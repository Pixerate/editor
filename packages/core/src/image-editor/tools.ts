import { withImagePlayback } from './playback';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { ImageEditorController } from './controller';
import type { AdjustmentKind, ImageAdjustments } from './types';
import { normalizeProcessVersion } from './color';
import {
  ADJUSTMENT_KINDS,
  isAdjustmentKind,
} from './adjustment-layers';
import { BLEND_MODES, isBlendMode } from './blend';
import {
  ADJUSTMENT_LAYER_CONTROLS,
  ADJUSTMENT_LAYER_OPACITY_CONTROL,
  IMAGE_ADJUSTMENT_CONTROLS,
  clampControlValue,
  findAdjustmentControl,
  findLayerControl,
  readAdjustmentControls,
  setControlPath,
} from './controls';
import { createImageSelectionTools } from './selection-tools';
import { createImageCaptureSurface } from './capture';
import { createCaptureTool } from '../tools/capture.js';
import { createImageEditTools } from './edit-tools';
import { createImageLayerTools } from './layer-tools';
import { createImageEffectTools } from './effect-tools';
import { createImagePaintTools } from './paint-tools';
import { createImageColorTools } from './color-tools';
import { createImageRetouchTools } from './retouch-tools';
import { createPigmentTools } from '../paint/pigment-tools';
import { createImagePsdTools } from './psd-tools';
import { createImageTransformTools } from './transform-tools';
import { createImageSmartObjectTools } from './smart-tools';
import { createImageShapeTools } from './shape-tools';
import { createImageTypeTools } from './type-tools';

export interface ImageEditorToolProviderOptions {
  /** Provider id (unique per registry). Default `image-editor`. */
  id?: string;
  /** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
  namespace?: string;
  /**
   * The agent playback surface its calls are acted out on (default `image`, where `ImageEditor` attaches).
   * Set it when one registry holds several editors of this kind, each attached under its own surface id.
   */
  playbackSurface?: string;
}

const LAYER_PATH = /^layers\.([^.]+)\.(.+)$/;

function adjustmentsSummary(adjustments: ImageAdjustments) {
  return {
    process: normalizeProcessVersion(adjustments.process),
    values: readAdjustmentControls(adjustments),
    layers: (adjustments.layers ?? []).map((l) => JSON.parse(JSON.stringify(l))),
  };
}

/**
 * Agent tools for an image editor, for a `ToolRegistry`:
 *
 * - `get_adjustments`: base slider values (by control id), process version and adjustment layers.
 * - `list_controls`: the control table (ids, ranges, defaults, steps), layer kinds and blend modes.
 * - `set_adjustments {values, label}`: sets base controls (`exposure`) and layer parameters
 *   (`layers.<id>.vibrance`, `layers.<id>.opacity`) in one undo step; values are clamped to the
 *   control ranges and the applied values are echoed.
 * - `add_adjustment_layer {kind, params?, opacity?, blend?, name?}`.
 * - `render_preview {maxSide}`: the rendered image as a PNG, longest side at most `maxSide`.
 * - `capture_view {region, rect?, ...}`: a screenshot of the whole image, the selection or a rect in
 *   natural pixels (up to 8× for close inspection), optionally with the selection shaded.
 * - Selections and masks: `get_selection`, `select_all`, `deselect`, `invert_selection`,
 *   `select_rect`, `select_ellipse`, `select_polygon`, `select_line`, `magic_wand`,
 *   `select_color_range`, `grow_selection`, `select_similar`, `reselect`,
 *   `select_layer_transparency`, `stroke_selection`, `crop_to_selection`, `content_aware_fill`,
 *   `copy_pixels`, `cut_pixels`, `paste_pixels`,
 *   `load_selection_from_image`, `load_selection_from_mask`, `set_selection_display`,
 *   `modify_selection`, `refine_selection`, `apply_selection_as_mask` and the deprecated
 *   `select_region` / `select_by_color` (see `createImageSelectionTools`).
 * - Layers, geometry and history: `get_image_info`, `get_histogram`, `update_adjustment_layer`,
 *   `remove_adjustment_layer`, `move_adjustment_layer`, `set_crop`, `reset_crop`, `set_rotation`,
 *   `flip_image`, `undo_image`, `redo_image` (see `createImageEditTools`).
 * - Free Transform: `get_transform_frame`, `transform_layer`, `warp_layer`, `transform_selection`,
 *   `flip_layer`, `rotate_layer_90` (see `createImageTransformTools`).
 * - Smart objects and smart filters: `get_smart_object`, `convert_to_smart_object`,
 *   `rasterize_smart_object`, `set_smart_object_transform`, `replace_smart_object_contents`,
 *   `export_smart_object_contents`, `copy_smart_object`, `edit_smart_object_contents`,
 *   `close_smart_object_contents`, `add_smart_filter`, `update_smart_filter`, `remove_smart_filter`,
 *   `move_smart_filter`, `set_smart_filters_enabled`, `set_smart_filter_mask` (see
 *   `createImageSmartObjectTools`).
 * - Shape layers: `get_shape_layer`, `add_shape_layer`, `update_shape`, `set_shape_component`,
 *   `add_shape_component`, `remove_shape_component`, `merge_shape_components` (see
 *   `createImageShapeTools`); `rasterize_layer` turns one into pixels.
 * - Type layers: `list_fonts`, `get_text_layer`, `add_text_layer`, `set_text`, `set_text_style`,
 *   `set_paragraph_style`, `set_text_frame`, `convert_text_to_shape` (see `createImageTypeTools`).
 * - Colour management: `get_color_profile`, `assign_profile`, `convert_to_profile`,
 *   `set_proof_setup`, `convert_colors` (see `createImageColorTools`).
 * - Retouching: `clone_stamp`, `heal_brush`, `spot_heal`, `smudge`, `dodge`, `burn`, `sponge`,
 *   `get_retouch_options`, `set_retouch_options`, `set_clone_source` (see `createImageRetouchTools`).
 */
export function createImageEditorToolProvider(
  controller: ImageEditorController,
  options: ImageEditorToolProviderOptions = {}
): AgentToolProvider {
  const getAdjustments: AgentTool = {
    name: 'get_adjustments',
    title: 'Read image adjustments',
    description:
      'Returns the image editor adjustment values by control id, the rendering process version and the adjustment layers (bottom to top).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: 'Read image adjustments',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: () => adjustmentsSummary(controller.getState().adjustments),
  };

  const listControls: AgentTool = {
    name: 'list_controls',
    title: 'List adjustment controls',
    description:
      'Lists every adjustment control (id, label, section, min, max, step, default), the parameters of each adjustment-layer kind, and the blend modes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: 'List adjustment controls',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: () => ({
      controls: IMAGE_ADJUSTMENT_CONTROLS.map(({ id, label, section, min, max, step, default: def, requiresProcess }) => ({
        id, label, section, min, max, step, default: def, ...(requiresProcess ? { requiresProcess } : {}),
      })),
      layerKinds: ADJUSTMENT_KINDS.map(({ kind, label }) => ({
        kind,
        label,
        controls: [...ADJUSTMENT_LAYER_CONTROLS[kind], ADJUSTMENT_LAYER_OPACITY_CONTROL].map(({ id, label: l, min, max, step, default: def }) => ({
          id, label: l, min, max, step, default: def,
        })),
      })),
      blendModes: BLEND_MODES.map((m) => m.id),
      layerPathFormat: 'layers.<layerId>.<controlId>',
    }),
  };

  const setAdjustments: AgentTool = {
    name: 'set_adjustments',
    title: 'Set image adjustments',
    description:
      'Sets adjustment values by control id in one undoable step. Base controls use their id (e.g. "exposure"); layer parameters use "layers.<layerId>.<controlId>" (e.g. "layers.adj_1.vibrance"). Values are clamped to each control range; the applied values are returned.',
    inputSchema: {
      type: 'object',
      properties: {
        values: {
          type: 'object',
          description: 'Map of control id to number. See list_controls for ids and ranges.',
          additionalProperties: { type: 'number' },
        },
        label: { type: 'string', description: 'Short description of the change (echoed back).' },
      },
      required: ['values'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Set image adjustments',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: ({ values, label }) => {
      const entries = Object.entries((values ?? {}) as Record<string, unknown>);
      if (!entries.length) throw new Error('No values given. Pass {"values": {"<control id>": number}}.');
      const state = controller.getState();
      const base: Partial<ImageAdjustments> = {};
      const layers = (state.adjustments.layers ?? []).map((l) => ({ ...l }));
      const applied: Record<string, number> = {};
      const clamped: string[] = [];
      const unknown: string[] = [];
      for (const [id, raw] of entries) {
        const m = LAYER_PATH.exec(id);
        if (m) {
          const layer = layers.find((l) => l.id === m[1]);
          const spec = layer ? findLayerControl(layer.kind, m[2]) : undefined;
          if (!layer || !spec) {
            unknown.push(id);
            continue;
          }
          const v = clampControlValue(spec, raw);
          if (v !== raw) clamped.push(id);
          if (spec.id === 'opacity') layer.opacity = v;
          else layer.params = setControlPath(layer.params, spec.id, v) as typeof layer.params;
          applied[id] = v;
          continue;
        }
        const spec = findAdjustmentControl(id);
        if (!spec) {
          unknown.push(id);
          continue;
        }
        const v = clampControlValue(spec, raw);
        if (v !== raw) clamped.push(id);
        (base as Record<string, number>)[id] = v;
        applied[id] = v;
      }
      if (unknown.length) {
        const accepted = IMAGE_ADJUSTMENT_CONTROLS.map((c) => c.id).join(', ');
        throw new Error(
          `Unknown control id(s): ${unknown.join(', ')}. Accepted: ${accepted}, or layers.<layerId>.<controlId> for an existing layer.`
        );
      }
      const changedLayers = Object.keys(applied).some((id) => id.startsWith('layers.'));
      controller.setAdjustments(changedLayers ? { ...base, layers } : base);
      const result: Record<string, unknown> = { applied, clamped };
      if (typeof label === 'string' && label) result.label = label;
      const notes: string[] = [];
      if ('tint' in applied && normalizeProcessVersion(controller.getState().adjustments.process) < 2) {
        notes.push('Tint has no effect on process 1 edits.');
      }
      if (notes.length) result.notes = notes;
      return result;
    },
  };

  const addLayer: AgentTool = {
    name: 'add_adjustment_layer',
    title: 'Add an adjustment layer',
    description:
      'Adds a non-destructive adjustment layer on top of the stack (one undoable step) and returns it; with a selection it is masked by it (useSelection, default true; masked in the result says so). Kinds: ' +
      ADJUSTMENT_KINDS.map((k) => k.kind).join(', ') +
      '. Omitted params are neutral.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ADJUSTMENT_KINDS.map((k) => k.kind), description: 'Adjustment kind.' },
        params: { type: 'object', description: 'Initial parameters (see list_controls); merged with neutral defaults.' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Layer opacity 0-1 (default 1).' },
        blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'Blend mode (default normal).' },
        name: { type: 'string', description: 'Layer name shown in the layers panel.' },
        aboveId: { type: 'string', description: 'Put the layer directly above this layer (from list_layers). Default: above the other adjustment layers, below annotations.' },
        parentId: { type: 'string', description: 'Put the layer at the top of this group (from list_layers).' },
        useSelection: { type: 'boolean', description: 'With a selection, mask the new layer with it so the adjustment only affects the selected area (default true; false for a global layer).' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Add an adjustment layer',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: ({ kind, params, opacity, blend, name, aboveId, parentId, useSelection }) => {
      if (!isAdjustmentKind(kind)) throw new Error(`Unknown adjustment kind "${kind}".`);
      if (blend !== undefined && !isBlendMode(blend)) throw new Error(`Unknown blend mode "${blend}".`);
      if (aboveId !== undefined && parentId !== undefined) throw new Error('Give aboveId or parentId, not both.');
      for (const ref of [aboveId, parentId]) {
        if (ref !== undefined && !controller.getLayer(ref as string)) throw new Error(`Unknown layer "${ref}". Call list_layers for ids.`);
      }
      if (parentId !== undefined && controller.getLayer(parentId as string)?.type !== 'group') throw new Error(`Layer "${parentId}" is not a group.`);
      const id = controller.addAdjustmentLayer({ kind: kind as AdjustmentKind, params, opacity, blend, name, aboveId, parentId, useSelection: useSelection !== false });
      const layer = controller.getAdjustmentLayer(id)!;
      return { layer: JSON.parse(JSON.stringify(layer)), index: controller.getAdjustmentLayers().findIndex((l) => l.id === id), masked: Boolean(layer.mask) };
    },
  };

  const renderPreview: AgentTool = {
    name: 'render_preview',
    title: 'Render a preview',
    description:
      'Renders the edited image (crop, adjustments, layers, annotations) as a PNG whose longest side is at most maxSide pixels. With layerId, renders only that layer (a group with its children) through the same crop and rotation.',
    inputSchema: {
      type: 'object',
      properties: {
        maxSide: { type: 'integer', minimum: 16, maximum: 2048, description: 'Longest side in pixels (default 512).' },
        layerId: { type: 'string', description: 'Render only this layer (from list_layers).' },
      },
      additionalProperties: false,
    },
    annotations: {
      title: 'Render a preview',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async ({ maxSide, layerId }) => {
      if (layerId !== undefined && !controller.getLayer(layerId as string)) throw new Error(`Unknown layer "${layerId}". Call list_layers for ids.`);
      const side = Math.max(16, Math.min(2048, Math.round(typeof maxSide === 'number' ? maxSide : 512)));
      const state = controller.getState();
      const crop = state.crop ?? { x: 0, y: 0, ...state.imageDimensions };
      const quarter = Math.abs(Math.round((state.transform.rotate % 180) / 90)) % 2 === 1;
      const w = quarter ? crop.height : crop.width;
      const h = quarter ? crop.width : crop.height;
      const k = Math.min(1, side / Math.max(w, h, 1));
      const dataUrl = await controller.toDataURL({
        format: 'image/png',
        width: Math.max(1, Math.round(w * k)),
        height: Math.max(1, Math.round(h * k)),
        ...(layerId !== undefined ? { layerIds: [layerId as string] } : {}),
      });
      const comma = dataUrl.indexOf(',');
      if (!dataUrl.startsWith('data:image/png') || comma < 0 || comma === dataUrl.length - 1) {
        throw new Error('Rendering is not available in this environment.');
      }
      return {
        content: [
          { type: 'image', data: dataUrl.slice(comma + 1), mimeType: 'image/png' },
          { type: 'text', text: `Preview ${Math.round(w * k)}×${Math.round(h * k)}` },
        ],
      };
    },
  };

  return withImagePlayback({
    id: options.id ?? 'image-editor',
    namespace: options.namespace,
    title: 'Image editor',
    description: 'Layered raster image editing: layers and groups, adjustments and adjustment layers, selections and masks, retouching, painting, shapes and type, transforms, colour management, PSD import and export.',
    skill: 'pixerate-image-editor',
    tools: [
      getAdjustments,
      listControls,
      setAdjustments,
      addLayer,
      renderPreview,
      createCaptureTool(createImageCaptureSurface(controller), { subject: 'the image (source orientation, before crop and rotation)', defaultPadding: 0 }),
      ...createImageSelectionTools(controller),
      ...createImageEditTools(controller),
      ...createImageLayerTools(controller),
      ...createImageTransformTools(controller),
      ...createImageSmartObjectTools(controller),
      ...createImageShapeTools(controller),
      ...createImageTypeTools(controller),
      ...createImageEffectTools(controller),
      ...createImagePaintTools(controller),
      ...createImageColorTools(controller),
      ...createImageRetouchTools(controller),
      ...createPigmentTools(),
      ...createImagePsdTools(controller),
    ],
  }, options.playbackSurface);
}

