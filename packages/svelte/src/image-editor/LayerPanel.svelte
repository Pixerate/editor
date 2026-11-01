<script lang="ts">
  import type { ImageEditorController, ImageHistogram, ImageLayer } from '@pixerate/editor/image-editor';
  import {
    ADJUSTMENT_LAYER_OPACITY_CONTROL,
    DEFAULT_SHAPE_TOOL_OPTIONS,
    DEFAULT_TYPE_TOOL_OPTIONS,
    DEFAULT_SELECTION_TOOL_OPTIONS,
    IMAGE_ADJUSTMENT_CONTROLS,
    readAdjustmentControls,
    type SelectionToolOptions,
    type ShapeToolOptions,
    type TypeToolOptions,
  } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';
  import CanvasSizePanel from './CanvasSizePanel.svelte';
  import ControlSlider from './ControlSlider.svelte';
  import LayerEffectsPanel from './LayerEffectsPanel.svelte';
  import BrushOptionsBar from './BrushOptionsBar.svelte';
  import ShapeOptionsBar from './ShapeOptionsBar.svelte';
  import TypeOptionsBar from './TypeOptionsBar.svelte';
  import AdjustmentLayersPanel from './AdjustmentLayersPanel.svelte';
  import SelectionOptionsBar from './SelectionOptionsBar.svelte';
  import ImageProviderEffectsPanel from './ImageProviderEffectsPanel.svelte';
  import RefineEdgePanel from './RefineEdgePanel.svelte';
  import ChannelsPanel from './ChannelsPanel.svelte';
  import PathsPanel from './PathsPanel.svelte';
  import EdgeColorPanel from './EdgeColorPanel.svelte';
  import VectorMaskEdgesPanel from './VectorMaskEdgesPanel.svelte';
  import Histogram from './Histogram.svelte';

  interface Props {
    controller: ImageEditorController;
    panelId: string;
    /**
     * The Selection panel's tool options. Bind them (with the canvas's `selectionOptions`) so the
     * tool and settings picked here are the ones the canvas selects with; unbound, the panel keeps
     * its own.
     */
    selectionOptions?: SelectionToolOptions;
    /** The Shape Options panel's options; bind them with the canvas's `shapeOptions`. */
    shapeOptions?: ShapeToolOptions;
    /** The Typography panel's options; bind them with the canvas's `typeOptions`. */
    typeOptions?: TypeToolOptions;
    class?: string;
  }

  let {
    controller,
    panelId,
    selectionOptions = $bindable({ ...DEFAULT_SELECTION_TOOL_OPTIONS }),
    shapeOptions = $bindable({ ...DEFAULT_SHAPE_TOOL_OPTIONS }),
    typeOptions = $bindable({ ...DEFAULT_TYPE_TOOL_OPTIONS }),
    class: className = '',
  }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    // `subscribe` calls the listener at once: untracked, or the effect would depend on `tick`.
    return untrack(() => c.subscribe(() => tick++));
  });
  // The controller isn't reactive: re-read the active layer after every change.
  const activeLayer = $derived.by(() => {
    void tick;
    return controller.getActiveLayer();
  });
  const adjustments = $derived.by(() => {
    void tick;
    return readAdjustmentControls(controller.getState().adjustments);
  });
  let histogram = $state.raw<ImageHistogram | null>(null);
  $effect(() => {
    if (panelId !== 'color') return;
    const c = controller;
    return untrack(() => {
      histogram = c.getHistogram();
      return c.subscribeHistogram((h) => (histogram = h));
    });
  });
  /** Layers whose soft edge takes Edge Colour (decontaminate, despill, cast). */
  const EDGE_COLOR_TYPES = new Set(['pixel', 'shape', 'type', 'smart']);
</script>

<div class="layer-panel-container {className}" data-image-panel={panelId} data-testid="layer-panel-{panelId}">
  {#if panelId === 'canvas-size'}
    <CanvasSizePanel {controller} />
  {:else if panelId === 'properties'}
    <div class="flex flex-col gap-3 text-xs text-foreground">
      <div class="font-medium text-sm">Properties</div>
      {#if activeLayer}
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground">Name</span>
            <span class="font-medium">{activeLayer.name || activeLayer.id}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground">Type</span>
            <span class="capitalize">{activeLayer.type}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground">Blend Mode</span>
            <span class="capitalize">{activeLayer.blend}</span>
          </div>
          <ControlSlider
            spec={ADJUSTMENT_LAYER_OPACITY_CONTROL}
            label="Opacity"
            value={activeLayer.opacity}
            onchange={(val) => controller.setLayerProperties(activeLayer.id, { opacity: val })}
          />
        </div>
        <!-- Layer Style (drop shadow, stroke, glow…) is part of the layer's properties; adjustment layers have none. -->
        {#if activeLayer.type !== 'adjustment'}
          <LayerEffectsPanel {controller} layerId={activeLayer.id} class="border-t border-border pt-2" />
        {/if}
      {:else}
        <div class="text-muted-foreground">No active layer selected.</div>
      {/if}
    </div>
  {:else if panelId === 'paint'}
    <div class="flex flex-col gap-3">
      <div class="font-medium text-sm text-foreground">Brush & Paint</div>
      <BrushOptionsBar {controller} />
    </div>
  {:else if panelId === 'effects'}
    <!-- Kept for hosts that still ask for it by id: layerPanels() folds it into 'properties'. -->
    <LayerEffectsPanel {controller} />
  {:else if panelId === 'color'}
    <!-- The colour adjustments (white balance, light, colour) without Add Adjustment Layer, which a host's layers panel offers. -->
    <div class="flex flex-col gap-3 text-xs text-foreground">
      <div class="flex items-center justify-between">
        <span class="font-medium text-sm">Color Adjustments</span>
        <button type="button" class="text-[10px] text-destructive hover:underline" onclick={() => controller.resetAdjustments()}>Reset</button>
      </div>
      {#if histogram}<Histogram {histogram} />{/if}
      {#each IMAGE_ADJUSTMENT_CONTROLS as spec (spec.id)}
        <ControlSlider {spec} value={adjustments[spec.id]} onchange={(v) => controller.setAdjustments({ [spec.id]: v })} />
      {/each}
    </div>
  {:else if panelId === 'adjustment'}
    <AdjustmentLayersPanel {controller} />
  {:else if panelId === 'type'}
    <div class="flex flex-col gap-3">
      <div class="font-medium text-sm text-foreground">Typography</div>
      <TypeOptionsBar {controller} options={typeOptions} onchange={(o) => (typeOptions = o)} />
    </div>
  {:else if panelId === 'shape'}
    <div class="flex flex-col gap-3">
      <div class="font-medium text-sm text-foreground">Shape Options</div>
      <ShapeOptionsBar {controller} options={shapeOptions} onchange={(o) => (shapeOptions = o)} />
    </div>
  {:else if panelId === 'smart-filters'}
    <!-- Kept for hosts that still ask for it by id: smart filters are under 'provider-effects'. -->
    <ImageProviderEffectsPanel {controller} />
  {:else if panelId === 'provider-effects'}
    <ImageProviderEffectsPanel {controller} />
  {:else if panelId === 'selection'}
    <div class="flex flex-col gap-3">
      <div class="font-medium text-sm text-foreground">Selection</div>
      <SelectionOptionsBar {controller} options={selectionOptions} onOptionsChange={(o) => (selectionOptions = o)} />
      <RefineEdgePanel {controller} />
    </div>
  {:else if panelId === 'channels'}
    <ChannelsPanel {controller} />
  {:else if panelId === 'paths'}
    <PathsPanel {controller} />
  {:else if panelId === 'mask'}
    <div class="flex flex-col gap-3 text-xs">
      <div class="font-medium text-sm text-foreground">Mask & Edges</div>
      {#if activeLayer}
        {#key activeLayer.id}
          {#if activeLayer.vectorMask}
            <VectorMaskEdgesPanel {controller} layer={activeLayer} />
          {/if}
          {#if EDGE_COLOR_TYPES.has(activeLayer.type)}
            <EdgeColorPanel {controller} layer={activeLayer} />
          {/if}
        {/key}
      {:else}
        <div class="text-muted-foreground">No active layer selected.</div>
      {/if}
    </div>
  {:else}
    <div class="text-xs text-muted-foreground">Panel {panelId}</div>
  {/if}
</div>
