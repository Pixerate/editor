// Tile keys only hold tiles −32768..32767 on each axis (±8388608 px). Surfaces store nothing past
// that range, and saved documents that reach past it are refused with a load problem instead of
// being written at the tile an aliased key reads back as (#852).
import { describe, expect, it } from 'vitest';
import {
  MAX_SURFACE_PIXEL,
  MAX_TILE,
  MIN_SURFACE_PIXEL,
  MIN_TILE,
  SURFACE_RANGE_MESSAGE,
  checkSurfaceRange,
  contentBounds,
  emptySurface,
  readRegion,
  surfaceFromPixels,
  surfaceFromSavedPixels,
  tileCoord,
  tileInRange,
  tileKey,
  tilesInRect,
  translateSurface,
  writeRegion,
} from '../src/raster/surface';
import { pngDataUrl } from '../src/raster/png';
import { readDeepRegion, writeDeepRegion } from '../src/raster/deep';
import { PaintEditorController } from '../src/paint-editor';
import { deflateSync } from 'node:zlib';

const GRAY = pngDataUrl(2, 2, [10, 20, 30, 40], 1);
const RGBA = pngDataUrl(2, 2, new Uint8ClampedArray(16).fill(200), 4);
const doc = (extra: Record<string, unknown>, layers: unknown[] = [{ id: 'paint', name: 'Paint', type: 'pixel' }]) => ({
  format: 'pixerate-paint',
  version: 2,
  width: 48,
  height: 32,
  paper: { color: '#ffffff' },
  layers,
  ...extra,
});
const refusedLight = (id: string) => `The light paint of layer "${id}" could not be read (${SURFACE_RANGE_MESSAGE}); it loads without light.`;

describe('tile key range', () => {
  it('names the range it holds', () => {
    expect([MIN_TILE, MAX_TILE, MIN_SURFACE_PIXEL, MAX_SURFACE_PIXEL]).toEqual([-32768, 32767, -8388608, 8388607]);
    expect(SURFACE_RANGE_MESSAGE).toBe('it lies outside the surface range, -8388608 to 8388607 px on each axis');
  });

  it('round-trips every tile in the range, negative ones and the corners included', () => {
    const edges = [MIN_TILE, MIN_TILE + 1, -257, -1, 0, 1, 4096, MAX_TILE - 1, MAX_TILE];
    for (const tx of edges) {
      for (const ty of edges) {
        const key = tileKey(tx, ty);
        expect(key).toBeGreaterThanOrEqual(0);
        expect(tileCoord(key)).toEqual({ tx, ty });
        expect(tileInRange(tx, ty)).toBe(true);
      }
    }
    for (const [tx, ty] of [[MIN_TILE - 1, 0], [0, MAX_TILE + 1], [2 ** 40, 0], [0, -(2 ** 60)], [NaN, 0], [Infinity, 0]]) expect(tileInRange(tx, ty)).toBe(false);
  });

  it('refuses a saved rect that reaches past the range, and accepts the first and last pixels', () => {
    const px = { width: 2, height: 2, data: [10, 20, 30, 40] };
    for (const [x, y] of [
      [255, 2 ** 46],
      [-3e12, 5e12],
      [2 ** 46 + 256, -(2 ** 46 + 256)],
      [MAX_SURFACE_PIXEL, 0],
      [0, MIN_SURFACE_PIXEL - 1],
      [1e300, 0],
      [-Infinity, 0],
    ]) {
      expect(() => surfaceFromSavedPixels(px, 1, x, y)).toThrow(SURFACE_RANGE_MESSAGE);
    }
    const low = surfaceFromSavedPixels(px, 1, MIN_SURFACE_PIXEL, MIN_SURFACE_PIXEL);
    expect(contentBounds(low)).toEqual({ x: MIN_SURFACE_PIXEL, y: MIN_SURFACE_PIXEL, width: 2, height: 2 });
    expect(Array.from(readRegion(low, { x: MIN_SURFACE_PIXEL, y: MIN_SURFACE_PIXEL, width: 2, height: 2 }))).toEqual([10, 20, 30, 40]);
    const high = surfaceFromSavedPixels(px, 1, MAX_SURFACE_PIXEL - 1, MAX_SURFACE_PIXEL - 1);
    expect(contentBounds(high)).toEqual({ x: MAX_SURFACE_PIXEL - 1, y: MAX_SURFACE_PIXEL - 1, width: 2, height: 2 });
    // NaN writes nothing, as before; an empty rect is not checked.
    expect(() => checkSurfaceRange({ x: NaN, y: 0, width: 2, height: 2 })).not.toThrow();
    expect(() => checkSurfaceRange({ x: 1e300, y: 0, width: 0, height: 2 })).not.toThrow();
  });

  it('drops pixels past the range instead of writing them at another tile', () => {
    const px = { width: 512, height: 1, data: new Uint8ClampedArray(512).fill(9) };
    const s = surfaceFromPixels(px, 1, MAX_SURFACE_PIXEL - 255, 0);
    expect(s.tileCount).toBe(1);
    expect(contentBounds(s)).toEqual({ x: MAX_SURFACE_PIXEL - 255, y: 0, width: 256, height: 1 });
    // Before, x = −3e12 landed at x = 1101824.
    expect(surfaceFromPixels({ width: 2, height: 2, data: [1, 2, 3, 4] }, 1, -3e12, 5e12).tileCount).toBe(0);
    // A tile-aligned move out of the range drops the tiles that leave it.
    expect(translateSurface(s, 2 * 256, 0).tileCount).toBe(0);
    expect(contentBounds(translateSurface(s, -256, 0))).toEqual({ x: MAX_SURFACE_PIXEL - 511, y: 0, width: 256, height: 1 });
  });

  it('keeps loops finite far past 2^53', () => {
    expect(tilesInRect({ x: 2 ** 60, y: 2 ** 61, width: 2, height: 2 })).toEqual([]);
    expect(tilesInRect({ x: 0, y: 2 ** 53, width: 1, height: 3 })).toEqual([]);
    expect(Array.from(readRegion(emptySurface(1), { x: 2 ** 53, y: 2 ** 53, width: 2, height: 2 }))).toEqual([0, 0, 0, 0]);
    const far = writeRegion(emptySurface(1), { x: 0, y: 2 ** 53, width: 2, height: 2 }, [1, 2, 3, 4]);
    expect(far.tileCount).toBe(0);
    expect(writeDeepRegion(emptySurface(1), { x: 2 ** 54, y: 0, width: 1, height: 1 }, new Uint16Array([7])).tileCount).toBe(0);
    expect(Array.from(readDeepRegion(emptySurface(1), { x: 2 ** 54, y: 0, width: 1, height: 1 }, 16))).toEqual([0]);
  });
});

describe('saved documents far off the canvas', () => {
  it('reports far-off channels as load problems instead of aliasing them', () => {
    const c = new PaintEditorController({ width: 48, height: 32 });
    const problems = c.loadJSON(
      doc(
        {
          light: {
            paint: { rect: { x: 255, y: 2 ** 46 }, light: GRAY },
            far: { rect: { x: -3e12, y: 5e12 }, light: GRAY },
          },
          fluor: { neg: { rect: { x: 2 ** 46 + 256, y: -(2 ** 46 + 256) }, fluor: RGBA } },
        },
        [
          { id: 'paint', name: 'Paint', type: 'pixel' },
          { id: 'far', name: 'Far', type: 'pixel' },
          { id: 'neg', name: 'Negative', type: 'pixel' },
        ]
      ) as never
    );
    expect(problems).toEqual([
      refusedLight('paint'),
      refusedLight('far'),
      `The fluorescent ink of layer "neg" could not be read (${SURFACE_RANGE_MESSAGE}); it loads without fluorescence.`,
    ]);
    const saved = c.toJSON() as unknown as Record<string, unknown>;
    expect(saved.light).toBeUndefined();
    expect(saved.fluor).toBeUndefined();
    c.dispose();
  });

  it('saves and reopens channels at negative coordinates where they were', () => {
    const c = new PaintEditorController({ width: 48, height: 32 });
    const rect = { x: MIN_SURFACE_PIXEL, y: MIN_SURFACE_PIXEL };
    expect(c.loadJSON(doc({ light: { paint: { rect, light: GRAY } }, thermo: { paint: { rect: { x: -300, y: -7 }, thermo: RGBA } } }) as never)).toEqual([]);
    const saved = JSON.parse(JSON.stringify(c.toJSON()));
    expect(saved.light.paint.rect).toEqual({ x: MIN_SURFACE_PIXEL, y: MIN_SURFACE_PIXEL, width: 256, height: 256 });
    expect(saved.thermo.paint.rect).toEqual({ x: -512, y: -256, width: 256, height: 256 });
    const d = new PaintEditorController({ width: 48, height: 32 });
    expect(d.loadJSON(saved)).toEqual([]);
    const light = d.document.light!.paint;
    expect(Array.from(readRegion(light, { ...rect, width: 2, height: 2 }))).toEqual([10, 20, 30, 40]);
    expect(contentBounds(light)).toEqual({ ...rect, width: 2, height: 2 });
    expect(contentBounds(d.document.thermo!.paint)).toEqual({ x: -300, y: -7, width: 2, height: 2 });
    expect(JSON.parse(JSON.stringify(d.toJSON()))).toEqual(saved);
    c.dispose();
    d.dispose();
  });

  it('refuses deep samples and layer pixels past the range without hanging', () => {
    // 2 × 2 RGBA 16-bit samples: 32 bytes.
    const data = deflateSync(Buffer.alloc(32, 0x80)).toString('base64');
    const deep = (x: number) => ({ depth: 16, x, y: 0, width: 2, height: 2, data });
    const ok = new PaintEditorController({ width: 48, height: 32 });
    expect(ok.loadJSON(doc({ assets: { a: RGBA } }, [{ id: 'deep', name: 'Deep', type: 'pixel', asset: 'a', deep: deep(0) }]) as never)).toEqual([]);
    ok.dispose();
    const c = new PaintEditorController({ width: 48, height: 32 });
    const problems = c.loadJSON(
      doc({ assets: { a: RGBA } }, [
        { id: 'deep', name: 'Deep', type: 'pixel', asset: 'a', deep: deep(2 ** 60) },
        { id: 'off', name: 'Off', type: 'pixel', asset: 'a', x: 9e6, y: 0 },
      ]) as never
    );
    expect(problems).toEqual([
      'Layer "Deep": its 16-bit samples could not be read, so it was opened at 8 bits',
      `Layer "Off": asset "a" could not be decoded (${SURFACE_RANGE_MESSAGE})`,
    ]);
    expect(() => c.toJSON()).not.toThrow();
    c.dispose();
  });
});
