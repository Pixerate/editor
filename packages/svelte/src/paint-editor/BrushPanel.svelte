<script lang="ts">
  import {
    BLEND_MENU_GROUPS,
    BRUSH_ROTATIONS,
    BRUSH_SLIDERS,
    brushEngineControls,
    brushLoadColor,
    downloadBytes,
    multiColorSliders,
    patchBrushValue,
    patchPath,
    readPath,
    type BlendMode,
    type BrushRotation,
    type MultiColorMode,
    type PaintEditorController,
  } from '@pixerate/editor/paint-editor';
  import { untrack } from 'svelte';
  import PaintSlider from './PaintSlider.svelte';
  import PixelCanvas from './PixelCanvas.svelte';
  import { attempt, button, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    thumbnailWidth?: number;
    thumbnailHeight?: number;
    class?: string;
  }
  let { controller, thumbnailWidth = 112, thumbnailHeight = 32, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const snap = $derived(editor.current);
  const brush = $derived(snap.brush);
  let error = $state<string | null>(null);
  let saveName = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
  // Thumbnails follow the library and the paper.
  // Separate deriveds keep their identity across unrelated changes, so thumbnails are not redrawn.
  const library = $derived(snap.brushes);
  const paper = $derived(snap.document.paper);
  const thumbs = $derived.by(() => {
    const list = library;
    void paper;
    return untrack(() => new Map(list.map((b) => [b.id, controller.brushThumbnail(b.id, { width: thumbnailWidth, height: thumbnailHeight, color: '#26324a' })])));
  });
  const engine = $derived(brushEngineControls(brush));
  const mc = $derived(brush.behavior.multicolor);
  const carried = $derived(brushLoadColor(snap.mixerLoad));
  const mixingValue = $derived(engine?.mixingPath === 'blender.mixing' ? brush.blender.mixing : engine?.mixingPath === 'smudge.mixing' ? brush.smudge.mixing : brush.behavior.mixing);
  const setColors = (colors: string[]) => controller.setBrush({ behavior: { multicolor: { colors } } });
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'brush';
</script>

<!-- The brush library with thumbnails, the active brush's settings and blend, its engine's controls (blender, smudge, pick-up / mix, mixing, dirty, multi-colour, load), save, import and export. -->
<div class={`${panel} ${className}`} data-testid="brush-panel">
  <div class="grid grid-cols-2 gap-1" role="listbox" aria-label="Brushes">
    {#each snap.brushes as b (b.id)}
      <button
        type="button"
        role="option"
        aria-selected={brush.id === b.id}
        title={`${b.name} (${b.category})`}
        class={`flex flex-col items-start gap-0.5 rounded p-1 text-left ${brush.id === b.id ? 'bg-indigo-600/30 ring-1 ring-indigo-500' : 'bg-slate-900 hover:bg-slate-800'}`}
        onclick={() => controller.setBrush({ id: b.id })}
      >
        <PixelCanvas pixels={thumbs.get(b.id) ?? null} label={`${b.name} thumbnail`} class="rounded" style={`width: 100%; aspect-ratio: ${thumbnailWidth} / ${thumbnailHeight}`} />
        <span class="truncate text-[10px] text-slate-300">{b.name}</span>
      </button>
    {/each}
  </div>
  <div class="flex flex-col gap-1.5">
    {#each BRUSH_SLIDERS as c (c.path)}
      <PaintSlider control={c} value={readPath(brush, c.path)} onchange={(v) => controller.setBrush(patchPath(brush as never, c.path, v) as never)} />
    {/each}
    <label class="flex items-center justify-between gap-2">
      <span class="text-slate-400">Rotation</span>
      <select aria-label="Brush rotation" value={brush.rotation} onchange={(e) => controller.setBrush({ rotation: e.currentTarget.value as BrushRotation })} class="rounded bg-slate-800 px-1 py-0.5">
        {#each BRUSH_ROTATIONS as r (r)}
          <option value={r}>{r === 'stroke' ? 'Follow stroke' : r === 'barrel' ? 'Pen barrel' : 'Fixed'}</option>
        {/each}
      </select>
    </label>
    <label class="flex items-center gap-2">
      <input type="checkbox" checked={brush.tip.pressureSize} onchange={(e) => controller.setBrush({ tip: { pressureSize: e.currentTarget.checked } })} /> Pressure → size
    </label>
    <label class="flex items-center gap-2">
      <input type="checkbox" checked={brush.tip.pressureOpacity} onchange={(e) => controller.setBrush({ tip: { pressureOpacity: e.currentTarget.checked } })} /> Pressure → opacity
    </label>
    {#if brush.engine === 'dab'}
      <label class="flex items-center justify-between gap-2">
        <span class="text-slate-400">Blend</span>
        <select aria-label="Brush blend" value={brush.tip.blend} onchange={(e) => controller.setBrush({ tip: { blend: e.currentTarget.value as BlendMode } })} class="rounded bg-slate-800 px-1 py-0.5">
          {#each BLEND_MENU_GROUPS as g (g.label)}
            <optgroup label={g.label}>
              {#each g.modes as m (m.id)}
                <option value={m.id} title={m.description}>{m.label}</option>
              {/each}
            </optgroup>
          {/each}
        </select>
      </label>
    {/if}
  </div>
  {#if engine}
    <div class="flex flex-col gap-1.5" data-testid="brush-engine">
      <span class="font-medium text-slate-300">{engine.title}</span>
      {#each engine.sliders as c (c.path)}
        <PaintSlider control={c} value={readPath(brush, c.path)} onchange={(v) => controller.setBrush(patchPath(brush as never, c.path, v) as never)} />
      {/each}
      {#if engine.mixingPath}
        <label class="flex items-center justify-between gap-2">
          <span class="text-slate-400">Mixing</span>
          <select aria-label="Brush mixing" value={mixingValue} onchange={(e) => controller.setBrush(patchBrushValue(brush, engine.mixingPath!, e.currentTarget.value))} class="rounded bg-slate-800 px-1 py-0.5">
            <option value="pigment">Pigment</option>
            <option value="rgb">RGB</option>
          </select>
        </label>
      {/if}
      {#if engine.dirty}
        <label class="flex items-center gap-2" title="Keep the colour the brush picked up for the next stroke (needs Pick-up above 0)">
          <input type="checkbox" aria-label="Dirty brush" checked={brush.behavior.dirty} onchange={(e) => controller.setBrush({ behavior: { dirty: e.currentTarget.checked } })} /> Dirty brush
        </label>
      {/if}
      {#if engine.multicolor}
        <div class="flex flex-col gap-1.5" data-testid="multicolor">
          <label class="flex items-center justify-between gap-2">
            <span class="text-slate-400">Multi-colour</span>
            <select aria-label="Multi-colour" value={mc.mode} onchange={(e) => controller.setBrush({ behavior: { multicolor: { mode: e.currentTarget.value as MultiColorMode } } })} class="rounded bg-slate-800 px-1 py-0.5">
              <option value="off">Off</option>
              <option value="tip">Across the tip</option>
              <option value="dab">Per dab</option>
            </select>
          </label>
          {#if mc.mode !== 'off'}
            <div class="flex flex-wrap items-center gap-1" aria-label="Multi-colour colours">
              {#each mc.colors as col, i (i)}
                <span class="flex items-center">
                  <input type="color" aria-label={`Multi-colour ${i + 1}`} value={col} onchange={(e) => setColors(mc.colors.map((x, j) => (j === i ? e.currentTarget.value : x)))} class="h-5 w-6 rounded bg-transparent" />
                  <button type="button" aria-label={`Remove multi-colour ${i + 1}`} class="px-0.5 text-slate-500 hover:text-white" onclick={() => setColors(mc.colors.filter((_, j) => j !== i))}>×</button>
                </span>
              {/each}
              {#if mc.colors.length < 8}
                <button type="button" class={button} aria-label="Add multi-colour" onclick={() => setColors([...(mc.colors.length ? mc.colors : [snap.color, snap.secondaryColor]), snap.color].slice(0, 8))}>+</button>
              {/if}
              {#if mc.colors.length < 2}<span class="text-[10px] text-slate-500">Uses the paint and second colours</span>{/if}
            </div>
            {#if mc.mode === 'dab'}
              <label class="flex items-center justify-between gap-2">
                <span class="text-slate-400">Order</span>
                <select aria-label="Colour order" value={mc.order} onchange={(e) => controller.setBrush({ behavior: { multicolor: { order: e.currentTarget.value as 'sequence' | 'random' } } })} class="rounded bg-slate-800 px-1 py-0.5">
                  <option value="sequence">In order</option>
                  <option value="random">Random</option>
                </select>
              </label>
            {/if}
            {#each multiColorSliders(mc.mode) as c (c.path)}
              <PaintSlider control={c} value={readPath(brush, c.path)} onchange={(v) => controller.setBrush(patchPath(brush as never, c.path, v) as never)} />
            {/each}
          {/if}
        </div>
      {/if}
      {#if engine.load}
        <div class="flex items-center gap-1">
          <span class="text-slate-400">Carries</span>
          <span aria-label="Brush load" title={carried ?? 'Clean'} class="h-4 w-4 rounded ring-1 ring-slate-700" style={`background: ${carried ?? 'transparent'}`}></span>
          {#if brush.engine === 'mixer'}
            <button type="button" class={button} onclick={() => controller.loadMixerBrush()}>Load</button>
          {/if}
          <button type="button" class={button} onclick={() => controller.cleanMixerBrush(brush.engine === 'mixer')}>Clean</button>
        </div>
      {/if}
    </div>
  {/if}
  <div class="flex flex-wrap items-center gap-1">
    <input bind:value={saveName} placeholder="Brush name" aria-label="Brush name" class="w-28 rounded bg-slate-800 px-1.5 py-0.5" />
    <button
      type="button"
      class={button}
      disabled={!saveName.trim()}
      onclick={() =>
        run(() => {
          controller.saveBrush({ id: slug(saveName), name: saveName.trim() });
          saveName = '';
        })}>Save brush</button
    >
    <button type="button" class={button} onclick={() => run(() => downloadBytes(JSON.stringify(controller.exportBrushes(), null, 2), 'brushes.json', 'application/json'))}>Export</button>
    <button type="button" class={button} onclick={() => fileInput?.click()}>Import…</button>
    <input
      bind:this={fileInput}
      type="file"
      accept=".json,application/json"
      aria-label="Import brushes"
      class="hidden"
      onchange={(e) => {
        const input = e.currentTarget;
        const f = input.files?.[0];
        input.value = '';
        if (f) run(async () => controller.importBrushes(JSON.parse(await f.text())));
      }}
    />
  </div>
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
