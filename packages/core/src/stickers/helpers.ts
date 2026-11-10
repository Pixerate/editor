/**
 * Helpers for sticker providers and the editors that use them: paging and searching an in-memory
 * catalogue, `provider:id` refs, and the slot an editor keeps its provider in.
 */

import { StickerError } from './errors';
import { STAMP_KINDS, type StampKind } from './stamps';
import { STICKER_VARIANTS, type StickerCollection, type StickerPage, type StickerProvider, type StickerRef, type StickerSearchOptions, type StickerSummary, type StickerVariant } from './types';

/** Default and largest page size. */
export const DEFAULT_STICKER_PAGE = 24;
export const MAX_STICKER_PAGE = 100;
/** The id of the editor's own sticker set (`editorStickers()`). */
export const EDITOR_STICKERS_ID = 'editor';

/** Checks search options, throwing a `StickerError` that names the bad one. */
export function checkStickerSearchOptions(options: StickerSearchOptions = {}): void {
  if (options.limit !== undefined && !(Number.isInteger(options.limit) && options.limit >= 1 && options.limit <= MAX_STICKER_PAGE)) {
    throw new StickerError('invalid_argument', `limit must be a whole number from 1 to ${MAX_STICKER_PAGE}, got ${options.limit}.`);
  }
  if (options.after !== undefined && !/^\d+$/.test(options.after)) throw new StickerError('invalid_argument', `after "${options.after}" is not a cursor from this provider; pass the next value of the previous page.`);
}

/** The words of a query or a sticker, lower case. */
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * One page of `items` filtered by `options` (category, collection, every tag, commercial licence) and, when
 * `query` has words, by every word appearing in the name, tags, category or description. Cursors
 * are offsets as strings.
 */
export function stickerPage(items: readonly StickerSummary[], options: StickerSearchOptions = {}, query = ''): StickerPage {
  checkStickerSearchOptions(options);
  const q = words(query);
  const tags = (options.tags ?? []).map((t) => t.toLowerCase());
  const matches = items.filter((s) => {
    if (options.category && s.category !== options.category) return false;
    if (options.collection && s.collection !== options.collection) return false;
    if (tags.length && !tags.every((t) => (s.tags ?? []).some((x) => x.toLowerCase() === t))) return false;
    if (options.licence?.commercial === true && !s.licence.commercial) return false;
    if (!q.length) return true;
    const text = new Set(words([s.name, s.category, s.description ?? '', ...(s.tags ?? [])].join(' ')));
    return q.every((w) => [...text].some((t) => t.startsWith(w)));
  });
  const start = options.after ? Number(options.after) : 0;
  const limit = options.limit ?? DEFAULT_STICKER_PAGE;
  const page = matches.slice(start, start + limit);
  return { items: page, total: matches.length, ...(start + limit < matches.length ? { next: String(start + limit) } : {}) };
}

/** The variants a sticker has (`light` always, first). */
export function stickerVariantsOf(s: Pick<StickerSummary, 'variants'>): StickerVariant[] {
  return STICKER_VARIANTS.filter((v) => v === 'light' || s.variants?.includes(v));
}

/**
 * Checks `load`'s variant against the sticker's, throwing an `unsupported_variant` `StickerError`
 * that names the ones it has. Providers call it at the top of `load`; returns the variant to draw.
 */
export function checkStickerVariant(s: Pick<StickerSummary, 'id' | 'variants'>, variant: StickerVariant | undefined): StickerVariant {
  const v = variant ?? 'light';
  const has = stickerVariantsOf(s);
  if (!has.includes(v)) throw new StickerError('unsupported_variant', `Sticker "${s.id}" has no ${JSON.stringify(v)} variant; it has ${has.join(', ')}.`);
  return v;
}

/** The variant to show on a dark or light background: `dark` when the background is dark and the sticker has it, else `light`. */
export function stickerVariantFor(s: Pick<StickerSummary, 'variants'>, dark: boolean): StickerVariant {
  return dark && s.variants?.includes('dark') ? 'dark' : 'light';
}

/**
 * Checks `load`'s frame against the sticker's `frameCount`, throwing an `invalid_argument` `StickerError`
 * when out of range. Providers call it at the top of `load`; returns the 0-based frame index to draw.
 */
export function checkStickerFrame(s: Pick<StickerSummary, 'id' | 'animated' | 'frameCount'>, frame: number | undefined): number {
  const f = frame ?? 0;
  const count = s.animated ? Math.max(1, s.frameCount ?? 1) : 1;
  if (!Number.isInteger(f) || f < 0 || f >= count) {
    throw new StickerError('invalid_argument', `Sticker "${s.id}" has ${count} frame(s) (0..${count - 1}), got frame ${JSON.stringify(frame)}.`);
  }
  return f;
}

/** The collections of an in-memory catalogue with their counts, in first-seen order; `names` gives names and descriptions by id. */
export function stickerCollections(items: readonly StickerSummary[], names: Record<string, { name: string; description?: string }> = {}): StickerCollection[] {
  const out = new Map<string, StickerCollection>();
  for (const s of items) {
    if (!s.collection) continue;
    const c = out.get(s.collection) ?? { id: s.collection, ...(names[s.collection] ?? { name: s.collection }), count: 0 };
    c.count++;
    out.set(s.collection, c);
  }
  return [...out.values()];
}

/** Calls `provider.collections()` or `provider.listCollections()` when the provider defines either. */
export function providerCollections(provider: StickerProvider): ReturnType<NonNullable<StickerProvider['collections']>> | undefined {
  return provider.collections ? provider.collections() : provider.listCollections?.();
}

/** A ref split into provider and id. A bare editor stamp (`"star"`) is `editor:star`; any other bare id is refused. */
export function parseStickerRef(ref: StickerRef): { provider: string; id: string } {
  if (typeof ref !== 'string' || !ref) throw new StickerError('invalid_argument', 'A sticker ref is a "provider:id" string, e.g. "editor:star" (find_stickers lists them).');
  const i = ref.indexOf(':');
  if (i === -1) {
    if (STAMP_KINDS.includes(ref as StampKind)) return { provider: EDITOR_STICKERS_ID, id: ref };
    throw new StickerError('invalid_argument', `"${ref}" is not a sticker ref; refs are "provider:id" (e.g. "editor:${STAMP_KINDS[1]}"); find_stickers lists them.`);
  }
  if (i === 0 || i === ref.length - 1) throw new StickerError('invalid_argument', `"${ref}" is not a sticker ref; refs are "provider:id".`);
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

/** The canonical form of a ref (`"star"` → `"editor:star"`). */
export function normalizeStickerRef(ref: StickerRef): StickerRef {
  const { provider, id } = parseStickerRef(ref);
  return `${provider}:${id}`;
}

/** The editor stamp a ref names, or `null` for another provider's sticker. */
export function editorStampOf(ref: StickerRef): StampKind | null {
  const { provider, id } = parseStickerRef(ref);
  return provider === EDITOR_STICKERS_ID && STAMP_KINDS.includes(id as StampKind) ? (id as StampKind) : null;
}

/** The ref of a sticker `id` listed by `provider`. */
export function stickerRefOf(provider: StickerProvider, id: string): StickerRef {
  return provider.namespaced ? id : `${provider.id}:${id}`;
}

/**
 * The id to pass to `provider` for `ref`, or `null` when the ref names another provider. A
 * combined provider takes the whole ref; any other takes the part after its own id.
 */
export function stickerIdFor(provider: StickerProvider, ref: StickerRef): string | null {
  const { provider: owner, id } = parseStickerRef(ref);
  if (provider.namespaced) return `${owner}:${id}`;
  return owner === provider.id ? id : null;
}

/** Up to `n` of `candidates` closest to `wanted` (shared prefix, then edit distance), for "did you mean" refusals. */
export function closestStickerRefs(wanted: string, candidates: readonly string[], n = 3): string[] {
  const w = wanted.toLowerCase();
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0];
      d[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = d[j];
        d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return d[b.length];
  };
  return [...candidates].sort((a, b) => dist(w, a.toLowerCase()) - dist(w, b.toLowerCase()) || a.localeCompare(b)).slice(0, n);
}

/**
 * Holds an editor's sticker provider: the editor's own set (`editorStickers()`) until a host sets
 * another. Controllers expose it as `stickersProvider` and `setStickersProvider(provider | null)`
 * (`null` goes back to the default); listeners hear every change.
 */
export class StickersSlot {
  private current: StickerProvider;
  private readonly listeners = new Set<(provider: StickerProvider) => void>();

  constructor(readonly fallback: StickerProvider) {
    this.current = fallback;
  }

  get provider(): StickerProvider {
    return this.current;
  }

  set(provider: StickerProvider | null): void {
    const next = provider ?? this.fallback;
    if (next === this.current) return;
    this.current = next;
    for (const l of [...this.listeners]) l(next);
  }

  subscribe(listener: (provider: StickerProvider) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
