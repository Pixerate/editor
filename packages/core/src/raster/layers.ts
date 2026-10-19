/**
 * A layer stack that is not specific to any editor: pixel layers on tiled surfaces, groups (with
 * pass-through), raster masks with density and feather, clipping, locks, opacity, fill and blend
 * modes, plus pure tree helpers. Editors extend these types with their own layer kinds (the image
 * editor adds adjustment and annotation layers, filters and parametric masks).
 *
 * Layer objects are immutable: every change builds new objects along the path from the root to
 * the changed layer and shares everything else.
 */

import type { BlendMode } from './blend';
import type { LayerEffects } from './effects/model';
import type { MaskSurface, PixelSurface } from './surface';

/** Blend modes of a layer; groups also accept `pass-through`. */
export type GroupBlendMode = BlendMode | 'pass-through';

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
 * A layer mask: 8-bit coverage (255 reveals, 0 hides) on a tiled surface, plus non-destructive
 * density and feather. `source` is an editor-defined parametric mask (generated instead of
 * painted; the compositor asks its profile for the coverage, and the surface is unused).
 */
export interface RasterMask<Source = unknown> {
  surface: MaskSurface;
  /** Value outside the painted tiles (PSD's default colour); equals `surface.defaultValue`. */
  defaultValue: 0 | 255;
  /** 0..1 (missing = 1): at 0.5 hidden areas still show half. */
  density?: number;
  /** Gaussian σ in pixels (missing = 0). */
  feather?: number;
  /** `false` keeps the mask but ignores it. */
  enabled?: boolean;
  /**
   * `false` unlinks the mask from its layer (Photoshop's chain icon): moving or transforming the
   * layer's pixels leaves the mask where it is. Missing = linked.
   */
  linked?: boolean;
  source?: Source;
}

export interface RasterLayerBase {
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
  /** Live layer effects (drop shadow, stroke, …), rendered between the content and its blend. */
  effects?: LayerEffects;
}

export interface RasterPixelLayer extends RasterLayerBase {
  type: 'pixel';
  /** Pixels in layer space; document position = layer position + `offset`. A linked mask moves with it. */
  surface: PixelSurface;
  /** Integer move without re-tiling. */
  offset: { x: number; y: number };
  /** 0..1, PSD "Fill" (missing = 1). */
  fillOpacity?: number;
}

export interface RasterGroupLayer<L = RasterLayer> extends Omit<RasterLayerBase, 'blend'> {
  type: 'group';
  blend: GroupBlendMode;
  /** Bottom to top. */
  children: L[];
  /** UI only. */
  collapsed?: boolean;
}

/** The plain stack: pixel layers and groups. */
export type RasterLayer = RasterPixelLayer | RasterGroupLayer<RasterLayer>;

/** What the tree helpers need of a layer: an id, a type, and `children` on groups. */
export interface RasterNode {
  id: string;
  type: string;
}

/** The group members of a layer union. */
export type GroupIn<T> = Extract<T, { type: 'group' }>;

const childrenOf = <T>(l: T): readonly T[] | null =>
  (l as { type: string }).type === 'group' ? ((l as unknown as { children: T[] }).children ?? null) : null;

export interface LayerLocation<T extends RasterNode = RasterLayer> {
  layer: T;
  /** The containing group, or `null` at the top level. */
  parent: GroupIn<T> | null;
  /** Index within the parent's children (or the top-level list). */
  index: number;
  /** Ancestors from the top level down to the parent. */
  path: GroupIn<T>[];
}

/** Every layer, depth first, bottom to top (a group comes before its children). */
export function flattenLayers<T extends RasterNode>(layers: readonly T[]): T[] {
  const out: T[] = [];
  const walk = (list: readonly T[]) => {
    for (const l of list) {
      out.push(l);
      const c = childrenOf(l);
      if (c) walk(c);
    }
  };
  walk(layers);
  return out;
}

export function findLayer<T extends RasterNode>(layers: readonly T[], id: string): LayerLocation<T> | null {
  const walk = (list: readonly T[], parent: GroupIn<T> | null, path: GroupIn<T>[]): LayerLocation<T> | null => {
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (l.id === id) return { layer: l, parent, index: i, path };
      const c = childrenOf(l);
      if (c) {
        const g = l as GroupIn<T>;
        const hit = walk(c, g, [...path, g]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(layers, null, []);
}

/** Replaces the layer with `id` by `fn(layer)` (or removes it when `fn` returns `null`). */
export function mapLayer<T extends RasterNode>(layers: readonly T[], id: string, fn: (layer: T) => T | null): T[] {
  let changed = false;
  const walk = (list: readonly T[]): T[] => {
    let out: T[] | null = null;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      let next: T | null = l;
      if (l.id === id) {
        next = fn(l);
        changed = true;
      } else {
        const c = childrenOf(l);
        if (c) {
          const children = walk(c);
          if (children !== c) next = { ...l, children } as T;
        }
      }
      if (next !== l) {
        if (!out) out = list.slice(0, i);
        if (next) out.push(next);
      } else if (out) out.push(l);
    }
    return out ?? (list as T[]);
  };
  const result = walk(layers);
  return changed ? result : (layers as T[]);
}

/** Inserts `layer` into `parentId`'s children (or the top level) at `index` (default: top). */
export function insertLayer<T extends RasterNode>(layers: readonly T[], layer: T, parentId: string | null, index?: number): T[] {
  const put = (list: readonly T[]) => {
    const at = index === undefined ? list.length : Math.max(0, Math.min(list.length, index));
    const next = list.slice();
    next.splice(at, 0, layer);
    return next;
  };
  if (!parentId) return put(layers);
  return mapLayer(layers, parentId, (g) => {
    const c = childrenOf(g);
    return c ? ({ ...g, children: put(c) } as T) : g;
  });
}

export function isLayerLocked(layer: { locks?: LayerLocks }, what: keyof LayerLocks): boolean {
  return Boolean(layer.locks?.all || layer.locks?.[what]);
}
