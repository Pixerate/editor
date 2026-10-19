/**
 * The image editor's layer stack: pixel, adjustment, group and annotation layers in one ordered
 * tree (bottom to top), all in document space (natural pixels of the document).
 *
 * Layer objects are immutable. Every change builds new objects along the path from the root to
 * the changed layer and shares everything else, so undo history, the compositor's caches and
 * serialization can compare layers by identity.
 */

import type {
  AdjustmentKind,
  AdjustmentParamsMap,
  Annotation,
  CropBox,
  DepthMaskOptions,
} from '../types';
import type { PixelSurface } from '../../raster/surface';
import {
  findLayer,
  flattenLayers,
  insertLayer,
  isLayerLocked,
  mapLayer,
  type GroupBlendMode,
  type LayerLocation as RasterLayerLocation,
  type LayerLocks,
  type RasterLayerBase,
  type RasterMask as BaseRasterMask,
  type RasterPixelLayer,
} from '../../raster/layers';

/** Blend modes of a layer; groups also accept `pass-through`. */
export type LayerBlendMode = GroupBlendMode;

export type { LayerLocks };

/**
 * A layer mask (see the raster module's `RasterMask`) whose parametric `source` is a depth map:
 * a depth mask is generated from it instead of painted, and its surface is unused.
 */
export type RasterMask = BaseRasterMask<DepthMaskOptions>;

export interface LayerBase extends RasterLayerBase {
  mask?: RasterMask;
}

/** The base sliders of the old document-level adjustments, as a filter on one layer. */
export interface DevelopSettings {
  brightness: number;
  contrast: number;
  saturation: number;
  exposure: number;
  temperature: number;
  tint?: number;
  /** Rendering process (see `ImageAdjustments.process`). */
  process?: 1 | 2;
}

export type DevelopFilter = { id: string; kind: 'develop'; enabled: boolean } & DevelopSettings;
/** Box blur of `radius` pixels (the old `adjustments.blur`), clamped at the canvas edges. */
export interface BlurFilter {
  id: string;
  kind: 'blur';
  enabled: boolean;
  radius: number;
}
export type LayerFilter = DevelopFilter | BlurFilter;
export type LayerFilterKind = LayerFilter['kind'];

export interface PixelLayer extends LayerBase, Omit<RasterPixelLayer, keyof RasterLayerBase> {
  /** Live filters, applied bottom (first) to top before the mask and blend. */
  filters?: LayerFilter[];
  /**
   * `'document'`: the pixels are the document's source image, unmodified (the Background of an
   * opened image). Such a layer's `surface` is a placeholder; read its pixels through the
   * controller. Painting it drops the flag.
   */
  source?: 'document';
}

export type AdjustmentLayerNode<K extends AdjustmentKind = AdjustmentKind> = {
  [P in K]: LayerBase & { type: 'adjustment'; kind: P; params: AdjustmentParamsMap[P] };
}[K];

export interface GroupLayer extends Omit<LayerBase, 'blend'> {
  type: 'group';
  blend: LayerBlendMode;
  /** Bottom to top. */
  children: ImageLayer[];
  /** UI only. */
  collapsed?: boolean;
}

/** One annotation (pen, shape, arrow, text, image) as a layer, drawn by the annotation renderer. */
export interface AnnotationLayer extends LayerBase {
  type: 'annotation';
  annotation: Annotation;
}

export type ImageLayer = PixelLayer | AdjustmentLayerNode | GroupLayer | AnnotationLayer;
export type ImageLayerType = ImageLayer['type'];

/** Which part of the active layer painting targets. */
export type LayerTarget = 'pixels' | 'mask';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

let idCounter = 0;

/** A fresh id with `prefix` (`layer`, `flt`, …). */
export function newLayerId(prefix = 'layer'): string {
  return `${prefix}_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Tree helpers (pure)
// ---------------------------------------------------------------------------

export type LayerLocation = RasterLayerLocation<ImageLayer>;

export { flattenLayers, findLayer, mapLayer, insertLayer, isLayerLocked };

/** The top-level and nested pixel layers. */
export function pixelLayers(layers: readonly ImageLayer[]): PixelLayer[] {
  return flattenLayers(layers).filter((l): l is PixelLayer => l.type === 'pixel');
}

/** The develop filter of a pixel layer, if any. */
export function developFilter(layer: PixelLayer): DevelopFilter | undefined {
  return layer.filters?.find((f): f is DevelopFilter => f.kind === 'develop');
}

export function blurFilter(layer: PixelLayer): BlurFilter | undefined {
  return layer.filters?.find((f): f is BlurFilter => f.kind === 'blur');
}

/** True for filters that change pixels (enabled, non-neutral). */
export function isActiveFilter(f: LayerFilter): boolean {
  if (!f.enabled) return false;
  if (f.kind === 'blur') return Math.min(Math.round(f.radius), 40) >= 1;
  return Boolean(f.brightness || f.contrast || f.saturation || f.exposure || f.temperature || f.tint);
}

/** True when a filter needs neighbouring pixels (it can't run tile by tile). */
export function isSpatialFilter(f: LayerFilter): boolean {
  return f.kind === 'blur';
}

/** Document-space bounds of a pixel layer's stored tiles, or `null`. */
export function pixelLayerBounds(layer: PixelLayer, surface: PixelSurface = layer.surface): CropBox | null {
  const b = surface.bounds;
  if (!b) return null;
  return { x: b.x + layer.offset.x, y: b.y + layer.offset.y, width: b.width, height: b.height };
}

/** Human label of a layer kind. */
export function layerTypeLabel(type: ImageLayerType): string {
  return type === 'pixel' ? 'Pixel layer' : type === 'adjustment' ? 'Adjustment layer' : type === 'group' ? 'Group' : 'Annotation';
}
