<script lang="ts">
  import {
    PaintCanvasPresenter,
    PaintGesture,
    drawWaterOverlay,
    fitZoom,
    startWetClock,
    guideOverlay,
    handlePaintShortcut,
    viewCssTransform,
    type PaintEditorController,
    type PaintPresence,
    type PaintTool,
  } from '@pixerate/editor/paint-editor';
  import { untrack } from 'svelte';
  import { paintEditorState } from './paintEditorRune.svelte.js';
  import PaintPresenceLayer from './PaintPresenceLayer.svelte';
  import ReferencePanel from './ReferencePanel.svelte';

  interface Props {
    controller: PaintEditorController;
    /** The active tool (default brush). */
    tool?: PaintTool;
    /** Draw the symmetry axes and perspective lines (default true). */
    showGuides?: boolean;
    /** Fit the canvas in the viewport on mount (default true). */
    fitOnMount?: boolean;
    /** Called with a refusal (hidden or locked layer). */
    onerror?: (message: string | null) => void;
    /** Agent cursors to draw over the canvas (see `PaintDirector` and `createPaintDirector`). */
    presence?: PaintPresence;
    class?: string;
  }
  let { controller, tool = 'brush', showGuides = true, fitOnMount = true, onerror, presence, class: className = '' }: Props = $props();

  const editor = paintEditorState(() => controller);
  const snap = $derived(editor.current);
  let viewport = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let water = $state<HTMLCanvasElement | null>(null);
  let size = $state({ width: 800, height: 600 });
  let predicted = $state<Array<{ x: number; y: number }>>([]);
  const presenter = $derived(new PaintCanvasPresenter(controller));
  const gesture = $derived(
    new PaintGesture(controller, () => {
      const r = viewport?.getBoundingClientRect();
      return { left: r?.left ?? 0, top: r?.top ?? 0, width: r?.width || size.width, height: r?.height || size.height };
    })
  );
  $effect(() => {
    gesture.tool = tool;
  });
  const doc = $derived(snap.document.canvas);

  $effect(() => {
    const el = viewport;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!el.clientWidth || !el.clientHeight) return;
      measured = true;
      size = { width: el.clientWidth, height: el.clientHeight };
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  // Fit once per canvas size, after the viewport has been measured (or at once where it cannot be).
  let fitted: string | null = null;
  let measured = $state(false);
  $effect(() => {
    const key = `${doc.width}x${doc.height}`;
    const s = size;
    if (!fitOnMount || fitted === key) return;
    if (typeof ResizeObserver !== 'undefined' && !measured) return;
    fitted = key;
    untrack(() => controller.setView({ zoom: fitZoom(doc, s), pan: { x: 0, y: 0 } }));
  });

  // Upload changed tiles whenever the state changes.
  $effect(() => {
    void snap;
    const ctx = canvas?.getContext('2d');
    untrack(() => {
      if (ctx && typeof ctx.createImageData === 'function') presenter.render(ctx as never);
      else controller.takeDirty();
    });
  });

  // Wet paint flows with the display.
  $effect(() => {
    const c = controller;
    return untrack(() => startWetClock(c));
  });

  // The water overlay.
  $effect(() => {
    void snap;
    const ctx = water?.getContext('2d');
    untrack(() => {
      if (ctx && typeof ctx.createImageData === 'function') drawWaterOverlay(controller, ctx as never);
    });
  });

  // Wheel needs a non-passive listener to prevent page scroll (see GOTCHAS).
  $effect(() => {
    const el = viewport;
    if (!el) return;
    const g = gesture;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      g.wheel(e);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const transform = $derived(viewCssTransform(snap.view, doc, size));
  const lines = $derived.by(() => {
    void snap;
    return showGuides ? guideOverlay(controller) : [];
  });
</script>

<!-- The canvas is a painting surface (role application): it takes pointer and key input. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={viewport}
  tabindex="0"
  role="application"
  aria-label="Paint canvas"
  data-testid="paint-canvas"
  class={`relative overflow-hidden bg-slate-950 outline-none touch-none select-none ${className}`}
  style={`cursor: ${tool === 'pan' ? 'grab' : tool === 'eyedropper' ? 'copy' : 'crosshair'}`}
  onpointerdown={(e) => {
    viewport?.focus();
    if (gesture.down(e)) (e.target as Element).setPointerCapture?.(e.pointerId);
    onerror?.(gesture.error);
  }}
  onpointermove={(e) => {
    gesture.move(e);
    if (gesture.predicted.length || predicted.length) predicted = gesture.predicted.map((p) => ({ x: p.x, y: p.y }));
  }}
  onpointerup={(e) => {
    gesture.up(e);
    predicted = [];
  }}
  onpointercancel={() => {
    gesture.cancel();
    predicted = [];
  }}
  onkeydown={(e) => {
    if (handlePaintShortcut(controller, gesture, e)) e.preventDefault();
  }}
>
  <canvas
    bind:this={canvas}
    width={doc.width}
    height={doc.height}
    class="absolute left-0 top-0 shadow-2xl"
    style={`transform: ${transform}; transform-origin: 0 0; image-rendering: ${snap.view.zoom > 2 ? 'pixelated' : 'auto'}`}
  ></canvas>
  {#if snap.wet.overlay}
    <canvas
      bind:this={water}
      width={doc.width}
      height={doc.height}
      data-testid="paint-water-overlay"
      class="absolute left-0 top-0 pointer-events-none opacity-60"
      style={`transform: ${transform}; transform-origin: 0 0`}
    ></canvas>
  {/if}
  <svg class="absolute left-0 top-0 pointer-events-none overflow-visible" width={doc.width} height={doc.height} style={`transform: ${transform}; transform-origin: 0 0`} aria-hidden="true">
    {#each lines as l, i (i)}
      <line
        x1={l.from.x}
        y1={l.from.y}
        x2={l.to.x}
        y2={l.to.y}
        stroke={l.kind === 'symmetry' ? '#22d3ee' : l.kind === 'stencil' ? '#fbbf24' : '#f472b6'}
        stroke-opacity={l.kind === 'symmetry' || l.kind === 'stencil' ? 0.8 : 0.35}
        stroke-width={1 / snap.view.zoom}
        stroke-dasharray={l.kind === 'symmetry' ? `${6 / snap.view.zoom} ${4 / snap.view.zoom}` : undefined}
      />
    {/each}
    {#if predicted.length > 0}
      <polyline points={predicted.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={snap.color} stroke-opacity="0.5" stroke-width={Math.max(1, snap.brush.tip.size / 2)} stroke-linecap="round" />
    {/if}
  </svg>
  {#each snap.guides.references.filter((r) => r.visible) as r (r.id)}
    <ReferencePanel {controller} reference={r} />
  {/each}
  {#if presence}<PaintPresenceLayer {presence} view={snap.view} canvas={doc} viewport={size} />{/if}
  <div class="absolute bottom-1 right-2 text-[10px] text-slate-500 pointer-events-none" data-testid="paint-view-status">
    {Math.round(snap.view.zoom * 100)}% · {Math.round(snap.view.rotation)}°{snap.view.mirror ? ' · mirrored' : ''}
  </div>
</div>
