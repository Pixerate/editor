<script lang="ts">
  import type { ImageEditorController } from '@pixerate/editor/image-editor';
  import { BRUSH_OPTION_CONTROLS, PAINT_TOOLS } from '@pixerate/editor/image-editor';
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
    return { tool: s.activeTool, ...s.paint };
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
  <div class="flex gap-1" role="toolbar" aria-label="Paint tools">
    {#each PAINT_TOOLS as t (t.id)}
      <button
        type="button"
        aria-pressed={view.tool === t.id}
        title={`${t.label} (${t.shortcut})`}
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
