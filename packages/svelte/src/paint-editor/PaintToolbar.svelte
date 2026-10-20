<script lang="ts">
  import { PAINT_TOOLS, SYMMETRY_MODES, decodeImageBlob, downloadBytes, timeLapseZip, type PaintEditorController, type PaintTool, type SymmetryMode } from '@pixerate/editor/paint-editor';
  import { attempt, button, chip, paintEditorState } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    tool: PaintTool;
    ontoolchange: (tool: PaintTool) => void;
    /** Base name of saved and exported files (default `painting`). */
    fileName?: string;
    class?: string;
  }
  let { controller, tool, ontoolchange, fileName = 'painting', class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const snap = $derived(editor.current);
  const symmetry = $derived(snap.guides.symmetry);
  const perspective = $derived(snap.guides.perspective);
  const tracing = $derived(snap.guides.tracing);
  const canvas = $derived(snap.document.canvas);
  let error = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let note = $state<string | null>(null);
  let openInput = $state<HTMLInputElement | null>(null);
  let tracingInput = $state<HTMLInputElement | null>(null);
  let refInput = $state<HTMLInputElement | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
  const timeLapse = () =>
    run(async () => {
      busy = 'Repainting…';
      try {
        const tl = await controller.timeLapse({ onProgress: (p) => (busy = `Repainting… ${Math.round(p * 100)}%`) });
        downloadBytes(await timeLapseZip(tl), `${fileName}-timelapse.zip`, 'application/zip');
        note = `Time-lapse: ${tl.frames.length} frames, ${(tl.durationMs / 1000).toFixed(1)} s (run render.sh in the zip for the MP4).`;
      } finally {
        busy = null;
      }
    });
  const highRes = () =>
    run(async () => {
      busy = 'Repainting at 2×…';
      try {
        downloadBytes(await controller.exportHighResPng({ scale: 2 }), `${fileName}@2x.png`, 'image/png');
      } finally {
        busy = null;
      }
    });
  const exportImage = (format: 'image/png' | 'image/jpeg') =>
    run(async () => downloadBytes(await controller.exportImage({ format }), `${fileName}.${format === 'image/png' ? 'png' : 'jpg'}`, format));
  const vanishing = (n: number) => {
    const y = canvas.height * 0.4;
    return n === 1 ? [{ x: canvas.width / 2, y }] : n === 2 ? [{ x: -canvas.width * 0.5, y }, { x: canvas.width * 1.5, y }] : [{ x: -canvas.width * 0.5, y }, { x: canvas.width * 1.5, y }, { x: canvas.width / 2, y: canvas.height * 3 }];
  };
  const fileOf = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    return f;
  };
</script>

<!-- Tools, undo / redo, view rotation and mirroring, guides, tracing and reference images, hand, files. -->
<div class={`flex flex-wrap items-center gap-1.5 text-xs text-slate-200 ${className}`} role="toolbar" aria-label="Paint toolbar" data-testid="paint-toolbar">
  {#each PAINT_TOOLS as t (t.id)}
    <button type="button" aria-pressed={tool === t.id} title={`${t.label} (${t.key.toUpperCase()})`} class={chip(tool === t.id)} onclick={() => ontoolchange(t.id)}>{t.label}</button>
  {/each}
  <span class="mx-1 h-4 w-px bg-slate-700"></span>
  <button type="button" class={button} disabled={!snap.canUndo} title={snap.undoLabel ? `Undo ${snap.undoLabel}` : 'Undo'} onclick={() => controller.undo()}>Undo</button>
  <button type="button" class={button} disabled={!snap.canRedo} title={snap.redoLabel ? `Redo ${snap.redoLabel}` : 'Redo'} onclick={() => controller.redo()}>Redo</button>
  <span class="mx-1 h-4 w-px bg-slate-700"></span>
  <button type="button" class={button} aria-label="Rotate view left" onclick={() => controller.setView({ rotation: snap.view.rotation - 15 })}>⟲</button>
  <button type="button" class={button} aria-label="Rotate view right" onclick={() => controller.setView({ rotation: snap.view.rotation + 15 })}>⟳</button>
  <button type="button" class={chip(snap.view.mirror)} aria-pressed={snap.view.mirror} onclick={() => controller.setView({ mirror: !snap.view.mirror })}>Mirror view</button>
  <button type="button" class={button} onclick={() => controller.resetView()}>Reset view</button>
  <span class="mx-1 h-4 w-px bg-slate-700"></span>
  <label class="flex items-center gap-1">
    Symmetry
    <select
      aria-label="Symmetry"
      value={symmetry.mode}
      onchange={(e) => controller.setSymmetry({ mode: e.currentTarget.value as SymmetryMode, center: symmetry.mode === 'off' ? { x: canvas.width / 2, y: canvas.height / 2 } : symmetry.center })}
      class="rounded bg-slate-800 px-1 py-0.5"
    >
      {#each SYMMETRY_MODES as m (m)}
        <option value={m}>{m}</option>
      {/each}
    </select>
  </label>
  {#if symmetry.mode === 'kaleidoscope'}
    <input type="number" aria-label="Kaleidoscope segments" min="2" max="32" value={symmetry.segments} oninput={(e) => controller.setSymmetry({ segments: Number(e.currentTarget.value) })} class="w-12 rounded bg-slate-800 px-1 py-0.5" />
  {/if}
  <button
    type="button"
    class={chip(perspective.enabled)}
    aria-pressed={perspective.enabled}
    onclick={() => run(() => controller.setPerspective(perspective.enabled ? { enabled: false } : { enabled: true, points: perspective.points.length ? perspective.points : vanishing(1) }))}
  >Perspective</button>
  {#if perspective.enabled}
    <select aria-label="Vanishing points" value={perspective.points.length} onchange={(e) => run(() => controller.setPerspective({ points: vanishing(Number(e.currentTarget.value)) }))} class="rounded bg-slate-800 px-1 py-0.5">
      <option value={1}>1-point</option>
      <option value={2}>2-point</option>
      <option value={3}>3-point</option>
    </select>
  {/if}
  <span class="mx-1 h-4 w-px bg-slate-700"></span>
  <button type="button" class={button} onclick={() => tracingInput?.click()}>Tracing image…</button>
  {#if tracing}
    <input type="range" aria-label="Tracing opacity" min="0" max="1" step="0.05" value={tracing.opacity} oninput={(e) => controller.updateTracing({ opacity: Number(e.currentTarget.value) })} class="w-16 accent-indigo-500" />
    <button type="button" class={chip(tracing.sampleColors)} aria-pressed={tracing.sampleColors} onclick={() => controller.updateTracing({ sampleColors: !tracing.sampleColors })}>Trace colours</button>
    <button type="button" class={chip(tracing.visible)} aria-pressed={tracing.visible} onclick={() => controller.updateTracing({ visible: !tracing.visible })}>Show tracing</button>
    <button type="button" class={button} onclick={() => controller.clearTracingImage()}>Remove tracing</button>
  {/if}
  <button type="button" class={button} onclick={() => refInput?.click()}>Reference…</button>
  <button type="button" class={button} title="Which hand holds the pen (palm rejection)" onclick={() => controller.setHand(snap.hand === 'right' ? 'left' : 'right')}>{snap.hand === 'right' ? 'Right-handed' : 'Left-handed'}</button>
  <span class="mx-1 h-4 w-px bg-slate-700"></span>
  <button type="button" class={button} onclick={() => run(() => downloadBytes(JSON.stringify(controller.toJSON()), `${fileName}.paint.json`, 'application/json'))}>Save</button>
  <button type="button" class={button} onclick={() => openInput?.click()}>Open…</button>
  <button type="button" class={button} onclick={() => exportImage('image/png')}>PNG</button>
  <button type="button" class={button} onclick={() => exportImage('image/jpeg')}>JPEG</button>
  <button type="button" class={button} onclick={() => run(() => downloadBytes(controller.exportPsd().bytes, `${fileName}.psd`, 'image/vnd.adobe.photoshop'))}>PSD</button>
  <button type="button" class={button} disabled={busy !== null} title="Repaint the painting from its strokes as a time-lapse: frames, a video project and the ffmpeg command, zipped" onclick={timeLapse}>Time-lapse</button>
  <button type="button" class={button} disabled={busy !== null} title="Repaint the painting from its strokes at twice the size (more detail, not upscaled)" onclick={highRes}>PNG 2×</button>
  {#if busy ?? note}<span class="text-[11px] text-slate-400" data-testid="paint-replay-status">{busy ?? note}</span>{/if}
  <input
    bind:this={openInput}
    type="file"
    accept=".json,application/json"
    aria-label="Open painting"
    class="hidden"
    onchange={(e) => {
      const f = fileOf(e);
      if (f) run(async () => controller.loadJSON(JSON.parse(await f.text())));
    }}
  />
  <input
    bind:this={tracingInput}
    type="file"
    accept="image/*"
    aria-label="Load tracing image"
    class="hidden"
    onchange={(e) => {
      const f = fileOf(e);
      if (f) run(async () => controller.setTracingImage({ pixels: await decodeImageBlob(f) }));
    }}
  />
  <input
    bind:this={refInput}
    type="file"
    accept="image/*"
    aria-label="Add reference image"
    class="hidden"
    onchange={(e) => {
      const f = fileOf(e);
      if (f) run(async () => controller.addReferenceImage({ pixels: await decodeImageBlob(f), name: f.name }));
    }}
  />
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
