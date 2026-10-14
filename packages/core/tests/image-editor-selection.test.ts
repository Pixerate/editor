// Test cases re-expressed from photocraft/crates/algo/src/selection.rs, selection_blur.rs,
// matting.rs and tests_selection_mix.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors).
// See THIRD_PARTY_NOTICES.md.
import { describe, it, expect } from 'vitest';
import {
  borderCoverage,
  colorRange,
  combineSelections,
  contractCoverage,
  createSelectionMask,
  decodeSelectionRle,
  deserializeSelection,
  distanceTransform,
  ellipseSelection,
  encodeSelectionRle,
  expandCoverage,
  featherCoverage,
  fullSelection,
  hueRange,
  invertSelection,
  isSelectionEmpty,
  magicWand,
  modifySelection,
  polygonCoverage,
  rectSelection,
  refineCoverage,
  refineSelection,
  resizeSelection,
  selectionArea,
  selectionFromCoverage,
  selectionFromPixels,
  selectionModeFromModifiers,
  selectionOutline,
  serializeSelection,
  smoothCoverage,
  toneRange,
  quickMaskPixels,
  describeSelection,
  parseSelectionMode,
  boxMean,
  guidedFilterColor,
  type PixelBuffer,
  type SelectionMask,
} from '../src/image-editor/selection';
import { measureGrowth } from './helpers/growth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function img(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

const count = (m: SelectionMask, pred: (v: number) => boolean = (v) => v > 0) => m.data.filter(pred).length;
const at = (m: SelectionMask, x: number, y: number) => m.data[y * m.width + x];

function square(w: number, h: number, lo = 5, hi = 15): Float32Array {
  const m = new Float32Array(w * h);
  for (let i = 0; i < m.length; i++) {
    const x = i % w;
    const y = Math.floor(i / w);
    if (x >= lo && x < hi && y >= lo && y < hi) m[i] = 1;
  }
  return m;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

function directFeather(m: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k: number[] = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const s = k.reduce((a, b) => a + b, 0);
  const kn = k.map((v) => v / s);
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = 0; i < kn.length; i++) {
        const xx = x + i - r;
        if (xx >= 0 && xx < w) a += m[y * w + xx] * kn[i];
      }
      tmp[y * w + x] = a;
    }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = 0; i < kn.length; i++) {
        const yy = y + i - r;
        if (yy >= 0 && yy < h) a += tmp[yy * w + x] * kn[i];
      }
      out[y * w + x] = a;
    }
  return out;
}

const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
};

// ---------------------------------------------------------------------------
// Magic wand, colour range
// ---------------------------------------------------------------------------

describe('magic wand', () => {
  it('contiguous vs global, anti-aliased fringe, seed outside', () => {
    // Two separate red squares (columns 2..5 and 12..15) on white.
    const px = img(20, 10, (x) => ((x >= 2 && x < 6) || (x >= 12 && x < 16) ? [255, 0, 0, 255] : [255, 255, 255, 255]));
    const c = magicWand(px, { x: 3, y: 3 }, { tolerance: 10, contiguous: true, antiAlias: false });
    expect(count(c)).toBe(40);
    expect(c.bounds).toEqual({ x: 2, y: 0, width: 4, height: 10 });
    const g = magicWand(px, { x: 3, y: 3 }, { tolerance: 10, contiguous: false, antiAlias: false });
    expect(count(g)).toBe(80);
    const aa = magicWand(px, { x: 3, y: 3 }, { tolerance: 10, contiguous: true, antiAlias: true });
    expect(at(aa, 6, 3)).toBeGreaterThan(0);
    expect(at(aa, 6, 3)).toBeLessThan(255);
    expect(isSelectionEmpty(magicWand(px, { x: 50, y: 3 }, { tolerance: 10 }))).toBe(true);
  });

  it('tolerance counts levels of the largest channel difference', () => {
    const px = img(10, 1, (x) => [x * 10, 0, 0, 255]);
    const m = magicWand(px, { x: 0, y: 0 }, { tolerance: 25, antiAlias: false });
    expect(count(m)).toBe(3);
  });

  it('ignores hidden RGB only when both pixels are fully transparent', () => {
    const pixels: [number, number, number, number][] = [
      [255, 0, 0, 0],
      [0, 255, 0, 0],
      [255, 0, 0, 128],
      [253, 0, 0, 128],
      [0, 0, 255, 0],
      [255, 0, 0, 255],
    ];
    const px = img(6, 1, (x) => pixels[x]);
    const cases: [number, number, boolean, number[]][] = [
      [0, 0, true, [1, 1, 0, 0, 0, 0]],
      [0, 0, false, [1, 1, 0, 0, 1, 0]],
      [4, 32, false, [1, 1, 0, 0, 1, 0]],
      [2, 0, false, [0, 0, 1, 0, 0, 0]],
      [2, 2, true, [0, 0, 1, 1, 0, 0]],
      [5, 32, false, [0, 0, 0, 0, 0, 1]],
    ];
    for (const [seed, tolerance, contiguous, expected] of cases) {
      const m = magicWand(px, { x: seed, y: 0 }, { tolerance, contiguous, antiAlias: false });
      expect(Array.from(m.data, (v) => v / 255)).toEqual(expected);
    }
  });

  it('perceptual distance treats a big lightness step as different and small hue noise as same', () => {
    // Left: two near-identical greens; right: a much darker green at a small per-channel step.
    const px = img(3, 1, (x) => (x === 0 ? [40, 160, 60, 255] : x === 1 ? [44, 158, 63, 255] : [10, 120, 20, 255]));
    const m = magicWand(px, { x: 0, y: 0 }, { tolerance: 10, distance: 'perceptual', antiAlias: false });
    expect(Array.from(m.data)).toEqual([255, 255, 0]);
  });

  it('fills a long serpentine corridor without recursion (scanline stack)', () => {
    const w = 301;
    const h = 401;
    // Walls on every 4th row, open at alternating ends: one corridor ~ w·h/4·… pixels long.
    const px = img(w, h, (x, y) => {
      const wall = y % 4 === 3 && ((y >> 2) % 2 === 0 ? x < w - 2 : x > 1);
      return wall ? [0, 0, 0, 255] : [255, 255, 255, 255];
    });
    const m = magicWand(px, { x: 0, y: 0 }, { tolerance: 0, antiAlias: false });
    expect(at(m, 0, h - 1)).toBe(255);
    expect(at(m, 5, 3)).toBe(0); // wall
    expect(count(m)).toBe(count(magicWand(px, { x: 0, y: 0 }, { tolerance: 0, contiguous: false, antiAlias: false })));
  });
});

describe('colour range', () => {
  it('falls off linearly and skips transparent pixels', () => {
    const px = img(4, 1, (x) => [[255, 0, 0, 255], [230, 0, 0, 255], [0, 0, 255, 255], [255, 0, 0, 0]][x] as [number, number, number, number]);
    const m = colorRange(px, [{ color: [255, 0, 0] }], { fuzziness: 40 });
    expect(m.data[0]).toBe(255);
    expect(m.data[1]).toBeGreaterThan(0.3 * 255);
    expect(m.data[1]).toBeLessThan(255);
    expect(m.data[2]).toBe(0);
    expect(m.data[3]).toBe(0);
  });

  it('several samples and localized clusters', () => {
    const red: [number, number, number, number] = [255, 0, 0, 255];
    const blue: [number, number, number, number] = [0, 0, 255, 255];
    const green: [number, number, number, number] = [0, 255, 0, 255];
    const px = img(4, 1, (x) => [red, blue, green, red][x]);
    expect(Array.from(colorRange(px, [{ color: '#ff0000' }, { color: [0, 0, 255] }], { fuzziness: 10 }).data)).toEqual([255, 255, 0, 255]);
    // Localized at x = 0 with a 2 px range: the far red pixel drops out.
    expect(Array.from(colorRange(px, [{ color: '#ff0000', at: { x: 0, y: 0 } }], { fuzziness: 10, localized: 2 }).data)).toEqual([255, 0, 0, 0]);
    const reds = img(4, 1, () => red);
    expect(Array.from(colorRange(reds, [{ color: '#ff0000', at: { x: 0, y: 0 } }], { fuzziness: 10, localized: 2 }).data)).toEqual([255, 128, 0, 0]);
    expect(count(colorRange(px, []))).toBe(0);
    expect(() => colorRange(px, [{ color: 'nope' }])).toThrow(/Invalid colour/);
  });

  it('tonal ranges and hue families', () => {
    const g = (v: number): [number, number, number, number] => [v, v, v, 255];
    const px = img(6, 1, (x) => g([0, 60, 75, 128, 200, 255][x]));
    const near = (m: SelectionMask, want: number[]) => Array.from(m.data).every((v, i) => Math.abs(v - want[i] * 255) <= 1);
    expect(near(toneRange(px, 'shadows'), [1, 1, 0.5, 0, 0, 0])).toBe(true);
    expect(near(toneRange(px, 'highlights'), [0, 0, 0, 0, 1, 1])).toBe(true);
    expect(near(toneRange(px, 'midtones'), [0, 0, 0, 1, 0, 0])).toBe(true);
    const colours = img(5, 1, (x) => [[255, 0, 0, 255], [255, 128, 0, 255], [128, 128, 128, 255], [0, 0, 255, 255], [255, 0, 0, 0]][x] as [number, number, number, number]);
    const reds = hueRange(colours, 0);
    expect(reds.data[0]).toBe(255);
    expect(Math.abs(reds.data[1] - 127)).toBeLessThanOrEqual(2);
    expect(reds.data[2]).toBe(0);
    expect(reds.data[3]).toBe(0);
    expect(reds.data[4]).toBe(0);
    expect(hueRange(colours, 240).data[3]).toBe(255);
  });
});

// ---------------------------------------------------------------------------
// Modes, shapes, serialisation
// ---------------------------------------------------------------------------

describe('selection modes', () => {
  const mk = (bytes: number[]) => createSelectionMask(bytes.length, 1, Uint8Array.from(bytes));

  it('combine replace / add / subtract / intersect (photocraft combine_modes)', () => {
    const old = mk([255, 255, 0, 0]);
    const next = mk([0, 255, 255, 0]);
    expect(Array.from(combineSelections(old, next, 'replace')!.data)).toEqual([0, 255, 255, 0]);
    expect(Array.from(combineSelections(old, next, 'add')!.data)).toEqual([255, 255, 255, 0]);
    expect(Array.from(combineSelections(old, next, 'subtract')!.data)).toEqual([255, 0, 0, 0]);
    expect(Array.from(combineSelections(old, next, 'intersect')!.data)).toEqual([0, 255, 0, 0]);
    expect(combineSelections(old, mk([255, 255, 255, 255]), 'subtract')).toBeNull();
    expect(combineSelections(null, next, 'subtract')).toBeNull();
    expect(combineSelections(null, next, 'intersect')).toBeNull();
    expect(combineSelections(null, next, 'add')).toBe(next);
    expect(parseSelectionMode('add')).toBe('add');
    expect(parseSelectionMode('bogus')).toBe('replace');
  });

  it('obeys the algebra of max / min on random soft masks', () => {
    const r = rng(7);
    const rand = () => mk(Array.from({ length: 64 }, () => (r() < 0.3 ? 0 : Math.floor(r() * 256))));
    for (let t = 0; t < 20; t++) {
      const a = rand();
      const b = rand();
      const c = rand();
      const add = (x: SelectionMask, y: SelectionMask) => combineSelections(x, y, 'add')!;
      const inter = (x: SelectionMask, y: SelectionMask) => combineSelections(x, y, 'intersect') ?? mk(new Array(64).fill(0));
      expect(add(a, b).data).toEqual(add(b, a).data);
      expect(inter(a, b).data).toEqual(inter(b, a).data);
      expect(add(add(a, b), c).data).toEqual(add(a, add(b, c)).data);
      expect(inter(a, a).data).toEqual(a.data);
      expect(add(a, a).data).toEqual(a.data);
      // Absorption: a ∪ (a ∩ b) = a.
      expect(add(a, inter(a, b)).data).toEqual(a.data);
      // Subtracting a selection from itself leaves nothing.
      expect(combineSelections(a, a, 'subtract')).toBeNull();
      // Invert twice is the identity; a − b = a ∩ ¬b for hard masks.
      expect(invertSelection(invertSelection(a)).data).toEqual(a.data);
    }
    const ha = mk([255, 255, 0, 0, 255]);
    const hb = mk([0, 255, 255, 0, 255]);
    expect(combineSelections(ha, hb, 'subtract')!.data).toEqual(combineSelections(ha, invertSelection(hb), 'intersect')!.data);
  });

  it('modifier keys pick the mode like Photoshop', () => {
    expect(selectionModeFromModifiers({}, 'replace')).toBe('replace');
    expect(selectionModeFromModifiers({ shiftKey: true }, 'replace')).toBe('add');
    expect(selectionModeFromModifiers({ altKey: true }, 'add')).toBe('subtract');
    expect(selectionModeFromModifiers({ shiftKey: true, altKey: true }, 'replace')).toBe('intersect');
  });
});

describe('selection shapes', () => {
  it('polygon area and anti-aliasing (photocraft polygon_area_and_aa)', () => {
    const sq = polygonCoverage([{ x: 2, y: 2 }, { x: 12, y: 2 }, { x: 12, y: 12 }, { x: 2, y: 12 }], 20, 20, true);
    expect(Math.abs(sq.reduce((a, b) => a + b, 0) - 100)).toBeLessThan(1e-3);
    const tri = polygonCoverage([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], 20, 20, true);
    expect(Math.abs(tri.reduce((a, b) => a + b, 0) - 50)).toBeLessThan(1);
    expect(tri.some((v) => v > 0 && v < 1)).toBe(true);
    const hard = polygonCoverage([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], 20, 20, false);
    expect(hard.every((v) => v === 0 || v === 1)).toBe(true);
    expect(polygonCoverage([{ x: 0, y: 0 }, { x: 1, y: 1 }], 20, 20).every((v) => v === 0)).toBe(true);
  });

  it('rect with fractional edges and ellipse area', () => {
    const r = rectSelection(10, 10, { x: 2.5, y: 2, width: 4, height: 3 });
    expect(r.bounds).toEqual({ x: 2, y: 2, width: 5, height: 3 });
    expect(at(r, 2, 2)).toBe(128);
    expect(at(r, 3, 2)).toBe(255);
    // Negative sizes are normalised.
    expect(rectSelection(10, 10, { x: 6, y: 5, width: -4, height: -3 }).bounds).toEqual({ x: 2, y: 2, width: 4, height: 3 });
    const e = ellipseSelection(100, 80, { x: 10, y: 10, width: 60, height: 40 });
    expect(Math.abs(selectionArea(e) - Math.PI * 30 * 20) / (Math.PI * 30 * 20)).toBeLessThan(0.005);
  });
});

describe('selection serialisation', () => {
  it('RLE round-trips hard, soft, empty and full masks', () => {
    const r = rng(3);
    const masks = [
      createSelectionMask(17, 9),
      fullSelection(300, 200),
      createSelectionMask(64, 64, Uint8Array.from({ length: 4096 }, () => Math.floor(r() * 256))),
      ellipseSelection(257, 129, { x: 20, y: 10, width: 200, height: 100 }),
    ];
    for (const m of masks) {
      const s = serializeSelection(m);
      expect(s.rle.startsWith('r1:')).toBe(true);
      const back = deserializeSelection(JSON.parse(JSON.stringify(s)));
      expect(back.width).toBe(m.width);
      expect(back.data).toEqual(m.data);
      expect(back.bounds).toEqual(m.bounds);
    }
    // Long runs use few bytes.
    expect(encodeSelectionRle(fullSelection(1000, 1000).data).length).toBeLessThan(20);
  });

  it('rejects damaged data', () => {
    const s = serializeSelection(rectSelection(10, 10, { x: 1, y: 1, width: 3, height: 3 }));
    expect(() => decodeSelectionRle(s.rle, 99)).toThrow();
    expect(() => decodeSelectionRle('x' + s.rle, 100)).toThrow();
    expect(() => decodeSelectionRle('r1:@@@@', 100)).toThrow();
    expect(() => deserializeSelection({ ...s, width: -1 })).toThrow();
    expect(() => deserializeSelection(null)).toThrow();
  });

  it('pixels in and out, resize, outline and quick mask', () => {
    const px = img(4, 2, (x) => [x * 85, x * 85, x * 85, 255]);
    const m = selectionFromPixels(px);
    expect(Array.from(m.data.slice(0, 4))).toEqual([0, 85, 170, 255]);
    expect(Array.from(selectionFromPixels(px, { invert: true, threshold: 128 }).data.slice(0, 4))).toEqual([255, 255, 0, 0]);
    const big = resizeSelection(rectSelection(10, 10, { x: 0, y: 0, width: 5, height: 10 }, { antiAlias: false }), 20, 20);
    expect(at(big, 4, 5)).toBe(255);
    expect(at(big, 15, 5)).toBe(0);
    // A 3×2 block has a 10-unit perimeter in 4 merged segments.
    const block = rectSelection(8, 8, { x: 2, y: 3, width: 3, height: 2 });
    const segs = selectionOutline(block);
    expect(segs.length / 4).toBe(4);
    let perim = 0;
    for (let i = 0; i < segs.length; i += 4) perim += Math.abs(segs[i + 2] - segs[i]) + Math.abs(segs[i + 3] - segs[i + 1]);
    expect(perim).toBe(10);
    const q = quickMaskPixels(block);
    expect(q[(3 * 8 + 2) * 4 + 3]).toBe(0);
    expect(q[3]).toBe(128);
    expect(describeSelection(null)).toBe('No selection');
    expect(describeSelection(block)).toBe('3 × 2 px selected (9.4% of the image)');
  });
});

// ---------------------------------------------------------------------------
// Modify
// ---------------------------------------------------------------------------

describe('selection modify', () => {
  it('distance transform matches brute force', () => {
    const r = rng(11);
    for (const [w, h, density] of [[23, 17, 0.05], [40, 9, 0.3], [5, 31, 0.01]] as const) {
      const inside = Uint8Array.from({ length: w * h }, () => (r() < density ? 1 : 0));
      inside[0] = 1;
      const d = distanceTransform(inside, w, h);
      for (let i = 0; i < w * h; i++) {
        let best = Infinity;
        for (let j = 0; j < w * h; j++) {
          if (!inside[j]) continue;
          best = Math.min(best, Math.hypot((i % w) - (j % w), Math.floor(i / w) - Math.floor(j / w)));
        }
        expect(Math.abs(d[i] - best)).toBeLessThan(1e-4);
      }
    }
    expect(distanceTransform(new Uint8Array(4), 2, 2)[0]).toBe(1e10);
  });

  it('expand, contract and border (photocraft expand_contract_border)', () => {
    const m = square(20, 20);
    const e = expandCoverage(m, 20, 20, 2);
    expect(e[10 * 20 + 3]).toBe(1);
    expect(e[10 * 20 + 2]).toBe(0);
    const c = contractCoverage(m, 20, 20, 2);
    expect(c[10 * 20 + 6]).toBe(0);
    expect(c[10 * 20 + 7]).toBe(1);
    const b = borderCoverage(m, 20, 20, 4);
    expect(b[10 * 20 + 10]).toBe(0);
    expect(b[10 * 20 + 5]).toBeGreaterThan(0.5);
    expect(b[10 * 20 + 4]).toBeGreaterThan(0.5);
  });

  it('border matches Photoshop', () => {
    const w = 64;
    const m = square(w, w, 16, 48);
    const b = borderCoverage(m, w, w, 4);
    const v = (x: number, y: number) => Math.round(b[y * w + x] * 255);
    const row = Array.from({ length: 17 }, (_, i) => v(8 + i, 32));
    const want = [0, 0, 0, 0, 63, 127, 191, 255, 255, 191, 127, 63, 0, 0, 0, 0, 0];
    row.forEach((g, i) => expect(Math.abs(g - want[i])).toBeLessThanOrEqual(1));
    const diag = Array.from({ length: 9 }, (_, i) => v(16 + i, 16 + i));
    [255, 191, 127, 63, 0, 0, 0, 0, 0].forEach((wv, i) => expect(Math.abs(diag[i] - wv)).toBeLessThanOrEqual(1));
  });

  it('smooth removes specks, feather softens without losing coverage', () => {
    const m = square(20, 20);
    m[2 * 20 + 2] = 1;
    const s = smoothCoverage(m, 20, 20, 1);
    expect(s[2 * 20 + 2]).toBe(0);
    expect(s[10 * 20 + 10]).toBe(1);
    const f = featherCoverage(square(20, 20), 20, 20, 2);
    expect(f[10 * 20 + 5]).toBeGreaterThan(0.3);
    expect(f[10 * 20 + 5]).toBeLessThan(0.8);
    expect(Math.abs(f.reduce((a, b) => a + b, 0) - 100)).toBeLessThan(1);
  });

  it('feather and smooth match Photoshop', () => {
    const w = 64;
    const m = square(w, w, 16, 48);
    const f = featherCoverage(m, w, w, 4);
    const ROW = [7, 13, 22, 34, 50, 70, 92, 115, 140, 163, 185, 205, 221, 233, 242, 248, 252];
    ROW.forEach((want, i) => expect(Math.abs(Math.round(f[32 * w + 8 + i] * 255) - want)).toBeLessThanOrEqual(3));
    const s = smoothCoverage(m, w, w, 8);
    expect(Array.from({ length: 17 }, (_, i) => s[32 * w + 8 + i])).toEqual(Array.from({ length: 17 }, (_, i) => (8 + i >= 16 ? 1 : 0)));
    expect(Array.from({ length: 9 }, (_, i) => s[(16 + i) * w + 16 + i])).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1]);
  });

  it('feather matches a direct Gaussian (exactly up to σ 8, box approximation beyond)', () => {
    const r = rng(5);
    for (const [w, h] of [[97, 61], [13, 7]] as const) {
      const soft = Float32Array.from({ length: w * h }, () => r());
      const rect = square(w, h, Math.floor(w / 3), Math.floor((h * 3) / 4));
      for (const m of [soft, rect]) {
        for (const sigma of [0.3, 1, 2.5, 8]) expect(maxDiff(featherCoverage(m, w, h, sigma), directFeather(m, w, h, sigma))).toBeLessThanOrEqual(1 / 255);
        for (const sigma of [12, 25]) expect(maxDiff(featherCoverage(m, w, h, sigma), directFeather(m, w, h, sigma))).toBeLessThan(0.03);
      }
    }
  });

  it('modifySelection wraps the ops on 8-bit masks', () => {
    const sel = selectionFromCoverage(20, 20, square(20, 20));
    expect(modifySelection(sel, 'grow', 2).bounds).toEqual({ x: 3, y: 3, width: 14, height: 14 });
    expect(modifySelection(sel, 'shrink', 2).bounds).toEqual({ x: 7, y: 7, width: 6, height: 6 });
    expect(modifySelection(sel, 'grow', 0)).toBe(sel);
    expect(modifySelection(sel, 'feather', 2).bounds!.width).toBeGreaterThan(10);
    expect(() => modifySelection(sel, 'nope' as never, 1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Refine edge
// ---------------------------------------------------------------------------

/** An 80×20 image whose edge at x = 40 is blurred with σ, and its true coverage. */
function blurredEdge(w: number, h: number, sigma: number) {
  const step = Float32Array.from({ length: w }, (_, x) => (x < 40 ? 1 : 0));
  const truth = featherCoverage(step, w, 1, 0); // placeholder copy
  // 1-D Gaussian of the step (edges replicated).
  const r = Math.ceil(sigma * 3);
  for (let x = 0; x < w; x++) {
    let a = 0;
    let s = 0;
    for (let i = -r; i <= r; i++) {
      const k = Math.exp(-(i * i) / (2 * sigma * sigma));
      a += step[Math.min(w - 1, Math.max(0, x + i))] * k;
      s += k;
    }
    truth[x] = a / s;
  }
  const a = [0.9, 0.8, 0.2];
  const b = [0.1, 0.2, 0.6];
  const planes: [Float32Array, Float32Array, Float32Array] = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) planes[c][y * w + x] = a[c] * truth[x] + b[c] * (1 - truth[x]);
  return { planes, truth };
}

describe('refine edge', () => {
  it('box mean matches a naive window average', () => {
    const r = rng(9);
    const src = Float32Array.from({ length: 13 * 7 }, () => r());
    const out = boxMean(src, 13, 7, 2);
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 13; x++) {
        let s = 0;
        let n = 0;
        for (let yy = Math.max(0, y - 2); yy <= Math.min(6, y + 2); yy++)
          for (let xx = Math.max(0, x - 2); xx <= Math.min(12, x + 2); xx++) {
            s += src[yy * 13 + xx];
            n++;
          }
        expect(Math.abs(out[y * 13 + x] - s / n)).toBeLessThan(1e-5);
      }
  });

  it('guided filter reproduces a mask that is a linear function of the guide', () => {
    const w = 30;
    const h = 10;
    const g: [Float32Array, Float32Array, Float32Array] = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
    const p = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const t = (i % w) / (w - 1);
      g[0][i] = t;
      g[1][i] = 0.5;
      g[2][i] = 1 - t;
      p[i] = 0.2 + 0.6 * t;
    }
    expect(maxDiff(guidedFilterColor(g, p, w, h, 3, 1e-6), p)).toBeLessThan(0.01);
  });

  it('guided filter matting softens a blurred edge (photocraft)', () => {
    const w = 80;
    const h = 20;
    const { planes, truth } = blurredEdge(w, h, 3);
    const m = Float32Array.from({ length: w * h }, (_, i) => (i % w < 40 ? 1 : 0));
    const a = refineCoverage(planes, m, w, h, { radius: 10 });
    const row = a.subarray(10 * w, 11 * w);
    expect(Array.from(row).filter((v) => v > 0.05 && v < 0.95).length).toBeGreaterThanOrEqual(6);
    for (let x = 0; x < w; x++) {
      expect(Math.abs(row[x] - truth[x])).toBeLessThan(0.12);
      if (x > 0) expect(row[x]).toBeLessThanOrEqual(row[x - 1] + 0.02);
    }
    // Outside the band the mask is untouched.
    expect(row[5]).toBe(1);
    expect(row[75]).toBe(0);
    // Smart radius keeps a sharp edge sharp.
    const sharp: [Float32Array, Float32Array, Float32Array] = [0, 1, 2].map((c) =>
      Float32Array.from({ length: w * h }, (_, i) => (i % w < 40 ? [0.9, 0.8, 0.2][c] : [0.1, 0.2, 0.6][c]))
    ) as never;
    const s = refineCoverage(sharp, m, w, h, { radius: 10, smartRadius: true });
    expect(Array.from(s.subarray(10 * w, 11 * w)).filter((v) => v > 0.05 && v < 0.95).length).toBeLessThanOrEqual(2);
  });

  it('feather, contrast and shift edge (photocraft)', () => {
    const w = 60;
    const h = 10;
    const m = Float32Array.from({ length: w * h }, (_, i) => (i % w < 30 ? 1 : 0));
    const f = refineCoverage(null, m, w, h, { feather: 6 });
    expect(f[5 * w + 29]).toBeGreaterThan(0.5);
    expect(f[5 * w + 29]).toBeLessThan(0.8);
    expect(f[5 * w + 31]).toBeGreaterThan(0.1);
    const c = refineCoverage(null, f, w, h, { contrast: 100 });
    expect(c[5 * w + 29]).toBe(1);
    expect(c[5 * w + 31]).toBe(0);
    const grown = refineCoverage(null, m, w, h, { shiftEdge: 100 });
    expect(grown[5 * w + 33]).toBe(1);
    expect(grown[5 * w + 34]).toBe(0);
    const shrunk = refineCoverage(null, m, w, h, { shiftEdge: -50 });
    expect(shrunk[5 * w + 27]).toBe(1);
    expect(shrunk[5 * w + 28]).toBe(0);
    const half = refineCoverage(null, m, w, h, { shiftEdge: 12.5 });
    const one = refineCoverage(null, m, w, h, { shiftEdge: 25 });
    expect(Math.abs(half[5 * w + 30] - 0.5)).toBeLessThan(0.02);
    expect(one[5 * w + 30]).toBe(1);
    expect(half[5 * w + 31]).toBe(0);
    const pulled = refineCoverage(null, m, w, h, { shiftEdge: -12.5 });
    expect(Math.abs(pulled[5 * w + 29] - 0.5)).toBeLessThan(0.02);
    const sm = refineCoverage(null, m, w, h, { smooth: 50 });
    expect(sm[5 * w + 10]).toBe(1);
    expect(sm[5 * w + 50]).toBe(0);
  });

  it('moves a misaligned coarse mask toward the image edge', () => {
    // A disc of radius 30 on a textured background; the "AI" mask is the disc shifted 4 px right
    // and blocky (8 px cells), as a low-resolution segmentation would be.
    const w = 120;
    const h = 100;
    const cx = 60;
    const cy = 50;
    const r = rng(21);
    const px = img(w, h, (x, y) => {
      const inDisc = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= 30;
      const n = Math.floor(r() * 20);
      return inDisc ? [200 + n / 2, 60 + n, 40, 255] : [30 + n, 90 + n, 160, 255];
    });
    const truth = (x: number, y: number) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= 30;
    const coarse = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const bx = Math.floor(x / 8) * 8 + 4;
        const by = Math.floor(y / 8) * 8 + 4;
        coarse[y * w + x] = Math.hypot(bx - 4 - cx, by - cy) <= 30 ? 255 : 0;
      }
    const mask = createSelectionMask(w, h, coarse);
    const errors = (m: SelectionMask) => {
      let e = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e += Math.abs(m.data[y * w + x] / 255 - (truth(x, y) ? 1 : 0));
      return e;
    };
    const refined = refineSelection(px, mask, { radius: 8, contrast: 30 });
    expect(errors(refined)).toBeLessThan(errors(mask) * 0.5);
    // Along the row through the centre, the 0.5 crossing on the right moves toward x = 90.
    const crossing = (m: SelectionMask) => {
      for (let x = w - 1; x >= 0; x--) if (m.data[cy * w + x] >= 128) return x + 1;
      return 0;
    };
    expect(Math.abs(crossing(refined) - 90)).toBeLessThan(Math.abs(crossing(mask) - 90));
  });

  it('works in a window around the mask and leaves far pixels alone', () => {
    const w = 200;
    const h = 150;
    const px = img(w, h, (x) => (x < 100 ? [220, 220, 220, 255] : [20, 20, 20, 255]));
    const sel = rectSelection(w, h, { x: 60, y: 40, width: 37, height: 30 }, { antiAlias: false });
    const windowed = refineSelection(px, sel, { radius: 6 });
    // Same as refining the full buffer.
    const full = refineCoverage(
      [0, 1, 2].map((c) => Float32Array.from({ length: w * h }, (_, i) => (px.data as Uint8ClampedArray)[i * 4 + c] / 255)) as never,
      Float32Array.from(sel.data, (v) => v / 255),
      w,
      h,
      { radius: 6 }
    );
    expect(maxDiff(Array.from(windowed.data, (v) => v / 255), full)).toBeLessThanOrEqual(2 / 255);
    expect(refineSelection(px, createSelectionMask(w, h), { radius: 6 }).bounds).toBeNull();
    expect(() => refineSelection(img(3, 3, () => [0, 0, 0, 255]), sel, { radius: 2 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Performance: growth ratios only
// ---------------------------------------------------------------------------

/**
 * Ratio of the cost of `large` to `small`. Each is repeated until one sample takes ≥ 15 ms, and
 * the two are measured alternately (so load spikes hit both), keeping the best of 7 samples.
 */
/** Growth from `small` to `large` (see helpers/growth), retried while at or above `limit`. */
const growthRatio = (small: () => void, large: () => void, limit = 30) => measureGrowth(small, large, { limit, runs: 7 });

describe('selection performance scales linearly', () => {
  // 9× the pixels: linear is ~9, quadratic would be ~81.
  const checker = (n: number) => img(n, n, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? [250, 250, 250, 255] : [255, 255, 255, 255]));
  const disc = (n: number) => ellipseSelection(n, n, { x: n / 8, y: n / 8, width: (n * 3) / 4, height: (n * 3) / 4 });
  const small = checker(200);
  const large = checker(600);
  const ds = disc(200);
  const dl = disc(600);

  it('magic wand (contiguous span fill) grows linearly', { timeout: 120_000 }, () => {
    const ratio = growthRatio(
      () => magicWand(small, { x: 1, y: 1 }, { tolerance: 8 }),
      () => magicWand(large, { x: 1, y: 1 }, { tolerance: 8 })
    );
    expect(ratio).toBeLessThan(30);
  });

  it('grow (distance transform) and feather grow linearly', { timeout: 120_000 }, () => {
    expect(growthRatio(() => modifySelection(ds, 'grow', 10), () => modifySelection(dl, 'grow', 10))).toBeLessThan(30);
    expect(growthRatio(() => modifySelection(ds, 'feather', 12), () => modifySelection(dl, 'feather', 12))).toBeLessThan(30);
  });

  it('refine edge grows linearly', { timeout: 120_000 }, () => {
    const ratio = growthRatio(
      () => refineSelection(small, ds, { radius: 8, smooth: 20 }),
      () => refineSelection(large, dl, { radius: 8, smooth: 20 })
    );
    expect(ratio).toBeLessThan(30);
  });

  it('a wide feather costs about the same as a narrow one', { timeout: 60_000 }, () => {
    const sel = disc(400);
    // Three box passes per line: the cost is O(pixels + radius × lines), not O(pixels × radius).
    expect(growthRatio(() => modifySelection(sel, 'feather', 10), () => modifySelection(sel, 'feather', 80), 6)).toBeLessThan(6);
  });
});
