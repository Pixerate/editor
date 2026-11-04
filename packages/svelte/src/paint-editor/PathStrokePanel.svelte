<script lang="ts">
  import { PATH_STROKE_TAPERS, type PaintEditorController } from '@pixerate/editor/paint-editor';
  import { attempt, button, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    class?: string;
  }
  let { controller, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  let path = $state('');
  let taper = $state(PATH_STROKE_TAPERS[0].id);
  const pressure = $derived(PATH_STROKE_TAPERS.find((t) => t.id === taper)?.pressure);
  let error = $state<string | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
</script>

<!-- Brush a path: paste SVG path data (document pixels) and brush it on the active layer with the active brush and colour, with an even pressure or a taper. One undo step, as the stroke_path agent tool. -->
<div class={`${panel} ${className}`} data-testid="path-stroke-panel">
  <span class="font-medium text-slate-300">Brush a path</span>
  <textarea aria-label="SVG path data" placeholder="M 40 200 C 120 40 280 40 360 200" bind:value={path} rows="2" class="w-full resize-y rounded bg-slate-800 px-1 py-0.5 font-mono text-[11px]"></textarea>
  <div class="flex items-center gap-2">
    <select aria-label="Pressure along the path" bind:value={taper} class="rounded bg-slate-800 px-1 py-0.5">
      {#each PATH_STROKE_TAPERS as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
    </select>
    <button type="button" class={button} disabled={!path.trim() || editor.current.stroking} onclick={() => run(() => controller.strokePath({ path, ...(pressure ? { pressure } : {}) }))}>Brush path</button>
  </div>
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
