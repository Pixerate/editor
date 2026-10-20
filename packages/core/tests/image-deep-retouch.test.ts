import { describe, expect, it } from 'vitest';
import { ImageEditorController, readDeepRegion, readRegion, surfaceDepth, surfaceFromDeepPixels, type PixelLayer } from '../src/image-editor';
import { exportPsd } from '../src/image-editor/psd/export';

const W = 300;
const H = 40;
const ALL = { x: 0, y: 0, width: W, height: H };

/** A smooth 16-bit ramp (about 600 levels on red) no 8-bit image can hold. */
function ramp16(): Uint16Array {
  const out = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.set([20000 + x * 2, 30000 + y * 3, 40000 - x, 65535], (y * W + x) * 4);
  return out;
}

export function deepSetup(data: Uint16Array | Float32Array, depth: 16 | 32) {
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

/** Samples of `channel` that are not whole 8-bit levels (multiples of 257). */
function fractional(samples: Uint16Array, from: number, to: number, channel = 0): number {
  let n = 0;
  for (let i = from * 4 + channel; i < to * 4; i += 4) if (samples[i] % 257 !== 0) n++;
  return n;
}

describe('dab tools at 16 and 32 bits', () => {
  it('Smudge drags 16-bit samples without rounding them to 8 bits, as one undo step', () => {
    const { c, id } = deepSetup(ramp16(), 16);
    const before = readDeepRegion(surfaceOf(c, id), ALL, 16);
    c.paintStroke({ tool: 'smudge', layerId: id, points: [{ x: 60, y: 20 }, { x: 160, y: 20 }], brush: { size: 20, hardness: 0.5 }, retouch: { strength: 0.8 } });
    const s = surfaceOf(c, id);
    expect(surfaceDepth(s)).toBe(16);
    for (const tile of s.tiles.values()) expect(tile.deep).toBeInstanceOf(Uint16Array);
    const after = readDeepRegion(s, ALL, 16);
    const row = 20 * W;
    expect(after.subarray((row + 100) * 4, (row + 150) * 4)).not.toEqual(before.subarray((row + 100) * 4, (row + 150) * 4));
    // The smudged pixels keep fractions of an 8-bit level.
    expect(fractional(after, row + 70, row + 150)).toBeGreaterThan(40);
    c.undo();
    expect(readDeepRegion(surfaceOf(c, id), ALL, 16)).toEqual(before);
  });

  it('the Mixer Brush blends into 16-bit samples', () => {
    const { c, id } = deepSetup(ramp16(), 16);
    c.paintStroke({ tool: 'mixer', layerId: id, points: [{ x: 40, y: 20 }, { x: 260, y: 20 }], color: '#ff8800', brush: { size: 24, hardness: 0.3 }, mixer: { wet: 0.6, load: 0.5, mix: 0.5 } });
    const s = surfaceOf(c, id);
    for (const tile of s.tiles.values()) expect(tile.deep).toBeInstanceOf(Uint16Array);
    const after = readDeepRegion(s, ALL, 16);
    const row = 20 * W;
    expect(fractional(after, row + 50, row + 250)).toBeGreaterThan(100);
  });

  it('Sponge on a 32-bit layer keeps colour above 1 where it does not reach and stays float', () => {
    const hot = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) hot.set([(i % W) < 20 ? 3 : 0.6, 0.2, 0.1, 1], i * 4);
    const { c, id } = deepSetup(hot, 32);
    c.paintStroke({ tool: 'sponge', layerId: id, points: [{ x: 150, y: 20 }, { x: 200, y: 20 }], brush: { size: 20 }, retouch: { strength: 0.8, spongeMode: 'desaturate' } });
    const s = surfaceOf(c, id);
    expect(surfaceDepth(s)).toBe(32);
    const out = readDeepRegion(s, ALL, 32);
    expect(out[(20 * W + 5) * 4]).toBe(3);
    const i = (20 * W + 175) * 4;
    // Desaturated: red moved towards green.
    expect(out[i] - out[i + 1]).toBeLessThan(0.4);
  });
});
