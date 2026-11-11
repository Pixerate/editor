/**
 * The paint editor as language-neutral contracts (`@pixerate/conformance` `domains/paint`), so
 * another implementation (the Swift port) offers the same tools, keys, controls and documents:
 * the agent tools of every paint provider, the keyboard commands, the UI tables React and Svelte
 * render, and a JSON Schema of a saved painting. `scripts/export-contracts.mjs` writes them; a
 * core test fails when the committed files differ from what this returns.
 *
 * Everything here is data from this module's own tables and providers; nothing depends on the
 * package version, so a release does not change the files.
 */

import type { EffectProvider } from '../effects/types';
import { BRUSH_OPTION_CONTROLS } from '../image-editor/layers/paint-ui';
import { EDITOR_DOCUMENT_FORMAT, toEditorDocumentFile } from '../persistence/editorDocument';
import { defaultLayerEffect, LAYER_EFFECT_KINDS } from '../raster/effects/model';
import { LAYER_EFFECT_MENU, layerEffectControls } from '../raster/effects/ui';
import type { ConformanceHost } from '../tools/conformance';
import { ToolRegistry, type AgentToolProvider } from '../tools/registry';
import type { JsonSchema } from '../tools/schema';
import { createPaintBrushLibraryToolProvider } from './brush-library-tools';
import { createPaintProposalToolProvider } from './collaboration-tools';
import { createPaintProposals } from './collaboration';
import { PaintEditorController, type PaintEditorOptions } from './controller';
import { createPaintEditorDocument } from './editorDocument';
import { createPaintEffectsToolProvider } from './effect-tools';
import { createPaintEffectAuthoringToolProvider } from './effect-authoring-tools';
import { PAINT_FORMAT, PAINT_SCHEMA_VERSION } from './serialize';
import { createPaintEditorToolProvider } from './tools';
import { combineStickerProviders } from '../stickers/combine';
import { editorStickers } from '../stickers/editor';
import { createFakeStickerProvider } from '../stickers/fake';
import type { StickerProvider } from '../stickers/types';
import {
  AGE_SLIDERS,
  ANTIMATTER_SLIDERS,
  BLEND_MENU_GROUPS,
  CULTURE_SLIDERS,
  DOT_ROTATION_LABELS,
  DOT_TEXTURE_ORDER_LABELS,
  GHOST_SLIDERS,
  IMPASTO_TOOL_LABELS,
  INVERT_MODE_LABELS,
  LIGHT_SLIDERS,
  LIVE_PATTERN_LABELS,
  LIVE_PATTERN_SLIDERS,
  MUTATION_SLIDERS,
  PAD_SAMPLE_SIZES,
  PAINT_SHORTCUTS,
  PAINT_TOOLS,
  PAPER_SLIDERS,
  PATH_STROKE_TAPERS,
  PARTICLE_KIND_LABELS,
  PARTICLE_RENDER_LABELS,
  RIBBON_PAIR_LABELS,
  STAMP_LABELS,
  STICKER_SLIDERS,
  STROKE_SLIDERS,
  UV_LIGHT_SLIDERS,
  VIEW_TILT_SLIDERS,
  VORTEX_DIRECTION_LABELS,
  VORTEX_SLIDERS,
  MAGNET_SLIDERS,
  WET_GPU_OPTIONS,
  WET_MEDIUM_LABELS,
  WET_PARAM_SLIDERS,
  WET_SPEED_SLIDER,
  WET_TILT_SLIDERS,
  WET_TOOL_LABELS,
} from './ui';

/** Bumped when a contract file changes shape (not when its data changes). */
export const PAINT_CONTRACT_FORMAT_VERSION = 1;

const POINT: JsonSchema = { type: 'object', properties: { x: { type: 'number', description: 'Document x in pixels.' }, y: { type: 'number', description: 'Document y in pixels.' } }, required: ['x', 'y'] };

/**
 * JSON Schema of a saved painting: the `pixerate.editor-document` envelope of kind `paint`
 * around a `pixerate-paint` document (`createPaintEditorDocument`). Fields readers do not know
 * are kept and written back, so objects stay open; layers are the image editor's serialized
 * layers, and every stroke's brush is a facet brush (`brush.schema.json` of the brushes domain).
 */
export const PAINT_DOCUMENT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'A saved painting, as the paint editor\'s save tools and autosave write it.',
  properties: {
    format: { type: 'string', const: EDITOR_DOCUMENT_FORMAT, description: `Always "${EDITOR_DOCUMENT_FORMAT}".` },
    kind: { type: 'string', const: 'paint', description: 'Always "paint".' },
    formatVersion: { type: 'integer', minimum: 1, description: 'Version of the envelope for this kind; readers migrate older ones.' },
    name: { type: 'string', description: 'Display name, when it has one.' },
    document: {
      type: 'object',
      description: 'The painting (`SerializedPaintDocument`).',
      properties: {
        format: { type: 'string', const: PAINT_FORMAT, description: `Always "${PAINT_FORMAT}".` },
        version: { type: 'integer', minimum: 1, maximum: PAINT_SCHEMA_VERSION, description: `Painting version (${PAINT_SCHEMA_VERSION}; version 1 strokes hold flat engine brushes and are migrated).` },
        width: { type: 'integer', minimum: 1, description: 'Canvas width in pixels.' },
        height: { type: 'integer', minimum: 1, description: 'Canvas height in pixels.' },
        dpi: { type: 'number', exclusiveMinimum: 0, description: 'Pixels per inch.' },
        paper: {
          type: 'object',
          description: 'The paper settings; the paper is regenerated from them, never stored as pixels.',
          properties: {
            preset: { type: 'string', description: 'The paper preset it started from (custom when none).' },
            name: { type: 'string', description: 'Display name.' },
            pattern: { type: 'string', description: 'Grain pattern id.' },
            seed: { type: 'number', description: 'Grain seed.' },
            color: { type: 'string', description: 'Paper colour #rrggbb.' },
            scale: { type: 'number', description: 'Grain scale (0.25 to 8).' },
            depth: { type: 'number', minimum: 0, maximum: 1, description: 'Grain depth for dry media.' },
          },
          required: ['preset', 'pattern', 'seed', 'color'],
        },
        layers: {
          type: 'array',
          description: 'Bottom to top: the image editor\'s serialized layers (pixel layers keep their pixels in `assets`).',
          items: { type: 'object', properties: { id: { type: 'string', description: 'Layer id.' }, name: { type: 'string', description: 'Layer name.' }, type: { type: 'string', description: 'pixel, group, …' } }, required: ['id', 'type'] },
        },
        assets: { type: 'object', additionalProperties: { type: 'string' }, description: 'Asset id → PNG data URL or an external reference.' },
        activeLayerId: { type: ['string', 'null'], description: 'The active layer.' },
        strokes: {
          type: 'array',
          description: 'Recorded strokes, oldest first (missing when saved without them).',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stroke id.' },
              layerId: { type: 'string', description: 'The layer it painted on.' },
              color: { type: 'string', description: 'The paint colour as recorded at stroke start.' },
              seed: { type: 'number', description: 'Seed of its jitter and grain, so a replay is exact.' },
              points: { type: 'array', items: POINT, description: 'The samples, with pressure, tilt and time when recorded.' },
              brush: { $ref: '../brushes/brush.schema.json', description: 'The facet brush it painted with.' } as JsonSchema,
            },
            required: ['id', 'layerId', 'points', 'brush'],
          },
        },
        ferro: { type: 'object', additionalProperties: { type: 'string' }, description: 'Layer id → asset id of its liquid ferrofluid map.' },
        ferroSettings: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              wavelength: { type: 'number', description: 'Rosensweig spike spacing in pixels.' },
              threshold: { type: 'number', description: 'Critical magnetic field threshold.' },
            },
          },
          description: 'Layer id → ferrofluid spike settings.',
        },
        magnets: {
          type: 'array',
          description: 'Magnets on the canvas that pull liquid ferrofluid into spikes.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Magnet id.' },
              x: { type: 'number', description: 'Document x in pixels.' },
              y: { type: 'number', description: 'Document y in pixels.' },
              strength: { type: 'number', minimum: -1, maximum: 1, description: 'Magnet dipole strength (-1..1).' },
              radius: { type: 'number', minimum: 4, maximum: 512, description: 'Magnet field falloff radius in pixels.' },
            },
            required: ['id', 'x', 'y', 'strength', 'radius'],
          },
        },
        fluor: {
          type: 'object',
          description: 'Per-layer UV-fluorescent ink channels (layerId → bounds + PNG data URL).',
          additionalProperties: { type: 'object' },
        },
        thermo: {
          type: 'object',
          description: 'Per-layer thermochromic ink channels (layerId → bounds + PNG data URL).',
          additionalProperties: { type: 'object' },
        },
        heat: {
          type: 'object',
          description: 'Coarse document heat field (width, height, png) when the canvas is warm.',
          properties: {
            width: { type: 'integer', minimum: 1, description: 'Heat grid width in cells (1/4 canvas resolution).' },
            height: { type: 'integer', minimum: 1, description: 'Heat grid height in cells (1/4 canvas resolution).' },
            png: { type: 'string', description: 'Heat grid encoded as an RGBA PNG data URL.' },
          },
          required: ['width', 'height', 'png'],
        },
        uvLight: {
          type: 'object',
          description: 'Virtual UV blacklight settings when non-default.',
          properties: {
            on: { type: 'boolean', description: 'Whether the UV blacklight is switched on.' },
            strength: { type: 'number', minimum: 0, maximum: 2, description: 'UV emission and spill strength (0..2).' },
            ambient: { type: 'number', minimum: 0, maximum: 1, description: 'Remaining daylight ambient level (0..1).' },
          },
        },
        age: {
          type: 'object',
          description: 'Painting time-machine ageing preview settings when non-default.',
          properties: {
            years: { type: 'number', minimum: 0, maximum: 500, description: 'Simulated age in years (0..500; 0 = fresh paint).' },
            varnish: { type: 'number', minimum: 0, maximum: 1, description: 'Yellowed varnish absorption strength (0..1).' },
            cracks: { type: 'number', minimum: 0, maximum: 1, description: 'Voronoi / stress craquelure crack network strength (0..1).' },
            fading: { type: 'number', minimum: 0, maximum: 1, description: 'Pigment lightfastness fading strength by hue (0..1).' },
            dust: { type: 'number', minimum: 0, maximum: 1, description: 'Low-frequency surface dust grain strength (0..1).' },
            seed: { type: 'integer', minimum: 0, description: 'Deterministic seed for craquelure and dust.' },
          },
        },
        cultures: {
          type: 'object',
          description: 'Living and extinct biopaint (`culture`) colonies per layer, plus offline growth options.',
          properties: {
            layers: {
              type: 'object',
              description: 'Layer id → serialized `LayerCultureJSON` (tick, nextId, tips, segmentsTotal, status, occupancy).',
              additionalProperties: { type: 'object' },
            },
            growWhileClosed: { type: 'boolean', description: 'Whether living colonies catch up elapsed growth when reopened.' },
            lastGrownAt: { type: 'number', description: 'Timestamp in milliseconds when the document was saved with living colonies.' },
          },
        },
      },
      required: ['format', 'version', 'width', 'height', 'dpi', 'paper', 'layers', 'assets', 'activeLayerId'],
    },
  },
  required: ['format', 'kind', 'formatVersion', 'document'],
};

/** A provider's tools as an MCP tool list (name, title, description, inputSchema, annotations). */
function toolList(provider: AgentToolProvider) {
  const tools = typeof provider.tools === 'function' ? provider.tools() : provider.tools;
  return {
    id: provider.id,
    title: provider.title,
    ...(provider.skill ? { skill: provider.skill } : {}),
    tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
  };
}

/** The UI tables React and Svelte render, as plain data. */
function uiTables() {
  return {
    tools: PAINT_TOOLS,
    brushOptions: BRUSH_OPTION_CONTROLS,
    blendMenu: BLEND_MENU_GROUPS,
    layerEffects: LAYER_EFFECT_MENU.map(({ kind, label }) => ({ kind, label, controls: layerEffectControls(defaultLayerEffect(kind, kind)) })),
    sliders: { paper: PAPER_SLIDERS, wet: WET_PARAM_SLIDERS, wetTilt: WET_TILT_SLIDERS, wetSpeed: WET_SPEED_SLIDER, light: LIGHT_SLIDERS, uvLight: UV_LIGHT_SLIDERS, age: AGE_SLIDERS, viewTilt: VIEW_TILT_SLIDERS, ghost: GHOST_SLIDERS, mutation: MUTATION_SLIDERS, vortex: VORTEX_SLIDERS, culture: CULTURE_SLIDERS, livePatterns: LIVE_PATTERN_SLIDERS, stroke: STROKE_SLIDERS, sticker: STICKER_SLIDERS, magnet: MAGNET_SLIDERS, antimatter: ANTIMATTER_SLIDERS },
    pathStrokeTapers: PATH_STROKE_TAPERS,
    padSampleSizes: PAD_SAMPLE_SIZES,
    wetGpu: WET_GPU_OPTIONS,
    labels: {
      wetTools: WET_TOOL_LABELS,
      wetMedia: WET_MEDIUM_LABELS,
      vortexDirections: VORTEX_DIRECTION_LABELS,
      livePatterns: LIVE_PATTERN_LABELS,
      impastoTools: IMPASTO_TOOL_LABELS,
      particleKinds: PARTICLE_KIND_LABELS,
      particleRenders: PARTICLE_RENDER_LABELS,
      ribbonPairs: RIBBON_PAIR_LABELS,
      dotTextureOrders: DOT_TEXTURE_ORDER_LABELS,
      dotRotations: DOT_ROTATION_LABELS,
      invertModes: INVERT_MODE_LABELS,
      stamps: STAMP_LABELS,
    },
  };
}

/**
 * Every paint contract file, by its path under `domains/paint/` (plain JSON values). `effects`
 * is the effect provider the effect tools are listed with (their list needs one; the export uses
 * the fake provider, so the files do not depend on a catalogue).
 */
export function paintContracts(options: { effects: EffectProvider }): Record<string, unknown> {
  const controller = new PaintEditorController({ width: 64, height: 64 });
  controller.setEffectsProvider(options.effects);
  const providers = [
    createPaintEditorToolProvider(controller),
    createPaintEffectsToolProvider(controller),
    createPaintEffectAuthoringToolProvider(controller),
    createPaintBrushLibraryToolProvider(controller),
    createPaintProposalToolProvider(createPaintProposals({ controller })),
  ].map(toolList);
  const document = createPaintEditorDocument(controller);
  const files: Record<string, unknown> = {
    'document.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'document.schema.json', ...PAINT_DOCUMENT_JSON_SCHEMA },
    'tools.json': { providers },
    'commands.json': PAINT_SHORTCUTS.map((s) => ({ ...s, params: { type: 'object', properties: {}, additionalProperties: false } })),
    'ui.json': uiTables(),
  };
  files['manifest.json'] = {
    domain: 'paint',
    formatVersion: PAINT_CONTRACT_FORMAT_VERSION,
    document: { kind: document.kind, formatVersion: document.formatVersion, format: PAINT_FORMAT, version: PAINT_SCHEMA_VERSION },
    counts: { providers: providers.length, tools: providers.reduce((n, p) => n + p.tools.length, 0), commands: PAINT_SHORTCUTS.length, layerEffects: LAYER_EFFECT_KINDS.length },
    files: Object.keys(files).sort(),
  };
  return files;
}

/**
 * Ids this core makes from the clock, which another implementation makes its own way: layers
 * (`pl…`), layer styles (`fx_…_…`) and image editor layers (`<prefix>_…_…`). Ids from counters
 * (`s1`, `st1`, `ref1`, `pad1`, `paint-proposal-1`) are part of the contract.
 */
const GENERATED_ID = /^(pl[0-9a-z]{9,}|[a-z]+_[0-9a-z]{8,}_[0-9a-z]+)$/;

/**
 * A fresh paint editor for replaying a conformance scenario (`domains/paint/fixtures`): every paint
 * tool provider in one registry that validates arguments, the saved document (the
 * `pixerate.editor-document` envelope) and the composited pixels. `setup` is the scenario's
 * editor options, such as `{ width, height }`, where `stickers: "fake"` is the editor's stickers with
 * the fake sticker library (`createFakeStickerProvider`, which has an animated sticker); `effects` is
 * the effect provider the effect tools use.
 */
export function createPaintConformanceHost(setup: Omit<PaintEditorOptions, 'stickers'> & { stickers?: StickerProvider | 'fake' }, options: { effects: EffectProvider }): ConformanceHost {
  const stickers = setup.stickers === 'fake' ? combineStickerProviders([editorStickers(), createFakeStickerProvider()]) : setup.stickers;
  // The TypeScript wet kernel on one thread is the reference; WebAssembly and the GPU load late.
  const controller = new PaintEditorController({ ...setup, stickers, wet: { kernel: 'typescript', threads: 0, gpu: 'off', ...setup.wet } });
  controller.setEffectsProvider(options.effects);
  const registry = new ToolRegistry({ validateArguments: true });
  registry.register(createPaintEditorToolProvider(controller));
  registry.register(createPaintEffectsToolProvider(controller));
  registry.register(createPaintEffectAuthoringToolProvider(controller));
  registry.register(createPaintBrushLibraryToolProvider(controller));
  registry.register(createPaintProposalToolProvider(createPaintProposals({ controller })));
  return {
    callTool: (name, args) => registry.callTool(name, args),
    document: () => toEditorDocumentFile(createPaintEditorDocument(controller)),
    save: () => controller.toJSON(),
    load: (document) => controller.loadJSON(document),
    pixels: ({ paper }) => controller.compositePixels({ paper }),
    isGeneratedId: (value) => GENERATED_ID.test(value),
    dispose: () => controller.dispose(),
  };
}
