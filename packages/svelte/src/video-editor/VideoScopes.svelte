<script lang="ts">
  import { readVideoScopesPanel, VIDEO_SCOPE_KINDS, type VideoEditorController, type VideoScopeKind, type VideoScopesPanelReading } from '@pixerate/editor/video-editor';

  interface Props {
    controller: VideoEditorController;
    /** Which scopes to show, in order (default histogram, waveform and vectorscope). */
    scopes?: readonly VideoScopeKind[];
    /** Size of the histogram and waveform in pixels (default 256 × 128); the vectorscope is square, `height` a side. */
    width?: number;
    height?: number;
    class?: string;
  }

  let { controller, scopes = VIDEO_SCOPE_KINDS, width = 256, height = 128, class: className = '' }: Props = $props();
  const LABELS: Record<VideoScopeKind, string> = { histogram: 'Histogram', waveform: 'Luma waveform', vectorscope: 'Vectorscope' };
  const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
  const canvases: Partial<Record<VideoScopeKind, HTMLCanvasElement>> = $state({});
  let reading: VideoScopesPanelReading = $state.raw({ ok: false, message: 'Show the preview to see its scopes.' });

  // Redraw after each preview frame, at most once an animation frame.
  $effect(() => {
    const feed = controller.previewPixels;
    const kinds = scopes;
    const size = { width, height };
    let frame = 0;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16) as unknown as number;
    const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : (id: number) => clearTimeout(id);
    const draw = () => {
      frame = 0;
      const next = readVideoScopesPanel(feed, kinds, size);
      reading = next;
      if (!next.ok) return;
      for (const kind of kinds) {
        const img = next.images[kind];
        const ctx = canvases[kind]?.getContext('2d');
        if (img && ctx && typeof ImageData !== 'undefined') ctx.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
      }
    };
    const schedule = () => {
      if (!frame) frame = raf(draw);
    };
    schedule();
    const off = feed.subscribe(schedule);
    return () => {
      off();
      if (frame) caf(frame);
    };
  });
</script>

<!-- Colour scopes of what this controller's <VideoPreview> draws, with exposure figures and notes. -->
<div class="flex flex-col gap-2 text-xs {className}" data-video-scopes="">
  <div class="flex flex-wrap gap-2">
    {#each scopes as kind (kind)}
      {@const w = kind === 'vectorscope' ? height : width}
      <figure class="m-0 flex min-w-0 max-w-full flex-col gap-1">
        <canvas bind:this={canvases[kind]} width={w} height={height} class="rounded border border-border bg-black" style="width:{w}px;max-width:100%;height:auto;aspect-ratio:{w} / {height}" aria-label={LABELS[kind]} data-scope={kind}></canvas>
        <figcaption class="text-[11px] text-muted-foreground">{LABELS[kind]}</figcaption>
      </figure>
    {/each}
  </div>
  {#if reading.ok}
    <div class="flex flex-col gap-0.5" data-scope-stats="">
      <div class="tabular-nums">
        Luma {reading.stats.luma.mean.toFixed(2)} mean · {reading.stats.luma.p1.toFixed(2)}–{reading.stats.luma.p99.toFixed(2)} · crushed {pct(reading.stats.clipped.shadows)} · blown {pct(reading.stats.clipped.highlights)} · average
        <span class="inline-block h-2.5 w-2.5 rounded-sm align-middle" style="background:{reading.stats.average}"></span>
        {reading.stats.average}
        {#if !reading.complete}<span class="text-muted-foreground"> · loading</span>{/if}
      </div>
      {#each reading.notes as note (note)}
        <div class="text-amber-500">{note}</div>
      {/each}
    </div>
  {:else}
    <div class="text-muted-foreground" data-scope-message="">{reading.message}</div>
  {/if}
</div>
