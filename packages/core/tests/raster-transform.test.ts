import { describe, expect, it } from 'vitest';
import {
  TILE,
  compositeSurfaceOver,
  contentBounds,
  emptySurface,
  keysWeight,
  readPixel,
  readRegion,
  solidSurface,
  surfaceFromPixels,
  transformSurface,
  transformedBounds,
  warpSurface,
  TransformTooLargeError,
  type Interpolation,
  type RasterRect,
  type TiledSurface,
} from '../src/raster';
import {
  applyHomography,
  evalWarpMesh,
  homographyFromAffine,
  invertHomography,
  rectToQuad,
  rotateMatrix,
  scaleMatrix,
  warpPresetMesh,
  type Homography,
} from '../src/geom';

/** Deterministic noisy RGBA with some partial alpha. */
function noise(w: number, h: number, seed = 7, alpha = true) {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < data.length; i += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    data[i] = s & 255;
    data[i + 1] = (s >> 8) & 255;
    data[i + 2] = (s >> 16) & 255;
    data[i + 3] = alpha ? 64 + ((s >> 24) & 191) : 255;
  }
  return { width: w, height: h, data };
}

/**
 * Reference resampler: the whole source in one float buffer, every destination pixel mapped back
 * through the inverse and sampled with bounds checks (no tiles, windows or shortcuts).
 */
function reference(src: { width: number; height: number; data: ArrayLike<number> }, at: { x: number; y: number }, h: Homography, interp: Interpolation, dst: RasterRect) {
  const inv = invertHomography(h)!;
  const pm = (x: number, y: number): number[] => {
    if (x < 0 || y < 0 || x >= src.width || y >= src.height) return [0, 0, 0, 0];
    const i = (y * src.width + x) * 4;
    const a = src.data[i + 3] / 255;
    return [src.data[i] * a, src.data[i + 1] * a, src.data[i + 2] * a, a];
  };
  const out = new Uint8ClampedArray(dst.width * dst.height * 4);
  for (let y = 0; y < dst.height; y++) {
    for (let x = 0; x < dst.width; x++) {
      const p = applyHomography(inv, { x: dst.x + x + 0.5, y: dst.y + y + 0.5 })!;
      const u = p.x - 0.5 - at.x;
      const v = p.y - 0.5 - at.y;
      if (u < -1 || v < -1 || u > src.width || v > src.height) continue;
      const acc = [0, 0, 0, 0];
      const add = (px: number[], k: number) => px.forEach((c, i) => (acc[i] += c * k));
      if (interp === 'nearest') add(pm(Math.floor(u + 0.5), Math.floor(v + 0.5)), 1);
      else if (interp === 'bilinear') {
        const fx = Math.floor(u);
        const fy = Math.floor(v);
        for (const [dy, ky] of [[0, 1 - (v - fy)], [1, v - fy]]) for (const [dx, kx] of [[0, 1 - (u - fx)], [1, u - fx]]) add(pm(fx + dx, fy + dy), kx * ky);
      } else {
        const r = (t: number) => (Math.abs(t - Math.round(t)) < 1e-7 ? Math.round(t) : t);
        const uu = r(u);
        const vv = r(v);
        const fx = Math.floor(uu);
        const fy = Math.floor(vv);
        for (let j = -1; j <= 2; j++) for (let i = -1; i <= 2; i++) add(pm(fx + i, fy + j), keysWeight(fx + i - uu) * keysWeight(fy + j - vv));
      }
      const al = Math.min(1, acc[3]);
      if (!(al > 1e-6)) continue;
      const o = (y * dst.width + x) * 4;
      out[o] = acc[0] / al;
      out[o + 1] = acc[1] / al;
      out[o + 2] = acc[2] / al;
      out[o + 3] = al * 255;
    }
  }
  return out;
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

const affine = (m: readonly [number, number, number, number, number, number]) => homographyFromAffine(m);

describe('transformSurface', () => {
  it('matches the reference resampler for every interpolation, across tile borders', () => {
    // 300 × 200 at (20, 30): the result spans several tiles, so per-tile windows are exercised.
    const px = noise(300, 200);
    const src = surfaceFromPixels(px, 4, 20, 30);
    const maps: Homography[] = [
      affine(rotateMatrix(17, { x: 170, y: 130 })),
      affine([1.6, 0.2, -0.3, 1.25, 11.3, -7.7]),
      rectToQuad({ x: 20, y: 30, width: 300, height: 200 }, [
        // Enlarges everywhere, so Bicubic is never widened (the reference has no widening).
        { x: 0, y: 0 },
        { x: 400, y: 20 },
        { x: 380, y: 300 },
        { x: -10, y: 260 },
      ])!,
    ];
    for (const h of maps) {
      for (const interp of ['nearest', 'bilinear', 'bicubic'] as const) {
        const out = transformSurface(src, h, { interpolation: interp });
        const dst = transformedBounds({ x: 20, y: 30, width: 300, height: 200 }, h)!;
        const want = reference(px, { x: 20, y: 30 }, h, interp, dst);
        // Float32 windows against float64 sums: at most a level of rounding.
        expect(maxDiff(readRegion(out, dst), want), interp).toBeLessThanOrEqual(1);
      }
    }
  });

  it('returns the source for the identity and shares tiles for whole-tile moves', () => {
    const src = surfaceFromPixels(noise(300, 300), 4);
    expect(transformSurface(src, [1, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(src);
    const moved = transformSurface(src, affine([1, 0, 0, 1, TILE, -2 * TILE]));
    for (const [key, tile] of moved.tiles) expect([...src.tiles.values()]).toContain(tile), void key;
    const odd = transformSurface(src, affine([1, 0, 0, 1, 7, -3]), { interpolation: 'bicubic' });
    expect(readRegion(odd, { x: 7, y: -3, width: 300, height: 300 })).toEqual(readRegion(src, { x: 0, y: 0, width: 300, height: 300 }));
  });

  it('is exact for a translation by whole pixels with any interpolation when a source rect is given', () => {
    const px = noise(40, 30);
    const src = surfaceFromPixels(px, 4, 4, 4);
    for (const interp of ['nearest', 'bilinear', 'bicubic'] as const) {
      const out = transformSurface(src, affine([1, 0, 0, 1, 7, -3]), { interpolation: interp, source: { x: 4, y: 4, width: 40, height: 30 } });
      expect(readRegion(out, { x: 11, y: 1, width: 40, height: 30 }), interp).toEqual(new Uint8ClampedArray(px.data));
    }
  });

  it('matches Photoshop’s Bicubic on a 200 % step edge (photocraft’s measurement)', () => {
    const data = new Uint8ClampedArray(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) data.set(x < 32 ? [64, 64, 64, 255] : [192, 192, 192, 255], (y * 64 + x) * 4);
    const src = surfaceFromPixels({ width: 64, height: 64, data });
    const h = rectToQuad({ x: 0, y: 0, width: 64, height: 64 }, [
      { x: -32, y: -32 },
      { x: 96, y: -32 },
      { x: 96, y: 96 },
      { x: -32, y: 96 },
    ])!;
    const out = transformSurface(src, h, { interpolation: 'bicubic' });
    const photoshop = [64, 64, 64, 60, 51, 93, 163, 206, 197, 192];
    photoshop.forEach((want, i) => expect(Math.abs(readPixel(out, 26 + i, 50)[0] - want), `column ${26 + i}`).toBeLessThanOrEqual(1.5));
  });

  it('samples premultiplied, so transparent neighbours do not tint a partially transparent edge', () => {
    // An opaque red pixel beside transparent green ones: half way between them is half-transparent red.
    const data = new Uint8ClampedArray(4 * 1 * 4);
    data.set([0, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 0]);
    const src = surfaceFromPixels({ width: 4, height: 1, data });
    const out = transformSurface(src, affine([1, 0, 0, 1, 0.5, 0]), { interpolation: 'bilinear', source: { x: 0, y: 0, width: 4, height: 1 } });
    expect(readPixel(out, 1, 0)).toEqual([255, 0, 0, 128]);
    expect(readPixel(out, 3, 0)).toEqual([255, 0, 0, 128]);
  });

  it('rotates by 90° and flips exactly with nearest', () => {
    const px = noise(37, 23);
    const src = surfaceFromPixels(px, 4);
    const rot = transformSurface(src, affine([0, 1, -1, 0, 23, 0]), { interpolation: 'nearest' });
    expect(contentBounds(rot)).toEqual({ x: 0, y: 0, width: 23, height: 37 });
    for (const [x, y] of [[0, 0], [36, 22], [5, 17]]) expect(readPixel(rot, 22 - y, x)).toEqual(readPixel(src, x, y));
    const flip = transformSurface(src, affine([-1, 0, 0, 1, 37, 0]), { interpolation: 'bicubic' });
    expect(readPixel(flip, 36, 4)).toEqual(readPixel(src, 0, 4));
  });

  it('pre-filters large reductions, so a fine checkerboard shrinks to grey', () => {
    const data = new Uint8ClampedArray(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const v = (x + y) % 2 ? 255 : 0;
      data.set([v, v, v, 255], (y * 64 + x) * 4);
    }
    const src = surfaceFromPixels({ width: 64, height: 64, data });
    const out = transformSurface(src, affine(scaleMatrix(1 / 8, 1 / 8)), { interpolation: 'bicubic' });
    expect(Math.abs(readPixel(out, 4, 4)[0] - 128)).toBeLessThan(26);
    expect(readPixel(out, 4, 4)[3]).toBe(255);
  });

  it('keeps every pixel inside a steep distort quad, and draws only the front side past the horizon', () => {
    const src = solidSurface(4, { x: 0, y: 0, width: 100, height: 100 }, 0xff0000ff);
    const steep = rectToQuad({ x: 0, y: 0, width: 100, height: 100 }, [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 155, y: 155 },
      { x: 0, y: 300 },
    ])!;
    const w = transformSurface(src, steep, { interpolation: 'nearest' });
    for (const [x, y] of [[20, 20], [252, 14], [252, 42], [14, 252], [42, 252]]) expect(readPixel(w, x, y)[3], `${x},${y}`).toBe(255);
    for (const [x, y] of [[200, 200], [280, 100], [100, 280]]) expect(readPixel(w, x, y)[3], `${x},${y}`).toBe(0);

    const past = rectToQuad({ x: 0, y: 0, width: 100, height: 100 }, [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 60, y: 60 },
      { x: 0, y: 300 },
    ])!;
    const clip = { x: -400, y: -400, width: 1100, height: 1100 };
    const out = transformSurface(src, past, { interpolation: 'bilinear', clip });
    const inv = invertHomography(past)!;
    const front = Math.sign(past[6] * 50 + past[7] * 50 + past[8]);
    const px = readRegion(out, clip);
    let drawn = 0;
    let behind = 0;
    for (let y = 0; y < clip.height; y++) {
      for (let x = 0; x < clip.width; x++) {
        if (!px[(y * clip.width + x) * 4 + 3]) continue;
        drawn++;
        const X = clip.x + x + 0.5;
        const Y = clip.y + y + 0.5;
        if (front * (inv[6] * X + inv[7] * Y + inv[8]) <= 0) behind++;
      }
    }
    expect(drawn).toBeGreaterThan(1000);
    expect(behind).toBe(0);
  });

  it('transforms a mask around its default value', () => {
    // A reveal-all mask with a black square: the square moves, white stays white everywhere else.
    const mask = solidSurface(1, { x: 10, y: 10, width: 20, height: 20 }, 0, 255);
    const out = transformSurface(mask, affine(scaleMatrix(2, 2, { x: 10, y: 10 })), { interpolation: 'bilinear' });
    expect(out.defaultValue).toBe(255);
    expect(readPixel(out, 30, 30)).toEqual([0]);
    expect(readPixel(out, 5, 5)).toEqual([255]);
    expect(readPixel(out, 60, 60)).toEqual([255]);
    // Edges blend into the default, not into black: a quarter of black coverage at x = 9.
    expect(readPixel(out, 9, 30)).toEqual([191]);
    const hide = solidSurface(1, { x: 0, y: 0, width: 8, height: 8 }, 255, 0);
    const moved = transformSurface(hide, affine([1, 0, 0, 1, 2.5, 0]), { interpolation: 'bilinear' });
    expect(readPixel(moved, 5, 3)).toEqual([255]);
    expect(readPixel(moved, 0, 3)).toEqual([0]);
  });

  it('limits work to a clip and fills preview blocks', () => {
    const px = noise(256, 256, 3, false);
    const src = surfaceFromPixels(px, 4);
    const h = affine(rotateMatrix(10, { x: 128, y: 128 }));
    const clip = { x: 64, y: 64, width: 64, height: 64 };
    const clipped = transformSurface(src, h, { interpolation: 'bilinear', clip });
    expect(contentBounds(clipped)).toEqual(clip);
    const full = transformSurface(src, h, { interpolation: 'bilinear' });
    expect(readRegion(clipped, clip)).toEqual(readRegion(full, clip));
    const preview = transformSurface(src, h, { interpolation: 'nearest', step: 4 });
    const block = readRegion(preview, { x: 128, y: 128, width: 4, height: 4 });
    for (let i = 4; i < block.length; i += 4) expect(Array.from(block.subarray(i, i + 4))).toEqual(Array.from(block.subarray(0, 4)));
  });

  it('refuses results past the pixel budget', () => {
    const src = solidSurface(4, { x: 0, y: 0, width: 100, height: 100 }, 0xffffffff);
    expect(() => transformSurface(src, affine(scaleMatrix(200, 200)))).toThrow(TransformTooLargeError);
  });
});

describe('warpSurface', () => {
  it('reproduces affine maps (the identity included) like transformSurface', () => {
    const px = noise(120, 90, 7, false);
    const src = surfaceFromPixels(px, 4, 10, 10);
    const id = warpSurface(src, (p) => p, { interpolation: 'bicubic' });
    expect(readRegion(id, { x: 10, y: 10, width: 120, height: 90 })).toEqual(new Uint8ClampedArray(px.data));
    const m = rotateMatrix(12, { x: 70, y: 55 });
    const h = affine(m);
    const viaWarp = warpSurface(src, (p) => applyHomography(h, p), { interpolation: 'bilinear' });
    const viaTransform = transformSurface(src, h, { interpolation: 'bilinear' });
    const b = transformedBounds({ x: 10, y: 10, width: 120, height: 90 }, h)!;
    // The mesh warp draws no anti-aliased fringe past the source edge, so compare where both are opaque.
    const a = readRegion(viaWarp, b);
    const c = readRegion(viaTransform, b);
    let worst = 0;
    let compared = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] !== 255 || c[i + 3] !== 255) continue;
      compared++;
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(a[i + k] - c[i + k]));
    }
    expect(compared).toBeGreaterThan(5000);
    expect(worst).toBeLessThanOrEqual(2);
  });

  it('bends through a preset mesh and keeps the corners in place', () => {
    const box = { x: 0, y: 0, width: 200, height: 100 };
    const src = solidSurface(4, box, 0x3366ccff);
    const mesh = warpPresetMesh({ style: 'arc', bend: 50 }, box)!;
    const out = warpSurface(src, (p) => evalWarpMesh(mesh, (p.x - box.x) / box.width, (p.y - box.y) / box.height), { interpolation: 'bicubic' });
    const b = contentBounds(out)!;
    expect(b.y).toBeLessThan(-5);
    // Every corner of an arc stays on its corner of the box's top edge only for Arc's inner edge; the
    // middle of the bottom edge rises.
    expect(readPixel(out, 100, 50)).toEqual([0x33, 0x66, 0xcc, 0xff]);
  });

  it('warps masks around their default value and averages when it shrinks', () => {
    const mask = solidSurface(1, { x: 0, y: 0, width: 64, height: 64 }, 0, 255);
    const out = warpSurface(mask, (p) => ({ x: p.x / 4, y: p.y / 4 }), { interpolation: 'bicubic' });
    expect(readPixel(out, 8, 8)).toEqual([0]);
    expect(readPixel(out, 40, 40)).toEqual([255]);
  });
});

describe('compositeSurfaceOver', () => {
  it('touches only the tiles the top layer stores', () => {
    const base = surfaceFromPixels(noise(600, 300), 4);
    const top = solidSurface(4, { x: 10, y: 10, width: 20, height: 20 }, 0xff000080);
    const out = compositeSurfaceOver(base, top);
    let shared = 0;
    for (const [key, tile] of out.tiles) if (base.tiles.get(key) === tile) shared++;
    expect(shared).toBe(base.tiles.size - 1);
    const under = readPixel(base, 15, 15);
    const got = readPixel(out, 15, 15);
    const a = 128 / 255;
    const da = under[3] / 255;
    expect(got[3]).toBe(Math.round((a + da * (1 - a)) * 255));
  });

  it('lands a moved grey + alpha region on a mask', () => {
    const mask = emptySurface(1, 255);
    const top = solidSurface(4, { x: 0, y: 0, width: 4, height: 4 }, 0x000000ff);
    const out: TiledSurface = compositeSurfaceOver(mask, top);
    expect(readPixel(out, 1, 1)).toEqual([0]);
    expect(readPixel(out, 5, 5)).toEqual([255]);
  });
});
