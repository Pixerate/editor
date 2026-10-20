<script lang="ts">
  import {
    VECTOR_HORIZONTAL_RESIZING,
    VECTOR_HORIZONTAL_RESIZING_LABELS,
    VECTOR_VERTICAL_RESIZING,
    VECTOR_VERTICAL_RESIZING_LABELS,
    getVectorFramePanel,
    vectorPaintToHex,
    type VectorEditorController,
    type VectorHorizontalResizing,
    type VectorVerticalResizing
  } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * Frames (artboards): Frame Selection; for a selected frame its position, size (its children
   * follow their constraints), background and clipping; for objects inside a frame their resizing
   * constraints. Each change is one undo step (sizes apply on Enter or blur).
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const panel = $derived(getVectorFramePanel(view));
  const f = $derived(panel.frame);
  const ids = $derived(f ? [f.id] : undefined);
  const fillHex = $derived(f ? vectorPaintToHex(f.frame.fill ?? null) : null);
  const hasFill = $derived(!!f && f.frame.fill !== undefined && f.frame.fill !== null);
  const fields = [
    { key: 'x', label: 'X' },
    { key: 'y', label: 'Y' },
    { key: 'width', label: 'W' },
    { key: 'height', label: 'H' }
  ] as const;

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  const numberClass = 'h-7 w-16 rounded border border-border bg-background px-1.5 text-xs';
</script>

<div class="space-y-2 {className}" data-vector-frame-panel="" aria-label="Frame">
  <div class="flex flex-wrap items-center gap-1">
    <span class="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Frame</span>
    <button
      type="button"
      data-vector-frame-action="frame-selection"
      class={buttonClass}
      title="Frame Selection: put the selection in a frame fitted to it"
      aria-label="Frame Selection"
      disabled={!view.selection.length}
      onclick={() => controller.frameSelection()}
    >
      Frame selection
    </button>
  </div>
  {#if f}
    <div class="space-y-2" data-vector-frame={f.id}>
      <div class="grid grid-cols-2 gap-1">
        {#each fields as { key, label } (key)}
          <label class="flex items-center gap-1 text-xs text-foreground">
            <span class="w-4 text-muted-foreground">{label}</span>
            <input
              type="number"
              step="1"
              min={key === 'width' || key === 'height' ? 1 : undefined}
              aria-label="Frame {key}"
              class={numberClass}
              value={Math.round(f.frame[key] * 100) / 100}
              onchange={(e) => {
                // On commit (Enter or blur): each resize lays the children out again, so the digits typed on the way must not.
                const n = parseFloat(e.currentTarget.value);
                if (Number.isFinite(n) && (key === 'x' || key === 'y' || n > 0)) controller.setFrame({ [key]: n }, { ids });
              }}
            />
          </label>
        {/each}
      </div>
      <div class="flex items-center gap-2">
        <label class="flex w-16 items-center gap-1.5 text-xs text-foreground">
          <input type="checkbox" aria-label="Frame fill on" checked={hasFill} onchange={(e) => controller.setFrame({ fill: e.currentTarget.checked ? (fillHex ?? '#ffffff') : null }, { ids })} />
          Fill
        </label>
        <input
          type="color"
          aria-label="Frame fill colour"
          class="h-7 w-10 cursor-pointer rounded border border-border bg-background disabled:opacity-40"
          disabled={!hasFill}
          value={fillHex ?? '#ffffff'}
          oninput={(e) => controller.setFrame({ fill: e.currentTarget.value }, { ids, merge: 'frame-fill' })}
        />
        <label class="flex items-center gap-1 text-xs text-foreground" title="Hide what lies outside the frame">
          <input type="checkbox" aria-label="Clip content" checked={f.frame.clip !== false} onchange={(e) => controller.setFrame({ clip: e.currentTarget.checked }, { ids })} />
          Clip
        </label>
      </div>
    </div>
  {/if}
  {#if panel.resizing}
    {@const resizing = panel.resizing}
    <div class="space-y-1" data-vector-resizing="">
      <label class="flex items-center gap-2 text-xs text-foreground">
        <span class="w-16">Horizontal</span>
        <select
          aria-label="Horizontal constraint"
          class={selectClass}
          value={resizing.horizontal}
          onchange={(e) => controller.setResizing({ horizontal: e.currentTarget.value as VectorHorizontalResizing }, { ids: resizing.ids })}
        >
          {#if resizing.horizontal === 'mixed'}<option value="mixed" disabled>Mixed</option>{/if}
          {#each VECTOR_HORIZONTAL_RESIZING as h (h)}<option value={h}>{VECTOR_HORIZONTAL_RESIZING_LABELS[h]}</option>{/each}
        </select>
      </label>
      <label class="flex items-center gap-2 text-xs text-foreground">
        <span class="w-16">Vertical</span>
        <select
          aria-label="Vertical constraint"
          class={selectClass}
          value={resizing.vertical}
          onchange={(e) => controller.setResizing({ vertical: e.currentTarget.value as VectorVerticalResizing }, { ids: resizing.ids })}
        >
          {#if resizing.vertical === 'mixed'}<option value="mixed" disabled>Mixed</option>{/if}
          {#each VECTOR_VERTICAL_RESIZING as v (v)}<option value={v}>{VECTOR_VERTICAL_RESIZING_LABELS[v]}</option>{/each}
        </select>
      </label>
    </div>
  {/if}
</div>
