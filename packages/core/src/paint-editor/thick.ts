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
import { PaintGradientSampler, type PaintGradientSample, type PaintGradientSource } from '../paint/gradient-paint';
import { effectDabField, sampleEffectAt, type EffectPaintPixels } from './effect-paint';
import { TILE, TiledSurface, finishTile, readRegion, surfaceFromSavedPixels, tileKeyIn, type RasterRect, type Tile, type TileKey } from '../raster/surface';
import { decodePng, parseDataUrl, pngDataUrl } from '../raster/png';
import type { IridescenceSettings } from './brush-model';
import type { PaintBrush } from './brushes';
import { IDENTITY_COPY, PenDabWalker, PenSmoother, type PenDab, type PenPoint, type StrokeCopy } from './engine';
import {
  FERRO_CARRIER_RGB,
  FERRO_DEFAULT_GLOSS,
  FERRO_DEFAULT_METALLIC,
  FERRO_DEFAULT_RIM,
  ferroCacheKey,
  ferroSpikeHeightAt,
  type FerroLayerInput,
} from './ferro';
import { hash2 } from './noise';
import { ageKey, carveAgeCrackHeightTile, isAgeActive, type PaintAgeSettings } from './age';

/**
 * A tile nothing keeps, handed to a write past the surface range (#852) so the pixel is dropped
 * instead of landing on another tile. Reads past the range see no tile (the default).
 */
const outsideTiles: [Uint8ClampedArray | null, Uint8ClampedArray | null] = [null, null];
function outsideTile(channels: 1 | 4): Uint8ClampedArray {
  const i = channels === 1 ? 0 : 1;
  return (outsideTiles[i] ??= new Uint8ClampedArray(TILE * TILE * channels));
}

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

/** View tilt (-1..1 on each axis, default 0): shifts the view vector for thin-film iridescence and highlights, not the light. Not saved with the document. */
export interface PaintViewTilt {
  x: number;
  y: number;
}

export const DEFAULT_VIEW_TILT: Readonly<PaintViewTilt> = { x: 0, y: 0 };

export function normalizeViewTilt(raw: Partial<PaintViewTilt> = {}, base: PaintViewTilt = DEFAULT_VIEW_TILT): PaintViewTilt {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    x: Math.min(1, Math.max(-1, num(raw.x, base.x))),
    y: Math.min(1, Math.max(-1, num(raw.y, base.y))),
  };
}

export function viewTiltKey(v: PaintViewTilt): string {
  return `${v.x.toFixed(3)}|${v.y.toFixed(3)}`;
}

/** A layer's thick-paint channels (layer space, like its pixels). */
export interface ThickChannels {
  /** Height 0..255 per pixel (1 channel). */
  height: TiledSurface;
  /** Material per pixel (4 channels): R gloss, G metallic, B rim (light paint), A opacity for clarity (255 solid; 0 no material, read as solid). */
  material: TiledSurface;
  /** Thin-film iridescence per pixel (4 channels): R thickness (0..255 → 100..1000 nm), G refractive index (0..255 → 1.2..2.0), B 0, A film coverage (0..255). */
  film: TiledSurface;
}

export function emptyThickChannels(): ThickChannels {
  return { height: new TiledSurface(1, new Map(), 0), material: new TiledSurface(4, new Map(), 0), film: new TiledSurface(4, new Map(), 0) };
}

export function hasThickChannels(ch: ThickChannels | undefined): boolean {
  return Boolean(ch && (ch.height.tiles.size > 0 || ch.material.tiles.size > 0 || ch.film.tiles.size > 0));
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

/** View vector (towards the viewer) for a view tilt. */
function viewVector(v: PaintViewTilt): [number, number, number] {
  const vx = v.x * 1.25;
  const vy = v.y * 1.25;
  const vz = 1;
  const vl = Math.hypot(vx, vy, vz);
  return [vx / vl, vy / vl, vz / vl];
}

/**
 * Thin-film interference reflectance (linear RGB 0..1) for an optical path difference `opd` in nm:
 * Airy / cosine interference across the three primary bands (630, 532, 465 nm) with a half-wave
 * top-surface phase shift.
 */
export function thinFilmRgb(opd: number): [number, number, number] {
  const twoPi = Math.PI * 2;
  return [
    0.5 - 0.5 * Math.cos((twoPi * opd) / 630),
    0.5 - 0.5 * Math.cos((twoPi * opd) / 532),
    0.5 - 0.5 * Math.cos((twoPi * opd) / 465),
  ];
}

export function lightingKey(l: PaintLighting): string {
  return `${l.azimuth.toFixed(2)}|${l.elevation.toFixed(2)}|${l.relief.toFixed(3)}`;
}

/**
 * One tile of a thick or iridescent layer lit: `color` (RGBA, straight), the height, material and
 * thin-film channels of the tile, and the height of its 8 neighbours for the slopes at the border
 * (`heightAround(dx, dy)` returns the neighbouring tile's data or null). Returns a new RGBA tile.
 */
export function lightTile(
  color: Uint8ClampedArray,
  height: Uint8ClampedArray | null,
  heightAround: (dx: number, dy: number) => Uint8ClampedArray | null,
  material: Uint8ClampedArray | null,
  light: PaintLighting,
  film: Uint8ClampedArray | null = null,
  viewTilt: PaintViewTilt = DEFAULT_VIEW_TILT,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(color);
  const hasRelief = Boolean(height && light.relief > 0);
  if (!hasRelief && !film) return out;
  const [lx, ly, lz] = lightVector(light);
  const [vx, vy, vz] = viewVector(viewTilt);
  const hv = [lx + vx, ly + vy, lz + vz];
  const hl = Math.hypot(hv[0], hv[1], hv[2]);
  const hx = hv[0] / hl;
  const hy = hv[1] / hl;
  const hz = hv[2] / hl;
  const k = (RELIEF_PX / 255) * light.relief * 2;
  const flatDiffuse = AMBIENT + (1 - AMBIENT) * lz;
  const read = (x: number, y: number): number => {
    if (!height) return 0;
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
      const fa = film ? film[i + 3] / 255 : 0;
      const h = hasRelief ? height![p] : 0;
      const gx = hasRelief ? (read(x + 1, y) - read(x - 1, y)) * 0.5 : 0;
      const gy = hasRelief ? (read(x, y + 1) - read(x, y - 1)) * 0.5 : 0;
      const hasSlope = hasRelief && (h !== 0 || gx !== 0 || gy !== 0);
      if (!hasSlope && fa <= 0) continue;
      let nx = 0;
      let ny = 0;
      let nz = 1;
      let shade = 1;
      let gloss = 0.3;
      let metal = 0;
      let spec = 0;
      if (hasSlope) {
        nx = -gx * k;
        ny = -gy * k;
        const nl = Math.hypot(nx, ny, 1);
        nx /= nl;
        ny /= nl;
        nz = 1 / nl;
        const diffuse = Math.max(0, nx * lx + ny * ly + nz * lz);
        shade = (AMBIENT + (1 - AMBIENT) * diffuse) / flatDiffuse;
        gloss = material ? material[i] / 255 : 0.3;
        metal = material ? material[i + 1] / 255 : 0;
        const shininess = 6 + 90 * gloss;
        const nh = Math.max(0, nx * hx + ny * hy + nz * hz);
        // Only slopes catch a highlight: subtract what a flat surface would show.
        spec = Math.max(0, Math.pow(nh, shininess) - Math.pow(hz, shininess)) * (0.25 + 0.75 * gloss) * light.relief;
      }
      let filmRgb: [number, number, number] | null = null;
      if (fa > 0 && film) {
        const d = 100 + (film[i] / 255) * 900;
        const ior = 1.2 + (film[i + 1] / 255) * 0.8;
        const nh = Math.max(0, nx * hx + ny * hy + nz * hz);
        const nv = Math.max(0, nx * vx + ny * vy + nz * vz);
        const cosThetaI = Math.max(0, Math.min(1, nh * nv));
        const sin2ThetaT = (1 - cosThetaI * cosThetaI) / (ior * ior);
        const cosThetaT = Math.sqrt(Math.max(0, 1 - sin2ThetaT));
        const opd = 2 * ior * d * cosThetaT;
        filmRgb = thinFilmRgb(opd);
      }
      for (let c = 0; c < 3; c++) {
        const a = SRGB_TO_LINEAR[color[i + c]];
        const fc = filmRgb ? filmRgb[c] : a;
        if (hasSlope) {
          const tint = metal * a + (1 - metal);
          const diff = fa > 0 ? a * (1 - fa * 0.75) + fc * fa * (0.45 + 0.55 * a) : a;
          const specTint = fa > 0 ? tint * (1 - fa) + fc * fa : tint;
          const v = diff * shade * (1 - 0.35 * metal) + spec * specTint * (1 + metal);
          out[i + c] = linearToSrgb8(v);
        } else {
          const v = a * (1 - fa * 0.75) + fc * fa * (0.45 + 0.55 * a);
          out[i + c] = linearToSrgb8(v);
        }
      }
    }
  }
  return out;
}

/** Cache of lit tiles for one layer, by the identity of their inputs. */
export class LitCache {
  private readonly tiles = new Map<TileKey, { inputs: unknown[]; tile: Tile }>();

  /**
   * The layer's pixels lit (tiles without relief, film or ferrofluid nearby are the colour tiles
   * themselves). Without ferrofluid this is the thick-paint / thin-film pass; with it, the liquid
   * ferrofluid adds its carrier colour, glossy metallic material and (near magnets) Rosensweig
   * spike heights before the same lighting.
   */
  lit(
    color: TiledSurface,
    ch: ThickChannels,
    light: PaintLighting,
    viewTilt: PaintViewTilt = DEFAULT_VIEW_TILT,
    ferro?: FerroLayerInput | null,
    age?: PaintAgeSettings | null,
    layerCount = 1,
    offset: { x: number; y: number } = { x: 0, y: 0 },
  ): TiledSurface {
    if (ferro && ferro.surface.tiles.size > 0) return this.litFerro(color, ch, light, viewTilt, ferro);
    const hasCracks = Boolean(age && isAgeActive(age) && age.cracks > 0 && light.relief > 0);
    const hasRelief = (ch.height.tiles.size > 0 || hasCracks) && light.relief > 0;
    const hasFilm = ch.film.tiles.size > 0;
    if (!hasRelief && !hasFilm) return color;
    const lk = `${lightingKey(light)}|${viewTiltKey(viewTilt)}${hasCracks ? `|${ageKey(age!)}|${layerCount}|${offset.x},${offset.y}` : ''}`;
    const out = new Map(color.tiles);
    const keys = new Set<TileKey>();
    for (const key of color.tiles.keys()) keys.add(key);
    for (const [key, tile] of color.tiles) {
      const tx = (key % 65536) - 32768;
      const ty = Math.floor(key / 65536) - 32768;
      const around = (dx: number, dy: number) => ch.height.tiles.get(tileKeyIn(tx + dx, ty + dy))?.data ?? null;
      let any = hasCracks;
      if (hasRelief && !any) {
        for (let dy = -1; dy <= 1 && !any; dy++) for (let dx = -1; dx <= 1 && !any; dx++) if (around(dx, dy)) any = true;
      }
      const f = ch.film.tiles.get(key) ?? null;
      if (!any && !f) continue;
      const h = hasRelief ? (ch.height.tiles.get(key) ?? null) : null;
      const m = hasRelief ? (ch.material.tiles.get(key) ?? null) : null;
      const inputs: unknown[] = [tile, lk, m, f];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nk = tileKeyIn(tx + dx, ty + dy);
          inputs.push(hasRelief ? (ch.height.tiles.get(nk) ?? null) : null);
          if (hasCracks) inputs.push(color.tiles.get(nk) ?? null);
        }
      }
      const cached = this.tiles.get(key);
      if (cached && cached.inputs.length === inputs.length && cached.inputs.every((v, i) => v === inputs[i])) {
        out.set(key, cached.tile);
        continue;
      }
      const cd = expand(tile, 4);
      const heightTileAt = (ntx: number, nty: number): Uint8ClampedArray | null => {
        const nk = tileKeyIn(ntx, nty);
        const ht = ch.height.tiles.get(nk);
        const baseH = ht ? expand(ht, 1) : null;
        if (!hasCracks) return baseH;
        const ct = ntx === tx && nty === ty ? cd : (() => {
          const nt = color.tiles.get(nk);
          return nt ? expand(nt, 4) : null;
        })();
        return carveAgeCrackHeightTile(ct, baseH, ntx, nty, offset, age!, layerCount);
      };
      const hd = hasRelief ? heightTileAt(tx, ty) : null;
      const md = m ? expand(m, 4) : null;
      const fd = f ? expand(f, 4) : null;
      const data = lightTile(
        cd,
        hd,
        (dx, dy) => heightTileAt(tx + dx, ty + dy),
        md,
        light,
        fd,
        viewTilt,
      );
      const lit: Tile = { data, uniform: null };
      this.tiles.set(key, { inputs, tile: lit });
      out.set(key, lit);
    }
    for (const key of [...this.tiles.keys()]) if (!keys.has(key)) this.tiles.delete(key);
    return new TiledSurface(4, out, color.defaultValue);
  }

  /**
   * The ferrofluid lighting pass: every tile with ferrofluid or thick relief nearby is lit, with the
   * liquid's carrier colour and gloss / metal material blended in and its spikes added to the
   * height field. Thick relief is lit even when `light.relief` is 0 here (the spikes need it), and
   * a thin film on the same layer still colours the lit tiles.
   */
  private litFerro(color: TiledSurface, ch: ThickChannels, light: PaintLighting, viewTilt: PaintViewTilt, ferro: FerroLayerInput): TiledSurface {
    const hasFerroSpikes = ferro.magnets.length > 0;
    const lk = `${lightingKey(light)}|${viewTiltKey(viewTilt)}`;
    const fk = ferroCacheKey(ferro);
    const out = new Map(color.tiles);
    const keys = new Set<TileKey>();
    for (const key of color.tiles.keys()) keys.add(key);
    for (const key of ferro.surface.tiles.keys()) keys.add(key);
    for (const key of keys) {
      const tile = color.tiles.get(key) ?? null;
      const tx = (key % 65536) - 32768;
      const ty = Math.floor(key / 65536) - 32768;
      const aroundH = (dx: number, dy: number) => ch.height.tiles.get(tileKeyIn(tx + dx, ty + dy)) ?? null;
      const aroundF = (dx: number, dy: number) => ferro.surface.tiles.get(tileKeyIn(tx + dx, ty + dy)) ?? null;
      const film = ch.film.tiles.get(key) ?? null;
      let any = !!film;
      for (let dy = -1; dy <= 1 && !any; dy++) {
        for (let dx = -1; dx <= 1 && !any; dx++) {
          if (aroundH(dx, dy) || aroundF(dx, dy)) any = true;
        }
      }
      if (!any) continue;
      const m = ch.material.tiles.get(key) ?? null;
      const f = ferro.surface.tiles.get(key) ?? null;
      if (!tile && !f) continue;
      const inputs: unknown[] = [tile, lk, m, fk, film];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) inputs.push(aroundH(dx, dy));
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) inputs.push(aroundF(dx, dy));
      const cached = this.tiles.get(key);
      if (cached && cached.inputs.length === inputs.length && cached.inputs.every((v, i) => v === inputs[i])) {
        out.set(key, cached.tile);
        continue;
      }

      let cd = tile ? expand(tile, 4) : new Uint8ClampedArray(TILE * TILE * 4);
      let md = m ? expand(m, 4) : null;
      if (f) {
        const fd = expand(f, 1);
        cd = new Uint8ClampedArray(cd);
        const mBuf = md ? new Uint8ClampedArray(md) : new Uint8ClampedArray(TILE * TILE * 4);
        for (let p = 0; p < fd.length; p++) {
          const fb = fd[p];
          if (!fb) continue;
          const i = p * 4;
          if (cd[i + 3] < fb) {
            const a0 = cd[i + 3] / fb;
            cd[i] = Math.round(cd[i] * a0 + FERRO_CARRIER_RGB[0] * (1 - a0));
            cd[i + 1] = Math.round(cd[i + 1] * a0 + FERRO_CARRIER_RGB[1] * (1 - a0));
            cd[i + 2] = Math.round(cd[i + 2] * a0 + FERRO_CARRIER_RGB[2] * (1 - a0));
            cd[i + 3] = fb;
          }
          const w = fb / 255;
          mBuf[i] = Math.max(mBuf[i], Math.round(FERRO_DEFAULT_GLOSS * w));
          mBuf[i + 1] = Math.max(mBuf[i + 1], Math.round(FERRO_DEFAULT_METALLIC * w));
          mBuf[i + 2] = Math.max(mBuf[i + 2], Math.round(FERRO_DEFAULT_RIM * w));
          mBuf[i + 3] = mBuf[i + 3] || 255;
        }
        md = mBuf;
      }

      const buildHeightTile = (ntx: number, nty: number): Uint8ClampedArray | null => {
        const nkey = tileKeyIn(ntx, nty);
        const ht = ch.height.tiles.get(nkey) ?? null;
        const ft = hasFerroSpikes ? (ferro.surface.tiles.get(nkey) ?? null) : null;
        if (!ht && !ft) return null;
        if (!ft) return expand(ht!, 1);
        const hBase = ht ? expand(ht, 1) : null;
        const fData = expand(ft, 1);
        const outH = hBase ? new Uint8ClampedArray(hBase) : new Uint8ClampedArray(TILE * TILE);
        const ox = ntx * TILE + ferro.offset.x + 0.5;
        const oy = nty * TILE + ferro.offset.y + 0.5;
        for (let py = 0, p = 0; py < TILE; py++) {
          const docY = oy + py;
          for (let px = 0; px < TILE; px++, p++) {
            const fb = fData[p];
            if (!fb) continue;
            const hs = ferroSpikeHeightAt(ox + px, docY, fb, ferro.magnets, ferro.settings);
            if (hs > 0) outH[p] = Math.min(255, outH[p] + hs);
          }
        }
        return outH;
      };

      const hd = buildHeightTile(tx, ty);
      const data = lightTile(cd, hd, (dx, dy) => buildHeightTile(tx + dx, ty + dy), md, light, film ? expand(film, 4) : null, viewTilt);
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

/** Live thin-film iridescence buffer for any stroke engine (deposits or erases into 4-channel `ThickChannels.film`). */
export class FilmBuffer {
  private readonly tiles = new Map<TileKey, Uint8ClampedArray>();

  constructor(
    private readonly base: TiledSurface,
    private readonly offset: { x: number; y: number } = { x: 0, y: 0 },
    private readonly mask: PaintTileTarget['selection'] = null,
  ) {}

  private maskAt(wx: number, wy: number): number {
    const sel = this.mask;
    if (!sel) return 1;
    return wx >= 0 && wy >= 0 && wx < sel.width && wy < sel.height ? sel.data[wy * sel.width + wx] / 255 : 0;
  }

  private tile(tx: number, ty: number): Uint8ClampedArray {
    const key = tileKeyIn(tx, ty);
    if (key < 0) return outsideTile(4);
    let t = this.tiles.get(key);
    if (!t) {
      const b = this.base.tiles.get(key);
      t = b ? new Uint8ClampedArray(expand(b, 4)) : new Uint8ClampedArray(TILE * TILE * 4);
      this.tiles.set(key, t);
    }
    return t;
  }

  /** Deposits thin-film iridescence over `rect` with per-pixel `coverage` (0..1) scaled by `strength` (0..1). */
  deposit(rect: RasterRect, coverage: ArrayLike<number>, strength: number, ir: IridescenceSettings, pressure = 0.5): void {
    if (strength <= 0) return;
    const nm = Math.max(100, Math.min(1000, ir.thickness * (1 + ir.pressureToThickness * (pressure - 0.5) * 2)));
    const rByte = Math.round(((nm - 100) / 900) * 255);
    const gByte = Math.round(((ir.ior - 1.2) / 0.8) * 255);
    const ox = this.offset.x;
    const oy = this.offset.y;
    for (let yy = 0, p = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < rect.width; xx++, p++) {
        const wx = rect.x + xx;
        const wy = rect.y + yy;
        const m = this.maskAt(wx, wy);
        const c = Math.min(1, coverage[p] * strength * m);
        if (c <= 0) continue;
        const lx = wx - ox;
        const ly = wy - oy;
        const t = this.tile(Math.floor(lx / TILE), Math.floor(ly / TILE));
        const i = ((ly & 255) * TILE + (lx & 255)) * 4;
        const prevA = t[i + 3] / 255;
        const nextA = prevA + c * (1 - prevA);
        const w = nextA > 0 ? c / nextA : 1;
        t[i] = Math.round(t[i] + (rByte - t[i]) * w);
        t[i + 1] = Math.round(t[i + 1] + (gByte - t[i + 1]) * w);
        t[i + 2] = 0;
        t[i + 3] = Math.round(nextA * 255);
      }
    }
  }

  /** Stamps a soft disc of thin-film iridescence at `(cx, cy)` (document pixels) with `radius` and `alpha` (0..1). */
  stampDisc(cx: number, cy: number, radius: number, alpha: number, ir: IridescenceSettings, pressure = 0.5): void {
    if (alpha <= 0 || radius <= 0) return;
    const r = Math.max(0.5, radius);
    const x0 = Math.floor(cx - r - 1);
    const y0 = Math.floor(cy - r - 1);
    const x1 = Math.ceil(cx + r + 1);
    const y1 = Math.ceil(cy + r + 1);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    const cov = new Float32Array(w * h);
    for (let yy = 0, p = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++, p++) {
        const d = Math.hypot(x0 + xx + 0.5 - cx, y0 + yy + 0.5 - cy);
        if (d < r + 0.5) cov[p] = d <= r - 0.5 ? 1 : Math.max(0, r + 0.5 - d);
      }
    }
    this.deposit({ x: x0, y: y0, width: w, height: h }, cov, Math.min(1, alpha), ir, pressure);
  }

  /** Erases thin-film coverage over `rect` by `coverage[p] * strength`. */
  erase(rect: RasterRect, coverage: ArrayLike<number>, strength: number): void {
    if (strength <= 0) return;
    const ox = this.offset.x;
    const oy = this.offset.y;
    for (let yy = 0, p = 0; yy < rect.height; yy++) {
      for (let xx = 0; xx < rect.width; xx++, p++) {
        const wx = rect.x + xx;
        const wy = rect.y + yy;
        const m = this.maskAt(wx, wy);
        const c = Math.min(1, coverage[p] * strength * m);
        if (c <= 0) continue;
        const lx = wx - ox;
        const ly = wy - oy;
        const tx = Math.floor(lx / TILE);
        const ty = Math.floor(ly / TILE);
        const key = tileKeyIn(tx, ty);
        if (!this.tiles.has(key) && !this.base.tiles.has(key)) continue;
        const t = this.tile(tx, ty);
        const i = ((ly & 255) * TILE + (lx & 255)) * 4;
        const a = Math.round(t[i + 3] * (1 - c));
        if (a <= 0) {
          t[i] = 0;
          t[i + 1] = 0;
          t[i + 2] = 0;
          t[i + 3] = 0;
        } else {
          t[i + 3] = a;
        }
      }
    }
  }

  surface(): TiledSurface {
    const out = new Map(this.base.tiles);
    for (const [k, d] of this.tiles) {
      const t = finishTile(new Uint8ClampedArray(d), 4, 0);
      if (t) out.set(k, t);
      else out.delete(k);
    }
    return new TiledSurface(4, out, 0);
  }
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
  /** Gradient paint (resolved): the colour varies along the impasto. */
  paint?: PaintGradientSource | null;
  /** Effect paint: each pixel's colour is the effect's there (its alpha scales the coverage); the relief is unchanged. */
  effect?: EffectPaintPixels | null;
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
  private readonly film: FilmBuffer | null;
  private readonly paint: RgbTriple = [0, 0, 0];
  private readonly centre: RgbTriple = [0, 0, 0];
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
    this.film = b.iridescence ? new FilmBuffer(init.channels.film, init.target.offset) : null;
    // Across the tip makes no sense for a loaded impasto tip: the colour follows the dab instead.
    this.sampler = init.paint ? new PaintGradientSampler(init.paint.map.by === 'across-tip' ? { ...init.paint, map: { by: 'distance', length: 300, repeat: 'mirror' } } : init.paint, init.seed) : null;
  }

  private readonly copies: readonly StrokeCopy[];
  private readonly sampler: PaintGradientSampler | null;
  private readonly sample: PaintGradientSample = { rgb: [0, 0, 0], alpha: 1 };

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
    return {
      height: new TiledSurface(1, h, 0),
      material: new TiledSurface(4, m, 0),
      film: this.film ? this.film.surface() : this.init.channels.film,
    };
  }

  private heightTile(tx: number, ty: number, write: boolean): Uint8ClampedArray | null {
    const key = tileKeyIn(tx, ty);
    if (key < 0) return write ? outsideTile(1) : null;
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
    const key = tileKeyIn(tx, ty);
    if (key < 0) return outsideTile(4);
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
    // Across-the-stroke coordinate for bristle ridges and the roller's stipple.
    const nxs = Math.sin(d.direction);
    const nys = Math.cos(d.direction);
    const r = Math.max(0.5, d.radius);

    if (im.tool === 'knife') {
      // Scrape: the relief flattens towards its low points and is dragged along; the paint smears.
      st.smudge!.dab(this.medium, { x: d.x, y: d.y, radius: d.radius, opacity: k }, rect, tip);
      this.knifeHeight(st, d, rect, tip, k, im.drag);
      this.paintMaterial(rect, tip, k * 0.6, im.gloss, im.metallic, im.rim, im.clarity);
      if (this.film && b.iridescence) this.film.deposit(rect, tip, k * 0.6, b.iridescence, d.pressure);
      return;
    }
    const thick = im.thickness * (1 - 0.8 * im.thinner);
    // The paint runs out along the stroke (a knife carries none, so it never runs out).
    st.amount *= 1 - 0.06 * (1 - im.load);
    // Colour: the exchange mixes the brush paint with the wet paint it picks up (like oil).
    const ex = st.exchange;
    let flow = 1;
    const effect = this.init.effect;
    if (effect) {
      sampleEffectAt(effect, d.x, d.y, this.centre, d);
      ex.setReservoirColor(this.centre[0], this.centre[1], this.centre[2]);
    } else if (this.sampler) {
      const g = this.sampler.dab(d, this.sample);
      ex.setReservoirColor(g.rgb[0], g.rgb[1], g.rgb[2]);
      flow = g.alpha;
    }
    ex.pickUp(this.medium.sample(rect, tip));
    const total = ex.paint(this.paint);
    ex.drain();
    const dep = Math.min(1, total) * k * (1 - 0.5 * im.thinner) * flow;
    if (dep > 0) {
      const cov = new Float32Array(n);
      for (let p = 0; p < n; p++) cov[p] = tip[p] > 0 ? Math.min(1, tip[p] * (im.tool === 'roller' || im.tool === 'gloop' || im.tool === 'tube' ? 1.6 : 1.1)) : 0;
      let field: Float32Array | null = null;
      if (effect) {
        field = new Float32Array(n * 3);
        effectDabField(effect, rect, cov, this.centre, this.paint, field, 0, d);
      }
      this.medium.deposit(rect, cov, dep, this.paint, ex.paintPigment, field);
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
    this.paintMaterial(rect, tip, k, im.gloss * (1 - 0.3 * im.thinner), im.metallic, im.rim, im.clarity);
    if (this.film && b.iridescence) this.film.deposit(rect, tip, k, b.iridescence, d.pressure);
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

  /**
   * Material: R gloss, G metallic, B rim (light paint, 0..255), A opacity for light paint's clarity
   * (255 solid .. 1 clearest; 0 is no material, read as solid).
   */
  private paintMaterial(rect: RasterRect, tip: Float32Array, k: number, gloss: number, metal: number, rim = 0, clarity = 0): void {
    const opacity = 255 - clarity * 254;
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
        t[i + 2] = Math.round(t[i + 2] + (rim * 255 - t[i + 2]) * c);
        const a = t[i + 3] || 255;
        t[i + 3] = Math.max(1, Math.round(a + (opacity - a) * c));
      }
    }
  }
}

function unionRects(a: RasterRect | null, b: RasterRect | null): RasterRect | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, yOf(b));
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
const yOf = (r: RasterRect) => r.y;

/** Height statistics of a layer's relief (for tools). */
export function reliefInfo(ch: ThickChannels): { bounds: RasterRect | null; maxHeight: number; tiles: number } {
  let max = 0;
  for (const t of ch.height.tiles.values()) {
    if (t.uniform !== null) max = Math.max(max, t.uniform & 255);
    else for (let i = 0; i < t.data.length; i++) if (t.data[i] > max) max = t.data[i];
  }
  const bounds = unionRects(ch.height.bounds, ch.film.bounds);
  return { bounds, maxHeight: max, tiles: ch.height.tiles.size || ch.film.tiles.size };
}

/** A layer's thick-paint channels as saved: PNG data URLs over a rectangle (layer space). */
export interface SavedThickChannels {
  rect: RasterRect;
  /** Greyscale PNG of the height. */
  height: string;
  /** RGBA PNG of the material (R gloss, G metallic). */
  material: string;
  /** RGBA PNG of the thin-film iridescence (R thickness, G refractive index, A coverage), when any. */
  film?: string;
}

/** Channels → saved form (`null` when there is neither relief nor film). */
export function thickToJSON(ch: ThickChannels): SavedThickChannels | null {
  const b = unionRects(ch.height.bounds, ch.film.bounds);
  if (!b) return null;
  const out: SavedThickChannels = {
    rect: { ...b },
    height: pngDataUrl(b.width, b.height, readRegion(ch.height, b), 1),
    material: pngDataUrl(b.width, b.height, readRegion(ch.material, b), 4),
  };
  if (ch.film.bounds) out.film = pngDataUrl(b.width, b.height, readRegion(ch.film, b), 4);
  return out;
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
  const film =
    typeof r.film === 'string'
      ? (() => {
          const f = decode(r.film, false);
          return surfaceFromSavedPixels({ width: f.width, height: f.height, data: f.data }, 4, r.rect.x, r.rect.y);
        })()
      : new TiledSurface(4, new Map(), 0);
  return {
    height: surfaceFromSavedPixels({ width: h.width, height: h.height, data: hd }, 1, r.rect.x, r.rect.y),
    material: surfaceFromSavedPixels({ width: m.width, height: m.height, data: m.data }, 4, r.rect.x, r.rect.y),
    film,
  };
}
