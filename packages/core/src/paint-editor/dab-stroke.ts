/**
 * The paint editor's dab-by-dab stroke engine: every brush whose dabs read what earlier dabs laid
 * down. The Mixer Brush, the blender, the smudge, and dab brushes that pick up paint or are
 * multi-coloured all run here, with the same pen input as dry media (`PenDabWalker`: pressure,
 * tilt, barrel rotation, velocity, rotation modes, jitter), paper grain and symmetry copies.
 *
 * - `mixer` and wet-capable `dab` brushes go through the shared pick-up / mix exchange
 *   (`PaintExchange` over a `TileMedium`): each dab picks up from the layer, mixes its paint from
 *   the brush colour (or the multi-colour gradient) and the carried paint, and lays it down. A
 *   Mixer Brush deposits per dab (photocraft's model); a dab brush keeps the stroke's opacity
 *   ceiling: a shared `CoverageMap` builds up as for dry media and each dab lays only the
 *   increase, `k = (c₁ − c₀)·o / (1 − c₀·o)`, so a one-colour Normal stroke matches the dry engine.
 * - `blender` calls `blenderDab`, `smudge` a `SmudgeTip` per copy.
 *
 * Pixels go through the session's live tiles (`PaintTileTarget`). Pure data in, pixels out:
 * points, seed, colours and the starting load replay exactly.
 */

import { CoverageMap, dabRect, rasterizeDab } from '../paint/brush';
import { blenderDab, createBlenderScratch, SmudgeTip, type BlenderScratch } from '../paint/blending';
import { exchangeRates, PaintExchange, TileMedium, type MixerLoad, type MixingModel, type PaintTileTarget, type RgbTriple } from '../paint/exchange';
import { mixerRates } from '../paint/mixer';
import { mixPigment8 } from '../raster/blend';
import type { RasterRect } from '../raster/surface';
import type { MultiColorSettings, PaintBrush } from './brushes';
import { IDENTITY_COPY, PenDabWalker, PenSmoother, type PenDab, type PenPoint, type StrokeCopy } from './engine';
import { rand01 } from './noise';
import { grainCatch, type PaperGrain } from './paper';

export interface PaintDabStrokeOptions {
  /** Where the stroke reads and writes pixels. */
  target: PaintTileTarget;
  /** The paint colour, sRGB 0..1. */
  color: RgbTriple;
  /** The secondary colour (a multi-colour brush without its own colours uses both). */
  secondary: RgbTriple;
  /** What the brush carries at the start (mixer and wet-capable dab brushes). */
  load: MixerLoad;
  grain: PaperGrain | null;
  paperDepth: number;
  seed?: number;
  copies?: readonly StrokeCopy[];
}

/** Entries in a multi-colour gradient table. */
const GRADIENT_STEPS = 32;

/** Colours of a multi-colour brush, resolved against the paint and secondary colours. */
export function multiColorPalette(mc: MultiColorSettings, color: RgbTriple, secondary: RgbTriple): RgbTriple[] {
  if (mc.colors.length >= 2) {
    return mc.colors.map((h) => {
      const n = parseInt(h.slice(1), 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    });
  }
  return [[...color], [...secondary]];
}

/** The blend position `t` between two neighbouring colours at fraction `f`, by softness (0: a hard step at ½). */
function soften(f: number, softness: number): number {
  if (softness >= 1) return f;
  const w = Math.max(1e-3, softness);
  return Math.min(1, Math.max(0, (f - 0.5) / w + 0.5));
}

/** `a` mixed `t` of the way to `b` by the mixing model (8-bit pigment spectra cached). */
function mixRgb(a: RgbTriple, b: RgbTriple, t: number, mixing: MixingModel): RgbTriple {
  if (t <= 0) return [...a];
  if (t >= 1) return [...b];
  if (mixing === 'pigment') {
    const o = [0, 0, 0];
    const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    mixPigment8(q(a[0]), q(a[1]), q(a[2]), q(b[0]), q(b[1]), q(b[2]), t, o);
    return [o[0], o[1], o[2]];
  }
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** The tip gradient of a multi-colour brush: `GRADIENT_STEPS` colours across the tip. */
export function multiColorGradient(palette: readonly RgbTriple[], softness: number, mixing: MixingModel): RgbTriple[] {
  const n = palette.length;
  const out: RgbTriple[] = [];
  for (let j = 0; j < GRADIENT_STEPS; j++) {
    // Each colour owns an equal band; blends happen across band edges.
    const f = (j / (GRADIENT_STEPS - 1)) * (n - 1);
    const i = Math.min(n - 2, Math.floor(f));
    out.push(mixRgb(palette[i], palette[i + 1], soften(f - i, softness), mixing));
  }
  return out;
}

/** The colour of dab `index` of a `dab`-mode multi-colour brush. */
export function multiColorForDab(mc: MultiColorSettings, palette: readonly RgbTriple[], index: number, seed: number, mixing: MixingModel): RgbTriple {
  const n = palette.length;
  if (mc.order === 'random') {
    const run = Math.floor(index / mc.length);
    return [...palette[Math.min(n - 1, Math.floor(rand01(seed, run, 11) * n))]];
  }
  const f = (index / mc.length) % n;
  const i = Math.floor(f);
  return mixRgb(palette[i], palette[(i + 1) % n], soften(f - i, mc.softness), mixing);
}

interface CopyState {
  walker: PenDabWalker;
  exchange: PaintExchange | null;
  smudge: SmudgeTip | null;
}

export class PaintDabStroke {
  dabCount = 0;
  private readonly smoother: PenSmoother;
  private readonly copies: readonly StrokeCopy[];
  private readonly states: CopyState[];
  private readonly medium: TileMedium;
  private readonly depth: number;
  private readonly coverage: CoverageMap | null;
  private readonly palette: RgbTriple[] | null;
  private readonly gradient: RgbTriple[] | null;
  private readonly fieldLut: RgbTriple[] = [];
  private readonly scratch: BlenderScratch | null;
  private readonly mixing: MixingModel;
  private tip = new Float32Array(0);
  private cov = new Float32Array(0);
  private field = new Float32Array(0);
  private readonly paint: RgbTriple = [0, 0, 0];
  private lastRaw: PenPoint | null = null;
  private lastFed: PenPoint | null = null;

  constructor(
    readonly brush: PaintBrush,
    private readonly options: PaintDabStrokeOptions
  ) {
    this.smoother = new PenSmoother(brush.tip.smoothing, brush.pressureSmoothing);
    this.copies = options.copies?.length ? options.copies : [IDENTITY_COPY];
    const exchanging = brush.engine === 'mixer' || brush.engine === 'dab';
    const rates = brush.engine === 'mixer' ? mixerRates(brush.mixer) : exchangeRates(brush.behavior.pickup, brush.behavior.mix, 1, brush.behavior.mixing);
    this.mixing = brush.engine === 'mixer' ? brush.mixer.mixing : brush.behavior.mixing;
    this.states = this.copies.map((c, i) => ({
      walker: new PenDabWalker(brush, ((options.seed ?? 0) + i * 7919) | 0, c.linear),
      exchange: exchanging ? new PaintExchange(rates, options.load) : null,
      smudge: brush.engine === 'smudge' ? new SmudgeTip(brush.smudge, brush.tip.size * (1 + brush.dynamics.tiltSize * 1.5)) : null,
    }));
    // A Mixer Brush mixes as its settings say; a dab brush blends by its tip's blend mode.
    this.medium = new TileMedium(options.target, brush.engine === 'dab' ? { blend: brush.tip.blend } : {});
    this.depth = options.grain && !options.grain.flat ? Math.min(1, Math.max(0, options.paperDepth * brush.grain)) : 0;
    this.coverage = brush.engine === 'dab' ? new CoverageMap() : null;
    const mc = brush.behavior.multicolor;
    this.palette = exchanging && mc.mode !== 'off' ? multiColorPalette(mc, options.color, options.secondary) : null;
    this.gradient = this.palette && mc.mode === 'tip' ? multiColorGradient(this.palette, mc.softness, this.mixing) : null;
    this.scratch = brush.engine === 'blender' ? createBlenderScratch() : null;
  }

  /** What copy 0's brush carries after the dabs so far (mixer and wet-capable dab brushes). */
  get load(): MixerLoad | null {
    return this.states[0].exchange?.load ?? null;
  }

  push(points: readonly PenPoint[]): RasterRect[] {
    const rects: RasterRect[] = [];
    for (const raw of points) {
      this.lastRaw = raw;
      const p = this.smoother.push(raw);
      this.lastFed = p;
      this.copies.forEach((c, i) => {
        const dabs: PenDab[] = [];
        this.states[i].walker.push(c.map(p), dabs);
        this.paintDabs(i, dabs, rects);
      });
    }
    return rects;
  }

  /** Ends the stroke: the smoothed path catches up with the last raw sample; a tap paints one dab. */
  finish(): RasterRect[] {
    const rects: RasterRect[] = [];
    const raw = this.lastRaw;
    const fed = this.lastFed;
    this.copies.forEach((c, i) => {
      const dabs: PenDab[] = [];
      if (raw && fed && (raw.x !== fed.x || raw.y !== fed.y)) this.states[i].walker.push(c.map({ ...raw, pressure: fed.pressure }), dabs);
      this.states[i].walker.finish(dabs);
      this.paintDabs(i, dabs, rects);
    });
    return rects;
  }

  private paintDabs(copy: number, dabs: PenDab[], rects: RasterRect[]): void {
    for (const d of dabs) {
      const rect = dabRect(d, this.brush.tip.hardness);
      if (rect.width <= 0 || rect.height <= 0) continue;
      this.dab(copy, d, rect);
      rects.push(rect);
      this.dabCount++;
    }
  }

  /** The tip's pure coverage (`tip`) and, with grain, what the paper catches of it (`cov`). */
  private rasterize(d: PenDab, rect: RasterRect): { tip: Float32Array; cov: Float32Array } {
    const n = rect.width * rect.height;
    if (this.tip.length < n) {
      this.tip = new Float32Array(n);
      this.cov = new Float32Array(n);
    }
    const tip = this.tip.subarray(0, n);
    tip.fill(0);
    rasterizeDab({ ...d, alpha: 1 }, this.brush.tip.hardness, rect, tip);
    if (!(this.depth > 0 && this.options.grain)) return { tip, cov: tip };
    const cov = this.cov.subarray(0, n);
    const grain = this.options.grain;
    for (let yy = 0, k = 0; yy < rect.height; yy++) {
      const y = rect.y + yy + 0.5;
      for (let xx = 0; xx < rect.width; xx++, k++) cov[k] = tip[k] > 0 ? tip[k] * grainCatch(grain.at(rect.x + xx + 0.5, y), this.depth, d.pressure) : 0;
    }
    return { tip, cov };
  }

  private dab(copy: number, d: PenDab, rect: RasterRect): void {
    const brush = this.brush;
    const { tip, cov } = this.rasterize(d, rect);
    const st = this.states[copy];
    if (brush.engine === 'blender') {
      blenderDab(this.medium, rect, cov, d.opacity * d.alpha * brush.tip.opacity, d.radius, brush.blender, this.scratch!);
      return;
    }
    if (brush.engine === 'smudge') {
      st.smudge!.dab(this.medium, { x: d.x, y: d.y, radius: d.radius, opacity: d.opacity * d.alpha * brush.tip.opacity }, rect, cov);
      return;
    }
    const ex = st.exchange!;
    // 1. Pick up from under the tip (the pure footprint, as the Mixer Brush samples).
    ex.pickUp(this.medium.sample(rect, tip));
    // 2. The dab's paint: one colour, or a colour per pixel across the tip.
    const mc = brush.behavior.multicolor;
    if (this.palette && mc.mode === 'dab') {
      const c = multiColorForDab(mc, this.palette, d.index, this.options.seed ?? 0, this.mixing);
      ex.setReservoirColor(c[0], c[1], c[2]);
    }
    let field: Float32Array | null = null;
    let total: number;
    if (this.gradient) {
      total = this.tipField(ex, d, rect);
      field = this.field;
    } else total = ex.paint(this.paint);
    if (total > 0) {
      if (this.coverage) this.depositWithCeiling(d, rect, cov, field, ex);
      else {
        const dep = Math.min(1, total) * d.alpha * brush.tip.opacity * d.opacity;
        if (dep > 0) this.medium.deposit(rect, cov, dep, this.paint, ex.paintPigment, field);
      }
    }
    // 3. Drain.
    ex.drain();
  }

  /** Fills `this.field` with the tip gradient (mixed with the carried paint) per pixel; returns the paint weight. */
  private tipField(ex: PaintExchange, d: PenDab, rect: RasterRect): number {
    const g = this.gradient!;
    const lut = this.fieldLut;
    let total = 0;
    for (let j = 0; j < g.length; j++) {
      ex.setReservoirColor(g[j][0], g[j][1], g[j][2]);
      const out: RgbTriple = lut[j] ?? [0, 0, 0];
      total = ex.paint(out);
      lut[j] = out;
    }
    const n = rect.width * rect.height;
    if (this.field.length < n * 3) this.field = new Float32Array(n * 3);
    const f = this.field;
    // Across the stroke: the normal to the direction of travel (document y points down).
    const nx = Math.sin(d.direction);
    const ny = Math.cos(d.direction);
    const r = Math.max(0.5, d.radius);
    const last = g.length - 1;
    for (let yy = 0, k = 0; yy < rect.height; yy++) {
      const py = rect.y + yy + 0.5 - d.y;
      for (let xx = 0; xx < rect.width; xx++, k++) {
        const u = ((rect.x + xx + 0.5 - d.x) * nx + py * ny) / r;
        const j = Math.min(last, Math.max(0, Math.round(((u + 1) / 2) * last)));
        f[k * 3] = lut[j][0];
        f[k * 3 + 1] = lut[j][1];
        f[k * 3 + 2] = lut[j][2];
      }
    }
    return total;
  }

  /** A dab brush's deposit: only what this dab adds to the stroke's coverage, under its opacity ceiling. */
  private depositWithCeiling(d: PenDab, rect: RasterRect, cov: Float32Array, field: Float32Array | null, ex: PaintExchange): void {
    const map = this.coverage!;
    const n = rect.width * rect.height;
    const before = new Float32Array(n);
    const vals = new Float32Array(n);
    for (let yy = 0, k = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < rect.width; xx++, k++) {
        if (cov[k] <= 0) continue;
        before[k] = map.get(rect.x + xx, rect.y + yy);
        vals[k] = cov[k] * d.alpha;
      }
    }
    map.accumulate(rect, vals, d.opacity);
    const o = this.brush.tip.opacity;
    for (let yy = 0, k = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < rect.width; xx++, k++) {
        if (cov[k] <= 0) {
          vals[k] = 0;
          continue;
        }
        const c0 = before[k] * o;
        const c1 = map.get(rect.x + xx, rect.y + yy) * o;
        vals[k] = c1 > c0 && c0 < 1 ? (c1 - c0) / (1 - c0) : 0;
      }
    }
    this.medium.deposit(rect, vals, 1, this.paint, ex.paintPigment, field);
  }
}
