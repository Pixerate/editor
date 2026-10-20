/**
 * High bit depth tiles: 16-bit and 32-bit float samples alongside the 8-bit tile data.
 *
 * A tile may carry `deep` samples next to its `data`:
 *
 * - `Uint16Array`: 16 bits per channel, 0..65535, the same sRGB encoding and straight alpha as
 *   the 8-bit data (`data = round(deep / 257)`).
 * - `Float32Array`: 32-bit float per channel in **linear light** (sRGB primaries), straight
 *   alpha, as Photoshop's 32-bit mode; colour may exceed 1 (`data` is the clamped sRGB encoding).
 *
 * `data` is always the 8-bit rendering of `deep`, so every 8-bit consumer (the compositor, the
 * viewport, brushes, filters, the paint editor) keeps working unchanged and at full speed: it
 * simply sees the 8-bit picture. A tile without `deep` holds 8-bit pixels; read at a higher depth
 * (`tileSamples16` / `tileSamples32`) they are converted exactly as a bit-depth conversion would.
 * Writers that only produce 8-bit data drop `deep` for the tiles they rewrite (those tiles become
 * 8-bit precise), and writers that understand depth build tiles with `deepTile`.
 *
 * Masks (one channel) are coverage, not colour: their float samples are never linearised.
 */

import { TILE, TiledSurface, emptySurface, finishTile, tileKey, tilesInRect, type RasterRect, type Tile } from './surface';

/** Bits per channel: 8, 16 or 32 (float). */
export type BitDepth = 8 | 16 | 32;

export const BIT_DEPTHS: readonly BitDepth[] = [8, 16, 32];

export const isBitDepth = (v: unknown): v is BitDepth => v === 8 || v === 16 || v === 32;

/** Deep samples of a tile: 16-bit encoded, or 32-bit linear float. */
export type DeepSamples = Uint16Array | Float32Array;

const TILE_PIXELS = TILE * TILE;

// ---------------------------------------------------------------------------
// Transfer functions
// ---------------------------------------------------------------------------

/** sRGB-encoded 0..1 to linear light. */
export function srgbDecode(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Linear light to sRGB-encoded (values above 1 extend the curve; below 0 clamp to 0). */
export function srgbEncode(v: number): number {
  if (!(v > 0)) return 0;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

let LIN8: Float32Array | null = null;
let LIN16: Float32Array | null = null;
/** Linear light of every 8-bit code. */
function lin8(): Float32Array {
  if (!LIN8) {
    LIN8 = new Float32Array(256);
    for (let i = 0; i < 256; i++) LIN8[i] = srgbDecode(i / 255);
  }
  return LIN8;
}
/** Linear light of every 16-bit code. */
function lin16(): Float32Array {
  if (!LIN16) {
    LIN16 = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) LIN16[i] = srgbDecode(i / 65535);
  }
  return LIN16;
}

/** Linear `v` as a 16-bit sRGB code (clamped). */
function encode16(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 65535;
  return Math.round(srgbEncode(v) * 65535);
}

let ENC8: Uint8Array | null = null;
/** Linear light (0..1 in 65536 steps, fine enough for 8 bits even near black) to an 8-bit sRGB code. */
function encode8(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  if (!ENC8) {
    ENC8 = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) ENC8[i] = Math.round(srgbEncode(i / 65535) * 255);
  }
  return ENC8[Math.round(v * 65535)];
}

// ---------------------------------------------------------------------------
// Sample conversions (whole buffers, interleaved, `channels` per pixel)
// ---------------------------------------------------------------------------

/** 8-bit samples to 16-bit (`v × 257`, exact both ways). */
export function to16From8(data: ArrayLike<number>, out = new Uint16Array(data.length)): Uint16Array {
  for (let i = 0; i < data.length; i++) out[i] = data[i] * 257;
  return out;
}

/** 8-bit samples to 32-bit float (colour linearised; alpha and masks as is). */
export function to32From8(data: ArrayLike<number>, channels: 1 | 4, out = new Float32Array(data.length)): Float32Array {
  if (channels === 1) {
    for (let i = 0; i < data.length; i++) out[i] = data[i] / 255;
    return out;
  }
  const t = lin8();
  for (let i = 0; i < data.length; i += 4) {
    out[i] = t[data[i]];
    out[i + 1] = t[data[i + 1]];
    out[i + 2] = t[data[i + 2]];
    out[i + 3] = data[i + 3] / 255;
  }
  return out;
}

/** 16-bit samples to 32-bit float. */
export function to32From16(data: ArrayLike<number>, channels: 1 | 4, out = new Float32Array(data.length)): Float32Array {
  if (channels === 1) {
    for (let i = 0; i < data.length; i++) out[i] = data[i] / 65535;
    return out;
  }
  const t = lin16();
  for (let i = 0; i < data.length; i += 4) {
    out[i] = t[data[i]];
    out[i + 1] = t[data[i + 1]];
    out[i + 2] = t[data[i + 2]];
    out[i + 3] = data[i + 3] / 65535;
  }
  return out;
}

/** 32-bit float samples to 16-bit (colour encoded and clamped to 0..1). */
export function to16From32(data: ArrayLike<number>, channels: 1 | 4, out = new Uint16Array(data.length)): Uint16Array {
  const unit = (v: number) => (v > 0 ? (v < 1 ? Math.round(v * 65535) : 65535) : 0);
  if (channels === 1) {
    for (let i = 0; i < data.length; i++) out[i] = unit(data[i]);
    return out;
  }
  for (let i = 0; i < data.length; i += 4) {
    out[i] = encode16(data[i]);
    out[i + 1] = encode16(data[i + 1]);
    out[i + 2] = encode16(data[i + 2]);
    out[i + 3] = unit(data[i + 3]);
  }
  return out;
}

/** 16-bit samples to 8-bit (rounded). */
export function to8From16(data: ArrayLike<number>, out = new Uint8ClampedArray(data.length)): Uint8ClampedArray {
  for (let i = 0; i < data.length; i++) out[i] = Math.round(data[i] / 257);
  return out;
}

/** 32-bit float samples to 8-bit (colour encoded and clamped). */
export function to8From32(data: ArrayLike<number>, channels: 1 | 4, out = new Uint8ClampedArray(data.length)): Uint8ClampedArray {
  if (channels === 1) {
    for (let i = 0; i < data.length; i++) out[i] = Math.round(data[i] * 255);
    return out;
  }
  for (let i = 0; i < data.length; i += 4) {
    out[i] = encode8(data[i]);
    out[i + 1] = encode8(data[i + 1]);
    out[i + 2] = encode8(data[i + 2]);
    out[i + 3] = Math.round(Math.min(1, Math.max(0, data[i + 3])) * 255);
  }
  return out;
}

/** The 8-bit rendering of deep samples. */
export function proxyOf(deep: DeepSamples, channels: 1 | 4, out?: Uint8ClampedArray<ArrayBuffer>): Uint8ClampedArray {
  return deep instanceof Uint16Array ? to8From16(deep, out) : to8From32(deep, channels, out);
}

/** The bit depth deep samples hold. */
export const depthOf = (deep: DeepSamples): 16 | 32 => (deep instanceof Uint16Array ? 16 : 32);

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

/**
 * A stored tile from deep samples (`TILE × TILE × channels`): `null` when it renders as the
 * surface default and holds nothing finer, an 8-bit tile when 8 bits hold it exactly (16-bit
 * samples that are multiples of 257), else a tile with `deep` and its 8-bit rendering.
 */
export function deepTile(deep: DeepSamples, channels: 1 | 4, defaultValue = 0): Tile | null {
  const data = proxyOf(deep, channels);
  if (deep instanceof Uint16Array) {
    let exact = true;
    for (let i = 0; i < deep.length; i++) {
      if (deep[i] % 257 !== 0) {
        exact = false;
        break;
      }
    }
    if (exact) return finishTile(data, channels, defaultValue);
  } else if (channels === 4 && defaultValue === 0) {
    // A float layer tile that is transparent everywhere stores nothing.
    let empty = true;
    for (let i = 3; i < deep.length; i += 4) {
      if (deep[i] !== 0) {
        empty = false;
        break;
      }
    }
    if (empty) return null;
  }
  return { data, uniform: null, deep };
}

/** 16-bit samples of a tile (`undefined`: the default tile), converting 8-bit or float data. */
export function tileSamples16(tile: Tile | undefined, channels: 1 | 4, defaultValue = 0): Uint16Array {
  const deep = tile?.deep;
  if (deep instanceof Uint16Array) return deep;
  if (deep instanceof Float32Array) return to16From32(deep, channels);
  if (tile) return to16From8(tile.data);
  return new Uint16Array(TILE_PIXELS * channels).fill(defaultValue * 257);
}

/** 32-bit float samples of a tile (`undefined`: the default tile), converting 8- or 16-bit data. */
export function tileSamples32(tile: Tile | undefined, channels: 1 | 4, defaultValue = 0): Float32Array {
  const deep = tile?.deep;
  if (deep instanceof Float32Array) return deep;
  if (deep instanceof Uint16Array) return to32From16(deep, channels);
  if (tile) return to32From8(tile.data, channels);
  const out = new Float32Array(TILE_PIXELS * channels);
  if (defaultValue) {
    if (channels === 1) out.fill(defaultValue / 255);
    else to32From8(new Uint8ClampedArray(TILE_PIXELS * 4).fill(defaultValue), 4, out);
  }
  return out;
}

/** Deep samples of a tile at `depth` (16 or 32). */
export function tileSamples(tile: Tile | undefined, channels: 1 | 4, depth: 16 | 32, defaultValue = 0): DeepSamples {
  return depth === 16 ? tileSamples16(tile, channels, defaultValue) : tileSamples32(tile, channels, defaultValue);
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** The deepest samples any tile of a surface holds: 8, 16 or 32. */
export function surfaceDepth(surface: TiledSurface): BitDepth {
  let d: BitDepth = 8;
  for (const t of surface.tiles.values()) {
    if (t.deep instanceof Float32Array) return 32;
    if (t.deep) d = 16;
  }
  return d;
}

/** Copies `rect` of a surface at `depth` into a new buffer (`rect.width × rect.height × channels`). */
export function readDeepRegion(surface: TiledSurface, rect: RasterRect, depth: 16): Uint16Array;
export function readDeepRegion(surface: TiledSurface, rect: RasterRect, depth: 32): Float32Array;
export function readDeepRegion(surface: TiledSurface, rect: RasterRect, depth: 16 | 32): DeepSamples;
export function readDeepRegion(surface: TiledSurface, rect: RasterRect, depth: 16 | 32): DeepSamples {
  const ch = surface.channels;
  const w = rect.width;
  const h = rect.height;
  const out = depth === 16 ? new Uint16Array(w * h * ch) : new Float32Array(w * h * ch);
  const fill = tileSamples(undefined, ch, depth, surface.defaultValue);
  if (surface.defaultValue) for (let i = 0; i < out.length; i += ch) for (let c = 0; c < ch; c++) out[i + c] = fill[c];
  for (const { tx, ty } of tilesInRect(rect)) {
    const tile = surface.tiles.get(tileKey(tx, ty));
    if (!tile) continue;
    const src = tileSamples(tile, ch, depth, surface.defaultValue);
    const ox = tx * TILE;
    const oy = ty * TILE;
    const x0 = Math.max(rect.x, ox);
    const y0 = Math.max(rect.y, oy);
    const x1 = Math.min(rect.x + w, ox + TILE);
    const y1 = Math.min(rect.y + h, oy + TILE);
    const span = (x1 - x0) * ch;
    for (let yy = y0; yy < y1; yy++) {
      const s = ((yy - oy) * TILE + (x0 - ox)) * ch;
      const d = ((yy - rect.y) * w + (x0 - rect.x)) * ch;
      out.set(src.subarray(s, s + span), d);
    }
  }
  return out;
}

/**
 * Writes `rect.width × rect.height` interleaved deep samples at `rect` and returns the new
 * surface. Partly covered tiles keep their other pixels, converted to the samples' depth.
 */
export function writeDeepRegion(surface: TiledSurface, rect: RasterRect, samples: DeepSamples): TiledSurface {
  const ch = surface.channels;
  const w = rect.width;
  const h = rect.height;
  if (w <= 0 || h <= 0) return surface;
  if (samples.length < w * h * ch) throw new Error(`writeDeepRegion: expected ${w * h * ch} samples, got ${samples.length}`);
  const depth = depthOf(samples);
  const tiles = new Map(surface.tiles);
  for (const { tx, ty } of tilesInRect(rect)) {
    const key = tileKey(tx, ty);
    const ox = tx * TILE;
    const oy = ty * TILE;
    const x0 = Math.max(rect.x, ox);
    const y0 = Math.max(rect.y, oy);
    const x1 = Math.min(rect.x + w, ox + TILE);
    const y1 = Math.min(rect.y + h, oy + TILE);
    const full = x0 === ox && y0 === oy && x1 === ox + TILE && y1 === oy + TILE;
    const base = full ? null : tileSamples(surface.tiles.get(key), ch, depth, surface.defaultValue);
    const t: DeepSamples = base ? (base.slice() as DeepSamples) : depth === 16 ? new Uint16Array(TILE_PIXELS * ch) : new Float32Array(TILE_PIXELS * ch);
    const span = (x1 - x0) * ch;
    for (let yy = y0; yy < y1; yy++) {
      const s = ((yy - rect.y) * w + (x0 - rect.x)) * ch;
      const d = ((yy - oy) * TILE + (x0 - ox)) * ch;
      t.set(samples.subarray(s, s + span), d);
    }
    const tile = deepTile(t, ch, surface.defaultValue);
    if (tile) tiles.set(key, tile);
    else tiles.delete(key);
  }
  return new TiledSurface(ch, tiles, surface.defaultValue);
}

/** A surface holding `width × height` deep samples placed at (`x`, `y`). */
export function surfaceFromDeepPixels(
  pixels: { width: number; height: number; data: DeepSamples },
  channels: 1 | 4 = 4,
  x = 0,
  y = 0,
  defaultValue = 0
): TiledSurface {
  return writeDeepRegion(emptySurface(channels, defaultValue), { x, y, width: pixels.width, height: pixels.height }, pixels.data);
}

/**
 * The surface converted to `depth`: 8 drops every tile's deep samples (keeping their 8-bit
 * rendering); 16 or 32 converts the deep samples tiles already hold. Tiles without deep samples
 * are left alone (they read at any depth by conversion), so going up from 8 bits costs nothing.
 * Returns the same surface when nothing changes.
 */
export function convertSurfaceDepth(surface: TiledSurface, depth: BitDepth): TiledSurface {
  let changed = false;
  const tiles = new Map(surface.tiles);
  const ch = surface.channels;
  for (const [key, tile] of surface.tiles) {
    const deep = tile.deep;
    if (!deep || depthOf(deep) === depth) continue;
    changed = true;
    let next: Tile | null;
    if (depth === 8) next = finishTile(tile.data, ch, surface.defaultValue);
    else next = deepTile(depth === 16 ? to16From32(deep, ch) : to32From16(deep, ch), ch, surface.defaultValue);
    if (next) tiles.set(key, next);
    else tiles.delete(key);
  }
  return changed ? new TiledSurface(ch, tiles, surface.defaultValue) : surface;
}

/** Bytes held by deep samples (in addition to `surfaceBytes`). */
export function deepBytes(surface: TiledSurface): number {
  let n = 0;
  for (const t of surface.tiles.values()) if (t.deep) n += t.deep.byteLength;
  return n;
}
