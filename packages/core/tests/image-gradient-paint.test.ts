import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, readPixel, readDeepRegion, type PixelLayer } from '../src/image-editor';
import type { PaintGradientSource } from '../src/paint';

const W = 400;
const H = 60;
const BLUE_YELLOW: PaintGradientSource = { type: 'gradient', stops: [{ offset: 0, color: '#1d4ed8' }, { offset: 1, color: '#facc15' }], space: 'pigment', map: { by: 'distance', length: 300, repeat: 'clamp', unit: 'px' } };

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  const call = (name: string, args: Record<string, unknown> = {}) => registry.callTool(name, args);
  const parse = (r: { content: Array<{ text?: string }>; structuredContent?: unknown }) => (r.structuredContent ?? JSON.parse(r.content[0].text!)) as Record<string, any>;
  return { c, call, parse };
}

const line = (y = 30, x0 = 10, x1 = 390) => Array.from({ length: 40 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 39, y }));
const pixel = (c: ImageEditorController, id: string, x: number, y: number) => {
  const l = c.getLayer(id) as PixelLayer;
  return readPixel(l.surface, x - l.offset.x, y - l.offset.y);
};

describe('gradient paint in the image editor', () => {
  it('the brush changes colour as the stroke is dragged out; a colour goes back to one colour', () => {
    const { c } = setup();
    const id = c.addPixelLayer();
    c.setPaintOptions({ paint: BLUE_YELLOW });
    expect(c.getState().paint.paint).toEqual(BLUE_YELLOW);
    c.paintStroke({ points: line(), brush: { size: 12, pressureSize: false } });
    const start = pixel(c, id, 12, 30);
    const middle = pixel(c, id, 160, 30);
    const end = pixel(c, id, 380, 30);
    expect(start[2]).toBeGreaterThan(start[0] + 100);
    expect(middle[1]).toBeGreaterThan(middle[0]);
    expect(middle[1]).toBeGreaterThan(middle[2]);
    expect(end.slice(0, 3)).toEqual([250, 204, 21]);
    // A colour for one stroke paints that colour; setting the foreground goes back to one colour.
    c.paintStroke({ points: line(50), color: '#c0392b', brush: { size: 6, pressureSize: false } });
    expect(pixel(c, id, 200, 50).slice(0, 3)).toEqual([192, 57, 43]);
    c.setPaintOptions({ foreground: '#00ff00' });
    expect(c.getState().paint.paint).toEqual({ type: 'color', color: '#00ff00' });
  });

  it('paint and secondary stops are the foreground and background; on a mask each colour is its grey', () => {
    const { c } = setup();
    const id = c.addPixelLayer({ color: '#808080' });
    c.setPaintOptions({ foreground: '#000000', background: '#ffffff' });
    c.setPaintOptions({ paint: { type: 'gradient', stops: [{ offset: 0, color: 'paint' }, { offset: 1, color: 'secondary' }], map: { by: 'distance', length: 380, repeat: 'clamp' }, space: 'srgb' } });
    c.addLayerMask(id, 'hide-all');
    c.paintStroke({ points: line(), channel: 'mask', brush: { size: 12, pressureSize: false } });
    const mask = (c.getLayer(id) as PixelLayer).mask!.surface;
    const g0 = readPixel(mask, 12, 30)[0];
    const g1 = readPixel(mask, 380, 30)[0];
    expect(g0).toBeLessThan(20);
    expect(g1).toBeGreaterThan(230);
  });

  it('paints a gradient at 16 bits too', async () => {
    const { c, call } = setup();
    const id = c.addPixelLayer();
    const r = await call('set_bit_depth', { depth: 16 });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    c.paintStroke({ layerId: id, points: line(), paint: BLUE_YELLOW, brush: { size: 12, pressureSize: false } });
    const deep = readDeepRegion((c.getLayer(id) as PixelLayer).surface, { x: 0, y: 0, width: W, height: H }, 16) as Uint16Array;
    const at = (x: number) => [...deep.subarray((30 * W + x) * 4, (30 * W + x) * 4 + 4)];
    expect(at(12)[2]).toBeGreaterThan(at(12)[0]);
    expect(at(380)[0]).toBeGreaterThan(at(380)[2]);
  });
});

describe('gradient paint image tools', () => {
  it('set_paint, get_paint and paint_stroke paint close the loop', async () => {
    const { c, call, parse } = setup();
    const id = c.addPixelLayer();
    let r = await call('set_paint', { paint: BLUE_YELLOW });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(parse(r).paint).toEqual(BLUE_YELLOW);
    r = await call('get_paint');
    expect(parse(r)).toMatchObject({ paint: BLUE_YELLOW, foreground: '#000000', background: '#ffffff' });
    r = await call('paint_stroke', { points: line(), paint: { ...BLUE_YELLOW, map: { by: 'random' } }, brush: { size: 10 } });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(pixel(c, id, 200, 30)[3]).toBe(255);
    r = await call('set_paint', { paint: { type: 'color', color: '#123456' } });
    expect(parse(r)).toMatchObject({ paint: { type: 'color', color: '#123456' }, foreground: '#123456' });
  });

  it('refuses bad gradients and paint where it does not apply, with reasons', async () => {
    const { c, call } = setup();
    c.addPixelLayer();
    let r = await call('set_paint', { paint: { type: 'gradient', stops: [{ offset: 1, color: '#000000' }, { offset: 0, color: '#ffffff' }] } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/sorted by offset/);
    r = await call('paint_stroke', { points: line(), tool: 'eraser', paint: BLUE_YELLOW });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/brush only/);
    r = await call('paint_stroke', { points: line(), color: '#ff0000', paint: BLUE_YELLOW });
    expect(r.isError).toBe(true);
    r = await call('set_paint', { paint: { type: 'gradient', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }], map: { by: 'distance', length: -5 } } });
    expect(r.isError).toBe(true);
  });
});
