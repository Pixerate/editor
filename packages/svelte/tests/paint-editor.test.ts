import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { PaintEditorController } from '@pixerate/editor/paint-editor';
import { BrushPanel, ColorPanel, PaintCanvas, PaintEditor, PaintLayersPanel, PaperPanel, PaintToolbar, createReactivePaintEditor } from '../src/paint-editor';

let target: HTMLDivElement;
let component: Record<string, any> | null = null;

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any;
  target = document.createElement('div');
  document.body.appendChild(target);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target.remove();
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

  it('the brush panel picks brushes and edits settings', () => {
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
    expect(c.getUserBrushes().map((b) => b.id)).toEqual(['my-charcoal']);
  });

  it("the brush panel shows each engine's controls: blender, smudge, behaviour, multi-colour and load", () => {
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
    setValue(q('select[aria-label="Multi-colour"]'), 'dab');
    expect(c.getState().brush.behavior.multicolor.mode).toBe('dab');
    click(q('button[aria-label="Add multi-colour"]'));
    expect(c.getState().brush.behavior.multicolor.colors).toHaveLength(3);
    setValue(q('select[aria-label="Colour order"]'), 'random');
    expect(c.getState().brush.behavior.multicolor.order).toBe('random');
    setValue(q('input[aria-label="Dabs per colour"]'), '7');
    expect(c.getState().brush.behavior.multicolor.length).toBe(7);
    click(q('button[aria-label="Remove multi-colour 1"]'));
    expect(c.getState().brush.behavior.multicolor.colors).toHaveLength(2);
    pick('Blender');
    expect(q('[data-testid="brush-engine"]')!.textContent).toContain('Blender');
    setValue(q('input[aria-label="Blend distance"]'), '0.6');
    expect(c.getState().brush.blender.distance).toBe(0.6);
    setValue(q('select[aria-label="Brush mixing"]'), 'rgb');
    expect(c.getState().brush.blender.mixing).toBe('rgb');
    expect(q('select[aria-label="Multi-colour"]')).toBeNull();
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
    pick('Soft eraser');
    expect(q('[data-testid="brush-engine"]')).toBeNull();
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
});
