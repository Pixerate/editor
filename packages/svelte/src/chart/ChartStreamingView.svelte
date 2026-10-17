<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import {
    CSS_VARIABLE_CHART_THEME,
    ChartStream,
    blendChartScenes,
    easeChartTween,
    layoutChart,
    type ChartIssue,
    type ChartScene,
    type ChartStreamFormat,
    type ChartTheme
  } from '@pixerate/editor/chart';
  import type { Snippet } from 'svelte';
  import ChartSceneSvg from './ChartSceneSvg.svelte';

  interface Props {
    /** Mermaid (xychart-beta, pie, radar-beta) or a JSON chart spec, as far as it has arrived. */
    source: string;
    /** Nothing more will arrive: the final chart is drawn at once and problems are reported. */
    complete?: boolean;
    format?: ChartStreamFormat;
    width?: number;
    height?: number;
    theme?: Partial<ChartTheme>;
    /** How often a new layout is adopted while streaming (ms, default 300). */
    adoptInterval?: number;
    /** Tween length between layouts (ms, default 450; 0 to switch at once). */
    tween?: number;
    /** Shown before anything can be drawn. */
    placeholder?: Snippet;
    /** Called with the parse problems once `complete`. */
    onissues?: (issues: ChartIssue[]) => void;
    class?: string;
  }

  let { source, complete = false, format = 'auto', width = 640, height = 360, theme, adoptInterval = 300, tween = 450, placeholder, onissues, class: className = '' }: Props = $props();

  const stream = $derived(new ChartStream(format));
  const fullTheme = $derived({ ...CSS_VARIABLE_CHART_THEME, ...theme });
  let scene: ChartScene | null = $state.raw(null);
  let lastAdopt = 0;
  let frame: number | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;

  function adopt(src: string, done: boolean) {
    const read = stream.update(src, done);
    if (done) onissues?.(read.issues);
    if (!read.spec) return;
    const next = layoutChart(read.spec, { width, height, theme: fullTheme, valueDomain: read.valueDomain });
    const from = untrack(() => scene);
    lastAdopt = Date.now();
    if (frame !== null) cancelAnimationFrame(frame);
    if (!from || tween <= 0 || typeof requestAnimationFrame === 'undefined') {
      scene = next;
      return;
    }
    const start = performance.now();
    const step = () => {
      const t = easeChartTween((performance.now() - start) / tween);
      scene = blendChartScenes(from, next, t);
      frame = t < 1 ? requestAnimationFrame(step) : null;
    };
    frame = requestAnimationFrame(step);
  }

  $effect(() => {
    const src = source;
    const done = complete;
    if (pending) clearTimeout(pending);
    const wait = done ? 0 : Math.max(0, adoptInterval - (Date.now() - lastAdopt));
    if (wait === 0) adopt(src, done);
    else pending = setTimeout(() => adopt(src, done), wait);
    return () => {
      if (pending) clearTimeout(pending);
    };
  });

  onDestroy(() => {
    if (frame !== null) cancelAnimationFrame(frame);
  });
</script>

<div class={className} data-chart-streaming={complete ? 'complete' : 'streaming'} aria-busy={!complete}>
  {#if scene}
    <ChartSceneSvg {scene} label={complete ? undefined : 'Chart loading'} />
  {:else if placeholder}
    {@render placeholder()}
  {:else}
    <div style:height="{height}px" class="flex items-center justify-center text-xs text-muted-foreground">Drawing chart…</div>
  {/if}
</div>
