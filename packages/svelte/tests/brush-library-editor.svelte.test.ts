import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { BRUSH_PRESETS, CANVAS_PROFILE, createBrushLibrary, type Brush } from '@pixerate/editor/brushes';
import { ImageEditorController } from '@pixerate/editor/image-editor';
import { VectorEditorController } from '@pixerate/editor/vector';
import { loadCanvasBrushstrokeRenderer } from '@pixerate/editor/canvas';
import { BrushEditor, BrushLibraryEditor } from '../src/brushes';
import { BrushEditor as PaintBrushEditor } from '../src/paint-editor';
import { BrushOptionsBar } from '../src/image-editor';
import { VectorAppearancePanel } from '../src/vector';

const ink = BRUSH_PRESETS.find((b) => b.id === 'ink-pen')!;
/** A paint brush with light, which canvas strokes can't paint. */
const litInk: Brush = { ...ink, id: 'lit-ink', name: 'Lit ink', light: { amount: 0.6, glow: true } };

let target: HTMLDivElement;
let component: Record<string, any> | null = null;
const settle = async () => {
  await new Promise((r) => setTimeout(r, 20));
  flushSync();
};
const q = <T extends Element = HTMLElement>(sel: string) => target.querySelector(sel) as T;
const byText = (text: string, sel = 'button') => [...target.querySelectorAll(sel)].find((b) => b.textContent?.trim() === text) as HTMLElement;
const show = (C: any, props: Record<string, unknown>) => {
  component = mount(C, { target, props });
  flushSync();
};
const setValue = (el: HTMLInputElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
};
const press = async (el: HTMLElement) => {
  el.click();
  flushSync();
  await settle();
};

beforeAll(async () => {
  await loadCanvasBrushstrokeRenderer();
});
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

describe('the shared brush editor (Svelte)', () => {
  it('is exported from brushes and still from paint-editor', () => {
    expect(PaintBrushEditor).toBe(BrushEditor);
  });

  it('shows only what the host uses, names the rest, and keeps it on save', async () => {
    const lib = createBrushLibrary();
    await lib.save(litInk);
    const saved: Brush[] = [];
    show(BrushLibraryEditor, { library: lib, brushId: 'lit-ink', profile: CANVAS_PROFILE, onsaved: (b: Brush) => saved.push(b) });
    await settle();
    expect(q('[data-testid="brush-editor-scope"]').textContent).toBe("Also has light and velocity dynamics, which Canvas can't use.");
    expect(target.querySelector('[data-section="light"]')).toBeNull();
    setValue(q<HTMLInputElement>('input[aria-label="Size"]'), '7');
    await press(byText('Save'));
    expect(saved.map((b) => b.id)).toEqual(['lit-ink']);
    expect((await lib.get('lit-ink'))!.brush).toMatchObject({ tip: { size: 7 }, light: { amount: 0.6, glow: true } });
    expect(q('[role="status"]').textContent).toMatch(/keeping what Canvas can't use/);
  });

  it('saves a built-in as a copy, and a new brush only with what the host uses', async () => {
    const lib = createBrushLibrary();
    show(BrushLibraryEditor, { library: lib, brushId: 'pencil-hb', profile: CANVAS_PROFILE });
    await settle();
    await press(byText('Save a copy'));
    expect((await lib.get('hb-pencil-copy'))?.builtin).toBe(false);
    await press(byText('New brush'));
    expect(q('[data-testid="brush-library-editor-title"]').textContent).toBe('New brush');
    expect(byText('Save')).toBeUndefined();
    setValue(q<HTMLInputElement>('input[aria-label="Brush name"]'), 'Canvas chalk');
    await press(byText('Save brush'));
    const fresh = (await lib.get('canvas-chalk'))!.brush;
    expect(fresh).toMatchObject({ name: 'Canvas chalk', kind: 'mark' });
    expect(fresh.dynamics?.velocitySize).toBeUndefined();
  });

  it('image: "Edit brush…" makes a brush in the library that the image editor then paints with', async () => {
    const lib = createBrushLibrary();
    const c = new ImageEditorController({ brushLibrary: lib });
    c.setTool('brush');
    show(BrushOptionsBar, { controller: c, renderBrushPreview: () => ({ data: 'AAAA', mimeType: 'image/png' }) });
    await press(byText('Edit brush…'));
    expect(q('[data-testid="brush-library-editor"]')).not.toBeNull();
    expect(q('img[alt="Brush preview"]').getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(target.querySelector('select[aria-label="Brush surface"]')).toBeNull();
    setValue(q<HTMLInputElement>('input[aria-label="Size"]'), '21');
    setValue(q<HTMLInputElement>('input[aria-label="Brush name"]'), 'Image ink');
    await press(byText('Save brush'));
    expect((await lib.get('image-ink'))!.brush.tip.size).toBe(21);
    expect(c.getState().paint).toMatchObject({ brushPreset: 'image-ink', brush: { size: 21 } });
  });

  it('vector: a brushstroke picks a brush from the library and edits it', async () => {
    const lib = createBrushLibrary();
    const c = new VectorEditorController({ document: { width: 200, height: 100, nodes: [{ id: 'a', type: 'path', subpaths: [{ closed: false, anchors: [{ x: 10, y: 50 }, { x: 190, y: 50 }] }], fill: null, stroke: '#1d4ed8', strokeWidth: 2 } as never] }, brushLibrary: lib });
    await c.whenBrushesLoaded();
    expect(c.addBrushstroke({ brushId: 'pencil-hb' }, { ids: ['a'] }).ok).toBe(true);
    c.select(['a']);
    show(VectorAppearancePanel, { controller: c, renderBrushPreview: () => ({ data: '', mimeType: 'image/png' }) });
    const stroke = () => (c.getState() as any).document.nodes[0].strokes.find((s: any) => s.kind === 'brushstroke').brush;
    await press(byText('Brush…'));
    await press([...target.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes('Ink pen')) as HTMLElement);
    expect(stroke().brushId).toBe('ink-pen');
    await press(byText('Edit brush…'));
    expect(q('[data-testid="brush-library-editor-title"]').textContent).toMatch(/Ink pen \(built in: saves a copy\)/);
    setValue(q<HTMLInputElement>('input[aria-label="Size"]'), '9');
    await press(byText('Save a copy'));
    await settle();
    expect(stroke()).toMatchObject({ brushId: 'ink-pen-copy', spec: { id: 'ink-pen-copy', tip: { size: 9 } } });
    setValue(q<HTMLInputElement>('input[aria-label="Size"]'), '4');
    await press(byText('Save'));
    await settle();
    expect(stroke().spec.tip.size).toBe(4);
  });
});
