// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { ImageEditorCanvas, useImageEditor, type ImageEditorCanvasProps, type UseImageEditorReturn } from '../src/image-editor';
import { FreeTransformTool, createImageEditorToolProvider, imageToCanvasPoint } from '@pixerate/editor/image-editor';
import { ToolRegistry, createAgentPlayback, createInstantPresenceClock, type PlaybackRef } from '@pixerate/editor/tools';
import { useAgentToolProvider } from '../src';

let container: HTMLDivElement;
let root: any;
const win: any = window;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
});
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  container = document.getElementById('root') as HTMLDivElement;
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

const fake = { width: 300, height: 150, naturalWidth: 300, naturalHeight: 150, src: 'data:fake' } as unknown as HTMLImageElement;
const pointer = (type: string, x: number, y: number) => {
  const e = new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'pointerup' ? 0 : 1 });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', pressure: 0.5 });
  return e;
};
const canvas = () => container.querySelector('[data-testid="image-editor-canvas"]') as HTMLCanvasElement;

async function renderCanvas(props: Partial<ImageEditorCanvasProps> = {}) {
  let editor!: UseImageEditorReturn;
  function Host() {
    editor = useImageEditor({ image: fake });
    return <ImageEditorCanvas editor={editor} className="h-64 w-96" {...props} />;
  }
  await act(async () => root.render(<Host />));
  const c = editor.controller;
  c.setSamplePixels({ width: 300, height: 150, data: new Uint8ClampedArray(300 * 150 * 4).fill(255) });
  return { editor: () => editor, c };
}

describe('ImageEditorCanvas (React)', () => {
  it('picks the composite colour as the foreground in sample mode (the Eyedropper)', async () => {
    const picked: string[] = [];
    const { c } = await renderCanvas({ mode: 'sample', onSample: (color) => picked.push(color) });
    await act(async () => {
      c.addPixelLayer({ color: '#3366cc' });
      c.setTool('eyedropper');
    });
    await act(async () => {
      canvas().dispatchEvent(pointer('mousedown', 400, 250));
    });
    expect(picked).toEqual(['#3366cc']);
    expect(c.getState().paint.foreground).toBe('#3366cc');
  });

  it('renders on its own, sized by its box, with the class it is given', async () => {
    await renderCanvas();
    const rootEl = container.querySelector('[data-testid="image-editor-canvas-root"]') as HTMLElement;
    expect(rootEl.className).toContain('h-64');
    expect(canvas()).toBeTruthy();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('paints in paint mode and ignores the same gesture in none mode', async () => {
    const { c } = await renderCanvas({ mode: 'none' });
    let id!: string;
    await act(async () => {
      id = c.addPixelLayer();
      c.setTool('brush');
    });
    await act(async () => {
      canvas().dispatchEvent(pointer('pointerdown', 120, 70));
      canvas().dispatchEvent(pointer('pointermove', 150, 75));
      canvas().dispatchEvent(pointer('pointerup', 150, 75));
    });
    expect(c.getLayerBounds(id)).toBeNull();
  });

  it('paints in paint mode', async () => {
    const { c } = await renderCanvas({ mode: 'paint' });
    let id!: string;
    await act(async () => {
      id = c.addPixelLayer();
      c.setTool('brush');
    });
    await act(async () => {
      canvas().dispatchEvent(pointer('pointerdown', 120, 70));
      canvas().dispatchEvent(pointer('pointermove', 150, 75));
      canvas().dispatchEvent(pointer('pointerup', 150, 75));
    });
    expect(c.getLayerBounds(id)).not.toBeNull();
  });

  it('paints a freshly loaded image without picking a layer first', async () => {
    const errors: Array<[string, string | null]> = [];
    const { c } = await renderCanvas({ mode: 'paint', onError: (source, message) => errors.push([source, message]) });
    expect(c.getState().activeLayerId).toBe('background');
    await act(async () => c.setTool('brush'));
    await act(async () => {
      canvas().dispatchEvent(pointer('pointerdown', 120, 70));
      canvas().dispatchEvent(pointer('pointermove', 150, 75));
      canvas().dispatchEvent(pointer('pointerup', 150, 75));
    });
    expect(errors.every(([, message]) => message === null)).toBe(true);
    expect(c.getLayer('background')).not.toHaveProperty('source');
  });

  it('reports gesture errors through onError, written for a person', async () => {
    const errors: Array<[string, string | null]> = [];
    const { c } = await renderCanvas({ mode: 'paint', onError: (source, message) => errors.push([source, message]) });
    await act(async () => {
      c.removeLayer('background');
      c.setTool('brush');
    });
    await act(async () => canvas().dispatchEvent(pointer('pointerdown', 50, 50)));
    expect(errors.at(-1)).toEqual(['paint', 'Pick a layer to paint on in the Layers panel.']);
    await act(async () => c.setTool('move'));
    await act(async () => canvas().dispatchEvent(pointer('pointerdown', 50, 50)));
    expect(errors.at(-1)).toEqual(['paint', 'Select a layer to move in the Layers panel.']);
  });

  describe('under a host CSS transform', () => {
    // A 220 × 110 node scaled to 500px wide on screen, as a host's expanded view does.
    const W = 220;
    const H = 110;
    const SCALE = 500 / W;
    const LEFT = 10;
    const TOP = 20;
    const restores: Array<() => void> = [];
    beforeEach(() => {
      for (const [key, value] of [['clientWidth', W], ['offsetWidth', W], ['clientHeight', H], ['offsetHeight', H]] as const) {
        const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
        Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
        restores.push(() => (own ? Object.defineProperty(HTMLElement.prototype, key, own) : delete (HTMLElement.prototype as any)[key]));
      }
      const rect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = () =>
        ({ left: LEFT, top: TOP, x: LEFT, y: TOP, width: W * SCALE, height: H * SCALE, right: LEFT + W * SCALE, bottom: TOP + H * SCALE }) as DOMRect;
      restores.push(() => (Element.prototype.getBoundingClientRect = rect));
    });
    afterEach(() => restores.splice(0).forEach((r) => r()));
    /** The client point where the canvas shows document point `p` (CSS-pixel projection, then the transform). */
    const client = (c: { getState(): any }, p: { x: number; y: number }, cropping = false) => {
      const q = imageToCanvasPoint(p, c.getState(), W, H, cropping);
      return { x: LEFT + q.x * SCALE, y: TOP + q.y * SCALE };
    };

    it('paints where the pointer is (pointer events)', async () => {
      const { c } = await renderCanvas({ mode: 'paint' });
      let id!: string;
      await act(async () => {
        id = c.addPixelLayer();
        c.setTool('brush');
        c.setPaintOptions({ brush: { size: 4, hardness: 1 } });
      });
      const a = client(c, { x: 140, y: 75 });
      const b = client(c, { x: 160, y: 75 });
      await act(async () => {
        canvas().dispatchEvent(pointer('pointerdown', a.x, a.y));
        canvas().dispatchEvent(pointer('pointermove', b.x, b.y));
        canvas().dispatchEvent(pointer('pointerup', b.x, b.y));
      });
      const bounds = c.getLayerBounds(id)!;
      expect(bounds.x + bounds.width / 2).toBeCloseTo(150, 0);
      expect(bounds.y + bounds.height / 2).toBeCloseTo(75, 0);
      expect(bounds.width).toBeLessThan(30);
    });

    it('drags the crop handle where the mouse is (mouse events)', async () => {
      const { c } = await renderCanvas({ mode: 'crop' });
      await act(async () => c.setTool('crop'));
      const from = client(c, { x: 300, y: 150 }, true);
      const to = client(c, { x: 200, y: 100 }, true);
      await act(async () => {
        canvas().dispatchEvent(pointer('mousedown', from.x, from.y));
        canvas().dispatchEvent(pointer('mousemove', to.x, to.y));
        canvas().dispatchEvent(pointer('mouseup', to.x, to.y));
      });
      const crop = c.getState().crop!;
      expect(crop.x).toBeCloseTo(0, 0);
      expect(Math.abs(crop.width - 200)).toBeLessThanOrEqual(2);
      expect(Math.abs(crop.height - 100)).toBeLessThanOrEqual(2);
    });
  });

  it('crops in crop mode', async () => {
    const { c } = await renderCanvas({ mode: 'crop' });
    await act(async () => c.setTool('crop'));
    await act(async () => {
      canvas().dispatchEvent(pointer('mousedown', 10, 10));
      canvas().dispatchEvent(pointer('mousemove', 200, 120));
      canvas().dispatchEvent(pointer('mouseup', 200, 120));
    });
    expect(c.getState().crop).not.toBeNull();
  });

  it('drives a Free Transform tool the host passes in', async () => {
    let tool!: FreeTransformTool;
    let editor!: UseImageEditorReturn;
    function Host() {
      editor = useImageEditor({ image: fake });
      const [t] = React.useState(() => new FreeTransformTool(editor.controller));
      tool = t;
      return <ImageEditorCanvas editor={editor} transformTool={t} />;
    }
    await act(async () => root.render(<Host />));
    const c = editor.controller;
    c.setSamplePixels({ width: 300, height: 150, data: new Uint8ClampedArray(300 * 150 * 4).fill(255) });
    await act(async () => void c.addPixelLayer({ name: 'P', color: '#3366cc' }));
    await act(async () => void tool.begin());
    expect(tool.active).toBe(true);
    expect(canvas().className).toContain('touch-none');
    await act(async () => tool.cancel());
    expect(canvas().className).not.toContain('touch-none');
  });

  it('plays on its surface and answers chrome refs through locateElement and open', async () => {
    const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
    const registry = new ToolRegistry();
    const opened: PlaybackRef[] = [];
    const slider = document.createElement('div');
    slider.getBoundingClientRect = () => ({ left: 10, top: 10, width: 20, height: 10, right: 30, bottom: 20, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
    function Host() {
      const editor = useImageEditor({ image: fake });
      const provider = useMemo(() => createImageEditorToolProvider(editor.controller, { id: 'img', namespace: 'img' }), [editor.controller]);
      useAgentToolProvider(registry, provider, { playback });
      return (
        <ImageEditorCanvas
          editor={editor}
          playback={playback}
          playbackId="img"
          locateElement={(ref) => (ref.kind === 'control' ? slider : null)}
          open={(ref) => void opened.push(ref)}
        />
      );
    }
    await act(async () => root.render(<Host />));
    const surface = playback.surface('img')!;
    expect(surface).toBeTruthy();
    (surface as { visible?: () => boolean }).visible = () => true;
    expect(surface.locate!({ kind: 'control', id: 'contrast' })).toBeTruthy();
    const steps = playback.record();
    const result = await act(() => registry.callTool('img__set_adjustments', { values: { contrast: 20 } }));
    expect(result.isError).toBeFalsy();
    expect(steps.map((r) => r.step.type)).toEqual(['open', 'target', 'commit']);
    expect(opened).toEqual([{ kind: 'panel', id: 'adjust' }]);
    expect(container.querySelector('.pixerate-presence')).toBeTruthy();
  });

  it("draws the crop box while the agent drags it out, then the call's real crop", async () => {
    const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
    const registry = new ToolRegistry();
    const drafts: unknown[] = [];
    let controller: UseImageEditorReturn['controller'] | null = null;
    function Host() {
      const editor = useImageEditor({ image: fake });
      controller = editor.controller;
      const provider = useMemo(() => {
        const render = editor.controller.render.bind(editor.controller);
        editor.controller.render = ((canvasEl: HTMLCanvasElement, options: { draftCrop?: unknown }) => {
          drafts.push(options?.draftCrop ?? null);
          return render(canvasEl, options as never);
        }) as typeof editor.controller.render;
        return createImageEditorToolProvider(editor.controller, { id: 'img', namespace: 'img' });
      }, [editor.controller]);
      useAgentToolProvider(registry, provider, { playback });
      return <ImageEditorCanvas editor={editor} mode="crop" playback={playback} playbackId="img" open={() => {}} />;
    }
    await act(async () => root.render(<Host />));
    (playback.surface('img') as { visible?: () => boolean }).visible = () => true;
    const result = await act(() => registry.callTool('img__set_crop', { x: 20, y: 10, width: 120, height: 80 }));
    expect(result.isError).toBeFalsy();
    expect(drafts.some((d) => d && (d as { width: number }).width > 1)).toBe(true);
    expect(drafts.at(-1)).toBeNull();
    expect(controller!.getState().crop).toMatchObject({ x: 20, y: 10, width: 120, height: 80 });
  });
});
