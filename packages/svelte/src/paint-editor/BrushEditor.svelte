<script lang="ts">
  import type { Snippet } from 'svelte';
  import { brushEditorSections, PAINT_PROFILE, setBrushEditorValue, type Brush, type BrushHostProfile } from '@pixerate/editor/brushes';
  import PaintSlider from './PaintSlider.svelte';
  import PixelCanvas from './PixelCanvas.svelte';
  import { button, chip } from './paintEditorRune.svelte.js';

  interface Props {
    /** The brush being edited, as facets. */
    brush: Brush;
    /** What the host renders (default the paint editor): other controls are left out. */
    profile?: BrushHostProfile;
    /** Called with the whole brush after each change (normalised). */
    onchange: (brush: Brush) => void;
    /** A live preview stroke of `brush` (e.g. `controller.brushThumbnail`). */
    preview?: { width: number; height: number; data: Uint8ClampedArray } | null;
    /** With it, a name field and "Save brush" save the brush under that name. */
    onsaveas?: (name: string) => unknown;
    /** Extra controls a host adds to a section (e.g. the sticker picker for stamps). */
    extra?: Snippet<[string]>;
    class?: string;
  }
  let { brush, profile = PAINT_PROFILE, onchange, preview, onsaveas, extra, class: className = '' }: Props = $props();
  const sections = $derived(brushEditorSections(brush, profile));
  let problems = $state<string | null>(null);
  let name = $state('');
  const set = (path: string, value: unknown) => {
    const r = setBrushEditorValue(brush, path, value);
    problems = r.problems.length ? r.problems.join(' ') : null;
    if (r.brush !== brush) onchange(r.brush);
  };
  const save = async () => {
    try {
      await onsaveas?.(name.trim());
      name = '';
      problems = null;
    } catch (e) {
      problems = (e as Error).message;
    }
  };
</script>

<!-- Edits a brush by its facets (brushEditorSections), with a live preview stroke and "Save as". Only what the host profile renders is shown. -->
<div class={`flex flex-col gap-2 ${className}`} data-testid="brush-editor">
  {#if preview !== undefined}
    <PixelCanvas pixels={preview} label="Brush preview" class="rounded" style={`width: 100%; aspect-ratio: ${preview ? `${preview.width} / ${preview.height}` : '4 / 1'}`} />
  {/if}
  {#each sections as s (s.id)}
    <section class="flex flex-col gap-1.5" data-section={s.id} data-testid={s.id === 'behaviour' ? 'brush-engine' : undefined}>
      <span class="font-medium text-slate-300">{s.title}</span>
      {#each s.controls as c (c.path)}
        {#if c.kind === 'slider'}
          <div title={c.note}>
            <PaintSlider control={c} value={c.value} onchange={(v) => set(c.path, v)} />
            {#if c.note}<span class="text-[10px] text-amber-400">{c.note}</span>{/if}
          </div>
        {:else if c.kind === 'choice'}
          <label class="flex items-center justify-between gap-2" title={c.note}>
            <span class="text-slate-400">{c.label}</span>
            <select aria-label={c.ariaLabel} value={c.value} onchange={(e) => set(c.path, e.currentTarget.value)} class="max-w-[60%] rounded bg-slate-800 px-1 py-0.5">
              {#each c.options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
            </select>
          </label>
        {:else if c.kind === 'toggle'}
          <label class="flex items-center gap-2" title={c.note}>
            <input type="checkbox" aria-label={c.ariaLabel} checked={c.value} onchange={(e) => set(c.path, e.currentTarget.checked)} /> {c.label}
          </label>
        {:else if c.kind === 'text'}
          <label class="flex items-center justify-between gap-2">
            <span class="text-slate-400">{c.label}</span>
            <input aria-label={c.ariaLabel} value={c.value} placeholder={c.placeholder} onblur={(e) => e.currentTarget.value !== c.value && set(c.path, e.currentTarget.value.trim().toLowerCase())} class="w-28 rounded bg-slate-800 px-1.5 py-0.5" />
          </label>
        {:else if c.kind === 'colour'}
          <div class="flex items-center justify-between gap-2">
            <span class="text-slate-400">{c.label}</span>
            <span class="flex items-center gap-1">
              <input type="color" aria-label={c.ariaLabel} value={c.value ?? '#000000'} onchange={(e) => set(c.path, e.currentTarget.value)} class="h-5 w-8" />
              {#if c.value}<button type="button" class={button} onclick={() => set(c.path, undefined)}>None</button>{/if}
            </span>
          </div>
        {:else if c.kind === 'palette'}
          <div class="flex flex-wrap items-center gap-1" role="group" aria-label={c.ariaLabel}>
            <span class="text-slate-400">{c.label}</span>
            {#each c.value as col, i (`${col}-${i}`)}
              <button type="button" title={`Remove ${col}`} aria-label={`Remove ${col}`} class="h-4 w-4 rounded ring-1 ring-slate-700" style={`background: ${col}`} onclick={() => set(c.path, c.value.filter((_, j) => j !== i))}></button>
            {/each}
            {#if c.value.length < c.max}
              <input type="color" aria-label="Add a palette colour" onchange={(e) => set(c.path, [...c.value, e.currentTarget.value])} class="h-4 w-6" />
            {/if}
          </div>
        {:else if c.kind === 'stamps'}
          <div class="flex flex-wrap gap-1" role="group" aria-label={c.ariaLabel} title={`Up to ${c.max}`}>
            {#each c.options as o (o.value)}
              {@const on = c.value.includes(o.value)}
              <button type="button" aria-pressed={on} class={chip(on)} onclick={() => set(c.path, on ? c.value.filter((v) => v !== o.value) : [...c.value, o.value].slice(-c.max))}>{o.label}</button>
            {/each}
          </div>
        {/if}
      {/each}
      {#if extra}{@render extra(s.id)}{/if}
    </section>
  {/each}
  {#if onsaveas}
    <div class="flex flex-wrap items-center gap-1">
      <input bind:value={name} placeholder="Brush name" aria-label="Brush name" class="w-28 rounded bg-slate-800 px-1.5 py-0.5" />
      <button type="button" class={button} disabled={!name.trim()} onclick={save}>Save brush</button>
    </div>
  {/if}
  {#if problems}<p role="alert" class="text-[11px] text-rose-400">{problems}</p>{/if}
</div>
