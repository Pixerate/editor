/**
 * The brush module as language-neutral contracts (`@pixerate/conformance` `domains/brushes`), so
 * another implementation (the Swift port) ships the same brushes: the brush JSON Schema, the
 * built-in presets and the engine brushes they resolve to, the host profiles and what each host
 * accepts, v1 migrations, the library file format, the library's agent tools and the brush editor
 * sections. `scripts/export-contracts.mjs` writes them; a core test fails when the committed
 * files differ from what this returns.
 *
 * Everything here is data from this module's own functions; nothing depends on the package
 * version, so a release does not change the files.
 */

import type { JsonSchema } from '../tools/schema';
import { brushToJSON, BUILTIN_BRUSHES, normalizePaintBrush, type PaintBrushInput } from '../paint-editor/brushes';
import { createBrushLibrary } from './library';
import { migrateBrushV1 } from './migrate';
import { BRUSH_PRESETS } from './presets';
import { BRUSH_HOST_PROFILES, checkBrush } from './profiles';
import { resolveBrush, resolveCategory, resolveEngine } from './resolve';
import { BRUSH_JSON_SCHEMA, MAX_BRUSH_PALETTE } from './schema';
import { MAX_BRUSH_SOURCE_SIZE, MAX_BRUSH_SOURCES } from './sources';
import { BRUSH_ID } from '../paint-editor/brush-model';
import { createBrushLibraryTools } from './tools';
import { brushEditorSections } from './ui';
import { BRUSH_KINDS, BRUSH_MARKS_KINDS, BRUSH_SURFACES, BRUSH_TIP_SHAPES, BRUSH_TOOLS } from './types';

/** Bumped when a contract file changes shape (not when its data changes). */
export const BRUSH_CONTRACT_FORMAT_VERSION = 1;

const SUPPORT: JsonSchema = { type: 'string', enum: ['full', 'ignored', 'none'], description: 'full: rendered; ignored: accepted, painted without it (a warning); none: refused (an error).' };

/** JSON Schema of a host profile (`profiles.json`). */
export const BRUSH_PROFILE_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'What a host can render (`BrushHostProfile`).',
  properties: {
    id: { type: 'string', description: 'paint, image, canvas, vector…' },
    name: { type: 'string', description: 'Display name, used in messages.' },
    kinds: { type: 'array', items: { type: 'string', enum: [...BRUSH_KINDS] }, description: 'Brush kinds it has.' },
    tools: { type: 'array', items: { type: 'string', enum: [...BRUSH_TOOLS] }, description: 'Tools it has (kind tool).' },
    tipShapes: { type: 'array', items: { type: 'string', enum: [...BRUSH_TIP_SHAPES] }, description: 'Tip shapes it renders.' },
    marks: { type: 'array', items: { type: 'string', enum: [...BRUSH_MARKS_KINDS] }, description: 'Marks kinds it renders.' },
    surfaces: { type: 'array', items: { type: 'string', enum: [...BRUSH_SURFACES] }, description: 'Surfaces it renders.' },
    exchange: { ...SUPPORT, description: 'Picking paint up and mixing it in.' },
    reservoir: { ...SUPPORT, description: 'The Mixer Brush reservoir.' },
    grain: { ...SUPPORT, description: 'Paper grain response.' },
    light: { ...SUPPORT, description: 'Light paint.' },
    motion: { ...SUPPORT, description: 'Motion after painting.' },
    colours: { type: 'array', items: { type: 'string', enum: ['solid', 'dual', 'gradient', 'effect'] }, description: 'Colour kinds a default colour may be.' },
    velocity: { ...SUPPORT, description: 'Velocity dynamics.' },
    tilt: { ...SUPPORT, description: 'Tilt dynamics.' },
    tipGrain: { ...SUPPORT, description: 'Texture inside the tip (tip.grain); missing: none.' },
    dabCount: { ...SUPPORT, description: 'Several dabs per spacing step (dynamics.count); missing: none.' },
    livePatterns: { ...SUPPORT, description: 'Gray-Scott reaction-diffusion patterns in wet paint (livePatterns); missing: none.' },
    iridescence: { ...SUPPORT, description: 'Thin-film iridescence (iridescence); missing: none.' },
  },
  required: ['id', 'name', 'kinds', 'tools', 'tipShapes', 'marks', 'surfaces', 'exchange', 'reservoir', 'grain', 'light', 'motion', 'colours', 'velocity', 'tilt'],
  additionalProperties: false,
};

/** JSON Schema of a brush library file (`pixerate-brushes` version 2). */
export const BRUSH_LIBRARY_FILE_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  description: 'A brush library file, as export_brushes writes it. Readers also accept version 1 files (flat engine brushes, migrated) and a bare array of brushes.',
  properties: {
    format: { type: 'string', const: 'pixerate-brushes', description: 'Always "pixerate-brushes".' },
    version: { type: 'integer', const: 2, description: 'Always 2.' },
    brushes: { type: 'array', items: { $ref: 'brush.schema.json' } as JsonSchema, description: 'The brushes, each a facet brush (brush.schema.json).' },
    sources: {
      type: 'array',
      maxItems: MAX_BRUSH_SOURCES,
      description: 'The image sources the brushes name (source:<id> in tip.stamps or tip.grain.source), bytes included.',
      items: {
        type: 'object',
        description: 'An image source: a grey mask, 255 paints (or is a grain peak).',
        properties: {
          id: { type: 'string', pattern: BRUSH_ID.source, description: 'Source id.' },
          name: { type: 'string', maxLength: 80, description: 'Display name.' },
          width: { type: 'integer', minimum: 1, maximum: MAX_BRUSH_SOURCE_SIZE, description: 'Width in px.' },
          height: { type: 'integer', minimum: 1, maximum: MAX_BRUSH_SOURCE_SIZE, description: 'Height in px.' },
          image: { type: 'string', pattern: '^data:image/png;base64,', description: 'The mask as a greyscale PNG data: URL.' },
          licence: { type: 'string', maxLength: 2000, description: 'The licence or terms it came with.' },
          origin: { type: 'string', maxLength: 200, description: 'Where it came from (a file or pack name).' },
        },
        required: ['id', 'name', 'width', 'height', 'image'],
        additionalProperties: false,
      },
    },
  },
  required: ['format', 'version', 'brushes'],
  additionalProperties: false,
};

/** Version 1 brushes (flat engine form, as older files and documents hold them) for the migration fixtures. */
function migrationInputs(): PaintBrushInput[] {
  const pick = (id: string) => brushToJSON(BUILTIN_BRUSHES.find((b) => b.id === id)!);
  return [
    { id: 'plain', name: 'Plain' },
    pick('pencil-6b'),
    { ...pick('soft-pastel'), id: 'my-pastel', name: 'My pastel', category: 'custom', grain: 0.2, tip: { ...pick('soft-pastel').tip, size: 50 } },
    pick('mixer-brush'),
    pick('watercolor-wash'),
    pick('impasto-brush'),
    pick('hair-strands'),
    pick('bristle-round'),
    pick('sticker-stars'),
    pick('rainbow-marker'),
    pick('blender'),
    pick('add-water'),
    pick('spray-can'),
    // Fields an engine never reads are dropped on migration.
    { ...pick('ink-pen'), id: 'ink-with-mixer', name: 'Ink with mixer settings', mixer: { wet: 0.9, load: 0.1, mix: 0.9, loadEachStroke: false, cleanEachStroke: false, mixing: 'pigment' } },
  ];
}

/** The brush editor sections of a few presets on each host, as fixtures of `brushEditorSections`. */
function editorSectionFixtures() {
  const ids = ['highlighter', 'chalk', 'watercolor-wash', 'hair-strands', 'mixer-brush', 'blender', 'spray-can'];
  return ids.flatMap((id) =>
    Object.keys(BRUSH_HOST_PROFILES).map((host) => {
      const brush = BRUSH_PRESETS.find((b) => b.id === id)!;
      return { brush: id, host, sections: brushEditorSections(brush, BRUSH_HOST_PROFILES[host]) };
    }),
  );
}

/**
 * The library's agent tools as an MCP tool list (name, title, description, inputSchema,
 * annotations) for the paint host, with `preview_brush`; every other host has the same tools with
 * its own name in the descriptions (`hosts` lists them).
 */
function toolDefinitions() {
  const library = createBrushLibrary();
  const toolsFor = (host: string) => createBrushLibraryTools(library, { profile: BRUSH_HOST_PROFILES[host], renderPreview: () => ({ data: '', mimeType: 'image/png' }) });
  return {
    tools: toolsFor('paint').map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
    hosts: Object.fromEntries(Object.keys(BRUSH_HOST_PROFILES).map((host) => [host, toolsFor(host).map((t) => t.name)])),
  };
}

/**
 * Every brush contract file, by its path under `domains/brushes/` (plain JSON values). The
 * presets and their resolutions, checks and migrations are what an implementation must reproduce;
 * the schemas and tools are what it must accept and offer.
 */
export function brushContracts(): Record<string, unknown> {
  const presets = BRUSH_PRESETS.map((b) => JSON.parse(JSON.stringify(b)));
  const resolved = BRUSH_PRESETS.map((b) => ({ id: b.id, engine: resolveEngine(b), category: resolveCategory(b), brush: brushToJSON(resolveBrush(b)) }));
  const profiles = Object.values(BRUSH_HOST_PROFILES);
  const checks = BRUSH_PRESETS.map((b) => ({
    id: b.id,
    hosts: Object.fromEntries(profiles.map((p) => {
      const c = checkBrush(b, p);
      return [p.id, { ok: c.ok, issues: c.issues.map(({ facet, severity }) => ({ facet, severity })) }];
    })),
  }));
  const migrations = migrationInputs().map((input) => ({ input, output: migrateBrushV1(input), resolved: brushToJSON(resolveBrush(migrateBrushV1(input))), engine: normalizePaintBrush(input).engine }));
  const files: Record<string, unknown> = {
    'brush.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'brush.schema.json', ...BRUSH_JSON_SCHEMA },
    'profile.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'profile.schema.json', ...BRUSH_PROFILE_JSON_SCHEMA },
    'library-file.schema.json': { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'library-file.schema.json', ...BRUSH_LIBRARY_FILE_JSON_SCHEMA },
    'presets.json': presets,
    'resolved.json': resolved,
    'profiles.json': profiles,
    'checks.json': checks,
    'migrations.json': migrations,
    'tools.json': toolDefinitions(),
    'editor-sections.json': editorSectionFixtures(),
  };
  files['manifest.json'] = {
    domain: 'brushes',
    formatVersion: BRUSH_CONTRACT_FORMAT_VERSION,
    limits: { maxPalette: MAX_BRUSH_PALETTE },
    counts: { presets: presets.length, profiles: profiles.length, migrations: migrations.length, editorSections: (files['editor-sections.json'] as unknown[]).length },
    files: Object.keys(files).sort(),
  };
  return files;
}
