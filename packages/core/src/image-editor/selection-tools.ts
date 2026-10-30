import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import type { ImageEditorController } from './controller';
import type { AdjustmentKind } from './types';
import { ADJUSTMENT_KINDS, isAdjustmentKind } from './adjustment-layers';
import { describeSelection } from './selection/tool-options';
import { SELECTION_MODES, parseSelectionMode, selectionArea, type SelectionChannel } from './selection/mask';
import { COLOR_RANGE_PRESETS, isColorRangePreset, type ColorRangeSample } from './selection/wand';
import { SELECTION_MODIFY_OPS, type SelectionModifyOp } from './selection/modify';
import { layerMaskFromSelection } from './selection/layer-mask';
import { planOutlineTrace, withImagePlayback } from './playback';

const modeSchema: JsonSchema = {
  type: 'string',
  enum: [...SELECTION_MODES],
  description: 'How the result combines with the current selection (default replace).',
};

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const featherSchema: JsonSchema = { type: 'number', minimum: 0, maximum: 1000, description: 'Feather the new shape by this many pixels before combining (default 0).' };
const antiAliasSchema: JsonSchema = { type: 'boolean', description: 'Soft one-pixel edge (default true).' };
const sampleMergedSchema: JsonSchema = { type: 'boolean', description: 'Sample the adjusted image (adjustment layers and filters applied) rather than the pixels as painted (default false).' };
const sampleSchema: JsonSchema = {
  type: 'string',
  enum: ['composite', 'active-layer'],
  description: 'composite (default): all layers; active-layer: only the active pixel layer (see set_active_layer).',
};
const pointSchema: JsonSchema = {
  type: 'object',
  properties: { x: { type: 'number', description: 'x in natural image pixels.' }, y: { type: 'number', description: 'y in natural image pixels.' } },
  required: ['x', 'y'],
  additionalProperties: false,
};
const rectProperties: Record<string, JsonSchema> = {
  x: { type: 'number', description: 'Left edge in natural image pixels.' },
  y: { type: 'number', description: 'Top edge in natural image pixels.' },
  width: { type: 'number', exclusiveMinimum: 0, description: 'Width in natural image pixels.' },
  height: { type: 'number', exclusiveMinimum: 0, description: 'Height in natural image pixels.' },
};

function shapeOptions(args: Record<string, unknown>) {
  return { mode: parseSelectionMode(args.mode), feather: num(args.feather, 0), antiAlias: args.antiAlias !== false };
}

function sampleOptions(args: Record<string, unknown>) {
  if (args.sample !== undefined && args.sample !== 'composite' && args.sample !== 'active-layer') {
    throw new Error(`Unknown sample "${String(args.sample)}". Use composite or active-layer.`);
  }
  return { sampleMerged: args.sampleMerged === true, sample: (args.sample as 'composite' | 'active-layer' | undefined) ?? 'composite' };
}

function rectOf(args: Record<string, unknown>) {
  const rect = { x: num(args.x, NaN), y: num(args.y, NaN), width: num(args.width, NaN), height: num(args.height, NaN) };
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new Error('Pass numeric x, y, width and height in natural image pixels.');
  if (rect.width <= 0 || rect.height <= 0) throw new Error('width and height must be greater than 0.');
  return rect;
}

function summary(controller: ImageEditorController) {
  const sel = controller.getSelection();
  const { width, height } = controller.getState().imageDimensions;
  const area = selectionArea(sel);
  return {
    empty: !sel,
    bounds: sel?.bounds ?? null,
    /** Σ coverage in pixels. */
    area: Math.round(area),
    percent: Math.round((area / Math.max(1, width * height)) * 10000) / 100,
    description: describeSelection(sel),
  };
}

const writeAnnotations = (title: string, idempotent = false) => ({
  title,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: idempotent,
  openWorldHint: false,
});

/**
 * Agent tools for selections and masks (part of `createImageEditorToolProvider`): reading
 * (`get_selection`), selecting (`select_all`, `deselect`, `invert_selection`, `select_rect`,
 * `select_ellipse`, `select_polygon`, `select_line`, `magic_wand`, `select_color_range`,
 * `grow_selection`, `select_similar`, `reselect`), loading (`load_selection_from_image`,
 * `load_selection_from_mask`, `select_layer_transparency`), the view
 * (`set_selection_display`), editing (`modify_selection`, `refine_selection`) and masking
 * (`apply_selection_as_mask`). `select_region` and `select_by_color` are deprecated aliases.
 * Coordinates are natural pixels of the source image.
 */
export function createImageSelectionTools(controller: ImageEditorController): AgentTool[] {
  const getSelection: AgentTool = {
    name: 'get_selection',
    title: 'Read the selection',
    description:
      'Returns the active selection: whether it is empty, its bounds (natural image pixels), its area in pixels and percent of the image.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Read the selection', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: () => summary(controller),
  };

  const selectRegion: AgentTool = {
    name: 'select_region',
    title: 'Select a region',
    description:
      'Deprecated: use select_rect, select_ellipse, select_polygon, select_all, deselect or invert_selection (this alias goes in the next minor release). Selects a rectangle or ellipse (x, y, width, height in natural image pixels), a polygon (the lasso: points along an outline, closed automatically), everything ("all"), nothing ("none") or the inverse of the current selection ("invert"). To cut out a subject, trace its contour with polygon (then refine_selection for soft edges such as fur or foliage) rather than selecting its bounding box. One undoable step.',
    inputSchema: {
      type: 'object',
      properties: {
        shape: { type: 'string', enum: ['rect', 'ellipse', 'polygon', 'all', 'none', 'invert'], description: 'What to select.' },
        x: { type: 'number', description: 'rect / ellipse: left edge in natural image pixels.' },
        y: { type: 'number', description: 'rect / ellipse: top edge in natural image pixels.' },
        width: { type: 'number', description: 'rect / ellipse: width in natural image pixels.' },
        height: { type: 'number', description: 'rect / ellipse: height in natural image pixels.' },
        points: {
          type: 'array',
          minItems: 3,
          items: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
            additionalProperties: false,
          },
          description: 'polygon: at least 3 vertices along the outline, in order, in natural image pixels. Follow the edge closely; more points give a tighter contour.',
        },
        mode: modeSchema,
        feather: { type: 'number', minimum: 0, description: 'Feather radius in pixels (default 0).' },
      },
      required: ['shape'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Select a region', true),
    handler: ({ shape, x, y, width, height, points, mode, feather }) => {
      const opts = { mode: parseSelectionMode(mode), feather: num(feather, 0) };
      switch (shape) {
        case 'all':
          controller.selectAll();
          break;
        case 'none':
          controller.deselect();
          break;
        case 'invert':
          controller.invertSelection();
          break;
        case 'rect':
        case 'ellipse': {
          const rect = { x: num(x, NaN), y: num(y, NaN), width: num(width, NaN), height: num(height, NaN) };
          if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
            throw new Error('rect and ellipse need numeric x, y, width and height.');
          }
          if (shape === 'rect') controller.selectRect(rect, opts);
          else controller.selectEllipse(rect, opts);
          break;
        }
        case 'polygon': {
          const list = Array.isArray(points) ? points.map((p: any) => ({ x: num(p?.x, NaN), y: num(p?.y, NaN) })) : [];
          if (list.length < 3 || !list.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
            throw new Error('polygon needs points: at least 3 { x, y } vertices.');
          }
          controller.selectPolygon(list, opts);
          break;
        }
        default:
          throw new Error(`Unknown shape "${String(shape)}". Use rect, ellipse, polygon, all, none or invert.`);
      }
      return summary(controller);
    },
  };

  const selectByColor: AgentTool = {
    name: 'select_by_color',
    title: 'Select by colour',
    description:
      'Deprecated: use magic_wand or select_color_range (this alias goes in the next minor release). Magic wand at (x, y) with tolerance (0-255) and contiguous, or with "color" ("#rrggbb") every pixel of a similar colour (Color Range, fuzziness 0-200). One undoable step.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Seed point x in natural image pixels.' },
        y: { type: 'number', description: 'Seed point y in natural image pixels.' },
        color: { type: 'string', description: '#rrggbb: select this colour everywhere instead of a seed point.' },
        tolerance: { type: 'number', minimum: 0, maximum: 255, description: 'Magic wand tolerance (default 32).' },
        contiguous: { type: 'boolean', description: 'Only the connected region around (x, y) (default true).' },
        fuzziness: { type: 'number', minimum: 0, maximum: 200, description: 'Color Range fuzziness (default 40).' },
        sampleMerged: { type: 'boolean', description: 'Sample the adjusted image rather than the source.' },
        sample: {
          type: 'string',
          enum: ['composite', 'active-layer'],
          description: 'composite (default): the whole image; active-layer: only the active pixel layer (see set_active_layer).',
        },
        mode: modeSchema,
      },
      additionalProperties: false,
    },
    annotations: writeAnnotations('Select by colour', true),
    handler: async ({ x, y, color, tolerance, contiguous, fuzziness, sampleMerged, sample, mode }) => {
      const common = {
        mode: parseSelectionMode(mode),
        sampleMerged: sampleMerged === true,
        sample: (sample as 'composite' | 'active-layer' | undefined) ?? 'composite',
      };
      if (typeof color === 'string') {
        await controller.selectColorRange([{ color }], { ...common, fuzziness: num(fuzziness, 40) });
      } else if (typeof x === 'number' && typeof y === 'number') {
        await controller.magicWand({ x, y }, { ...common, tolerance: num(tolerance, 32), contiguous: contiguous !== false });
      } else {
        throw new Error('Pass x and y (magic wand) or color (#rrggbb).');
      }
      return summary(controller);
    },
  };

  const modify: AgentTool = {
    name: 'modify_selection',
    title: 'Modify the selection',
    description:
      'Select › Modify: expand, contract, feather, border or smooth the selection by radius pixels (grow and shrink are older names for expand and contract). Expand and contract move the edge by distance; to add pixels of similar colour use grow_selection or select_similar. One undoable step.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: [...SELECTION_MODIFY_OPS], description: 'How to modify the selection.' },
        radius: { type: 'number', minimum: 0, maximum: 500, description: 'Radius in pixels.' },
      },
      required: ['op', 'radius'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Modify the selection'),
    handler: ({ op, radius }) => {
      if (!(SELECTION_MODIFY_OPS as readonly string[]).includes(op as string)) throw new Error(`Unknown op "${String(op)}".`);
      if (!controller.getSelection()) throw new Error('Nothing is selected.');
      controller.modifySelection(op as SelectionModifyOp, Math.min(500, Math.max(0, num(radius, 0))));
      return summary(controller);
    },
  };

  const refine: AgentTool = {
    name: 'refine_selection',
    title: 'Refine the selection edge',
    description:
      'Refine Edge: snaps the selection edge to the image within radius pixels (edge-aware guided filter), then smooth (0-100), feather (px), contrast (0-100) and shiftEdge (-100..100 %). Use it after loading a coarse AI mask. One undoable step.',
    inputSchema: {
      type: 'object',
      properties: {
        radius: { type: 'number', minimum: 0, maximum: 64, description: 'Edge detection radius in pixels.' },
        smartRadius: { type: 'boolean', description: 'Adapt the radius to hard and soft edges.' },
        smooth: { type: 'number', minimum: 0, maximum: 100, description: 'Smooth the edge outline (0-100).' },
        feather: { type: 'number', minimum: 0, maximum: 250, description: 'Feather the edge (pixels).' },
        contrast: { type: 'number', minimum: 0, maximum: 100, description: 'Sharpen the edge transition (0-100).' },
        shiftEdge: { type: 'number', minimum: -100, maximum: 100, description: 'Move the edge out (+) or in (-), in percent.' },
      },
      additionalProperties: false,
    },
    annotations: writeAnnotations('Refine the selection edge'),
    handler: async (params) => {
      if (!controller.getSelection()) throw new Error('Nothing is selected.');
      await controller.refineSelection({
        radius: num(params.radius, 8),
        smartRadius: params.smartRadius === true,
        smooth: num(params.smooth, 0),
        feather: num(params.feather, 0),
        contrast: num(params.contrast, 0),
        shiftEdge: num(params.shiftEdge, 0),
      });
      return summary(controller);
    },
  };

  const applyMask: AgentTool = {
    name: 'apply_selection_as_mask',
    title: 'Mask a layer with the selection',
    description:
      'Uses the selection as an adjustment layer mask: on layerId, or on a new layer of kind (with optional params), so the adjustment only affects the selected area. density (0-1) and feather (px) soften the mask non-destructively. One undoable step.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'string', description: 'Existing adjustment layer to mask.' },
        kind: { type: 'string', enum: ADJUSTMENT_KINDS.map((k) => k.kind), description: 'Kind of a new layer to add and mask (instead of layerId).' },
        params: { type: 'object', description: 'Parameters for the new layer (see list_controls).' },
        density: { type: 'number', minimum: 0, maximum: 1, description: 'Mask density 0-1.' },
        feather: { type: 'number', minimum: 0, maximum: 1000, description: 'Mask feather in pixels.' },
      },
      additionalProperties: false,
    },
    annotations: writeAnnotations('Mask a layer with the selection'),
    handler: ({ layerId, kind, params, density, feather }) => {
      const sel = controller.getSelection();
      if (!sel) throw new Error('Nothing is selected.');
      const props = {
        ...(typeof density === 'number' ? { density } : {}),
        ...(typeof feather === 'number' ? { feather } : {}),
      };
      let id: string;
      if (typeof layerId === 'string') {
        if (!controller.getAdjustmentLayer(layerId)) throw new Error(`No adjustment layer "${layerId}".`);
        controller.applySelectionAsLayerMask(layerId, props);
        id = layerId;
      } else if (isAdjustmentKind(kind)) {
        id = controller.addAdjustmentLayer({
          kind: kind as AdjustmentKind,
          params: params as never,
          mask: layerMaskFromSelection(sel, props),
        });
      } else {
        throw new Error('Pass layerId (an existing layer) or kind (a new adjustment layer).');
      }
      const layer = controller.getAdjustmentLayer(id)!;
      const { rle: _rle, ...mask } = layer.mask!;
      return { layerId: id, kind: layer.kind, mask, selection: summary(controller) };
    },
  };

  const selectAll: AgentTool = {
    name: 'select_all',
    title: 'Select all',
    description: 'Select › All: selects the whole image. One undoable step. Returns the selection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: writeAnnotations('Select all', true),
    handler: () => {
      controller.selectAll();
      return summary(controller);
    },
  };

  const deselect: AgentTool = {
    name: 'deselect',
    title: 'Deselect',
    description: 'Select › Deselect: clears the selection, so later edits apply to the whole layer. One undoable step. Returns the (empty) selection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: writeAnnotations('Deselect', true),
    handler: () => {
      controller.deselect();
      return summary(controller);
    },
  };

  const invert: AgentTool = {
    name: 'invert_selection',
    title: 'Invert the selection',
    description: 'Select › Inverse: selects what was not selected (soft edges stay soft). With nothing selected, selects everything. One undoable step. Returns the selection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: writeAnnotations('Invert the selection'),
    handler: () => {
      controller.invertSelection();
      return summary(controller);
    },
  };

  const selectRect: AgentTool = {
    name: 'select_rect',
    title: 'Select a rectangle',
    description:
      'Rectangular Marquee: selects x, y, width, height (natural image pixels), combined with the selection by mode. Use it for geometric areas (a frame, a screen, a strip along an edge); for a subject, trace its outline with select_polygon or use select_subject. One undoable step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: { ...rectProperties, mode: modeSchema, feather: featherSchema, antiAlias: antiAliasSchema },
      required: ['x', 'y', 'width', 'height'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Select a rectangle', true),
    handler: (args) => {
      controller.selectRect(rectOf(args), shapeOptions(args));
      return summary(controller);
    },
  };

  const selectEllipse: AgentTool = {
    name: 'select_ellipse',
    title: 'Select an ellipse',
    description:
      'Elliptical Marquee: selects the ellipse inscribed in x, y, width, height (natural image pixels), combined by mode. Use feather for a vignette. One undoable step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: { ...rectProperties, mode: modeSchema, feather: featherSchema, antiAlias: antiAliasSchema },
      required: ['x', 'y', 'width', 'height'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Select an ellipse', true),
    handler: (args) => {
      controller.selectEllipse(rectOf(args), shapeOptions(args));
      return summary(controller);
    },
  };

  const selectPolygonTool: AgentTool = {
    name: 'select_polygon',
    title: 'Select a polygon (lasso)',
    description:
      'Lasso: selects the polygon through points (natural image pixels, in order along the outline, closed automatically), combined by mode. To cut out a subject, follow its contour closely (more points give a tighter edge), then refine_selection for hair or foliage. One undoable step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        points: { type: 'array', minItems: 3, items: pointSchema, description: 'At least 3 vertices along the outline, in order, in natural image pixels.' },
        mode: modeSchema,
        feather: featherSchema,
        antiAlias: antiAliasSchema,
      },
      required: ['points'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Select a polygon (lasso)', true),
    handler: (args) => {
      const list = Array.isArray(args.points) ? args.points.map((p: any) => ({ x: num(p?.x, NaN), y: num(p?.y, NaN) })) : [];
      if (list.length < 3 || !list.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
        throw new Error('points needs at least 3 { x, y } vertices in natural image pixels.');
      }
      controller.selectPolygon(list, shapeOptions(args));
      return summary(controller);
    },
  };

  const magicWandTool: AgentTool = {
    name: 'magic_wand',
    title: 'Magic wand',
    description:
      'Magic Wand: selects pixels similar in colour to the one at (x, y). tolerance 0..255 (default 32) is the largest channel difference (rgb) or ΔE scaled so 255 ≈ ΔE 100 (perceptual, closer to how colours look); contiguous (default true) keeps only the region connected to the seed. Best on flat backdrops and solid colours; check percent with get_selection before using it. One undoable step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Seed x in natural image pixels.' },
        y: { type: 'number', description: 'Seed y in natural image pixels.' },
        tolerance: { type: 'number', minimum: 0, maximum: 255, description: 'Colour tolerance 0..255 (default 32).' },
        contiguous: { type: 'boolean', description: 'Only the region connected to the seed (default true); false selects every similar pixel.' },
        distance: { type: 'string', enum: ['rgb', 'perceptual'], description: 'How colour difference is measured: rgb (default, as Photoshop) or perceptual (CIE ΔE).' },
        antiAlias: antiAliasSchema,
        sampleMerged: sampleMergedSchema,
        sample: sampleSchema,
        mode: modeSchema,
        feather: featherSchema,
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Magic wand', true),
    handler: async (args) => {
      const x = num(args.x, NaN);
      const y = num(args.y, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Pass the seed point x and y in natural image pixels.');
      const { width, height } = controller.getState().imageDimensions;
      if (x < 0 || y < 0 || x >= width || y >= height) throw new Error(`(${x}, ${y}) is outside the image (0..${width - 1}, 0..${height - 1}).`);
      if (args.distance !== undefined && args.distance !== 'rgb' && args.distance !== 'perceptual') {
        throw new Error(`Unknown distance "${String(args.distance)}". Use rgb or perceptual.`);
      }
      await controller.magicWand(
        { x, y },
        {
          ...shapeOptions(args),
          ...sampleOptions(args),
          tolerance: Math.min(255, Math.max(0, num(args.tolerance, 32))),
          contiguous: args.contiguous !== false,
          distance: (args.distance as 'rgb' | 'perceptual' | undefined) ?? 'rgb',
        }
      );
      return summary(controller);
    },
  };

  const colorRangeTool: AgentTool = {
    name: 'select_color_range',
    title: 'Select a colour range',
    description:
      'Select › Color Range: selects every pixel matching samples (colours, each optionally at the x, y where it was picked) or a preset (reds … magentas, highlights, midtones, shadows, skinTones), softly: coverage falls off with colour distance over fuzziness levels. localized limits each positioned sample to a radius. invert selects everything else. Pass samples or preset, not both. One undoable step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        samples: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: {
            type: 'object',
            properties: {
              color: { type: 'string', pattern: '^#?[0-9a-fA-F]{6}$', description: 'The sampled colour, #rrggbb.' },
              x: { type: 'number', description: 'Where it was picked (natural image pixels), for localized.' },
              y: { type: 'number', description: 'Where it was picked (natural image pixels), for localized.' },
            },
            required: ['color'],
            additionalProperties: false,
          },
          description: 'Colours to select (the + eyedropper adds one). Read colours from capture_view or a seed pixel.',
        },
        preset: { type: 'string', enum: [...COLOR_RANGE_PRESETS], description: 'A preset range instead of samples.' },
        fuzziness: {
          type: 'number',
          minimum: 0,
          maximum: 200,
          description: 'Colour samples: levels over which coverage fades to 0 (default 40). Tone presets: falloff in levels around the range (default 20). Ignored by colour and skin presets.',
        },
        localized: { type: 'number', exclusiveMinimum: 0, description: 'Localized Color Clusters: positioned samples fade to 0 at this many pixels from where they were picked (default off).' },
        invert: { type: 'boolean', description: 'Select everything except the range (default false).' },
        sampleMerged: sampleMergedSchema,
        sample: sampleSchema,
        mode: modeSchema,
        feather: featherSchema,
      },
      additionalProperties: false,
    },
    annotations: writeAnnotations('Select a colour range', true),
    handler: async (args) => {
      const hasSamples = Array.isArray(args.samples) && args.samples.length > 0;
      if (hasSamples === (args.preset !== undefined)) throw new Error('Pass samples (colours to match) or preset, not both.');
      const common = { ...sampleOptions(args), mode: parseSelectionMode(args.mode), feather: num(args.feather, 0), invert: args.invert === true };
      if (!hasSamples) {
        if (!isColorRangePreset(args.preset)) throw new Error(`Unknown preset "${String(args.preset)}". Use one of ${COLOR_RANGE_PRESETS.join(', ')}.`);
        await controller.selectColorRangePreset(args.preset, { ...common, falloff: num(args.fuzziness, 20) });
      } else {
        const samples: ColorRangeSample[] = (args.samples as any[]).map((s, i) => {
          if (typeof s?.color !== 'string' || !/^#?[0-9a-f]{6}$/i.test(s.color.trim())) throw new Error(`samples[${i}].color must be #rrggbb.`);
          const at = typeof s.x === 'number' && typeof s.y === 'number' ? { x: s.x, y: s.y } : undefined;
          return at ? { color: s.color, at } : { color: s.color };
        });
        const localized = typeof args.localized === 'number' && args.localized > 0 ? args.localized : undefined;
        await controller.selectColorRange(samples, { ...common, fuzziness: num(args.fuzziness, 40), localized });
      }
      return summary(controller);
    },
  };

  const loadFromImage: AgentTool = {
    name: 'load_selection_from_image',
    title: 'Load a selection from a mask image',
    description:
      'Loads a selection from a mask image (an AI segmentation, a saved matte): white = selected by luminance, or one channel. Any size; it is resampled to the image. threshold (0..255) makes it hard-edged; leave it unset to keep soft edges. Follow with refine_selection for a coarse mask. One undoable step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', minLength: 1, description: 'The mask as a data URL (data:image/png;base64,…) or an image URL.' },
        channel: { type: 'string', enum: ['luminance', 'alpha', 'red', 'green', 'blue'], description: 'What to read as coverage (default luminance; alpha for a cutout PNG).' },
        threshold: { type: 'number', minimum: 0, maximum: 255, description: 'Values at or above this are selected, the rest not (default: keep soft values).' },
        invert: { type: 'boolean', description: 'Black = selected instead (default false).' },
        mode: modeSchema,
      },
      required: ['image'],
      additionalProperties: false,
    },
    annotations: { ...writeAnnotations('Load a selection from a mask image', true), openWorldHint: true },
    handler: async (args) => {
      if (typeof args.image !== 'string' || !args.image.trim()) throw new Error('image must be a data URL or image URL.');
      const channel = (args.channel as SelectionChannel | undefined) ?? 'luminance';
      if (!['luminance', 'alpha', 'red', 'green', 'blue'].includes(channel)) throw new Error(`Unknown channel "${String(channel)}". Use luminance, alpha, red, green or blue.`);
      await controller.loadSelectionFromImage(args.image, {
        channel,
        invert: args.invert === true,
        threshold: typeof args.threshold === 'number' ? Math.min(255, Math.max(0, args.threshold)) : undefined,
        mode: parseSelectionMode(args.mode),
      });
      return summary(controller);
    },
  };

  const loadFromMask: AgentTool = {
    name: 'load_selection_from_mask',
    title: 'Load a selection from a layer mask',
    description:
      'Load Selection from a layer\'s mask (Ctrl/⌘-click its mask thumbnail): the mask\'s pixels become the selection, combined by mode (density and feather are not applied). Use it to reuse a mask on another layer or to edit it as a selection. Fails when the layer has no painted mask. One undoable step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'string', minLength: 1, description: 'The layer whose mask to load (see list_layers).' },
        invert: { type: 'boolean', description: 'Select what the mask hides instead (default false).' },
        mode: modeSchema,
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Load a selection from a layer mask', true),
    handler: (args) => {
      const id = String(args.layerId ?? '');
      const layer = controller.getLayer(id);
      if (!layer) throw new Error(`No layer "${id}". Call list_layers for ids.`);
      if (!layer.mask) throw new Error(`Layer "${id}" has no mask. Add one with add_layer_mask, or pick a layer with a mask.`);
      if (layer.mask.source) throw new Error(`Layer "${id}" has a computed (depth) mask, not a painted one, so it cannot be loaded as a selection.`);
      controller.selectionFromLayerMask(id, parseSelectionMode(args.mode), args.invert === true);
      return summary(controller);
    },
  };

  const display: AgentTool = {
    name: 'set_selection_display',
    title: 'Show or hide the selection',
    description:
      'How the canvas shows the selection: ants (marching ants), quickMask (a red tint over what is not selected, to judge soft edges and feather) or none (hidden; it still limits edits). View state only: no undo step, not saved. Returns the display and the selection.',
    inputSchema: {
      type: 'object',
      properties: { display: { type: 'string', enum: ['ants', 'quickMask', 'none'], description: 'ants, quickMask or none.' } },
      required: ['display'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Show or hide the selection', true),
    handler: (args) => {
      controller.setSelectionDisplay(args.display as 'ants' | 'quickMask' | 'none');
      return { display: controller.getSelectionDisplay(), selection: summary(controller) };
    },
  };

  const sampleTolerance: Record<string, JsonSchema> = {
    tolerance: { type: 'number', minimum: 0, maximum: 255, description: 'Largest per-channel difference from a selected colour, 0..255 (default 32, as magic_wand).' },
    sampleMerged: sampleMergedSchema,
    sample: sampleSchema,
  };

  const growTool: AgentTool = {
    name: 'grow_selection',
    title: 'Grow the selection by colour',
    description:
      'Select › Grow: adds the pixels connected to the selection whose colour is within tolerance of a selected colour (to the nearest 4 levels). Use it after a magic_wand click that missed shades of the same area. Unlike modify_selection expand, it follows colour, not distance. Fails when nothing is selected. One undoable step. Returns the selection.',
    inputSchema: { type: 'object', properties: sampleTolerance, additionalProperties: false },
    annotations: writeAnnotations('Grow the selection by colour'),
    handler: async (args) => {
      if (!controller.getSelection()) throw new Error('Nothing is selected; select part of the area first (magic_wand, select_rect).');
      await controller.growSelection({ ...sampleOptions(args), tolerance: Math.min(255, Math.max(0, num(args.tolerance, 32))) });
      return summary(controller);
    },
  };

  const similarTool: AgentTool = {
    name: 'select_similar',
    title: 'Select similar colours',
    description:
      'Select › Similar: adds every pixel in the image whose colour is within tolerance of a selected colour, connected or not. Fails when nothing is selected. One undoable step. Returns the selection.',
    inputSchema: { type: 'object', properties: sampleTolerance, additionalProperties: false },
    annotations: writeAnnotations('Select similar colours'),
    handler: async (args) => {
      if (!controller.getSelection()) throw new Error('Nothing is selected; select a sample of the colour first.');
      await controller.selectSimilar({ ...sampleOptions(args), tolerance: Math.min(255, Math.max(0, num(args.tolerance, 32))) });
      return summary(controller);
    },
  };

  const lineTool: AgentTool = {
    name: 'select_line',
    title: 'Select a single row or column',
    description:
      'Single Row / Single Column Marquee: selects a 1 px line across the whole image, a row at y = position or a column at x = position (natural image pixels). Use it to fix a dead row or column of pixels, or to stretch an edge line. One undoable step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        orientation: { type: 'string', enum: ['row', 'column'], description: 'row (horizontal, at y) or column (vertical, at x).' },
        position: { type: 'number', minimum: 0, description: 'y of the row or x of the column, in natural image pixels.' },
        mode: modeSchema,
      },
      required: ['orientation', 'position'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Select a single row or column', true),
    handler: (args) => {
      if (args.orientation !== 'row' && args.orientation !== 'column') throw new Error('orientation must be row or column.');
      controller.selectLine(args.orientation, num(args.position, NaN), { mode: parseSelectionMode(args.mode) });
      return summary(controller);
    },
  };

  const reselectTool: AgentTool = {
    name: 'reselect',
    title: 'Reselect',
    description:
      'Select › Reselect: brings back the last selection that deselect (or select_region none) cleared. Fails when there is none (for example after reopening the document). One undoable step. Returns the selection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: writeAnnotations('Reselect', true),
    handler: () => {
      if (!controller.canReselect()) throw new Error('There is no cleared selection to bring back.');
      controller.reselect();
      return summary(controller);
    },
  };

  const transparencyTool: AgentTool = {
    name: 'select_layer_transparency',
    title: "Select a layer's pixels",
    description:
      "Load Selection from a layer's transparency (Ctrl/⌘-click its thumbnail): selects where the layer has pixels, soft where it is partly transparent, combined by mode. Use it to select a cutout, a shape or text exactly. Pixel, shape, type and smart object layers. One undoable step. Returns the selection.",
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'string', minLength: 1, description: 'The layer whose pixels to select (see list_layers).' },
        mode: modeSchema,
        feather: featherSchema,
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: writeAnnotations("Select a layer's pixels", true),
    handler: (args) => {
      const id = String(args.layerId ?? '');
      if (!controller.getLayer(id)) throw new Error(`No layer "${id}". Call list_layers for ids.`);
      controller.selectLayerTransparency(id, { mode: parseSelectionMode(args.mode), feather: num(args.feather, 0) });
      return summary(controller);
    },
  };

  return [
    getSelection,
    selectAll,
    deselect,
    invert,
    selectRect,
    selectEllipse,
    selectPolygonTool,
    lineTool,
    magicWandTool,
    colorRangeTool,
    loadFromImage,
    loadFromMask,
    transparencyTool,
    growTool,
    similarTool,
    reselectTool,
    display,
    selectRegion,
    selectByColor,
    modify,
    refine,
    applyMask,
  ];
}

/** Options for `createImageSegmentationToolProvider`. */
export interface ImageSegmentationToolProviderOptions {
  /** Provider id (default `image-segmentation`). */
  id?: string;
  /** Tool-name prefix (`<namespace>__<name>`). */
  namespace?: string;
  /** Agent playback surface (default the image editor's). */
  playbackSurface?: string;
}

/** The `select_subject` tool: Select › Subject through the controller's segmentation provider. */
export function createImageSubjectSelectionTool(controller: ImageEditorController): AgentTool {
  return {
    name: 'select_subject',
    title: 'Select a subject',
    description:
      'Select › Subject: an AI segmentation model finds the objects matching target (a description such as "the dog", "the house", "the sky") in the flattened image and selects their outlines, combined with the selection by mode. Use it to cut a subject out by its contour (then layer_via_copy for a layer of just that subject); describe one object precisely to get only that one. One undoable step. Returns the selection and the objects found (label, bounds); none found leaves the selection unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', minLength: 1, description: 'What to select, in words.' },
        maxSegments: {
          type: 'integer',
          minimum: 1,
          maximum: 32,
          description: 'Select at most this many matching objects (default the model’s; 1 for a single subject).',
        },
        mode: modeSchema,
        feather: { type: 'number', minimum: 0, description: 'Feather radius in pixels (default 0).' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    annotations: { ...writeAnnotations('Select a subject'), openWorldHint: true },
    handler: async ({ target, maxSegments, mode, feather }, context) => {
      if (typeof target !== 'string' || !target.trim()) throw new Error('target must describe what to select.');
      const perform = context?.perform;
      const { segments } = await controller.selectSubject(target, {
        mode: parseSelectionMode(mode),
        feather: num(feather, 0),
        maxSegments: typeof maxSegments === 'number' ? Math.max(1, Math.round(maxSegments)) : undefined,
        signal: context?.signal,
        // Under playback the cursor traces what the model found, as a lasso, before it is selected.
        beforeApply: perform ? (outlines) => perform(planOutlineTrace(outlines)) : undefined,
      });
      return { ...summary(controller), found: segments };
    },
  };
}

/**
 * Agent tools that need the controller's segmentation provider (`select_subject`). The list is
 * empty while no provider is set, so a host can register this once and the tool appears when a
 * model is available.
 */
export function createImageSegmentationToolProvider(
  controller: ImageEditorController,
  options: ImageSegmentationToolProviderOptions = {}
): AgentToolProvider {
  const tool = createImageSubjectSelectionTool(controller);
  return withImagePlayback(
    {
      id: options.id ?? 'image-segmentation',
      namespace: options.namespace,
      title: 'Image segmentation',
      description: 'Select › Subject: select objects in the image by description through an AI segmentation model.',
      skill: 'pixerate-image-editor',
      tools: () => (controller.segmentationProvider ? [tool] : []),
    },
    options.playbackSurface
  );
}
