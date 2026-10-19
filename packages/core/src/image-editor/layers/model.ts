/**
 * The image editor's layer stack: pixel, adjustment, group and annotation layers in one ordered
 * tree (bottom to top), all in document space (natural pixels of the document).
 *
 * Layer objects are immutable. Every change builds new objects along the path from the root to
 * the changed layer and shares everything else, so undo history, the compositor's caches and
 * serialization can compare layers by identity.
 */

import type { BlendMode } from '../blend';
import type {
  AdjustmentKind,
  AdjustmentParamsMap,
  Annotation,
  CropBox,
  DepthMaskOptions,
} from '../types';
import type { MaskSurface, PixelSurface } from './surface';

/** Blend modes of a layer; groups also accept `pass-through`. */
export type LayerBlendMode = BlendMode | 'pass-through';

export interface LayerLocks {
  /** Painting and filling are refused. */
  pixels?: boolean;
  /** Painting keeps each pixel's alpha. */
  transparency?: boolean;
  /** Moving (offset) is refused. */
  position?: boolean;
  /** Everything above, plus property changes and deletion. */
  all?: boolean;
}

/**
 * A layer mask: 8-bit coverage in document space (255 reveals, 0 hides), stored as a tiled
 * surface, plus non-destructive density and feather. A *parametric* mask (`source`) is generated
 * from a depth map instead of painted; its surface is unused.
 */
export interface RasterMask {
  surface: MaskSurface;
  /** Value outside the painted tiles (PSD's default colour); equals `surface.defaultValue`. */
  defaultValue: 0 | 255;
  /** 0..1 (missing = 1): at 0.5 hidden areas still show half. */
  density?: number;
  /** Gaussian σ in pixels (missing = 0). */
  feather?: number;
  /** `false` keeps the mask but ignores it. */
  enabled?: boolean;
  /** Parametric depth mask: the mask is generated from this depth map. */
  source?: DepthMaskOptions;
}

export interface LayerBase {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  blend: BlendMode;
  /** Clip to the nearest unclipped layer below (Photoshop's clipping mask). */
  clipped?: boolean;
  mask?: RasterMask;
  locks?: LayerLocks;
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

export interface PixelLayer extends LayerBase {
  type: 'pixel';
  /** Pixels in layer space; document position = layer position + `offset`. */
  surface: PixelSurface;
  /** Integer move without re-tiling. */
  offset: { x: number; y: number };
  /** 0..1, PSD "Fill" (missing = 1). */
  fillOpacity?: number;
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

export interface LayerLocation {
  layer: ImageLayer;
  /** The containing group, or `null` at the top level. */
  parent: GroupLayer | null;
  /** Index within the parent's children (or the top-level list). */
  index: number;
  /** Ancestors from the top level down to the parent. */
  path: GroupLayer[];
}

/** Every layer, depth first, bottom to top (a group comes before its children). */
export function flattenLayers(layers: readonly ImageLayer[]): ImageLayer[] {
  const out: ImageLayer[] = [];
  const walk = (list: readonly ImageLayer[]) => {
    for (const l of list) {
      out.push(l);
      if (l.type === 'group') walk(l.children);
    }
  };
  walk(layers);
  return out;
}

export function findLayer(layers: readonly ImageLayer[], id: string): LayerLocation | null {
  const walk = (list: readonly ImageLayer[], parent: GroupLayer | null, path: GroupLayer[]): LayerLocation | null => {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (l.id === id) return { layer: l, parent, index: i, path };
      if (l.type === 'group') {
        const hit = walk(l.children, l, [...path, l]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(layers, null, []);
}

/** Replaces the layer with `id` by `fn(layer)` (or removes it when `fn` returns `null`). */
export function mapLayer(
  layers: readonly ImageLayer[],
  id: string,
  fn: (layer: ImageLayer) => ImageLayer | null
): ImageLayer[] {
  let changed = false;
  const walk = (list: readonly ImageLayer[]): ImageLayer[] => {
    let out: ImageLayer[] | null = null;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      let next: ImageLayer | null = l;
      if (l.id === id) {
        next = fn(l);
        changed = true;
      } else if (l.type === 'group') {
        const children = walk(l.children);
        if (children !== l.children) next = { ...l, children };
      }
      if (next !== l) {
        if (!out) out = list.slice(0, i);
        if (next) out.push(next);
      } else if (out) out.push(l);
    }
    return out ?? (list as ImageLayer[]);
  };
  const result = walk(layers);
  return changed ? result : (layers as ImageLayer[]);
}

/** Inserts `layer` into `parentId`'s children (or the top level) at `index` (default: top). */
export function insertLayer(
  layers: readonly ImageLayer[],
  layer: ImageLayer,
  parentId: string | null,
  index?: number
): ImageLayer[] {
  const put = (list: readonly ImageLayer[]) => {
    const at = index === undefined ? list.length : Math.max(0, Math.min(list.length, index));
    const next = list.slice();
    next.splice(at, 0, layer);
    return next;
  };
  if (!parentId) return put(layers);
  return mapLayer(layers, parentId, (g) => (g.type === 'group' ? { ...g, children: put(g.children) } : g));
}

/** The top-level and nested pixel layers. */
export function pixelLayers(layers: readonly ImageLayer[]): PixelLayer[] {
  return flattenLayers(layers).filter((l): l is PixelLayer => l.type === 'pixel');
}

export function isLayerLocked(layer: ImageLayer, what: keyof LayerLocks): boolean {
  return Boolean(layer.locks?.all || layer.locks?.[what]);
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
