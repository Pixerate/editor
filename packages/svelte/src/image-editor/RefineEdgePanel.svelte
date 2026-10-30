<script lang="ts">
  import { imageRangeClass, imageSectionTitleClass } from './styles.js';
  import type {
    AdjustmentKind,
    AdjustmentLayer,
    ImageEditorController,
    RefineEdgeParams,
    RefineOutput,
    SelectionMask,
  } from '@pixerate/editor/image-editor';
  import {
    ADJUSTMENT_KINDS,
    REFINE_EDGE_CONTROLS,
    REFINE_OUTPUTS,
    adjustmentKindLabel,
    layerMaskFromSelection,
  } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  interface Props {
    controller: ImageEditorController;
    /** The current selection (`state.selection`). Omit to follow the controller. */
    selection?: SelectionMask | null;
    /** The adjustment layers (`state.adjustments.layers`). Omit to follow the controller. */
    layers?: AdjustmentLayer[];
    class?: string;
  }

  let { controller, selection, layers: layersProp, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });
  const sel = $derived.by(() => {
    void tick;
    return selection === undefined ? controller.getSelection() : selection;
  });
  const list = $derived.by(() => {
    void tick;
    return layersProp ?? controller.getAdjustmentLayers();
  });

  const DEFAULT_PARAMS: Required<RefineEdgeParams> = { radius: 8, smartRadius: false, smooth: 0, feather: 0, contrast: 0, shiftEdge: 0 };
  let params = $state<Required<RefineEdgeParams>>({ ...DEFAULT_PARAMS });
  let busy = $state(false);
  let error = $state<string | null>(null);
  let layerId = $state('');
  let newKind = $state<AdjustmentKind>('hueSaturation');
  let output = $state<RefineOutput>('selection');
  let decontaminate = $state(0);
  let objectAware = $state(false);
  const canObject = $derived.by(() => {
    void tick;
    return Boolean(controller.segmentationProvider);
  });
  const toLayer = $derived(output !== 'selection' && output !== 'layer-mask');
  const outputs = $derived.by(() => {
    void tick;
    return REFINE_OUTPUTS.filter((o) => !o.needsDocuments || controller.canOpenDocuments);
  });
  const target = $derived(list.find((l) => l.id === layerId) ?? list[list.length - 1]);

  async function refine() {
    busy = true;
    error = null;
    try {
      await controller.refineSelectionTo({ ...params }, output, {
        decontaminate: toLayer ? decontaminate : 0,
        refineMode: canObject && objectAware ? 'object' : 'color',
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function newMaskedLayer() {
    const s = controller.getSelection();
    if (s) layerId = controller.addAdjustmentLayer({ kind: newKind, mask: layerMaskFromSelection(s) });
  }

  const button =
    'px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';
</script>

<div data-testid="refine-edge-panel" class="flex flex-col gap-3 text-xs {className}">
  <span class={imageSectionTitleClass}>Refine Edge</span>
  {#each REFINE_EDGE_CONTROLS as c (c.id)}
    <label class="flex flex-col gap-1">
      <span class="flex justify-between text-muted-foreground">
        <span>{c.label}</span>
        <span class="font-mono">{params[c.id]}{c.unit}</span>
      </span>
      <input
        type="range"
        min={c.min}
        max={c.max}
        step={c.step}
        aria-label={c.label}
        value={params[c.id]}
        oninput={(e) => (params = { ...params, [c.id]: Number((e.currentTarget as HTMLInputElement).value) })}
        class={imageRangeClass}
      />
    </label>
  {/each}
  <label class="flex items-center gap-2 text-foreground">
    <input
      type="checkbox"
      checked={params.smartRadius}
      onchange={(e) => (params = { ...params, smartRadius: (e.currentTarget as HTMLInputElement).checked })}
    />
    Smart Radius
  </label>
  {#if canObject}
    <label class="flex items-center gap-2 text-foreground">
      <input type="checkbox" aria-label="Object aware" checked={objectAware} onchange={(e) => (objectAware = (e.currentTarget as HTMLInputElement).checked)} />
      Object aware (segmentation model)
    </label>
  {/if}
  <label class="flex items-center gap-2 text-muted-foreground">
    Output to
    <select
      aria-label="Refine output"
      value={output}
      onchange={(e) => (output = (e.currentTarget as HTMLSelectElement).value as RefineOutput)}
      class="flex-1 bg-background border border-border rounded px-1 py-1 text-foreground"
    >
      {#each outputs as o (o.id)}
        <option value={o.id}>{o.label}</option>
      {/each}
    </select>
  </label>
  <label class="flex flex-col gap-1">
    <span class="flex justify-between text-muted-foreground">
      <span>Decontaminate colors{toLayer ? '' : ' (new layer or document outputs)'}</span>
      <span class="font-mono">{decontaminate}%</span>
    </span>
    <input
      type="range"
      min="0"
      max="100"
      step="1"
      aria-label="Decontaminate amount"
      disabled={!toLayer}
      value={decontaminate}
      oninput={(e) => (decontaminate = Number((e.currentTarget as HTMLInputElement).value))}
      class={imageRangeClass}
    />
  </label>
  <div class="flex gap-1">
    <button type="button" class={button} disabled={!sel || busy} onclick={refine}>Refine Edge</button>
    <button type="button" class={button} onclick={() => (params = { ...DEFAULT_PARAMS })}>Reset</button>
  </div>
  {#if error}
    <p role="alert" class="text-destructive">{error}</p>
  {/if}

  <span class="font-semibold text-foreground uppercase tracking-wider text-[11px] mt-2">Layer Mask</span>
  <div class="flex gap-1 items-center">
    <select
      aria-label="New masked layer kind"
      value={newKind}
      onchange={(e) => (newKind = (e.currentTarget as HTMLSelectElement).value as AdjustmentKind)}
      class="flex-1 bg-background border border-border rounded px-1 py-1 text-foreground"
    >
      {#each ADJUSTMENT_KINDS as k (k.kind)}
        <option value={k.kind}>{k.label}</option>
      {/each}
    </select>
    <button type="button" class={button} disabled={!sel} onclick={newMaskedLayer}>New Masked Layer</button>
  </div>
  {#if list.length > 0 && target}
    <div class="flex flex-col gap-2">
      <select
        aria-label="Mask layer"
        value={target.id}
        onchange={(e) => (layerId = (e.currentTarget as HTMLSelectElement).value)}
        class="bg-background border border-border rounded px-1 py-1 text-foreground"
      >
        {#each list as l (l.id)}
          <option value={l.id}>{l.name || adjustmentKindLabel(l.kind)}{l.mask ? ' (masked)' : ''}</option>
        {/each}
      </select>
      <div class="flex flex-wrap gap-1">
        <button type="button" class={button} disabled={!sel} onclick={() => controller.applySelectionAsLayerMask(target.id)}>
          Mask with Selection
        </button>
        <button type="button" class={button} disabled={!target.mask} onclick={() => controller.selectionFromLayerMask(target.id)}>
          Load as Selection
        </button>
        <button type="button" class={button} disabled={!target.mask} onclick={() => controller.setAdjustmentLayerMask(target.id, null)}>
          Remove Mask
        </button>
      </div>
      {#if target.mask}
        <label class="flex flex-col gap-1">
          <span class="flex justify-between text-muted-foreground">
            <span>Density</span>
            <span class="font-mono">{Math.round((target.mask.density ?? 1) * 100)}%</span>
          </span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            aria-label="Mask density"
            value={Math.round((target.mask.density ?? 1) * 100)}
            oninput={(e) => controller.setAdjustmentLayerMaskProps(target.id, { density: Number((e.currentTarget as HTMLInputElement).value) / 100 })}
            class={imageRangeClass}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="flex justify-between text-muted-foreground">
            <span>Mask Feather</span>
            <span class="font-mono">{target.mask.feather ?? 0}px</span>
          </span>
          <input
            type="range"
            min="0"
            max="50"
            step="0.5"
            aria-label="Mask feather"
            value={target.mask.feather ?? 0}
            oninput={(e) => controller.setAdjustmentLayerMaskProps(target.id, { feather: Number((e.currentTarget as HTMLInputElement).value) })}
            class={imageRangeClass}
          />
        </label>
      {/if}
    </div>
  {/if}
</div>
