import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController } from './controller';
import { contentBounds } from './layers/surface';
import { findLayer, type ImageLayer, type LayerFilter, type RasterMask } from './layers/model';
import { LayerOperationError, requireLayer, type LayerPlacement } from './layers/ops';
import { adjustmentKindLabel } from './adjustment-layers';
import { BLEND_MODES } from './blend';
import type { BlendMode } from './blend';
import type { CropBox } from './types';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;

/** A short description of a mask for agents (no pixels). */
export function maskSummary(mask: RasterMask | undefined): Record<string, unknown> | null {
  if (!mask) return null;
  const out: Record<string, unknown> = {
    kind: mask.source ? 'depth' : 'raster',
    enabled: mask.enabled !== false,
    density: mask.density ?? 1,
    feather: mask.feather ?? 0,
  };
  if (!mask.source) {
    out.defaultValue = mask.defaultValue;
    out.paintedBounds = contentBounds(mask.surface);
  }
  return out;
}

/**
 * A plain description of a layer (and its children) for agents: ids, types, names, document
 * bounds, visibility, opacity, fill, blend, clipping, locks, mask summary and whether it is
 * active. `boundsOf` gives a pixel layer's document bounds.
 */
export function describeLayer(
  layer: ImageLayer,
  activeId: string | null,
  boundsOf: (layer: ImageLayer) => CropBox | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: layer.id,
    type: layer.type,
    name: layer.name || (layer.type === 'adjustment' ? adjustmentKindLabel(layer.kind) : ''),
    visible: layer.visible,
    opacity: round(layer.opacity),
    blend: layer.blend,
    clipped: Boolean(layer.clipped),
    locks: layer.locks ? { ...layer.locks } : {},
    mask: maskSummary(layer.mask),
    active: layer.id === activeId,
  };
  switch (layer.type) {
    case 'pixel':
      out.bounds = boundsOf(layer);
      out.offset = { ...layer.offset };
      out.fillOpacity = round(layer.fillOpacity ?? 1);
      out.filters = (layer.filters ?? []).map((f) => ({ ...f }));
      if (layer.source === 'document') out.source = 'document';
      break;
    case 'adjustment':
      out.kind = layer.kind;
      out.params = JSON.parse(JSON.stringify(layer.params));
      break;
    case 'annotation':
      out.annotation = { id: layer.annotation.id, type: layer.annotation.type };
      break;
    case 'group':
      out.collapsed = Boolean(layer.collapsed);
      out.children = layer.children.map((c) => describeLayer(c, activeId, boundsOf));
      break;
  }
  return out;
}

const LAYER_ID = { type: 'string', description: 'Layer id from list_layers.' } as const;
const PLACEMENT = {
  aboveId: { type: 'string', description: 'Put the layer directly above this layer (same group).' },
  belowId: { type: 'string', description: 'Put the layer directly below this layer (same group).' },
  parentId: { type: 'string', description: 'Put the layer inside this group (at index, default its top).' },
  index: { type: 'integer', minimum: 0, description: 'Position among the siblings, 0 = bottom (with parentId, or at the top level).' },
} as const;
const BLEND = { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'Blend mode (default normal).' } as const;

function placementFrom(args: Record<string, unknown>): LayerPlacement {
  const p: LayerPlacement = {};
  if (typeof args.aboveId === 'string') p.aboveId = args.aboveId;
  if (typeof args.belowId === 'string') p.belowId = args.belowId;
  if (typeof args.parentId === 'string') p.parentId = args.parentId;
  if (typeof args.index === 'number') p.index = args.index;
  return p;
}

/**
 * Agent tools for the image editor's layer stack: `list_layers`, `set_active_layer`,
 * `add_pixel_layer`, `duplicate_layer`, `remove_layer`, `move_layer`, `set_layer_properties`,
 * `group_layers`, `ungroup_layer`, `merge_down`, `merge_visible`, `flatten_image`, `offset_layer`,
 * `add_layer_mask`, `apply_layer_mask`, `remove_layer_mask`, `set_layer_mask_properties`,
 * `layer_via_copy`, `add_layer_filter`, `update_layer_filter` and `remove_layer_filter`. Each write
 * is one undo step, validates before changing anything and returns what it changed.
 */
export function createImageLayerTools(controller: ImageEditorController): AgentTool[] {
  const describe = (id: string) => {
    const s = controller.getState();
    const loc = findLayer(s.layers, id);
    if (!loc) return null;
    return {
      ...describeLayer(loc.layer, s.activeLayerId, (x) => controller.getLayerBounds(x.id)),
      parentId: loc.parent?.id ?? null,
      index: loc.index,
    };
  };
  const exists = (id: unknown, what = 'layerId') => {
    if (typeof id !== 'string' || !id) throw new LayerOperationError(`${what} is required (a layer id from list_layers).`);
    requireLayer(controller.getLayers(), id);
    return id;
  };

  const listLayers: AgentTool = {
    name: 'list_layers',
    title: 'List image layers',
    description:
      'Returns the layer stack bottom to top as a tree: id, type (pixel, adjustment, group, annotation), name, document bounds (pixel layers), visible, opacity, fillOpacity, blend, clipped, locks, a mask summary, filters (pixel layers), kind and params (adjustment layers), children (groups) and which layer is active. Also returns the active layer id and target (pixels or mask) and the canvas size.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List image layers', ...READ },
    handler: () => {
      const s = controller.getState();
      return {
        canvas: { ...s.imageDimensions },
        activeLayerId: s.activeLayerId,
        activeTarget: s.activeTarget,
        layers: s.layers.map((l) => describeLayer(l, s.activeLayerId, (x) => controller.getLayerBounds(x.id))),
      };
    },
  };

  const setActive: AgentTool = {
    name: 'set_active_layer',
    title: 'Set the active layer',
    description:
      'Makes a layer active (the base sliders of set_adjustments then edit its develop filter when it is a pixel layer) and chooses whether painting targets its pixels or its mask. View state, not an undo step. Returns the active layer.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { ...LAYER_ID, description: 'Layer to activate (from list_layers).' },
        target: { type: 'string', enum: ['pixels', 'mask'], description: 'Paint target (default pixels; mask needs a mask).' },
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Set the active layer', ...WRITE_IDEMPOTENT },
    handler: ({ layerId, target }) => {
      const id = exists(layerId);
      const layer = controller.getLayer(id)!;
      if (target === 'mask' && !layer.mask) throw new LayerOperationError(`Layer "${layer.name || id}" has no mask; add one with add_layer_mask.`);
      controller.setActiveLayer(id, (target as 'pixels' | 'mask' | undefined) ?? 'pixels');
      return { layer: describe(id), activeTarget: controller.getState().activeTarget };
    },
  };

  const addPixelLayer: AgentTool = {
    name: 'add_pixel_layer',
    title: 'Add a pixel layer',
    description:
      'Adds a pixel layer and makes it active: empty (default), filled with color over the canvas, or holding an image (PNG data URL or base64 PNG; other formats and URLs only in a browser) placed at x, y. Goes above the active layer unless aboveId / belowId / parentId / index is given. One undo step. Returns the new layer with its id, bounds and position.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Layer name (default "Layer N").' },
        color: { type: 'string', description: 'Fill colour #rrggbb or #rrggbbaa; omit for an empty layer.' },
        image: { type: 'string', description: 'Image to place: PNG data URL or base64 PNG (or any URL in a browser).' },
        x: { type: 'integer', description: 'Left of the image in document pixels (default 0).' },
        y: { type: 'integer', description: 'Top of the image in document pixels (default 0).' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Layer opacity 0..1 (default 1).' },
        blend: BLEND,
        ...PLACEMENT,
      },
      additionalProperties: false,
    },
    annotations: { title: 'Add a pixel layer', ...WRITE },
    handler: async (args) => {
      if (args.color !== undefined && args.image !== undefined) throw new LayerOperationError('Give color or image, not both.');
      for (const k of ['aboveId', 'belowId', 'parentId'] as const) if (args[k] !== undefined) exists(args[k], k);
      const init = {
        name: args.name as string | undefined,
        x: args.x as number | undefined,
        y: args.y as number | undefined,
        opacity: args.opacity as number | undefined,
        blend: args.blend as BlendMode | undefined,
        ...placementFrom(args),
      };
      const id =
        typeof args.image === 'string'
          ? await controller.addPixelLayerFromImage(args.image, init)
          : controller.addPixelLayer({ ...init, color: args.color as string | undefined });
      return { layer: describe(id) };
    },
  };

  const duplicate: AgentTool = {
    name: 'duplicate_layer',
    title: 'Duplicate a layer',
    description: 'Duplicates a layer (groups with their children) directly above it and makes the copy active. One undo step. Returns the copy with its new id.',
    inputSchema: {
      type: 'object',
      properties: { layerId: LAYER_ID, name: { type: 'string', description: 'Name of the copy (default "<name> copy").' } },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Duplicate a layer', ...WRITE },
    handler: ({ layerId, name }) => ({ layer: describe(controller.duplicateLayer(exists(layerId), name as string | undefined)) }),
  };

  const remove: AgentTool = {
    name: 'remove_layer',
    title: 'Delete a layer',
    description:
      'Deletes a layer (a group with its children). Refused for a layer locked with all. Prefer hiding it (set_layer_properties visible false) when it may be wanted back. One undo step. Returns the removed id and the remaining top-level ids.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Delete a layer', ...DESTRUCTIVE },
    handler: ({ layerId }) => {
      const id = exists(layerId);
      controller.removeLayer(id);
      return { removed: id, layers: controller.getLayers().map((l) => l.id) };
    },
  };

  const move: AgentTool = {
    name: 'move_layer',
    title: 'Move a layer in the stack',
    description:
      'Moves a layer above or below another layer (aboveId / belowId, in that layer\'s group), into a group (parentId, optional index), or to an index at the top level. Give exactly one of aboveId, belowId, parentId, or index alone. One undo step. Returns the new parentId and index.',
    inputSchema: {
      type: 'object',
      properties: { layerId: LAYER_ID, ...PLACEMENT },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Move a layer in the stack', ...WRITE },
    handler: (args) => {
      const id = exists(args.layerId);
      return { layerId: id, ...controller.moveLayer(id, placementFrom(args)) };
    },
  };

  const setProps: AgentTool = {
    name: 'set_layer_properties',
    title: 'Set layer properties',
    description:
      'Changes a layer\'s name, visible, opacity (0..1), fillOpacity (0..1, pixel layers: fades the pixels but not masks), blend (pass-through is for groups), clipped (clip to the layer below), locks ({pixels, transparency, position, all}) or collapsed (groups). Only the given fields change. Refused (except visible, locks and collapsed) on a layer locked with all. One undo step. Returns the layer after the change.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER_ID,
        name: { type: 'string', description: 'New name.' },
        visible: { type: 'boolean', description: 'Show (true) or hide (false).' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Layer opacity 0..1.' },
        fillOpacity: { type: 'number', minimum: 0, maximum: 1, description: 'Fill 0..1 (pixel layers).' },
        blend: { type: 'string', enum: [...BLEND_MODES.map((m) => m.id), 'pass-through'], description: 'Blend mode; pass-through for groups only.' },
        clipped: { type: 'boolean', description: 'Clip to the nearest unclipped layer below.' },
        locks: {
          type: 'object',
          description: 'Locks to set (missing keys are unlocked).',
          properties: {
            pixels: { type: 'boolean', description: 'Refuse painting and filling.' },
            transparency: { type: 'boolean', description: 'Painting keeps alpha.' },
            position: { type: 'boolean', description: 'Refuse moving.' },
            all: { type: 'boolean', description: 'Everything, including properties and deletion.' },
          },
          additionalProperties: false,
        },
        collapsed: { type: 'boolean', description: 'Collapse a group in the layers panel.' },
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Set layer properties', ...WRITE_IDEMPOTENT },
    handler: (args) => {
      const id = exists(args.layerId);
      const props: Record<string, unknown> = {};
      for (const k of ['name', 'visible', 'opacity', 'fillOpacity', 'blend', 'clipped', 'locks', 'collapsed']) if (args[k] !== undefined) props[k] = args[k];
      if (!Object.keys(props).length) throw new LayerOperationError('Give at least one property to change.');
      controller.setLayerProperties(id, props);
      return { layer: describe(id) };
    },
  };

  const group: AgentTool = {
    name: 'group_layers',
    title: 'Group layers',
    description:
      'Puts sibling layers (same group or top level) into a new pass-through group at the position of the topmost one, keeping their order. One undo step. Returns the group with its id and children.',
    inputSchema: {
      type: 'object',
      properties: {
        layerIds: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ids of the layers to group (from list_layers).' },
        name: { type: 'string', description: 'Group name (default "Group").' },
      },
      required: ['layerIds'],
      additionalProperties: false,
    },
    annotations: { title: 'Group layers', ...WRITE },
    handler: ({ layerIds, name }) => {
      const ids = (layerIds as string[]).map((id) => exists(id, 'layerIds[]'));
      return { group: describe(controller.groupLayers(ids, name as string | undefined)) };
    },
  };

  const addGroup: AgentTool = {
    name: 'add_group',
    title: 'Add an empty group',
    description:
      'Adds an empty group (pass-through unless blend is given) above the active layer, or at aboveId / belowId / parentId / index, and makes it active. Move layers into it with move_layer parentId, or use group_layers to group existing layers. One undo step. Returns the group.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name (default "Group").' },
        blend: { type: 'string', enum: [...BLEND_MODES.map((m) => m.id), 'pass-through'], description: 'Blend mode (default pass-through).' },
        ...PLACEMENT,
      },
      additionalProperties: false,
    },
    annotations: { title: 'Add an empty group', ...WRITE },
    handler: (args) => {
      for (const k of ['aboveId', 'belowId', 'parentId'] as const) if (args[k] !== undefined) exists(args[k], k);
      return { group: describe(controller.addGroup({ name: args.name as string | undefined, blend: args.blend as never, ...placementFrom(args) })) };
    },
  };

  const ungroup: AgentTool = {
    name: 'ungroup_layer',
    title: 'Ungroup a group',
    description: 'Replaces a group by its children at its position (the group\'s own opacity, blend and mask are dropped). One undo step. Returns the child ids bottom to top.',
    inputSchema: { type: 'object', properties: { layerId: { ...LAYER_ID, description: 'Group id.' } }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Ungroup a group', ...WRITE },
    handler: ({ layerId }) => ({ childIds: controller.ungroupLayer(exists(layerId)) }),
  };

  const mergeDown: AgentTool = {
    name: 'merge_down',
    title: 'Merge a layer down',
    description:
      'Composites a layer (pixel, adjustment, group or annotation) onto the pixel layer directly below it. The lower layer keeps its name, opacity and blend; masks, fill and filters are baked into its pixels. Refused when the layer below is not a pixel layer or is locked, or when the layer is hidden. One undo step. Returns the merged layer.',
    inputSchema: { type: 'object', properties: { layerId: { ...LAYER_ID, description: 'The upper layer to merge down.' } }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Merge a layer down', ...DESTRUCTIVE },
    handler: async ({ layerId }) => ({ layer: describe(await controller.mergeDown(exists(layerId))) }),
  };

  const mergeVisible: AgentTool = {
    name: 'merge_visible',
    title: 'Merge visible layers',
    description: 'Composites every visible top-level layer into one normal pixel layer at the position of the lowest of them; hidden layers stay. One undo step. Returns the merged layer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Merge visible layers', ...DESTRUCTIVE },
    handler: async () => ({ layer: describe(await controller.mergeVisible()) }),
  };

  const flatten: AgentTool = {
    name: 'flatten_image',
    title: 'Flatten the image',
    description: 'Composites every visible layer into one Background pixel layer and discards hidden layers. Crop, rotation and output opacity stay. One undo step. Returns the Background layer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Flatten the image', ...DESTRUCTIVE },
    handler: async () => ({ layer: describe(await controller.flattenImage()) }),
  };

  const offset: AgentTool = {
    name: 'offset_layer',
    title: 'Move a layer\'s pixels',
    description:
      'Moves a pixel layer (and its mask) to an absolute offset x, y or by dx, dy, in document pixels (integers). Refused when its position is locked. One undo step. Returns the new offset and document bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER_ID,
        x: { type: 'integer', description: 'New horizontal offset in document pixels.' },
        y: { type: 'integer', description: 'New vertical offset in document pixels.' },
        dx: { type: 'integer', description: 'Move right by this many pixels (negative: left).' },
        dy: { type: 'integer', description: 'Move down by this many pixels (negative: up).' },
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Move a layer\'s pixels', ...WRITE },
    handler: ({ layerId, x, y, dx, dy }) => {
      const id = exists(layerId);
      if ([x, y, dx, dy].every((v) => v === undefined)) throw new LayerOperationError('Give x and y, or dx and dy.');
      if ((x !== undefined || y !== undefined) && (dx !== undefined || dy !== undefined)) throw new LayerOperationError('Give x / y or dx / dy, not both.');
      return { layerId: id, ...controller.offsetLayer(id, { x: x as number | undefined, y: y as number | undefined, dx: dx as number | undefined, dy: dy as number | undefined }) };
    },
  };

  const addMask: AgentTool = {
    name: 'add_layer_mask',
    title: 'Add a layer mask',
    description:
      'Adds a mask to any layer, replacing an existing one: from reveal-all (white, paint black to hide), hide-all (black, paint white to reveal) or selection (the selection\'s coverage). density 0..1 and feather px soften it non-destructively. One undo step. Returns the mask summary.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER_ID,
        from: { type: 'string', enum: ['reveal-all', 'hide-all', 'selection'], description: 'What the mask starts as (default reveal-all).' },
        density: { type: 'number', minimum: 0, maximum: 1, description: 'Mask density 0..1 (default 1).' },
        feather: { type: 'number', minimum: 0, maximum: 1000, description: 'Feather σ in px (default 0).' },
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Add a layer mask', ...WRITE },
    handler: ({ layerId, from, density, feather }) => {
      const id = exists(layerId);
      const mask = controller.addLayerMask(id, (from as 'reveal-all' | 'hide-all' | 'selection' | undefined) ?? 'reveal-all', {
        density: density as number | undefined,
        feather: feather as number | undefined,
      });
      return { layerId: id, mask: maskSummary(mask) };
    },
  };

  const applyMask: AgentTool = {
    name: 'apply_layer_mask',
    title: 'Apply a layer mask',
    description: "Bakes a pixel layer's mask into its pixels (alpha × coverage, including density and feather) and removes the mask. Pixel layers only; refused when its pixels are locked. One undo step. Returns the layer.",
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Apply a layer mask', ...DESTRUCTIVE },
    handler: async ({ layerId }) => {
      const id = exists(layerId);
      await controller.applyLayerMask(id);
      return { layer: describe(id) };
    },
  };

  const removeMask: AgentTool = {
    name: 'remove_layer_mask',
    title: 'Delete a layer mask',
    description: "Deletes a layer's mask without applying it (the layer shows everywhere again). Disable it instead with set_layer_mask_properties enabled false to keep it. One undo step. Returns the layer.",
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Delete a layer mask', ...DESTRUCTIVE },
    handler: ({ layerId }) => {
      const id = exists(layerId);
      controller.removeLayerMask(id);
      return { layer: describe(id) };
    },
  };

  const maskProps: AgentTool = {
    name: 'set_layer_mask_properties',
    title: 'Set layer mask properties',
    description: "Changes a layer mask's density (0..1), feather (px) or enabled flag; its pixels are kept. One undo step. Returns the mask summary.",
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER_ID,
        density: { type: 'number', minimum: 0, maximum: 1, description: 'Density 0..1.' },
        feather: { type: 'number', minimum: 0, maximum: 1000, description: 'Feather σ in px.' },
        enabled: { type: 'boolean', description: 'false ignores the mask but keeps it.' },
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Set layer mask properties', ...WRITE_IDEMPOTENT },
    handler: ({ layerId, density, feather, enabled }) => {
      const id = exists(layerId);
      if ([density, feather, enabled].every((v) => v === undefined)) throw new LayerOperationError('Give density, feather or enabled.');
      const mask = controller.setLayerMaskProps(id, { density: density as number | undefined, feather: feather as number | undefined, enabled: enabled as boolean | undefined });
      return { layerId: id, mask: maskSummary(mask) };
    },
  };

  const viaCopy: AgentTool = {
    name: 'layer_via_copy',
    title: 'New layer from the selection',
    description:
      'Layer via Copy: copies the selected pixels of a pixel layer (layerId, default the active layer) to a new layer directly above it and makes it active. cut: true also removes them from the source (Layer via Cut). Needs a selection. One undo step. Returns the new layer.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { ...LAYER_ID, description: 'Pixel layer to copy from (default the active layer).' },
        cut: { type: 'boolean', description: 'Remove the pixels from the source too (default false).' },
        name: { type: 'string', description: 'Name of the new layer.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'New layer from the selection', ...WRITE },
    handler: ({ layerId, cut, name }) => {
      if (layerId !== undefined) exists(layerId);
      return { layer: describe(controller.layerViaCopy({ layerId: layerId as string | undefined, cut: cut === true, name: name as string | undefined })) };
    },
  };

  const rasterize: AgentTool = {
    name: 'rasterize_layer',
    title: 'Rasterize a layer',
    description:
      'Rasterize Layer: turns an annotation layer into a pixel layer (same id, name, opacity, blend and mask; needs a browser) or bakes a pixel layer\'s filters (develop, blur) into its pixels. One undo step. Returns the layer.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Rasterize a layer', ...DESTRUCTIVE },
    handler: async ({ layerId }) => ({ layer: describe(await controller.rasterizeLayer(exists(layerId))) }),
  };

  const filterArgs = {
    enabled: { type: 'boolean', description: 'false keeps the filter but skips it.' },
    radius: { type: 'number', minimum: 0, maximum: 50, description: 'blur: box radius in px (default 2).' },
    brightness: { type: 'number', minimum: -100, maximum: 100, description: 'develop: -100..100 (default 0).' },
    contrast: { type: 'number', minimum: -100, maximum: 100, description: 'develop: -100..100 (default 0).' },
    saturation: { type: 'number', minimum: -100, maximum: 100, description: 'develop: -100..100 (default 0).' },
    exposure: { type: 'number', minimum: -100, maximum: 100, description: 'develop: -100..100 (default 0).' },
    temperature: { type: 'number', minimum: -100, maximum: 100, description: 'develop: -100..100 (default 0).' },
    tint: { type: 'number', minimum: -100, maximum: 100, description: 'develop: -100..100 green to magenta (default 0).' },
  } as const;
  const filterValues = (args: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(filterArgs)) if (args[k] !== undefined) out[k] = args[k];
    return out;
  };

  const addFilter: AgentTool = {
    name: 'add_layer_filter',
    title: 'Add a layer filter',
    description:
      'Adds a live filter to a pixel layer: develop (the base sliders: brightness, contrast, saturation, exposure, temperature, tint) or blur (radius px). One of each kind per layer, applied bottom to top before the mask. One undo step. Returns the layer\'s filters with their ids.',
    inputSchema: {
      type: 'object',
      properties: { layerId: LAYER_ID, kind: { type: 'string', enum: ['develop', 'blur'], description: 'Filter kind.' }, ...filterArgs },
      required: ['layerId', 'kind'],
      additionalProperties: false,
    },
    annotations: { title: 'Add a layer filter', ...WRITE },
    handler: (args) => {
      const id = exists(args.layerId);
      const filters = controller.addLayerFilter(id, { kind: args.kind as LayerFilter['kind'], ...filterValues(args) } as never);
      return { layerId: id, filters };
    },
  };

  const updateFilter: AgentTool = {
    name: 'update_layer_filter',
    title: 'Change a layer filter',
    description: "Changes one filter of a pixel layer (only the given values; the kind cannot change). One undo step. Returns the layer's filters.",
    inputSchema: {
      type: 'object',
      properties: { layerId: LAYER_ID, filterId: { type: 'string', description: 'Filter id from list_layers or add_layer_filter.' }, ...filterArgs },
      required: ['layerId', 'filterId'],
      additionalProperties: false,
    },
    annotations: { title: 'Change a layer filter', ...WRITE_IDEMPOTENT },
    handler: (args) => {
      const id = exists(args.layerId);
      const changes = filterValues(args);
      if (!Object.keys(changes).length) throw new LayerOperationError('Give at least one value to change.');
      return { layerId: id, filters: controller.updateLayerFilter(id, args.filterId as string, changes) };
    },
  };

  const removeFilter: AgentTool = {
    name: 'remove_layer_filter',
    title: 'Remove a layer filter',
    description: "Removes one filter from a pixel layer. One undo step. Returns the layer's remaining filters.",
    inputSchema: {
      type: 'object',
      properties: { layerId: LAYER_ID, filterId: { type: 'string', description: 'Filter id from list_layers.' } },
      required: ['layerId', 'filterId'],
      additionalProperties: false,
    },
    annotations: { title: 'Remove a layer filter', ...DESTRUCTIVE },
    handler: ({ layerId, filterId }) => {
      const id = exists(layerId);
      return { layerId: id, filters: controller.removeLayerFilter(id, filterId as string) };
    },
  };

  return [
    listLayers,
    setActive,
    addPixelLayer,
    duplicate,
    remove,
    move,
    setProps,
    group,
    addGroup,
    ungroup,
    mergeDown,
    mergeVisible,
    flatten,
    offset,
    addMask,
    applyMask,
    removeMask,
    maskProps,
    viaCopy,
    rasterize,
    addFilter,
    updateFilter,
    removeFilter,
  ];
}
