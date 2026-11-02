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
  /**
   * How the effect lies on the paint: fixed to the canvas (missing, the default), or along each
   * stroke (`by: 'stroke'`): the effect is rendered as a strip `length` px long and 256 px across,
   * and each pixel takes the colour at (distance along the stroke, position across the tip).
   */
  map?: PaintEffectStrokeMap;
  /**
   * Live: on a stroke layer the stroke keeps playing the effect (each frame drawn at the editor's
   * effect time); elsewhere it bakes the frame at `time` like any effect paint.
   */
  live?: boolean;
}

/** Effect paint laid along the stroke. */
export interface PaintEffectStrokeMap {
  by: 'stroke';
  /** Strip length: px of stroke per repeat of the effect, 16..4096. */
  length: number;
  /** Past the strip's end: start again, run back (mirror), or hold the last colour (clamp). */
  repeat: 'repeat' | 'mirror' | 'clamp';
}

/** How tall a stroke-mapped effect strip is rendered (the position across the tip maps onto it). */
export const EFFECT_STRIP_HEIGHT = 256;
export const EFFECT_MAP_REPEATS = ['repeat', 'mirror', 'clamp'] as const;

/** The size an effect paint renders at: the canvas, or its strip. */
export function effectPaintSize(p: PaintEffectPaint, canvas: { width: number; height: number }): { width: number; height: number } {
  return p.map ? { width: p.map.length, height: EFFECT_STRIP_HEIGHT } : { width: canvas.width, height: canvas.height };
}

/** A stroke map checked and rounded; throws a sentence naming the bad field. */
export function readEffectStrokeMap(raw: unknown): PaintEffectStrokeMap | undefined {
  if (raw === undefined || raw === null || (raw as { by?: unknown }).by === 'canvas') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.by !== 'stroke') throw new Error(`map.by ${JSON.stringify(r.by)} is not a mapping; use "canvas" (fixed to the canvas) or "stroke" (along each stroke).`);
  const length = r.length === undefined ? 300 : Number(r.length);
  if (!(Number.isFinite(length) && length >= 16 && length <= 4096)) throw new Error(`map.length ${JSON.stringify(r.length)} is out of range; use 16..4096 px of stroke per repeat.`);
  const repeat = r.repeat === undefined ? 'repeat' : r.repeat;
  if (!EFFECT_MAP_REPEATS.includes(repeat as never)) throw new Error(`map.repeat ${JSON.stringify(r.repeat)} is not a repeat mode; use ${EFFECT_MAP_REPEATS.join(', ')}.`);
  return { by: 'stroke', length: Math.round(length), repeat: repeat as PaintEffectStrokeMap['repeat'] };
}

/**
 * Straight-alpha RGBA an effect paint was rendered to: canvas-sized, or (with `map`) the strip
 * laid along each stroke.
 */
export interface EffectPaintPixels {
  width: number;
  height: number;
  data: ArrayLike<number>;
  map?: PaintEffectStrokeMap;
}

/** Where a dab is on its stroke, for effect paint laid along the stroke. */
export interface EffectDabPlace {
  x: number;
  y: number;
  /** Direction of travel, radians counter-clockwise with y up. */
  direction: number;
  /** The tip's radius (px): the position across the tip maps onto the strip's height. */
  radius: number;
  /** Path length (px) travelled to the dab. */
  travel: number;
}

/** The strip pixel index for a document point on a stroke-mapped effect, or -1. */
function stripIndex(img: EffectPaintPixels, map: PaintEffectStrokeMap, dab: EffectDabPlace, x: number, y: number): number {
  const ca = Math.cos(dab.direction);
  const sa = Math.sin(dab.direction);
  const dx = x - dab.x;
  const dy = y - dab.y;
  let u = (dab.travel + dx * ca - dy * sa) / map.length;
  if (map.repeat === 'clamp') u = Math.min(1, Math.max(0, u));
  else if (map.repeat === 'mirror') {
    const m = ((u % 2) + 2) % 2;
    u = m > 1 ? 2 - m : m;
  } else u = ((u % 1) + 1) % 1;
  const v = Math.min(1, Math.max(0, ((dx * sa + dy * ca) / Math.max(0.5, dab.radius) + 1) / 2));
  const px = Math.min(img.width - 1, Math.floor(u * img.width));
  const py = Math.min(img.height - 1, Math.floor(v * img.height));
  return (py * img.width + px) * 4;
}

/** The cache key of an effect paint (the same source renders the same pixels). */
export function effectPaintKey(p: PaintEffectPaint): string {
  // `live` changes when a frame is drawn, not its pixels.
  return JSON.stringify({ type: 'effect', effect: p.effect, provider: p.provider, values: p.values, time: p.time, ...(p.map ? { map: p.map } : {}) });
}

/** Whether a value is an effect paint (`{ type: 'effect', effect, … }`). */
export function isPaintEffectPaint(raw: unknown): raw is PaintEffectPaint {
  return Boolean(raw) && typeof raw === 'object' && (raw as { type?: unknown }).type === 'effect';
}

/** A saved stroke map, or `undefined` when it is missing or unreadable (documents are read leniently). */
function readMapLeniently(raw: unknown): PaintEffectStrokeMap | undefined {
  try {
    return readEffectStrokeMap(raw);
  } catch {
    return undefined;
  }
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
    ...(readMapLeniently(r.map) ? { map: readMapLeniently(r.map) } : {}),
    ...(r.live === true ? { live: true } : {}),
  };
}

/**
 * Takes a dab's colours from the effect: fills `field` (sRGB 0..1, 3 per pixel of `rect`, a
 * document rectangle) with the effect's colour at each pixel and multiplies `vals` by its alpha.
 * Pixels off the canvas paint nothing.
 */
export function sampleEffectField(img: EffectPaintPixels, rect: RasterRect, vals: Float32Array, field: Float32Array, dab?: EffectDabPlace | null): void {
  const { width, height, data } = img;
  if (img.map && dab) {
    for (let yy = 0, k = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < rect.width; xx++, k++) {
        const i = stripIndex(img, img.map, dab, rect.x + xx + 0.5, rect.y + yy + 0.5);
        const f = k * 3;
        const a = data[i + 3];
        if (a < 255) vals[k] *= a / 255;
        field[f] = data[i] / 255;
        field[f + 1] = data[i + 1] / 255;
        field[f + 2] = data[i + 2] / 255;
      }
    }
    return;
  }
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
export function sampleEffectAt(img: EffectPaintPixels, x: number, y: number, out: [number, number, number], dab?: EffectDabPlace | null): number {
  if (img.map && dab) {
    const i = stripIndex(img, img.map, dab, x, y);
    out[0] = img.data[i] / 255;
    out[1] = img.data[i + 1] / 255;
    out[2] = img.data[i + 2] / 255;
    return img.data[i + 3] / 255;
  }
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) return 0;
  const i = (py * img.width + px) * 4;
  out[0] = img.data[i] / 255;
  out[1] = img.data[i + 1] / 255;
  out[2] = img.data[i + 2] / 255;
  return img.data[i + 3] / 255;
}

/**
 * Effect colours for one dab of a brush that mixes paint (wet and impasto brushes): fills `field`
 * (sRGB 0..1, 3 per pixel of `rect`) with the effect's colour at each pixel, shifted by how far the
 * brush's mixed paint (`mixed`) moved from the effect's colour at the dab's centre (`centre`, which
 * the brush was loaded with), so paint the brush picked up still drags through the pattern. A clean
 * brush paints the effect's colours exactly. `cov` is multiplied by the effect's alpha, rounded to
 * `steps` levels when given (wet paint keeps its coverage on fixed steps so replays are exact).
 * `dab` places it on its stroke, for effect paint laid along the stroke.
 */
export function effectDabField(
  img: EffectPaintPixels,
  rect: RasterRect,
  cov: Float32Array,
  centre: readonly [number, number, number],
  mixed: readonly [number, number, number],
  field: Float32Array,
  steps = 0,
  dab: EffectDabPlace | null = null
): void {
  sampleEffectField(img, rect, cov, field, dab);
  const d0 = mixed[0] - centre[0];
  const d1 = mixed[1] - centre[1];
  const d2 = mixed[2] - centre[2];
  const n = rect.width * rect.height;
  for (let k = 0; k < n; k++) {
    if (steps) cov[k] = Math.round(cov[k] * steps) / steps;
    const f = k * 3;
    field[f] = Math.min(1, Math.max(0, field[f] + d0));
    field[f + 1] = Math.min(1, Math.max(0, field[f + 1] + d1));
    field[f + 2] = Math.min(1, Math.max(0, field[f + 2] + d2));
  }
}
