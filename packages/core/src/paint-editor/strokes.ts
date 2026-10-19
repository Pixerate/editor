/**
 * Strokes as data. Every committed stroke is recorded with the brush, colour, raw pen samples,
 * jitter seed and symmetry copies it was painted with, so it replays to the same pixels, and can
 * be replayed moved, scaled, rotated, recoloured or with another brush (`replay_strokes`).
 */

import { normalizePaintBrush, type PaintBrushInput, type PaintBrush } from './brushes';
import type { Linear2, PenPoint, StrokeCopy } from './engine';

/** An affine map [a, b, c, d, e, f]: (x, y) → (a·x + b·y + e, c·x + d·y + f). */
export type Affine = readonly [number, number, number, number, number, number];

export const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0];

export interface RecordedStroke {
  id: string;
  layerId: string;
  brush: PaintBrush;
  /** #rrggbb */
  color: string;
  /** Raw pen samples in document pixels, before smoothing. */
  points: PenPoint[];
  seed: number;
  /** Extra copies painted with the stroke (mirror / kaleidoscope), as affine maps of the points. */
  copies?: Affine[];
}

export function applyAffine(m: Affine, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[1] * y + m[4], y: m[2] * x + m[3] * y + m[5] };
}

/** `a ∘ b` (b first). */
export function composeAffine(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[0] * b[4] + a[1] * b[5] + a[4],
    a[2] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function invertAffine(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error('The transform is not invertible (scale 0?).');
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + b * m[5]), -(c * m[4] + d * m[5])];
}

/** The pen sample mapped by `m` (tilt and twist are kept: they describe the pen, not the path). */
export function mapPenPoint(m: Affine, p: PenPoint): PenPoint {
  const q = applyAffine(m, p.x, p.y);
  return { ...p, x: q.x, y: q.y };
}

/** An affine copy as the engine's `StrokeCopy`. */
export function affineCopy(m: Affine): StrokeCopy {
  const linear: Linear2 = [m[0], m[1], m[2], m[3]];
  return { map: (p) => mapPenPoint(m, p), linear };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readPoint(raw: unknown): PenPoint | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!finite(r.x) || !finite(r.y)) return null;
  const p: PenPoint = { x: r.x, y: r.y };
  for (const k of ['pressure', 't', 'tiltX', 'tiltY', 'altitude', 'azimuth', 'twist'] as const) if (finite(r[k])) p[k] = r[k] as number;
  return p;
}

function readAffine(raw: unknown): Affine | null {
  return Array.isArray(raw) && raw.length === 6 && raw.every(finite) ? (raw as unknown as Affine) : null;
}

/** A recorded stroke read from JSON, or `null` when it is not one. */
export function normalizeBrushStroke(raw: unknown): RecordedStroke | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.layerId !== 'string' || !Array.isArray(r.points)) return null;
  const points = r.points.map(readPoint).filter((p): p is PenPoint => p !== null);
  if (!points.length) return null;
  const out: RecordedStroke = {
    id: r.id,
    layerId: r.layerId,
    brush: normalizePaintBrush((r.brush as PaintBrushInput) ?? {}),
    color: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color.toLowerCase() : '#000000',
    points,
    seed: finite(r.seed) ? r.seed | 0 : 0,
  };
  const copies = Array.isArray(r.copies) ? r.copies.map(readAffine).filter((m): m is Affine => m !== null) : [];
  if (copies.length) out.copies = copies;
  return out;
}

/** The bounding box of a stroke's points. */
export function strokeBounds(points: readonly PenPoint[]): { x: number; y: number; width: number; height: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export interface StrokeVariation {
  /** Move by this many document pixels (default 0). */
  dx?: number;
  dy?: number;
  /** Scale about the origin (default 1); brush size scales with it. */
  scale?: number;
  /** Rotate about the origin, degrees clockwise (default 0). */
  rotate?: number;
  /** Mirror horizontally about the origin (default false). */
  flipX?: boolean;
  /** The origin for scale, rotate and flip (default: the centre of the strokes' bounds). */
  origin?: { x: number; y: number };
  /** Multiply every pressure by this (default 1). */
  pressureScale?: number;
}

/** The affine map of a variation about `origin`. */
export function variationAffine(v: StrokeVariation, origin: { x: number; y: number }): Affine {
  const s = v.scale ?? 1;
  const a = ((v.rotate ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a) * s;
  const sin = Math.sin(a) * s;
  const fx = v.flipX ? -1 : 1;
  // Translate to the origin, flip, rotate (clockwise with y down) and scale, translate back, move.
  const linear: Affine = [cos * fx, -sin, sin * fx, cos, 0, 0];
  const toOrigin: Affine = [1, 0, 0, 1, -origin.x, -origin.y];
  const back: Affine = [1, 0, 0, 1, origin.x + (v.dx ?? 0), origin.y + (v.dy ?? 0)];
  return composeAffine(back, composeAffine(linear, toOrigin));
}

/** A stroke varied by `m` (points mapped; symmetry copies conjugated so they stay symmetric). */
export function varyStroke(stroke: RecordedStroke, m: Affine, v: StrokeVariation): RecordedStroke {
  const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const ps = v.pressureScale ?? 1;
  const points = stroke.points.map((p) => {
    const q = mapPenPoint(m, p);
    if (ps !== 1) q.pressure = Math.min(1, Math.max(0, (p.pressure ?? 1) * ps));
    return q;
  });
  const brush = s !== 1 ? normalizePaintBrush({ ...stroke.brush, tip: { ...stroke.brush.tip, size: stroke.brush.tip.size * s } }) : stroke.brush;
  const out: RecordedStroke = { ...stroke, brush, points };
  if (stroke.copies?.length) {
    const inv = invertAffine(m);
    out.copies = stroke.copies.map((c) => composeAffine(m, composeAffine(c, inv)));
  }
  return out;
}
