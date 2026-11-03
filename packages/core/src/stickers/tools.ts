/**
 * Agent tools for a sticker library: `find_stickers` (search and page) and `describe_sticker`.
 * Every sticker comes back as a `ref` (`provider:id`) for the editors' tools that place or spray
 * stickers. Refusals name the valid choices.
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import { StickerError } from './errors';
import { closestStickerRefs, MAX_STICKER_PAGE, parseStickerRef, stickerIdFor, stickerRefOf } from './helpers';
import type { StickerDescription, StickerProvider, StickerRef, StickerSummary } from './types';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

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
}

/** `find_stickers` and `describe_sticker` over the provider `options.provider()` returns. */
export function createStickerTools(options: StickerToolsOptions): AgentTool[] {
  const find: AgentTool = {
    name: 'find_stickers',
    title: 'Find stickers',
    description:
      'Searches the sticker library (the editor\'s own stamps unless the host plugged in its own): words in the name, tags, category or description, filtered by category, tags and commercial licence, a small page at a time. Returns each sticker\'s ref (provider:id, for the tools that spray or place stickers), name, category, tags, natural width and height, formats, whether it is tintable (recoloured to the paint colour) and its licence, plus total and next (pass as after for the next page) and the categories. Changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200, description: 'Words to match (default: list everything).' },
        category: { type: 'string', description: 'Only this category (the result lists them).' },
        tags: { type: 'array', maxItems: 10, items: { type: 'string', description: 'A tag.' }, description: 'Only stickers with every one of these tags.' },
        commercial: { type: 'boolean', description: 'true: only stickers whose licence allows commercial use.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_STICKER_PAGE, description: 'Page size (default 24).' },
        after: { type: 'string', description: 'next from the previous page.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Find stickers', ...READ },
    handler: async ({ query, category, tags, commercial, limit, after }) => {
      const p = options.provider();
      const categories = (await p.categories?.()) ?? null;
      if (category !== undefined && categories && !categories.some((c) => c.id === category)) {
        throw new StickerError('invalid_argument', `No category "${category}" in "${p.name}"; categories: ${categories.map((c) => c.id).join(', ')}.`);
      }
      const o = { ...(category !== undefined ? { category: category as string } : {}), ...(tags ? { tags: tags as string[] } : {}), ...(commercial ? { licence: { commercial: true } } : {}), ...(limit !== undefined ? { limit: limit as number } : {}), ...(after !== undefined ? { after: after as string } : {}) };
      const q = typeof query === 'string' ? query.trim() : '';
      if (q && !p.capabilities.supportsSearch) throw new StickerError('invalid_argument', `"${p.name}" can't search; leave query out and filter by category instead.`);
      const page = q ? await p.search(q, o) : await p.list(o);
      return { provider: p.id, items: page.items.map((s) => stickerForAgent(p, s)), total: page.total, ...(page.next ? { next: page.next } : {}), ...(categories ? { categories } : {}) };
    },
  };
  const describe: AgentTool = {
    name: 'describe_sticker',
    title: 'Describe a sticker',
    description:
      'Everything about one sticker by ref (from find_stickers): name, category, tags, natural size, formats, tintable, licence (with any attribution it asks for), dominant colours, variants and its outline as SVG path data (silhouette). An unknown ref is refused with the closest refs. Changes nothing.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'Sticker ref provider:id from find_stickers (e.g. editor:star).' } }, required: ['ref'], additionalProperties: false },
    annotations: { title: 'Describe a sticker', ...READ },
    handler: async ({ ref }) => {
      const p = options.provider();
      const d = await describeStickerRef(p, ref as string);
      const { thumbnail: _thumbnail, id, ...rest } = d;
      return { ref: stickerRefOf(p, id), ...rest };
    },
  };
  return [find, describe];
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
