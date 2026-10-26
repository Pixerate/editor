/**
 * Stencils: shapes laid on the canvas that guide or mask strokes, like a ruler, a French curve or a
 * masking template held over the paper.
 *
 * - `ruler` (a straight edge) and `arc` (a circle or part of one) **guide**: a stroke that starts
 *   within `snap` pixels of the edge follows it exactly; one that starts further away is free.
 * - `line` (a straight edge across the canvas) and `shape` (rectangle, ellipse or polygon)
 *   **mask**: paint lands only on one side of the line, or only inside the shape (outside with
 *   `invert`), with an anti-aliased edge. Several masks combine (paint lands where all allow it).
 * - Any stencil can be switched to the other `mode`: a shape can guide (strokes follow its
 *   outline) and a ruler can mask (paint on one side of it).
 *
 * Geometry only; `stencilMask` makes the canvas coverage the stroke engines read as a selection.
 */

import type { Point2 } from './guides';

export type StencilKind = 'ruler' | 'arc' | 'line' | 'shape';
export const STENCIL_KINDS: readonly StencilKind[] = ['ruler', 'arc', 'line', 'shape'];

export type StencilShape = 'rect' | 'ellipse' | 'polygon';
export const STENCIL_SHAPES: readonly StencilShape[] = ['rect', 'ellipse', 'polygon'];

export interface Stencil {
  id: string;
  kind: StencilKind;
  /** `guide`: strokes that start near the edge follow it; `mask`: paint lands only inside (or on one side). */
  mode: 'guide' | 'mask';
  /** Shown and in effect (default true). */
  enabled: boolean;
  /** ruler / line: two points on the edge (document pixels). */
  from?: Point2;
  to?: Point2;
  /** arc: centre and radius, and the part of the circle in degrees clockwise from +x (default the whole circle). */
  center?: Point2;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  /** shape: its kind and geometry (`rect` for rect and ellipse, `points` for a polygon). */
  shape?: StencilShape;
  rect?: { x: number; y: number; width: number; height: number };
  points?: Point2[];
  /** mask: paint outside the shape (or on the other side of the line) instead. */
  invert: boolean;
  /** guide: how near the edge (px) a stroke must start to follow it (default 40). */
  snap: number;
  /** mask: soft edge width in pixels (default 1, anti-aliased). */
  feather: number;
}

export type StencilInput = Partial<Omit<Stencil, 'id'>> & { kind: StencilKind };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pt = (p: unknown): Point2 | undefined => (p && finite((p as Point2).x) && finite((p as Point2).y) ? { x: (p as Point2).x, y: (p as Point2).y } : undefined);

/** A stencil with every field in range; throws a sentence naming what is missing. */
export function normalizeStencil(raw: StencilInput, id: string, base?: Stencil): Stencil {
  const kind = STENCIL_KINDS.includes(raw.kind) ? raw.kind : base?.kind;
  if (!kind) throw new Error(`kind ${JSON.stringify(raw.kind)} is not a stencil; use ${STENCIL_KINDS.join(', ')}.`);
  const s: Stencil = {
    id,
    kind,
    mode: raw.mode === 'guide' || raw.mode === 'mask' ? raw.mode : (base?.mode ?? (kind === 'ruler' || kind === 'arc' ? 'guide' : 'mask')),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : (base?.enabled ?? true),
    invert: typeof raw.invert === 'boolean' ? raw.invert : (base?.invert ?? false),
    snap: finite(raw.snap) ? Math.min(400, Math.max(1, raw.snap)) : (base?.snap ?? 40),
    feather: finite(raw.feather) ? Math.min(100, Math.max(0, raw.feather)) : (base?.feather ?? 1),
  };
  if (kind === 'ruler' || kind === 'line') {
    s.from = pt(raw.from) ?? base?.from;
    s.to = pt(raw.to) ?? base?.to;
    if (!s.from || !s.to) throw new Error(`A ${kind} needs from and to points ({x, y} in document pixels).`);
    if (Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) < 1) throw new Error(`A ${kind}'s from and to must be at least 1 px apart.`);
  } else if (kind === 'arc') {
    s.center = pt(raw.center) ?? base?.center;
    s.radius = finite(raw.radius) ? raw.radius : base?.radius;
    if (!s.center || !(s.radius! > 0)) throw new Error('An arc needs a center ({x, y}) and a radius above 0.');
    s.startAngle = finite(raw.startAngle) ? raw.startAngle : (base?.startAngle ?? 0);
    s.endAngle = finite(raw.endAngle) ? raw.endAngle : (base?.endAngle ?? 360);
  } else {
    s.shape = STENCIL_SHAPES.includes(raw.shape as StencilShape) ? raw.shape : (base?.shape ?? 'rect');
    if (s.shape === 'polygon') {
      const pts = Array.isArray(raw.points) ? raw.points.map(pt).filter((p): p is Point2 => Boolean(p)) : base?.points;
      if (!pts || pts.length < 3) throw new Error('A polygon stencil needs at least 3 points.');
      s.points = pts;
    } else {
      const r = raw.rect ?? base?.rect;
      if (!r || !finite(r.x) || !finite(r.y) || !(r.width > 0) || !(r.height > 0)) throw new Error(`A ${s.shape} stencil needs rect {x, y, width, height} with a width and height above 0.`);
      s.rect = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
  }
  return s;
}

/** The outline of a stencil as a polyline (document pixels), for drawing and for shape guides. */
export function stencilOutline(s: Stencil): Point2[] {
  if (s.kind === 'ruler' || s.kind === 'line') return [s.from!, s.to!];
  if (s.kind === 'arc') {
    const a0 = (s.startAngle! * Math.PI) / 180;
    const a1 = (s.endAngle! * Math.PI) / 180;
    const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) * Math.max(8, s.radius! / 4)));
    return Array.from({ length: n + 1 }, (_, i) => {
      const a = a0 + ((a1 - a0) * i) / n;
      return { x: s.center!.x + Math.cos(a) * s.radius!, y: s.center!.y + Math.sin(a) * s.radius! };
    });
  }
  if (s.shape === 'polygon') return [...s.points!, s.points![0]];
  const r = s.rect!;
  if (s.shape === 'rect') return [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }, { x: r.x, y: r.y }];
  const n = 96;
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: r.x + r.width / 2 + (Math.cos(a) * r.width) / 2, y: r.y + r.height / 2 + (Math.sin(a) * r.height) / 2 };
  });
}

/** The nearest point of a polyline to `p`, and its distance. */
function nearestOnPolyline(line: readonly Point2[], p: Point2): { point: Point2; distance: number } {
  let best = { point: line[0], distance: Infinity };
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.distance) best = { point: q, distance: d };
  }
  return best;
}

/** The nearest point on a stencil's edge (a ruler extends without end; an arc is exact). */
function nearestOnStencil(s: Stencil, p: Point2): { point: Point2; distance: number } {
  if (s.kind === 'ruler' || s.kind === 'line') {
    const a = s.from!;
    const dx = s.to!.x - a.x;
    const dy = s.to!.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    return { point: q, distance: Math.hypot(p.x - q.x, p.y - q.y) };
  }
  if (s.kind === 'arc') {
    const c = s.center!;
    const ang = Math.atan2(p.y - c.y, p.x - c.x);
    const full = Math.abs(s.endAngle! - s.startAngle!) >= 360;
    if (full) {
      const q = { x: c.x + Math.cos(ang) * s.radius!, y: c.y + Math.sin(ang) * s.radius! };
      return { point: q, distance: Math.hypot(p.x - q.x, p.y - q.y) };
    }
    return nearestOnPolyline(stencilOutline(s), p);
  }
  return nearestOnPolyline(stencilOutline(s), p);
}

/**
 * Snaps a stroke to the guide stencils: the first point picks the nearest guide within its `snap`
 * distance (or none), and every point after it is moved onto that guide's edge.
 */
export class StencilSnapper {
  private guide: Stencil | null | undefined;

  constructor(private readonly stencils: readonly Stencil[]) {}

  /** The stencil the stroke follows, once chosen (`null`: none). */
  get following(): Stencil | null {
    return this.guide ?? null;
  }

  snap<P extends Point2>(p: P): P {
    if (this.guide === undefined) {
      let best: { s: Stencil; d: number } | null = null;
      for (const s of this.stencils) {
        if (!s.enabled || s.mode !== 'guide') continue;
        const { distance } = nearestOnStencil(s, p);
        if (distance <= s.snap && (!best || distance < best.d)) best = { s, d: distance };
      }
      this.guide = best?.s ?? null;
    }
    if (!this.guide) return p;
    const q = nearestOnStencil(this.guide, p).point;
    return { ...p, x: q.x, y: q.y };
  }
}

/** Signed distance to a mask stencil's edge: positive where paint may land. */
function maskDistance(s: Stencil, x: number, y: number): number {
  let d: number;
  if (s.kind === 'ruler' || s.kind === 'line') {
    // The left side of from → to (screen coordinates, y down) is "inside".
    const dx = s.to!.x - s.from!.x;
    const dy = s.to!.y - s.from!.y;
    const len = Math.hypot(dx, dy);
    d = ((x - s.from!.x) * dy - (y - s.from!.y) * dx) / len;
  } else if (s.kind === 'arc') {
    d = s.radius! - Math.hypot(x - s.center!.x, y - s.center!.y);
  } else if (s.shape === 'rect') {
    const r = s.rect!;
    d = Math.min(x - r.x, r.x + r.width - x, y - r.y, r.y + r.height - y);
  } else if (s.shape === 'ellipse') {
    const r = s.rect!;
    const rx = r.width / 2;
    const ry = r.height / 2;
    const nx = (x - r.x - rx) / rx;
    const ny = (y - r.y - ry) / ry;
    // Approximate distance: the radial distance scaled by the local radius.
    const k = Math.hypot(nx, ny);
    d = (1 - k) * Math.min(rx, ry);
  } else {
    const pts = s.points!;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    const e = nearestOnPolyline([...pts, pts[0]], { x, y }).distance;
    d = inside ? e : -e;
  }
  return s.invert ? -d : d;
}

/**
 * The combined coverage of the enabled mask stencils over a `width × height` canvas (0..255 per
 * pixel), or `null` when no stencil masks.
 */
export function stencilMask(stencils: readonly Stencil[], width: number, height: number): { width: number; height: number; data: Uint8Array } | null {
  const masks = stencils.filter((s) => s.enabled && s.mode === 'mask');
  if (!masks.length) return null;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let cov = 1;
      for (const s of masks) {
        const f = Math.max(0.5, s.feather);
        const d = maskDistance(s, x + 0.5, y + 0.5);
        cov = Math.min(cov, Math.min(1, Math.max(0, d / (2 * f) + 0.5)));
        if (cov <= 0) break;
      }
      data[y * width + x] = Math.round(cov * 255);
    }
  }
  return { width, height, data };
}

/** A stencil moved by (dx, dy) document pixels (for a canvas extended to the left or top). */
export function translateStencil(s: Stencil, dx: number, dy: number): Stencil {
  const p = (q?: Point2) => (q ? { x: q.x + dx, y: q.y + dy } : undefined);
  return {
    ...s,
    ...(s.from ? { from: p(s.from) } : {}),
    ...(s.to ? { to: p(s.to) } : {}),
    ...(s.center ? { center: p(s.center) } : {}),
    ...(s.rect ? { rect: { ...s.rect, x: s.rect.x + dx, y: s.rect.y + dy } } : {}),
    ...(s.points ? { points: s.points.map((q) => p(q)!) } : {}),
  };
}

/** A stencil scaled about the origin by `k` (for repainting at a larger size). */
export function scaleStencil(s: Stencil, k: number): Stencil {
  const p = (q?: Point2) => (q ? { x: q.x * k, y: q.y * k } : undefined);
  return {
    ...s,
    ...(s.from ? { from: p(s.from) } : {}),
    ...(s.to ? { to: p(s.to) } : {}),
    ...(s.center ? { center: p(s.center), radius: s.radius! * k } : {}),
    ...(s.rect ? { rect: { x: s.rect.x * k, y: s.rect.y * k, width: s.rect.width * k, height: s.rect.height * k } } : {}),
    ...(s.points ? { points: s.points.map((q) => p(q)!) } : {}),
    snap: s.snap * k,
    feather: s.feather * k,
  };
}
