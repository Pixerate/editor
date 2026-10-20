<script lang="ts">
  import { WET_FLOW_KINDS, WET_GPU_OPTIONS, WET_PARAM_SLIDERS, WET_SPEED_SLIDER, WET_TILT_SLIDERS, readPath, wetEngineSummary, type PaintEditorController, type WetFlowKind, type WetGpuMode } from '@pixerate/editor/paint-editor';
  import PaintSlider from './PaintSlider.svelte';
  import { attempt, button, chip, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    class?: string;
  }
  let { controller, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const wet = $derived(editor.current.wet);
  const layerId = $derived(editor.current.document.activeLayerId);
  const info = $derived.by(() => {
    void editor.current;
    return layerId ? controller.wetLayerInfo(layerId) : null;
  });
  const backend = $derived.by(() => {
    void editor.current;
    return controller.wetState();
  });
  let error = $state<string | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
  const FLOW_LABELS: Record<WetFlowKind, string> = { none: 'None', linear: 'One way', swirl: 'Swirl', radial: 'Outwards', turbulent: 'Eddies' };
</script>

<!-- Wet media: status, Dry now, Pause, the water overlay, speed, Wet paper, tilt, the active layer's wet settings and flow map, the kernel in use, and Engine B (the WebGPU accelerator) with a switch to force the CPU. -->
<div class={`${panel} ${className}`} data-testid="wet-panel">
  <div class="flex items-center justify-between">
    <span class={wet.wet ? 'text-sky-300' : 'text-slate-400'} data-testid="wet-status">{wet.wet ? (wet.paused ? 'Wet (paused)' : 'Wet') : 'Dry'}</span>
    <span class="text-[10px] text-slate-500">step {wet.clock}</span>
  </div>
  <div class="flex flex-wrap gap-1">
    <button type="button" class={button} disabled={!wet.layerIds.length} onclick={() => run(async () => (await controller.wetIdle(), controller.dryPaint()))}>Dry now</button>
    <button type="button" class={chip(wet.paused)} aria-pressed={wet.paused} onclick={() => controller.setWetPaused(!wet.paused)}>{wet.paused ? 'Resume' : 'Pause'}</button>
    <button type="button" class={chip(wet.overlay)} aria-pressed={wet.overlay} onclick={() => controller.setWaterOverlay(!wet.overlay)}>Water</button>
    <button type="button" class={chip(wet.instantDry)} aria-pressed={wet.instantDry} title="Each wet stroke dries as soon as it ends" onclick={() => controller.setInstantDry(!wet.instantDry)}>Instant dry</button>
    <button type="button" class={button} disabled={!layerId} onclick={() => run(async () => (await controller.wetIdle(), controller.wetPaper({})))}>Wet paper</button>
  </div>
  <PaintSlider control={WET_SPEED_SLIDER} value={wet.speed} onchange={(v) => controller.setWetSpeed(v)} />
  {#each WET_TILT_SLIDERS as c (c.path)}
    <PaintSlider control={c} value={readPath(wet.tilt, c.path)} oncommit={(v) => run(async () => (await controller.wetIdle(), controller.setCanvasTilt({ [c.path]: v })))} />
  {/each}
  {#if info && layerId}
    <div class="flex flex-col gap-1.5" data-testid="wet-layer">
      <span class="font-medium text-slate-300">This layer</span>
      {#each WET_PARAM_SLIDERS as c (c.path)}
        <PaintSlider control={c} value={readPath(info.params, c.path)} oncommit={(v) => run(async () => (await controller.wetIdle(), controller.setWetParams(layerId, { [c.path]: v })))} />
      {/each}
      <label class="flex items-center justify-between gap-2">
        <span class="text-slate-400">Flow map</span>
        <select aria-label="Flow map" value={info.flow.kind} onchange={(e) => { const kind = e.currentTarget.value as WetFlowKind; run(async () => (await controller.wetIdle(), controller.setFlowMap(layerId, { kind }))); }} class="rounded bg-slate-800 px-1 py-0.5">
          {#each WET_FLOW_KINDS as k (k)}<option value={k}>{FLOW_LABELS[k]}</option>{/each}
        </select>
      </label>
      {#if info.flow.kind !== 'none'}
        <PaintSlider control={{ path: 'strength', label: 'Flow strength', min: 0, max: 1, step: 0.01 }} value={info.flow.strength} oncommit={(v) => run(async () => (await controller.wetIdle(), controller.setFlowMap(layerId, { strength: v })))} />
      {/if}
    </div>
  {/if}
  {#if backend.message}<p class="text-[10px] text-amber-300" data-testid="wet-message">{backend.message}</p>{/if}
  {#if backend.backend}
    <p class="text-[10px] text-slate-500">{backend.backend.kind === 'wasm-threads' ? `WebAssembly, ${backend.backend.threads} threads` : backend.backend.kind === 'wasm' ? 'WebAssembly, one thread' : 'JavaScript'}</p>
  {/if}
  <label class="flex items-center justify-between gap-2">
    <span class="text-slate-400">Engine</span>
    <select aria-label="Wet engine" value={wet.gpu} onchange={(e) => run(() => controller.setWetEngine({ gpu: (e.currentTarget as HTMLSelectElement).value as WetGpuMode }))} class="rounded bg-slate-800 px-1 py-0.5">
      {#each WET_GPU_OPTIONS as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
    </select>
  </label>
  <p class={`text-[10px] ${backend.engine.state === 'active' ? 'text-emerald-300' : 'text-slate-500'}`} data-testid="wet-engine">{wetEngineSummary(backend.engine)}</p>
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
