/**
 * Layer tree operations as pure functions: each validates its arguments against the stack and
 * throws a `LayerOperationError` that says what is wrong before changing anything, and returns a
 * new stack that shares every untouched layer. The controller wraps them with undo history.
 */

import type { BlendMode } from '../blend';
import { isBlendMode } from '../blend';
import type { CropBox } from '../types';
import { translateSurface } from '../../raster/surface';
import {
  defaultLayerEffect,
  isLayerEffectKind,
  LAYER_EFFECT_KINDS,
  LayerEffectError,
  mergeLayerEffect,
  newEffectId,
  validateLayerEffects,
  type LayerEffect,
  type LayerEffectKind,
  type LayerEffects,
} from '../../raster/effects/model';
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
  // A copy of a migrated shape is a shape of its own, not a second view of the annotation.
  if (next.type === 'shape') delete next.annotation;
  if (next.type === 'smart' && next.psd?.placed) {
    // A copy is another instance of the same contents: Photoshop needs it to have its own instance id.
    next.psd = { ...next.psd };
    delete next.psd.placed;
  }
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
    if (layer.type !== 'pixel' && layer.type !== 'smart' && layer.type !== 'shape') fail(`fillOpacity applies to pixel, shape and smart object layers; "${id}" is a ${layer.type} layer.`);
    if (!(typeof props.fillOpacity === 'number' && props.fillOpacity >= 0 && props.fillOpacity <= 1)) fail('fillOpacity must be a number from 0 to 1.');
    const p = next as { fillOpacity?: number };
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

/** Sets a pixel layer's offset (refused when its position is locked). An unlinked mask stays in place. */
export function offsetLayer(layers: readonly ImageLayer[], id: string, offset: { x: number; y: number }): ImageLayer[] {
  const loc = requireLayer(layers, id);
  if (loc.layer.type !== 'pixel') fail(`Only pixel layers move; "${id}" is a ${loc.layer.type} layer.`);
  requireUnlocked(loc.layer, 'position', 'move it');
  if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) fail('x and y must be numbers.');
  const layer = loc.layer as PixelLayer;
  const next: PixelLayer = { ...layer, offset: { x: Math.round(offset.x), y: Math.round(offset.y) } };
  const mask = layer.mask;
  if (mask && mask.linked === false && !mask.source) {
    // An unlinked mask stays where it is in the document, so it moves the other way in layer space.
    next.mask = { ...mask, surface: translateSurface(mask.surface, layer.offset.x - next.offset.x, layer.offset.y - next.offset.y) };
  }
  return mapLayer(layers, id, () => next);
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

// ---------------------------------------------------------------------------
// Layer effects
// ---------------------------------------------------------------------------

/** A layer that can carry effects (pixel, annotation and group layers), checked for locks. */
function requireEffectLayer(layers: readonly ImageLayer[], id: string, action: string): ImageLayer {
  const layer = requireLayer(layers, id).layer;
  if (layer.type === 'adjustment') fail(`Layer "${layer.name || id}" is an adjustment layer; effects go on pixel, annotation and group layers.`);
  requireUnlocked(layer, 'all', action);
  return layer;
}

/** A layer's effects, or an empty, enabled list when it has none. */
export function layerEffectsOf(layer: ImageLayer): LayerEffects {
  return layer.effects ?? { enabled: true, items: [] };
}

/** Wraps an effect validation error as a layer operation error (same message). */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LayerEffectError) fail(e.message);
    throw e;
  }
}

/** Replaces a layer's effects (validated); `null` or an empty list without a PSD block removes them. */
export function setLayerEffects(layers: readonly ImageLayer[], id: string, effects: LayerEffects | null): ImageLayer[] {
  const layer = requireEffectLayer(layers, id, 'change its effects');
  const next = { ...layer };
  if (effects && (effects.items.length || effects.psd || effects.scale !== undefined || !effects.enabled)) {
    guard(() => validateLayerEffects(effects));
    next.effects = effects;
  } else delete next.effects;
  return mapLayer(layers, id, () => next as ImageLayer);
}

/**
 * Adds an effect of `kind` (Photoshop's defaults with `params` applied) to a layer's effects, at
 * `index` in the list (default: the end; the first listed of a kind is on top). Returns the stack
 * and the new effect.
 */
export function addLayerEffect(
  layers: readonly ImageLayer[],
  id: string,
  kind: LayerEffectKind,
  params: Record<string, unknown> = {},
  index?: number
): { layers: ImageLayer[]; effect: LayerEffect } {
  if (!isLayerEffectKind(kind)) fail(`Unknown effect kind "${String(kind)}". Kinds: ${LAYER_EFFECT_KINDS.join(', ')}.`);
  const layer = requireEffectLayer(layers, id, 'add effects');
  const current = layerEffectsOf(layer);
  const ids = new Set(current.items.map((e) => e.id));
  let effectId = newEffectId();
  while (ids.has(effectId)) effectId = newEffectId();
  const { id: _ignored, kind: _kind, ...rest } = params;
  const effect = guard(() => mergeLayerEffect(defaultLayerEffect(kind, effectId), rest));
  const items = [...current.items];
  const at = index === undefined ? items.length : Math.max(0, Math.min(items.length, Math.floor(index)));
  items.splice(at, 0, effect);
  return { layers: setLayerEffects(layers, id, { ...current, items }), effect };
}

/** The index of effect `effectId` on a layer, or a `LayerOperationError` listing the effect ids. */
function requireEffect(layer: ImageLayer, effectId: string): number {
  const items = layer.effects?.items ?? [];
  const i = items.findIndex((e) => e.id === effectId);
  if (i === -1) fail(`Layer "${layer.name || layer.id}" has no effect "${effectId}". Effects: ${items.map((e) => `${e.id} (${e.kind})`).join(', ') || 'none'}; call list_layer_effects.`);
  return i;
}

/** Changes one effect (only the given fields; nested objects replace whole, `null` removes an optional one). */
export function updateLayerEffect(layers: readonly ImageLayer[], id: string, effectId: string, changes: Record<string, unknown>): ImageLayer[] {
  const layer = requireEffectLayer(layers, id, 'change its effects');
  const i = requireEffect(layer, effectId);
  const current = layer.effects!;
  const items = [...current.items];
  items[i] = guard(() => mergeLayerEffect(items[i], changes));
  return setLayerEffects(layers, id, { ...current, items });
}

export function removeLayerEffect(layers: readonly ImageLayer[], id: string, effectId: string): ImageLayer[] {
  const layer = requireEffectLayer(layers, id, 'change its effects');
  requireEffect(layer, effectId);
  const current = layer.effects!;
  return setLayerEffects(layers, id, { ...current, items: current.items.filter((e) => e.id !== effectId) });
}

/** Sets the master switch and, when given, Scale Effects (0.01..10, 1 = 100 %). */
export function setLayerEffectsEnabled(layers: readonly ImageLayer[], id: string, enabled: boolean, scale?: number): ImageLayer[] {
  const layer = requireEffectLayer(layers, id, 'change its effects');
  if (scale !== undefined && !(Number.isFinite(scale) && scale >= 0.01 && scale <= 10)) fail(`scale must be from 0.01 to 10 (1 = 100 %), got ${scale}.`);
  const current = layerEffectsOf(layer);
  const next: LayerEffects = { ...current, enabled };
  if (scale !== undefined) {
    if (scale === 1) delete next.scale;
    else next.scale = scale;
  }
  return setLayerEffects(layers, id, next);
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
