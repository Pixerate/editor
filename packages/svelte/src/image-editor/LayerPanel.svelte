<script lang="ts">
  import type { ImageEditorController, ImageLayer } from '@pixerate/editor/image-editor';
  import CanvasSizePanel from './CanvasSizePanel.svelte';
  import ControlSlider from './ControlSlider.svelte';
  import LayerEffectsPanel from './LayerEffectsPanel.svelte';
  import BrushOptionsBar from './BrushOptionsBar.svelte';
  import ShapeOptionsBar from './ShapeOptionsBar.svelte';
  import TypeOptionsBar from './TypeOptionsBar.svelte';
  import AdjustmentLayersPanel from './AdjustmentLayersPanel.svelte';
  import SelectionOptionsBar from './SelectionOptionsBar.svelte';

  interface Props {
    controller: ImageEditorController;
    panelId: string;
    class?: string;
  }

  let { controller, panelId, class: className = '' }: Props = $props();

  const activeLayer = $derived(controller.getActiveLayer());
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
            id="layer-opacity"
            label="Opacity"
            value={Math.round(activeLayer.opacity * 100)}
            min={0}
            max={100}
            step={1}
            unit="%"
            onchange={(val) => controller.setLayerProperties(activeLayer.id, { opacity: val / 100 })}
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
      <TypeOptionsBar {controller} />
    </div>
  {:else if panelId === 'shape'}
    <div class="flex flex-col gap-3">
      <div class="font-medium text-sm text-foreground">Shape Options</div>
      <ShapeOptionsBar {controller} />
    </div>
  {:else if panelId === 'smart-filters'}
    <div class="flex flex-col gap-3">
      <div class="font-medium text-sm text-foreground">Smart Filters</div>
      <LayerEffectsPanel {controller} />
    </div>
  {:else if panelId === 'selection'}
    <div class="flex flex-col gap-3">
      <div class="font-medium text-sm text-foreground">Selection</div>
      <SelectionOptionsBar {controller} />
    </div>
  {:else}
    <div class="text-xs text-muted-foreground">Panel {panelId}</div>
  {/if}
</div>
