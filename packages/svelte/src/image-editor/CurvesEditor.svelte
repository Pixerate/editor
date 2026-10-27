<script lang="ts">
  import type { CurvePoint, ImageHistogram } from '@pixerate/editor/image-editor';
  import {
    boxToCurvePoint,
    curvePointToBox,
    curveSvgPath,
    hitTestCurvePoint,
    histogramPath,
    insertCurvePoint,
    moveCurvePoint,
    removeCurvePoint,
  } from '@pixerate/editor/image-editor';

  interface Props {
    points: CurvePoint[];
    /** `commit` is true for the first change of a gesture (one undo step), false for the drag moves. */
    onchange: (points: CurvePoint[], commit: boolean) => void;
    histogram?: ImageHistogram | null;
    channel?: 'master' | 'red' | 'green' | 'blue';
    size?: number;
    /** Extra classes on the root element. */
    class?: string;
  }

  let { points, onchange, histogram = null, channel = 'master', size = 200, class: className = '' }: Props = $props();

  const BOX = 256;
  const STROKE = { master: 'var(--foreground, #e2e8f0)', red: '#ef4444', green: '#22c55e', blue: '#3b82f6' };

  let svgEl: SVGSVGElement | undefined = $state();
  let drag: number | null = $state(null);

  function toBox(e: MouseEvent) {
    const rect = svgEl?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return { x: 0, y: 0 };
    return { x: ((e.clientX - rect.left) / rect.width) * BOX, y: ((e.clientY - rect.top) / rect.height) * BOX };
  }

  function onpointerdown(e: PointerEvent) {
    const { x, y } = toBox(e);
    let index = hitTestCurvePoint(points, x, y, BOX, BOX, 10);
    if (index === -1) {
      const inserted = insertCurvePoint(points, boxToCurvePoint(x, y, BOX, BOX));
      onchange(inserted.points, true);
      index = inserted.index;
    } else {
      onchange(points, true);
    }
    drag = index;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onpointermove(e: PointerEvent) {
    if (drag === null) return;
    const { x, y } = toBox(e);
    onchange(moveCurvePoint(points, drag, boxToCurvePoint(x, y, BOX, BOX)), false);
  }

  function ondblclick(e: MouseEvent) {
    const { x, y } = toBox(e);
    const index = hitTestCurvePoint(points, x, y, BOX, BOX, 10);
    if (index !== -1 && points.length > 2) onchange(removeCurvePoint(points, index), true);
  }

  const histChannel = $derived(channel === 'master' ? 'luminance' : channel);
</script>

<!-- Curves editor over the histogram: click to add a point, drag to move it, double-click to remove it. -->
<svg
  bind:this={svgEl}
  viewBox="0 0 {BOX} {BOX}"
  width={size}
  height={size}
  role="application"
  aria-label="{channel} curve"
  data-testid="curves-editor"
  class="rounded bg-muted/40 touch-none select-none cursor-crosshair {className}"
  {onpointerdown}
  {onpointermove}
  onpointerup={() => (drag = null)}
  onpointercancel={() => (drag = null)}
  {ondblclick}
>
  {#if histogram && histogram.samples > 0}
    <path d={histogramPath(histogram, histChannel, BOX, BOX)} fill="rgba(148, 163, 184, 0.25)" />
  {/if}
  {#each [64, 128, 192] as v (v)}
    <g stroke="rgba(148, 163, 184, 0.2)" stroke-width="1">
      <line x1={v} y1="0" x2={v} y2={BOX} />
      <line x1="0" y1={v} x2={BOX} y2={v} />
    </g>
  {/each}
  <line x1="0" y1={BOX} x2={BOX} y2="0" stroke="rgba(148, 163, 184, 0.35)" stroke-dasharray="4 4" />
  <path d={curveSvgPath(points, BOX, BOX)} fill="none" stroke={STROKE[channel]} stroke-width="2" />
  {#each points as p, i (i)}
    {@const b = curvePointToBox(p, BOX, BOX)}
    <circle
      cx={b.x}
      cy={b.y}
      r="5"
      fill={drag === i ? STROKE[channel] : 'var(--background, #0f172a)'}
      stroke={STROKE[channel]}
      stroke-width="2"
      aria-label="Point {p.input} to {p.output}"
    />
  {/each}
</svg>
