/**
 * Showing a tiled surface in a pannable, zoomable view (an infinite canvas): world ↔ surface
 * mapping with a resolution policy, the surface rectangle a view can see, and drawing a surface
 * onto a 2D context with visible-tile culling and mip levels. Hosts bring the 2D context and a
 * canvas factory, so this module stays free of any browser API.
 *
 * Coordinates: **world** units are the host's (a node canvas's flow units). **Surface** pixels are
 * the tiled surface's; surface pixel (0, 0) sits at world `origin` and one world unit is
 * `pixelsPerUnit` surface pixels. **Screen** pixels follow the view as xyflow defines it:
 * `screen = world × zoom + (x, y)`.
 */

import { TILE, tileCoord, tileKey, type RasterRect, type Tile, type TiledSurface } from './surface';

/** Where a surface lies in the world. */
export interface SurfaceMapping {
  /** World position of surface pixel (0, 0) (default 0, 0). */
  origin?: { x: number; y: number };
  /** Surface pixels per world unit (default 1). */
  pixelsPerUnit?: number;
}

/** A pan / zoom view: `screen = world × zoom + (x, y)` (the xyflow viewport). */
export interface ViewTransform {
  x: number;
  y: number;
  zoom: number;
}

const ppuOf = (m: SurfaceMapping) => (m.pixelsPerUnit && m.pixelsPerUnit > 0 ? m.pixelsPerUnit : 1);

/** A world point in surface pixels. */
export function worldToSurface(mapping: SurfaceMapping, x: number, y: number): { x: number; y: number } {
  const k = ppuOf(mapping);
  return { x: (x - (mapping.origin?.x ?? 0)) * k, y: (y - (mapping.origin?.y ?? 0)) * k };
}

/** A surface pixel position in world units. */
export function surfaceToWorld(mapping: SurfaceMapping, x: number, y: number): { x: number; y: number } {
  const k = ppuOf(mapping);
  return { x: x / k + (mapping.origin?.x ?? 0), y: y / k + (mapping.origin?.y ?? 0) };
}

/** A world rectangle as the whole surface pixels it touches. */
export function worldRectToSurface(mapping: SurfaceMapping, rect: { x: number; y: number; width: number; height: number }): RasterRect {
  const a = worldToSurface(mapping, rect.x, rect.y);
  const b = worldToSurface(mapping, rect.x + rect.width, rect.y + rect.height);
  const x = Math.floor(Math.min(a.x, b.x));
  const y = Math.floor(Math.min(a.y, b.y));
  return { x, y, width: Math.ceil(Math.max(a.x, b.x)) - x, height: Math.ceil(Math.max(a.y, b.y)) - y };
}

/** A screen point (relative to the view's element) in world units. */
export function screenToWorld(view: ViewTransform, x: number, y: number): { x: number; y: number } {
  const z = view.zoom > 0 ? view.zoom : 1;
  return { x: (x - view.x) / z, y: (y - view.y) / z };
}

/** The world rectangle a `width × height` screen area shows. */
export function visibleWorldRect(view: ViewTransform, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const a = screenToWorld(view, 0, 0);
  const z = view.zoom > 0 ? view.zoom : 1;
  return { x: a.x, y: a.y, width: width / z, height: height / z };
}

/** The surface pixels a `width × height` screen area shows (pad by `margin` surface pixels). */
export function visibleSurfaceRect(mapping: SurfaceMapping, view: ViewTransform, width: number, height: number, margin = 0): RasterRect {
  const r = worldRectToSurface(mapping, visibleWorldRect(view, width, height));
  return { x: r.x - margin, y: r.y - margin, width: r.width + 2 * margin, height: r.height + 2 * margin };
}

export interface ResolutionPolicy {
  /** Screen pixel density (default 1). */
  devicePixelRatio?: number;
  /** Fewest surface pixels per world unit (default 1/4). */
  min?: number;
  /** Most surface pixels per world unit (default 8). */
  max?: number;
}

/**
 * The surface density (pixels per world unit) for painting at `zoom`: the screen density rounded
 * up to a power of two and clamped, so strokes are never coarser than the screen and nearby
 * zooms share a density. Use it when creating a surface (or a level of one) for the current view.
 */
export function surfaceResolutionForZoom(zoom: number, policy: ResolutionPolicy = {}): number {
  const s = zoom * (policy.devicePixelRatio && policy.devicePixelRatio > 0 ? policy.devicePixelRatio : 1);
  const min = policy.min && policy.min > 0 ? policy.min : 1 / 4;
  const max = policy.max && policy.max > 0 ? policy.max : 8;
  if (!Number.isFinite(s) || s <= 0) return Math.min(max, Math.max(min, 1));
  return Math.min(max, Math.max(min, Math.pow(2, Math.ceil(Math.log2(s) - 1e-9))));
}

/**
 * The mip level to draw a surface at: 0 at or above half a screen pixel per surface pixel, then
 * one level per halving (each level halves the resolution), at most `maxLevel`.
 */
export function surfaceMipLevel(screenPixelsPerSurfacePixel: number, maxLevel = 4): number {
  const s = screenPixelsPerSurfacePixel;
  if (!(s > 0) || s >= 0.5) return 0;
  return Math.min(maxLevel, Math.floor(Math.log2(1 / s)));
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** The 2D context `drawSurfaceToViewport` draws on (a canvas 2D context, structurally). */
export interface ViewportContext2D {
  drawImage(image: never, dx: number, dy: number, dw: number, dh: number): void;
  imageSmoothingEnabled?: boolean;
}

/** A canvas the renderer makes tile images on (a canvas element or an offscreen canvas, structurally). */
export interface TileCanvasLike {
  getContext(type: '2d'): { createImageData(w: number, h: number): { data: Uint8ClampedArray }; putImageData(image: never, x: number, y: number): void } | null;
}

export interface DrawSurfaceOptions {
  /** View area in screen pixels (the canvas's CSS size). */
  width: number;
  height: number;
  /** Highest mip level (default 4: down to 1/16 resolution). */
  maxMipLevel?: number;
  /** Smooth scaling (default: true when zoomed out, false when a surface pixel covers 2+ screen pixels). */
  smoothing?: boolean;
}

export interface DrawSurfaceStats {
  level: number;
  /** Tiles drawn (at that level). */
  drawn: number;
  /** Tile images made this call (the rest came from the cache). */
  built: number;
}

/** Box-filters `n × n` blocks of straight-alpha RGBA (premultiplied while averaging). */
function downsampleInto(src: Uint8ClampedArray, n: number, out: Uint8ClampedArray, ox: number, oy: number): void {
  const side = TILE / n;
  const area = n * n;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < n; dy++) {
        let i = ((y * n + dy) * TILE + x * n) * 4;
        for (let dx = 0; dx < n; dx++, i += 4) {
          const al = src[i + 3];
          r += src[i] * al;
          g += src[i + 1] * al;
          b += src[i + 2] * al;
          a += al;
        }
      }
      const o = ((oy + y) * TILE + ox + x) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
        out[o + 3] = a / area;
      }
    }
  }
}

/**
 * Draws tiled surfaces onto 2D contexts, keeping a cache of tile images: level-0 images by tile
 * identity (tiles are copy-on-write, so an edited tile is a new object), mip images by the tiles
 * they were built from. One renderer per surface you show; `clear` drops the cache.
 */
export class SurfaceViewportRenderer<C extends TileCanvasLike = TileCanvasLike> {
  private readonly base = new WeakMap<Tile, C>();
  private readonly mips = new Map<string, { sources: (Tile | undefined)[]; canvas: C }>();
  private readonly uniform = new Map<number, C>();

  /** `createCanvas(256, 256)` makes the tile images (inject a canvas element or offscreen canvas). */
  constructor(private readonly createCanvas: (width: number, height: number) => C) {}

  clear(): void {
    this.mips.clear();
    this.uniform.clear();
  }

  private image(data: ArrayLike<number>): C | null {
    const canvas = this.createCanvas(TILE, TILE);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(TILE, TILE);
    img.data.set(data);
    ctx.putImageData(img as never, 0, 0);
    return canvas;
  }

  private tileImage(tile: Tile): C | null {
    let c = this.base.get(tile);
    if (!c) {
      const img = this.image(tile.data);
      if (!img) return null;
      c = img;
      this.base.set(tile, c);
    }
    return c;
  }

  private uniformImage(value: number): C | null {
    let c = this.uniform.get(value);
    if (!c) {
      const data = new Uint8ClampedArray(TILE * TILE * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = (value >>> 24) & 255;
        data[i + 1] = (value >>> 16) & 255;
        data[i + 2] = (value >>> 8) & 255;
        data[i + 3] = value & 255;
      }
      const img = this.image(data);
      if (!img) return null;
      c = img;
      this.uniform.set(value, c);
    }
    return c;
  }

  private mipImage(surface: TiledSurface, level: number, mx: number, my: number): C | null {
    const n = 1 << level;
    const sources: (Tile | undefined)[] = [];
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) sources.push(surface.tiles.get(tileKey(mx * n + dx, my * n + dy)));
    if (sources.every((t) => !t)) return null;
    const key = `${level}:${mx}:${my}`;
    const hit = this.mips.get(key);
    if (hit && hit.sources.length === sources.length && hit.sources.every((t, i) => t === sources[i])) return hit.canvas;
    const out = new Uint8ClampedArray(TILE * TILE * 4);
    const side = TILE / n;
    const blank = surface.defaultValue ? this.defaultTileData(surface.defaultValue) : null;
    sources.forEach((t, i) => {
      const src = t?.data ?? blank;
      if (src && src.length === TILE * TILE * 4) downsampleInto(src as Uint8ClampedArray, n, out, (i % n) * side, Math.floor(i / n) * side);
    });
    const canvas = this.image(out);
    if (!canvas) return null;
    this.mips.set(key, { sources, canvas });
    return canvas;
  }

  private defaultTileData(value: number): Uint8ClampedArray {
    const data = new Uint8ClampedArray(TILE * TILE * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (value >>> 24) & 255;
      data[i + 1] = (value >>> 16) & 255;
      data[i + 2] = (value >>> 8) & 255;
      data[i + 3] = value & 255;
    }
    return data;
  }

  /**
   * Draws the part of an RGBA `surface` (placed by `mapping`) that `view` shows onto `ctx`, tile
   * by tile: only visible tiles, at the mip level the zoom calls for, at whole screen pixels so
   * tiles meet without seams. Does not clear `ctx` first.
   */
  draw(ctx: ViewportContext2D, surface: TiledSurface, mapping: SurfaceMapping, view: ViewTransform, options: DrawSurfaceOptions): DrawSurfaceStats {
    if (surface.channels !== 4) throw new Error('drawSurfaceToViewport draws RGBA surfaces (4 channels).');
    const ppu = ppuOf(mapping);
    const zoom = view.zoom > 0 ? view.zoom : 1;
    const screenPerPixel = zoom / ppu;
    const level = surfaceMipLevel(screenPerPixel, options.maxMipLevel ?? 4);
    const span = TILE << level; // surface pixels per drawn tile
    const visible = visibleSurfaceRect(mapping, view, options.width, options.height);
    const tx0 = Math.floor(visible.x / span);
    const ty0 = Math.floor(visible.y / span);
    const tx1 = Math.floor((visible.x + visible.width - 1) / span);
    const ty1 = Math.floor((visible.y + visible.height - 1) / span);
    ctx.imageSmoothingEnabled = options.smoothing ?? screenPerPixel < 2;
    const ox = (mapping.origin?.x ?? 0) * zoom + view.x;
    const oy = (mapping.origin?.y ?? 0) * zoom + view.y;
    let drawn = 0;
    let built = 0;
    // Visit the grid cells in view, or (zoomed far out over sparse paint) only the cells that hold tiles.
    const keys: Array<[number, number]> = [];
    if (!surface.defaultValue && surface.tiles.size < (tx1 - tx0 + 1) * (ty1 - ty0 + 1)) {
      const seen = new Set<string>();
      for (const key of surface.tiles.keys()) {
        const c = tileCoord(key);
        const mx = Math.floor(c.tx / (1 << level));
        const my = Math.floor(c.ty / (1 << level));
        if (mx < tx0 || mx > tx1 || my < ty0 || my > ty1 || seen.has(`${mx},${my}`)) continue;
        seen.add(`${mx},${my}`);
        keys.push([mx, my]);
      }
    } else {
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) keys.push([tx, ty]);
    }
    for (const [tx, ty] of keys) {
      let canvas: C | null = null;
      if (level === 0) {
        const tile = surface.tiles.get(tileKey(tx, ty));
        if (tile) {
          const had = this.base.has(tile);
          canvas = this.tileImage(tile);
          if (!had && canvas) built++;
        } else if (surface.defaultValue) canvas = this.uniformImage(surface.defaultValue);
      } else {
        const before = this.mips.size;
        const hitKey = `${level}:${tx}:${ty}`;
        const prev = this.mips.get(hitKey)?.canvas;
        canvas = this.mipImage(surface, level, tx, ty);
        if (canvas && (this.mips.size !== before || canvas !== prev)) built++;
        if (!canvas && surface.defaultValue) canvas = this.uniformImage(surface.defaultValue);
      }
      if (!canvas) continue;
      const sx0 = Math.round(ox + (tx * span * zoom) / ppu);
      const sy0 = Math.round(oy + (ty * span * zoom) / ppu);
      const sx1 = Math.round(ox + ((tx + 1) * span * zoom) / ppu);
      const sy1 = Math.round(oy + ((ty + 1) * span * zoom) / ppu);
      if (sx1 <= sx0 || sy1 <= sy0) continue;
      ctx.drawImage(canvas as never, sx0, sy0, sx1 - sx0, sy1 - sy0);
      drawn++;
    }
    return { level, drawn, built };
  }
}

/**
 * Draws the visible part of an RGBA `surface` onto `ctx` with a `SurfaceViewportRenderer` (pass
 * the same renderer every frame to reuse its tile images). See `SurfaceViewportRenderer.draw`.
 */
export function drawSurfaceToViewport<C extends TileCanvasLike>(
  ctx: ViewportContext2D,
  surface: TiledSurface,
  mapping: SurfaceMapping,
  view: ViewTransform,
  options: DrawSurfaceOptions & { renderer: SurfaceViewportRenderer<C> }
): DrawSurfaceStats {
  return options.renderer.draw(ctx, surface, mapping, view, options);
}
