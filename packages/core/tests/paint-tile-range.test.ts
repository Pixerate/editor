// Paint code that keys tiles straight from pixel coordinates (brushes, the paint exchange, culture,
// thick paint, antimatter, the wet engine) stays inside the surface tile range: a pixel layer offset
// past ±8388608 px must not alias a stroke onto another tile of that layer (#852).
import { describe, expect, it } from 'vitest';
import {
  MAX_TILE,
  MIN_TILE,
  NO_TILE_KEY,
  TILE,
  readRegion,
  tileCoord,
  tileInRange,
  tileKey,
  tileKeyIn,
  type TileKey,
} from '../src/raster/surface';
import { pngDataUrl } from '../src/raster/png';
import { CoverageMap } from '../src/paint/brush';
import { TileMedium, type PaintTileTarget } from '../src/paint/exchange';
import { TilePixelSource } from '../src/paint/retouch';
import { DEFAULT_CULTURE, seedCultureFromStroke, stepLayerCulture } from '../src/paint/culture';
import { emptySurface, surfaceFromPixels } from '../src/raster/surface';
import { PaintEditorController } from '../src/paint-editor';
import type { PaintPixelLayer } from '../src/paint-editor/document';

const FAR = 9e6;
const RGBA = pngDataUrl(2, 2, new Uint8ClampedArray(16).fill(200), 4);

/** A painting with a layer offset past the range (`far`, its pixels at canvas x = 9e6) and one on the canvas (`near`). */
function editor(options: ConstructorParameters<typeof PaintEditorController>[0] = {}) {
  const c = new PaintEditorController({ width: 96, height: 64, ...options });
  const problems = c.loadJSON({
    format: 'pixerate-paint',
    version: 2,
    width: 96,
    height: 64,
    paper: { color: '#ffffff' },
    assets: { a: RGBA },
    layers: [
      { id: 'near', name: 'Near', type: 'pixel', asset: 'a', x: 4, y: 4 },
      { id: 'far', name: 'Far', type: 'pixel', asset: 'a', x: 0, y: 0, offset: { x: FAR, y: 0 } },
    ],
  } as never);
  expect(problems).toEqual([]);
  c.setActiveLayer('far');
  return c;
}

const layer = (c: PaintEditorController, id: string) => c.document.layers.find((l) => l.id === id) as PaintPixelLayer;
const keys = (c: PaintEditorController, id: string) => [...layer(c, id).surface.tiles.keys()].sort((a, b) => a - b);
const line = (y = 32, x0 = 12, x1 = 84) => Array.from({ length: 12 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 11, y, pressure: 0.8 }));

/** Every stored tile of every pixel layer is in range and reads back as itself. */
function expectKeysInRange(c: PaintEditorController) {
  for (const l of c.document.layers as PaintPixelLayer[]) {
    for (const key of l.surface.tiles.keys()) {
      const { tx, ty } = tileCoord(key);
      expect(tileInRange(tx, ty)).toBe(true);
      expect(tileKey(tx, ty)).toBe(key);
    }
  }
}

describe('tileKeyIn', () => {
  it('keys tiles in the range as tileKey does and gives NO_TILE_KEY past it', () => {
    for (const [tx, ty] of [[0, 0], [MIN_TILE, MIN_TILE], [MAX_TILE, MAX_TILE], [-1, 7]]) expect(tileKeyIn(tx, ty)).toBe(tileKey(tx, ty));
    for (const [tx, ty] of [[MIN_TILE - 1, 0], [0, MAX_TILE + 1], [-35157, -1], [2 ** 40, 0], [NaN, 0], [0, -Infinity]]) expect(tileKeyIn(tx, ty)).toBe(NO_TILE_KEY);
    // The alias #852 is about: one column past the range shares a key with a tile in it.
    expect(tileKey(MAX_TILE + 1, 0)).toBe(tileKey(MIN_TILE, 1));
    expect(NO_TILE_KEY).toBeLessThan(tileKey(MIN_TILE, MIN_TILE));
  });
});

describe('paint primitives past the tile range', () => {
  it('a coverage map drops coverage past the range and reads it as none', () => {
    const cov = new CoverageMap();
    const x = (MAX_TILE + 1) * TILE; // the first pixel past the range: its key aliases tile (MIN_TILE, 1)
    cov.accumulate({ x: x - 2, y: 0, width: 4, height: 1 }, new Float32Array([1, 1, 1, 1]), 1);
    expect([...cov.tiles.keys()]).toEqual([tileKey(MAX_TILE, 0)]);
    expect(cov.get(x - 1, 0)).toBe(1);
    expect(cov.get(x, 0)).toBe(0);
    expect(cov.get(MIN_TILE * TILE, TILE)).toBe(0);
    const far = new CoverageMap();
    far.accumulate({ x: -1e12, y: 5, width: 3, height: 3 }, new Float32Array(9).fill(1), 1);
    expect(far.tiles.size).toBe(0);
    expect(far.bounds).toBeNull();
  });

  it('the paint exchange reads past the range as empty and drops writes there', () => {
    const tiles = new Map<TileKey, Uint8ClampedArray>();
    const asked: Array<[number, number]> = [];
    const target: PaintTileTarget = {
      offset: { x: FAR, y: 0 },
      lockTransparency: false,
      selection: null,
      readTile: (tx, ty) => (asked.push([tx, ty]), tiles.get(tileKey(tx, ty)) ?? null),
      writeTile: (tx, ty) => {
        asked.push([tx, ty]);
        const k = tileKey(tx, ty);
        let t = tiles.get(k);
        if (!t) tiles.set(k, (t = new Uint8ClampedArray(TILE * TILE * 4)));
        return t;
      },
    };
    const m = new TileMedium(target);
    m.deposit({ x: 10, y: 10, width: 4, height: 4 }, new Float32Array(16).fill(1), 1, [1, 0, 0], null);
    expect(m.locate(10, 10, false)).toBe(-1);
    expect(m.sample({ x: 10, y: 10, width: 4, height: 4 }, new Float32Array(16).fill(1))).toBeNull();
    expect(asked).toEqual([]);
    expect(tiles.size).toBe(0);
    // In range it still writes and reads back.
    m.locate(FAR + 3, 2, true);
    m.deposit({ x: FAR + 3, y: 2, width: 1, height: 1 }, [1], 1, [1, 0, 0], null);
    expect([...tiles.keys()]).toEqual([tileKey(0, 0)]);
    expect(m.locate(FAR + 3, 2, false)).toBeGreaterThanOrEqual(0);
  });

  it('a tile pixel source never hands a tile past the range to its reader', () => {
    const asked: Array<[number, number]> = [];
    const src = new TilePixelSource((tx, ty) => (asked.push([tx, ty]), new Uint8ClampedArray(TILE * TILE * 4).fill(255)), 4, { x: FAR, y: 0 });
    const out = [9, 9, 9, 9];
    expect(src.sample(5, 5, out)).toBe(false);
    expect(out).toEqual([0, 0, 0, 0]);
    expect(src.sample(FAR + 5, 5, out)).toBe(true);
    expect(asked).toEqual([[0, 0]]);
  });
});

describe('culture on a layer offset past the tile range', () => {
  const seedInput = (offsetX: number, x0: number) => ({
    points: [{ x: x0 + 20, y: 30 }, { x: x0 + 80, y: 30 }],
    brushSize: 8,
    color: [20, 40, 60] as const,
    culture: { ...DEFAULT_CULTURE },
    strokeSeed: 7,
    beforeSurface: emptySurface(4),
    afterSurface: emptySurface(4),
    canvasWidth: 96,
    canvasHeight: 64,
    offsetX,
  });

  it('seeds no spores past the range', () => {
    expect(seedCultureFromStroke(seedInput(0, 0)).seedsAdded).toBeGreaterThan(0);
    expect(seedCultureFromStroke(seedInput(FAR, -FAR)).seedsAdded).toBe(0);
  });

  it('grows no thread onto a tile of the layer, and stops', () => {
    // The colony a canvas-space stroke would seed, as the far layer holds it (its pixels at x − 9e6).
    const near = seedCultureFromStroke(seedInput(0, 0)).culture;
    const culture = { ...near, tips: near.tips.map((t) => ({ ...t, x: t.x - FAR * 256 })) };
    const surface = surfaceFromPixels({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(200) }, 4);
    const r = stepLayerCulture({ culture, surface, paperSeed: 1, paperDepthPermille: 0, canvasWidth: 96, canvasHeight: 64, offsetX: FAR, steps: 40 });
    expect(r.segmentsAdded).toBe(0);
    expect([...r.surface.tiles.keys()]).toEqual([...surface.tiles.keys()]);
    expect(r.culture.occupancy.tileCount).toBe(0);
  });
});

describe('strokes on a layer offset past the tile range', () => {
  it.each([
    ['a dry brush', { brushId: 'ink-pen' }],
    ['a soft brush', { brushId: 'soft-pastel' }],
    ['the mixer', { tool: 'mixer', mixer: { wet: 0.5, load: 1 } }],
    ['the smudge tool', { tool: 'smudge' }],
    ['the blender', { tool: 'blender' }],
    ['thick paint', { brushId: 'impasto-brush' }],
    ['a culture brush', { brushId: 'mycelial-ink', seed: 7 }],
    ['antimatter', { brushId: 'antimatter' }],
  ])('%s leaves every tile of the far layer alone', (_, opts) => {
    const c = editor();
    const before = keys(c, 'far');
    const near = keys(c, 'near');
    const pixels = Array.from(readRegion(layer(c, 'far').surface, { x: 0, y: 0, width: 2, height: 2 }));
    c.paintStroke({ points: line(), color: '#ff0000', ...opts } as never);
    expect(keys(c, 'far')).toEqual(before);
    expect(keys(c, 'near')).toEqual(near);
    expect(Array.from(readRegion(layer(c, 'far').surface, { x: 0, y: 0, width: 2, height: 2 }))).toEqual(pixels);
    expectKeysInRange(c);
    c.dispose();
  });

  it('a wet stroke paints on the canvas and keys no tile past the range, without hanging', async () => {
    const c = editor({ wet: { kernel: 'wasm', threads: 0 } });
    const near = layer(c, 'near').surface;
    const r = c.paintStroke({ points: line(), brushId: 'watercolor-round', color: '#1d4ed8' });
    await c.wetReady();
    expect(r.wet).toBe(true);
    await c.advanceWet({ steps: 16 });
    c.dryPaint();
    const far = layer(c, 'far');
    // The wet engine works in canvas space: the layer was moved there (its far pixels dropped, as
    // `translateSurface` drops tiles leaving the range) and the stroke landed on the canvas.
    expect(far.offset).toEqual({ x: 0, y: 0 });
    expect(far.surface.tileCount).toBeGreaterThan(0);
    for (const key of far.surface.tiles.keys()) expect(tileCoord(key).tx).toBeLessThan(1);
    expect(layer(c, 'near').surface).toBe(near);
    expectKeysInRange(c);
    c.dispose();
  }, 30_000);
});
