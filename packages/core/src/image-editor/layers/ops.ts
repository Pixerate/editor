/**
 * Layer tree operations as pure functions: each validates its arguments against the stack and
 * throws a `LayerOperationError` that says what is wrong before changing anything, and returns a
 * new stack that shares every untouched layer. The controller wraps them with undo history.
 */

import type { BlendMode } from '../blend';
import { isBlendMode } from '../blend';
import type { CropBox } from '../types';
import {
  findLayer,
  flattenLayers,
  insertLayer,
  isLayerLocked,
  mapLayer,
  newLayerId,
  type GroupLayer,
  type ImageLayer,
  type LayerBlendMode,
  type LayerFilter,
  type LayerLocks,
  type PixelLayer,
  type RasterMask,
} from './model';

/** A refused layer operation; the message says why and how to fix it. */
export class LayerOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayerOperationError';
  }
}

const fail = (message: string): never => {
  throw new LayerOperationError(message);
};

/** Where a layer goes: above or below a layer (in its group), or at a position in a group. */
export interface LayerPlacement {
  /** Directly above this layer, in the same group. */
  aboveId?: string;
  /** Directly below this layer, in the same group. */
  belowId?: string;
  /** Inside this group (at `index`, default the top). */
  parentId?: string;
  /** Index in the parent's children (or the top level), 0 = bottom. */
  index?: number;
}

/** The layer with `id`, or a `LayerOperationError` listing the ids that exist. */
export function requireLayer(layers: readonly ImageLayer[], id: string) {
  const loc = findLayer(layers, id);
  if (!loc) {
    const ids = flattenLayers(layers).map((l) => l.id);
    fail(`Unknown layer "${id}". ${ids.length ? `Layers: ${ids.join(', ')}.` : 'The document has no layers.'} Call list_layers for ids.`);
  }
  return loc!;
}

/** Refuses when the layer is locked for `what` (and always for `all`). */
export function requireUnlocked(layer: ImageLayer, what: keyof LayerLocks, action: string): void {
  if (isLayerLocked(layer, 'all')) fail(`Layer "${layer.name || layer.id}" is locked (all); unlock it before you ${action}.`);
  if (what !== 'all' && isLayerLocked(layer, what)) fail(`Layer "${layer.name || layer.id}" has its ${what} locked; unlock it before you ${action}.`);
}

/** Inserts `layer` at `placement` (default: the top level at `defaultIndex`, or the top). */
export function placeLayer(layers: readonly ImageLayer[], layer: ImageLayer, placement: LayerPlacement = {}, defaultIndex?: number): ImageLayer[] {
  const given = [placement.aboveId, placement.belowId, placement.parentId].filter((v) => v !== undefined).length;
  if (given > 1) fail('Give only one of aboveId, belowId and parentId.');
  if (placement.aboveId || placement.belowId) {
    const ref = requireLayer(layers, (placement.aboveId ?? placement.belowId)!);
    return insertLayer(layers, layer, ref.parent?.id ?? null, ref.index + (placement.aboveId ? 1 : 0));
  }
  if (placement.parentId) {
    const ref = requireLayer(layers, placement.parentId);
    if (ref.layer.type !== 'group') fail(`Layer "${placement.parentId}" is not a group; parentId must be a group id.`);
    return insertLayer(layers, layer, ref.layer.id, placement.index);
  }
  return insertLayer(layers, layer, null, placement.index ?? defaultIndex);
}

/** Removes a layer (refused when it is locked). */
export function removeLayer(layers: readonly ImageLayer[], id: string): ImageLayer[] {
  const loc = requireLayer(layers, id);
  requireUnlocked(loc.layer, 'all', 'delete it');
  return mapLayer(layers, id, () => null);
}

/** Moves a layer to `placement`. A group cannot go inside itself. Returns the new stack. */
export function moveLayer(layers: readonly ImageLayer[], id: string, placement: LayerPlacement): ImageLayer[] {
  const loc = requireLayer(layers, id);
  requireUnlocked(loc.layer, 'all', 'move it');
  const target = placement.aboveId ?? placement.belowId ?? placement.parentId;
  if (target === id) fail('A layer cannot be placed relative to itself.');
  if (target && loc.layer.type === 'group' && flattenLayers(loc.layer.children).some((l) => l.id === target)) {
    fail(`Group "${id}" cannot be moved into its own child "${target}".`);
  }
  if (target) requireLayer(layers, target);
  if (!target && placement.index === undefined) fail('Give aboveId, belowId, parentId or index.');
  const without = mapLayer(layers, id, () => null);
  return placeLayer(without, loc.layer, placement);
}

/** Every id in a subtree gets a fresh one (for duplicates). */
export function withNewIds<T extends ImageLayer>(layer: T): T {
  const next = { ...layer, id: newLayerId(layer.type === 'adjustment' ? 'adj' : layer.type) } as T;
  if (next.type === 'group') (next as GroupLayer).children = (next as GroupLayer).children.map(withNewIds);
  if (next.type === 'annotation') next.annotation = { ...next.annotation, id: next.id };
  return next;
}

/** Duplicates a layer (and its children) directly above it. Returns the stack and the copy's id. */
export function duplicateLayer(layers: readonly ImageLayer[], id: string, name?: string): { layers: ImageLayer[]; id: string } {
  const loc = requireLayer(layers, id);
  const copy = withNewIds(loc.layer);
  copy.name = name ?? `${loc.layer.name || 'Layer'} copy`;
  delete copy.locks;
  return { layers: insertLayer(layers, copy, loc.parent?.id ?? null, loc.index + 1), id: copy.id };
}

/** Properties `setLayerProperties` changes. */
export interface LayerProperties {
  name?: string;
  visible?: boolean;
  /** 0..1 */
  opacity?: number;
  /** 0..1, pixel layers only. */
  fillOpacity?: number;
  blend?: LayerBlendMode;
  clipped?: boolean;
  locks?: LayerLocks;
  /** Groups only (UI state). */
  collapsed?: boolean;
}

/** Validates and applies property changes to one layer. */
export function setLayerProperties(layers: readonly ImageLayer[], id: string, props: LayerProperties): ImageLayer[] {
  const loc = requireLayer(layers, id);
  const layer = loc.layer;
  const onlyUnlocking = Object.keys(props).every((k) => k === 'locks' || k === 'visible' || k === 'collapsed');
  if (!onlyUnlocking) requireUnlocked(layer, 'all', 'change its properties');
  const next = { ...layer } as ImageLayer;
  if (props.name !== undefined) {
    if (typeof props.name !== 'string' || !props.name.trim()) fail('name must be a non-empty string.');
    next.name = props.name.trim();
  }
  if (props.visible !== undefined) next.visible = Boolean(props.visible);
  if (props.opacity !== undefined) {
    if (!(typeof props.opacity === 'number' && props.opacity >= 0 && props.opacity <= 1)) fail('opacity must be a number from 0 to 1.');
    next.opacity = props.opacity;
  }
  if (props.fillOpacity !== undefined) {
    if (layer.type !== 'pixel') fail(`fillOpacity applies to pixel layers; "${id}" is a ${layer.type} layer.`);
    if (!(typeof props.fillOpacity === 'number' && props.fillOpacity >= 0 && props.fillOpacity <= 1)) fail('fillOpacity must be a number from 0 to 1.');
    const p = next as PixelLayer;
    if (props.fillOpacity === 1) delete p.fillOpacity;
    else p.fillOpacity = props.fillOpacity;
  }
  if (props.blend !== undefined) {
    if (props.blend === 'pass-through') {
      if (layer.type !== 'group') fail('pass-through is only for groups.');
    } else if (!isBlendMode(props.blend)) fail(`Unknown blend mode "${props.blend}".`);
    (next as { blend: LayerBlendMode }).blend = props.blend;
  }
  if (props.clipped !== undefined) {
    if (props.clipped && loc.index === 0) fail('The bottom layer of a group or the stack has nothing below to clip to.');
    if (props.clipped) next.clipped = true;
    else delete next.clipped;
  }
  if (props.locks !== undefined) {
    const locks: LayerLocks = {};
    for (const k of ['pixels', 'transparency', 'position', 'all'] as const) if (props.locks[k]) locks[k] = true;
    if (Object.keys(locks).length) next.locks = locks;
    else delete next.locks;
  }
  if (props.collapsed !== undefined) {
    if (layer.type !== 'group') fail('collapsed applies to groups.');
    const g = next as GroupLayer;
    if (props.collapsed) g.collapsed = true;
    else delete g.collapsed;
  }
  return mapLayer(layers, id, () => next);
}

/**
 * Puts layers (siblings in one group or the top level) into a new group at the position of the
 * topmost one, keeping their order. Returns the stack and the group id.
 */
export function groupLayers(layers: readonly ImageLayer[], ids: string[], name = 'Group'): { layers: ImageLayer[]; id: string } {
  if (!ids.length) fail('Give at least one layer id to group.');
  const locs = ids.map((id) => requireLayer(layers, id));
  const parent = locs[0].parent?.id ?? null;
  if (locs.some((l) => (l.parent?.id ?? null) !== parent)) fail('Layers to group must share one parent; move them next to each other first.');
  for (const l of locs) requireUnlocked(l.layer, 'all', 'group it');
  const ordered = [...new Set(locs)].sort((a, b) => a.index - b.index);
  const top = ordered[ordered.length - 1].index;
  const below = ordered.filter((l) => l.index < top).length;
  const group: GroupLayer = {
    type: 'group',
    id: newLayerId('group'),
    name,
    visible: true,
    opacity: 1,
    blend: 'pass-through',
    children: ordered.map((l) => {
      const c = { ...l.layer } as ImageLayer;
      return c;
    }),
  };
  // The bottom child cannot be clipped to anything inside the new group.
  if (group.children[0]?.clipped) {
    const c = { ...group.children[0] };
    delete c.clipped;
    group.children[0] = c;
  }
  let out = layers as ImageLayer[];
  for (const l of ordered) out = mapLayer(out, l.layer.id, () => null);
  return { layers: insertLayer(out, group, parent, top - below), id: group.id };
}

/** Replaces a group by its children (the group's own opacity, blend and mask are dropped). */
export function ungroupLayer(layers: readonly ImageLayer[], id: string): { layers: ImageLayer[]; ids: string[] } {
  const loc = requireLayer(layers, id);
  if (loc.layer.type !== 'group') fail(`Layer "${id}" is not a group.`);
  requireUnlocked(loc.layer, 'all', 'ungroup it');
  const group = loc.layer as GroupLayer;
  let out = mapLayer(layers, id, () => null);
  group.children.forEach((c, i) => {
    out = insertLayer(out, c, loc.parent?.id ?? null, loc.index + i);
  });
  return { layers: out, ids: group.children.map((c) => c.id) };
}

/** Sets a pixel layer's offset (refused when its position is locked). */
export function offsetLayer(layers: readonly ImageLayer[], id: string, offset: { x: number; y: number }): ImageLayer[] {
  const loc = requireLayer(layers, id);
  if (loc.layer.type !== 'pixel') fail(`Only pixel layers move; "${id}" is a ${loc.layer.type} layer.`);
  requireUnlocked(loc.layer, 'position', 'move it');
  if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) fail('x and y must be numbers.');
  const layer = loc.layer as PixelLayer;
  return mapLayer(layers, id, () => ({ ...layer, offset: { x: Math.round(offset.x), y: Math.round(offset.y) } }));
}

/** Sets or removes (`null`) a layer's mask. */
export function setLayerMask(layers: readonly ImageLayer[], id: string, mask: RasterMask | null): ImageLayer[] {
  const loc = requireLayer(layers, id);
  requireUnlocked(loc.layer, 'all', 'change its mask');
  return mapLayer(layers, id, (l) => {
    const next = { ...l } as ImageLayer;
    if (mask) next.mask = mask;
    else delete next.mask;
    return next;
  });
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const DEVELOP_FIELDS = ['brightness', 'contrast', 'saturation', 'exposure', 'temperature', 'tint'] as const;

/** A clean filter from loose input (for tools and the UI). */
export function normalizeFilter(raw: Partial<LayerFilter> & { kind: LayerFilter['kind'] }, id = newLayerId('flt')): LayerFilter {
  const enabled = raw.enabled !== false;
  if (raw.kind === 'blur') {
    const r = (raw as { radius?: unknown }).radius;
    if (r !== undefined && !(typeof r === 'number' && r >= 0 && r <= 50)) fail('blur radius must be a number from 0 to 50 px.');
    return { id, kind: 'blur', enabled, radius: typeof r === 'number' ? r : 2 };
  }
  if (raw.kind !== 'develop') fail(`Unknown filter kind "${(raw as { kind: string }).kind}". Use develop or blur.`);
  const out = { id, kind: 'develop', enabled, brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, tint: 0, process: 2 } as LayerFilter & { kind: 'develop' };
  for (const k of DEVELOP_FIELDS) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (!(typeof v === 'number' && v >= -100 && v <= 100)) fail(`${k} must be a number from -100 to 100.`);
    out[k] = v as number;
  }
  const p = (raw as { process?: unknown }).process;
  if (p !== undefined) {
    if (p !== 1 && p !== 2) fail('process must be 1 or 2.');
    out.process = p as 1 | 2;
  }
  return out;
}

function requirePixelLayer(layers: readonly ImageLayer[], id: string): PixelLayer {
  const loc = requireLayer(layers, id);
  if (loc.layer.type !== 'pixel') fail(`Filters belong to pixel layers; "${id}" is a ${loc.layer.type} layer.`);
  requireUnlocked(loc.layer, 'all', 'change its filters');
  return loc.layer as PixelLayer;
}

/** Adds a filter on top of a pixel layer's filters. A layer has at most one filter of each kind. */
export function addLayerFilter(layers: readonly ImageLayer[], id: string, filter: LayerFilter): ImageLayer[] {
  const layer = requirePixelLayer(layers, id);
  if (layer.filters?.some((f) => f.kind === filter.kind)) fail(`Layer "${id}" already has a ${filter.kind} filter; change it with update_layer_filter.`);
  return mapLayer(layers, id, () => ({ ...layer, filters: [...(layer.filters ?? []), filter] }));
}

/** Changes one filter of a pixel layer (`changes` merged and validated). */
export function updateLayerFilter(layers: readonly ImageLayer[], id: string, filterId: string, changes: Record<string, unknown>): ImageLayer[] {
  const layer = requirePixelLayer(layers, id);
  const i = (layer.filters ?? []).findIndex((f) => f.id === filterId);
  if (i === -1) fail(`Layer "${id}" has no filter "${filterId}". Filters: ${(layer.filters ?? []).map((f) => f.id).join(', ') || 'none'}.`);
  const current = layer.filters![i];
  if ('kind' in changes && changes.kind !== current.kind) fail('A filter kind cannot change; remove it and add another.');
  const merged = normalizeFilter({ ...current, ...changes, kind: current.kind } as LayerFilter, current.id);
  const filters = [...layer.filters!];
  filters[i] = merged;
  return mapLayer(layers, id, () => ({ ...layer, filters }));
}

export function removeLayerFilter(layers: readonly ImageLayer[], id: string, filterId: string): ImageLayer[] {
  const layer = requirePixelLayer(layers, id);
  if (!(layer.filters ?? []).some((f) => f.id === filterId)) fail(`Layer "${id}" has no filter "${filterId}".`);
  const filters = layer.filters!.filter((f) => f.id !== filterId);
  const next = { ...layer };
  if (filters.length) next.filters = filters;
  else delete next.filters;
  return mapLayer(layers, id, () => next);
}

/** A blend mode check for tools. */
export function parseBlend(value: unknown, allowPassThrough = false): BlendMode | 'pass-through' | undefined {
  if (value === undefined) return undefined;
  if (value === 'pass-through' && allowPassThrough) return value;
  if (!isBlendMode(value)) fail(`Unknown blend mode "${String(value)}".`);
  return value as BlendMode;
}

/** The union of two rectangles (either may be null). */
export function unionRect(a: CropBox | null, b: CropBox | null): CropBox | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
