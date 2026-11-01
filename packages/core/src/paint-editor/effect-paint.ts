/**
 * Effect paint: a provider generator, overlay or title effect that brushes paint with. The effect
 * is rendered once at the canvas size when it is chosen; strokes then take each pixel's colour
 * from that image, fixed to the canvas, as if painting a hidden picture into view. The effect's
 * alpha multiplies the brush coverage, so a transparent part of an overlay paints nothing.
 *
 * Strokes are synchronous and effect renders are not, so the pixels are rendered (and cached by
 * source) before a stroke can use them; a stroke records the source, and replays render any
 * missing source before they paint.
 *
 * Kept out of the shared `PaintSource` union (`@pixerate/editor/paint`), which the image editor
 * shares: only the paint editor paints with effects.
 */

import type { EffectValue } from '../effects/types.js';
import type { RasterRect } from '../raster/surface';

/** What strokes paint with when they paint with a provider effect. */
export interface PaintEffectPaint {
  type: 'effect';
  /** The effect id (search_effects). */
  effect: string;
  /** The provider's id when it was chosen. */
  provider: string;
  /** Every control value. */
  values: Record<string, EffectValue>;
  /** Which moment of an animated effect, in ms. */
  time: number;
}

/** Canvas-sized straight-alpha RGBA an effect paint was rendered to. */
export interface EffectPaintPixels {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** The cache key of an effect paint (the same source renders the same pixels). */
export function effectPaintKey(p: PaintEffectPaint): string {
  return JSON.stringify({ type: 'effect', effect: p.effect, provider: p.provider, values: p.values, time: p.time });
}

/** Whether a value is an effect paint (`{ type: 'effect', effect, … }`). */
export function isPaintEffectPaint(raw: unknown): raw is PaintEffectPaint {
  return Boolean(raw) && typeof raw === 'object' && (raw as { type?: unknown }).type === 'effect';
}

/** A saved effect paint, or `null` when it is not one. */
export function readPaintEffectPaint(raw: unknown): PaintEffectPaint | null {
  if (!isPaintEffectPaint(raw)) return null;
  const r = raw as unknown as Record<string, unknown>;
  if (typeof r.effect !== 'string' || !r.effect || !r.values || typeof r.values !== 'object' || Array.isArray(r.values)) return null;
  return {
    type: 'effect',
    effect: r.effect,
    provider: typeof r.provider === 'string' ? r.provider : '',
    values: JSON.parse(JSON.stringify(r.values)) as Record<string, EffectValue>,
    time: typeof r.time === 'number' && Number.isFinite(r.time) && r.time > 0 ? r.time : 0,
  };
}

/**
 * Takes a dab's colours from the effect: fills `field` (sRGB 0..1, 3 per pixel of `rect`, a
 * document rectangle) with the effect's colour at each pixel and multiplies `vals` by its alpha.
 * Pixels off the canvas paint nothing.
 */
export function sampleEffectField(img: EffectPaintPixels, rect: RasterRect, vals: Float32Array, field: Float32Array): void {
  const { width, height, data } = img;
  for (let yy = 0, k = 0; yy < rect.height; yy++) {
    const y = rect.y + yy;
    const inY = y >= 0 && y < height;
    for (let xx = 0; xx < rect.width; xx++, k++) {
      const x = rect.x + xx;
      const f = k * 3;
      if (!inY || x < 0 || x >= width) {
        vals[k] = 0;
        field[f] = field[f + 1] = field[f + 2] = 0;
        continue;
      }
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a < 255) vals[k] *= a / 255;
      field[f] = data[i] / 255;
      field[f + 1] = data[i + 1] / 255;
      field[f + 2] = data[i + 2] / 255;
    }
  }
}

/** The effect's colour (sRGB 0..1 into `out`) at a document point; returns its alpha 0..1 (0 off the canvas). */
export function sampleEffectAt(img: EffectPaintPixels, x: number, y: number, out: [number, number, number]): number {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) return 0;
  const i = (py * img.width + px) * 4;
  out[0] = img.data[i] / 255;
  out[1] = img.data[i + 1] / 255;
  out[2] = img.data[i + 2] / 255;
  return img.data[i + 3] / 255;
}
