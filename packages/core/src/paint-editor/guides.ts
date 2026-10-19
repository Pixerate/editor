// Portions ported from photocraft/crates/paint/src/symmetry.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Painting guides: mirror and kaleidoscope symmetry (every stroke paints its reflected or rotated
 * copies as one stroke), perspective guides with one to three vanishing points that strokes snap
 * to, a tracing image under the paint (optionally the source of the stroke colour), and floating
 * reference images to pick colours from. Geometry only: no pixels, no DOM.
 */

import { composeAffine, type Affine } from './strokes';

export type SymmetryMode = 'off' | 'vertical' | 'horizontal' | 'dual' | 'diagonal' | 'kaleidoscope';

export const SYMMETRY_MODES: readonly SymmetryMode[] = ['off', 'vertical', 'horizontal', 'dual', 'diagonal', 'kaleidoscope'];

export interface SymmetryGuide {
  mode: SymmetryMode;
  /** Centre of the axes in document pixels (default the canvas centre). */
  center: { x: number; y: number };
  /** Turns the axes, degrees clockwise (default 0). */
  rotation: number;
  /** Kaleidoscope: number of segments, 2..32 (default 6). */
  segments: number;
  /** Kaleidoscope: reflect every other segment as well as rotating (default true), like a real kaleidoscope. */
  mirror: boolean;
}

export interface Point2 {
  x: number;
  y: number;
}

export interface PerspectiveGuide {
  enabled: boolean;
  /** One to three vanishing points in document pixels (they may lie outside the canvas). */
  points: Point2[];
  /** Strokes snap to the guide lines (default true when enabled). */
  snap: boolean;
}

/** A view-only image under the paint, placed over the canvas. */
export interface TracingImage {
  /** PNG or JPEG data URL. */
  src: string;
  /** Natural size of the image in pixels. */
  width: number;
  height: number;
  /** Where it is drawn, in document pixels (default: fitted to the canvas). */
  rect: { x: number; y: number; width: number; height: number };
  /** 0..1 (default 0.35). */
  opacity: number;
  visible: boolean;
  /** Strokes without an explicit colour take the tracing image's colour where they start. */
  sampleColors: boolean;
}

/** A floating image to look at and pick colours from (shown beside the canvas, never painted). */
export interface ReferenceImage {
  id: string;
  name: string;
  src: string;
  width: number;
  height: number;
  /** Where the panel floats over the viewport, in screen pixels, and its displayed width. */
  x: number;
  y: number;
  displayWidth: number;
  visible: boolean;
}

export interface PaintGuides {
  symmetry: SymmetryGuide;
  perspective: PerspectiveGuide;
  tracing: TracingImage | null;
  references: ReferenceImage[];
}

export function defaultGuides(canvas: { width: number; height: number }): PaintGuides {
  return {
    symmetry: { mode: 'off', center: { x: canvas.width / 2, y: canvas.height / 2 }, rotation: 0, segments: 6, mirror: true },
    perspective: { enabled: false, points: [], snap: true },
    tracing: null,
    references: [],
  };
}

export const MAX_COORDINATE = 1_000_000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const coord = (v: unknown, d: number) => (finite(v) && Math.abs(v) <= MAX_COORDINATE ? v : d);

export function normalizeSymmetry(raw: Partial<SymmetryGuide> | Record<string, unknown>, base: SymmetryGuide): SymmetryGuide {
  const r = raw as Record<string, unknown>;
  const c = (r.center ?? {}) as Record<string, unknown>;
  return {
    mode: SYMMETRY_MODES.includes(r.mode as SymmetryMode) ? (r.mode as SymmetryMode) : base.mode,
    center: { x: coord(c.x, base.center.x), y: coord(c.y, base.center.y) },
    rotation: finite(r.rotation) ? ((r.rotation % 360) + 360) % 360 : base.rotation,
    segments: finite(r.segments) ? Math.min(32, Math.max(2, Math.round(r.segments))) : base.segments,
    mirror: typeof r.mirror === 'boolean' ? r.mirror : base.mirror,
  };
}

/** Reflection across the line through `c` in direction angle `a` (radians, clockwise with y down). */
function reflectAbout(c: Point2, a: number): Affine {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  // 2·d·dᵀ − I, conjugated by the translation to the centre.
  const m00 = 2 * dx * dx - 1;
  const m01 = 2 * dx * dy;
  const m11 = 2 * dy * dy - 1;
  return [m00, m01, m01, m11, c.x - (m00 * c.x + m01 * c.y), c.y - (m01 * c.x + m11 * c.y)];
}

/** Rotation by `a` radians (clockwise with y down) about `c`. */
function rotateAbout(c: Point2, a: number): Affine {
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [cos, -sin, sin, cos, c.x - (cos * c.x - sin * c.y), c.y - (sin * c.x + cos * c.y)];
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** The axis directions of a mirror mode (radians), as photocraft's `directions`. */
export function symmetryAxisAngles(g: SymmetryGuide): number[] {
  if (g.mode === 'off') return [];
  if (g.mode === 'kaleidoscope') return Array.from({ length: g.segments }, (_, k) => rad(g.rotation) + (k * Math.PI) / g.segments);
  const initial = g.mode === 'horizontal' ? 0 : g.mode === 'diagonal' ? 45 : 90;
  const a = rad(initial + g.rotation);
  return g.mode === 'dual' ? [a, a + Math.PI / 2] : [a];
}

/**
 * The extra copies a stroke paints under the symmetry guide, as affine maps (the stroke itself is
 * not included). Vertical, horizontal and diagonal: one reflection. Dual: two reflections and the
 * point reflection. Kaleidoscope: rotations by 360°/n, and with `mirror` the reflections between them.
 */
export function symmetryCopies(g: SymmetryGuide): Affine[] {
  const c = g.center;
  switch (g.mode) {
    case 'off':
      return [];
    case 'vertical':
    case 'horizontal':
    case 'diagonal':
      return symmetryAxisAngles(g).map((a) => reflectAbout(c, a));
    case 'dual': {
      const [a, b] = symmetryAxisAngles(g);
      return [reflectAbout(c, a), reflectAbout(c, b), rotateAbout(c, Math.PI)];
    }
    case 'kaleidoscope': {
      const out: Affine[] = [];
      const n = g.segments;
      for (let k = 1; k < n; k++) out.push(rotateAbout(c, (2 * Math.PI * k) / n));
      if (g.mirror) {
        const first = reflectAbout(c, rad(g.rotation));
        for (let k = 0; k < n; k++) out.push(composeAffine(rotateAbout(c, (2 * Math.PI * k) / n), first));
      }
      return out;
    }
  }
}

/** The axes clipped to the canvas, for drawing (photocraft's `segments`). */
export function symmetryAxisSegments(g: SymmetryGuide, size: { width: number; height: number }): Array<[Point2, Point2]> {
  const out: Array<[Point2, Point2]> = [];
  for (const a of symmetryAxisAngles(g)) {
    const d = [Math.cos(a), Math.sin(a)];
    const origin = [g.center.x, g.center.y];
    const extent = [size.width, size.height];
    let lo = -Infinity;
    let hi = Infinity;
    let ok = true;
    for (let i = 0; i < 2; i++) {
      if (Math.abs(d[i]) < 1e-12) {
        if (origin[i] < 0 || origin[i] > extent[i]) ok = false;
      } else {
        const t0 = -origin[i] / d[i];
        const t1 = (extent[i] - origin[i]) / d[i];
        lo = Math.max(lo, Math.min(t0, t1));
        hi = Math.min(hi, Math.max(t0, t1));
      }
    }
    if (!ok || !Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue;
    out.push([{ x: g.center.x + lo * d[0], y: g.center.y + lo * d[1] }, { x: g.center.x + hi * d[0], y: g.center.y + hi * d[1] }]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Perspective
// ---------------------------------------------------------------------------

export function normalizePerspective(raw: Partial<PerspectiveGuide> | Record<string, unknown>, base: PerspectiveGuide): PerspectiveGuide {
  const r = raw as Record<string, unknown>;
  let points = base.points;
  if (Array.isArray(r.points)) {
    if (r.points.length > 3) throw new Error(`A perspective guide has one to three vanishing points; got ${r.points.length}.`);
    points = r.points.map((p, i) => {
      const q = (p ?? {}) as Record<string, unknown>;
      if (!finite(q.x) || !finite(q.y) || Math.abs(q.x) > MAX_COORDINATE || Math.abs(q.y) > MAX_COORDINATE) {
        throw new Error(`points[${i}] needs finite x and y within ±${MAX_COORDINATE} document pixels.`);
      }
      return { x: q.x, y: q.y };
    });
  }
  const enabled = typeof r.enabled === 'boolean' ? r.enabled : base.enabled;
  if (enabled && !points.length) throw new Error('An enabled perspective guide needs at least one vanishing point; pass points.');
  return { enabled, points, snap: typeof r.snap === 'boolean' ? r.snap : base.snap };
}

/** The line families a perspective guide snaps to at `p`: unit directions. */
export function perspectiveDirections(g: PerspectiveGuide, p: Point2): Point2[] {
  const out: Point2[] = [];
  for (const v of g.points) {
    const dx = v.x - p.x;
    const dy = v.y - p.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) out.push({ x: dx / len, y: dy / len });
  }
  // One-point perspective keeps true horizontals and verticals; two-point keeps verticals.
  if (g.points.length <= 2) out.push({ x: 0, y: 1 });
  if (g.points.length <= 1) out.push({ x: 1, y: 0 });
  return out;
}

/** How far the pen must move before a stroke chooses its perspective line (document pixels). */
export const SNAP_DECIDE_DISTANCE = 6;

/**
 * Snaps one stroke to a perspective guide: once the pen has moved `SNAP_DECIDE_DISTANCE` from
 * where it started, the stroke picks the guide line through its start that best matches its
 * direction, and every sample after that is projected onto the line.
 */
export class PerspectiveSnapper {
  private start: Point2 | null = null;
  private dir: Point2 | null = null;

  constructor(private readonly guide: PerspectiveGuide) {}

  /** The line the stroke follows, once chosen. */
  get line(): { from: Point2; direction: Point2 } | null {
    return this.start && this.dir ? { from: this.start, direction: this.dir } : null;
  }

  snap<P extends Point2>(p: P): P {
    if (!this.guide.enabled || !this.guide.snap || !this.guide.points.length) return p;
    if (!this.start) {
      this.start = { x: p.x, y: p.y };
      return p;
    }
    const s = this.start;
    if (!this.dir) {
      const dx = p.x - s.x;
      const dy = p.y - s.y;
      const len = Math.hypot(dx, dy);
      if (len < SNAP_DECIDE_DISTANCE) return { ...p, x: s.x, y: s.y };
      let best: Point2 | null = null;
      let bestDot = -1;
      for (const d of perspectiveDirections(this.guide, s)) {
        const dot = Math.abs((dx * d.x + dy * d.y) / len);
        if (dot > bestDot) {
          bestDot = dot;
          best = d;
        }
      }
      this.dir = best;
      if (!best) return p;
    }
    const d = this.dir!;
    const t = (p.x - s.x) * d.x + (p.y - s.y) * d.y;
    return { ...p, x: s.x + d.x * t, y: s.y + d.y * t };
  }
}

/** Guide lines to draw for a perspective guide: rays from each vanishing point through the canvas. */
export function perspectiveGuideLines(g: PerspectiveGuide, size: { width: number; height: number }, count = 12): Array<[Point2, Point2]> {
  const out: Array<[Point2, Point2]> = [];
  const far = Math.hypot(size.width, size.height) * 4;
  for (const v of g.points) {
    // Aim the fan at the canvas: spread around the direction to its centre.
    const cx = size.width / 2 - v.x;
    const cy = size.height / 2 - v.y;
    const inside = v.x >= 0 && v.y >= 0 && v.x <= size.width && v.y <= size.height;
    const mid = Math.atan2(cy, cx);
    const spread = inside ? Math.PI : Math.min(Math.PI, 2 * Math.atan2(Math.hypot(size.width, size.height) / 2, Math.hypot(cx, cy)));
    for (let i = 0; i < count; i++) {
      const a = inside ? (2 * Math.PI * i) / count : mid - spread / 2 + (spread * (i + 0.5)) / count;
      out.push([{ ...v }, { x: v.x + Math.cos(a) * far, y: v.y + Math.sin(a) * far }]);
    }
  }
  return out;
}
