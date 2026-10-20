<script lang="ts">
  import type { ImageEditorController } from '@pixerate/editor/image-editor';
  import {
    BRUSH_OPTION_CONTROLS,
    MIXER_MIXING_OPTIONS,
    MIXER_OPTION_CONTROLS,
    PAINT_TOOLS,
    RETOUCH_CHOICES,
    RETOUCH_OPTION_CONTROLS,
    RETOUCH_TOGGLES,
    cloneSourceLabel,
    isRetouchPaintTool,
    rgbUnitToHex,
    setRetouchChoice,
  } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';
  import ControlSlider from './ControlSlider.svelte';

  interface Props {
    controller: ImageEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    // `subscribe` calls the listener at once: untracked, or the effect would depend on `tick`.
    return untrack(() => c.subscribe(() => tick++));
  });
  const view = $derived.by(() => {
    void tick;
    const s = controller.getState();
    return { tool: s.activeTool, sourceLabel: cloneSourceLabel(controller), ...s.paint };
  });
  let error = $state<string | null>(null);

  const chip = (on: boolean) => `px-2 py-1 rounded text-[11px] ${on ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:text-white'}`;

  function attempt(fn: () => unknown) {
    try {
      error = null;
      fn();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div class="flex flex-col gap-2 text-xs text-slate-200 {className}" data-testid="brush-options">
  <div class="flex flex-wrap gap-1" role="toolbar" aria-label="Paint tools">
    {#each PAINT_TOOLS as t (t.id)}
      <button
        type="button"
        aria-pressed={view.tool === t.id}
        title={t.shortcut ? `${t.label} (${t.shortcut})` : t.label}
        class={chip(view.tool === t.id)}
        onclick={() => controller.setTool(t.id)}>{t.label}</button>
    {/each}
  </div>

  <div class="flex items-center gap-2" role="group" aria-label="Colours">
    <label class="flex items-center gap-1">
      <input
        type="color"
        aria-label="Foreground colour"
        value={view.foreground}
        oninput={(e) => controller.setPaintOptions({ foreground: (e.target as HTMLInputElement).value })}
        class="h-6 w-8 rounded border border-slate-700 bg-transparent"
      />
      <span class="text-slate-400">FG</span>
    </label>
    <label class="flex items-center gap-1">
      <input
        type="color"
        aria-label="Background colour"
        value={view.background}
        oninput={(e) => controller.setPaintOptions({ background: (e.target as HTMLInputElement).value })}
        class="h-6 w-8 rounded border border-slate-700 bg-transparent"
      />
      <span class="text-slate-400">BG</span>
    </label>
    <button type="button" title="Swap colours (X)" class={chip(false)} onclick={() => controller.swapPaintColors()}>Swap</button>
    <button type="button" title="Default colours (D)" class={chip(false)} onclick={() => controller.resetPaintColors()}>Default</button>
  </div>

  {#each BRUSH_OPTION_CONTROLS as spec (spec.id)}
    <ControlSlider {spec} value={view.brush[spec.id]} onchange={(v) => controller.setPaintOptions({ brush: { [spec.id]: v } })} />
  {/each}

  {#if view.tool === 'mixer'}
    {@const load = view.mixerLoad}
    <div class="flex flex-col gap-2 border-t border-slate-800 pt-2" role="group" aria-label="Mixer Brush" data-testid="mixer-options">
      <div class="flex items-center gap-2">
        <span
          aria-label="Brush load"
          title={load.reservoir ? `Loaded ${rgbUnitToHex(load.reservoir)}, ${Math.round(load.amount * 100)}% left` : 'Unloaded'}
          class="h-6 w-6 rounded border border-slate-700"
          style:background={load.reservoir ? rgbUnitToHex(load.reservoir) : 'transparent'}
        ></span>
        <button type="button" title="Fill the reservoir with the foreground colour" class={chip(false)} onclick={() => controller.loadMixerBrush()}>Load brush</button>
        <button type="button" title="Empty the picked-up colour" class={chip(false)} onclick={() => controller.cleanMixerBrush()}>Clean brush</button>
      </div>
      <div class="flex gap-1" role="group" aria-label="Mixing">
        {#each MIXER_MIXING_OPTIONS as m (m.id)}
          <button
            type="button"
            aria-pressed={view.mixer.mixing === m.id}
            title={m.title}
            class={chip(view.mixer.mixing === m.id)}
            onclick={() => controller.setPaintOptions({ mixer: { mixing: m.id } })}>{m.label}</button>
        {/each}
      </div>
      {#each MIXER_OPTION_CONTROLS as spec (spec.id)}
        <ControlSlider {spec} value={view.mixer[spec.id]} onchange={(v) => controller.setPaintOptions({ mixer: { [spec.id]: v } })} />
      {/each}
      <div class="flex flex-wrap gap-3 text-slate-300">
        <label class="flex items-center gap-1.5">
          <input
            type="checkbox"
            aria-label="Load the brush after each stroke"
            checked={view.mixer.loadEachStroke}
            onchange={(e) => controller.setPaintOptions({ mixer: { loadEachStroke: (e.target as HTMLInputElement).checked } })}
            class="accent-indigo-500"
          />
          Load each stroke
        </label>
        <label class="flex items-center gap-1.5">
          <input
            type="checkbox"
            aria-label="Clean the brush after each stroke"
            checked={view.mixer.cleanEachStroke}
            onchange={(e) => controller.setPaintOptions({ mixer: { cleanEachStroke: (e.target as HTMLInputElement).checked } })}
            class="accent-indigo-500"
          />
          Clean each stroke
        </label>
      </div>
    </div>
  {/if}

  {#if isRetouchPaintTool(view.tool)}
    <div class="flex flex-col gap-2 border-t border-slate-800 pt-2" role="group" aria-label="Retouch options" data-testid="retouch-options">
      {#if view.tool === 'clone' || view.tool === 'heal'}
        <div class="flex items-center gap-2">
          <span class="text-slate-400" data-testid="clone-source">{view.sourceLabel}</span>
          {#if view.cloneSource}
            <button type="button" title="Forget the source point" class={chip(false)} onclick={() => controller.setCloneSource(null)}>Clear source</button>
          {/if}
        </div>
      {/if}
      {#each RETOUCH_CHOICES.filter((c) => c.tools.includes(view.tool as never)) as choice (choice.id)}
        <div class="flex flex-wrap items-center gap-1" role="group" aria-label={choice.label}>
          <span class="text-slate-400">{choice.label}</span>
          {#each choice.options as o (o.id)}
            <button
              type="button"
              aria-pressed={view.retouch[choice.id] === o.id}
              title={o.title}
              class={chip(view.retouch[choice.id] === o.id)}
              onclick={() => setRetouchChoice(controller, choice.id, o.id)}>{o.label}</button>
          {/each}
        </div>
      {/each}
      {#each RETOUCH_OPTION_CONTROLS.filter((c) => c.tools.includes(view.tool as never)) as spec (spec.id)}
        <ControlSlider {spec} value={view.retouch[spec.id]} onchange={(v) => controller.setPaintOptions({ retouch: { [spec.id]: v } })} />
      {/each}
      <div class="flex flex-wrap gap-3 text-slate-300">
        {#each RETOUCH_TOGGLES.filter((t) => t.tools.includes(view.tool as never)) as t (t.id)}
          <label class="flex items-center gap-1.5">
            <input
              type="checkbox"
              aria-label={t.label}
              checked={view.retouch[t.id]}
              onchange={(e) => controller.setPaintOptions({ retouch: { [t.id]: (e.target as HTMLInputElement).checked } })}
              class="accent-indigo-500"
            />
            {t.label}
          </label>
        {/each}
      </div>
    </div>
  {/if}

  <div class="flex flex-wrap gap-3 text-slate-300" role="group" aria-label="Pressure">
    <label class="flex items-center gap-1.5">
      <input
        type="checkbox"
        aria-label="Pressure controls size"
        checked={view.brush.pressureSize}
        onchange={(e) => controller.setPaintOptions({ brush: { pressureSize: (e.target as HTMLInputElement).checked } })}
        class="accent-indigo-500"
      />
      Pressure size
    </label>
    <label class="flex items-center gap-1.5">
      <input
        type="checkbox"
        aria-label="Pressure controls opacity"
        checked={view.brush.pressureOpacity}
        onchange={(e) => controller.setPaintOptions({ brush: { pressureOpacity: (e.target as HTMLInputElement).checked } })}
        class="accent-indigo-500"
      />
      Pressure opacity
    </label>
  </div>

  <div class="flex gap-1">
    <button type="button" class={chip(false)} onclick={() => attempt(() => controller.fillPixels())}>Fill</button>
    <button type="button" class={chip(false)} onclick={() => attempt(() => controller.clearPixels())}>Clear</button>
  </div>
  {#if error}
    <p role="alert" class="text-rose-400">{error}</p>
  {/if}
</div>
