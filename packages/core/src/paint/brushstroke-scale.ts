/**
 * Zoom buckets for brushstroke images, on their own with no imports so a canvas can bucket its
 * zoom without loading the brush engine.
 */

export const BRUSHSTROKE_MIN_SCALE = 1 / 16;
export const BRUSHSTROKE_MAX_SCALE = 16;

/**
 * The scale to render at for a zoom (and device pixel ratio): the smallest power of √2 at or above
 * it, clamped to 1/16..16. Every zoom in a bucket shares one cached image and never draws it
 * enlarged by more than √2.
 */
export function brushstrokeScaleBucket(zoom: number, devicePixelRatio = 1): number {
  const s = zoom * devicePixelRatio;
  if (!Number.isFinite(s) || s <= 0) return 1;
  const b = Math.pow(Math.SQRT2, Math.ceil(Math.log2(Math.min(BRUSHSTROKE_MAX_SCALE, Math.max(BRUSHSTROKE_MIN_SCALE, s))) * 2 - 1e-9));
  return Math.min(BRUSHSTROKE_MAX_SCALE, Math.max(BRUSHSTROKE_MIN_SCALE, Math.round(b * 1e9) / 1e9));
}

