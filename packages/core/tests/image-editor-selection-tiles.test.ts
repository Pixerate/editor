import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  combineSelections,
  computeSelectionBounds,
  createSelectionMask,
  fullSelection,
  invertSelection,
  selectionArea,
  selectionFromTiles,
  selectionValueAt,
  createImageEditorToolProvider,
  type SelectionMask,
} from '../src/image-editor';
import { TILE, emptySurface, fillRect, type Tile } from '../src/raster/surface';

/** A deterministic pseudo-random source. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Coverage with a hard rectangle, a soft ellipse and some noise, so tiles of every kind occur. */
function sampleCoverage(width: number, height: number, seed: number): Uint8Array {
  const r = rng(seed);
  const out = new Uint8Array(width * height);
  const rx = Math.floor(r() * width * 0.5);
  const ry = Math.floor(r() * height * 0.5);
  const cx = width * (0.3 + r() * 0.4);
  const cy = height * (0.3 + r() * 0.4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = x >= rx && x < rx + width / 3 && y >= ry && y < ry + height / 3 ? 255 : 0;
      const d = Math.hypot((x - cx) / (width / 5), (y - cy) / (height / 5));
      if (d < 1) v = Math.max(v, Math.round((1 - d) * 255));
      if (x % 97 === 13 && r() < 0.3) v = Math.floor(r() * 256);
      out[y * width + x] = v;
    }
  }
  return out;
}

const naive = {
  add: (a: number, b: number) => Math.max(a, b),
  subtract: (a: number, b: number) => Math.max(a - b, 0),
  intersect: (a: number, b: number) => Math.min(a, b),
};

function tileSet(mask: SelectionMask): Set<Tile> {
  return new Set(mask.surface.tiles.values());
}

describe('tiled selection masks', () => {
  // Sizes that are not multiples of the tile size, so edge tiles are partial.
  const sizes: [number, number][] = [[600, 300], [256, 512], [1, 1], [257, 3]];

  it.each(sizes)('combine, invert, area, bounds and values match a per-pixel reference at %i×%i', (w, h) => {
    const a = sampleCoverage(w, h, w + h);
    const b = sampleCoverage(w, h, w * 7 + 1);
    const ma = createSelectionMask(w, h, new Uint8Array(a));
    const mb = createSelectionMask(w, h, new Uint8Array(b));
    expect(Array.from(ma.data)).toEqual(Array.from(a));
    expect(ma.bounds).toEqual(computeSelectionBounds(w, h, a));
    for (const mode of ['add', 'subtract', 'intersect'] as const) {
      const out = combineSelections(ma, mb, mode);
      const expected = a.map((v, i) => naive[mode](v, b[i]));
      const bounds = computeSelectionBounds(w, h, expected);
      if (!bounds) {
        expect(out, mode).toBeNull();
        continue;
      }
      expect(Array.from(out!.data), mode).toEqual(Array.from(expected));
      expect(out!.bounds, mode).toEqual(bounds);
      expect(selectionArea(out), mode).toBeCloseTo(expected.reduce((s, v) => s + v, 0) / 255, 6);
    }
    const inv = invertSelection(ma);
    expect(Array.from(inv.data)).toEqual(Array.from(a, (v) => 255 - v));
    expect(Array.from(invertSelection(inv).data)).toEqual(Array.from(a));
    const i = Math.floor(a.length / 2);
    expect(selectionValueAt(ma, i % w, Math.floor(i / w))).toBeCloseTo(a[i] / 255, 6);
    expect(selectionValueAt(ma, -1, 0)).toBe(0);
    // Nothing outside the image is ever stored.
    for (const m of [ma, inv, fullSelection(w, h)]) {
      for (const [key, tile] of m.surface.tiles) {
        expect(tile.data.length).toBe(TILE * TILE);
        void key;
      }
      expect(selectionArea(m)).toBeCloseTo(Array.from(m.data).reduce((s, v) => s + v, 0) / 255, 6);
    }
  });

  it('stores an empty or fully selected area as no tiles or one shared tile', () => {
    const full = fullSelection(4096, 3072);
    const kinds = new Set([...full.surface.tiles.values()].map((t) => t.uniform));
    expect(kinds).toEqual(new Set([255]));
    expect(tileSet(full).size).toBe(1);
    expect(selectionArea(full)).toBe(4096 * 3072);
    expect(invertSelection(full).surface.tiles.size).toBe(0);
    expect(createSelectionMask(4096, 3072).surface.tiles.size).toBe(0);
  });

  it('shares the tiles an operation did not change', () => {
    const w = 2048;
    const h = 2048;
    const rect = (x: number, y: number, s: number) => {
      const d = new Uint8Array(w * h);
      for (let yy = y; yy < y + s; yy++) d.fill(255, yy * w + x, yy * w + x + s);
      return createSelectionMask(w, h, d);
    };
    const first = rect(10, 10, 100);
    const both = combineSelections(first, rect(1500, 1500, 100), 'add')!;
    expect(both.surface.getTile(0, 0)).toBe(first.surface.getTile(0, 0));
    const big = rect(0, 0, 1024);
    const cut = combineSelections(big, rect(900, 900, 50), 'subtract')!;
    // Only the one tile the cut touches is new.
    const fresh = [...cut.surface.tiles.values()].filter((t) => ![...big.surface.tiles.values()].includes(t));
    expect(fresh).toHaveLength(1);
  });

  it('reads data lazily and rebuilds it after it was let go', () => {
    const masks = Array.from({ length: 8 }, (_, i) => createSelectionMask(300, 300, sampleCoverage(300, 300, i)));
    const first = masks[0]!.data;
    expect(masks[0]!.data).toBe(first);
    const copy = Array.from(first);
    for (const m of masks) void m.data;
    expect(Array.from(masks[0]!.data)).toEqual(copy);
  });

  it('wraps a painted surface without copying, dropping paint outside the image', () => {
    const surface = fillRect(emptySurface(1, 0), { x: -20, y: 250, width: 400, height: 20 }, [255]);
    const sel = selectionFromTiles(300, 260, surface);
    expect(sel.bounds).toEqual({ x: 0, y: 250, width: 300, height: 10 });
    expect(selectionArea(sel)).toBe(300 * 10);
    const inside = fillRect(emptySurface(1, 0), { x: 0, y: 0, width: 256, height: 256 }, [255]);
    expect(selectionFromTiles(512, 512, inside).surface).toBe(inside);
  });
});

describe('selections in the editor', () => {
  function setup(width: number, height: number) {
    const fake = { width, height, naturalWidth: width, naturalHeight: height, src: 'data:fake' } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(c));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await registry.callTool(name, args);
      if (res.isError) throw new Error(String((res.content?.[0] as { text?: string })?.text ?? 'tool error'));
      return res.structuredContent as Record<string, any>;
    };
    return { c, call };
  }

  it('counts selection and channel tiles in historyBytes, sharing unchanged tiles', async () => {
    const { c, call } = setup(4096, 3072);
    expect(c.historyBytes).toBe(0);
    await call('select_all');
    await call('save_selection', { name: 'All' });
    // Steps that only swap fully selected tiles for shared ones hold nothing of their own.
    for (let i = 0; i < 5; i++) await call('select_rect', { x: 300 + i * 300, y: 300, width: 50, height: 50, mode: 'subtract', antiAlias: false });
    expect(c.historyBytes).toBe(0);
    // Ten cuts into one tile: each step keeps its own copy of that tile, and nothing else.
    for (let i = 0; i < 10; i++) await call('select_rect', { x: 10 + i * 20, y: 10, width: 10, height: 10, mode: 'subtract', antiAlias: false });
    expect(c.historyBytes).toBe(9 * TILE * TILE);
    expect((await call('get_selection')).percent).toBeLessThan(100);
  });

  it('keeps Quick Mask paint in tiles shared with the selection it started from', async () => {
    const { c, call } = setup(1024, 1024);
    await call('select_rect', { x: 0, y: 0, width: 1024, height: 512, antiAlias: false });
    const before = c.getSelection()!;
    await call('set_quick_mask', { enabled: true });
    await call('paint_stroke', { points: [{ x: 900, y: 900 }, { x: 950, y: 950 }], color: '#ffffff', brush: { size: 10, hardness: 1 } });
    const after = c.getSelection()!;
    expect(after).not.toBe(before);
    expect(after.surface.getTile(0, 0)).toBe(before.surface.getTile(0, 0));
    expect(after.data[920 * 1024 + 920]).toBe(255);
    expect(after.bounds).toMatchObject({ x: 0, y: 0, width: 1024 });
  });
});
