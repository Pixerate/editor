// Portions ported from photocraft/crates/doc/src/lib.rs (SmartObject, SmartSource, smart filters) (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Smart objects as pure functions: their contents (raster pixels or a nested layer document,
 * shared by linked instances), the non-destructive placement (a warp in the contents' pixels and a
 * projective corner map, the Free Transform geometry), the smart filter stack with its one filter
 * mask, and the rendering that turns them into the layer's pixels. Every change re-renders from
 * the contents, so transforms never degrade.
 *
 * The operations validate against the stack and throw a `LayerOperationError` that says what is
 * wrong before changing anything, like the other layer operations.
 */

import { blendTile } from '../../raster/compositor';
import { gaussianBlur } from '../../raster/blur';
import { MAX_EFFECT_REACH, effectsMargin } from '../../raster/effects/model';
import {
  contentBounds,
  emptySurface,
  readRegion,
  surfaceFromPixels,
  translateSurface,
  type PixelSurface,
  type RasterRect,
} from '../../raster/surface';
import { isInterpolation, reduceSurface, transformSurface, TransformTooLargeError, warpSurface, type Interpolation } from '../../raster/transform';
import { isBlendMode, type BlendMode } from '../../raster/blend';
import { boxQuad, invertHomography, multiplyHomographies, type Homography } from '../../geom/homography';
import { isValidWarpMesh, mapWarpMeshPoints } from '../../geom/warp';
import type { Quad, WarpMesh } from '../../geom/types';
import { hasWarp, transformHomography, transformMap, transformedBox, type FreeTransformGeometry } from '../transform';
import type { CropBox } from '../types';
import { LayerCompositor, runLayerFilters } from './compositor';
import {
  findLayer,
  flattenLayers,
  insertLayer,
  isActiveFilter,
  mapLayer,
  newLayerId,
  type ImageLayer,
  type LayerFilter,
  type PixelLayer,
  type RasterMask,
  type SmartContents,
  type SmartDocument,
  type SmartFilter,
  type SmartFilterStack,
  type SmartObjectLayer,
  type SmartPlacement,
} from './model';
import { LayerOperationError, normalizeFilter, requireLayer, requireUnlocked } from './ops';

const fail = (message: string): never => {
  throw new LayerOperationError(message);
};

/**
 * How far beyond the canvas a smart object is rendered (document pixels): enough for any layer
 * effect to see the parts just outside the canvas. Further out a smart object is not drawn.
 */
export const SMART_RENDER_MARGIN = MAX_EFFECT_REACH;

/** The document canvas a smart object renders for. */
export interface SmartCanvas {
  width: number;
  height: number;
}

/** A fresh contents id (independent contents). */
export function newContentsId(): string {
  return newLayerId('so');
}

/** The contents' rectangle in its own pixels. */
export function contentsBox(contents: SmartContents): CropBox {
  return { x: 0, y: 0, width: contents.width, height: contents.height };
}

/** A smart object's placement as Free Transform geometry (the frame is the contents' rectangle). */
export function placementGeometry(layer: Pick<SmartObjectLayer, 'contents' | 'placement'>): FreeTransformGeometry {
  return { box: contentsBox(layer.contents), corners: layer.placement.corners, warp: layer.placement.warp ?? null };
}

/** The placement that draws the contents 1:1 with their top-left corner at (`x`, `y`). */
export function placementAt(contents: Pick<SmartContents, 'width' | 'height'>, x: number, y: number): SmartPlacement {
  return { corners: boxQuad({ x, y, width: contents.width, height: contents.height }) };
}

/** Whether the contents can be rendered here (decoded pixels or a layer document). */
export function isContentsDecoded(contents: SmartContents): boolean {
  return contents.kind === 'raster' ? Boolean(contents.raster) : Boolean(contents.document);
}

function requireDecoded(layer: SmartObjectLayer, action: string): void {
  if (isContentsDecoded(layer.contents)) return;
  const what = layer.contents.file?.type ? `a ${layer.contents.file.type.toUpperCase()} file` : 'a file';
  fail(
    `The contents of smart object "${layer.name || layer.id}" are ${what} that could not be decoded here, so it cannot ${action}. ` +
      'Run prepareSmartObjects() in a browser first, or rasterize it.'
  );
}

/** The layer with `id`, which must be a smart object. */
export function requireSmartObject(layers: readonly ImageLayer[], id: string): SmartObjectLayer {
  const layer = requireLayer(layers, id).layer;
  if (layer.type !== 'smart') fail(`Layer "${layer.name || id}" is a ${layer.type} layer, not a smart object; convert it with convert_to_smart_object.`);
  return layer as SmartObjectLayer;
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

const contentsPixels = new WeakMap<SmartContents, PixelSurface>();

/**
 * The contents as pixels at (0, 0) in their own space: the raster, or the nested document
 * composited at its size (annotation layers inside need a canvas and are left out). Memoised.
 */
export function contentsSurface(contents: SmartContents): PixelSurface {
  let s = contentsPixels.get(contents);
  if (s) return s;
  if (contents.kind === 'raster') {
    s = contents.raster ?? emptySurface(4);
  } else {
    const doc = contents.document;
    if (!doc) return emptySurface(4);
    const W = contents.width;
    const H = contents.height;
    const data = new LayerCompositor().composite(doc.layers, { x: 0, y: 0, width: W, height: H }, {
      width: W,
      height: H,
      globalLight: doc.globalLight,
      pattern: (id) => doc.patterns?.find((p) => p.id === id) ?? null,
    });
    s = surfaceFromPixels({ width: W, height: H, data }, 4, 0, 0);
  }
  contentsPixels.set(contents, s);
  return s;
}

/** Raster contents from RGBA pixels. */
export function rasterContents(pixels: { width: number; height: number; data: ArrayLike<number> }, name: string, id = newContentsId()): SmartContents {
  if (!(pixels.width > 0 && pixels.height > 0) || pixels.data.length < pixels.width * pixels.height * 4) fail('Contents pixels must be RGBA with width × height × 4 bytes.');
  return { id, name, width: pixels.width, height: pixels.height, kind: 'raster', raster: surfaceFromPixels(pixels, 4, 0, 0) };
}

/** Document contents from layers on a `width × height` canvas. */
export function documentContents(document: SmartDocument, width: number, height: number, name: string, id = newContentsId()): SmartContents {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) fail('Contents width and height must be positive whole numbers.');
  return { id, name, width, height, kind: 'document', document };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** How a render runs: full quality (default), or a fast preview. */
export interface SmartRenderOptions {
  /** Preview block size (a power of two): sample a reduced copy of the contents once per block. */
  step?: number;
  /** Only this part of the document (the visible area). */
  clip?: RasterRect;
  /** Leave the smart filters out (previews while transforming). */
  skipFilters?: boolean;
  /** Reduced copies of the contents by factor, kept by the caller between previews. */
  reduced?: Map<number, PixelSurface>;
}

const placedCache = new WeakMap<SmartContents, Map<string, PixelSurface>>();
const filteredCache = new WeakMap<PixelSurface, { key: string; base: Uint8ClampedArray; filtered: Uint8ClampedArray }>();

function placementKey(p: SmartPlacement, canvas: SmartCanvas): string {
  return JSON.stringify([p.corners, p.warp ?? null, p.interpolation ?? 'bicubic', canvas.width, canvas.height]);
}

/** The integer move of a placement that is a whole-pixel translation without a warp, or `null`. */
function integerMove(layer: Pick<SmartObjectLayer, 'contents' | 'placement'>): { x: number; y: number } | null {
  const g = placementGeometry(layer);
  if (hasWarp(g)) return null;
  const q = boxQuad(g.box);
  const dx = g.corners[0].x - q[0].x;
  const dy = g.corners[0].y - q[0].y;
  if (Math.abs(dx - Math.round(dx)) > 1e-9 || Math.abs(dy - Math.round(dy)) > 1e-9) return null;
  const same = g.corners.every((c, i) => Math.abs(c.x - q[i].x - dx) < 1e-9 && Math.abs(c.y - q[i].y - dy) < 1e-9);
  return same ? { x: Math.round(dx), y: Math.round(dy) } : null;
}

/** The contents placed in the document (no filters), clipped to the canvas grown by the render margin. */
export function placeContents(layer: Pick<SmartObjectLayer, 'contents' | 'placement'>, canvas: SmartCanvas, options: SmartRenderOptions = {}): PixelSurface {
  const { contents, placement } = layer;
  const preview = Boolean(options.step && options.step > 1) || Boolean(options.clip);
  const key = placementKey(placement, canvas);
  if (!preview) {
    const hit = placedCache.get(contents)?.get(key);
    if (hit) return hit;
  }
  const src = contentsSurface(contents);
  const m = SMART_RENDER_MARGIN;
  const area = { x: -m, y: -m, width: canvas.width + 2 * m, height: canvas.height + 2 * m };
  let clip = area;
  if (options.clip) {
    const c = options.clip;
    const x0 = Math.max(area.x, Math.floor(c.x));
    const y0 = Math.max(area.y, Math.floor(c.y));
    const x1 = Math.min(area.x + area.width, Math.ceil(c.x + c.width));
    const y1 = Math.min(area.y + area.height, Math.ceil(c.y + c.height));
    clip = { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }
  let out: PixelSurface;
  const move = integerMove(layer);
  if (move && !options.clip) {
    // Exact and cheap: a whole-pixel move shares tiles (Convert to Smart Object renders this way).
    out = translateSurface(src, move.x, move.y);
  } else {
    const g = placementGeometry(layer);
    const interpolation: Interpolation = preview ? (placement.interpolation === 'nearest' ? 'nearest' : 'bilinear') : (placement.interpolation ?? 'bicubic');
    const step = options.step && options.step > 1 ? options.step : 1;
    let source = src;
    let k = 1;
    if (step > 1) {
      k = step;
      let r = options.reduced?.get(k);
      if (!r) {
        r = reduceSurface(src, k);
        options.reduced?.set(k, r);
      }
      source = r;
    }
    const box = { x: 0, y: 0, width: Math.ceil(contents.width / k), height: Math.ceil(contents.height / k) };
    try {
      if (hasWarp(g)) {
        const f = transformMap(g);
        if (!f) fail('The placement folds the contents over itself or through the horizon; keep the corners a convex quad.');
        out = warpSurface(source, (p) => f!({ x: p.x * k, y: p.y * k }), { interpolation, source: box, clip, step: step > 1 ? step : undefined });
      } else {
        const h = transformHomography(g);
        if (!h) fail('The placement folds the contents over itself or through the horizon; keep the corners a convex quad.');
        const hk = multiplyHomographies([k, 0, 0, 0, k, 0, 0, 0, 1], h!);
        out = transformSurface(source, hk, { interpolation, source: box, clip, step: step > 1 ? step : undefined });
      }
    } catch (e) {
      if (e instanceof TransformTooLargeError) fail(e.message);
      throw e;
    }
  }
  if (!preview) {
    let byKey = placedCache.get(contents);
    if (!byKey) {
      byKey = new Map();
      placedCache.set(contents, byKey);
    }
    byKey.set(key, out);
    while (byKey.size > 4) byKey.delete(byKey.keys().next().value as string);
  }
  return out;
}

/** The filters of a stack that change pixels (the stack enabled, each filter active, a modelled kind). */
export function activeSmartFilters(stack: SmartFilterStack | undefined): Array<SmartFilter & LayerFilter> {
  if (!stack?.enabled) return [];
  return stack.filters.filter((f): f is SmartFilter & LayerFilter => f.kind !== 'psd' && isActiveFilter(f as LayerFilter) && f.opacity > 0);
}

/** A filter mask's coverage over the canvas (0..1), after density and feather; `null` reveals all. */
export function filterMaskCoverage(mask: RasterMask | undefined, canvas: SmartCanvas): Float32Array | null {
  if (!mask || mask.enabled === false || mask.source) return null;
  const W = canvas.width;
  const H = canvas.height;
  const bytes = readRegion(mask.surface, { x: 0, y: 0, width: W, height: H });
  let v: Float32Array = new Float32Array(W * H);
  let all = true;
  for (let i = 0; i < v.length; i++) {
    v[i] = bytes[i] / 255;
    if (bytes[i] !== 255) all = false;
  }
  const feather = mask.feather ?? 0;
  if (all && !(feather > 0)) return null;
  if (feather > 0) v = gaussianBlur(v, W, H, feather, 'clamp') as Float32Array;
  const density = mask.density ?? 1;
  if (density !== 1) for (let i = 0; i < v.length; i++) v[i] = 1 - density * (1 - v[i]);
  return v;
}

/**
 * Runs a smart filter stack over the placed contents, over the canvas (spatial filters clamp at
 * its edges, as a pixel layer's filters do): each filter filters the result below it, and its own
 * blend mode and opacity mix its result with that input. The filter mask then mixes the filtered
 * result with the unfiltered contents. Returns `placed` itself when no filter is active.
 */
export function applySmartFilters(placed: PixelSurface, stack: SmartFilterStack | undefined, canvas: SmartCanvas): PixelSurface {
  const active = activeSmartFilters(stack);
  if (!active.length || !(canvas.width > 0 && canvas.height > 0)) return placed;
  const W = canvas.width;
  const H = canvas.height;
  const key = JSON.stringify([W, H, active.map((f) => ({ ...f, id: undefined }))]);
  let entry = filteredCache.get(placed);
  if (!entry || entry.key !== key) {
    const base = readRegion(placed, { x: 0, y: 0, width: W, height: H });
    let acc = new Uint8ClampedArray(base);
    for (const f of active) {
      const out = new Uint8ClampedArray(acc);
      runLayerFilters(out, W, H, [f]);
      if (f.blend === 'normal') {
        if (f.opacity >= 1) acc = out;
        else lerpInto(acc, out, f.opacity, null);
      } else {
        blendTile(acc, out, f.blend, f.opacity, null);
      }
    }
    entry = { key, base, filtered: acc };
    filteredCache.set(placed, entry);
  }
  const cov = filterMaskCoverage(stack!.mask, canvas);
  let result = entry.filtered;
  if (cov) {
    result = new Uint8ClampedArray(entry.base);
    lerpInto(result, entry.filtered, 1, cov);
  }
  return surfaceFromPixels({ width: W, height: H, data: result }, 4, 0, 0);
}

/** `dst = lerp(dst, src, k · coverage)` per channel. */
function lerpInto(dst: Uint8ClampedArray, src: Uint8ClampedArray, k: number, coverage: Float32Array | null): void {
  for (let i = 0, p = 0; i < dst.length; i += 4, p++) {
    const t = coverage ? k * coverage[p] : k;
    if (t <= 0) continue;
    if (t >= 1) {
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
      dst[i + 3] = src[i + 3];
      continue;
    }
    for (let c = 0; c < 4; c++) dst[i + c] = Math.round(dst[i + c] + (src[i + c] - dst[i + c]) * t);
  }
}

/** A smart object's pixels: the contents through the placement, then the smart filters. */
export function renderSmartObject(layer: Pick<SmartObjectLayer, 'contents' | 'placement' | 'smartFilters'>, canvas: SmartCanvas, options: SmartRenderOptions = {}): PixelSurface {
  const placed = placeContents(layer, canvas, options);
  return options.skipFilters ? placed : applySmartFilters(placed, layer.smartFilters, canvas);
}

/** The layer with its pixels rendered again (refused when the contents are not decoded). */
export function rerender(layer: SmartObjectLayer, canvas: SmartCanvas, action = 'change'): SmartObjectLayer {
  requireDecoded(layer, action);
  return { ...layer, surface: renderSmartObject(layer, canvas) };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Validates a placement for contents of `width × height`; returns a clean copy. */
export function normalizePlacement(raw: SmartPlacement, contents: Pick<SmartContents, 'width' | 'height'>): SmartPlacement {
  const c = raw?.corners as unknown;
  if (!Array.isArray(c) || c.length !== 4 || !c.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))) {
    fail('corners must be four finite points [top-left, top-right, bottom-right, bottom-left] in document pixels.');
  }
  const out: SmartPlacement = { corners: (c as Quad).map((p) => ({ x: p.x, y: p.y })) as unknown as Quad };
  if (raw.warp) {
    if (!isValidWarpMesh(raw.warp)) fail('warp must be a mesh with us and vs (knots from 0 to 1, increasing) and (3·columns + 1) × (3·rows + 1) finite points in contents pixels.');
    out.warp = { us: [...raw.warp.us], vs: [...raw.warp.vs], points: raw.warp.points.map((p) => ({ x: p.x, y: p.y })) };
  }
  if (raw.interpolation !== undefined) {
    if (!isInterpolation(raw.interpolation)) fail(`Unknown interpolation "${String(raw.interpolation)}"; use nearest, bilinear or bicubic.`);
    if (raw.interpolation !== 'bicubic') out.interpolation = raw.interpolation;
  }
  const g: FreeTransformGeometry = { box: { x: 0, y: 0, width: contents.width, height: contents.height }, corners: out.corners, warp: out.warp ?? null };
  if (!transformHomography(g)) fail('These corners fold the contents over themselves or through the horizon; keep the quad convex.');
  if (out.warp && !hasWarp(g)) delete out.warp;
  return out;
}

/** The projective map of a warp-free placement (contents → document), or `null`. */
function placementHomography(layer: Pick<SmartObjectLayer, 'contents' | 'placement'>): Homography | null {
  const g = placementGeometry(layer);
  return hasWarp(g) ? null : transformHomography(g);
}

/**
 * Moves a linked mask with a placement change when both placements are warp-free (by the change's
 * projective map); otherwise, or for an unlinked or parametric mask, it stays.
 */
function followMask(mask: RasterMask | undefined, before: SmartObjectLayer, after: SmartObjectLayer): RasterMask | undefined {
  if (!mask || mask.linked === false || mask.source) return mask;
  const h0 = placementHomography(before);
  const h1 = placementHomography(after);
  if (!h0 || !h1) return mask;
  const inv = invertHomography(h0);
  if (!inv) return mask;
  const delta = multiplyHomographies(inv, h1);
  const surface = transformSurface(mask.surface, delta, { interpolation: 'bilinear' });
  return { ...mask, surface };
}

/**
 * Sets a smart object's placement (corners, warp, interpolation) and renders it again from its
 * contents. A linked layer mask and filter mask follow a warp-free change. Returns the stack and
 * whether the masks moved.
 */
export function setSmartPlacement(
  layers: readonly ImageLayer[],
  id: string,
  placement: SmartPlacement,
  canvas: SmartCanvas
): { layers: ImageLayer[]; layer: SmartObjectLayer; masksMoved: boolean } {
  const layer = requireSmartObject(layers, id);
  requireUnlocked(layer, 'position', 'transform it');
  requireDecoded(layer, 'be transformed');
  const clean = normalizePlacement(placement, layer.contents);
  let next: SmartObjectLayer = { ...layer, placement: clean };
  let masksMoved = false;
  if (layer.mask) {
    const m = followMask(layer.mask, layer, next);
    masksMoved ||= m !== layer.mask;
    next.mask = m;
  }
  if (next.smartFilters?.mask) {
    const m = followMask(next.smartFilters.mask, layer, next);
    masksMoved ||= m !== next.smartFilters.mask;
    next.smartFilters = { ...next.smartFilters, mask: m };
  }
  next = rerender(next, canvas, 'be transformed');
  return { layers: mapLayer(layers, id, () => next), layer: next, masksMoved };
}

/**
 * Moves a smart object by whole pixels (the move tool): its corners, a linked mask and filter mask
 * move with it. Without spatial smart filters the rendered pixels are shifted, not resampled.
 */
export function offsetSmartObject(layers: readonly ImageLayer[], id: string, dx: number, dy: number, canvas: SmartCanvas): ImageLayer[] {
  const layer = requireSmartObject(layers, id);
  requireUnlocked(layer, 'position', 'move it');
  const mx = Math.round(dx);
  const my = Math.round(dy);
  if (!mx && !my) return layers as ImageLayer[];
  const corners = layer.placement.corners.map((p) => ({ x: p.x + mx, y: p.y + my })) as unknown as Quad;
  let next: SmartObjectLayer = { ...layer, placement: { ...layer.placement, corners } };
  const moveMask = (m: RasterMask | undefined) => (m && m.linked !== false && !m.source ? { ...m, surface: translateSurface(m.surface, mx, my) } : m);
  if (layer.mask) next.mask = moveMask(layer.mask);
  if (layer.smartFilters?.mask) next.smartFilters = { ...layer.smartFilters, mask: moveMask(layer.smartFilters.mask) };
  // Shifting is exact unless a filter reads across the canvas edge, or the render was cut at its margin.
  const spatial = activeSmartFilters(layer.smartFilters).some((f) => f.kind === 'blur');
  const b = contentBounds(layer.surface);
  const m = SMART_RENDER_MARGIN;
  const cut = b && (b.x <= -m || b.y <= -m || b.x + b.width >= canvas.width + m || b.y + b.height >= canvas.height + m);
  if (!spatial && !cut && !(next.smartFilters?.mask && activeSmartFilters(next.smartFilters).length && next.smartFilters.mask.linked === false)) {
    next = { ...next, surface: translateSurface(layer.surface, mx, my) };
  } else {
    next = rerender(next, canvas, 'move');
  }
  return mapLayer(layers, id, () => next);
}

// ---------------------------------------------------------------------------
// Convert, rasterize, copy
// ---------------------------------------------------------------------------

/** Moves a layer (and everything in it) by whole pixels, for nesting it in contents. */
function translateLayer(layer: ImageLayer, dx: number, dy: number): ImageLayer {
  if (!dx && !dy) return layer;
  const moveMask = (m: RasterMask | undefined): RasterMask | undefined => {
    if (!m) return m;
    if (m.source) fail(`Layer "${layer.name || layer.id}" has a depth mask, which cannot move into a smart object; bake or remove it first.`);
    return { ...m, surface: translateSurface(m.surface, dx, dy) };
  };
  switch (layer.type) {
    case 'pixel':
      // Pixels and the mask are in layer space; moving the offset moves both.
      return { ...layer, offset: { x: layer.offset.x + dx, y: layer.offset.y + dy } };
    case 'smart': {
      const next: SmartObjectLayer = {
        ...layer,
        placement: { ...layer.placement, corners: layer.placement.corners.map((p) => ({ x: p.x + dx, y: p.y + dy })) as unknown as Quad },
        surface: translateSurface(layer.surface, dx, dy),
        mask: moveMask(layer.mask),
      };
      if (!next.mask) delete next.mask;
      if (layer.smartFilters?.mask) next.smartFilters = { ...layer.smartFilters, mask: moveMask(layer.smartFilters.mask) };
      return next;
    }
    case 'group': {
      const next = { ...layer, children: layer.children.map((c) => translateLayer(c, dx, dy)), mask: moveMask(layer.mask) };
      if (!next.mask) delete next.mask;
      return next;
    }
    case 'adjustment': {
      const next = { ...layer, mask: moveMask(layer.mask) } as ImageLayer;
      if (!next.mask) delete next.mask;
      return next;
    }
    case 'annotation':
      return fail(`Annotation layer "${layer.name || layer.id}" cannot go into a smart object; rasterize it first.`);
  }
}

/** Integer document bounds a layer draws into (effects included), or `null` for none; the canvas for layers without bounds. */
function layerExtent(layer: ImageLayer, surfaceOf: (l: PixelLayer) => PixelSurface, canvas: SmartCanvas): CropBox | null {
  const full = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  let b: CropBox | null = null;
  if (layer.type === 'pixel' || layer.type === 'smart') {
    const s = layer.type === 'pixel' ? surfaceOf(layer) : layer.surface;
    if (s.defaultValue !== 0) b = full;
    else {
      const c = contentBounds(s);
      b = c ? { x: c.x + layer.offset.x, y: c.y + layer.offset.y, width: c.width, height: c.height } : null;
    }
  } else if (layer.type === 'group') {
    for (const c of layer.children) b = union(b, layerExtent(c, surfaceOf, canvas));
  } else {
    b = full;
  }
  const m = effectsMargin(layer.effects);
  if (b && m > 0) b = { x: b.x - Math.ceil(m), y: b.y - Math.ceil(m), width: b.width + 2 * Math.ceil(m), height: b.height + 2 * Math.ceil(m) };
  return b;
}

function union(a: CropBox | null, b: CropBox | null): CropBox | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Plain smart filters from a pixel layer's filters (normal, 100 %). */
function asSmartFilters(filters: readonly LayerFilter[] | undefined): SmartFilterStack | undefined {
  if (!filters?.length) return undefined;
  return { enabled: true, filters: filters.map((f) => ({ ...f, blend: 'normal' as BlendMode, opacity: 1 })) };
}

export interface ConvertOptions {
  /** The pixels of a pixel layer (resolves the Background's document source). */
  surfaceOf(layer: PixelLayer): PixelSurface;
  /** Name of the new layer (default: the top layer's name). */
  name?: string;
}

/**
 * Layer › Smart Objects › Convert to Smart Object: sibling layers become one smart object at the
 * position of the topmost one.
 *
 * - One pixel layer becomes raster contents (its pixels, cropped to their bounds) and keeps its
 *   id, name, visibility, opacity, fill, blend, clipping, mask and effects; its filters become
 *   smart filters. It renders exactly as before.
 * - Anything else (several layers, a group, an adjustment, a smart object) becomes a nested
 *   document holding the layers as they were, sized to their bounds (effects included), and the
 *   new layer is a plain Normal layer named after the top one, rendering the isolated composite.
 *
 * Returns the stack, the new layer and its contents.
 */
export function convertToSmartObject(
  layers: readonly ImageLayer[],
  ids: readonly string[],
  canvas: SmartCanvas,
  options: ConvertOptions
): { layers: ImageLayer[]; layer: SmartObjectLayer } {
  if (!ids.length) fail('Give at least one layer id to convert.');
  const locs = [...new Set(ids)].map((id) => requireLayer(layers, id));
  const parent = locs[0].parent?.id ?? null;
  if (locs.some((l) => (l.parent?.id ?? null) !== parent)) fail('Layers to convert must share one parent; move them next to each other first.');
  for (const l of locs) requireUnlocked(l.layer, 'all', 'convert it');
  const ordered = locs.sort((a, b) => a.index - b.index);
  const top = ordered[ordered.length - 1];

  let smart: SmartObjectLayer;
  const single = ordered.length === 1 ? ordered[0].layer : null;
  if (single && single.type === 'pixel') {
    const surface = options.surfaceOf(single);
    if (surface.defaultValue !== 0) fail(`Layer "${single.name || single.id}" has no transparent area to crop to; it cannot be converted.`);
    const b = contentBounds(surface);
    if (!b) fail(`Layer "${single.name || single.id}" has no pixels to convert; paint something first.`);
    const contents: SmartContents = {
      id: newContentsId(),
      name: `${single.name || 'Layer'}.png`,
      width: b!.width,
      height: b!.height,
      kind: 'raster',
      raster: translateSurface(surface, -b!.x, -b!.y),
    };
    smart = {
      type: 'smart',
      id: single.id,
      name: single.name,
      visible: single.visible,
      opacity: single.opacity,
      blend: single.blend,
      contents,
      placement: placementAt(contents, b!.x + single.offset.x, b!.y + single.offset.y),
      surface: emptySurface(4),
      offset: { x: 0, y: 0 },
    };
    if (single.clipped) smart.clipped = true;
    if (single.fillOpacity !== undefined) smart.fillOpacity = single.fillOpacity;
    if (single.effects) smart.effects = single.effects;
    if (single.mask) {
      // Masks of pixel layers are in layer space; a smart object's are in document space.
      smart.mask = single.mask.source ? single.mask : { ...single.mask, surface: translateSurface(single.mask.surface, single.offset.x, single.offset.y) };
    }
    const filters = asSmartFilters(single.filters);
    if (filters) smart.smartFilters = filters;
  } else {
    let b: CropBox | null = null;
    for (const l of ordered) b = union(b, layerExtent(l.layer, options.surfaceOf, canvas));
    if (!b || !(b.width > 0 && b.height > 0)) fail('The layers have no pixels to convert; paint something first.');
    const nested = ordered.map((l) => {
      let layer = l.layer;
      if (layer.type === 'pixel' && layer.source === 'document') {
        const resolved = { ...layer, surface: options.surfaceOf(layer) };
        delete resolved.source;
        layer = resolved;
      }
      if (flattenLayers([layer]).some((x) => x.type === 'pixel' && x.source === 'document')) fail(`Layer "${layer.name || layer.id}" holds the document image inside a group; convert the Background on its own.`);
      return translateLayer(layer, -b!.x, -b!.y);
    });
    // The bottom layer has nothing below it to clip to inside the contents.
    if (nested[0].clipped) {
      const first = { ...nested[0] };
      delete first.clipped;
      nested[0] = first;
    }
    const name = options.name?.trim() || top.layer.name || 'Smart Object';
    const contents = documentContents({ layers: nested }, b!.width, b!.height, `${name}.psb`);
    smart = {
      type: 'smart',
      id: ordered.length === 1 ? ordered[0].layer.id : newLayerId('smart'),
      name,
      visible: true,
      opacity: 1,
      blend: 'normal',
      contents,
      placement: placementAt(contents, b!.x, b!.y),
      surface: emptySurface(4),
      offset: { x: 0, y: 0 },
    };
  }
  if (options.name?.trim()) smart.name = options.name.trim();
  smart = { ...smart, surface: renderSmartObject(smart, canvas) };
  const below = ordered.filter((l) => l.index < top.index).length;
  let out = layers as ImageLayer[];
  for (const l of ordered) out = mapLayer(out, l.layer.id, () => null);
  return { layers: insertLayer(out, smart, parent, top.index - below), layer: smart };
}

/**
 * Layer › Smart Objects › Rasterize: the smart object becomes a pixel layer holding what it
 * renders (filters baked), with its mask, effects, blend, opacity and fill. Same id.
 */
export function rasterizeSmartObject(layers: readonly ImageLayer[], id: string): { layers: ImageLayer[]; layer: PixelLayer } {
  const layer = requireSmartObject(layers, id);
  requireUnlocked(layer, 'all', 'rasterize it');
  const out: PixelLayer = {
    type: 'pixel',
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    opacity: layer.opacity,
    blend: layer.blend,
    surface: layer.surface,
    offset: { x: 0, y: 0 },
  };
  if (layer.clipped) out.clipped = true;
  if (layer.mask) out.mask = layer.mask;
  if (layer.locks) out.locks = layer.locks;
  if (layer.effects) out.effects = layer.effects;
  if (layer.fillOpacity !== undefined) out.fillOpacity = layer.fillOpacity;
  return { layers: mapLayer(layers, id, () => out), layer: out };
}

/**
 * Layer › Smart Objects › New Smart Object via Copy (`linked: false`, fresh contents that edit
 * independently) or a linked duplicate (`linked: true`, shared contents), directly above.
 */
export function copySmartObject(layers: readonly ImageLayer[], id: string, linked: boolean, name?: string): { layers: ImageLayer[]; layer: SmartObjectLayer } {
  const loc = requireLayer(layers, id);
  const layer = requireSmartObject(layers, id);
  const copy: SmartObjectLayer = { ...layer, id: newLayerId('smart'), name: name?.trim() || `${layer.name || 'Smart Object'} copy` };
  delete copy.locks;
  delete copy.psd;
  if (!linked) copy.contents = { ...layer.contents, id: newContentsId() };
  if (copy.smartFilters) copy.smartFilters = { ...copy.smartFilters, filters: copy.smartFilters.filters.map((f) => ({ ...f, id: newLayerId('flt') })) };
  return { layers: insertLayer(layers, copy, loc.parent?.id ?? null, loc.index + 1), layer: copy };
}

/** Ids of the smart objects in the stack placed from contents `contentsId` (linked instances), bottom first. */
export function instancesOf(layers: readonly ImageLayer[], contentsId: string): string[] {
  return flattenLayers(layers)
    .filter((l): l is SmartObjectLayer => l.type === 'smart' && l.contents.id === contentsId)
    .map((l) => l.id);
}

/**
 * Puts new contents into every instance of `contentsId` and renders them again. With
 * `keepPlacement` false (Replace Contents of a different size), each instance keeps its scale and
 * rotation about the contents' centre, and a warp is stretched to the new size.
 */
export function replaceContents(
  layers: readonly ImageLayer[],
  contentsId: string,
  contents: SmartContents,
  canvas: SmartCanvas
): { layers: ImageLayer[]; ids: string[] } {
  const ids = instancesOf(layers, contentsId);
  if (!ids.length) fail(`No smart object uses contents "${contentsId}".`);
  for (const id of ids) requireUnlocked(findLayer(layers, id)!.layer, 'all', 'replace its contents');
  const next = { ...contents, id: contentsId };
  let out = layers as ImageLayer[];
  for (const id of ids) {
    out = mapLayer(out, id, (l) => {
      const layer = l as SmartObjectLayer;
      return rerender({ ...layer, contents: next, placement: refitPlacement(layer, next) }, canvas, 'take the new contents');
    });
  }
  return { layers: out, ids };
}

/** A placement for new contents of another size: the same map about the contents' centre (warp stretched). */
function refitPlacement(layer: SmartObjectLayer, contents: Pick<SmartContents, 'width' | 'height'>): SmartPlacement {
  const W0 = layer.contents.width;
  const H0 = layer.contents.height;
  const W1 = contents.width;
  const H1 = contents.height;
  if (W0 === W1 && H0 === H1) return layer.placement;
  const g = placementGeometry(layer);
  const h = transformHomography(g);
  if (!h) return placementAt(contents, 0, 0);
  // The new rectangle centred on the old one, through the old corner map.
  const shift: Homography = [1, 0, (W0 - W1) / 2, 0, 1, (H0 - H1) / 2, 0, 0, 1];
  const hn = multiplyHomographies(shift, h);
  const pts = boxQuad({ x: 0, y: 0, width: W1, height: H1 }).map((p) => {
    const w = hn[6] * p.x + hn[7] * p.y + hn[8];
    return { x: (hn[0] * p.x + hn[1] * p.y + hn[2]) / w, y: (hn[3] * p.x + hn[4] * p.y + hn[5]) / w };
  });
  const out: SmartPlacement = { corners: pts as unknown as Quad };
  if (layer.placement.interpolation) out.interpolation = layer.placement.interpolation;
  if (layer.placement.warp) out.warp = mapWarpMeshPoints(layer.placement.warp, (p) => ({ x: (p.x * W1) / W0, y: (p.y * H1) / H0 }));
  return out;
}

// ---------------------------------------------------------------------------
// Smart filters
// ---------------------------------------------------------------------------

/** A clean smart filter from loose input: a `develop` or `blur` filter plus blend and opacity. */
export function normalizeSmartFilter(raw: Record<string, unknown> & { kind: string }, id = newLayerId('flt')): SmartFilter {
  if (raw.kind === 'psd') fail('Photoshop filters can only come from a PSD; add develop or blur.');
  const base = normalizeFilter(raw as Partial<LayerFilter> & { kind: LayerFilter['kind'] }, id);
  const blend = raw.blend ?? 'normal';
  if (!isBlendMode(blend) || blend === 'pigment') fail(`Unknown blend mode "${String(blend)}" for a smart filter.`);
  const opacity = raw.opacity ?? 1;
  if (!(typeof opacity === 'number' && opacity >= 0 && opacity <= 1)) fail('opacity must be a number from 0 to 1.');
  return { ...base, blend: blend as BlendMode, opacity: opacity as number };
}

function withStack(layer: SmartObjectLayer, stack: SmartFilterStack | undefined, canvas: SmartCanvas): SmartObjectLayer {
  const next = { ...layer };
  if (stack && (stack.filters.length || stack.mask || !stack.enabled)) next.smartFilters = stack;
  else delete next.smartFilters;
  return rerender(next, canvas, 'change its smart filters');
}

function stackOf(layer: SmartObjectLayer): SmartFilterStack {
  return layer.smartFilters ?? { enabled: true, filters: [] };
}

function requireFilter(layer: SmartObjectLayer, filterId: string): number {
  const list = layer.smartFilters?.filters ?? [];
  const i = list.findIndex((f) => f.id === filterId);
  if (i === -1) fail(`Smart object "${layer.name || layer.id}" has no smart filter "${filterId}". Filters: ${list.map((f) => `${f.id} (${f.kind})`).join(', ') || 'none'}; call get_smart_object.`);
  return i;
}

function editableSmart(layers: readonly ImageLayer[], id: string): SmartObjectLayer {
  const layer = requireSmartObject(layers, id);
  requireUnlocked(layer, 'all', 'change its smart filters');
  return layer;
}

/** Adds a smart filter at `index` (default the top). Returns the stack and the filter. */
export function addSmartFilter(
  layers: readonly ImageLayer[],
  id: string,
  filter: SmartFilter,
  canvas: SmartCanvas,
  index?: number
): { layers: ImageLayer[]; layer: SmartObjectLayer; filter: SmartFilter } {
  const layer = editableSmart(layers, id);
  const stack = stackOf(layer);
  const filters = [...stack.filters];
  const at = index === undefined ? filters.length : Math.max(0, Math.min(filters.length, Math.floor(index)));
  filters.splice(at, 0, filter);
  const next = withStack(layer, { ...stack, filters }, canvas);
  return { layers: mapLayer(layers, id, () => next), layer: next, filter };
}

/** Changes one smart filter (settings, enabled, blend, opacity; validated). */
export function updateSmartFilter(
  layers: readonly ImageLayer[],
  id: string,
  filterId: string,
  changes: Record<string, unknown>,
  canvas: SmartCanvas
): { layers: ImageLayer[]; layer: SmartObjectLayer; filter: SmartFilter } {
  const layer = editableSmart(layers, id);
  const i = requireFilter(layer, filterId);
  const current = layer.smartFilters!.filters[i];
  if ('kind' in changes && changes.kind !== current.kind) fail('A smart filter kind cannot change; remove it and add another.');
  let merged: SmartFilter;
  if (current.kind === 'psd') {
    const extra = Object.keys(changes).filter((k) => !['enabled', 'blend', 'opacity', 'kind'].includes(k));
    if (extra.length) fail(`"${current.name}" is a Photoshop filter we keep but do not model; only enabled, blend and opacity change. Unknown: ${extra.join(', ')}.`);
    const blend = changes.blend ?? current.blend;
    if (!isBlendMode(blend) || blend === 'pigment') fail(`Unknown blend mode "${String(blend)}" for a smart filter.`);
    const opacity = changes.opacity ?? current.opacity;
    if (!(typeof opacity === 'number' && opacity >= 0 && opacity <= 1)) fail('opacity must be a number from 0 to 1.');
    merged = { ...current, enabled: changes.enabled === undefined ? current.enabled : Boolean(changes.enabled), blend: blend as BlendMode, opacity: opacity as number };
  } else {
    merged = normalizeSmartFilter({ ...current, ...changes, kind: current.kind } as Record<string, unknown> & { kind: string }, current.id);
  }
  const filters = [...layer.smartFilters!.filters];
  filters[i] = merged;
  const next = withStack(layer, { ...layer.smartFilters!, filters }, canvas);
  return { layers: mapLayer(layers, id, () => next), layer: next, filter: merged };
}

/** Removes one smart filter. */
export function removeSmartFilter(layers: readonly ImageLayer[], id: string, filterId: string, canvas: SmartCanvas): { layers: ImageLayer[]; layer: SmartObjectLayer } {
  const layer = editableSmart(layers, id);
  requireFilter(layer, filterId);
  const stack = layer.smartFilters!;
  const filters = stack.filters.filter((f) => f.id !== filterId);
  // The filter mask goes with the last filter, as in Photoshop.
  const next = withStack(layer, filters.length ? { ...stack, filters } : stack.enabled ? undefined : { enabled: false, filters }, canvas);
  return { layers: mapLayer(layers, id, () => next), layer: next };
}

/** Moves one smart filter to `index` (0 = bottom, applied first). */
export function moveSmartFilter(layers: readonly ImageLayer[], id: string, filterId: string, index: number, canvas: SmartCanvas): { layers: ImageLayer[]; layer: SmartObjectLayer } {
  const layer = editableSmart(layers, id);
  const i = requireFilter(layer, filterId);
  const list = layer.smartFilters!.filters;
  if (!Number.isInteger(index) || index < 0 || index >= list.length) fail(`index must be a whole number from 0 to ${list.length - 1}.`);
  const filters = [...list];
  const [f] = filters.splice(i, 1);
  filters.splice(index, 0, f);
  const next = withStack(layer, { ...layer.smartFilters!, filters }, canvas);
  return { layers: mapLayer(layers, id, () => next), layer: next };
}

/** Turns the whole smart filter stack on or off (each filter keeps its own switch). */
export function setSmartFiltersEnabled(layers: readonly ImageLayer[], id: string, enabled: boolean, canvas: SmartCanvas): { layers: ImageLayer[]; layer: SmartObjectLayer } {
  const layer = editableSmart(layers, id);
  const next = withStack(layer, { ...stackOf(layer), enabled: Boolean(enabled) }, canvas);
  return { layers: mapLayer(layers, id, () => next), layer: next };
}

/** Sets or removes (`null`) the smart filter mask. */
export function setSmartFilterMask(layers: readonly ImageLayer[], id: string, mask: RasterMask | null, canvas: SmartCanvas): { layers: ImageLayer[]; layer: SmartObjectLayer } {
  const layer = editableSmart(layers, id);
  if (mask?.source) fail('A smart filter mask is painted, not generated; use a raster mask.');
  const stack = { ...stackOf(layer) };
  if (mask) stack.mask = mask;
  else delete stack.mask;
  const next = withStack(layer, stack, canvas);
  return { layers: mapLayer(layers, id, () => next), layer: next };
}

/** A smart object's filter mask surface replaced (painting it), rendered again. */
export function withFilterMaskSurface(layer: SmartObjectLayer, surface: PixelSurface, canvas: SmartCanvas): SmartObjectLayer {
  const stack = stackOf(layer);
  if (!stack.mask) fail(`Smart object "${layer.name || layer.id}" has no filter mask; add one with set_smart_filter_mask.`);
  return withStack(layer, { ...stack, mask: { ...stack.mask!, surface } }, canvas);
}

/** The transformed outline of a smart object's contents (document bounds, warp included). */
export function placementBounds(layer: Pick<SmartObjectLayer, 'contents' | 'placement'>): CropBox | null {
  return transformedBox(placementGeometry(layer));
}
