<script lang="ts">
  import type { ImageHistogram } from '@pixerate/editor/image-editor';
  import { histogramPath } from '@pixerate/editor/image-editor';

  interface Props {
    histogram: ImageHistogram | null;
    /** `rgb` overlays the three channels on the luminance; a single channel draws just that one. */
    channel?: 'rgb' | 'luminance' | 'red' | 'green' | 'blue';
    height?: number;
    class?: string;
  }

  let { histogram, channel = 'rgb', height = 64, class: className = '' }: Props = $props();

  const W = 256;
  const FILL: Record<'luminance' | 'red' | 'green' | 'blue', string> = {
    luminance: 'rgba(148, 163, 184, 0.45)',
    red: 'rgba(239, 68, 68, 0.45)',
    green: 'rgba(34, 197, 94, 0.45)',
    blue: 'rgba(59, 130, 246, 0.45)',
  };

  const channels = $derived(channel === 'rgb' ? (['luminance', 'red', 'green', 'blue'] as const) : ([channel] as const));
  const paths = $derived(
    histogram && histogram.samples > 0 ? channels.map((c) => ({ c, d: histogramPath(histogram, c, W, height) })) : []
  );
  const clipLow = $derived(histogram && histogram.samples ? Math.max(...histogram.shadows) / histogram.samples : 0);
  const clipHigh = $derived(histogram && histogram.samples ? Math.max(...histogram.highlights) / histogram.samples : 0);
</script>

<svg
  viewBox="0 0 {W} {height}"
  preserveAspectRatio="none"
  role="img"
  aria-label={histogram ? `Histogram of ${histogram.samples} pixels` : 'Histogram (no data)'}
  data-testid="image-editor-histogram"
  class="w-full rounded bg-muted/40 {className}"
  style="height: {height}px"
>
  {#each paths as p (p.c)}
    <path d={p.d} fill={FILL[p.c]} stroke="none" />
  {/each}
  {#if clipLow > 0.005}
    <rect x="0" y="0" width="3" {height} fill="#3b82f6" data-testid="histogram-clip-shadows" />
  {/if}
  {#if clipHigh > 0.005}
    <rect x={W - 3} y="0" width="3" {height} fill="#ef4444" data-testid="histogram-clip-highlights" />
  {/if}
</svg>
