<script lang="ts">
  import { LIGHT_SLIDERS, PAPER_FAMILIES, PAPER_LIBRARY, PAPER_SLIDERS, patchPath, readPath, renderPaper, type PaintEditorController } from '@pixerate/editor/paint-editor';
  import PaintSlider from './PaintSlider.svelte';
  import PixelCanvas from './PixelCanvas.svelte';
  import { attempt, button, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    class?: string;
  }
  let { controller, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const paper = $derived(editor.current.document.paper);
  let error = $state<string | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
  const SWATCH = { x: 0, y: 0, width: 64, height: 40 };
  const lighting = $derived.by(() => {
    void editor.current;
    return controller.getLighting();
  });
  const previews = new Map(PAPER_LIBRARY.map((p) => [p.preset, { ...SWATCH, data: renderPaper({ ...p, shading: Math.max(0.8, p.shading) }, SWATCH) }]));
</script>

<!-- The paper library by family and the current paper's settings (each change one undo step). -->
<div class={`${panel} ${className}`} data-testid="paper-panel">
  {#each PAPER_FAMILIES as family (family)}
    <div>
      <div class="mb-0.5 text-[10px] uppercase tracking-wide text-slate-500">{family}</div>
      <div class="flex flex-wrap gap-1" role="listbox" aria-label={`${family} papers`}>
        {#each PAPER_LIBRARY.filter((p) => p.family === family) as p (p.preset)}
          <button
            type="button"
            role="option"
            aria-selected={paper.preset === p.preset}
            title={p.name}
            class={`rounded p-0.5 ${paper.preset === p.preset ? 'ring-2 ring-indigo-500' : 'ring-1 ring-slate-700 hover:ring-slate-500'}`}
            onclick={() => run(() => controller.setPaper({ preset: p.preset }))}
          >
            <PixelCanvas pixels={previews.get(p.preset) ?? null} label={p.name} style="width: 48px; height: 30px" />
          </button>
        {/each}
      </div>
    </div>
  {/each}
  <div class="text-slate-300">{paper.name}</div>
  <label class="flex items-center justify-between">
    <span class="text-slate-400">Colour</span>
    <input type="color" aria-label="Paper colour" value={paper.color} onchange={(e) => run(() => controller.setPaper({ color: e.currentTarget.value }))} class="h-6 w-10 rounded bg-transparent" />
  </label>
  {#each PAPER_SLIDERS as c (c.path)}
    <PaintSlider control={c} value={readPath(paper, c.path)} oncommit={(v) => run(() => controller.setPaper(patchPath(paper as never, c.path, v) as never))} />
  {/each}
  <label class="flex items-center gap-2">
    <input type="checkbox" checked={paper.tiling === 'mirror'} onchange={(e) => run(() => controller.setPaper({ tiling: e.currentTarget.checked ? 'mirror' : 'repeat' }))} /> Mirror tiling
  </label>
  <button type="button" class={`self-start ${button}`} onclick={() => run(() => controller.setPaper({ seed: paper.seed + 1 }))}>New sheet</button>
  <div class="flex flex-col gap-1.5" data-testid="light-panel">
    <span class="font-medium text-slate-300">Light (thick paint, metallic paper)</span>
    {#each LIGHT_SLIDERS as c (c.path)}
      <PaintSlider control={c} value={readPath(lighting, c.path)} onchange={(v) => run(() => controller.setLighting({ [c.path]: v }))} />
    {/each}
    <button type="button" class={`self-start ${button}`} onclick={() => run(() => controller.flattenRelief())}>Flatten relief</button>
  </div>
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
