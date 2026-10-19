/**
 * The image editor's compositor: the raster engine (`@pixerate/editor/raster`) with the photo
 * layer kinds plugged in. Adjustment layers filter what is below them (a run of adjacent ones is
 * one float pass with one rounding at the end, exactly as `applyAdjustmentLayers` does, so a
 * document migrated from adjustment layers renders identically); annotation layers are drawn by
 * the host; pixel layers can carry develop and blur filters; masks can be depth masks.
 */

import { applyAdjustmentLayers } from '../adjustment-layers';
import { applyBoxBlur, applyLegacyAdjustments, applyProcess2Adjustments } from '../filters';
import { LATEST_PROCESS_VERSION, normalizeProcessVersion } from '../color';
import type { BlendMode } from '../blend';
import type { AdjustmentLayer, Annotation, CropBox, DepthMaskOptions, ImageAdjustments } from '../types';
import {
  RasterCompositor,
  type CompositeCallOptions,
  type CompositeStats,
  type CompositorOptions,
  type CompositorProfile,
  type PixelFilterSpec,
  type RasterSources,
} from '../../raster/compositor';
import type { PixelSurface } from '../../raster/surface';
import { isActiveFilter, isSpatialFilter, type AdjustmentLayerNode, type ImageLayer, type LayerFilter, type PixelLayer, type SmartObjectLayer } from './model';

export { blendTile, changedTiles } from '../../raster/compositor';
export type { CompositeCallOptions, CompositeStats, CompositorOptions };

/** What the compositor needs from its host besides the layers. */
export interface CompositorSources extends RasterSources {
  /** The pixels of a pixel layer or smart object (resolves layers whose pixels are the document source). */
  surfaceOf?(layer: PixelLayer | SmartObjectLayer): PixelSurface;
  /**
   * A parametric mask's depth map as RGBA at canvas size (the red channel is the depth), or
   * `null` while it is unavailable (the mask then reveals everything).
   */
  depthMap?(source: DepthMaskOptions): { width: number; height: number; data: ArrayLike<number> } | null;
  /** Draws one annotation into RGBA for `rect` (canvas hosts only); `null` when unavailable. */
  rasterizeAnnotation?(annotation: Annotation, rect: CropBox): Uint8ClampedArray | null;
}

const legacyViewCache = new WeakMap<AdjustmentLayerNode, AdjustmentLayer>();

/** The `AdjustmentLayer` shape `applyAdjustmentLayers` evaluates, for a node (memoised). */
export function adjustmentNodeAsLayer(node: AdjustmentLayerNode): AdjustmentLayer {
  let view = legacyViewCache.get(node);
  if (!view) {
    view = {
      id: node.id,
      kind: node.kind,
      enabled: node.visible,
      opacity: node.opacity,
      blend: node.blend,
      params: node.params,
    } as AdjustmentLayer;
    legacyViewCache.set(node, view);
  }
  return view;
}

/** Develop settings as `ImageAdjustments` for the process functions (opacity is document-level). */
function developAdjustments(f: Extract<LayerFilter, { kind: 'develop' }>): ImageAdjustments {
  return {
    brightness: f.brightness,
    contrast: f.contrast,
    saturation: f.saturation,
    exposure: f.exposure,
    temperature: f.temperature,
    tint: f.tint ?? 0,
    blur: 0,
    opacity: 1,
    process: f.process,
  };
}

/** Runs per-pixel filters over RGBA `data` in place. */
function applyPixelFilters(data: Uint8ClampedArray, filters: readonly LayerFilter[]): void {
  for (const f of filters) {
    if (!isActiveFilter(f) || f.kind !== 'develop') continue;
    const adj = developAdjustments(f);
    if (normalizeProcessVersion(adj.process) === LATEST_PROCESS_VERSION) applyProcess2Adjustments({ data }, adj);
    else applyLegacyAdjustments({ data }, adj);
  }
}

/** Evaluates a depth mask (see `applyDepthMask`) into one coverage byte per depth sample. */
export function depthMaskAlpha(depth: number, options: DepthMaskOptions): number {
  const { mode, depthRange, softness, invert } = options;
  let v = invert ? 255 - depth : depth;
  const soft = Math.max(1, softness || 10);
  const [lo, hi] = depthRange;
  if (mode === 'threshold') {
    if (v >= hi + soft) return 0;
    if (v > hi) return Math.round(((hi + soft - v) / soft) * 255);
    if (v >= lo) return 255;
    if (v < lo - soft) return 0;
    return Math.round(((v - (lo - soft)) / soft) * 255);
  }
  v += lo;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Runs layer filters (develop, blur) over RGBA `data` (`width × height`) in place, bottom first. */
export function runLayerFilters(data: Uint8ClampedArray, width: number, height: number, filters: readonly LayerFilter[]): void {
  for (const f of filters) {
    if (!isActiveFilter(f)) continue;
    if (f.kind === 'develop') applyPixelFilters(data, [f]);
    else if (f.kind === 'blur') applyBoxBlur({ width, height, data }, Math.min(Math.round(f.radius), 40));
  }
}

const filterSpecCache = new WeakMap<object, PixelFilterSpec | null>();

/** A pixel layer's active filters for the engine (memoised per filter list). */
function pixelFilterSpec(layer: PixelLayer): PixelFilterSpec | null {
  const list = layer.filters;
  if (!list?.length) return null;
  if (filterSpecCache.has(list)) return filterSpecCache.get(list)!;
  const filters = list.filter(isActiveFilter);
  let spec: PixelFilterSpec | null = null;
  if (filters.length) {
    const spatial = filters.some(isSpatialFilter);
    spec = {
      key: JSON.stringify(filters),
      spatial,
      apply: (data, width, height) => runLayerFilters(data, width, height, filters),
    };
  }
  filterSpecCache.set(list, spec);
  return spec;
}

const PHOTO_PROFILE: CompositorProfile<ImageLayer, CompositorSources> = {
  isFilterLayer: (l) => l.type === 'adjustment',
  applyFilterRun: (layers, acc, _r, masks) => {
    const views = (layers as AdjustmentLayerNode[]).map(adjustmentNodeAsLayer);
    applyAdjustmentLayers({ data: acc }, views, masks);
  },
  contentTile: (l, r, sources) => (l.type === 'annotation' ? (sources.rasterizeAnnotation?.(l.annotation, r) ?? null) : null),
  /** Annotation layers draw with their annotation's blend mode unless the layer sets one. */
  contentBlend: (l) => (l.type === 'annotation' && l.blend === 'normal' && l.annotation.blend ? l.annotation.blend : (l.blend as BlendMode)),
  layerKey: (l) =>
    l.type === 'pixel' ? [l.filters ?? null, l.source ?? null] : l.type === 'adjustment' ? [l.kind, l.params] : l.type === 'annotation' ? l.annotation : undefined,
  pixelFilters: (l) => (l.type === 'pixel' ? pixelFilterSpec(l) : null),
  /** A smart object draws its rendered pixels (contents → placement → smart filters) like a pixel layer. */
  isPixelLike: (l) => l.type === 'smart',
  maskSourcePlane: (source, W, H, sources) => {
    const opts = source as DepthMaskOptions;
    const depth = sources.depthMap?.(opts) ?? null;
    if (!depth || depth.width !== W || depth.height !== H) return null;
    const v = new Float32Array(W * H);
    for (let i = 0; i < v.length; i++) v[i] = depthMaskAlpha(depth.data[i * 4], opts) / 255;
    return v;
  },
};

/** The per-tile compositor for image editor layer stacks (see the raster module for the caches). */
export class LayerCompositor extends RasterCompositor<ImageLayer, CompositorSources> {
  constructor(options: CompositorOptions = {}) {
    super(PHOTO_PROFILE, options);
  }
}
