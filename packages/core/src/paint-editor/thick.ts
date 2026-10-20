/**
 * Thick paint (impasto): a pixel layer can carry two extra channels, a **height** map (how far the
 * paint stands up, 0..255) and a **material** map (R gloss, G metallic, 0..255), and it is lit at
 * render time: a normal from the height's slope, diffuse light from `PaintLighting`, and a
 * Blinn-Phong highlight whose sharpness follows the gloss, tinted by the paint where it is
 * metallic. The layer's own pixels stay the paint's colour (albedo), so relighting never repaints
 * anything, saving keeps colour, height and material apart, and only tiles whose inputs changed are
 * relit (the lit tiles are cached by the identity of their input tiles).
 *
 * Impasto strokes (`ThickStrokeDriver`) lay colour through the shared pick-up / mix exchange (paint
 * mixes into the wet paint it meets, like oil) and raise the height: `brush` with bristle ridges
 * along the stroke, `tube` in domed blobs, `knife` scraping the relief flat while it smears the
 * paint, `roller` as a flat stippled band, `gloop` as a thick glossy round bead. The paint runs out
 * along the stroke with `load` below 1, and `thinner` flattens and thins it.
 */

import { dabRect, rasterizeDab } from '../paint/brush';
import { SmudgeTip } from '../paint/blending';
import { exchangeRates, PaintExchange, TileMedium, type MixerLoad, type PaintTileTarget, type RgbTriple } from '../paint/exchange';
import { SRGB_TO_LINEAR, linearToSrgb8 } from '../paint/wet/film';
import { TILE, TiledSurface, finishTile, readRegion, surfaceFromPixels, tileKey, type RasterRect, type Tile, type TileKey } from '../raster/surface';
import { decodePng, parseDataUrl, pngDataUrl } from '../raster/png';
import type { PaintBrush } from './brushes';
import { IDENTITY_COPY, PenDabWalker, PenSmoother, type PenDab, type PenPoint, type StrokeCopy } from './engine';
import { hash2 } from './noise';

/** Where the light comes from. */
export interface PaintLighting {
  /** Degrees clockwise from the top of the canvas (315: top left, the default). */
  azimuth: number;
  /** Degrees above the canvas, 5 (grazing, deep shadows) .. 90 (straight on, no relief). Default 40. */
  elevation: number;
  /** How strongly the relief shows, 0 (flat) .. 1 (default 0.7). */
  relief: number;
}

export const DEFAULT_LIGHTING: Readonly<PaintLighting> = { azimuth: 315, elevation: 40, relief: 0.7 };

export function normalizeLighting(raw: Partial<PaintLighting> = {}, base: PaintLighting = DEFAULT_LIGHTING): PaintLighting {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    azimuth: ((num(raw.azimuth, base.azimuth) % 360) + 360) % 360,
    elevation: Math.min(90, Math.max(5, num(raw.elevation, base.elevation))),
    relief: Math.min(1, Math.max(0, num(raw.relief, base.relief))),
  };
}

/** A layer's thick-paint channels (layer space, like its pixels). */
export interface ThickChannels {
  /** Height 0..255 per pixel (1 channel). */
  height: TiledSurface;
  /** Material per pixel (4 channels): R gloss, G metallic, B and A unused. */
  material: TiledSurface;
}

export function emptyThickChannels(): ThickChannels {
  return { height: new TiledSurface(1, new Map(), 0), material: new TiledSurface(4, new Map(), 0) };
}

/** Height in pixels of the full 0..255 range, for the slopes. */
const RELIEF_PX = 7;
const AMBIENT = 0.38;

/** Light vector (towards the light) for a lighting. */
function lightVector(l: PaintLighting): [number, number, number] {
  const az = (l.azimuth * Math.PI) / 180;
  const el = (l.elevation * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(az), -Math.cos(el) * Math.cos(az), Math.sin(el)];
}

export function lightingKey(l: PaintLighting): string {
  return `${l.azimuth.toFixed(2)}|${l.elevation.toFixed(2)}|${l.relief.toFixed(3)}`;
}

/**
 * One tile of a thick layer lit: `color` (RGBA, straight), the height and material of the tile, and
 * the height of its 8 neighbours for the slopes at the border (`heightAt(dx, dy)` returns the
 * neighbouring tile's data or null). Returns a new RGBA tile.
 */
export function lightTile(color: Uint8ClampedArray, height: Uint8ClampedArray | null, heightAround: (dx: number, dy: number) => Uint8ClampedArray | null, material: Uint8ClampedArray | null, light: PaintLighting): Uint8ClampedArray {
  const out = new Uint8ClampedArray(color);
  if (!height || light.relief <= 0) return out;
  const [lx, ly, lz] = lightVector(light);
  const hv = [lx, ly, lz + 1];
  const hl = Math.hypot(hv[0], hv[1], hv[2]);
  const hx = hv[0] / hl;
  const hy = hv[1] / hl;
  const hz = hv[2] / hl;
  const k = (RELIEF_PX / 255) * light.relief * 2;
  const flatDiffuse = AMBIENT + (1 - AMBIENT) * lz;
  const read = (x: number, y: number): number => {
    if (x >= 0 && y >= 0 && x < TILE && y < TILE) return height[y * TILE + x];
    const dx = x < 0 ? -1 : x >= TILE ? 1 : 0;
    const dy = y < 0 ? -1 : y >= TILE ? 1 : 0;
    const t = heightAround(dx, dy);
    if (!t) return 0;
    return t[(y - dy * TILE) * TILE + (x - dx * TILE)];
  };
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const p = y * TILE + x;
      const i = p * 4;
      if (color[i + 3] === 0) continue;
      const h = height[p];
      const gx = (read(x + 1, y) - read(x - 1, y)) * 0.5;
      const gy = (read(x, y + 1) - read(x, y - 1)) * 0.5;
      if (h === 0 && gx === 0 && gy === 0) continue;
      let nx = -gx * k;
      let ny = -gy * k;
      const nl = Math.hypot(nx, ny, 1);
      nx /= nl;
      ny /= nl;
      const nz = 1 / nl;
      const diffuse = Math.max(0, nx * lx + ny * ly + nz * lz);
      const shade = (AMBIENT + (1 - AMBIENT) * diffuse) / flatDiffuse;
      const gloss = material ? material[i] / 255 : 0.3;
      const metal = material ? material[i + 1] / 255 : 0;
      const shininess = 6 + 90 * gloss;
      const nh = Math.max(0, nx * hx + ny * hy + nz * hz);
      // Only slopes catch a highlight: subtract what a flat surface would show.
      const spec = Math.max(0, Math.pow(nh, shininess) - Math.pow(hz, shininess)) * (0.25 + 0.75 * gloss) * light.relief;
      for (let c = 0; c < 3; c++) {
        const a = SRGB_TO_LINEAR[color[i + c]];
        const tint = metal * a + (1 - metal);
        const v = a * shade * (1 - 0.35 * metal) + spec * tint * (1 + metal);
        out[i + c] = linearToSrgb8(v);
      }
    }
  }
  return out;
}

/** Cache of lit tiles for one layer, by the identity of their inputs. */
export class LitCache {
  private readonly tiles = new Map<TileKey, { inputs: unknown[]; tile: Tile }>();

  /** The layer's pixels lit (tiles without relief nearby are the colour tiles themselves). */
  lit(color: TiledSurface, ch: ThickChannels, light: PaintLighting): TiledSurface {
    if (!ch.height.tiles.size || light.relief <= 0) return color;
    const lk = lightingKey(light);
    const out = new Map(color.tiles);
    const keys = new Set<TileKey>();
    for (const key of color.tiles.keys()) keys.add(key);
    for (const [key, tile] of color.tiles) {
      const tx = (key % 65536) - 32768;
      const ty = Math.floor(key / 65536) - 32768;
      const around = (dx: number, dy: number) => ch.height.tiles.get(tileKey(tx + dx, ty + dy))?.data ?? null;
      let any = false;
      for (let dy = -1; dy <= 1 && !any; dy++) for (let dx = -1; dx <= 1 && !any; dx++) if (around(dx, dy)) any = true;
      if (!any) continue;
      const h = ch.height.tiles.get(key) ?? null;
      const m = ch.material.tiles.get(key) ?? null;
      const inputs: unknown[] = [tile, lk, m];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) inputs.push(ch.height.tiles.get(tileKey(tx + dx, ty + dy)) ?? null);
      const cached = this.tiles.get(key);
      if (cached && cached.inputs.length === inputs.length && cached.inputs.every((v, i) => v === inputs[i])) {
        out.set(key, cached.tile);
        continue;
      }
      const hd = h ? expand(h, 1) : null;
      const md = m ? expand(m, 4) : null;
      const data = lightTile(expand(tile, 4), hd, (dx, dy) => {
        const t = ch.height.tiles.get(tileKey(tx + dx, ty + dy));
        return t ? expand(t, 1) : null;
      }, md, light);
      const lit: Tile = { data, uniform: null };
      this.tiles.set(key, { inputs, tile: lit });
      out.set(key, lit);
    }
    for (const key of [...this.tiles.keys()]) if (!keys.has(key)) this.tiles.delete(key);
    return new TiledSurface(4, out, color.defaultValue);
  }
}

/** A tile's pixels as a full buffer (uniform tiles are stored compactly). */
function expand(t: Tile, channels: 1 | 4): Uint8ClampedArray {
  if (t.data.length === TILE * TILE * channels) return t.data;
  const out = new Uint8ClampedArray(TILE * TILE * channels);
  const u = t.uniform ?? 0;
  if (channels === 1) out.fill(u & 255);
  else {
    const bytes = [(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255];
    for (let i = 0; i < out.length; i += 4) out.set(bytes, i);
  }
  return out;
}

export interface ThickStrokeInit {
  brush: PaintBrush;
  /** Where the colour goes (the session's live tiles). */
  target: PaintTileTarget;
  /** The layer's channels before the stroke. */
  channels: ThickChannels;
  /** Paint colour, sRGB 0..1. */
  color: RgbTriple;
  load: MixerLoad;
  seed: number;
  copies: readonly StrokeCopy[];
}

interface CopyState {
  walker: PenDabWalker;
  exchange: PaintExchange;
  smudge: SmudgeTip | null;
  /** Height patch carried by the knife. */
  carried: Float32Array | null;
  amount: number;
}

/** One impasto stroke: colour through the exchange, height and material into live channel tiles. */
export class ThickStrokeDriver {
  dabCount = 0;
  private readonly smoother: PenSmoother;
  private readonly states: CopyState[];
  private readonly medium: TileMedium;
  private readonly height = new Map<TileKey, Uint8ClampedArray>();
  private readonly material = new Map<TileKey, Uint8ClampedArray>();
  private readonly paint: RgbTriple = [0, 0, 0];
  private tip = new Float32Array(0);
  private lastRaw: PenPoint | null = null;
  private lastFed: PenPoint | null = null;
  private version = 0;

  constructor(readonly init: ThickStrokeInit) {
    const b = init.brush;
    this.smoother = new PenSmoother(b.tip.smoothing, b.pressureSmoothing);
    const copies = init.copies.length ? init.copies : [IDENTITY_COPY];
    this.copies = copies;
    const rates = exchangeRates(b.behavior.pickup, b.behavior.mix, 1, b.behavior.mixing);
    this.states = copies.map((c, i) => ({
      walker: new PenDabWalker(b, (init.seed + i * 7919) | 0, c.linear),
      exchange: new PaintExchange(rates, init.load),
      smudge: b.impasto.tool === 'knife' ? new SmudgeTip({ strength: 0.85, length: 0.6 + 0.38 * b.impasto.drag, mixing: b.behavior.mixing }, b.tip.size * 1.2) : null,
      carried: null,
      amount: 1,
    }));
    this.medium = new TileMedium(init.target, {});
  }

  private readonly copies: readonly StrokeCopy[];

  /** What copy 0 carries after the dabs so far. */
  get load(): MixerLoad {
    return this.states[0].exchange.load;
  }

  /** The channels with the stroke so far (new objects whenever they changed). */
  channels(): ThickChannels {
    const h = new Map(this.init.channels.height.tiles);
    const m = new Map(this.init.channels.material.tiles);
    for (const [k, d] of this.height) {
      const t = finishTile(d, 1, 0);
      if (t) h.set(k, t);
      else h.delete(k);
    }
    for (const [k, d] of this.material) {
      const t = finishTile(new Uint8ClampedArray(d), 4, 0);
      if (t) m.set(k, t);
      else m.delete(k);
    }
    void this.version;
    return { height: new TiledSurface(1, h, 0), material: new TiledSurface(4, m, 0) };
  }

  private heightTile(tx: number, ty: number, write: boolean): Uint8ClampedArray | null {
    const key = tileKey(tx, ty);
    let t = this.height.get(key);
    if (t) {
      // Live tiles are replaced on write so caches keyed by identity see the change.
      return t;
    }
    const base = this.init.channels.height.tiles.get(key);
    if (!write) return base ? expand(base, 1) : null;
    t = base ? new Uint8ClampedArray(expand(base, 1)) : new Uint8ClampedArray(TILE * TILE);
    this.height.set(key, t);
    return t;
  }

  private materialTile(tx: number, ty: number): Uint8ClampedArray {
    const key = tileKey(tx, ty);
    let t = this.material.get(key);
    if (!t) {
      const base = this.init.channels.material.tiles.get(key);
      t = base ? new Uint8ClampedArray(expand(base, 4)) : new Uint8ClampedArray(TILE * TILE * 4);
      this.material.set(key, t);
    }
    return t;
  }

  private getH(x: number, y: number): number {
    const t = this.heightTile(Math.floor(x / TILE), Math.floor(y / TILE), false);
    return t ? t[(y & 255) * TILE + (x & 255)] : 0;
  }

  private setH(x: number, y: number, v: number): void {
    const t = this.heightTile(Math.floor(x / TILE), Math.floor(y / TILE), true)!;
    t[(y & 255) * TILE + (x & 255)] = v;
  }

  push(points: readonly PenPoint[]): RasterRect[] {
    const rects: RasterRect[] = [];
    for (const raw of points) {
      this.lastRaw = raw;
      const p = this.smoother.push(raw);
      this.lastFed = p;
      this.copies.forEach((c, i) => {
        const dabs: PenDab[] = [];
        this.states[i].walker.push(c.map(p), dabs);
        this.applyDabs(i, dabs, rects);
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
      if (raw && fed && (raw.x !== fed.x || raw.y !== fed.y)) this.states[i].walker.push(c.map({ ...raw, pressure: fed.pressure }), dabs);
      this.states[i].walker.finish(dabs);
      this.applyDabs(i, dabs, rects);
    });
    return rects;
  }

  private applyDabs(copy: number, dabs: PenDab[], rects: RasterRect[]): void {
    for (const d of dabs) {
      const rect = dabRect(d, this.init.brush.tip.hardness);
      if (rect.width <= 0 || rect.height <= 0) continue;
      this.dab(copy, d, rect);
      rects.push(rect);
      this.dabCount++;
    }
    if (dabs.length) this.version++;
  }

  private dab(copy: number, d: PenDab, rect: RasterRect): void {
    const b = this.init.brush;
    const im = b.impasto;
    const st = this.states[copy];
    const n = rect.width * rect.height;
    if (this.tip.length < n) this.tip = new Float32Array(n);
    const tip = this.tip.subarray(0, n);
    rasterizeDab({ ...d, alpha: 1 }, b.tip.hardness, rect, tip);
    const sel = this.init.target.selection;
    if (sel) {
      for (let yy = 0, p = 0; yy < rect.height; yy++)
        for (let xx = 0; xx < rect.width; xx++, p++) {
          const mx = rect.x + xx;
          const my = rect.y + yy;
          if (tip[p] > 0) tip[p] *= mx >= 0 && my >= 0 && mx < sel.width && my < sel.height ? sel.data[my * sel.width + mx] / 255 : 0;
        }
    }
    const off = this.init.target.offset;
    const k = Math.min(1, d.alpha * d.opacity * b.tip.opacity) * st.amount;
    const thick = im.thickness * (1 - 0.8 * im.thinner);
    // The paint runs out along the stroke.
    st.amount *= 1 - 0.06 * (1 - im.load);
    // Across-the-stroke coordinate for bristle ridges and the roller's stipple.
    const nxs = Math.sin(d.direction);
    const nys = Math.cos(d.direction);
    const r = Math.max(0.5, d.radius);

    if (im.tool === 'knife') {
      // Scrape: the relief flattens towards its low points and is dragged along; the paint smears.
      st.smudge!.dab(this.medium, { x: d.x, y: d.y, radius: d.radius, opacity: k }, rect, tip);
      this.knifeHeight(st, d, rect, tip, k, im.drag);
      this.paintMaterial(rect, tip, k * 0.6, im.gloss, im.metallic);
      return;
    }
    // Colour: the exchange mixes the brush paint with the wet paint it picks up (like oil).
    const ex = st.exchange;
    ex.pickUp(this.medium.sample(rect, tip));
    const total = ex.paint(this.paint);
    ex.drain();
    const dep = Math.min(1, total) * k * (1 - 0.5 * im.thinner);
    if (dep > 0) {
      const cov = new Float32Array(n);
      for (let p = 0; p < n; p++) cov[p] = tip[p] > 0 ? Math.min(1, tip[p] * (im.tool === 'roller' || im.tool === 'gloop' || im.tool === 'tube' ? 1.6 : 1.1)) : 0;
      this.medium.deposit(rect, cov, dep, this.paint, ex.paintPigment);
    }
    // Height.
    const seed = this.init.seed;
    for (let yy = 0, p = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < rect.width; xx++, p++) {
        const c = tip[p];
        if (c <= 0) continue;
        const dx = rect.x + xx;
        const dy = rect.y + yy;
        const lx = dx - off.x;
        const ly = dy - off.y;
        const u = ((dx + 0.5 - d.x) * nxs + (dy + 0.5 - d.y) * nys) / r;
        const h0 = this.getH(lx, ly);
        let h = h0;
        const full = 255 * thick * k;
        switch (im.tool) {
          case 'brush': {
            // Bristle ridges along the stroke: stripes across the tip, with a little noise.
            const ridge = 0.6 + 0.4 * Math.sin(u * 9 + hash2(Math.round(u * 6), 3, seed) * 6.28) + 0.15 * (hash2(lx, ly, seed) - 0.5);
            const target = full * c * ridge;
            // Wet paint pushed by the bristles: towards the ridge profile, building where it overlaps.
            h = Math.max(h0 * (1 - 0.25 * c * im.drag), Math.min(255, h0 * 0.35 + target));
            break;
          }
          case 'tube': {
            const dome = Math.sqrt(Math.max(0, c));
            h = Math.max(h0, Math.min(255, full * dome * 1.1));
            break;
          }
          case 'gloop': {
            const dome = Math.sqrt(Math.max(0, 1 - Math.min(1, Math.abs(u)) ** 2));
            h = Math.max(h0, Math.min(255, full * dome * (c > 0.2 ? 1 : c * 5)));
            break;
          }
          case 'roller': {
            const stipple = 0.75 + 0.5 * hash2(lx >> 1, ly >> 1, seed);
            h = h0 + (Math.min(255, full * 0.6 * stipple) - h0) * Math.min(1, c * 1.5);
            break;
          }
        }
        this.setH(lx, ly, Math.round(Math.max(0, Math.min(255, h))));
      }
    }
    this.paintMaterial(rect, tip, k, im.gloss * (1 - 0.3 * im.thinner), im.metallic);
  }

  /** The knife: flattens the relief under it and carries some of it along (a patch, like a smudge). */
  private knifeHeight(st: CopyState, d: PenDab, rect: RasterRect, tip: Float32Array, k: number, drag: number): void {
    const off = this.init.target.offset;
    const w = rect.width;
    const n = w * rect.height;
    const cur = new Float32Array(n);
    for (let yy = 0, p = 0; yy < rect.height; yy++) for (let xx = 0; xx < w; xx++, p++) cur[p] = this.getH(rect.x + xx - off.x, rect.y + yy - off.y);
    const carried = st.carried && st.carried.length === n ? st.carried : null;
    const next = new Float32Array(n);
    for (let yy = 0, p = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < w; xx++, p++) {
        const c = tip[p] * k;
        if (c <= 0) {
          next[p] = cur[p];
          continue;
        }
        // Scrape flat: the blade levels to a thin film; what it carries is laid down at the trailing edge.
        const flat = cur[p] * (1 - 0.85 * c);
        const laid = carried ? carried[p] * drag * c : 0;
        const v = Math.max(flat, Math.min(255, flat * 0.5 + laid));
        next[p] = v;
        this.setH(rect.x + xx - off.x, rect.y + yy - off.y, Math.round(v));
      }
    }
    // What the blade picked up: the paint it scraped off.
    const pick = new Float32Array(n);
    for (let p = 0; p < n; p++) pick[p] = Math.max(0, cur[p] - next[p]) + (carried ? carried[p] * (1 - drag) * 0.5 : 0);
    st.carried = pick;
  }

  private paintMaterial(rect: RasterRect, tip: Float32Array, k: number, gloss: number, metal: number): void {
    const off = this.init.target.offset;
    for (let yy = 0, p = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < rect.width; xx++, p++) {
        const c = Math.min(1, tip[p] * k);
        if (c <= 0) continue;
        const lx = rect.x + xx - off.x;
        const ly = rect.y + yy - off.y;
        const t = this.materialTile(Math.floor(lx / TILE), Math.floor(ly / TILE));
        const i = ((ly & 255) * TILE + (lx & 255)) * 4;
        t[i] = Math.round(t[i] + (gloss * 255 - t[i]) * c);
        t[i + 1] = Math.round(t[i + 1] + (metal * 255 - t[i + 1]) * c);
        t[i + 3] = 255;
      }
    }
  }
}

/** Height statistics of a layer's relief (for tools). */
export function reliefInfo(ch: ThickChannels): { bounds: RasterRect | null; maxHeight: number; tiles: number } {
  let max = 0;
  for (const t of ch.height.tiles.values()) {
    if (t.uniform !== null) max = Math.max(max, t.uniform & 255);
    else for (let i = 0; i < t.data.length; i++) if (t.data[i] > max) max = t.data[i];
  }
  return { bounds: ch.height.bounds, maxHeight: max, tiles: ch.height.tiles.size };
}

/** A layer's thick-paint channels as saved: PNG data URLs over a rectangle (layer space). */
export interface SavedThickChannels {
  rect: RasterRect;
  /** Greyscale PNG of the height. */
  height: string;
  /** RGBA PNG of the material (R gloss, G metallic). */
  material: string;
}

/** Channels → saved form (`null` when there is no relief). */
export function thickToJSON(ch: ThickChannels): SavedThickChannels | null {
  const b = ch.height.bounds;
  if (!b) return null;
  return { rect: { ...b }, height: pngDataUrl(b.width, b.height, readRegion(ch.height, b), 1), material: pngDataUrl(b.width, b.height, readRegion(ch.material, b), 4) };
}

/** Saved form → channels; throws a sentence when it cannot be read. */
export function thickFromJSON(raw: unknown): ThickChannels {
  const r = raw as Partial<SavedThickChannels>;
  if (!r || typeof r !== 'object' || !r.rect || typeof r.height !== 'string' || typeof r.material !== 'string') throw new Error('not saved thick-paint channels');
  const decode = (url: string, gray: boolean) => {
    const parsed = parseDataUrl(url);
    if (!parsed) throw new Error('a channel is not a PNG data URL');
    return decodePng(parsed.bytes, { keepGray: gray });
  };
  const h = decode(r.height, true);
  const m = decode(r.material, false);
  const hd = h.channels === 1 ? h.data : Uint8ClampedArray.from({ length: h.width * h.height }, (_, i) => h.data[i * 4]);
  return {
    height: surfaceFromPixels({ width: h.width, height: h.height, data: hd }, 1, r.rect.x, r.rect.y),
    material: surfaceFromPixels({ width: m.width, height: m.height, data: m.data }, 4, r.rect.x, r.rect.y),
  };
}
