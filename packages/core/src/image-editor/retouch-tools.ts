import type { AgentTool } from '../tools/registry.js';
import type { ImageEditorController, RetouchTool } from './controller';
import { MAX_BRUSH_SIZE, RETOUCH_SAMPLES, SPOT_HEAL_TYPES, TONE_RANGES, type BrushSettings, type RetouchSettings, type StrokePoint } from '../paint';
import type { LayerTarget } from './layers/model';
import { LayerOperationError } from './layers/ops';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const POINTS = {
  type: 'array',
  minItems: 1,
  maxItems: 10000,
  description: 'The stroke path in document pixels; one point is one dab.',
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
} as const;

const BRUSH = {
  type: 'object',
  description: 'Brush tip; missing fields use the current paint options (default round, hard, 20 px).',
  properties: {
    size: { type: 'number', minimum: 1, maximum: MAX_BRUSH_SIZE, description: 'Diameter in px (default 20).' },
    hardness: { type: 'number', minimum: 0, maximum: 1, description: 'Edge hardness 0 (soft) .. 1 (hard, default). Retouching usually wants a soft tip (0..0.5).' },
    spacing: { type: 'number', minimum: 0.01, maximum: 10, description: 'Dab spacing as a fraction of the diameter (default 0.1).' },
    opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Stroke opacity (Clone Stamp and Healing Brush only; default 1).' },
    flow: { type: 'number', minimum: 0, maximum: 1, description: 'Build-up per dab (default 1). For the Sponge, how strongly each pass moves saturation.' },
    smoothing: { type: 'number', minimum: 0, maximum: 0.95, description: 'Point smoothing 0..0.95 (default 0).' },
    pressureSize: { type: 'boolean', description: 'Point pressure scales the size (default true).' },
    pressureOpacity: { type: 'boolean', description: 'Point pressure scales the opacity (default false).' },
  },
  additionalProperties: false,
} as const;

const TARGET = {
  layerId: { type: 'string', description: 'Layer to retouch (default the active layer; see list_layers).' },
  channel: {
    type: 'string',
    enum: ['pixels', 'mask', 'filter-mask'],
    description: "pixels (default for a pixel layer), the layer's mask, or a smart object's filter mask. Masks are grey values and sample only themselves.",
  },
} as const;

const SAMPLE = {
  type: 'string',
  enum: [...RETOUCH_SAMPLES],
  description:
    'What is sampled: current (default: the target layer), current-below (the composite of this layer and everything under it), or all (the composite of every layer). Sample current-below or all to retouch onto an empty layer above the image.',
} as const;

function readTarget(args: Record<string, unknown>): { layerId?: string; channel?: LayerTarget } {
  return { layerId: args.layerId as string | undefined, channel: args.channel as LayerTarget | undefined };
}

function checkSource(controller: ImageEditorController, source: unknown): { x: number; y: number } | undefined {
  if (source === undefined) return undefined;
  const p = source as { x: number; y: number };
  const { width, height } = controller.getState().imageDimensions;
  if (!(p.x >= 0 && p.y >= 0 && p.x < width && p.y < height)) {
    throw new LayerOperationError(`source (${p.x}, ${p.y}) is outside the ${width} × ${height} canvas; pick a point on the image to sample.`);
  }
  return p;
}

const SOURCE = {
  type: 'object',
  description: 'Source point in document pixels (an Alt-click). Given, it replaces the clone source and the offset starts afresh at this stroke; missing, the current clone source is used (set_clone_source).',
  properties: { x: { type: 'number', description: 'Source x in px.' }, y: { type: 'number', description: 'Source y in px.' } },
  required: ['x', 'y'],
  additionalProperties: false,
} as const;

/**
 * Agent tools for the retouching tools, one per tool: `clone_stamp`, `heal_brush`, `spot_heal`,
 * `smudge`, `dodge`, `burn` and `sponge` (each one stroke, one undo step, returning the layer,
 * channel, changed bounds and dab count), plus the view state they share: `get_retouch_options`,
 * `set_retouch_options` and `set_clone_source`.
 */
export function createImageRetouchTools(controller: ImageEditorController): AgentTool[] {
  const stroke = (tool: RetouchTool, args: Record<string, unknown>, retouch: Partial<RetouchSettings>) =>
    controller.paintStroke({
      tool,
      points: args.points as StrokePoint[],
      brush: args.brush as Partial<BrushSettings> | undefined,
      retouch,
      source: checkSource(controller, args.source),
      ...readTarget(args),
    });

  const cloneStamp: AgentTool = {
    name: 'clone_stamp',
    title: 'Clone Stamp stroke',
    description:
      "Copies pixels from the clone source along a stroke (Photoshop's Clone Stamp): each point paints what lies at point + offset, where the offset is source − the stroke's first point. With aligned on, later strokes keep that offset; off, every stroke starts again at the source point. Samples the layer, the layers up to it, or all layers, from before the stroke. The selection limits it; a transparency-locked layer keeps its alpha. One undo step. Returns the layerId, channel, changed bounds, dab count and clone {offset, source, aligned}.",
    inputSchema: {
      type: 'object',
      properties: {
        points: POINTS,
        source: SOURCE,
        aligned: { type: 'boolean', description: 'Keep the offset for the next strokes (default the current option, true).' },
        sample: SAMPLE,
        brush: BRUSH,
        ...TARGET,
      },
      required: ['points'],
      additionalProperties: false,
    },
    annotations: { title: 'Clone Stamp stroke', ...WRITE },
    handler: (args) => stroke('clone', args, pick(args, ['aligned', 'sample'])),
  };

  const healBrush: AgentTool = {
    name: 'heal_brush',
    title: 'Healing Brush stroke',
    description:
      "Heals along a stroke from the clone source (Photoshop's Healing Brush): the source's texture is cloned, then blended so its colour and light match the pixels around the stroke (Poisson seamless cloning, applied when the stroke ends). Use it for blemishes and dust where the area around them is the right tone; use clone_stamp to copy exactly. Same source, offset and aligned rules as clone_stamp. One undo step. Returns the layerId, channel, changed bounds, dab count and clone {offset, source, aligned}.",
    inputSchema: {
      type: 'object',
      properties: {
        points: POINTS,
        source: SOURCE,
        aligned: { type: 'boolean', description: 'Keep the offset for the next strokes (default the current option, true).' },
        sample: SAMPLE,
        brush: BRUSH,
        ...TARGET,
      },
      required: ['points'],
      additionalProperties: false,
    },
    annotations: { title: 'Healing Brush stroke', ...WRITE },
    handler: (args) => stroke('heal', args, pick(args, ['aligned', 'sample'])),
  };

  const spotHeal: AgentTool = {
    name: 'spot_heal',
    title: 'Spot Healing stroke',
    description:
      "Removes what a stroke covers without a source point (Photoshop's Spot Healing Brush): proximity-match copies the best matching patch nearby and blends it in; smooth fills from the edges inwards (for spots on smooth areas). Paint just over the spot with a brush a little larger than it. One undo step. Returns the layerId, channel, changed bounds, dab count and spotHeal {offset} (the patch offset copied, or null for a smooth fill).",
    inputSchema: {
      type: 'object',
      properties: {
        points: POINTS,
        type: { type: 'string', enum: [...SPOT_HEAL_TYPES], description: 'proximity-match (default) or smooth.' },
        sample: SAMPLE,
        brush: BRUSH,
        ...TARGET,
      },
      required: ['points'],
      additionalProperties: false,
    },
    annotations: { title: 'Spot Healing stroke', ...WRITE },
    handler: (args) => stroke('spot-heal', args, { ...pick(args, ['sample']), ...(args.type !== undefined ? { spotType: args.type as RetouchSettings['spotType'] } : {}) }),
  };

  const smudge: AgentTool = {
    name: 'smudge',
    title: 'Smudge stroke',
    description:
      "Drags pixels along a stroke like a finger through wet paint (Photoshop's Smudge): each dab lays what the finger carries and picks up what was under it, so colour is pulled in the stroke's direction and fades with distance. One undo step. Returns the layerId, channel, changed bounds and dab count.",
    inputSchema: {
      type: 'object',
      properties: {
        points: POINTS,
        strength: { type: 'number', minimum: 0, maximum: 1, description: 'How far colour is dragged, 0..1 (default the current option, 0.5).' },
        brush: BRUSH,
        ...TARGET,
      },
      required: ['points'],
      additionalProperties: false,
    },
    annotations: { title: 'Smudge stroke', ...WRITE },
    handler: (args) => stroke('smudge', args, pick(args, ['strength'])),
  };

  const toneSchema = (verb: string) => ({
    type: 'object' as const,
    properties: {
      points: POINTS,
      range: { type: 'string', enum: [...TONE_RANGES], description: `Which tones to ${verb} most: shadows, midtones (default the current option, midtones) or highlights.` },
      exposure: { type: 'number', minimum: 0, maximum: 1, description: 'Strength 0..1 (default the current option, 0.5). Overlapping dabs in one stroke never go past it; another stroke builds on it.' },
      protectTones: { type: 'boolean', description: 'Change luma only, keeping hue and saturation (default true).' },
      brush: BRUSH,
      ...TARGET,
    },
    required: ['points'],
    additionalProperties: false,
  }) as const;

  const dodge: AgentTool = {
    name: 'dodge',
    title: 'Dodge stroke',
    description:
      "Lightens the pixels a stroke covers (Photoshop's Dodge), most in the chosen tonal range. Alpha is kept. One undo step. Returns the layerId, channel, changed bounds and dab count. Inspect the result with capture_view or get_histogram; several light strokes look more natural than one strong one.",
    inputSchema: toneSchema('lighten'),
    annotations: { title: 'Dodge stroke', ...WRITE },
    handler: (args) => stroke('dodge', args, pick(args, ['range', 'exposure', 'protectTones'])),
  };

  const burn: AgentTool = {
    name: 'burn',
    title: 'Burn stroke',
    description:
      "Darkens the pixels a stroke covers (Photoshop's Burn), most in the chosen tonal range. Alpha is kept. One undo step. Returns the layerId, channel, changed bounds and dab count.",
    inputSchema: toneSchema('darken'),
    annotations: { title: 'Burn stroke', ...WRITE },
    handler: (args) => stroke('burn', args, pick(args, ['range', 'exposure', 'protectTones'])),
  };

  const spongeTool: AgentTool = {
    name: 'sponge',
    title: 'Sponge stroke',
    description:
      "Saturates or desaturates the pixels a stroke covers (Photoshop's Sponge); passes compound, and brush.flow sets how much each moves. Pixels only (a mask has no colour). One undo step. Returns the layerId, channel, changed bounds and dab count.",
    inputSchema: {
      type: 'object',
      properties: {
        points: POINTS,
        mode: { type: 'string', enum: ['desaturate', 'saturate'], description: 'desaturate (default the current option, desaturate) or saturate.' },
        vibrance: { type: 'boolean', description: 'Damp the change where colours would clip or collapse to grey (default true).' },
        brush: BRUSH,
        layerId: TARGET.layerId,
      },
      required: ['points'],
      additionalProperties: false,
    },
    annotations: { title: 'Sponge stroke', ...WRITE },
    handler: (args) =>
      stroke('sponge', { ...args, channel: 'pixels' }, { ...pick(args, ['vibrance']), ...(args.mode !== undefined ? { spongeMode: args.mode as RetouchSettings['spongeMode'] } : {}) }),
  };

  const filterSchema = (verb: string) => ({
    type: 'object' as const,
    properties: {
      points: POINTS,
      strength: { type: 'number', minimum: 0, maximum: 1, description: `How strongly to ${verb}, 0..1 (default the current option, 0.5); multiplies the brush opacity.` },
      brush: BRUSH,
      ...TARGET,
    },
    required: ['points'],
    additionalProperties: false,
  }) as const;

  const blurTool: AgentTool = {
    name: 'blur_stroke',
    title: 'Blur stroke',
    description:
      "Softens the pixels a stroke covers (Photoshop's Blur tool): a soft blur of the layer laid through the brush at `strength`. Overlapping dabs in one stroke do not compound; another stroke blurs further. Works on pixels and masks, at any bit depth. One undo step. Returns the layerId, channel, changed bounds and dab count.",
    inputSchema: filterSchema('blur'),
    annotations: { title: 'Blur stroke', ...WRITE },
    handler: (args) => stroke('blur', args, pick(args, ['strength'])),
  };

  const sharpenTool: AgentTool = {
    name: 'sharpen_stroke',
    title: 'Sharpen stroke',
    description:
      "Crisps the pixels a stroke covers (Photoshop's Sharpen tool): an unsharp mask of the layer laid through the brush at `strength`. Keep strength low (0.2..0.5) and inspect with capture_view; strong sharpening shows halos and noise. One undo step. Returns the layerId, channel, changed bounds and dab count.",
    inputSchema: filterSchema('sharpen'),
    annotations: { title: 'Sharpen stroke', ...WRITE },
    handler: (args) => stroke('sharpen', args, pick(args, ['strength'])),
  };

  const historyBrush: AgentTool = {
    name: 'history_brush',
    title: 'History Brush stroke',
    description:
      "Paints the layer back as it was earlier (Photoshop's History Brush): the same layer's pixels (or mask) from `historySteps` undo steps back, or from the oldest state history keeps (0, the default, usually the document as opened), laid through the brush. Use it to undo part of a filter, paint or retouch in one area. Fails if the layer did not exist then or there is no history yet. One undo step. Returns the layerId, channel, changed bounds and dab count.",
    inputSchema: {
      type: 'object',
      properties: {
        points: POINTS,
        historySteps: { type: 'integer', minimum: 0, maximum: 1000, description: 'Undo steps back to paint from; 0 (default the current option) is the oldest state history keeps.' },
        brush: BRUSH,
        ...TARGET,
      },
      required: ['points'],
      additionalProperties: false,
    },
    annotations: { title: 'History Brush stroke', ...WRITE },
    handler: (args) => stroke('history', args, pick(args, ['historySteps'])),
  };

  const getOptions: AgentTool = {
    name: 'get_retouch_options',
    title: 'Get retouch options',
    description:
      'Reads the retouching tools\' options (aligned, sample, spotType, range, exposure, protectTones, spongeMode, vibrance, strength, historySteps) and the clone source ({x, y, offset} or null; offset is the aligned offset the last clone or heal stroke fixed: an aligned stroke samples at the brush plus offset, which the editors show as a crosshair). Call it before clone_stamp or heal_brush without a source to see where they will sample.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Get retouch options', ...READ },
    handler: () => {
      const { retouch, cloneSource } = controller.getState().paint;
      return { options: { ...retouch }, cloneSource: cloneSource ? { ...cloneSource } : null };
    },
  };

  const setOptions: AgentTool = {
    name: 'set_retouch_options',
    title: 'Set retouch options',
    description:
      'Sets the retouching tools\' defaults (view state, not an undo step); each stroke tool can also override them per call. Changing aligned clears the aligned offset. Returns the options after the change.',
    inputSchema: {
      type: 'object',
      properties: {
        aligned: { type: 'boolean', description: 'Clone / heal: keep the offset from stroke to stroke (default true).' },
        sample: SAMPLE,
        spotType: { type: 'string', enum: [...SPOT_HEAL_TYPES], description: 'Spot heal: proximity-match (default) or smooth.' },
        range: { type: 'string', enum: [...TONE_RANGES], description: 'Dodge / burn: shadows, midtones (default) or highlights.' },
        exposure: { type: 'number', minimum: 0, maximum: 1, description: 'Dodge / burn strength 0..1 (default 0.5).' },
        protectTones: { type: 'boolean', description: 'Dodge / burn: keep hue and saturation (default true).' },
        spongeMode: { type: 'string', enum: ['desaturate', 'saturate'], description: 'Sponge: desaturate (default) or saturate.' },
        vibrance: { type: 'boolean', description: 'Sponge: damp clipping (default true).' },
        strength: { type: 'number', minimum: 0, maximum: 1, description: 'Smudge, blur and sharpen strength 0..1 (default 0.5).' },
        historySteps: { type: 'integer', minimum: 0, maximum: 1000, description: 'History Brush: undo steps back it paints from; 0 is the oldest state (default 0).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Set retouch options', ...WRITE, idempotentHint: true },
    handler: (args) => ({ ...controller.setPaintOptions({ retouch: args as Partial<RetouchSettings> }).retouch }),
  };

  const setSource: AgentTool = {
    name: 'set_clone_source',
    title: 'Set the clone source',
    description:
      "Sets the Clone Stamp and Healing Brush source point (Photoshop's Alt-click), in document pixels, or clears it with clear true. The next clone_stamp or heal_brush stroke fixes the offset from its first point. View state, not an undo step. Returns the clone source {x, y, offset} (or null).",
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Source x in px (required unless clear).' },
        y: { type: 'number', description: 'Source y in px (required unless clear).' },
        clear: { type: 'boolean', description: 'Remove the source point instead (default false).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Set the clone source', ...WRITE, idempotentHint: true },
    handler: (args) => {
      if (args.clear === true) {
        if (args.x !== undefined || args.y !== undefined) throw new LayerOperationError('Give either clear true or x and y, not both.');
        return controller.setCloneSource(null);
      }
      if (typeof args.x !== 'number' || typeof args.y !== 'number') throw new LayerOperationError('Pass x and y (document pixels) for the source point, or clear true to remove it.');
      return controller.setCloneSource(checkSource(controller, { x: args.x, y: args.y })!);
    },
  };

  return [cloneStamp, healBrush, spotHeal, smudge, dodge, burn, spongeTool, blurTool, sharpenTool, historyBrush, getOptions, setOptions, setSource];
}

function pick(args: Record<string, unknown>, keys: string[]): Partial<RetouchSettings> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out as Partial<RetouchSettings>;
}
