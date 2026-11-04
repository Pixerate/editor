/**
 * Agent tools for a brush library (`createBrushLibraryToolProvider`): list, describe, create,
 * update, duplicate, remove, export, import and check brushes, and preview one when the host
 * injects a renderer. Writes are checked against the host's profile before anything is stored,
 * and refusals name what to do instead. The provider imports no renderer: `preview_brush` is
 * the host's.
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import { describeStickerRef } from '../stickers/tools';
import type { StickerProvider } from '../stickers/types';
import type { JsonSchema } from '../tools/schema';
import { BrushLibraryError, closest, type BrushLibrary, type BrushLibraryEntry } from './library';
import { normalizeBrushSpec } from './normalize';
import { BRUSH_PATCH_PROPERTIES, BRUSH_UNSET_PROPERTY, changedBrushPaths, mergeBrushPatch } from './patch';
import { BRUSH_HOST_PROFILES, checkBrush, degrade, PAINT_PROFILE, withKeptIssues, type BrushCheck, type BrushHostProfile } from './profiles';
import { resolveCategory, resolveEngine } from './resolve';
import { BRUSH_JSON_SCHEMA } from './schema';
import { BRUSH_KINDS, BRUSH_MEDIA, BRUSH_TOOLS, type Brush } from './types';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/** A preview image of a brush: base64 data and its type. */
export interface BrushPreviewImage {
  data: string;
  mimeType: string;
}

/** Draws a sample stroke with a brush (the host's renderer: the paint engine, a canvas…). */
export type BrushPreviewRenderer = (brush: Brush, options: { width: number; height: number; color: string }) => BrushPreviewImage | Promise<BrushPreviewImage>;

export interface BrushLibraryToolProviderOptions {
  /** What this host can render (default `PAINT_PROFILE`): lists are filtered by it and writes checked against it. */
  profile?: BrushHostProfile;
  /** With it, `preview_brush` draws a sample stroke. */
  renderPreview?: BrushPreviewRenderer;
  /** Only the read tools (list, describe, export, check, preview). */
  readOnly?: boolean;
  /**
   * The host's sticker library (an editor's `StickersSlot` provider), read on every call: stamp
   * tips naming a sticker it can't load are refused with the reason and the closest ones. Without
   * it, sticker refs are not checked.
   */
  stickers?: () => StickerProvider;
  /** Provider id (default `brushes`), also the tool namespace unless `namespace` is set. */
  id?: string;
  namespace?: string;
}

const FACETS = BRUSH_JSON_SCHEMA.properties!;
const ID: JsonSchema = { type: 'string', pattern: String(FACETS.id!.pattern), description: 'Brush id from list_brush_presets (lowercase letters, digits and dashes).' };
const FACET_PROPS = BRUSH_PATCH_PROPERTIES;
const HOSTS = Object.keys(BRUSH_HOST_PROFILES);

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const merge = mergeBrushPatch;
const changedPaths = changedBrushPaths;

function summary(entry: BrushLibraryEntry, profile: BrushHostProfile, withCheck: boolean) {
  const b = entry.brush;
  const engine = resolveEngine(b);
  const check = withCheck ? checkBrush(b, profile) : null;
  return {
    id: b.id,
    name: b.name,
    builtin: entry.builtin,
    kind: b.kind,
    ...(b.medium ? { medium: b.medium } : {}),
    ...(b.variety ? { variety: b.variety } : {}),
    ...(b.tool ? { tool: b.tool } : {}),
    category: resolveCategory(b, engine),
    engine,
    tip: b.tip.shape,
    ...(b.tip.size !== undefined ? { size: b.tip.size } : {}),
    marks: b.marks?.kind ?? 'continuous',
    surface: b.behaviour?.surface ?? 'dry',
    ...(b.light?.amount ? { light: b.light.amount } : {}),
    ...(b.tags?.length ? { tags: b.tags } : {}),
    ...(check ? { renderable: check.ok } : {}),
  };
}

const refusal = (check: BrushCheck, host: BrushHostProfile) =>
  `${host.name} can't use this brush: ${check.issues
    .filter((i) => i.severity === 'error')
    .map((i) => `${i.facet}: ${i.reason} ${i.fix}`)
    .join(' ')} (check_brush lists every issue; nothing was saved.)`;

const warnings = (check: BrushCheck) => check.issues.filter((i) => i.severity === 'warning');

/** The brush library tools for one host (see the module comment). */
export function createBrushLibraryTools(library: BrushLibrary, options: BrushLibraryToolProviderOptions = {}): AgentTool[] {
  const profile = options.profile ?? PAINT_PROFILE;
  const hostOf = (id: unknown): BrushHostProfile => {
    if (id === undefined) return profile;
    const p = BRUSH_HOST_PROFILES[id as string];
    if (!p) throw new BrushLibraryError('invalid', `No host "${id}"; use one of: ${HOSTS.join(', ')}.`);
    return p;
  };
  const entry = async (id: string): Promise<BrushLibraryEntry> => {
    const found = await library.get(id);
    if (found) return found;
    const ids = (await library.list()).map((e) => e.brush.id);
    throw new BrushLibraryError('unknown_brush', `No brush "${id}". ${closest(id, ids)}list_brush_presets lists them.`);
  };
  /** `checkBrush`, plus a stamp tip's stickers checked against the host's sticker library. */
  const checkFor = async (brush: Brush, p: BrushHostProfile): Promise<BrushCheck> => {
    const check = checkBrush(brush, p);
    const provider = options.stickers?.();
    if (!provider || brush.tip.shape !== 'stamp') return check;
    const issues = [...check.issues];
    for (const ref of brush.tip.stamps ?? []) {
      if (ref.startsWith('editor:')) continue;
      try {
        await describeStickerRef(provider, ref);
      } catch (e) {
        issues.push({ facet: 'tip.stamps', severity: 'error', reason: `${p.name} can't load sticker "${ref}": ${(e as Error).message}`, fix: 'Use a ref from find_stickers, or an editor stamp (editor:star, editor:dot…).' });
      }
    }
    return { ok: !issues.some((i) => i.severity === 'error'), issues };
  };
  /**
   * Normalises and checks a brush for this host, then stores it. With `original` (an update), what
   * it already had that this host can't use is kept, not refused: only new refusals refuse it.
   */
  const store = async (raw: Record<string, unknown>, overwrite: boolean, original?: Brush) => {
    const problems: string[] = [];
    let brush: Brush;
    try {
      brush = normalizeBrushSpec(raw, problems);
    } catch (e) {
      throw new BrushLibraryError('invalid', (e as Error).message);
    }
    const check = withKeptIssues(await checkFor(brush, profile), original ? await checkFor(original, profile) : null);
    if (!check.ok) throw new BrushLibraryError('invalid', refusal(check, profile));
    const saved = await library.save(brush, { overwrite });
    return { ...saved, problems, check };
  };

  const list: AgentTool = {
    name: 'list_brush_presets',
    title: 'List brushes',
    description: `Lists the brush library (built-in presets and saved brushes) that this host (${profile.name}) can render, filtered by kind, medium, variety, tool, tag or words. Returns each brush's id (for describe_brush, create_brush basedOn, duplicate_brush and the editor's set_brush), name, builtin, kind, medium, variety or tool, category, engine, tip shape and size, marks, surface and light, plus total. Call it first to find the nearest brush to start from. Changes nothing.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...BRUSH_KINDS], description: 'mark (lays a material) or tool (works on paint already down).' },
        medium: { type: 'string', enum: [...BRUSH_MEDIA], description: 'Marks laying this medium.' },
        variety: { type: 'string', maxLength: 40, description: 'This variety (oil, watercolor, pencil, highlighter…).' },
        tool: { type: 'string', enum: [...BRUSH_TOOLS], description: 'Tools that do this.' },
        tag: { type: 'string', maxLength: 40, description: 'Brushes with this tag.' },
        text: { type: 'string', maxLength: 200, description: 'Words in the id, name, description, variety or tags (each word must match the start of one).' },
        source: { type: 'string', enum: ['all', 'builtin', 'user'], description: 'all (default), builtin presets only, or user (saved) brushes only.' },
        all: { type: 'boolean', description: 'Also list brushes this host can\'t render, each with renderable false (default false).' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many (default 0).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many (default 100).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List brushes', ...READ },
    handler: async (a) => {
      const source = a.source === 'all' ? undefined : (a.source as 'builtin' | 'user' | undefined);
      const found = await library.list({ kind: a.kind, medium: a.medium, variety: a.variety, tool: a.tool, tag: a.tag, text: a.text, source, ...(a.all ? {} : { profile }) });
      const offset = (a.offset as number | undefined) ?? 0;
      const page = found.slice(offset, offset + ((a.limit as number | undefined) ?? 100));
      return { host: profile.id, total: found.length, brushes: page.map((e) => summary(e, profile, !!a.all)) };
    },
  };

  const describe: AgentTool = {
    name: 'describe_brush',
    title: 'Describe a brush',
    description: `Reads one brush by id: its full facet spec (kind, medium, variety or tool, tip, marks, dynamics, behaviour, light, motion, colour), whether it is built in, the engine and category it resolves to, and check: what this host (${profile.name}) refuses or paints without, each with a fix. Unknown ids are refused with the closest ones. Changes nothing.`,
    inputSchema: { type: 'object', properties: { id: ID }, required: ['id'], additionalProperties: false },
    annotations: { title: 'Describe a brush', ...READ },
    handler: async ({ id }) => {
      const e = await entry(id as string);
      const engine = resolveEngine(e.brush);
      return { brush: e.brush, builtin: e.builtin, engine, category: resolveCategory(e.brush, engine), check: await checkFor(e.brush, profile) };
    },
  };

  const check: AgentTool = {
    name: 'check_brush',
    title: 'Check a brush for a host',
    description: `Checks a brush (by id, or a facet spec not yet saved) against a host profile: ${HOSTS.join(', ')} (default this host, ${profile.id}). Returns ok (no errors), issues (facet, severity error or warning, reason, fix) and, when it is refused, degraded: the brush with the refused facets stripped and what was dropped. Use it before create_brush, or to see whether a brush works in another editor. Changes nothing.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { ...ID, description: 'A brush in the library (give id or brush, not both).' },
        brush: { type: 'object', description: 'A facet brush spec (the create_brush fields, with id and name).' },
        host: { type: 'string', enum: HOSTS, description: `The host profile (default ${profile.id}).` },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Check a brush for a host', ...READ },
    handler: async ({ id, brush, host }) => {
      if ((id === undefined) === (brush === undefined)) throw new BrushLibraryError('invalid', 'Give either id (a library brush) or brush (a spec), not both or neither.');
      const p = hostOf(host);
      let b: Brush;
      const problems: string[] = [];
      if (id !== undefined) b = (await entry(id as string)).brush;
      else {
        try {
          b = normalizeBrushSpec(brush, problems);
        } catch (e) {
          throw new BrushLibraryError('invalid', (e as Error).message);
        }
      }
      const result = await checkFor(b, p);
      return { host: p.id, ...result, ...(problems.length ? { problems } : {}), ...(!result.ok ? { degraded: degrade(b, p) } : {}) };
    },
  };

  const exportTool: AgentTool = {
    name: 'export_brushes',
    title: 'Export brushes',
    description: 'Writes a brush library file (format pixerate-brushes, version 2) of the saved brushes, or of the ids given (built-ins included). Returns the file as JSON, for import_brushes in another library. Changes nothing.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', minItems: 1, maxItems: 500, uniqueItems: true, items: ID, description: 'Only these brushes (default every saved brush).' } }, additionalProperties: false },
    annotations: { title: 'Export brushes', ...READ },
    handler: async ({ ids }) => ({ file: await library.exportFile(ids as string[] | undefined) }),
  };

  const tools: AgentTool[] = [list, describe, check, exportTool];

  if (options.renderPreview) {
    const render = options.renderPreview;
    tools.push({
      name: 'preview_brush',
      title: 'Preview a brush',
      description: 'Draws a sample S-stroke with a brush (by id) on a plain background and returns it as an image, to see a brush before painting with it or after create_brush / update_brush. Returns the image plus id, width and height. Changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID,
          width: { type: 'integer', minimum: 32, maximum: 1024, description: 'Image width in px (default 256).' },
          height: { type: 'integer', minimum: 16, maximum: 512, description: 'Image height in px (default 96).' },
          color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Paint colour #rrggbb (default the brush\'s own default colour, else #1f2937).' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: 'Preview a brush', ...READ },
      handler: async ({ id, width, height, color }) => {
        const { brush } = await entry(id as string);
        const own = typeof brush.colour?.default === 'string' && /^#[0-9a-f]{6}/i.test(brush.colour.default) ? brush.colour.default.slice(0, 7) : undefined;
        const w = (width as number | undefined) ?? 256;
        const h = (height as number | undefined) ?? 96;
        const image = await render(brush, { width: w, height: h, color: (color as string | undefined) ?? own ?? '#1f2937' });
        return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }], structuredContent: { id, width: w, height: h } };
      },
    });
  }

  if (options.readOnly) return tools;

  tools.push(
    {
      name: 'create_brush',
      title: 'Save a new brush',
      description: `Saves a new brush made of facets (to save an editor's current brush settings, pass the brush get_brush returns), optionally basedOn an existing brush (its facets are copied and the ones given here laid over them: objects merge, lists and values replace). Values are normalised (out-of-range numbers clamped, unused facets dropped, each reported in problems) and checked against this host (${profile.name}): a brush it can't render is refused with the facet and fix, and nothing is saved. Returns the new id, the stored brush, the engine it resolves to, problems and warnings (settings this host paints without). Start from the nearest preset (list_brush_presets) rather than from nothing.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { ...FACETS.id!, description: 'The new brush id: lowercase letters, digits and dashes, not taken (list_brush_presets).' },
          name: FACETS.name!,
          basedOn: { ...ID, description: 'Copy this brush\'s facets first (a built-in preset or a saved brush).' },
          ...FACET_PROPS,
        },
        required: ['id', 'name'],
        additionalProperties: false,
      },
      annotations: { title: 'Save a new brush', ...WRITE },
      handler: async ({ basedOn, ...spec }) => {
        if (library.isBuiltin(spec.id as string)) throw new BrushLibraryError('builtin', `"${spec.id}" is a built-in brush id; pick another id (or basedOn "${spec.id}" with a new id).`);
        if (await library.get(spec.id as string)) throw new BrushLibraryError('exists', `A brush "${spec.id}" exists already; pick another id, or change it with update_brush.`);
        const base = basedOn !== undefined ? (await entry(basedOn as string)).brush : undefined;
        const raw = base ? merge(base as unknown as Record<string, unknown>, spec) : spec;
        const saved = await store(raw, false);
        return { id: saved.brush.id, brush: saved.brush, engine: resolveEngine(saved.brush), problems: saved.problems, warnings: warnings(saved.check) };
      },
    },
    {
      name: 'update_brush',
      title: 'Update a brush',
      description: `Changes a saved brush: the facets given are laid over its own (objects merge, lists and values replace; marks of another kind replace the marks), and unset removes whole facets back to their defaults. Built-in presets are refused (duplicate_brush first). Checked against this host like create_brush: a change that adds what this host can't render is refused and saves nothing, while facets the brush already had for other hosts (a paint brush's light, in canvas) are kept as they are. One change. Returns the brush, the leaf paths changed, problems, warnings and, when there are any, kept: the facets this host can't use that the brush keeps.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { ...ID, description: 'The saved brush to change (not a built-in).' },
          name: FACETS.name!,
          ...FACET_PROPS,
          unset: BRUSH_UNSET_PROPERTY,
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: 'Update a brush', ...WRITE, idempotentHint: true },
      handler: async ({ id, unset, ...patch }) => {
        const e = await entry(id as string);
        if (e.builtin) throw new BrushLibraryError('builtin', `"${id}" is a built-in brush and can't be changed; duplicate_brush makes a copy you can change.`);
        const base = copy(e.brush) as unknown as Record<string, unknown>;
        for (const k of (unset as string[] | undefined) ?? []) delete base[k];
        const saved = await store(merge(base, { ...patch, id }), true, e.brush);
        return { id, brush: saved.brush, changed: changedPaths(e.brush, saved.brush), problems: saved.problems, warnings: warnings(saved.check), ...(saved.check.kept.length ? { kept: saved.check.kept } : {}) };
      },
    },
    {
      name: 'duplicate_brush',
      title: 'Duplicate a brush',
      description: 'Copies any brush (built-in presets included) to a new saved brush you can change with update_brush. Returns the new id (default <id>-copy, -copy-2…) and the brush.',
      inputSchema: {
        type: 'object',
        properties: {
          id: ID,
          newId: { ...FACETS.id!, description: 'Id for the copy (default <id>-copy, -copy-2…); must not be taken.' },
          name: { ...FACETS.name!, description: 'Name for the copy (default "<name> copy").' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { title: 'Duplicate a brush', ...WRITE },
      handler: async ({ id, newId, name }) => {
        const brush = await library.duplicate(id as string, { ...(newId !== undefined ? { id: newId as string } : {}), ...(name !== undefined ? { name: name as string } : {}) });
        return { id: brush.id, brush };
      },
    },
    {
      name: 'remove_brush',
      title: 'Remove a brush',
      description: 'Deletes a saved brush from the library for good (export_brushes first to keep a copy). Built-in presets are refused. Returns the id removed.',
      inputSchema: { type: 'object', properties: { id: { ...ID, description: 'The saved brush to remove (not a built-in).' } }, required: ['id'], additionalProperties: false },
      annotations: { title: 'Remove a brush', ...WRITE, destructiveHint: true },
      handler: async ({ id }) => {
        await entry(id as string);
        await library.remove(id as string);
        return { removed: id };
      },
    },
    {
      name: 'import_brushes',
      title: 'Import brushes',
      description: 'Adds the brushes of a library file (format pixerate-brushes version 2 from export_brushes, a version 1 file of the paint editor\'s brushes, which are migrated, or a bare list of brushes). Brushes with a built-in id are skipped, and so are ids already saved unless overwrite. Returns added, replaced and skipped ids and problems (each fix or skip, per brush).',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: ['object', 'array'], description: 'The library file object, or an array of brushes.' },
          overwrite: { type: 'boolean', description: 'Replace saved brushes with the same id (default false: skip them).' },
        },
        required: ['file'],
        additionalProperties: false,
      },
      annotations: { title: 'Import brushes', ...WRITE, destructiveHint: true },
      handler: async ({ file, overwrite }) => library.importFile(file, { overwrite: !!overwrite }),
    },
  );
  return tools;
}

/** The brush library tools as a provider (id `brushes` by default; namespaced, so they don't meet the paint editor's brush tools). */
export function createBrushLibraryToolProvider(library: BrushLibrary, options: BrushLibraryToolProviderOptions = {}): AgentToolProvider {
  const profile = options.profile ?? PAINT_PROFILE;
  const tools = createBrushLibraryTools(library, options);
  return {
    id: options.id ?? 'brushes',
    namespace: options.namespace,
    title: 'Brush library',
    description: `The shared brush library: find, describe, create, change, check and share brushes made of facets, for ${profile.name}.`,
    skill: 'pixerate-brushes',
    tools,
  };
}
