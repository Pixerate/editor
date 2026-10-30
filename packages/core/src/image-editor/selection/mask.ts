// Portions ported from photocraft/crates/algo/src/selection.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import type { CropBox } from '../types';
import { TILE, TiledSurface, contentBounds, finishTile, readPixel, readRegion, tileCoord, writeRegion, tileKey, uniformTile, type Tile, type TileKey } from '../../raster/surface';

/**
 * A selection: one 8-bit coverage value per image pixel (0 = not selected, 255 = fully
 * selected), row-major over the whole source image in natural pixels — the same space as the
 * crop box and annotations. Soft values are partial selection (feathered or anti-aliased edges).
 *
 * The coverage is stored as 256 × 256 tiles (`surface`, one byte per pixel, missing tiles are 0
 * and every pixel outside the image is 0), so an empty or fully selected area costs nothing and
 * masks share the tiles an operation did not change. `data` is the same coverage as one array,
 * built on first read and cached for the few masks read most recently.
 *
 * Treat a mask as immutable: every operation returns a new one, so history entries can share
 * them without copying. Never write to `data`.
 */
export interface SelectionMask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /** Bounding box of the non-zero coverage, or `null` when nothing is selected. */
  readonly bounds: CropBox | null;
  /** The coverage as tiles (1 channel, default 0), shared with other masks where equal. */
  readonly surface: TiledSurface;
}

/** How a new selection combines with the current one. */
export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect';

export const SELECTION_MODES: readonly SelectionMode[] = ['replace', 'add', 'subtract', 'intersect'];

export function isSelectionMode(value: unknown): value is SelectionMode {
  return typeof value === 'string' && (SELECTION_MODES as readonly string[]).includes(value);
}

/** Parses `replace|add|subtract|intersect`; anything else is `replace`. */
export function parseSelectionMode(value: unknown): SelectionMode {
  return isSelectionMode(value) ? value : 'replace';
}

/** RGBA pixels, 8 bits per channel, straight alpha (an `ImageData` qualifies). */
export interface PixelBuffer {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** Serialized selection: a run-length encoding of the 8-bit coverage. */
export interface SerializedSelection {
  width: number;
  height: number;
  /** `r1:` + base64 of (value byte, LEB128 run length) pairs. */
  rle: string;
}

const MAX_SIDE = 1 << 15;

function checkSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) {
    throw new Error(`Invalid selection size ${width}×${height}`);
  }
}

/** Bounding box of non-zero bytes. */
export function computeSelectionBounds(width: number, height: number, data: ArrayLike<number>): CropBox | null {
  let x0 = width;
  let x1 = -1;
  let y0 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let first = -1;
    for (let x = 0; x < width; x++) {
      if (data[row + x] !== 0) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let x = width - 1; x > first; x--) {
      if (data[row + x] !== 0) {
        last = x;
        break;
      }
    }
    if (y0 < 0) y0 = y;
    y1 = y;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
  }
  if (y0 < 0) return null;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// ---------------------------------------------------------------------------
// Tiled storage
// ---------------------------------------------------------------------------

const TILE_PIXELS = TILE * TILE;

/** Masks whose `data` was read most recently keep it; older ones rebuild it from the tiles. */
const MATERIALIZED_LIMIT = 4;
const materialized = new Map<TiledSelectionMask, Uint8Array>();
let lastRead: TiledSelectionMask | null = null;
let lastData: Uint8Array | null = null;

class TiledSelectionMask implements SelectionMask {
  private cachedBounds: CropBox | null | undefined;
  private weak: WeakRef<Uint8Array> | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly surface: TiledSurface,
    bounds?: CropBox | null,
    data?: Uint8Array
  ) {
    this.cachedBounds = bounds;
    if (data) this.remember(data);
  }

  get bounds(): CropBox | null {
    if (this.cachedBounds === undefined) this.cachedBounds = contentBounds(this.surface);
    return this.cachedBounds;
  }

  get data(): Uint8Array {
    // Loops often read `mask.data[i]`: answer the latest mask without touching the cache.
    if (lastRead === this) return lastData!;
    let d = materialized.get(this);
    if (d) {
      // Most recently used last.
      materialized.delete(this);
      materialized.set(this, d);
      lastRead = this;
      lastData = d;
      return d;
    }
    d = this.weak?.deref();
    if (!d) {
      const all = readRegion(this.surface, { x: 0, y: 0, width: this.width, height: this.height });
      d = new Uint8Array(all.buffer, all.byteOffset, all.length);
    }
    this.remember(d);
    return d;
  }

  private remember(d: Uint8Array): void {
    lastRead = this;
    lastData = d;
    this.weak = typeof WeakRef === 'function' ? new WeakRef(d) : null;
    materialized.set(this, d);
    while (materialized.size > MATERIALIZED_LIMIT) materialized.delete(materialized.keys().next().value!);
  }
}

/** Tile columns and rows covering a `width × height` image. */
function tileGrid(width: number, height: number): { cols: number; rows: number } {
  return { cols: Math.ceil(width / TILE), rows: Math.ceil(height / TILE) };
}

/** Whether tile (tx, ty) lies wholly inside the image. */
function insideTile(tx: number, ty: number, width: number, height: number): boolean {
  return (tx + 1) * TILE <= width && (ty + 1) * TILE <= height;
}

/** The tiles of `width × height` coverage bytes; all-zero tiles are left out, uniform ones shared. */
function surfaceFromCoverage(width: number, height: number, data: ArrayLike<number>): TiledSurface {
  const tiles = new Map<TileKey, Tile>();
  const { cols, rows } = tileGrid(width, height);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const ox = tx * TILE;
      const oy = ty * TILE;
      const w = Math.min(TILE, width - ox);
      const h = Math.min(TILE, height - oy);
      let lo = 255;
      let hi = 0;
      for (let y = 0; y < h && !(hi > 0 && lo < hi); y++) {
        const row = (oy + y) * width + ox;
        for (let x = 0; x < w; x++) {
          const v = data[row + x];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (hi === 0) continue;
      if (lo === hi && w === TILE && h === TILE) {
        tiles.set(tileKey(tx, ty), uniformTile(1, hi));
        continue;
      }
      const t = new Uint8ClampedArray(TILE_PIXELS);
      for (let y = 0; y < h; y++) {
        const row = (oy + y) * width + ox;
        for (let x = 0; x < w; x++) t[y * TILE + x] = data[row + x];
      }
      tiles.set(tileKey(tx, ty), { data: t, uniform: null });
    }
  }
  return new TiledSurface(1, tiles, 0);
}

/** `tile` with everything outside the image (`w × h` of it in use) set to 0, or `null` when nothing is left. */
function clipTile(tile: Tile, w: number, h: number): Tile | null {
  const d = tile.data;
  let outside = false;
  for (let y = 0; y < TILE && !outside; y++) {
    for (let x = y < h ? w : 0; x < TILE; x++) {
      if (d[y * TILE + x] !== 0) {
        outside = true;
        break;
      }
    }
  }
  if (!outside) return tile;
  const t = new Uint8ClampedArray(TILE_PIXELS);
  for (let y = 0; y < h; y++) t.set(d.subarray(y * TILE, y * TILE + w), y * TILE);
  return finishTile(t, 1, 0);
}

/**
 * A selection over `width × height` from a 1-channel tiled surface in image space (Quick Mask
 * paint, a mask): its tiles are shared, and coverage outside the image is dropped. A surface
 * whose default is not 0 is read out instead.
 */
export function selectionFromTiles(width: number, height: number, surface: TiledSurface): SelectionMask {
  checkSize(width, height);
  if (surface.channels !== 1) throw new Error('A selection needs a 1-channel surface');
  if (surface.defaultValue !== 0) {
    const all = readRegion(surface, { x: 0, y: 0, width, height });
    return createSelectionMask(width, height, new Uint8Array(all.buffer, all.byteOffset, all.length));
  }
  const { cols, rows } = tileGrid(width, height);
  let tiles: Map<TileKey, Tile> | null = null;
  for (const [key, tile] of surface.tiles) {
    const { tx, ty } = tileCoord(key);
    let next: Tile | null = tile;
    if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) next = null;
    else if (!insideTile(tx, ty, width, height)) next = clipTile(tile, Math.min(TILE, width - tx * TILE), Math.min(TILE, height - ty * TILE));
    if (next === tile) continue;
    tiles ??= new Map(surface.tiles);
    if (next) tiles.set(key, next);
    else tiles.delete(key);
  }
  return new TiledSelectionMask(width, height, tiles ? new TiledSurface(1, tiles, 0) : surface);
}

/** Wraps coverage bytes (taken over, not copied) as a selection, computing its bounds. */
export function createSelectionMask(width: number, height: number, data?: Uint8Array): SelectionMask {
  checkSize(width, height);
  if (!data) return new TiledSelectionMask(width, height, new TiledSurface(1, new Map(), 0), null);
  if (data.length !== width * height) throw new Error('Selection data does not match its size');
  return new TiledSelectionMask(width, height, surfaceFromCoverage(width, height, data), undefined, data);
}

/**
 * A selection that is `data` (`rect.width × rect.height` coverage bytes) inside `rect` and
 * nothing elsewhere, without allocating the whole image. `rect` must lie inside the image.
 */
export function selectionFromRegion(width: number, height: number, rect: CropBox, data: ArrayLike<number>): SelectionMask {
  checkSize(width, height);
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > width || rect.y + rect.height > height) throw new Error('The region lies outside the selection');
  return new TiledSelectionMask(width, height, writeRegion(new TiledSurface(1, new Map(), 0), rect, data));
}

/** Select › All. */
export function fullSelection(width: number, height: number): SelectionMask {
  checkSize(width, height);
  const tiles = new Map<TileKey, Tile>();
  const { cols, rows } = tileGrid(width, height);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      if (insideTile(tx, ty, width, height)) {
        tiles.set(tileKey(tx, ty), uniformTile(1, 255));
        continue;
      }
      const t = new Uint8ClampedArray(TILE_PIXELS);
      const w = Math.min(TILE, width - tx * TILE);
      for (let y = 0; y < Math.min(TILE, height - ty * TILE); y++) t.fill(255, y * TILE, y * TILE + w);
      tiles.set(tileKey(tx, ty), { data: t, uniform: null });
    }
  }
  return new TiledSelectionMask(width, height, new TiledSurface(1, tiles, 0), { x: 0, y: 0, width, height });
}

export function isSelectionEmpty(mask: SelectionMask | null | undefined): boolean {
  return !mask || mask.bounds === null;
}

/** Coverage at a pixel, 0..1 (0 outside the image). */
export function selectionValueAt(mask: SelectionMask, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= mask.width || yi >= mask.height) return 0;
  return readPixel(mask.surface, xi, yi)[0] / 255;
}

/** 8-bit value of a coverage (clamped and rounded; NaN → 0). */
export function coverageToByte(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  return Math.floor(v * 255 + 0.5);
}

/** A selection from 0..1 coverage. */
export function selectionFromCoverage(width: number, height: number, coverage: ArrayLike<number>): SelectionMask {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = coverageToByte(coverage[i]);
  return createSelectionMask(width, height, out);
}

/** The selection's coverage as 0..1 floats. */
export function selectionToCoverage(mask: SelectionMask): Float32Array {
  const out = new Float32Array(mask.data.length);
  for (let i = 0; i < out.length; i++) out[i] = mask.data[i] / 255;
  return out;
}

/** Number of fully-or-partly selected pixels, weighted by coverage (Σ coverage). */
export function selectionArea(mask: SelectionMask | null | undefined): number {
  if (!mask || !mask.bounds) return 0;
  let sum = 0;
  for (const tile of mask.surface.tiles.values()) {
    if (tile.uniform !== null) {
      sum += tile.uniform * TILE_PIXELS;
      continue;
    }
    const d = tile.data;
    for (let i = 0; i < d.length; i++) sum += d[i];
  }
  return sum / 255;
}

/**
 * Combines `next` with `prev` by `mode` (8-bit, exact: combining a mask with itself is a no-op).
 * Add is the maximum, Subtract `max(prev − next, 0)`, Intersect the minimum. A missing `prev`
 * reads as nothing selected. Returns `null` when nothing remains selected.
 */
export function combineSelections(
  prev: SelectionMask | null | undefined,
  next: SelectionMask,
  mode: SelectionMode
): SelectionMask | null {
  let result: SelectionMask;
  if (mode === 'replace' || (!prev && mode === 'add')) {
    result = next;
  } else if (!prev) {
    return null;
  } else {
    if (prev.width !== next.width || prev.height !== next.height) throw new Error('Selections differ in size');
    result = new TiledSelectionMask(prev.width, prev.height, combineSurfaces(prev.surface, next.surface, mode));
  }
  return result.bounds ? result : null;
}

const FULL = 255;

/** One tile of `a` combined with `b` by `mode`; `undefined` = nothing selected. Shares a tile when the result equals it. */
function combineTile(a: Tile | undefined, b: Tile | undefined, mode: Exclude<SelectionMode, 'replace'>): Tile | undefined {
  if (mode === 'add') {
    if (!b || a?.uniform === FULL) return a;
    if (!a || b.uniform === FULL) return b;
  } else if (mode === 'subtract') {
    if (!a || !b) return a;
    if (b.uniform === FULL) return undefined;
  } else {
    if (!a || !b) return undefined;
    if (a.uniform === FULL) return b;
    if (b.uniform === FULL) return a;
  }
  const x = a.data;
  const y = b.data;
  const out = new Uint8ClampedArray(TILE_PIXELS);
  if (mode === 'add') for (let i = 0; i < out.length; i++) out[i] = x[i] > y[i] ? x[i] : y[i];
  else if (mode === 'subtract') for (let i = 0; i < out.length; i++) out[i] = x[i] > y[i] ? x[i] - y[i] : 0;
  else for (let i = 0; i < out.length; i++) out[i] = x[i] < y[i] ? x[i] : y[i];
  return finishTile(out, 1, 0) ?? undefined;
}

function combineSurfaces(a: TiledSurface, b: TiledSurface, mode: Exclude<SelectionMode, 'replace'>): TiledSurface {
  const tiles = new Map<TileKey, Tile>();
  for (const key of new Set([...a.tiles.keys(), ...b.tiles.keys()])) {
    const tile = combineTile(a.tiles.get(key), b.tiles.get(key), mode);
    if (tile) tiles.set(key, tile);
  }
  return new TiledSurface(1, tiles, 0);
}

/** Select › Inverse. */
export function invertSelection(mask: SelectionMask): SelectionMask {
  const { width, height } = mask;
  const tiles = new Map<TileKey, Tile>();
  const { cols, rows } = tileGrid(width, height);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const src = mask.surface.getTile(tx, ty);
      const key = tileKey(tx, ty);
      if (insideTile(tx, ty, width, height)) {
        if (!src) tiles.set(key, uniformTile(1, FULL));
        else if (src.uniform !== null) {
          if (src.uniform !== FULL) tiles.set(key, uniformTile(1, FULL - src.uniform));
        } else {
          const out = new Uint8ClampedArray(TILE_PIXELS);
          for (let i = 0; i < out.length; i++) out[i] = FULL - src.data[i];
          const t = finishTile(out, 1, 0);
          if (t) tiles.set(key, t);
        }
        continue;
      }
      const w = Math.min(TILE, width - tx * TILE);
      const h = Math.min(TILE, height - ty * TILE);
      const out = new Uint8ClampedArray(TILE_PIXELS);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * TILE + x] = FULL - (src ? src.data[y * TILE + x] : 0);
      const t = finishTile(out, 1, 0);
      if (t) tiles.set(key, t);
    }
  }
  return new TiledSelectionMask(width, height, new TiledSurface(1, tiles, 0));
}

/** Bilinear resample to another size (e.g. an AI mask returned at a different resolution). */
export function resizeSelection(mask: SelectionMask, width: number, height: number): SelectionMask {
  if (mask.width === width && mask.height === height) return mask;
  checkSize(width, height);
  const out = new Uint8Array(width * height);
  const sx = mask.width / width;
  const sy = mask.height / height;
  const src = mask.data;
  const mw = mask.width;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(mask.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(mask.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(mw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(mw - 1, x0 + 1);
      const tx = fx - x0;
      const top = src[y0 * mw + x0] * (1 - tx) + src[y0 * mw + x1] * tx;
      const bot = src[y1 * mw + x0] * (1 - tx) + src[y1 * mw + x1] * tx;
      out[y * width + x] = Math.round(top * (1 - ty) + bot * ty);
    }
  }
  return createSelectionMask(width, height, out);
}

export type SelectionChannel = 'alpha' | 'luminance' | 'red' | 'green' | 'blue';

/**
 * A selection from an image: by default its luminance (white = selected, the usual convention
 * of segmentation masks), or one channel. Partly transparent pixels count as black for
 * luminance, so a mask PNG with transparency works either way.
 */
export function selectionFromPixels(
  pixels: PixelBuffer,
  options: { channel?: SelectionChannel; invert?: boolean; threshold?: number } = {}
): SelectionMask {
  const { width, height, data } = pixels;
  checkSize(width, height);
  if (data.length < width * height * 4) throw new Error('Pixel data is shorter than width × height × 4');
  const channel = options.channel ?? 'luminance';
  const out = new Uint8Array(width * height);
  const threshold = options.threshold;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    let v: number;
    switch (channel) {
      case 'alpha':
        v = data[p + 3];
        break;
      case 'red':
        v = data[p];
        break;
      case 'green':
        v = data[p + 1];
        break;
      case 'blue':
        v = data[p + 2];
        break;
      default:
        v = Math.round(((0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) * data[p + 3]) / 255);
    }
    if (options.invert) v = 255 - v;
    if (threshold !== undefined) v = v >= threshold ? 255 : 0;
    out[i] = v;
  }
  return createSelectionMask(width, height, out);
}

/** The selection as RGBA pixels: grey (white = selected, opaque) or white with coverage as alpha. */
export function selectionToPixels(mask: SelectionMask, as: 'gray' | 'alpha' = 'gray'): { width: number; height: number; data: Uint8ClampedArray } {
  const out = new Uint8ClampedArray(mask.data.length * 4);
  for (let i = 0, p = 0; i < mask.data.length; i++, p += 4) {
    const v = mask.data[i];
    if (as === 'gray') {
      out[p] = out[p + 1] = out[p + 2] = v;
      out[p + 3] = 255;
    } else {
      out[p] = out[p + 1] = out[p + 2] = 255;
      out[p + 3] = v;
    }
  }
  return { width: mask.width, height: mask.height, data: out };
}

// ---------------------------------------------------------------------------
// Run-length encoding
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function toBase64(bytes: Uint8Array, length: number): string {
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < length ? bytes[i + 1] : 0;
    const c = i + 2 < length ? bytes[i + 2] : 0;
    chunk += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    chunk += i + 1 < length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    chunk += i + 2 < length ? B64[c & 63] : '=';
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new Error('Invalid base64 length');
  let pad = 0;
  if (text.endsWith('==')) pad = 2;
  else if (text.endsWith('=')) pad = 1;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  const digit = (i: number, k: number): number => {
    const ch = text.charCodeAt(i + k);
    if (ch === 61 /* = */ && i + 4 === text.length && k >= 4 - pad) return 0;
    const idx = ch < 128 ? B64_INDEX[ch] : -1;
    if (idx < 0) throw new Error('Invalid base64 character');
    return idx;
  };
  for (let i = 0; i < text.length; i += 4) {
    const n = (digit(i, 0) << 18) | (digit(i, 1) << 12) | (digit(i, 2) << 6) | digit(i, 3);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** Run-length encodes coverage bytes: `r1:` + base64 of (value, LEB128 run length) pairs. */
export function encodeSelectionRle(data: Uint8Array): string {
  let buf = new Uint8Array(64);
  let len = 0;
  const push = (b: number) => {
    if (len === buf.length) {
      const next = new Uint8Array(buf.length * 2);
      next.set(buf);
      buf = next;
    }
    buf[len++] = b;
  };
  let i = 0;
  while (i < data.length) {
    const v = data[i];
    let j = i + 1;
    while (j < data.length && data[j] === v) j++;
    push(v);
    let run = j - i;
    while (run >= 128) {
      push((run & 127) | 128);
      run = Math.floor(run / 128);
    }
    push(run);
    i = j;
  }
  return 'r1:' + toBase64(buf, len);
}

/** Decodes {@link encodeSelectionRle}; throws unless the runs cover exactly `length` bytes. */
export function decodeSelectionRle(rle: string, length: number): Uint8Array {
  if (typeof rle !== 'string' || !rle.startsWith('r1:')) throw new Error('Unknown selection encoding');
  const bytes = fromBase64(rle.slice(3));
  const out = new Uint8Array(length);
  let o = 0;
  let i = 0;
  while (i < bytes.length) {
    const v = bytes[i++];
    let run = 0;
    let scale = 1;
    for (;;) {
      if (i >= bytes.length) throw new Error('Truncated selection run');
      const b = bytes[i++];
      run += (b & 127) * scale;
      if (b < 128) break;
      scale *= 128;
      if (scale > 2 ** 35) throw new Error('Selection run too long');
    }
    if (run === 0 || o + run > length) throw new Error('Selection runs do not match its size');
    if (v !== 0) out.fill(v, o, o + run);
    o += run;
  }
  if (o !== length) throw new Error('Selection runs do not match its size');
  return out;
}

export function serializeSelection(mask: SelectionMask): SerializedSelection {
  return { width: mask.width, height: mask.height, rle: encodeSelectionRle(mask.data) };
}

/** Restores a {@link SerializedSelection}; throws on damaged data. */
export function deserializeSelection(value: unknown): SelectionMask {
  if (!value || typeof value !== 'object') throw new Error('selection must be an object');
  const v = value as Record<string, unknown>;
  const width = v.width as number;
  const height = v.height as number;
  checkSize(width, height);
  return createSelectionMask(width, height, decodeSelectionRle(v.rle as string, width * height));
}

/** A short, stable hash of a string or bytes (FNV-1a, 32-bit, hex) for cache keys. */
export function hashMaskContent(content: string | Uint8Array): string {
  let h = 0x811c9dc5;
  if (typeof content === 'string') {
    for (let i = 0; i < content.length; i++) {
      h ^= content.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  } else {
    for (let i = 0; i < content.length; i++) {
      h ^= content[i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return `${(h >>> 0).toString(16)}:${content.length}`;
}
