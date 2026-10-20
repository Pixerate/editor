/**
 * Blending tools on raster tiles, dab by dab (any dab walker can drive them):
 *
 * - **Blender** (`blenderDab`): every pixel under the tip moves towards the mix of the paint
 *   within `distance` of it, so neighbouring colours run together. The mix is taken through the
 *   pigment model: the neighbourhood's K/S spectra are averaged with Kubelka-Munk weights
 *   (alpha × scattering), so blue next to yellow blends into green, not grey. `rgb` averages
 *   straight colours instead.
 * - **Smudge** (`SmudgeTip`): a finger that carries a patch of paint. Each dab lays the patch it
 *   carries over the pixels under the tip (`strength`) and picks up some of the paint that was
 *   there (`1 − length`), so the paint's pattern is dragged along the stroke and fades with distance.
 *   Optional pigment mixing for both steps.
 *
 * Both blend alpha too: blending next to bare canvas softens an edge, smudging drags paint out
 * into it. A transparency-locked layer keeps its alpha. Pure data in, pixels out.
 */

import { mixPigment8, pigment8 } from '../raster/blend';
import { PIGMENT_BANDS, lerpPigmentInto, type Pigment } from '../raster/pigment';
import type { RasterRect } from '../raster/surface';
import { put255, type MixingModel, type TileMedium } from './exchange';

/** Blender options. */
export interface BlenderSettings {
  /** How far each pixel moves towards the neighbourhood mix per dab at full coverage, 0..1 (default 0.5). */
  strength: number;
  /** Blend distance: the neighbourhood's radius as a fraction of the tip diameter, 0..1 (default 0.35). */
  distance: number;
  /** `pigment` (default: Kubelka-Munk, blue next to yellow blends green) or `rgb`. */
  mixing: MixingModel;
}

export const DEFAULT_BLENDER: Readonly<BlenderSettings> = { strength: 0.5, distance: 0.35, mixing: 'pigment' };

/** Smudge options. */
export interface SmudgeSettings {
  /** How strongly the carried paint covers the pixels under the tip per dab, 0..1 (default 0.7). */
  strength: number;
  /** How far paint is dragged: the share of the carried patch kept per dab, 0..1 (default 0.85). */
  length: number;
  /** `rgb` (default) or `pigment` (smeared colours mix like paint). */
  mixing: MixingModel;
}

export const DEFAULT_SMUDGE: Readonly<SmudgeSettings> = { strength: 0.7, length: 0.85, mixing: 'rgb' };

const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

export function normalizeBlender(raw: Partial<BlenderSettings> = {}, base: BlenderSettings = DEFAULT_BLENDER): BlenderSettings {
  return { strength: unit(raw.strength, base.strength), distance: unit(raw.distance, base.distance), mixing: raw.mixing === 'rgb' || raw.mixing === 'pigment' ? raw.mixing : base.mixing };
}

export function normalizeSmudge(raw: Partial<SmudgeSettings> = {}, base: SmudgeSettings = DEFAULT_SMUDGE): SmudgeSettings {
  return { strength: unit(raw.strength, base.strength), length: unit(raw.length, base.length), mixing: raw.mixing === 'rgb' || raw.mixing === 'pigment' ? raw.mixing : base.mixing };
}

/** The neighbourhood radius in pixels of a blender dab of `radius`. */
export function blendRadius(settings: BlenderSettings, radius: number): number {
  return Math.max(1, Math.round(settings.distance * 2 * radius));
}

/** Reusable buffers for `blenderDab` (one per stroke). */
export interface BlenderScratch {
  sums: Float64Array;
  mix: Pigment;
  out: number[];
}

export function createBlenderScratch(): BlenderScratch {
  return { sums: new Float64Array(0), mix: { rgb: [0, 0, 0], strength: 1, ks: new Float32Array(PIGMENT_BANDS), scatter: 1 }, out: [0, 0, 0] };
}

const N = PIGMENT_BANDS;

/**
 * One blender dab: `cov` is the tip's coverage over `rect` (document space, 0..1), `opacity` the
 * dab's (pressure) opacity, `radius` its radius in pixels. Reads the neighbourhood as it was
 * before the dab, then writes every covered pixel.
 */
export function blenderDab(medium: TileMedium, rect: RasterRect, cov: ArrayLike<number>, opacity: number, radius: number, settings: BlenderSettings, scratch: BlenderScratch): void {
  const R = blendRadius(settings, radius);
  const W = rect.width + 2 * R;
  const H = rect.height + 2 * R;
  const pigment = settings.mixing === 'pigment';
  // Channels per pixel: pigment: S·a·K/S per band, S·a, a, r·a, g·a, b·a; rgb: r·a, g·a, b·a, a.
  const C = pigment ? N + 2 : 4;
  const stride = (W + 1) * C;
  const size = stride * (H + 1);
  if (scratch.sums.length < size) scratch.sums = new Float64Array(size);
  const I = scratch.sums;
  I.fill(0, 0, size);
  medium.reset();
  // Summed-area table over the region (row 0 and column 0 stay zero).
  const row = new Float64Array(C);
  for (let y = 0; y < H; y++) {
    row.fill(0);
    const dy = rect.y - R + y;
    for (let x = 0; x < W; x++) {
      const dx = rect.x - R + x;
      const i = medium.locate(dx, dy, false);
      if (i >= 0) {
        const px = medium.pixels;
        const a = px[i + 3] / 255;
        if (a > 0) {
          if (pigment) {
            const p = pigment8(Math.round(px[i]), Math.round(px[i + 1]), Math.round(px[i + 2]));
            const sa = p.scatter * p.strength * a;
            for (let k = 0; k < N; k++) row[k] += sa * p.ks[k];
            row[N] += sa;
            row[N + 1] += a;
          } else {
            row[0] += (px[i] / 255) * a;
            row[1] += (px[i + 1] / 255) * a;
            row[2] += (px[i + 2] / 255) * a;
            row[3] += a;
          }
        }
      }
      const o = (y + 1) * stride + (x + 1) * C;
      const up = y * stride + (x + 1) * C;
      for (let c = 0; c < C; c++) I[o + c] = I[up + c] + row[c];
    }
  }
  const area = (2 * R + 1) * (2 * R + 1);
  const strength = settings.strength * opacity;
  const lock = medium.target.lockTransparency;
  const mixPig = scratch.mix;
  const out = scratch.out;
  const sum = (c: number, x1: number, y1: number, x2: number, y2: number) => I[y2 * stride + x2 * C + c] - I[y1 * stride + x2 * C + c] - I[y2 * stride + x1 * C + c] + I[y1 * stride + x1 * C + c];
  const w = rect.width;
  medium.reset();
  for (let yy = 0; yy < rect.height; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const k = cov[yy * w + xx];
      if (k <= 0) continue;
      const dx = rect.x + xx;
      const dy = rect.y + yy;
      let t = strength * k * medium.selectionAt(dx, dy);
      if (t <= 0) continue;
      if (t > 1) t = 1;
      // The window [x − R, x + R] in region coordinates, as summed-area bounds.
      const x1 = xx;
      const y1 = yy;
      const x2 = xx + 2 * R + 1;
      const y2 = yy + 2 * R + 1;
      const asum = sum(pigment ? N + 1 : 3, x1, y1, x2, y2);
      const ri = medium.locate(dx, dy, false);
      const a = ri < 0 ? 0 : medium.pixels[ri + 3] / 255;
      if (lock && a <= 0) continue;
      const avgA = asum / area;
      const na = lock ? a : (1 - t) * a + t * avgA;
      if (asum <= 1e-9) {
        // Only bare canvas nearby: the paint thins out (edges soften).
        if (lock || a <= 0) continue;
        const i = medium.locate(dx, dy, true);
        put255(medium.pixels, i + 3, na);
        continue;
      }
      // The neighbourhood's share of the paint in the result.
      const share = lock ? t : na > 0 ? (t * avgA) / na : 1;
      const i = medium.locate(dx, dy, true);
      const px = medium.pixels;
      if (pigment) {
        const sa = sum(N, x1, y1, x2, y2);
        for (let c = 0; c < N; c++) mixPig.ks[c] = sum(c, x1, y1, x2, y2) / sa;
        mixPig.scatter = sa / asum;
        if (a <= 0 || share >= 1) lerpPigmentInto(mixPig, mixPig, 0, out, 0);
        else lerpPigmentInto(pigment8(Math.round(px[i]), Math.round(px[i + 1]), Math.round(px[i + 2])), mixPig, share, out, 0);
      } else {
        for (let c = 0; c < 3; c++) {
          const m = sum(c, x1, y1, x2, y2) / asum;
          out[c] = a <= 0 || share >= 1 ? m : px[i + c] / 255 + (m - px[i + c] / 255) * share;
        }
      }
      put255(px, i, out[0]);
      put255(px, i + 1, out[1]);
      put255(px, i + 2, out[2]);
      if (!lock) put255(px, i + 3, na);
    }
  }
}

/** A dab as the smudge needs it: centre, radius (px) and pressure opacity. */
export interface SmudgeDab {
  x: number;
  y: number;
  radius: number;
  opacity: number;
}

/**
 * A smudging finger: carries a patch of paint (straight RGBA, `size × size` cells over the tip,
 * in canvas orientation) from dab to dab. The first dab only picks the patch up.
 */
export class SmudgeTip {
  private readonly size: number;
  private readonly patch: Float32Array;
  private loaded = false;
  private readonly out = [0, 0, 0];

  constructor(
    readonly settings: SmudgeSettings,
    /** The largest tip diameter of the stroke, in pixels (the patch resolution). */
    diameter: number
  ) {
    this.size = Math.max(2, Math.min(512, Math.ceil(diameter)));
    this.patch = new Float32Array(this.size * this.size * 4);
  }

  private cell(d: SmudgeDab, px: number, py: number): number {
    const s = this.size;
    const r = Math.max(0.5, d.radius);
    const bx = Math.min(s - 1, Math.max(0, Math.floor((((px - d.x) / r + 1) / 2) * s)));
    const by = Math.min(s - 1, Math.max(0, Math.floor((((py - d.y) / r + 1) / 2) * s)));
    return (by * s + bx) * 4;
  }

  /** Fills the patch from the pixels under the dab. */
  private load(medium: TileMedium, d: SmudgeDab): void {
    const s = this.size;
    const r = Math.max(0.5, d.radius);
    medium.reset();
    for (let by = 0; by < s; by++) {
      for (let bx = 0; bx < s; bx++) {
        const dx = Math.floor(d.x + (((bx + 0.5) / s) * 2 - 1) * r);
        const dy = Math.floor(d.y + (((by + 0.5) / s) * 2 - 1) * r);
        const i = medium.locate(dx, dy, false);
        const c = (by * s + bx) * 4;
        if (i < 0) {
          this.patch.fill(0, c, c + 4);
          continue;
        }
        const px = medium.pixels;
        this.patch[c] = px[i] / 255;
        this.patch[c + 1] = px[i + 1] / 255;
        this.patch[c + 2] = px[i + 2] / 255;
        this.patch[c + 3] = px[i + 3] / 255;
      }
    }
    this.loaded = true;
  }

  /** `a` mixed `t` of the way to `b` (both 0..1) into `out`. */
  private mix(a0: number, a1: number, a2: number, b0: number, b1: number, b2: number, t: number): number[] {
    const o = this.out;
    if (this.settings.mixing === 'pigment') {
      mixPigment8(Math.round(a0 * 255), Math.round(a1 * 255), Math.round(a2 * 255), Math.round(b0 * 255), Math.round(b1 * 255), Math.round(b2 * 255), t, o);
    } else {
      o[0] = a0 + (b0 - a0) * t;
      o[1] = a1 + (b1 - a1) * t;
      o[2] = a2 + (b2 - a2) * t;
    }
    return o;
  }

  /** One dab: lays the carried patch over the tip's footprint (`cov` over `rect`), then picks up. */
  dab(medium: TileMedium, d: SmudgeDab, rect: RasterRect, cov: ArrayLike<number>): void {
    if (!this.loaded) {
      this.load(medium, d);
      return;
    }
    const { strength, length } = this.settings;
    const lock = medium.target.lockTransparency;
    const patch = this.patch;
    const w = rect.width;
    medium.reset();
    for (let yy = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const cv = cov[yy * w + xx];
        if (cv <= 0) continue;
        const dx = rect.x + xx;
        const dy = rect.y + yy;
        let k = strength * cv * d.opacity * medium.selectionAt(dx, dy);
        if (k <= 0) continue;
        if (k > 1) k = 1;
        const c = this.cell(d, dx + 0.5, dy + 0.5);
        const ba = patch[c + 3];
        const ri = medium.locate(dx, dy, false);
        const a = ri < 0 ? 0 : medium.pixels[ri + 3] / 255;
        if (lock && a <= 0) continue;
        // The pixel as it was: what the finger lays paint over, and what it picks up afterwards.
        const px0 = ri >= 0 ? medium.pixels : null;
        const o0 = px0 ? px0[ri] / 255 : 0;
        const o1 = px0 ? px0[ri + 1] / 255 : 0;
        const o2 = px0 ? px0[ri + 2] / 255 : 0;
        if (a > 0 || ba > 0) {
          const na = lock ? a : a + (ba - a) * k;
          const share = lock ? k * ba : na > 0 ? (k * ba) / na : 0;
          let r = o0;
          let g = o1;
          let b = o2;
          if (a <= 0 || share >= 1) {
            r = patch[c];
            g = patch[c + 1];
            b = patch[c + 2];
          } else if (share > 0) {
            const m = this.mix(o0, o1, o2, patch[c], patch[c + 1], patch[c + 2], share);
            r = m[0];
            g = m[1];
            b = m[2];
          }
          const i = medium.locate(dx, dy, true);
          const out = medium.pixels;
          put255(out, i, r);
          put255(out, i + 1, g);
          put255(out, i + 2, b);
          put255(out, i + 3, na);
        }
        // Pick up: the patch takes `1 − length` of the paint that was under it (alpha-weighted).
        const pick = (1 - length) * Math.min(1, cv * d.opacity);
        if (pick > 0) {
          const pa = ba + (a - ba) * pick;
          const s = pa > 0 ? (a * pick) / pa : 0;
          if (s > 0) {
            const m = ba <= 0 || s >= 1 ? [o0, o1, o2] : this.mix(patch[c], patch[c + 1], patch[c + 2], o0, o1, o2, s);
            patch[c] = m[0];
            patch[c + 1] = m[1];
            patch[c + 2] = m[2];
          }
          patch[c + 3] = pa;
        }
      }
    }
  }
}
