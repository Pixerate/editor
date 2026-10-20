import { describe, expect, it } from 'vitest';
import { ImageEditorController, readRegion, surfaceFromDeepPixels, type PixelLayer } from '../src/image-editor';
import { LayerCompositor } from '../src/image-editor/layers/compositor';
import { exportPsd } from '../src/image-editor/psd/export';

const W = 300;
const H = 60;
const ALL = { x: 0, y: 0, width: W, height: H };

/** A 16-bit ramp in a band (rows 15..44), transparent around it, so effects have an edge. */
function band16(): Uint16Array {
  const out = new Uint16Array(W * H * 4);
  for (let y = 15; y < 45; y++) for (let x = 20; x < 280; x++) out.set([12000 + x * 2, 30000, 40000 - x, 65535], (y * W + x) * 4);
  return out;
}

function setup(data: Uint16Array | Float32Array = band16(), depth: 16 | 32 = 16) {
  const layer: PixelLayer = { type: 'pixel', id: 'L', name: 'L', visible: true, opacity: 1, blend: 'normal', surface: surfaceFromDeepPixels({ width: W, height: H, data }, 4), offset: { x: 0, y: 0 } };
  const bytes = exportPsd({ width: W, height: H, layers: [layer], merged: readRegion(layer.surface, ALL), depth }).bytes;
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  c.loadPsd(bytes);
  return { c, id: c.getLayers()[0].id };
}

function composite8(c: ImageEditorController): Uint8ClampedArray {
  return new LayerCompositor().composite(c.getLayers() as never, ALL, (c as unknown as { compositorSources(): never }).compositorSources());
}

function distinct(a: ArrayLike<number>, from: number, to: number, ch = 0): number {
  const s = new Set<number>();
  for (let i = from * 4 + ch; i < to * 4; i += 4) s.add(a[i]);
  return s.size;
}

describe('layer effects at 16 and 32 bits', () => {
  it('a drop shadow and stroke leave the 16-bit content exact, and match the 8-bit look', () => {
    const { c, id } = setup();
    c.addLayerEffect(id, 'drop-shadow', { distance: 6, size: 4, opacity: 0.6 });
    c.addLayerEffect(id, 'stroke', { size: 3, position: 'outside' });
    const deep = c.compositeDeepPixels();
    const eight = composite8(c);
    const row = 30 * W;
    // Inside the band the layer's own samples come through untouched.
    for (const x of [40, 150, 270]) expect(deep.data[(row + x) * 4]).toBe(12000 + x * 2);
    expect(distinct(deep.data, row + 20, row + 280)).toBeGreaterThan(256);
    // Everywhere (shadow, stroke, content) within a level or two of the 8-bit composite.
    let worst = 0;
    for (let i = 0; i < W * H * 4; i++) {
      const v = (deep.data[i] as number) / 257;
      worst = Math.max(worst, Math.abs(v - eight[i]));
    }
    expect(worst).toBeLessThan(2.5);
  });

  it('a colour overlay at half opacity blends with the 16-bit samples', () => {
    const { c, id } = setup();
    c.addLayerEffect(id, 'color-overlay', { color: '#0000ff', opacity: 0.5 });
    const deep = c.compositeDeepPixels();
    const row = 30 * W;
    expect(distinct(deep.data, row + 20, row + 280)).toBeGreaterThan(256);
    const eight = composite8(c);
    const i = (row + 150) * 4;
    expect(Math.abs((deep.data[i] as number) / 257 - eight[i])).toBeLessThan(2);
  });

  it('at 32 bits an outer glow keeps the layer above 1', () => {
    const hot = new Float32Array(W * H * 4);
    for (let y = 15; y < 45; y++) for (let x = 20; x < 280; x++) hot.set([3, 0.5, 0.2, 1], (y * W + x) * 4);
    const { c, id } = setup(hot, 32);
    c.addLayerEffect(id, 'outer-glow', { size: 8 });
    const deep = c.compositeDeepPixels();
    expect(deep.data[(30 * W + 150) * 4]).toBeCloseTo(3, 4);
    // The glow reaches outside the band.
    expect(deep.data[(10 * W + 150) * 4 + 3]).toBeGreaterThan(0);
  });
});
