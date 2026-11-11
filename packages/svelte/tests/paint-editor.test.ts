import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { PaintEditorController, documentToScreen } from '@pixerate/editor/paint-editor';
import { createFakeStickerProvider } from '@pixerate/editor/stickers';
import { createBrushLibrary } from '@pixerate/editor/brushes';
import { BrushPanel, ColorPanel, EvolutionPanel, PaintCanvas, PaintEditor, PaintLayersPanel, PaperPanel, PaintToolbar, WetPanel, PathStrokePanel, createPaintDirector, createReactivePaintEditor } from '../src/paint-editor';
import { stubBrushThumbnails } from './paint-thumbnails';

let target: HTMLDivElement;
let component: Record<string, any> | null = null;
let thumbnails: ReturnType<typeof stubBrushThumbnails>;

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any;
  thumbnails = stubBrushThumbnails();
  target = document.createElement('div');
  document.body.appendChild(target);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target.remove();
  vi.restoreAllMocks();
});

const show = (C: any, props: Record<string, unknown>) => {
  component = mount(C, { target, props });
  flushSync();
};
const byText = (text: string) => Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, commit = false) {
  el.value = value;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  if (commit) el.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}
const pointer = (type: string, x: number, y: number) => {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', pressure: 0.5 });
  return e;
};

describe('Svelte paint editor', () => {
  it('createReactivePaintEditor exposes the state as a rune', () => {
    const editor = createReactivePaintEditor({ width: 32, height: 16 });
    expect(editor.state.color).toBe('#1f2937');
    editor.controller.setColor('#ff0000');
    expect(editor.state.color).toBe('#ff0000');
    editor.destroy();
  });

  it('paints with the pointer on the canvas (one undo step) and reports refusals', () => {
    const c = new PaintEditorController({ width: 800, height: 600, paper: 'smooth' });
    let error: string | null = null;
    show(PaintCanvas, { controller: c, fitOnMount: false, onerror: (e: string | null) => (error = e) });
    const el = target.querySelector('[data-testid="paint-canvas"]')!;
    el.dispatchEvent(pointer('pointerdown', 100, 100));
    el.dispatchEvent(pointer('pointermove', 150, 120));
    el.dispatchEvent(pointer('pointerup', 150, 120));
    flushSync();
    expect(c.getStrokes()).toHaveLength(1);
    expect(c.getStrokes()[0].points.map((p) => [p.x, p.y])).toEqual([[100, 100], [150, 120]]);
    c.updateLayer(c.document.activeLayerId!, { locks: { pixels: true } });
    el.dispatchEvent(pointer('pointerdown', 10, 10));
    expect(error).toMatch(/locked/);
    flushSync();
    expect(target.querySelector('[data-testid="paint-view-status"]')?.textContent?.trim()).toBe('100% · 0°');
  });

  it('the toolbar drives tools, history, view and guides', () => {
    const c = new PaintEditorController({ width: 64, height: 64 });
    let tool = 'brush';
    show(PaintToolbar, { controller: c, tool: 'brush', ontoolchange: (t: string) => (tool = t) });
    click(byText('Eyedropper'));
    expect(tool).toBe('eyedropper');
    c.paintStroke({ points: [{ x: 5, y: 5 }] });
    flushSync();
    click(byText('Undo'));
    expect(c.getStrokes()).toHaveLength(0);
    click(byText('Mirror view'));
    expect(c.getState().view.mirror).toBe(true);
    click(target.querySelector('[aria-label="Rotate view right"]'));
    expect(c.getState().view.rotation).toBe(15);
    setValue(target.querySelector('select[aria-label="Symmetry"]')!, 'kaleidoscope');
    expect(c.getState().guides.symmetry.mode).toBe('kaleidoscope');
    setValue(target.querySelector('input[aria-label="Kaleidoscope segments"]')!, '8');
    expect(c.getState().guides.symmetry.segments).toBe(8);
    click(byText('Perspective'));
    expect(c.getState().guides.perspective).toMatchObject({ enabled: true, points: [{ x: 32, y: 25.6 }] });
    setValue(target.querySelector('select[aria-label="Vanishing points"]')!, '2');
    expect(c.getState().guides.perspective.points).toHaveLength(2);
    click(byText('Right-handed'));
    expect(c.getState().hand).toBe('left');
  });

  it('the brush panel picks brushes and edits settings', async () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    show(BrushPanel, { controller: c });
    click(Array.from(target.querySelectorAll('[role="option"]')).find((o) => o.getAttribute('title')?.startsWith('Charcoal stick'))!);
    expect(c.getState().brush.id).toBe('charcoal-stick');
    setValue(target.querySelector('input[aria-label="Size"]')!, '60');
    expect(c.getState().brush.tip.size).toBe(60);
    setValue(target.querySelector('input[aria-label="Grain"]')!, '0.3');
    expect(c.getState().brush.grain).toBe(0.3);
    setValue(target.querySelector('select[aria-label="Brush rotation"]')!, 'barrel');
    expect(c.getState().brush.rotation).toBe('barrel');
    setValue(target.querySelector('input[aria-label="Brush name"]')!, 'My Charcoal');
    click(byText('Save brush'));
    await vi.waitFor(() => expect(c.getUserBrushes().map((b) => b.id)).toEqual(['my-charcoal']));
    // Saved with the edits, as facets that keep the preset's variety.
    expect(c.getBrushSpec('my-charcoal')).toMatchObject({ name: 'My Charcoal', variety: 'charcoal', tip: { size: 60 }, behaviour: { grain: 0.3 }, dynamics: { rotation: 'barrel' } });
    flushSync();
    // A preview of every brush in the library, the saved one included.
    const previewed = new Set(thumbnails.mock.calls.map(([id]) => id));
    expect(c.getState().brushes.map((b) => b.id).filter((id) => !previewed.has(id))).toEqual([]);
    expect(target.querySelectorAll('canvas[aria-label$=" thumbnail"]')).toHaveLength(c.getState().brushes.length);
  });

  it("the brush panel shows each engine's controls: blender, smudge, behaviour, brush gradient and load", () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    show(BrushPanel, { controller: c });
    const pick = (name: string) => click(Array.from(target.querySelectorAll('[role="option"]')).find((o) => o.getAttribute('title')?.startsWith(name))!);
    const q = <T extends Element>(sel: string) => target.querySelector(sel) as unknown as T;
    setValue(q('select[aria-label="Brush blend"]'), 'watercolor');
    expect(c.getState().brush.tip.blend).toBe('watercolor');
    setValue(q('input[aria-label="Pick-up"]'), '0.4');
    expect(c.getState().brush.behavior.pickup).toBe(0.4);
    click(q('input[aria-label="Dirty brush"]'));
    expect(c.getState().brush.behavior.dirty).toBe(true);
    // The multi-colour brush is the brush's own gradient now.
    click(q('[data-testid="brush-gradient"] button[aria-pressed]'));
    expect(c.getState().brush.paint).toMatchObject({ type: 'gradient', stops: [{ color: 'paint' }, { color: 'secondary' }] });
    setValue(q('[data-testid="brush-gradient"] select[aria-label="Gradient follows"]'), 'across-tip');
    expect(c.getState().brush.paint?.map.by).toBe('across-tip');
    expect(c.getState().brush.behavior.multicolor.mode).toBe('tip');
    setValue(q('[data-testid="brush-gradient"] select[aria-label="Gradient follows"]'), 'random');
    expect(c.getState().brush.paint?.map).toEqual({ by: 'random', every: 1 });
    pick('Blender');
    expect(q('[data-testid="brush-engine"]')!.textContent).toContain('Blender');
    setValue(q('input[aria-label="Blend distance"]'), '0.6');
    expect(c.getState().brush.blender.distance).toBe(0.6);
    setValue(q('select[aria-label="Brush mixing"]'), 'rgb');
    expect(c.getState().brush.blender.mixing).toBe('rgb');
    expect(q('[data-testid="brush-gradient"]')).toBeNull();
    pick('Smudge');
    setValue(q('select[aria-label="Brush mixing"]'), 'pigment');
    expect(c.getState().brush.smudge.mixing).toBe('pigment');
    setValue(q('input[aria-label="Length"]'), '0.95');
    expect(c.getState().brush.smudge.length).toBe(0.95);
    pick('Mixer Brush');
    setValue(q('input[aria-label="Pick-up"]'), '0.8');
    expect(c.getState().brush.mixer.wet).toBe(0.8);
    click(byText('Load'));
    expect(c.getState().mixerLoad.reservoir).not.toBeNull();
    expect(q<HTMLElement>('[aria-label="Brush load"]').getAttribute('title')).toMatch(/^#/);
    click(byText('Clean'));
    expect(c.getState().mixerLoad.reservoir).toBeNull();
    // The eraser has no paint behaviour: only the paper grain.
    pick('Soft eraser');
    expect(q('input[aria-label="Pick-up"]')).toBeNull();
    expect(q('[data-testid="brush-engine"]')!.textContent).toContain('Grain');
  });

  it('the brush editor builds a highlighter-style brush from facets, saves it into a shared library, and paints with it', async () => {
    const library = createBrushLibrary();
    const c = new PaintEditorController({ width: 96, height: 48, brushLibrary: library });
    const other = new PaintEditorController({ width: 32, height: 32, brushLibrary: library });
    show(BrushPanel, { controller: c });
    const q = <T extends Element>(sel: string) => target.querySelector(sel) as unknown as T;
    // The library is grouped by medium; the filter narrows it.
    expect([...target.querySelectorAll('[data-testid="brush-library"] [role="group"]')].map((g) => g.getAttribute('aria-label'))).toEqual(['Dry media', 'Ink', 'Paint', 'Spray', 'Other', 'Tools']);
    setValue(q('input[aria-label="Find a brush"]'), 'highlighter');
    expect(target.querySelectorAll('[data-testid="brush-library"] [role="option"]')).toHaveLength(1);
    click(q('[data-testid="brush-library"] [role="option"]'));
    flushSync();
    expect(c.getState().brush.id).toBe('highlighter');
    // The fields show the chosen brush, not the one before it.
    expect(q<HTMLInputElement>('input[aria-label="Brush variety"]').value).toBe('highlighter');
    // Facets of the preset, edited: a narrower tip, a pink default colour and a palette colour.
    expect(q('[data-testid="brush-editor"] canvas[aria-label="Brush preview"]')).not.toBeNull();
    expect([...target.querySelectorAll('[data-testid="brush-editor"] section')].map((s) => s.getAttribute('data-section'))).toEqual(['medium', 'shape', 'grain', 'marks', 'feel', 'behaviour', 'light', 'colour']);
    setValue(q('input[aria-label="Size"]'), '18');
    setValue(q('input[aria-label="Brush default colour"]'), '#ff6ec7', true);
    setValue(q('input[aria-label="Add a palette colour"]'), '#ffd1ec', true);
    expect(c.getBrushSpec()).toMatchObject({ variety: 'highlighter', tip: { size: 18, blend: 'multiply' }, colour: { default: '#ff6ec7' }, light: { spill: { radius: 0 } } });
    expect(c.getBrushSpec()!.colour!.palette).toContain('#ffd1ec');
    setValue(q('input[aria-label="Brush name"]'), 'Pink highlighter');
    byText('Save brush').click();
    await c.whenBrushesLoaded();
    flushSync();
    await vi.waitFor(() => expect(c.getBrush('pink-highlighter')).toBeDefined());
    // The other editor on the same library has it, and paints with it.
    await other.whenBrushesLoaded();
    expect(other.getBrushSpec('pink-highlighter')).toMatchObject({ name: 'Pink highlighter', colour: { default: '#ff6ec7' } });
    other.setBrush({ id: 'pink-highlighter' });
    expect(other.paintStroke({ points: [{ x: 4, y: 16 }, { x: 28, y: 16 }], color: '#ff6ec7' }).dabs).toBeGreaterThan(0);
    // A tip of another shape changes the engine the brush paints with.
    setValue(q('select[aria-label="Brush tip"]'), 'bristle');
    expect(c.getState().brush.engine).toBe('bristle');
  });

  it('the brush editor sets default colours and light / dark pairs, and the panel can keep my colour', async () => {
    const c = new PaintEditorController({ width: 64, height: 32 });
    show(BrushPanel, { controller: c });
    const q = <T extends Element>(sel: string) => target.querySelector(sel) as unknown as T;
    const choose = (name: string) => click([...target.querySelectorAll('[data-testid="brush-library"] [role="option"]')].find((o) => o.getAttribute('title')?.startsWith(name))!);
    choose('Highlighter');
    expect(c.getState().color).toBe('#fff200');
    // The brush's palette: one click paints with that colour.
    click(q('button[aria-label="Paint with #ff6ec7"]'));
    expect(c.getState().color).toBe('#ff6ec7');
    // A light / dark default: the toggle makes a pair, the dark picker sets its other side.
    click(q('input[aria-label="Brush default colour: light and dark"]'));
    setValue(q('input[aria-label="Brush default colour (dark)"]'), '#ffe066', true);
    expect(c.getBrushSpec()!.colour!.default).toEqual({ light: '#fff200', dark: '#ffe066' });
    click(byText('Add light / dark pair'));
    expect(c.getBrushSpec()!.colour!.palette!.at(-1)).toEqual({ light: '#334155', dark: '#e2e8f0' });
    setValue(q(`input[aria-label="Palette colour ${c.getBrushSpec()!.colour!.palette!.length} (dark)"]`), '#ffffff', true);
    expect(c.getBrushSpec()!.colour!.palette!.at(-1)).toEqual({ light: '#334155', dark: '#ffffff' });
    // Kept: choosing a brush with a default colour leaves mine.
    c.setColor('#123456');
    click(q('input[aria-label="Keep my colour"]'));
    expect(c.getState().colorLocked).toBe(true);
    choose('Ballpoint');
    expect(c.getState().color).toBe('#123456');
  });

  it('the mixing pad picks with a sample size, mixes measured parts and keeps pads', () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    c.setColor('#1e40af');
    c.setSecondaryColor('#facc15');
    show(ColorPanel, { controller: c });
    setValue(target.querySelector('input[aria-label="Second colour parts"]')!, '3');
    click(byText('Mix'));
    const mixed = c.getState().color;
    expect(mixed).not.toBe('#1e40af');
    expect(c.mixingPad.pick(180, 110, 0)).toBe(mixed);
    setValue(target.querySelector('select[aria-label="Pick sample size"]')!, '9');
    setValue(target.querySelector('input[aria-label="Pad name"]')!, 'Greens');
    click(byText('Keep pad'));
    expect(c.listMixingPads()).toEqual([{ id: 'pad1', name: 'Greens' }]);
    c.clearMixingPad();
    flushSync();
    click(byText('Greens'));
    expect(c.mixingPad.pick(180, 110, 0)).toBe(mixed);
    click(target.querySelector('button[aria-label="Remove Greens"]'));
    expect(c.listMixingPads()).toEqual([]);
  });

  it('the paper panel sets presets and commits sliders on release (one undo step)', () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    show(PaperPanel, { controller: c });
    click(target.querySelector('[role="option"][title="Gesso panel"]'));
    expect(c.document.paper.preset).toBe('gesso');
    const depth = target.querySelector('input[aria-label="Grain depth"]') as HTMLInputElement;
    setValue(depth, '0.6');
    setValue(depth, '0.8');
    expect(c.document.paper.depth).toBe(0.35);
    setValue(depth, '0.9', true);
    expect(c.document.paper.depth).toBe(0.9);
    expect(c.historyLabels().undo).toEqual(['Paper', 'Paper']);
  });

  it('the colour panel sets colours from harmonies and swatches, and mixes on the pad', () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    c.setColor('#ff0000');
    show(ColorPanel, { controller: c });
    const chips = () => target.querySelector('[aria-label="Harmony colours"]')!.querySelectorAll('button[aria-label^="Use"]');
    expect(chips()).toHaveLength(2);
    click(chips()[1]);
    expect(c.getState().color).toBe('#00ff00');
    click(byText('RGB'));
    setValue(target.querySelector('select[aria-label="Harmony"]')!, 'triadic');
    expect(chips()).toHaveLength(3);
    click(target.querySelector('[role="option"][aria-label="Lemon yellow"]'));
    expect(c.getState().color).toBe('#f3d23a');
    const n = c.getState().swatches.length;
    click(target.querySelector('button[aria-label="Add swatch"]'));
    expect(c.getState().swatches).toHaveLength(n + 1);
    const pad = target.querySelector('[aria-label="Mixing pad"]')!;
    pad.dispatchEvent(pointer('pointerdown', 50, 50));
    pad.dispatchEvent(pointer('pointermove', 120, 60));
    pad.dispatchEvent(pointer('pointerup', 120, 60));
    flushSync();
    expect(c.getState().mixingPadVersion).toBe(1);
    c.setColor('#000000');
    flushSync();
    click(byText('Pick'));
    pad.dispatchEvent(pointer('pointerdown', 80, 54));
    // The pad holds the yellow it was painted with.
    expect(c.getState().color).toBe('#f3d23a');
  });

  it('the layers panel adds, renames, reorders and changes layers', () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    show(PaintLayersPanel, { controller: c });
    click(byText('New layer'));
    expect(c.listLayers()).toHaveLength(2);
    const name = target.querySelector('[role="treeitem"][aria-selected="true"] span.truncate')!;
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    flushSync();
    const input = target.querySelector('input[aria-label="Layer name"]') as HTMLInputElement;
    input.value = 'Ink';
    input.dispatchEvent(new FocusEvent('blur'));
    flushSync();
    expect(c.listLayers()[0].name).toBe('Ink');
    click(target.querySelector('button[aria-label="Move layer down"]'));
    expect(c.listLayers()[1].name).toBe('Ink');
    setValue(target.querySelector('select[aria-label="Layer blend"]')!, 'multiply');
    expect(c.listLayers().find((l) => l.name === 'Ink')?.blend).toBe('multiply');
    const blendSelect = target.querySelector('select[aria-label="Layer blend"]')!;
    expect(Array.from(blendSelect.querySelectorAll('optgroup')).map((g) => g.getAttribute('label'))).toEqual(['Standard', 'Paint']);
    expect(Array.from(blendSelect.querySelectorAll('optgroup[label="Paint"] option')).map((o) => o.getAttribute('value'))).toEqual(['pigment', 'watercolor', 'tint', 'highlight', 'shadow']);
    setValue(blendSelect, 'watercolor');
    expect(c.listLayers().find((l) => l.name === 'Ink')?.blend).toBe('watercolor');
    click(byText('Lock pixels'));
    expect(c.listLayers().find((l) => l.name === 'Ink')?.locks.pixels).toBe(true);
    click(target.querySelector('button[aria-label="Hide Ink"]'));
    expect(c.listLayers().find((l) => l.name === 'Ink')?.visible).toBe(false);
  });

  it('PaintEditor composes the panels with tabs', () => {
    const c = new PaintEditorController({ width: 64, height: 64 });
    show(PaintEditor, { controller: c });
    expect(target.querySelector('[data-testid="paint-toolbar"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="brush-panel"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="color-panel"]')).not.toBeNull();
    click(byText('Paper'));
    expect(target.querySelector('[data-testid="paper-panel"]')).not.toBeNull();
    click(byText('Layers'));
    expect(target.querySelector('[data-testid="paint-layers-panel"]')).not.toBeNull();
  });

  it('createPaintDirector paints agent strokes live with a cursor drawn through the view', async () => {
    const controller = new PaintEditorController({ width: 200, height: 100 });
    const { presence, director } = createPaintDirector(controller, { speed: Infinity, linger: 0 });
    show(PaintEditor, { controller, presence });
    presence.set({ id: 'agent', name: 'Agent', x: 50, y: 25, message: 'Sky first' });
    flushSync();
    const cursor = target.querySelector('[data-paint-presence] [data-actor="agent"]') as HTMLElement;
    expect(cursor.textContent?.trim()).toBe('Sky first');
    const s = controller.getState();
    const at = documentToScreen(s.view, s.document.canvas, { width: 800, height: 600 }, 50, 25);
    expect(parseFloat(cursor.style.left)).toBeCloseTo(at.x, 3);
    expect(parseFloat(cursor.style.top)).toBeCloseTo(at.y, 3);
    presence.remove('agent');
    const results = await director.perform({ id: 'agent' }, [{ kind: 'stroke', stroke: { points: [{ x: 10, y: 10 }, { x: 150, y: 80 }] } }]);
    flushSync();
    expect(results[0]).toMatchObject({ ok: true, result: { strokeId: 's1' } });
    expect(controller.getStrokes()).toHaveLength(1);
    // linger 0 keeps the cursor where the stroke ended.
    expect(target.querySelector('[data-paint-presence] [data-actor="agent"]')).not.toBeNull();
  });

  it('gradient paint: the colour panel toggles it, edits stops and the mapping, and keeps it as a swatch', () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    c.setColor('#1d4ed8');
    c.setSecondaryColor('#facc15');
    show(ColorPanel, { controller: c, mixingPad: false });
    click(byText('Gradient'));
    expect(c.getState().paint).toMatchObject({ type: 'gradient', map: { by: 'distance' } });
    expect(target.querySelector('[data-testid="paint-gradient-editor"]')).not.toBeNull();
    expect((target.querySelector('[data-testid="paint-well"]') as HTMLElement).style.background).toContain('linear-gradient');
    const ramp = target.querySelector('[data-testid="paint-gradient-ramp"]') as HTMLElement;
    ramp.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 0 }));
    flushSync();
    expect((c.getState().paint as { stops: unknown[] }).stops).toHaveLength(3);
    setValue(target.querySelector('select[aria-label="Stop colour source"]')!, 'color');
    setValue(target.querySelector('input[aria-label="Stop colour"]')!, '#ff0000');
    setValue(target.querySelector('input[aria-label="Stop position"]')!, '40');
    const g = c.getState().paint as { stops: { offset: number; color: string }[] };
    expect(g.stops.find((s) => s.color === '#ff0000')?.offset).toBe(0.4);
    setValue(target.querySelector('select[aria-label="Gradient follows"]')!, 'pressure');
    expect(c.getState().paint).toMatchObject({ map: { by: 'pressure' } });
    setValue(target.querySelector('select[aria-label="Gradient mixing"]')!, 'oklab');
    expect(c.getState().paint).toMatchObject({ space: 'oklab' });
    click(target.querySelector('button[aria-label="Add swatch"]'));
    expect(c.getState().swatches.at(-1)!.paint?.map.by).toBe('pressure');
    click(byText('Gradient'));
    expect(c.getState().paint.type).toBe('color');
    const swatches = target.querySelectorAll('[aria-label="Swatches"] [role="option"]');
    click(swatches[swatches.length - 1]);
    expect(c.getState().paint.type).toBe('gradient');
  });

  it('WetPanel shows wet paint and dries, pauses, tilts and tunes it; the brush panel picks the wet tool', async () => {
    const c = new PaintEditorController({ width: 300, height: 200, wet: { kernel: 'typescript' } });
    show(PaintEditor, { controller: c });
    click(byText('Wet'));
    const status = () => target.querySelector('[data-testid="wet-status"]')!.textContent;
    expect(status()).toBe('Dry');
    c.paintStroke({ points: [{ x: 50, y: 100 }, { x: 200, y: 100 }], brushId: 'watercolor-round', color: '#1d4ed8' });
    flushSync();
    expect(status()).toBe('Wet');
    click(byText('Pause'));
    expect(c.getState().wet.paused).toBe(true);
    expect(status()).toBe('Wet (paused)');
    expect(target.querySelector('[data-testid="paint-water-overlay"]')).toBeNull();
    click(byText('Water'));
    expect(target.querySelector('[data-testid="paint-water-overlay"]')).not.toBeNull();
    setValue(target.querySelector('[data-testid="wet-layer"] input[aria-label="Granulation"]') as HTMLInputElement, '0.9', true);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.wetLayerInfo().params.granulation).toBe(0.9);
    setValue(target.querySelector('input[aria-label="Tilt"]') as HTMLInputElement, '40', true);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.getState().wet.tilt.angle).toBe(40);
    byText('Dry now').click();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(status()).toBe('Dry');
    // The wet tools are tool brushes: switch one to another.
    c.setBrush({ id: 'add-water' });
    flushSync();
    const tool = target.querySelector('select[aria-label="Brush tool"]') as HTMLSelectElement;
    expect(tool.value).toBe('water');
    setValue(tool, 'blot');
    flushSync();
    expect(c.getState().brush.wet.tool).toBe('blot');
    expect(target.querySelector('input[aria-label="Strength"]')).not.toBeNull();
    // Engine B: force the CPU, then let the GPU run again (there is none in jsdom: the reason shows).
    const engine = () => target.querySelector('[data-testid="wet-engine"]')!.textContent;
    setValue(target.querySelector('select[aria-label="Wet engine"]') as HTMLSelectElement, 'off');
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(c.getState().wet.gpu).toBe('off');
    expect(engine()).toBe('CPU only (GPU off).');
    setValue(target.querySelector('select[aria-label="Wet engine"]') as HTMLSelectElement, 'auto');
    await c.setWetEngine({});
    flushSync();
    expect(c.getState().wet.gpu).toBe('auto');
    expect(engine()).toMatch(/no WebGPU/);
    c.dispose();
  });

  it('thick paint and oil controls: impasto tool, wet medium, instant dry and the light', () => {
    const c = new PaintEditorController({ width: 300, height: 200, wet: { kernel: 'typescript' } });
    show(PaintEditor, { controller: c });
    c.setBrush({ id: 'impasto-brush' });
    flushSync();
    const tool = target.querySelector('select[aria-label="Impasto tool"]') as HTMLSelectElement;
    expect(tool.value).toBe('brush');
    setValue(tool, 'knife');
    expect(c.getState().brush.impasto.tool).toBe('knife');
    expect(target.querySelector('input[aria-label="Thickness"]')).not.toBeNull();
    c.setBrush({ id: 'oil-round' });
    flushSync();
    const medium = target.querySelector('select[aria-label="Wet medium"]') as HTMLSelectElement;
    expect(medium.value).toBe('oil');
    setValue(medium, 'gouache');
    expect(c.getState().brush.wet.medium).toBe('gouache');
    click(byText('Wet'));
    click(byText('Instant dry'));
    expect(c.getState().wet.instantDry).toBe(true);
    click(byText('Paper'));
    setValue(target.querySelector('[data-testid="light-panel"] input[aria-label="Light height"]') as HTMLInputElement, '20');
    expect(c.getLighting().elevation).toBe(20);
    c.setBrush({ id: 'impasto-brush' });
    c.paintStroke({ points: [{ x: 20, y: 50 }, { x: 200, y: 50 }] });
    flushSync();
    expect(c.reliefOf()).not.toBeNull();
    click(byText('Flatten relief'));
    expect(c.reliefOf()).toBeNull();
  });

  it('the toolbar exports a time-lapse and a PNG repainted at twice the size', async () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    c.paintStroke({ points: [{ x: 10, y: 40 }, { x: 110, y: 40 }], brushId: 'soft-pastel' });
    const downloads: string[] = [];
    (URL as any).createObjectURL = () => 'blob:x';
    (URL as any).revokeObjectURL = () => {};
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    };
    show(PaintToolbar, { controller: c, tool: 'brush', ontoolchange: () => {} });
    byText('Time-lapse').click();
    for (let i = 0; i < 50 && downloads.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    flushSync();
    expect(downloads).toContain('painting-timelapse.zip');
    expect(target.querySelector('[data-testid="paint-replay-status"]')!.textContent).toMatch(/frames/);
    byText('PNG 2×').click();
    for (let i = 0; i < 50 && downloads.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(downloads).toContain('painting@2x.png');
    HTMLAnchorElement.prototype.click = click;
  });

  it('picks stickers from a host library: brush stamps by category, and restickering a placed sticker', async () => {
    const c = new PaintEditorController({ width: 300, height: 200, stickers: createFakeStickerProvider() });
    show(PaintEditor, { controller: c });
    c.setBrush({ id: 'sticker-stars' });
    const settle = async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
      flushSync();
    };
    await settle();
    setValue(target.querySelector('select[aria-label="Sticker category"]') as HTMLSelectElement, 'food');
    await settle();
    const names = [...target.querySelectorAll('[aria-label="Sticker stamps"] button')].map((b) => b.textContent?.trim());
    expect(names).toEqual(['Apple', 'Pear', 'Cherry', 'Lemon', 'Grape']);
    click(byText('Apple'));
    expect(c.getState().brush.sticker.stamps).toContain('fake:fruit-apple');
    await c.prepareStickers(['fake:fruit-apple']);
    c.addLayer();
    const [placed] = c.addStickers(undefined, [{ ref: 'fake:fruit-apple', x: 60, y: 60, size: 40 }]);
    c.selectSticker(placed.id);
    click(byText('Layers'));
    await settle();
    const art = target.querySelector('[aria-label="Sticker art"]')!;
    click([...art.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Pear')!);
    await settle();
    expect(c.listStickers()[0].ref).toBe('fake:fruit-pear');
  });

  it('procedural, bristle and sticker controls, stencils in the toolbar, and the sticker panel', async () => {
    const c = new PaintEditorController({ width: 300, height: 200 });
    show(PaintEditor, { controller: c });
    c.setBrush({ id: 'hair-strands' });
    flushSync();
    setValue(target.querySelector('select[aria-label="Particle kind"]') as HTMLSelectElement, 'orbit');
    expect(c.getState().brush.particle.kind).toBe('orbit');
    setValue(target.querySelector('select[aria-label="Particle render"]') as HTMLSelectElement, 'sequence');
    expect(c.getState().brush.particle.render).toBe('sequence');
    // Textured dots (sequence beads) on a stamp tip, then ribbons and waves.
    flushSync();
    setValue(target.querySelector('select[aria-label="Brush tip"]') as HTMLSelectElement, 'stamp');
    flushSync();
    click(target.querySelector('[aria-label="Brush stamps"] button[aria-pressed="false"]'));
    expect(c.getState().brush.particle.dotTextures).toHaveLength(1);
    flushSync();
    setValue(target.querySelector('select[aria-label="Dot texture order"]') as HTMLSelectElement, 'random');
    setValue(target.querySelector('select[aria-label="Dot rotation"]') as HTMLSelectElement, 'follow');
    expect(c.getState().brush.particle).toMatchObject({ dotTextureOrder: 'random', dotRotation: 'follow' });
    setValue(target.querySelector('select[aria-label="Particle render"]') as HTMLSelectElement, 'ribbon');
    flushSync();
    setValue(target.querySelector('select[aria-label="Ribbon pairs"]') as HTMLSelectElement, 'first-last');
    expect(c.getState().brush.particle.ribbonPairs).toBe('first-last');
    expect(target.querySelector('input[aria-label="Wave"]')).not.toBeNull();
    expect(target.querySelector('input[aria-label="Ribbon fill"]')).not.toBeNull();
    c.setBrush({ id: 'bristle-round' });
    flushSync();
    expect(target.querySelector('input[aria-label="Splay"]')).not.toBeNull();
    c.setBrush({ id: 'sticker-stars' });
    flushSync();
    // The picker lists the sticker library (the editor's own stamps here) once its first page lands.
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    click(target.querySelector('[aria-label="Sticker stamps"] button[aria-pressed="false"]'));
    expect(c.getState().brush.sticker.stamps.length).toBe(3);
    expect(c.getState().brush.sticker.stamps.every((r) => r.startsWith('editor:'))).toBe(true);
    // Searching narrows the list.
    const search = target.querySelector('input[aria-label="Search sticker stamps"]') as HTMLInputElement;
    search.value = 'heart';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect([...target.querySelectorAll('[aria-label="Sticker stamps"] button')].map((b) => b.textContent?.trim())).toEqual(['Heart']);
    click(byText('Ruler'));
    expect(c.listStencils()[0].kind).toBe('ruler');
    expect(target.querySelectorAll('svg line[stroke="#fbbf24"]').length).toBeGreaterThan(0);
    click(byText('Clear stencils'));
    expect(c.listStencils()).toHaveLength(0);
    c.paintStroke({ points: [{ x: 20, y: 100 }, { x: 280, y: 100 }] });
    flushSync();
    click(byText('Layers'));
    const list = target.querySelectorAll('[data-testid="sticker-panel"] [role="option"]');
    expect(list.length).toBe(c.listStickers().length);
    click(list[0]);
    click(Array.from(target.querySelectorAll('[data-testid="sticker-edit"] button')).find((b) => b.textContent?.trim() === 'Delete')!);
    expect(c.listStickers().length).toBe(list.length - 1);
  });

  it('the sticker panel follows the canvas pick, moves a sticker by X/Y, and the canvas outlines it', () => {
    const c = new PaintEditorController({ width: 300, height: 200 });
    show(PaintEditor, { controller: c });
    click(byText('Stickers'));
    expect(byText('Stickers').getAttribute('aria-pressed')).toBe('true');
    click(byText('Layers'));
    const [placed] = c.addStickers(undefined, [{ stamp: 'heart', x: 60, y: 50 }, { stamp: 'star', x: 200, y: 120 }]);
    c.selectSticker(placed.id);
    flushSync();
    expect(target.querySelector('[data-testid="sticker-panel"] [aria-selected="true"]')).not.toBeNull();
    expect(target.querySelectorAll('svg line[stroke="#818cf8"]').length).toBe(4);
    const x = target.querySelector('input[aria-label="Sticker x"]') as HTMLInputElement;
    expect(x.value).toBe('60');
    setValue(x, '90', true);
    expect(c.listStickers()[0]).toMatchObject({ x: 90, y: 50 });
    expect(c.getState().undoLabel).toBe('Edit sticker');
  });
});

describe('stroke layers', () => {
  it('adds a stroke layer, picks and edits strokes in the stroke panel, outlines the pick and rasterizes', () => {
    const c = new PaintEditorController({ width: 300, height: 200 });
    show(PaintEditor, { controller: c });
    click(byText('Layers'));
    expect(target.querySelector('[data-testid="stroke-panel"]')).toBeNull();
    click(byText('New stroke layer'));
    expect(target.querySelector('[aria-label="Stroke layer"]')).not.toBeNull();
    click(byText('Select stroke'));
    expect(byText('Select stroke').getAttribute('aria-pressed')).toBe('true');
    c.paintStroke({ points: [{ x: 20, y: 60 }, { x: 260, y: 60 }], brushId: 'ink-pen', color: '#2563eb' });
    c.paintStroke({ points: [{ x: 20, y: 120 }, { x: 260, y: 120 }], brushId: 'ink-pen', color: '#dc2626' });
    flushSync();
    const options = target.querySelectorAll('[data-testid="stroke-panel"] [role="option"]');
    expect(options).toHaveLength(2);
    click(options[0]);
    const [a, b] = c.listLiveStrokes();
    expect(c.getState().selectedStroke).toBe(a.id);
    expect(target.querySelectorAll('svg line[stroke="#818cf8"]').length).toBe(4);
    setValue(target.querySelector('select[aria-label="Stroke brush"]') as HTMLSelectElement, 'pencil-hb');
    expect(c.listLiveStrokes()[0].brush.id).toBe('pencil-hb');
    expect(target.querySelector('select[aria-label="Stroke brush"] option[value="eraser-soft"]')).not.toBeNull();
    expect(target.querySelector('select[aria-label="Stroke brush"] option[value="smudge"]')).toBeNull();
    click(byText('New seed'));
    expect(c.listLiveStrokes()[0].seed).toBe(a.seed + 1);
    click(target.querySelector('[aria-label="Move stroke up"]'));
    expect(c.listLiveStrokes().map((s) => s.id)).toEqual([b.id, a.id]);
    click(Array.from(target.querySelectorAll('[data-testid="stroke-edit"] button')).find((x) => x.textContent?.trim() === 'Delete')!);
    expect(c.listLiveStrokes().map((s) => s.id)).toEqual([b.id]);
    click(byText('Rasterize'));
    expect(target.querySelector('[data-testid="stroke-panel"]')).toBeNull();
    expect(c.getState().undoLabel).toBe('Rasterize stroke layer');
  });
});

describe('light paint', () => {
  it('the brush panel has Light (and Rim, Clarity for impasto), and the layers panel shows, spills and clears light', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    show(PaintEditor, { controller: c });
    c.setBrush({ id: 'neon-marker' });
    flushSync();
    expect(target.querySelector('input[aria-label="Light"]')).not.toBeNull();
    click(target.querySelector('input[aria-label="Light follows pressure"]'));
    expect(c.getState().brush.light.pressure).toBe(true);
    c.setBrush({ id: 'glow-gel' });
    flushSync();
    expect(target.querySelector('input[aria-label="Rim"]')).not.toBeNull();
    expect(target.querySelector('input[aria-label="Clarity"]')).not.toBeNull();
    click(byText('Layers'));
    expect(target.querySelector('[data-testid="layer-light"]')).toBeNull();
    c.paintStroke({ brushId: 'neon-marker', points: [{ x: 10, y: 40 }, { x: 110, y: 40 }] });
    flushSync();
    expect(target.querySelector('[data-testid="layer-light"]')).not.toBeNull();
    setValue(target.querySelector('input[aria-label="Light spill radius"]') as HTMLInputElement, '60', true);
    expect(c.lightOf().spill.radius).toBe(60);
    click(byText('Clear light'));
    expect(c.lightOf().hasLight).toBe(false);
    expect(target.querySelector('[data-testid="layer-light"]')).toBeNull();
    // The layer style section (the image editor's panel): add a glow, then remove it.
    const fx = target.querySelector('[data-testid="paint-layer-effects"]')!;
    setValue(fx.querySelector('select[aria-label="Add style"]') as HTMLSelectElement, 'outer-glow');
    flushSync();
    const id = c.getActiveLayer()!.id;
    expect(c.getLayerEffects(id).items.map((e) => e.kind)).toEqual(['outer-glow']);
    click(target.querySelector('[data-testid="paint-layer-effects"] button[aria-label^="Remove "]'));
    expect(c.getLayerEffects(id).items).toHaveLength(0);
  });
});


describe('wet light paint and backlit paper', () => {
  it('wet paint brushes get the Light slider; the paper panel sets the backlight and its colour', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    show(BrushPanel, { controller: c });
    c.setBrush({ id: 'glow-wash' });
    flushSync();
    expect(target.querySelector('input[aria-label="Light"]')).not.toBeNull();
    c.setBrush({ id: 'add-water' });
    flushSync();
    expect(target.querySelector('input[aria-label="Light"]')).toBeNull();
    show(PaperPanel, { controller: c });
    click(target.querySelector('[role="option"][title="Stained glass (backlit)"]'));
    expect(c.document.paper).toMatchObject({ preset: 'stained-glass', backlight: 0.8 });
    setValue(target.querySelector('input[aria-label="Backlight"]') as HTMLInputElement, '0.4', true);
    expect(c.document.paper.backlight).toBe(0.4);
    setValue(target.querySelector('input[aria-label="Backlight colour"]') as HTMLInputElement, '#ffccaa', true);
    expect(c.document.paper.backlightColor).toBe('#ffccaa');
  });
});

describe('Svelte PathStrokePanel', () => {
  it('brushes pasted SVG path data with a taper, one undo step, and shows errors', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    show(PathStrokePanel, { controller: c });
    const area = target.querySelector('textarea[aria-label="SVG path data"]') as HTMLTextAreaElement;
    expect(byText('Brush path').disabled).toBe(true);
    area.value = 'M 10 40 L 110 40';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    setValue(target.querySelector('select[aria-label="Pressure along the path"]') as HTMLSelectElement, 'both');
    click(byText('Brush path'));
    expect(c.getStrokes().length).toBe(1);
    expect(c.getStrokes()[0].points[0].pressure).toBeCloseTo(0.2, 2);
    expect(c.getState().undoLabel).toMatch(/path stroke/);
    area.value = 'M 5 5';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    click(byText('Brush path'));
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('no segments to brush');
    expect(c.getStrokes().length).toBe(1);
  });

  it('the brush panel imports a Procreate brush pack into the library', async () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    show(BrushPanel, { controller: c });
    const input = target.querySelector<HTMLInputElement>('input[aria-label="Import brushes"]')!;
    expect(input.accept).toContain('.brushset');
    const bytes = readFileSync(`${__dirname}/../../core/tests/fixtures/brush-packs/test-set.brushset`);
    Object.defineProperty(input, 'files', { value: [new File([bytes], 'Test set.brushset')], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect((await c.brushLibrary.list({ source: 'user' })).map((e) => e.brush.id)).toEqual(['test-set-dry-ink', 'test-set-soft-round']);
    expect((await c.brushLibrary.listSources()).length).toBe(3);
  });

  it('EvolutionPanel breeds variants, crosses two proposals, exports a contact sheet, and accepts one in one undo step', () => {
    const c = new PaintEditorController({ width: 96, height: 72 });
    c.paintStroke({
      brushId: 'ink-pen',
      color: '#2563eb',
      points: [
        { x: 16, y: 20, pressure: 0.5 },
        { x: 64, y: 44, pressure: 0.8 },
      ],
    });
    show(EvolutionPanel, { controller: c });
    setValue(target.querySelector('input[aria-label="Variant count"]') as HTMLInputElement, '2', true);
    click(byText('Breed strokes'));
    expect(c.proposals.getState().proposals).toHaveLength(2);
    expect(target.querySelectorAll('[data-testid^="evolution-variant-"]')).toHaveLength(2);

    click(byText('Contact sheet'));
    expect(target.querySelector('[data-testid="evolution-contact-sheet"]')).not.toBeNull();

    const variantChips = Array.from(target.querySelectorAll('[data-testid^="evolution-variant-"] button[aria-pressed]'));
    click(variantChips[0]!);
    click(variantChips[1]!);
    click(byText('Cross over (2)'));
    expect(c.proposals.getState().proposals).toHaveLength(4);

    const layersBefore = c.document.layers.length;
    click(byText('Accept'));
    expect(c.document.layers.length).toBe(layersBefore + 1);
  });
});
