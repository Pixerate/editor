// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { BRUSH_PRESETS, CANVAS_PROFILE, createBrushLibrary, type Brush } from '@pixerate/editor/brushes';
import { ImageEditorController } from '@pixerate/editor/image-editor';
import { VectorEditorController } from '@pixerate/editor/vector';
import { BrushLibraryBrowser, useBrushLibrary } from '../src/brushes';
import { BrushOptionsBar } from '../src/image-editor';
import { loadCanvasBrushstrokeRenderer, useCanvasBrushes, type CanvasBrushPreset } from '../src/canvas';
import { VectorAppearancePanel } from '../src/vector';

const pencil = BRUSH_PRESETS.find((b) => b.id === 'pencil-hb')!;
const myPencil: Brush = { ...pencil, id: 'my-pencil', name: 'My pencil', tip: { ...pencil.tip, size: 9 } };
const myWash: Brush = { ...BRUSH_PRESETS.find((b) => b.id === 'watercolor-wash')!, id: 'my-wash', name: 'My wash' };

let container: HTMLDivElement;
let root: any;
const settle = () => new Promise((r) => setTimeout(r, 20));
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const option = (name: string) => [...container.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(name));

beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
  await loadCanvasBrushstrokeRenderer();
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const library = async () => {
  const lib = createBrushLibrary();
  await lib.save(myPencil);
  await lib.save(myWash);
  return lib;
};

describe('brush pickers on a shared library (React)', () => {
  it('BrushLibraryBrowser filters by profile and follows the library through useBrushLibrary', async () => {
    const lib = await library();
    const picked: string[] = [];
    function Test() {
      const entries = useBrushLibrary(lib, { profile: CANVAS_PROFILE });
      return <BrushLibraryBrowser entries={entries} onSelect={(id) => picked.push(id)} thumbnail={() => 'data:image/png;base64,'} />;
    }
    await act(async () => root.render(<Test />));
    await act(settle);
    expect(option('My pencil')).toBeTruthy();
    expect(option('My wash')).toBeUndefined();
    expect(option('Wash brush')).toBeUndefined();
    expect(container.querySelector('img[alt="My pencil thumbnail"]')).not.toBeNull();
    click(option('My pencil'));
    expect(picked).toEqual(['my-pencil']);
    await act(async () => {
      await lib.save({ ...myPencil, id: 'my-second', name: 'My second' });
      await settle();
    });
    expect(option('My second')).toBeTruthy();
  });

  it('the image brush options pick a preset or saved brush from the library', async () => {
    const lib = await library();
    const c = new ImageEditorController({ brushLibrary: lib });
    c.setTool('brush');
    await act(async () => root.render(<BrushOptionsBar controller={c} />));
    const toggle = container.querySelector('[data-testid="brush-presets"] button[aria-expanded]')!;
    click(toggle);
    await act(settle);
    expect(option('My wash')).toBeUndefined();
    await act(async () => {
      (option('My pencil') as HTMLElement).click();
      await settle();
    });
    expect(c.getState().paint).toMatchObject({ brushPreset: 'my-pencil', brush: { size: 9 } });
    expect(toggle.textContent).toContain('My pencil');
    await act(async () => {
      (option('Mixer Brush') as HTMLElement).click();
      await settle();
    });
    expect(c.getState().activeTool).toBe('mixer');
  });

  it('the vector brushstroke menu lists saved brushes', async () => {
    const lib = await library();
    const c = new VectorEditorController({ document: { width: 200, height: 100, nodes: [{ id: 'a', type: 'path', subpaths: [{ closed: false, anchors: [{ x: 10, y: 50 }, { x: 190, y: 50 }] }], fill: null, stroke: '#1d4ed8', strokeWidth: 2 } as never] }, brushLibrary: lib });
    await c.whenBrushesLoaded();
    expect(c.addBrushstroke({ brushId: 'my-pencil' }, { ids: ['a'] }).ok).toBe(true);
    c.select(['a']);
    await act(async () => root.render(<VectorAppearancePanel controller={c} />));
    const select = container.querySelector('select[aria-label$=" brush"]') as HTMLSelectElement;
    expect(select.value).toBe('my-pencil');
    expect([...select.options].map((o) => o.value)).toContain('my-pencil');
    expect([...select.options].map((o) => o.value)).not.toContain('my-wash');
  });

  it('useCanvasBrushes lists saved brushes with their spec and follows the library', async () => {
    const lib = await library();
    const ref: { brushes: CanvasBrushPreset[] } = { brushes: [] };
    function Test() {
      ref.brushes = useCanvasBrushes({ library: lib }).brushes;
      return null;
    }
    await act(async () => root.render(<Test />));
    await act(settle);
    expect(ref.brushes.find((b) => b.id === 'my-pencil')).toMatchObject({ builtin: false, size: 9, spec: { id: 'my-pencil' } });
    expect(ref.brushes.some((b) => b.id === 'my-wash')).toBe(false);
    await act(async () => {
      await lib.remove('my-pencil');
      await settle();
    });
    expect(ref.brushes.some((b) => b.id === 'my-pencil')).toBe(false);
  });
});
