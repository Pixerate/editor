import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController } from './controller';
import { BLEND_MODES, type BlendMode } from './blend';
import { MAX_BRUSH_SIZE, MIXING_MODELS, PAINT_SOURCE_JSON_SCHEMA, type BrushSettings, type MixerLoad, type MixerSettings, type PaintSource, type StrokePoint } from '../paint';
import type { LayerTarget } from './layers/model';
import { rgbUnitToHex } from './layers/paint-ui';
import { LayerOperationError } from './layers/ops';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const TARGET = {
  layerId: { type: 'string', description: 'Layer to paint (default the active layer; see list_layers).' },
  channel: {
    type: 'string',
    enum: ['pixels', 'mask', 'filter-mask', 'quick-mask'],
    description: "pixels (default for a pixel layer), the layer's mask, or a smart object's smart filter mask (filter-mask): black hides, white reveals. In Quick Mask mode (set_quick_mask), quick-mask (the default when no layerId is given) paints the selection: white selects, black deselects.",
  },
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
    blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'How paint combines with the layer (default normal). pigment mixes it in like real paint (blue into yellow gives green) instead of laying it over.' },
  },
  additionalProperties: false,
} as const;

const MIXER = {
  type: 'object',
  description:
    'Mixer Brush settings (tool mixer only); missing fields use the current mixer options (wet 0.5, load 0.5, mix 0.5, loadEachStroke true, cleanEachStroke true, mixing rgb).',
  properties: {
    wet: { type: 'number', minimum: 0, maximum: 1, description: 'How much canvas colour each dab picks up, 0 (dry: paints only the reservoir) .. 1 (default 0.5).' },
    load: { type: 'number', minimum: 0, maximum: 1, description: 'How much paint the reservoir holds, 0 .. 1 (default 0.5); below 1 it drains per dab, so long strokes run dry.' },
    mix: { type: 'number', minimum: 0, maximum: 1, description: "How far each dab's paint moves from the reservoir towards the picked-up colour, 0 .. 1 (default 0.5)." },
    loadEachStroke: { type: 'boolean', description: 'Refill the reservoir with `color` (or the foreground) before the stroke (default true). Off, the brush keeps what is left of its last load.' },
    cleanEachStroke: { type: 'boolean', description: 'Empty the pickup well after the stroke (default true). Off, the next stroke starts with the colour this one picked up.' },
    mixing: { type: 'string', enum: [...MIXING_MODELS], description: 'rgb (default): RGB averages. pigment: mixes like paint (Kubelka-Munk), so blue dragged through yellow makes green.' },
  },
  additionalProperties: false,
} as const;

/** A Mixer Brush load as tool output: hex colours and the amount left. */
export function mixerLoadResult(load: MixerLoad): { reservoir: string | null; amount: number; pickup: string | null } {
  return {
    reservoir: load.reservoir ? rgbUnitToHex(load.reservoir) : null,
    amount: Math.round(load.amount * 1000) / 1000,
    pickup: load.pickup ? rgbUnitToHex(load.pickup) : null,
  };
}

function readTarget(args: Record<string, unknown>): { layerId?: string; channel?: LayerTarget } {
  return { layerId: args.layerId as string | undefined, channel: args.channel as LayerTarget | undefined };
}

/**
 * Agent tools for painting: `paint_stroke` (brush, Mixer Brush or eraser along points, on pixels
 * or a mask), `fill_pixels` and `clear_pixels` (Edit › Fill / Clear inside the selection), each
 * one undo step returning the layer, channel and changed bounds; and the Mixer Brush's load:
 * `get_mixer_brush`, `load_mixer_brush` and `clean_mixer_brush` (view state, no undo).
 */
export function createImagePaintTools(controller: ImageEditorController): AgentTool[] {
  const paintStroke: AgentTool = {
    name: 'paint_stroke',
    title: 'Paint a brush stroke',
    description:
      'Paints one stroke with the brush, smears and blends paint with the Mixer Brush (tool mixer: its reservoir mixes with colour picked up from the layer under each dab, in RGB or pigment mixing), or removes pixels with the eraser, through points in document pixels (optional pressure 0..1 each) on a pixel layer or a layer mask (the mixer paints pixels only). The selection limits the paint; a transparency-locked layer keeps its alpha (the eraser then paints the background colour). One undo step. Returns the layerId, channel, changed bounds and dab count, and for the mixer its mixerLoad after the stroke ({reservoir, amount, pickup}).',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: ['brush', 'eraser', 'mixer'], description: 'brush (default), eraser, or mixer (the Mixer Brush: picks up and blends the layer colour under each dab).' },
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
        color: {
          type: 'string',
          description:
            'Paint colour #rrggbb (default the foreground). On a mask its grey value: #000000 hides, #ffffff reveals. For the mixer, the colour its reservoir is loaded with before the stroke (given, it loads even with loadEachStroke false).',
        },
        paint: {
          ...PAINT_SOURCE_JSON_SCHEMA,
          description:
            "Brush only: what this stroke paints with instead of the paint options' paint (set_paint): a colour, or gradient paint that changes colour as the stroke goes (by distance, pressure, velocity, direction, time, across the tip or at random). On a mask each colour's grey value.",
        },
        brush: BRUSH,
        mixer: MIXER,
        ...TARGET,
      },
      required: ['points'],
      additionalProperties: false,
    },
    annotations: { title: 'Paint a brush stroke', ...WRITE },
    handler: (args) => {
      const tool = args.tool as 'brush' | 'eraser' | 'mixer' | undefined;
      if (args.mixer !== undefined && tool !== 'mixer') throw new LayerOperationError('mixer settings apply to the Mixer Brush only; pass tool "mixer", or drop mixer.');
      if (args.paint !== undefined && (tool ?? 'brush') !== 'brush') throw new LayerOperationError('paint applies to the brush only (the eraser removes paint; the Mixer Brush loads color); drop paint or use tool "brush".');
      if (args.paint !== undefined && args.color !== undefined) throw new LayerOperationError('Give color or paint, not both.');
      const result = controller.paintStroke({
        tool,
        points: args.points as StrokePoint[],
        color: args.color as string | undefined,
        paint: args.paint as PaintSource | undefined,
        brush: args.brush as Partial<BrushSettings> | undefined,
        mixer: args.mixer as Partial<MixerSettings> | undefined,
        ...readTarget(args),
      });
      return result.mixerLoad ? { ...result, mixerLoad: mixerLoadResult(result.mixerLoad) } : result;
    },
  };

  const getMixer: AgentTool = {
    name: 'get_mixer_brush',
    title: 'Get the Mixer Brush',
    description:
      "Reads the Mixer Brush: its settings (wet, load, mix, loadEachStroke, cleanEachStroke, mixing) and what it carries now (reservoir #rrggbb or null, amount 0..1 left, pickup #rrggbb or null). Call it before a paint_stroke with tool mixer and loadEachStroke false, to know the brush's starting paint.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Get the Mixer Brush', ...READ },
    handler: () => {
      const { mixer, mixerLoad } = controller.getState().paint;
      return { settings: { ...mixer }, load: mixerLoadResult(mixerLoad) };
    },
  };

  const loadMixerTool: AgentTool = {
    name: 'load_mixer_brush',
    title: 'Load the Mixer Brush',
    description:
      'Fills the Mixer Brush reservoir with a colour (amount 1); the picked-up colour is kept. View state, not an undo step. Use it with loadEachStroke false to carry one load across several paint_stroke calls. Returns the load {reservoir, amount, pickup}.',
    inputSchema: {
      type: 'object',
      properties: { color: { type: 'string', description: 'Paint colour #rrggbb (default the foreground).' } },
      additionalProperties: false,
    },
    annotations: { title: 'Load the Mixer Brush', ...WRITE, idempotentHint: true },
    handler: (args) => mixerLoadResult(controller.loadMixerBrush(args.color as string | undefined)),
  };

  const cleanMixerTool: AgentTool = {
    name: 'clean_mixer_brush',
    title: 'Clean the Mixer Brush',
    description:
      'Cleans the Mixer Brush: empties the pickup well so the next stroke starts without canvas colour; with emptyReservoir also drops the loaded paint (the brush then only smears). View state, not an undo step. Returns the load {reservoir, amount, pickup}.',
    inputSchema: {
      type: 'object',
      properties: { emptyReservoir: { type: 'boolean', description: 'Also drop the reservoir (default false).' } },
      additionalProperties: false,
    },
    annotations: { title: 'Clean the Mixer Brush', ...WRITE, idempotentHint: true },
    handler: (args) => mixerLoadResult(args.emptyReservoir === true ? controller.emptyMixerBrush() : controller.cleanMixerBrush()),
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
        blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'Blend mode (default normal). pigment mixes the colour into the pixels like paint, opacity being the share of new paint.' },
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

  const paintView = () => {
    const p = controller.getState().paint;
    return { paint: p.paint, foreground: p.foreground, background: p.background, brush: p.brush };
  };
  const setPaint: AgentTool = {
    name: 'set_paint',
    title: 'Set the paint (colour or gradient)',
    description:
      'Sets what the brush paints: one colour (it becomes the foreground), or gradient paint that changes colour as the stroke goes. Gradient paint: 2..16 stops sorted by offset (#rrggbb, or "paint" / "secondary" for the foreground and background colours), space pigment (default: mixes like paint) / oklab / srgb, and map: distance (default: the colour changes as the stroke is dragged out, 300 px then mirrored back), pressure, tilt, velocity, direction, time, across-tip or random. paint_stroke with tool brush samples it per dab (on a mask, each colour\'s grey); the eraser and the Mixer Brush ignore it, and Fill uses the foreground. View state, not an undo step. Returns paint, foreground, background and brush.',
    inputSchema: { type: 'object', properties: { paint: PAINT_SOURCE_JSON_SCHEMA }, required: ['paint'], additionalProperties: false },
    annotations: { title: 'Set the paint (colour or gradient)', ...SET },
    handler: ({ paint }) => {
      controller.setPaintOptions({ paint: paint as PaintSource });
      return paintView();
    },
  };
  const getPaint: AgentTool = {
    name: 'get_paint',
    title: 'Get the paint',
    description: 'Reads what the brush paints (paint: the foreground colour or gradient paint), the foreground and background colours and the brush settings (size, hardness, spacing, opacity, flow …). Changes nothing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Get the paint', ...READ },
    handler: () => paintView(),
  };
  return [paintStroke, fill, clear, getMixer, loadMixerTool, cleanMixerTool, setPaint, getPaint];
}
