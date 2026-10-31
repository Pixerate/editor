/**
 * What changed between two selections (`compare_selections`): the area added and removed, where,
 * and how much they overlap (IoU), so an agent can check that a modify or refine step did what it
 * meant to and a person can see it as a two-colour overlay.
 */

import type { CropBox } from '../types';
import { createSelectionMask, type SelectionMask } from './mask';

/** One piece of added or removed area. */
export interface SelectionDiffRegion {
  area: number;
  bounds: CropBox;
}

export interface SelectionDiffSide {
  /** Pixels at least half selected. */
  area: number;
  bounds: CropBox | null;
}

export interface SelectionDiff {
  a: SelectionDiffSide;
  b: SelectionDiffSide;
  /** Selected in b but not in a: area, and the largest pieces (at most `maxRegions`). */
  added: { area: number; count: number; regions: SelectionDiffRegion[] };
  /** Selected in a but not in b. */
  removed: { area: number; count: number; regions: SelectionDiffRegion[] };
  /** Intersection over union, 0–1 (1 when both are empty). */
  iou: number;
  /** Σ |coverage b − coverage a| in pixels: also counts edges that only softened or hardened. */
  coverageChange: number;
  /** Every pixel's coverage is the same. */
  identical: boolean;
}

export interface CompareSelectionsOptions {
  /** Pieces smaller than this many pixels are counted in the area but not listed (default 4). */
  minArea?: number;
  /** At most this many pieces are listed per side (default 10). */
  maxRegions?: number;
}

/**
 * Compares selection `a` (before) with `b` (after) over a `width × height` canvas; `null` is
 * nothing selected. Area, pieces and IoU are judged at half coverage. Also returns the added and
 * removed masks for an overlay.
 */
export function compareSelectionMasks(
  a: SelectionMask | null,
  b: SelectionMask | null,
  width: number,
  height: number,
  options: CompareSelectionsOptions = {}
): SelectionDiff & { addedMask: SelectionMask; removedMask: SelectionMask } {
  const minArea = Math.max(1, options.minArea ?? 4);
  const maxRegions = Math.max(1, options.maxRegions ?? 10);
  const n = width * height;
  const ad = a?.data;
  const bd = b?.data;
  const added = new Uint8Array(n);
  const removed = new Uint8Array(n);
  let areaA = 0;
  let areaB = 0;
  let inter = 0;
  let change = 0;
  let addedArea = 0;
  let removedArea = 0;
  for (let i = 0; i < n; i++) {
    const va = ad ? ad[i] : 0;
    const vb = bd ? bd[i] : 0;
    if (va !== vb) change += Math.abs(vb - va);
    const ia = va >= 128;
    const ib = vb >= 128;
    if (ia) areaA++;
    if (ib) areaB++;
    if (ia && ib) inter++;
    else if (ib) {
      added[i] = 255;
      addedArea++;
    } else if (ia) {
      removed[i] = 255;
      removedArea++;
    }
  }
  const union = areaA + areaB - inter;
  const addedMask = createSelectionMask(width, height, added);
  const removedMask = createSelectionMask(width, height, removed);
  return {
    a: { area: areaA, bounds: a?.bounds ?? null },
    b: { area: areaB, bounds: b?.bounds ?? null },
    added: { area: addedArea, ...pieces(added, width, height, addedMask.bounds, minArea, maxRegions) },
    removed: { area: removedArea, ...pieces(removed, width, height, removedMask.bounds, minArea, maxRegions) },
    iou: union ? Math.round((inter / union) * 10000) / 10000 : 1,
    coverageChange: Math.round(change / 255),
    identical: change === 0,
    addedMask,
    removedMask,
  };
}

/** 8-connected pieces of `bits` (255 = on) inside `bounds`, largest first. */
function pieces(bits: Uint8Array, W: number, H: number, bounds: CropBox | null, minArea: number, maxRegions: number): { count: number; regions: SelectionDiffRegion[] } {
  if (!bounds) return { count: 0, regions: [] };
  const { x: x0, y: y0, width: w, height: h } = bounds;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const found: SelectionDiffRegion[] = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !bits[(y0 + Math.floor(start / w)) * W + x0 + (start % w)]) continue;
    let area = 0;
    let bx0 = w;
    let by0 = h;
    let bx1 = -1;
    let by1 = -1;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const k = stack[--top];
      const i = k % w;
      const j = (k - i) / w;
      area++;
      if (i < bx0) bx0 = i;
      if (i > bx1) bx1 = i;
      if (j < by0) by0 = j;
      if (j > by1) by1 = j;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = i + dx;
          const nj = j + dy;
          if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
          const nk = nj * w + ni;
          if (seen[nk] || !bits[(y0 + nj) * W + x0 + ni]) continue;
          seen[nk] = 1;
          stack[top++] = nk;
        }
      }
    }
    if (area >= minArea) found.push({ area, bounds: { x: x0 + bx0, y: y0 + by0, width: bx1 - bx0 + 1, height: by1 - by0 + 1 } });
  }
  found.sort((p, q) => q.area - p.area);
  return { count: found.length, regions: found.slice(0, maxRegions) };
}

/**
 * The diff overlay's RGBA: added area tinted green, removed area red, the rest transparent
 * (`width × height`, the masks' size).
 */
export function selectionDiffPixels(added: SelectionMask, removed: SelectionMask): Uint8ClampedArray {
  const n = added.width * added.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    if (added.data[i]) out.set([34, 197, 94, 140], i * 4);
    else if (removed.data[i]) out.set([239, 68, 68, 140], i * 4);
  }
  return out;
}
