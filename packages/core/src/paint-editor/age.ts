/**
 * Painting time machine: non-destructive ageing (lightfastness fading by hue, yellowed varnish
 * absorption, seeded Voronoi craquelure cracks that catch raking light, and low-frequency dust
 * grain) plus X-ray radiography (`render_xray` / `set_xray_view`) that composites every layer
 * (hidden ones included) by `opacity * (thickHeight + lightnessWeight)` so whites read bright
 * like lead white and pentimenti show through.
 */

import { flattenLayers } from '../raster/layers';
import {
  TILE,
  TiledSurface,
  finishTile,
  readPixel,
  readRegion,
  tileCoord,
  type RasterRect,
  type Tile,
  type TileKey,
} from '../raster/surface';
import type { PaintLayer, PaintPixelLayer } from './document';
import { hash2 } from './noise';
import type { ThickChannels } from './thick';

/** Document ageing preview settings (`0..500` years). */
export interface PaintAgeSettings {
  /** Simulated age in years (0..500, default 0). */
  years: number;
  /** Yellowing varnish absorption over the painting (0..1, default 0.5). */
  varnish: number;
  /** Seeded Voronoi / stress craquelure crack network (0..1, default 0.5). */
  cracks: number;
  /** Hue-dependent pigment lightfastness fading (0..1, default 0.5). */
  fading: number;
  /** Low-frequency gallery dust grain (0..1, default 0.3). */
  dust: number;
  /** Deterministic craquelure and dust seed (whole number >= 0, default 1). */
  seed: number;
}

export type PaintAgeInput = Partial<PaintAgeSettings>;

export const DEFAULT_AGE: Readonly<PaintAgeSettings> = {
  years: 0,
  varnish: 0.5,
  cracks: 0.5,
  fading: 0.5,
  dust: 0.3,
  seed: 1,
};

/** Whether ageing has a visible effect. */
export function isAgeActive(age: PaintAgeSettings | undefined): boolean {
  if (!age || !(age.years > 0)) return false;
  return age.varnish > 0 || age.cracks > 0 || age.fading > 0 || age.dust > 0;
}

/** Cache key for an `age` configuration. */
export function ageKey(age: PaintAgeSettings | undefined): string {
  if (!age || !isAgeActive(age)) return '';
  return `${age.years}|${age.varnish}|${age.cracks}|${age.fading}|${age.dust}|${age.seed}`;
}

/** Validates partial age settings, throwing via `makeError` when any field is out of range. */
export function validateAgeInput(
  input: PaintAgeInput,
  makeError: (message: string) => Error = (m) => new Error(m)
): void {
  if (input.years !== undefined && !(Number.isFinite(input.years) && input.years >= 0 && input.years <= 500)) {
    throw makeError(`years ${input.years} is out of range; use 0..500.`);
  }
  for (const k of ['varnish', 'cracks', 'fading', 'dust'] as const) {
    const v = input[k];
    if (v !== undefined && !(Number.isFinite(v) && v >= 0 && v <= 1)) {
      throw makeError(`${k} ${v} is out of range; use 0..1.`);
    }
  }
  if (
    input.seed !== undefined &&
    !(Number.isFinite(input.seed) && Math.floor(input.seed) === input.seed && input.seed >= 0 && input.seed <= 2147483647)
  ) {
    throw makeError(`seed ${input.seed} must be a whole number 0..2147483647.`);
  }
}

/** Normalizes age settings into valid ranges, filling missing fields from `base`. */
export function normalizeAge(
  input?: PaintAgeInput | null,
  base: PaintAgeSettings = DEFAULT_AGE
): PaintAgeSettings {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const clamp01 = (v: number) => Math.min(1, Math.max(0, Math.round(v * 1000) / 1000));
  const years = Math.min(500, Math.max(0, Math.round(num(input?.years, base.years) * 100) / 100));
  const seedRaw = Math.round(num(input?.seed, base.seed));
  const seed = Math.min(2147483647, Math.max(0, seedRaw));
  return {
    years,
    varnish: clamp01(num(input?.varnish, base.varnish)),
    cracks: clamp01(num(input?.cracks, base.cracks)),
    fading: clamp01(num(input?.fading, base.fading)),
    dust: clamp01(num(input?.dust, base.dust)),
    seed,
  };
}

/**
 * Deterministic lightfastness fugitive table by hue every 30° (`0..360°`).
 * Reds (`0°`, `330°` — alizarin / carmine lakes) and violets (`270°..300°` — mauve / Tyrian)
 * fade fastest; blues (`210°..240°` — cobalt / ultramarine) and greens (`120°..180°`) are most lightfast.
 */
export const HUE_LIGHTFASTNESS_FUGITIVE: readonly number[] = [
  1.0, // 0°   red (fastest fading)
  0.66, // 30°  orange-red
  0.5, // 60°  yellow
  0.38, // 90°  yellow-green
  0.24, // 120° green
  0.2, // 150° blue-green
  0.22, // 180° cyan
  0.16, // 210° cerulean / cobalt blue (most lightfast)
  0.2, // 240° ultramarine blue
  0.82, // 270° blue-violet
  0.98, // 300° violet / magenta (fastest fading)
  0.95, // 330° crimson-rose (fastest fading)
];

/** Hue in degrees `0..360` from sRGB `0..1` channels (`0` when achromatic). */
export function rgbHueDegrees(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d <= 1e-6) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** Fugitive fading susceptibility (`0.16..1.0`) at a hue angle in degrees (`0..360`), interpolated from `HUE_LIGHTFASTNESS_FUGITIVE`. */
export function fadeSusceptibilityAtHue(hueDegrees: number): number {
  const h = ((hueDegrees % 360) + 360) % 360;
  const pos = (h / 30) % 12;
  const i0 = Math.floor(pos) % 12;
  const i1 = (i0 + 1) % 12;
  const frac = pos - Math.floor(pos);
  return HUE_LIGHTFASTNESS_FUGITIVE[i0] * (1 - frac) + HUE_LIGHTFASTNESS_FUGITIVE[i1] * frac;
}

/** Fugitive fading rate (`0.16..1.0`) for an sRGB `0..1` colour, interpolated from `HUE_LIGHTFASTNESS_FUGITIVE`. */
export function hueFugitiveRate(r: number, g: number, b: number): number {
  return fadeSusceptibilityAtHue(rgbHueDegrees(r, g, b));
}

/** Smooth 2D value noise in `0..1` at continuous coordinates `(u, v)`. */
function valueNoise2D(u: number, v: number, seed: number): number {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
}

/** Voronoi cell-edge ridge distance (`d2 - d1`, in cell units) at `(u, v)`. */
function voronoiEdge(u: number, v: number, seed: number): number {
  const gx = Math.floor(u);
  const gy = Math.floor(v);
  let d1 = 1e9;
  let d2 = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = gx + dx;
      const cy = gy + dy;
      const px = cx + 0.15 + 0.7 * hash2(cx, cy, seed);
      const py = cy + 0.15 + 0.7 * hash2(cx, cy, seed + 1013);
      const dist = Math.hypot(u - px, v - py);
      if (dist < d1) {
        d2 = d1;
        d1 = dist;
      } else if (dist < d2) {
        d2 = dist;
      }
    }
  }
  return d2 - d1;
}

/**
 * Seeded Voronoi / stress craquelure intensity (`0..1`) at document pixel `(wx, wy)`.
 * Gets denser with `layerCount` (more paint layers) and `thickHeight` (`0..1` impasto height).
 */
export function craquelureAt(
  wx: number,
  wy: number,
  seed: number,
  layerCount: number,
  thickHeight: number
): number {
  const layers = Math.max(1, Math.min(8, layerCount));
  const h = Math.max(0, Math.min(1, thickHeight));
  const stress = Math.min(1, (layers - 1) * 0.22 + h * 0.75);
  // Cell size shrinks (denser network) as layerCount and thickHeight increase.
  const cellSize = Math.max(7, 22 - (layers - 1) * 2.2 - h * 6);
  const warpX = (valueNoise2D(wx / 24, wy / 24, seed + 307) - 0.5) * 0.35;
  const warpY = (valueNoise2D(wx / 24, wy / 24, seed + 613) - 0.5) * 0.35;
  const ePrimary = voronoiEdge(wx / cellSize + warpX, wy / cellSize + warpY, seed);
  const widthPrimary = 0.085 + 0.065 * stress;
  let crack = ePrimary < widthPrimary ? 1 - ePrimary / widthPrimary : 0;
  if (stress > 0.05) {
    const fineSize = cellSize * 0.48;
    const eFine = voronoiEdge(wx / fineSize - warpY, wy / fineSize + warpX, seed + 2029);
    const widthFine = (0.065 + 0.055 * stress) * stress;
    if (eFine < widthFine) {
      const fineCrack = (1 - eFine / widthFine) * (0.45 + 0.55 * stress);
      if (fineCrack > crack) crack = fineCrack;
    }
  }
  return crack > 0 ? Math.min(1, crack * crack * (1.2 - 0.2 * crack)) : 0;
}

/** Low-frequency gallery dust grain (`0..1`) at document pixel `(wx, wy)`. */
export function dustAt(wx: number, wy: number, seed: number): number {
  const coarse = valueNoise2D(wx / 18, wy / 18, seed + 4099);
  const medium = valueNoise2D(wx / 5, wy / 5, seed + 8191);
  const speck = hash2(Math.floor(wx), Math.floor(wy), seed + 12289);
  return Math.min(1, Math.max(0, 0.58 * coarse + 0.32 * medium + (speck > 0.92 ? (speck - 0.92) * 2.5 : 0)));
}

/**
 * Applies the four ageing effects (fading, yellowed varnish, crack darkening, and dust grain)
 * to a single sRGB `0..1` pixel at document coordinate `(wx, wy)`.
 */
export function agePixel(
  rIn: number,
  gIn: number,
  bIn: number,
  wx: number,
  wy: number,
  age: PaintAgeSettings,
  layerCount: number,
  thickHeight: number
): [number, number, number] {
  const timeFactor = Math.min(1.35, age.years / 300);
  if (timeFactor <= 0) return [rIn, gIn, bIn];
  let r = rIn;
  let g = gIn;
  let b = bIn;

  // 1. Hue-dependent lightfastness fading (reds and violets fade fastest).
  if (age.fading > 0) {
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const chroma = maxC - minC;
    const fugitive = hueFugitiveRate(r, g, b);
    const fadeAmt = Math.min(0.88, timeFactor * age.fading * fugitive * (0.35 + 0.65 * chroma));
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const bleachR = lum * 0.82 + 0.165;
    const bleachG = lum * 0.82 + 0.158;
    const bleachB = lum * 0.82 + 0.145;
    r += (bleachR - r) * fadeAmt;
    g += (bleachG - g) * fadeAmt;
    b += (bleachB - b) * fadeAmt;
  }

  // 2. Yellowing varnish absorption over the composite.
  if (age.varnish > 0) {
    const vAmt = Math.min(1, timeFactor * age.varnish);
    r = r * (1 - 0.07 * vAmt) + 0.045 * vAmt;
    g = g * (1 - 0.21 * vAmt) + 0.032 * vAmt;
    b = b * (1 - 0.52 * vAmt) + 0.008 * vAmt;
  }

  // 3. Craquelure crack darkening along the Voronoi / stress fissures.
  if (age.cracks > 0) {
    const crackRaw = craquelureAt(wx, wy, age.seed, layerCount, thickHeight);
    if (crackRaw > 0) {
      const cAmt = Math.min(0.85, crackRaw * Math.min(1, timeFactor * age.cracks));
      r = r * (1 - cAmt) + 0.12 * cAmt;
      g = g * (1 - cAmt) + 0.085 * cAmt;
      b = b * (1 - cAmt) + 0.055 * cAmt;
    }
  }

  // 4. Low-frequency gallery dust grain.
  if (age.dust > 0) {
    const dNoise = dustAt(wx, wy, age.seed);
    const dAmt = Math.min(0.65, timeFactor * age.dust * (0.32 + 0.68 * dNoise));
    r += (0.72 - r) * dAmt;
    g += (0.69 - g) * dAmt;
    b += (0.63 - b) * dAmt;
  }

  return [
    Math.min(1, Math.max(0, r)),
    Math.min(1, Math.max(0, g)),
    Math.min(1, Math.max(0, b)),
  ];
}

/**
 * Carves craquelure crack channels into a 256×256 height tile before `lightTile` runs,
 * so crack edges lower the height and catch raking light.
 */
export function carveAgeCrackHeightTile(
  colorData: Uint8Array | Uint8ClampedArray | null,
  baseHeightData: Uint8Array | Uint8ClampedArray | null,
  tx: number,
  ty: number,
  offset: { x: number; y: number },
  age: PaintAgeSettings,
  layerCount: number
): Uint8ClampedArray | null {
  if (!isAgeActive(age) || age.cracks <= 0) return baseHeightData ? new Uint8ClampedArray(baseHeightData) : null;
  if (!colorData && !baseHeightData) return null;
  const timeFactor = Math.min(1.35, age.years / 300);
  const strength = Math.min(1, timeFactor * age.cracks);
  if (strength <= 0) return baseHeightData ? new Uint8ClampedArray(baseHeightData) : null;
  const out = new Uint8ClampedArray(TILE * TILE);
  const ox = tx * TILE + offset.x;
  const oy = ty * TILE + offset.y;
  let any = false;
  let p = 0;
  for (let y = 0; y < TILE; y++) {
    const wy = oy + y;
    for (let x = 0; x < TILE; x++, p++) {
      const a = colorData ? colorData[p * 4 + 3] : 0;
      const h0 = baseHeightData ? baseHeightData[p] : 0;
      if (a === 0 && h0 === 0) continue;
      // Painted pixels have a base paint-film thickness so cracks catch light even without impasto.
      const filmH = Math.max(h0, Math.round((a * 56) / 255));
      const crack = craquelureAt(ox + x, wy, age.seed, layerCount, h0 / 255);
      const drop = crack > 0 ? Math.round(crack * strength * Math.min(filmH, 160)) : 0;
      const h1 = Math.max(0, filmH - drop);
      out[p] = h1;
      if (h1 !== 0) any = true;
    }
  }
  return any ? out : baseHeightData ? new Uint8ClampedArray(baseHeightData) : null;
}

/** Ages one 256×256 RGBA tile of a paint layer on its own (the editor ages the composite: `ageCompositeRegion`). */
export function ageTile(
  colorData: Uint8Array | Uint8ClampedArray,
  heightData: Uint8Array | Uint8ClampedArray | null,
  tx: number,
  ty: number,
  offset: { x: number; y: number },
  age: PaintAgeSettings,
  layerCount: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(colorData);
  if (!isAgeActive(age)) return out;
  const ox = tx * TILE + offset.x;
  const oy = ty * TILE + offset.y;
  let p = 0;
  for (let y = 0; y < TILE; y++) {
    const wy = oy + y;
    for (let x = 0; x < TILE; x++, p++) {
      const i = p * 4;
      const a = colorData[i + 3];
      if (a === 0) continue;
      const hNorm = heightData ? heightData[p] / 255 : 0;
      const [r, g, b] = agePixel(
        colorData[i] / 255,
        colorData[i + 1] / 255,
        colorData[i + 2] / 255,
        ox + x,
        wy,
        age,
        layerCount,
        hNorm
      );
      out[i] = Math.round(r * 255);
      out[i + 1] = Math.round(g * 255);
      out[i + 2] = Math.round(b * 255);
    }
  }
  return out;
}

/** Ages a paper tile over `(x0, y0, width, height)` (yellowed varnish, subtle paper cracks, and gallery dust). */
export function agePaperTile(
  tile: Uint8ClampedArray,
  x0: number,
  y0: number,
  width: number,
  height: number,
  age: PaintAgeSettings
): Uint8ClampedArray {
  if (!isAgeActive(age)) return tile;
  const out = new Uint8ClampedArray(tile);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const wy = y0 + y;
    for (let x = 0; x < width; x++, p++) {
      const i = p * 4;
      const [r, g, b] = agePixel(
        tile[i] / 255,
        tile[i + 1] / 255,
        tile[i + 2] / 255,
        x0 + x,
        wy,
        age,
        1,
        0
      );
      out[i] = Math.round(r * 255);
      out[i + 1] = Math.round(g * 255);
      out[i + 2] = Math.round(b * 255);
    }
  }
  return out;
}

/** A painted layer as the composite ageing pass reads it: its alpha marks paint, its thick height feeds the cracks. */
export interface AgeFieldLayer {
  /** The layer's RGBA pixels (only alpha is read). */
  surface: TiledSurface;
  /** The layer's thick paint height (one channel, `0..255`), when it has impasto. */
  height?: TiledSurface;
  /** Where the layer sits on the canvas. */
  offset: { x: number; y: number };
}

/**
 * The time machine's single ageing pass over the composite: ages straight-alpha RGBA `data`
 * (`rect.width × rect.height`, document pixels `rect`) in place, as varnish, fading and dust sit
 * over the finished painting. Where any `layers` pixel is painted the craquelure uses
 * `layerCount` and the tallest thick height there; bare ground (paper) ages as one layer with no
 * impasto. Transparent pixels are left alone.
 */
export function ageCompositeRegion(
  data: Uint8ClampedArray,
  rect: RasterRect,
  age: PaintAgeSettings,
  layers: readonly AgeFieldLayer[],
  layerCount: number
): void {
  if (!isAgeActive(age)) return;
  const n = rect.width * rect.height;
  const covered = new Uint8Array(n);
  const tallest = new Uint8Array(n);
  for (const l of layers) {
    const r = { x: rect.x - l.offset.x, y: rect.y - l.offset.y, width: rect.width, height: rect.height };
    const color = readRegion(l.surface, r);
    const height = l.height ? readRegion(l.height, r) : null;
    for (let p = 0; p < n; p++) {
      if (color[p * 4 + 3] === 0) continue;
      covered[p] = 1;
      if (height && height[p] > tallest[p]) tallest[p] = height[p];
    }
  }
  let p = 0;
  for (let y = 0; y < rect.height; y++) {
    const wy = rect.y + y;
    for (let x = 0; x < rect.width; x++, p++) {
      const i = p * 4;
      if (data[i + 3] === 0) continue;
      const paint = covered[p] === 1;
      const [r, g, b] = agePixel(
        data[i] / 255,
        data[i + 1] / 255,
        data[i + 2] / 255,
        rect.x + x,
        wy,
        age,
        paint ? layerCount : 1,
        paint ? tallest[p] / 255 : 0
      );
      data[i] = Math.round(r * 255);
      data[i + 1] = Math.round(g * 255);
      data[i + 2] = Math.round(b * 255);
    }
  }
}

/**
 * Per-layer cache of aged colour tiles.
 * @deprecated The editor ages the composite in one pass (`ageCompositeRegion`); ageing each layer
 * yellows Multiply / Overlay layers twice and brightens Add layers.
 */
export class AgeCache {
  private tiles = new Map<
    TileKey,
    { color: Tile; height: Tile | undefined; key: string; layerCount: number; offsetX: number; offsetY: number; tile: Tile }
  >();

  render(
    color: TiledSurface,
    height: TiledSurface | undefined,
    age: PaintAgeSettings,
    layerCount = 1,
    offset: { x: number; y: number } = { x: 0, y: 0 }
  ): TiledSurface {
    if (!isAgeActive(age) || color.tiles.size === 0) return color;
    const k = ageKey(age);
    const out = new Map(color.tiles);
    for (const [key, tile] of color.tiles) {
      const hTile = height?.tiles.get(key);
      const cached = this.tiles.get(key);
      if (
        cached &&
        cached.color === tile &&
        cached.height === hTile &&
        cached.key === k &&
        cached.layerCount === layerCount &&
        cached.offsetX === offset.x &&
        cached.offsetY === offset.y
      ) {
        out.set(key, cached.tile);
        continue;
      }
      const { tx, ty } = tileCoord(key);
      const data = ageTile(tile.data, hTile?.data ?? null, tx, ty, offset, age, layerCount);
      const agedTile: Tile = finishTile(data, 4, 0) ?? { data, uniform: null };
      this.tiles.set(key, {
        color: tile,
        height: hTile,
        key: k,
        layerCount,
        offsetX: offset.x,
        offsetY: offset.y,
        tile: agedTile,
      });
      out.set(key, agedTile);
    }
    for (const key of this.tiles.keys()) {
      if (!color.tiles.has(key)) this.tiles.delete(key);
    }
    return new TiledSurface(4, out, color.defaultValue);
  }
}

export interface XrayResult {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  strokes: number;
  totalStrokes: number;
  layerCount: number;
  hiddenLayerCount: number;
  maxDensity: number;
  meanDensity: number;
}

/**
 * Composites every pixel layer (hidden ones included) into an X-ray radiograph.
 * Each layer adds `density = opacity * (thickHeight + lightnessWeight)` so whites read bright
 * the way lead white does and buried layers (pentimento) show through.
 */
export function renderXrayPixels(
  width: number,
  height: number,
  layers: readonly PaintLayer[],
  thick: Readonly<Record<string, ThickChannels>> | undefined,
  strokes = 0,
  totalStrokes = 0
): XrayResult {
  const pixelLayers = flattenLayers(layers).filter((l): l is PaintPixelLayer => l.type === 'pixel');
  const hiddenLayerCount = pixelLayers.filter((l) => !l.visible).length;
  const out = new Uint8ClampedArray(width * height * 4);
  let maxDensity = 0;
  let sumDensity = 0;
  const totalPixels = width * height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let density = 0;
      for (const l of pixelLayers) {
        const op = Math.max(0, Math.min(1, l.opacity));
        if (op <= 0) continue;
        const lx = x - l.offset.x;
        const ly = y - l.offset.y;
        const rgba = readPixel(l.surface, lx, ly);
        const a = rgba[3] / 255;
        const hSurf = thick?.[l.id]?.height;
        const h = hSurf ? readPixel(hSurf, lx, ly)[0] / 255 : 0;
        if (a <= 0 && h <= 0) continue;
        const r = rgba[0] / 255;
        const g = rgba[1] / 255;
        const b = rgba[2] / 255;
        // Relative luminance / lightness weight: white paint reads bright like lead white.
        const lightnessWeight = 0.22 + 0.78 * (0.2126 * r + 0.7152 * g + 0.0722 * b);
        density += op * (h + a * lightnessWeight);
      }
      if (density > maxDensity) maxDensity = density;
      sumDensity += density;
      const d = 1 - Math.exp(-density * 1.25);
      const idx = (y * width + x) * 4;
      out[idx] = Math.round(10 + 235 * Math.pow(d, 1.12));
      out[idx + 1] = Math.round(14 + 236 * d);
      out[idx + 2] = Math.round(20 + 235 * Math.pow(d, 0.88));
      out[idx + 3] = 255;
    }
  }

  return {
    width,
    height,
    data: out,
    strokes,
    totalStrokes,
    layerCount: pixelLayers.length,
    hiddenLayerCount,
    maxDensity: Math.round(maxDensity * 1000) / 1000,
    meanDensity: totalPixels > 0 ? Math.round((sumDensity / totalPixels) * 1000) / 1000 : 0,
  };
}
