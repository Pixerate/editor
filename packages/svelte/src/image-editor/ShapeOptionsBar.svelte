<script lang="ts">
  import ImageColor from './controls/ImageColor.svelte';
  import ImageCheckbox from './controls/ImageCheckbox.svelte';
  import ImageRange from './controls/ImageRange.svelte';
  import { imageChipClass, imageFieldClass } from './styles.js';
  import type { ImageEditorController, ShapeToolOptions } from '@pixerate/editor/image-editor';
  import { LIVE_SHAPE_KINDS, SHAPE_KIND_LABELS, applyShapeOptions } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  /**
   * The shape tool's options: the kind to draw, fill and stroke (colour or none), stroke width and
   * the kind's own settings (corner radius, sides, points, line weight and arrowhead). Changes also
   * apply to the active shape layer, as one undo step each.
   */
  interface Props {
    controller: ImageEditorController;
    options: ShapeToolOptions;
    onchange: (options: ShapeToolOptions) => void;
    /** The tool picker row (default true); hide it when the host's toolbar offers the same choice. */
    showTools?: boolean;
    class?: string;
  }

  let { controller, options, onchange, showTools = true, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });
  const shapeId = $derived.by(() => {
    void tick;
    const a = controller.getActiveLayer();
    return a?.type === 'shape' ? a.id : null;
  });
  let error = $state<string | null>(null);

  
  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Number(v) || min));

  function set(change: Partial<ShapeToolOptions>) {
    onchange({ ...options, ...change });
    if (!shapeId) return;
    try {
      error = null;
      applyShapeOptions(controller, shapeId, change);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const value = (e: Event) => (e.target as HTMLInputElement).value;
</script>

<div class="flex flex-col gap-2 text-xs text-foreground {className}" data-testid="shape-options">
  {#if showTools}
    <div class="flex flex-wrap gap-1" role="toolbar" aria-label="Shape kind">
      {#each LIVE_SHAPE_KINDS as k (k)}
        <button type="button" aria-pressed={options.kind === k} class={imageChipClass(options.kind === k)} onclick={() => onchange({ ...options, kind: k })}>{SHAPE_KIND_LABELS[k]}</button>
      {/each}
    </div>
  {/if}
  <div class="flex flex-wrap items-center gap-3">
    <label class="flex items-center gap-1">
      <ImageCheckbox label="Fill" checked={options.fill !== null} onchange={(on) => set({ fill: on ? '#4f46e5' : null })} />
      Fill
      <ImageColor label="Fill colour" disabled={options.fill === null} value={options.fill ?? '#4f46e5'} oninput={(fill) => set({ fill })} />
    </label>
    <label class="flex items-center gap-1">
      <ImageCheckbox label="Stroke" checked={options.stroke !== null} onchange={(on) => set({ stroke: on ? '#000000' : null })} />
      Stroke
      <ImageColor label="Stroke colour" disabled={options.stroke === null} value={options.stroke ?? '#000000'} oninput={(stroke) => set({ stroke })} />
    </label>
    <label class="flex items-center gap-1">
      Width
      <input type="number" aria-label="Stroke width" min="0" max="200" value={options.strokeWidth} oninput={(e) => set({ strokeWidth: num(value(e), 0, 200) })} class="w-14 {imageFieldClass}" />
    </label>
  </div>
  <div class="flex flex-wrap items-center gap-3">
    {#if options.kind === 'rect'}
      <label class="flex items-center gap-1">
        Radius
        <input type="number" aria-label="Corner radius" min="0" max="1000" value={options.radius} oninput={(e) => set({ radius: num(value(e), 0, 1000) })} class="w-14 {imageFieldClass}" />
      </label>
    {:else if options.kind === 'polygon'}
      <label class="flex items-center gap-1">
        Sides
        <input type="number" aria-label="Sides" min="3" max="100" value={options.sides} oninput={(e) => set({ sides: num(value(e), 3, 100) })} class="w-14 {imageFieldClass}" />
      </label>
    {:else if options.kind === 'star'}
      <label class="flex items-center gap-1">
        Points
        <input type="number" aria-label="Points" min="3" max="100" value={options.points} oninput={(e) => set({ points: num(value(e), 3, 100) })} class="w-14 {imageFieldClass}" />
      </label>
      <label class="flex items-center gap-1">
        Inner
        <ImageRange label="Inner radius" min={0.05} max={1} step={0.05} value={options.innerRatio} oninput={(v) => set({ innerRatio: v })} />
      </label>
    {:else if options.kind === 'line'}
      <label class="flex items-center gap-1">
        Weight
        <input type="number" aria-label="Line weight" min="1" max="200" value={options.weight} oninput={(e) => set({ weight: num(value(e), 1, 200) })} class="w-14 {imageFieldClass}" />
      </label>
      <label class="flex items-center gap-1">
        <ImageCheckbox label="Arrowhead" checked={options.arrow} onchange={(on) => set({ arrow: on })} />
        Arrowhead
      </label>
    {/if}
  </div>
  <p class="text-[10px] text-muted-foreground">Drag on the image to draw. Shift: square, circle or 45° line. Alt: from the centre.</p>
  {#if error}
    <p role="alert" class="text-destructive">{error}</p>
  {/if}
</div>
