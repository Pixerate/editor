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
    getVectorSymbolEditBackground,
    isVectorTextTarget,
    toVectorKeyInput,
    toVectorPointerInput,
    vectorDiamondPath,
    createVectorPlaybackLocator,
    type VectorEditorController
  } from '@pixerate/editor/vector';
  import type { AgentPlayback } from '@pixerate/editor/tools';
  import { createPlaybackSurface, getAgentPlayback } from '../playback/playback.svelte.js';
  import PresenceLayer from '../playback/PresenceLayer.svelte';
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
    /**
     * Agent playback: act out the vector commands' calls here with the agent's cursor (default:
     * `setAgentPlayback` above; `null` turns it off).
     */
    playback?: AgentPlayback | null;
    /** The playback surface id (default `vector`, where the vector commands play). */
    playbackId?: string;
    /** Bring the canvas on screen (switch to its tab) before the agent acts. */
    onplaybackreveal?: () => void | Promise<void>;
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
    'aria-label': ariaLabel = 'Vector canvas',
    playback,
    playbackId = 'vector',
    onplaybackreveal
  }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  // The canvas size, so the scene leaves out what is off screen and simplifies what is tiny.
  let size: { width: number; height: number } | null = $state(null);
  const scene = $derived(getVectorSceneRenderData(view, { idPrefix, ...(size ? { viewportSize: size } : {}) }));

  const overlay = $derived(getVectorOverlayRenderData(view));
  // Isolation mode: the rest of the document, dimmed behind the symbol's art.
  const host = $derived(getVectorSymbolEditBackground(view, { idPrefix: `${idPrefix}host-` }));
  const box = $derived(overlay.selectionBox);
  const edit = $derived(view.widthPointEdit);
  const editAt = $derived(edit ? { x: edit.point.x * view.viewport.zoom + view.viewport.x, y: edit.point.y * view.viewport.zoom + view.viewport.y } : null);
  const closing = $derived(view.tool === 'pen' ? overlay.anchors.find((a) => a.closes && a.hovered) : undefined);
  const hs = THEME.transformHandleSize;
  const as = THEME.anchorSize;

  let svg: SVGSVGElement | undefined = $state();

  // Agent playback: the agent's cursor in document units, drawn through the viewport.
  const ambientPlayback = getAgentPlayback();
  const playing = $derived((playback === undefined ? ambientPlayback : playback) ?? null);
  const svgBox = () => svg?.getBoundingClientRect() ?? null;
  const presence = createPlaybackSurface(() => playing, () => playbackId, () => ({
    defaultKind: 'vector',
    locate: createVectorPlaybackLocator(controller),
    bounds: () => {
      const r = svgBox();
      const v = controller.getState().viewport;
      return r && r.width > 0 ? { x: -v.x / v.zoom, y: -v.y / v.zoom, width: r.width / v.zoom, height: r.height / v.zoom } : null;
    },
    visible: () => {
      const r = svgBox();
      return !!r && r.width > 0 && r.height > 0 && !(typeof document !== 'undefined' && document.visibilityState === 'hidden');
    },
    toViewport: (p) => {
      const r = svgBox();
      const v = controller.getState().viewport;
      return { x: (r?.left ?? 0) + p.x * v.zoom + v.x, y: (r?.top ?? 0) + p.y * v.zoom + v.y };
    },
    fromViewport: (p) => {
      const r = svgBox();
      const v = controller.getState().viewport;
      return { x: (p.x - (r?.left ?? 0) - v.x) / v.zoom, y: (p.y - (r?.top ?? 0) - v.y) / v.zoom };
    },
    reveal: () => onplaybackreveal?.()
  }));
  $effect(() => {
    const el = svg;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const now = untrack(() => size);
      if (r.width > 0 && r.height > 0 && (!now || now.width !== r.width || now.height !== r.height)) size = { width: r.width, height: r.height };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
  let textInput: HTMLTextAreaElement | undefined = $state();
  const editingText = $derived(view.textEdit?.nodeId ?? null);

  // Typing goes into a hidden textarea while text is edited (focused after the click that started it).
  $effect(() => {
    if (!editingText) return;
    const t = setTimeout(() => textInput?.focus({ preventScroll: true }), 0);
    return () => clearTimeout(t);
  });

  function onTextInput(e: Event) {
    const el = e.currentTarget as HTMLTextAreaElement;
    if ((e as InputEvent).isComposing) return;
    if (el.value) controller.textInput(el.value);
    el.value = '';
  }

  function onTextCompositionEnd(e: CompositionEvent) {
    const el = e.currentTarget as HTMLTextAreaElement;
    if (el.value) controller.textInput(el.value);
    el.value = '';
  }

  function onTextKeyDown(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.isComposing) return;
    // Characters come through `input`; editing keys and shortcuts go to the controller.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) return;
    if (controller.keyDown(toVectorKeyInput(e))) e.preventDefault();
    if (!controller.getState().textEdit) svg?.focus({ preventScroll: true });
  }

  function onTextClipboard(kind: 'copy' | 'cut' | 'paste') {
    return (e: ClipboardEvent) => {
      e.stopPropagation();
      if (kind === 'paste') {
        const text = e.clipboardData?.getData('text/plain');
        if (text) controller.textInput(text);
        e.preventDefault();
        return;
      }
      const text = kind === 'cut' ? controller.cutText() : controller.getSelectedText();
      if (text && e.clipboardData) {
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
      }
    };
  }
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
  {#if host}
    <g data-vector-symbol-host="" opacity="0.3" pointer-events="none" transform={host.transform}>
      <VectorGradientDefs defs={host.defs} />
      <VectorFilterDefs filters={host.filters} />
      <VectorSceneNodes nodes={host.nodes} />
    </g>
  {/if}
  <g data-vector-scene="" transform={scene.transform}>
    <VectorSceneNodes nodes={scene.nodes} />
  </g>
  {#if overlay.frames.length}
    <g data-vector-frame-labels="">
      {#each overlay.frames as f (f.id)}
        <!-- A frame's name selects it (clicking inside a frame may pick its contents). -->
        <text
          role="button"
          tabindex="-1"
          data-vector-frame-label={f.id}
          x={f.x}
          y={f.y - 6}
          font-size="11"
          font-weight={f.selected ? 600 : 400}
          fill={f.selected ? accentColor : '#737373'}
          style="font-family:system-ui,sans-serif;cursor:default;user-select:none"
          onpointerdown={(e) => {
            e.stopPropagation();
            controller.select([f.id]);
          }}>{f.name}</text
        >
      {/each}
    </g>
  {/if}
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
    {#if overlay.brush}
      <circle data-vector-brush="" cx={overlay.brush.x} cy={overlay.brush.y} r={overlay.brush.r} fill="none" stroke={accentColor} stroke-width="1" stroke-dasharray="4 3" pointer-events="none" />
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
    {#if overlay.text}
      <g data-vector-text-edit={overlay.text.nodeId} data-editing={overlay.text.editing || undefined}>
        <path d={overlay.text.frame} stroke={accentColor} stroke-dasharray={overlay.text.editing ? '3 2' : undefined} opacity="0.8" />
        {#each overlay.text.selection as d, i (i)}
          <path data-vector-text-selection="" {d} fill={accentColor} fill-opacity="0.25" stroke="none" />
        {/each}
        {#if overlay.text.caret}
          <line data-vector-text-caret="" x1={overlay.text.caret.x1} y1={overlay.text.caret.y1} x2={overlay.text.caret.x2} y2={overlay.text.caret.y2} stroke={accentColor} stroke-width="1.5" />
        {/if}
        {#if overlay.text.overflow}
          <g data-vector-text-overflow="" transform="translate({overlay.text.overflow.x} {overlay.text.overflow.y})">
            <rect x="-5" y="-5" width="10" height="10" fill={THEME.handleFill} stroke="#dc2626" />
            <path d="M-3 0H3M0 -3V3" stroke="#dc2626" />
          </g>
        {/if}
      </g>
    {/if}
    {#each overlay.shading as sh (sh.nodeId)}
      <g data-vector-shading={sh.kind}>
        {#each sh.lines as d, i (i)}<path {d} stroke={accentColor} stroke-width="1" opacity="0.7" />{/each}
        {#each sh.points as p (p.index)}
          <circle data-vector-shading-point={p.index} data-selected={p.selected || undefined} cx={p.x} cy={p.y} r={p.selected ? 6 : 4.5} fill={p.color} stroke={p.selected ? accentColor : '#ffffff'} stroke-width={p.selected ? 2 : 1.5} />
        {/each}
      </g>
    {/each}
    {#if overlay.perspective}
      <g data-vector-perspective-grid="" fill="none" pointer-events="none">
        {#each overlay.perspective.planes as pl (pl.plane)}
          <path data-vector-perspective-plane={pl.plane} data-active={pl.active || undefined} d={pl.d} stroke={pl.active ? accentColor : guideColor} stroke-width={pl.active ? 1 : 0.75} opacity={pl.active ? 0.55 : 0.25} />
        {/each}
        {#each overlay.perspective.vanishingPoints as v, i (i)}
          <circle data-vector-vanishing-point={i} cx={v.x} cy={v.y} r="4" stroke={accentColor} stroke-width="1.5" />
        {/each}
        <circle data-vector-perspective-origin="" cx={overlay.perspective.origin.x} cy={overlay.perspective.origin.y} r="3" fill={accentColor} />
      </g>
    {/if}
    {#each overlay.symmetry as sy (sy.nodeId)}
      <g data-vector-symmetry-axes={sy.nodeId} stroke={accentColor} stroke-dasharray={sy.drawing ? undefined : '6 4'} opacity={sy.drawing ? 0.9 : 0.6}>
        {#each sy.lines as l, i (i)}<line x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />{/each}
      </g>
    {/each}
    {#each overlay.trackingPoints as t, i (i)}
      <path data-vector-tracking-point="" d="M{t.x - 5} {t.y}H{t.x + 5}M{t.x} {t.y - 5}V{t.y + 5}" stroke={guideColor} stroke-width="1.5" />
    {/each}
    {#if overlay.typedEntry}
      <g data-vector-typed-entry="" transform="translate({overlay.typedEntry.x + 14} {overlay.typedEntry.y + 18})">
        <rect x="-3" y="-12" width={overlay.typedEntry.text.length * 7 + 8} height="17" rx="3" fill={THEME.handleFill} stroke={accentColor} />
        <text x="1" y="1" font-size="11" fill={accentColor} style="font-family:ui-monospace,monospace">{overlay.typedEntry.text}</text>
      </g>
    {/if}
    {#each overlay.connectorSites as s (`${s.nodeId}:${s.side}`)}
      <circle data-vector-connection-site={s.side} data-active={s.active || undefined} cx={s.x} cy={s.y} r={s.active ? 5 : 3.5} fill={s.active ? accentColor : THEME.handleFill} stroke={accentColor} />
    {/each}
    {#each overlay.constraints as c (c.id)}
      <g data-vector-constraint-glyph={c.kind} data-satisfied={c.satisfied ? 'true' : 'false'}>
        {#if c.dimension}<line x1={c.dimension.x1} y1={c.dimension.y1} x2={c.dimension.x2} y2={c.dimension.y2} stroke={c.satisfied ? THEME.guide : '#dc2626'} stroke-dasharray="2 2" />{/if}
        <text x={c.x} y={c.y} font-size="10" text-anchor="middle" fill={c.satisfied ? accentColor : '#dc2626'} stroke="#ffffff" stroke-width="3" paint-order="stroke" style="font-family:system-ui,sans-serif">{c.label}</text>
      </g>
    {/each}
    {#if overlay.textBox}
      <rect data-vector-text-box="" x={overlay.textBox.x} y={overlay.textBox.y} width={overlay.textBox.width} height={overlay.textBox.height} stroke={accentColor} stroke-dasharray="3 2" />
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
  {#if view.textEdit && overlay.text}
    <!-- A hidden textarea at the caret takes typing and composed (IME) text. -->
    <foreignObject x={overlay.text.caret?.x1 ?? 0} y={overlay.text.caret?.y1 ?? 0} width="1" height="1" style="overflow:visible">
      <textarea
        bind:this={textInput}
        data-testid="vector-type-input"
        aria-label="Text"
        autocapitalize="off"
        autocomplete="off"
        spellcheck="false"
        style="position:absolute;width:1px;height:1px;padding:0;border:0;opacity:0;resize:none;overflow:hidden"
        onpointerdown={(e) => e.stopPropagation()}
        oninput={onTextInput}
        oncompositionend={onTextCompositionEnd}
        onkeydown={onTextKeyDown}
        onkeyup={(e) => e.stopPropagation()}
        oncopy={onTextClipboard('copy')}
        oncut={onTextClipboard('cut')}
        onpaste={onTextClipboard('paste')}
      ></textarea>
    </foreignObject>
  {/if}
  {#if view.symbolEdit}
    <!-- Isolation mode: which symbol, and the way out (Escape with nothing selected works too). -->
    <foreignObject data-vector-symbol-edit={view.symbolEdit.symbolId} x="8" y="8" width="320" height="32" style="overflow:visible">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        style="display:inline-flex;align-items:center;gap:8px;padding:4px 8px;border-radius:6px;background:rgba(15,23,42,0.85);color:#fff;font:12px system-ui,sans-serif"
        onpointerdown={(e) => e.stopPropagation()}
        ondblclick={(e) => e.stopPropagation()}
        onkeydown={(e) => e.stopPropagation()}
      >
        <span>Symbol: {view.symbolEdit.name}</span>
        <button type="button" aria-label="Exit symbol" style="border:1px solid rgba(255,255,255,0.4);border-radius:4px;padding:0 6px;background:transparent;color:#fff;cursor:pointer" onclick={() => controller.exitSymbolEdit()}>Done</button>
      </div>
    </foreignObject>
  {/if}
  {#if edit && editAt}
    <!-- Width Point Edit (double-click with the width tool), beside the point. -->
    <foreignObject data-vector-width-point-edit="" x={editAt.x + 12} y={editAt.y + 12} width="180" height="140" style="overflow:visible">
      {#key `${edit.nodeId}:${edit.index}:${edit.t}`}
        <VectorWidthPointEditor {controller} {edit} {accentColor} />
      {/key}
    </foreignObject>
  {/if}
  {#if playing}
    <!-- The agent's cursor (agent playback), over everything and never in the way. -->
    <foreignObject data-vector-presence="" x="0" y="0" width="100%" height="100%" pointer-events="none" style="overflow:visible;pointer-events:none">
      <div style="position:relative;width:100%;height:100%">
        <PresenceLayer {presence} viewport={view.viewport} />
      </div>
    </foreignObject>
  {/if}
</svg>
