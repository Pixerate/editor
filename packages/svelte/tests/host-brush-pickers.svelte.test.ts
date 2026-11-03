import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { BRUSH_PRESETS, CANVAS_PROFILE, createBrushLibrary, type Brush } from '@pixerate/editor/brushes';
import { ImageEditorController } from '@pixerate/editor/image-editor';
import { VectorEditorController } from '@pixerate/editor/vector';
import { loadCanvasBrushstrokeRenderer } from '@pixerate/editor/canvas';
import { BrushLibraryBrowser, brushLibraryState } from '../src/brushes';
import { BrushOptionsBar } from '../src/image-editor';
import { VectorAppearancePanel } from '../src/vector';
import { createCanvasBrushes } from '../src/canvas/shapeBrushstroke.svelte.js';

const pencil = BRUSH_PRESETS.find((b) => b.id === 'pencil-hb')!;
const myPencil: Brush = { ...pencil, id: 'my-pencil', name: 'My pencil', tip: { ...pencil.tip, size: 9 } };
const myWash: Brush = { ...BRUSH_PRESETS.find((b) => b.id === 'watercolor-wash')!, id: 'my-wash', name: 'My wash' };

let target: HTMLDivElement;
let component: Record<string, any> | null = null;
const settle = () => new Promise((r) => setTimeout(r, 20));
const option = (name: string) => [...target.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(name)) as HTMLElement | undefined;
const show = (C: any, props: Record<string, unknown>) => {
  component = mount(C, { target, props });
  flushSync();
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

const library = async () => {
  const lib = createBrushLibrary();
  await lib.save(myPencil);
  await lib.save(myWash);
  return lib;
};

describe('brush pickers on a shared library (Svelte)', () => {
  it('brushLibraryState filters by profile and follows the library; BrushLibraryBrowser picks', async () => {
    const lib = await library();
    let state: ReturnType<typeof brushLibraryState> | undefined;
    const cleanup = $effect.root(() => {
      state = brushLibraryState(() => lib, () => ({ profile: CANVAS_PROFILE }));
    });
    await settle();
    const ids = () => state!.entries.map((e) => e.brush.id);
    expect(ids()).toContain('my-pencil');
    expect(ids()).not.toContain('my-wash');
    await lib.save({ ...myPencil, id: 'my-second', name: 'My second' });
    await settle();
    expect(ids()).toContain('my-second');
    const picked: string[] = [];
    show(BrushLibraryBrowser, { entries: state!.entries, onselect: (id: string) => picked.push(id), thumbnail: () => 'data:image/png;base64,' });
    expect(target.querySelector('img[alt="My pencil thumbnail"]')).not.toBeNull();
    option('My pencil')!.click();
    expect(picked).toEqual(['my-pencil']);
    cleanup();
  });

  it('the image brush options pick a preset or saved brush from the library', async () => {
    const lib = await library();
    const c = new ImageEditorController({ brushLibrary: lib });
    c.setTool('brush');
    show(BrushOptionsBar, { controller: c });
    const toggle = target.querySelector('[data-testid="brush-presets"] button[aria-expanded]') as HTMLElement;
    toggle.click();
    flushSync();
    await settle();
    flushSync();
    expect(option('My wash')).toBeUndefined();
    option('My pencil')!.click();
    await settle();
    flushSync();
    expect(c.getState().paint).toMatchObject({ brushPreset: 'my-pencil', brush: { size: 9 } });
    expect(toggle.textContent).toContain('My pencil');
    option('Mixer Brush')!.click();
    await settle();
    expect(c.getState().activeTool).toBe('mixer');
  });

  it('the vector brushstroke menu lists saved brushes', async () => {
    const lib = await library();
    const c = new VectorEditorController({ document: { width: 200, height: 100, nodes: [{ id: 'a', type: 'path', subpaths: [{ closed: false, anchors: [{ x: 10, y: 50 }, { x: 190, y: 50 }] }], fill: null, stroke: '#1d4ed8', strokeWidth: 2 } as never] }, brushLibrary: lib });
    await c.whenBrushesLoaded();
    expect(c.addBrushstroke({ brushId: 'my-pencil' }, { ids: ['a'] }).ok).toBe(true);
    c.select(['a']);
    show(VectorAppearancePanel, { controller: c });
    const select = target.querySelector('select[aria-label$=" brush"]') as HTMLSelectElement;
    expect(select.value).toBe('my-pencil');
    expect([...select.options].map((o) => o.value)).toContain('my-pencil');
    expect([...select.options].map((o) => o.value)).not.toContain('my-wash');
  });

  it('createCanvasBrushes lists saved brushes with their spec and follows the library', async () => {
    const lib = await library();
    let brushes: ReturnType<typeof createCanvasBrushes> | undefined;
    const cleanup = $effect.root(() => {
      brushes = createCanvasBrushes({ library: lib });
    });
    await settle();
    expect(brushes!.brushes.find((b) => b.id === 'my-pencil')).toMatchObject({ builtin: false, size: 9, spec: { id: 'my-pencil' } });
    expect(brushes!.brushes.some((b) => b.id === 'my-wash')).toBe(false);
    await lib.remove('my-pencil');
    await settle();
    expect(brushes!.brushes.some((b) => b.id === 'my-pencil')).toBe(false);
    brushes!.dispose();
    cleanup();
  });
});
