/**
 * Where a selection is unsure of itself (a trimap's unknown band): the stretches of its edge that
 * run where the image shows no edge, widened into a band. The smart selection tools report these
 * as `uncertainRegions`, so an agent looks at and refines only them (`refine_selection` `regions`).
 */

import type { CropBox } from '../types';
import { createSelectionMask, type PixelBuffer, type SelectionMask } from './mask';
import { createGradientSampler } from './inspect';

export interface UncertainRegion {
  bounds: CropBox;
  /** Pixels in the unknown band. */
  area: number;
  /** 0–1: how strongly the image backs the edge here (low = unsure). */
  confidence: number;
}

export interface SelectionUncertainty {
  /** The unknown band over the canvas (255 = unsure). */
  unknown: SelectionMask;
  /** The least confident regions first (at most `maxRegions`). */
  regions: UncertainRegion[];
  /** How many regions there are in all. */
  count: number;
  /** 0–1 over the whole edge. */
  confidence: number;
}

export interface SelectionUncertaintyOptions {
  /** Half-width of the unknown band in px (default 1/200 of the shorter side, at least 2). */
  band?: number;
  /** Regions smaller than this many pixels are left out (default 16). */
  minArea?: number;
  /** At most this many regions are listed (default 20). */
  maxRegions?: number;
}

/** Image edge strength (0–1 of a full step) at which an edge counts as fully backed. */
const BACKED = 0.2;

/**
 * The unknown band of `mask` against `image` (RGBA, straight alpha, at `image.x`, `image.y` in
 * document pixels). An empty selection has no band.
 */
export function selectionUncertainty(mask: SelectionMask, image: PixelBuffer & { x: number; y: number }, options: SelectionUncertaintyOptions = {}): SelectionUncertainty {
  const W = mask.width;
  const H = mask.height;
  const empty = (): SelectionUncertainty => ({ unknown: createSelectionMask(W, H), regions: [], count: 0, confidence: 1 });
  const b = mask.bounds;
  if (!b) return empty();
  const band = Math.max(1, Math.round(options.band ?? Math.max(2, Math.min(W, H) / 200)));
  const minArea = Math.max(1, options.minArea ?? 16);
  const maxRegions = Math.max(1, options.maxRegions ?? 20);
  const a = mask.data;
  const gradient = createGradientSampler(image, W);
  // Work in the bounds plus the band.
  const x0 = Math.max(0, b.x - band - 1);
  const y0 = Math.max(0, b.y - band - 1);
  const x1 = Math.min(W, b.x + b.width + band + 1);
  const y1 = Math.min(H, b.y + b.height + band + 1);
  const w = x1 - x0;
  const h = y1 - y0;
  // Evidence at edge pixels (both sides of the half-coverage line); NaN elsewhere.
  const evidence = new Float32Array(w * h).fill(NaN);
  const seeds = new Uint8Array(w * h);
  let sum = 0;
  let n = 0;
  const on = (x: number, y: number) => a[y * W + x] >= 128;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = on(x, y);
      const differs = (nx: number, ny: number) => nx >= 0 && ny >= 0 && nx < W && ny < H && on(nx, ny) !== v;
      if (!(differs(x - 1, y) || differs(x + 1, y) || differs(x, y - 1) || differs(x, y + 1))) continue;
      let g = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H) g = Math.max(g, gradient(nx, ny));
        }
      }
      const e = Math.min(1, g / BACKED);
      const k = (y - y0) * w + (x - x0);
      evidence[k] = e;
      sum += e;
      n++;
      if (e < 0.5) seeds[k] = 1;
    }
  }
  if (!n) return empty();
  // The unknown band: the weak edge pixels grown by `band` (a square, rows then columns).
  const rows = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    for (let x = 0; x < w; x++) {
      if (seeds[y * w + x]) last = x;
      if (x - last <= band) rows[y * w + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (seeds[y * w + x]) last = x;
      if (last - x <= band) rows[y * w + x] = 1;
    }
  }
  const grown = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (rows[y * w + x]) last = y;
      if (y - last <= band) grown[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (rows[y * w + x]) last = y;
      if (last - y <= band) grown[y * w + x] = 1;
    }
  }
  // Regions: 8-connected pieces of the band, scored by the evidence along the edge inside them.
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const found: Array<{ area: number; e: number; en: number; bx0: number; by0: number; bx1: number; by1: number }> = [];
  for (let start = 0; start < w * h; start++) {
    if (!grown[start] || label[start]) continue;
    const r = { area: 0, e: 0, en: 0, bx0: w, by0: h, bx1: -1, by1: -1 };
    const id = found.length + 1;
    let top = 0;
    stack[top++] = start;
    label[start] = id;
    while (top) {
      const k = stack[--top];
      const i = k % w;
      const j = (k - i) / w;
      r.area++;
      if (!Number.isNaN(evidence[k])) {
        r.e += evidence[k];
        r.en++;
      }
      if (i < r.bx0) r.bx0 = i;
      if (i > r.bx1) r.bx1 = i;
      if (j < r.by0) r.by0 = j;
      if (j > r.by1) r.by1 = j;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = i + dx;
          const nj = j + dy;
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          const nk = nj * w + ni;
          if (!grown[nk] || label[nk]) continue;
          label[nk] = id;
          stack[top++] = nk;
        }
      }
    }
    found.push(r);
  }
  const unknownData = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = label[y * w + x];
      if (id && found[id - 1].area >= minArea) unknownData[(y + y0) * W + x + x0] = 255;
    }
  }
  const kept = found
    .filter((r) => r.area >= minArea)
    .map((r) => ({
      bounds: { x: x0 + r.bx0, y: y0 + r.by0, width: r.bx1 - r.bx0 + 1, height: r.by1 - r.by0 + 1 },
      area: r.area,
      confidence: Math.round((r.en ? r.e / r.en : 0) * 1000) / 1000,
    }))
    .sort((p, q) => p.confidence - q.confidence || q.area - p.area);
  return {
    unknown: createSelectionMask(W, H, unknownData),
    regions: kept.slice(0, maxRegions),
    count: kept.length,
    confidence: Math.round((sum / n) * 1000) / 1000,
  };
}
