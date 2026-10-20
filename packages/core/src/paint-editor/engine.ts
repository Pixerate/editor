/**
 * The paint editor's dry-media stroke engine, on the shared brush engine (`@pixerate/editor/paint`):
 *
 * - Pen input: pressure, tilt (`tiltX` / `tiltY` or `altitude` / `azimuth`), barrel rotation
 *   (`twist`) and time (for velocity). Position and pressure are smoothed separately.
 * - `PenDabWalker` walks the points into the shared `Dab`s at `spacing × diameter`, with every
 *   pen channel interpolated, and applies the brush's dynamics, rotation mode and jitter.
 *   Jitter is a pure hash of the stroke seed and the dab index, so a stroke replays exactly.
 * - `DryStroke` rasterizes each dab with the shared round tip, multiplies it by how much of it the
 *   paper grain catches (`grainCatch`), and builds it up in the shared `CoverageMap`; the session
 *   then composites the coverage with the shared `applyStrokeToTile`.
 * - Symmetry: one stroke can paint several copies of its points (mirror and kaleidoscope), each
 *   with its own walker, into the same coverage, so the copies are one stroke and one undo step.
 *
 * Pure data in, pixels out: no DOM, no framework.
 */

import { CoverageMap, dabRect, rasterizeDab, type BrushSettings, type Dab, type StrokePoint } from '../paint/brush';
import type { RasterRect } from '../raster/surface';
import type { PaintBrush } from './brushes';
import { randSigned } from './noise';
import { grainCatch, type PaperGrain } from './paper';

/** One pen sample in document pixels. Every channel but x and y is optional. */
export interface PenPoint {
  x: number;
  y: number;
  /** 0..1 (missing: 1, a mouse). */
  pressure?: number;
  /** Milliseconds since any fixed origin (for velocity; missing: no velocity dynamics). */
  t?: number;
  /** Pointer Events tilt in degrees, -90..90 (used when `altitude` / `azimuth` are missing). */
  tiltX?: number;
  tiltY?: number;
  /** Radians from the surface: π/2 is upright, 0 lies flat. */
  altitude?: number;
  /** Radians clockwise from the +x axis (screen y points down): where the pen leans. */
  azimuth?: number;
  /** Barrel rotation in degrees clockwise, 0..359. */
  twist?: number;
}

/** A pen's lean as altitude and azimuth, or `null` when the sample has no tilt. */
export function penOrientation(p: PenPoint): { altitude: number; azimuth: number } | null {
  if (typeof p.altitude === 'number' && Number.isFinite(p.altitude)) {
    const altitude = Math.min(Math.PI / 2, Math.max(0, p.altitude));
    const azimuth = typeof p.azimuth === 'number' && Number.isFinite(p.azimuth) ? p.azimuth : 0;
    return { altitude, azimuth };
  }
  const hasX = typeof p.tiltX === 'number' && Number.isFinite(p.tiltX);
  const hasY = typeof p.tiltY === 'number' && Number.isFinite(p.tiltY);
  if (!hasX && !hasY) return null;
  return tiltToOrientation(hasX ? p.tiltX! : 0, hasY ? p.tiltY! : 0);
}

/** Pointer Events `tiltX` / `tiltY` (degrees) → altitude and azimuth (radians). */
export function tiltToOrientation(tiltX: number, tiltY: number): { altitude: number; azimuth: number } {
  const clampT = (v: number) => Math.min(89.999, Math.max(-89.999, v));
  const tx = Math.tan((clampT(tiltX) * Math.PI) / 180);
  const ty = Math.tan((clampT(tiltY) * Math.PI) / 180);
  const r = Math.hypot(tx, ty);
  if (r < 1e-9) return { altitude: Math.PI / 2, azimuth: 0 };
  let azimuth = Math.atan2(ty, tx);
  if (azimuth < 0) azimuth += 2 * Math.PI;
  return { altitude: Math.atan(1 / r), azimuth };
}

const pressureOf = (p: PenPoint) => (typeof p.pressure === 'number' && Number.isFinite(p.pressure) ? Math.min(1, Math.max(0, p.pressure)) : 1);

/**
 * Exponential smoothing of position and of pressure, each by its own amount (0..0.95). Feed raw
 * samples; the first sample passes through.
 */
export class PenSmoother {
  private pos: { x: number; y: number } | null = null;
  private pressure: number | null = null;
  private readonly a: number;
  private readonly ap: number;

  constructor(position: number, pressure: number) {
    this.a = 1 - Math.min(0.95, Math.max(0, position));
    this.ap = 1 - Math.min(0.95, Math.max(0, pressure));
  }

  push(p: PenPoint): PenPoint {
    const pr = pressureOf(p);
    if (!this.pos) {
      this.pos = { x: p.x, y: p.y };
      this.pressure = pr;
      return p;
    }
    this.pos = { x: this.pos.x + (p.x - this.pos.x) * this.a, y: this.pos.y + (p.y - this.pos.y) * this.a };
    this.pressure = this.pressure! + (pr - this.pressure!) * this.ap;
    return { ...p, x: this.pos.x, y: this.pos.y, pressure: this.pressure };
  }

  /** Where the smoothed position is now (or `null` before the first sample). */
  get position(): { x: number; y: number } | null {
    return this.pos;
  }
}

/** A linear map of document vectors `[a, b, c, d]`: (x, y) → (a·x + b·y, c·x + d·y). */
export type Linear2 = readonly [number, number, number, number];

/** How one copy of a stroke maps the input: a point map and its linear part (for dab angles). */
export interface StrokeCopy {
  map(p: PenPoint): PenPoint;
  linear: Linear2;
}

export const IDENTITY_COPY: StrokeCopy = { map: (p) => p, linear: [1, 0, 0, 1] };

/** A dab with the pen state it was made at (the shared `Dab` plus pressure for the grain). */
export interface PenDab extends Dab {
  pressure: number;
  /** Direction of travel at the dab, radians counter-clockwise with y up (as `angle`). */
  direction: number;
  /** The dab's index within its copy of the stroke (0, 1, 2 …). */
  index: number;
  /** Path length (px, along the smoothed samples of this copy) travelled to the dab: what gradient paint maps by distance. */
  travel: number;
  /** ms since the stroke's first timed sample, or `null` when the samples carry no time. */
  time: number | null;
  /** Pen lean, 0 upright .. 1 flat. */
  lean: number;
  /** Pen speed (px/ms), or `null` when the samples carry no time. */
  speed: number | null;
}

const enum Stream {
  Size = 1,
  Angle = 2,
  Opacity = 3,
  Scatter = 4,
}

interface Sample {
  x: number;
  y: number;
  pressure: number;
  lean: number;
  azimuth: number;
  twist: number | null;
  speed: number | null;
  /** Path length to this sample. */
  travel: number;
  /** ms since the first timed sample. */
  time: number | null;
}

/** Speed (px/ms) at which velocity dynamics reach their full effect. */
const FULL_SPEED = 2.5;

/**
 * Walks pen samples into dabs, incrementally (any chunking gives the same dabs). Dab angles are in
 * the shared rasterizer's convention: radians, counter-clockwise with y up.
 */
export class PenDabWalker {
  private last: Sample | null = null;
  private nextAt = 0;
  private pendingFirst: Sample | null = null;
  private index = 0;
  private dir = 0;
  private lastT: number | null = null;
  private firstT: number | null = null;
  private speed: number | null = null;
  private travelled = 0;

  constructor(
    readonly brush: PaintBrush,
    private readonly seed = 0,
    private readonly linear: Linear2 = [1, 0, 0, 1]
  ) {}

  private sample(p: PenPoint): Sample {
    const o = penOrientation(p);
    let speed: number | null = null;
    let time: number | null = null;
    if (this.last) this.travelled += Math.hypot(p.x - this.last.x, p.y - this.last.y);
    if (typeof p.t === 'number' && Number.isFinite(p.t)) {
      if (this.firstT === null) this.firstT = p.t;
      time = p.t - this.firstT;
      if (this.last && this.lastT !== null && p.t > this.lastT) {
        const v = Math.hypot(p.x - this.last.x, p.y - this.last.y) / (p.t - this.lastT);
        this.speed = this.speed === null ? v : this.speed + (v - this.speed) * 0.35;
      }
      this.lastT = p.t;
      speed = this.speed ?? 0;
    }
    return {
      x: p.x,
      y: p.y,
      pressure: pressureOf(p),
      lean: o ? 1 - o.altitude / (Math.PI / 2) : 0,
      azimuth: o ? o.azimuth : 0,
      twist: typeof p.twist === 'number' && Number.isFinite(p.twist) ? p.twist : null,
      speed,
      travel: this.travelled,
      time,
    };
  }

  private diameter(s: Sample): number {
    const tip = this.brush.tip;
    const dyn = this.brush.dynamics;
    let d = tip.size;
    if (tip.pressureSize) d *= dyn.minSize + (1 - dyn.minSize) * s.pressure;
    d *= 1 + dyn.tiltSize * s.lean * 1.5;
    if (s.speed !== null && dyn.velocitySize) d *= Math.max(0.05, 1 + dyn.velocitySize * Math.min(1, s.speed / FULL_SPEED) * (dyn.velocitySize < 0 ? 0.85 : 1));
    return d;
  }

  private stepLen(s: Sample): number {
    return Math.max(0.5, Math.max(1, this.diameter(s)) * Math.max(0.01, this.brush.tip.spacing));
  }

  /** A rasterizer angle (CCW, y up) mapped through this copy's linear part. */
  private mapAngle(theta: number): number {
    const [a, b, c, d] = this.linear;
    if (a === 1 && b === 0 && c === 0 && d === 1) return theta;
    const vx = Math.cos(theta);
    const vy = -Math.sin(theta);
    return Math.atan2(-(c * vx + d * vy), a * vx + b * vy);
  }

  private dab(s: Sample): PenDab {
    const { tip, dynamics: dyn, rotation } = this.brush;
    const i = this.index++;
    const seed = this.seed;
    let diameter = this.diameter(s);
    if (dyn.sizeJitter) diameter *= Math.max(0.05, 1 + dyn.sizeJitter * randSigned(seed, i, Stream.Size));
    const base = (tip.angle * Math.PI) / 180;
    let angle: number;
    if (rotation === 'stroke') angle = this.dir + base;
    else if (rotation === 'barrel' && s.twist !== null) angle = this.mapAngle(base - (s.twist * Math.PI) / 180);
    else if (dyn.tiltRoundness > 0 && s.lean > 0.02) angle = this.mapAngle(base - s.azimuth);
    else angle = this.mapAngle(base);
    if (dyn.angleJitter) angle += dyn.angleJitter * Math.PI * randSigned(seed, i, Stream.Angle);
    let opacity = tip.pressureOpacity ? s.pressure : 1;
    opacity *= 1 - dyn.tiltOpacity * s.lean * 0.8;
    if (s.speed !== null && dyn.velocityOpacity) opacity *= Math.max(0, 1 + dyn.velocityOpacity * (Math.min(1, s.speed / FULL_SPEED) - 0.5));
    if (dyn.opacityJitter) opacity *= 1 - dyn.opacityJitter * (randSigned(seed, i, Stream.Opacity) * 0.5 + 0.5);
    const flow = tip.flow * (1 - dyn.pressureFlow + dyn.pressureFlow * s.pressure);
    let { x, y } = s;
    if (dyn.scatter) {
      const off = dyn.scatter * diameter * randSigned(seed, i, Stream.Scatter);
      // Across the stroke: the direction of travel turned a quarter (document y points down).
      x += Math.sin(this.dir) * off;
      y += Math.cos(this.dir) * off;
    }
    return {
      x,
      y,
      radius: Math.max(0.5, diameter / 2),
      alpha: Math.min(1, Math.max(0, flow)),
      opacity: Math.min(1, Math.max(0, opacity)),
      angle,
      roundness: Math.min(1, Math.max(0.01, tip.roundness * (1 - dyn.tiltRoundness * s.lean * 0.8))),
      pressure: s.pressure,
      direction: this.dir,
      index: i,
      travel: s.travel,
      time: s.time,
      lean: s.lean,
      speed: s.speed,
    };
  }

  push(p: PenPoint, out: PenDab[]): void {
    const a = this.last;
    const s = this.sample(p);
    if (!a) {
      this.last = s;
      this.pendingFirst = s;
      this.nextAt = this.stepLen(s);
      return;
    }
    const dx = s.x - a.x;
    const dy = s.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len > 1e-9) this.dir = Math.atan2(-dy, dx);
    if (this.pendingFirst) {
      out.push(this.dab(this.pendingFirst));
      this.pendingFirst = null;
    }
    if (len > 1e-9) {
      while (this.nextAt <= len + 1e-9) {
        const f = Math.min(1, this.nextAt / len);
        const lerp = (u: number, v: number) => u + (v - u) * f;
        const q: Sample = {
          x: a.x + dx * f,
          y: a.y + dy * f,
          pressure: lerp(a.pressure, s.pressure),
          lean: lerp(a.lean, s.lean),
          azimuth: lerpAngle(a.azimuth, s.azimuth, f),
          twist: a.twist !== null && s.twist !== null ? lerpDegrees(a.twist, s.twist, f) : s.twist,
          speed: a.speed !== null && s.speed !== null ? lerp(a.speed, s.speed) : s.speed,
          travel: a.travel + this.nextAt,
          time: a.time !== null && s.time !== null ? lerp(a.time, s.time) : s.time,
        };
        out.push(this.dab(q));
        this.nextAt += this.stepLen(q);
      }
      this.nextAt -= len;
    }
    this.last = s;
  }

  finish(out: PenDab[]): void {
    if (this.pendingFirst) {
      out.push(this.dab(this.pendingFirst));
      this.pendingFirst = null;
    }
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

function lerpDegrees(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return a + d * t;
}

export interface DryStrokeOptions {
  /** The paper's dry height field, or `null` for no grain. */
  grain: PaperGrain | null;
  /** The paper's grain depth, 0..1 (multiplied by the brush's grain response). */
  paperDepth: number;
  /** Jitter seed (record it to replay the stroke exactly). */
  seed?: number;
  /** Copies of the stroke (symmetry); default one identity copy. */
  copies?: readonly StrokeCopy[];
}

/**
 * One dab-engine stroke (dab and eraser brushes): smoothing, the dab walk of every copy, grain and
 * build-up in a shared coverage map.
 */
export class DryStroke {
  readonly coverage = new CoverageMap();
  dabCount = 0;
  private readonly smoother: PenSmoother;
  private readonly walkers: PenDabWalker[];
  private readonly copies: readonly StrokeCopy[];
  private readonly depth: number;
  private buf = new Float32Array(0);
  private lastRaw: PenPoint | null = null;
  private lastFed: PenPoint | null = null;

  constructor(readonly brush: PaintBrush, private readonly options: DryStrokeOptions) {
    this.smoother = new PenSmoother(brush.tip.smoothing, brush.pressureSmoothing);
    this.copies = options.copies?.length ? options.copies : [IDENTITY_COPY];
    this.walkers = this.copies.map((c, i) => new PenDabWalker(brush, ((options.seed ?? 0) + i * 7919) | 0, c.linear));
    this.depth = options.grain && !options.grain.flat ? Math.min(1, Math.max(0, options.paperDepth * brush.grain)) : 0;
  }

  /** Feeds raw pen samples; returns the document rectangles the new dabs touched. */
  push(points: readonly PenPoint[]): RasterRect[] {
    const dabs: PenDab[] = [];
    for (const raw of points) {
      this.lastRaw = raw;
      const p = this.smoother.push(raw);
      this.lastFed = p;
      this.copies.forEach((c, i) => this.walkers[i].push(c.map(p), dabs));
    }
    return this.paint(dabs);
  }

  /** Ends the stroke: the smoothed path catches up with the last raw sample; a single tap paints one dab. */
  finish(): RasterRect[] {
    const dabs: PenDab[] = [];
    const raw = this.lastRaw;
    const fed = this.lastFed;
    if (raw && fed && (raw.x !== fed.x || raw.y !== fed.y)) this.copies.forEach((c, i) => this.walkers[i].push(c.map({ ...raw, pressure: fed.pressure }), dabs));
    for (const w of this.walkers) w.finish(dabs);
    return this.paint(dabs);
  }

  private paint(dabs: PenDab[]): RasterRect[] {
    const rects: RasterRect[] = [];
    const hardness = this.brush.tip.hardness;
    const grain = this.options.grain;
    for (const d of dabs) {
      const rect = dabRect(d, hardness);
      const n = rect.width * rect.height;
      if (this.buf.length < n) this.buf = new Float32Array(n);
      const vals = this.buf.subarray(0, n);
      rasterizeDab(d, hardness, rect, vals);
      if (this.depth > 0 && grain) {
        for (let yy = 0, k = 0; yy < rect.height; yy++) {
          const y = rect.y + yy + 0.5;
          for (let xx = 0; xx < rect.width; xx++, k++) {
            if (vals[k] > 0) vals[k] *= grainCatch(grain.at(rect.x + xx + 0.5, y), this.depth, d.pressure);
          }
        }
      }
      this.coverage.accumulate(rect, vals, d.opacity);
      rects.push(rect);
      this.dabCount++;
    }
    return rects;
  }
}

/** The shared engine's tip for the Mixer Brush engine (it smooths and walks by itself, so smoothing is applied before). */
export function mixerTip(brush: PaintBrush): BrushSettings {
  return { ...brush.tip, smoothing: 0, pressureSize: brush.tip.pressureSize };
}

/** Pen samples → the shared engine's stroke points (pressure only). */
export function toStrokePoint(p: PenPoint): StrokePoint {
  return { x: p.x, y: p.y, pressure: pressureOf(p), ...(typeof p.t === 'number' ? { t: p.t } : {}) };
}
