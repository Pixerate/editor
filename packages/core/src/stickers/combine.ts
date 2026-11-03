import { StickerError } from './errors';
import { checkStickerSearchOptions, DEFAULT_STICKER_PAGE, parseStickerRef, stickerRefOf } from './helpers';
import type { StickerPage, StickerProvider, StickerSearchOptions, StickerSummary } from './types';

/**
 * One provider over several, in order. Its ids are refs (`provider:id`, `namespaced`), so the
 * same id from two libraries stays two stickers. Pages run through the providers in turn; the
 * cursor is `<provider index>|<that provider's cursor>`. Capabilities are what any of them offers.
 */
export function combineStickerProviders(providers: readonly StickerProvider[], options: { id?: string; name?: string } = {}): StickerProvider {
  const ids = providers.map((p) => p.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new StickerError('invalid_argument', `Two sticker providers have the id "${dup}"; give each a unique id.`);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const owner = (ref: string) => {
    const { provider, id } = parseStickerRef(ref);
    const p = byId.get(provider);
    if (!p) throw new StickerError('unknown_provider', `No sticker provider "${provider}"; the providers are ${ids.join(', ') || 'none'}.`);
    return { p, id };
  };
  const prefix = (p: StickerProvider, s: StickerSummary): StickerSummary => ({ ...s, id: stickerRefOf(p, s.id) });
  const page = async (query: string | null, o: StickerSearchOptions = {}): Promise<StickerPage> => {
    const { after, limit = DEFAULT_STICKER_PAGE, ...filters } = o;
    checkStickerSearchOptions({ limit });
    let i = 0;
    let inner: string | undefined;
    if (after !== undefined) {
      const m = /^(\d+)\|(.*)$/.exec(after);
      if (!m || Number(m[1]) >= providers.length) throw new StickerError('invalid_argument', `after "${after}" is not a cursor from this provider; pass the next value of the previous page.`);
      i = Number(m[1]);
      inner = m[2] || undefined;
    }
    const get = (p: StickerProvider, opts: StickerSearchOptions) => (query === null ? p.list(opts) : p.search(query, opts));
    let total = 0;
    for (const p of providers) total += (await get(p, { ...filters, limit: 1 })).total;
    const items: StickerSummary[] = [];
    let next: string | undefined;
    while (i < providers.length && items.length < limit) {
      const p = providers[i];
      const res = await get(p, { ...filters, limit: limit - items.length, ...(inner ? { after: inner } : {}) });
      items.push(...res.items.map((s) => prefix(p, s)));
      if (res.next && res.items.length) {
        // More from this provider: on this page if there is room, else on the next.
        inner = res.next;
        if (items.length >= limit) next = `${i}|${inner}`;
        continue;
      }
      i++;
      inner = undefined;
    }
    if (!next && items.length >= limit && i < providers.length) next = `${i}|`;
    return { items, total, ...(next ? { next } : {}) };
  };
  return {
    id: options.id ?? 'stickers',
    name: options.name ?? providers.map((p) => p.name).join(' + '),
    namespaced: true,
    capabilities: {
      supportsSearch: providers.some((p) => p.capabilities.supportsSearch),
      supportsSvg: providers.some((p) => p.capabilities.supportsSvg),
      supportsRaster: providers.some((p) => p.capabilities.supportsRaster),
      ...(providers.every((p) => p.capabilities.maxSize) ? { maxSize: Math.max(...providers.map((p) => p.capabilities.maxSize!)) } : {}),
    },
    list: (o) => page(null, o),
    search: (q, o) => page(q, o),
    async describe(ref) {
      let o;
      try {
        o = owner(ref);
      } catch {
        return undefined;
      }
      const d = await o.p.describe(o.id);
      return d ? { ...d, id: stickerRefOf(o.p, d.id) } : undefined;
    },
    async load(ref, o) {
      const { p, id } = owner(ref);
      return p.load(id, o);
    },
    async categories() {
      const counts = new Map<string, { id: string; name: string; count: number }>();
      for (const p of providers) {
        for (const c of (await p.categories?.()) ?? []) {
          const had = counts.get(c.id);
          counts.set(c.id, { id: c.id, name: had?.name ?? c.name, count: (had?.count ?? 0) + c.count });
        }
      }
      return [...counts.values()];
    },
  };
}
