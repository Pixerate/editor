<script lang="ts" module>
  // A counter keeps gradient ids unique per canvas (`$props.id()` needs Svelte 5.20).
  let nextId = 0;
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import {
    VECTOR_OVERLAY_THEME as THEME,
    getVectorOverlayRenderData,
    getVectorSceneRenderData,
    isVectorTextTarget,
    toVectorKeyInput,
    toVectorPointerInput,
    type VectorEditorController
  } from '@pixerate/editor/vector';
  import VectorGradientDefs from './VectorGradientDefs.svelte';
  import VectorSceneNodes from './VectorSceneNodes.svelte';
  import { vectorStateOf } from './subscribe.svelte.js';

  interface Props {
    controller: VectorEditorController;
    /** Fit the artboard into the canvas when it first gets a size (default `true`). */
    fitOnMount?: boolean;
    /** Draw a checkerboard behind a transparent artboard (default `true`). */
    checkerboard?: boolean;
    /** Overlay accent colour (default sky blue). */
    accentColor?: string;
    /** Prefix for gradient ids (keep it unique per page). */
    idPrefix?: string;
    class?: string;
    style?: string;
    /** Accessible label (default "Vector canvas"). */
    'aria-label'?: string;
  }

  let {
    controller,
    fitOnMount = true,
    checkerboard = true,
    accentColor = THEME.accent,
    idPrefix = `ve${++nextId}-`,
    class: className = '',
    style = '',
    'aria-label': ariaLabel = 'Vector canvas'
  }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const scene = $derived(getVectorSceneRenderData(view, { idPrefix }));
  const overlay = $derived(getVectorOverlayRenderData(view));
  const box = $derived(overlay.selectionBox);
  const closing = $derived(view.tool === 'pen' ? overlay.anchors.find((a) => a.closes && a.hovered) : undefined);
  const hs = THEME.transformHandleSize;
  const as = THEME.anchorSize;

  let svg: SVGSVGElement | undefined = $state();
  let fitted = untrack(() => !fitOnMount);

  $effect(() => {
    const el = svg;
    const current = controller;
    if (!el || fitted) return;
    const fit = () => {
      const rect = el.getBoundingClientRect();
      if (fitted || rect.width <= 0 || rect.height <= 0) return;
      fitted = true;
      current.zoomToFit({ width: rect.width, height: rect.height });
    };
    fit();
    if (fitted || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  });

  // Wheel needs a non-passive listener to stop page scroll / browser zoom.
  $effect(() => {
    const el = svg;
    const current = controller;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      current.wheel(local(e), { x: e.deltaX, y: e.deltaY }, toVectorPointerInput(e));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  function local(e: { clientX: number; clientY: number }) {
    const rect = svg?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }

  function onPointerDown(e: PointerEvent) {
    svg?.focus({ preventScroll: true });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    controller.pointerDown(local(e), toVectorPointerInput(e));
  }

  function onPointerUp(e: PointerEvent) {
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    controller.pointerUp(local(e), toVectorPointerInput(e));
  }

  function onKeyDown(e: KeyboardEvent) {
    if (isVectorTextTarget(e.target)) return;
    if (controller.keyDown(toVectorKeyInput(e))) e.preventDefault();
  }

  function clipboard(kind: 'copy' | 'cut' | 'paste') {
    return (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (kind === 'paste') {
        const text = data?.getData('text/plain') ?? '';
        const pasted = text ? controller.paste(text) : controller.paste();
        if (pasted.length) e.preventDefault();
        return;
      }
      const text = kind === 'cut' ? controller.cut() : controller.copy();
      if (text && data) {
        data.setData('text/plain', text);
        e.preventDefault();
      }
    };
  }

  const handleKey = (h: { ref: { nodeId: string; subpath: number; index: number; handle: string } }) =>
    `${h.ref.nodeId}:${h.ref.subpath}:${h.ref.index}:${h.ref.handle}`;
  const anchorKey = (a: { ref: { nodeId: string; subpath: number; index: number } }) => `${a.ref.nodeId}:${a.ref.subpath}:${a.ref.index}`;
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<svg
  bind:this={svg}
  role="application"
  aria-label={ariaLabel}
  tabindex="0"
  data-tool={view.tool}
  class={className}
  style="display:block;width:100%;height:100%;outline:none;touch-action:none;user-select:none;cursor:{view.cursor};{style}"
  onpointerdown={onPointerDown}
  onpointermove={(e) => controller.pointerMove(local(e), toVectorPointerInput(e))}
  onpointerup={onPointerUp}
  onpointercancel={() => controller.cancelDrag()}
  onpointerleave={() => controller.pointerLeave()}
  ondblclick={(e) => controller.doubleClick(local(e))}
  onkeydown={onKeyDown}
  onkeyup={(e) => controller.keyUp(toVectorKeyInput(e))}
  oncopy={clipboard('copy')}
  oncut={clipboard('cut')}
  onpaste={clipboard('paste')}
>
  {#if checkerboard}
    <defs>
      <pattern id="{idPrefix}checker" width="16" height="16" patternUnits="userSpaceOnUse">
        <rect width="16" height="16" fill="#ffffff" />
        <rect width="8" height="8" fill="#e5e7eb" />
        <rect x="8" y="8" width="8" height="8" fill="#e5e7eb" />
      </pattern>
    </defs>
  {/if}
  <VectorGradientDefs defs={scene.defs} />
  <rect
    data-vector-artboard=""
    x={overlay.artboard.x}
    y={overlay.artboard.y}
    width={overlay.artboard.width}
    height={overlay.artboard.height}
    fill={scene.background ?? (checkerboard ? `url(#${idPrefix}checker)` : '#ffffff')}
    stroke="rgba(0,0,0,0.12)"
  />
  <g data-vector-scene="" transform={scene.transform}>
    <VectorSceneNodes nodes={scene.nodes} />
  </g>
  <g data-vector-overlay="" pointer-events="none" fill="none">
    {#each overlay.outlines as o (o.id)}
      <path d={o.d} stroke={accentColor} stroke-width={o.selected ? 1 : 1.5} opacity={o.selected ? 1 : 0.7} />
    {/each}
    {#if overlay.penPreview}
      <path d={overlay.penPreview} stroke={accentColor} stroke-dasharray="4 3" />
    {/if}
    {#if box}
      <g data-vector-selection="" transform={box.transform || undefined}>
        <rect x={box.x} y={box.y} width={box.width} height={box.height} stroke={accentColor} />
        <line x1={box.x + box.width / 2} y1={box.y} x2={box.x + box.width / 2} y2={box.y - 24} stroke={accentColor} />
        {#each box.handles as h (h.handle)}
          {#if h.handle === 'rotate'}
            <circle data-handle={h.handle} cx={h.x} cy={h.y} r={hs / 2 + 1} fill={THEME.handleFill} stroke={accentColor} />
          {:else}
            <rect data-handle={h.handle} x={h.x - hs / 2} y={h.y - hs / 2} width={hs} height={hs} fill={THEME.handleFill} stroke={accentColor} />
          {/if}
        {/each}
      </g>
    {/if}
    {#each overlay.handles as h (handleKey(h))}
      <g data-vector-handle={h.ref.handle}>
        <line x1={h.anchorX} y1={h.anchorY} x2={h.x} y2={h.y} stroke={accentColor} />
        <circle cx={h.x} cy={h.y} r={THEME.handleRadius + (h.hovered ? 1 : 0)} fill={THEME.handleFill} stroke={accentColor} />
      </g>
    {/each}
    {#each overlay.anchors as a (anchorKey(a))}
      {@const size = as + (a.hovered ? 2 : 0)}
      {#if a.type === 'corner'}
        <rect
          data-vector-anchor={a.ref.index}
          x={a.x - size / 2}
          y={a.y - size / 2}
          width={size}
          height={size}
          fill={a.selected ? accentColor : THEME.handleFill}
          stroke={accentColor}
        />
      {:else}
        <circle data-vector-anchor={a.ref.index} cx={a.x} cy={a.y} r={size / 2} fill={a.selected ? accentColor : THEME.handleFill} stroke={accentColor} />
      {/if}
    {/each}
    {#if closing}
      <circle cx={closing.x} cy={closing.y} r={as} stroke={accentColor} />
    {/if}
    {#if overlay.marquee}
      <rect
        data-vector-marquee=""
        x={overlay.marquee.x}
        y={overlay.marquee.y}
        width={overlay.marquee.width}
        height={overlay.marquee.height}
        fill={THEME.marqueeFill}
        stroke={accentColor}
        stroke-dasharray="3 2"
      />
    {/if}
    {#if overlay.status}
      <text data-vector-status="" x="8" y="100%" dy="-8" font-size="11" fill={accentColor} style="font-family:system-ui,sans-serif">{overlay.status}</text>
    {/if}
  </g>
</svg>
