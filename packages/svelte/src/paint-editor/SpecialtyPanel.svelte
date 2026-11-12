<script lang="ts">
  import { UV_LIGHT_SLIDERS, VIEW_TILT_SLIDERS, brushSpecialtyGuides, readPath, requestDeviceTiltPermission, startDeviceTilt, warmCanvasHeat, type PaintEditorController } from '@pixerate/editor/paint-editor';
  import { untrack } from 'svelte';
  import PaintSlider from './PaintSlider.svelte';
  import FerroPanel from './FerroPanel.svelte';
  import SpecialtyGuideCard from './SpecialtyGuideCard.svelte';
  import { attempt, button, chip, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    class?: string;
  }
  let { controller, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const snap = $derived(editor.current);
  let error = $state<string | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
  /** Specialty presets offered as a quick pick while a standard brush is active. */
  const PICKS = ['ferrofluid', 'uv-marker', 'thermo-ink', 'soap-film', 'ghost-wash', 'mutation-wash', 'turing-wash'];
  const guides = $derived(brushSpecialtyGuides(snap));
  const picks = $derived(PICKS.flatMap((id) => snap.brushes.filter((b) => b.id === id)));
  const tilted = $derived(snap.viewTilt.x !== 0 || snap.viewTilt.y !== 0);
  let tiltFollow = $state(false);
  $effect(() => {
    const c = controller;
    const on = tiltFollow;
    return on ? untrack(() => startDeviceTilt(c)) : undefined;
  });
</script>

<!-- The canvas environment for specialty paint: the brush's guide (or a quick pick), the UV blacklight and heat, magnets, and the view tilt. -->
<div class={`${panel} ${className}`} data-testid="specialty-panel">
  {#if guides.length}
    <SpecialtyGuideCard {controller} />
  {:else}
    <div class="flex flex-col gap-1" data-testid="specialty-picks">
      <span class="text-slate-400">The active brush is a standard one. Pick a specialty brush:</span>
      <div class="flex flex-wrap gap-1">
        {#each picks as b (b.id)}
          <button type="button" class={button} onclick={() => run(() => controller.setBrush({ id: b.id }))}>{b.name}</button>
        {/each}
      </div>
    </div>
  {/if}
  <div class="flex flex-col gap-1.5" data-testid="uv-heat-panel">
    <span class="font-medium text-slate-300">UV blacklight &amp; heat</span>
    <p class="text-[11px] leading-snug text-slate-500">UV-fluorescent ink (UV marker) glows in its own colour under the blacklight; invisible UV ink shows only under it. Thermochromic ink (Thermochromic ink preset) shifts toward its hot colour where the canvas is warm.</p>
    <label class="flex items-center gap-2">
      <input type="checkbox" checked={snap.uvLight.on} onchange={(e) => run(() => controller.setUvLight({ on: e.currentTarget.checked }))} /> UV blacklight
    </label>
    {#each UV_LIGHT_SLIDERS as c (c.path)}
      <PaintSlider control={c} value={readPath(snap.uvLight, c.path)} onchange={(v) => run(() => controller.setUvLight({ [c.path]: v }))} />
    {/each}
    <span class="text-[11px] text-slate-400" role="status">{snap.heat.hotCells > 0 ? `Canvas heat: ${Math.round(snap.heat.max * 100)}% at its warmest` : 'Canvas is cool'}</span>
    <div class="flex flex-wrap items-center gap-1">
      <button type="button" class={button} onclick={() => run(() => controller.paintHeat(warmCanvasHeat(snap.document.canvas)))}>Warm canvas</button>
      <button type="button" class={button} disabled={snap.heat.hotCells === 0} onclick={() => run(() => controller.advanceHeat(10))}>Step heat</button>
      <button type="button" class={button} disabled={snap.heat.hotCells === 0} onclick={() => run(() => controller.clearHeat())}>Cool canvas</button>
    </div>
  </div>
  <div class="flex flex-col gap-1.5">
    <p class="text-[11px] leading-snug text-slate-500">Ferrofluid and Ferro ink pool into liquid magnetic paint that magnets pull into 3D Rosensweig spikes.</p>
    <FerroPanel {controller} />
  </div>
  <div class="flex flex-col gap-1.5" data-testid="view-tilt-panel">
    <span class="font-medium text-slate-300">Thin-film iridescence &amp; view tilt</span>
    <p class="text-[11px] leading-snug text-slate-500">Scarab lacquer, Soap film and Pearl glaze shift colour with the viewing angle.</p>
    {#each VIEW_TILT_SLIDERS as c (c.path)}
      <PaintSlider control={c} value={readPath(snap.viewTilt, c.path)} onchange={(v) => run(() => controller.setViewTilt({ [c.path]: v }))} />
    {/each}
    <div class="flex flex-wrap items-center gap-1">
      <button type="button" class={button} disabled={!tilted} onclick={() => run(() => controller.setViewTilt({ x: 0, y: 0 }))}>Reset tilt</button>
      <button
        type="button"
        aria-pressed={tiltFollow}
        class={chip(tiltFollow)}
        onclick={() =>
          run(async () => {
            if (!tiltFollow && !(await requestDeviceTiltPermission())) return;
            tiltFollow = !tiltFollow;
          })}
      >Device tilt</button>
    </div>
  </div>
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
