/**
 * Agent tools for wet media (watercolour and gouache on a simulated wet layer). Wet strokes are
 * painted with `paint_stroke` and a wet brush (`list_brush_presets` variety `watercolor` or
 * `wet-tool`); these tools read and steer the wet paint. Every result says whether paint is still
 * wet. Settings (wet parameters, flow maps, tilt) are saved with the document but are not undo
 * steps; drying and wetting the paper are.
 */

import { WET_FLOW_KINDS } from '../paint/wet/flow';
import { LIVE_PATTERN_KINDS } from '../paint/live-patterns';
import type { PaintAgentTool } from './hosted';
import type { PaintEditorController } from './controller';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const SET = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const EMPTY = { type: 'object', properties: {}, additionalProperties: false } as const;
const LAYER_ID = { type: 'string', description: 'Pixel layer id from list_layers (default the active layer).' } as const;
const RECT = {
  type: 'object',
  description: 'A rectangle in document pixels.',
  properties: {
    x: { type: 'number', description: 'Left edge, document pixels.' },
    y: { type: 'number', description: 'Top edge, document pixels.' },
    width: { type: 'number', exclusiveMinimum: 0, description: 'Width in pixels.' },
    height: { type: 'number', exclusiveMinimum: 0, description: 'Height in pixels.' },
  },
  required: ['x', 'y', 'width', 'height'],
  additionalProperties: false,
} as const;

const UNIT = (d: string) => ({ type: 'number', minimum: 0, maximum: 1, description: d }) as const;

export const WET_PARAM_SCHEMA = {
  viscosity: UNIT('How thick the water is: 0 runny like ink .. 1 very thick (default 0.3, watercolour).'),
  evaporation: UNIT('How fast it dries: 0 never .. 1 very fast (default 0.45).'),
  edgeDarkening: UNIT('Darker rims where a wash dries (default 0.5).'),
  pigmentWeight: UNIT('Heavy pigment travels less and settles sooner (default 0.3).'),
  granulation: UNIT('Pigment collecting in the paper’s valleys, a grainy look (default 0.4; needs a rough paper).'),
  pickup: UNIT('How readily water lifts settled pigment again (default 0.2).'),
  fixture: UNIT('How fast pigment settles into the paper while wet, i.e. staining (default 0.2).'),
  bloom: UNIT('Blooms: water running into a drying wash pushes its pigment into cauliflower edges (default 0.4).'),
  bleed: UNIT('Colour bleed between touching wet areas (default 0.3).'),
} as const;

export const LIVE_PATTERN_SCHEMA = {
  pattern: {
    type: 'string',
    enum: [...LIVE_PATTERN_KINDS],
    description: 'Pearson Gray-Scott preset: spots, stripes, coral, maze or worms (default spots). Sets feed and kill unless explicit feed/kill are also passed.',
  },
  feed: {
    type: 'number',
    minimum: 0.005,
    maximum: 0.1,
    description: 'Gray-Scott feed rate F, 0.005..0.1 (default: the pattern preset’s feed rate).',
  },
  kill: {
    type: 'number',
    minimum: 0.02,
    maximum: 0.08,
    description: 'Gray-Scott kill rate k, 0.02..0.08 (default: the pattern preset’s kill rate).',
  },
  scale: {
    type: 'number',
    minimum: 0.25,
    maximum: 4,
    description: 'Diffusion scale 0.25..4 (larger values grow broader pattern features; default 1).',
  },
  contrast: {
    type: 'number',
    minimum: 0,
    maximum: 2,
    description: 'How strongly V modulates the wet pigment or blends toward secondColor, 0..2 (default 0.85).',
  },
  secondColor: {
    type: ['string', 'null'],
    pattern: '^#[0-9a-fA-F]{6}$',
    description: 'Optional #rrggbb colour that high-V pattern ridges blend toward, or null to modulate pigment contrast (default null).',
  },
  relief: UNIT('Impasto ridge height 0..1 written from V into the layer’s thick height map so light catches the pattern (default 0).'),
} as const;

export function createPaintWetTools(c: PaintEditorController): PaintAgentTool[] {
  const stillWet = () => c.wetState().wet;
  return [
    {
      name: 'get_wet_paint',
      title: 'Get the wet paint',
      description:
        'Reads the wet media: whether any paint is still wet, the simulation clock (steps), whether time is paused, its speed (steps per second), the canvas tilt, the kernel running it (typescript, wasm, wasm-threads with the thread count, and a message when it runs slower than it could, e.g. without cross-origin isolation), and each wet layer: wet cells, where the water is (wetBounds), live tiles, its settings and flow map. Also engine: Engine B, the GPU accelerator: WebGPU in browsers, Metal in the Swift editors (mode auto/off, state, reason, adapter, minTiles, activeTiles). Call it after wet strokes to see what is still wet.',
      inputSchema: EMPTY,
      annotations: { title: 'Get the wet paint', ...READ },
      coordinates: { out: ['layers[].wetBounds', 'layers[].flow.center'] },
      handler: () => c.wetState(),
    },
    {
      name: 'advance_wet_paint',
      title: 'Let the wet paint flow',
      description:
        'Lets time pass for wet paint: the water spreads, runs downhill on a tilted canvas, granulates, blooms and evaporates, and pigment settles. Give steps (simulation steps; at the default 120 per second, 120 steps is one second) or seconds (default 1). Not an undo step, as time passing never is. Returns the steps run, the clock, stillWet and each wet layer’s state. Paint dries by itself after a few thousand steps; dry_paint dries it at once. Wet light paint (wet brushes with light.amount) flows with the pigment and settles where it dries into the layer’s light (get_light).',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'integer', minimum: 0, maximum: 100000, description: 'Simulation steps to run (default: seconds × speed).' },
          seconds: { type: 'number', minimum: 0, maximum: 600, description: 'Seconds of simulated time at the current speed (default 1; ignored when steps is given).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Let the wet paint flow', ...WRITE },
      handler: async ({ steps, seconds }) => {
        await c.wetIdle();
        return c.advanceWet({ steps, seconds });
      },
    },
    {
      name: 'dry_paint',
      title: 'Dry the wet paint',
      description:
        'Dries wet paint at once: everything settles where it is and the water goes, as a hair dryer at full blast would (the same deterministic bake that saving uses). On one layer or every wet layer, optionally only inside rect. Dried washes stay put: later washes glaze over them instead of mixing in. One undo step. Returns dried (each layer id with the rectangle that dried) and stillWet.',
      inputSchema: { type: 'object', properties: { layerId: { type: 'string', description: 'Only this layer (default every wet layer).' }, rect: RECT }, additionalProperties: false },
      annotations: { title: 'Dry the wet paint', ...WRITE },
      coordinates: { in: ['rect'], out: ['dried[].bounds'] },
      handler: async ({ layerId, rect }) => {
        await c.wetIdle();
        return c.dryPaint({ layerId, rect });
      },
    },
    {
      name: 'wet_paper',
      title: 'Pre-wet the paper',
      description:
        'Wets the paper with clear water over rect (default the whole canvas) on a layer, for wet-in-wet: paint laid on damp paper spreads softly with feathered edges instead of stopping at a hard edge. One undo step. Returns the layer id, the rectangle and wet: true. The paper dries again over time (advance_wet_paint) or at once (dry_paint).',
      inputSchema: {
        type: 'object',
        properties: { layerId: LAYER_ID, rect: RECT, amount: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'How wet, 0..1 (default 1: soaked).' } },
        additionalProperties: false,
      },
      annotations: { title: 'Pre-wet the paper', ...WRITE },
      coordinates: { in: ['rect'], out: ['rect'] },
      handler: async ({ layerId, rect, amount }) => {
        await c.wetIdle();
        return c.wetPaper({ layerId, rect, amount });
      },
    },
    {
      name: 'set_wet_settings',
      title: 'Set a layer’s wet settings',
      description:
        'Changes how wet paint behaves on a layer: viscosity, evaporation, edge darkening, pigment weight, granulation, pickup (re-wetting), fixture (staining), blooms and colour bleed, each 0..1. Missing fields keep their values. Applies to the paint already wet too. Saved with the document, not an undo step. Returns the settings and stillWet.',
      inputSchema: { type: 'object', properties: { layerId: LAYER_ID, ...WET_PARAM_SCHEMA }, additionalProperties: false },
      annotations: { title: 'Set a layer’s wet settings', ...SET },
      handler: async ({ layerId, ...params }) => {
        await c.wetIdle();
        return { layerId: layerId ?? c.document.activeLayerId, params: c.setWetParams(layerId, params), stillWet: stillWet() };
      },
    },
    {
      name: 'set_flow_map',
      title: 'Set a flow map',
      description:
        'Pushes a layer’s water in a pattern while it is wet: linear (one direction, angle), swirl (around center, clockwise or not), radial (out from center) or turbulent (eddies of scale pixels, seeded), at strength 0..1; none turns it off. Saved with the document, not an undo step. Returns the flow map and stillWet.',
      inputSchema: {
        type: 'object',
        properties: {
          layerId: LAYER_ID,
          kind: { type: 'string', enum: [...WET_FLOW_KINDS], description: 'none, linear, swirl, radial or turbulent.' },
          strength: UNIT('How hard it pushes, 0..1 (1 is about a 25° tilt; default 0.5).'),
          angle: { type: 'number', minimum: -360, maximum: 360, description: 'linear: direction in degrees clockwise from canvas down (default 0).' },
          center: {
            type: 'object',
            description: 'swirl / radial: centre in document pixels (default the canvas centre).',
            properties: { x: { type: 'number', description: 'Document x.' }, y: { type: 'number', description: 'Document y.' } },
            required: ['x', 'y'],
            additionalProperties: false,
          },
          clockwise: { type: 'boolean', description: 'swirl: turn clockwise (default true).' },
          scale: { type: 'number', minimum: 8, maximum: 1024, description: 'turbulent: eddy size in pixels (default 120).' },
          seed: { type: 'integer', minimum: 0, description: 'turbulent: pattern seed (default 1).' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
      annotations: { title: 'Set a flow map', ...SET },
      coordinates: { in: ['center'], out: ['flow.center'] },
      handler: async ({ layerId, ...flow }) => {
        await c.wetIdle();
        return { layerId: layerId ?? c.document.activeLayerId, flow: c.setFlowMap(layerId, flow), stillWet: stillWet() };
      },
    },
    {
      name: 'set_canvas_tilt',
      title: 'Tilt the canvas',
      description:
        'Tilts the canvas so wet paint runs downhill: angle 0 (flat) .. 90 (upright) degrees, direction the way down in degrees clockwise from the canvas bottom (0 runs towards the bottom edge, 90 towards the left). Steep tilts with very wet paint make drips. Saved with the document, not an undo step. Returns the tilt and stillWet.',
      inputSchema: {
        type: 'object',
        properties: {
          angle: { type: 'number', minimum: 0, maximum: 90, description: 'Degrees from flat (default unchanged).' },
          direction: { type: 'number', minimum: -360, maximum: 360, description: 'Downhill direction, degrees clockwise from canvas down (default unchanged).' },
        },
        additionalProperties: false,
      },
      annotations: { title: 'Tilt the canvas', ...SET },
      handler: async ({ angle, direction }) => {
        await c.wetIdle();
        return { tilt: c.setCanvasTilt({ angle, direction }), stillWet: stillWet() };
      },
    },
    {
      name: 'pause_wet_paint',
      title: 'Pause or resume wet paint',
      description: 'Stops time for wet paint (it stays wet and still) or lets it run again, and optionally sets the speed in steps per second. Editor state, not an undo step. Returns paused, speed and stillWet.',
      inputSchema: {
        type: 'object',
        properties: {
          paused: { type: 'boolean', description: 'true stops time, false resumes it.' },
          speed: { type: 'number', minimum: 1, maximum: 2000, description: 'Steps per second while running (default unchanged; 120 at start).' },
        },
        required: ['paused'],
        additionalProperties: false,
      },
      annotations: { title: 'Pause or resume wet paint', ...SET },
      handler: ({ paused, speed }) => {
        c.setWetPaused(paused);
        if (speed !== undefined) c.setWetSpeed(speed);
        const s = c.getState().wet;
        return { paused: s.paused, speed: s.speed, stillWet: s.wet };
      },
    },
    {
      name: 'set_wet_engine',
      title: 'Choose the wet-media engine',
      description:
        'Lets Engine B, the GPU accelerator (WebGPU in browsers, Metal in the Swift editors), run for large wet areas (gpu "auto", the default) or forces the CPU (gpu "off"), and optionally sets minTiles, the wet area at which the GPU takes over. The GPU only shades what is shown: the CPU engine stays the authority, so the painting, drying, saving, export and replay come out the same either way; force the CPU when the display looks wrong or the GPU is busy with other work. Editor setting, not an undo step, not saved with the painting. Returns the engine: mode, state (off, not-started, starting, unavailable, standby, active, failed), reason, adapter, maxTiles, minTiles and activeTiles.',
      inputSchema: {
        type: 'object',
        properties: {
          gpu: { type: 'string', enum: ['auto', 'off'], description: '"auto": use the GPU when there is one and the wet area is large; "off": the CPU only.' },
          minTiles: { type: 'integer', minimum: 1, maximum: 1024, description: 'Live 256 px tiles (all wet layers) at which the GPU takes over (default unchanged; 16 at start, a fully wet 1024² canvas).' },
        },
        required: ['gpu'],
        additionalProperties: false,
      },
      annotations: { title: 'Choose the wet-media engine', ...SET },
      handler: async ({ gpu, minTiles }) => ({ engine: await c.setWetEngine({ gpu, minTiles }) }),
    },
    {
      name: 'set_water_overlay',
      title: 'Show the water',
      description: 'Shows or hides the water overlay on the canvas (blue where the surface is wet, fainter where the paper is damp). View only, never in exports. Returns visible and stillWet.',
      inputSchema: { type: 'object', properties: { visible: { type: 'boolean', description: 'Show (true) or hide (false) the overlay.' } }, required: ['visible'], additionalProperties: false },
      annotations: { title: 'Show the water', ...SET },
      handler: ({ visible }) => ({ visible: c.setWaterOverlay(visible), stillWet: stillWet() }),
    },
    {
      name: 'get_live_patterns',
      title: 'Get live patterns',
      description:
        'Reads the Gray-Scott reaction-diffusion live patterns on a layer (layerId, default the active layer): whether live patterns are enabled, the active settings (pattern, feed, kill, scale, contrast, secondColor, relief), activeTiles, patternCells, wetPatternCells (pattern cells still holding water where the pattern can grow), meanV, maxV, bounds, wet coverage (wet, wetCells, wetBounds), layers (every layer with wet paint or live patterns), and presets (built-in Pearson feed/kill presets: spots, stripes, coral, maze, worms). Call it before or after advance_wet_paint and dry_paint to inspect pattern growth and freezing.',
      inputSchema: { type: 'object', properties: { layerId: LAYER_ID }, additionalProperties: false },
      annotations: { title: 'Get live patterns', ...READ },
      coordinates: { out: ['wetBounds', 'bounds', 'layers[].wetBounds', 'layers[].bounds'] },
      handler: ({ layerId }) => c.getLivePatterns(layerId),
    },
    {
      name: 'set_live_patterns',
      title: 'Set live patterns',
      description:
        'Configures a layer’s Gray-Scott reaction-diffusion live patterns (or clears them with enabled: false). Patterns grow inside wet paint during advance_wet_paint and freeze when the paint dries (dry_paint). Choose a Pearson preset (spots, stripes, coral, maze, worms) or explicit feed and kill rates, scale, contrast, secondColor (#rrggbb or null to modulate pigment contrast) and relief (0..1, writes ridge height into thick paint so lighting catches the pattern). One undo step. Returns the layer’s live-pattern stats and stillWet.',
      inputSchema: {
        type: 'object',
        properties: {
          layerId: LAYER_ID,
          enabled: { type: 'boolean', description: 'true (default) configures live patterns on the layer; false clears them.' },
          ...LIVE_PATTERN_SCHEMA,
        },
        additionalProperties: false,
      },
      annotations: { title: 'Set live patterns', ...SET },
      coordinates: { out: ['wetBounds', 'bounds'] },
      handler: async ({ layerId, ...update }) => {
        await c.wetIdle();
        return { ...c.setLivePatterns(layerId, update), stillWet: stillWet() };
      },
    },
    {
      name: 'seed_live_patterns',
      title: 'Seed live patterns',
      description:
        'Seeds Gray-Scott reaction-diffusion activator (V) discs at points on a layer so reaction-diffusion patterns (spots, stripes, coral, maze, worms) grow where the layer holds wet water (advance_wet_paint) and freeze where it dries (dry_paint). Painting with a wet brush that has a livePatterns facet (such as preset "turing-wash" or "coral-ink") also seeds along the stroke automatically. One undo step. Returns seededCells, the layer’s live-pattern stats (patternCells, wetPatternCells, meanV, maxV, bounds) and stillWet.',
      inputSchema: {
        type: 'object',
        properties: {
          layerId: LAYER_ID,
          points: {
            type: 'array',
            minItems: 1,
            maxItems: 1024,
            description: 'Seed centres in document pixels where reaction-diffusion activator V is nucleated.',
            items: {
              type: 'object',
              properties: {
                x: { type: 'number', description: 'Document x in pixels.' },
                y: { type: 'number', description: 'Document y in pixels.' },
                strength: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: 'Seed strength 0..1 (default 1).' },
              },
              required: ['x', 'y'],
              additionalProperties: false,
            },
          },
          radius: { type: 'number', minimum: 1, maximum: 512, description: 'Seed disc radius in document pixels (default 16).' },
          seed: { type: 'integer', minimum: 0, description: 'Deterministic noise seed for the nucleated discs (default: next editor seed).' },
          ...LIVE_PATTERN_SCHEMA,
        },
        required: ['points'],
        additionalProperties: false,
      },
      annotations: { title: 'Seed live patterns', ...WRITE },
      coordinates: { in: ['points'], out: ['wetBounds', 'bounds'] },
      handler: async (args) => {
        await c.wetIdle();
        return { ...c.seedLivePatterns(args as Parameters<typeof c.seedLivePatterns>[0]), stillWet: stillWet() };
      },
    },
  ];
}
