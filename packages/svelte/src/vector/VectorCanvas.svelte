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
    vectorDiamondPath,
    type VectorEditorController
  } from '@pixerate/editor/vector';
  import VectorGradientDefs from './VectorGradientDefs.svelte';
  import VectorFilterDefs from './VectorFilterDefs.svelte';
  import VectorGradientAnnotator from './VectorGradientAnnotator.svelte';
  import VectorSceneNodes from './VectorSceneNodes.svelte';
  import VectorWidthPointEditor from './VectorWidthPointEditor.svelte';
  import { vectorStateOf } from './subscribe.svelte.js';

  interface Props {
    controller: VectorEditorController;
    /** Fit the artboard into the canvas when it first gets a size (default `true`). */
    fitOnMount?: boolean;
    /** Draw a checkerboard behind a transparent artboard (default `true`). */
    checkerboard?: boolean;
    /** Overlay accent colour (default sky blue). */
    accentColor?: string;
    /** Smart guide colour (default magenta). */
    guideColor?: string;
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
    guideColor = THEME.guide,
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
  const edit = $derived(view.widthPointEdit);
  const editAt = $derived(edit ? { x: edit.point.x * view.viewport.zoom + view.viewport.x, y: edit.point.y * view.viewport.zoom + view.viewport.y } : null);
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
    if (!rect || !svg) return { x: e.clientX, y: e.clientY };
    const scaleX = rect.width > 0 && svg.clientWidth > 0 ? svg.clientWidth / rect.width : 1;
    const scaleY = rect.height > 0 && svg.clientHeight > 0 ? svg.clientHeight / rect.height : 1;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
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
  <VectorFilterDefs filters={scene.filters} />
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
      <g data-vector-selection="" data-free-distort={box.freeDistort || undefined} transform={box.transform || undefined}>
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
    {#if overlay.distort}
      <g data-vector-distort={overlay.distort.mode}>
        <path d={overlay.distort.d} stroke={accentColor} />
        {#each overlay.distort.corners as c, i (i)}
          <rect x={c.x - hs / 2} y={c.y - hs / 2} width={hs} height={hs} fill={THEME.handleFill} stroke={accentColor} />
        {/each}
      </g>
    {/if}
    {#if overlay.envelope}
      <g data-vector-envelope-mesh={overlay.envelope.nodeId}>
        <path data-vector-envelope-grid="" d={overlay.envelope.grid} stroke={accentColor} stroke-opacity="0.8" />
        {#each overlay.envelope.handles as h (h.index)}
          <g data-vector-envelope-handle={h.index}>
            <line x1={h.anchorX} y1={h.anchorY} x2={h.x} y2={h.y} stroke={accentColor} stroke-opacity="0.6" />
            <circle cx={h.x} cy={h.y} r={THEME.handleRadius + (h.hovered || h.active ? 1 : 0)} fill={h.active ? accentColor : THEME.handleFill} stroke={accentColor} />
          </g>
        {/each}
        {#each overlay.envelope.anchors as a (a.index)}
          {@const size = as + (a.hovered || a.active ? 2 : 0)}
          <rect data-vector-envelope-anchor={a.index} x={a.x - size / 2} y={a.y - size / 2} width={size} height={size} fill={a.active ? accentColor : THEME.handleFill} stroke={accentColor} />
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
    {#each overlay.cornerWidgets as w (`corner:${anchorKey(w)}`)}
      <g data-vector-corner-widget={w.ref.index} data-corner-kind={w.kind}>
        <circle cx={w.x} cy={w.y} r={THEME.cornerWidgetRadius + (w.hovered ? 1 : 0)} fill={THEME.handleFill} stroke={accentColor} />
        <circle cx={w.x} cy={w.y} r={1.5} fill={accentColor} />
      </g>
    {/each}
    {#each overlay.masks as m (m.id)}
      <path
        data-vector-mask-indicator={m.id}
        data-mask-type={m.type}
        data-inverted={m.invert || undefined}
        d={m.d}
        fill="none"
        stroke={THEME.mask}
        stroke-width={m.editing ? 1.5 : 1}
        stroke-dasharray={m.editing ? undefined : THEME.maskDash}
        opacity={m.enabled ? 1 : 0.5}
      />
    {/each}
    {#each overlay.blend.spines as sp (sp.id)}
      <g data-vector-blend-spine={sp.id} data-replaced={sp.replaced || undefined}>
        <path d={sp.d} fill="none" stroke={accentColor} stroke-dasharray="4 3" />
        {#each sp.keys as k, i (i)}
          <circle cx={k.x} cy={k.y} r={THEME.handleRadius} fill={THEME.handleFill} stroke={accentColor} />
        {/each}
      </g>
    {/each}
    {#if overlay.blend.start}
      <g data-vector-blend-start="">
        <path d={overlay.blend.start.d} fill="none" stroke={accentColor} stroke-width="2" />
        {#if overlay.blend.start.anchor}
          <circle cx={overlay.blend.start.anchor.x} cy={overlay.blend.start.anchor.y} r={THEME.handleRadius + 1} fill={accentColor} />
        {/if}
      </g>
    {/if}
    {#each overlay.blend.anchors as a, i (i)}
      <rect data-vector-blend-anchor={i} x={a.x - as / 2} y={a.y - as / 2} width={as} height={as} fill={a.hovered ? accentColor : THEME.handleFill} stroke={accentColor} />
    {/each}
    {#if overlay.gradient}<VectorGradientAnnotator annotator={overlay.gradient} {accentColor} />{/if}
    {#if overlay.widthSpot}
      <g data-vector-width-spot="">
        <line x1={overlay.widthSpot.left.x} y1={overlay.widthSpot.left.y} x2={overlay.widthSpot.right.x} y2={overlay.widthSpot.right.y} stroke={accentColor} stroke-dasharray="3 2" />
        <path d={vectorDiamondPath(overlay.widthSpot.x, overlay.widthSpot.y)} fill="none" stroke={accentColor} />
      </g>
    {/if}
    {#each overlay.widthPoints as w (`width:${w.ref.nodeId}:${w.ref.subpath}:${w.ref.index}`)}
      <g data-vector-width-point={w.ref.index} data-selected={w.selected || undefined}>
        <line x1={w.left.x} y1={w.left.y} x2={w.right.x} y2={w.right.y} stroke={accentColor} />
        <path d={vectorDiamondPath(w.x, w.y)} fill={w.selected || w.active ? accentColor : THEME.handleFill} stroke={accentColor} stroke-width={w.hovered === 'center' ? 2 : 1} />
        {#each ['left', 'right'] as const as side (side)}
          <circle data-vector-width-side={side} cx={w[side].x} cy={w[side].y} r={THEME.handleRadius + (w.hovered === side ? 1 : 0)} fill={THEME.handleFill} stroke={accentColor} />
        {/each}
      </g>
    {/each}
    {#if closing}
      <circle cx={closing.x} cy={closing.y} r={as} stroke={accentColor} />
    {/if}
    {#if overlay.builder}
      {@const builder = overlay.builder}
      <g data-vector-builder={builder.mode}>
        {#each builder.faces as d, i (i)}
          <path
            data-vector-builder-face=""
            {d}
            fill={builder.mode === 'erase' ? THEME.builderEraseFill : THEME.builderFill}
            fill-rule="nonzero"
            stroke={builder.mode === 'erase' ? THEME.builderErase : accentColor}
            stroke-width={1}
          />
        {/each}
        {#each builder.hatches as d, i (i)}
          {#if d}
            <path
              data-vector-builder-hatch=""
              {d}
              fill="none"
              stroke={builder.mode === 'erase' ? THEME.builderErase : accentColor}
              stroke-opacity={THEME.builderHatchOpacity}
              stroke-width={1}
            />
          {/if}
        {/each}
        {#each builder.lines as d, i (i)}
          <path data-vector-builder-line="" {d} fill="none" stroke={THEME.builderErase} stroke-width={3} stroke-linecap="round" />
        {/each}
        {#if builder.trail}
          <path data-vector-builder-trail="" d={builder.trail} fill="none" stroke={builder.mode === 'erase' ? THEME.builderErase : accentColor} stroke-width={1} />
        {/if}
      </g>
    {/if}
    {#if overlay.toolStroke}
      <path
        data-vector-tool-stroke={overlay.toolStroke.tool}
        d={overlay.toolStroke.d}
        stroke={overlay.toolStroke.tool === 'eraser' ? THEME.eraserFill : accentColor}
        stroke-width={overlay.toolStroke.tool === 'eraser' ? overlay.toolStroke.width : 1}
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-dasharray={overlay.toolStroke.tool === 'knife' ? '5 3' : undefined}
      />
    {/if}
    {#if overlay.pencilString}
      <line
        data-vector-pencil-string=""
        x1={overlay.pencilString.x1}
        y1={overlay.pencilString.y1}
        x2={overlay.pencilString.x2}
        y2={overlay.pencilString.y2}
        stroke={accentColor}
        stroke-dasharray="2 2"
      />
    {/if}
    {#if overlay.cutPoint}
      <circle data-vector-cut-point="" cx={overlay.cutPoint.x} cy={overlay.cutPoint.y} r={THEME.handleRadius + 1} fill={THEME.handleFill} stroke={accentColor} />
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
    {#if overlay.guides.lines.length}
      <g data-vector-guides="" stroke={guideColor}>
        {#each overlay.guides.lines as l, i (i)}
          <line data-vector-guide={l.kind} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke-dasharray={l.kind === 'construction' ? '4 3' : undefined} />
        {/each}
      </g>
    {/if}
    {#each overlay.guides.labels as l, i (i)}
      <text
        data-vector-guide-label={l.kind}
        x={l.x + 6}
        y={l.y - 6}
        font-size="10"
        fill={guideColor}
        stroke="#ffffff"
        stroke-width="3"
        paint-order="stroke"
        style="font-family:system-ui,sans-serif">{l.text}</text
      >
    {/each}
    {#if overlay.status}
      <text data-vector-status="" x="8" y="100%" dy="-8" font-size="11" fill={accentColor} style="font-family:system-ui,sans-serif">{overlay.status}</text>
    {/if}
  </g>
  {#if edit && editAt}
    <!-- Width Point Edit (double-click with the width tool), beside the point. -->
    <foreignObject data-vector-width-point-edit="" x={editAt.x + 12} y={editAt.y + 12} width="180" height="140" style="overflow:visible">
      {#key `${edit.nodeId}:${edit.index}:${edit.t}`}
        <VectorWidthPointEditor {controller} {edit} {accentColor} />
      {/key}
    </foreignObject>
  {/if}
</svg>
