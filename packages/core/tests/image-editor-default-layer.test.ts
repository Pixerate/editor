import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  LayerOperationError,
  PaintGesture,
  createImageEditorToolProvider,
  defaultActiveLayerId,
  readPixel,
  userErrorMessage,
  type PixelLayer,
} from '../src/image-editor';

const W = 60;
const H = 40;

function setup(options: ConstructorParameters<typeof ImageEditorController>[0] = {}) {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, ...options });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, registry };
}

const pixel = (c: ImageEditorController, id: string, x: number, y: number) => {
  const l = c.getLayer(id) as PixelLayer;
  return readPixel(l.surface, x - l.offset.x, y - l.offset.y);
};
const text = (res: { content?: unknown[] }) => String((res.content?.[0] as { text?: string })?.text);

describe('default active layer', () => {
  it('a freshly loaded image starts on its Background', async () => {
    const { c, registry } = setup();
    expect(c.getState().activeLayerId).toBe('background');
    expect(c.getState().activeTarget).toBe('pixels');
    const list = await registry.callTool('list_layers', {});
    expect(list.structuredContent).toMatchObject({ activeLayerId: 'background' });
  });

  it('paint_stroke paints a new image without a layerId', async () => {
    const { c, registry } = setup();
    const res = await registry.callTool('paint_stroke', { points: [{ x: 10, y: 10 }, { x: 40, y: 10 }], color: '#123456', brush: { size: 6, hardness: 1 } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ layerId: 'background', channel: 'pixels', bounds: expect.any(Object) });
    expect(pixel(c, 'background', 30, 10)).toEqual([0x12, 0x34, 0x56, 255]);
    expect(c.undo()).toBe(true);
    expect(c.getState().activeLayerId).toBe('background');
  });

  it('fill_pixels fills a new image without a layerId', async () => {
    const { c, registry } = setup();
    const res = await registry.callTool('fill_pixels', { color: '#ff0000', useSelection: false });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ layerId: 'background' });
    expect(pixel(c, 'background', 5, 5)).toEqual([255, 0, 0, 255]);
  });

  it('a paint gesture on a new image paints the Background', () => {
    const { c } = setup();
    c.setTool('brush');
    c.setPaintOptions({ foreground: '#00ff00', brush: { size: 6, hardness: 1 } });
    const g = new PaintGesture(c);
    expect(g.down({ x: 10, y: 20, pressure: 1 })).toBeNull();
    g.moveTo([{ x: 40, y: 20, pressure: 1 }]);
    g.up();
    expect(g.error).toBeNull();
    expect(pixel(c, 'background', 25, 20)).toEqual([0, 255, 0, 255]);
  });

  it('keeps the default through loadImage, reset and v1 / v2 documents', async () => {
    const { c } = setup();
    c.addPixelLayer();
    c.reset();
    expect(c.getState().activeLayerId).toBe('background');
    c.loadJSON({ version: 2, adjustments: { brightness: 10 } } as never);
    expect(c.getState().activeLayerId).toBe('background');
    await c.loadImage({ width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement);
    expect(c.getState().activeLayerId).toBe('background');
  });

  it('a layered document saved without an active layer opens on the topmost paintable pixel layer', () => {
    const { c } = setup();
    const lower = c.addPixelLayer({ name: 'lower' });
    const hidden = c.addPixelLayer({ name: 'hidden' });
    const locked = c.addPixelLayer({ name: 'locked' });
    c.setLayerProperties(hidden, { visible: false });
    c.setLayerProperties(locked, { locks: { pixels: true } });
    const saved = { ...c.toJSON(), activeLayerId: null };
    const { c: d } = setup();
    d.loadJSON(saved as never);
    expect(d.getState().activeLayerId).toBe(lower);
    expect(defaultActiveLayerId(d.getLayers())).toBe(lower);
  });

  it('removing the active layer activates the nearest paintable layer below it', async () => {
    const { c, registry } = setup();
    const a = c.addPixelLayer({ name: 'a' });
    const hidden = c.addPixelLayer({ name: 'hidden' });
    c.setLayerProperties(hidden, { visible: false });
    const top = c.addPixelLayer({ name: 'top' });
    expect(c.getState().activeLayerId).toBe(top);
    const res = await registry.callTool('remove_layer', { layerId: top });
    expect(res.structuredContent).toMatchObject({ removed: top, activeLayerId: a });
    expect(c.getState().activeLayerId).toBe(a);
    c.removeLayer(a);
    expect(c.getState().activeLayerId).toBe('background');
    expect(c.undo()).toBe(true);
    expect(c.getState().activeLayerId).toBe(a);
  });

  it('removing an active adjustment layer moves to a paintable layer', () => {
    const { c } = setup();
    const id = c.addAdjustmentLayer('invert');
    c.setActiveLayer(id);
    c.removeAdjustmentLayer(id);
    expect(c.getState().activeLayerId).toBe('background');
  });
});

describe('paint refusals', () => {
  it('tell agents which tool to call and people what to do', async () => {
    const { c, registry } = setup();
    c.removeLayer('background');
    expect(c.getState().activeLayerId).toBeNull();
    const res = await registry.callTool('paint_stroke', { points: [{ x: 1, y: 1 }] });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/pass layerId \(see list_layers\)/);
    c.setTool('brush');
    const g = new PaintGesture(c);
    expect(g.down({ x: 5, y: 5, pressure: 1 })).toBe('Pick a layer to paint on in the Layers panel.');
    c.setTool('eraser');
    expect(g.down({ x: 5, y: 5, pressure: 1 })).toBe('Pick a layer to erase on in the Layers panel.');
  });

  it('name no tools for people when the layer is not a pixel layer', () => {
    const { c } = setup();
    const id = c.addAdjustmentLayer({ kind: 'invert', name: 'Invert' });
    c.setActiveLayer(id);
    c.setTool('brush');
    const err = (() => {
      try {
        c.beginStroke();
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(LayerOperationError);
    expect((err as Error).message).toMatch(/channel mask/);
    expect(userErrorMessage(err)).toBe('"Invert" is not a pixel layer; pick a pixel layer to paint on.');
  });

  it('userErrorMessage falls back to the message', () => {
    expect(userErrorMessage(new LayerOperationError('agent text'))).toBe('agent text');
    expect(userErrorMessage(new LayerOperationError('agent text', 'person text'))).toBe('person text');
    expect(userErrorMessage(new Error('plain'))).toBe('plain');
    expect(userErrorMessage('str')).toBe('str');
  });
});
