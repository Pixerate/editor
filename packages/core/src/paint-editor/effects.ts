/**
 * Provider effects in the paint editor (see `@pixerate/editor/effects`):
 *
 * - **Effect paper**: a generator drawn over the paper, under the paint (multiplied by default, so
 *   the paper's grain and colour still show). It is part of the document: undo, save and export.
 * - **Effect layers**: pixel layers drawn by a generator, overlay or title effect. The layer keeps
 *   its effect, so it can be drawn again with new values; painting on it works as on any layer.
 * - **Effect fills**: a generator, overlay or title effect composited onto a layer's pixels.
 * - **Light on dried paint**: a filter effect (light, glow, grade) run on a layer's paint and baked
 *   in. Wet paint is dried first, in the same undo step; thick paint keeps its relief.
 *
 * Effects render asynchronously, so each change renders first and commits after (one undo step).
 */

import { EffectUnsupportedError } from '../effects/errors.js';
import { EffectRendererPool } from '../effects/pool.js';
import type { EffectDescription, EffectPixels, EffectProvider, EffectRenderRequest, EffectUse, EffectValue } from '../effects/types.js';
import { decodePng, parseDataUrl, pngDataUrl } from '../raster/png';

/** Which uses each place in the paint editor takes. */
export const PAINT_EFFECT_PLACES = {
  /** Effect paper: drawn over the whole sheet. */
  paper: ['generator'],
  /** An effect layer: drawn at the canvas size. */
  layer: ['generator', 'overlay', 'title'],
  /** An effect fill: composited onto a layer's pixels. */
  fill: ['generator', 'overlay', 'title'],
  /** Light (or any filter) on a layer's dried paint. */
  light: ['filter'],
} as const satisfies Record<string, readonly EffectUse[]>;

export type PaintEffectPlace = keyof typeof PAINT_EFFECT_PLACES;

const PLACE_WORDS: Record<PaintEffectPlace, string> = {
  paper: 'effect paper takes generator effects',
  layer: 'an effect layer takes generator, overlay or title effects',
  fill: 'an effect fill takes generator, overlay or title effects',
  light: 'light on dried paint takes filter effects',
};

/** Refuses an effect that cannot go in `place`, saying what to use instead. */
export function checkPaintEffectPlace(d: EffectDescription, place: PaintEffectPlace): void {
  const allowed: readonly EffectUse[] = PAINT_EFFECT_PLACES[place];
  if (d.kind !== 'motion' && d.kind !== 'vector' && d.uses.some((u) => allowed.includes(u))) return;
  let instead = '';
  if (d.uses.includes('filter') && place !== 'light') instead = '; run it on a layer\'s dried paint with apply_effect instead';
  else if (place === 'light' && d.uses.some((u) => (PAINT_EFFECT_PLACES.layer as readonly string[]).includes(u))) instead = '; add it as an effect layer (add_effect_layer) or fill a layer with it (fill_layer_with_effect) instead';
  else if (place === 'paper' && d.uses.some((u) => u === 'overlay' || u === 'title')) instead = '; add it as an effect layer with add_effect_layer instead';
  throw new EffectUnsupportedError(`"${d.id}" (${d.name}) is a ${d.uses.join(' / ') || d.kind} effect, and ${PLACE_WORDS[place]}${instead}.`, d.id);
}

/** The provider effect a layer or the paper is drawn from. */
export interface PaintEffectSource {
  effect: string;
  /** The provider's id when it was drawn. */
  provider?: string;
  /** The effect's name when it was drawn (for placeholders without the provider). */
  name?: string;
  /** Every control value. */
  values: Record<string, EffectValue>;
  /** Which moment of an animated effect, in ms (missing: 0). */
  time?: number;
}

/** Blend modes effect paper draws with. */
export const PAPER_EFFECT_BLENDS = ['multiply', 'normal', 'overlay', 'soft-light', 'screen', 'color'] as const;
export type PaperEffectBlend = (typeof PAPER_EFFECT_BLENDS)[number];

/** Effect paper: its effect, how it is drawn over the sheet, and its rendered pixels. */
export interface PaintPaperEffect extends PaintEffectSource {
  /** 0..1 (default 1). */
  opacity: number;
  /** How it draws over the paper (default `multiply`, which keeps the paper's grain and colour). */
  blend: PaperEffectBlend;
  /** Canvas-sized straight-alpha RGBA. */
  image: { width: number; height: number; data: Uint8ClampedArray };
  /** Changes whenever the pixels change (render caches key on it). */
  version: number;
}

let paperVersion = 1;

/** A new version number for effect paper pixels. */
export function nextPaperEffectVersion(): number {
  return paperVersion++;
}

/** Over-composites `top` onto `base` at `opacity` (straight alpha, same size). */
export function overPixels(base: Uint8ClampedArray, top: ArrayLike<number>, opacity = 1): Uint8ClampedArray {
  const out = new Uint8ClampedArray(base.length);
  for (let i = 0; i < out.length; i += 4) {
    const ta = (top[i + 3] / 255) * opacity;
    const ba = base[i + 3] / 255;
    const a = ta + ba * (1 - ta);
    out[i + 3] = Math.round(a * 255);
    if (a > 0) for (let c = 0; c < 3; c++) out[i + c] = (top[i + c] * ta + base[i + c] * ba * (1 - ta)) / a;
  }
  return out;
}

/** Mixes `after` back towards `before` by `1 - amount` (for a filter at partial strength), keeping `before`'s alpha. */
export function mixPixels(before: Uint8ClampedArray, after: ArrayLike<number>, amount: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(before.length);
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = before[i + c] + (after[i + c] - before[i + c]) * amount;
    out[i + 3] = before[i + 3];
  }
  return out;
}

/**
 * Renders effects for one paint editor through a small renderer pool (GPU providers hold a
 * graphics context per renderer). Output always has the asked size.
 */
export class PaintEffectsRenderer {
  private readonly pool = new EffectRendererPool({ maxRenderers: 3 });
  private readonly descriptions = new Map<string, Promise<EffectDescription>>();
  private provider: EffectProvider | null = null;

  /** Forgets cached descriptions and renderers when the provider changes. */
  follow(provider: EffectProvider | null): void {
    if (provider === this.provider) return;
    this.provider = provider;
    this.descriptions.clear();
    this.pool.clear();
  }

  describe(provider: EffectProvider, id: string): Promise<EffectDescription> {
    this.follow(provider);
    let d = this.descriptions.get(id);
    if (!d) {
      d = Promise.resolve().then(() => provider.describe(id));
      d.catch(() => this.descriptions.delete(id));
      this.descriptions.set(id, d);
    }
    return d;
  }

  async render(provider: EffectProvider, id: string, size: { width: number; height: number }, request: EffectRenderRequest): Promise<EffectPixels> {
    this.follow(provider);
    const out = await this.pool.render(provider, id, { ...size, depth: 8 }, request);
    if (out.width !== size.width || out.height !== size.height || out.data.length !== size.width * size.height * 4) {
      throw new Error(`The effect "${id}" returned ${out.width}×${out.height} pixels for a ${size.width}×${size.height} canvas.`);
    }
    return out;
  }

  dispose(): void {
    this.pool.clear();
    this.descriptions.clear();
  }
}

const sourceOut = (s: PaintEffectSource): PaintEffectSource => ({
  effect: s.effect,
  ...(s.provider ? { provider: s.provider } : {}),
  ...(s.name ? { name: s.name } : {}),
  values: JSON.parse(JSON.stringify(s.values)),
  ...(s.time ? { time: s.time } : {}),
});

/** A saved effect source, or `null` when it is not one. */
export function readPaintEffectSource(raw: unknown): PaintEffectSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.effect !== 'string' || !r.effect || !r.values || typeof r.values !== 'object' || Array.isArray(r.values)) return null;
  return {
    effect: r.effect,
    ...(typeof r.provider === 'string' ? { provider: r.provider } : {}),
    ...(typeof r.name === 'string' ? { name: r.name } : {}),
    values: r.values as Record<string, EffectValue>,
    ...(typeof r.time === 'number' && r.time > 0 ? { time: r.time } : {}),
  };
}

/** Effect paper as saved: its settings and its pixels as a PNG data URL. */
export function paperEffectToJSON(p: PaintPaperEffect): Record<string, unknown> {
  return { ...sourceOut(p), opacity: p.opacity, blend: p.blend, png: pngDataUrl(p.image.width, p.image.height, p.image.data) };
}

/** Reads saved effect paper for a `width × height` canvas (throws saying what is wrong). */
export function paperEffectFromJSON(raw: unknown, width: number, height: number): PaintPaperEffect {
  const source = readPaintEffectSource(raw);
  if (!source) throw new Error('it is not an effect (effect id and values)');
  const r = raw as Record<string, unknown>;
  const parsed = typeof r.png === 'string' ? parseDataUrl(r.png) : null;
  if (!parsed) throw new Error('its pixels are missing');
  const image = decodePng(parsed.bytes);
  if (image.width !== width || image.height !== height) throw new Error(`its pixels are ${image.width}×${image.height}, not the canvas size ${width}×${height}`);
  const opacity = typeof r.opacity === 'number' && r.opacity >= 0 && r.opacity <= 1 ? r.opacity : 1;
  const blend = (PAPER_EFFECT_BLENDS as readonly string[]).includes(r.blend as string) ? (r.blend as PaperEffectBlend) : 'multiply';
  return { ...source, opacity, blend, image: { width, height, data: new Uint8ClampedArray(image.data) }, version: nextPaperEffectVersion() };
}

/** Effect layers as saved (layer id → effect). */
export function effectLayersToJSON(map: Readonly<Record<string, PaintEffectSource>>, keep: (id: string) => boolean): Record<string, PaintEffectSource> | undefined {
  const out: Record<string, PaintEffectSource> = {};
  for (const [id, s] of Object.entries(map)) if (keep(id)) out[id] = sourceOut(s);
  return Object.keys(out).length ? out : undefined;
}
