// Portions ported from photocraft/crates/paint/src/mixer.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * The pick-up / mix exchange between a loaded brush and the paint under it: the one mechanism
 * every wet-capable brush shares. The Mixer Brush (`MixerStroke`) and the paint editor's
 * wet-capable brushes run on it now; the wet layer (phase 3) plugs in as another `PaintMedium`.
 *
 * Two halves:
 *
 * - `PaintExchange` is what the brush carries: a **reservoir** of loaded paint (with an amount
 *   that drains per dab) and a **well** of paint picked up from the canvas. Per dab it
 *   1. picks up: the well moves towards the colour under the dab by the pick-up rate times how
 *      much of the footprint holds paint (`pickUp`);
 *   2. mixes the dab's paint: reservoir weight `amount × (1 − mix)`, well weight `mix`
 *      (`paint`);
 *   3. drains the reservoir (`drain`).
 *   Every mix is RGB or Kubelka-Munk pigment (`mixing`), so a blue brush through yellow goes
 *   green.
 * - `PaintMedium` is what the brush touches: `sample` (the colour and contact under a footprint)
 *   and `deposit` (lay paint at per-pixel amounts). `TileMedium` is the raster layer's pixels.
 *   A wet layer implements the same two calls over its wet pigment and water (sampling only wet
 *   paint, so pick-up lifts what is still wet), and nothing in `PaintExchange` changes.
 *
 * The ratios a user sets are `pickup` (pick-up ratio, 0..1) and `mix` (mix ratio, 0..1);
 * `exchangeRates` turns them into per-dab rates with the Mixer Brush's constants, so a Mixer
 * Brush's `wet` and `mix` are exactly these two ratios. Everything is data in, pixels out.
 */

import { blendPixel, mixPigment8, type BlendMode } from '../raster/blend';
import type { RasterRect } from '../raster/surface';
import { TILE } from '../raster/surface';
import { createPigment, lerpPigmentInto, setPigmentColor, type Pigment } from './pigment';

/** How colours mix: straight sRGB averages, or like paint (Kubelka-Munk). */
export type MixingModel = 'rgb' | 'pigment';

export const MIXING_MODELS: readonly MixingModel[] = ['rgb', 'pigment'];

/** An sRGB colour, 0..1 per channel. */
export type RgbTriple = [number, number, number];

/** What a brush carries between dabs and strokes. Colours are straight sRGB, 0..1. */
export interface MixerLoad {
  /** Loaded paint, or `null` when the brush is unloaded. */
  readonly reservoir: readonly [number, number, number] | null;
  /** Reservoir left, 0..1. */
  readonly amount: number;
  /** Colour picked up from the canvas (the well), or `null` when the brush is clean. */
  readonly pickup: readonly [number, number, number] | null;
}

export const EMPTY_MIXER_LOAD: MixerLoad = { reservoir: null, amount: 0, pickup: null };

/** Fraction of the way the well moves towards the canvas colour per dab at a pick-up ratio of 1. */
export const MIXER_PICKUP_RATE = 0.25;
/** Fraction of the reservoir that drains per dab at a load of 0. */
export const MIXER_DRAIN = 0.08;

/** Per-dab rates of an exchange. */
export interface ExchangeRates {
  /** How far the well moves towards the canvas colour per dab at full contact (0: lifts nothing). */
  pickup: number;
  /** The well's weight in each dab's paint; the reservoir gets `amount × (1 − mix)`. */
  mix: number;
  /** Fraction of the reservoir lost per dab. */
  drain: number;
  mixing: MixingModel;
}

/**
 * Per-dab rates from the ratios a user sets: pick-up ratio `pickup` (0 dry .. 1), mix ratio
 * `mix` (0 .. 1, scaled by the pick-up ratio: a brush that lifts nothing has nothing to mix) and
 * `load` (1 never drains). The Mixer Brush passes its `wet`, `mix` and `load`.
 */
export function exchangeRates(pickup: number, mix: number, load: number, mixing: MixingModel): ExchangeRates {
  return { pickup: MIXER_PICKUP_RATE * pickup, mix: mix * pickup, drain: MIXER_DRAIN * (1 - load), mixing };
}

/** What a footprint holds: its average paint colour and how much of it holds paint (0..1). */
export interface PaintSample {
  rgb: RgbTriple;
  /** Paint-weighted share of the footprint (alpha × coverage over coverage). */
  contact: number;
}

/** The brush side of the exchange: reservoir, amount and well, mixed per dab. */
export class PaintExchange {
  private reservoir: RgbTriple | null;
  private amount: number;
  private well: RgbTriple | null;
  private readonly pig: { res: Pigment; well: Pigment; paint: Pigment; canvas: Pigment } | null;
  private readonly out: RgbTriple = [0, 0, 0];

  constructor(
    readonly rates: ExchangeRates,
    load: MixerLoad
  ) {
    this.reservoir = load.reservoir ? [load.reservoir[0], load.reservoir[1], load.reservoir[2]] : null;
    this.amount = this.reservoir ? Math.min(1, Math.max(0, load.amount)) : 0;
    this.well = load.pickup ? [load.pickup[0], load.pickup[1], load.pickup[2]] : null;
    this.pig =
      rates.mixing === 'pigment'
        ? { res: createPigment(this.reservoir ?? [0, 0, 0]), well: createPigment(this.well ?? [0, 0, 0]), paint: createPigment([0, 0, 0]), canvas: createPigment([0, 0, 0]) }
        : null;
  }

  /** What the brush carries now. */
  get load(): MixerLoad {
    return { reservoir: this.reservoir ? [...this.reservoir] : null, amount: this.amount, pickup: this.well ? [...this.well] : null };
  }

  /** The colour picked up so far, or `null`. */
  get pickup(): Readonly<RgbTriple> | null {
    return this.well;
  }

  /** The prepared pigment of the last `paint` colour (pigment mixing only), for `deposit`. */
  get paintPigment(): Pigment | null {
    return this.pig?.paint ?? null;
  }

  /** Recolours the reservoir without refilling it (a multi-coloured brush, per dab). */
  setReservoirColor(r: number, g: number, b: number): void {
    if (!this.reservoir) {
      this.reservoir = [r, g, b];
      this.amount = 1;
    } else {
      this.reservoir[0] = r;
      this.reservoir[1] = g;
      this.reservoir[2] = b;
    }
    if (this.pig) setPigmentColor(this.pig.res, r, g, b);
  }

  /** `a` mixed `t` of the way to `b` into `this.out`, by the mixing model. */
  private mix(a: RgbTriple, pa: Pigment | null, b: RgbTriple, pb: Pigment | null, t: number): RgbTriple {
    const o = this.out;
    if (pa && pb) lerpPigmentInto(pa, pb, t, o, 0);
    else for (let c = 0; c < 3; c++) o[c] = a[c] + (b[c] - a[c]) * t;
    return o;
  }

  /** `a` mixed `t` of the way to `b` (sRGB 0..1) by the mixing model, into `out`. */
  mixColors(a: readonly number[], b: readonly number[], t: number, out: number[]): number[] {
    if (this.pig) {
      setPigmentColor(this.pig.canvas, a[0], a[1], a[2]);
      setPigmentColor(this.pig.paint, b[0], b[1], b[2]);
      lerpPigmentInto(this.pig.canvas, this.pig.paint, t, out, 0);
    } else for (let c = 0; c < 3; c++) out[c] = a[c] + (b[c] - a[c]) * t;
    return out;
  }

  /** 1. Pick-up: the well moves towards the sampled colour (or takes it, when clean). */
  pickUp(sample: PaintSample | null): void {
    if (!sample || !(this.rates.pickup > 0)) return;
    const pig = this.pig;
    if (!this.well) this.well = [sample.rgb[0], sample.rgb[1], sample.rgb[2]];
    else {
      if (pig) setPigmentColor(pig.canvas, sample.rgb[0], sample.rgb[1], sample.rgb[2]);
      const o = this.mix(this.well, pig?.well ?? null, sample.rgb, pig?.canvas ?? null, this.rates.pickup * sample.contact);
      this.well = [o[0], o[1], o[2]];
    }
    if (pig) setPigmentColor(pig.well, this.well[0], this.well[1], this.well[2]);
  }

  /**
   * 2. The dab's paint: the reservoir mixed with the well, written to `out`. Returns the total
   * weight (≤ 0: nothing to lay down); deposit `min(1, weight)` of it. With pigment mixing,
   * `paintPigment` is the result's pigment afterwards.
   */
  paint(out: RgbTriple): number {
    const res = this.reservoir;
    const wr = res ? this.amount * (1 - this.rates.mix) : 0;
    const wp = this.well ? this.rates.mix : 0;
    const total = wr + wp;
    if (!(total > 1e-6)) return 0;
    const pig = this.pig;
    if (res && this.well) {
      const m = this.mix(res, pig?.res ?? null, this.well, pig?.well ?? null, wp / total);
      out[0] = m[0];
      out[1] = m[1];
      out[2] = m[2];
    } else {
      const c = res ?? this.well!;
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
    }
    if (pig) setPigmentColor(pig.paint, out[0], out[1], out[2]);
    return total;
  }

  /** 3. The reservoir drains. */
  drain(): void {
    this.amount *= 1 - this.rates.drain;
  }
}

/**
 * A brush's working tile: 8-bit bytes, or (on a 16- or 32-bit document) floats on the same
 * 0..255 sRGB-encoded scale, which keep the fractions an 8-bit tile would round away.
 */
export type PaintPixels = Uint8ClampedArray | Float32Array;

/** Writes `v` (0..1) into a working tile: rounded for bytes, kept exact (not below 0) for floats. */
export function put255(px: PaintPixels, i: number, v: number): void {
  if (px instanceof Float32Array) px[i] = v > 0 ? v * 255 : 0;
  else px[i] = Math.round(v * 255);
}

/** The pixels a brush reads and writes (RGBA tiles in layer space). */
export interface PaintTileTarget {
  /** The tile (TILE × TILE × 4) at (tx, ty) as it is now, or `null` when it is fully transparent. */
  readTile(tx: number, ty: number): PaintPixels | null;
  /** A writable tile at (tx, ty), returned by `readTile` from then on. */
  writeTile(tx: number, ty: number): PaintPixels;
  /** Layer offset: layer pixel = document pixel − offset. */
  offset: { x: number; y: number };
  /** Keep alpha and paint only where the layer has pixels. */
  lockTransparency: boolean;
  /** Selection coverage (document space, canvas-sized), or `null`. */
  selection: { width: number; height: number; data: ArrayLike<number> } | null;
}

/** The canvas side of the exchange: where a brush picks paint up and lays it down. */
export interface PaintMedium {
  /** The paint under a footprint (`cov` over `rect`, document space), or `null` where there is none. */
  sample(rect: RasterRect, cov: ArrayLike<number>): PaintSample | null;
  /**
   * Lays paint over the footprint at `dep × cov` per pixel. The colour is `paint` (with its
   * prepared pigment for pigment mixing), or per pixel from `field` (3 floats per pixel of
   * `rect`, sRGB 0..1) when given.
   */
  deposit(rect: RasterRect, cov: ArrayLike<number>, dep: number, paint: Readonly<RgbTriple>, paintPigment: Pigment | null, field?: Float32Array | null): void;
}

export interface TileMediumOptions {
  /**
   * How deposits combine with the pixels. Missing: the exchange's mixing (source-over, or a
   * pigment mix with pigment mixing), as the Mixer Brush paints. Otherwise any blend mode, as a
   * brush tip's `blend`.
   */
  blend?: BlendMode;
}

/** A raster layer's pixels as a `PaintMedium` (through live tiles). */
export class TileMedium implements PaintMedium {
  // The tile last looked up by `locate` (and whether it came from `writeTile`).
  private tx = NaN;
  private ty = NaN;
  private tile: PaintPixels | null = null;
  private writable = false;
  private readonly canvasPig = createPigment([0, 0, 0]);
  private readonly paintPig = createPigment([0, 0, 0]);
  private paintKey = -1;
  private readonly cb = [0, 0, 0, 0];
  private readonly src = [0, 0, 0, 1];
  private readonly o: number[] = [0, 0, 0];

  constructor(
    readonly target: PaintTileTarget,
    private readonly options: TileMediumOptions = {}
  ) {}

  /** Forgets the cached tile (call when another writer may have replaced tiles). */
  reset(): void {
    this.tx = NaN;
  }

  /**
   * The tile holding document pixel (dx, dy) (`pixels`) and the pixel's byte index in it, or -1
   * when reading an empty tile.
   */
  locate(dx: number, dy: number, write: boolean): number {
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

  /** The tile `locate` last found. */
  get pixels(): PaintPixels {
    return this.tile!;
  }

  /** Selection coverage at a document pixel, 0..1 (1 without a selection). */
  selectionAt(dx: number, dy: number): number {
    const sel = this.target.selection;
    if (!sel) return 1;
    if (dx < 0 || dy < 0 || dx >= sel.width || dy >= sel.height) return 0;
    return sel.data[dy * sel.width + dx] / 255;
  }

  sample(rect: RasterRect, cov: ArrayLike<number>): PaintSample | null {
    const w = rect.width;
    this.tx = NaN;
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
    if (!(asum > 1e-6)) return null;
    return { rgb: [ar / asum, ag / asum, ab / asum], contact: asum / Math.max(1e-6, wsum) };
  }

  deposit(rect: RasterRect, cov: ArrayLike<number>, dep: number, paint: Readonly<RgbTriple>, paintPigment: Pigment | null, field: Float32Array | null = null): void {
    const t = this.target;
    const sel = t.selection;
    const w = rect.width;
    const o = this.o;
    const blend = this.options.blend;
    // Pigment where the exchange mixes pigment (no blend given) or the blend is `pigment`.
    const pigment = blend === undefined ? paintPigment !== null : blend === 'pigment';
    const general = blend !== undefined && blend !== 'normal' && blend !== 'pigment';
    // Pigment mode keeps the last canvas colour's spectrum: runs of equal pixels are common.
    let lastKey = -1;
    this.tx = NaN;
    for (let yy = 0; yy < rect.height; yy++) {
      const dy = rect.y + yy;
      for (let xx = 0; xx < w; xx++) {
        const p = yy * w + xx;
        let k = cov[p] * dep;
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
        const pr = field ? field[p * 3] : paint[0];
        const pg = field ? field[p * 3 + 1] : paint[1];
        const pb = field ? field[p * 3 + 2] : paint[2];
        if (general) {
          const cb = this.cb;
          for (let c = 0; c < 4; c++) cb[c] = px[i + c] / 255;
          const src = this.src;
          src[0] = pr;
          src[1] = pg;
          src[2] = pb;
          const r = blendPixel(blend!, cb, src, k);
          put255(px, i, r[0]);
          put255(px, i + 1, r[1]);
          put255(px, i + 2, r[2]);
          if (!t.lockTransparency) put255(px, i + 3, r[3]);
          continue;
        }
        const a = px[i + 3] / 255;
        const na = t.lockTransparency ? a : a + (1 - a) * k;
        // The new paint's share of the result (source-over); a locked layer mixes by `k` alone.
        const share = t.lockTransparency ? k : na > 0 ? k / na : 1;
        if (a <= 0 || share >= 1) {
          o[0] = pr;
          o[1] = pg;
          o[2] = pb;
        } else if (pigment && field) {
          mixPigment8(Math.round(px[i]), Math.round(px[i + 1]), Math.round(px[i + 2]), Math.round(pr * 255), Math.round(pg * 255), Math.round(pb * 255), share, o);
        } else if (pigment) {
          // Float tiles (16 / 32 bits) hold fractions the 8-bit key would merge: no cache there.
          const key = px instanceof Float32Array ? -2 : (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
          if (key !== lastKey || key === -2) {
            setPigmentColor(this.canvasPig, px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
            lastKey = key;
          }
          let pp = paintPigment;
          if (!pp) {
            // A pigment-blend tip over an RGB exchange: prepare the paint colour once per colour.
            const pkey = (Math.round(pr * 255) << 16) | (Math.round(pg * 255) << 8) | Math.round(pb * 255);
            if (pkey !== this.paintKey) {
              setPigmentColor(this.paintPig, pr, pg, pb);
              this.paintKey = pkey;
            }
            pp = this.paintPig;
          }
          lerpPigmentInto(this.canvasPig, pp, share, o, 0);
        } else {
          o[0] = px[i] / 255 + (pr - px[i] / 255) * share;
          o[1] = px[i + 1] / 255 + (pg - px[i + 1] / 255) * share;
          o[2] = px[i + 2] / 255 + (pb - px[i + 2] / 255) * share;
        }
        put255(px, i, o[0]);
        put255(px, i + 1, o[1]);
        put255(px, i + 2, o[2]);
        put255(px, i + 3, na);
      }
    }
  }
}
