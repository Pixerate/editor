<script lang="ts">
  import ImageColor from './controls/ImageColor.svelte';
  import ImageCheckbox from './controls/ImageCheckbox.svelte';
  import { imageChipClass } from './styles.js';
  import type { ImageEditorController } from '@pixerate/editor/image-editor';
  import {
    userErrorMessage,
    BRUSH_OPTION_CONTROLS,
    MIXER_MIXING_OPTIONS,
    MIXER_OPTION_CONTROLS,
    PAINT_TOOLS,
    RETOUCH_CHOICES,
    RETOUCH_OPTION_CONTROLS,
    RETOUCH_TOGGLES,
    CLONE_TRANSFORM_CONTROLS,
    cloneSourceLabel,
    cloneTransformView,
    setCloneTransformValue,
    isRetouchPaintTool,
    rgbUnitToHex,
    setRetouchChoice,
  } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';
  import { DEFAULT_PAINT_GRADIENT } from '@pixerate/editor/image-editor';
  import PaintGradientEditor from './PaintGradientEditor.svelte';
  import ControlSlider from './ControlSlider.svelte';

  interface Props {
    controller: ImageEditorController;
    /** The row of paint tool buttons (default true); hide it when the host has its own toolbar. */
    showTools?: boolean;
    class?: string;
  }

  let { controller, showTools = true, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    // `subscribe` calls the listener at once: untracked, or the effect would depend on `tick`.
    return untrack(() => c.subscribe(() => tick++));
  });
  const view = $derived.by(() => {
    void tick;
    const s = controller.getState();
    return { tool: s.activeTool, sourceLabel: cloneSourceLabel(controller), cloneView: cloneTransformView(controller), ...s.paint };
  });
  let error = $state<string | null>(null);

  

  function attempt(fn: () => unknown) {
    try {
      error = null;
      fn();
    } catch (err) {
      error = userErrorMessage(err);
    }
  }
</script>

<div class="flex flex-col gap-2 text-xs text-foreground {className}" data-testid="brush-options">
  {#if showTools}
    <div class="flex flex-wrap gap-1" role="toolbar" aria-label="Paint tools">
      {#each PAINT_TOOLS as t (t.id)}
        <button
          type="button"
          aria-pressed={view.tool === t.id}
          title={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}
          class={imageChipClass(view.tool === t.id)}
          onclick={() => controller.setTool(t.id)}>{t.label}</button>
      {/each}
    </div>
  {/if}

  <div class="flex items-center gap-2" role="group" aria-label="Colours">
    <label class="flex items-center gap-1">
      <ImageColor label="Foreground colour" value={view.foreground} oninput={(foreground) => controller.setPaintOptions({ foreground })} />
      <span class="text-muted-foreground">FG</span>
    </label>
    <label class="flex items-center gap-1">
      <ImageColor label="Background colour" value={view.background} oninput={(background) => controller.setPaintOptions({ background })} />
      <span class="text-muted-foreground">BG</span>
    </label>
    <button type="button" title="Swap colours (X)" class={imageChipClass(false)} onclick={() => controller.swapPaintColors()}>Swap</button>
    <button type="button" title="Default colours (D)" class={imageChipClass(false)} onclick={() => controller.resetPaintColors()}>Default</button>
    {#if view.tool === 'brush'}
      <button
        type="button"
        aria-pressed={view.paint.type === 'gradient'}
        title="Gradient paint: the brush changes colour as the stroke goes"
        class={imageChipClass(view.paint.type === 'gradient')}
        onclick={() => attempt(() => controller.setPaintOptions(view.paint.type === 'gradient' ? { foreground: view.foreground } : { paint: DEFAULT_PAINT_GRADIENT }))}>Gradient</button
      >
    {/if}
  </div>
  {#if view.tool === 'brush' && view.paint.type === 'gradient'}
    <PaintGradientEditor value={view.paint} colors={{ paint: view.foreground, secondary: view.background }} onchange={(g) => attempt(() => controller.setPaintOptions({ paint: g }))} />
  {/if}

  {#each BRUSH_OPTION_CONTROLS as spec (spec.id)}
    <ControlSlider {spec} value={view.brush[spec.id]} onchange={(v) => controller.setPaintOptions({ brush: { [spec.id]: v } })} />
  {/each}

  {#if view.tool === 'mixer'}
    {@const load = view.mixerLoad}
    <div class="flex flex-col gap-2 border-t border-border pt-2" role="group" aria-label="Mixer Brush" data-testid="mixer-options">
      <div class="flex items-center gap-2">
        <span
          aria-label="Brush load"
          title={load.reservoir ? `Loaded ${rgbUnitToHex(load.reservoir)}, ${Math.round(load.amount * 100)}% left` : 'Unloaded'}
          class="h-6 w-6 rounded border border-border"
          style:background={load.reservoir ? rgbUnitToHex(load.reservoir) : 'transparent'}
        ></span>
        <button type="button" title="Fill the reservoir with the foreground colour" class={imageChipClass(false)} onclick={() => controller.loadMixerBrush()}>Load brush</button>
        <button type="button" title="Empty the picked-up colour" class={imageChipClass(false)} onclick={() => controller.cleanMixerBrush()}>Clean brush</button>
      </div>
      <div class="flex gap-1" role="group" aria-label="Mixing">
        {#each MIXER_MIXING_OPTIONS as m (m.id)}
          <button
            type="button"
            aria-pressed={view.mixer.mixing === m.id}
            title={m.title}
            class={imageChipClass(view.mixer.mixing === m.id)}
            onclick={() => controller.setPaintOptions({ mixer: { mixing: m.id } })}>{m.label}</button>
        {/each}
      </div>
      {#each MIXER_OPTION_CONTROLS as spec (spec.id)}
        <ControlSlider {spec} value={view.mixer[spec.id]} onchange={(v) => controller.setPaintOptions({ mixer: { [spec.id]: v } })} />
      {/each}
      <div class="flex flex-wrap gap-3 text-foreground">
        <label class="flex items-center gap-1.5">
          <ImageCheckbox label="Load the brush after each stroke" checked={view.mixer.loadEachStroke} onchange={(on) => controller.setPaintOptions({ mixer: { loadEachStroke: on } })} />
          Load each stroke
        </label>
        <label class="flex items-center gap-1.5">
          <ImageCheckbox label="Clean the brush after each stroke" checked={view.mixer.cleanEachStroke} onchange={(on) => controller.setPaintOptions({ mixer: { cleanEachStroke: on } })} />
          Clean each stroke
        </label>
      </div>
    </div>
  {/if}

  {#if isRetouchPaintTool(view.tool)}
    <div class="flex flex-col gap-2 border-t border-border pt-2" role="group" aria-label="Retouch options" data-testid="retouch-options">
      {#if view.tool === 'clone' || view.tool === 'heal'}
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground" data-testid="clone-source">{view.sourceLabel}</span>
          {#if view.cloneSource}
            <button type="button" title="Forget the source point" class={imageChipClass(false)} onclick={() => controller.setCloneSource(null)}>Clear source</button>
          {/if}
        </div>
        <div class="flex flex-col gap-1" role="group" aria-label="Clone source transform" data-testid="clone-transform">
          {#each CLONE_TRANSFORM_CONTROLS as spec (spec.id)}
            <ControlSlider {spec} value={view.cloneView[spec.id]} onchange={(v) => setCloneTransformValue(controller, spec.id, v)} />
          {/each}
          <div class="flex items-center gap-1">
            <button type="button" aria-pressed={view.cloneView.flipH} title="Mirror the source left to right" class={imageChipClass(view.cloneView.flipH)} onclick={() => setCloneTransformValue(controller, 'flipH')}>Flip H</button>
            <button type="button" aria-pressed={view.cloneView.flipV} title="Mirror the source top to bottom" class={imageChipClass(view.cloneView.flipV)} onclick={() => setCloneTransformValue(controller, 'flipV')}>Flip V</button>
            {#if !view.cloneView.identity}
              <button type="button" title="Back to 100 %, no flip, 0°" class={imageChipClass(false)} onclick={() => controller.setCloneTransform(null)}>Reset transform</button>
            {/if}
          </div>
        </div>
      {/if}
      {#each RETOUCH_CHOICES.filter((c) => c.tools.includes(view.tool as never)) as choice (choice.id)}
        <div class="flex flex-wrap items-center gap-1" role="group" aria-label={choice.label}>
          <span class="text-muted-foreground">{choice.label}</span>
          {#each choice.options as o (o.id)}
            <button
              type="button"
              aria-pressed={view.retouch[choice.id] === o.id}
              title={o.title}
              class={imageChipClass(view.retouch[choice.id] === o.id)}
              onclick={() => setRetouchChoice(controller, choice.id, o.id)}>{o.label}</button>
          {/each}
        </div>
      {/each}
      {#each RETOUCH_OPTION_CONTROLS.filter((c) => c.tools.includes(view.tool as never)) as spec (spec.id)}
        <ControlSlider {spec} value={view.retouch[spec.id]} onchange={(v) => controller.setPaintOptions({ retouch: { [spec.id]: v } })} />
      {/each}
      <div class="flex flex-wrap gap-3 text-foreground">
        {#each RETOUCH_TOGGLES.filter((t) => t.tools.includes(view.tool as never)) as t (t.id)}
          <label class="flex items-center gap-1.5">
            <ImageCheckbox label={t.label} checked={view.retouch[t.id]} onchange={(on) => controller.setPaintOptions({ retouch: { [t.id]: on } })} />
            {t.label}
          </label>
        {/each}
      </div>
    </div>
  {/if}

  <div class="flex flex-wrap gap-3 text-foreground" role="group" aria-label="Pressure">
    <label class="flex items-center gap-1.5">
      <ImageCheckbox label="Pressure controls size" checked={view.brush.pressureSize} onchange={(on) => controller.setPaintOptions({ brush: { pressureSize: on } })} />
      Pressure size
    </label>
    <label class="flex items-center gap-1.5">
      <ImageCheckbox label="Pressure controls opacity" checked={view.brush.pressureOpacity} onchange={(on) => controller.setPaintOptions({ brush: { pressureOpacity: on } })} />
      Pressure opacity
    </label>
  </div>

  <div class="flex gap-1">
    <button type="button" class={imageChipClass(false)} onclick={() => attempt(() => controller.fillPixels())}>Fill</button>
    <button type="button" class={imageChipClass(false)} onclick={() => attempt(() => controller.clearPixels())}>Clear</button>
  </div>
  {#if error}
    <p role="alert" class="text-destructive">{error}</p>
  {/if}
</div>
