<script lang="ts">
  import { chartTextBaseline, chartTextTransform, type ChartMark } from '@pixerate/editor/chart';

  interface Props {
    marks: readonly ChartMark[];
    fontFamily: string;
    /** Marks with targets get a pointer cursor and receive events. */
    interactive?: boolean;
  }

  let { marks, fontFamily, interactive = false }: Props = $props();

  const pointerEvents = (mark: ChartMark) => (mark.role === 'selection' || mark.role === 'drag-readout' || (!mark.target && mark.role !== 'background') ? 'none' : undefined);
  const cursor = (mark: ChartMark) => (interactive && mark.target && mark.role !== 'background' ? 'pointer' : undefined);
</script>

{#each marks as mark (mark.key)}
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
      style:font-family={fontFamily}
      style:user-select="none">{mark.text}</text
    >
  {/if}
{/each}
