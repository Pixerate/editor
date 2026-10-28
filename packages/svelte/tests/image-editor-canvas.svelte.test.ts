import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { FreeTransformTool, createImageEditorToolProvider, imageToCanvasPoint } from '@pixerate/editor/image-editor';
import { ToolRegistry, createAgentPlayback, createInstantPresenceClock, type PlaybackRef } from '@pixerate/editor/tools';
import { ImageEditorCanvas, createReactiveImageEditor } from '../src/image-editor';

let target: HTMLDivElement;
let component: Record<string, any> | null = null;
const editors: { destroy(): void }[] = [];

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any;
  target = document.createElement('div');
  document.body.appendChild(target);
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  target.remove();
  editors.splice(0).forEach((e) => e.destroy());
});

const fake = { width: 300, height: 150, naturalWidth: 300, naturalHeight: 150, src: 'data:fake' } as unknown as HTMLImageElement;
const pointer = (type: string, x: number, y: number) => {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type.endsWith('up') ? 0 : 1 });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', pressure: 0.5 });
  return e;
};
const canvas = () => target.querySelector('[data-testid="image-editor-canvas"]') as HTMLCanvasElement;

function setup(props: Record<string, unknown> = {}) {
  const editor = createReactiveImageEditor({ image: fake });
  editors.push(editor);
  editor.controller.setSamplePixels({ width: 300, height: 150, data: new Uint8ClampedArray(300 * 150 * 4).fill(255) });
  component = mount(ImageEditorCanvas, { target, props: { editor, class: 'h-64 w-96', ...props } });
  flushSync();
  return { editor, c: editor.controller };
}

describe('ImageEditorCanvas (Svelte)', () => {
  it('renders on its own, sized by its box, with the class it is given', () => {
    setup();
    expect((target.querySelector('[data-testid="image-editor-canvas-root"]') as HTMLElement).className).toContain('h-64');
    expect(canvas()).toBeTruthy();
    expect(target.querySelector('textarea')).toBeNull();
  });

  it('ignores paint gestures in none mode', () => {
    const { c } = setup({ mode: 'none' });
    const id = c.addPixelLayer();
    c.setTool('brush');
    flushSync();
    canvas().dispatchEvent(pointer('pointerdown', 120, 70));
    canvas().dispatchEvent(pointer('pointermove', 150, 75));
    canvas().dispatchEvent(pointer('pointerup', 150, 75));
    expect(c.getLayerBounds(id)).toBeNull();
  });

  it('pans with a primary drag in pan mode, instead of painting', () => {
    const { c } = setup({ mode: 'paint', panMode: true });
    const id = c.addPixelLayer();
    c.setTool('brush');
    flushSync();
    canvas().dispatchEvent(pointer('pointerdown', 120, 70));
    canvas().dispatchEvent(pointer('mousedown', 120, 70));
    canvas().dispatchEvent(pointer('pointermove', 160, 90));
    canvas().dispatchEvent(pointer('mousemove', 160, 90));
    canvas().dispatchEvent(pointer('pointerup', 160, 90));
    canvas().dispatchEvent(pointer('mouseup', 160, 90));
    expect(c.getState().pan).toEqual({ x: 40, y: 20 });
    expect(c.getLayerBounds(id)).toBeNull();
  });

  it('paints in paint mode', () => {
    const { c } = setup({ mode: 'paint' });
    const id = c.addPixelLayer();
    c.setTool('brush');
    flushSync();
    canvas().dispatchEvent(pointer('pointerdown', 120, 70));
    canvas().dispatchEvent(pointer('pointermove', 150, 75));
    canvas().dispatchEvent(pointer('pointerup', 150, 75));
    expect(c.getLayerBounds(id)).not.toBeNull();
  });

  it('paints a freshly loaded image without picking a layer first', () => {
    const errors: Array<[string, string | null]> = [];
    const { c } = setup({ mode: 'paint', onerror: (source: string, message: string | null) => errors.push([source, message]) });
    expect(c.getState().activeLayerId).toBe('background');
    c.setTool('brush');
    flushSync();
    canvas().dispatchEvent(pointer('pointerdown', 120, 70));
    canvas().dispatchEvent(pointer('pointermove', 150, 75));
    canvas().dispatchEvent(pointer('pointerup', 150, 75));
    expect(errors.every(([, message]) => message === null)).toBe(true);
    expect(c.getLayer('background')).not.toHaveProperty('source');
  });

  it('reports gesture errors through onerror, written for a person', () => {
    const errors: Array<[string, string | null]> = [];
    const { c } = setup({ mode: 'paint', onerror: (source: string, message: string | null) => errors.push([source, message]) });
    c.removeLayer('background');
    c.setTool('brush');
    flushSync();
    canvas().dispatchEvent(pointer('pointerdown', 50, 50));
    expect(errors.at(-1)).toEqual(['paint', 'Pick a layer to paint on in the Layers panel.']);
    c.setTool('move');
    flushSync();
    canvas().dispatchEvent(pointer('pointerdown', 50, 50));
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

    it('paints where the pointer is (pointer events)', () => {
      const { c } = setup({ mode: 'paint' });
      const id = c.addPixelLayer();
      c.setTool('brush');
      c.setPaintOptions({ brush: { size: 4, hardness: 1 } });
      flushSync();
      const a = client(c, { x: 140, y: 75 });
      const b = client(c, { x: 160, y: 75 });
      canvas().dispatchEvent(pointer('pointerdown', a.x, a.y));
      canvas().dispatchEvent(pointer('pointermove', b.x, b.y));
      canvas().dispatchEvent(pointer('pointerup', b.x, b.y));
      const bounds = c.getLayerBounds(id)!;
      expect(bounds.x + bounds.width / 2).toBeCloseTo(150, 0);
      expect(bounds.y + bounds.height / 2).toBeCloseTo(75, 0);
      expect(bounds.width).toBeLessThan(30);
    });

    it('drags the crop handle where the mouse is (mouse events)', () => {
      const { c } = setup({ mode: 'crop' });
      c.setTool('crop');
      flushSync();
      const from = client(c, { x: 300, y: 150 }, true);
      const to = client(c, { x: 200, y: 100 }, true);
      canvas().dispatchEvent(pointer('mousedown', from.x, from.y));
      canvas().dispatchEvent(pointer('mousemove', to.x, to.y));
      canvas().dispatchEvent(pointer('mouseup', to.x, to.y));
      const crop = c.getState().crop!;
      expect(crop.x).toBeCloseTo(0, 0);
      expect(Math.abs(crop.width - 200)).toBeLessThanOrEqual(2);
      expect(Math.abs(crop.height - 100)).toBeLessThanOrEqual(2);
    });
  });

  it('crops in crop mode', () => {
    const { c } = setup({ mode: 'crop' });
    c.setTool('crop');
    flushSync();
    canvas().dispatchEvent(pointer('mousedown', 10, 10));
    canvas().dispatchEvent(pointer('mousemove', 200, 120));
    canvas().dispatchEvent(pointer('mouseup', 200, 120));
    expect(c.getState().crop).not.toBeNull();
  });

  it('drives a Free Transform tool the host passes in', () => {
    const editor = createReactiveImageEditor({ image: fake });
    editors.push(editor);
    const c = editor.controller;
    c.setSamplePixels({ width: 300, height: 150, data: new Uint8ClampedArray(300 * 150 * 4).fill(255) });
    c.addPixelLayer({ name: 'P', color: '#3366cc' });
    const tool = new FreeTransformTool(c);
    component = mount(ImageEditorCanvas, { target, props: { editor, transformTool: tool } });
    flushSync();
    tool.begin();
    flushSync();
    expect(tool.active).toBe(true);
    expect(canvas().className).toContain('touch-none');
    tool.cancel();
    flushSync();
    expect(canvas().className).not.toContain('touch-none');
  });

  it('plays on its surface and answers chrome refs through locateElement and open', async () => {
    const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
    const registry = new ToolRegistry();
    playback.install(registry);
    const opened: PlaybackRef[] = [];
    const slider = document.createElement('div');
    slider.getBoundingClientRect = () => ({ left: 10, top: 10, width: 20, height: 10, right: 30, bottom: 20, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
    const { c } = setup({
      playback,
      playbackId: 'img',
      locateElement: (ref: PlaybackRef) => (ref.kind === 'control' ? slider : null),
      open: (ref: PlaybackRef) => void opened.push(ref),
    });
    registry.register(createImageEditorToolProvider(c, { id: 'img', namespace: 'img' }));
    const surface = playback.surface('img')!;
    expect(surface).toBeTruthy();
    (surface as { visible?: () => boolean }).visible = () => true;
    expect(surface.locate!({ kind: 'control', id: 'contrast' })).toBeTruthy();
    const steps = playback.record();
    const result = await registry.callTool('img__set_adjustments', { values: { contrast: 20 } });
    flushSync();
    expect(result.isError).toBeFalsy();
    expect(steps.map((r) => r.step.type)).toEqual(['open', 'target', 'commit']);
    expect(opened).toEqual([{ kind: 'panel', id: 'adjust' }]);
    expect(target.querySelector('.pixerate-presence')).toBeTruthy();
  });

  it("draws the crop box while the agent drags it out, then the call's real crop", async () => {
    const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
    const registry = new ToolRegistry();
    playback.install(registry);
    const { c } = setup({ mode: 'crop', playback, playbackId: 'img', open: () => {} });
    registry.register(createImageEditorToolProvider(c, { id: 'img', namespace: 'img' }));
    (playback.surface('img') as { visible?: () => boolean }).visible = () => true;
    const drafts: unknown[] = [];
    const render = c.render.bind(c);
    c.render = ((canvasEl: HTMLCanvasElement, options: { draftCrop?: unknown }) => {
      drafts.push(options?.draftCrop ?? null);
      return render(canvasEl, options as never);
    }) as typeof c.render;
    const result = await registry.callTool('img__set_crop', { x: 20, y: 10, width: 120, height: 80 });
    flushSync();
    expect(result.isError).toBeFalsy();
    expect(drafts.some((d) => d && (d as { width: number }).width > 1)).toBe(true);
    expect(drafts.at(-1)).toBeNull();
    expect(c.getState().crop).toMatchObject({ x: 20, y: 10, width: 120, height: 80 });
  });
});
