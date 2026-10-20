import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  createImageEditorToolProvider,
  readDeepRegion,
  surfaceDepth,
  surfaceFromDeepPixels,
  type PixelLayer,
} from '../src/image-editor';
import { exportPsd } from '../src/image-editor/psd/export';
import { readRegion } from '../src/image-editor';

const W = 300;
const H = 40;
const ALL = { x: 0, y: 0, width: W, height: H };

/** A flat mid grey in 16 bits (every tile deep). */
function grey16(v = 30000): Uint16Array {
  const out = new Uint16Array(W * H * 4);
  for (let i = 0; i < W * H; i++) out.set([v, v, v, 65535], i * 4);
  return out;
}

function psdOf(data: Uint16Array | Float32Array, depth: 16 | 32): Uint8Array {
  const layer: PixelLayer = {
    type: 'pixel',
    id: 'Deep',
    name: 'Deep',
    visible: true,
    opacity: 1,
    blend: 'normal',
    surface: surfaceFromDeepPixels({ width: W, height: H, data }, 4),
    offset: { x: 0, y: 0 },
  };
  return exportPsd({ width: W, height: H, layers: [layer], merged: readRegion(layer.surface, ALL), depth }).bytes;
}

function setup(depth: 16 | 32, data: Uint16Array | Float32Array = grey16()) {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  c.loadPsd(psdOf(data, depth));
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, registry };
}

const surfaceOf = (c: ImageEditorController, id: string) => (c.getLayer(id) as PixelLayer).surface;

function distinct(samples: ArrayLike<number>, channel = 0): number {
  const s = new Set<number>();
  for (let i = channel; i < samples.length; i += 4) s.add(samples[i]);
  return s.size;
}

describe('painting at 16 and 32 bits', () => {
  it('a soft 16-bit brush stroke keeps more than 256 levels and stays one undo step', async () => {
    const { c, registry } = setup(16);
    const id = c.getLayers()[0].id;
    expect(c.bitDepth).toBe(16);
    const before = readDeepRegion(surfaceOf(c, id), ALL, 16);
    const res = await registry.callTool('paint_stroke', {
      layerId: id,
      points: [{ x: 20, y: 20 }, { x: 280, y: 20 }],
      color: '#ffffff',
      brush: { size: 60, hardness: 0, opacity: 1 },
    });
    expect(res.isError).toBeFalsy();
    const s = surfaceOf(c, id);
    expect(surfaceDepth(s)).toBe(16);
    // Every tile keeps its deep samples, painted or not.
    for (const tile of s.tiles.values()) expect(tile.deep).toBeInstanceOf(Uint16Array);
    const after = readDeepRegion(s, ALL, 16);
    expect(after).not.toEqual(before);
    // The soft edge runs from grey to white through far more than 8 bits of levels.
    expect(distinct(after)).toBeGreaterThan(256);
    c.undo();
    expect(readDeepRegion(surfaceOf(c, id), ALL, 16)).toEqual(before);
  });

  it('the eraser, fill and clear keep deep tiles', () => {
    const { c } = setup(16);
    const id = c.getLayers()[0].id;
    c.paintStroke({ tool: 'eraser', layerId: id, points: [{ x: 150, y: 20 }], brush: { size: 200, hardness: 0 } });
    const erased = readDeepRegion(surfaceOf(c, id), ALL, 16);
    expect(erased[(20 * W + 150) * 4 + 3]).toBeLessThan(65535);
    expect(distinct(erased, 3)).toBeGreaterThan(256);
    c.fillPixels({ layerId: id, color: '#808080', opacity: 0.5 });
    for (const tile of surfaceOf(c, id).tiles.values()) expect(tile.deep).toBeInstanceOf(Uint16Array);
    c.clearPixels({ layerId: id });
    expect(surfaceOf(c, id).tiles.size).toBe(0);
    c.undo();
    expect(surfaceDepth(surfaceOf(c, id))).toBe(16);
  });

  it('a 32-bit stroke paints in linear light and keeps values above 1', () => {
    // Linear grey, with the top rows above 1 as an HDR file would have.
    const hot = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) hot.set([i < W * 4 ? 4 : 0.2, 0.2, 0.2, 1], i * 4);
    const { c } = setup(32, hot);
    expect(c.bitDepth).toBe(32);
    const id = c.getLayers()[0].id;
    c.paintStroke({ layerId: id, points: [{ x: 150, y: 30 }], color: '#ffffff', brush: { size: 10, hardness: 1, opacity: 0.5 } });
    const out = readDeepRegion(surfaceOf(c, id), ALL, 32) as Float32Array;
    expect(surfaceDepth(surfaceOf(c, id))).toBe(32);
    expect(out[0]).toBe(4);
    // Half of white over linear grey: the mean of the two in linear light.
    const g = hot[(30 * W + 150) * 4];
    expect(out[(30 * W + 150) * 4]).toBeCloseTo((g + 1) / 2, 2);
  });

  it('an 8-bit document still paints 8-bit tiles', () => {
    const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
    const id = c.addPixelLayer({ color: '#336699' });
    c.paintStroke({ layerId: id, points: [{ x: 20, y: 20 }], color: '#ffffff', brush: { size: 20 } });
    for (const tile of surfaceOf(c, id).tiles.values()) expect(tile.deep).toBeUndefined();
  });
});
