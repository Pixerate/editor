<script lang="ts">
  import { brushLibraryGroups, type BrushHostProfile, type BrushLibraryEntry } from '@pixerate/editor/brushes';
  import PixelCanvas from './PixelCanvas.svelte';

  interface Props {
    /** The library's brushes (built-in presets and saved ones), as facets. */
    entries: readonly BrushLibraryEntry[];
    /** The active brush id. */
    activeId?: string;
    onselect: (id: string) => void;
    /** Only brushes this host renders. */
    profile?: BrushHostProfile;
    /** A thumbnail for a brush (a test stroke). */
    thumbnail?: (id: string) => { width: number; height: number; data: Uint8ClampedArray } | null;
    thumbnailWidth?: number;
    thumbnailHeight?: number;
    class?: string;
  }
  let { entries, activeId, onselect, profile, thumbnail, thumbnailWidth = 112, thumbnailHeight = 32, class: className = '' }: Props = $props();
  let text = $state('');
  const groups = $derived(brushLibraryGroups(entries, { text, profile }));
</script>

<!-- The brush library grouped by medium, then variety, with tools as their own group, and a filter (brushLibraryGroups). -->
<div class={`flex flex-col gap-1 ${className}`} data-testid="brush-library">
  <input type="search" bind:value={text} placeholder="Find a brush" aria-label="Find a brush" class="rounded bg-slate-800 px-1.5 py-0.5" />
  <div class="flex flex-col gap-1.5" role="listbox" aria-label="Brushes">
    {#each groups as g (g.id)}
      <div role="group" aria-label={g.title} class="flex flex-col gap-0.5">
        <span class="text-[10px] uppercase tracking-wide text-slate-500">{g.title}</span>
        <div class="grid grid-cols-2 gap-1">
          {#each g.varieties as v (v.variety)}
            {#each v.entries as e (e.brush.id)}
              <button
                type="button"
                role="option"
                aria-selected={activeId === e.brush.id}
                title={[e.brush.name, v.title.toLowerCase() === e.brush.name.toLowerCase() ? '' : v.title, e.builtin ? '' : 'saved'].filter(Boolean).join(' · ')}
                class={`flex flex-col items-start gap-0.5 rounded p-1 text-left ${activeId === e.brush.id ? 'bg-indigo-600/30 ring-1 ring-indigo-500' : 'bg-slate-900 hover:bg-slate-800'}`}
                onclick={() => onselect(e.brush.id)}
              >
                {#if thumbnail}
                  <PixelCanvas pixels={thumbnail(e.brush.id)} label={`${e.brush.name} thumbnail`} class="rounded" style={`width: 100%; aspect-ratio: ${thumbnailWidth} / ${thumbnailHeight}`} />
                {/if}
                <span class="truncate text-[10px] text-slate-300">{e.brush.name}</span>
              </button>
            {/each}
          {/each}
        </div>
      </div>
    {/each}
    {#if !groups.length}<span class="text-slate-500">No brush matches.</span>{/if}
  </div>
</div>
