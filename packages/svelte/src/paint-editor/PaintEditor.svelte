<script lang="ts">
  import type { PaintEditorController, PaintPresence, PaintTool } from '@pixerate/editor/paint-editor';
  import BrushPanel from './BrushPanel.svelte';
  import ColorPanel from './ColorPanel.svelte';
  import PaintCanvas from './PaintCanvas.svelte';
  import PaintLayersPanel from './PaintLayersPanel.svelte';
  import PaintToolbar from './PaintToolbar.svelte';
  import PaperPanel from './PaperPanel.svelte';
  import WetPanel from './WetPanel.svelte';
  import StickerPanel from './StickerPanel.svelte';
  import PaintEffectsPanel from './PaintEffectsPanel.svelte';
  import { chip, paintEffectsProvider } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    /** Base name of saved and exported files (default `painting`). */
    fileName?: string;
    /** Height of the editor (default 720 px). */
    height?: number | string;
    /** Agent cursors to draw over the canvas (see `createPaintDirector`). */
    presence?: PaintPresence;
    class?: string;
  }
  let { controller, fileName, height = 720, presence, class: className = '' }: Props = $props();
  let tool = $state<PaintTool>('brush');
  let tab = $state<'color' | 'wet' | 'paper' | 'layers' | 'effects'>('color');
  const effects = paintEffectsProvider(() => controller);
  const tabs = $derived(effects.current ? (['color', 'wet', 'paper', 'layers', 'effects'] as const) : (['color', 'wet', 'paper', 'layers'] as const));
  let error = $state<string | null>(null);
</script>

<!-- Toolbar, brush library, the canvas, and colour / wet media / paper / layers. -->
<div class={`flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900 p-2 ${className}`} style={`height: ${typeof height === 'number' ? `${height}px` : height}`} data-testid="paint-editor">
  <PaintToolbar {controller} {tool} ontoolchange={(t) => (tool = t)} {fileName} />
  <div class="flex min-h-0 flex-1 gap-2">
    <BrushPanel {controller} class="w-60 shrink-0 overflow-y-auto pr-1" />
    <div class="flex min-w-0 flex-1 flex-col">
      <PaintCanvas {controller} {tool} {presence} onerror={(e) => (error = e)} class="flex-1 rounded-lg" />
      {#if error}<p role="alert" class="mt-1 text-[11px] text-rose-400">{error}</p>{/if}
    </div>
    <div class="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto pr-1">
      <div class="flex gap-1" role="tablist" aria-label="Paint panels">
        {#each tabs as t (t)}
          <button type="button" role="tab" aria-selected={tab === t} class={chip(tab === t)} onclick={() => (tab = t)}>{t === 'color' ? 'Colour' : t === 'wet' ? 'Wet' : t === 'paper' ? 'Paper' : t === 'layers' ? 'Layers' : 'Effects'}</button>
        {/each}
      </div>
      {#if tab === 'color'}<ColorPanel {controller} />{/if}
      {#if tab === 'wet'}<WetPanel {controller} />{/if}
      {#if tab === 'paper'}<PaperPanel {controller} />{/if}
      {#if tab === 'layers'}<PaintLayersPanel {controller} /><StickerPanel {controller} />{/if}
      {#if tab === 'effects' && effects.current}<PaintEffectsPanel {controller} />{/if}
    </div>
  </div>
</div>
