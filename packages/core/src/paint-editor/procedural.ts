/**
 * Procedural brush engines: marks made by small simulations driven by the pen, rather than by
 * stamping the tip.
 *
 * - **Particle brushes** (`engine: 'particle'`): a handful of particles follow the pen by their own
 *   rules. `string`: strands of masses on springs, dragged behind the pen like hair or wet string;
 *   `spring`: each particle tied to the pen by a spring, overshooting and wobbling; `orbit`:
 *   particles circling the pen (spirograph curls); `flow`: particles thrown off the pen and carried
 *   by a swirling flow field until they fade; `elastic`: strands whose masses keep a rest length,
 *   stretching when the pen is fast and snapping back; `fuzzy`: strings that wind, each strand
 *   waving out of step with the others. Each is drawn as `dot`s (round, or stamped with up to four
 *   textures), a continuous `line`, a `sequence` of beads spaced along its path, or a `ribbon`:
 *   the area between neighbouring particles' paths filled, with their paths as its edges. Any kind
 *   can wave: each particle's drawn place moves sideways on a sine along the pen's path.
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
import { TILE, tileKey, type RasterRect, type TileKey } from '../raster/surface';
import type { PaintBrush } from './brushes';
import { sampleEffectField, type EffectPaintPixels } from './effect-paint';
import { IDENTITY_COPY, PenDabWalker, PenSmoother, type PenDab, type PenPoint, type StrokeCopy } from './engine';
import { rand01 } from './noise';
import { grainCatch, type PaperGrain } from './paper';
import { stampSampler } from './stamp-tip';
import type { StickerArtLookup } from './sticker-art';
import type { BristleSettings, ParticleSettings, StampKind } from './mark-settings';

export {
  DEFAULT_BRISTLE,
  DEFAULT_PARTICLE,
  DOT_ROTATIONS,
  DOT_TEXTURE_ORDERS,
  MAX_DOT_TEXTURES,
  normalizeBristle,
  normalizeParticle,
  PARTICLE_KINDS,
  PARTICLE_RENDERS,
  RIBBON_PAIRS,
  type BristleSettings,
  type DotRotation,
  type DotTextureOrder,
  type ParticleKind,
  type ParticleRender,
  type ParticleSettings,
  type RibbonPairs,
} from './mark-settings';

export interface ProceduralStrokeOptions {
  grain: PaperGrain | null;
  paperDepth: number;
  seed?: number;
  copies?: readonly StrokeCopy[];
  /** Gradient paint (resolved): each mark takes the colour of the pen dab that made it. */
  paint?: PaintGradientSource | null;
  /** Effect paint: each pixel of a mark takes its colour (and alpha) from these canvas-sized pixels. */
  effect?: EffectPaintPixels | null;
  /** Loaded sticker art, for textured dots of stickers from the sticker library. */
  stampArt?: StickerArtLookup;
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
    // Marks take their place along the stroke (gradient paint across the tip, stroke-mapped effects) from their pen dab.
    this.pen = d;
    if (this.sampler && !this.tipTable) this.sampler.dab(d, this.penColor);
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
    const vals = this.scratch(n);
    rasterizeDab(dab, hardness, rect, vals);
    this.lay(rect, vals, dab.opacity, pressure, x, y, rects);
  }

  /**
   * Stamps a textured mark: `kind` from the sticker stamps over a square of half-size `r`, turned
   * `rotation` radians clockwise, with flow `alpha` towards `opacity`. Small marks are supersampled.
   */
  protected stamp(x: number, y: number, r: number, kind: string, rotation: number, seed: number, alpha: number, opacity: number, pressure: number, rects: RasterRect[]): void {
    if (!(r > 0.05) || !(alpha > 0)) return;
    // An editor stamp, or a library sticker's loaded art (its alpha); round while the art is not loaded.
    const sample = stampSampler(kind, this.options.stampArt);
    if (!sample) return this.mark(x, y, r, alpha, opacity, pressure, rects);
    const reach = Math.max(0.5, r) * Math.SQRT2 + 1;
    const rect: RasterRect = { x: Math.floor(x - reach), y: Math.floor(y - reach), width: 0, height: 0 };
    rect.width = Math.ceil(x + reach) - rect.x;
    rect.height = Math.ceil(y + reach) - rect.y;
    const n = rect.width * rect.height;
    const vals = this.scratch(n);
    const ss = r < 10 ? 3 : 1;
    const c = Math.cos(rotation);
    const s = Math.sin(rotation);
    const inv = 1 / Math.max(0.5, r);
    const a = Math.min(1, alpha);
    for (let yy = 0, k = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < rect.width; xx++, k++) {
        let sum = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const dx = rect.x + xx + (sx + 0.5) / ss - x;
            const dy = rect.y + yy + (sy + 0.5) / ss - y;
            // Into the stamp's square: undo the turn (clockwise on screen, y down).
            sum += sample((dx * c + dy * s) * inv, (dy * c - dx * s) * inv, seed);
          }
        }
        vals[k] = (sum / (ss * ss)) * a;
      }
    }
    this.lay(rect, vals, Math.min(1, opacity), pressure, x, y, rects);
  }

  /** A scratch buffer of `n` values (reused; valid until the next mark). */
  protected scratch(n: number): Float32Array {
    if (this.buf.length < n) this.buf = new Float32Array(n);
    const vals = this.buf.subarray(0, n);
    vals.fill(0);
    return vals;
  }

  /**
   * Lays coverage `vals` over `rect` towards `opacity`: paper grain, then effect paint or the
   * colour of a mark at (x, y) (gradient paint), into the stroke's coverage.
   */
  protected lay(rect: RasterRect, vals: Float32Array, opacity: number, pressure: number, x: number, y: number, rects: RasterRect[]): void {
    const n = rect.width * rect.height;
    if (n <= 0) return;
    const grain = this.options.grain;
    if (this.depth > 0 && grain) {
      for (let yy = 0, k = 0; yy < rect.height; yy++)
        for (let xx = 0; xx < rect.width; xx++, k++) if (vals[k] > 0) vals[k] *= grainCatch(grain.at(rect.x + xx + 0.5, rect.y + yy + 0.5), this.depth, pressure);
    }
    if (this.options.effect) {
      if (this.field.length < n * 3) this.field = new Float32Array(n * 3);
      const field = this.field.subarray(0, n * 3);
      sampleEffectField(this.options.effect, rect, vals, field, this.pen);
      this.coverage.accumulate(rect, vals, opacity, null, field);
    } else {
      const color = this.markColor(x, y);
      if (color && color.alpha < 1) for (let k = 0; k < n; k++) vals[k] *= color.alpha;
      this.coverage.accumulate(rect, vals, opacity, color ? color.rgb : null);
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


/** Fuzzy strands always wave, by at least this fraction of the tip size. */
const FUZZY_AMPLITUDE = 0.12;
/** Ms of travel per px for strokes without times (the wave runs as if the pen moved at 0.5 px/ms). */
const NOMINAL_MS_PER_PX = 2;
/** Ribbon fill: sub-rows per pixel row (coverage is exact across each sub-row). */
const RIBBON_SUB = 4;

/**
 * Velocity kept per step by a mass in a strand with spring `k`: at most a little under critical
 * damping (critical is 1 / (1 + √k)² for this update). Each mass chases the one before it, so the
 * strand is a chain of springs; lightly damped, each link resonates and the chain multiplies it
 * until the strand flies apart. Used by the elastic and fuzzy kinds (string keeps its old motion).
 */
function chainDamp(damp: number, k: number): number {
  return Math.min(damp, 1 / (1 + 0.8 * Math.sqrt(Math.max(0, k))) ** 2);
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
  /** string, elastic, fuzzy: the masses of the strand, pen end first. */
  strand?: Array<{ x: number; y: number; vx: number; vy: number }>;
  /** Wave: this particle's phase (radians) and wavelength factor. */
  wavePhase: number;
  waveScale: number;
  /** Where it was last drawn (its place plus its wave); where it started before that. */
  dx: number;
  dy: number;
  /** Where it was drawn before that step (ribbons join these to the new places). */
  px: number;
  py: number;
  /** Fade when last drawn (flow). */
  fade: number;
}

/**
 * Adds the area polygon `pts` (x, y pairs, even-odd) covers in each pixel of `rect`, times `weight`, to `out`,
 * exactly across each of `RIBBON_SUB` sub-rows per row. Points on an edge two polygons share
 * count for exactly one of them, so polygons that tile a region add up to it with no seams.
 */
export function addPolygonArea(pts: readonly number[], rect: RasterRect, out: Float32Array, weight = 1): void {
  const n = pts.length >> 1;
  if (n < 3) return;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 1; i < pts.length; i += 2) {
    if (pts[i] < y0) y0 = pts[i];
    if (pts[i] > y1) y1 = pts[i];
  }
  const r0 = Math.max(0, Math.floor(y0) - rect.y);
  const r1 = Math.min(rect.height - 1, Math.floor(y1) - rect.y);
  const xs: number[] = [];
  const w = weight / RIBBON_SUB;
  for (let row = r0; row <= r1; row++) {
    const base = row * rect.width;
    for (let sub = 0; sub < RIBBON_SUB; sub++) {
      const y = rect.y + row + (sub + 0.5) / RIBBON_SUB;
      xs.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = pts[i * 2 + 1];
        const yj = pts[j * 2 + 1];
        if (yi <= y !== yj <= y) xs.push(pts[i * 2] + ((y - yi) / (yj - yi)) * (pts[j * 2] - pts[i * 2]));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(rect.x, xs[k]);
        const b = Math.min(rect.x + rect.width, xs[k + 1]);
        if (!(b > a)) continue;
        for (let px = Math.floor(a); px < b; px++) {
          const cover = Math.min(b, px + 1) - Math.max(a, px);
          if (cover > 0) out[base + px - rect.x] += cover * w;
        }
      }
    }
  }
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
  /** Ribbon pairs per copy: particles in their order around the pen (non-flow kinds). */
  private readonly orders: number[][];
  private readonly s: ParticleSettings;
  private spawn = 0;
  /** Textured dots drawn so far, per copy (sequence order, random picks). */
  private readonly dots: number[];
  /** Ribbon fill: the area each pixel has had so far this stroke (telescoped into the coverage). */
  private readonly filled = new Map<TileKey, Float32Array>();
  private pts: number[] = [];

  constructor(brush: PaintBrush, options: ProceduralStrokeOptions) {
    super(brush, options);
    this.s = brush.particle;
    this.sets = this.copies.map(() => []);
    this.orders = this.copies.map(() => []);
    this.dots = this.copies.map(() => 0);
  }

  /** Strand kinds: a chain of masses behind each particle. */
  private get strands(): boolean {
    return this.s.kind === 'string' || this.s.kind === 'elastic' || this.s.kind === 'fuzzy';
  }

  private newParticle(x: number, y: number, ox: number, oy: number, k: number, phase: number, i: number, copy: number): Particle {
    const s = this.s;
    const fuzzy = s.kind === 'fuzzy';
    const jitter = fuzzy ? 1 : s.wavePhaseJitter;
    return {
      x,
      y,
      vx: 0,
      vy: 0,
      ox,
      oy,
      k,
      phase,
      age: 0,
      run: 0,
      bead: 0,
      alive: true,
      wavePhase: jitter > 0 ? jitter * Math.PI * 2 * rand01(this.seed, i, 43 + copy) : 0,
      waveScale: fuzzy ? 0.6 + 0.8 * rand01(this.seed, i, 47 + copy) : 1,
      dx: x,
      dy: y,
      px: NaN,
      py: NaN,
      fade: 1,
    };
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
      const p = this.newParticle(d.x + ox, d.y + oy, ox, oy, 0.6 + 0.8 * rand01(this.seed, i, 7), a, i, copy);
      if (this.strands) p.strand = Array.from({ length: 6 }, () => ({ x: d.x + ox, y: d.y + oy, vx: 0, vy: 0 }));
      if (s.kind === 'orbit') {
        p.ox = Math.max(1, r + size * 0.15);
        p.oy = 0;
      }
      list.push(p);
    }
    // Ribbons join neighbours around the pen, so the bands do not cross each other at rest.
    this.orders[copy] = list.map((_, i) => i).sort((i, j) => list[i].phase - list[j].phase || i - j);
  }

  /** The sideways wave of particle `p` at pen dab `d` (px along the normal to the pen's direction). */
  private wave(p: Particle, d: PenDab, size: number): number {
    const s = this.s;
    const amp = s.kind === 'fuzzy' ? Math.max(FUZZY_AMPLITUDE, s.waveAmplitude) : s.waveAmplitude;
    if (!(amp > 0)) return 0;
    const ms = d.time ?? d.travel * NOMINAL_MS_PER_PX;
    // About four waves a second at full speed, running back along the path.
    const phase = (2 * Math.PI * d.travel) / (s.waveLength * p.waveScale) - s.waveSpeed * 0.025 * ms + p.wavePhase;
    return amp * size * Math.sin(phase);
  }

  protected advance(copy: number, d: PenDab, rects: RasterRect[]): void {
    const s = this.s;
    let list = this.sets[copy];
    if (d.index === 0 && !list.length) this.init(copy, d);
    const size = Math.max(1, d.radius * 2);
    const markR = Math.max(0.5, (size * s.size) / 2);
    const k = 0.02 + 0.3 * s.stiffness;
    const damp = 0.6 + 0.38 * (1 - s.damping);
    const g = s.gravity * 0.15;
    const op = d.opacity;
    const al = Math.max(0.05, d.alpha);
    // The normal to the pen's direction (dab directions are counter-clockwise with y up).
    const nx = Math.sin(d.direction);
    const ny = Math.cos(d.direction);
    if (s.kind === 'flow') {
      // Throw off particles at the pen while it moves.
      this.spawn += s.count / 8;
      while (this.spawn >= 1) {
        this.spawn -= 1;
        const i = this.dabCount + list.length * 31 + Math.floor(d.index);
        const a = rand01(this.seed, i, 11 + copy) * Math.PI * 2;
        const r = rand01(this.seed, i, 13 + copy) * s.spread * size * 0.5;
        list.push(this.newParticle(d.x + Math.cos(a) * r, d.y + Math.sin(a) * r, 0, 0, 1, a, i, copy));
      }
    }
    const lifeSteps = 8 + 120 * s.life;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.alive) continue;
      switch (s.kind) {
        case 'spring': {
          p.vx = (p.vx + (d.x + p.ox - p.x) * k * p.k) * damp;
          p.vy = (p.vy + (d.y + p.oy - p.y) * k * p.k + g) * damp;
          p.x += p.vx;
          p.y += p.vy;
          break;
        }
        case 'string':
        case 'fuzzy': {
          // A strand of masses: the first tied to the pen, each to the one before.
          const strand = p.strand!;
          const dm = s.kind === 'fuzzy' ? chainDamp(damp, k * p.k) : damp;
          let ax = d.x + p.ox;
          let ay = d.y + p.oy;
          for (const m of strand) {
            m.vx = (m.vx + (ax - m.x) * k * p.k + 0) * dm;
            m.vy = (m.vy + (ay - m.y) * k * p.k + g) * dm;
            m.x += m.vx;
            m.y += m.vy;
            ax = m.x;
            ay = m.y;
          }
          p.x = strand[strand.length - 1].x;
          p.y = strand[strand.length - 1].y;
          break;
        }
        case 'elastic': {
          // A strand whose links have a rest length: they go slack when pushed together, stretch
          // when the pen pulls and snap back, so the tail keeps its distance behind the pen.
          const strand = p.strand!;
          const rest = size * 0.12;
          const ke = Math.min(0.9, (0.1 + 0.6 * s.stiffness) * p.k);
          const dm = chainDamp(damp, ke);
          let ax = d.x + p.ox;
          let ay = d.y + p.oy;
          for (const m of strand) {
            const ex = ax - m.x;
            const ey = ay - m.y;
            const len = Math.hypot(ex, ey);
            const pull = len > rest ? (len - rest) / len : 0;
            m.vx = (m.vx + ex * pull * ke) * dm;
            m.vy = (m.vy + ey * pull * ke + g) * dm;
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
      // Where it is drawn: its place, moved sideways by its wave.
      const w = this.wave(p, d, size);
      const qx = w ? p.x + nx * w : p.x;
      const qy = w ? p.y + ny * w : p.y;
      const px = p.dx;
      const py = p.dy;
      p.px = p.dx;
      p.py = p.dy;
      p.dx = qx;
      p.dy = qy;
      const fade = s.kind === 'flow' ? 1 - p.age / lifeSteps : 1;
      p.fade = fade;
      const moved = Math.hypot(qx - px, qy - py);
      if (d.index === 0 && s.kind !== 'flow') continue;
      if (s.render === 'dot') this.dot(copy, qx, qy, qx - px, qy - py, markR * fade, al * fade, op, d, rects);
      else if (s.render === 'line' || s.render === 'ribbon') this.segment(px, py, qx, qy, markR * fade, al * fade, op, d.pressure, rects);
      else {
        // Beads along the path, each a little larger in the middle of its run.
        p.run += moved;
        const gap = Math.max(markR * 2, size * (0.05 + s.interval));
        while (p.run >= gap) {
          p.run -= gap;
          p.bead++;
          const t = moved > 0 ? 1 - p.run / Math.max(moved, 1e-6) : 1;
          const bx = px + (qx - px) * Math.min(1, Math.max(0, t));
          const by = py + (qy - py) * Math.min(1, Math.max(0, t));
          this.dot(copy, bx, by, qx - px, qy - py, markR * (0.7 + 0.6 * ((p.bead % 3) / 2)) * fade, al * fade, op, d, rects);
        }
      }
    }
    if (s.render === 'ribbon' && !(d.index === 0 && s.kind !== 'flow')) this.ribbon(copy, list, op, al, d, rects);
    if (s.kind === 'flow' && list.length > 512) {
      list = list.filter((p) => p.alive);
      this.sets[copy] = list;
    }
  }

  /** A dot (or bead): round, or a textured stamp turned by the particle's motion (mx, my), at random or to the tip angle. */
  private dot(copy: number, x: number, y: number, mx: number, my: number, r: number, alpha: number, opacity: number, d: PenDab, rects: RasterRect[]): void {
    const s = this.s;
    const textures = s.dotTextures;
    if (!textures.length) return this.mark(x, y, r, alpha, opacity, d.pressure, rects);
    const n = this.dots[copy]++;
    const pick = s.dotTextureOrder === 'random' ? Math.min(textures.length - 1, Math.floor(rand01(this.seed, n, 31 + copy) * textures.length)) : n % textures.length;
    const rotation =
      s.dotRotation === 'random'
        ? rand01(this.seed, n, 37 + copy) * Math.PI * 2
        : s.dotRotation === 'follow'
          ? mx || my
            ? Math.atan2(my, mx)
            : -d.direction
          : (-this.brush.tip.angle * Math.PI) / 180;
    this.stamp(x, y, r, textures[pick], rotation, (this.seed + n * 2654435761) >>> 0, alpha, opacity, d.pressure, rects);
  }

  /**
   * Ribbon fill for one step: the band between each pair of joined particles, from where they
   * were drawn last step to where they are drawn now. Bands of one step, and of consecutive steps,
   * share edges exactly, so the fill has no seams; it is telescoped into the coverage
   * (`telescope`), so it does not build up at the joins.
   */
  private ribbon(copy: number, list: Particle[], opacity: number, alpha: number, d: PenDab, rects: RasterRect[]): void {
    const s = this.s;
    if (!(s.ribbonFill > 0)) return;
    const live = (p: Particle | undefined): p is Particle => !!p && p.alive && !Number.isNaN(p.px);
    let order: Particle[];
    if (s.kind === 'flow') order = list.filter(live);
    else order = this.orders[copy].map((i) => list[i]).filter(live);
    if (order.length < 2) return;
    const pairs: Array<[Particle, Particle]> = [];
    if (s.ribbonPairs === 'first-last') pairs.push([order[0], order[order.length - 1]]);
    else for (let i = 0; i + 1 < order.length; i++) pairs.push([order[i], order[i + 1]]);
    const pts = this.pts;
    const ceil = Math.min(1, opacity * s.ribbonFill);
    for (const [a, b] of pairs) {
      pts.length = 0;
      pts.push(a.px, a.py, a.dx, a.dy, b.dx, b.dy, b.px, b.py);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < 8; i += 2) {
        x0 = Math.min(x0, pts[i]);
        x1 = Math.max(x1, pts[i]);
        y0 = Math.min(y0, pts[i + 1]);
        y1 = Math.max(y1, pts[i + 1]);
      }
      const rect: RasterRect = { x: Math.floor(x0), y: Math.floor(y0), width: Math.floor(x1) - Math.floor(x0) + 1, height: Math.floor(y1) - Math.floor(y0) + 1 };
      const area = this.scratch(rect.width * rect.height);
      // Flow ribbons fade with their particles.
      addPolygonArea(pts, rect, area, Math.min(a.fade, b.fade) * alpha);
      if (this.telescope(rect, area)) this.lay(rect, area, ceil, d.pressure, (a.dx + b.dx) / 2, (a.dy + b.dy) / 2, rects);
    }
  }

  /**
   * Turns the area newly filled over `rect` into coverage to lay towards the fill's ceiling: the
   * share of what was left unfilled, so after any number of bands (in any grouping) a pixel's
   * coverage is the ceiling times the area filled there. False when nothing was added.
   */
  private telescope(rect: RasterRect, area: Float32Array): boolean {
    let any = false;
    for (let yy = 0, k = 0; yy < rect.height; yy++) {
      const gy = rect.y + yy;
      const ty = Math.floor(gy / TILE);
      let t: Float32Array | undefined;
      let tx = NaN;
      for (let xx = 0; xx < rect.width; xx++, k++) {
        const add = area[k];
        if (!(add > 0)) continue;
        const gx = rect.x + xx;
        const ntx = Math.floor(gx / TILE);
        if (ntx !== tx || !t) {
          tx = ntx;
          const key = tileKey(tx, ty);
          t = this.filled.get(key);
          if (!t) {
            t = new Float32Array(TILE * TILE);
            this.filled.set(key, t);
          }
        }
        const ti = (gy - ty * TILE) * TILE + (gx - tx * TILE);
        const before = t[ti];
        const after = Math.min(1, before + add);
        t[ti] = after;
        area[k] = before < 1 ? (after - before) / (1 - before) : 0;
        any = true;
      }
    }
    return any;
  }
}

// ---------------------------------------------------------------------------
// Bristle brushes
// ---------------------------------------------------------------------------


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
