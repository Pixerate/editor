<script lang="ts">
  import type { Snippet } from 'svelte';
  import { brushEditorScope, brushEditorSections, PAINT_PROFILE, setBrushEditorValue, type Brush, type BrushHostProfile } from '@pixerate/editor/brushes';
  import PaintSlider from '../paint-editor/PaintSlider.svelte';
  import PixelCanvas from '../paint-editor/PixelCanvas.svelte';
  import { button, chip } from './styles.js';

  interface Props {
    /** The brush being edited, as facets. */
    brush: Brush;
    /**
     * What the host renders (default the paint editor): only its sections, controls and options
     * are shown. Facets of the brush it can't use stay as they are, named in a note.
     */
    profile?: BrushHostProfile;
    /** Called with the whole brush after each change (normalised). */
    onchange: (brush: Brush) => void;
    /** A live preview stroke of `brush`: pixels (e.g. `controller.brushThumbnail`) or an image URL. */
    preview?: { width: number; height: number; data: Uint8ClampedArray } | string | null;
    /** With it, a "Save" button (labelled `saveLabel`) saves the brush in place. */
    onsave?: () => unknown;
    /** The Save button's label (default "Save"; e.g. "Save a copy" for a built-in). */
    saveLabel?: string;
    /** With it, a name field and "Save brush" save the brush under that name. */
    onsaveas?: (name: string) => unknown;
    /** Extra controls a host adds to a section (e.g. the sticker picker for stamps). */
    extra?: Snippet<[string]>;
    class?: string;
  }
  let { brush, profile = PAINT_PROFILE, onchange, preview, onsave, saveLabel = 'Save', onsaveas, extra, class: className = '' }: Props = $props();
  const sections = $derived(brushEditorSections(brush, profile));
  const scope = $derived(brushEditorScope(brush, profile));
  let problems = $state<string | null>(null);
  let name = $state('');
  const set = (path: string, value: unknown) => {
    const r = setBrushEditorValue(brush, path, value);
    problems = r.problems.length ? r.problems.join(' ') : null;
    if (r.brush !== brush) onchange(r.brush);
  };
  const setColour = (path: string, light: string, dark: string | null) => set(path, dark === null ? light : { light, dark });
  const setAt = (path: string, list: Array<string | { light: string; dark: string }>, i: number, entry: string | { light: string; dark: string }) => set(path, list.map((x, j) => (j === i ? entry : x)));
  const attemptSave = async (fn: () => unknown, after?: () => void) => {
    try {
      await fn();
      after?.();
      problems = null;
    } catch (e) {
      problems = (e as Error).message;
    }
  };
  const save = () => attemptSave(() => onsaveas?.(name.trim()), () => (name = ''));
</script>

<!--
  Edits a brush by its facets (brushEditorSections), with a live preview stroke, "Save" and "Save as". It needs no
  editor controller, so every host that paints uses it. Only what the host profile uses is shown; what the brush has
  for other hosts is kept and named (brushEditorScope). BrushLibraryEditor wires it to a brush library.
-->
<div class={`flex flex-col gap-2 ${className}`} data-testid="brush-editor">
  {#if typeof preview === 'string'}
    <img src={preview} alt="Brush preview" class="rounded object-contain" style="width: 100%; aspect-ratio: 4 / 1" />
  {:else if preview !== undefined}
    <PixelCanvas pixels={preview} label="Brush preview" class="rounded" style={`width: 100%; aspect-ratio: ${preview ? `${preview.width} / ${preview.height}` : '4 / 1'}`} />
  {/if}
  {#if scope.note}
    <p class="text-[10px] text-amber-400" data-testid="brush-editor-scope" title={`${profile.name} shows only what it can use; these are kept unchanged when you save.`}>{scope.note}</p>
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
          <!-- One colour, or a light / dark pair resolved for the host's colour scheme. -->
          <div class="flex flex-col gap-1">
            <div class="flex items-center justify-between gap-2">
              <span class="text-slate-400">{c.label}</span>
              <span class="flex items-center gap-1">
                <input type="color" aria-label={c.ariaLabel} title={c.dark !== null ? 'On light backgrounds' : undefined} value={c.value ?? '#000000'} onchange={(e) => setColour(c.path, e.currentTarget.value, c.dark)} class="h-5 w-8" />
                {#if c.dark !== null}
                  <input type="color" aria-label={`${c.ariaLabel} (dark)`} title="On dark backgrounds" value={c.dark} onchange={(e) => setColour(c.path, c.value ?? '#000000', e.currentTarget.value)} class="h-5 w-8" />
                {/if}
                {#if c.value || c.gradient}<button type="button" class={button} onclick={() => set(c.path, undefined)}>None</button>{/if}
              </span>
            </div>
            {#if c.gradient}
              <span class="text-[10px] text-slate-500">A gradient (its own paint).</span>
            {:else}
              <label class="flex items-center gap-2">
                <input type="checkbox" aria-label={`${c.ariaLabel}: light and dark`} checked={c.dark !== null} onchange={(e) => setColour(c.path, c.value ?? '#000000', e.currentTarget.checked ? (c.value ?? '#ffffff') : null)} /> Light / dark
              </label>
            {/if}
          </div>
        {:else if c.kind === 'palette'}
          <div class="flex flex-col gap-1" role="group" aria-label={c.ariaLabel}>
            <span class="text-slate-400">{c.label}</span>
            <div class="flex flex-wrap items-center gap-1">
              {#each c.value as col, i (i)}
                <span class="flex items-center gap-0.5 rounded bg-slate-900 p-0.5">
                  <input type="color" aria-label={`Palette colour ${i + 1}`} value={typeof col === 'string' ? col : col.light} onchange={(e) => setAt(c.path, c.value, i, typeof col === 'string' ? e.currentTarget.value : { ...col, light: e.currentTarget.value })} class="h-4 w-5" />
                  {#if typeof col !== 'string'}
                    <input type="color" aria-label={`Palette colour ${i + 1} (dark)`} value={col.dark} onchange={(e) => setAt(c.path, c.value, i, { ...col, dark: e.currentTarget.value })} class="h-4 w-5" />
                  {/if}
                  <button type="button" aria-label={`Remove palette colour ${i + 1}`} class="px-0.5 text-slate-400 hover:text-white" onclick={() => set(c.path, c.value.filter((_, j) => j !== i))}>×</button>
                </span>
              {/each}
              {#if c.value.length < c.max}
                <input type="color" aria-label="Add a palette colour" onchange={(e) => set(c.path, [...c.value, e.currentTarget.value])} class="h-4 w-6" />
                <button type="button" class={button} onclick={() => set(c.path, [...c.value, { light: '#334155', dark: '#e2e8f0' }])}>Add light / dark pair</button>
              {/if}
            </div>
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
  {#if onsave || onsaveas}
    <div class="flex flex-wrap items-center gap-1">
      {#if onsave}<button type="button" class={button} onclick={() => attemptSave(onsave)}>{saveLabel}</button>{/if}
      {#if onsaveas}
        <input bind:value={name} placeholder="Brush name" aria-label="Brush name" class="w-28 rounded bg-slate-800 px-1.5 py-0.5" />
        <button type="button" class={button} disabled={!name.trim()} onclick={save}>Save brush</button>
      {/if}
    </div>
  {/if}
  {#if problems}<p role="alert" class="text-[11px] text-rose-400">{problems}</p>{/if}
</div>
