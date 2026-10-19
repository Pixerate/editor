/**
 * Anti-aliased coverage of filled Bézier paths over a pixel rectangle, without a canvas. The paths
 * are flattened to lines, then rasterized one of two ways:
 *
 * - `exact` (default): each line adds its signed area to a running-sum buffer (the accumulation
 *   rasterizer of font-rs, extended with clipping on every side). A pixel's coverage is the exact
 *   area of the path inside it as long as the path does not overlap itself; where it does, the fill
 *   rule is applied to the accumulated winding, which over-counts pixels that two overlapping
 *   parts' edges both cross.
 * - `sampled`: 16 sub-rows per pixel row, each with exact horizontal coverage of the spans the
 *   fill rule keeps, so overlapping parts (stroke outlines, a line's bar and arrowhead) count once.
 *   Edges are within 1/32 of a pixel vertically.
 *
 * Coordinates are document pixels; pixel (x, y) covers [x, x + 1) × [y, y + 1).
 */

import type { BezierPath } from '../../canvas/pathops/bezier';
import type { CropBox } from '../types';

export type CoverageFillRule = 'nonzero' | 'evenodd';

/** Maximum distance between a curve and the lines that replace it, in pixels. */
const FLATNESS = 0.01;

/** A path as polylines (closed implicitly), document pixels: `[x0, y0, x1, y1, …]` per contour. */
export type FlatPath = Float64Array[];

/** Flattens Bézier commands into closed polylines (every subpath is filled, so open ones close). */
export function flattenPath(path: BezierPath, tolerance = FLATNESS): FlatPath {
  const out: FlatPath = [];
  let pts: number[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const flush = () => {
    if (pts.length >= 6) out.push(Float64Array.from(pts));
    pts = [];
  };
  const steps = (dd: number, degree: number) => Math.max(1, Math.min(1024, Math.ceil(Math.sqrt((degree * (degree - 1) * dd) / (8 * tolerance)))));
  for (const c of path) {
    switch (c.type) {
      case 'M':
        flush();
        cx = sx = c.x;
        cy = sy = c.y;
        pts.push(cx, cy);
        break;
      case 'L':
        if (!pts.length) pts.push(cx, cy);
        cx = c.x;
        cy = c.y;
        pts.push(cx, cy);
        break;
      case 'Q': {
        if (!pts.length) pts.push(cx, cy);
        const n = steps(Math.hypot(cx - 2 * c.x1 + c.x, cy - 2 * c.y1 + c.y), 2);
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const u = 1 - t;
          pts.push(u * u * cx + 2 * u * t * c.x1 + t * t * c.x, u * u * cy + 2 * u * t * c.y1 + t * t * c.y);
        }
        cx = c.x;
        cy = c.y;
        break;
      }
      case 'C': {
        if (!pts.length) pts.push(cx, cy);
        const dd = Math.max(Math.hypot(cx - 2 * c.x1 + c.x2, cy - 2 * c.y1 + c.y2), Math.hypot(c.x1 - 2 * c.x2 + c.x, c.y1 - 2 * c.y2 + c.y));
        const n = steps(dd, 3);
        for (let k = 1; k <= n; k++) {
          const t = k / n;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const d = 3 * u * t * t;
          const e = t * t * t;
          pts.push(a * cx + b * c.x1 + d * c.x2 + e * c.x, a * cy + b * c.y1 + d * c.y2 + e * c.y);
        }
        cx = c.x;
        cy = c.y;
        break;
      }
      case 'Z':
        flush();
        cx = sx;
        cy = sy;
        break;
    }
  }
  flush();
  return out.filter((p) => p.every(Number.isFinite));
}

/** Bounds of flattened contours, or `null` when empty. */
export function flatBounds(flat: FlatPath): CropBox | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of flat) {
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
  }
  if (x0 === Infinity) return null;
  const x = Math.floor(x0);
  const y = Math.floor(y0);
  return { x, y, width: Math.ceil(x1) - x, height: Math.ceil(y1) - y };
}

/**
 * Adds one line's signed area to the accumulation buffer `a` (`w` cells per row, `h` rows, plus
 * spill room), in rect-local coordinates. Lines must already lie within `0 ≤ x ≤ w`.
 */
function drawLine(a: Float64Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): void {
  if (y0 === y1) return;
  let dir = 1;
  if (y0 > y1) {
    dir = -1;
    let t = x0;
    x0 = x1;
    x1 = t;
    t = y0;
    y0 = y1;
    y1 = t;
  }
  if (y1 <= 0 || y0 >= h) return;
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0;
  if (y0 < 0) x -= y0 * dxdy;
  const rowStart = Math.max(0, Math.floor(y0));
  const rowEnd = Math.min(h, Math.ceil(y1));
  for (let y = rowStart; y < rowEnd; y++) {
    const line = y * w;
    const dy = Math.min(y + 1, y1) - Math.max(y, y0);
    const xnext = x + dxdy * dy;
    const d = dy * dir;
    const xa = x < xnext ? x : xnext;
    const xb = x < xnext ? xnext : x;
    const xaFloor = Math.floor(xa);
    const xai = xaFloor;
    const xbCeil = Math.ceil(xb);
    const xbi = xbCeil;
    if (xbi <= xai + 1) {
      const xmf = 0.5 * (x + xnext) - xaFloor;
      a[line + xai] += d - d * xmf;
      a[line + xai + 1] += d * xmf;
    } else {
      const s = 1 / (xb - xa);
      const xaf = xa - xaFloor;
      const a0 = 0.5 * s * (1 - xaf) * (1 - xaf);
      const xbf = xb - xbCeil + 1;
      const am = 0.5 * s * xbf * xbf;
      a[line + xai] += d * a0;
      if (xbi === xai + 2) a[line + xai + 1] += d * (1 - a0 - am);
      else {
        const a1 = s * (1.5 - xaf);
        a[line + xai + 1] += d * (a1 - a0);
        for (let xi = xai + 2; xi < xbi - 1; xi++) a[line + xi] += d * s;
        const a2 = a1 + (xbi - xai - 3) * s;
        a[line + xbi - 1] += d * (1 - a2 - am);
      }
      a[line + xbi] += d * am;
    }
    x = xnext;
  }
}

/** Adds a line clipped to `0 ≤ x ≤ w`: parts left or right of the rect run along its edge. */
function drawClippedLine(a: Float64Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): void {
  if (y0 === y1) return;
  if ((y0 <= 0 && y1 <= 0) || (y0 >= h && y1 >= h)) return;
  if (x0 >= 0 && x0 <= w && x1 >= 0 && x1 <= w) return drawLine(a, w, h, x0, y0, x1, y1);
  // Split at x = 0 and x = w, then clamp each piece.
  const ts: number[] = [0, 1];
  const dx = x1 - x0;
  if (dx !== 0) {
    for (const edge of [0, w]) {
      const t = (edge - x0) / dx;
      if (t > 0 && t < 1) ts.push(t);
    }
  }
  ts.sort((p, q) => p - q);
  const clamp = (v: number) => (v < 0 ? 0 : v > w ? w : v);
  for (let i = 0; i + 1 < ts.length; i++) {
    const ta = ts[i];
    const tb = ts[i + 1];
    drawLine(a, w, h, clamp(x0 + dx * ta), y0 + (y1 - y0) * ta, clamp(x0 + dx * tb), y0 + (y1 - y0) * tb);
  }
}

/** Applies the fill rule to an accumulated winding value. */
function ruleCoverage(v: number, rule: CoverageFillRule): number {
  const m = v < 0 ? -v : v;
  if (rule === 'nonzero') return m >= 1 ? 1 : m;
  const f = m % 2;
  return f > 1 ? 2 - f : f;
}

/**
 * Coverage (0..1 per pixel, `rect.width × rect.height`, row by row) of `flat` filled with `rule`
 * over `rect`. Returns `null` when nothing in the rect is covered.
 */
export function rasterizeCoverage(flat: FlatPath, rect: CropBox, rule: CoverageFillRule = 'nonzero'): Float32Array | null {
  const w = rect.width;
  const h = rect.height;
  if (w <= 0 || h <= 0 || !flat.length) return null;
  const a = new Float64Array(w * h + w + 4);
  const ox = rect.x;
  const oy = rect.y;
  let touched = false;
  for (const p of flat) {
    const n = p.length;
    for (let i = 0; i < n; i += 2) {
      const j = i + 2 < n ? i + 2 : 0;
      const ya = p[i + 1] - oy;
      const yb = p[j + 1] - oy;
      if ((ya <= 0 && yb <= 0) || (ya >= h && yb >= h) || ya === yb) continue;
      // Lines right of the rect still count: their winding cancels the row's running sum at x = w.
      drawClippedLine(a, w, h, p[i] - ox, ya, p[j] - ox, yb);
      touched = true;
    }
  }
  if (!touched) return null;
  const out = new Float32Array(w * h);
  let acc = 0;
  let any = false;
  for (let i = 0; i < out.length; i++) {
    acc += a[i];
    const c = ruleCoverage(acc, rule);
    if (c > 1e-6) {
      out[i] = c;
      any = true;
    }
  }
  return any ? out : null;
}

/** Sub-rows per pixel row of the sampled rasterizer. */
const SUB_ROWS = 16;

/**
 * Coverage like `rasterizeCoverage`, sampled on `SUB_ROWS` sub-rows per pixel row with exact
 * horizontal coverage: correct wherever the path overlaps itself, edges within 1/32 px vertically.
 */
export function rasterizeCoverageSampled(flat: FlatPath, rect: CropBox, rule: CoverageFillRule = 'nonzero'): Float32Array | null {
  const w = rect.width;
  const h = rect.height;
  if (w <= 0 || h <= 0 || !flat.length) return null;
  // Edges in rect-local coordinates, top to bottom: y0, y1, x at y0, dx/dy, winding.
  let n = 0;
  for (const p of flat) n += p.length >> 1;
  const ey0 = new Float64Array(n);
  const ey1 = new Float64Array(n);
  const ex0 = new Float64Array(n);
  const eslope = new Float64Array(n);
  const edir = new Int8Array(n);
  let count = 0;
  for (const p of flat) {
    const len = p.length;
    for (let i = 0; i < len; i += 2) {
      const j = i + 2 < len ? i + 2 : 0;
      let xa = p[i] - rect.x;
      let ya = p[i + 1] - rect.y;
      let xb = p[j] - rect.x;
      let yb = p[j + 1] - rect.y;
      if (ya === yb) continue;
      let dir = 1;
      if (ya > yb) {
        dir = -1;
        let t = xa;
        xa = xb;
        xb = t;
        t = ya;
        ya = yb;
        yb = t;
      }
      if (yb <= 0 || ya >= h) continue;
      ey0[count] = ya;
      ey1[count] = yb;
      ex0[count] = xa;
      eslope[count] = (xb - xa) / (yb - ya);
      edir[count] = dir;
      count++;
    }
  }
  if (!count) return null;
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => ey0[a] - ey0[b]);
  const out = new Float32Array(w * h);
  const diff = new Float32Array(w + 1);
  let active: number[] = [];
  let next = 0;
  const xs: number[] = [];
  const ds: number[] = [];
  const idx: number[] = [];
  const f = 1 / SUB_ROWS;
  let any = false;
  const firstRow = Math.max(0, Math.floor(ey0[order[0]]));
  for (let y = firstRow; y < h; y++) {
    if (next >= count && !active.length) break;
    const row = y * w;
    let rowTouched = false;
    for (let s = 0; s < SUB_ROWS; s++) {
      const sy = y + (s + 0.5) * f;
      while (next < count && ey0[order[next]] <= sy) active.push(order[next++]);
      if (!active.length) continue;
      active = active.filter((e) => ey1[e] > sy);
      xs.length = 0;
      ds.length = 0;
      idx.length = 0;
      for (const e of active) {
        if (ey0[e] > sy) continue;
        idx.push(xs.length);
        xs.push(ex0[e] + (sy - ey0[e]) * eslope[e]);
        ds.push(edir[e]);
      }
      if (xs.length < 2) continue;
      idx.sort((a, b) => xs[a] - xs[b]);
      let wind = 0;
      for (let k = 0; k + 1 < idx.length; k++) {
        wind += ds[idx[k]];
        const inside = rule === 'nonzero' ? wind !== 0 : (wind & 1) !== 0;
        if (!inside) continue;
        let xa = xs[idx[k]];
        let xb = xs[idx[k + 1]];
        if (xb <= 0 || xa >= w || xb <= xa) continue;
        if (xa < 0) xa = 0;
        if (xb > w) xb = w;
        const ia = Math.floor(xa);
        const ib = Math.floor(xb);
        rowTouched = true;
        if (ia === ib) {
          out[row + ia] += (xb - xa) * f;
          continue;
        }
        out[row + ia] += (ia + 1 - xa) * f;
        diff[ia + 1] += f;
        diff[ib] -= f;
        if (ib < w) out[row + ib] += (xb - ib) * f;
      }
    }
    if (!rowTouched) continue;
    let run = 0;
    for (let x = 0; x < w; x++) {
      run += diff[x];
      diff[x] = 0;
      const v = out[row + x] + run;
      out[row + x] = v > 1 ? 1 : v < 1e-6 ? 0 : v;
      if (out[row + x] > 0) any = true;
    }
    diff[w] = 0;
  }
  return any ? out : null;
}

/** Coverage of `a` and `b` combined per pixel (Photoshop's path operations on coverage). */
export function combineCoverage(a: Float32Array | null, b: Float32Array | null, op: 'combine' | 'subtract' | 'intersect' | 'exclude', n: number): Float32Array | null {
  if (op === 'combine') {
    if (!a) return b;
    if (!b) return a;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = a[i] + b[i] - a[i] * b[i];
    return out;
  }
  if (op === 'subtract') {
    if (!a || !b) return a;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = a[i] * (1 - b[i]);
    return out;
  }
  if (op === 'intersect') {
    if (!a || !b) return null;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = a[i] * b[i];
    return out;
  }
  if (!a) return b;
  if (!b) return a;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] + b[i] - 2 * a[i] * b[i];
  return out;
}
