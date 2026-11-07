/**
 * Ferrofluid paint: a per-layer liquid ferrofluid channel (`doc.ferro`, one byte 0..255 per pixel
 * in layer space, like `doc.light`) and document-space magnets (`doc.magnets`).
 *
 * Where the analytical dipole magnetic field `|B|` exceeds the critical threshold `Bc` and
 * `ferro > 0`, the liquid rises into a hexagonal Rosensweig spike relief field whose spacing
 * follows the capillary wavelength, whose amplitude scales as `sqrt(1 - Bc / |B|) * ferro`, and
 * whose peaks tilt along `B`. Adding or moving a magnet runs deterministic advection steps on
 * `doc.ferro` so the liquid gathers toward the magnets.
 *
 * At render time, the spike height combines with `doc.thick` height and defaults to a dark,
 * glossy metallic material where `ferro > 0`, so `lightTile` shades the spikes with the canvas
 * lighting. `cure_ferrofluid` bakes the current spikes into `doc.thick` and clears `doc.ferro`.
 */

import { TILE, TiledSurface, finishTile, readRegion, surfaceFromPixels, type RasterRect, type Tile, type TileKey } from '../raster/surface';
import { decodePng, parseDataUrl, pngDataUrl } from '../raster/png';
import { DEFAULT_FERRO, normalizeFerro as normalizeFerroSettings, normalizePaintBrush, type FerroSettings, type PaintBrush } from './brushes';
import { emptyThickChannels, type ThickChannels } from './thick';

export { DEFAULT_FERRO, normalizeFerroSettings, type FerroSettings };

/** A dipole magnet on the canvas (document pixel coordinates). */
export interface PaintMagnet {
  id: string;
  x: number;
  y: number;
  /** Dipole strength and polarity (-1 .. 1). */
  strength: number;
  /** Characteristic dipole falloff radius in canvas pixels (8 .. 2000). */
  radius: number;
}

export const DEFAULT_MAGNET_STRENGTH = 0.75;
export const DEFAULT_MAGNET_RADIUS = 72;

/** Dark carrier fluid sRGB colour (`#111827`) for advected ferrofluid outside existing pigment. */
export const FERRO_CARRIER_RGB: readonly [number, number, number] = [17, 24, 39];
/** Default glossy metallic material for ferrofluid (`gloss ≈ 0.88`, `metallic ≈ 0.65`, `rim ≈ 0.25`). */
export const FERRO_DEFAULT_GLOSS = 224;
export const FERRO_DEFAULT_METALLIC = 166;
export const FERRO_DEFAULT_RIM = 64;

const SQRT3_HALF = 0.8660254037844386;

/** Validates and normalizes a magnet; throws a descriptive Error when a field is out of range. */
export function normalizeMagnet(
  raw: Partial<PaintMagnet> & { id: string; x: number; y: number },
  base?: PaintMagnet
): PaintMagnet {
  const x = raw.x ?? base?.x;
  const y = raw.y ?? base?.y;
  const strength = raw.strength ?? base?.strength ?? DEFAULT_MAGNET_STRENGTH;
  const radius = raw.radius ?? base?.radius ?? DEFAULT_MAGNET_RADIUS;
  if (typeof x !== 'number' || !Number.isFinite(x)) {
    throw new Error(`x ${String(x)} is not a finite coordinate; pass a number in canvas pixels.`);
  }
  if (typeof y !== 'number' || !Number.isFinite(y)) {
    throw new Error(`y ${String(y)} is not a finite coordinate; pass a number in canvas pixels.`);
  }
  if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < -1 || strength > 1) {
    throw new Error(`strength ${String(strength)} is out of range; use -1..1.`);
  }
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 8 || radius > 2000) {
    throw new Error(`radius ${String(radius)} is out of range; use 8..2000 px.`);
  }
  return { id: raw.id, x, y, strength, radius };
}

export function emptyFerro(): TiledSurface {
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

/** The ferrofluid channel as grey paint for a stroke's twin: white, with alpha = ferro. */
export function ferroToShadow(ferro: TiledSurface): TiledSurface {
  const tiles = new Map<TileKey, Tile>();
  for (const [key, tile] of ferro.tiles) {
    const f = full(tile, 1);
    const d = new Uint8ClampedArray(TILE * TILE * 4);
    for (let i = 0, j = 0; i < f.length; i++, j += 4) {
      if (!f[i]) continue;
      d[j] = d[j + 1] = d[j + 2] = 255;
      d[j + 3] = f[i];
    }
    const t = finishTile(d, 4, 0);
    if (t) tiles.set(key, t);
  }
  return new TiledSurface(4, tiles, 0);
}

/** A twin's grey paint back as ferrofluid: grey × alpha. */
export function shadowToFerro(shadow: TiledSurface): TiledSurface {
  const tiles = new Map<TileKey, Tile>();
  for (const [key, tile] of shadow.tiles) {
    const s = full(tile, 4);
    const d = new Uint8ClampedArray(TILE * TILE);
    for (let i = 0, j = 0; i < d.length; i++, j += 4) {
      if (s[j + 3]) d[i] = Math.round((((s[j] + s[j + 1] + s[j + 2]) / 3) * s[j + 3]) / 255);
    }
    const t = finishTile(d, 1, 0);
    if (t) tiles.set(key, t);
  }
  return new TiledSurface(1, tiles, 0);
}

/** The brush a stroke's ferrofluid twin paints with: same geometry, normal blend, RGB mixing. */
export function ferroTwinBrush(brush: PaintBrush): PaintBrush {
  return normalizePaintBrush(
    {
      tip: { ...brush.tip, blend: 'normal' },
      behavior: { ...brush.behavior, mixing: 'rgb' },
      paint: null,
      ...(brush.engine === 'mixer' ? { mixer: { ...brush.mixer, mixing: 'rgb' } } : {}),
      ...(brush.engine === 'blender' ? { blender: { ...brush.blender, mixing: 'rgb' } } : {}),
      ...(brush.engine === 'smudge' ? { smudge: { ...brush.smudge, mixing: 'rgb' } } : {}),
    },
    brush
  );
}

/** Ferrofluid scaled by `k` (0..1), e.g. under a fill that covers it. */
export function scaleFerro(ferro: TiledSurface, k: number): TiledSurface {
  if (k >= 1) return ferro;
  const tiles = new Map<TileKey, Tile>();
  if (k > 0) {
    for (const [key, tile] of ferro.tiles) {
      const d = Uint8ClampedArray.from(full(tile, 1), (v) => Math.round(v * k));
      const t = finishTile(d, 1, 0);
      if (t) tiles.set(key, t);
    }
  }
  return new TiledSurface(1, tiles, 0);
}

/** Ferrofluid of an upper layer merged down onto the one below (both in lower layer's space). */
export function mergeFerro(
  lower: TiledSurface | undefined,
  upper: TiledSurface | undefined,
  upperColor: TiledSurface
): TiledSurface | undefined {
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
      const uf = u ? u[i] : 0;
      const ca = c ? c[i * 4 + 3] : 0;
      const a = Math.max(ca, uf) / 255;
      d[i] = Math.min(255, Math.round(uf + (l ? l[i] : 0) * (1 - a)));
    }
    const t = finishTile(d, 1, 0);
    if (t) tiles.set(key, t);
  }
  return new TiledSurface(1, tiles, 0);
}

export interface FerroFieldSample {
  bx: number;
  by: number;
  bz: number;
  magnitude: number;
}

/**
 * Analytical 3D magnetic dipole field `B = (bx, by, bz)` at canvas point `(x, y)` from a set of
 * dipole magnets placed on the canvas plane (`z = -radius`).
 */
export function ferroFieldAt(x: number, y: number, magnets: readonly PaintMagnet[]): FerroFieldSample {
  let bx = 0;
  let by = 0;
  let bz = 0;
  for (let i = 0; i < magnets.length; i++) {
    const m = magnets[i];
    if (m.strength === 0) continue;
    const invR = 1 / Math.max(8, m.radius);
    const u = (x - m.x) * invR;
    const v = (y - m.y) * invR;
    const r2 = u * u + v * v;
    const s = 1 + r2;
    const d = 1 / (s * s * Math.sqrt(s));
    bx += m.strength * 1.5 * u * d;
    by += m.strength * 1.5 * v * d;
    bz += m.strength * (1 - 0.5 * r2) * d;
  }
  const magnitude = Math.hypot(bx, by, bz);
  return { bx, by, bz, magnitude };
}

function hexWave(px: number, py: number, k: number): number {
  const c0 = Math.cos(k * px);
  const c1 = Math.cos(k * (-0.5 * px + SQRT3_HALF * py));
  const c2 = Math.cos(k * (-0.5 * px - SQRT3_HALF * py));
  return (c0 + c1 + c2 + 1.5) / 4.5;
}

/**
 * Hexagonal Rosensweig instability spike height (0..255) at canvas coordinate `(x, y)` for a pixel
 * with liquid ferrofluid byte `ferroByte` (0..255).
 *
 * Where `|B| > threshold` and `ferroByte > 0`, spikes rise with amplitude `∝ sqrt(1 - Bc / |B|) * ferro`
 * at the capillary `wavelength` and tilt along the tangential field `(bx, by)`.
 */
export function ferroSpikeHeightAt(
  x: number,
  y: number,
  ferroByte: number,
  magnets: readonly PaintMagnet[],
  settings: FerroSettings = DEFAULT_FERRO
): number {
  if (ferroByte <= 0 || magnets.length === 0) return 0;
  const field = ferroFieldAt(x, y, magnets);
  const bc = Math.max(0.01, settings.threshold);
  if (field.magnitude <= bc) return 0;
  const amp = Math.sqrt(1 - bc / field.magnitude) * (ferroByte / 255);
  const wl = Math.max(4, settings.wavelength);
  const k = (2 * Math.PI) / wl;
  const w0 = hexWave(x, y, k);
  const sz = field.bz < 0 ? -1 : 1;
  const tx = (sz * field.bx) / field.magnitude;
  const ty = (sz * field.by) / field.magnitude;
  const shift = 0.32 * wl * amp * w0;
  const w = Math.max(0, hexWave(x - tx * shift, y - ty * shift, k));
  const profile = 0.15 + 0.85 * w * Math.sqrt(w);
  return Math.min(255, Math.max(1, Math.round(255 * amp * profile)));
}

/**
 * Runs deterministic mass-gathering advection steps on a layer's `ferro` surface toward `magnets`.
 * Each step transports liquid ferrofluid along the dipole attraction field via bilinear splatting.
 */
export function advectFerro(
  ferro: TiledSurface,
  magnets: readonly PaintMagnet[],
  offset: { x: number; y: number } = { x: 0, y: 0 },
  steps = 4
): TiledSurface {
  if (!ferro.tiles.size || !magnets.length || steps <= 0) return ferro;
  const b = ferro.bounds;
  if (!b) return ferro;
  let active = false;
  for (let i = 0; i < magnets.length; i++) {
    if (magnets[i].strength !== 0) {
      active = true;
      break;
    }
  }
  if (!active) return ferro;

  const pad = Math.min(32, Math.max(8, steps * 4));
  const rect: RasterRect = {
    x: b.x - pad,
    y: b.y - pad,
    width: b.width + 2 * pad,
    height: b.height + 2 * pad,
  };
  const w = rect.width;
  const h = rect.height;
  const raw = readRegion(ferro, rect);
  let cur = new Float64Array(w * h);
  for (let i = 0; i < raw.length; i++) cur[i] = raw[i];

  const vx = new Float64Array(w * h);
  const vy = new Float64Array(w * h);
  for (let gy = 0; gy < h; gy++) {
    const docY = rect.y + gy + offset.y + 0.5;
    for (let gx = 0; gx < w; gx++) {
      const docX = rect.x + gx + offset.x + 0.5;
      let fx = 0;
      let fy = 0;
      for (let mIdx = 0; mIdx < magnets.length; mIdx++) {
        const m = magnets[mIdx];
        if (m.strength === 0) continue;
        const dx = m.x - docX;
        const dy = m.y - docY;
        const r = Math.hypot(dx, dy);
        if (r <= 1e-6) continue;
        const R = Math.max(8, m.radius);
        const u = r / R;
        const s = 1 + u * u;
        const damp = Math.min(1, r * 0.5);
        const pull = (Math.abs(m.strength) * damp * 1.5) / (s * Math.sqrt(s));
        fx += (dx / r) * pull;
        fy += (dy / r) * pull;
      }
      const mag = Math.hypot(fx, fy);
      if (mag > 2.5) {
        const scale = 2.5 / mag;
        fx *= scale;
        fy *= scale;
      }
      const idx = gy * w + gx;
      vx[idx] = fx;
      vy[idx] = fy;
    }
  }

  for (let step = 0; step < steps; step++) {
    const next = new Float64Array(w * h);
    for (let gy = 0; gy < h; gy++) {
      for (let gx = 0; gx < w; gx++) {
        const idx = gy * w + gx;
        const val = cur[idx];
        if (val <= 0) continue;
        const nx = Math.min(w - 1, Math.max(0, gx + vx[idx]));
        const ny = Math.min(h - 1, Math.max(0, gy + vy[idx]));
        const x0 = Math.floor(nx);
        const y0 = Math.floor(ny);
        const x1 = Math.min(w - 1, x0 + 1);
        const y1 = Math.min(h - 1, y0 + 1);
        const tx = nx - x0;
        const ty = ny - y0;
        next[y0 * w + x0] += val * (1 - tx) * (1 - ty);
        next[y0 * w + x1] += val * tx * (1 - ty);
        next[y1 * w + x0] += val * (1 - tx) * ty;
        next[y1 * w + x1] += val * tx * ty;
      }
    }
    for (let i = 0; i < next.length; i++) {
      cur[i] = Math.min(255, next[i]);
    }
  }

  const out = new Uint8ClampedArray(w * h);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.min(255, Math.max(0, Math.round(cur[i])));
  }
  return surfaceFromPixels({ width: w, height: h, data: out }, 1, rect.x, rect.y);
}

export interface FerroStats {
  bounds: RasterRect | null;
  peak: number;
  liquidPixels: number;
  maxSpikeHeight: number;
  spikePixels: number;
  magnetCount: number;
}

/**
 * Inspects a layer's liquid ferrofluid channel and active Rosensweig spike relief under `magnets`.
 */
export function ferroInfo(
  ferro: TiledSurface | undefined,
  magnets: readonly PaintMagnet[] = [],
  settings: FerroSettings = DEFAULT_FERRO,
  offset: { x: number; y: number } = { x: 0, y: 0 }
): FerroStats {
  if (!ferro || !ferro.tiles.size) {
    return {
      bounds: null,
      peak: 0,
      liquidPixels: 0,
      maxSpikeHeight: 0,
      spikePixels: 0,
      magnetCount: magnets.length,
    };
  }
  let peak = 0;
  let liquidPixels = 0;
  let maxSpikeHeight = 0;
  let spikePixels = 0;
  for (const [key, tile] of ferro.tiles) {
    const tx = (key % 65536) - 32768;
    const ty = Math.floor(key / 65536) - 32768;
    const d = full(tile, 1);
    for (let y = 0, i = 0; y < TILE; y++) {
      const docY = ty * TILE + y + offset.y + 0.5;
      for (let x = 0; x < TILE; x++, i++) {
        const fb = d[i];
        if (!fb) continue;
        liquidPixels++;
        if (fb > peak) peak = fb;
        if (magnets.length > 0) {
          const docX = tx * TILE + x + offset.x + 0.5;
          const hs = ferroSpikeHeightAt(docX, docY, fb, magnets, settings);
          if (hs > 0) {
            spikePixels++;
            if (hs > maxSpikeHeight) maxSpikeHeight = hs;
          }
        }
      }
    }
  }
  return {
    bounds: peak ? ferro.bounds : null,
    peak,
    liquidPixels,
    maxSpikeHeight,
    spikePixels,
    magnetCount: magnets.length,
  };
}

export interface FerroLayerInput {
  surface: TiledSurface;
  magnets: readonly PaintMagnet[];
  settings: FerroSettings;
  offset: { x: number; y: number };
}

export function ferroCacheKey(ferro: FerroLayerInput | null | undefined): string {
  if (!ferro || !ferro.surface.tiles.size) return '';
  const mKey = ferro.magnets
    .map((m) => `${m.id}:${m.x.toFixed(2)},${m.y.toFixed(2)},${m.strength.toFixed(3)},${m.radius.toFixed(1)}`)
    .join(';');
  const s = ferro.settings;
  return `${ferro.offset.x},${ferro.offset.y}|${s.wavelength.toFixed(2)},${s.threshold.toFixed(3)}|${mKey}`;
}

/**
 * Bakes a layer's liquid ferrofluid and active Rosensweig spikes into permanent `ThickChannels`
 * (and ensures carrier colour covers advected ferrofluid pixels) for `cure_ferrofluid`.
 */
export function bakeFerroIntoThick(
  color: TiledSurface,
  ferro: TiledSurface,
  thick: ThickChannels | undefined,
  magnets: readonly PaintMagnet[],
  settings: FerroSettings = DEFAULT_FERRO,
  offset: { x: number; y: number } = { x: 0, y: 0 }
): { color: TiledSurface; thick: ThickChannels; maxSpikeHeight: number; spikePixels: number; curedPixels: number } {
  const baseThick = thick ?? emptyThickChannels();
  if (!ferro.tiles.size) {
    return { color, thick: baseThick, maxSpikeHeight: 0, spikePixels: 0, curedPixels: 0 };
  }
  const colorTiles = new Map(color.tiles);
  const heightTiles = new Map(baseThick.height.tiles);
  const materialTiles = new Map(baseThick.material.tiles);
  let maxSpikeHeight = 0;
  let spikePixels = 0;
  let curedPixels = 0;

  for (const [key, fTile] of ferro.tiles) {
    const tx = (key % 65536) - 32768;
    const ty = Math.floor(key / 65536) - 32768;
    const fd = full(fTile, 1);
    const cTile = colorTiles.get(key);
    const hTile = heightTiles.get(key);
    const mTile = materialTiles.get(key);
    const cd = cTile ? new Uint8ClampedArray(full(cTile, 4)) : new Uint8ClampedArray(TILE * TILE * 4);
    const hd = hTile ? new Uint8ClampedArray(full(hTile, 1)) : new Uint8ClampedArray(TILE * TILE);
    const md = mTile ? new Uint8ClampedArray(full(mTile, 4)) : new Uint8ClampedArray(TILE * TILE * 4);

    let changedColor = false;
    let changedHeight = false;
    let changedMaterial = false;

    for (let y = 0, p = 0; y < TILE; y++) {
      const docY = ty * TILE + y + offset.y + 0.5;
      for (let x = 0; x < TILE; x++, p++) {
        const fb = fd[p];
        if (!fb) continue;
        curedPixels++;
        const i = p * 4;
        if (cd[i + 3] < fb) {
          const a0 = cd[i + 3] / fb;
          cd[i] = Math.round(cd[i] * a0 + FERRO_CARRIER_RGB[0] * (1 - a0));
          cd[i + 1] = Math.round(cd[i + 1] * a0 + FERRO_CARRIER_RGB[1] * (1 - a0));
          cd[i + 2] = Math.round(cd[i + 2] * a0 + FERRO_CARRIER_RGB[2] * (1 - a0));
          cd[i + 3] = fb;
          changedColor = true;
        }
        const docX = tx * TILE + x + offset.x + 0.5;
        const hs = magnets.length > 0 ? ferroSpikeHeightAt(docX, docY, fb, magnets, settings) : 0;
        if (hs > 0) {
          spikePixels++;
          if (hs > maxSpikeHeight) maxSpikeHeight = hs;
        }
        // Even without magnets, cured ferrofluid leaves a thin glossy bead (min height from ferro).
        const bead = Math.max(hs, Math.round((fb * 28) / 255));
        const nh = Math.min(255, hd[p] + bead);
        if (nh !== hd[p]) {
          hd[p] = nh;
          changedHeight = true;
        }
        const w = fb / 255;
        const ng = Math.max(md[i], Math.round(FERRO_DEFAULT_GLOSS * w));
        const nm = Math.max(md[i + 1], Math.round(FERRO_DEFAULT_METALLIC * w));
        const nr = Math.max(md[i + 2], Math.round(FERRO_DEFAULT_RIM * w));
        const na = md[i + 3] || 255;
        if (ng !== md[i] || nm !== md[i + 1] || nr !== md[i + 2] || na !== md[i + 3]) {
          md[i] = ng;
          md[i + 1] = nm;
          md[i + 2] = nr;
          md[i + 3] = na;
          changedMaterial = true;
        }
      }
    }

    if (changedColor) {
      const ct = finishTile(cd, 4, 0);
      if (ct) colorTiles.set(key, ct);
    }
    if (changedHeight) {
      const ht = finishTile(hd, 1, 0);
      if (ht) heightTiles.set(key, ht);
    }
    if (changedMaterial) {
      const mt = finishTile(md, 4, 0);
      if (mt) materialTiles.set(key, mt);
    }
  }

  return {
    color: new TiledSurface(4, colorTiles, color.defaultValue),
    thick: {
      height: new TiledSurface(1, heightTiles, 0),
      material: new TiledSurface(4, materialTiles, 0),
      film: baseThick.film,
    },
    maxSpikeHeight,
    spikePixels,
    curedPixels,
  };
}

/** A layer's liquid ferrofluid as saved: its rect (layer space), grey PNG, and spike settings. */
export interface SavedFerro {
  rect: RasterRect;
  ferro: string;
  wavelength?: number;
  threshold?: number;
}

export function ferroToJSON(ferro: TiledSurface, settings?: FerroSettings): SavedFerro | null {
  const b = ferroInfo(ferro).bounds;
  if (!b) return null;
  const out: SavedFerro = {
    rect: { ...b },
    ferro: pngDataUrl(b.width, b.height, readRegion(ferro, b), 1),
  };
  if (settings) {
    if (settings.wavelength !== DEFAULT_FERRO.wavelength) out.wavelength = settings.wavelength;
    if (settings.threshold !== DEFAULT_FERRO.threshold) out.threshold = settings.threshold;
  }
  return out;
}

/** Saved form → ferrofluid surface and settings; throws a sentence when it cannot be read. */
export function ferroFromJSON(raw: unknown): { surface: TiledSurface; settings: FerroSettings } {
  const r = raw as Partial<SavedFerro>;
  if (!r || typeof r !== 'object' || !r.rect || typeof r.ferro !== 'string') {
    throw new Error('not a saved ferrofluid channel');
  }
  const parsed = parseDataUrl(r.ferro);
  if (!parsed) throw new Error('the ferrofluid channel is not a PNG data URL');
  const img = decodePng(parsed.bytes, { keepGray: true });
  const data =
    img.channels === 1
      ? img.data
      : Uint8ClampedArray.from({ length: img.width * img.height }, (_, i) => img.data[i * 4]);
  const surface = surfaceFromPixels({ width: img.width, height: img.height, data }, 1, r.rect.x, r.rect.y);
  const settings = normalizeFerroSettings({
    amount: 0,
    wavelength: r.wavelength,
    threshold: r.threshold,
  });
  return { surface, settings };
}

/** Saved magnets array → validated `PaintMagnet[]`. */
export function magnetsFromJSON(raw: unknown): PaintMagnet[] {
  if (!Array.isArray(raw)) return [];
  const out: PaintMagnet[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Partial<PaintMagnet>;
    if (typeof m.id !== 'string' || !m.id || typeof m.x !== 'number' || typeof m.y !== 'number') continue;
    try {
      out.push(normalizeMagnet({ id: m.id, x: m.x, y: m.y, strength: m.strength, radius: m.radius }));
    } catch {
      // Ignore malformed magnet entries in external JSON.
    }
  }
  return out;
}
