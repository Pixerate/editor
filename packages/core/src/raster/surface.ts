// Portions ported from photocraft/crates/raster/src/lib.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Tiled, sparse, copy-on-write pixel storage (photocraft's `Surface`): 256 px square tiles in a
 * map keyed by tile coordinate, a default value for every missing tile, and shared tiles.
 *
 * - Pixels are 8-bit, straight alpha: RGBA for layers (4 channels, the same as `ImageData`), one
 *   byte for masks.
 * - A surface is never mutated. A write returns a new surface that shares every tile it did not
 *   touch, so undo history and caches can keep old surfaces by reference.
 * - A tile whose pixels all hold one value is a *uniform* tile; one instance per value is shared,
 *   so a solid fill or a "hide all" mask costs one tile however large it is.
 * - Coordinates are document pixels and may be negative or past the canvas (layers can extend
 *   beyond it, as PSD layer rects do).
 *
 * The module has no DOM dependency, so it runs in Node, tests and workers.
 */

/** A pixel rectangle (`x`, `y` of the top-left corner, `width`, `height`). */
export interface RasterRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
type CropBox = RasterRect;

export const TILE = 256;
export const TILE_SHIFT = 8;
const TILE_PIXELS = TILE * TILE;
const KEY_OFFSET = 1 << 15;
const KEY_SPAN = 1 << 16;

/** A tile coordinate packed into one number (tx, ty in −32768..32767). */
export type TileKey = number;

export function tileKey(tx: number, ty: number): TileKey {
  return (ty + KEY_OFFSET) * KEY_SPAN + (tx + KEY_OFFSET);
}

export function tileCoord(key: TileKey): { tx: number; ty: number } {
  return { tx: (key % KEY_SPAN) - KEY_OFFSET, ty: Math.floor(key / KEY_SPAN) - KEY_OFFSET };
}

/** A tile's pixel rectangle in document space. */
export function tileRect(tx: number, ty: number): CropBox {
  return { x: tx * TILE, y: ty * TILE, width: TILE, height: TILE };
}

/** One tile: TILE × TILE pixels of `channels` bytes. Never mutate `data` after it is shared. */
export interface Tile {
  readonly data: Uint8ClampedArray;
  /** The packed value of every pixel when the tile is uniform, else `null`. */
  readonly uniform: number | null;
}

let nextSurfaceId = 1;

/**
 * An immutable tiled surface. `channels` is 4 (RGBA) for layers and 1 for masks. Missing tiles
 * hold `defaultValue` in every byte (0: transparent black for layers; 0 or 255 for masks).
 */
export class TiledSurface {
  /** Unique per instance: a cache key that changes whenever the pixels can have changed. */
  readonly id = nextSurfaceId++;
  private boundsCache: CropBox | null | undefined;

  constructor(
    readonly channels: 1 | 4,
    readonly tiles: ReadonlyMap<TileKey, Tile>,
    readonly defaultValue = 0
  ) {}

  /** Bounds of the stored (non-default) tiles, tile-aligned; `null` when there are none. */
  get bounds(): CropBox | null {
    if (this.boundsCache === undefined) this.boundsCache = tileUnion(this.tiles.keys());
    return this.boundsCache;
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  getTile(tx: number, ty: number): Tile | undefined {
    return this.tiles.get(tileKey(tx, ty));
  }
}

export type PixelSurface = TiledSurface;
export type MaskSurface = TiledSurface;

function tileUnion(keys: Iterable<TileKey>): CropBox | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const key of keys) {
    const { tx, ty } = tileCoord(key);
    if (tx < x0) x0 = tx;
    if (ty < y0) y0 = ty;
    if (tx > x1) x1 = tx;
    if (ty > y1) y1 = ty;
  }
  if (x0 === Infinity) return null;
  return { x: x0 * TILE, y: y0 * TILE, width: (x1 - x0 + 1) * TILE, height: (y1 - y0 + 1) * TILE };
}

// ---------------------------------------------------------------------------
// Uniform tiles
// ---------------------------------------------------------------------------

const uniformTiles = new Map<string, Tile>();
const UNIFORM_LIMIT = 64;

/** Packs one pixel (`channels` bytes from `data` at `offset`) into a number. */
function packPixel(data: ArrayLike<number>, offset: number, channels: number): number {
  return channels === 1
    ? data[offset]
    : ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

/** The shared tile whose every pixel is `value` (packed RGBA, or one byte for masks). */
export function uniformTile(channels: 1 | 4, value: number): Tile {
  const key = `${channels}:${value}`;
  let tile = uniformTiles.get(key);
  if (tile) return tile;
  const data = new Uint8ClampedArray(TILE_PIXELS * channels);
  if (channels === 1) data.fill(value);
  else if (value !== 0) {
    const r = value >>> 24;
    const g = (value >>> 16) & 255;
    const b = (value >>> 8) & 255;
    const a = value & 255;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  tile = { data, uniform: value };
  if (uniformTiles.size >= UNIFORM_LIMIT) uniformTiles.delete(uniformTiles.keys().next().value as string);
  uniformTiles.set(key, tile);
  return tile;
}

/** Packs an RGBA colour (0..255 each) the way uniform tiles store it. */
export function packRgba(r: number, g: number, b: number, a: number): number {
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

function defaultPacked(channels: 1 | 4, defaultValue: number): number {
  return channels === 1 ? defaultValue : packRgba(defaultValue, defaultValue, defaultValue, defaultValue);
}

/** The packed value when every pixel of `data` is the same, else `null`. */
function uniformValue(data: Uint8ClampedArray, channels: 1 | 4): number | null {
  if (channels === 1) {
    const v = data[0];
    for (let i = 1; i < data.length; i++) if (data[i] !== v) return null;
    return v;
  }
  const words = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
  const w = words[0];
  for (let i = 1; i < words.length; i++) if (words[i] !== w) return null;
  return packPixel(data, 0, 4);
}

/**
 * Turns freshly written tile data into a stored tile: `null` when it equals the surface default
 * (the tile is dropped), the shared uniform tile when it is uniform, else a tile owning `data`.
 */
export function finishTile(data: Uint8ClampedArray, channels: 1 | 4, defaultValue: number): Tile | null {
  const u = uniformValue(data, channels);
  if (u === null) return { data, uniform: null };
  if (u === defaultPacked(channels, defaultValue)) return null;
  return uniformTile(channels, u);
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** An empty surface (every pixel is `defaultValue`). */
export function emptySurface(channels: 1 | 4 = 4, defaultValue = 0): TiledSurface {
  return new TiledSurface(channels, new Map(), defaultValue);
}

/** A surface filled with one value over `rect` (packed RGBA for layers, a byte for masks). */
export function solidSurface(channels: 1 | 4, rect: CropBox, value: number, defaultValue = 0): TiledSurface {
  const bytes = new Uint8ClampedArray(channels);
  if (channels === 1) bytes[0] = value;
  else {
    bytes[0] = value >>> 24;
    bytes[1] = (value >>> 16) & 255;
    bytes[2] = (value >>> 8) & 255;
    bytes[3] = value & 255;
  }
  return fillRect(emptySurface(channels, defaultValue), rect, bytes);
}

/**
 * A surface holding `width × height` interleaved pixels placed at (`x`, `y`) in document space.
 * Tiles equal to the default are left out; uniform tiles are shared.
 */
export function surfaceFromPixels(
  pixels: { width: number; height: number; data: ArrayLike<number> },
  channels: 1 | 4 = 4,
  x = 0,
  y = 0,
  defaultValue = 0
): TiledSurface {
  return writeRegion(emptySurface(channels, defaultValue), { x, y, width: pixels.width, height: pixels.height }, pixels.data);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Tile coordinates covering `rect`, row by row. */
export function tilesInRect(rect: CropBox): Array<{ tx: number; ty: number }> {
  const out: Array<{ tx: number; ty: number }> = [];
  if (rect.width <= 0 || rect.height <= 0) return out;
  const tx0 = Math.floor(rect.x / TILE);
  const ty0 = Math.floor(rect.y / TILE);
  const tx1 = Math.floor((rect.x + rect.width - 1) / TILE);
  const ty1 = Math.floor((rect.y + rect.height - 1) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push({ tx, ty });
  return out;
}

/**
 * Copies `rect` of the surface into `out` (or a new buffer), `rect.width × rect.height`
 * interleaved pixels; missing tiles read as the default.
 */
export function readRegion(surface: TiledSurface, rect: CropBox, out?: Uint8ClampedArray): Uint8ClampedArray {
  const ch = surface.channels;
  const w = rect.width;
  const h = rect.height;
  const dst = out ?? new Uint8ClampedArray(w * h * ch);
  if (surface.defaultValue !== 0) dst.fill(surface.defaultValue);
  else if (out) dst.fill(0);
  for (const { tx, ty } of tilesInRect(rect)) {
    const tile = surface.getTile(tx, ty);
    if (!tile) continue;
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
      dst.set(tile.data.subarray(s, s + span), d);
    }
  }
  return dst;
}

/** One pixel's bytes (RGBA or the mask byte). */
export function readPixel(surface: TiledSurface, x: number, y: number): number[] {
  const tile = surface.getTile(Math.floor(x / TILE), Math.floor(y / TILE));
  const ch = surface.channels;
  if (!tile) return new Array(ch).fill(surface.defaultValue);
  const i = (((y & (TILE - 1)) * TILE) + (x & (TILE - 1))) * ch;
  return Array.from(tile.data.subarray(i, i + ch));
}

/**
 * Exact bounds of the pixels that differ from the default (for a layer: non-transparent), or
 * `null`. Scans the stored tiles; uniform tiles count whole.
 */
export function contentBounds(surface: TiledSurface): CropBox | null {
  const ch = surface.channels;
  const def = surface.defaultValue;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [key, tile] of surface.tiles) {
    const { tx, ty } = tileCoord(key);
    const ox = tx * TILE;
    const oy = ty * TILE;
    if (tile.uniform !== null) {
      if (ox < x0) x0 = ox;
      if (oy < y0) y0 = oy;
      if (ox + TILE - 1 > x1) x1 = ox + TILE - 1;
      if (oy + TILE - 1 > y1) y1 = oy + TILE - 1;
      continue;
    }
    const d = tile.data;
    for (let y = 0; y < TILE; y++) {
      let first = -1;
      let last = -1;
      const row = y * TILE * ch;
      for (let x = 0; x < TILE; x++) {
        const i = row + x * ch;
        let differs = false;
        for (let c = 0; c < ch; c++) if (d[i + c] !== def) differs = true;
        if (differs) {
          if (first < 0) first = x;
          last = x;
        }
      }
      if (first < 0) continue;
      if (ox + first < x0) x0 = ox + first;
      if (ox + last > x1) x1 = ox + last;
      if (oy + y < y0) y0 = oy + y;
      if (oy + y > y1) y1 = oy + y;
    }
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// ---------------------------------------------------------------------------
// Writing (copy-on-write)
// ---------------------------------------------------------------------------

/**
 * A private, mutable copy of the tiles a write touches. `tile(tx, ty)` copies the tile on first
 * use; `commit()` returns a new surface sharing every untouched tile. Use it for strokes:
 * edit through the draft while the pointer moves and commit once at pointer-up.
 */
export class SurfaceDraft {
  private readonly copies = new Map<TileKey, Uint8ClampedArray>();

  constructor(readonly base: TiledSurface) {}

  get channels(): 1 | 4 {
    return this.base.channels;
  }

  /** The writable data of tile (tx, ty), copied from the base on first use. */
  tile(tx: number, ty: number): Uint8ClampedArray {
    const key = tileKey(tx, ty);
    let data = this.copies.get(key);
    if (data) return data;
    const src = this.base.tiles.get(key);
    if (src) data = new Uint8ClampedArray(src.data);
    else {
      data = new Uint8ClampedArray(TILE_PIXELS * this.base.channels);
      if (this.base.defaultValue !== 0) data.fill(this.base.defaultValue);
    }
    this.copies.set(key, data);
    return data;
  }

  /** Replaces a whole tile with `data` (owned by the draft from now on). */
  replace(tx: number, ty: number, data: Uint8ClampedArray): void {
    this.copies.set(tileKey(tx, ty), data);
  }

  /** The current data of a tile without copying it (base tile, draft copy or `null` for default). */
  peek(tx: number, ty: number): Uint8ClampedArray | null {
    const key = tileKey(tx, ty);
    return this.copies.get(key) ?? this.base.tiles.get(key)?.data ?? null;
  }

  /** Keys of the tiles changed so far. */
  get touched(): TileKey[] {
    return [...this.copies.keys()];
  }

  /** A new surface with the draft's tiles; the draft must not be used afterwards. */
  commit(): TiledSurface {
    if (!this.copies.size) return this.base;
    const tiles = new Map(this.base.tiles);
    const { channels, defaultValue } = this.base;
    for (const [key, data] of this.copies) {
      const tile = finishTile(data, channels, defaultValue);
      if (tile) tiles.set(key, tile);
      else tiles.delete(key);
    }
    return new TiledSurface(channels, tiles, defaultValue);
  }
}

/** Writes `rect.width × rect.height` interleaved pixels at `rect`; returns the new surface. */
export function writeRegion(surface: TiledSurface, rect: CropBox, data: ArrayLike<number>): TiledSurface {
  const ch = surface.channels;
  const w = rect.width;
  const h = rect.height;
  if (w <= 0 || h <= 0) return surface;
  if (data.length < w * h * ch) throw new Error(`writeRegion: expected ${w * h * ch} bytes, got ${data.length}`);
  const draft = new SurfaceDraft(surface);
  const src = data as Uint8ClampedArray;
  const canSubarray = typeof (src as Uint8ClampedArray).subarray === 'function';
  for (const { tx, ty } of tilesInRect(rect)) {
    const ox = tx * TILE;
    const oy = ty * TILE;
    const x0 = Math.max(rect.x, ox);
    const y0 = Math.max(rect.y, oy);
    const x1 = Math.min(rect.x + w, ox + TILE);
    const y1 = Math.min(rect.y + h, oy + TILE);
    const full = x0 === ox && y0 === oy && x1 === ox + TILE && y1 === oy + TILE;
    const t = full ? new Uint8ClampedArray(TILE_PIXELS * ch) : draft.tile(tx, ty);
    const span = (x1 - x0) * ch;
    for (let yy = y0; yy < y1; yy++) {
      const s = ((yy - rect.y) * w + (x0 - rect.x)) * ch;
      const d = ((yy - oy) * TILE + (x0 - ox)) * ch;
      if (canSubarray) t.set(src.subarray(s, s + span), d);
      else for (let k = 0; k < span; k++) t[d + k] = src[s + k];
    }
    if (full) draft.replace(tx, ty, t);
  }
  return draft.commit();
}

/** Fills `rect` with one pixel value (`bytes`, `channels` long). */
export function fillRect(surface: TiledSurface, rect: CropBox, bytes: ArrayLike<number>): TiledSurface {
  const ch = surface.channels;
  if (rect.width <= 0 || rect.height <= 0) return surface;
  const tiles = new Map(surface.tiles);
  const draft = new SurfaceDraft(surface);
  const value = packPixel(bytes, 0, ch);
  const isDefault = value === defaultPacked(ch, surface.defaultValue);
  for (const { tx, ty } of tilesInRect(rect)) {
    const ox = tx * TILE;
    const oy = ty * TILE;
    const x0 = Math.max(rect.x, ox);
    const y0 = Math.max(rect.y, oy);
    const x1 = Math.min(rect.x + rect.width, ox + TILE);
    const y1 = Math.min(rect.y + rect.height, oy + TILE);
    const key = tileKey(tx, ty);
    if (x0 === ox && y0 === oy && x1 === ox + TILE && y1 === oy + TILE) {
      if (isDefault) tiles.delete(key);
      else tiles.set(key, uniformTile(ch, value));
      continue;
    }
    const t = draft.tile(tx, ty);
    for (let yy = y0; yy < y1; yy++) {
      let d = ((yy - oy) * TILE + (x0 - ox)) * ch;
      for (let xx = x0; xx < x1; xx++, d += ch) for (let c = 0; c < ch; c++) t[d + c] = bytes[c];
    }
    const tile = finishTile(t, ch, surface.defaultValue);
    if (tile) tiles.set(key, tile);
    else tiles.delete(key);
  }
  return new TiledSurface(ch, tiles, surface.defaultValue);
}

/** A copy of the surface moved by an integer offset (re-tiles; layers normally move by `offset`). */
export function translateSurface(surface: TiledSurface, dx: number, dy: number): TiledSurface {
  dx = Math.round(dx);
  dy = Math.round(dy);
  if (!dx && !dy) return surface;
  if (dx % TILE === 0 && dy % TILE === 0) {
    const tiles = new Map<TileKey, Tile>();
    for (const [key, tile] of surface.tiles) {
      const { tx, ty } = tileCoord(key);
      tiles.set(tileKey(tx + dx / TILE, ty + dy / TILE), tile);
    }
    return new TiledSurface(surface.channels, tiles, surface.defaultValue);
  }
  const b = surface.bounds;
  if (!b) return surface;
  const data = readRegion(surface, b);
  return writeRegion(emptySurface(surface.channels, surface.defaultValue), { ...b, x: b.x + dx, y: b.y + dy }, data);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/** Bytes held by a surface's non-uniform tiles (uniform tiles are shared and nearly free). */
export function surfaceBytes(surface: TiledSurface): number {
  let n = 0;
  for (const tile of surface.tiles.values()) if (tile.uniform === null) n += tile.data.byteLength;
  return n;
}

/** Adds every non-uniform tile of `surface` to `into` (for counting bytes shared across states). */
export function collectTiles(surface: TiledSurface, into: Set<Tile>): void {
  for (const tile of surface.tiles.values()) if (tile.uniform === null) into.add(tile);
}

/** True when two surfaces hold the same pixels (cheap when they share tiles). */
export function surfacesEqual(a: TiledSurface, b: TiledSurface): boolean {
  if (a === b) return true;
  if (a.channels !== b.channels || a.defaultValue !== b.defaultValue || a.tiles.size !== b.tiles.size) return false;
  for (const [key, ta] of a.tiles) {
    const tb = b.tiles.get(key);
    if (!tb) return false;
    if (ta === tb) continue;
    if (ta.uniform !== null || tb.uniform !== null) {
      if (ta.uniform !== tb.uniform) return false;
      continue;
    }
    const x = ta.data;
    const y = tb.data;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}
