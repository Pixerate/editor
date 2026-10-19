/**
 * Curve lookup tables shared by Curves adjustments and layer-effect contours.
 */

/** Entries of a curve LUT (input 0..1 in `size - 1` steps). */
export const CURVE_LUT_SIZE = 4096;

const clamp01 = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/**
 * Photoshop curve: a natural cubic spline through the points (0..1 in and out; it may overshoot
 * between points, as Photoshop's does), constant outside the first / last point, clamped to
 * 0..1, sampled into a LUT. Fewer than two distinct points: the identity.
 */
export function curveLut(points: ReadonlyArray<{ input: number; output: number }>, size = CURVE_LUT_SIZE): Float32Array {
  const pts = points
    .filter((p) => Number.isFinite(p.input) && Number.isFinite(p.output))
    .map((p) => [p.input, p.output] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const dedup: [number, number][] = [];
  for (const p of pts) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1][0] - p[0]) < 1e-6) continue;
    dedup.push(p);
  }
  const out = new Float32Array(size);
  const n = dedup.length;
  if (n < 2) {
    for (let k = 0; k < size; k++) out[k] = k / (size - 1);
    return out;
  }
  const x = dedup.map((p) => p[0]);
  const y = dedup.map((p) => p[1]);
  // Second derivatives of the natural spline (tridiagonal solve).
  const m2 = new Float64Array(n);
  if (n > 2) {
    const c = new Float64Array(n);
    const d = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      const h0 = x[i] - x[i - 1];
      const h1 = x[i + 1] - x[i];
      const a = h0 / 6;
      const b = (h0 + h1) / 3;
      const cc = h1 / 6;
      const r = (y[i + 1] - y[i]) / h1 - (y[i] - y[i - 1]) / h0;
      const denom = b - a * c[i - 1];
      c[i] = cc / denom;
      d[i] = (r - a * d[i - 1]) / denom;
    }
    for (let i = n - 2; i >= 1; i--) m2[i] = d[i] - c[i] * m2[i + 1];
  }
  let seg = 0;
  for (let k = 0; k < size; k++) {
    const xv = k / (size - 1);
    if (xv <= x[0]) {
      out[k] = clamp01(y[0]);
      continue;
    }
    if (xv >= x[n - 1]) {
      out[k] = clamp01(y[n - 1]);
      continue;
    }
    while (seg < n - 2 && xv > x[seg + 1]) seg++;
    const x0 = x[seg], x1 = x[seg + 1];
    const h = x1 - x0;
    const a = (x1 - xv) / h;
    const b = (xv - x0) / h;
    const v = a * y[seg] + b * y[seg + 1] + ((a * a * a - a) * m2[seg] + (b * b * b - b) * m2[seg + 1]) * (h * h) / 6;
    out[k] = clamp01(v);
  }
  return out;
}
