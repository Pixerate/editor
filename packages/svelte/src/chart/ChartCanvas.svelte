<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    CSS_VARIABLE_CHART_THEME,
    chartClientToScene,
    chartTextBaseline,
    chartTextTransform,
    describeChartSelection,
    handleChartKey,
    layoutChart,
    startChartPointDrag,
    type ChartController,
    type ChartMark,
    type ChartPointDrag,
    type ChartTextMeasure,
    type ChartTheme
  } from '@pixerate/editor/chart';
  import { chartStateOf } from './createChartEditor.svelte.js';

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
    class: className = ''
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

  const sceneWidth = $derived((responsive && measured) || width);
  const fullTheme = $derived({ ...CSS_VARIABLE_CHART_THEME, ...theme });
  const scene = $derived(
    layoutChart(view.current.spec, {
      width: sceneWidth,
      height,
      theme: fullTheme,
      selection: editable ? view.current.selection : null,
      measureText,
      emptyMessage
    })
  );
  const byKey = $derived(new Map(scene.marks.map((m) => [m.key, m])));
  const label = $derived(view.current.spec.title || 'Chart');

  onDestroy(() => drag?.end());

  const pointerEvents = (mark: ChartMark) => (mark.role === 'selection' || (!mark.target && mark.role !== 'background') ? 'none' : undefined);
  const cursor = (mark: ChartMark) => (editable && mark.target && mark.role !== 'background' ? 'pointer' : undefined);
  const scenePoint = (e: PointerEvent) => chartClientToScene(scene, svg!.getBoundingClientRect(), e.clientX, e.clientY);

  function pointerdown(e: PointerEvent) {
    if (!editable || e.button !== 0) return;
    const key = (e.target as Element).closest?.('[data-chart-key]')?.getAttribute('data-chart-key');
    const target = key ? byKey.get(key)?.target : undefined;
    controller.select(target ?? null);
    drag = startChartPointDrag(controller, scene, target, scenePoint(e));
    if (drag) svg?.setPointerCapture?.(e.pointerId);
  }
  function pointermove(e: PointerEvent) {
    drag?.move(scenePoint(e));
  }
  function endDrag() {
    drag?.end();
    drag = null;
  }
  function keydown(e: KeyboardEvent) {
    if (editable && handleChartKey(controller, scene, e)) e.preventDefault();
  }
</script>

<div bind:this={wrapper} class="w-full {className}" data-chart-canvas="">
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
    onkeydown={keydown}
  >
    {#each scene.marks as mark (mark.key)}
      {#if mark.kind === 'rect'}
        <rect
          data-role={mark.role}
          data-chart-key={mark.target ? mark.key : undefined}
          data-selected={mark.selected ? '' : undefined}
          x={mark.x}
          y={mark.y}
          width={mark.width}
          height={mark.height}
          rx={mark.radius}
          opacity={mark.opacity}
          pointer-events={pointerEvents(mark)}
          cursor={cursor(mark)}
          style:fill={mark.fill}
          style:stroke={mark.stroke}
          style:stroke-width={mark.strokeWidth}
        />
      {:else if mark.kind === 'path'}
        <path
          data-role={mark.role}
          data-chart-key={mark.target ? mark.key : undefined}
          data-selected={mark.selected ? '' : undefined}
          d={mark.d}
          stroke-linejoin="round"
          stroke-linecap="round"
          stroke-dasharray={mark.dash}
          opacity={mark.opacity}
          pointer-events={pointerEvents(mark)}
          cursor={cursor(mark)}
          style:fill={mark.fill ?? 'none'}
          style:stroke={mark.stroke}
          style:stroke-width={mark.strokeWidth}
        />
      {:else if mark.kind === 'circle'}
        <circle
          data-role={mark.role}
          data-chart-key={mark.target ? mark.key : undefined}
          data-selected={mark.selected ? '' : undefined}
          cx={mark.cx}
          cy={mark.cy}
          r={mark.r}
          opacity={mark.opacity}
          pointer-events={pointerEvents(mark)}
          cursor={cursor(mark)}
          style:fill={mark.fill}
          style:stroke={mark.stroke}
          style:stroke-width={mark.strokeWidth}
        />
      {:else if mark.kind === 'line'}
        <line
          data-role={mark.role}
          data-chart-key={mark.target ? mark.key : undefined}
          data-selected={mark.selected ? '' : undefined}
          x1={mark.x1}
          y1={mark.y1}
          x2={mark.x2}
          y2={mark.y2}
          stroke-dasharray={mark.dash}
          opacity={mark.opacity}
          pointer-events={pointerEvents(mark)}
          cursor={cursor(mark)}
          style:stroke={mark.stroke}
          style:stroke-width={mark.strokeWidth}
        />
      {:else}
        <text
          data-role={mark.role}
          data-chart-key={mark.target ? mark.key : undefined}
          data-selected={mark.selected ? '' : undefined}
          x={mark.x}
          y={mark.y}
          text-anchor={mark.anchor}
          dominant-baseline={chartTextBaseline(mark.baseline)}
          transform={chartTextTransform(mark)}
          opacity={mark.opacity}
          pointer-events={pointerEvents(mark)}
          cursor={cursor(mark)}
          style:fill={mark.fill}
          style:font-size="{mark.size}px"
          style:font-weight={mark.weight}
          style:font-family={scene.theme.fontFamily}
          style:user-select="none">{mark.text}</text
        >
      {/if}
    {/each}
  </svg>
</div>
