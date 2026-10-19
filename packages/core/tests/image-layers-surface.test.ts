import { describe, expect, it } from 'vitest';
import {
  SurfaceDraft,
  TILE,
  contentBounds,
  emptySurface,
  fillRect,
  packRgba,
  readPixel,
  readRegion,
  solidSurface,
  surfaceBytes,
  surfaceFromPixels,
  surfacesEqual,
  tileCoord,
  tileKey,
  tilesInRect,
  translateSurface,
  uniformTile,
  writeRegion,
} from '../src/image-editor';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomPixels(w: number, h: number, seed = 1, channels = 4) {
  const r = rng(seed);
  const data = new Uint8ClampedArray(w * h * channels);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(r() * 256);
  return { width: w, height: h, data };
}

describe('tiled surfaces', () => {
  it('packs tile coordinates, negative ones included', () => {
    for (const [tx, ty] of [[0, 0], [-1, -1], [5, -3], [-32768, 32767], [100, 200]]) {
      expect(tileCoord(tileKey(tx, ty))).toEqual({ tx, ty });
    }
    expect(tilesInRect({ x: -1, y: 0, width: TILE + 2, height: 1 }).map((t) => t.tx)).toEqual([-1, 0, 1]);
    expect(tilesInRect({ x: 0, y: 0, width: 0, height: 10 })).toEqual([]);
  });

  it('reads back what was written, anywhere, with the default outside', () => {
    const px = randomPixels(300, 280, 2);
    const s = surfaceFromPixels(px, 4, -100, 37);
    expect(readRegion(s, { x: -100, y: 37, width: 300, height: 280 })).toEqual(px.data);
    // A window straddling the content and empty space.
    const win = readRegion(s, { x: 150, y: 300, width: 100, height: 40 });
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 100; x++) {
        const dx = 150 + x + 100;
        const dy = 300 + y - 37;
        const inside = dx < 300 && dy < 280;
        const i = (y * 100 + x) * 4;
        const want = inside ? Array.from(px.data.subarray((dy * 300 + dx) * 4, (dy * 300 + dx) * 4 + 4)) : [0, 0, 0, 0];
        expect(Array.from(win.subarray(i, i + 4))).toEqual(want);
      }
    }
    expect(readPixel(s, -100, 37)).toEqual(Array.from(px.data.subarray(0, 4)));
    expect(readPixel(s, 5000, 5000)).toEqual([0, 0, 0, 0]);
  });

  it('is copy-on-write: a write shares every untouched tile and leaves the original alone', { timeout: 30_000 }, () => {
    const base = surfaceFromPixels(randomPixels(TILE * 3, TILE * 2, 3), 4);
    const before = readRegion(base, { x: 0, y: 0, width: TILE * 3, height: TILE * 2 });
    const patch = new Uint8ClampedArray(10 * 10 * 4).fill(200);
    const next = writeRegion(base, { x: TILE + 5, y: 5, width: 10, height: 10 }, patch);
    expect(next).not.toBe(base);
    // Byte comparison (a toEqual over a large array is slow).
    expect(Buffer.from(readRegion(base, { x: 0, y: 0, width: TILE * 3, height: TILE * 2 })).equals(Buffer.from(before))).toBe(true);
    let shared = 0;
    for (const [k, t] of next.tiles) if (base.tiles.get(k) === t) shared++;
    expect(shared).toBe(5);
    expect(next.getTile(1, 0)).not.toBe(base.getTile(1, 0));
    expect(readPixel(next, TILE + 6, 6)).toEqual([200, 200, 200, 200]);
  });

  it('stores uniform tiles once and drops default tiles', () => {
    const red = packRgba(255, 0, 0, 255);
    const s = solidSurface(4, { x: 0, y: 0, width: TILE * 4, height: TILE * 4 }, red);
    expect(s.tileCount).toBe(16);
    const tiles = new Set(s.tiles.values());
    expect(tiles.size).toBe(1);
    expect([...tiles][0]).toBe(uniformTile(4, red));
    expect(surfaceBytes(s)).toBe(0);
    // Filling back to the default removes the tiles.
    const cleared = fillRect(s, { x: 0, y: 0, width: TILE * 2, height: TILE * 4 }, [0, 0, 0, 0]);
    expect(cleared.tileCount).toBe(8);
    // A partial fill makes an owned tile, which becomes uniform again when completed.
    const partial = fillRect(emptySurface(4), { x: 0, y: 0, width: 10, height: 10 }, [1, 2, 3, 4]);
    expect(partial.getTile(0, 0)!.uniform).toBeNull();
    const done = fillRect(partial, { x: 10, y: 0, width: TILE - 10, height: TILE }, [1, 2, 3, 4]);
    const rest = fillRect(done, { x: 0, y: 10, width: 10, height: TILE - 10 }, [1, 2, 3, 4]);
    expect(rest.getTile(0, 0)!.uniform).toBe(packRgba(1, 2, 3, 4));
  });

  it('masks use one byte and their own default', () => {
    const hidden = emptySurface(1, 0);
    const revealed = emptySurface(1, 255);
    expect(readRegion(revealed, { x: -5, y: -5, width: 3, height: 1 })).toEqual(new Uint8ClampedArray([255, 255, 255]));
    const m = writeRegion(hidden, { x: 1, y: 1, width: 2, height: 1 }, [10, 20]);
    expect(readRegion(m, { x: 0, y: 1, width: 4, height: 1 })).toEqual(new Uint8ClampedArray([0, 10, 20, 0]));
    // A tile written back to the default is dropped.
    const back = writeRegion(m, { x: 1, y: 1, width: 2, height: 1 }, [0, 0]);
    expect(back.tileCount).toBe(0);
  });

  it('bounds are tile-aligned; contentBounds is exact', () => {
    const s = writeRegion(emptySurface(4), { x: 300, y: -20, width: 5, height: 7 }, new Uint8ClampedArray(5 * 7 * 4).fill(9));
    expect(s.bounds).toEqual({ x: TILE, y: -TILE, width: TILE, height: TILE });
    expect(contentBounds(s)).toEqual({ x: 300, y: -20, width: 5, height: 7 });
    expect(contentBounds(emptySurface(4))).toBeNull();
  });

  it('drafts copy a tile on first write and commit once', () => {
    const base = surfaceFromPixels(randomPixels(TILE * 2, TILE, 5), 4);
    const draft = new SurfaceDraft(base);
    const t = draft.tile(0, 0);
    t[0] = 1;
    expect(draft.tile(0, 0)).toBe(t);
    expect(base.getTile(0, 0)!.data[0]).not.toBe(1);
    expect(draft.touched).toEqual([tileKey(0, 0)]);
    const next = draft.commit();
    expect(next.getTile(0, 0)!.data[0]).toBe(1);
    expect(next.getTile(1, 0)).toBe(base.getTile(1, 0));
    expect(new SurfaceDraft(base).commit()).toBe(base);
  });

  it('translates exactly, sharing tiles for whole-tile moves', () => {
    const px = randomPixels(70, 40, 6);
    const s = surfaceFromPixels(px, 4, 3, 4);
    const moved = translateSurface(s, TILE, -TILE);
    expect([...moved.tiles.values()][0]).toBe([...s.tiles.values()][0]);
    expect(readRegion(moved, { x: 3 + TILE, y: 4 - TILE, width: 70, height: 40 })).toEqual(px.data);
    const odd = translateSurface(s, 5, -7);
    expect(readRegion(odd, { x: 8, y: -3, width: 70, height: 40 })).toEqual(px.data);
  });

  it('compares surfaces by content', () => {
    const px = randomPixels(50, 50, 7);
    const a = surfaceFromPixels(px, 4);
    const b = surfaceFromPixels(px, 4);
    expect(a).not.toBe(b);
    expect(surfacesEqual(a, b)).toBe(true);
    expect(surfacesEqual(a, writeRegion(a, { x: 0, y: 0, width: 1, height: 1 }, [0, 0, 0, 1]))).toBe(false);
  });
});
