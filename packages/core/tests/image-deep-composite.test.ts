import { describe, expect, it } from 'vitest';
import {
  ImageEditorController,
  identityLevels,
  readDeepRegion,
  surfaceDepth,
  surfaceFromDeepPixels,
  srgbDecode,
  type ImageLayer,
  type PixelLayer,
} from '../src/image-editor';
import { exportPsd } from '../src/image-editor/psd/export';
import { decodeMergedImage, readPsd } from '../src/image-editor/psd/file';

const W = 300;
const H = 4;

const pixel = (id: string, surface: PixelLayer['surface'], extra: Partial<PixelLayer> = {}): PixelLayer => ({
  type: 'pixel',
  id,
  name: id,
  visible: true,
  opacity: 1,
  blend: 'normal',
  surface,
  offset: { x: 0, y: 0 },
  ...extra,
});

/** A dark 16-bit ramp, 300 distinct greys inside 8-bit codes 20..30: 8 bits would hold only ~11. */
function darkRamp(): Uint16Array {
  const out = new Uint16Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = 20 * 257 + (i % W) * 9;
    out.set([v, v, v, 65535], i * 4);
  }
  return out;
}

const distinct = (a: ArrayLike<number>, stride = 4) => {
  const s = new Set<number>();
  for (let i = 0; i < a.length; i += stride) s.add(a[i]);
  return s.size;
};

function doc(layers: ImageLayer[], depth: 16 | 32 = 16) {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  const merged = new Uint8ClampedArray(W * H * 4);
  c.loadPsd(exportPsd({ width: W, height: H, layers, merged, depth }).bytes);
  return c;
}

describe('compositing at high bit depth', () => {
  it('matches the 8-bit compositor on 8-bit layers (masks, blend modes, groups, adjustments)', () => {
    const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) data.set([(i % W) % 256, 128, 255 - ((i % W) % 256), 255], i * 4);
    c.setSamplePixels({ width: W, height: H, data });
    c.addPixelLayer({ name: 'Base', pixels: { width: W, height: H, data } });
    const top = c.addPixelLayer({ name: 'Top', color: '#3366cc' });
    c.setLayerProperties(top, { blend: 'multiply', opacity: 0.6 });
    c.addLayerMask(top, 'reveal-all');
    c.addAdjustmentLayer({ kind: 'levels', params: { master: { ...identityLevels(), gamma: 1.4 }, red: identityLevels(), green: identityLevels(), blue: identityLevels() } });
    const eight = c.compositePixels().data;
    c.setBitDepth(16);
    const sixteen = c.compositeDeepPixels().data as Uint16Array;
    let worst = 0;
    for (let i = 0; i < eight.length; i++) worst = Math.max(worst, Math.abs(Math.round(sixteen[i] / 257) - eight[i]));
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('keeps 16-bit precision through blending and adjustment layers', () => {
    const c = doc([pixel('ramp', surfaceFromDeepPixels({ width: W, height: H, data: darkRamp() }, 4))]);
    expect(c.bitDepth).toBe(16);
    // A strong Levels stretch: 8 bits would show ~11 bands across the image.
    c.addAdjustmentLayer({ kind: 'levels', params: { master: { ...identityLevels(), inBlack: 18, inWhite: 32 }, red: identityLevels(), green: identityLevels(), blue: identityLevels() } });
    const out = c.compositeDeepPixels({ x: 0, y: 0, width: W, height: 1 }).data;
    expect(distinct(out)).toBeGreaterThan(200);
    expect(distinct(c.compositePixels({ x: 0, y: 0, width: W, height: 1 }).data)).toBeLessThan(200);
  });

  it('blends in linear light at 32 bits', () => {
    const white = new Float32Array(W * H * 4).fill(1);
    const black = new Float32Array(W * H * 4);
    for (let i = 3; i < black.length; i += 4) black[i] = 1;
    const c = doc([pixel('black', surfaceFromDeepPixels({ width: W, height: H, data: black }, 4)), pixel('white', surfaceFromDeepPixels({ width: W, height: H, data: white }, 4), { opacity: 0.5 })], 32);
    const out = c.compositeDeepPixels({ x: 0, y: 0, width: 1, height: 1 }).data;
    expect(out[0]).toBeCloseTo(0.5, 5);
    // At 16 bits the same stack blends encoded values: half of white is encoded 0.5.
    c.setBitDepth(16);
    expect((c.compositeDeepPixels({ x: 0, y: 0, width: 1, height: 1 }).data as Uint16Array)[0] / 65535).toBeCloseTo(0.5, 3);
    // …which is darker in linear light than the 32-bit blend.
    expect(srgbDecode(0.5)).toBeLessThan(0.5);
  });

  it('merges and the PSD merged image keep the depth', async () => {
    const ramp = darkRamp();
    const half = new Uint16Array(W * H * 4);
    for (let i = 0; i < W * H; i++) half.set([0, 0, 0, 32768], i * 4);
    const c = doc([pixel('ramp', surfaceFromDeepPixels({ width: W, height: H, data: ramp }, 4)), pixel('shade', surfaceFromDeepPixels({ width: W, height: H, data: half }, 4))]);
    const saved = await c.toPsd();
    const file = readPsd(saved.bytes);
    const planes = decodeMergedImage(file);
    const red = Array.from({ length: W }, (_, x) => (planes[2 * x] << 8) | planes[2 * x + 1]);
    expect(distinct(red, 1)).toBeGreaterThan(200);
    const id = await c.mergeVisible();
    const merged = (c.getLayer(id) as PixelLayer).surface;
    expect(surfaceDepth(merged)).toBe(16);
    const row = readDeepRegion(merged, { x: 0, y: 0, width: W, height: 1 }, 16);
    expect(distinct(row)).toBeGreaterThan(200);
    expect(row[0]).toBeCloseTo((ramp[0] * 32767) / 65535, -1);
  });

  it('an 8-bit document widens its composite to 16 bits', () => {
    const fake = { width: 4, height: 1, naturalWidth: 4, naturalHeight: 1 } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.addPixelLayer({ name: 'a', color: '#808080' });
    const out = c.compositeDeepPixels();
    expect(out.depth).toBe(16);
    expect(out.data[0]).toBe(128 * 257);
  });
});
