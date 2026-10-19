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
import { createPigment, lerpPigmentInto, setPigmentColor, type Pigment } from './pigment';
import type { RasterRect as CropBox } from '../raster/surface';
import { TILE } from '../raster/surface';

/** How the Mixer Brush mixes colours: straight sRGB averages, or like paint (Kubelka-Munk). */
export type MixingModel = 'rgb' | 'pigment';

export const MIXING_MODELS: readonly MixingModel[] = ['rgb', 'pigment'];

/** Mixer Brush options. */
export interface MixerSettings {
  /** How much colour the brush picks up from the canvas, 0 (dry) .. 1 (default 0.5). */
  wet: number;
  /** How much paint the reservoir holds, 0 .. 1 (default 0.5): below 1 it drains per dab and the stroke runs dry. */
  load: number;
  /** How far each dab's paint moves from the reservoir towards the picked-up colour, 0 .. 1 (default 0.5). */
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

/** Fraction of the way the pickup colour moves towards the canvas per dab at 100 % wet. */
export const MIXER_PICKUP_RATE = 0.25;
/** Fraction of the reservoir that drains per dab at 0 % load. */
export const MIXER_DRAIN = 0.08;

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

/** What the brush carries between strokes. Colours are straight sRGB, 0..1. */
export interface MixerLoad {
  /** Loaded paint, or `null` when the brush is unloaded. */
  readonly reservoir: readonly [number, number, number] | null;
  /** Reservoir left, 0..1. */
  readonly amount: number;
  /** Colour picked up from the canvas, or `null` when the brush is clean. */
  readonly pickup: readonly [number, number, number] | null;
}

export const EMPTY_MIXER_LOAD: MixerLoad = { reservoir: null, amount: 0, pickup: null };

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
export interface MixerTarget {
  /** The tile (TILE × TILE × 4) at (tx, ty) as it is now, or `null` when it is fully transparent. */
  readTile(tx: number, ty: number): Uint8ClampedArray | null;
  /** A writable tile at (tx, ty), returned by `readTile` from then on. */
  writeTile(tx: number, ty: number): Uint8ClampedArray;
  /** Layer offset: layer pixel = document pixel − offset. */
  offset: { x: number; y: number };
  /** Keep alpha and paint only where the layer has pixels. */
  lockTransparency: boolean;
  /** Selection coverage (document space, canvas-sized), or `null`. */
  selection: { width: number; height: number; data: ArrayLike<number> } | null;
}

type Rgb = [number, number, number];

/**
 * One Mixer Brush stroke. Feed points with `push` (any chunks give the same dabs), end with
 * `finish`; `load` is the brush load after the dabs so far. Each call returns the document
 * rectangles it touched.
 */
export class MixerStroke {
  dabCount = 0;
  bounds: CropBox | null = null;
  private walker: DabWalker;
  private smoothPos: StrokePoint | null = null;
  private buf = new Float32Array(0);
  private readonly settings: MixerSettings;
  private readonly reservoir: Rgb | null;
  private amount: number;
  private pickup: Rgb | null;
  private readonly pig: { res: Pigment; pick: Pigment; paint: Pigment; canvas: Pigment } | null;
  private readonly out: Rgb = [0, 0, 0];

  constructor(
    readonly brush: BrushSettings,
    settings: Partial<MixerSettings>,
    load: MixerLoad,
    private readonly target: MixerTarget
  ) {
    this.settings = normalizeMixer(settings);
    this.walker = new DabWalker(brush);
    this.reservoir = load.reservoir ? [load.reservoir[0], load.reservoir[1], load.reservoir[2]] : null;
    this.amount = this.reservoir ? Math.min(1, Math.max(0, load.amount)) : 0;
    this.pickup = load.pickup ? [load.pickup[0], load.pickup[1], load.pickup[2]] : null;
    this.pig =
      this.settings.mixing === 'pigment'
        ? { res: createPigment(this.reservoir ?? [0, 0, 0]), pick: createPigment(this.pickup ?? [0, 0, 0]), paint: createPigment([0, 0, 0]), canvas: createPigment([0, 0, 0]) }
        : null;
  }

  /** The brush load after the dabs so far. */
  get load(): MixerLoad {
    return { reservoir: this.reservoir ? [...this.reservoir] : null, amount: this.amount, pickup: this.pickup ? [...this.pickup] : null };
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

  /** `a` mixed `t` of the way to `b` into `this.out`, by the mixing model. */
  private mix(a: Rgb, pa: Pigment | null, b: Rgb, pb: Pigment | null, t: number): Rgb {
    const o = this.out;
    if (pa && pb) lerpPigmentInto(pa, pb, t, o, 0);
    else for (let c = 0; c < 3; c++) o[c] = a[c] + (b[c] - a[c]) * t;
    return o;
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

  // The tile last looked up by `locate` (and whether it came from `writeTile`).
  private tx = NaN;
  private ty = NaN;
  private tile: Uint8ClampedArray | null = null;
  private writable = false;

  /** Index of document pixel (dx, dy) in `this.tile`, or -1 when reading an empty tile. */
  private locate(dx: number, dy: number, write: boolean): number {
    const t = this.target;
    const lx = dx - t.offset.x;
    const ly = dy - t.offset.y;
    const tx = Math.floor(lx / TILE);
    const ty = Math.floor(ly / TILE);
    if (tx !== this.tx || ty !== this.ty || (write && !this.writable)) {
      this.tx = tx;
      this.ty = ty;
      this.tile = write ? t.writeTile(tx, ty) : t.readTile(tx, ty);
      this.writable = write;
    }
    return this.tile ? ((ly - ty * TILE) * TILE + (lx - tx * TILE)) * 4 : -1;
  }

  private dab(d: Dab, rect: CropBox, cov: Float32Array): void {
    const { wet, mix, load } = this.settings;
    const pig = this.pig;
    const w = rect.width;
    this.tx = NaN;

    // 1. Sample the canvas under the dab.
    let ar = 0;
    let ag = 0;
    let ab = 0;
    let wsum = 0;
    let asum = 0;
    for (let yy = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const k = cov[yy * w + xx];
        if (k <= 0) continue;
        wsum += k;
        const i = this.locate(rect.x + xx, rect.y + yy, false);
        if (i < 0) continue;
        const px = this.tile!;
        const al = px[i + 3] / 255;
        if (al <= 0) continue;
        const ka = k * al;
        ar += (px[i] / 255) * ka;
        ag += (px[i + 1] / 255) * ka;
        ab += (px[i + 2] / 255) * ka;
        asum += ka;
      }
    }
    if (asum > 1e-6 && wet > 0) {
      const canvas: Rgb = [ar / asum, ag / asum, ab / asum];
      if (!this.pickup) this.pickup = canvas;
      else {
        if (pig) setPigmentColor(pig.canvas, canvas[0], canvas[1], canvas[2]);
        const o = this.mix(this.pickup, pig?.pick ?? null, canvas, pig?.canvas ?? null, MIXER_PICKUP_RATE * wet * (asum / Math.max(1e-6, wsum)));
        this.pickup = [o[0], o[1], o[2]];
      }
      if (pig) setPigmentColor(pig.pick, this.pickup[0], this.pickup[1], this.pickup[2]);
    }

    // 2. The dab's paint: the reservoir mixed with the pickup.
    const res = this.reservoir;
    const wr = res ? this.amount * (1 - mix * wet) : 0;
    const wp = this.pickup ? mix * wet : 0;
    const total = wr + wp;
    if (total > 1e-6) {
      const paint: Rgb = res && this.pickup ? [...this.mix(res, pig?.res ?? null, this.pickup, pig?.pick ?? null, wp / total)] : [...(res ?? this.pickup!)];
      if (pig) setPigmentColor(pig.paint, paint[0], paint[1], paint[2]);
      const dep = Math.min(1, total) * this.brush.flow * this.brush.opacity * d.opacity;
      if (dep > 0) this.deposit(rect, cov, paint, dep);
    }

    // 3. The reservoir drains unless the load is full.
    this.amount *= 1 - MIXER_DRAIN * (1 - load);
  }

  /** Lays `paint` over the pixels under the dab at `dep` × coverage (× selection). */
  private deposit(rect: CropBox, cov: Float32Array, paint: Rgb, dep: number): void {
    const t = this.target;
    const sel = t.selection;
    const pig = this.pig;
    const w = rect.width;
    const o = this.out;
    // Pigment mode keeps the last canvas colour's spectrum: runs of equal pixels are common.
    let lastKey = -1;
    for (let yy = 0; yy < rect.height; yy++) {
      const dy = rect.y + yy;
      for (let xx = 0; xx < w; xx++) {
        let k = cov[yy * w + xx] * dep;
        if (k <= 0) continue;
        const dx = rect.x + xx;
        if (sel) {
          if (dx < 0 || dy < 0 || dx >= sel.width || dy >= sel.height) continue;
          k *= sel.data[dy * sel.width + dx] / 255;
          if (k <= 0) continue;
        }
        if (k > 1) k = 1;
        // A locked layer keeps its transparent pixels (and leaves their tiles unwritten).
        if (t.lockTransparency) {
          const ri = this.locate(dx, dy, false);
          if (ri < 0 || this.tile![ri + 3] === 0) continue;
        }
        const i = this.locate(dx, dy, true);
        const px = this.tile!;
        const a = px[i + 3] / 255;
        const na = t.lockTransparency ? a : a + (1 - a) * k;
        // The new paint's share of the result (source-over); a locked layer mixes by `k` alone.
        const share = t.lockTransparency ? k : na > 0 ? k / na : 1;
        if (a <= 0 || share >= 1) {
          o[0] = paint[0];
          o[1] = paint[1];
          o[2] = paint[2];
        } else if (pig) {
          const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
          if (key !== lastKey) {
            setPigmentColor(pig.canvas, px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
            lastKey = key;
          }
          lerpPigmentInto(pig.canvas, pig.paint, share, o, 0);
        } else {
          for (let c = 0; c < 3; c++) o[c] = px[i + c] / 255 + (paint[c] - px[i + c] / 255) * share;
        }
        px[i] = Math.round(o[0] * 255);
        px[i + 1] = Math.round(o[1] * 255);
        px[i + 2] = Math.round(o[2] * 255);
        px[i + 3] = Math.round(na * 255);
      }
    }
  }
}

function union(a: CropBox | null, b: CropBox): CropBox {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
