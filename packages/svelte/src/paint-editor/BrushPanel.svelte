<script lang="ts">
  import { BRUSH_ROTATIONS, BRUSH_SLIDERS, downloadBytes, patchPath, readPath, type BrushRotation, type PaintEditorController } from '@pixerate/editor/paint-editor';
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
  const thumbs = $derived.by(() => {
    const list = snap.brushes;
    void snap.document.paper;
    return untrack(() => new Map(list.map((b) => [b.id, controller.brushThumbnail(b.id, { width: thumbnailWidth, height: thumbnailHeight, color: '#26324a' })])));
  });
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'brush';
</script>

<!-- The brush library with thumbnails, the active brush's settings, save, import and export. -->
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
  </div>
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
