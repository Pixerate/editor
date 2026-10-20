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

import { TILE, TiledSurface, finishTile, tileKey, type RasterRect, type Tile, type TileKey } from '../raster/surface';
import { TileMedium, type PaintTileTarget } from '../paint/exchange';
import type { PaintBrush } from './brushes';
import { IDENTITY_COPY, PenDabWalker, PenSmoother, type PenDab, type PenPoint, type StrokeCopy } from './engine';
import { hash2, rand01 } from './noise';

export type StampKind = 'dot' | 'star' | 'heart' | 'leaf' | 'flower' | 'confetti' | 'splat' | 'sparkle' | 'ring';
export const STAMP_KINDS: readonly StampKind[] = ['dot', 'star', 'heart', 'leaf', 'flower', 'confetti', 'splat', 'sparkle', 'ring'];

/** One sticker (document pixels). */
export interface Sticker {
  id: string;
  stamp: StampKind;
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
}

/** Sticker spray settings (each 0..1 unless noted). */
export interface StickerSettings {
  /** The stamps to spray (picked at random per sticker). */
  stamps: StampKind[];
  /** Stickers per tip diameter of travel. */
  density: number;
  /** Random size change. */
  sizeJitter: number;
  /** Random turn, as a fraction of ±180°. */
  rotationJitter: number;
  /** How far from the path stickers land, in tip diameters (0..2). */
  scatter: number;
  /** Random colour change (hue and lightness). */
  colorJitter: number;
}

export const DEFAULT_STICKER: Readonly<StickerSettings> = { stamps: ['star'], density: 0.4, sizeJitter: 0.4, rotationJitter: 1, scatter: 0.5, colorJitter: 0.2 };

const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

export function normalizeStickerSettings(raw: Partial<StickerSettings> = {}, base: StickerSettings = DEFAULT_STICKER): StickerSettings {
  const stamps = Array.isArray(raw.stamps) ? raw.stamps.filter((s): s is StampKind => STAMP_KINDS.includes(s as StampKind)) : base.stamps;
  return {
    stamps: stamps.length ? [...new Set(stamps)] : [...base.stamps],
    density: unit(raw.density, base.density),
    sizeJitter: unit(raw.sizeJitter, base.sizeJitter),
    rotationJitter: unit(raw.rotationJitter, base.rotationJitter),
    scatter: typeof raw.scatter === 'number' && Number.isFinite(raw.scatter) ? Math.min(2, Math.max(0, raw.scatter)) : base.scatter,
    colorJitter: unit(raw.colorJitter, base.colorJitter),
  };
}

/**
 * Coverage of a stamp at a point (u, v) of its unit square (−1..1, y down), 0..1, before shading.
 * `t` is the sticker's seed for shapes with random parts (splat, confetti).
 */
export function stampCoverage(kind: StampKind, u: number, v: number, t: number): number {
  const r = Math.hypot(u, v);
  const a = Math.atan2(v, u);
  const edge = (d: number) => Math.min(1, Math.max(0, d * 24 + 0.5));
  switch (kind) {
    case 'dot':
      return edge(0.95 - r);
    case 'ring':
      return edge(Math.min(0.95 - r, r - 0.6));
    case 'star': {
      // Five points, one straight up: the outline radius falls from the points to the notches.
      const f = (((a + Math.PI / 2) * 5) / (2 * Math.PI)) % 1;
      const notch = Math.min(f < 0 ? f + 1 : f, 1 - (f < 0 ? f + 1 : f)) * 2;
      return edge(0.95 - 0.55 * notch - r);
    }
    case 'sparkle': {
      // A four-pointed twinkle (an astroid): |u|^0.6 + |v|^0.6 ≤ 1.
      const q = Math.pow(Math.abs(u) / 0.95, 0.6) + Math.pow(Math.abs(v) / 0.95, 0.6);
      return edge((1 - q) * 0.4);
    }
    case 'heart': {
      const x = u * 1.1;
      const y = -v * 1.1 + 0.15;
      const q = x * x + y * y - 0.55;
      return edge(-(q * q * q - x * x * y * y * y) * 3);
    }
    case 'leaf': {
      // A pointed oval with a midrib.
      const w = 0.42 * Math.sqrt(Math.max(0, 1 - u * u));
      const inside = edge(w - Math.abs(v + 0.15 * u * u));
      const rib = Math.abs(v + 0.15 * u * u) < 0.03 && Math.abs(u) < 0.85 ? 0.65 : 1;
      return inside * rib;
    }
    case 'flower': {
      const petals = 0.6 + 0.35 * Math.abs(Math.cos(2.5 * a));
      const body = edge(petals - r);
      return r < 0.22 ? Math.max(body, 1) * 0.85 : body;
    }
    case 'confetti': {
      // A small turned rectangle.
      return edge(Math.min(0.9 - Math.abs(u), 0.35 - Math.abs(v)));
    }
    case 'splat': {
      // A blob with drops: a bumpy outline plus a few satellites.
      let rr = 0.55;
      for (let k = 1; k <= 3; k++) rr += 0.08 * Math.sin(a * (k + 2) + hash2(k, 1, t) * 6.28) / k;
      let c = edge(rr - r);
      for (let k = 0; k < 4; k++) {
        const ang = hash2(k, 7, t) * Math.PI * 2;
        const dist = 0.72 + 0.2 * hash2(k, 9, t);
        const dx = u - Math.cos(ang) * dist;
        const dy = v - Math.sin(ang) * dist;
        c = Math.max(c, edge(0.08 + 0.06 * hash2(k, 11, t) - Math.hypot(dx, dy)));
      }
      return c;
    }
  }
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

/**
 * Draws one sticker through a `TileMedium` (straight source-over): the stamp's coverage, lit a
 * little from the top left and given a fine seeded texture, in its colour and opacity.
 */
export function drawSticker(medium: TileMedium, s: Sticker): RasterRect {
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
      for (let k = 0; k < 4; k++) c += stampCoverage(s.stamp, u + ((k & 1) - 0.5) / rad / 2, v + ((k >> 1) - 0.5) / rad / 2, s.seed);
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

/** A colour moved in lightness and hue by up to `amount` (deterministic). */
function jitterColor(hex: string, amount: number, seed: number, i: number): string {
  const [r, g, b] = hexRgb(hex);
  const l = (rand01(seed, i, 61) - 0.5) * amount * 0.6;
  const h = (rand01(seed, i, 63) - 0.5) * amount;
  // A small rotation in RGB around grey, then lightness.
  const m = (r + g + b) / 3;
  const rot = (c0: number, c1: number) => c0 + (c1 - c0) * h;
  const out = [rot(r, g), rot(g, b), rot(b, r)].map((c) => Math.min(1, Math.max(0, c + l + (c - m) * 0)));
  return '#' + out.map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
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
}

/** A sticker-spray stroke: drops stickers along the path and draws them as it goes. */
export class StickerSpray {
  dabCount = 0;
  readonly stickers: Sticker[] = [];
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
    const sticker: Sticker = {
      id: `st${this.next++}`,
      stamp: st.stamps[Math.floor(rand01(seed, i, 57) * st.stamps.length)] ?? 'dot',
      x: Math.round((d.x + Math.cos(a) * dist) * 100) / 100,
      y: Math.round((d.y + Math.sin(a) * dist) * 100) / 100,
      size: Math.max(2, Math.round(size * 10) / 10),
      rotation: Math.round(((-d.angle * 180) / Math.PI + (rand01(seed, i, 59) * 2 - 1) * 180 * st.rotationJitter) * 10) / 10,
      color: st.colorJitter > 0 ? jitterColor(this.init.color, st.colorJitter, seed, i) : this.init.color,
      opacity: Math.round(Math.min(1, d.opacity * this.init.brush.tip.opacity) * 1000) / 1000,
      seed: Math.floor(rand01(seed, i, 65) * 1e9),
    };
    this.stickers.push(sticker);
    rects.push(drawSticker(this.medium, sticker));
    this.dabCount++;
  }
}

/** A sticker list rendered over a transparent layer, through a tile target. */
export function renderStickers(stickers: readonly Sticker[], target: PaintTileTarget): void {
  const medium = new TileMedium(target, {});
  for (const s of stickers) drawSticker(medium, s);
}

/** Checks and rounds a sticker change; throws a sentence naming the bad field. */
export function normalizeStickerUpdate(u: Partial<Omit<Sticker, 'id'>>): Partial<Omit<Sticker, 'id'>> {
  const out: Partial<Omit<Sticker, 'id'>> = {};
  if (u.stamp !== undefined) {
    if (!STAMP_KINDS.includes(u.stamp)) throw new Error(`stamp ${JSON.stringify(u.stamp)} is not a stamp; use ${STAMP_KINDS.join(', ')}.`);
    out.stamp = u.stamp;
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
  return out;
}

/** A sticker layer's pixels: its stickers drawn bottom first over a transparent layer. */
export function stickerSurface(stickers: readonly Sticker[]): TiledSurface {
  const live = new Map<TileKey, Uint8ClampedArray>();
  const target: PaintTileTarget = {
    offset: { x: 0, y: 0 },
    lockTransparency: false,
    selection: null,
    readTile: (tx, ty) => live.get(tileKey(tx, ty)) ?? null,
    writeTile: (tx, ty) => {
      const k = tileKey(tx, ty);
      let t = live.get(k);
      if (!t) live.set(k, (t = new Uint8ClampedArray(TILE * TILE * 4)));
      return t;
    },
  };
  renderStickers(stickers, target);
  const tiles = new Map<TileKey, Tile>();
  for (const [k, d] of live) {
    const t = finishTile(d, 4, 0);
    if (t) tiles.set(k, t);
  }
  return new TiledSurface(4, tiles, 0);
}
