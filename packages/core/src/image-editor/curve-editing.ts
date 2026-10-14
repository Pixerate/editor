import type { CurvePoint } from './types';
import { curveLutFromLevels } from './adjustment-layers';

/**
 * Framework-neutral helpers for a Curves editor drawn in a `width` × `height` box (levels 0..255
 * on both axes, output up). The React and Svelte curve editors share them.
 */

const clampLevel = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

/** Box coordinates of a curve point. */
export function curvePointToBox(p: CurvePoint, width: number, height: number): { x: number; y: number } {
  return { x: (p.input / 255) * width, y: height - (p.output / 255) * height };
}

/** The curve point (whole levels, clamped) under box coordinates. */
export function boxToCurvePoint(x: number, y: number, width: number, height: number): CurvePoint {
  return { input: clampLevel((x / (width || 1)) * 255), output: clampLevel(((height - y) / (height || 1)) * 255) };
}

/** An SVG polyline path of the evaluated curve (spline, clamped, constant beyond the end points). */
export function curveSvgPath(points: readonly CurvePoint[], width: number, height: number, samples = 64): string {
  const lut = curveLutFromLevels(points);
  const n = lut.length - 1;
  let d = '';
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const y = lut[Math.round(t * n)];
    d += `${i === 0 ? 'M' : ' L'}${round2(t * width)} ${round2(height - y * height)}`;
  }
  return d;
}

/** Index of the point within `radius` box units of (x, y), nearest first; -1 for none. */
export function hitTestCurvePoint(
  points: readonly CurvePoint[],
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 8
): number {
  let best = -1;
  let bestD = radius * radius;
  points.forEach((p, i) => {
    const b = curvePointToBox(p, width, height);
    const d = (b.x - x) ** 2 + (b.y - y) ** 2;
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** Inserts a point in input order (replacing one at the same input). Returns the new list and its index. */
export function insertCurvePoint(points: readonly CurvePoint[], p: CurvePoint): { points: CurvePoint[]; index: number } {
  const point = { input: clampLevel(p.input), output: clampLevel(p.output) };
  const out = points.filter((q) => q.input !== point.input).map((q) => ({ ...q }));
  let index = out.findIndex((q) => q.input > point.input);
  if (index === -1) index = out.length;
  out.splice(index, 0, point);
  return { points: out, index };
}

/** Moves point `index`, keeping its input strictly between its neighbours'. */
export function moveCurvePoint(points: readonly CurvePoint[], index: number, p: CurvePoint): CurvePoint[] {
  const out = points.map((q) => ({ ...q }));
  if (index < 0 || index >= out.length) return out;
  const lo = index > 0 ? out[index - 1].input + 1 : 0;
  const hi = index < out.length - 1 ? out[index + 1].input - 1 : 255;
  out[index] = { input: Math.min(hi, Math.max(lo, clampLevel(p.input))), output: clampLevel(p.output) };
  return out;
}

/** Removes point `index`; a curve keeps at least two points. */
export function removeCurvePoint(points: readonly CurvePoint[], index: number): CurvePoint[] {
  if (points.length <= 2 || index < 0 || index >= points.length) return points.map((q) => ({ ...q }));
  return points.filter((_, i) => i !== index).map((q) => ({ ...q }));
}

const round2 = (v: number) => Math.round(v * 100) / 100;
