/**
 * Stamp tips: a dab, a particle dot or a spray droplet shaped like a sticker instead of the round
 * computed tip. An editor stamp (`editor:star`, or a bare `star`) is drawn from its coverage
 * function; any other sticker ref from its loaded art (`StickerArtCache`), by its alpha. The mark
 * is laid in the paint colour: a stamp tip takes the sticker's shape, never its colours (keep
 * those with `marks: objects`, which lays editable stickers).
 */

import type { RasterRect as CropBox } from '../raster/surface';
import { stampCoverage, type StampKind } from '../stickers/stamps';
import { editorStampOf } from '../stickers/helpers';
import type { StickerArtLookup } from './sticker-art';

/** Coverage 0..1 of a stamp at (u, v) of its unit square (−1..1, y down); `seed` varies shapes with random parts. */
export type StampSampler = (u: number, v: number, seed: number) => number;

const samplers = new WeakMap<object, StampSampler>();

/**
 * The sampler of a stamp ref: an editor stamp's coverage, or the alpha of a sticker's loaded art
 * (bilinear, centred in the unit square, aspect kept). `null` when the art is not loaded (or the
 * ref is not a sticker): the caller paints the round tip instead.
 */
export function stampSampler(ref: string, art?: StickerArtLookup): StampSampler | null {
  let kind: StampKind | null = null;
  try {
    kind = editorStampOf(ref.includes(':') ? ref : `editor:${ref}`);
  } catch {
    return null;
  }
  if (kind) {
    const k = kind;
    return (u, v, seed) => stampCoverage(k, u, v, seed);
  }
  const a = art?.(ref);
  if (!a || !(a.width > 0 && a.height > 0)) return null;
  const hit = samplers.get(a);
  if (hit) return hit;
  const { width: w, height: h, data } = a;
  // The art's longest side spans the unit square.
  const scale = Math.max(w, h) / 2;
  const alpha = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[(y * w + x) * 4 + 3] / 255);
  const sampler: StampSampler = (u, v) => {
    const x = u * scale + w / 2 - 0.5;
    const y = v * scale + h / 2 - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    return (alpha(x0, y0) * (1 - fx) + alpha(x0 + 1, y0) * fx) * (1 - fy) + (alpha(x0, y0 + 1) * (1 - fx) + alpha(x0 + 1, y0 + 1) * fx) * fy;
  };
  samplers.set(a, sampler);
  return sampler;
}

/** A dab of a stamp tip: centre, radius (px), roundness squashing it across, angle (radians, counter-clockwise) and flow. */
export interface StampDab {
  x: number;
  y: number;
  radius: number;
  roundness: number;
  angle: number;
  alpha: number;
}

/** The pixel rectangle a stamp dab can touch. */
export function stampDabRect(d: StampDab): CropBox {
  const r = Math.max(0.5, d.radius) * Math.SQRT2 + 1.5;
  const x0 = Math.floor(d.x - r);
  const y0 = Math.floor(d.y - r);
  return { x: x0, y: y0, width: Math.ceil(d.x + r) - x0, height: Math.ceil(d.y + r) - y0 };
}

/**
 * Rasterizes one stamp dab over `rect` into `out` (coverage × flow): the stamp's unit square spans
 * the tip's diameter, squashed by roundness and turned by the tip angle as a round tip would be.
 * Small dabs are supersampled.
 */
export function rasterizeStampDab(d: StampDab, sample: StampSampler, seed: number, rect: CropBox, out: Float32Array): void {
  const w = rect.width;
  const h = rect.height;
  out.fill(0, 0, w * h);
  const r = Math.max(0.5, d.radius);
  const ro = Math.min(1, Math.max(0.05, d.roundness));
  const sn = Math.sin(d.angle);
  const cs = Math.cos(d.angle);
  const ss = r < 6 ? 3 : 1;
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      let sum = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const dx = rect.x + xx + (sx + 0.5) / ss - d.x;
          const dy = rect.y + yy + (sy + 0.5) / ss - d.y;
          // Into the tip's frame (the angle turns counter-clockwise on screen, y down), then the unit square.
          const u = (dx * cs - dy * sn) / r;
          const v = (dx * sn + dy * cs) / (r * ro);
          if (u > -1.05 && u < 1.05 && v > -1.05 && v < 1.05) sum += sample(u, v, seed);
        }
      }
      const val = sum / (ss * ss);
      if (val > 0) out[yy * w + xx] = Math.min(1, val) * d.alpha;
    }
  }
}

/** The sticker refs a brush lays that need loaded art (provider stickers; editor stamps need none). */
export function brushStickerRefs(brush: { engine: string; stamp: string | null; sticker: { stamps: readonly string[] }; particle: { dotTextures: readonly string[] } }): string[] {
  const refs = brush.engine === 'sticker' ? [...brush.sticker.stamps] : brush.engine === 'particle' ? [...brush.particle.dotTextures] : brush.engine === 'dab' && brush.stamp ? [brush.stamp] : [];
  return [...new Set(refs.filter((r) => r.includes(':') && !r.startsWith('editor:')))];
}
