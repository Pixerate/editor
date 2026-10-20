import { describe, expect, it } from 'vitest';
import { ImageEditorController, readDeepRegion, readRegion, surfaceDepth, surfaceFromDeepPixels, type PixelLayer } from '../src/image-editor';
import { exportPsd } from '../src/image-editor/psd/export';
import { importPsd } from '../src/image-editor/psd/import';

const W = 300;
const H = 40;
const ALL = { x: 0, y: 0, width: W, height: H };

/** A 16-bit mask ramp from hidden to shown: about 300 distinct levels, finer than 8 bits. */
function maskRamp(): Uint16Array {
  const out = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = 10000 + x * 150 + (x % 3);
  return out;
}

function grey(): Uint16Array {
  const out = new Uint16Array(W * H * 4);
  for (let i = 0; i < W * H; i++) out.set([40000, 30000, 20000, 65535], i * 4);
  return out;
}

function maskedLayer(depth: 16 | 32): PixelLayer {
  return {
    type: 'pixel',
    id: 'Masked',
    name: 'Masked',
    visible: true,
    opacity: 1,
    blend: 'normal',
    surface: surfaceFromDeepPixels({ width: W, height: H, data: grey() }, 4),
    offset: { x: 0, y: 0 },
    mask: { surface: surfaceFromDeepPixels({ width: W, height: H, data: depth === 16 ? maskRamp() : Float32Array.from(maskRamp(), (v) => v / 65535) }, 1, 0, 0, 0), defaultValue: 0 },
  };
}

function psdOf(layer: PixelLayer, depth: 16 | 32): Uint8Array {
  return exportPsd({ width: W, height: H, layers: [layer], merged: readRegion(layer.surface, ALL), depth }).bytes;
}

function setup(depth: 16 | 32 = 16) {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  c.loadPsd(psdOf(maskedLayer(depth), depth));
  return { c, id: c.getLayers()[0].id };
}

const maskOf = (c: ImageEditorController, id: string) => (c.getLayer(id) as PixelLayer).mask!.surface;

function distinct(a: ArrayLike<number>, step = 1, offset = 0): number {
  const s = new Set<number>();
  for (let i = offset; i < a.length; i += step) s.add(a[i]);
  return s.size;
}

describe('16- and 32-bit masks', () => {
  it('a 16-bit PSD mask keeps every sample through import and export', () => {
    const bytes = psdOf(maskedLayer(16), 16);
    const layer = importPsd(bytes).layers[0] as PixelLayer;
    expect(surfaceDepth(layer.mask!.surface)).toBe(16);
    expect(readDeepRegion(layer.mask!.surface, ALL, 16)).toEqual(maskRamp());
    const again = importPsd(psdOf(layer, 16)).layers[0] as PixelLayer;
    expect(readDeepRegion(again.mask!.surface, ALL, 16)).toEqual(maskRamp());
    // 32-bit masks are float coverage.
    const l32 = importPsd(psdOf(maskedLayer(32), 32)).layers[0] as PixelLayer;
    expect(surfaceDepth(l32.mask!.surface)).toBe(32);
    const d = readDeepRegion(l32.mask!.surface, ALL, 32);
    expect(d[5]).toBeCloseTo((10000 + 5 * 150 + 2) / 65535, 6);
  });

  it('the deep composite takes its coverage from the deep mask', () => {
    const { c } = setup();
    const px = c.compositeDeepPixels();
    const row = px.data.subarray(20 * W * 4, 21 * W * 4) as Uint16Array;
    // Over transparency the mask becomes alpha, in more steps than 8 bits hold.
    expect(distinct(row, 4, 3)).toBeGreaterThan(256);
  });

  it('a soft brush paints a 16-bit mask, as one undo step', () => {
    const { c, id } = setup();
    const before = readDeepRegion(maskOf(c, id), ALL, 16);
    c.paintStroke({ layerId: id, channel: 'mask', points: [{ x: 20, y: 20 }, { x: 280, y: 20 }], color: '#000000', brush: { size: 60, hardness: 0 } });
    const m = maskOf(c, id);
    expect(surfaceDepth(m)).toBe(16);
    for (const tile of m.tiles.values()) expect(tile.deep).toBeInstanceOf(Uint16Array);
    const after = readDeepRegion(m, ALL, 16);
    expect(after).not.toEqual(before);
    expect(distinct(after.subarray(5 * W, 6 * W))).toBeGreaterThan(256);
    c.fillPixels({ layerId: id, channel: 'mask', color: '#ffffff', opacity: 0.5 });
    expect(surfaceDepth(maskOf(c, id))).toBe(16);
    c.undo();
    c.undo();
    expect(readDeepRegion(maskOf(c, id), ALL, 16)).toEqual(before);
  });

  it('set_bit_depth converts masks, and JSON keeps their samples', () => {
    const { c, id } = setup();
    expect(c.setBitDepth(32).changedLayerIds).toContain(id);
    expect(surfaceDepth(maskOf(c, id))).toBe(32);
    const json = c.toJSON();
    const { c: d } = setup();
    d.loadJSON(json);
    const back = readDeepRegion(maskOf(d, d.getLayers()[0].id), ALL, 32);
    expect(back).toEqual(readDeepRegion(maskOf(c, id), ALL, 32));
    c.setBitDepth(8);
    expect(surfaceDepth(maskOf(c, id))).toBe(8);
  });
});
