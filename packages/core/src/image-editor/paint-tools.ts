import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController } from './controller';
import { BLEND_MODES, type BlendMode } from './blend';
import { MAX_BRUSH_SIZE, type BrushSettings, type StrokePoint } from '../paint';
import type { LayerTarget } from './layers/model';

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const TARGET = {
  layerId: { type: 'string', description: 'Layer to paint (default the active layer; see list_layers).' },
  channel: { type: 'string', enum: ['pixels', 'mask'], description: "pixels (default for a pixel layer) or the layer's mask: black hides, white reveals." },
} as const;

const BRUSH = {
  type: 'object',
  description: 'Brush settings; missing fields use the current paint options (default round, hard, 20 px).',
  properties: {
    size: { type: 'number', minimum: 1, maximum: MAX_BRUSH_SIZE, description: 'Diameter in px (default 20).' },
    hardness: { type: 'number', minimum: 0, maximum: 1, description: 'Edge hardness 0 (soft) .. 1 (hard, default).' },
    spacing: { type: 'number', minimum: 0.01, maximum: 10, description: 'Dab spacing as a fraction of the diameter (default 0.1).' },
    angle: { type: 'number', minimum: -360, maximum: 360, description: 'Tip angle in degrees (default 0).' },
    roundness: { type: 'number', minimum: 0.01, maximum: 1, description: 'Tip roundness (default 1).' },
    opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Stroke opacity: overlapping dabs never exceed it (default 1).' },
    flow: { type: 'number', minimum: 0, maximum: 1, description: 'Build-up per dab towards the opacity (default 1).' },
    smoothing: { type: 'number', minimum: 0, maximum: 0.95, description: 'Point smoothing 0..0.95 (default 0).' },
    pressureSize: { type: 'boolean', description: 'Point pressure scales the size (default true).' },
    pressureOpacity: { type: 'boolean', description: 'Point pressure scales the opacity (default false).' },
    blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'How paint combines with the layer (default normal).' },
  },
  additionalProperties: false,
} as const;

function readTarget(args: Record<string, unknown>): { layerId?: string; channel?: LayerTarget } {
  return { layerId: args.layerId as string | undefined, channel: args.channel as LayerTarget | undefined };
}

/**
 * Agent tools for painting: `paint_stroke` (brush or eraser along points, on pixels or a mask),
 * `fill_pixels` and `clear_pixels` (Edit › Fill / Clear inside the selection). Each is one undo
 * step and returns the layer, channel and changed bounds.
 */
export function createImagePaintTools(controller: ImageEditorController): AgentTool[] {
  const paintStroke: AgentTool = {
    name: 'paint_stroke',
    title: 'Paint a brush stroke',
    description:
      'Paints one stroke with the brush (or removes pixels with the eraser) through points in document pixels (optional pressure 0..1 each) on a pixel layer or a layer mask. The selection limits the paint; a transparency-locked layer keeps its alpha (the eraser then paints the background colour). One undo step. Returns the layerId, channel, changed bounds and dab count.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: ['brush', 'eraser'], description: 'brush (default) or eraser.' },
        points: {
          type: 'array',
          minItems: 1,
          maxItems: 10000,
          description: 'The path in document pixels; one point paints one dab.',
          items: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'Document x in px.' },
              y: { type: 'number', description: 'Document y in px.' },
              pressure: { type: 'number', minimum: 0, maximum: 1, description: 'Pen pressure (default 1).' },
            },
            required: ['x', 'y'],
            additionalProperties: false,
          },
        },
        color: { type: 'string', description: 'Paint colour #rrggbb (default the foreground). On a mask its grey value: #000000 hides, #ffffff reveals.' },
        brush: BRUSH,
        ...TARGET,
      },
      required: ['points'],
      additionalProperties: false,
    },
    annotations: { title: 'Paint a brush stroke', ...WRITE },
    handler: (args) =>
      controller.paintStroke({
        tool: args.tool as 'brush' | 'eraser' | undefined,
        points: args.points as StrokePoint[],
        color: args.color as string | undefined,
        brush: args.brush as Partial<BrushSettings> | undefined,
        ...readTarget(args),
      }),
  };

  const fill: AgentTool = {
    name: 'fill_pixels',
    title: 'Fill pixels',
    description:
      'Edit › Fill: fills the selection (or the whole canvas without one, or with useSelection false) on a pixel layer or a mask with a colour (default the foreground) at opacity, with a blend mode. One undo step. Returns the layerId, channel and changed bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        color: { type: 'string', description: 'Fill colour #rrggbb or #rrggbbaa (default the foreground).' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Fill opacity 0..1 (default 1).' },
        blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'Blend mode (default normal).' },
        useSelection: { type: 'boolean', description: 'Limit to the selection when there is one (default true).' },
        ...TARGET,
      },
      additionalProperties: false,
    },
    annotations: { title: 'Fill pixels', ...WRITE },
    handler: (args) =>
      controller.fillPixels({
        color: args.color as string | undefined,
        opacity: args.opacity as number | undefined,
        blend: args.blend as BlendMode | undefined,
        useSelection: args.useSelection as boolean | undefined,
        ...readTarget(args),
      }),
  };

  const clear: AgentTool = {
    name: 'clear_pixels',
    title: 'Clear pixels',
    description:
      'Edit › Clear: removes the selected pixels of a pixel layer (or, without a selection or with useSelection false, all of them); on a transparency-locked layer or a mask it fills with the background colour instead. One undo step. Returns the layerId, channel and changed bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'How much to clear 0..1 (default 1).' },
        useSelection: { type: 'boolean', description: 'Limit to the selection when there is one (default true).' },
        ...TARGET,
      },
      additionalProperties: false,
    },
    annotations: { title: 'Clear pixels', ...DESTRUCTIVE },
    handler: (args) =>
      controller.clearPixels({ opacity: args.opacity as number | undefined, useSelection: args.useSelection as boolean | undefined, ...readTarget(args) }),
  };

  return [paintStroke, fill, clear];
}
