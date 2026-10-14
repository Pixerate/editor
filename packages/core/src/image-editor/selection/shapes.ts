// Portions ported from photocraft/crates/algo/src/selection.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import type { CropBox, ImagePoint } from '../types';
import { createSelectionMask, coverageToByte, type SelectionMask } from './mask';

export interface ShapeSelectionOptions {
  /** Partial coverage along the edge (default true). */
  antiAlias?: boolean;
}

interface Edge {
  top: number;
  bottom: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/**
 * Even-odd polygon coverage over a `width × height` image: exact horizontal coverage on 4
 * sub-rows per pixel row (1 without anti-aliasing, where a pixel is in when its centre is).
 * Each sub-row only tests the edges that cross it (an active edge list over edges sorted by
 * their top), so the cost is about pixels + edges × rows they span.
 */
export function polygonCoverage(
  points: readonly ImagePoint[],
  width: number,
  height: number,
  antiAlias = true
): Float32Array {
  const m = new Float32Array(width * height);
  if (points.length < 3 || width <= 0 || height <= 0) return m;
  const sub = antiAlias ? 4 : 1;
  const edges: Edge[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
    if (a.y < b.y) edges.push({ top: a.y, bottom: b.y, ax: a.x, ay: a.y, bx: b.x, by: b.y });
    else if (b.y < a.y) edges.push({ top: b.y, bottom: a.y, ax: a.x, ay: a.y, bx: b.x, by: b.y });
  }
  edges.sort((p, q) => p.top - q.top);
  let next = 0;
  let active: Edge[] = [];
  const xs: number[] = [];
  for (let py = 0; py < height; py++) {
    const row = py * width;
    for (let s = 0; s < sub; s++) {
      const y = py + (s + 0.5) / sub;
      while (next < edges.length && edges[next].top <= y) active.push(edges[next++]);
      if (active.length) active = active.filter((e) => e.bottom > y);
      if (!active.length) continue;
      xs.length = 0;
      for (const e of active) {
        if (e.top <= y) xs.push(e.ax + ((y - e.ay) / (e.by - e.ay)) * (e.bx - e.ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, xs[k]);
        const x1 = Math.min(width, xs[k + 1]);
        if (x1 <= x0) continue;
        const c0 = Math.floor(x0);
        const c1 = Math.min(width, Math.ceil(x1));
        for (let cx = c0; cx < c1; cx++) {
          let cov: number;
          if (antiAlias) cov = Math.min(cx + 1, x1) - Math.max(cx, x0);
          else {
            const c = cx + 0.5;
            cov = c >= x0 && c < x1 ? 1 : 0;
          }
          if (cov > 0) m[row + cx] += cov / sub;
        }
      }
    }
  }
  for (let i = 0; i < m.length; i++) if (m[i] > 1) m[i] = 1;
  return m;
}

function toMask(width: number, height: number, coverage: Float32Array): SelectionMask {
  const out = new Uint8Array(coverage.length);
  for (let i = 0; i < out.length; i++) out[i] = coverageToByte(coverage[i]);
  return createSelectionMask(width, height, out);
}

/** Lasso / polygonal lasso: an even-odd polygon in natural image pixels. */
export function polygonSelection(
  width: number,
  height: number,
  points: readonly ImagePoint[],
  options: ShapeSelectionOptions = {}
): SelectionMask {
  return toMask(width, height, polygonCoverage(points, width, height, options.antiAlias ?? true));
}

/** Normalises a rectangle with a negative width or height. */
export function normalizeRect(rect: CropBox): CropBox {
  const x = rect.width < 0 ? rect.x + rect.width : rect.x;
  const y = rect.height < 0 ? rect.y + rect.height : rect.y;
  return { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) };
}

/** Rectangular marquee. Fractional edges get partial coverage when anti-aliased. */
export function rectSelection(width: number, height: number, rect: CropBox, options: ShapeSelectionOptions = {}): SelectionMask {
  const r = normalizeRect(rect);
  const pts = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
  return polygonSelection(width, height, pts, options);
}

/** The ellipse inscribed in `rect` as a polygon fine enough that its chords stay within 0.05 px. */
export function ellipsePoints(rect: CropBox): ImagePoint[] {
  const r = normalizeRect(rect);
  const rx = r.width / 2;
  const ry = r.height / 2;
  const cx = r.x + rx;
  const cy = r.y + ry;
  const rmax = Math.max(rx, ry, 0.5);
  // Sagitta of a chord with angle step θ is r(1 − cos(θ/2)) ≈ rθ²/8 ≤ 0.05.
  const step = Math.sqrt(0.4 / rmax);
  const n = Math.min(4096, Math.max(16, Math.ceil((2 * Math.PI) / step)));
  const pts: ImagePoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * 2 * Math.PI;
    pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return pts;
}

/** Elliptical marquee inscribed in `rect`. */
export function ellipseSelection(width: number, height: number, rect: CropBox, options: ShapeSelectionOptions = {}): SelectionMask {
  return polygonSelection(width, height, ellipsePoints(rect), options);
}
