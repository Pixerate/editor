<script lang="ts">
  import ImageSelect from './controls/ImageSelect.svelte';
  import ImageCheckbox from './controls/ImageCheckbox.svelte';
  import type { ImageEditorController, TransformAnchor } from '@pixerate/editor/image-editor';
  import { CANVAS_SIZE_PRESETS, isTransformAnchor } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';
  import { imagePrimaryButtonClass } from './styles.js';

  interface Props {
    controller: ImageEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });

  const natural = $derived.by(() => {
    void tick;
    return controller.getCanvasSize();
  });

  let width = $state(800);
  let height = $state(600);
  let lockAspect = $state(false);
  let anchor = $state<TransformAnchor>('center');
  let error = $state<string | null>(null);

  // Sync initial dimensions with current canvas size
  $effect(() => {
    width = natural.width;
    height = natural.height;
  });

  const ANCHOR_GRID: TransformAnchor[][] = [
    ['top-left', 'top', 'top-right'],
    ['left', 'center', 'right'],
    ['bottom-left', 'bottom', 'bottom-right'],
  ];

  function onWidthChange(val: number) {
    if (lockAspect && natural.width > 0) {
      const ratio = natural.height / natural.width;
      height = Math.max(1, Math.round(val * ratio));
    }
    width = val;
  }

  function onHeightChange(val: number) {
    if (lockAspect && natural.height > 0) {
      const ratio = natural.width / natural.height;
      width = Math.max(1, Math.round(val * ratio));
    }
    height = val;
  }

  function onPresetSelect(presetId: string) {
    const preset = CANVAS_SIZE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    width = preset.width;
    height = preset.height;
  }


  function apply() {
    error = null;
    try {
      controller.resizeCanvas({ width, height, anchor });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div class="flex flex-col gap-3 text-xs text-foreground {className}" data-image-panel="canvas-size" data-testid="canvas-size-panel">
  <div class="font-medium text-sm text-foreground">Canvas Size</div>

  {#if error}
    <div class="text-xs text-destructive bg-destructive/10 p-1.5 rounded">{error}</div>
  {/if}

  <div class="flex flex-col gap-1.5">
    <span class="text-muted-foreground text-[11px]">Preset</span>
    <ImageSelect
      class="w-full"
      label="Preset canvas sizes"
      value=""
      placeholder="Choose preset…"
      options={CANVAS_SIZE_PRESETS.map((preset) => ({ value: preset.id, label: `${preset.label} (${preset.width} × ${preset.height})` }))}
      onchange={onPresetSelect}
    />
  </div>

  <div class="grid grid-cols-2 gap-2 items-center">
    <div class="flex flex-col gap-1">
      <label for="canvas-size-width" class="text-muted-foreground text-[11px]">Width (px)</label>
      <input
        id="canvas-size-width"
        type="number"
        min="1"
        max="16384"
        class="w-full bg-background border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        value={width}
        oninput={(e) => onWidthChange(Number((e.currentTarget as HTMLInputElement).value))}
      />
    </div>

    <div class="flex flex-col gap-1">
      <label for="canvas-size-height" class="text-muted-foreground text-[11px]">Height (px)</label>
      <input
        id="canvas-size-height"
        type="number"
        min="1"
        max="16384"
        class="w-full bg-background border border-border rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        value={height}
        oninput={(e) => onHeightChange(Number((e.currentTarget as HTMLInputElement).value))}
      />
    </div>
  </div>

  <div class="flex items-center gap-2">
    <label class="flex items-center gap-1.5 cursor-pointer text-muted-foreground select-none">
      <ImageCheckbox label="Lock aspect ratio" checked={lockAspect} onchange={(on) => (lockAspect = on)} />
      <span>Lock aspect ratio</span>
    </label>
  </div>

  <div class="flex flex-col gap-1.5">
    <span class="text-muted-foreground text-[11px]">Anchor</span>
    <div class="grid grid-cols-3 gap-1 w-24 h-24 p-1 bg-muted/40 border border-border rounded" role="radiogroup" aria-label="Resize anchor">
      {#each ANCHOR_GRID as row}
        {#each row as a (a)}
          <button
            type="button"
            role="radio"
            aria-checked={anchor === a}
            aria-label={a}
            class="w-full h-full rounded flex items-center justify-center transition-colors {anchor === a ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted text-muted-foreground'}"
            onclick={() => (anchor = a)}
          >
            <div class="w-1.5 h-1.5 rounded-full {anchor === a ? 'bg-primary-foreground' : 'bg-muted-foreground/60'}"></div>
          </button>
        {/each}
      {/each}
    </div>
  </div>

  <div class="pt-2">
    <button
      type="button"
      class="{imagePrimaryButtonClass} w-full"
      onclick={apply}
    >
      Apply Canvas Size
    </button>
  </div>
</div>
