<script lang="ts">
  import { StickerBrowser, type PaintEditorController } from '@pixerate/editor/paint-editor';

  interface Props {
    controller: PaintEditorController;
    /** Refs shown as chosen. */
    selected: readonly string[];
    /** Called with a sticker's ref when it is clicked. */
    onpick: (ref: string) => void;
    /** Accessible name of the sticker list (default "Stickers"). */
    label?: string;
  }
  let { controller, selected, onpick, label = 'Stickers' }: Props = $props();
  const browser = $derived(new StickerBrowser(() => controller.stickersProvider));
  let s = $state(new StickerBrowser(() => controller.stickersProvider).state);
  $effect(() => {
    const b = browser;
    s = b.state;
    const off = b.subscribe(() => (s = b.state));
    void b.refresh();
    const offProvider = controller.stickers.subscribe(() => void b.refresh());
    return () => {
      off();
      offProvider();
    };
  });
  const failed = $derived(selected.map((ref) => ({ ref, ...controller.stickerArtStatus(ref) })).filter((x) => x.status === 'failed'));
</script>

<!-- Stickers from the paint editor's sticker library, searchable, by category and a page at a time; clicking one calls onpick with its ref. -->
<div class="flex flex-col gap-1" data-testid="sticker-picker">
  <div class="flex items-center gap-1">
    <input type="search" aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${s.provider}`} value={s.query} oninput={(e) => void browser.setQuery(e.currentTarget.value)} class="min-w-0 flex-1 rounded bg-slate-800 px-1 py-0.5" />
    {#if s.categories.length > 1}
      <select aria-label="Sticker category" value={s.category} onchange={(e) => void browser.setCategory(e.currentTarget.value)} class="rounded bg-slate-800 px-1 py-0.5">
        <option value="">All</option>
        {#each s.categories as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
      </select>
    {/if}
  </div>
  <div class="flex max-h-32 flex-wrap gap-1 overflow-y-auto" role="group" aria-label={label}>
    {#each s.items as it (it.ref)}
      <button
        type="button"
        aria-pressed={selected.includes(it.ref)}
        title={`${it.name} (${it.ref}) · ${it.licence.name}`}
        class={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${selected.includes(it.ref) ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300'}`}
        onclick={() => onpick(it.ref)}
      >
        {#if it.thumbnail}<img src={it.thumbnail} alt="" class="h-4 w-4" />{/if}{it.name}
      </button>
    {/each}
  </div>
  <div class="flex items-center justify-between text-[10px] text-slate-500">
    <span>{s.loading ? 'Loading…' : `${s.items.length} of ${s.total}`}</span>
    {#if s.hasMore}<button type="button" class="text-indigo-300" onclick={() => void browser.more()}>More</button>{/if}
  </div>
  {#if s.error}<p role="alert" class="text-[11px] text-rose-400">{s.error}</p>{/if}
  {#each failed as f (f.ref)}<p role="alert" class="text-[11px] text-rose-400">{f.ref}: {f.error}</p>{/each}
</div>
