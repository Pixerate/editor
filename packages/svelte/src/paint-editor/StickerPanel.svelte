<script lang="ts">
  import { STAMP_KINDS, STAMP_LABELS, STICKER_SLIDERS, readPath, type PaintEditorController, type StampKind } from '@pixerate/editor/paint-editor';
  import PaintSlider from './PaintSlider.svelte';
  import { attempt, button, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    class?: string;
  }
  let { controller, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const layerId = $derived(editor.current.document.activeLayerId);
  const stickers = $derived(layerId ? (editor.current.document.stickers?.[layerId] ?? []) : []);
  let picked = $state<string | null>(null);
  const sel = $derived(stickers.find((s) => s.id === picked) ?? null);
  let error = $state<string | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
</script>

<!-- The active layer's stickers: pick one to change, reorder or delete it (each change one undo step). -->
{#if stickers.length && layerId}
  <div class={`${panel} ${className}`} data-testid="sticker-panel">
    <span class="font-medium text-slate-300">Stickers ({stickers.length})</span>
    <div class="flex max-h-24 flex-wrap gap-1 overflow-y-auto" role="listbox" aria-label="Stickers">
      {#each stickers as s (s.id)}
        <button type="button" role="option" aria-selected={s.id === picked} title={`${STAMP_LABELS[s.stamp]} ${s.id}`} class={`h-5 w-5 rounded ring-1 ${s.id === picked ? 'ring-indigo-400' : 'ring-slate-700'}`} style={`background: ${s.color}`} onclick={() => (picked = s.id)}></button>
      {/each}
    </div>
    {#if sel}
      <div class="flex flex-col gap-1.5" data-testid="sticker-edit">
        <label class="flex items-center justify-between gap-2">
          <span class="text-slate-400">Stamp</span>
          <select aria-label="Sticker stamp" value={sel.stamp} onchange={(e) => { const stamp = e.currentTarget.value as StampKind; run(() => controller.updateSticker(layerId, sel.id, { stamp })); }} class="rounded bg-slate-800 px-1 py-0.5">
            {#each STAMP_KINDS as k (k)}<option value={k}>{STAMP_LABELS[k]}</option>{/each}
          </select>
        </label>
        {#each STICKER_SLIDERS as c (c.path)}
          <PaintSlider control={c} value={readPath(sel, c.path)} oncommit={(v) => run(() => controller.updateSticker(layerId, sel.id, { [c.path]: v }))} />
        {/each}
        <label class="flex items-center justify-between">
          <span class="text-slate-400">Colour</span>
          <input type="color" aria-label="Sticker colour" value={sel.color} onchange={(e) => { const color = e.currentTarget.value; run(() => controller.updateSticker(layerId, sel.id, { color })); }} class="h-6 w-10 rounded bg-transparent" />
        </label>
        <div class="flex flex-wrap gap-1">
          <button type="button" class={button} onclick={() => run(() => controller.arrangeStickers(layerId, [sel.id], 'front'))}>To front</button>
          <button type="button" class={button} onclick={() => run(() => controller.arrangeStickers(layerId, [sel.id], 'back'))}>To back</button>
          <button type="button" class={button} onclick={() => run(() => { controller.removeStickers(layerId, [sel.id]); picked = null; })}>Delete</button>
        </div>
      </div>
    {/if}
    {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
  </div>
{/if}
