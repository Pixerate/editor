/**
 * Stickers: textured stamps sprayed along a stroke onto a sticker layer, where each stays an object
 * that can be moved, turned, resized, recoloured or deleted afterwards. A sticker layer is a pixel
 * layer whose pixels are drawn from its stickers (`renderStickers`), so the compositor, exports and
 * every layer operation see ordinary pixels.
 *
 * The stamps are our own procedural shapes (dot, star, heart, leaf, petal flower, confetti, splat,
 * sparkle, ring), each with a little shading and a seeded paper-like texture, so no artwork is
 * bundled. The spray (`StickerSpray`) is deterministic: the same points, seed and brush give the
 * same stickers.
 */

import { TILE, TiledSurface, finishTile, tileKey, tilesInRect, type RasterRect, type Tile, type TileKey } from '../raster/surface';
import { TileMedium, type PaintTileTarget } from '../paint/exchange';
import { PaintGradientSampler, type PaintGradientSource } from '../paint/gradient-paint';
import type { PaintBrush } from './brushes';
import { IDENTITY_COPY, PenDabWalker, PenSmoother, type PenDab, type PenPoint, type StrokeCopy } from './engine';
import { hash2, rand01 } from './noise';
import { STAMP_KINDS, stampCoverage, type StampKind } from '../stickers/stamps';
import { editorStampOf, normalizeStickerRef } from '../stickers/helpers';
import type { StickerRef, StickerVariant } from '../stickers/types';
import { sampleArt, type StickerArt, type StickerArtLookup } from './sticker-art';

export { STAMP_KINDS, stampCoverage, type StampKind } from '../stickers/stamps';
export { DEFAULT_STICKER, MAX_STICKER_STAMPS, normalizeStickerSettings, STICKER_FRAME_MODES, type StickerFrameMode, type StickerSettings } from './mark-settings';
import type { StickerSettings } from './mark-settings';
import { sampleEffectAt, type EffectPaintPixels } from './effect-paint';
import { oklabToOklch, oklabToRgb, oklchToOklab, rgbToOklab } from '../color/convert';

/** One sticker (document pixels). */
export interface Sticker {
  id: string;
  /** What it shows: a sticker ref (`provider:id`), e.g. `editor:star` or a host library's sticker. */
  ref: StickerRef;
  /** The editor stamp, when `ref` is one (`editor:star` → `star`); kept for documents and code that read it. */
  stamp?: StampKind;
  x: number;
  y: number;
  /** Diameter in pixels. */
  size: number;
  /** Degrees clockwise. */
  rotation: number;
  /** #rrggbb */
  color: string;
  /** 0..1 */
  opacity: number;
  /** Texture seed. */
  seed: number;
  /**
   * `dark` when it is drawn in its sticker's dark variant (sprayed or placed while the editor's
   * colour scheme was dark and the sticker has one); absent for the light art.
   */
  variant?: StickerVariant;
  /** 0-based animation frame index when the sticker is animated; absent when 0 or static. */
  frame?: number;
}

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The pixel rectangle a sticker covers. */
export function stickerRect(s: Sticker): RasterRect {
  const r = s.size / 2 + 1;
  const x0 = Math.floor(s.x - r);
  const y0 = Math.floor(s.y - r);
  return { x: x0, y: y0, width: Math.ceil(s.x + r) - x0, height: Math.ceil(s.y + r) - y0 };
}

/** The editor stamp a sticker shows, or `null` for a provider's sticker. */
export function stickerStamp(s: Pick<Sticker, 'ref' | 'stamp'>): StampKind | null {
  if (s.ref) {
    try {
      return editorStampOf(s.ref);
    } catch {
      return null;
    }
  }
  return s.stamp && STAMP_KINDS.includes(s.stamp) ? s.stamp : null;
}

/**
 * Draws one sticker through a `TileMedium` (straight source-over). An editor stamp: its coverage,
 * lit a little from the top left and given a fine seeded texture, in its colour and opacity. A
 * provider's sticker: its loaded art (`art`), fitted into the sticker's size and turned, in its
 * own colours or, when tintable, in the sticker's colour; nothing until the art has loaded.
 */
export function drawSticker(medium: TileMedium, s: Sticker, art?: StickerArtLookup): RasterRect {
  const kind = stickerStamp(s);
  if (!kind) {
    const a = art?.(s.ref, s.variant);
    return a ? drawArtSticker(medium, s, a) : stickerRect(s);
  }
  const rect = stickerRect(s);
  const n = rect.width * rect.height;
  const cov = new Float32Array(n);
  const field = new Float32Array(n * 3);
  const rad = s.size / 2;
  const a = (s.rotation * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const [r, g, b] = hexRgb(s.color);
  for (let yy = 0, p = 0; yy < rect.height; yy++) {
    for (let xx = 0, px = rect.x; xx < rect.width; xx++, p++, px++) {
      const dx = px + 0.5 - s.x;
      const dy = rect.y + yy + 0.5 - s.y;
      const u = (dx * ca + dy * sa) / rad;
      const v = (-dx * sa + dy * ca) / rad;
      if (u < -1.05 || u > 1.05 || v < -1.05 || v > 1.05) continue;
      // Supersample the edge 2 × 2.
      let c = 0;
      for (let k = 0; k < 4; k++) c += stampCoverage(kind, u + ((k & 1) - 0.5) / rad / 2, v + ((k >> 1) - 0.5) / rad / 2, s.seed);
      c /= 4;
      if (c <= 0) continue;
      cov[p] = c;
      // Shading: lighter towards the top left, and a fine paper texture.
      const shade = 1 + 0.12 * (-(u + v) / 2) + 0.06 * (hash2(px, rect.y + yy, s.seed) - 0.5);
      field[p * 3] = Math.min(1, Math.max(0, r * shade));
      field[p * 3 + 1] = Math.min(1, Math.max(0, g * shade));
      field[p * 3 + 2] = Math.min(1, Math.max(0, b * shade));
    }
  }
  medium.deposit(rect, cov, s.opacity, [r, g, b], null, field);
  return rect;
}

/** Draws a provider sticker from its art: the longest side spans the sticker's size. */
function drawArtSticker(medium: TileMedium, s: Sticker, art: StickerArt): RasterRect {
  const rect = stickerRect(s);
  const n = rect.width * rect.height;
  const cov = new Float32Array(n);
  const field = new Float32Array(n * 3);
  const a = (s.rotation * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const scale = Math.max(art.width, art.height) / s.size;
  const [r, g, b] = hexRgb(s.color);
  const px: number[] = [0, 0, 0, 0];
  for (let yy = 0, p = 0; yy < rect.height; yy++) {
    for (let xx = 0; xx < rect.width; xx++, p++) {
      const dx = rect.x + xx + 0.5 - s.x;
      const dy = rect.y + yy + 0.5 - s.y;
      // Into the art: undo the turn, then from the centre in art pixels.
      const ax = (dx * ca + dy * sa) * scale + art.width / 2;
      const ay = (-dx * sa + dy * ca) * scale + art.height / 2;
      if (ax < -1 || ay < -1 || ax > art.width + 1 || ay > art.height + 1) continue;
      sampleArt(art, ax, ay, px, s.frame);
      if (!(px[3] > 0)) continue;
      cov[p] = px[3];
      field[p * 3] = art.tintable ? r : px[0];
      field[p * 3 + 1] = art.tintable ? g : px[1];
      field[p * 3 + 2] = art.tintable ? b : px[2];
    }
  }
  medium.deposit(rect, cov, s.opacity, [r, g, b], null, field);
  return rect;
}

/**
 * A colour moved in lightness and hue by up to `amount` (deterministic): in OKLCH, up to ±0.15 L
 * and ±40° of hue at `amount` 1, with chroma reduced (not channels clipped) to stay in sRGB.
 */
function jitterColor(hex: string, amount: number, seed: number, i: number): string {
  const [r, g, b] = hexRgb(hex);
  const lch = oklabToOklch(rgbToOklab({ r, g, b, a: 1 }));
  const l = Math.min(1, Math.max(0, lch.l + (rand01(seed, i, 61) - 0.5) * amount * 0.3));
  const h = lch.h + (rand01(seed, i, 63) - 0.5) * amount * 80;
  const at = (c: number) => oklabToRgb(oklchToOklab({ l, c, h, alpha: 1 }));
  const inGamut = (o: { r: number; g: number; b: number }) => [o.r, o.g, o.b].every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let out = at(lch.c);
  if (!inGamut(out)) {
    let lo = 0;
    let hi = lch.c;
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    out = at(lo);
  }
  return '#' + [out.r, out.g, out.b].map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('');
}

export interface StickerSprayInit {
  brush: PaintBrush;
  target: PaintTileTarget;
  /** The paint colour #rrggbb. */
  color: string;
  seed: number;
  copies: readonly StrokeCopy[];
  /** The next sticker number on the layer (ids `st<n>`). */
  nextId: number;
  /** Gradient paint (resolved): each sticker takes its dab's colour (across the tip: by its offset). */
  paint?: PaintGradientSource | null;
  /**
   * Effect paint: each sticker takes the effect's colour at its centre (it keeps one colour, so it
   * stays recolourable); none lands where the effect is transparent.
   */
  effect?: EffectPaintPixels | null;
  /** Loaded art for provider stickers; stickers without art yet are skipped (see `skipped`). */
  art?: StickerArtLookup;
  /** The variant to spray a provider sticker in (default `light`); recorded on each sticker. */
  variant?: (ref: StickerRef) => StickerVariant;
}

/** A sticker-spray stroke: drops stickers along the path and draws them as it goes. */
export class StickerSpray {
  dabCount = 0;
  readonly stickers: Sticker[] = [];
  /** Refs the spray picked but could not draw because their art had not loaded. */
  readonly skipped = new Set<StickerRef>();
  private readonly smoother: PenSmoother;
  private readonly walkers: PenDabWalker[];
  private readonly copies: readonly StrokeCopy[];
  private readonly medium: TileMedium;
  private lastRaw: PenPoint | null = null;
  private lastFed: PenPoint | null = null;
  private next: number;

  constructor(readonly init: StickerSprayInit) {
    const b = init.brush;
    this.smoother = new PenSmoother(b.tip.smoothing, b.pressureSmoothing);
    this.copies = init.copies.length ? init.copies : [IDENTITY_COPY];
    // One walked dab per sticker: spacing from the density.
    const spacing = Math.max(0.05, 1 / Math.max(0.05, b.sticker.density * 4));
    const walk: PaintBrush = { ...b, tip: { ...b.tip, spacing }, dynamics: { ...b.dynamics, scatter: 0, sizeJitter: 0, angleJitter: 0 } };
    this.walkers = this.copies.map((c, i) => new PenDabWalker(walk, (init.seed + i * 7919) | 0, c.linear));
    this.medium = new TileMedium(init.target, {});
    this.next = init.nextId;
  }

  push(points: readonly PenPoint[]): RasterRect[] {
    const rects: RasterRect[] = [];
    for (const raw of points) {
      this.lastRaw = raw;
      const p = this.smoother.push(raw);
      this.lastFed = p;
      this.copies.forEach((c, i) => {
        const dabs: PenDab[] = [];
        this.walkers[i].push(c.map(p), dabs);
        for (const d of dabs) this.drop(d, rects);
      });
    }
    return rects;
  }

  finish(): RasterRect[] {
    const rects: RasterRect[] = [];
    const raw = this.lastRaw;
    const fed = this.lastFed;
    this.copies.forEach((c, i) => {
      const dabs: PenDab[] = [];
      if (raw && fed && (raw.x !== fed.x || raw.y !== fed.y)) this.walkers[i].push(c.map({ ...raw, pressure: fed.pressure }), dabs);
      this.walkers[i].finish(dabs);
      for (const d of dabs) this.drop(d, rects);
    });
    return rects;
  }

  private drop(d: PenDab, rects: RasterRect[]): void {
    const st = this.init.brush.sticker;
    const i = this.next;
    const seed = this.init.seed;
    const size = d.radius * 2 * (1 - st.sizeJitter * 0.7 * rand01(seed, i, 51));
    const off = st.scatter * d.radius * 2;
    const a = rand01(seed, i, 53) * Math.PI * 2;
    const dist = rand01(seed, i, 55) * off;
    const base = this.colorAt(d, Math.cos(a) * dist, Math.sin(a) * dist);
    if (!(base.alpha > 0)) {
      this.next++;
      return;
    }
    const ref = st.stamps[Math.floor(rand01(seed, i, 57) * st.stamps.length)] ?? 'editor:dot';
    const stamp = stickerStamp({ ref });
    const variant = stamp ? 'light' : (this.init.variant?.(ref) ?? 'light');
    const pic = stamp ? undefined : this.init.art?.(ref, variant);
    if (!stamp && !pic) {
      this.skipped.add(ref);
      this.next++;
      return;
    }
    const frameCount = pic?.frames && pic.frames.length > 1 ? pic.frames.length : 1;
    const frame =
      frameCount > 1
        ? st.frameMode === 'random'
          ? Math.floor(rand01(seed, i, 67) * frameCount)
          : Math.floor(Math.max(0, d.time ?? 0) / Math.max(1, pic?.frameDelay ?? 100)) % frameCount
        : 0;
    const sticker: Sticker = {
      id: `st${this.next++}`,
      ref,
      ...(stamp ? { stamp } : {}),
      x: Math.round((d.x + Math.cos(a) * dist) * 100) / 100,
      y: Math.round((d.y + Math.sin(a) * dist) * 100) / 100,
      size: Math.max(2, Math.round(size * 10) / 10),
      rotation: Math.round(((-d.angle * 180) / Math.PI + (rand01(seed, i, 59) * 2 - 1) * 180 * st.rotationJitter) * 10) / 10,
      color: st.colorJitter > 0 ? jitterColor(base.color, st.colorJitter, seed, i) : base.color,
      opacity: Math.round(Math.min(1, d.opacity * this.init.brush.tip.opacity * base.alpha) * 1000) / 1000,
      seed: Math.floor(rand01(seed, i, 65) * 1e9),
      ...(variant === 'dark' ? { variant } : {}),
      ...(frame > 0 ? { frame } : {}),
    };
    this.stickers.push(sticker);
    rects.push(drawSticker(this.medium, sticker, this.init.art));
    this.dabCount++;
  }

  private sampler: PaintGradientSampler | null | undefined;

  /** A sticker's colour: the paint colour, or gradient paint at its dab (`dx`, `dy` from the dab's centre). */
  private colorAt(d: PenDab, dx: number, dy: number): { color: string; alpha: number } {
    const effect = this.init.effect;
    if (effect) {
      const rgb: [number, number, number] = [0, 0, 0];
      const alpha = sampleEffectAt(effect, d.x + dx, d.y + dy, rgb, d);
      return { color: '#' + rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join(''), alpha };
    }
    const g = this.init.paint;
    if (!g) return { color: this.init.color, alpha: 1 };
    this.sampler ??= new PaintGradientSampler(g, this.init.seed);
    const s =
      g.map.by === 'across-tip'
        ? this.sampler.sample(((dx * Math.sin(d.direction) + dy * Math.cos(d.direction)) / Math.max(0.5, d.radius) + 1) / 2)
        : this.sampler.dab(d);
    return { color: '#' + s.rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join(''), alpha: s.alpha };
  }
}

/** A sticker list rendered over a transparent layer, through a tile target. */
export function renderStickers(stickers: readonly Sticker[], target: PaintTileTarget, art?: StickerArtLookup): void {
  const medium = new TileMedium(target, {});
  for (const s of stickers) drawSticker(medium, s, art);
}

/** Checks and rounds a sticker change; throws a sentence naming the bad field. */
export function normalizeStickerUpdate(u: Partial<Omit<Sticker, 'id'>>): Partial<Omit<Sticker, 'id'>> {
  const out: Partial<Omit<Sticker, 'id'>> = {};
  if (u.ref !== undefined && u.stamp !== undefined) throw new Error('Give ref or stamp, not both (stamp is the older name for an editor stamp).');
  if (u.stamp !== undefined) {
    if (!STAMP_KINDS.includes(u.stamp)) throw new Error(`stamp ${JSON.stringify(u.stamp)} is not a stamp; use ${STAMP_KINDS.join(', ')}, or ref for any sticker (find_stickers).`);
    out.ref = `editor:${u.stamp}`;
    out.stamp = u.stamp;
  }
  if (u.ref !== undefined) {
    out.ref = normalizeStickerRef(u.ref);
    const stamp = stickerStamp({ ref: out.ref });
    if (stamp) out.stamp = stamp;
    else out.stamp = undefined;
  }
  for (const k of ['x', 'y'] as const) if (u[k] !== undefined) {
    if (!Number.isFinite(u[k])) throw new Error(`${k} must be a number of pixels.`);
    out[k] = u[k];
  }
  if (u.size !== undefined) {
    if (!(u.size >= 2 && u.size <= 2048)) throw new Error(`size ${u.size} is out of range; use 2..2048 px.`);
    out.size = u.size;
  }
  if (u.rotation !== undefined) {
    if (!Number.isFinite(u.rotation)) throw new Error('rotation must be degrees.');
    out.rotation = u.rotation;
  }
  if (u.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(u.color)) throw new Error(`color ${JSON.stringify(u.color)} must be #rrggbb.`);
    out.color = u.color.toLowerCase();
  }
  if (u.opacity !== undefined) {
    if (!(u.opacity >= 0 && u.opacity <= 1)) throw new Error(`opacity ${u.opacity} is out of range; use 0..1.`);
    out.opacity = u.opacity;
  }
  if (u.frame !== undefined) {
    if (!Number.isInteger(u.frame) || u.frame < 0) throw new Error(`frame ${JSON.stringify(u.frame)} must be a whole number >= 0.`);
    out.frame = u.frame;
  }
  return out;
}

/**
 * A placed sticker with its animation frame checked against its art: frame 0 is left out (the saved
 * form, so a static and a first-frame sticker save the same), and a frame past the art's last is
 * refused naming how many it has. Editor stamps and static art have one frame. Art that has not
 * loaded passes unchecked (the redraw refuses it until it has).
 */
export function stickerWithFrame<T extends Partial<Sticker> & Pick<Sticker, 'ref'>>(s: T, art: StickerArt | null | undefined): T {
  const { frame, ...rest } = s;
  if (frame === undefined || frame === 0) return rest as T;
  if (!Number.isInteger(frame) || frame < 0) throw new Error(`frame ${JSON.stringify(frame)} must be a whole number >= 0.`);
  if (!stickerStamp(s) && !art) return s;
  const count = art?.frames && art.frames.length > 1 ? art.frames.length : 1;
  if (frame >= count) {
    throw new Error(count > 1 ? `"${s.ref}" has ${count} frames, so frame is 0..${count - 1}; got ${frame}.` : `"${s.ref}" is not animated, so its only frame is 0; got ${frame} (describe_sticker says whether a sticker is animated and its frameCount).`);
  }
  return s;
}

/**
 * A sticker layer's pixels: its stickers drawn bottom first over a transparent layer. With `base`
 * (the layer's current pixels, at offset 0) and `dirty` rects, only the tiles those rects touch are
 * drawn again, from the stickers that reach them; the rest are kept. The pixels are the same as a
 * full redraw, since a tile depends only on the stickers over it.
 */
export function stickerSurface(stickers: readonly Sticker[], base?: TiledSurface, dirty?: readonly RasterRect[], art?: StickerArtLookup): TiledSurface {
  const only = base && dirty ? new Set(dirty.flatMap((r) => tilesInRect(r).map(({ tx, ty }) => tileKey(tx, ty)))) : null;
  const live = new Map<TileKey, Uint8ClampedArray>();
  let scratch: Uint8ClampedArray | null = null;
  const target: PaintTileTarget = {
    offset: { x: 0, y: 0 },
    lockTransparency: false,
    selection: null,
    readTile: (tx, ty) => live.get(tileKey(tx, ty)) ?? null,
    writeTile: (tx, ty) => {
      const k = tileKey(tx, ty);
      // Writes to kept tiles go nowhere.
      if (only && !only.has(k)) return (scratch ??= new Uint8ClampedArray(TILE * TILE * 4)).fill(0);
      let t = live.get(k);
      if (!t) live.set(k, (t = new Uint8ClampedArray(TILE * TILE * 4)));
      return t;
    },
  };
  const reaches = (s: Sticker) => !only || tilesInRect(stickerRect(s)).some(({ tx, ty }) => only.has(tileKey(tx, ty)));
  renderStickers(stickers.filter(reaches), target, art);
  const tiles = new Map<TileKey, Tile>();
  if (only && base) for (const [k, t] of base.tiles) if (!only.has(k)) tiles.set(k, t);
  for (const [k, d] of live) {
    const t = finishTile(d, 4, 0);
    if (t) tiles.set(k, t);
  }
  return new TiledSurface(4, tiles, 0);
}

/** The top-most sticker under a point (document pixels), by its stamp's shape (or its art's alpha), or `null`. */
export function stickerAt(stickers: readonly Sticker[], x: number, y: number, art?: StickerArtLookup): Sticker | null {
  for (let i = stickers.length - 1; i >= 0; i--) {
    const s = stickers[i];
    const rad = s.size / 2;
    const a = (s.rotation * Math.PI) / 180;
    const dx = x - s.x;
    const dy = y - s.y;
    const u = (dx * Math.cos(a) + dy * Math.sin(a)) / rad;
    const v = (-dx * Math.sin(a) + dy * Math.cos(a)) / rad;
    if (Math.abs(u) > 1.05 || Math.abs(v) > 1.05) continue;
    // Small stickers are hard to hit exactly: their whole box counts.
    if (s.size < 16) return s;
    const kind = stickerStamp(s);
    if (kind) {
      if (stampCoverage(kind, u, v, s.seed) > 0.25) return s;
      continue;
    }
    const pic = art?.(s.ref, s.variant);
    if (!pic) return s;
    const scale = Math.max(pic.width, pic.height) / 2;
    if (sampleArt(pic, u * scale + pic.width / 2, v * scale + pic.height / 2, [0, 0, 0, 0], s.frame)[3] > 0.25) return s;
  }
  return null;
}
