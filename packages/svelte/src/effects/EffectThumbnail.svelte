<script lang="ts">
  import { renderEffectThumbnail, type EffectProvider, type EffectSummary } from '@pixerate/editor/effects';

  interface Props {
    provider: EffectProvider;
    effect: EffectSummary;
    /** Pixel size of the preview (default 96 × 54). */
    width?: number;
    height?: number;
    class?: string;
  }

  let { provider, effect: item, width = 96, height = 54, class: className = '' }: Props = $props();
  let canvas = $state<HTMLCanvasElement | null>(null);
  let failed = $state(false);

  $effect(() => {
    failed = item.kind === 'motion';
    if (failed) return;
    let live = true;
    renderEffectThumbnail(provider, item, { width, height }).then(
      (pixels) => {
        const ctx = live ? canvas?.getContext('2d') : null;
        if (!ctx || typeof ImageData === 'undefined') return;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
      },
      () => {
        if (live) failed = true;
      },
    );
    return () => {
      live = false;
    };
  });
</script>

<!-- A preview of an effect drawn by the provider's own renderer; motion effects and failures show a label. -->
<div
  class="relative overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#8884_0_25%,transparent_0_50%)] bg-[length:12px_12px] {className}"
  style="aspect-ratio: {width} / {height}"
  data-effect-thumbnail={item.id}
>
  {#if failed}
    <span class="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">{item.kind === 'motion' ? 'Motion' : 'No preview'}</span>
  {:else}
    <canvas bind:this={canvas} {width} {height} class="h-full w-full" aria-hidden="true"></canvas>
  {/if}
</div>
