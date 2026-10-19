/**
 * The layers panel's view model, shared by the React and Svelte panels: the rows to show (top of
 * the stack first, groups indented, collapsed groups hiding their children), where a drop lands,
 * and the menu of layer operations with whether each one applies to the active layer.
 */

import { adjustmentKindLabel } from '../adjustment-layers';
import type { ImageEditorController } from '../controller';
import { findLayer, type ImageLayer, type SmartFilter, type SmartObjectLayer } from './model';
import type { LayerPlacement } from './ops';

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
  }
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
  | 'add-mask-selection'
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
    { action: 'apply-mask', label: 'Apply Layer Mask', enabled: isPixel && Boolean(active?.mask) },
    { action: 'delete-mask', label: 'Delete Layer Mask', enabled: Boolean(active?.mask) },
    { action: 'toggle-mask', label: active?.mask?.enabled === false ? 'Enable Layer Mask' : 'Disable Layer Mask', enabled: Boolean(active?.mask) },
    { action: 'toggle-mask-link', label: active?.mask?.linked === false ? 'Link Layer Mask' : 'Unlink Layer Mask', enabled: Boolean(active?.mask && !active.mask.source) },
    { action: 'rasterize', label: 'Rasterize Layer', enabled: active?.type === 'annotation' || active?.type === 'smart' || (isPixel && Boolean(active?.type === 'pixel' && active.filters?.length)) },
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
    label: f.kind === 'psd' ? f.name.replace(/&/g, '').replace(/\.\.\.$/, '') : f.kind === 'blur' ? `Blur (${f.radius} px)` : 'Develop',
  }));
  return rows.reverse();
}
