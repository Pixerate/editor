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
import type { BlendMode } from '../../raster/blend';
import type { Interpolation } from '../../raster/transform';
import type { GlobalLight } from '../../raster/effects/model';
import type { EffectPattern } from '../../raster/effects/patterns';
import type { Quad, WarpMesh } from '../../geom/types';
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

// ---------------------------------------------------------------------------
// Smart objects
// ---------------------------------------------------------------------------

/** A nested layer document: the contents of a smart object made from layers (or an embedded PSD). */
export interface SmartDocument {
  /** Bottom to top, on a canvas of the contents' `width × height`. */
  layers: ImageLayer[];
  globalLight?: GlobalLight;
  patterns?: EffectPattern[];
}

/**
 * What a smart object places: raster pixels or a nested layer document, at their own pixel size.
 * Immutable and shared: every instance placed from the same contents (duplicates, linked
 * instances) holds the same `id`, and replacing or editing the contents updates them all.
 */
export interface SmartContents {
  /** Shared by linked instances; independent copies get a fresh one. */
  id: string;
  /** File name shown in the UI and written to PSD (`Layer 1.psb`, `photo.png`). */
  name: string;
  /** Pixel size of the contents (the placement maps `0..width × 0..height` into the document). */
  width: number;
  height: number;
  /** `raster`: `raster` holds the pixels at (0, 0); `document`: `document` holds the layers. */
  kind: 'raster' | 'document';
  raster?: PixelSurface;
  document?: SmartDocument;
  /**
   * The file the contents came from (a PSD's embedded file), written back by Export Contents and
   * PSD export while the contents are unedited. Without `raster` / `document` the file could not
   * be decoded here (a JPEG outside a browser): the layer keeps its rendered pixels, and changes
   * that re-render it are refused until `prepareSmartObjects` decodes it.
   */
  file?: { bytes: Uint8Array; type: string };
  /** Linked to an external file (Photoshop `liFE`): only the embedded preview is held. */
  linked?: { path: string };
}

/**
 * Where a smart object's contents land, non-destructively: a warp in the contents' own pixels
 * (optional) and then the map of the contents' rectangle onto `corners`. Every change re-renders
 * from the contents, so repeated transforms never degrade.
 */
export interface SmartPlacement {
  /** Where the contents' corners land (top-left, top-right, bottom-right, bottom-left), document pixels. */
  corners: Quad;
  /** A Bézier warp over the contents' rectangle, control points in contents pixels (missing = none). */
  warp?: WarpMesh | null;
  /** Resampling (default bicubic). */
  interpolation?: Interpolation;
}

/**
 * A Photoshop smart filter we do not model (Gaussian Blur, Camera Raw, …), kept from a PSD so it
 * is listed, can be hidden, reordered or deleted, and is written back unchanged. It draws nothing.
 */
export interface PsdSmartFilter {
  id: string;
  kind: 'psd';
  enabled: boolean;
  /** Photoshop's menu name (`Gaussian Blur...`). */
  name: string;
  /** The filter's `filterFX` item descriptor (versioned descriptor bytes), as read. */
  data: Uint8Array;
}

/** One smart filter: a layer filter (or a kept PSD filter) with its own blending over the result below it. */
export type SmartFilter = (LayerFilter | PsdSmartFilter) & {
  /** How the filter's result blends with the result below it (Photoshop's Blending Options). */
  blend: BlendMode;
  /** 0..1 */
  opacity: number;
};
export type SmartFilterKind = SmartFilter['kind'];

/** The smart filter stack of a smart object. */
export interface SmartFilterStack {
  /** Layer › Smart Filter › Disable Smart Filters (each filter keeps its own `enabled`). */
  enabled: boolean;
  /** Bottom (applied first) to top. */
  filters: SmartFilter[];
  /**
   * The one filter mask (document space): where the filtered result shows over the unfiltered
   * contents. Missing reveals everywhere.
   */
  mask?: RasterMask;
}

/** PSD data of a smart object kept for round trips (see the PSD module). */
export interface SmartPsdData {
  /** The placed-layer block as read (`SoLd`, `SoLE` or `PlLd`) and its key. */
  key: string;
  data: Uint8Array;
  /** The instance id (`placed`), which keys the filter-effects cache. */
  placed?: string;
}

/**
 * A smart object: `contents` placed through `placement`, then the smart filters. `surface` is the
 * rendered result in document space (offset 0), rebuilt by every change to the contents,
 * placement or filters; the compositor draws it like a pixel layer's pixels, and masks, effects,
 * clipping and blend apply on top. Never paint into it: rasterize the layer first.
 */
export interface SmartObjectLayer extends LayerBase {
  type: 'smart';
  contents: SmartContents;
  placement: SmartPlacement;
  smartFilters?: SmartFilterStack;
  /** The rendered pixels (a cache of contents → placement → filters), document space. */
  surface: PixelSurface;
  /** Always (0, 0): a smart object moves through its placement. */
  offset: { x: number; y: number };
  /** 0..1, PSD "Fill" (missing = 1). */
  fillOpacity?: number;
  psd?: SmartPsdData;
}

export type ImageLayer = PixelLayer | AdjustmentLayerNode | GroupLayer | AnnotationLayer | SmartObjectLayer;
export type ImageLayerType = ImageLayer['type'];

/** Which part of the active layer painting targets (`filter-mask`: a smart object's filter mask). */
export type LayerTarget = 'pixels' | 'mask' | 'filter-mask';

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
  return type === 'pixel' ? 'Pixel layer' : type === 'adjustment' ? 'Adjustment layer' : type === 'group' ? 'Group' : type === 'smart' ? 'Smart object' : 'Annotation';
}

/** Layers whose pixels are a surface the compositor draws (pixel layers and smart objects). */
export function hasSurface(layer: ImageLayer): layer is PixelLayer | SmartObjectLayer {
  return layer.type === 'pixel' || layer.type === 'smart';
}

/** Every smart object in the stack (nested contents not included). */
export function smartObjectLayers(layers: readonly ImageLayer[]): SmartObjectLayer[] {
  return flattenLayers(layers).filter((l): l is SmartObjectLayer => l.type === 'smart');
}
