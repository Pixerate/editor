/**
 * `StickerBrowser`: the state behind a sticker picker, shared by the React and Svelte pickers. It
 * searches or lists the provider a page at a time (search words, category, collection), keeps the
 * pages it has loaded, its categories and collections, and tells listeners when anything changes.
 * UI-agnostic.
 */

import { providerCollections, stickerRefOf } from './helpers';
import type { StickerCollection, StickerProvider, StickerRef, StickerSummary } from './types';

export interface StickerBrowserItem extends StickerSummary {
  ref: StickerRef;
}

export interface StickerBrowserState {
  query: string;
  /** `''` for every category. */
  category: string;
  /** `''` for every collection. */
  collection: string;
  items: StickerBrowserItem[];
  total: number;
  /** More pages to load (`more()`). */
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  categories: Array<{ id: string; name: string; count: number }>;
  /** The provider's collections (empty when it has none). */
  collections: StickerCollection[];
  /** The provider's name. */
  provider: string;
}

export class StickerBrowser {
  private s: StickerBrowserState;
  private next: string | undefined;
  private run = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly provider: () => StickerProvider,
    private readonly pageSize = 24
  ) {
    this.s = { query: '', category: '', collection: '', items: [], total: 0, hasMore: false, loading: false, error: null, categories: [], collections: [], provider: provider().name };
  }

  get state(): StickerBrowserState {
    return this.s;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<StickerBrowserState>): void {
    this.s = { ...this.s, ...patch };
    for (const l of [...this.listeners]) l();
  }

  /** Loads the first page (and the categories) again, for the current provider. */
  async refresh(): Promise<void> {
    const run = ++this.run;
    const p = this.provider();
    this.next = undefined;
    this.set({ loading: true, error: null, items: [], total: 0, hasMore: false, provider: p.name });
    try {
      const categories = (await p.categories?.()) ?? [];
      const collections = (await providerCollections(p)) ?? [];
      if (run !== this.run) return;
      // A collection the new provider doesn't have shows everything.
      this.set({ categories, collections, ...(this.s.collection && !collections.some((c) => c.id === this.s.collection) ? { collection: '' } : {}) });
      await this.page(run, p, true);
    } catch (e) {
      if (run === this.run) this.set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Searches for `query` (words; `''` lists everything) from the first page. */
  setQuery(query: string): Promise<void> {
    this.s = { ...this.s, query };
    return this.refresh();
  }

  /** Shows one category (`''` for all) from the first page. */
  setCategory(category: string): Promise<void> {
    this.s = { ...this.s, category };
    return this.refresh();
  }

  /** Shows one collection (`''` for all) from the first page. */
  setCollection(collection: string): Promise<void> {
    this.s = { ...this.s, collection };
    return this.refresh();
  }

  /** Loads the next page onto the list. */
  async more(): Promise<void> {
    if (!this.next || this.s.loading) return;
    const run = this.run;
    this.set({ loading: true });
    try {
      await this.page(run, this.provider(), false);
    } catch (e) {
      if (run === this.run) this.set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async page(run: number, p: StickerProvider, first: boolean): Promise<void> {
    const options = { limit: this.pageSize, ...(this.s.category ? { category: this.s.category } : {}), ...(this.s.collection ? { collection: this.s.collection } : {}), ...(!first && this.next ? { after: this.next } : {}) };
    const q = this.s.query.trim();
    const res = q && p.capabilities.supportsSearch ? await p.search(q, options) : await p.list(options);
    if (run !== this.run) return;
    this.next = res.next;
    const items = res.items.map((s) => ({ ...s, ref: stickerRefOf(p, s.id) }));
    this.set({ items: first ? items : [...this.s.items, ...items], total: res.total, hasMore: Boolean(res.next), loading: false });
  }
}
