<script lang="ts">
  import { CULTURE_SLIDERS, readPath, type PaintEditorController } from '@pixerate/editor/paint-editor';
  import PaintSlider from './PaintSlider.svelte';
  import { attempt, button, chip, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    class?: string;
  }
  let { controller, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const cultures = $derived(editor.current.cultures);
  const brush = $derived(editor.current.brush);
  const activeColony = $derived.by(() => {
    const activeId = editor.current.document.activeLayerId;
    return cultures.layers.find((l) => l.layerId === activeId) ?? cultures.layers[0] ?? null;
  });
  const totalTips = $derived(cultures.layers.reduce((acc, l) => acc + l.tips, 0));
  const totalSegments = $derived(cultures.layers.reduce((acc, l) => acc + l.segments, 0));
  const canCarryCulture = $derived(['dab', 'mixer', 'impasto', 'particle', 'bristle'].includes(brush.engine));
  let error = $state<string | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
</script>

<!-- Biopaint (culture) panel: inspect living mycelial colonies, step growth, pause/resume, kill tips, and tune brush spores. -->
<div class={`${panel} ${className}`} data-testid="culture-panel">
  <div class="flex items-center justify-between">
    <span class="font-medium text-slate-300">Biopaint (mycelial ink)</span>
    <div class="flex gap-1">
      <button type="button" class={button} onclick={() => run(() => controller.growCultures({ steps: 40 }))}>Grow</button>
      <button
        type="button"
        aria-pressed={cultures.paused}
        class={chip(cultures.paused)}
        onclick={() => controller.setCulturePaused(!cultures.paused)}
      >
        {cultures.paused ? 'Paused' : 'Pause'}
      </button>
      <button
        type="button"
        class={button}
        disabled={!activeColony || activeColony.tips === 0}
        onclick={() => run(() => controller.removeCultures(activeColony?.layerId))}
      >
        Kill colony
      </button>
    </div>
  </div>
  <div class="flex items-center justify-between text-[11px] text-slate-400">
    <span>
      {activeColony
        ? `${totalTips} living tips · ${totalSegments} segments (${activeColony.status})`
        : 'No mycelial colony on canvas'}
    </span>
  </div>
  <label class="flex items-center gap-2 text-[11px]">
    <input
      type="checkbox"
      checked={cultures.growWhileClosed}
      onchange={(e) => run(() => controller.setCultureOptions({ growWhileClosed: e.currentTarget.checked }))}
    />
    Grow while closed
  </label>
  {#if canCarryCulture}
    <div class="flex flex-col gap-1 border-t border-slate-800 pt-1.5">
      <div class="flex items-center justify-between">
        <span class="text-[11px] text-slate-400">Brush spores</span>
        <button
          type="button"
          aria-pressed={Boolean(brush.culture)}
          class={chip(Boolean(brush.culture))}
          onclick={() => run(() => controller.setBrush({ culture: brush.culture ? null : {} }))}
        >
          {brush.culture ? 'On' : 'Off'}
        </button>
      </div>
      {#if brush.culture}
        {#each CULTURE_SLIDERS as c (c.path)}
          {@const key = c.path.replace(/^culture\./, '')}
          <PaintSlider
            control={c}
            value={readPath(brush.culture, key)}
            oncommit={(v) => run(() => controller.setBrush({ culture: { [key]: v } }))}
          />
        {/each}
      {/if}
    </div>
  {/if}
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
