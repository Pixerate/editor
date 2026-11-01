/**
 * Procedural brush engines: marks made by small simulations driven by the pen, rather than by
 * stamping the tip.
 *
 * - **Particle brushes** (`engine: 'particle'`): a handful of particles follow the pen by their own
 *   rules. `string`: strands of masses on springs, dragged behind the pen like hair or wet string;
 *   `spring`: each particle tied to the pen by a spring, overshooting and wobbling; `orbit`:
 *   particles circling the pen (spirograph curls); `flow`: particles thrown off the pen and carried
 *   by a swirling flow field until they fade. Each is drawn as `dot`s, a continuous `line`, or a
 *   `sequence` of beads spaced along its path.
 * - **Bristle brushes** (`engine: 'bristle'`): a tuft of bristles, each its own thin line. Pressure
 *   splays the tuft, tilt flattens it, and bristles lag behind the tip by their stiffness, so they
 *   bend into curves at turns; each bristle carries its own paint and runs dry at its own pace, so
 *   long strokes break into dry-brush streaks.
 *
 * Both are deterministic (seeded) and step the simulation by distance travelled, not by how the
 * input was sampled, so a replay paints the same marks. They build up a `CoverageMap` like the dab
 * engine, so opacity, blend modes, locks, stencils and symmetry work as for any dry brush.
 */

import { CoverageMap, dabRect, rasterizeDab, TIP_GRADIENT_STEPS, type Dab } from '../paint/brush';
import { PaintGradientSampler, type PaintGradientSample, type PaintGradientSource } from '../paint/gradient-paint';
import type { RasterRect } from '../raster/surface';
import type { PaintBrush } from './brushes';
import { sampleEffectField, type EffectPaintPixels } from './effect-paint';
import { IDENTITY_COPY, PenDabWalker, PenSmoother, type PenDab, type PenPoint, type StrokeCopy } from './engine';
import { rand01 } from './noise';
import { grainCatch, type PaperGrain } from './paper';

export interface ProceduralStrokeOptions {
  grain: PaperGrain | null;
  paperDepth: number;
  seed?: number;
  copies?: readonly StrokeCopy[];
  /** Gradient paint (resolved): each mark takes the colour of the pen dab that made it. */
  paint?: PaintGradientSource | null;
  /** Effect paint: each pixel of a mark takes its colour (and alpha) from these canvas-sized pixels. */
  effect?: EffectPaintPixels | null;
}

/** What a coverage-building stroke engine provides to the stroke session. */
export interface CoverageStroke {
  readonly coverage: CoverageMap;
  dabCount: number;
  push(points: readonly PenPoint[]): RasterRect[];
  finish(): RasterRect[];
}

/** Pixels of pen travel per simulation step. */
const STEP_PX = 1.5;

/** Shared plumbing: smoothing, the dab walk per copy (for size, pressure, direction), grain, and stamping marks. */
abstract class MarkStroke implements CoverageStroke {
  readonly coverage = new CoverageMap();
  dabCount = 0;
  protected readonly smoother: PenSmoother;
  protected readonly copies: readonly StrokeCopy[];
  protected readonly walkers: PenDabWalker[];
  protected readonly depth: number;
  private buf = new Float32Array(0);
  private field = new Float32Array(0);
  private lastRaw: PenPoint | null = null;
  private lastFed: PenPoint | null = null;
  protected readonly seed: number;
  private readonly sampler: PaintGradientSampler | null;
  private readonly tipTable: PaintGradientSample[] | null;
  /** The pen dab the marks being made belong to, and its gradient colour. */
  private pen: PenDab | null = null;
  private penColor: PaintGradientSample = { rgb: [0, 0, 0], alpha: 1 };

  constructor(
    readonly brush: PaintBrush,
    protected readonly options: ProceduralStrokeOptions
  ) {
    this.sampler = options.paint ? new PaintGradientSampler(options.paint, options.seed ?? 0) : null;
    this.tipTable = this.sampler?.acrossTip ? this.sampler.tipTable(TIP_GRADIENT_STEPS) : null;
    this.smoother = new PenSmoother(brush.tip.smoothing, brush.pressureSmoothing);
    this.copies = options.copies?.length ? options.copies : [IDENTITY_COPY];
    this.seed = options.seed ?? 0;
    // A fine walk (spacing a fraction of the tip): each walked dab is a simulation input.
    const fine: PaintBrush = { ...brush, tip: { ...brush.tip, spacing: Math.max(0.01, Math.min(0.25, STEP_PX / Math.max(1, brush.tip.size))) } };
    this.walkers = this.copies.map((c, i) => new PenDabWalker(fine, ((options.seed ?? 0) + i * 7919) | 0, c.linear));
    this.depth = options.grain && !options.grain.flat ? Math.min(1, Math.max(0, options.paperDepth * brush.grain)) : 0;
  }

  push(points: readonly PenPoint[]): RasterRect[] {
    const rects: RasterRect[] = [];
    for (const raw of points) {
      this.lastRaw = raw;
      const p = this.smoother.push(raw);
      this.lastFed = p;
      this.copies.forEach((c, i) => {
        const dabs: PenDab[] = [];
        this.walkers[i].push(c.map(p), dabs);
        for (const d of dabs) this.step(i, d, rects);
      });
    }
    return rects;
  }

  private step(copy: number, d: PenDab, rects: RasterRect[]): void {
    if (this.sampler) {
      this.pen = d;
      if (!this.tipTable) this.sampler.dab(d, this.penColor);
    }
    this.advance(copy, d, rects);
  }

  /** The colour of a mark at (x, y): its pen dab's, or across the tip by its offset from the pen. */
  private markColor(x: number, y: number): PaintGradientSample | null {
    if (!this.sampler || !this.pen) return null;
    if (!this.tipTable) return this.penColor;
    const d = this.pen;
    const u = ((x - d.x) * Math.sin(d.direction) + (y - d.y) * Math.cos(d.direction)) / Math.max(0.5, d.radius);
    const last = this.tipTable.length - 1;
    return this.tipTable[Math.min(last, Math.max(0, Math.round(((u + 1) / 2) * last)))];
  }

  finish(): RasterRect[] {
    const rects: RasterRect[] = [];
    const raw = this.lastRaw;
    const fed = this.lastFed;
    this.copies.forEach((c, i) => {
      const dabs: PenDab[] = [];
      if (raw && fed && (raw.x !== fed.x || raw.y !== fed.y)) this.walkers[i].push(c.map({ ...raw, pressure: fed.pressure }), dabs);
      this.walkers[i].finish(dabs);
      for (const d of dabs) this.step(i, d, rects);
    });
    return rects;
  }

  /** One simulation step of copy `copy` with the pen at dab `d`. */
  protected abstract advance(copy: number, d: PenDab, rects: RasterRect[]): void;

  /** Stamps one round mark of radius `r` at (x, y) with flow `alpha` towards `opacity`. */
  protected mark(x: number, y: number, r: number, alpha: number, opacity: number, pressure: number, rects: RasterRect[]): void {
    if (!(r > 0.05) || !(alpha > 0)) return;
    const dab: Dab = { x, y, radius: Math.max(0.5, r), alpha: Math.min(1, alpha), opacity: Math.min(1, opacity), angle: 0, roundness: 1 };
    const hardness = this.brush.tip.hardness;
    const rect = dabRect(dab, hardness);
    const n = rect.width * rect.height;
    if (n <= 0) return;
    if (this.buf.length < n) this.buf = new Float32Array(n);
    const vals = this.buf.subarray(0, n);
    rasterizeDab(dab, hardness, rect, vals);
    const grain = this.options.grain;
    if (this.depth > 0 && grain) {
      for (let yy = 0, k = 0; yy < rect.height; yy++)
        for (let xx = 0; xx < rect.width; xx++, k++) if (vals[k] > 0) vals[k] *= grainCatch(grain.at(rect.x + xx + 0.5, rect.y + yy + 0.5), this.depth, pressure);
    }
    if (this.options.effect) {
      if (this.field.length < n * 3) this.field = new Float32Array(n * 3);
      const field = this.field.subarray(0, n * 3);
      sampleEffectField(this.options.effect, rect, vals, field);
      this.coverage.accumulate(rect, vals, dab.opacity, null, field);
    } else {
      const color = this.markColor(x, y);
      if (color && color.alpha < 1) for (let k = 0; k < n; k++) vals[k] *= color.alpha;
      this.coverage.accumulate(rect, vals, dab.opacity, color ? color.rgb : null);
    }
    rects.push(rect);
    this.dabCount++;
  }

  /** Marks along a segment, spaced by a fraction of the radius. */
  protected segment(x0: number, y0: number, x1: number, y1: number, r: number, alpha: number, opacity: number, pressure: number, rects: RasterRect[]): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const step = Math.max(0.35, r * 0.5);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 1; i <= n; i++) this.mark(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, r, alpha, opacity, pressure, rects);
  }
}

// ---------------------------------------------------------------------------
// Particle brushes
// ---------------------------------------------------------------------------

export type ParticleKind = 'string' | 'spring' | 'orbit' | 'flow';
export const PARTICLE_KINDS: readonly ParticleKind[] = ['string', 'spring', 'orbit', 'flow'];
export type ParticleRender = 'dot' | 'line' | 'sequence';
export const PARTICLE_RENDERS: readonly ParticleRender[] = ['dot', 'line', 'sequence'];

/** Particle engine settings (each 0..1 unless noted). */
export interface ParticleSettings {
  kind: ParticleKind;
  render: ParticleRender;
  /** Particles, 1..64. */
  count: number;
  /** Mark size as a fraction of the tip size. */
  size: number;
  /** How far apart the particles start, as a fraction of the tip size. */
  spread: number;
  /** Spring and string stiffness (stiff follows closely; soft swings wide). */
  stiffness: number;
  /** How quickly motion dies down. */
  damping: number;
  /** Orbit and flow speed. */
  speed: number;
  /** Pull downwards (−1 up .. 1 down). */
  gravity: number;
  /** Flow particles' lifetime. */
  life: number;
  /** Sequence: spacing of the beads along each path. */
  interval: number;
}

export const DEFAULT_PARTICLE: Readonly<ParticleSettings> = { kind: 'spring', render: 'line', count: 12, size: 0.08, spread: 0.5, stiffness: 0.4, damping: 0.25, speed: 0.5, gravity: 0, life: 0.5, interval: 0.3 };

const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

export function normalizeParticle(raw: Partial<ParticleSettings> = {}, base: ParticleSettings = DEFAULT_PARTICLE): ParticleSettings {
  return {
    kind: PARTICLE_KINDS.includes(raw.kind as ParticleKind) ? (raw.kind as ParticleKind) : base.kind,
    render: PARTICLE_RENDERS.includes(raw.render as ParticleRender) ? (raw.render as ParticleRender) : base.render,
    count: typeof raw.count === 'number' && Number.isFinite(raw.count) ? Math.min(64, Math.max(1, Math.round(raw.count))) : base.count,
    size: unit(raw.size, base.size),
    spread: unit(raw.spread, base.spread),
    stiffness: unit(raw.stiffness, base.stiffness),
    damping: unit(raw.damping, base.damping),
    speed: unit(raw.speed, base.speed),
    gravity: typeof raw.gravity === 'number' && Number.isFinite(raw.gravity) ? Math.min(1, Math.max(-1, raw.gravity)) : base.gravity,
    life: unit(raw.life, base.life),
    interval: unit(raw.interval, base.interval),
  };
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Rest offset from the pen (spring) or orbit radius and phase. */
  ox: number;
  oy: number;
  k: number;
  phase: number;
  age: number;
  /** Distance travelled since the last bead (sequence). */
  run: number;
  bead: number;
  alive: boolean;
  /** string: the masses of the strand, pen end first. */
  strand?: Array<{ x: number; y: number; vx: number; vy: number }>;
}

/** Curl of a value-noise field (a swirling, divergence-free flow), deterministic. */
function curl(x: number, y: number, seed: number): [number, number] {
  const n = (u: number, v: number) => {
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const h = (a: number, b: number) => rand01(seed, a * 73856093 + b * 19349663, 41);
    const a = h(x0, y0);
    const b = h(x0 + 1, y0);
    const c = h(x0, y0 + 1);
    const d = h(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  const e = 0.01;
  return [(n(x, y + e) - n(x, y - e)) / (2 * e), -(n(x + e, y) - n(x - e, y)) / (2 * e)];
}

/** A particle-brush stroke. */
export class ParticleStroke extends MarkStroke {
  private readonly sets: Particle[][];
  private readonly s: ParticleSettings;
  private spawn = 0;

  constructor(brush: PaintBrush, options: ProceduralStrokeOptions) {
    super(brush, options);
    this.s = brush.particle;
    this.sets = this.copies.map(() => []);
  }

  private init(copy: number, d: PenDab): void {
    const s = this.s;
    const list = this.sets[copy];
    const size = Math.max(1, d.radius * 2);
    for (let i = 0; i < (s.kind === 'flow' ? 0 : s.count); i++) {
      const r = rand01(this.seed, i, 3 + copy) * s.spread * size * 0.5;
      const a = rand01(this.seed, i, 5 + copy) * Math.PI * 2;
      const ox = Math.cos(a) * r;
      const oy = Math.sin(a) * r;
      const p: Particle = { x: d.x + ox, y: d.y + oy, vx: 0, vy: 0, ox, oy, k: 0.6 + 0.8 * rand01(this.seed, i, 7), phase: a, age: 0, run: 0, bead: 0, alive: true };
      if (s.kind === 'string') p.strand = Array.from({ length: 6 }, () => ({ x: d.x + ox, y: d.y + oy, vx: 0, vy: 0 }));
      if (s.kind === 'orbit') {
        p.ox = Math.max(1, r + size * 0.15);
        p.oy = 0;
      }
      list.push(p);
    }
  }

  protected advance(copy: number, d: PenDab, rects: RasterRect[]): void {
    const s = this.s;
    const list = this.sets[copy];
    if (d.index === 0 && !list.length) this.init(copy, d);
    const size = Math.max(1, d.radius * 2);
    const markR = Math.max(0.5, (size * s.size) / 2);
    const k = 0.02 + 0.3 * s.stiffness;
    const damp = 0.6 + 0.38 * (1 - s.damping);
    const g = s.gravity * 0.15;
    const op = d.opacity;
    const al = Math.max(0.05, d.alpha);
    if (s.kind === 'flow') {
      // Throw off particles at the pen while it moves.
      this.spawn += s.count / 8;
      while (this.spawn >= 1) {
        this.spawn -= 1;
        const i = this.dabCount + list.length * 31 + Math.floor(d.index);
        const a = rand01(this.seed, i, 11 + copy) * Math.PI * 2;
        const r = rand01(this.seed, i, 13 + copy) * s.spread * size * 0.5;
        list.push({ x: d.x + Math.cos(a) * r, y: d.y + Math.sin(a) * r, vx: 0, vy: 0, ox: 0, oy: 0, k: 1, phase: a, age: 0, run: 0, bead: 0, alive: true });
      }
    }
    const lifeSteps = 8 + 120 * s.life;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.alive) continue;
      const px = p.x;
      const py = p.y;
      switch (s.kind) {
        case 'spring': {
          p.vx = (p.vx + (d.x + p.ox - p.x) * k * p.k) * damp;
          p.vy = (p.vy + (d.y + p.oy - p.y) * k * p.k + g) * damp;
          p.x += p.vx;
          p.y += p.vy;
          break;
        }
        case 'string': {
          // A strand of masses: the first tied to the pen, each to the one before.
          const strand = p.strand!;
          let ax = d.x + p.ox;
          let ay = d.y + p.oy;
          for (const m of strand) {
            m.vx = (m.vx + (ax - m.x) * k * p.k + 0) * damp;
            m.vy = (m.vy + (ay - m.y) * k * p.k + g) * damp;
            m.x += m.vx;
            m.y += m.vy;
            ax = m.x;
            ay = m.y;
          }
          p.x = strand[strand.length - 1].x;
          p.y = strand[strand.length - 1].y;
          break;
        }
        case 'orbit': {
          p.phase += (0.05 + 0.3 * s.speed) * (i % 2 ? -1 : 1) * (0.7 + 0.6 * rand01(this.seed, i, 17));
          p.x = d.x + Math.cos(p.phase) * p.ox;
          p.y = d.y + Math.sin(p.phase) * p.ox + g * p.ox;
          break;
        }
        case 'flow': {
          // The field's slope is about 1 per field cell; the push is a small fraction of the tip per step.
          const [fx, fy] = curl(p.x / Math.max(8, size * 1.5), p.y / Math.max(8, size * 1.5), this.seed);
          const push = size * 0.012 * (0.3 + 1.5 * s.speed);
          const fl = Math.hypot(fx, fy) || 1;
          p.vx = p.vx * 0.8 + (fx / fl) * push;
          p.vy = p.vy * 0.8 + (fy / fl) * push + g * 0.2;
          p.x += p.vx;
          p.y += p.vy;
          p.age++;
          if (p.age > lifeSteps) p.alive = false;
          break;
        }
      }
      const fade = s.kind === 'flow' ? 1 - p.age / lifeSteps : 1;
      const moved = Math.hypot(p.x - px, p.y - py);
      if (d.index === 0 && s.kind !== 'flow') continue;
      if (s.render === 'dot') this.mark(p.x, p.y, markR * fade, al * fade, op, d.pressure, rects);
      else if (s.render === 'line') this.segment(px, py, p.x, p.y, markR * fade, al * fade, op, d.pressure, rects);
      else {
        // Beads along the path, each a little larger in the middle of its run.
        p.run += moved;
        const gap = Math.max(markR * 2, size * (0.05 + s.interval));
        while (p.run >= gap) {
          p.run -= gap;
          p.bead++;
          const t = moved > 0 ? 1 - p.run / Math.max(moved, 1e-6) : 1;
          const bx = px + (p.x - px) * Math.min(1, Math.max(0, t));
          const by = py + (p.y - py) * Math.min(1, Math.max(0, t));
          this.mark(bx, by, markR * (0.7 + 0.6 * ((p.bead % 3) / 2)) * fade, al * fade, op, d.pressure, rects);
        }
      }
    }
    if (s.kind === 'flow' && list.length > 512) this.sets[copy] = list.filter((p) => p.alive);
  }
}

// ---------------------------------------------------------------------------
// Bristle brushes
// ---------------------------------------------------------------------------

/** Bristle engine settings (each 0..1 unless noted). */
export interface BristleSettings {
  /** Bristles in the tuft, 3..128. */
  count: number;
  /** Stiff bristles follow the tip; soft ones lag and bend into curves at turns. */
  stiffness: number;
  /** How far pressure spreads the tuft. */
  splay: number;
  /** Width of each bristle's line as a fraction of the tip size. */
  thickness: number;
  /** Paint per bristle: 1 never runs dry; lower, bristles run out along the stroke (dry brush). */
  load: number;
  /** Random variation between bristles (length, paint, position). */
  jitter: number;
}

export const DEFAULT_BRISTLE: Readonly<BristleSettings> = { count: 32, stiffness: 0.5, splay: 0.5, thickness: 0.06, load: 0.6, jitter: 0.4 };

export function normalizeBristle(raw: Partial<BristleSettings> = {}, base: BristleSettings = DEFAULT_BRISTLE): BristleSettings {
  return {
    count: typeof raw.count === 'number' && Number.isFinite(raw.count) ? Math.min(128, Math.max(3, Math.round(raw.count))) : base.count,
    stiffness: unit(raw.stiffness, base.stiffness),
    splay: unit(raw.splay, base.splay),
    thickness: unit(raw.thickness, base.thickness),
    load: unit(raw.load, base.load),
    jitter: unit(raw.jitter, base.jitter),
  };
}

interface Bristle {
  /** Place in the tuft: across (−1..1) and along (−1..1) the tip. */
  u: number;
  v: number;
  x: number;
  y: number;
  paint: number;
  /** How fast it runs dry. */
  thirst: number;
  /** Extra width. */
  w: number;
  started: boolean;
}

/** A bristle-brush stroke: every bristle draws its own line. */
export class BristleStroke extends MarkStroke {
  private readonly tufts: Bristle[][];
  private readonly s: BristleSettings;

  constructor(brush: PaintBrush, options: ProceduralStrokeOptions) {
    super(brush, options);
    this.s = brush.bristle;
    const s = this.s;
    this.tufts = this.copies.map((_, c) =>
      Array.from({ length: s.count }, (_, i) => {
        // Spread over an ellipse, denser in the middle.
        const a = rand01(this.seed, i, 21 + c) * Math.PI * 2;
        const r = Math.sqrt(rand01(this.seed, i, 23 + c));
        return {
          u: Math.cos(a) * r,
          v: Math.sin(a) * r,
          x: 0,
          y: 0,
          paint: 1 - s.jitter * 0.4 * rand01(this.seed, i, 25 + c),
          thirst: 1 + s.jitter * (rand01(this.seed, i, 27 + c) * 2 - 1),
          w: 1 + s.jitter * 0.6 * (rand01(this.seed, i, 29 + c) - 0.5),
          started: false,
        };
      })
    );
  }

  protected advance(copy: number, d: PenDab, rects: RasterRect[]): void {
    const s = this.s;
    const tuft = this.tufts[copy];
    // Pressure splays the tuft; the tip's roundness and angle (tilt, rotation) shape it.
    const spread = d.radius * (0.55 + 0.9 * s.splay * d.pressure);
    const ca = Math.cos(d.angle);
    const sa = Math.sin(d.angle);
    const ro = Math.max(0.15, d.roundness);
    // Direction of travel (dab directions are counter-clockwise with y up).
    const tx = Math.cos(d.direction);
    const ty = -Math.sin(d.direction);
    const follow = 0.15 + 0.85 * s.stiffness;
    const bend = d.radius * (1 - s.stiffness) * d.pressure * 0.8;
    const lineR = Math.max(0.5, d.radius * 2 * s.thickness * 0.5);
    const dryRate = 0.004 * (1 - s.load);
    for (const b of tuft) {
      // Where the bristle wants to be: its place in the tuft (rotated with the tip, flattened by
      // tilt), bent back against the direction of travel by pressure.
      const lu = b.u * spread;
      const lv = b.v * spread * ro;
      const ox = lu * ca - lv * sa;
      const oy = -(lu * sa + lv * ca);
      const lag = bend * (1 - 0.5 * b.v);
      const wx = d.x + ox - tx * lag;
      const wy = d.y + oy - ty * lag;
      if (!b.started) {
        b.x = wx;
        b.y = wy;
        b.started = true;
        continue;
      }
      const nx = b.x + (wx - b.x) * follow;
      const ny = b.y + (wy - b.y) * follow;
      const paint = Math.max(0, b.paint);
      if (paint > 0.02) this.segment(b.x, b.y, nx, ny, lineR * b.w * (0.6 + 0.4 * d.pressure), d.alpha * Math.min(1, paint * 1.4), d.opacity, d.pressure, rects);
      b.paint -= dryRate * b.thirst * Math.hypot(nx - b.x, ny - b.y);
      b.x = nx;
      b.y = ny;
    }
  }
}
