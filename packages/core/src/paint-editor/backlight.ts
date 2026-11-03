/**
 * Backlit paper: the paper as a light source behind the paint (a lightbox, stained glass). The
 * light that makes it through the paint is drawn as one Linear Dodge (Add) layer, "Backlight", at
 * the top of the stack (opaque pixels whose colour is the light added, so the sRGB blend adds
 * exactly that; the linear light value is added as is, an approximation of adding light) (it shines through everything, so nothing composited above it may cover
 * it), with a soft spill where it comes through paint, so a lit glaze lights its surroundings.
 *
 * Per pixel, the light starts as `backlight × backlightColor` (linear), a little stronger in the
 * paper's valleys (thinner paper, by its grain depth), and passes through each visible pixel layer
 * from the bottom up:
 *
 * - **Paint as a film over the paper.** A layer pixel (colour `c`, alpha `a`) over the paper `p`
 *   shows `e = a·c + (1 − a)·p`. Its transmission is `T = min(1, e / p)` per channel (linear):
 *   exact for a transparent glaze, whose film over the paper is `T·p` (the wet bake writes
 *   watercolour that way). Alpha above the least the colour needs over the paper
 *   (`aMin`, as `film.ts` computes it) is hiding: `hide = (a − aMin) / (1 − aMin)`, and the light
 *   through is `(1 − hide)·T`. The wet bake writes gouache and oil with their hiding in alpha, and
 *   opaque dry paint (alpha 1) hides by this rule too, so glazes glow in their own colour and
 *   opaque paint blocks the light.
 * - **Thick paint** blocks the light by its height; impasto clarity (material A) lets some through.
 * - **Layer opacity** mixes towards no change. Blend modes are not modelled (every layer is read
 *   as a film); over other layers rather than the paper the film rule is an approximation.
 *
 * Exact for watercolour straight over the paper; approximate for stacks of layers and for blend
 * modes. Changing the backlight never repaints: it is a few numbers on the paper.
 */

import { srgbToLinear, linearToSrgb } from '../color/convert';
import { TILE, TiledSurface, finishTile, readRegion, tileKey, type RasterRect, type Tile, type TileKey } from '../raster/surface';
import { computeSpill, type LightSpill } from './light';
import { hexToRgb8, type PaperGrain, type PaperSettings } from './paper';
import type { ThickChannels } from './thick';

/** Default backlight colour: warm white, like a lightbox. */
export const DEFAULT_BACKLIGHT_COLOR = '#fff1d6';

/** Spill of the light that comes through paint (px, strength), at backlight 1. */
export const BACKLIGHT_SPILL: Readonly<LightSpill> = { radius: 24, strength: 1.5 };

/** Thick paint this high (0..255) blocks the backlight completely. */
const BLOCK_HEIGHT = 96;
/** How much brighter the light is in the paper's deepest valleys (at grain depth 1). */
const VALLEY_GAIN = 0.35;

/** One visible pixel layer as the backlight reads it, bottom first. */
export interface BacklitLayer {
  surface: TiledSurface;
  offset: { x: number; y: number };
  /** Effective opacity (its groups' opacities multiplied in). */
  opacity: number;
  thick?: ThickChannels;
}

/** The paper's backlight (0 when it has none). */
export function backlightOf(paper: PaperSettings): number {
  return paper.backlight ?? 0;
}

const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i / 255);

/** The least alpha a film value `e` needs over paper value `p` (bytes), as `film.ts` bakes it. */
function needAlpha(e: number, p: number): number {
  if (e < p) return 1 - e / p;
  if (e > p) return (e - p) / (255 - p);
  return 0;
}

/** The tiles of `surface` a document rectangle overlaps, for a layer at `offset` (cache keys). */
function tilesUnder(surface: TiledSurface | undefined, rect: RasterRect, offset: { x: number; y: number }, out: unknown[]): void {
  if (!surface) {
    out.push(null);
    return;
  }
  const x0 = Math.floor((rect.x - offset.x) / TILE);
  const y0 = Math.floor((rect.y - offset.y) / TILE);
  const x1 = Math.floor((rect.x - offset.x + rect.width - 1) / TILE);
  const y1 = Math.floor((rect.y - offset.y + rect.height - 1) / TILE);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push(surface.tiles.get(tileKey(tx, ty)) ?? null);
}

const sameRefs = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

interface TileResult {
  refs: unknown[];
  /** Added light (Linear Dodge RGBA), or null where none. */
  light: Tile | null;
  /** The transmitted colour (opaque RGBA) where light comes through paint, for the spill. */
  color: Tile | null;
  /** How much paint the light came through (1 channel), for the spill. */
  painted: Tile | null;
}

/**
 * Computes and caches the backlight per 256 px document tile: a tile is recomputed only when one of
 * the layer tiles over it (or the paper, or the layer list) changed.
 */
export class BacklightCache {
  private tiles = new Map<TileKey, TileResult>();
  private key = '';
  private spillOf: { color: TiledSurface; painted: TiledSurface; out: TiledSurface | null } | null = null;
  private out: { parts: Tile[]; surface: TiledSurface } | null = null;

  /**
   * The backlight layer's pixels for `layers` (bottom first) on `paper` over a `width` × `height`
   * canvas, or `null` when the paper has no backlight. `spillFrom` is the committed painting (the
   * spill is drawn from it, so a stroke in progress does not redo the blur every frame).
   */
  surface(paper: PaperSettings, grain: PaperGrain, width: number, height: number, layers: readonly BacklitLayer[], spillFrom: BacklightCache | null): { light: TiledSurface; color: TiledSurface; painted: TiledSurface } | null {
    const amount = backlightOf(paper);
    if (!(amount > 0)) return null;
    const key = JSON.stringify([amount, paper.backlightColor ?? DEFAULT_BACKLIGHT_COLOR, paper.color, paper.depth, grain.flat, width, height, layers.length, layers.map((l) => [l.opacity, l.offset.x, l.offset.y, l.surface.channels])]);
    if (key !== this.key) {
      this.tiles.clear();
      this.key = key;
    }
    const light = new Map<TileKey, Tile>();
    const color = new Map<TileKey, Tile>();
    const painted = new Map<TileKey, Tile>();
    const tilesX = Math.ceil(width / TILE);
    const tilesY = Math.ceil(height / TILE);
    const refs: unknown[] = [];
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const rect = { x: tx * TILE, y: ty * TILE, width: Math.min(TILE, width - tx * TILE), height: Math.min(TILE, height - ty * TILE) };
        refs.length = 0;
        for (const l of layers) {
          tilesUnder(l.surface, rect, l.offset, refs);
          tilesUnder(l.thick?.height, rect, l.offset, refs);
          tilesUnder(l.thick?.material, rect, l.offset, refs);
        }
        const k = tileKey(tx, ty);
        let r = this.tiles.get(k);
        if (!r || !sameRefs(r.refs, refs)) {
          r = { refs: [...refs], ...computeTile(paper, grain, amount, rect, layers) };
          this.tiles.set(k, r);
        }
        if (r.light) light.set(k, r.light);
        if (r.color) color.set(k, r.color);
        if (r.painted) painted.set(k, r.painted);
      }
    }
    return { light: new TiledSurface(4, light, 0), color: new TiledSurface(4, color, 0), painted: new TiledSurface(1, painted, 0) };
  }

  /**
   * The full Backlight layer: the light through the paint (`current`) plus the spill of the light
   * through the committed paint (`committed`), both Linear Dodge. Cached on their tiles.
   */
  layer(current: { light: TiledSurface }, committed: { color: TiledSurface; painted: TiledSurface } | null, amount: number): TiledSurface {
    let spill: TiledSurface | null = null;
    if (committed) {
      const s = this.spillOf;
      if (s && s.color.id === committed.color.id && s.painted.id === committed.painted.id) spill = s.out;
      else {
        spill = computeSpill(committed.color, committed.painted, { radius: BACKLIGHT_SPILL.radius, strength: BACKLIGHT_SPILL.strength * amount });
        this.spillOf = { color: committed.color, painted: committed.painted, out: spill };
      }
    }
    if (!spill) return current.light;
    const parts = [...current.light.tiles.values(), ...spill.tiles.values()];
    if (this.out && sameRefs(this.out.parts, parts)) return this.out.surface;
    const keys = new Set<TileKey>([...current.light.tiles.keys(), ...spill.tiles.keys()]);
    const tiles = new Map<TileKey, Tile>();
    for (const key of keys) {
      const a = current.light.tiles.get(key);
      const b = spill.tiles.get(key);
      const t = !a ? b! : !b ? a : addTiles(a, b);
      if (t) tiles.set(key, t);
    }
    const surface = new TiledSurface(4, tiles, 0);
    this.out = { parts, surface };
    return surface;
  }
}

const full4 = (t: Tile): Uint8ClampedArray => {
  if (t.data.length === TILE * TILE * 4) return t.data;
  const out = new Uint8ClampedArray(TILE * TILE * 4);
  const u = t.uniform ?? 0;
  const bytes = [(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255];
  for (let i = 0; i < out.length; i += 4) out.set(bytes, i);
  return out;
};

/**
 * The backlight tile `a` (opaque: its colour is the light added) plus a spill tile `b` (light
 * paint's encoding: rgb × alpha is about what it adds), as an opaque added-light tile.
 */
function addTiles(a: Tile, b: Tile): Tile | null {
  const x = full4(a);
  const y = full4(b);
  const out = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0; i < out.length; i += 4) {
    const ay = y[i + 3] / 255;
    const r = x[i] + y[i] * ay;
    const g = x[i + 1] + y[i + 1] * ay;
    const bl = x[i + 2] + y[i + 2] * ay;
    if (r < 0.5 && g < 0.5 && bl < 0.5) continue;
    out[i] = Math.round(r);
    out[i + 1] = Math.round(g);
    out[i + 2] = Math.round(bl);
    out[i + 3] = 255;
  }
  return finishTile(out, 4, 0);
}

/** One document tile of backlight. */
function computeTile(paper: PaperSettings, grain: PaperGrain, amount: number, rect: RasterRect, layers: readonly BacklitLayer[]): Omit<TileResult, 'refs'> {
  const n = rect.width * rect.height;
  const [p0, p1, p2] = hexToRgb8(paper.color);
  const pb = [p0, p1, p2];
  const pl = [Math.max(1e-4, LIN[p0]), Math.max(1e-4, LIN[p1]), Math.max(1e-4, LIN[p2])];
  const [c0, c1, c2] = hexToRgb8(paper.backlightColor ?? DEFAULT_BACKLIGHT_COLOR);
  const t0 = new Float32Array(n).fill(amount * LIN[c0]);
  const t1 = new Float32Array(n).fill(amount * LIN[c1]);
  const t2 = new Float32Array(n).fill(amount * LIN[c2]);
  // Thinner paper in the valleys lets a little more light through.
  const depth = grain.flat ? 0 : paper.depth;
  if (depth > 0) {
    for (let y = 0, i = 0; y < rect.height; y++)
      for (let x = 0; x < rect.width; x++, i++) {
        const g = 1 + VALLEY_GAIN * depth * (0.5 - grain.at(rect.x + x + 0.5, rect.y + y + 0.5));
        t0[i] *= g;
        t1[i] *= g;
        t2[i] *= g;
      }
  }
  const clear = new Float32Array(n).fill(1);
  for (const l of layers) {
    const lr = { x: rect.x - l.offset.x, y: rect.y - l.offset.y, width: rect.width, height: rect.height };
    if (!l.surface.tiles.size) continue;
    const px = readRegion(l.surface, lr);
    const h = l.thick?.height.tiles.size ? readRegion(l.thick.height, lr) : null;
    const m = h && l.thick?.material.tiles.size ? readRegion(l.thick.material, lr) : null;
    const op = l.opacity;
    for (let i = 0; i < n; i++) {
      const a8 = px[i * 4 + 3];
      if (!a8 && !(h && h[i])) continue;
      const a = a8 / 255;
      let aMin = 0;
      const tr = [1, 1, 1];
      for (let c = 0; c < 3; c++) {
        const e = a * px[i * 4 + c] + (1 - a) * pb[c];
        aMin = Math.max(aMin, needAlpha(e, pb[c]));
        tr[c] = Math.min(1, LIN[Math.round(e)] / pl[c]);
      }
      const hide = aMin < 1 && a > aMin ? (a - aMin) / (1 - aMin) : 0;
      let k = 1 - hide;
      if (h && h[i]) {
        // Thick paint blocks by its height; clarity (material A: 255 solid, 0 no material) lets some through.
        const ma = m ? m[i * 4 + 3] : 0;
        const clarity = ma ? (255 - ma) / 254 : 0;
        k *= 1 - Math.min(1, h[i] / BLOCK_HEIGHT) * (1 - clarity);
      }
      t0[i] *= 1 - op + op * tr[0] * k;
      t1[i] *= 1 - op + op * tr[1] * k;
      t2[i] *= 1 - op + op * tr[2] * k;
      clear[i] *= 1 - op * Math.max(a, h && h[i] ? 1 : 0);
    }
  }
  const light = new Uint8ClampedArray(TILE * TILE * 4);
  const color = new Uint8ClampedArray(TILE * TILE * 4);
  const painted = new Uint8ClampedArray(TILE * TILE);
  for (let y = 0, i = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++, i++) {
      const o = (y * TILE + x) * 4;
      // Opaque, its colour the light it adds: Linear Dodge then adds exactly that (min(1, below + light)).
      const add = [Math.min(1, t0[i]), Math.min(1, t1[i]), Math.min(1, t2[i])];
      const mx = Math.max(add[0], add[1], add[2]);
      if (mx > 0.5 / 255) {
        light[o] = Math.round(add[0] * 255);
        light[o + 1] = Math.round(add[1] * 255);
        light[o + 2] = Math.round(add[2] * 255);
        light[o + 3] = 255;
      }
      const pv = Math.round((1 - clear[i]) * 255);
      if (pv && mx > 0.5 / 255) {
        // The spill reads colour as sRGB and spreads it in linear light.
        painted[y * TILE + x] = pv;
        color[o] = Math.round(linearToSrgb(add[0]) * 255);
        color[o + 1] = Math.round(linearToSrgb(add[1]) * 255);
        color[o + 2] = Math.round(linearToSrgb(add[2]) * 255);
        color[o + 3] = 255;
      }
    }
  }
  return { light: finishTile(light, 4, 0), color: finishTile(color, 4, 0), painted: finishTile(painted, 1, 0) };
}
