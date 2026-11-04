<script lang="ts">
  import type { Snippet } from 'svelte';
  import { StickerBrowser, type StickerBrowserItem, type StickerBrowserState, type StickerProvider } from '@pixerate/editor/stickers';

  interface Props {
    /** The sticker library (e.g. `editorStickers()`, a host's, or `combineStickerProviders([...])`). */
    provider: StickerProvider;
    /** Refs shown as chosen. */
    selected?: readonly string[];
    /** Called with a sticker when it is clicked. */
    onpick: (sticker: StickerBrowserItem) => void;
    /** Accessible name of the sticker list (default "Stickers"). */
    label?: string;
    /** Shown under the list (e.g. load errors). */
    footer?: Snippet;
    class?: string;
  }
  let { provider, selected = [], onpick, label = 'Stickers', footer, class: className = '' }: Props = $props();
  const browser = $derived(new StickerBrowser(() => provider));
  let s = $state<StickerBrowserState | null>(null);
  $effect(() => {
    const b = browser;
    s = b.state;
    const off = b.subscribe(() => (s = b.state));
    void b.refresh();
    return off;
  });
  /** A sticker's tooltip: name, ref, licence and credit, AI-generated, dark variant. */
  const tooltip = (it: StickerBrowserItem) => `${it.name} (${it.ref}) · ${it.licence.name}${it.licence.attribution ? ` · ${it.licence.attribution}` : ''}${it.aiGenerated ? ' · AI-generated' : ''}${it.variants?.includes('dark') ? ' · light and dark' : ''}`;
</script>

<!-- Stickers from a sticker library: searchable, by category or collection and a page at a time, each sticker's licence in its tooltip and an AI label on AI-generated art; clicking one calls onpick. -->
<div class={`flex flex-col gap-1 ${className}`} data-testid="sticker-picker">
  {#if s}
    <div class="flex items-center gap-1">
      <input type="search" aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${s.provider}`} value={s.query} oninput={(e) => void browser.setQuery(e.currentTarget.value)} class="min-w-0 flex-1 rounded bg-slate-800 px-1 py-0.5" />
      {#if s.categories.length > 1}
        <select aria-label="Sticker category" value={s.category} onchange={(e) => void browser.setCategory(e.currentTarget.value)} class="rounded bg-slate-800 px-1 py-0.5">
          <option value="">All</option>
          {#each s.categories as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
        </select>
      {/if}
      {#if s.collections.length > 0}
        <select aria-label="Sticker collection" value={s.collection} onchange={(e) => void browser.setCollection(e.currentTarget.value)} class="rounded bg-slate-800 px-1 py-0.5">
          <option value="">All collections</option>
          {#each s.collections as c (c.id)}<option value={c.id} title={c.description}>{c.name} ({c.count})</option>{/each}
        </select>
      {/if}
    </div>
    <div class="flex max-h-32 flex-wrap gap-1 overflow-y-auto" role="group" aria-label={label}>
      {#each s.items as it (it.ref)}
        <button
          type="button"
          aria-pressed={selected.includes(it.ref)}
          title={tooltip(it)}
          class={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${selected.includes(it.ref) ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'}`}
          onclick={() => onpick(it)}
        >
          {#if it.thumbnail}<img src={it.thumbnail} alt="" class="h-4 w-4" />{/if}{it.name}{#if it.aiGenerated}<span class="rounded bg-slate-700 px-0.5 text-[8px] text-slate-200" aria-label="AI-generated">AI</span>{/if}
        </button>
      {/each}
    </div>
    <div class="flex items-center justify-between text-[10px] text-slate-500">
      <span>{s.loading ? 'Loading…' : `${s.items.length} of ${s.total}`}</span>
      {#if s.hasMore}<button type="button" class="text-indigo-300" onclick={() => void browser.more()}>More</button>{/if}
    </div>
    {#if s.error}<p role="alert" class="text-[11px] text-rose-400">{s.error}</p>{/if}
  {/if}
  {@render footer?.()}
</div>
