<script lang="ts">
  import type { ImageEditorController, ImageLayer } from '@pixerate/editor/image-editor';
  import {
    ADJUSTMENT_LAYER_OPACITY_CONTROL,
    DEFAULT_SHAPE_TOOL_OPTIONS,
    DEFAULT_TYPE_TOOL_OPTIONS,
    DEFAULT_SELECTION_TOOL_OPTIONS,
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

  interface Props {
    controller: ImageEditorController;
    panelId: string;
    class?: string;
  }

  let { controller, panelId, class: className = '' }: Props = $props();

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
  let shapeOptions = $state({ ...DEFAULT_SHAPE_TOOL_OPTIONS });
  let typeOptions = $state({ ...DEFAULT_TYPE_TOOL_OPTIONS });
  let selectionOptions = $state({ ...DEFAULT_SELECTION_TOOL_OPTIONS });
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
    <div class="flex flex-col gap-3">
      <div class="font-medium text-sm text-foreground">Layer Effects</div>
      <LayerEffectsPanel {controller} />
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
    <div class="flex flex-col gap-3">
      <div class="font-medium text-sm text-foreground">Smart Filters</div>
      <LayerEffectsPanel {controller} />
    </div>
  {:else if panelId === 'provider-effects'}
    <ImageProviderEffectsPanel {controller} />
  {:else if panelId === 'selection'}
    <div class="flex flex-col gap-3">
      <div class="font-medium text-sm text-foreground">Selection</div>
      <SelectionOptionsBar {controller} options={selectionOptions} onOptionsChange={(o) => (selectionOptions = o)} />
    </div>
  {:else}
    <div class="text-xs text-muted-foreground">Panel {panelId}</div>
  {/if}
</div>
