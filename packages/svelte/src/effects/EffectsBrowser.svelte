<script lang="ts">
  import { EFFECT_USE_LABELS, type EffectProvider, type EffectSummary, type EffectUse } from '@pixerate/editor/effects';
  import EffectThumbnail from './EffectThumbnail.svelte';

  interface Props {
    /** The editor's provider; without one the browser says effects are unavailable. */
    provider: EffectProvider | null | undefined;
    /** Only effects with one of these uses (default: all but motion). */
    uses?: readonly EffectUse[];
    /** Called with the effect the user picks. */
    onpick: (effect: EffectSummary) => void;
    /** Draw previews with the provider's renderer (default true). */
    thumbnails?: boolean;
    /** Heading (default "Effects"; empty for none). */
    title?: string;
    class?: string;
  }

  let { provider, uses, onpick, thumbnails = true, title = 'Effects', class: className = '' }: Props = $props();
  let all = $state.raw<readonly EffectSummary[]>([]);
  let found = $state.raw<readonly EffectSummary[]>([]);
  let query = $state('');
  let category = $state('');
  let use = $state<EffectUse | ''>('');
  let error = $state<string | null>(null);

  $effect(() => {
    const p = provider;
    all = [];
    if (!p) return;
    let live = true;
    Promise.resolve()
      .then(() => p.list())
      .then(
        (list) => {
          if (live) (all = list), (error = null);
        },
        (e: unknown) => {
          if (live) error = e instanceof Error ? e.message : String(e);
        },
      );
    return () => {
      live = false;
    };
  });
  $effect(() => {
    const p = provider;
    const q = query;
    const options = { ...(category ? { category } : {}), ...(use ? { use } : {}) };
    if (!p) {
      found = [];
      return;
    }
    let live = true;
    Promise.resolve()
      .then(() => p.search(q, options))
      .then(
        (list) => {
          if (live) found = list;
        },
        () => {
          if (live) found = [];
        },
      );
    return () => {
      live = false;
    };
  });
  const allowed = (e: EffectSummary) => (uses ? e.kind !== 'motion' || uses.includes('motion') : e.kind !== 'motion') && (!uses || e.uses.some((u) => uses.includes(u)));
  const categories = $derived([...new Set(all.filter(allowed).map((e) => e.category))]);
  const shown = $derived(found.filter(allowed));
</script>

<!--
  Browses a provider's effects: a search box, a category filter (and a use filter when more than one
  use is allowed), and a grid of effects with previews. Picking one calls `onpick`.
-->
{#if !provider}
  <div class="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground {className}" data-effects-browser="" data-effects-unavailable="">
    No effects provider is registered, so effects cannot be added. Effects already in the document are kept.
  </div>
{:else}
  <section class="flex flex-col gap-2 {className}" data-effects-browser="" aria-label="Effects browser">
    {#if title}<h3 class="text-xs font-semibold">{title}</h3>{/if}
    <div class="flex flex-wrap gap-1">
      <input type="search" class="min-w-0 flex-1 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs" placeholder="Search effects" aria-label="Search effects" bind:value={query} />
      <select class="rounded border border-border bg-transparent px-1 py-0.5 text-xs" aria-label="Category" bind:value={category}>
        <option value="">All categories</option>
        {#each categories as c (c)}<option value={c}>{c}</option>{/each}
      </select>
      {#if uses && uses.length > 1}
        <select class="rounded border border-border bg-transparent px-1 py-0.5 text-xs" aria-label="Use" bind:value={use}>
          <option value="">Any use</option>
          {#each uses as u (u)}<option value={u}>{EFFECT_USE_LABELS[u]}</option>{/each}
        </select>
      {/if}
    </div>
    {#if error}<p role="alert" class="text-[11px] text-destructive">{error}</p>{/if}
    <ul class="grid max-h-96 grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-1.5 overflow-y-auto" role="list">
      {#each shown as e (e.id)}
        <li>
          <button type="button" class="flex w-full flex-col gap-1 rounded border border-transparent p-1 text-left hover:border-border focus-visible:border-border" title={e.description ?? e.name} data-effect-id={e.id} onclick={() => onpick(e)}>
            {#if thumbnails}<EffectThumbnail {provider} effect={e} />{/if}
            <span class="truncate text-[11px] font-medium">{e.name}</span>
            <span class="truncate text-[10px] text-muted-foreground">{e.uses.map((u) => EFFECT_USE_LABELS[u]).join(' · ')}</span>
          </button>
        </li>
      {/each}
    </ul>
    {#if !shown.length && !error}<p class="text-[11px] text-muted-foreground">No effects match.</p>{/if}
  </section>
{/if}
