/**
 * Smart inks: UV-fluorescent ink (`doc.fluor[layerId]` + `uvLight`) and thermochromic ink
 * (`doc.thermo[layerId]` + `doc.heat`).
 *
 * - **Fluorescent ink**: a per-layer 4-channel RGBA surface (`[R, G, B, intensity]`) in layer
 *   space, painted alongside strokes when `brush.fluorescence.amount > 0`. With
 *   `brush.fluorescence.invisible: true`, no daylight pigment is laid onto the layer's normal
 *   surface, so the mark stays invisible under normal light. When the virtual UV blacklight
 *   (`uvLight.on`) is switched on, normal layers dim to `uvLight.ambient` and fluorescent pixels
 *   emit their colour and cast a Linear Dodge spill halo (reusing `computeSpill` from `./light`).
 * - **Thermochromic ink**: a per-layer 4-channel RGBA surface (`[hotR, hotG, hotB, thresholdByte]`)
 *   in layer space, painted when `brush.thermochromic.hotColor` is set. A document-level coarse
 *   heat field (`HEAT_SCALE = 4`, 1/4 canvas resolution) stores local temperature in `0..1`,
 *   painted by `paintHeatField` and stepped with 5-point Laplacian diffusion + Newtonian cooling
 *   by `advanceHeatField`. At render time, thermochromic pixels blend smoothly from their cold
 *   paint colour to `hotColor` around `threshold` based on bilinearly sampled temperature, and
 *   tiles heated past `HEAT_DRY_THRESHOLD` dry any wet paint on them.
 */

import { SRGB_TO_LINEAR, linearToSrgb8 } from '../paint/wet/film';
import { decodePng, parseDataUrl, pngDataUrl } from '../raster/png';
import { TILE, TiledSurface, finishTile, readRegion, surfaceFromPixels, tileKey, type RasterRect, type Tile, type TileKey } from '../raster/surface';
import { brushVortex, normalizePaintBrush, type PaintBrush } from './brushes';
import { computeSpill } from './light';
import { hexToRgb8, type PaperSettings } from './paper';

/** View / document UV blacklight setting. */
export interface UvLightSettings {
  /** Whether the UV blacklight is switched on (default false). */
  on: boolean;
  /** Emission and halo strength under UV, 0..2 (default 1). */
  strength: number;
  /** How much normal daylight colour remains visible when UV is on, 0 (pitch dark) .. 1 (default 0.15). */
  ambient: number;
}

export const DEFAULT_UV_LIGHT: Readonly<UvLightSettings> = { on: false, strength: 1, ambient: 0.15 };

export function normalizeUvLight(raw: Partial<UvLightSettings> = {}, base: UvLightSettings = DEFAULT_UV_LIGHT): UvLightSettings {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    on: typeof raw.on === 'boolean' ? raw.on : base.on,
    strength: Math.min(2, Math.max(0, num(raw.strength, base.strength))),
    ambient: Math.min(1, Math.max(0, num(raw.ambient, base.ambient))),
  };
}

export function uvLightKey(uv: UvLightSettings): string {
  return `${uv.on ? 1 : 0}|${uv.strength.toFixed(3)}|${uv.ambient.toFixed(3)}`;
}

const uvPapers = new WeakMap<PaperSettings, { ambient: number; paper: PaperSettings }>();

/** The paper dimmed to `uv.ambient` while the UV blacklight is on (cached by paper reference). */
export function uvPaper(paper: PaperSettings, uv: UvLightSettings): PaperSettings {
  if (!uv.on || uv.ambient >= 1) return paper;
  const cached = uvPapers.get(paper);
  if (cached && cached.ambient === uv.ambient) return cached.paper;
  const [r, g, b] = hexToRgb8(paper.color);
  const toHex = (v: number) => Math.round(Math.min(255, Math.max(0, v * uv.ambient))).toString(16).padStart(2, '0');
  const next: PaperSettings = { ...paper, color: `#${toHex(r)}${toHex(g)}${toHex(b)}` };
  uvPapers.set(paper, { ambient: uv.ambient, paper: next });
  return next;
}

export function emptyFluor(): TiledSurface {
  return new TiledSurface(4, new Map(), 0);
}

export function emptyThermo(): TiledSurface {
  return new TiledSurface(4, new Map(), 0);
}

function expand4(t: Tile): Uint8ClampedArray {
  if (t.data.length === TILE * TILE * 4) return t.data;
  const out = new Uint8ClampedArray(TILE * TILE * 4);
  const u = t.uniform ?? 0;
  const bytes = [(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255];
  for (let i = 0; i < out.length; i += 4) out.set(bytes, i);
  return out;
}

/**
 * Twin brush that writes or moves the per-layer 4-channel fluorescence surface (`doc.fluor[id]`).
 * When `brush.fluorescence.amount > 0`, it lays the stroke's colour scaled by `fluorescence.amount`;
 * erasers, smudges and blenders act on the existing fluorescence; plain opaque paint dims it.
 */
export function fluorTwinBrush(brush: PaintBrush): PaintBrush {
  const f = brush.fluorescence.amount;
  const base: PaintBrush = { ...brush, light: { amount: 0, pressure: false }, fluorescence: { amount: 0, invisible: false }, thermochromic: { hotColor: null, threshold: 0.5 }, tip: { ...brush.tip, blend: 'normal' } };
  if (brush.engine === 'eraser' || brush.engine === 'smudge' || brush.engine === 'blender') return base;
  if (brush.engine === 'vortex') {
    const v = brushVortex(brush);
    return normalizePaintBrush(
      {
        ...base,
        tip: { ...base.tip, opacity: f > 0 ? brush.tip.opacity * f : brush.tip.opacity, blend: 'normal' },
        vortex: { ...v, ink: f > 0 ? v.ink : 0 },
      },
      base,
    );
  }
  const move = brush.engine === 'impasto' ? (brush.impasto.tool === 'knife' ? 'smudge' : 'dab') : brush.engine;
  if (f > 0) {
    return normalizePaintBrush(
      {
        ...base,
        engine: move,
        tip: { ...base.tip, opacity: brush.tip.opacity * f, blend: 'normal' },
      },
      base,
    );
  }
  if (brush.engine === 'mixer' || brush.behavior.pickup > 0 || (brush.engine === 'impasto' && brush.impasto.tool === 'knife')) {
    return normalizePaintBrush({ ...base, engine: move }, base);
  }
  return normalizePaintBrush(
    {
      ...base,
      engine: 'eraser',
      tip: { ...base.tip, opacity: brush.tip.opacity },
      paint: null,
    },
    base,
  );
}

/**
 * Twin brush that writes or moves the per-layer 4-channel thermochromic surface (`doc.thermo[id]`).
 */
export function thermoTwinBrush(brush: PaintBrush): PaintBrush {
  const active = brush.thermochromic.hotColor !== null;
  const base: PaintBrush = {
    ...brush,
    light: { amount: 0, pressure: false },
    fluorescence: { amount: 0, invisible: false },
    thermochromic: { hotColor: null, threshold: 0.5 },
    paint: null,
    tip: { ...brush.tip, blend: 'normal' },
  };
  if (brush.engine === 'eraser' || brush.engine === 'smudge' || brush.engine === 'blender') return base;
  if (brush.engine === 'vortex') {
    const v = brushVortex(brush);
    return normalizePaintBrush({ ...base, vortex: { ...v, ink: active ? v.ink : 0 } }, base);
  }
  const move = brush.engine === 'impasto' ? (brush.impasto.tool === 'knife' ? 'smudge' : 'dab') : brush.engine;
  if (active) {
    return normalizePaintBrush({ ...base, engine: move, behavior: { ...base.behavior, pickup: 0 } }, base);
  }
  if (brush.engine === 'mixer' || brush.behavior.pickup > 0 || (brush.engine === 'impasto' && brush.impasto.tool === 'knife')) {
    return normalizePaintBrush({ ...base, engine: move }, base);
  }
  return normalizePaintBrush({ ...base, engine: 'eraser', tip: { ...base.tip, opacity: brush.tip.opacity } }, base);
}

/**
 * Encodes `threshold` (`0.05..0.95`) into channel 3 (`1..255`) of a thermochromic surface after a
 * twin stroke painted `hotColor` with coverage in channel 3. Existing thermochromic pixels blend
 * smoothly with the new `hotColor` and `threshold` by the twin's coverage.
 */
export function finalizeThermoStroke(twinOut: TiledSurface, before: TiledSurface, hotRgb: readonly [number, number, number], threshold: number): TiledSurface {
  const thByte = Math.max(1, Math.min(255, Math.round(threshold * 255)));
  const out = new Map<TileKey, Tile>(before.tiles);
  const keys = new Set<TileKey>([...before.tiles.keys(), ...twinOut.tiles.keys()]);
  for (const key of keys) {
    const afterTile = twinOut.tiles.get(key);
    const beforeTile = before.tiles.get(key);
    if (afterTile === beforeTile) continue;
    if (!afterTile) {
      out.delete(key);
      continue;
    }
    const aData = expand4(afterTile);
    const bData = beforeTile ? expand4(beforeTile) : null;
    const dst = new Uint8ClampedArray(TILE * TILE * 4);
    for (let i = 0; i < dst.length; i += 4) {
      const cov = aData[i + 3] / 255;
      const prevTh = bData ? bData[i + 3] : 0;
      if (cov <= 0 && prevTh === 0) continue;
      if (prevTh === 0) {
        dst[i] = hotRgb[0];
        dst[i + 1] = hotRgb[1];
        dst[i + 2] = hotRgb[2];
        dst[i + 3] = thByte;
      } else if (cov <= 0) {
        dst[i] = bData![i];
        dst[i + 1] = bData![i + 1];
        dst[i + 2] = bData![i + 2];
        dst[i + 3] = prevTh;
      } else {
        dst[i] = Math.round(bData![i] * (1 - cov) + hotRgb[0] * cov);
        dst[i + 1] = Math.round(bData![i + 1] * (1 - cov) + hotRgb[1] * cov);
        dst[i + 2] = Math.round(bData![i + 2] * (1 - cov) + hotRgb[2] * cov);
        dst[i + 3] = Math.max(1, Math.round(prevTh * (1 - cov) + thByte * cov));
      }
    }
    const ft = finishTile(dst, 4, 0);
    if (ft) out.set(key, ft);
    else out.delete(key);
  }
  return new TiledSurface(4, out, 0);
}

/** Scales the alpha channel of a 4-channel RGBA surface (`fluor`) by `k` (0..1). */
export function scaleFluor(surface: TiledSurface, k: number): TiledSurface {
  if (k <= 0 || !surface.tiles.size) return emptyFluor();
  if (k >= 1) return new TiledSurface(4, new Map(surface.tiles), 0);
  const tiles = new Map<TileKey, Tile>();
  for (const [key, tile] of surface.tiles) {
    const src = expand4(tile);
    const dst = new Uint8ClampedArray(src);
    for (let i = 3; i < dst.length; i += 4) dst[i] = Math.round(dst[i] * k);
    const ft = finishTile(dst, 4, 0);
    if (ft) tiles.set(key, ft);
  }
  return new TiledSurface(4, tiles, 0);
}

/** Merges two 4-channel surfaces (`above` over `below`) when merging layers down. */
export function mergeFourChannel(below: TiledSurface | undefined, above: TiledSurface | undefined): TiledSurface | null {
  if (!below?.tiles.size && !above?.tiles.size) return null;
  if (!below?.tiles.size) return new TiledSurface(4, new Map(above!.tiles), 0);
  if (!above?.tiles.size) return new TiledSurface(4, new Map(below.tiles), 0);
  const keys = new Set<TileKey>([...below.tiles.keys(), ...above.tiles.keys()]);
  const tiles = new Map<TileKey, Tile>();
  for (const key of keys) {
    const b = below.tiles.get(key);
    const a = above.tiles.get(key);
    if (!a) {
      tiles.set(key, b!);
      continue;
    }
    if (!b) {
      tiles.set(key, a);
      continue;
    }
    const bd = expand4(b);
    const ad = expand4(a);
    const dst = new Uint8ClampedArray(TILE * TILE * 4);
    for (let i = 0; i < dst.length; i += 4) {
      const sa = ad[i + 3] / 255;
      const da = bd[i + 3] / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      for (let c = 0; c < 3; c++) dst[i + c] = Math.round((ad[i + c] * sa + bd[i + c] * da * (1 - sa)) / oa);
      dst[i + 3] = Math.round(oa * 255);
    }
    const ft = finishTile(dst, 4, 0);
    if (ft) tiles.set(key, ft);
  }
  return tiles.size ? new TiledSurface(4, tiles, 0) : null;
}

/** Extracts a 1-channel intensity surface from a 4-channel `fluor` surface's alpha channel. */
function fluorIntensitySurface(fluor: TiledSurface): TiledSurface {
  const tiles = new Map<TileKey, Tile>();
  for (const [key, tile] of fluor.tiles) {
    const src = expand4(tile);
    const dst = new Uint8ClampedArray(TILE * TILE);
    for (let p = 0; p < TILE * TILE; p++) dst[p] = src[p * 4 + 3];
    const ft = finishTile(dst, 1, 0);
    if (ft) tiles.set(key, ft);
  }
  return new TiledSurface(1, tiles, 0);
}

/** Computes the UV spill halo for a layer's `fluor` surface, reusing `computeSpill` from `./light`. */
export function computeUvSpill(fluor: TiledSurface, strength: number): TiledSurface | null {
  if (!fluor.tiles.size || strength <= 0) return null;
  const intensity = fluorIntensitySurface(fluor);
  if (!intensity.tiles.size) return null;
  return computeSpill(fluor, intensity, { radius: 20, strength: Math.min(2, 0.9 * strength) });
}

/**
 * Tile cache for UV blacklight rendering on one layer: dims daylight pixels to `uvLight.ambient`
 * and adds fluorescent emission from `doc.fluor[id]` (even where daylight alpha is 0 for invisible ink).
 */
export class UvCache {
  private readonly tiles = new Map<TileKey, { inputs: unknown[]; tile: Tile }>();
  private spillCache: { fluor: TiledSurface; strength: number; surface: TiledSurface | null } | null = null;

  render(color: TiledSurface, fluor: TiledSurface | undefined, uv: UvLightSettings): TiledSurface {
    if (!uv.on) return color;
    const uk = uvLightKey(uv);
    const keys = new Set<TileKey>([...color.tiles.keys(), ...(fluor ? fluor.tiles.keys() : [])]);
    const out = new Map<TileKey, Tile>();
    for (const key of keys) {
      const cTile = color.tiles.get(key) ?? null;
      const fTile = fluor?.tiles.get(key) ?? null;
      if (!cTile && (!fTile || uv.strength <= 0)) continue;
      const inputs: unknown[] = [cTile, fTile, uk];
      const cached = this.tiles.get(key);
      if (cached && cached.inputs.length === inputs.length && cached.inputs.every((v, i) => v === inputs[i])) {
        out.set(key, cached.tile);
        continue;
      }
      const cd = cTile ? expand4(cTile) : null;
      const fd = fTile && uv.strength > 0 ? expand4(fTile) : null;
      const dst = new Uint8ClampedArray(TILE * TILE * 4);
      const amb = uv.ambient;
      const str = uv.strength;
      for (let i = 0; i < dst.length; i += 4) {
        const ca = cd ? cd[i + 3] : 0;
        const fa = fd ? fd[i + 3] : 0;
        if (ca === 0 && fa === 0) continue;
        const fGain = (fa / 255) * str;
        const fCov = Math.min(1, fGain);
        for (let c = 0; c < 3; c++) {
          const baseLin = ca > 0 ? SRGB_TO_LINEAR[cd![i + c]] * amb : 0;
          const emLin = fa > 0 ? SRGB_TO_LINEAR[fd![i + c]] * (1 + 1.15 * fGain) : 0;
          dst[i + c] = linearToSrgb8(baseLin * (1 - fCov * 0.5) + emLin * fCov);
        }
        dst[i + 3] = Math.min(255, Math.max(ca, Math.round(fa * Math.min(1, str))));
      }
      const ft = finishTile(dst, 4, 0);
      if (ft) {
        this.tiles.set(key, { inputs, tile: ft });
        out.set(key, ft);
      }
    }
    for (const key of [...this.tiles.keys()]) if (!keys.has(key)) this.tiles.delete(key);
    return new TiledSurface(4, out, color.defaultValue);
  }

  spill(fluor: TiledSurface, uv: UvLightSettings): TiledSurface | null {
    if (!uv.on || uv.strength <= 0 || !fluor.tiles.size) return null;
    if (this.spillCache && this.spillCache.fluor === fluor && this.spillCache.strength === uv.strength) {
      return this.spillCache.surface;
    }
    const surface = computeUvSpill(fluor, uv.strength);
    this.spillCache = { fluor, strength: uv.strength, surface };
    return surface;
  }
}

/** Coarse grid scale: 1 heat cell per 4×4 canvas pixels. */
export const HEAT_SCALE = 4;
/** Explicit 2D diffusion rate per step (≤ 0.25 for stability). */
export const HEAT_DIFFUSION = 0.18;
/** Newtonian cooling fraction per step. */
export const HEAT_COOLING = 0.03;
/** Temperature above which a heated cell dries wet paint. */
export const HEAT_DRY_THRESHOLD = 0.5;

export interface HeatField {
  width: number;
  height: number;
  gridWidth: number;
  gridHeight: number;
  /** Row-major temperatures in 0..1 (`gridWidth * gridHeight`). */
  cells: Float64Array;
  max: number;
  revision: number;
}

export interface HeatSample {
  x: number;
  y: number;
  temperature: number;
}

export function createHeatField(width: number, height: number): HeatField {
  const gridWidth = Math.max(1, Math.ceil(width / HEAT_SCALE));
  const gridHeight = Math.max(1, Math.ceil(height / HEAT_SCALE));
  return {
    width,
    height,
    gridWidth,
    gridHeight,
    cells: new Float64Array(gridWidth * gridHeight),
    max: 0,
    revision: 0,
  };
}

export function cloneHeatField(field: HeatField): HeatField {
  return {
    width: field.width,
    height: field.height,
    gridWidth: field.gridWidth,
    gridHeight: field.gridHeight,
    cells: new Float64Array(field.cells),
    max: field.max,
    revision: field.revision,
  };
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-9) return Math.hypot(px - ax, py - ay);
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export interface HeatStats {
  max: number;
  mean: number;
  hotCells: number;
  bounds: RasterRect | null;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function heatStats(field: HeatField | undefined): HeatStats {
  if (!field) return { max: 0, mean: 0, hotCells: 0, bounds: null };
  let max = 0;
  let sum = 0;
  let hot = 0;
  const n = field.cells.length;
  for (let i = 0; i < n; i++) {
    const v = field.cells[i];
    if (v > max) max = v;
    sum += v;
    if (v >= 0.05) hot++;
  }
  field.max = round3(max);
  return {
    max: field.max,
    mean: n > 0 ? round3(sum / n) : 0,
    hotCells: hot,
    bounds: hot > 0 ? hotCellsBounds(field, 0.05) : null,
  };
}

/** Bounding document-space rectangle of all coarse cells with temperature ≥ `threshold`, or `null`. */
export function hotCellsBounds(field: HeatField, threshold = HEAT_DRY_THRESHOLD): RasterRect | null {
  let x0 = field.gridWidth;
  let y0 = field.gridHeight;
  let x1 = -1;
  let y1 = -1;
  for (let cy = 0; cy < field.gridHeight; cy++) {
    for (let cx = 0; cx < field.gridWidth; cx++) {
      if (field.cells[cy * field.gridWidth + cx] >= threshold) {
        if (cx < x0) x0 = cx;
        if (cy < y0) y0 = cy;
        if (cx > x1) x1 = cx;
        if (cy > y1) y1 = cy;
      }
    }
  }
  if (x1 < x0) return null;
  const rx = x0 * HEAT_SCALE;
  const ry = y0 * HEAT_SCALE;
  const rw = Math.min(field.width - rx, (x1 - x0 + 1) * HEAT_SCALE);
  const rh = Math.min(field.height - ry, (y1 - y0 + 1) * HEAT_SCALE);
  return rw > 0 && rh > 0 ? { x: rx, y: ry, width: rw, height: rh } : null;
}

/**
 * Paints heat (or cools when `temperature` is below current cell heat) along `points` with `radius`
 * in document pixels. Returns the affected document-space bounding box and updated field statistics.
 */
export function paintHeatField(
  field: HeatField,
  points: ReadonlyArray<{ x: number; y: number }>,
  radius = 32,
  temperature = 0.85,
): { bounds: RasterRect; stats: HeatStats } {
  const r = Math.min(512, Math.max(1, radius));
  const temp = Math.min(1, Math.max(0, temperature));
  const gw = field.gridWidth;
  const gh = field.gridHeight;
  let minCx = gw;
  let minCy = gh;
  let maxCx = -1;
  let maxCy = -1;
  const segCount = Math.max(1, points.length - 1);
  for (let s = 0; s < segCount; s++) {
    const a = points[s];
    const b = points[Math.min(points.length - 1, s + 1)];
    const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - r) / HEAT_SCALE));
    const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - r) / HEAT_SCALE));
    const x1 = Math.min(gw - 1, Math.ceil((Math.max(a.x, b.x) + r) / HEAT_SCALE));
    const y1 = Math.min(gh - 1, Math.ceil((Math.max(a.y, b.y) + r) / HEAT_SCALE));
    for (let cy = y0; cy <= y1; cy++) {
      const gy = (cy + 0.5) * HEAT_SCALE;
      for (let cx = x0; cx <= x1; cx++) {
        const gx = (cx + 0.5) * HEAT_SCALE;
        const d = distToSegment(gx, gy, a.x, a.y, b.x, b.y);
        if (d >= r) continue;
        const u = 1 - d / r;
        const w = u * u * (3 - 2 * u);
        const idx = cy * gw + cx;
        const cur = field.cells[idx];
        const next = cur + (temp - cur) * w;
        field.cells[idx] = next < 1e-4 ? 0 : Math.min(1, Math.max(0, next));
        if (cx < minCx) minCx = cx;
        if (cy < minCy) minCy = cy;
        if (cx > maxCx) maxCx = cx;
        if (cy > maxCy) maxCy = cy;
      }
    }
  }
  field.revision++;
  const bounds: RasterRect =
    maxCx >= minCx
      ? {
          x: minCx * HEAT_SCALE,
          y: minCy * HEAT_SCALE,
          width: Math.min(field.width - minCx * HEAT_SCALE, (maxCx - minCx + 1) * HEAT_SCALE),
          height: Math.min(field.height - minCy * HEAT_SCALE, (maxCy - minCy + 1) * HEAT_SCALE),
        }
      : { x: 0, y: 0, width: 0, height: 0 };
  return { bounds, stats: heatStats(field) };
}

/**
 * Advances the heat field by `steps` iterations of 5-point Laplacian diffusion and Newtonian cooling.
 */
export function advanceHeatField(field: HeatField, steps = 10): HeatStats {
  const n = Math.min(1000, Math.max(1, Math.round(steps)));
  const gw = field.gridWidth;
  const gh = field.gridHeight;
  let src: Float64Array<ArrayBufferLike> = field.cells;
  let dst: Float64Array<ArrayBufferLike> = new Float64Array(src.length);
  const decay = 1 - HEAT_COOLING;
  for (let s = 0; s < n; s++) {
    for (let y = 0; y < gh; y++) {
      const yUp = Math.max(0, y - 1) * gw;
      const yCur = y * gw;
      const yDn = Math.min(gh - 1, y + 1) * gw;
      for (let x = 0; x < gw; x++) {
        const xL = Math.max(0, x - 1);
        const xR = Math.min(gw - 1, x + 1);
        const c = src[yCur + x];
        const avg = (src[yCur + xL] + src[yCur + xR] + src[yUp + x] + src[yDn + x]) * 0.25;
        const v = (c + HEAT_DIFFUSION * (avg - c)) * decay;
        dst[yCur + x] = v < 1e-4 ? 0 : v;
      }
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  if (src !== field.cells) field.cells.set(src);
  field.revision++;
  return heatStats(field);
}

/** Clears the heat field to 0 everywhere. */
export function clearHeatField(field: HeatField): boolean {
  let had = false;
  for (let i = 0; i < field.cells.length; i++) {
    if (field.cells[i] > 0) {
      had = true;
      field.cells[i] = 0;
    }
  }
  field.max = 0;
  if (had) field.revision++;
  return had;
}

/** Bilinearly samples temperature (0..1) at document coordinates `(x, y)`. */
export function sampleHeatAt(field: HeatField, x: number, y: number): number {
  const gx = x / HEAT_SCALE - 0.5;
  const gy = y / HEAT_SCALE - 0.5;
  const gw = field.gridWidth;
  const gh = field.gridHeight;
  const x0 = Math.max(0, Math.min(gw - 1, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(gh - 1, Math.floor(gy)));
  const x1 = Math.max(0, Math.min(gw - 1, x0 + 1));
  const y1 = Math.max(0, Math.min(gh - 1, y0 + 1));
  const fx = Math.min(1, Math.max(0, gx - Math.floor(gx)));
  const fy = Math.min(1, Math.max(0, gy - Math.floor(gy)));
  const c00 = field.cells[y0 * gw + x0];
  const c10 = field.cells[y0 * gw + x1];
  const c01 = field.cells[y1 * gw + x0];
  const c11 = field.cells[y1 * gw + x1];
  const top = c00 * (1 - fx) + c10 * fx;
  const bot = c01 * (1 - fx) + c11 * fx;
  return top * (1 - fy) + bot * fy;
}

/** Shifts and resizes a heat field when `extendCanvas` shifts the document by `(dx, dy)`. */
export function shiftHeatField(field: HeatField, dx: number, dy: number, newWidth: number, newHeight: number): HeatField {
  const next = createHeatField(newWidth, newHeight);
  for (let cy = 0; cy < next.gridHeight; cy++) {
    const docY = (cy + 0.5) * HEAT_SCALE - dy;
    if (docY < 0 || docY >= field.height) continue;
    for (let cx = 0; cx < next.gridWidth; cx++) {
      const docX = (cx + 0.5) * HEAT_SCALE - dx;
      if (docX < 0 || docX >= field.width) continue;
      next.cells[cy * next.gridWidth + cx] = sampleHeatAt(field, docX, docY);
    }
  }
  next.revision = field.revision + 1;
  heatStats(next);
  return next;
}

/**
 * Tile cache for thermochromic colour shifting on one layer: blends cold pixels toward `hotColor`
 * around `threshold` where the coarse heat field is warm.
 */
export class ThermoCache {
  private readonly tiles = new Map<TileKey, { inputs: unknown[]; tile: Tile }>();

  render(color: TiledSurface, thermo: TiledSurface | undefined, offset: { x: number; y: number }, heat: HeatField): TiledSurface {
    if (!thermo?.tiles.size) return color;
    let anyHeat = false;
    for (let i = 0; i < heat.cells.length; i++) {
      if (heat.cells[i] > 0) {
        anyHeat = true;
        break;
      }
    }
    if (!anyHeat) return color;
    const out = new Map(color.tiles);
    const keys = new Set<TileKey>();
    for (const key of color.tiles.keys()) keys.add(key);
    for (const [key, cTile] of color.tiles) {
      const tTile = thermo.tiles.get(key);
      if (!tTile) continue;
      const inputs: unknown[] = [cTile, tTile, offset.x, offset.y, heat.revision];
      const cached = this.tiles.get(key);
      if (cached && cached.inputs.length === inputs.length && cached.inputs.every((v, i) => v === inputs[i])) {
        out.set(key, cached.tile);
        continue;
      }
      const tx = (key % 65536) - 32768;
      const ty = Math.floor(key / 65536) - 32768;
      const cd = expand4(cTile);
      const td = expand4(tTile);
      const dst = new Uint8ClampedArray(cd);
      const band = 0.12;
      for (let y = 0; y < TILE; y++) {
        const docY = ty * TILE + y + offset.y + 0.5;
        for (let x = 0; x < TILE; x++) {
          const i = (y * TILE + x) * 4;
          const ca = cd[i + 3];
          const thByte = td[i + 3];
          if (ca === 0 || thByte === 0) continue;
          const docX = tx * TILE + x + offset.x + 0.5;
          const temp = sampleHeatAt(heat, docX, docY);
          if (temp <= 0) continue;
          const threshold = thByte / 255;
          const u = Math.min(1, Math.max(0, (temp - (threshold - band)) / (2 * band)));
          const t = u * u * (3 - 2 * u);
          if (t <= 0) continue;
          dst[i] = Math.round(cd[i] * (1 - t) + td[i] * t);
          dst[i + 1] = Math.round(cd[i + 1] * (1 - t) + td[i + 1] * t);
          dst[i + 2] = Math.round(cd[i + 2] * (1 - t) + td[i + 2] * t);
        }
      }
      const shadedTile: Tile = { data: dst, uniform: null };
      this.tiles.set(key, { inputs, tile: shadedTile });
      out.set(key, shadedTile);
    }
    for (const key of [...this.tiles.keys()]) if (!keys.has(key)) this.tiles.delete(key);
    return new TiledSurface(4, out, color.defaultValue);
  }
}

export interface SavedLayerFluor {
  rect: RasterRect;
  /** 4-channel RGBA PNG data URL of the layer's fluorescence. */
  fluor: string;
}

export interface SavedLayerThermo {
  rect: RasterRect;
  /** 4-channel RGBA PNG data URL of the layer's thermochromic `[hotR, hotG, hotB, thresholdByte]`. */
  thermo: string;
}

export interface SavedHeatField {
  gridWidth: number;
  gridHeight: number;
  cells: number[];
}

export function fluorToJSON(fluor: TiledSurface | undefined): SavedLayerFluor | null {
  const b = fluor?.bounds;
  if (!fluor || !b) return null;
  return { rect: { ...b }, fluor: pngDataUrl(b.width, b.height, readRegion(fluor, b), 4) };
}

export function fluorFromJSON(raw: unknown): TiledSurface {
  const r = raw as Partial<SavedLayerFluor>;
  if (!r || typeof r !== 'object' || !r.rect || typeof r.fluor !== 'string') throw new Error('not a saved fluorescence channel');
  const parsed = parseDataUrl(r.fluor);
  if (!parsed) throw new Error('the fluorescence channel is not a PNG data URL');
  const img = decodePng(parsed.bytes);
  return surfaceFromPixels({ width: img.width, height: img.height, data: img.data }, 4, r.rect.x, r.rect.y);
}

export function thermoToJSON(thermo: TiledSurface | undefined): SavedLayerThermo | null {
  const b = thermo?.bounds;
  if (!thermo || !b) return null;
  return { rect: { ...b }, thermo: pngDataUrl(b.width, b.height, readRegion(thermo, b), 4) };
}

export function thermoFromJSON(raw: unknown): TiledSurface {
  const r = raw as Partial<SavedLayerThermo>;
  if (!r || typeof r !== 'object' || !r.rect || typeof r.thermo !== 'string') throw new Error('not a saved thermochromic channel');
  const parsed = parseDataUrl(r.thermo);
  if (!parsed) throw new Error('the thermochromic channel is not a PNG data URL');
  const img = decodePng(parsed.bytes);
  return surfaceFromPixels({ width: img.width, height: img.height, data: img.data }, 4, r.rect.x, r.rect.y);
}

export function heatToJSON(field: HeatField | undefined): SavedHeatField | null {
  if (!field) return null;
  let any = false;
  for (let i = 0; i < field.cells.length; i++) {
    if (field.cells[i] > 0) {
      any = true;
      break;
    }
  }
  if (!any) return null;
  return {
    gridWidth: field.gridWidth,
    gridHeight: field.gridHeight,
    cells: Array.from(field.cells, (v) => Math.round(v * 10000) / 10000),
  };
}

export function heatFromJSON(raw: unknown, width: number, height: number): HeatField | null {
  const r = raw as Partial<SavedHeatField>;
  if (!r || typeof r !== 'object' || typeof r.gridWidth !== 'number' || typeof r.gridHeight !== 'number' || !Array.isArray(r.cells)) {
    return null;
  }
  const field = createHeatField(width, height);
  if (r.gridWidth === field.gridWidth && r.gridHeight === field.gridHeight && r.cells.length === field.cells.length) {
    for (let i = 0; i < field.cells.length; i++) {
      const v = r.cells[i];
      field.cells[i] = typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    }
    field.revision = 1;
    heatStats(field);
  }
  return field;
}
