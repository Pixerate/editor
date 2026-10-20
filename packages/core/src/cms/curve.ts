// Portions ported from photocraft/crates/cms/src/curve.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * One-dimensional tone curves (ICC `curv` and `para`) and their inverses. Gamma and parametric
 * curves evaluate analytically, also outside 0..1 (negatives mirror, values above 1 extend the
 * formula), so float transforms keep HDR values. Tables clamp their input to 0..1.
 */

export type Curve =
  | { type: 'identity' }
  | { type: 'gamma'; gamma: number }
  /** ICC `parametricCurveType` function `kind` (0–4), parameters `[g, a, b, c, d, e, f]`. */
  | { type: 'parametric'; kind: number; p: number[] }
  /** Samples at evenly spaced inputs over 0..1. */
  | { type: 'table'; table: Float32Array };

export const IDENTITY_CURVE: Curve = { type: 'identity' };

/** The sRGB transfer function (IEC 61966-2.1) as ICC parametric type 3. */
export function srgbTrc(): Curve {
  return { type: 'parametric', kind: 3, p: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045, 0, 0] };
}

export const gammaCurve = (g: number): Curve => ({ type: 'gamma', gamma: g });

/** Parameters stored for a parametric function type. */
export function paramCount(kind: number): number {
  return kind === 0 ? 1 : kind === 1 ? 3 : kind === 2 ? 4 : kind === 3 ? 5 : 7;
}

export function isIdentityCurve(c: Curve): boolean {
  switch (c.type) {
    case 'identity':
      return true;
    case 'gamma':
      return Math.abs(c.gamma - 1) < 1e-9;
    case 'parametric':
      return c.kind === 0 && Math.abs(c.p[0] - 1) < 1e-9;
    case 'table': {
      const n = c.table.length;
      if (n < 2) return true;
      for (let i = 0; i < n; i++) if (Math.abs(c.table[i] - i / (n - 1)) >= 1 / 65535) return false;
      return true;
    }
  }
}

const mirror = (x: number, f: (v: number) => number) => (x < 0 ? -f(-x) : f(x));
const pw = (base: number, g: number) => (base <= 0 ? 0 : Math.pow(base, g));

function para(kind: number, p: readonly number[], x: number): number {
  const [g, a, b, c, d, e, f] = p;
  switch (kind) {
    case 0:
      return mirror(x, (v) => Math.pow(v, g));
    case 1:
      return a !== 0 && x >= -b / a ? pw(a * x + b, g) : 0;
    case 2:
      return a !== 0 && x >= -b / a ? pw(a * x + b, g) + c : c;
    case 3:
      if (x < 0 && b === 0 && d === 0) return -para(kind, p, -x);
      return x >= d ? pw(a * x + b, g) : c * x;
    default:
      return x >= d ? pw(a * x + b, g) + e : c * x + f;
  }
}

function paraInverse(kind: number, p: readonly number[], y: number): number | null {
  const [g, a, b, c, d, e, f] = p;
  if (Math.abs(g) < 1e-12) return null;
  const root = (v: number) => (v <= 0 ? 0 : Math.pow(v, 1 / g));
  switch (kind) {
    case 0:
      return mirror(y, (v) => Math.pow(v, 1 / g));
    case 1:
      if (a === 0) return null;
      return y <= 0 ? -b / a : (root(y) - b) / a;
    case 2:
      if (a === 0) return null;
      return y <= c ? -b / a : (root(y - c) - b) / a;
    case 3: {
      if (a === 0) return null;
      if (y < 0 && b === 0 && d === 0) {
        const v = paraInverse(kind, p, -y);
        return v === null ? null : -v;
      }
      const yd = pw(a * d + b, g);
      if (y >= yd) return (root(y) - b) / a;
      return c !== 0 ? y / c : 0;
    }
    default: {
      if (a === 0) return null;
      const yd = pw(a * d + b, g) + e;
      if (y >= yd) return (root(y - e) - b) / a;
      return c !== 0 ? (y - f) / c : 0;
    }
  }
}

/** Bisection inverse of a monotonic function on 0..1. */
function numericInverse(f: (x: number) => number, y: number): number {
  const increasing = f(1) >= f(0);
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) < y === increasing) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function table(t: Float32Array, x: number): number {
  const n = t.length;
  if (n === 0) return x;
  if (n === 1) return t[0];
  const pos = Math.min(1, Math.max(0, x)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(pos));
  const f = pos - i;
  return t[i] + (t[i + 1] - t[i]) * f;
}

function edgeIndex(t: Float32Array, start: boolean): number {
  const n = t.length;
  if (start) {
    const v = t[0];
    let i = n - 1;
    for (let k = 0; k < n; k++) {
      if (Math.abs(t[k] - v) > 1e-7) {
        i = k - 1;
        break;
      }
    }
    return i / (n - 1);
  }
  const v = t[n - 1];
  let i = 0;
  for (let k = n - 1; k >= 0; k--) {
    if (Math.abs(t[k] - v) > 1e-7) {
      i = k + 1;
      break;
    }
  }
  return i / (n - 1);
}

/** Exact inverse of a piecewise-linear table (binary search), increasing or decreasing. */
function tableInverse(t: Float32Array, y: number): number {
  const n = t.length;
  if (n < 2) return y;
  const increasing = t[n - 1] >= t[0];
  const loV = increasing ? t[0] : t[n - 1];
  const hiV = increasing ? t[n - 1] : t[0];
  if (y <= loV) return edgeIndex(t, increasing);
  if (y >= hiV) return edgeIndex(t, !increasing);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < y === increasing) lo = mid;
    else hi = mid;
  }
  const a = t[lo];
  const b = t[hi];
  const f = Math.abs(b - a) > 1e-12 ? (y - a) / (b - a) : 0.5;
  return (lo + f) / (n - 1);
}

/** Evaluates a curve at `x`. */
export function evalCurve(c: Curve, x: number): number {
  switch (c.type) {
    case 'identity':
      return x;
    case 'gamma':
      return mirror(x, (v) => Math.pow(v, c.gamma));
    case 'parametric':
      return para(c.kind, c.p, x);
    case 'table':
      return table(c.table, x);
  }
}

/** Evaluates the inverse curve at `y`. */
export function evalCurveInverse(c: Curve, y: number): number {
  switch (c.type) {
    case 'identity':
      return y;
    case 'gamma':
      return Math.abs(c.gamma) < 1e-12 ? y : mirror(y, (v) => Math.pow(v, 1 / c.gamma));
    case 'parametric':
      return paraInverse(c.kind, c.p, y) ?? numericInverse((x) => para(c.kind, c.p, x), y);
    case 'table':
      return tableInverse(c.table, y);
  }
}

/** `n` evenly spaced samples over 0..1. */
export function sampleCurve(c: Curve, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = evalCurve(c, i / (n - 1));
  return out;
}
