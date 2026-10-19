import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController } from './controller';
import { bytesToBase64 } from '../raster/png';
import { INTERPOLATIONS, type Interpolation } from '../raster/transform';
import { WARP_STYLES, type AffineMatrix, type Quad, type WarpMesh, type WarpStyle } from './transform';
import { BLEND_MODES } from './blend';
import { findLayer } from './layers/model';
import { LayerOperationError, requireLayer } from './layers/ops';
import { requireSmartObject } from './layers/smart';
import { describeLayer, maskSummary } from './layer-tools';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;
const roundPoint = (p: { x: number; y: number }) => ({ x: round(p.x), y: round(p.y) });

const LAYER_ID = { type: 'string', description: 'Smart object layer id from list_layers (type smart).' } as const;
const FILTER_ID = { type: 'string', description: 'Smart filter id from get_smart_object or add_smart_filter.' } as const;
const POINT = {
  type: 'object',
  properties: { x: { type: 'number', description: 'Document pixels from the left.' }, y: { type: 'number', description: 'Document pixels from the top.' } },
  required: ['x', 'y'],
  additionalProperties: false,
} as const;
const FILTER_BLENDS = BLEND_MODES.map((m) => m.id).filter((m) => m !== 'pigment');

const FILTER_SETTINGS = {
  enabled: { type: 'boolean', description: 'false keeps the filter but skips it (the eye in the Layers panel; default true).' },
  blend: { type: 'string', enum: FILTER_BLENDS, description: 'How the filter’s result blends with the result below it (Blending Options; default normal).' },
  opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Strength of the filter’s result over the result below it, 0..1 (default 1).' },
  radius: { type: 'number', minimum: 0, maximum: 50, description: 'blur: box radius in px (default 2).' },
  brightness: { type: 'number', minimum: -100, maximum: 100, description: 'develop: -100..100 (default 0).' },
  contrast: { type: 'number', minimum: -100, maximum: 100, description: 'develop: -100..100 (default 0).' },
  saturation: { type: 'number', minimum: -100, maximum: 100, description: 'develop: -100..100 (default 0).' },
  exposure: { type: 'number', minimum: -100, maximum: 100, description: 'develop: -100..100 (default 0).' },
  temperature: { type: 'number', minimum: -100, maximum: 100, description: 'develop: -100..100 blue to yellow (default 0).' },
  tint: { type: 'number', minimum: -100, maximum: 100, description: 'develop: -100..100 green to magenta (default 0).' },
} as const;

function settingsFrom(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(FILTER_SETTINGS)) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

/** A PNG (data URL or base64) as a data URL. */
function imageArg(image: unknown): string {
  if (typeof image !== 'string' || !image.trim()) throw new LayerOperationError('image is required: a PNG as a data URL or base64 (other formats need a browser).');
  return image.trim();
}

/**
 * Agent tools for smart objects in the image editor: `get_smart_object`, `convert_to_smart_object`,
 * `rasterize_smart_object`, `set_smart_object_transform`, `replace_smart_object_contents`,
 * `export_smart_object_contents`, `copy_smart_object`, `edit_smart_object_contents`,
 * `close_smart_object_contents`, and the smart filter stack: `add_smart_filter`,
 * `update_smart_filter`, `remove_smart_filter`, `move_smart_filter`, `set_smart_filters_enabled`,
 * `set_smart_filter_mask`. Every write is one undo step, validates first and returns what changed.
 */
export function createImageSmartObjectTools(controller: ImageEditorController): AgentTool[] {
  const smartId = (id: unknown) => {
    if (typeof id !== 'string' || !id) throw new LayerOperationError('layerId is required (a smart object id from list_layers).');
    requireSmartObject(controller.getLayers(), id);
    return id;
  };
  const info = (id: string) => {
    const i = controller.getSmartObject(id);
    return {
      ...i,
      placement: { ...i.placement, corners: i.placement.corners.map(roundPoint), center: roundPoint(i.placement.center), scaleX: round(i.placement.scaleX), scaleY: round(i.placement.scaleY), rotate: round(i.placement.rotate), skewX: round(i.placement.skewX) },
    };
  };
  const layerSummary = (id: string) => {
    const s = controller.getState();
    const loc = findLayer(s.layers, id);
    return loc ? { ...describeLayer(loc.layer, s.activeLayerId, (x) => controller.getLayerBounds(x.id)), parentId: loc.parent?.id ?? null, index: loc.index } : null;
  };

  const getSmart: AgentTool = {
    name: 'get_smart_object',
    title: 'Read a smart object',
    description:
      'Returns a smart object’s contents (id shared by linked instances, name, kind raster or document, pixel size, the file type it came from, the instances placed from it), its placement (corners in document pixels, warp mesh in contents pixels, interpolation, and scale / rotate / skew in percent and degrees of the contents’ own size when affine), its smart filters bottom to top (ids, kind, settings, enabled, blend, opacity; kind psd marks a Photoshop filter kept but not drawn) with the filter mask, and the rendered bounds. Changes nothing.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Read a smart object', ...READ },
    handler: ({ layerId }) => info(smartId(layerId)),
  };

  const convert: AgentTool = {
    name: 'convert_to_smart_object',
    title: 'Convert to Smart Object',
    description:
      'Layer › Smart Objects › Convert to Smart Object: sibling layers become one smart object at the topmost one’s position, so later transforms and filters are non-destructive. One pixel layer keeps its id, name, opacity, blend, fill, mask and effects, and its filters become smart filters (it looks exactly the same); several layers, a group or an adjustment become a nested layer document (edit it with edit_smart_object_contents). One undo step. Returns the new layer and its contents.',
    inputSchema: {
      type: 'object',
      properties: {
        layerIds: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Sibling layer ids from list_layers (default the active layer).' },
        name: { type: 'string', description: 'Name of the smart object (default the top layer’s name).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Convert to Smart Object', ...WRITE },
    handler: ({ layerIds, name }) => {
      for (const id of (layerIds as string[] | undefined) ?? []) requireLayer(controller.getLayers(), id);
      const id = controller.convertToSmartObject(layerIds as string[] | undefined, { name: name as string | undefined });
      return { layer: layerSummary(id), smartObject: info(id) };
    },
  };

  const rasterize: AgentTool = {
    name: 'rasterize_smart_object',
    title: 'Rasterize a smart object',
    description:
      'Layer › Smart Objects › Rasterize: the smart object becomes a pixel layer holding what it shows now (smart filters baked; same id, mask, effects, opacity, blend and fill). The contents, placement and filters are gone, so later transforms resample the pixels. One undo step. Returns the layer.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Rasterize a smart object', ...DESTRUCTIVE },
    handler: ({ layerId }) => ({ layer: layerSummary(controller.rasterizeSmartObject(smartId(layerId))) }),
  };

  const setTransform: AgentTool = {
    name: 'set_smart_object_transform',
    title: 'Set a smart object’s transform',
    description:
      'Sets where a smart object’s contents land, absolutely (not relative to the current transform), and renders it again from the contents, so nothing degrades however often it is transformed. Give at most one of: corners (Distort / Perspective), matrix (contents pixels → document), or the numbers scaleX / scaleY (percent of the contents’ own size), rotate, skewX, skewY and x, y (where the contents’ centre goes; unset numbers keep their current values). warp sets a preset or a mesh in contents pixels (null removes it); with nothing else given the corners stay. A linked mask follows a warp-free change. For a relative nudge use transform_layer. One undo step. Returns the placement and bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER_ID,
        corners: { type: 'array', items: POINT, minItems: 4, maxItems: 4, description: 'Where the contents’ corners land: [top-left, top-right, bottom-right, bottom-left] in document pixels. The quad must stay convex.' },
        matrix: { type: 'array', items: { type: 'number' }, minItems: 6, maxItems: 6, description: "Affine map from contents pixels to document pixels [a, b, c, d, e, f] (x' = a·x + c·y + e, y' = b·x + d·y + f)." },
        scaleX: { type: 'number', description: 'Width in percent of the contents’ own width (negative flips).' },
        scaleY: { type: 'number', description: 'Height in percent of the contents’ own height (negative flips).' },
        rotate: { type: 'number', description: 'Rotation in degrees, clockwise.' },
        skewX: { type: 'number', minimum: -89, maximum: 89, description: 'Horizontal skew in degrees.' },
        skewY: { type: 'number', minimum: -89, maximum: 89, description: 'Vertical skew in degrees.' },
        x: { type: 'number', description: 'Document x of the contents’ centre (default where it is now).' },
        y: { type: 'number', description: 'Document y of the contents’ centre (default where it is now).' },
        warp: {
          description: 'A warp over the contents: a preset {style, bend, horizontal, vertical, orientation}, a mesh {columns, rows, points} in contents pixels, or null to remove the warp. Omit to keep the current warp.',
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              properties: {
                style: { type: 'string', enum: WARP_STYLES, description: 'Preset (Photoshop’s menu).' },
                bend: { type: 'number', minimum: -100, maximum: 100, description: 'Bend in percent (default 50).' },
                horizontal: { type: 'number', minimum: -100, maximum: 100, description: 'Horizontal distortion in percent (default 0).' },
                vertical: { type: 'number', minimum: -100, maximum: 100, description: 'Vertical distortion in percent (default 0).' },
                orientation: { type: 'string', enum: ['horizontal', 'vertical'], description: 'Bend axis (default horizontal).' },
              },
              required: ['style'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                columns: { type: 'integer', minimum: 1, maximum: 16, description: 'Patch columns.' },
                rows: { type: 'integer', minimum: 1, maximum: 16, description: 'Patch rows.' },
                points: { type: 'array', items: POINT, minItems: 16, description: 'The (3·columns + 1) × (3·rows + 1) control points row by row, in contents pixels (0..width × 0..height is no warp).' },
              },
              required: ['columns', 'rows', 'points'],
              additionalProperties: false,
            },
          ],
        },
        interpolation: { type: 'string', enum: INTERPOLATIONS, description: 'Resampling: nearest, bilinear or bicubic (default: as before, bicubic for new smart objects).' },
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Set a smart object’s transform', ...WRITE_IDEMPOTENT },
    handler: (args) => {
      const id = smartId(args.layerId);
      let warp: WarpMesh | { style: WarpStyle; bend: number; horizontal?: number; vertical?: number; orientation?: 'horizontal' | 'vertical' } | null | undefined;
      const w = args.warp as Record<string, unknown> | null | undefined;
      if (w === null) warp = null;
      else if (w && 'style' in w) warp = { style: w.style as WarpStyle, bend: (w.bend as number | undefined) ?? 50, horizontal: w.horizontal as number | undefined, vertical: w.vertical as number | undefined, orientation: w.orientation as 'horizontal' | 'vertical' | undefined };
      else if (w) {
        const m = w as { columns: number; rows: number; points: { x: number; y: number }[] };
        const want = (3 * m.columns + 1) * (3 * m.rows + 1);
        if (m.points.length !== want) throw new LayerOperationError(`A ${m.columns} × ${m.rows} mesh needs (3·${m.columns} + 1) × (3·${m.rows} + 1) = ${want} points, got ${m.points.length}.`);
        const knots = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);
        warp = { us: knots(m.columns), vs: knots(m.rows), points: m.points.map((p) => ({ x: p.x, y: p.y })) };
      }
      const keys = ['corners', 'matrix', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY', 'x', 'y', 'warp', 'interpolation'];
      if (!keys.some((k) => args[k] !== undefined)) throw new LayerOperationError(`Give something to set: ${keys.join(', ')}.`);
      const res = controller.setSmartObjectTransform(id, {
        corners: args.corners as Quad | undefined,
        matrix: args.matrix as AffineMatrix | undefined,
        scaleX: args.scaleX as number | undefined,
        scaleY: args.scaleY as number | undefined,
        rotate: args.rotate as number | undefined,
        skewX: args.skewX as number | undefined,
        skewY: args.skewY as number | undefined,
        x: args.x as number | undefined,
        y: args.y as number | undefined,
        warp,
        interpolation: args.interpolation as Interpolation | undefined,
      });
      return { layerId: id, placement: info(id).placement, masksMoved: res.masksMoved, bounds: controller.getLayerBounds(id) };
    },
  };

  const replace: AgentTool = {
    name: 'replace_smart_object_contents',
    title: 'Replace a smart object’s contents',
    description:
      'Layer › Smart Objects › Replace Contents: new raster contents from an image for the smart object and every linked instance (same contents id). Each instance keeps its scale and rotation about the contents’ centre and its smart filters, and renders again. One undo step. Returns the contents id, the new size and the layers that changed.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER_ID,
        image: { type: 'string', description: 'The new contents: a PNG as a data URL or base64 (other formats and URLs need a browser).' },
        name: { type: 'string', description: 'File name of the contents (default the old name with .png).' },
      },
      required: ['layerId', 'image'],
      additionalProperties: false,
    },
    annotations: { title: 'Replace a smart object’s contents', ...DESTRUCTIVE },
    handler: async ({ layerId, image, name }) => controller.replaceSmartObjectContentsFromImage(smartId(layerId), imageArg(image), name as string | undefined),
  };

  const exportContents: AgentTool = {
    name: 'export_smart_object_contents',
    title: 'Export a smart object’s contents',
    description:
      'Layer › Smart Objects › Export Contents: the contents as a file, base64: the file they came from while unedited (a PSB, PNG, JPEG…), else a PNG for raster contents or a PSD / PSB of a nested document. Returns name, mimeType, byteLength and base64. Changes nothing.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Export a smart object’s contents', ...READ },
    handler: ({ layerId }) => {
      const f = controller.exportSmartObjectContents(smartId(layerId));
      return { name: f.name, mimeType: f.mimeType, byteLength: f.bytes.length, base64: bytesToBase64(f.bytes) };
    },
  };

  const copy: AgentTool = {
    name: 'copy_smart_object',
    title: 'Copy a smart object',
    description:
      'Duplicates a smart object directly above it. linked true (Duplicate Layer) shares the contents, so editing or replacing them changes both; linked false (Layer › Smart Objects › New Smart Object via Copy) gives the copy its own contents. Placement, filters, mask and effects are copied either way. One undo step. Returns the copy.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER_ID,
        linked: { type: 'boolean', description: 'true shares the contents with the original; false (default) makes independent contents.' },
        name: { type: 'string', description: 'Name of the copy (default "<name> copy").' },
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Copy a smart object', ...WRITE },
    handler: ({ layerId, linked, name }) => {
      const id = controller.copySmartObject(smartId(layerId), linked === true, name as string | undefined);
      return { layer: layerSummary(id), contentsId: controller.getSmartObject(id).contents.id };
    },
  };

  const editContents: AgentTool = {
    name: 'edit_smart_object_contents',
    title: 'Edit a smart object’s contents',
    description:
      'Layer › Smart Objects › Edit Contents: opens the contents as a document of their own (a layer document, or raster contents as one pixel layer "Layer 0") with their own undo history. Every other tool (list_layers, paint, adjustments…) then works inside the contents until close_smart_object_contents saves them back. Contents can nest. Returns the contents’ size and layers.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Edit a smart object’s contents', ...WRITE },
    handler: ({ layerId }) => {
      const res = controller.editSmartObjectContents(smartId(layerId));
      const s = controller.getState();
      return { ...res, editing: controller.getEditingContents(), layers: s.layers.map((l) => describeLayer(l, s.activeLayerId, (x) => controller.getLayerBounds(x.id))) };
    },
  };

  const closeContents: AgentTool = {
    name: 'close_smart_object_contents',
    title: 'Close a smart object’s contents',
    description:
      'Closes the contents opened with edit_smart_object_contents. save true (default) writes the edits back: the smart object and every linked instance render again, as one undo step in the document; save false drops them. Returns the smart object, whether it changed, the layers that changed and what is still open.',
    inputSchema: {
      type: 'object',
      properties: { save: { type: 'boolean', description: 'true (default) saves the edits into the smart object; false discards them.' } },
      additionalProperties: false,
    },
    annotations: { title: 'Close a smart object’s contents', ...WRITE },
    handler: ({ save }) => ({ ...controller.closeSmartObjectContents(save !== false), editing: controller.getEditingContents() }),
  };

  const addFilter: AgentTool = {
    name: 'add_smart_filter',
    title: 'Add a smart filter',
    description:
      'Adds a smart filter to a smart object: develop (brightness, contrast, saturation, exposure, temperature, tint) or blur (radius px), with its own blend mode and opacity over the result below it. Filters run bottom to top on the placed contents, then the filter mask mixes in the unfiltered contents. Unlike layer filters, a kind can repeat. One undo step. Returns the filter (with its id) and the stack.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER_ID,
        kind: { type: 'string', enum: ['develop', 'blur'], description: 'Filter kind.' },
        index: { type: 'integer', minimum: 0, description: 'Position in the stack, 0 = bottom, applied first (default the top).' },
        ...FILTER_SETTINGS,
      },
      required: ['layerId', 'kind'],
      additionalProperties: false,
    },
    annotations: { title: 'Add a smart filter', ...WRITE },
    handler: (args) => {
      const id = smartId(args.layerId);
      const filter = controller.addSmartFilter(id, { kind: args.kind as string, ...settingsFrom(args) }, args.index as number | undefined);
      return { layerId: id, filter, smartFilters: info(id).smartFilters };
    },
  };

  const updateFilter: AgentTool = {
    name: 'update_smart_filter',
    title: 'Change a smart filter',
    description:
      'Changes one smart filter: its settings, enabled, blend or opacity (only the given values; the kind cannot change). A Photoshop filter kept from a PSD (kind psd) only takes enabled, blend and opacity. One undo step. Returns the filter and the stack.',
    inputSchema: {
      type: 'object',
      properties: { layerId: LAYER_ID, filterId: FILTER_ID, ...FILTER_SETTINGS },
      required: ['layerId', 'filterId'],
      additionalProperties: false,
    },
    annotations: { title: 'Change a smart filter', ...WRITE_IDEMPOTENT },
    handler: (args) => {
      const id = smartId(args.layerId);
      const changes = settingsFrom(args);
      if (!Object.keys(changes).length) throw new LayerOperationError('Give at least one value to change.');
      const filter = controller.updateSmartFilter(id, args.filterId as string, changes);
      return { layerId: id, filter, smartFilters: info(id).smartFilters };
    },
  };

  const removeFilter: AgentTool = {
    name: 'remove_smart_filter',
    title: 'Remove a smart filter',
    description: 'Removes one smart filter (the filter mask goes with the last one). One undo step. Returns the remaining stack.',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID, filterId: FILTER_ID }, required: ['layerId', 'filterId'], additionalProperties: false },
    annotations: { title: 'Remove a smart filter', ...DESTRUCTIVE },
    handler: ({ layerId, filterId }) => {
      const id = smartId(layerId);
      controller.removeSmartFilter(id, filterId as string);
      return { layerId: id, smartFilters: info(id).smartFilters };
    },
  };

  const moveFilter: AgentTool = {
    name: 'move_smart_filter',
    title: 'Reorder a smart filter',
    description: 'Moves one smart filter to a position in the stack (0 = bottom, applied first), as dragging it in the Layers panel. One undo step. Returns the stack in its new order.',
    inputSchema: {
      type: 'object',
      properties: { layerId: LAYER_ID, filterId: FILTER_ID, index: { type: 'integer', minimum: 0, description: 'New position, 0 = bottom (applied first).' } },
      required: ['layerId', 'filterId', 'index'],
      additionalProperties: false,
    },
    annotations: { title: 'Reorder a smart filter', ...WRITE_IDEMPOTENT },
    handler: ({ layerId, filterId, index }) => {
      const id = smartId(layerId);
      controller.moveSmartFilter(id, filterId as string, index as number);
      return { layerId: id, smartFilters: info(id).smartFilters };
    },
  };

  const setEnabled: AgentTool = {
    name: 'set_smart_filters_enabled',
    title: 'Turn smart filters on or off',
    description: 'Layer › Smart Filter › Disable / Enable Smart Filters: switches the whole stack; each filter keeps its own enabled flag. One undo step. Returns the stack.',
    inputSchema: {
      type: 'object',
      properties: { layerId: LAYER_ID, enabled: { type: 'boolean', description: 'false hides every smart filter; true shows them again.' } },
      required: ['layerId', 'enabled'],
      additionalProperties: false,
    },
    annotations: { title: 'Turn smart filters on or off', ...WRITE_IDEMPOTENT },
    handler: ({ layerId, enabled }) => {
      const id = smartId(layerId);
      controller.setSmartFiltersEnabled(id, enabled === true);
      return { layerId: id, smartFilters: info(id).smartFilters };
    },
  };

  const setMask: AgentTool = {
    name: 'set_smart_filter_mask',
    title: 'Set the smart filter mask',
    description:
      'Sets the one filter mask of a smart object’s smart filters, which says where the filtered result shows over the unfiltered contents: from reveal-all (white), hide-all (black), selection (the selection’s coverage) or none (remove it); keep changes only its properties. Paint it with paint_stroke channel filter-mask. One undo step. Returns the mask summary.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER_ID,
        from: { type: 'string', enum: ['reveal-all', 'hide-all', 'selection', 'none', 'keep'], description: 'What the mask starts from; none removes it; keep only changes the properties below.' },
        density: { type: 'number', minimum: 0, maximum: 1, description: 'How much hidden areas hide, 0..1 (default 1).' },
        feather: { type: 'number', minimum: 0, maximum: 1000, description: 'Gaussian softening in px (default 0).' },
        enabled: { type: 'boolean', description: 'false keeps the mask but ignores it.' },
        linked: { type: 'boolean', description: 'false keeps the mask in place when the smart object is transformed or moved (default linked).' },
      },
      required: ['layerId', 'from'],
      additionalProperties: false,
    },
    annotations: { title: 'Set the smart filter mask', ...WRITE },
    handler: (args) => {
      const id = smartId(args.layerId);
      const props: Record<string, unknown> = {};
      for (const k of ['density', 'feather', 'enabled', 'linked']) if (args[k] !== undefined) props[k] = args[k];
      const mask = controller.setSmartFilterMask(id, args.from as 'reveal-all' | 'hide-all' | 'selection' | 'none' | 'keep', props);
      return { layerId: id, filterMask: maskSummary(mask ?? undefined) };
    },
  };

  return [getSmart, convert, rasterize, setTransform, replace, exportContents, copy, editContents, closeContents, addFilter, updateFilter, removeFilter, moveFilter, setEnabled, setMask];
}
