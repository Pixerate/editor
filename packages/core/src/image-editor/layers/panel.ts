/**
 * The layers panel's view model, shared by the React and Svelte panels: the rows to show (top of
 * the stack first, groups indented, collapsed groups hiding their children), where a drop lands,
 * and the menu of layer operations with whether each one applies to the active layer.
 */

import { ADJUSTMENT_KINDS, adjustmentKindLabel, isAdjustmentKind } from '../adjustment-layers';
import type { AdjustmentKind } from '../types';
import type { ImageEditorController } from '../controller';
import { findLayer, type ImageLayer, type SmartFilter, type SmartObjectLayer } from './model';
import type { LayerPlacement } from './ops';

import { selectionModeFromModifiers } from '../selection/tool-options';

/**
 * A click on a layer's mask thumbnail, as in Photoshop: Ctrl/⌘-click loads the mask as the
 * selection (with Shift adding, Alt subtracting, both intersecting), Alt-click shows the mask
 * alone in grey (Alt+Shift-click as a red overlay; again to go back to the image), Shift-click
 * turns the mask on or off, and a plain click makes the mask the paint target.
 */
export function maskThumbnailClick(
  controller: ImageEditorController,
  layer: ImageLayer,
  e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }
): void {
  if (!layer.mask) return;
  if (e.ctrlKey || e.metaKey) {
    controller.selectionFromLayerMask(layer.id, selectionModeFromModifiers(e, 'replace'));
  } else if (e.altKey && !layer.mask.source) {
    const mode = e.shiftKey ? 'overlay' : 'gray';
    const view = controller.getMaskView();
    controller.setMaskView(view?.layerId === layer.id && view.mode === mode ? 'off' : mode, layer.id);
  } else if (e.shiftKey) {
    controller.setLayerMaskProps(layer.id, { enabled: layer.mask.enabled === false });
  } else {
    controller.setActiveLayer(layer.id, 'mask');
  }
}

/**
 * A click on a layer's vector mask thumbnail: Ctrl/⌘-click loads the path as the selection (Shift
 * adds, Alt subtracts, both intersect) and Shift-click turns the vector mask on or off.
 */
export function vectorMaskThumbnailClick(
  controller: ImageEditorController,
  layer: ImageLayer,
  e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }
): void {
  if (!layer.vectorMask) return;
  if (e.ctrlKey || e.metaKey) controller.selectionFromVectorMask(layer.id, selectionModeFromModifiers(e, 'replace'));
  else if (e.shiftKey) controller.setVectorMaskProps(layer.id, { enabled: layer.vectorMask.enabled === false });
}

/**
 * A click on a layer's pixel thumbnail: Ctrl/⌘-click loads the layer's transparency as the
 * selection (Shift adds, Alt subtracts, both intersect) and returns true; other clicks are left
 * to the row (false).
 */
export function layerThumbnailClick(
  controller: ImageEditorController,
  layer: ImageLayer,
  e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }
): boolean {
  if (!(e.ctrlKey || e.metaKey)) return false;
  controller.selectLayerTransparency(layer.id, { mode: selectionModeFromModifiers(e, 'replace') });
  return true;
}

export interface LayerPanelRow {
  layer: ImageLayer;
  /** Nesting depth (0 = top level). */
  depth: number;
  parentId: string | null;
  /** Index among its siblings, 0 = bottom. */
  index: number;
  active: boolean;
  /** Display name (adjustment layers without a name show their kind). */
  label: string;
  /** Clipped to the layer below (drawn with an indent arrow). */
  clipped: boolean;
}

/** Rows top to bottom; children of collapsed groups are left out. */
export function layerPanelRows(layers: readonly ImageLayer[], activeId: string | null): LayerPanelRow[] {
  const rows: LayerPanelRow[] = [];
  const walk = (list: readonly ImageLayer[], depth: number, parentId: string | null) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const layer = list[i];
      rows.push({
        layer,
        depth,
        parentId,
        index: i,
        active: layer.id === activeId,
        label: layerLabel(layer),
        clipped: Boolean(layer.clipped),
      });
      if (layer.type === 'group' && !layer.collapsed) walk(layer.children, depth + 1, layer.id);
    }
  };
  walk(layers, 0, null);
  return rows;
}

export function layerLabel(layer: ImageLayer): string {
  if (layer.name) return layer.name;
  if (layer.type === 'adjustment') return adjustmentKindLabel(layer.kind);
  return layer.type === 'group' ? 'Group' : 'Layer';
}

/** A short type badge for rows without a thumbnail. */
export function layerBadge(layer: ImageLayer): string {
  switch (layer.type) {
    case 'pixel':
      return 'px';
    case 'adjustment':
      return 'adj';
    case 'group':
      return 'grp';
    case 'annotation':
      return layer.annotation.type === 'text' ? 'T' : 'ann';
    case 'smart':
      return 'so';
    case 'shape':
      return 'shp';
    case 'type':
      return 'T';
  }
}

/** Whether the layer's row shows a pixel thumbnail (pixel, shape and type layers; shapes and type with a badge on it). */
export function layerHasThumbnail(layer: ImageLayer): boolean {
  return layer.type === 'pixel' || layer.type === 'shape' || layer.type === 'type';
}

/** A warning to show on a layer's row (a type layer drawn with fallback fonts), or `null`. */
export function layerWarning(layer: ImageLayer): string | null {
  if (layer.type === 'type' && layer.missingFonts?.length) {
    return `Missing ${layer.missingFonts.length === 1 ? 'font' : 'fonts'}: ${layer.missingFonts.join(', ')}. ${layer.rendering === 'stored' ? 'Showing the saved pixels until the text is edited.' : 'Drawn with a fallback font.'}`;
  }
  return null;
}

/** Where a row was dropped on: the top or bottom part of the row, or the middle of a group row. */
export type DropZone = 'above' | 'below' | 'inside';

/** The zone for a pointer at `fraction` (0 top .. 1 bottom) of a row's height. */
export function dropZone(fraction: number, isGroup: boolean): DropZone {
  if (isGroup && fraction > 0.3 && fraction < 0.7) return 'inside';
  return fraction < 0.5 ? 'above' : 'below';
}

/** The placement for `move_layer` when `dragId` is dropped on row `targetId` in `zone`, or `null` for a no-op. */
export function dropPlacement(layers: readonly ImageLayer[], dragId: string, targetId: string, zone: DropZone): LayerPlacement | null {
  if (dragId === targetId) return null;
  const target = findLayer(layers, targetId);
  if (!target) return null;
  if (zone === 'inside' && target.layer.type === 'group') return { parentId: targetId };
  // The panel lists the top first: dropping above a row means higher in the stack.
  return zone === 'above' ? { aboveId: targetId } : { belowId: targetId };
}

export type LayerMenuAction =
  | 'new-layer'
  | 'new-group'
  | 'duplicate'
  | 'delete'
  | 'group-selected'
  | 'ungroup'
  | 'merge-down'
  | 'merge-visible'
  | 'flatten'
  | 'via-copy'
  | 'via-cut'
  | 'add-mask'
  | 'add-vector-mask'
  | 'add-vector-mask-hide'
  | 'add-vector-mask-selection'
  | 'delete-vector-mask'
  | 'toggle-vector-mask'
  | 'rasterize-vector-mask'
  | 'add-mask-selection'
  | 'add-mask-hide-selection'
  | 'add-mask-transparency'
  | 'select-transparency'
  | 'apply-mask'
  | 'delete-mask'
  | 'toggle-mask'
  | 'toggle-mask-link'
  | 'toggle-clip'
  | 'rasterize'
  | 'convert-smart'
  | 'edit-contents'
  | 'smart-via-copy'
  | 'add-filter-mask';

export interface LayerMenuItem {
  action: LayerMenuAction;
  label: string;
  enabled: boolean;
}

/** The layer menu for the controller's current state (active layer, selection). */
export function layerMenu(controller: ImageEditorController): LayerMenuItem[] {
  const s = controller.getState();
  const active = controller.getActiveLayer();
  const loc = active ? findLayer(s.layers, active.id) : null;
  const siblings = loc ? (loc.parent ? loc.parent.children : s.layers) : [];
  const below = loc ? siblings[loc.index - 1] : undefined;
  const hasSel = controller.hasSelection;
  const isPixel = active?.type === 'pixel';
  const hasOwnPixels = active?.type === 'pixel' || active?.type === 'shape' || active?.type === 'type' || active?.type === 'smart';
  return [
    { action: 'new-layer', label: 'New Layer', enabled: true },
    { action: 'new-group', label: 'New Group', enabled: true },
    { action: 'duplicate', label: 'Duplicate Layer', enabled: Boolean(active) },
    { action: 'delete', label: 'Delete Layer', enabled: Boolean(active) },
    { action: 'group-selected', label: 'Group Layer', enabled: Boolean(active) },
    { action: 'ungroup', label: 'Ungroup', enabled: active?.type === 'group' },
    { action: 'merge-down', label: 'Merge Down', enabled: Boolean(active?.visible && below?.type === 'pixel') },
    { action: 'merge-visible', label: 'Merge Visible', enabled: s.layers.some((l) => l.visible) },
    { action: 'flatten', label: 'Flatten Image', enabled: s.layers.length > 0 },
    { action: 'via-copy', label: 'Layer via Copy', enabled: isPixel && hasSel },
    { action: 'via-cut', label: 'Layer via Cut', enabled: isPixel && hasSel },
    { action: 'add-mask', label: 'Add Layer Mask', enabled: Boolean(active) },
    { action: 'add-mask-selection', label: 'Add Mask from Selection', enabled: Boolean(active) && hasSel },
    { action: 'add-mask-hide-selection', label: 'Add Mask Hiding Selection', enabled: Boolean(active) && hasSel },
    { action: 'add-mask-transparency', label: 'Add Mask from Transparency', enabled: hasOwnPixels },
    { action: 'select-transparency', label: 'Select Layer Pixels', enabled: hasOwnPixels },
    { action: 'apply-mask', label: 'Apply Layer Mask', enabled: isPixel && Boolean(active?.mask) },
    { action: 'delete-mask', label: 'Delete Layer Mask', enabled: Boolean(active?.mask) },
    { action: 'toggle-mask', label: active?.mask?.enabled === false ? 'Enable Layer Mask' : 'Disable Layer Mask', enabled: Boolean(active?.mask) },
    { action: 'toggle-mask-link', label: active?.mask?.linked === false ? 'Link Layer Mask' : 'Unlink Layer Mask', enabled: Boolean(active?.mask && !active.mask.source) },
    { action: 'add-vector-mask', label: 'Add Vector Mask (Reveal All)', enabled: Boolean(active && active.type !== 'shape' && !active.mask?.source) },
    { action: 'add-vector-mask-hide', label: 'Add Vector Mask (Hide All)', enabled: Boolean(active && active.type !== 'shape' && !active.mask?.source) },
    { action: 'add-vector-mask-selection', label: 'Add Vector Mask from Selection', enabled: Boolean(active && active.type !== 'shape' && !active.mask?.source) && hasSel },
    { action: 'delete-vector-mask', label: 'Delete Vector Mask', enabled: Boolean(active?.vectorMask) },
    { action: 'toggle-vector-mask', label: active?.vectorMask?.enabled === false ? 'Enable Vector Mask' : 'Disable Vector Mask', enabled: Boolean(active?.vectorMask) },
    { action: 'rasterize-vector-mask', label: 'Rasterize Vector Mask', enabled: Boolean(active?.vectorMask) },
    { action: 'rasterize', label: 'Rasterize Layer', enabled: active?.type === 'annotation' || active?.type === 'smart' || active?.type === 'shape' || active?.type === 'type' || (isPixel && Boolean(active?.type === 'pixel' && active.filters?.length)) },
    { action: 'convert-smart', label: 'Convert to Smart Object', enabled: Boolean(active && active.type !== 'annotation') },
    { action: 'edit-contents', label: 'Edit Contents', enabled: active?.type === 'smart' },
    { action: 'smart-via-copy', label: 'New Smart Object via Copy', enabled: active?.type === 'smart' },
    { action: 'add-filter-mask', label: 'Add Smart Filter Mask', enabled: active?.type === 'smart' && !active.smartFilters?.mask },
    { action: 'toggle-clip', label: active?.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask', enabled: Boolean(loc && loc.index > 0) },
  ];
}

/** Runs a menu action on the active layer. Resolves to the error message when it was refused. */
export async function runLayerMenuAction(controller: ImageEditorController, action: LayerMenuAction): Promise<string | null> {
  const active = controller.getActiveLayer();
  const id = active?.id;
  try {
    switch (action) {
      case 'new-layer':
        controller.addPixelLayer();
        break;
      case 'new-group':
        controller.addGroup();
        break;
      case 'duplicate':
        if (id) controller.duplicateLayer(id);
        break;
      case 'delete':
        if (id) controller.removeLayer(id);
        break;
      case 'group-selected':
        if (id) controller.groupLayers([id]);
        break;
      case 'ungroup':
        if (id) controller.ungroupLayer(id);
        break;
      case 'merge-down':
        if (id) await controller.mergeDown(id);
        break;
      case 'merge-visible':
        await controller.mergeVisible();
        break;
      case 'flatten':
        await controller.flattenImage();
        break;
      case 'via-copy':
      case 'via-cut':
        controller.layerViaCopy({ cut: action === 'via-cut' });
        break;
      case 'add-mask':
        if (id) controller.addLayerMask(id, 'reveal-all');
        break;
      case 'add-mask-hide-selection':
        if (id) controller.addLayerMask(id, 'hide-selection');
        break;
      case 'add-mask-transparency':
        if (id) controller.addLayerMask(id, 'transparency');
        break;
      case 'select-transparency':
        if (id) controller.selectLayerTransparency(id);
        break;
      case 'add-mask-selection':
        if (id) controller.addLayerMask(id, 'selection');
        break;
      case 'apply-mask':
        if (id) await controller.applyLayerMask(id);
        break;
      case 'delete-mask':
        if (id) controller.removeLayerMask(id);
        break;
      case 'toggle-mask':
        if (id && active?.mask) controller.setLayerMaskProps(id, { enabled: active.mask.enabled === false });
        break;
      case 'toggle-mask-link':
        if (id && active?.mask) controller.setLayerMaskProps(id, { linked: active.mask.linked === false });
        break;
      case 'add-vector-mask':
      case 'add-vector-mask-hide':
        if (id) controller.addVectorMask(id, action === 'add-vector-mask' ? 'reveal-all' : 'hide-all');
        break;
      case 'add-vector-mask-selection':
        if (id) controller.addVectorMask(id, 'selection');
        break;
      case 'delete-vector-mask':
        if (id) controller.removeVectorMask(id);
        break;
      case 'toggle-vector-mask':
        if (id && active?.vectorMask) controller.setVectorMaskProps(id, { enabled: active.vectorMask.enabled === false });
        break;
      case 'rasterize-vector-mask':
        if (id) controller.rasterizeVectorMask(id);
        break;
      case 'rasterize':
        if (id) await controller.rasterizeLayer(id);
        break;
      case 'convert-smart':
        if (id) controller.convertToSmartObject([id]);
        break;
      case 'edit-contents':
        if (id) controller.editSmartObjectContents(id);
        break;
      case 'smart-via-copy':
        if (id) controller.copySmartObject(id, false);
        break;
      case 'add-filter-mask':
        if (id) controller.setSmartFilterMask(id, 'reveal-all');
        break;
      case 'toggle-clip':
        if (id) controller.setLayerProperties(id, { clipped: !active?.clipped });
        break;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** One row of a smart object's filter list (Photoshop shows them under the layer, top filter first). */
export interface SmartFilterRow {
  filter: SmartFilter;
  /** Display name: Develop, Blur (radius), or the Photoshop filter's name. */
  label: string;
  /** Index in the stack, 0 = bottom (applied first). */
  index: number;
  /** False for Photoshop filters we keep but do not draw. */
  drawn: boolean;
}

/** The filter rows of a smart object, top filter first (empty when it has none). */
export function smartFilterRows(layer: ImageLayer): SmartFilterRow[] {
  if (layer.type !== 'smart') return [];
  const list = (layer as SmartObjectLayer).smartFilters?.filters ?? [];
  const rows: SmartFilterRow[] = list.map((f, index) => ({
    filter: f,
    index,
    drawn: f.kind !== 'psd',
    label: f.kind === 'psd' ? f.name.replace(/&/g, '').replace(/\.\.\.$/, '') : f.kind === 'effect' ? (f.name ?? f.effect) : f.kind === 'blur' ? `Blur (${f.radius} px)` : 'Develop',
  }));
  return rows.reverse();
}

export interface NormalizedLayerItem {
  id: string;
  name: string;
  imageUrl: string;
  thumbnailUrl?: string;
  visible: boolean;
  opacity: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Extracts a flat list of normalized layer metadata (0..1 bounds relative to document dimensions
 * and resolved PNG data-URL thumbnails) from the controller's current V3 layer state.
 */
export function extractNormalizedLayerItems(
  controller: ImageEditorController,
  fallbackImageUrl = ''
): NormalizedLayerItem[] {
  const state = controller.getState();
  const ctrlLayers = controller.getLayers();
  if (!ctrlLayers || ctrlLayers.length === 0) return [];

  const serialized = controller.toJSON() as {
    assets?: Record<string, string>;
    layers?: Array<{ id: string; asset?: string; source?: string; children?: unknown[] }>;
  };
  const assets = serialized.assets ?? {};
  const allSerializedLayers: Array<{ id: string; asset?: string; source?: string; children?: unknown[] }> = [];

  const collectSerialized = (list: Array<{ id: string; asset?: string; source?: string; children?: unknown[] }>) => {
    for (const sl of list) {
      allSerializedLayers.push(sl);
      if (sl.children && Array.isArray(sl.children)) {
        collectSerialized(sl.children as Array<{ id: string; asset?: string; source?: string; children?: unknown[] }>);
      }
    }
  };
  collectSerialized(serialized.layers ?? []);

  const sLayerMap = new Map(allSerializedLayers.map((sl) => [sl.id, sl]));
  const imgW = state.imageDimensions?.width || 1;
  const imgH = state.imageDimensions?.height || 1;

  return ctrlLayers.map((l) => {
    const bounds = controller.getLayerBounds(l.id) || {
      x: 0,
      y: 0,
      width: imgW,
      height: imgH,
    };
    const sLayer = sLayerMap.get(l.id);
    const assetKey = sLayer?.asset;
    const layerDataUrl =
      (assetKey && assets[assetKey]) ||
      assets[l.id] ||
      (sLayer?.source === 'document' ? fallbackImageUrl : '');
    return {
      id: l.id,
      name: l.name || 'Untitled Layer',
      imageUrl: layerDataUrl || fallbackImageUrl,
      thumbnailUrl: layerDataUrl || undefined,
      visible: l.visible !== false,
      opacity: l.opacity ?? 1,
      x: imgW ? bounds.x / imgW : 0,
      y: imgH ? bounds.y / imgH : 0,
      width: imgW ? bounds.width / imgW : 1,
      height: imgH ? bounds.height / imgH : 1,
    };
  });
}


/** Image › Mode: the bit depths a panel offers, with their labels. */
export const BIT_DEPTH_OPTIONS: readonly { depth: 8 | 16 | 32; label: string; title: string }[] = [
  { depth: 8, label: '8-bit', title: '8 bits per channel' },
  { depth: 16, label: '16-bit', title: '16 bits per channel: smooth gradients, no banding under strong adjustments' },
  { depth: 32, label: '32-bit', title: '32-bit float per channel, linear light (HDR)' },
];

export interface NewLayerOption {
  id: string;
  label: string;
  icon: string;
  group?: string;
  disabled?: boolean;
  reason?: string;
  /**
   * The host has the user pick something before adding: `'effect'` is one of the provider's
   * effects with a use in `EFFECT_LAYER_USES` (an `EffectsBrowser` with those `uses`), passed to
   * `addLayerOfKind` as `init.effect`.
   */
  pick?: 'effect';
}

/** The effect uses an effect layer draws: generators, overlays and titles (filters apply to a layer instead). */
export const EFFECT_LAYER_USES = ['generator', 'overlay', 'title'] as const;

/**
 * Catalogue of layer types and adjustment layers that can be added dynamically to the controller,
 * with an effect layer when it has an effects provider.
 */
export function newLayerOptions(controller: ImageEditorController): NewLayerOption[] {
  const options: NewLayerOption[] = [
    { id: 'pixel', label: 'Empty Layer', icon: 'square-dashed', group: 'Basic' },
    { id: 'text', label: 'Text Layer', icon: 'type', group: 'Basic' },
    { id: 'shape-rect', label: 'Rectangle Shape', icon: 'square', group: 'Shapes' },
    { id: 'shape-ellipse', label: 'Ellipse Shape', icon: 'circle', group: 'Shapes' },
    { id: 'group', label: 'Group Folder', icon: 'folder', group: 'Basic' },
  ];

  for (const { kind, label } of ADJUSTMENT_KINDS) {
    options.push({
      id: `adjustment-${kind}`,
      label,
      icon: 'sliders',
      group: 'Adjustments',
    });
  }

  if (controller.effectsProvider) {
    options.push({ id: 'effect', label: 'Effect Layer…', icon: 'sparkles', group: 'Effects', pick: 'effect' });
  }

  return options;
}

/**
 * Adds a new layer of the specified catalogue kind to the controller.
 */
export async function addLayerOfKind(
  controller: ImageEditorController,
  id: string,
  init?: Record<string, unknown>
): Promise<string> {
  if (id === 'pixel') {
    return controller.addPixelLayer(init as Parameters<ImageEditorController['addPixelLayer']>[0]);
  }
  if (id === 'group') {
    return controller.addGroup(init as Parameters<ImageEditorController['addGroup']>[0]);
  }
  if (id === 'text') {
    const canvas = controller.getCanvasSize();
    const cx = Math.round(canvas.width / 2);
    const cy = Math.round(canvas.height / 2);
    return controller.addTextLayer({
      text: (init?.text as string) || 'New Text',
      x: typeof init?.x === 'number' ? init.x : cx - 100,
      y: typeof init?.y === 'number' ? init.y : cy,
      ...(init as object),
    });
  }
  if (id === 'shape-rect') {
    const canvas = controller.getCanvasSize();
    const cx = Math.round(canvas.width / 2);
    const cy = Math.round(canvas.height / 2);
    const w = 200;
    const h = 150;
    return controller.addShapeLayer({
      shape: {
        kind: 'rect',
        x: typeof init?.x === 'number' ? init.x : cx - Math.round(w / 2),
        y: typeof init?.y === 'number' ? init.y : cy - Math.round(h / 2),
        width: typeof init?.width === 'number' ? init.width : w,
        height: typeof init?.height === 'number' ? init.height : h,
      },
      name: 'Rectangle',
      ...(init as object),
    });
  }
  if (id === 'shape-ellipse') {
    const canvas = controller.getCanvasSize();
    const cx = Math.round(canvas.width / 2);
    const cy = Math.round(canvas.height / 2);
    const w = 200;
    const h = 200;
    return controller.addShapeLayer({
      shape: {
        kind: 'ellipse',
        x: typeof init?.x === 'number' ? init.x : cx - Math.round(w / 2),
        y: typeof init?.y === 'number' ? init.y : cy - Math.round(h / 2),
        width: typeof init?.width === 'number' ? init.width : w,
        height: typeof init?.height === 'number' ? init.height : h,
      },
      name: 'Ellipse',
      ...(init as object),
    });
  }
  if (id === 'effect') {
    const { effect, ...options } = (init ?? {}) as { effect?: unknown } & Parameters<ImageEditorController['addEffectLayer']>[1];
    if (typeof effect !== 'string' || !effect) throw new Error('An effect layer needs init.effect: the effect to draw.');
    return controller.addEffectLayer(effect, options);
  }
  if (id.startsWith('adjustment-')) {
    const kind = id.slice('adjustment-'.length) as AdjustmentKind;
    if (isAdjustmentKind(kind)) {
      return controller.addAdjustmentLayer({
        kind,
        useSelection: true,
        ...(init as object),
      });
    }
  }

  throw new Error(`Unknown layer kind "${id}"`);
}

export interface LayerPanelDescriptor {
  id: string;
  title: string;
}

export interface LayerPanelsOptions {
  /**
   * The editor has an effects provider (`controller.effectsProvider`): adds the `provider-effects`
   * panel ("Effects") for layers that can take provider effects. It holds an effect layer's own
   * effect (change it, its frame or animation, its controls) and the provider filters applied to
   * the layer (smart filters). New effect layers are added from the layers panel
   * (`newLayerOptions`).
   */
  effects?: boolean;
}

/**
 * Returns contextual panels that apply to the currently active layer (or layer-independent panels if null).
 *
 * `properties` ("Layer Properties") is first for every layer and includes the layer's Layer Style
 * (drop shadow, stroke, glow…: `layerEffectsPanel`) for layers that can take one, with or without a
 * provider. There is no separate `effects` (Layer Effects) or `smart-filters` panel. `mask`
 * ("Mask & Edges": a vector mask's per-segment edges and the layer's edge colour) shows for a layer
 * with a painted or vector mask. The document's panels end the list for every layer, and with no
 * active layer follow `canvas-size`: `selection` (the selection tools and Refine Edge), `channels`
 * and `paths`. A host that lays out its own sidebar from these gets every panel the editor's own
 * `ImageEditor` shows.
 */
export function layerPanels(layer: ImageLayer | null, options: LayerPanelsOptions = {}): LayerPanelDescriptor[] {
  const documentPanels: LayerPanelDescriptor[] = [
    { id: 'selection', title: 'Selection' },
    { id: 'channels', title: 'Channels' },
    { id: 'paths', title: 'Paths' },
  ];
  if (!layer) return [{ id: 'canvas-size', title: 'Composition Size' }, ...documentPanels];

  const panels: LayerPanelDescriptor[] = [{ id: 'properties', title: 'Layer Properties' }];
  const effects = () => {
    if (options.effects) panels.push({ id: 'provider-effects', title: 'Effects' });
  };

  if (layer.type === 'pixel') {
    effects();
    panels.push({ id: 'color', title: 'Color Adjustments' });
    panels.push({ id: 'paint', title: 'Brush Options' });
  } else if (layer.type === 'adjustment') {
    panels.push({ id: 'adjustment', title: adjustmentKindLabel(layer.kind) });
  } else if (layer.type === 'type') {
    panels.push({ id: 'type', title: 'Typography' });
    effects();
  } else if (layer.type === 'shape') {
    panels.push({ id: 'shape', title: 'Shape Options' });
    effects();
  } else if (layer.type === 'smart') {
    effects();
    panels.push({ id: 'color', title: 'Color Adjustments' });
  } else if (layer.type === 'group') {
    effects();
  }

  if (layer.mask || layer.vectorMask) {
    panels.push({ id: 'mask', title: 'Mask & Edges' });
  }

  // The selection, channels and paths belong to the document, not the layer: they stay available
  // with a layer active (Layer via Copy, masks and painting all work through them).
  panels.push(...documentPanels);

  return panels;
}
