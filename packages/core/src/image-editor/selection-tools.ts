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
import { BLEND_MODES } from './blend';

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
      'Lasso: selects the polygon through points (natural image pixels, in order along the outline, closed automatically), combined by mode. To cut out a subject, follow its contour closely (more points give a tighter edge), then refine_selection for hair or foliage. With snapToEdges (the Magnetic Lasso), each point snaps to the strongest edge within width px and the outline between points follows the edges of the image, so a rough outline a few dozen px per point is enough on a subject with a clear edge. One undoable step. Returns the selection (with snapToEdges, also outlinePoints: how many vertices the snapped outline has).',
    inputSchema: {
      type: 'object',
      properties: {
        points: { type: 'array', minItems: 3, items: pointSchema, description: 'At least 3 vertices along the outline, in order, in natural image pixels.' },
        snapToEdges: {
          type: 'object',
          description: 'Magnetic Lasso: snap the outline to the edges of the image (the composite as painted) instead of joining the points with straight lines. Omit for a plain polygon.',
          properties: {
            width: { type: 'number', minimum: 1, maximum: 256, description: 'Detection width in px: each point snaps to the strongest edge this close (default 10). Keep points within it of the edge.' },
            contrast: { type: 'number', minimum: 0.01, maximum: 1, description: 'Ignore edges with less contrast than this, 0.01..1 (default 0.1). Raise it on a noisy or textured background; lower it for a faint edge.' },
          },
          additionalProperties: false,
        },
        mode: modeSchema,
        feather: featherSchema,
        antiAlias: antiAliasSchema,
      },
      required: ['points'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Select a polygon (lasso)', true),
    handler: async (args) => {
      const list = Array.isArray(args.points) ? args.points.map((p: any) => ({ x: num(p?.x, NaN), y: num(p?.y, NaN) })) : [];
      if (list.length < 3 || !list.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
        throw new Error('points needs at least 3 { x, y } vertices in natural image pixels.');
      }
      const snap = args.snapToEdges as { width?: number; contrast?: number } | undefined;
      if (!snap) {
        controller.selectPolygon(list, shapeOptions(args));
        return summary(controller);
      }
      const outline = await controller.snapToEdges(list, { width: snap.width, contrast: snap.contrast });
      controller.selectPolygon(outline, shapeOptions(args));
      return { ...summary(controller), outlinePoints: outline.length };
    },
  };

  const quickSelectTool: AgentTool = {
    name: 'quick_select',
    title: 'Quick Selection',
    description:
      'Quick Selection: paints brush strokes (paths in natural image pixels) that each grow into the region they are painted on, out to its edges (a graph cut on colour and edges), combined with the selection by mode. With replace (default) the first stroke replaces the selection and later ones add, as the brush does; use mode subtract to take an area back out. Best for a subject or area that differs from its surroundings: paint inside it, away from the edge, then check with get_selection and capture_view and add or subtract strokes where it leaked or fell short. All strokes are one undoable step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        strokes: {
          type: 'array',
          minItems: 1,
          items: { type: 'array', minItems: 1, items: pointSchema, description: 'One stroke: the brush path, in order (one point is a dab).' },
          description: 'Brush strokes in natural image pixels, applied in order.',
        },
        size: { type: 'number', minimum: 1, maximum: 2500, description: 'Brush diameter in natural image pixels (default 30). Smaller for a narrow area, larger for a broad one.' },
        mode: modeSchema,
        sampleAllLayers: { type: 'boolean', description: 'Read every layer (default true); false reads only the active pixel layer.' },
        enhanceEdge: { type: 'boolean', description: 'Smoother, less blocky edges (Auto-Enhance; default false). Use it before masking a smooth-edged subject.' },
      },
      required: ['strokes'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Quick Selection'),
    handler: async (args) => {
      const strokes = Array.isArray(args.strokes)
        ? args.strokes.map((s: any) => (Array.isArray(s) ? s.map((p: any) => ({ x: num(p?.x, NaN), y: num(p?.y, NaN) })) : []))
        : [];
      if (!strokes.length || strokes.some((s: { x: number; y: number }[]) => !s.length || !s.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))) {
        throw new Error('strokes needs at least one stroke of { x, y } points in natural image pixels.');
      }
      await controller.quickSelect(strokes, {
        size: args.size === undefined ? undefined : num(args.size, 30),
        mode: parseSelectionMode(args.mode),
        sampleAllLayers: args.sampleAllLayers as boolean | undefined,
        enhanceEdge: args.enhanceEdge as boolean | undefined,
      });
      return summary(controller);
    },
  };

  const selectObjectTool: AgentTool = {
    name: 'select_object',
    title: 'Object Selection',
    description:
      'Object Selection: selects the object inside rect (a box drawn loosely around it, natural image pixels; what lies outside the box is treated as background) or the object under point, found from the colours of object and background and the edges between them (GrabCut). Combined with the selection by mode. A box is more reliable than a point: make it a little larger than the object on every side. Check with get_selection and capture_view, then fix with quick_select strokes or select_object with mode add / subtract. One undoable step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        rect: {
          type: 'object',
          properties: rectProperties,
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
          description: 'A box around the object (x, y, width, height in natural image pixels). Pass this or point.',
        },
        point: { ...pointSchema, description: 'A point on the object (natural image pixels). Pass this or rect.' },
        mode: modeSchema,
        sampleAllLayers: { type: 'boolean', description: 'Read every layer (default true); false reads only the active pixel layer.' },
        enhanceEdge: { type: 'boolean', description: 'Smoother, less blocky edges (Auto-Enhance; default false).' },
      },
      additionalProperties: false,
    },
    annotations: writeAnnotations('Object Selection'),
    handler: async (args) => {
      const rect = args.rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined;
      const point = args.point as { x?: unknown; y?: unknown } | undefined;
      if (!rect && !point) throw new Error('Pass rect (a box around the object) or point (a point on it).');
      if (rect && point) throw new Error('Pass rect or point, not both.');
      const options = { mode: parseSelectionMode(args.mode), sampleAllLayers: args.sampleAllLayers as boolean | undefined, enhanceEdge: args.enhanceEdge as boolean | undefined };
      if (rect) await controller.selectObject({ rect: { x: num(rect.x, NaN), y: num(rect.y, NaN), width: num(rect.width, NaN), height: num(rect.height, NaN) } }, options);
      else await controller.selectObject({ point: { x: num(point!.x, NaN), y: num(point!.y, NaN) } }, options);
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
      'Load Selection from a layer\'s mask (Ctrl/⌘-click its mask thumbnail): the raster mask\'s pixels, or with source vector the vector mask\'s path, become the selection, combined by mode (density and feather are not applied). Use it to reuse a mask on another layer or to edit it as a selection. Fails when the layer has no such mask. One undoable step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'string', minLength: 1, description: 'The layer whose mask to load (see list_layers).' },
        source: { type: 'string', enum: ['pixels', 'vector'], description: 'pixels: the raster (layer) mask (default); vector: the vector mask\'s path.' },
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
      if (args.source === 'vector') {
        if (!layer.vectorMask) throw new Error(`Layer "${id}" has no vector mask. Add one with add_vector_mask, or load its pixels mask (source pixels).`);
        controller.selectionFromVectorMask(id, parseSelectionMode(args.mode), args.invert === true);
        return summary(controller);
      }
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

  const colorSchema: JsonSchema = { type: 'string', pattern: '^#?[0-9a-fA-F]{6}$', description: 'Colour #rrggbb (default the foreground colour).' };
  const layerIdSchema: JsonSchema = { type: 'string', minLength: 1, description: 'The layer (see list_layers; default the active layer).' };
  const requireLayerId = (v: unknown) => {
    if (v === undefined) return undefined;
    const id = String(v);
    if (!controller.getLayer(id)) throw new Error(`No layer "${id}". Call list_layers for ids.`);
    return id;
  };

  const strokeTool: AgentTool = {
    name: 'stroke_selection',
    title: 'Stroke the selection',
    description:
      'Edit › Stroke: paints a band width px wide along the selection edge, outside it (default), inside it or centred on it, with color, opacity and blend, on a layer\'s pixels or mask (channel). Use it for outlines, frames and borders that follow a shape. Fails when nothing is selected. One undo step. Returns the layer, channel and changed bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', exclusiveMinimum: 0, maximum: 250, description: 'Band width in pixels.' },
        location: { type: 'string', enum: ['outside', 'inside', 'center'], description: 'Where the band lies against the edge (default outside).' },
        color: colorSchema,
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Opacity 0..1 (default 1).' },
        blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'Blend mode (default normal).' },
        layerId: layerIdSchema,
        channel: { type: 'string', enum: ['pixels', 'mask'], description: 'Paint the pixels (default) or the layer mask.' },
      },
      required: ['width'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Stroke the selection'),
    handler: (args) => {
      if (!controller.getSelection()) throw new Error('Nothing is selected; select the shape to outline first.');
      return controller.strokeSelection({
        width: num(args.width, NaN),
        location: args.location as 'inside' | 'center' | 'outside' | undefined,
        color: args.color as string | undefined,
        opacity: args.opacity as number | undefined,
        blend: args.blend as never,
        layerId: requireLayerId(args.layerId),
        channel: args.channel as 'pixels' | 'mask' | undefined,
      });
    },
  };

  const cropTool: AgentTool = {
    name: 'crop_to_selection',
    title: 'Crop to the selection',
    description:
      'Image › Crop to the selection: sets the crop box to the selection\'s bounds (non-destructive; reset_crop undoes it). Fails when nothing is selected. One undo step. Returns the crop box in natural image pixels.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: writeAnnotations('Crop to the selection', true),
    handler: () => {
      if (!controller.getSelection()) throw new Error('Nothing is selected; select the area to keep first.');
      return { crop: controller.cropToSelection() };
    },
  };

  const fillTool: AgentTool = {
    name: 'content_aware_fill',
    title: 'Content-Aware Fill',
    description:
      'Edit › Content-Aware Fill: removes what is selected by filling it with texture and edges synthesised from around it (on a pixel layer, default the active one). Select the object with a small margin (expand 2–4 px) first. output current paints into the layer; new-layer puts the fill on its own layer above it, so it can be masked or removed (recommended). sampleRadius limits where it samples from. Deterministic for a seed. 8-bit documents. One undo step. Returns the layer id and filled bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        output: { type: 'string', enum: ['new-layer', 'current'], description: 'new-layer or current (default current).' },
        sampleRadius: { type: 'number', minimum: 32, maximum: 4000, description: 'Sample within this many pixels of the selection (default its larger side).' },
        seed: { type: 'integer', minimum: 0, description: 'Random seed; another seed gives another fill to choose from (default 0).' },
        layerId: layerIdSchema,
      },
      additionalProperties: false,
    },
    annotations: writeAnnotations('Content-Aware Fill'),
    handler: (args) => {
      if (!controller.getSelection()) throw new Error('Nothing is selected; select what to remove first.');
      return controller.contentAwareFill({
        output: args.output as 'current' | 'new-layer' | undefined,
        sampleRadius: args.sampleRadius as number | undefined,
        seed: args.seed as number | undefined,
        layerId: requireLayerId(args.layerId),
      });
    },
  };

  const copyTool: AgentTool = {
    name: 'copy_pixels',
    title: 'Copy pixels',
    description:
      'Edit › Copy: puts the selected pixels of a pixel layer (default the active one), or with merged everything visible (Copy Merged), on the editor clipboard, cropped to the selection with its soft edge as alpha. Without a selection, the whole canvas. The document does not change. Returns the copied size and where it came from; then paste_pixels.',
    inputSchema: {
      type: 'object',
      properties: { layerId: layerIdSchema, merged: { type: 'boolean', description: 'Copy the visible image of all layers (default false).' } },
      additionalProperties: false,
    },
    annotations: { title: 'Copy pixels', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (args) => {
      const { width, height, x, y } = controller.copyPixels({ layerId: requireLayerId(args.layerId), merged: args.merged === true });
      return { width, height, x, y };
    },
  };

  const cutTool: AgentTool = {
    name: 'cut_pixels',
    title: 'Cut pixels',
    description:
      'Edit › Cut: copies the selected pixels of a pixel layer (default the active one) to the editor clipboard and clears them from the layer (transparent, or the background colour on a transparency-locked layer). One undo step. Returns the copied size and position; then paste_pixels.',
    inputSchema: { type: 'object', properties: { layerId: layerIdSchema }, additionalProperties: false },
    annotations: { title: 'Cut pixels', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: (args) => {
      if (!controller.getSelection()) throw new Error('Nothing is selected; select what to cut first (cutting everything would empty the layer).');
      const { width, height, x, y } = controller.cutPixels({ layerId: requireLayerId(args.layerId) });
      return { width, height, x, y };
    },
  };

  const pasteTool: AgentTool = {
    name: 'paste_pixels',
    title: 'Paste pixels',
    description:
      'Edit › Paste the editor clipboard (from copy_pixels or cut_pixels) as a new pixel layer above the active one: new-layer (default, centred on the selection or the canvas), in-place (where it was copied), into (centred in the selection, masked by it: Paste Into) or outside (masked by its inverse). One undo step. Returns the new layerId, its bounds and whether it is masked.',
    inputSchema: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['new-layer', 'in-place', 'into', 'outside'], description: 'Where and how to paste (default new-layer).' } },
      additionalProperties: false,
    },
    annotations: writeAnnotations('Paste pixels'),
    handler: (args) => controller.pastePixels((args.mode as 'new-layer' | 'in-place' | 'into' | 'outside' | undefined) ?? 'new-layer'),
  };

  const channelIdSchema: JsonSchema = { type: 'string', minLength: 1, description: 'The alpha channel (see list_channels).' };
  const channelResult = (id: string) => controller.describeChannels().find((c) => c.id === id)!;

  const listChannels: AgentTool = {
    name: 'list_channels',
    title: 'List alpha channels',
    description:
      'Lists the alpha channels (saved selections kept with the document): id, name, bounds, percent of the image covered, overlay color, opacity, what the tint indicates and whether it is visible. Also whether Quick Mask mode is on.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List alpha channels', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: () => ({ channels: controller.describeChannels(), quickMask: controller.quickMaskEditing }),
  };

  const saveSelectionTool: AgentTool = {
    name: 'save_selection',
    title: 'Save the selection to a channel',
    description:
      'Select › Save Selection: stores the selection in a new alpha channel (name, default "Alpha n"), or with channelId combines it into that channel by mode (replace, add, subtract, intersect). Save any selection that took work, so it can be loaded again with load_selection_from_channel. Fails when nothing is selected. One undo step. Returns the channel.',
    inputSchema: {
      type: 'object',
      properties: { channelId: channelIdSchema, name: { type: 'string', minLength: 1, description: 'Name of a new channel, or a new name for channelId.' }, mode: modeSchema },
      additionalProperties: false,
    },
    annotations: writeAnnotations('Save the selection to a channel'),
    handler: (args) => {
      if (!controller.getSelection()) throw new Error('Nothing is selected; select first, then save it.');
      const c = controller.saveSelection({ channelId: args.channelId as string | undefined, name: args.name as string | undefined, mode: parseSelectionMode(args.mode) });
      return { channel: channelResult(c.id) };
    },
  };

  const loadChannelTool: AgentTool = {
    name: 'load_selection_from_channel',
    title: 'Load a selection from a channel',
    description:
      'Select › Load Selection from an alpha channel (invert for its inverse), combined with the current selection by mode. One undo step. Returns the selection.',
    inputSchema: {
      type: 'object',
      properties: { channelId: channelIdSchema, invert: { type: 'boolean', description: 'Load the inverse (default false).' }, mode: modeSchema },
      required: ['channelId'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Load a selection from a channel', true),
    handler: (args) => {
      controller.loadSelectionFromChannel(String(args.channelId), { mode: parseSelectionMode(args.mode), invert: args.invert === true });
      return summary(controller);
    },
  };

  const channelPropsTool: AgentTool = {
    name: 'set_channel_properties',
    title: 'Change an alpha channel',
    description:
      'Renames an alpha channel or changes its overlay: color (#rrggbb), opacity (0..1), indicates (masked: tint the unselected area, or selected) and visible (show the tint on the canvas). Pixels do not change. One undo step. Returns the channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: channelIdSchema,
        name: { type: 'string', minLength: 1, description: 'New name.' },
        color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Overlay colour #rrggbb.' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Overlay opacity 0..1.' },
        indicates: { type: 'string', enum: ['masked', 'selected'], description: 'Which area the tint covers.' },
        visible: { type: 'boolean', description: 'Show the channel as a tint on the canvas.' },
      },
      required: ['channelId'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Change an alpha channel', true),
    handler: (args) => {
      const { channelId, ...props } = args as Record<string, any>;
      const c = controller.setChannelProperties(String(channelId), props);
      return { channel: channelResult(c.id) };
    },
  };

  const duplicateChannelTool: AgentTool = {
    name: 'duplicate_channel',
    title: 'Duplicate an alpha channel',
    description: 'Copies an alpha channel (name, default "<name> copy") just after it, to keep a version before changing it. One undo step. Returns the copy.',
    inputSchema: {
      type: 'object',
      properties: { channelId: channelIdSchema, name: { type: 'string', minLength: 1, description: 'Name of the copy.' } },
      required: ['channelId'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Duplicate an alpha channel'),
    handler: (args) => ({ channel: channelResult(controller.duplicateChannel(String(args.channelId), args.name as string | undefined).id) }),
  };

  const deleteChannelTool: AgentTool = {
    name: 'delete_channel',
    title: 'Delete an alpha channel',
    description: 'Deletes an alpha channel (undo_image brings it back). Returns the remaining channels.',
    inputSchema: { type: 'object', properties: { channelId: channelIdSchema }, required: ['channelId'], additionalProperties: false },
    annotations: { title: 'Delete an alpha channel', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: (args) => {
      controller.deleteChannel(String(args.channelId));
      return { channels: controller.describeChannels() };
    },
  };

  const quickMaskTool: AgentTool = {
    name: 'set_quick_mask',
    title: 'Quick Mask mode',
    description:
      'Turns Quick Mask mode on or off (Q). On, the selection shows as a red tint and paint_stroke, fill_pixels, clear_pixels, stroke_selection and the retouch tools called without layerId edit the selection itself: white selects, black deselects, grey selects partly, and blur_stroke softens its edge. Each edit is one undo step. Turn it off before painting layers again. Returns the mode and the selection.',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean', description: 'true to enter Quick Mask mode, false to leave it.' } },
      required: ['enabled'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Quick Mask mode', true),
    handler: (args) => {
      if (typeof args.enabled !== 'boolean') throw new Error('enabled must be true or false.');
      controller.setQuickMaskMode(args.enabled);
      return { quickMask: controller.quickMaskEditing, selection: summary(controller) };
    },
  };

  const exportMaskTool: AgentTool = {
    name: 'export_mask_image',
    title: 'Export a mask as a PNG',
    description:
      'Writes the selection, an alpha channel (channelId) or a layer\'s painted mask (layerId) as a greyscale PNG: white = selected / revealed. Use it to look at a mask on its own, or to hand it to another tool or service; load_channel_from_image and load_selection_from_image read it back. Give at most one of channelId and layerId (neither = the selection). Changes nothing. Returns the image and its size.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: channelIdSchema,
        layerId: { type: 'string', minLength: 1, description: 'A layer whose painted mask to export (see list_layers).' },
        invert: { type: 'boolean', description: 'Black = selected instead (default false).' },
        maxSide: { type: 'integer', minimum: 16, maximum: 16384, description: 'Longest side in pixels; larger masks are scaled down (default 1024, never scaled up).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Export a mask as a PNG', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (args) => {
      if (args.channelId !== undefined && args.layerId !== undefined) throw new Error('Give channelId or layerId, not both (neither exports the selection).');
      if (typeof args.layerId === 'string' && !controller.getLayer(args.layerId)) throw new Error(`No layer "${args.layerId}". Call list_layers for ids.`);
      const source = typeof args.channelId === 'string' ? { channelId: args.channelId } : typeof args.layerId === 'string' ? { layerId: args.layerId } : 'selection';
      const out = controller.exportMaskImage(source, { invert: args.invert === true, maxSide: typeof args.maxSide === 'number' ? args.maxSide : 1024 });
      const what = source === 'selection' ? 'Selection' : 'channelId' in source ? `Channel ${source.channelId}` : `Mask of layer ${source.layerId}`;
      return {
        content: [
          { type: 'image', data: out.dataUrl.slice(out.dataUrl.indexOf(',') + 1), mimeType: 'image/png' },
          { type: 'text', text: `${what}, ${out.width}×${out.height}` },
        ],
        structuredContent: { width: out.width, height: out.height },
      };
    },
  };

  const loadChannelFromImageTool: AgentTool = {
    name: 'load_channel_from_image',
    title: 'Load a mask image into a new channel',
    description:
      'Stores a mask image (an AI segmentation, a matte, a PNG from export_mask_image) in a new alpha channel without touching the selection: white = selected by luminance, or one channel. Any size; it is resampled to the image. Load it as the selection later with load_selection_from_channel. One undo step. Returns the channel.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', minLength: 1, description: 'The mask as a data URL (data:image/png;base64,…) or an image URL.' },
        name: { type: 'string', minLength: 1, description: 'Channel name (default "Alpha n").' },
        channel: { type: 'string', enum: ['luminance', 'alpha', 'red', 'green', 'blue'], description: 'What to read as coverage (default luminance; alpha for a cutout PNG).' },
        threshold: { type: 'number', minimum: 0, maximum: 255, description: 'Values at or above this are selected, the rest not (default: keep soft values).' },
        invert: { type: 'boolean', description: 'Black = selected instead (default false).' },
      },
      required: ['image'],
      additionalProperties: false,
    },
    annotations: { ...writeAnnotations('Load a mask image into a new channel'), openWorldHint: true },
    handler: async (args) => {
      if (typeof args.image !== 'string' || !args.image.trim()) throw new Error('image must be a data URL or image URL.');
      const c = await controller.loadChannelFromImage(args.image, {
        name: args.name as string | undefined,
        channel: (args.channel as SelectionChannel | undefined) ?? 'luminance',
        invert: args.invert === true,
        threshold: typeof args.threshold === 'number' ? Math.min(255, Math.max(0, args.threshold)) : undefined,
      });
      return { channel: channelResult(c.id) };
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
    quickSelectTool,
    selectObjectTool,
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
    strokeTool,
    cropTool,
    fillTool,
    copyTool,
    cutTool,
    pasteTool,
    listChannels,
    saveSelectionTool,
    loadChannelTool,
    channelPropsTool,
    duplicateChannelTool,
    deleteChannelTool,
    exportMaskTool,
    loadChannelFromImageTool,
    quickMaskTool,
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
