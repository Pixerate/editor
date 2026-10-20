import { describe, expect, it } from 'vitest';
import {
  TILE,
  convertSurfaceDepth,
  deepBytes,
  deepTile,
  emptySurface,
  readDeepRegion,
  readRegion,
  surfaceDepth,
  surfaceFromDeepPixels,
  surfaceFromPixels,
  srgbDecode,
  srgbEncode,
  tileSamples16,
  tileSamples32,
  to16From32,
  to16From8,
  to32From16,
  to32From8,
  to8From16,
  to8From32,
  writeDeepRegion,
} from '../src/raster';

/** A 16-bit horizontal ramp that 8 bits cannot hold (every sample distinct). */
function ramp16(w: number, h: number): Uint16Array {
  const out = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = 1000 + x * 7;
      out[i + 1] = 30000 + y;
      out[i + 2] = 65535 - x;
      out[i + 3] = 65535;
    }
  }
  return out;
}

describe('deep samples', () => {
  it('converts 8 ↔ 16 bits exactly and 16 → 8 by rounding', () => {
    const b = Uint8ClampedArray.from([0, 1, 127, 128, 254, 255]);
    expect([...to8From16(to16From8(b))]).toEqual([...b]);
    expect([...to8From16(Uint16Array.from([128, 129, 385, 65535]))]).toEqual([0, 1, 1, 255]);
  });

  it('linearises colour but not alpha or masks for 32 bits, and encodes back', () => {
    const rgba = Uint8ClampedArray.from([255, 128, 0, 128]);
    const f = to32From8(rgba, 4);
    expect(f[0]).toBeCloseTo(1, 6);
    expect(f[1]).toBeCloseTo(srgbDecode(128 / 255), 6);
    expect(f[3]).toBeCloseTo(128 / 255, 6);
    expect([...to8From32(f, 4)]).toEqual([255, 128, 0, 128]);
    expect([...to32From8(Uint8ClampedArray.from([51]), 1)][0]).toBeCloseTo(0.2, 6);
    // 16 → 32 → 16 is exact for every code.
    const all = new Uint16Array(65536 * 4);
    for (let v = 0; v < 65536; v++) all.set([v, v, v, v], v * 4);
    const back = to16From32(to32From16(all, 4), 4);
    let worst = 0;
    for (let i = 0; i < all.length; i++) worst = Math.max(worst, Math.abs(back[i] - all[i]));
    expect(worst).toBe(0);
    // HDR colour clips when it comes back to 16 or 8 bits.
    expect([...to16From32(Float32Array.from([4, 0.5, -1, 1]), 4)]).toEqual([65535, Math.round(srgbEncode(0.5) * 65535), 0, 65535]);
  });

  it('a deep tile keeps its 8-bit rendering, and collapses to 8 bits when nothing finer is there', () => {
    const exact = to16From8(new Uint8ClampedArray(TILE * TILE * 4).fill(200));
    const t1 = deepTile(exact, 4)!;
    expect(t1.deep).toBeUndefined();
    expect(t1.uniform).not.toBeNull();
    const fine = exact.slice();
    fine[0] += 3;
    const t2 = deepTile(fine, 4)!;
    expect(t2.deep).toBe(fine);
    expect(t2.data[0]).toBe(200);
    expect(deepTile(new Float32Array(TILE * TILE * 4), 4)).toBeNull();
    expect(tileSamples16(t2, 4)).toBe(fine);
    expect(tileSamples32(t1, 4)[0]).toBeCloseTo(srgbDecode(200 / 255), 6);
    expect([...tileSamples16(undefined, 1, 255).slice(0, 2)]).toEqual([65535, 65535]);
  });

  it('reads and writes regions across tiles at 16 and 32 bits', () => {
    const w = 300;
    const h = 40;
    const samples = ramp16(w, h);
    const s = surfaceFromDeepPixels({ width: w, height: h, data: samples }, 4, -20, 250);
    expect(surfaceDepth(s)).toBe(16);
    const back = readDeepRegion(s, { x: -20, y: 250, width: w, height: h }, 16);
    expect(back).toEqual(samples);
    // The 8-bit rendering everyone else reads.
    expect(readRegion(s, { x: -20, y: 250, width: 1, height: 1 })[0]).toBe(Math.round(1000 / 257));
    // Outside the written rect: transparent.
    expect([...readDeepRegion(s, { x: 400, y: 0, width: 1, height: 1 }, 16)]).toEqual([0, 0, 0, 0]);
    const f = readDeepRegion(s, { x: 0, y: 260, width: 2, height: 1 }, 32);
    expect(f[0]).toBeCloseTo(srgbDecode((1000 + 20 * 7) / 65535), 6);
    // A partial write keeps the rest of the tile at its depth.
    const patch = new Uint16Array(4).fill(12345);
    const s2 = writeDeepRegion(s, { x: 0, y: 260, width: 1, height: 1 }, patch);
    expect([...readDeepRegion(s2, { x: 0, y: 260, width: 1, height: 1 }, 16)]).toEqual([12345, 12345, 12345, 12345]);
    expect(readDeepRegion(s2, { x: 1, y: 260, width: 1, height: 1 }, 16)[0]).toBe(1000 + 21 * 7);
  });

  it('8-bit tiles read at any depth, and converting a surface touches only deep tiles', () => {
    const px = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(10) };
    const s8 = surfaceFromPixels(px, 4);
    expect(surfaceDepth(s8)).toBe(8);
    expect(convertSurfaceDepth(s8, 16)).toBe(s8);
    expect(readDeepRegion(s8, { x: 0, y: 0, width: 1, height: 1 }, 16)[0]).toBe(2570);
    const s16 = surfaceFromDeepPixels({ width: 8, height: 2, data: ramp16(8, 2) }, 4);
    const s32 = convertSurfaceDepth(s16, 32);
    expect(surfaceDepth(s32)).toBe(32);
    expect(readDeepRegion(convertSurfaceDepth(s32, 16), { x: 0, y: 0, width: 8, height: 2 }, 16)).toEqual(ramp16(8, 2));
    const down = convertSurfaceDepth(s16, 8);
    expect(surfaceDepth(down)).toBe(8);
    expect(deepBytes(down)).toBe(0);
    expect(readRegion(down, { x: 0, y: 0, width: 8, height: 2 })).toEqual(readRegion(s16, { x: 0, y: 0, width: 8, height: 2 }));
  });

  it('masks keep coverage values at 32 bits', () => {
    const m = writeDeepRegion(emptySurface(1, 255), { x: 0, y: 0, width: 2, height: 1 }, Float32Array.from([0.25, 0.5]));
    expect([...readDeepRegion(m, { x: 0, y: 0, width: 3, height: 1 }, 32)]).toEqual([0.25, 0.5, 1]);
    expect([...readRegion(m, { x: 0, y: 0, width: 3, height: 1 })]).toEqual([64, 128, 255]);
  });
});
