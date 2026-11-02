<script lang="ts">
  import { STROKE_SLIDERS, liveStrokeRefusal, readPath, type PaintEditorController } from '@pixerate/editor/paint-editor';
  import PaintSlider from './PaintSlider.svelte';
  import { attempt, button, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    class?: string;
  }
  let { controller, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const layerId = $derived(editor.current.document.activeLayerId);
  const strokes = $derived(layerId ? editor.current.document.liveStrokes?.[layerId] : undefined);
  const index = $derived(strokes ? strokes.findIndex((s) => s.id === editor.current.selectedStroke) : -1);
  const sel = $derived(strokes && index >= 0 ? strokes[index] : null);
  const brushes = $derived(editor.current.brushes.filter((b) => !liveStrokeRefusal(b)));
  let error = $state<string | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
</script>

<!-- The active stroke layer's strokes: pick one (here, or with the Select stroke tool on the canvas) to change its brush, size, opacity, flow, colour or seed, reorder or delete it. The layer redraws exactly; each change is one undo step. -->
{#if layerId && strokes}
  <div class={`${panel} ${className}`} data-testid="stroke-panel">
    <div class="flex items-center justify-between">
      <span class="font-medium text-slate-300">Strokes ({strokes.length})</span>
      <button type="button" class={button} onclick={() => run(() => controller.rasterizeLiveStrokes(layerId))}>Rasterize</button>
    </div>
    <div class="flex max-h-24 flex-wrap gap-1 overflow-y-auto" role="listbox" aria-label="Strokes">
      {#each strokes as s, i (s.id)}
        <button type="button" role="option" aria-selected={s.id === editor.current.selectedStroke} title={`${i + 1}. ${s.brush.name} (${s.id})`} class={`h-5 w-5 rounded ring-1 ${s.id === editor.current.selectedStroke ? 'ring-indigo-400' : 'ring-slate-700'}`} style={`background: ${s.color}`} onclick={() => controller.selectStroke(s.id)}></button>
      {/each}
    </div>
    {#if sel}
      <div class="flex flex-col gap-1.5" data-testid="stroke-edit">
        <label class="flex items-center justify-between gap-2">
          <span class="text-slate-400">Brush</span>
          <select aria-label="Stroke brush" value={brushes.some((b) => b.id === sel.brush.id) ? sel.brush.id : ''} onchange={(e) => { const brushId = e.currentTarget.value; if (brushId) run(() => controller.updateStroke(sel.id, { brushId })); }} class="max-w-[10rem] rounded bg-slate-800 px-1 py-0.5">
            {#if !brushes.some((b) => b.id === sel.brush.id)}<option value="">{sel.brush.name}</option>{/if}
            {#each brushes as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
          </select>
        </label>
        {#each STROKE_SLIDERS as c (c.path)}
          <PaintSlider control={c} value={readPath(sel.brush, c.path)} oncommit={(v) => run(() => controller.updateStroke(sel.id, { brush: { tip: { [c.path.split('.')[1]]: v } } }))} />
        {/each}
        <label class="flex items-center justify-between">
          <span class="text-slate-400">Colour</span>
          <input type="color" aria-label="Stroke colour" value={sel.color} onchange={(e) => { const color = e.currentTarget.value; run(() => controller.updateStroke(sel.id, { color })); }} class="h-6 w-10 rounded bg-transparent" />
        </label>
        <div class="flex flex-wrap gap-1">
          <button type="button" class={button} onclick={() => run(() => controller.updateStroke(sel.id, { seed: (sel.seed + 1) % 2147483647 }))}>New seed</button>
          <button type="button" class={button} disabled={index === strokes.length - 1} aria-label="Move stroke up" onclick={() => run(() => controller.reorderStroke(sel.id, index + 1))}>↑</button>
          <button type="button" class={button} disabled={index === 0} aria-label="Move stroke down" onclick={() => run(() => controller.reorderStroke(sel.id, index - 1))}>↓</button>
          <button type="button" class={button} onclick={() => run(() => { controller.removeStrokes([sel.id]); controller.selectStroke(null); })}>Delete</button>
        </div>
      </div>
    {/if}
    {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
  </div>
{/if}
