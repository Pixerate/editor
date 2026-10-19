// Portions ported from photocraft/crates/paint/src/mixer.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * The Mixer Brush: a reservoir of loaded paint plus a pickup well that takes up colour from the
 * canvas under each dab (photocraft's behavioural model):
 *
 * - Each dab samples the canvas under its footprint (coverage- and alpha-weighted). The pickup
 *   colour `P` moves towards that sample by `PICKUP_RATE × wet` (scaled by the sample's coverage).
 * - The dab's paint mixes the reservoir `R` (weight `amount × (1 − mix·wet)`) with the pickup
 *   (weight `mix·wet`) and lands at `flow × opacity` times the total weight, over the pixels as
 *   they are now, so earlier dabs of the same stroke are picked up again (smearing).
 * - The reservoir drains per dab unless `load` is 1, so low-load strokes run dry. A dry brush
 *   (`wet` 0) paints only reservoir colour; an empty, wet brush smears canvas colour.
 *
 * `mixing: 'pigment'` does all three mixes (pickup, paint and deposit) with the Kubelka-Munk model
 * of `./pigment`, so a blue brush dragged through yellow makes green instead of grey. Everything
 * is data in, pixels out: the same canvas, points, settings and load replay identically.
 */

import { DabWalker, dabRect, rasterizeDab, type BrushSettings, type Dab, type StrokePoint } from './brush';
import {
  EMPTY_MIXER_LOAD,
  exchangeRates,
  MIXER_DRAIN,
  MIXER_PICKUP_RATE,
  MIXING_MODELS,
  PaintExchange,
  TileMedium,
  type ExchangeRates,
  type MixerLoad,
  type MixingModel,
  type PaintTileTarget,
  type RgbTriple,
} from './exchange';
import type { RasterRect as CropBox } from '../raster/surface';


export { EMPTY_MIXER_LOAD, MIXER_DRAIN, MIXER_PICKUP_RATE, MIXING_MODELS, type MixerLoad, type MixingModel };

/** Mixer Brush options. */
export interface MixerSettings {
  /** How much colour the brush picks up from the canvas (the pick-up ratio), 0 (dry) .. 1 (default 0.5). */
  wet: number;
  /** How much paint the reservoir holds, 0 .. 1 (default 0.5): below 1 it drains per dab and the stroke runs dry. */
  load: number;
  /** How far each dab's paint moves from the reservoir towards the picked-up colour (the mix ratio), 0 .. 1 (default 0.5). */
  mix: number;
  /** Refill the reservoir with the paint colour at the start of each stroke (default true). */
  loadEachStroke: boolean;
  /** Empty the pickup well after each stroke (default true); off keeps the brush dirty for the next stroke. */
  cleanEachStroke: boolean;
  /** `rgb` (default) or `pigment` (blue and yellow make green). */
  mixing: MixingModel;
}

export const DEFAULT_MIXER: Readonly<MixerSettings> = {
  wet: 0.5,
  load: 0.5,
  mix: 0.5,
  loadEachStroke: true,
  cleanEachStroke: true,
  mixing: 'rgb',
};

/** Mixer settings with every field in range (missing fields from `DEFAULT_MIXER`). */
export function normalizeMixer(raw: Partial<MixerSettings> = {}): MixerSettings {
  const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    wet: unit(raw.wet, DEFAULT_MIXER.wet),
    load: unit(raw.load, DEFAULT_MIXER.load),
    mix: unit(raw.mix, DEFAULT_MIXER.mix),
    loadEachStroke: bool(raw.loadEachStroke, DEFAULT_MIXER.loadEachStroke),
    cleanEachStroke: bool(raw.cleanEachStroke, DEFAULT_MIXER.cleanEachStroke),
    mixing: raw.mixing === 'pigment' ? 'pigment' : 'rgb',
  };
}

/** The per-dab exchange rates of Mixer Brush settings (`wet` is the pick-up ratio, `mix` the mix ratio). */
export function mixerRates(settings: MixerSettings): ExchangeRates {
  return exchangeRates(settings.wet, settings.mix, settings.load, settings.mixing);
}

/** The brush loaded full with `color` (sRGB 0..1); the pickup well is kept. */
export function loadMixer(load: MixerLoad, color: readonly [number, number, number]): MixerLoad {
  const c = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
  return { reservoir: [c(color[0]), c(color[1]), c(color[2])], amount: 1, pickup: load.pickup };
}

/** The brush with its pickup well emptied; the reservoir is kept. */
export function cleanMixer(load: MixerLoad): MixerLoad {
  return { reservoir: load.reservoir, amount: load.amount, pickup: null };
}

/** The pixels a mixer stroke reads and writes (RGBA tiles in layer space). */
export type MixerTarget = PaintTileTarget;

/**
 * One Mixer Brush stroke. Feed points with `push` (any chunks give the same dabs), end with
 * `finish`; `load` is the brush load after the dabs so far. Each call returns the document
 * rectangles it touched. Runs on the shared pick-up / mix exchange (`./exchange`).
 */
export class MixerStroke {
  dabCount = 0;
  bounds: CropBox | null = null;
  private walker: DabWalker;
  private smoothPos: StrokePoint | null = null;
  private buf = new Float32Array(0);
  private readonly exchange: PaintExchange;
  private readonly medium: TileMedium;
  private readonly paintColor: RgbTriple = [0, 0, 0];

  constructor(
    readonly brush: BrushSettings,
    settings: Partial<MixerSettings>,
    load: MixerLoad,
    target: MixerTarget
  ) {
    this.walker = new DabWalker(brush);
    this.exchange = new PaintExchange(mixerRates(normalizeMixer(settings)), load);
    this.medium = new TileMedium(target);
  }

  /** The brush load after the dabs so far. */
  get load(): MixerLoad {
    return this.exchange.load;
  }

  push(points: readonly StrokePoint[]): CropBox[] {
    const dabs: Dab[] = [];
    for (const p of points) this.walker.push(this.smooth(p), dabs);
    return this.paint(dabs);
  }

  finish(last?: StrokePoint): CropBox[] {
    const dabs: Dab[] = [];
    if (last && this.smoothPos && (this.smoothPos.x !== last.x || this.smoothPos.y !== last.y)) this.walker.push(last, dabs);
    this.walker.finish(dabs);
    return this.paint(dabs);
  }

  private smooth(p: StrokePoint): StrokePoint {
    const a = 1 - Math.min(0.95, Math.max(0, this.brush.smoothing));
    const cur = this.smoothPos;
    const n = cur && a < 1 ? { ...p, x: cur.x + (p.x - cur.x) * a, y: cur.y + (p.y - cur.y) * a } : p;
    this.smoothPos = n;
    return n;
  }

  private paint(dabs: Dab[]): CropBox[] {
    const rects: CropBox[] = [];
    for (const d of dabs) {
      const rect = dabRect(d, this.brush.hardness);
      const n = rect.width * rect.height;
      if (this.buf.length < n) this.buf = new Float32Array(n);
      const cov = this.buf.subarray(0, n);
      // Pure tip coverage: flow scales the deposit, not the sampling weights.
      rasterizeDab({ ...d, alpha: 1 }, this.brush.hardness, rect, cov);
      this.dab(d, rect, cov);
      rects.push(rect);
      this.bounds = union(this.bounds, rect);
      this.dabCount++;
    }
    return rects;
  }

  private dab(d: Dab, rect: CropBox, cov: Float32Array): void {
    const ex = this.exchange;
    // 1. Pick up from the canvas under the dab; 2. mix the dab's paint and lay it; 3. drain.
    ex.pickUp(this.medium.sample(rect, cov));
    const total = ex.paint(this.paintColor);
    if (total > 0) {
      const dep = Math.min(1, total) * this.brush.flow * this.brush.opacity * d.opacity;
      if (dep > 0) this.medium.deposit(rect, cov, dep, this.paintColor, ex.paintPigment);
    }
    ex.drain();
  }
}

function union(a: CropBox | null, b: CropBox): CropBox {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
