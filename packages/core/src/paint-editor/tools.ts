/**
 * Agent tools for the paint editor (`createPaintEditorToolProvider`). Strict schemas, every
 * argument described, all four annotations. Each write is one undo step (or editor state, said so)
 * and returns what it changed; ids come from the read tools (`list_layers`, `list_brushes`,
 * `list_papers`, `list_strokes`).
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import { createPigmentTools } from '../paint/pigment-tools';
import { MIXING_MODELS, type MixerLoad } from '../paint/mixer';
import { BLEND_MODES, standardBlendMode, type BlendMode } from '../raster/blend';
import { bytesToBase64, encodePng } from '../raster/png';
import { BRUSH_ROTATIONS, MAX_BRUSH_SIZE, MULTI_COLOR_MODES, PAINT_BRUSH_CATEGORIES, PAINT_BRUSH_ENGINES, brushToJSON, isWetCapable, type PaintBrush } from './brushes';
import { MAX_CANVAS_SIDE } from './document';
import type { PaintEditorController } from './controller';
import type { PenPoint } from './engine';
import { GRAIN_PATTERNS, PAPER_FAMILIES, PAPER_LIBRARY } from './paper';
import { MAX_ZOOM, MIN_ZOOM } from './view';
import { createPaintGuideTools } from './guide-tools';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const EMPTY = { type: 'object', properties: {}, additionalProperties: false } as const;
const COLOR = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Colour #rrggbb, e.g. "#2a4b8d".' } as const;
const LAYER_ID = { type: 'string', description: 'Layer id from list_layers (default the active layer).' } as const;

export interface PaintEditorToolProviderOptions {
  /** Provider id (unique per registry). Default `paint-editor`. */
  id?: string;
  /** Always prefix tool names with `<namespace>__`. */
  namespace?: string;
}

const TIP = {
  type: 'object',
  description: 'The tip (the shared brush engine). Missing fields keep their current values.',
  properties: {
    size: { type: 'number', minimum: 1, maximum: MAX_BRUSH_SIZE, description: 'Diameter in document pixels.' },
    hardness: { type: 'number', minimum: 0, maximum: 1, description: 'Edge hardness, 0 (soft) .. 1 (hard).' },
    spacing: { type: 'number', minimum: 0.01, maximum: 10, description: 'Dab spacing as a fraction of the diameter (0.05 is smooth, 1 is dotted).' },
    angle: { type: 'number', minimum: -360, maximum: 360, description: 'Tip angle in degrees, counter-clockwise; with rotation stroke or barrel it is added to the stroke direction or pen rotation.' },
    roundness: { type: 'number', minimum: 0.01, maximum: 1, description: 'Tip roundness: 1 round, lower is a flat ellipse (a pastel or chisel tip).' },
    opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Stroke opacity ceiling: overlapping dabs never exceed it.' },
    flow: { type: 'number', minimum: 0, maximum: 1, description: 'Build-up per dab towards the opacity (low flow builds up softly, like an airbrush).' },
    smoothing: { type: 'number', minimum: 0, maximum: 0.95, description: 'Position smoothing of the input, 0..0.95.' },
    pressureSize: { type: 'boolean', description: 'Pressure scales the size (down to dynamics.minSize).' },
    pressureOpacity: { type: 'boolean', description: 'Pressure scales the opacity.' },
    blend: {
      type: 'string',
      enum: BLEND_MODES.map((m) => m.id),
      description: 'How paint combines with the layer. pigment mixes it in like real paint (blue into yellow gives green); multiply darkens like marker ink; watercolor glazes like a transparent wash; tint, highlight and shadow recolour, light and shade (see list_blend_modes).',
    },
  },
  additionalProperties: false,
} as const;

const DYNAMICS = {
  type: 'object',
  description: 'Pen dynamics and jitter. Missing fields keep their current values.',
  properties: {
    minSize: { type: 'number', minimum: 0, maximum: 1, description: 'Size at zero pressure as a fraction of the full size (when pressureSize).' },
    pressureFlow: { type: 'number', minimum: 0, maximum: 1, description: 'How much pressure scales flow.' },
    tiltSize: { type: 'number', minimum: 0, maximum: 1, description: 'Laying the pen down widens the tip (up to 2.5×).' },
    tiltRoundness: { type: 'number', minimum: 0, maximum: 1, description: 'Laying the pen down flattens the tip along the tilt (side-of-the-pencil shading).' },
    tiltOpacity: { type: 'number', minimum: 0, maximum: 1, description: 'Laying the pen down lightens the mark.' },
    velocitySize: { type: 'number', minimum: -1, maximum: 1, description: 'Positive grows the tip on fast strokes, negative thins it (needs point times t).' },
    velocityOpacity: { type: 'number', minimum: -1, maximum: 1, description: 'Positive darkens fast marks, negative lightens them (needs point times t).' },
    sizeJitter: { type: 'number', minimum: 0, maximum: 1, description: 'Random size change per dab.' },
    angleJitter: { type: 'number', minimum: 0, maximum: 1, description: 'Random angle per dab, as a fraction of ±180°.' },
    opacityJitter: { type: 'number', minimum: 0, maximum: 1, description: 'Random opacity drop per dab.' },
    scatter: { type: 'number', minimum: 0, maximum: 4, description: 'Random offset across the stroke, in diameters.' },
  },
  additionalProperties: false,
} as const;

const MIXER = {
  type: 'object',
  description: 'Mixer engine settings (the Mixer Brush). Missing fields keep their current values.',
  properties: {
    wet: { type: 'number', minimum: 0, maximum: 1, description: 'Pick-up ratio: how much canvas colour each dab picks up, 0 (dry) .. 1.' },
    load: { type: 'number', minimum: 0, maximum: 1, description: 'How much paint the reservoir holds; below 1 it drains per dab, so long strokes run dry.' },
    mix: { type: 'number', minimum: 0, maximum: 1, description: "Mix ratio: how far each dab's paint moves from the reservoir towards the picked-up colour." },
    loadEachStroke: { type: 'boolean', description: 'Refill the reservoir with the colour before each stroke.' },
    cleanEachStroke: { type: 'boolean', description: 'Empty the pickup well after each stroke.' },
    mixing: { type: 'string', enum: [...MIXING_MODELS], description: 'rgb: RGB averages. pigment: mixes like paint (Kubelka-Munk).' },
  },
  additionalProperties: false,
} as const;

const MIXING = { type: 'string', enum: [...MIXING_MODELS], description: 'pigment: mixes like paint (Kubelka-Munk, blue and yellow make green); rgb: straight RGB averages.' } as const;

const BEHAVIOR = {
  type: 'object',
  description:
    'How the brush handles paint on the canvas (dab and mixer engines; on a mixer brush pickup, mix, dirty and mixing are its mixer wet, mix, !cleanEachStroke and mixing). Missing fields keep their current values.',
  properties: {
    pickup: { type: 'number', minimum: 0, maximum: 1, description: 'Pick-up ratio 0..1: how much of the paint under each dab the brush lifts and carries along (0: none, a dry brush).' },
    mix: { type: 'number', minimum: 0, maximum: 1, description: "Mix ratio 0..1: how much of the carried paint goes into what the brush lays down, against the brush's own colour (scaled by pickup)." },
    dirty: { type: 'boolean', description: 'Dirty brush: keep the carried paint after the stroke, so the next stroke starts with the last colour it touched (needs pickup above 0). clean_mixer_brush wipes it.' },
    mixing: MIXING,
    multicolor: {
      type: 'object',
      description: 'Multi-coloured brush. Missing fields keep their current values.',
      properties: {
        mode: { type: 'string', enum: [...MULTI_COLOR_MODES], description: 'off; tip: the colours lie side by side across the tip (stripes along the stroke, like a brush loaded with several paints); dab: the colour changes along the stroke.' },
        colors: { type: 'array', maxItems: 8, items: { ...COLOR }, description: '2..8 colours #rrggbb; fewer than 2 uses the paint colour and the secondary colour.' },
        order: { type: 'string', enum: ['sequence', 'random'], description: 'dab mode: sequence runs through the colours in order, blending between them; random picks one per run of dabs (seeded).' },
        length: { type: 'integer', minimum: 1, maximum: 500, description: 'dab mode: dabs per colour (default 12).' },
        softness: { type: 'number', minimum: 0, maximum: 1, description: 'How softly neighbouring colours blend: 0 hard stripes or steps, 1 a smooth gradient.' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

const BLENDER = {
  type: 'object',
  description: 'Blender engine settings. Missing fields keep their current values.',
  properties: {
    strength: { type: 'number', minimum: 0, maximum: 1, description: 'How far each pixel under the tip moves towards the mix of the paint near it, per dab.' },
    distance: { type: 'number', minimum: 0, maximum: 1, description: 'Blend distance: how far away colours are mixed in, as a fraction of the tip diameter (0.35 default; higher blends wider and softer).' },
    mixing: MIXING,
  },
  additionalProperties: false,
} as const;

const SMUDGE = {
  type: 'object',
  description: 'Smudge engine settings. Missing fields keep their current values.',
  properties: {
    strength: { type: 'number', minimum: 0, maximum: 1, description: 'How strongly the dragged paint covers what is under the tip, per dab.' },
    length: { type: 'number', minimum: 0, maximum: 1, description: 'How far paint is dragged: the share of the carried paint kept from dab to dab (0.85 default; 1 drags it the whole stroke).' },
    mixing: { ...MIXING, description: 'rgb (default): smeared colours average; pigment: they mix like paint.' },
  },
  additionalProperties: false,
} as const;

const BRUSH_FIELDS = {
  name: { type: 'string', minLength: 1, maxLength: 80, description: 'Display name.' },
  category: { type: 'string', enum: [...PAINT_BRUSH_CATEGORIES], description: 'Library category.' },
  engine: {
    type: 'string',
    enum: [...PAINT_BRUSH_ENGINES],
    description: 'dab: paints dabs (with behavior.pickup or multicolor it paints dab by dab, lifting and mixing paint); eraser: removes paint; mixer: the Mixer Brush (a reservoir plus picked-up paint); blender: mixes the colours under and near the tip; smudge: drags paint along the stroke.',
  },
  tip: TIP,
  grain: { type: 'number', minimum: 0, maximum: 1, description: 'Paper grain response: 0 ignores the grain, 1 catches only its peaks at light pressure (pencil, pastel, charcoal). Multiplied by the paper depth.' },
  pressureSmoothing: { type: 'number', minimum: 0, maximum: 0.95, description: 'Pressure smoothing, separate from the tip position smoothing.' },
  rotation: { type: 'string', enum: [...BRUSH_ROTATIONS], description: 'What turns the tip: fixed (tip.angle), stroke (follows the direction of travel) or barrel (the pen barrel rotation, twist).' },
  dynamics: DYNAMICS,
  mixer: MIXER,
  loadsColor: { type: 'boolean', description: 'Mixer engine: load the colour each stroke (false for a mixer that only moves paint).' },
  behavior: BEHAVIOR,
  blender: BLENDER,
  smudge: SMUDGE,
} as const;

const POINTS = {
  type: 'array',
  minItems: 1,
  maxItems: 20000,
  description: 'The path in document pixels (raw samples; the brush smooths them). One point paints one dab.',
  items: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'Document x in pixels.' },
      y: { type: 'number', description: 'Document y in pixels.' },
      pressure: { type: 'number', minimum: 0, maximum: 1, description: 'Pen pressure 0..1 (default 1).' },
      t: { type: 'number', description: 'Time in milliseconds (optional; drives velocity dynamics, e.g. an ink pen thinning on fast strokes).' },
      tiltX: { type: 'number', minimum: -90, maximum: 90, description: 'Pen tilt in degrees towards +x (Pointer Events tiltX).' },
      tiltY: { type: 'number', minimum: -90, maximum: 90, description: 'Pen tilt in degrees towards +y (Pointer Events tiltY).' },
      altitude: { type: 'number', minimum: 0, maximum: 1.5708, description: 'Pen altitude in radians: 1.5708 upright, 0 lying flat (overrides tiltX / tiltY).' },
      azimuth: { type: 'number', minimum: 0, maximum: 6.2832, description: 'Where the pen leans, radians clockwise from +x (with altitude).' },
      twist: { type: 'number', minimum: 0, maximum: 359, description: 'Barrel rotation in degrees (brushes with rotation barrel).' },
    },
    required: ['x', 'y'],
    additionalProperties: false,
  },
} as const;

function loadResult(load: MixerLoad) {
  const hex = (c: readonly number[] | null) => (c ? '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('') : null);
  return { reservoir: hex(load.reservoir), amount: Math.round(load.amount * 1000) / 1000, pickup: hex(load.pickup) };
}

function brushSummary(b: PaintBrush) {
  return {
    id: b.id,
    name: b.name,
    category: b.category,
    engine: b.engine,
    size: b.tip.size,
    grain: b.grain,
    rotation: b.rotation,
    wetCapable: isWetCapable(b),
    pickup: b.behavior.pickup,
    dirty: b.behavior.dirty,
    multicolor: b.behavior.multicolor.mode,
    builtin: Boolean(b.builtin),
  };
}

/** Agent tools for one paint editor. */
export function createPaintEditorToolProvider(controller: PaintEditorController, options: PaintEditorToolProviderOptions = {}): AgentToolProvider {
  const c = controller;
  const tools: AgentTool[] = [];
  const add = (t: AgentTool) => tools.push(t);

  // --- Canvas ------------------------------------------------------------------

  add({
    name: 'get_canvas_info',
    title: 'Get the canvas',
    description:
      'Reads the canvas: size in pixels and dpi, the paper (preset, colour, grain depth), the active layer, the active brush id, the paint colour, the view (zoom, rotation, mirror), the hand, how many strokes are recorded, the undo / redo labels, and the blend modes. Call it first.',
    inputSchema: EMPTY,
    annotations: { title: 'Get the canvas', ...READ },
    handler: () => {
      const s = c.getState();
      const d = s.document;
      return {
        width: d.canvas.width,
        height: d.canvas.height,
        dpi: d.canvas.dpi,
        paper: { preset: d.paper.preset, name: d.paper.name, color: d.paper.color, depth: d.paper.depth },
        activeLayerId: d.activeLayerId,
        layerCount: c.listLayers().length,
        brushId: s.brush.id,
        color: s.color,
        secondaryColor: s.secondaryColor,
        view: { zoom: s.view.zoom, rotation: s.view.rotation, mirror: s.view.mirror },
        hand: s.hand,
        strokes: d.strokes.length,
        undo: s.undoLabel,
        redo: s.redoLabel,
        blendModes: BLEND_MODES.map((m) => m.id),
      };
    },
  });

  add({
    name: 'new_canvas',
    title: 'Start a new canvas',
    description:
      'Replaces the document with a blank canvas: one empty layer over the paper. Size and dpi default to the current ones, the paper to the current paper (or a preset id from list_papers). One undo step (undo brings the old painting back). Returns the new size, paper and layer id.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 1, maximum: MAX_CANVAS_SIDE, description: 'Width in pixels (default the current width).' },
        height: { type: 'integer', minimum: 1, maximum: MAX_CANVAS_SIDE, description: 'Height in pixels (default the current height).' },
        dpi: { type: 'number', minimum: 1, maximum: 10000, description: 'Pixels per inch for print sizes and PSD (default the current dpi).' },
        paper: { type: 'string', description: 'Paper preset id from list_papers (default the current paper).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Start a new canvas', ...DESTRUCTIVE },
    handler: (a) => {
      const d = c.newCanvas({ width: a.width, height: a.height, dpi: a.dpi, paper: a.paper });
      return { width: d.canvas.width, height: d.canvas.height, dpi: d.canvas.dpi, paper: d.paper.preset, layerId: d.activeLayerId };
    },
  });

  add({
    name: 'set_canvas',
    title: 'Resize the canvas',
    description:
      'Changes the canvas size (pixels stay where they are, anchored at the top-left; anything outside is kept on the layers but not shown) and / or its dpi. One undo step. Returns the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'integer', minimum: 1, maximum: MAX_CANVAS_SIDE, description: 'Width in pixels (default unchanged).' },
        height: { type: 'integer', minimum: 1, maximum: MAX_CANVAS_SIDE, description: 'Height in pixels (default unchanged).' },
        dpi: { type: 'number', minimum: 1, maximum: 10000, description: 'Pixels per inch (default unchanged).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Resize the canvas', ...SET },
    handler: (a) => c.setCanvas({ width: a.width, height: a.height, dpi: a.dpi }),
  });

  // --- Paper -------------------------------------------------------------------

  add({
    name: 'list_papers',
    title: 'List papers',
    description:
      'Lists the built-in paper library (generated grain, no textures): id, name, family, grain pattern, colour, grain depth and the wet-media properties (absorption, permeability, roughness). Use an id with set_paper or new_canvas.',
    inputSchema: EMPTY,
    annotations: { title: 'List papers', ...READ },
    handler: () => ({
      papers: PAPER_LIBRARY.map((p) => ({ id: p.preset, name: p.name, family: p.family, pattern: p.pattern, color: p.color, depth: p.depth, absorption: p.absorption, permeability: p.permeability, roughness: p.roughness })),
      families: [...PAPER_FAMILIES],
      patterns: [...GRAIN_PATTERNS],
    }),
  });

  add({
    name: 'get_paper',
    title: 'Get the paper',
    description: 'Reads every setting of the current paper (preset, pattern, seed, colour, scale, tiling, depth, shading, dry and wet tuning, absorption, permeability, roughness).',
    inputSchema: EMPTY,
    annotations: { title: 'Get the paper', ...READ },
    handler: () => JSON.parse(JSON.stringify(c.document.paper)),
  });

  const tuning = {
    type: 'object',
    properties: {
      contrast: { type: 'number', minimum: 0, maximum: 3, description: 'Height contrast around the middle (default 1).' },
      invert: { type: 'boolean', description: 'Swap peaks and valleys.' },
    },
    additionalProperties: false,
  } as const;

  add({
    name: 'set_paper',
    title: 'Set the paper',
    description:
      'Changes the paper under the whole painting: a preset from list_papers and / or its settings. Grain depth decides how much grain-responsive brushes (pencil, pastel, charcoal) skip the valleys; changing it re-renders the paper but not strokes already painted. One undo step. Returns the paper.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', description: 'Paper id from list_papers (its settings, then the other fields here on top).' },
        color: { ...COLOR, description: 'Paper colour #rrggbb.' },
        depth: { type: 'number', minimum: 0, maximum: 1, description: 'Grain depth 0..1 (0: brushes ignore the grain).' },
        scale: { type: 'number', minimum: 0.25, maximum: 8, description: 'Grain scale: 1 natural, 2 twice as coarse.' },
        seed: { type: 'integer', minimum: 0, description: 'Grain seed: another sheet of the same paper.' },
        pattern: { type: 'string', enum: [...GRAIN_PATTERNS], description: 'Grain pattern.' },
        tiling: { type: 'string', enum: ['repeat', 'mirror'], description: 'How the grain tile repeats (mirror hides seams).' },
        shading: { type: 'number', minimum: 0, maximum: 1, description: 'How much the grain shades the paper colour.' },
        dry: { ...tuning, description: 'Height map tuning for dry media.' },
        wet: { ...tuning, description: 'Height map tuning for wet media (stored for later).' },
        absorption: { type: 'number', minimum: 0, maximum: 1, description: 'Wet media: how fast the paper takes water (stored for later).' },
        permeability: { type: 'number', minimum: 0, maximum: 1, description: 'Wet media: how far water spreads in the paper (stored for later).' },
        roughness: { type: 'number', minimum: 0, maximum: 1, description: 'Wet media: how much the grain catches pigment (stored for later).' },
        name: { type: 'string', minLength: 1, description: 'Display name.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Set the paper', ...SET },
    handler: (a) => c.setPaper(a),
  });

  // --- Layers ------------------------------------------------------------------

  add({
    name: 'list_layers',
    title: 'List layers',
    description:
      'Lists the layers top first: id, name, type (pixel or group), visibility, opacity, blend, clipping, locks, whether it is active, the painted bounds in document pixels (null when empty), parent and depth.',
    inputSchema: EMPTY,
    annotations: { title: 'List layers', ...READ },
    handler: () => ({ layers: c.listLayers(), activeLayerId: c.document.activeLayerId }),
  });

  add({
    name: 'add_layer',
    title: 'Add a layer',
    description: 'Adds an empty pixel layer (or a group) above the active layer, or above aboveId, or at the top of parentId; it becomes the active layer. One undo step. Returns the layer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Layer name (default "Layer n").' },
        type: { type: 'string', enum: ['pixel', 'group'], description: 'pixel (default) or group.' },
        aboveId: { type: 'string', description: 'Put it directly above this layer (default the active layer).' },
        parentId: { type: 'string', description: 'Put it at the top of this group instead.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Add a layer', ...WRITE },
    handler: (a) => c.addLayer({ name: a.name, type: a.type, aboveId: a.aboveId, parentId: a.parentId }),
  });

  add({
    name: 'update_layer',
    title: 'Change a layer',
    description: 'Changes a layer: name, visibility, opacity, blend mode, clipping to the layer below, locks. One undo step. Returns the layer.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'string', description: 'Layer id from list_layers.' },
        name: { type: 'string', minLength: 1, description: 'New name.' },
        visible: { type: 'boolean', description: 'Show or hide.' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Layer opacity 0..1.' },
        blend: {
          type: 'string',
          enum: [...BLEND_MODES.map((m) => m.id), 'pass-through'],
          description: 'Blend mode (pass-through for groups only). Painterly modes: watercolor (the layer glazes like a transparent wash), tint (recolours keeping lightness), highlight (adds soft coloured light), shadow (shades with ambient fill); see list_blend_modes.',
        },
        clipped: { type: 'boolean', description: 'Clip to the layer below (paint only shows where it has paint).' },
        locks: {
          type: 'object',
          description: 'Locks to change (others keep their values).',
          properties: {
            pixels: { type: 'boolean', description: 'Refuse painting.' },
            transparency: { type: 'boolean', description: 'Paint only where the layer already has paint.' },
            position: { type: 'boolean', description: 'Refuse moving.' },
            all: { type: 'boolean', description: 'All of the above, plus property changes and removal.' },
          },
          additionalProperties: false,
        },
      },
      required: ['layerId'],
      additionalProperties: false,
    },
    annotations: { title: 'Change a layer', ...SET },
    handler: ({ layerId, ...u }) => c.updateLayer(layerId, u as { blend?: BlendMode }),
  });

  add({
    name: 'list_blend_modes',
    title: 'List blend modes',
    description:
      'Lists every layer and brush blend mode: id, label, group (standard Photoshop modes, pigment, or painterly), what the pigment and painterly modes do, and the standard mode PSD export writes in their place. Changes nothing. Read it before choosing a painterly mode for update_layer or a brush tip.',
    inputSchema: EMPTY,
    annotations: { title: 'List blend modes', ...READ },
    handler: () => ({
      modes: BLEND_MODES.map((m) => ({
        id: m.id,
        label: m.label,
        group: m.painterly ? 'painterly' : m.id === 'pigment' ? 'pigment' : 'standard',
        ...(m.description ? { description: m.description } : {}),
        psd: standardBlendMode(m.id),
      })),
    }),
  });

  add({
    name: 'set_active_layer',
    title: 'Choose the active layer',
    description: 'Makes a layer active: strokes, fills and clears without a layerId go to it. Editor state, not an undo step. Returns the layer.',
    inputSchema: { type: 'object', properties: { layerId: { type: 'string', description: 'Layer id from list_layers.' } }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Choose the active layer', ...SET },
    handler: ({ layerId }) => {
      c.setActiveLayer(layerId);
      return c.describeLayer(c.getLayer(layerId)!);
    },
  });

  add({
    name: 'remove_layer',
    title: 'Remove a layer',
    description: 'Removes a layer (a group with its children). One undo step. Returns the removed id and the new active layer.',
    inputSchema: { type: 'object', properties: { layerId: { type: 'string', description: 'Layer id from list_layers.' } }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Remove a layer', ...DESTRUCTIVE },
    handler: ({ layerId }) => c.removeLayer(layerId),
  });

  add({
    name: 'duplicate_layer',
    title: 'Duplicate a layer',
    description: 'Copies a layer (a group with its children) directly above it; the copy becomes active. One undo step. Returns the copy.',
    inputSchema: { type: 'object', properties: { layerId: { type: 'string', description: 'Layer id from list_layers.' } }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Duplicate a layer', ...WRITE },
    handler: ({ layerId }) => c.duplicateLayer(layerId),
  });

  add({
    name: 'move_layer',
    title: 'Reorder a layer',
    description: 'Moves a layer to a position in its group or another (0 is the bottom). One undo step. Returns the layer with its new parent.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'string', description: 'Layer id from list_layers.' },
        index: { type: 'integer', minimum: 0, description: 'New position among its siblings, 0 = bottom.' },
        parentId: { type: ['string', 'null'], description: 'Group id to move into, or null for the top level (default its current parent).' },
      },
      required: ['layerId', 'index'],
      additionalProperties: false,
    },
    annotations: { title: 'Reorder a layer', ...WRITE },
    handler: ({ layerId, index, parentId }) => c.moveLayer(layerId, index, parentId),
  });

  add({
    name: 'merge_layer_down',
    title: 'Merge a layer down',
    description: 'Merges a pixel layer into the pixel layer directly below it, which keeps its name, opacity and blend. One undo step. Returns the merged layer.',
    inputSchema: { type: 'object', properties: { layerId: { type: 'string', description: 'The upper layer, from list_layers.' } }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Merge a layer down', ...DESTRUCTIVE },
    handler: ({ layerId }) => c.mergeDown(layerId),
  });

  add({
    name: 'fill_layer',
    title: 'Fill a layer',
    description:
      'Fills a whole pixel layer with a colour: a flat block-in, or with grain above 0 a fill that follows the paper grain like pastel or charcoal rubbed across the sheet (pressure decides how far it reaches into the valleys). Good for a ground colour or a tonal layer to paint over. One undo step. Returns the layer id and the filled bounds.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: LAYER_ID,
        color: { ...COLOR, description: 'Fill colour #rrggbb (default the paint colour).' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Opacity 0..1 (default 1).' },
        grain: { type: 'number', minimum: 0, maximum: 1, description: 'Paper grain response 0..1 (default 0: flat).' },
        pressure: { type: 'number', minimum: 0, maximum: 1, description: 'With grain: how far into the valleys, 0..1 (default 0.5).' },
        blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'Blend mode (default normal; pigment mixes like paint, watercolor glazes; see list_blend_modes).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Fill a layer', ...WRITE },
    handler: (a) => c.fillLayer(a),
  });

  add({
    name: 'clear_layer',
    title: 'Clear a layer',
    description: 'Removes every pixel of a pixel layer. One undo step. Returns the layer id and the bounds that were cleared (null if it was empty).',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, additionalProperties: false },
    annotations: { title: 'Clear a layer', ...DESTRUCTIVE },
    handler: ({ layerId }) => c.clearLayer(layerId),
  });

  // --- Brushes -----------------------------------------------------------------

  add({
    name: 'list_brushes',
    title: 'List brushes',
    description:
      'Lists the brush library: built-in dry media (pencils, pastels, charcoal, airbrush, marker, ink, erasers), paint brushes (dirty round, multi-colour flat, palette dabber), blending tools (blender, smudge, pigment smudge, Mixer Brush) and saved user brushes, with id, name, category, engine, size, grain response, rotation mode, whether it can pick up paint (wetCapable), its pick-up ratio, dirty and multi-colour mode, plus the active brush id.',
    inputSchema: EMPTY,
    annotations: { title: 'List brushes', ...READ },
    handler: () => {
      const s = c.getState();
      return { activeBrushId: s.brush.id, activeEdited: !s.brush.builtin && Boolean(c.getBrush(s.brush.id)?.builtin), brushes: s.brushes.map(brushSummary) };
    },
  });

  add({
    name: 'get_brush',
    title: 'Get a brush',
    description: 'Reads every setting of a brush (tip, grain, pressure smoothing, rotation, dynamics, mixer, behavior: pick-up / mix / dirty / multi-colour, blender, smudge). Without id, the active brush as edited.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Brush id from list_brushes (default the active brush).' } }, additionalProperties: false },
    annotations: { title: 'Get a brush', ...READ },
    handler: ({ id }) => {
      if (id === undefined) return brushToJSON(c.getState().brush);
      const b = c.getBrush(id);
      if (!b) throw new Error(`Unknown brush "${id}". Call list_brushes for the ids.`);
      return { ...brushToJSON(b), builtin: Boolean(b.builtin) };
    },
  });

  add({
    name: 'set_brush',
    title: 'Set the brush',
    description:
      'Chooses the active brush (id) and / or changes its settings; strokes without a brush use it. Editor state, not an undo step. Changes stay on the active brush until save_brush stores them. Returns the active brush.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Brush id from list_brushes to start from.' }, ...BRUSH_FIELDS }, additionalProperties: false },
    annotations: { title: 'Set the brush', ...SET },
    handler: (a) => brushToJSON(c.setBrush(a)),
  });

  add({
    name: 'save_brush',
    title: 'Save a brush',
    description: 'Saves the active brush (with its changes) into the user library under a new or existing user id. Built-in ids are refused. Library state, not an undo step. Returns the saved brush.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description: 'Library id: lowercase letters, digits and dashes.' },
        name: { type: 'string', minLength: 1, maxLength: 80, description: 'Display name (default the brush name).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { title: 'Save a brush', ...SET },
    handler: ({ id, name }) => brushToJSON(c.saveBrush({ id, name })),
  });

  add({
    name: 'remove_brush',
    title: 'Remove a saved brush',
    description: 'Removes a user brush from the library (built-in brushes cannot be removed). Library state, not an undo step. Returns the removed id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'User brush id from list_brushes.' } }, required: ['id'], additionalProperties: false },
    annotations: { title: 'Remove a saved brush', ...DESTRUCTIVE },
    handler: ({ id }) => {
      c.removeBrush(id);
      return { removed: id };
    },
  });

  add({
    name: 'export_brushes',
    title: 'Export brushes',
    description: 'Returns a brush library file (JSON: format pixerate-brushes, version 1, brushes) of the given brushes, or of every user brush. Changes nothing.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string', description: 'Brush id.' }, description: 'Brush ids from list_brushes (default every user brush).' } },
      additionalProperties: false,
    },
    annotations: { title: 'Export brushes', ...READ },
    handler: ({ ids }) => c.exportBrushes(ids),
  });

  add({
    name: 'import_brushes',
    title: 'Import brushes',
    description:
      'Adds the brushes of a brush library file (as export_brushes returns) to the user library. Taken ids are skipped unless replace is true; built-in ids are always skipped. Library state, not an undo step. Returns the ids added and skipped and any problems.',
    inputSchema: {
      type: 'object',
      properties: {
        library: { type: 'object', description: 'The library file: {format: "pixerate-brushes", version: 1, brushes: [...]}.' },
        replace: { type: 'boolean', description: 'Replace user brushes with the same id (default false).' },
      },
      required: ['library'],
      additionalProperties: false,
    },
    annotations: { title: 'Import brushes', ...WRITE },
    handler: ({ library, replace }) => c.importBrushes(library, { replace }),
  });

  add({
    name: 'render_brush_thumbnail',
    title: 'Render a brush thumbnail',
    description: 'Renders a brush as a PNG: a test stroke (an S-curve swelling and fading in pressure) on the current paper, so you can see what it does before painting. Changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Brush id from list_brushes (default the active brush).' },
        width: { type: 'integer', minimum: 16, maximum: 512, description: 'Width in pixels (default 160).' },
        height: { type: 'integer', minimum: 16, maximum: 512, description: 'Height in pixels (default 48).' },
        color: { ...COLOR, description: 'Stroke colour (default the paint colour).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Render a brush thumbnail', ...READ },
    handler: ({ id, width, height, color }) => {
      const t = c.brushThumbnail(id ?? c.getState().brush.id, { width, height, color });
      return {
        content: [
          { type: 'image', data: bytesToBase64(encodePng(t.width, t.height, t.data)), mimeType: 'image/png' },
          { type: 'text', text: `Brush ${id ?? c.getState().brush.id} ${t.width}×${t.height}` },
        ],
      };
    },
  });

  // --- Colour and the Mixer Brush ----------------------------------------------

  add({
    name: 'set_color',
    title: 'Set the paint colour',
    description: 'Sets the paint colour (and optionally the second colour) that strokes and fills use by default. Editor state, not an undo step. Returns both colours.',
    inputSchema: {
      type: 'object',
      properties: { color: { ...COLOR, description: 'Paint colour #rrggbb.' }, secondaryColor: { ...COLOR, description: 'Second colour #rrggbb.' } },
      additionalProperties: false,
    },
    annotations: { title: 'Set the paint colour', ...SET },
    handler: ({ color, secondaryColor }) => {
      if (color !== undefined) c.setColor(color);
      if (secondaryColor !== undefined) c.setSecondaryColor(secondaryColor);
      const s = c.getState();
      return { color: s.color, secondaryColor: s.secondaryColor };
    },
  });

  add({
    name: 'pick_color',
    title: 'Pick a colour',
    description: 'Reads the colour at a document pixel: of the painting with its paper, or of one layer (with its alpha). Changes nothing. Returns #rrggbb and alpha 0..1.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Document x in pixels.' },
        y: { type: 'number', description: 'Document y in pixels.' },
        layerId: { type: 'string', description: 'Pick from this layer only (default the painting as shown).' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    annotations: { title: 'Pick a colour', ...READ },
    handler: ({ x, y, layerId }) => c.pickColor(x, y, { layerId }),
  });

  add({
    name: 'get_mixer_brush',
    title: 'Get the Mixer Brush load',
    description:
      "Reads what the brush carries between strokes: reservoir #rrggbb or null (the Mixer Brush's loaded paint), amount 0..1 left, pickup #rrggbb or null (paint picked up from the canvas, kept by dirty brushes and a Mixer Brush that does not clean each stroke). Call before painting with mixer-brush when its loadEachStroke is false, or with a dirty brush.",
    inputSchema: EMPTY,
    annotations: { title: 'Get the Mixer Brush load', ...READ },
    handler: () => loadResult(c.getState().mixerLoad),
  });

  add({
    name: 'load_mixer_brush',
    title: 'Load the Mixer Brush',
    description: 'Fills the Mixer Brush reservoir with a colour (amount 1), keeping what it picked up. Editor state, not an undo step. Returns the load.',
    inputSchema: { type: 'object', properties: { color: { ...COLOR, description: 'Colour #rrggbb (default the paint colour).' } }, additionalProperties: false },
    annotations: { title: 'Load the Mixer Brush', ...SET },
    handler: ({ color }) => loadResult(c.loadMixerBrush(color)),
  });

  add({
    name: 'clean_mixer_brush',
    title: 'Clean the Mixer Brush',
    description: 'Cleans the brush: empties the picked-up paint a dirty brush or the Mixer Brush carries (and with emptyReservoir the Mixer Brush paint too). Editor state, not an undo step. Returns the load.',
    inputSchema: { type: 'object', properties: { emptyReservoir: { type: 'boolean', description: 'Also drop the loaded paint (default false).' } }, additionalProperties: false },
    annotations: { title: 'Clean the Mixer Brush', ...SET },
    handler: ({ emptyReservoir }) => loadResult(c.cleanMixerBrush(emptyReservoir === true)),
  });

  // --- Painting ----------------------------------------------------------------

  add({
    name: 'paint_stroke',
    title: 'Paint a brush stroke',
    description:
      'Paints one stroke through points (document pixels, with optional pressure, time, tilt and barrel rotation) on a pixel layer with a library brush or the active one, optionally changed for this stroke. Grain-responsive brushes follow the paper; the mixer engine (mixer-brush) picks up and mixes paint already on the layer, the blender mixes nearby colours, the smudge drags paint, and dab brushes with behavior.pickup lift and carry paint. The symmetry guide adds its mirror copies; with a tracing image that samples colours, a stroke without color takes the image colour at its first point. One undo step. Returns the layer id, changed bounds, dab count, the recorded strokeId (for replay_strokes) and, for brushes that pick up paint, mixerLoad: what the brush carries after the stroke.',
    inputSchema: {
      type: 'object',
      properties: {
        points: POINTS,
        layerId: LAYER_ID,
        brushId: { type: 'string', description: 'Brush id from list_brushes (default the active brush).' },
        brush: { type: 'object', description: 'Brush changes for this stroke only.', properties: BRUSH_FIELDS, additionalProperties: false },
        color: { ...COLOR, description: 'Paint colour #rrggbb (default the paint colour).' },
        seed: { type: 'integer', minimum: 0, description: 'Jitter seed (default a new one); the same seed and points give the same marks.' },
        snapToPerspective: { type: 'boolean', description: 'Snap the points to the perspective guide, as a pen stroke would (default false).' },
      },
      required: ['points'],
      additionalProperties: false,
    },
    annotations: { title: 'Paint a brush stroke', ...WRITE },
    handler: (a) => {
      const r = c.paintStroke({ points: a.points as PenPoint[], layerId: a.layerId, brushId: a.brushId, brush: a.brush, color: a.color, seed: a.seed, snapToPerspective: a.snapToPerspective });
      return r.mixerLoad ? { ...r, mixerLoad: loadResult(r.mixerLoad) } : r;
    },
  });

  add({
    name: 'list_strokes',
    title: 'List recorded strokes',
    description:
      'Lists the recorded strokes, oldest first (every stroke is kept as data): id, layer, brush id and name, colour, point count, bounds and seed. With ids, also the points. Use the ids with replay_strokes.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string', description: 'Stroke id.' }, description: 'Only these strokes, with their points.' },
        last: { type: 'integer', minimum: 1, maximum: 1000, description: 'Only the most recent n strokes (default 100).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List recorded strokes', ...READ },
    handler: ({ ids, last }) => {
      const all = c.getStrokes();
      const picked = ids ? all.filter((s) => ids.includes(s.id)) : all.slice(-(last ?? 100));
      if (ids) for (const id of ids) if (!all.some((s) => s.id === id)) throw new Error(`Unknown stroke "${id}". Call list_strokes without ids for the ids.`);
      return {
        total: all.length,
        strokes: picked.map((s) => {
          const xs = s.points.map((p) => p.x);
          const ys = s.points.map((p) => p.y);
          const pad = s.brush.tip.size / 2;
          return {
            id: s.id,
            layerId: s.layerId,
            brushId: s.brush.id,
            brushName: s.brush.name,
            color: s.color,
            points: ids ? s.points : s.points.length,
            seed: s.seed,
            copies: s.copies?.length ?? 0,
            bounds: { x: Math.floor(Math.min(...xs) - pad), y: Math.floor(Math.min(...ys) - pad), width: Math.ceil(Math.max(...xs) - Math.min(...xs) + 2 * pad), height: Math.ceil(Math.max(...ys) - Math.min(...ys) + 2 * pad) },
          };
        }),
      };
    },
  });

  add({
    name: 'replay_strokes',
    title: 'Replay strokes, varied',
    description:
      'Paints recorded strokes again, moved, scaled, rotated, flipped, recoloured, with another brush or on another layer, repeat times (each repeat applies the variation again: a row, a fan, a spiral). Strokes replay exactly (same seed). All of it is one undo step. Returns the new stroke ids, the changed bounds and layer ids.',
    inputSchema: {
      type: 'object',
      properties: {
        strokeIds: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', description: 'Stroke id.' }, description: 'Stroke ids from list_strokes.' },
        dx: { type: 'number', description: 'Move right by this many pixels per repeat (default 0).' },
        dy: { type: 'number', description: 'Move down by this many pixels per repeat (default 0).' },
        scale: { type: 'number', exclusiveMinimum: 0, maximum: 20, description: 'Scale per repeat about the origin; brush size scales too (default 1).' },
        rotate: { type: 'number', minimum: -360, maximum: 360, description: 'Rotate per repeat about the origin, degrees clockwise (default 0).' },
        flipX: { type: 'boolean', description: 'Mirror left to right about the origin (default false).' },
        origin: {
          type: 'object',
          description: 'Centre for scale, rotate and flip (default the centre of the strokes).',
          properties: { x: { type: 'number', description: 'Document x.' }, y: { type: 'number', description: 'Document y.' } },
          required: ['x', 'y'],
          additionalProperties: false,
        },
        pressureScale: { type: 'number', minimum: 0, maximum: 4, description: 'Multiply every pressure (default 1).' },
        color: { ...COLOR, description: 'Recolour (default each stroke’s colour).' },
        brushId: { type: 'string', description: 'Replay with this brush from list_brushes (default each stroke’s brush).' },
        layerId: { type: 'string', description: 'Paint on this layer (default each stroke’s layer).' },
        repeat: { type: 'integer', minimum: 1, maximum: 100, description: 'How many copies (default 1).' },
      },
      required: ['strokeIds'],
      additionalProperties: false,
    },
    annotations: { title: 'Replay strokes, varied', ...WRITE },
    handler: (a) => c.replayStrokes(a as Parameters<PaintEditorController['replayStrokes']>[0]),
  });

  // --- View, hand, history -------------------------------------------------------

  add({
    name: 'set_view',
    title: 'Rotate, mirror or zoom the view',
    description: 'Changes the view only (the pixels never resample): zoom, rotation and mirroring, as an artist turns the paper or checks the drawing in a mirror. Editor state, not an undo step. Returns the view.',
    inputSchema: {
      type: 'object',
      properties: {
        zoom: { type: 'number', minimum: MIN_ZOOM, maximum: MAX_ZOOM, description: 'Screen pixels per document pixel.' },
        rotation: { type: 'number', minimum: -360, maximum: 360, description: 'Rotation in degrees clockwise.' },
        mirror: { type: 'boolean', description: 'Mirror left to right.' },
        reset: { type: 'boolean', description: 'Back to 100 %, no rotation, no mirror, centred (applied first).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Rotate, mirror or zoom the view', ...SET },
    handler: ({ reset, ...v }) => {
      if (reset) c.resetView();
      return c.setView(v);
    },
  });

  add({
    name: 'set_hand',
    title: 'Set the drawing hand',
    description: 'Says which hand holds the pen; palm rejection ignores touches on that side of the pen. Editor state, not an undo step. Returns the hand.',
    inputSchema: { type: 'object', properties: { hand: { type: 'string', enum: ['right', 'left'], description: 'right or left.' } }, required: ['hand'], additionalProperties: false },
    annotations: { title: 'Set the drawing hand', ...SET },
    handler: ({ hand }) => ({ hand: c.setHand(hand) }),
  });

  add({
    name: 'undo_paint',
    title: 'Undo',
    description: 'Undoes the last step (a stroke, a fill, a layer or paper change). Returns the label undone (null when there was nothing) and what can be undone and redone next.',
    inputSchema: EMPTY,
    annotations: { title: 'Undo', ...WRITE },
    handler: () => {
      const undone = c.undo();
      const s = c.getState();
      return { undone, nextUndo: s.undoLabel, nextRedo: s.redoLabel };
    },
  });

  add({
    name: 'redo_paint',
    title: 'Redo',
    description: 'Redoes the last undone step. Returns the label redone (null when there was nothing) and what can be undone and redone next.',
    inputSchema: EMPTY,
    annotations: { title: 'Redo', ...WRITE },
    handler: () => {
      const redone = c.redo();
      const s = c.getState();
      return { redone, nextUndo: s.undoLabel, nextRedo: s.redoLabel };
    },
  });

  // --- Output ------------------------------------------------------------------

  add({
    name: 'render_preview',
    title: 'Render a preview',
    description: 'Renders the painting (with its paper unless paper is false) or some layers as a PNG whose longest side is at most maxSide. Changes nothing. Look at it after each block of work.',
    inputSchema: {
      type: 'object',
      properties: {
        maxSide: { type: 'integer', minimum: 16, maximum: 2048, description: 'Longest side in pixels (default 512).' },
        layerIds: { type: 'array', items: { type: 'string', description: 'Layer id.' }, description: 'Only these layers (default all).' },
        paper: { type: 'boolean', description: 'Include the paper (default true).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Render a preview', ...READ },
    handler: ({ maxSide, layerIds, paper }) => {
      if (layerIds) for (const id of layerIds) if (!c.getLayer(id)) throw new Error(`Unknown layer "${id}". Call list_layers for the ids.`);
      const p = c.previewPngBase64({ maxSide: maxSide ?? 512, layerIds, paper });
      return { content: [{ type: 'image', data: p.data, mimeType: 'image/png' }, { type: 'text', text: `Preview ${p.width}×${p.height}` }] };
    },
  });

  add({
    name: 'export_image',
    title: 'Export the painting',
    description: 'Exports the painting as PNG, JPEG or WebP (base64). JPEG always includes the paper; JPEG and WebP need a browser canvas. Changes nothing. Returns the data, its MIME type and size.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'], description: 'File type (default image/png).' },
        quality: { type: 'number', minimum: 0, maximum: 1, description: 'JPEG / WebP quality 0..1 (default 0.92).' },
        scale: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Shrink by this factor (default 1).' },
        paper: { type: 'boolean', description: 'Include the paper (default true).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Export the painting', ...READ },
    handler: async ({ format, quality, scale, paper }) => {
      const bytes = await c.exportImage({ format, quality, scale, paper });
      return { mimeType: format ?? 'image/png', bytes: bytes.length, data: bytesToBase64(bytes) };
    },
  });

  add({
    name: 'export_psd',
    title: 'Export as PSD',
    description:
      'Writes the painting as an 8-bit RGB PSD (PSB above 30000 px) through the shared PSD writer: every layer and group with its opacity, blend, mask and locks, the paper as a locked "Paper" pixel layer at the bottom, and the composite as the merged image. Changes nothing. Returns the file as base64, its size, whether it is a PSB, and warnings (pigment and painterly blend modes have no PSD equivalent: they are written as the nearest standard mode, see list_blend_modes).',
    inputSchema: EMPTY,
    annotations: { title: 'Export as PSD', ...READ },
    handler: () => {
      const r = c.exportPsd();
      return { data: bytesToBase64(r.bytes), bytes: r.bytes.length, psb: r.psb, warnings: r.warnings };
    },
  });

  add({
    name: 'save_document',
    title: 'Save the document',
    description: 'Returns the document as JSON (format pixerate-paint, version 1): canvas, paper, layers with PNG data URLs, and the recorded strokes unless strokes is false. Changes nothing.',
    inputSchema: { type: 'object', properties: { strokes: { type: 'boolean', description: 'Include the recorded strokes (default true).' } }, additionalProperties: false },
    annotations: { title: 'Save the document', ...READ },
    handler: ({ strokes }) => c.toJSON({ strokes }),
  });

  add({
    name: 'open_document',
    title: 'Open a document',
    description: 'Opens a saved paint document (as save_document returns), replacing the painting and clearing the undo history. Returns the canvas, the layers and anything that could not be read.',
    inputSchema: { type: 'object', properties: { document: { type: 'object', description: 'The saved document JSON.' } }, required: ['document'], additionalProperties: false },
    annotations: { title: 'Open a document', ...DESTRUCTIVE },
    handler: ({ document }) => {
      const problems = c.loadJSON(document);
      const d = c.document;
      return { width: d.canvas.width, height: d.canvas.height, layers: c.listLayers(), strokes: d.strokes.length, problems };
    },
  });

  tools.push(...createPaintGuideTools(c));
  tools.push(...createPigmentTools());

  return { id: options.id ?? 'paint-editor', namespace: options.namespace, tools };
}
