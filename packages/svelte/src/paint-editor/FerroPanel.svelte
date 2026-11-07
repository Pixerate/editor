<script lang="ts">
  import { MAGNET_SLIDERS, readPath, type PaintEditorController } from '@pixerate/editor/paint-editor';
  import PaintSlider from './PaintSlider.svelte';
  import { attempt, button, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    class?: string;
  }
  let { controller, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const magnets = $derived(editor.current.document.magnets ?? []);
  let error = $state<string | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
  const info = $derived.by(() => {
    const activeId = editor.current.document.activeLayerId;
    try {
      return activeId ? controller.getFerrofluid(activeId) : null;
    } catch {
      return null;
    }
  });
</script>

<!-- Ferrofluid & magnets panel: add, adjust and remove magnets, inspect spikes and cure ferrofluid. -->
<div class={`${panel} ${className}`} data-testid="ferro-panel">
  <div class="flex items-center justify-between">
    <span class="font-medium text-slate-300">Ferrofluid & magnets</span>
    <div class="flex gap-1">
      <button
        type="button"
        class={button}
        onclick={() => run(() => controller.addMagnet({ x: Math.round(editor.current.document.canvas.width / 2), y: Math.round(editor.current.document.canvas.height / 2) }))}
      >
        Add magnet
      </button>
      {#if magnets.length > 0}
        <button type="button" class={button} onclick={() => run(() => controller.removeMagnets())}>Clear magnets</button>
      {/if}
    </div>
  </div>
  {#each magnets as m (m.id)}
    <div class="flex flex-col gap-1 rounded border border-slate-800 p-1.5" data-magnet={m.id}>
      <div class="flex items-center justify-between text-[11px]">
        <span class="font-mono text-slate-300">{m.id} ({Math.round(m.x)}, {Math.round(m.y)})</span>
        <button type="button" aria-label={`Remove magnet ${m.id}`} class="px-1 text-slate-400 hover:text-white" onclick={() => run(() => controller.removeMagnets([m.id]))}>
          ×
        </button>
      </div>
      {#each MAGNET_SLIDERS as c (c.path)}
        <PaintSlider
          control={{ ...c, label: `${c.label} (${m.id})` }}
          value={readPath(m, c.path)}
          oncommit={(v) => run(() => controller.updateMagnet(m.id, { [c.path]: v }))}
        />
      {/each}
    </div>
  {/each}
  <div class="flex items-center justify-between gap-2">
    <span class="text-[11px] text-slate-400">
      {info?.ferro ? `${info.activeSpikeArea} spike px · max ${Math.round(info.maxSpikeHeight * 100)}%` : 'No liquid ferrofluid on layer'}
    </span>
    <button type="button" class={button} disabled={!info?.ferro} onclick={() => run(() => controller.cureFerrofluid())}>Cure ferrofluid</button>
  </div>
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
