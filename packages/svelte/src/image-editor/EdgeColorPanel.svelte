<script lang="ts">
  import ImageCheckbox from './controls/ImageCheckbox.svelte';
  import type { ImageEditorController, ImageLayer } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  /**
   * Edge Colour: decontamination, despill and the live edge cast of a layer's soft edge, applied
   * when compositing (nothing is baked), as the `set_edge_*` tools set them. A slider drag is one
   * undo step.
   */
  interface Props {
    controller: ImageEditorController;
    /** The layer to edit (a pixel, shape, type or smart object layer). */
    layer: ImageLayer;
    class?: string;
  }

  let { controller, layer, class: className = '' }: Props = $props();

  const SLIDERS = [
    { key: 'decontaminate', label: 'Decontaminate', hint: 'Unmix the old background from a soft-edged mask' },
    { key: 'despill', label: 'Despill', hint: "Take out the old background's hue at the edge" },
    { key: 'ambient', label: 'Cast', hint: 'Tint the edge with what is behind the layer, live' },
  ] as const;

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });
  let error = $state<string | null>(null);
  let commitNext = true;
  const info = $derived.by(() => {
    void tick;
    return controller.getEdgeColor(layer.id);
  });
  const fixed = $derived(info.ambientSource !== 'auto');

  function set(change: Parameters<ImageEditorController['setEdgeColor']>[1]) {
    error = null;
    try {
      controller.setEdgeColor(layer.id, change, commitNext);
      commitNext = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const startDrag = () => (commitNext = true);
</script>

<details class="text-xs {className}" data-testid="edge-color-panel" open={Boolean(info.decontaminate || info.despill || info.ambient) || undefined}>
  <summary class="cursor-pointer text-muted-foreground">Edge Colour</summary>
  <div class="flex flex-col gap-1.5 pt-1">
    {#each SLIDERS as s (s.key)}
      <label class="flex flex-col gap-0.5" title={s.hint}>
        <span class="flex justify-between text-muted-foreground">
          <span>{s.label}</span>
          <span class="font-mono">{info[s.key]}%</span>
        </span>
        <input
          type="range"
          min="0"
          max="100"
          aria-label="Edge {s.label.toLowerCase()}"
          value={info[s.key]}
          onpointerdown={startDrag}
          onpointerup={startDrag}
          onkeydown={startDrag}
          oninput={(e) => set({ [s.key]: Number((e.currentTarget as HTMLInputElement).value) })}
          class="accent-primary"
        />
      </label>
    {/each}
    <label class="flex items-center gap-1.5 text-foreground">
      <ImageCheckbox
        label="Fixed cast colour"
        checked={fixed}
        onchange={(on) => {
          commitNext = true;
          set({ ambientColor: on ? '#808080' : 'auto' });
        }}
      />
      Fixed cast colour
      {#if fixed}
        <input
          type="color"
          aria-label="Cast colour"
          value={info.ambientSource}
          onchange={(e) => {
            commitNext = true;
            set({ ambientColor: (e.currentTarget as HTMLInputElement).value });
          }}
          class="h-5 w-8 bg-background border border-border rounded"
        />
      {/if}
    </label>
    {#if error}
      <p role="alert" class="text-destructive">{error}</p>
    {/if}
  </div>
</details>
