<script lang="ts">
  import { PaintPresence, documentToScreen, screenToDocument, type PaintEditorController, type PaintTool } from '@pixerate/editor/paint-editor';
  import type { AgentPlayback, PlaybackPoint, PlaybackRect, PlaybackRef } from '@pixerate/editor/tools';
  import { createPlaybackSurface, getAgentPlayback } from '../playback/playback.svelte.js';
  import PresenceLayer from '../playback/PresenceLayer.svelte';
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
    /**
     * Agent playback: act out the paint tools' calls here with the agent's cursor, opening the
     * panel each write belongs to (default: `setAgentPlayback` above; `null` turns it off). With
     * `presence` (a `PaintDirector`'s), the director's strokes share the cursor.
     */
    playback?: AgentPlayback | null;
    /** The playback surface id (default `paint`, where the paint tool providers play). */
    playbackId?: string;
    /** Bring the editor on screen (switch to its tab) before the agent acts. */
    onplaybackreveal?: () => void | Promise<void>;
  }
  let { controller, fileName, height = 720, presence, class: className = '', playback, playbackId = 'paint', onplaybackreveal }: Props = $props();

  /** Controls a paint plan can point at, by `{ kind: 'control', id }`. */
  const PAINT_CONTROLS: Record<string, string> = {
    'mixing-pad': '[data-testid="mixing-pad"]',
    lighting: '[data-testid="light-panel"]',
    symmetry: '[aria-label="Symmetry"]'
  };
  // Agent playback in document pixels, sharing a director's presence store (one cursor). Panels
  // outside the canvas are mapped into document pixels through the canvas view.
  let root: HTMLDivElement | undefined = $state();
  const ambientPlayback = getAgentPlayback();
  const playing = $derived((playback === undefined ? ambientPlayback : playback) ?? null);
  const viewBox = () => {
    const r = root?.querySelector<HTMLElement>('[data-testid="paint-canvas"]')?.getBoundingClientRect();
    return r && r.width > 0 ? r : null;
  };
  const docToClient = (p: PlaybackPoint): PlaybackPoint | null => {
    const r = viewBox();
    if (!r) return null;
    const q = documentToScreen(controller.getState().view, controller.document.canvas, { width: r.width, height: r.height }, p.x, p.y);
    return { x: r.left + q.x, y: r.top + q.y };
  };
  const clientToDoc = (p: PlaybackPoint): PlaybackPoint | null => {
    const r = viewBox();
    return r ? screenToDocument(controller.getState().view, controller.document.canvas, { width: r.width, height: r.height }, p.x - r.left, p.y - r.top) : null;
  };
  const elementRect = (selector: string): PlaybackRect | null => {
    const r = root?.querySelector(selector)?.getBoundingClientRect();
    if (!r || r.width <= 0) return null;
    // The element's centre and size (the view may rotate; the cursor only needs the centre).
    const c = clientToDoc({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const zoom = controller.getState().view.zoom || 1;
    return c ? { x: c.x - r.width / zoom / 2, y: c.y - r.height / zoom / 2, width: r.width / zoom, height: r.height / zoom } : null;
  };
  // svelte-ignore state_referenced_locally
  const sharedPresence = presence ?? new PaintPresence();
  const agentPresence = createPlaybackSurface(() => playing, () => playbackId, () => ({
    locate: (ref: PlaybackRef) => {
      if (ref.kind === 'panel') return elementRect(`[data-paint-tab="${CSS.escape(ref.id)}"]`);
      if (ref.kind === 'panel-body') return elementRect(`[data-paint-panel="${CSS.escape(ref.id)}"]`);
      if (ref.kind === 'control' && PAINT_CONTROLS[ref.id]) return elementRect(PAINT_CONTROLS[ref.id]!);
      return null;
    },
    open: async (ref: PlaybackRef) => {
      if (ref.kind !== 'panel' || tab === ref.id) return;
      root?.querySelector<HTMLElement>(`[data-paint-tab="${CSS.escape(ref.id)}"]`)?.click();
      await new Promise((resolve) => setTimeout(resolve, 60));
    },
    bounds: () => ({ x: 0, y: 0, width: controller.document.canvas.width, height: controller.document.canvas.height }),
    visible: () => {
      const r = root?.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0 && !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
    },
    toViewport: (p: PlaybackPoint) => docToClient(p) ?? p,
    fromViewport: (p: PlaybackPoint) => clientToDoc(p) ?? p,
    reveal: () => onplaybackreveal?.()
  }), sharedPresence);
  /** Document pixels → pixels in the editor's root, for the cursor layer. */
  const docToRoot = (p: PlaybackPoint): PlaybackPoint => {
    const c = docToClient(p);
    const box = root?.getBoundingClientRect();
    return c && box ? { x: c.x - box.left, y: c.y - box.top } : p;
  };
  let tool = $state<PaintTool>('brush');
  let tab = $state<'color' | 'wet' | 'paper' | 'layers' | 'effects'>('color');
  const effects = paintEffectsProvider(() => controller);
  const tabs = $derived(effects.current ? (['color', 'wet', 'paper', 'layers', 'effects'] as const) : (['color', 'wet', 'paper', 'layers'] as const));
  let error = $state<string | null>(null);
</script>

<!-- Toolbar, brush library, the canvas, and colour / wet media / paper / layers. -->
<div bind:this={root} class={`relative flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-900 p-2 ${className}`} style={`height: ${typeof height === 'number' ? `${height}px` : height}`} data-testid="paint-editor">
  {#if playing}
    <PresenceLayer presence={agentPresence} viewport={docToRoot} />
  {/if}
  <PaintToolbar {controller} {tool} ontoolchange={(t) => (tool = t)} {fileName} />
  <div class="flex min-h-0 flex-1 gap-2">
    <BrushPanel {controller} class="w-60 shrink-0 overflow-y-auto pr-1" />
    <div class="flex min-w-0 flex-1 flex-col">
      <!-- With playback the editor draws the cursor (over the panels too), so the canvas doesn't. -->
      <PaintCanvas {controller} {tool} presence={playing ? undefined : presence} onerror={(e) => (error = e)} class="flex-1 rounded-lg" />
      {#if error}<p role="alert" class="mt-1 text-[11px] text-rose-400">{error}</p>{/if}
    </div>
    <div class="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto pr-1">
      <div class="flex gap-1" role="tablist" aria-label="Paint panels">
        {#each tabs as t (t)}
          <button type="button" role="tab" aria-selected={tab === t} data-paint-tab={t} class={chip(tab === t)} onclick={() => (tab = t)}>{t === 'color' ? 'Colour' : t === 'wet' ? 'Wet' : t === 'paper' ? 'Paper' : t === 'layers' ? 'Layers' : 'Effects'}</button>
        {/each}
      </div>
      <div class="flex flex-col gap-2" data-paint-panel={tab}>
        {#if tab === 'color'}<ColorPanel {controller} />{/if}
        {#if tab === 'wet'}<WetPanel {controller} />{/if}
        {#if tab === 'paper'}<PaperPanel {controller} />{/if}
        {#if tab === 'layers'}<PaintLayersPanel {controller} /><StickerPanel {controller} />{/if}
        {#if tab === 'effects' && effects.current}<PaintEffectsPanel {controller} />{/if}
      </div>
    </div>
  </div>
</div>
