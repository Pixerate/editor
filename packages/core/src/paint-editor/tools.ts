/**
 * Agent tools for the paint editor (`createPaintEditorToolProvider`). Strict schemas, every
 * argument described, all four annotations. Each write is one undo step (or editor state, said so)
 * and returns what it changed; ids come from the read tools (`list_layers`, the brush library's `list_brush_presets`,
 * `list_papers`, `list_strokes`).
 */

import { withPaintPlayback } from './playback';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import { fromDocument, hostedSchema, hostedText, lazyController, toDocument, type PaintAgentTool, type PaintOrigin } from './hosted';
import { createPigmentTools } from '../paint/pigment-tools';
import { bezierPathToSvg } from '../canvas/pathops/bezier';
import type { MixerLoad } from '../paint/mixer';
import { PAINT_SOURCE_JSON_SCHEMA } from '../paint/gradient-paint';
import { BLEND_MODES, standardBlendMode, type BlendMode } from '../raster/blend';
import { bytesToBase64 } from '../raster/png';
import { createStickerTools } from '../stickers/tools';
import { createPaintStickerTools } from './sticker-tools';
import { MAX_CANVAS_SIDE } from './document';
import { normalizePaintBrush } from './brushes';
import { brushStickerRefs } from './stamp-tip';
import { PaintEditorError, type PaintEditorController } from './controller';
import { BRUSH_PATCH_PROPERTIES, BRUSH_UNSET_PROPERTY, type BrushPatch, type UnsettableBrushFacet } from '../brushes/patch';
import type { PenPoint } from './engine';
import type { RecordedStroke } from './strokes';
import { GRAIN_PATTERNS, PAPER_FAMILIES, PAPER_LIBRARY } from './paper';
import { MAX_ZOOM, MIN_ZOOM } from './view';
import { createPaintGuideTools } from './guide-tools';
import { createLayerEffectTools } from '../image-editor/effect-tools';
import { createPaintWetTools } from './wet-tools';
import { createPaintThickTools } from './thick-tools';
import { createFerroTools } from './ferro-tools';
import { createPaintReplayTools } from './replay-tools';
import { createMutationTools } from './mutation-tools';
import { createPaintEvolutionTools } from './evolution-tools';
import { samplePath } from './path-samples';
import type { PaintAgentCommand, PaintDirector } from './presence';
import type { PresenceActorInfo } from '../animation/presence';

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
  /** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
  namespace?: string;
  /**
   * Acts out strokes, fills and replays with an agent cursor on the canvas (see `PaintDirector`):
   * strokes paint live along their points. Each call is still one undo step. Without it, they apply at once.
   */
  director?: PaintDirector;
  /** The agent's cursor (default `{ id: 'agent', name: 'Agent' }`). */
  actor?: PresenceActorInfo;
  /**
   * The agent playback surface its calls are acted out on (default `paint`, where `PaintEditor` attaches).
   * Set it when one registry holds several editors of this kind, each attached under its own surface id.
   */
  playbackSurface?: string;
  /**
   * Hosts the document as a layer on a larger canvas: where document (0, 0) sits in host
   * coordinates. Every position the tools take is then a host coordinate and every position they
   * return is one too (strokes, picks, bounds, guides, stencils, stickers, wet areas); the
   * descriptions say canvas coordinates. Directors receive document pixels.
   */
  origin?: PaintOrigin;
  /** Bare tool names to leave out (e.g. `new_canvas`, `export_psd` when the host owns the canvas). */
  exclude?: readonly string[];
  /** Called after each successful write (every tool not marked read-only), e.g. so the host can save. */
  onChange?: (info: { tool: string }) => void;
}


/** The moment of live effect paint to export at. */
const TIME = { type: 'number', minimum: 0, description: 'Draw live effect paint (strokes on stroke layers painted with live effect paint) this many ms into its animation (default: as painted, its own time).' } as const;

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


/**
 * Agent tools for one paint editor. Pass a getter to create the document lazily: it is first
 * called when a tool runs, never on registration.
 */
export function createPaintEditorToolProvider(controller: PaintEditorController | (() => PaintEditorController), options: PaintEditorToolProviderOptions = {}): AgentToolProvider {
  const c = typeof controller === 'function' ? lazyController(controller) : controller;
  const tools: PaintAgentTool[] = [];
  const add = (t: PaintAgentTool) => tools.push(t);
  /** Runs `command` through the director when there is one (its error becomes the tool error), else `direct`. */
  const act = async <T>(command: PaintAgentCommand | (() => PaintAgentCommand), direct: () => T): Promise<T> => {
    if (!options.director) return direct();
    const cmd = typeof command === 'function' ? command() : command;
    const [r] = await options.director.perform(options.actor ?? { id: 'agent', name: 'Agent' }, [cmd]);
    if (!r || !r.ok) throw new Error(r && !r.ok ? r.message : 'The director did not run the command.');
    return r.result as T;
  };

  // --- Canvas ------------------------------------------------------------------

  add({
    name: 'get_canvas_info',
    title: 'Get the canvas',
    description:
      'Reads the canvas: size in pixels and dpi, its origin (where (0, 0) is relative to the canvas it was extended from), bounds (the rectangle the painting covers, in the coordinates every other tool takes), the paper (preset, colour, grain depth), the active layer, the active brush id, the paint colour, the view (zoom, rotation, mirror), the hand, how many strokes are recorded, the undo / redo labels, and the blend modes. Call it first.',
    inputSchema: EMPTY,
    annotations: { title: 'Get the canvas', ...READ },
    coordinates: { out: ['bounds'] },
    handler: () => {
      const s = c.getState();
      const d = s.document;
      return {
        width: d.canvas.width,
        height: d.canvas.height,
        dpi: d.canvas.dpi,
        origin: { ...(d.origin ?? { x: 0, y: 0 }) },
        bounds: { x: 0, y: 0, width: d.canvas.width, height: d.canvas.height },
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
        wet: s.wet.wet,
        lighting: c.getLighting(),
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

  const EXTEND_SIDE = (side: string) => ({ type: 'integer', minimum: 0, maximum: MAX_CANVAS_SIDE - 1, description: `Pixels to add on the ${side} (default 0).` }) as const;
  add({
    name: 'extend_canvas',
    title: 'Extend the canvas',
    description:
      'Grows the canvas by adding pixels on any side, keeping everything painted. Adding on the left or top moves the whole picture (layers, paper grain, guides, stencils, recorded strokes) right or down by that much in document pixels, so coordinates you read before change by (+left, +top). Wet paint stays wet and moves with it when left and top are multiples of 256; otherwise it dries first. One undo step. Returns the canvas, rect (the new canvas in the previous coordinates: x -left, y -top) and origin.',
    inputSchema: {
      type: 'object',
      properties: { left: EXTEND_SIDE('left'), top: EXTEND_SIDE('top'), right: EXTEND_SIDE('right'), bottom: EXTEND_SIDE('bottom') },
      additionalProperties: false,
    },
    annotations: { title: 'Extend the canvas', ...WRITE },
    handler: (a) => c.extendCanvas({ left: a.left, top: a.top, right: a.right, bottom: a.bottom }),
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
    description: 'Reads every setting of the current paper (preset, pattern, seed, colour, scale, tiling, depth, shading, dry and wet tuning, absorption, permeability, roughness, and metallic, backlight and backlightColor when set).',
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
      'Changes the paper under the whole painting: a preset from list_papers and / or its settings. Grain depth decides how much grain-responsive brushes (pencil, pastel, charcoal) skip the valleys; changing it re-renders the paper but not strokes already painted. backlight lights the paper from behind (the stained-glass preset has it on). One undo step. Returns the paper.',
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
        wet: { ...tuning, description: 'Height map tuning for wet media (the grain water and pigment follow).' },
        absorption: { type: 'number', minimum: 0, maximum: 1, description: 'Wet media: how fast the paper soaks up water (high: washes stop spreading sooner).' },
        permeability: { type: 'number', minimum: 0, maximum: 1, description: 'Wet media: how freely water flows over the fibres (low: more ragged, slower spreading).' },
        roughness: { type: 'number', minimum: 0, maximum: 1, description: 'Wet media: how much the grain pins wet edges and catches granulating pigment.' },
        metallic: { type: 'number', minimum: 0, maximum: 1, description: 'Metallic paper (gold or silver leaf, pearlescent card): the grain catches the light (see set_lighting). 0 by default.' },
        backlight: { type: 'number', minimum: 0, maximum: 1, description: 'Backlit paper (a lightbox, stained glass): light from behind the paper, 0 (none, the default) .. 1. Transparent glazes (watercolour, airbrush, thin marker) glow in their own colour; opaque paint (gouache, oil, solid ink) and thick paint block it; the light through paint spills softly around it. Nothing is repainted.' },
        backlightColor: { ...COLOR, description: 'The backlight’s colour #rrggbb (default #fff1d6, warm white).' },
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
    coordinates: { out: ['layers[].bounds'] },
    handler: () => ({ layers: c.listLayers(), activeLayerId: c.document.activeLayerId }),
  });

  add({
    name: 'add_layer',
    title: 'Add a layer',
    description: 'Adds an empty pixel layer, a group, or a stroke layer (type strokes: its strokes stay editable with update_stroke and edit_stroke_points) above the active layer, or above aboveId, or at the top of parentId; it becomes the active layer. One undo step. Returns the layer (liveStrokes: its stroke count, for a stroke layer).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Layer name (default "Layer n").' },
        type: { type: 'string', enum: ['pixel', 'group', 'strokes'], description: 'pixel (default), group, or strokes: a live stroke layer whose pixels are drawn from its strokes, so each stays editable. It takes dab, particle, bristle and Mixer Brush strokes that pick up no paint.' },
        aboveId: { type: 'string', description: 'Put it directly above this layer (default the active layer).' },
        parentId: { type: 'string', description: 'Put it at the top of this group instead.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Add a layer', ...WRITE },
    coordinates: { out: ['bounds'] },
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
    coordinates: { out: ['bounds'] },
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
    coordinates: { out: ['bounds'] },
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
    coordinates: { out: ['bounds'] },
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
    coordinates: { out: ['bounds'] },
    handler: ({ layerId, index, parentId }) => c.moveLayer(layerId, index, parentId),
  });

  add({
    name: 'merge_layer_down',
    title: 'Merge a layer down',
    description: 'Merges a pixel layer into the pixel layer directly below it, which keeps its name, opacity and blend. One undo step. Returns the merged layer.',
    inputSchema: { type: 'object', properties: { layerId: { type: 'string', description: 'The upper layer, from list_layers.' } }, required: ['layerId'], additionalProperties: false },
    annotations: { title: 'Merge a layer down', ...DESTRUCTIVE },
    coordinates: { out: ['bounds'] },
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
    coordinates: { out: ['bounds'] },
    handler: (a) => act({ kind: 'fill', fill: a }, () => c.fillLayer(a)),
  });

  add({
    name: 'fill_region',
    title: 'Fill a region (bucket / flats)',
    description:
      'Flood-fills one or more enclosed regions on a pixel layer from a seed point (x, y) or a batch of seed points (points). Set reference to a line-art layer id from list_layers (or "all" / "composite" for all visible layers, or "layer" for the target layer itself) to drop flat colours onto a flats layer under the ink without touching the line art. closeGap (0..32 px) bridges small gaps in the line art so flats do not leak; expand (-16..16 px, e.g. 1..2 px) bleeds the fill under anti-aliased line edges so no halo shows; wet pours a watercolour wash into the region on the wet layer. One undo step. Returns layerId, bounds, pixelCount, regions, and leaked (true when the fill touched the canvas border).',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Seed point x in document pixels (pass x and y, or points).' },
        y: { type: 'number', description: 'Seed point y in document pixels (pass x and y, or points).' },
        points: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          description: 'Multiple seed points in document pixels, filled together as one undo step.',
          items: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'Document x in pixels.' },
              y: { type: 'number', description: 'Document y in pixels.' },
            },
            required: ['x', 'y'],
            additionalProperties: false,
          },
        },
        layerId: LAYER_ID,
        reference: {
          type: 'string',
          description:
            'Which pixels stop the fill: "layer" (default, the target layer itself), "all" or "composite" (all visible layers without paper), or a layer id from list_layers (e.g. an ink line-art layer above the flats layer).',
        },
        color: { ...COLOR, description: 'Fill colour #rrggbb (default the paint colour).' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Opacity 0..1 (default 1).' },
        blend: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'Blend mode (default normal; see list_blend_modes).' },
        blendMode: { type: 'string', enum: BLEND_MODES.map((m) => m.id), description: 'Alias for blend (default normal; see list_blend_modes).' },
        tolerance: { type: 'number', minimum: 0, maximum: 255, description: 'Colour and alpha similarity tolerance 0..255 (default 32).' },
        closeGap: { type: 'number', minimum: 0, maximum: 32, description: 'Close gaps in line art up to this width in pixels, 0..32 (default 0).' },
        expand: { type: 'number', minimum: -16, maximum: 16, description: 'Expand (> 0, bleed under lines to hide anti-aliased halos) or contract (< 0) the filled region in pixels, -16..16 (default 0).' },
        antialias: { type: 'boolean', description: 'Soften boundary edges (default true).' },
        grain: { type: 'number', minimum: 0, maximum: 1, description: 'Paper grain response 0..1 (default 0: flat).' },
        pressure: { type: 'number', minimum: 0, maximum: 1, description: 'With grain: how far into the valleys, 0..1 (default 0.5).' },
        wet: { type: 'boolean', description: 'Pour a wet watercolour wash into the region on the wet layer instead of dry pixels (default false).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Fill a region (bucket / flats)', ...WRITE },
    coordinates: { in: ['', 'points[]'], out: ['bounds', 'regions[].point', 'regions[].bounds'] },
    handler: (a) => act({ kind: 'fill-region', fill: a }, () => c.fillRegion(a)),
  });

  add({
    name: 'find_unfilled_regions',
    title: 'Find enclosed unfilled regions',
    description:
      'Finds enclosed unfilled regions from a reference line-art layer (reference: layerId) or the visible composite ("all" / "composite", the default), closing line-art gaps up to closeGap px. When layerId is given, regions already painted on that target layer are excluded. Changes nothing. Returns regions sorted largest first, each with an interior seed point {x, y} ready for fill_region, centroid, bounds, pixelCount (area), and touchesEdge.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'string', description: 'Target flats layer id from list_layers; regions already painted on it are excluded (optional).' },
        reference: {
          type: 'string',
          description:
            'Which pixels define the line-art barriers: "all" or "composite" (default, all visible layers without paper), "layer" (the target or active layer), or a layer id from list_layers (e.g. an ink line-art layer).',
        },
        tolerance: { type: 'number', minimum: 0, maximum: 255, description: 'Alpha/colour threshold 0..255 above which a reference pixel counts as line art (default 32).' },
        closeGap: { type: 'number', minimum: 0, maximum: 32, description: 'Close small gaps in line art up to this width in pixels, 0..32 (default 0).' },
        minArea: { type: 'integer', minimum: 1, maximum: 10000000, description: 'Ignore regions smaller than this many pixels (default 16).' },
        includeEdge: { type: 'boolean', description: 'Include regions that touch the canvas border (default false: only enclosed shapes).' },
        maxRegions: { type: 'integer', minimum: 1, maximum: 1000, description: 'Most regions to return, largest first (default 100).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Find enclosed unfilled regions', ...READ },
    coordinates: { out: ['regions[].point', 'regions[].centroid', 'regions[].bounds'] },
    handler: (a) => c.findUnfilledRegions(a),
  });

  add({
    name: 'clear_layer',
    title: 'Clear a layer',
    description: 'Removes every pixel of a pixel layer. One undo step. Returns the layer id and the bounds that were cleared (null if it was empty).',
    inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, additionalProperties: false },
    annotations: { title: 'Clear a layer', ...DESTRUCTIVE },
    coordinates: { out: ['bounds'] },
    handler: ({ layerId }) => c.clearLayer(layerId),
  });

  // --- Brushes -----------------------------------------------------------------
  // Listing, saving, sharing and previewing brushes are the brush library's tools
  // (createPaintBrushLibraryToolProvider); these two choose and change the brush strokes use.

  add({
    name: 'get_brush',
    title: 'Get a brush',
    description:
      "Reads a brush as facets (kind, medium, variety or tool, tip, marks, dynamics, behaviour, light, motion, colour: the brush library's form, as describe_brush returns it), with the engine it paints with and whether it is an unchanged built-in preset. Without id, the active brush as edited. Also returns strokePaint: what a stroke with it would paint now (its gradient colour, else the editor's paint from set_paint). Changes nothing.",
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Brush id from list_brush_presets (default the active brush).' } }, additionalProperties: false },
    annotations: { title: 'Get a brush', ...READ },
    handler: ({ id }) => {
      const st = c.getState();
      const b = id === undefined ? st.brush : c.getBrush(id);
      if (!b) c.setBrushFacets({}, id); // throws the unknown-id error with the closest ids
      const brush = b!;
      return { brush: c.getBrushSpec(id), engine: brush.engine, category: brush.category, builtin: Boolean(brush.builtin), strokePaint: brush.paint ?? st.paint };
    },
  });

  add({
    name: 'set_brush',
    title: 'Set the brush',
    description:
      "Chooses the active brush (id, from list_brush_presets) and / or changes it with facets laid over it (objects merge, lists and values replace, marks of another kind replace the marks; the brush library's create_brush fields); unset removes whole facets first (unset colour drops a brush's own gradient). Strokes without a brush use it. Editor state, not an undo step: the changes stay on the active brush until the library's create_brush or update_brush stores a brush. Returns the active brush as facets, the engine it paints with, and problems (values clamped or dropped).",
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Brush id from list_brush_presets to start from (default the active brush).' }, name: { type: 'string', minLength: 1, maxLength: 80, description: 'Display name.' }, ...BRUSH_PATCH_PROPERTIES, unset: BRUSH_UNSET_PROPERTY }, additionalProperties: false },
    annotations: { title: 'Set the brush', ...SET },
    handler: async ({ id, unset, ...patch }) => {
      const stamps = (patch.tip as { stamps?: string[] } | undefined)?.stamps;
      if (stamps) await c.prepareStickers(stamps);
      const r = c.setBrushFacets(patch as BrushPatch, id as string | undefined, unset as UnsettableBrushFacet[] | undefined);
      return { brush: r.spec, engine: r.brush.engine, problems: r.problems };
    },
  });

  // --- Colour and the Mixer Brush ----------------------------------------------

  add({
    name: 'set_color',
    title: 'Set the paint colour',
    description: "Sets the paint colour (and optionally the second colour) that strokes and fills use by default, and whether it is locked. Choosing a brush with a default colour (set_brush id, e.g. the highlighter's yellow) makes that the paint colour unless the colour is locked; a brush with colour.own always paints its own. Setting color goes back to one colour from gradient paint (set_paint) or effect paint (set_effect_paint). Editor state, not an undo step. Returns both colours and locked.",
    inputSchema: {
      type: 'object',
      properties: {
        color: { ...COLOR, description: 'Paint colour #rrggbb.' },
        secondaryColor: { ...COLOR, description: 'Second colour #rrggbb.' },
        locked: { type: 'boolean', description: "Lock the paint colour: brushes chosen later keep it instead of taking their default colour (default: unchanged; the editor starts unlocked)." },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Set the paint colour', ...SET },
    handler: ({ color, secondaryColor, locked }) => {
      if (color === undefined && secondaryColor === undefined && locked === undefined) throw new Error('Pass color, secondaryColor or locked.');
      if (color !== undefined) c.setColor(color);
      if (secondaryColor !== undefined) c.setSecondaryColor(secondaryColor);
      if (locked !== undefined) c.setColorLocked(locked as boolean);
      const s = c.getState();
      return { color: s.color, secondaryColor: s.secondaryColor, locked: s.colorLocked };
    },
  });

  add({
    name: 'set_paint',
    title: 'Set the paint (colour or gradient)',
    description:
      'Sets what strokes paint with: one colour, or gradient paint that changes colour as the stroke goes. Gradient paint: 2..16 stops sorted by offset (#rrggbb, or "paint" / "secondary" for the two editor colours), space pigment (default: mixes like paint) / oklab / srgb, and map: distance (default: the colour changes as the stroke is dragged out, 300 px then mirrored back), pressure, tilt, velocity, direction, time, across-tip or random. Every stroking brush samples it per dab (dab, mixer, watercolour and gouache, oil and impasto, particle, bristle, sticker); erasers, blenders and smudges ignore it, and a brush with its own gradient (get_brush paint) paints that instead. It also ends effect paint (set_effect_paint); set_color goes back to one colour. Editor state, not an undo step. Returns paint, color and secondaryColor.',
    inputSchema: { type: 'object', properties: { paint: PAINT_SOURCE_JSON_SCHEMA }, required: ['paint'], additionalProperties: false },
    annotations: { title: 'Set the paint (colour or gradient)', ...SET },
    handler: ({ paint }) => {
      const p = c.setPaint(paint);
      const s = c.getState();
      return { paint: p, color: s.color, secondaryColor: s.secondaryColor };
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
    coordinates: { in: [''] },
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
      'Paints one stroke through points (document pixels, with optional pressure, time, tilt and barrel rotation) on a pixel layer of the canvas with a library brush or the active one, optionally changed (by facets) for this stroke. Grain-responsive brushes follow the paper; the mixer engine (mixer-brush) picks up and mixes paint already on the layer, the blender mixes nearby colours, the smudge drags paint, and dab brushes with behavior.pickup lift and carry paint, and wet brushes (engine wet: watercolour, gouache, add water, dry, blow, wet blend, wet smudge, blot) paint on the layer’s wet layer, where the paint keeps moving until it dries (the result says wet: true while it is; see advance_wet_paint and dry_paint; a dry brush on wet paint dries it first; wet oil brushes blend into the wet oil they meet; with light.amount, as glow-wash has, their light flows with the paint), impasto brushes (engine impasto: impasto brush, paint tube, palette knife, roller, gloop pen, metallic paint) lay thick paint whose relief is lit by set_lighting, particle and bristle brushes draw procedural marks, sticker brushes spray editable stickers onto an empty or sticker layer (list_stickers), and antimatter brushes (engine antimatter: antimatter, antimatter-flare, antimatter-charge) detonate where they touch paint across every visible layer, inverting colours in the core, removing alpha, scorching a soot ring, denting thick relief, clearing core light, and throwing sparks on the active layer (returning antimatter: { blasts, sparks, fuel, layers, skippedLayers }). Guide stencils make strokes that start near them follow them; mask stencils keep paint inside them. The symmetry guide adds its mirror copies; with a tracing image that samples colours, a stroke without color takes the image colour at its first point. With an agent cursor (a director), the stroke is painted live along the points at the pace of their times. One undo step. Returns the layer id, changed bounds, dab count, the recorded strokeId (for replay_strokes), for wet brushes wet (paint still wet), for antimatter brushes antimatter, and, for brushes that pick up paint, mixerLoad: what the brush carries after the stroke.',
    inputSchema: {
      type: 'object',
      properties: {
        points: POINTS,
        layerId: LAYER_ID,
        brushId: { type: 'string', description: 'Brush id from list_brush_presets (default the active brush).' },
        brush: { type: 'object', description: 'Facets to change for this stroke only, laid over brushId or the active brush (as set_brush takes them).', properties: BRUSH_PATCH_PROPERTIES, additionalProperties: false },
        color: { ...COLOR, description: 'Paint colour #rrggbb (default the paint colour).' },
        paint: { ...PAINT_SOURCE_JSON_SCHEMA, description: "What this stroke paints with instead of the editor's paint: a colour, or gradient paint that changes colour as the stroke goes (by distance, pressure, tilt, speed, direction, time, across the tip or at random). Wins over the brush's own gradient." },
        seed: { type: 'integer', minimum: 0, description: 'Jitter seed (default a new one); the same seed and points give the same marks.' },
        snapToPerspective: { type: 'boolean', description: 'Snap the points to the perspective guide, as a pen stroke would (default false).' },
      },
      required: ['points'],
      additionalProperties: false,
    },
    annotations: { title: 'Paint a brush stroke', ...WRITE },
    coordinates: { in: ['points[]'], out: ['bounds'] },
    handler: async (a) => {
      await c.wetIdle();
      // Sticker brushes: load the stickers' art first, so the spray draws every one.
      const base = a.brushId ? c.getBrush(a.brushId as string) : c.getState().brush;
      const brush = a.brush ? c.brushChanges(a.brush as BrushPatch, a.brushId as string | undefined) : undefined;
      // Sticker sprays, stamp tips and textured dots of library stickers: load their art first.
      if (base) {
        const refs = brushStickerRefs(normalizePaintBrush({ ...(brush ?? {}), id: base.id }, base));
        if (refs.length) await c.prepareStickers(refs);
      }
      const stroke = { points: a.points as PenPoint[], layerId: a.layerId, brushId: a.brushId, brush, color: a.color, paint: a.paint, seed: a.seed, snapToPerspective: a.snapToPerspective };
      await c.prepareStrokePathEffect(stroke, [stroke.points]);
      const r = await act({ kind: 'stroke', stroke }, () => c.paintStroke(stroke));
      return r.mixerLoad ? { ...r, mixerLoad: loadResult(r.mixerLoad) } : r;
    },
  });

  add({
    name: 'stroke_path',
    title: 'Brush along a path',
    description:
      'Brushes vector path data (SVG path d in document pixels: M, L, H, V, C, S, Q, T, A and Z) on a pixel layer with a library brush or the active one, as if drawn by hand along it: the outline of a shape, a lettering guide, a curve from a vector tool. Each subpath becomes one recorded stroke, sampled every spacing px, with an optional pressure profile spread along each subpath (a taper such as [0.2, 1, 0.2]); closed subpaths end where they start. Brushes behave as in paint_stroke (grain, pick-up, wet and thick paint, guides off). With an agent cursor (a director), each subpath is painted live in turn. One undo step for the whole path. Returns the layer id, changed bounds, dab count and the recorded strokeIds (for replay_strokes, update_stroke).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'SVG path data in document pixels, e.g. "M 40 200 C 120 40 280 40 360 200". Several subpaths paint several strokes.' },
        spacing: { type: 'number', minimum: 0.25, maximum: 100, description: 'Distance between samples along the path in document pixels (default 2); the brush spaces its own dabs, so this only sets how closely curves are followed.' },
        pressure: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'number', minimum: 0, maximum: 1 }, description: 'Pen pressure along each subpath, spread evenly from start to end (default full pressure); [0.2, 1, 0.2] tapers both ends.' },
        speed: { type: 'number', minimum: 0.01, maximum: 100, description: 'Drawing speed in document pixels per millisecond (optional; gives each sample a time t so playback has a pace and speed-sensitive brushes respond).' },
        layerId: LAYER_ID,
        brushId: { type: 'string', description: 'Brush id from list_brush_presets (default the active brush).' },
        brush: { type: 'object', description: 'Facets to change for this stroke only, laid over brushId or the active brush (as set_brush takes them).', properties: BRUSH_PATCH_PROPERTIES, additionalProperties: false },
        color: { ...COLOR, description: 'Paint colour #rrggbb (default the paint colour).' },
        paint: { ...PAINT_SOURCE_JSON_SCHEMA, description: "What the strokes paint with instead of the editor's paint: a colour, or gradient paint that changes colour as each stroke goes." },
        seed: { type: 'integer', minimum: 0, description: 'Jitter seed of the first subpath, the next ones take the following seeds (default new ones); the same seed and path give the same marks.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { title: 'Brush along a path', ...WRITE },
    coordinates: { out: ['bounds'] },
    handler: async (a) => {
      await c.wetIdle();
      const base = a.brushId ? c.getBrush(a.brushId as string) : c.getState().brush;
      const brush = a.brush ? c.brushChanges(a.brush as BrushPatch, a.brushId as string | undefined) : undefined;
      if (base) {
        const refs = brushStickerRefs(normalizePaintBrush({ ...(brush ?? {}), id: base.id }, base));
        if (refs.length) await c.prepareStickers(refs);
      }
      // A hosted layer takes canvas coordinates: move the path into document pixels.
      const path = options.origin && typeof a.path === 'string' && a.path.trim() ? bezierPathToSvg(a.path, { offset: { x: -options.origin.x, y: -options.origin.y } }) : (a.path as string);
      const init = { path, spacing: a.spacing, pressure: a.pressure, speed: a.speed, layerId: a.layerId, brushId: a.brushId, brush, color: a.color, paint: a.paint, seed: a.seed };
      if (typeof path === 'string' && path.trim()) {
        try {
          const sampled = samplePath(path, init);
          await c.prepareStrokePathEffect(init, sampled);
        } catch {
          // Invalid path will be reported by strokePath / act below.
        }
      }
      const r = await act(
        () => {
          if (typeof path !== 'string' || !path.trim()) throw new PaintEditorError('path is empty; give SVG path data in document pixels, e.g. "M 10 10 C 40 0 80 60 120 30".');
          let subpaths: PenPoint[][];
          try {
            subpaths = samplePath(path, init);
          } catch (e) {
            throw new PaintEditorError(e instanceof Error ? e.message : String(e));
          }
          const { path: _path, spacing: _spacing, pressure: _pressure, speed: _speed, ...stroke } = init;
          return {
            kind: 'strokes' as const,
            label: `${base?.name ?? 'Brush'} path stroke`,
            strokes: subpaths.map((points, i) => ({
              ...stroke,
              ...(stroke.seed !== undefined ? { seed: (stroke.seed as number) + i } : {}),
              snapToPerspective: false,
              points,
            })),
          };
        },
        () => c.strokePath(init)
      );
      return r.mixerLoad ? { ...r, mixerLoad: loadResult(r.mixerLoad) } : r;
    },
  });

  add({
    name: 'get_live_stroke',
    title: 'Get the stroke being painted',
    description:
      'Reads the stroke the user is painting right now, if any: its layer, brush id and name, colour, and the pen samples so far (document pixels; at most the last `limit`). Returns live: false when no stroke is in progress. For agents that paint along with the user: hosts stream the same samples to them live (onStrokeSample); this is a snapshot.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 5000, description: 'Most recent samples to return (default 500).' } },
      additionalProperties: false,
    },
    annotations: { title: 'Get the stroke being painted', ...READ },
    handler: (args) => {
      const live = c.getLiveStroke();
      if (!live) return { live: false };
      const limit = args.limit ?? 500;
      return { live: true, layerId: live.layerId, brushId: live.brushId, brushName: live.brushName, color: live.color, total: live.points.length, points: live.points.slice(-limit) };
    },
  });

  add({
    name: 'list_strokes',
    title: 'List recorded strokes',
    description:
      'Lists the recorded strokes, oldest first (every stroke is kept as data): id, layer, brush id and name, colour, point count, bounds, seed and whether it is live. With ids, also the points. Use the ids with replay_strokes. With live true, lists the strokes of stroke layers as they are now, bottom first: the ones update_stroke, edit_stroke_points, reorder_stroke and remove_strokes change.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string', description: 'Stroke id.' }, description: 'Only these strokes, with their points.' },
        last: { type: 'integer', minimum: 1, maximum: 1000, description: 'Only the most recent n strokes (default 100).' },
        live: { type: 'boolean', description: 'Only the editable strokes of stroke layers, as they are now, bottom first (default false: the whole recorded history).' },
        layerId: { type: 'string', description: 'Only strokes of this layer.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List recorded strokes', ...READ },
    coordinates: { out: ['strokes[].bounds', 'strokes[].points[]'] },
    handler: ({ ids, last, live, layerId }) => {
      if (layerId !== undefined && !c.getLayer(layerId)) throw new Error(`Unknown layer "${layerId}". Call list_layers for the ids.`);
      const liveAll = Object.values(c.document.liveStrokes ?? {}).flat();
      const liveIds = new Set(liveAll.map((s) => s.id));
      let all: readonly RecordedStroke[] = live ? liveAll : c.getStrokes();
      if (layerId !== undefined) all = all.filter((s) => s.layerId === layerId);
      const picked = ids ? all.filter((s) => ids.includes(s.id)) : all.slice(-(last ?? 100));
      if (ids) for (const id of ids) if (!all.some((s) => s.id === id)) throw new Error(`Unknown stroke "${id}". Call list_strokes without ids for the ids.`);
      return { total: all.length, strokes: picked.map((s) => strokeSummary(s, Boolean(ids), live ? true : liveIds.has(s.id) && c.document.liveStrokes?.[s.layerId]?.includes(s) === true)) };
    },
  });

  add({
    name: 'stroke_at',
    title: 'Find the stroke at a point',
    description: 'Returns the top-most stroke of a stroke layer that painted the pixel at a point (document pixels), or stroke null when none did, so you can pick one stroke among overlapping ones before update_stroke, edit_stroke_points or remove_strokes. Changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        layerId: { type: 'string', description: 'Stroke layer id from list_layers (default the active layer).' },
        x: { type: 'number', description: 'Point x in document pixels.' },
        y: { type: 'number', description: 'Point y in document pixels.' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    annotations: { title: 'Find the stroke at a point', ...READ },
    coordinates: { in: [''], out: ['stroke.bounds'] },
    handler: ({ layerId, x, y }) => {
      const s = c.liveStrokeAt(layerId, x, y);
      return { stroke: s ? strokeSummary(s, false, true) : null };
    },
  });

  add({
    name: 'update_stroke',
    title: 'Change a stroke',
    description:
      'Changes a stroke on a stroke layer after it was painted: another brush preset (brushId, keeping the stroke size), brush settings (as set_brush takes), colour (replaces gradient paint), paint, or seed, then redraws the layer exactly. Ids come from list_strokes {live: true}. Refuses brushes a stroke layer cannot redraw (wet, impasto, sticker, eraser, smudge, blender, pick-up). One undo step. Returns the stroke and the area that changed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stroke id from list_strokes {live: true}.' },
        brushId: { type: 'string', description: 'Brush id from list_brush_presets; the stroke keeps its size.' },
        brush: { type: 'object', properties: BRUSH_PATCH_PROPERTIES, additionalProperties: false, description: 'Facets to change on top of brushId or the stroke’s brush (as set_brush takes them); missing fields keep their values.' },
        color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'New colour #rrggbb (replaces gradient paint).' },
        paint: { anyOf: [PAINT_SOURCE_JSON_SCHEMA, { type: 'null', description: 'Back to the stroke’s plain colour.' }], description: 'A colour or gradient paint for the stroke; null drops its gradient.' },
        seed: { type: 'integer', minimum: 0, description: 'Another jitter seed: particles, scatter and texture fall differently.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { title: 'Change a stroke', ...WRITE },
    coordinates: { out: ['bounds', 'stroke.bounds'] },
    handler: ({ id, ...update }) => {
      if (!Object.keys(update).length) throw new Error('Pass at least one change: brushId, brush, color, paint or seed.');
      if (update.brush) {
        const stroke = Object.values(c.document.liveStrokes ?? {}).flat().find((s) => s.id === id);
        if (!stroke) throw new Error(`Unknown stroke "${id}" on a stroke layer. Call list_strokes {live: true} for the ids.`);
        update.brush = c.brushChanges(update.brush as BrushPatch, (update.brushId as string | undefined) ?? stroke.brush);
      }
      const r = c.updateStroke(id, update);
      return { stroke: strokeSummary(r.stroke, false, true), bounds: r.bounds };
    },
  });

  add({
    name: 'edit_stroke_points',
    title: 'Move or reshape a stroke',
    description:
      'Replaces a stroke’s points (points, document pixels), or moves, scales, rotates or flips it (transform, about its centre unless origin is given; the brush size scales with it), then redraws its stroke layer exactly. Pass one of points or transform. One undo step. Returns the stroke with its points and the area that changed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stroke id from list_strokes {live: true}.' },
        points: POINTS,
        transform: {
          type: 'object',
          description: 'A move, scale, rotation or flip of the whole stroke.',
          properties: {
            dx: { type: 'number', description: 'Move right by this many pixels (default 0).' },
            dy: { type: 'number', description: 'Move down by this many pixels (default 0).' },
            scale: { type: 'number', exclusiveMinimum: 0, maximum: 20, description: 'Scale about the origin; brush size scales too (default 1).' },
            rotate: { type: 'number', minimum: -360, maximum: 360, description: 'Rotate about the origin, degrees clockwise (default 0).' },
            flipX: { type: 'boolean', description: 'Mirror left to right about the origin (default false).' },
            origin: { type: 'object', description: 'Centre for scale, rotate and flip (default the centre of the stroke).', properties: { x: { type: 'number', description: 'Document x.' }, y: { type: 'number', description: 'Document y.' } }, required: ['x', 'y'], additionalProperties: false },
          },
          additionalProperties: false,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { title: 'Move or reshape a stroke', ...WRITE },
    coordinates: { in: ['points[]', 'transform.origin'], out: ['bounds', 'stroke.bounds', 'stroke.points[]'] },
    handler: async ({ id, points, transform }) => {
      await c.prepareStrokeEdit(id, { points, transform });
      const r = c.editStrokePoints(id, { points, transform });
      return { stroke: strokeSummary(r.stroke, true, true), bounds: r.bounds };
    },
  });

  add({
    name: 'reorder_stroke',
    title: 'Move a stroke up or down',
    description: 'Moves a stroke to index in its stroke layer (0 = bottom, drawn first) and redraws the layer. One undo step. Returns the new order of ids, bottom first.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Stroke id from list_strokes {live: true}.' }, index: { type: 'integer', minimum: 0, description: 'New position, 0 = bottom.' } },
      required: ['id', 'index'],
      additionalProperties: false,
    },
    annotations: { title: 'Move a stroke up or down', ...WRITE },
    handler: ({ id, index }) => ({ order: c.reorderStroke(id, index) }),
  });

  add({
    name: 'remove_strokes',
    title: 'Delete strokes',
    description: 'Deletes strokes from their stroke layers (the eraser of a stroke layer) and redraws them. All checked first; one undo step. Returns the ids removed and the area that changed.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', minItems: 1, items: { type: 'string', description: 'Stroke id.' }, description: 'Stroke ids from list_strokes {live: true}.' } },
      required: ['ids'],
      additionalProperties: false,
    },
    annotations: { title: 'Delete strokes', ...DESTRUCTIVE },
    coordinates: { out: ['bounds'] },
    handler: ({ ids }) => c.removeStrokes(ids),
  });

  add({
    name: 'convert_to_stroke_layer',
    title: 'Make a layer a stroke layer',
    description: 'Makes an empty pixel layer a stroke layer, so strokes painted on it stay editable. Refuses a layer with paint (add_layer {type: "strokes"} instead). One undo step. Returns the layer.',
    inputSchema: { type: 'object', properties: { layerId: { type: 'string', description: 'Layer id from list_layers (default the active layer).' } }, additionalProperties: false },
    annotations: { title: 'Make a layer a stroke layer', ...WRITE },
    coordinates: { out: ['bounds'] },
    handler: ({ layerId }) => c.convertToLiveStrokes(layerId),
  });

  add({
    name: 'rasterize_stroke_layer',
    title: 'Rasterize a stroke layer',
    description: 'Turns a stroke layer into a plain pixel layer with the same pixels: its strokes stop being editable, and erasers, smudges and fills work on it. One undo step. Returns the layer.',
    inputSchema: { type: 'object', properties: { layerId: { type: 'string', description: 'Stroke layer id from list_layers (default the active layer).' } }, additionalProperties: false },
    annotations: { title: 'Rasterize a stroke layer', ...DESTRUCTIVE },
    coordinates: { out: ['bounds'] },
    handler: ({ layerId }) => c.rasterizeLiveStrokes(layerId),
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
        brushId: { type: 'string', description: 'Replay with this brush from list_brush_presets (default each stroke’s brush).' },
        layerId: { type: 'string', description: 'Paint on this layer (default each stroke’s layer).' },
        repeat: { type: 'integer', minimum: 1, maximum: 100, description: 'How many copies (default 1).' },
      },
      required: ['strokeIds'],
      additionalProperties: false,
    },
    annotations: { title: 'Replay strokes, varied', ...WRITE },
    coordinates: { in: ['origin'], out: ['bounds'] },
    handler: async (a) => {
      const replay = a as Parameters<PaintEditorController['replayStrokes']>[0];
      // Strokes painted with effect paint need it rendered first (unless recoloured).
      if (replay.color === undefined) await c.prepareStrokeEffects(replay.strokeIds, replay);
      return act({ kind: 'replay', replay }, () => c.replayStrokes(replay));
    },
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
    description: 'Exports the painting as PNG, JPEG or WebP (base64). JPEG always includes the paper; JPEG and WebP need a browser canvas. With time, live effect paint is drawn at that moment (get_effect_playback / set_effect_playback). Changes nothing. Returns the data, its MIME type and size.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'], description: 'File type (default image/png).' },
        quality: { type: 'number', minimum: 0, maximum: 1, description: 'JPEG / WebP quality 0..1 (default 0.92).' },
        scale: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Shrink by this factor (default 1).' },
        paper: { type: 'boolean', description: 'Include the paper (default true).' },
        time: TIME,
      },
      additionalProperties: false,
    },
    annotations: { title: 'Export the painting', ...READ },
    handler: async ({ format, quality, scale, paper, time }) => {
      const run = () => c.exportImage({ format, quality, scale, paper });
      const bytes = time === undefined ? await run() : await c.withEffectTime(time, run);
      return { mimeType: format ?? 'image/png', bytes: bytes.length, data: bytesToBase64(bytes) };
    },
  });

  add({
    name: 'export_psd',
    title: 'Export as PSD',
    description:
      'Writes the painting as an 8-bit RGB PSD (PSB above 30000 px) through the shared PSD writer: every layer and group with its opacity, blend, mask and locks, the paper as a locked "Paper" pixel layer at the bottom, and the composite as the merged image. Changes nothing. Returns the file as base64, its size, whether it is a PSB, and warnings (pigment and painterly blend modes have no PSD equivalent: they are written as the nearest standard mode, see list_blend_modes).',
    inputSchema: { type: 'object', properties: { time: TIME }, additionalProperties: false },
    annotations: { title: 'Export as PSD', ...READ },
    handler: async ({ time }) => {
      const r = time === undefined ? c.exportPsd() : await c.withEffectTime(time, () => c.exportPsd());
      return { data: bytesToBase64(r.bytes), bytes: r.bytes.length, psb: r.psb, warnings: r.warnings };
    },
  });

  tools.push(...createPaintGuideTools(c));
  tools.push(...createPaintWetTools(c));
  tools.push(...createPaintThickTools(c));
  tools.push(...createFerroTools(c));
  tools.push(...createPaintReplayTools(c));
  tools.push(...createPaintEvolutionTools(c));
  tools.push(...createPaintStickerTools(c));
  tools.push(...createMutationTools(c, { director: options.director, actor: options.actor }));
  tools.push(...createPigmentTools());
  // The sticker library (the editor's own stamps unless the host set one): refs for sticker brushes and add_stickers.
  tools.push(...createStickerTools({ provider: () => c.stickersProvider }));
  // Layer styles: the image editor's tools, schemas and defaults on paint layers (no global light of its own).
  tools.push(
    ...createLayerEffectTools(
      {
        requireLayer: (id) => void c.getLayerEffects(id),
        getLayerEffects: (id) => c.getLayerEffects(id),
        addLayerEffect: (id, kind, settings, index) => c.addLayerEffect(id, kind, settings, index),
        updateLayerEffect: (id, effectId, changes) => c.updateLayerEffect(id, effectId, changes),
        removeLayerEffect: (id, effectId) => c.removeLayerEffect(id, effectId),
        setLayerEffectsEnabled: (id, enabled, scale) => c.setLayerEffectsEnabled(id, enabled, scale),
      },
      { layers: 'a pixel, stroke, sticker or group layer', error: (m) => new PaintEditorError(m) }
    )
  );

  const exclude = new Set(options.exclude ?? []);
  const description = 'Natural-media painting: paper and grain, dry and wet brushes, the brush library, strokes as data, pigment mixing, stencils, guides, layers and export.';
  return withPaintPlayback({
    id: options.id ?? 'paint-editor',
    namespace: options.namespace,
    title: 'Paint editor',
    description: options.origin ? `${description} It is a layer of a larger canvas: every position is in canvas coordinates.` : description,
    skill: 'pixerate-paint-editor',
    tools: tools.filter((t) => !exclude.has(t.name)).map((t) => hostTool(t, options)),
  }, { director: !!options.director, surface: options.playbackSurface });
}

/** Applies `origin` (positions in and out, host wording) and `onChange` to one tool. */
function hostTool({ coordinates, ...tool }: PaintAgentTool, { origin, onChange }: PaintEditorToolProviderOptions): AgentTool {
  if (!origin && !onChange) return tool;
  const write = !tool.annotations?.readOnlyHint;
  const done = (result: unknown) => {
    if (write) onChange?.({ tool: tool.name });
    return origin && coordinates?.out ? fromDocument(result, coordinates.out, origin) : result;
  };
  return {
    ...tool,
    ...(origin ? { description: hostedText(tool.description ?? ''), inputSchema: hostedSchema(tool.inputSchema) } : {}),
    handler: (args, context) => {
      const r = tool.handler(origin && coordinates?.in ? toDocument(args, coordinates.in, origin) : args, context);
      return r instanceof Promise ? r.then(done) : done(r);
    },
  };
}

/** A stroke as tools return it: its points (or how many), bounds and whether it is live (editable). */
function strokeSummary(s: RecordedStroke, withPoints: boolean, live: boolean) {
  const xs = s.points.map((p) => p.x);
  const ys = s.points.map((p) => p.y);
  const pad = s.brush.tip.size / 2;
  return {
    id: s.id,
    layerId: s.layerId,
    brushId: s.brush.id,
    brushName: s.brush.name,
    color: s.color,
    points: withPoints ? s.points : s.points.length,
    seed: s.seed,
    copies: s.copies?.length ?? 0,
    live,
    bounds: { x: Math.floor(Math.min(...xs) - pad), y: Math.floor(Math.min(...ys) - pad), width: Math.ceil(Math.max(...xs) - Math.min(...xs) + 2 * pad), height: Math.ceil(Math.max(...ys) - Math.min(...ys) + 2 * pad) },
  };
}
