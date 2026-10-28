<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte';
  import {
    CSS_VARIABLE_CHART_THEME,
    chartClientToScene,
    chartTooltipAt,
    sameChartTooltip,
    describeChartSelection,
    handleChartKey,
    layoutChart,
    startChartPointDrag,
    type ChartController,
    type ChartPointDrag,
    type ChartPresence,
    type ChartScene,
    type ChartTextMeasure,
    type ChartTheme,
    type ChartTooltip,
    type ChartTooltipMode
  } from '@pixerate/editor/chart';
  import { chartStateOf } from './createChartEditor.svelte.js';
  import ChartMarks from './ChartMarks.svelte';
  import ChartPresenceLayer from './ChartPresenceLayer.svelte';

  interface Props {
    controller: ChartController;
    /** Scene width; with `responsive` this is only the fallback before the container is measured (default 640). */
    width?: number;
    /** Scene height in pixels (default 400). */
    height?: number;
    /** Follow the container's width (default `true`). */
    responsive?: boolean;
    /** Colours and type (default: shadcn-style CSS variables). */
    theme?: Partial<ChartTheme>;
    /** Click to select, drag bars and points, keyboard editing (default `true`). */
    editable?: boolean;
    /** Text width for layout (default: an estimate). */
    measureText?: ChartTextMeasure;
    emptyMessage?: string;
    class?: string;
    /** Agent cursors to draw over the chart (see `ChartDirector`). */
    presence?: ChartPresence;
    /** Receives the scene as drawn (e.g. for `ChartDirector`'s `scene`). */
    sceneRef?: { current: ChartScene | null };
    /** Show a tooltip on hover: `point` (or `true`) for the bar, point or slice under the pointer, `category` for every series in the category under it (default off). */
    tooltip?: boolean | ChartTooltipMode;
    /** Draws the tooltip's content instead of the category label and one row per series. */
    tooltipContent?: Snippet<[ChartTooltip]>;
  }

  let {
    controller,
    width = 640,
    height = 400,
    responsive = true,
    theme,
    editable = true,
    measureText,
    emptyMessage,
    class: className = '',
    presence,
    sceneRef,
    tooltip = false,
    tooltipContent
  }: Props = $props();

  const view = chartStateOf(() => controller);
  let measured = $state(0);
  let wrapper: HTMLDivElement | undefined = $state();
  let svg: SVGSVGElement | undefined = $state();

  // Guarded (not `bind:clientWidth`) so it also runs where ResizeObserver is missing (jsdom).
  $effect(() => {
    const el = wrapper;
    if (!responsive || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) measured = w;
    });
    observer.observe(el);
    return () => observer.disconnect();
  });
  let drag: ChartPointDrag | null = null;
  // Frozen while a point is dragged so the axes do not rescale under the pointer.
  let frozen = $state.raw<{ valueDomain: ChartPointDrag['valueDomain']; valueDomain2: ChartPointDrag['valueDomain2'] | null; xDomain: ChartPointDrag['xDomain'] | null; readout: ChartPointDrag['target'] } | null>(null);

  const sceneWidth = $derived((responsive && measured) || width);
  const fullTheme = $derived({ ...CSS_VARIABLE_CHART_THEME, ...theme });
  const scene = $derived(
    layoutChart(view.current.spec, {
      width: sceneWidth,
      height,
      theme: fullTheme,
      selection: editable ? view.current.selection : null,
      measureText,
      emptyMessage,
      valueDomain: frozen?.valueDomain,
      valueDomain2: frozen?.valueDomain2,
      xDomain: frozen?.xDomain,
      readout: frozen?.readout,
      raceFrame: view.current.raceFrame
    })
  );
  $effect(() => {
    if (sceneRef) sceneRef.current = scene;
  });
  const tooltipMode = $derived<ChartTooltipMode | null>(tooltip === true ? 'point' : tooltip || null);
  let tip = $state.raw<ChartTooltip | null>(null);
  // In wrapper pixels; `flip` puts the tooltip left of the pointer near the right edge.
  let tipAt = $state({ left: 0, top: 0, flip: false });
  const byKey = $derived(new Map(scene.marks.map((m) => [m.key, m])));
  const label = $derived(view.current.spec.title || 'Chart');

  onDestroy(() => drag?.end());

  const scenePoint = (e: PointerEvent) => chartClientToScene(scene, svg!.getBoundingClientRect(), e.clientX, e.clientY);

  function pointerdown(e: PointerEvent) {
    if (!editable || e.button !== 0) return;
    const key = (e.target as Element).closest?.('[data-chart-key]')?.getAttribute('data-chart-key');
    const target = key ? byKey.get(key)?.target : undefined;
    controller.select(target ?? null);
    drag = startChartPointDrag(controller, scene, target, scenePoint(e));
    if (drag) {
      tip = null;
      frozen = { valueDomain: drag.valueDomain, valueDomain2: drag.valueDomain2 ?? null, xDomain: drag.xDomain ?? null, readout: drag.target };
      svg?.setPointerCapture?.(e.pointerId);
    }
  }
  function pointermove(e: PointerEvent) {
    drag?.move(scenePoint(e), { fine: e.altKey, lockAxis: e.shiftKey, noSnap: e.ctrlKey || e.metaKey });
    hover(e);
  }
  function hover(e: PointerEvent) {
    if (!tooltipMode || drag || !wrapper) {
      tip = null;
      return;
    }
    const next = chartTooltipAt(view.current.spec, scene, scenePoint(e), { mode: tooltipMode, measureText });
    if (!sameChartTooltip(tip, next)) tip = next;
    if (!next) return;
    const box = wrapper.getBoundingClientRect();
    const left = e.clientX - box.left;
    tipAt = { left, top: e.clientY - box.top, flip: left > box.width * 0.6 };
  }
  function endDrag() {
    drag?.end();
    drag = null;
    frozen = null;
  }
  function keydown(e: KeyboardEvent) {
    if (drag && e.key === 'Escape') {
      drag.cancel();
      drag = null;
      frozen = null;
      e.preventDefault();
      return;
    }
    if (editable && handleChartKey(controller, scene, e)) e.preventDefault();
  }
</script>

<div bind:this={wrapper} class="relative w-full {className}" data-chart-canvas="">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <svg
    bind:this={svg}
    width={sceneWidth}
    {height}
    viewBox="0 0 {scene.width} {scene.height}"
    role="img"
    aria-label={editable ? `${label}. ${describeChartSelection(controller, view.current.selection)}` : label}
    tabindex={editable ? 0 : undefined}
    class="block max-w-full touch-none select-none rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    onpointerdown={pointerdown}
    onpointermove={pointermove}
    onpointerup={endDrag}
    onpointercancel={endDrag}
    onpointerleave={() => (tip = null)}
    onkeydown={keydown}
  >
    <ChartMarks marks={scene.marks} fontFamily={scene.theme.fontFamily} interactive={editable} />
    {#if presence}<ChartPresenceLayer {presence} />{/if}
  </svg>
  {#if tip}
    <div
      role="tooltip"
      data-chart-tooltip=""
      class="pointer-events-none absolute z-10 min-w-32 rounded-md border px-2.5 py-1.5 text-xs shadow-md"
      style="left: {tipAt.left}px; top: {tipAt.top}px; transform: translate({tipAt.flip ? 'calc(-100% - 12px)' : '12px'}, calc(-100% - 8px)); background: var(--popover, #ffffff); color: var(--popover-foreground, #0f172a); border-color: var(--border, #e2e8f0); font-family: {scene.theme.fontFamily};"
    >
      {#if tooltipContent}
        {@render tooltipContent(tip)}
      {:else}
        {#if tip.title}<div class="mb-1 font-medium">{tip.title}</div>{/if}
        {#each tip.items as item (item.seriesId)}
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 shrink-0 rounded-full" style="background: {item.color}"></span>
            <span style="color: var(--muted-foreground, #64748b)">{item.name}</span>
            <span class="ml-auto pl-3 font-medium tabular-nums">{item.text}</span>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>
