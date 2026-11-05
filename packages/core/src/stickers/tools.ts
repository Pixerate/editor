/**
 * Agent tools for a sticker library: `find_stickers` (search and page) and `describe_sticker`.
 * Every sticker comes back as a `ref` (`provider:id`) for the editors' tools that place or spray
 * stickers. Refusals name the valid choices.
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import { StickerError } from './errors';
import { closestStickerRefs, MAX_STICKER_PAGE, parseStickerRef, providerCollections, stickerIdFor, stickerRefOf, stickerVariantFor, stickerVariantsOf } from './helpers';
import { STICKER_VARIANTS, type MaybePromise, type StickerAsset, type StickerDescription, type StickerFormat, type StickerProvider, type StickerRef, type StickerSummary, type StickerVariant } from './types';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/** Where and how big an inserted sticker goes, with its art. */
export interface StickerPlacement {
  ref: StickerRef;
  description: StickerDescription;
  asset: StickerAsset;
  /** Centre, in the editor's document units. */
  x: number;
  y: number;
  /** Size of its box (the natural aspect kept). */
  width: number;
  height: number;
  /** #rrggbb it was tinted to, when tintable and asked for. */
  colour?: string;
  /** The variant its art is (`dark` for a dark background, when the sticker has it). */
  variant: StickerVariant;
}

/**
 * An editor that can take an inserted sticker (`insert_sticker`): the vector editor (editable
 * paths), the image editor (a pixel layer), the canvas (a shape node) or any other.
 */
export interface StickerInsertHost {
  /** What the editor calls the thing it makes ("group", "layer", "node"), for descriptions. */
  noun: string;
  /** The format it wants first (it gets the other when the sticker has only that). */
  format: StickerFormat;
  /** The default centre when the call gives none (the middle of the view or document). */
  defaultCentre(): { x: number; y: number };
  /** The background is dark (a dark canvas or theme): stickers with a dark variant use it unless the call names one. */
  dark?(): boolean;
  /** Adds the sticker as one undo step; returns what it made (its id at least) for later tools. */
  insert(placement: StickerPlacement): MaybePromise<{ id: string } & Record<string, unknown>>;
}

/** A summary as the tools return it: `ref` instead of the provider's id. */
export function stickerForAgent(provider: StickerProvider, s: StickerSummary): Record<string, unknown> {
  const { id, thumbnail: _thumbnail, ...rest } = s;
  return { ref: stickerRefOf(provider, id), ...rest };
}

/** Every ref the provider lists (up to `cap`), for "did you mean" refusals. */
async function knownRefs(provider: StickerProvider, cap = 500): Promise<string[]> {
  const refs: string[] = [];
  let after: string | undefined;
  while (refs.length < cap) {
    const page = await provider.list({ limit: MAX_STICKER_PAGE, ...(after ? { after } : {}) });
    refs.push(...page.items.map((s) => stickerRefOf(provider, s.id)));
    if (!page.next || !page.items.length) break;
    after = page.next;
  }
  return refs;
}

/**
 * Looks up `ref` in `provider`, refusing an unknown or foreign ref with the closest ones it has.
 * The editors use it to check refs before spraying or placing them.
 */
export async function describeStickerRef(provider: StickerProvider, ref: StickerRef): Promise<StickerDescription> {
  parseStickerRef(ref);
  const id = stickerIdFor(provider, ref);
  const found = id === null ? undefined : await provider.describe(id);
  if (found) return found;
  const near = closestStickerRefs(ref, await knownRefs(provider));
  const owner = parseStickerRef(ref).provider;
  const where = id === null && !provider.namespaced ? ` The sticker library is "${provider.id}", not "${owner}".` : '';
  throw new StickerError('unknown_sticker', `No sticker "${ref}".${where} Closest: ${near.join(', ') || 'none'}; find_stickers lists them.`);
}

export interface StickerToolsOptions {
  /** The provider to use, read on every call (an editor's `StickersSlot`). */
  provider: () => StickerProvider;
  /** With it, `insert_sticker` puts a sticker into this editor. */
  insert?: StickerInsertHost;
}

/** `find_stickers` and `describe_sticker` over the provider `options.provider()` returns. */
export function createStickerTools(options: StickerToolsOptions): AgentTool[] {
  const find: AgentTool = {
    name: 'find_stickers',
    title: 'Find stickers',
    description:
      'Searches the sticker library (the editor\'s own stamps unless the host plugged in its own): words in the name, tags, category or description, filtered by category, collection, tags and commercial licence, a small page at a time. Returns each sticker\'s ref (provider:id, for the tools that spray or place stickers), name, category, tags, natural width and height, formats, whether it is tintable (recoloured to the paint colour), its licence, aiGenerated when the provider says whether AI made the art, variants (light, and dark when it has art for dark backgrounds) and its collection, plus total and next (pass as after for the next page), the categories and the collections. Changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200, description: 'Words to match (default: list everything).' },
        category: { type: 'string', description: 'Only this category (the result lists them).' },
        collection: { type: 'string', minLength: 1, description: 'Only this collection id (the result lists them; default every collection).' },
        tags: { type: 'array', maxItems: 10, items: { type: 'string', description: 'A tag.' }, description: 'Only stickers with every one of these tags.' },
        commercial: { type: 'boolean', description: 'true: only stickers whose licence allows commercial use.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_STICKER_PAGE, description: 'Page size (default 24).' },
        after: { type: 'string', description: 'next from the previous page.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Find stickers', ...READ },
    handler: async ({ query, category, collection, tags, commercial, limit, after }) => {
      const p = options.provider();
      const categories = (await p.categories?.()) ?? null;
      if (category !== undefined && categories && !categories.some((c) => c.id === category)) {
        throw new StickerError('invalid_argument', `No category "${category}" in "${p.name}"; categories: ${categories.map((c) => c.id).join(', ')}.`);
      }
      const collections = (await providerCollections(p)) ?? null;
      if (collection !== undefined && !collections?.some((c) => c.id === collection)) {
        throw new StickerError('invalid_argument', collections?.length ? `No collection "${collection}" in "${p.name}"; collections: ${collections.map((c) => c.id).join(', ')}.` : `"${p.name}" has no collections; leave collection out.`);
      }
      const o = { ...(category !== undefined ? { category: category as string } : {}), ...(collection !== undefined ? { collection: collection as string } : {}), ...(tags ? { tags: tags as string[] } : {}), ...(commercial ? { licence: { commercial: true } } : {}), ...(limit !== undefined ? { limit: limit as number } : {}), ...(after !== undefined ? { after: after as string } : {}) };
      const q = typeof query === 'string' ? query.trim() : '';
      if (q && !p.capabilities.supportsSearch) throw new StickerError('invalid_argument', `"${p.name}" can't search; leave query out and filter by category instead.`);
      const page = q ? await p.search(q, o) : await p.list(o);
      return { provider: p.id, items: page.items.map((s) => stickerForAgent(p, s)), total: page.total, ...(page.next ? { next: page.next } : {}), ...(categories ? { categories } : {}), ...(collections?.length ? { collections } : {}) };
    },
  };
  const describe: AgentTool = {
    name: 'describe_sticker',
    title: 'Describe a sticker',
    description:
      'Everything about one sticker by ref (from find_stickers): name, category, collection, tags, natural size, formats, tintable, licence (with any attribution it asks for), aiGenerated, variants (light / dark), dominant colours and its outline as SVG path data (silhouette). An unknown ref is refused with the closest refs. Changes nothing.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'Sticker ref provider:id from find_stickers (e.g. editor:star).' } }, required: ['ref'], additionalProperties: false },
    annotations: { title: 'Describe a sticker', ...READ },
    handler: async ({ ref }) => {
      const p = options.provider();
      const d = await describeStickerRef(p, ref as string);
      const { thumbnail: _thumbnail, id, ...rest } = d;
      return { ref: stickerRefOf(p, id), ...rest };
    },
  };
  return options.insert ? [find, describe, createInsertStickerTool(options.provider, options.insert)] : [find, describe];
}

/** Loads a sticker's art in the host's format (or the other one it has), tinted when asked and tintable. */
async function loadForHost(provider: StickerProvider, ref: StickerRef, d: StickerDescription, host: StickerInsertHost, colour: string | undefined, size: number, variant: StickerVariant): Promise<StickerAsset> {
  const id = stickerIdFor(provider, ref)!;
  const format: StickerFormat = d.formats.includes(host.format) ? host.format : (d.formats[0] ?? host.format);
  return provider.load(id, { format, ...(format === 'png' ? { size: Math.max(8, Math.min(provider.capabilities.maxSize ?? 1024, Math.round(size))) } : {}), ...(colour && d.tintable ? { colour } : {}), ...(variant !== 'light' ? { variant } : {}) });
}

/**
 * Puts one sticker into an editor through its host (the panels and `insert_sticker` both use it):
 * checks the ref, loads the art in the host's format, tinted when asked and tintable, and places
 * it centred at (`x`, `y`) (default the host's centre), `width` wide (default its natural width).
 * The art is the `variant` asked for, else the dark one when the host's background is dark and
 * the sticker has it. Returns what the host made, the ref, the size, the variant and the licence.
 */
export async function insertSticker(provider: StickerProvider, host: StickerInsertHost, options: { ref: StickerRef; x?: number; y?: number; width?: number; color?: string; variant?: StickerVariant }): Promise<{ id: string; ref: StickerRef; width: number; height: number; variant: StickerVariant; licence: StickerDescription['licence'] } & Record<string, unknown>> {
  const d = await describeStickerRef(provider, options.ref);
  const has = stickerVariantsOf(d);
  if (options.variant !== undefined && !has.includes(options.variant)) throw new StickerError('unsupported_variant', `"${options.ref}" has no ${JSON.stringify(options.variant)} variant; it has ${has.join(', ')}. Leave variant out to pick for the background.`);
  const variant = options.variant ?? stickerVariantFor(d, host.dark?.() ?? false);
  if (options.color !== undefined && !d.tintable) throw new StickerError('invalid_argument', `"${options.ref}" is not tintable (its art has its own colours); leave color out, or pick a tintable sticker (find_stickers lists tintable).`);
  if (options.width !== undefined && !(options.width > 0)) throw new StickerError('invalid_argument', `width must be a positive size, got ${options.width}.`);
  const w = options.width ?? d.width;
  const h = (w * d.height) / d.width;
  const centre = host.defaultCentre();
  const asset = await loadForHost(provider, options.ref, d, host, options.color, Math.max(w, h), variant);
  const ref = stickerRefOf(provider, d.id);
  const made = await host.insert({ ref, description: d, asset, variant, x: options.x ?? centre.x, y: options.y ?? centre.y, width: w, height: h, ...(options.color ? { colour: options.color.toLowerCase() } : {}) });
  return { ...made, ref, width: w, height: h, variant, licence: d.licence };
}

/** `insert_sticker`: one sticker by ref into an editor, at a place and size, as one undo step. */
export function createInsertStickerTool(provider: () => StickerProvider, host: StickerInsertHost): AgentTool {
  return {
    name: 'insert_sticker',
    title: 'Insert a sticker',
    description: `Puts one sticker from the sticker library (ref from find_stickers) into the document as a new ${host.noun}, centred at x, y and width wide (its natural aspect kept; default its natural size), tinted to color when the sticker is tintable, in its dark variant when the background is dark and it has one (or the variant asked for). Its art is loaded first; an unknown ref is refused with the closest ones. One undo step. Returns the new ${host.noun}'s id (for the editor's own tools, such as effects on it), the ref, the variant used and its licence (credit any attribution it asks for).`,
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', minLength: 1, description: 'Sticker ref provider:id from find_stickers (e.g. editor:star).' },
        x: { type: 'number', description: 'Centre x in document units (default the middle of the view or document).' },
        y: { type: 'number', description: 'Centre y in document units (default the middle of the view or document).' },
        width: { type: 'number', exclusiveMinimum: 0, maximum: 10000, description: 'Width in document units (default the natural width); the height follows the aspect.' },
        color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Tint #rrggbb for tintable stickers (default the sticker\'s own colour); refused for stickers that are not tintable.' },
        variant: { type: 'string', enum: [...STICKER_VARIANTS], description: 'light or dark art (default: dark on a dark background when the sticker has it, else light); one the sticker does not list (find_stickers variants) is refused.' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    annotations: { title: 'Insert a sticker', ...WRITE },
    handler: ({ ref, x, y, width, color, variant }) => insertSticker(provider(), host, { ref: ref as string, x: x as number | undefined, y: y as number | undefined, width: width as number | undefined, color: color as string | undefined, variant: variant as StickerVariant | undefined }),
  };
}

/** The sticker library tools as a provider (id `stickers` by default). */
export function createStickerToolProvider(options: StickerToolsOptions & { id?: string; namespace?: string }): AgentToolProvider {
  return {
    id: options.id ?? 'stickers',
    namespace: options.namespace,
    title: 'Stickers',
    description: 'Find and describe stickers from the sticker library, by ref (provider:id), for the editors that spray or place them.',
    skill: 'pixerate-stickers',
    tools: createStickerTools(options),
  };
}
