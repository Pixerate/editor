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
import { EDITOR_DOCUMENT_FORMAT } from '../persistence/editorDocument';
import { defaultLayerEffect, LAYER_EFFECT_KINDS } from '../raster/effects/model';
import { LAYER_EFFECT_MENU, layerEffectControls } from '../raster/effects/ui';
import type { AgentToolProvider } from '../tools/registry';
import type { JsonSchema } from '../tools/schema';
import { createPaintBrushLibraryToolProvider } from './brush-library-tools';
import { createPaintProposalToolProvider } from './collaboration-tools';
import { createPaintProposals } from './collaboration';
import { PaintEditorController } from './controller';
import { createPaintEditorDocument } from './editorDocument';
import { createPaintEffectsToolProvider } from './effect-tools';
import { PAINT_FORMAT, PAINT_SCHEMA_VERSION } from './serialize';
import { createPaintEditorToolProvider } from './tools';
import {
  BLEND_MENU_GROUPS,
  DOT_ROTATION_LABELS,
  DOT_TEXTURE_ORDER_LABELS,
  IMPASTO_TOOL_LABELS,
  LIGHT_SLIDERS,
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
    sliders: { paper: PAPER_SLIDERS, wet: WET_PARAM_SLIDERS, wetTilt: WET_TILT_SLIDERS, wetSpeed: WET_SPEED_SLIDER, light: LIGHT_SLIDERS, stroke: STROKE_SLIDERS, sticker: STICKER_SLIDERS },
    pathStrokeTapers: PATH_STROKE_TAPERS,
    padSampleSizes: PAD_SAMPLE_SIZES,
    wetGpu: WET_GPU_OPTIONS,
    labels: {
      wetTools: WET_TOOL_LABELS,
      wetMedia: WET_MEDIUM_LABELS,
      impastoTools: IMPASTO_TOOL_LABELS,
      particleKinds: PARTICLE_KIND_LABELS,
      particleRenders: PARTICLE_RENDER_LABELS,
      ribbonPairs: RIBBON_PAIR_LABELS,
      dotTextureOrders: DOT_TEXTURE_ORDER_LABELS,
      dotRotations: DOT_ROTATION_LABELS,
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
