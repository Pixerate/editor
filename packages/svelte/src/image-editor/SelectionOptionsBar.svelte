<script lang="ts">
  import type {
    ImageEditorController,
    SelectionMask,
    SelectionModifyOp,
    SelectionToolOptions,
  } from '@pixerate/editor/image-editor';
  import {
    SELECTION_MODES,
    SELECTION_MODE_LABELS,
    SELECTION_TOOLS,
    describeSelection,
  } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  interface Props {
    controller: ImageEditorController;
    options: SelectionToolOptions;
    onOptionsChange: (next: SelectionToolOptions) => void;
    /** The current selection (`state.selection`). Omit to follow the controller. */
    selection?: SelectionMask | null;
    /** The Quick Mask view flag (`state.quickMask`). Omit to follow the controller. */
    quickMask?: boolean;
    class?: string;
  }

  let { controller, options, onOptionsChange, selection, quickMask, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });
  const sel = $derived.by(() => {
    void tick;
    return selection === undefined ? controller.getSelection() : selection;
  });
  const qm = $derived.by(() => {
    void tick;
    return quickMask ?? Boolean(controller.getState().quickMask);
  });

  let radius = $state(2);

  const MODIFY_OPS: { op: SelectionModifyOp; label: string }[] = [
    { op: 'grow', label: 'Grow' },
    { op: 'shrink', label: 'Shrink' },
    { op: 'feather', label: 'Feather' },
    { op: 'border', label: 'Border' },
    { op: 'smooth', label: 'Smooth' },
  ];

  function set(patch: Partial<SelectionToolOptions>) {
    onOptionsChange({ ...options, ...patch });
  }

  const btn = (on: boolean) =>
    `px-2 py-1 rounded-md border text-[11px] transition-colors ${
      on ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-950 border-slate-800 text-slate-300 hover:text-white'
    }`;
</script>

<div data-testid="selection-options-bar" class="flex flex-col gap-3 text-xs {className}">
  <div role="group" aria-label="Selection tool" class="flex flex-wrap gap-1">
    {#each SELECTION_TOOLS as t (t.id)}
      <button type="button" aria-pressed={options.tool === t.id} class={btn(options.tool === t.id)} onclick={() => set({ tool: t.id })}>
        {t.label}
      </button>
    {/each}
  </div>
  <div role="group" aria-label="Selection mode" class="flex flex-wrap gap-1">
    {#each SELECTION_MODES as m (m)}
      <button type="button" aria-pressed={options.mode === m} class={btn(options.mode === m)} onclick={() => set({ mode: m })}>
        {SELECTION_MODE_LABELS[m]}
      </button>
    {/each}
  </div>
  {#if options.tool === 'wand'}
    <div class="flex flex-col gap-2">
      <label class="flex flex-col gap-1">
        <span class="flex justify-between text-slate-400">
          <span>Tolerance</span>
          <span class="font-mono">{options.tolerance}</span>
        </span>
        <input
          type="range"
          min="0"
          max="255"
          step="1"
          aria-label="Tolerance"
          value={options.tolerance}
          oninput={(e) => set({ tolerance: Number((e.currentTarget as HTMLInputElement).value) })}
          class="w-full accent-indigo-500"
        />
      </label>
      <label class="flex items-center gap-2 text-slate-300">
        <input type="checkbox" checked={options.contiguous} onchange={(e) => set({ contiguous: (e.currentTarget as HTMLInputElement).checked })} />
        Contiguous
      </label>
      <label class="flex items-center gap-2 text-slate-300">
        <input type="checkbox" checked={options.sampleMerged} onchange={(e) => set({ sampleMerged: (e.currentTarget as HTMLInputElement).checked })} />
        Sample adjusted image
      </label>
    </div>
  {/if}
  <label class="flex items-center gap-2 text-slate-300">
    <input type="checkbox" checked={options.antiAlias} onchange={(e) => set({ antiAlias: (e.currentTarget as HTMLInputElement).checked })} />
    Anti-alias
  </label>
  <div class="flex flex-wrap gap-1">
    <button type="button" class={btn(false)} onclick={() => controller.selectAll()}>Select All</button>
    <button type="button" class={btn(false)} disabled={!sel} onclick={() => controller.deselect()}>Deselect</button>
    <button type="button" class={btn(false)} onclick={() => controller.invertSelection()}>Inverse</button>
    <button type="button" aria-pressed={qm} class={btn(qm)} onclick={() => controller.setQuickMask(!qm)}>Quick Mask</button>
  </div>
  <div class="flex flex-wrap items-center gap-1">
    <label class="flex items-center gap-1 text-slate-400">
      Radius
      <input
        type="number"
        min="0"
        max="500"
        step="1"
        aria-label="Modify radius"
        value={radius}
        oninput={(e) => (radius = Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0))}
        class="w-14 bg-slate-950 border border-slate-800 rounded px-1 py-0.5 text-slate-200"
      />
    </label>
    {#each MODIFY_OPS as m (m.op)}
      <button type="button" class={btn(false)} disabled={!sel} onclick={() => controller.modifySelection(m.op, radius)}>{m.label}</button>
    {/each}
  </div>
  <p data-testid="selection-status" class="text-slate-400">{describeSelection(sel)}</p>
</div>
