<script lang="ts">
  import { AGE_SLIDERS, readPath, type PaintEditorController } from '@pixerate/editor/paint-editor';
  import PaintSlider from './PaintSlider.svelte';
  import { attempt, button, chip, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    class?: string;
  }
  let { controller, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const age = $derived(editor.current.age);
  let error = $state<string | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
</script>

<!-- Painting time machine panel: non-destructive ageing preview, bakeAge, X-ray view and scraper brush. -->
<div class={`${panel} ${className}`} data-testid="time-machine-panel">
  <div class="flex items-center justify-between gap-1">
    <span class="font-medium text-slate-300">Time machine (ageing &amp; X-ray)</span>
    <div class="flex flex-wrap gap-1">
      <button type="button" class={chip(age.years === 300)} onclick={() => run(() => controller.setAge({ years: 300 }))}>
        Age 300 yr
      </button>
      {#if age.years > 0}
        <button type="button" class={button} onclick={() => run(() => controller.setAge({ years: 0 }))}>Fresh</button>
      {/if}
    </div>
  </div>
  <label class="flex items-center gap-2">
    <input
      type="checkbox"
      checked={editor.current.xrayView}
      onchange={(e) => run(() => controller.setXrayView(e.currentTarget.checked))}
    />
    X-ray view (pentimento)
  </label>
  {#each AGE_SLIDERS as c (c.path)}
    <PaintSlider control={c} value={readPath(age, c.path)} onchange={(v) => run(() => controller.setAge({ [c.path]: v }))} />
  {/each}
  <div class="flex flex-wrap items-center gap-1.5">
    <button type="button" class={button} disabled={age.years <= 0} onclick={() => run(() => controller.bakeAge())}>
      Bake age
    </button>
    <button type="button" class={button} onclick={() => run(() => controller.setAge({ seed: age.seed + 1 }))}>
      New crack seed
    </button>
    <button
      type="button"
      class={chip(editor.current.brush.id === 'paint-scraper')}
      onclick={() => run(() => controller.setBrush({ id: 'paint-scraper' }))}
    >
      Scraper brush
    </button>
  </div>
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
