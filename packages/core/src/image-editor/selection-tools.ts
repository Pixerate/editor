import type { AgentTool } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import type { ImageEditorController } from './controller';
import type { AdjustmentKind } from './types';
import { ADJUSTMENT_KINDS, isAdjustmentKind } from './adjustment-layers';
import { describeSelection } from './selection/tool-options';
import { SELECTION_MODES, parseSelectionMode, selectionArea } from './selection/mask';
import { SELECTION_MODIFY_OPS, type SelectionModifyOp } from './selection/modify';
import { layerMaskFromSelection } from './selection/layer-mask';

const modeSchema: JsonSchema = {
  type: 'string',
  enum: [...SELECTION_MODES],
  description: 'How the result combines with the current selection (default replace).',
};

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

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
 * Agent tools for selections and masks (part of `createImageEditorToolProvider`):
 * `get_selection`, `select_region`, `select_by_color`, `modify_selection`, `refine_selection`
 * and `apply_selection_as_mask`. Coordinates are natural pixels of the source image.
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
      'Selects a rectangle or ellipse (x, y, width, height in natural image pixels), everything ("all"), nothing ("none") or the inverse of the current selection ("invert"). One undoable step.',
    inputSchema: {
      type: 'object',
      properties: {
        shape: { type: 'string', enum: ['rect', 'ellipse', 'all', 'none', 'invert'], description: 'What to select.' },
        x: { type: 'number', description: 'rect / ellipse: left edge in natural image pixels.' },
        y: { type: 'number', description: 'rect / ellipse: top edge in natural image pixels.' },
        width: { type: 'number', description: 'rect / ellipse: width in natural image pixels.' },
        height: { type: 'number', description: 'rect / ellipse: height in natural image pixels.' },
        mode: modeSchema,
        feather: { type: 'number', minimum: 0, description: 'Feather radius in pixels (default 0).' },
      },
      required: ['shape'],
      additionalProperties: false,
    },
    annotations: writeAnnotations('Select a region', true),
    handler: ({ shape, x, y, width, height, mode, feather }) => {
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
        default:
          throw new Error(`Unknown shape "${String(shape)}". Use rect, ellipse, all, none or invert.`);
      }
      return summary(controller);
    },
  };

  const selectByColor: AgentTool = {
    name: 'select_by_color',
    title: 'Select by colour',
    description:
      'Magic wand at (x, y) with tolerance (0-255) and contiguous, or with "color" ("#rrggbb") every pixel of a similar colour (Color Range, fuzziness 0-200). One undoable step.',
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
        mode: modeSchema,
      },
      additionalProperties: false,
    },
    annotations: writeAnnotations('Select by colour', true),
    handler: async ({ x, y, color, tolerance, contiguous, fuzziness, sampleMerged, mode }) => {
      const common = { mode: parseSelectionMode(mode), sampleMerged: sampleMerged === true };
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
    description: 'Select › Modify: grow, shrink, feather, border or smooth the selection by radius pixels. One undoable step.',
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

  return [getSelection, selectRegion, selectByColor, modify, refine, applyMask];
}
