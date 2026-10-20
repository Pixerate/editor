import { describe, expect, it } from 'vitest';
import {
  ImageEditorController,
  keepDeepSamples,
  readDeepRegion,
  readRegion,
  surfaceDepth,
  surfaceFromDeepPixels,
  surfaceFromPixels,
  transformSurface,
  type PixelLayer,
} from '../src/image-editor';
import { exportPsd } from '../src/image-editor/psd/export';

const W = 300;
const H = 40;
const ALL = { x: 0, y: 0, width: W, height: H };

/** A smooth 16-bit horizontal ramp no 8-bit image can hold (about 600 levels on red). */
function ramp16(): Uint16Array {
  const out = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.set([20000 + x * 2, 30000, 40000 - x, 65535], (y * W + x) * 4);
  return out;
}

function setup(data: Uint16Array | Float32Array, depth: 16 | 32) {
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
  const bytes = exportPsd({ width: W, height: H, layers: [layer], merged: readRegion(layer.surface, ALL), depth }).bytes;
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  c.loadPsd(bytes);
  return { c, id: c.getLayers()[0].id };
}

const surfaceOf = (c: ImageEditorController, id: string) => (c.getLayer(id) as PixelLayer).surface;

function distinct(samples: ArrayLike<number>, channel = 0, alphaMin = 0): number {
  const s = new Set<number>();
  for (let i = channel; i < samples.length; i += 4) if (samples[i - channel + 3] > alphaMin) s.add(samples[i]);
  return s.size;
}

describe('keepDeepSamples', () => {
  it('keeps the deep samples of pixels an 8-bit rewrite left alone, and renders as the rewrite does', () => {
    const before = surfaceFromDeepPixels({ width: W, height: H, data: ramp16() }, 4);
    const px = readRegion(before, ALL);
    for (let i = 0; i < 10 * 4; i += 4) px[i] = 0; // change the first ten pixels of row 0
    const after = surfaceFromPixels({ width: W, height: H, data: px }, 4, 0, 0);
    expect(surfaceDepth(after)).toBe(8);
    const kept = keepDeepSamples(before, after);
    expect(surfaceDepth(kept)).toBe(16);
    expect(readRegion(kept, ALL)).toEqual(px);
    const d = readDeepRegion(kept, ALL, 16);
    const src = ramp16();
    expect(d[0]).toBe(0);
    expect(Array.from(d.subarray(40, 400))).toEqual(Array.from(src.subarray(40, 400)));
    // An 8-bit surface is left as it is.
    const flat = surfaceFromPixels({ width: W, height: H, data: px }, 4, 0, 0);
    expect(keepDeepSamples(flat, after)).toBe(after);
  });
});

describe('editing at 16 and 32 bits', () => {
  it('Free Transform resamples the deep samples: a 16-bit ramp keeps its levels', () => {
    const { c, id } = setup(ramp16(), 16);
    c.transformLayer({ layerId: id, params: { scaleX: 150, rotate: 3 } });
    const s = surfaceOf(c, id);
    expect(surfaceDepth(s)).toBe(16);
    const b = s.bounds!;
    const d = readDeepRegion(s, b, 16);
    expect(distinct(d, 0, 60000)).toBeGreaterThan(400);
    c.undo();
    expect(readDeepRegion(surfaceOf(c, id), ALL, 16)).toEqual(ramp16());
  });

  it('a whole-pixel move keeps 32-bit samples exactly, colour above 1 included', () => {
    const hot = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) hot.set([1 + (i % W) / 50, 0.25, 0.001 * (i % 7), 1], i * 4);
    const { c, id } = setup(hot, 32);
    c.transformLayer({ layerId: id, params: { dx: 7, dy: 3 } });
    const s = surfaceOf(c, id);
    expect(surfaceDepth(s)).toBe(32);
    const moved = readDeepRegion(s, { x: 7, y: 3, width: W, height: H }, 32);
    expect(moved).toEqual(hot);
  });

  it('transformSurface on an 8-bit surface stays 8-bit', () => {
    const px = new Uint8ClampedArray(W * H * 4).fill(200);
    const s = transformSurface(surfaceFromPixels({ width: W, height: H, data: px }, 4, 0, 0), [1.5, 0, 0.3, 0, 1.5, 0.2, 0, 0, 1]);
    expect(surfaceDepth(s)).toBe(8);
  });

  it('a selection transformed at 16 bits keeps the rest of the layer deep', () => {
    const { c, id } = setup(ramp16(), 16);
    c.selectRect({ x: 20, y: 5, width: 40, height: 20 });
    c.transformLayer({ layerId: id, content: 'selection', params: { rotate: 10 } });
    const s = surfaceOf(c, id);
    expect(surfaceDepth(s)).toBe(16);
    for (const tile of s.tiles.values()) expect(tile.deep).toBeInstanceOf(Uint16Array);
    const d = readDeepRegion(s, ALL, 16);
    const src = ramp16();
    const i = (30 * W + 200) * 4;
    expect(d[i]).toBe(src[i]);
  });

  it('Dodge at 16 bits keeps more than 256 levels where it lightens', () => {
    const { c, id } = setup(ramp16(), 16);
    const before = readDeepRegion(surfaceOf(c, id), ALL, 16);
    c.paintStroke({ tool: 'dodge', layerId: id, points: [{ x: 10, y: 20 }, { x: 290, y: 20 }], brush: { size: 80, hardness: 0 }, retouch: { exposure: 0.5, range: 'midtones' } });
    const s = surfaceOf(c, id);
    for (const tile of s.tiles.values()) expect(tile.deep).toBeInstanceOf(Uint16Array);
    const after = readDeepRegion(s, ALL, 16);
    expect(after).not.toEqual(before);
    const row = after.subarray(20 * W * 4, 21 * W * 4);
    expect(distinct(row)).toBeGreaterThan(256);
    c.undo();
    expect(readDeepRegion(surfaceOf(c, id), ALL, 16)).toEqual(before);
  });

  it('an 8-bit tool on a deep layer (Smudge) loses precision only on the pixels it changed', () => {
    const { c, id } = setup(ramp16(), 16);
    c.paintStroke({ tool: 'smudge', layerId: id, points: [{ x: 100, y: 20 }, { x: 120, y: 20 }], brush: { size: 10, hardness: 1 } });
    const s = surfaceOf(c, id);
    for (const tile of s.tiles.values()) expect(tile.deep).toBeInstanceOf(Uint16Array);
    const d = readDeepRegion(s, ALL, 16);
    const src = ramp16();
    // Far from the stroke, on the same tile: the exact 16-bit samples.
    const i = (2 * W + 110) * 4;
    expect(d[i]).toBe(src[i]);
    expect(Array.from(d.subarray(0, 4 * 50))).toEqual(Array.from(src.subarray(0, 4 * 50)));
  });
});
