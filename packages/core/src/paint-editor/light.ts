/**
 * Light paint: a per-layer light channel (`doc.light`, one channel 0..255 per pixel, in layer
 * space like the thick-paint channels) saying how much light the paint there gives off. The
 * light's colour is the layer's own colour at that pixel, so recolouring the paint recolours its
 * light.
 *
 * Laying and moving light: a stroke on a layer with light (or with a brush that lays it) runs a
 * twin of itself over the light channel drawn as grey paint (`lightToShadow`: white with alpha =
 * light). The twin uses the same engine, seed and points with the brush's light amount as its grey
 * colour, in a normal blend and RGB mixing, so light is laid by exactly the stroke's coverage,
 * plain paint over glowing paint dims it, erasers take it away, and smudges, blenders, the knife,
 * the Mixer Brush and pick-up brushes move and pick up light as they move colour.
 *
 * Rendering: glow adds `light × colour × GLOW` (linear light) to the layer's own pixels; spill
 * blurs `light × colour` outwards (at a reduced resolution) into its own layer drawn directly above
 * with Linear Dodge (Add). Impasto rim (material B) brightens a bead's light where its surface
 * turns away, and clarity (material A) lets the middle of a bead show the layers below.
 */

import { TILE, TiledSurface, finishTile, readRegion, surfaceFromPixels, type RasterRect, type Tile, type TileKey } from '../raster/surface';
import { srgbToLinear, linearToSrgb } from '../color/convert';
import { decodePng, parseDataUrl, pngDataUrl } from '../raster/png';
import { normalizePaintBrush, type PaintBrush } from './brushes';
import type { ThickChannels } from './thick';

/** How much brighter full light makes the paint itself (linear light). */
export const GLOW = 1.5;

/** A layer's spill: how far its light reaches (px; 0 turns spill off) and how strong it is (0..2). */
export interface LightSpill {
  radius: number;
  strength: number;
}

export const DEFAULT_LIGHT_SPILL: Readonly<LightSpill> = { radius: 24, strength: 1 };

/** Checks and fills a spill change; throws a sentence naming the bad field. */
export function normalizeLightSpill(raw: Partial<LightSpill>, base: LightSpill = DEFAULT_LIGHT_SPILL): LightSpill {
  const radius = raw.radius ?? base.radius;
  const strength = raw.strength ?? base.strength;
  if (!(Number.isFinite(radius) && radius >= 0 && radius <= 512)) throw new Error(`radius ${radius} is out of range; use 0..512 px (0 turns spill off).`);
  if (!(Number.isFinite(strength) && strength >= 0 && strength <= 2)) throw new Error(`strength ${strength} is out of range; use 0..2.`);
  return { radius, strength };
}

export function emptyLight(): TiledSurface {
  return new TiledSurface(1, new Map(), 0);
}

const full = (t: Tile, channels: 1 | 4): Uint8ClampedArray => {
  if (t.data.length === TILE * TILE * channels) return t.data;
  const out = new Uint8ClampedArray(TILE * TILE * channels);
  const u = t.uniform ?? 0;
  if (channels === 1) out.fill(u & 255);
  else {
    const bytes = [(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255];
    for (let i = 0; i < out.length; i += 4) out.set(bytes, i);
  }
  return out;
};

/** The light channel as grey paint for a stroke's twin: white, with alpha = light. */
export function lightToShadow(light: TiledSurface): TiledSurface {
  const tiles = new Map<TileKey, Tile>();
  for (const [key, tile] of light.tiles) {
    const l = full(tile, 1);
    const d = new Uint8ClampedArray(TILE * TILE * 4);
    for (let i = 0, j = 0; i < l.length; i++, j += 4) {
      if (!l[i]) continue;
      d[j] = d[j + 1] = d[j + 2] = 255;
      d[j + 3] = l[i];
    }
    const t = finishTile(d, 4, 0);
    if (t) tiles.set(key, t);
  }
  return new TiledSurface(4, tiles, 0);
}

/** A twin's grey paint back as light: grey × alpha. */
export function shadowToLight(shadow: TiledSurface): TiledSurface {
  const tiles = new Map<TileKey, Tile>();
  for (const [key, tile] of shadow.tiles) {
    const s = full(tile, 4);
    const d = new Uint8ClampedArray(TILE * TILE);
    for (let i = 0, j = 0; i < d.length; i++, j += 4) if (s[j + 3]) d[i] = Math.round((((s[j] + s[j + 1] + s[j + 2]) / 3) * s[j + 3]) / 255);
    const t = finishTile(d, 1, 0);
    if (t) tiles.set(key, t);
  }
  return new TiledSurface(1, tiles, 0);
}

/** The brush a stroke's light twin paints with: the same marks, grey, normal blend, RGB mixing, no gradient. */
export function lightTwinBrush(brush: PaintBrush): PaintBrush {
  return normalizePaintBrush(
    {
      tip: { ...brush.tip, blend: 'normal', pressureOpacity: brush.tip.pressureOpacity || brush.light.pressure },
      behavior: { ...brush.behavior, mixing: 'rgb' },
      paint: null,
      ...(brush.engine === 'mixer' ? { mixer: { ...brush.mixer, mixing: 'rgb' } } : {}),
      ...(brush.engine === 'blender' ? { blender: { ...brush.blender, mixing: 'rgb' } } : {}),
      ...(brush.engine === 'smudge' ? { smudge: { ...brush.smudge, mixing: 'rgb' } } : {}),
    },
    brush
  );
}

/** Where a layer's light is (layer space) and its brightest value 0..255; `null` bounds when it has none. */
export function lightInfo(light: TiledSurface | undefined): { bounds: RasterRect | null; peak: number } {
  if (!light) return { bounds: null, peak: 0 };
  let peak = 0;
  for (const t of light.tiles.values()) {
    if (t.uniform !== null) peak = Math.max(peak, t.uniform & 255);
    else for (let i = 0; i < t.data.length; i++) if (t.data[i] > peak) peak = t.data[i];
  }
  return { bounds: peak ? light.bounds : null, peak };
}

/** Light scaled by `k` (0..1), e.g. under a fill that covers it. */
export function scaleLight(light: TiledSurface, k: number): TiledSurface {
  if (k >= 1) return light;
  const tiles = new Map<TileKey, Tile>();
  if (k > 0) {
    for (const [key, tile] of light.tiles) {
      const d = Uint8ClampedArray.from(full(tile, 1), (v) => Math.round(v * k));
      const t = finishTile(d, 1, 0);
      if (t) tiles.set(key, t);
    }
  }
  return new TiledSurface(1, tiles, 0);
}

/**
 * Light of a layer merged down onto the one below (both in the lower layer's space): the upper
 * layer's light over the lower's, which shows through where the upper paint is transparent.
 */
export function mergeLight(lower: TiledSurface | undefined, upper: TiledSurface | undefined, upperColor: TiledSurface): TiledSurface | undefined {
  if (!upper?.tiles.size) return lower;
  const keys = new Set<TileKey>([...(lower?.tiles.keys() ?? []), ...upper.tiles.keys()]);
  const tiles = new Map<TileKey, Tile>();
  for (const key of keys) {
    const lo = lower?.tiles.get(key);
    const up = upper.tiles.get(key);
    const col = upperColor.tiles.get(key);
    const l = lo ? full(lo, 1) : null;
    const u = up ? full(up, 1) : null;
    const c = col ? full(col, 4) : null;
    const d = new Uint8ClampedArray(TILE * TILE);
    for (let i = 0; i < d.length; i++) {
      const a = c ? c[i * 4 + 3] / 255 : 0;
      d[i] = Math.round((u ? u[i] : 0) + (l ? l[i] : 0) * (1 - a));
    }
    const t = finishTile(d, 1, 0);
    if (t) tiles.set(key, t);
  }
  return new TiledSurface(1, tiles, 0);
}

/** How far a bead's surface faces the viewer (0 edge-on .. 1 facing), from the height around a pixel. */
function facing(h: Uint8ClampedArray, x: number, y: number): number {
  const at = (xx: number, yy: number) => h[Math.min(TILE - 1, Math.max(0, yy)) * TILE + Math.min(TILE - 1, Math.max(0, xx))];
  // Height in px: 255 is about 7 px of relief (as thick paint's lighting).
  const k = 7 / 255;
  const dx = ((at(x + 1, y) - at(x - 1, y)) / 2) * k;
  const dy = ((at(x, y + 1) - at(x, y - 1)) / 2) * k;
  return 1 / Math.hypot(dx, dy, 1);
}

/**
 * Glow, rim and clarity over a layer's (lit) colour, tile by tile, cached by the identity of each
 * tile's inputs. Tiles with no light and no clear thick paint are the colour tiles themselves.
 */
export class LightCache {
  private readonly tiles = new Map<TileKey, { inputs: unknown[]; tile: Tile }>();

  glow(color: TiledSurface, light: TiledSurface | undefined, thick: ThickChannels | undefined): TiledSurface {
    const clear = (m: Tile | undefined) => !!m && (m.uniform === null ? m.data.some((v, i) => i % 4 === 3 && v > 0 && v < 255) : ((m.uniform & 255) > 0 && (m.uniform & 255) < 255));
    if (!light?.tiles.size && !(thick && [...thick.material.tiles.values()].some(clear))) return color;
    const out = new Map(color.tiles);
    const seen = new Set<TileKey>();
    for (const [key, tile] of color.tiles) {
      const l = light?.tiles.get(key);
      const m = thick?.material.tiles.get(key);
      const h = thick?.height.tiles.get(key);
      if (!l && !clear(m)) continue;
      seen.add(key);
      const inputs: unknown[] = [tile, l ?? null, m ?? null, h ?? null];
      const cached = this.tiles.get(key);
      if (cached && cached.inputs.every((v, i) => v === inputs[i])) {
        out.set(key, cached.tile);
        continue;
      }
      const c = full(tile, 4);
      const ld = l ? full(l, 1) : null;
      const md = m ? full(m, 4) : null;
      const hd = h ? full(h, 1) : null;
      const d = new Uint8ClampedArray(c);
      for (let y = 0, i = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++, i++) {
          const j = i * 4;
          if (!d[j + 3]) continue;
          const rim = md ? md[j + 2] / 255 : 0;
          const opacity = md && md[j + 3] ? md[j + 3] : 255;
          const f = (rim > 0 || opacity < 255) && hd ? facing(hd, x, y) : 1;
          const g = ld && ld[i] ? (ld[i] / 255) * (1 - rim + rim * 2 * (1 - f) ** 3) : 0;
          if (g > 0) {
            for (let ch = 0; ch < 3; ch++) d[j + ch] = Math.round(linearToSrgb(Math.min(1, srgbToLinear(d[j + ch] / 255) * (1 + GLOW * g))) * 255);
          }
          // Clarity: the middle of a bead (facing the viewer) turns clear; its edges stay solid.
          if (opacity < 255) d[j + 3] = Math.round(d[j + 3] * (1 - ((255 - opacity) / 254) * f));
        }
      }
      const lit: Tile = { data: d, uniform: null };
      this.tiles.set(key, { inputs, tile: lit });
      out.set(key, lit);
    }
    for (const key of [...this.tiles.keys()]) if (!seen.has(key)) this.tiles.delete(key);
    return new TiledSurface(4, out, color.defaultValue);
  }

  private spillCache: { inputs: unknown[]; surface: TiledSurface | null } | null = null;

  /**
   * The layer's spill (layer space, RGBA for Linear Dodge (Add)): `light × colour` blurred by
   * `radius` px at a reduced resolution, times `strength`; `null` without light or spill.
   */
  spill(color: TiledSurface, light: TiledSurface | undefined, spill: LightSpill): TiledSurface | null {
    const inputs = [color, light, spill.radius, spill.strength];
    if (this.spillCache && this.spillCache.inputs.every((v, i) => v === inputs[i])) return this.spillCache.surface;
    const surface = computeSpill(color, light, spill);
    this.spillCache = { inputs, surface };
    return surface;
  }
}

/** See `LightCache.spill`. */
export function computeSpill(color: TiledSurface, light: TiledSurface | undefined, spill: LightSpill): TiledSurface | null {
  const b = light ? lightInfo(light).bounds : null;
  if (!light || !b || spill.radius <= 0 || spill.strength <= 0) return null;
  const r = Math.ceil(spill.radius);
  const region = { x: b.x - r, y: b.y - r, width: b.width + 2 * r, height: b.height + 2 * r };
  const col = readRegion(color, region);
  const lit = readRegion(light, region);
  // Reduced resolution: the blur is wide and smooth, so a few pixels per cell are enough.
  const f = Math.max(1, Math.floor(spill.radius / 6));
  const w = Math.ceil(region.width / f);
  const h = Math.ceil(region.height / f);
  const e = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const i = y * region.width + x;
      const l = lit[i];
      if (!l) continue;
      const j = i * 4;
      const k = ((l / 255) * (col[j + 3] / 255)) / (f * f);
      const cell = Math.floor(y / f) * w + Math.floor(x / f);
      for (let ch = 0; ch < 3; ch++) e[ch][cell] += srgbToLinear(col[j + ch] / 255) * k;
    }
  }
  // Three box blurs ≈ a Gaussian with σ ≈ radius / 2.
  const box = Math.max(1, Math.round(spill.radius / f / 2.5));
  for (const plane of e) for (let pass = 0; pass < 3; pass++) boxBlur(plane, w, h, box);
  const out = new Uint8ClampedArray(region.width * region.height * 4);
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      // Bilinear back up to full resolution.
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) / f - 0.5));
      const fy = Math.min(h - 1, Math.max(0, (y + 0.5) / f - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const rgb = e.map((p) => (p[y0 * w + x0] * (1 - tx) + p[y0 * w + x1] * tx) * (1 - ty) + (p[y1 * w + x0] * (1 - tx) + p[y1 * w + x1] * tx) * ty) as number[];
      // Added light (linear), as sRGB with alpha: Linear Dodge adds rgb × alpha.
      const add = rgb.map((v) => Math.min(1, linearToSrgb(Math.min(1, v * spill.strength))));
      const a = Math.max(add[0], add[1], add[2]);
      if (a <= 1 / 255) continue;
      const o = (y * region.width + x) * 4;
      out[o] = Math.round((add[0] / a) * 255);
      out[o + 1] = Math.round((add[1] / a) * 255);
      out[o + 2] = Math.round((add[2] / a) * 255);
      out[o + 3] = Math.round(a * 255);
    }
  }
  return surfaceFromPixels({ width: region.width, height: region.height, data: out }, 4, region.x, region.y);
}

/** A box blur of radius `r` across then down, in place (edges clamped). */
function boxBlur(p: Float32Array, w: number, h: number, r: number): void {
  const tmp = new Float32Array(Math.max(w, h));
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += p[y * w + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[x] = sum / n;
      sum += p[y * w + Math.min(w - 1, x + r + 1)] - p[y * w + Math.max(0, x - r)];
    }
    for (let x = 0; x < w; x++) p[y * w + x] = tmp[x];
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += p[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      tmp[y] = sum / n;
      sum += p[Math.min(h - 1, y + r + 1) * w + x] - p[Math.max(0, y - r) * w + x];
    }
    for (let y = 0; y < h; y++) p[y * w + x] = tmp[y];
  }
}

/** A layer's light as saved: its rect (layer space) and a grey PNG. */
export interface SavedLight {
  rect: RasterRect;
  light: string;
}

export function lightToJSON(light: TiledSurface): SavedLight | null {
  const b = lightInfo(light).bounds;
  if (!b) return null;
  return { rect: { ...b }, light: pngDataUrl(b.width, b.height, readRegion(light, b), 1) };
}

/** Saved form → light channel; throws a sentence when it cannot be read. */
export function lightFromJSON(raw: unknown): TiledSurface {
  const r = raw as Partial<SavedLight>;
  if (!r || typeof r !== 'object' || !r.rect || typeof r.light !== 'string') throw new Error('not a saved light channel');
  const parsed = parseDataUrl(r.light);
  if (!parsed) throw new Error('the light is not a PNG data URL');
  const img = decodePng(parsed.bytes, { keepGray: true });
  const data = img.channels === 1 ? img.data : Uint8ClampedArray.from({ length: img.width * img.height }, (_, i) => img.data[i * 4]);
  return surfaceFromPixels({ width: img.width, height: img.height, data }, 1, r.rect.x, r.rect.y);
}
