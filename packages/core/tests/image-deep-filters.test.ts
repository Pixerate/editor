import { describe, expect, it } from 'vitest';
import { ImageEditorController, readRegion, surfaceFromDeepPixels, type PixelLayer } from '../src/image-editor';
import { LayerCompositor } from '../src/image-editor/layers/compositor';
import { exportPsd } from '../src/image-editor/psd/export';

const W = 300;
const H = 40;
const ALL = { x: 0, y: 0, width: W, height: H };

/** A 16-bit ramp (about 600 levels on red), opaque. */
function ramp16(): Uint16Array {
  const out = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.set([12000 + x * 2, 30000, 40000 - x, 65535], (y * W + x) * 4);
  return out;
}

function setup(data: Uint16Array | Float32Array = ramp16(), depth: 16 | 32 = 16) {
  const layer: PixelLayer = { type: 'pixel', id: 'L', name: 'L', visible: true, opacity: 1, blend: 'normal', surface: surfaceFromDeepPixels({ width: W, height: H, data }, 4), offset: { x: 0, y: 0 } };
  const bytes = exportPsd({ width: W, height: H, layers: [layer], merged: readRegion(layer.surface, ALL), depth }).bytes;
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  c.loadPsd(bytes);
  return { c, id: c.getLayers()[0].id };
}

function distinct(a: ArrayLike<number>, from: number, to: number, ch = 0): number {
  const s = new Set<number>();
  for (let i = from * 4 + ch; i < to * 4; i += 4) s.add(a[i]);
  return s.size;
}

/** The 8-bit composite, for comparison. */
function composite8(c: ImageEditorController): Uint8ClampedArray {
  const comp = new LayerCompositor();
  return comp.composite(c.getLayers() as never, ALL, (c as unknown as { compositorSources(): never }).compositorSources());
}

describe('layer filters at 16 and 32 bits', () => {
  it('a develop filter grades the 16-bit samples in float, matching the 8-bit look', () => {
    const { c, id } = setup();
    c.addLayerFilter(id, { kind: 'develop', exposure: 0.6, contrast: 20 });
    const deep = c.compositeDeepPixels();
    expect(deep.depth).toBe(16);
    const row = 20 * W;
    expect(distinct(deep.data, row, row + W)).toBeGreaterThan(256);
    const eight = composite8(c);
    for (const x of [10, 150, 290]) {
      const i = (row + x) * 4;
      expect(Math.abs((deep.data[i] as number) / 257 - eight[i])).toBeLessThan(2);
    }
  });

  it('a blur filter averages the 16-bit samples without rounding', () => {
    const { c, id } = setup();
    c.addLayerFilter(id, { kind: 'blur', radius: 4 });
    const deep = c.compositeDeepPixels();
    const row = 20 * W;
    // A linear ramp blurs to itself inside (red steps by 2 per pixel).
    for (const x of [50, 100, 200]) expect(deep.data[(row + x) * 4]).toBe(12000 + x * 2);
    const eight = composite8(c);
    const i = (row + 150) * 4;
    expect(Math.abs((deep.data[i] as number) / 257 - eight[i])).toBeLessThan(1.5);
  });

  it('at 32 bits a develop filter keeps colour above 1', () => {
    const hot = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) hot.set([2.5, 0.2, 0.1, 1], i * 4);
    const { c, id } = setup(hot, 32);
    c.addLayerFilter(id, { kind: 'develop', exposure: 0.3 });
    const deep = c.compositeDeepPixels();
    expect(deep.depth).toBe(32);
    // Still well above 1 (the highlight shoulder compresses it; the 8-bit path would clip it to white).
    expect(deep.data[0]).toBeGreaterThan(1.5);
  });
});
