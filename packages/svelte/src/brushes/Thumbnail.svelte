<script lang="ts">
  interface Props {
    /** RGBA pixels drawn on a canvas, or an image URL (e.g. a brushstroke swatch's data URL). */
    image: { width: number; height: number; data: Uint8ClampedArray } | string | null;
    label: string;
    style?: string;
  }
  let { image, label, style = '' }: Props = $props();
  let canvas = $state<HTMLCanvasElement | null>(null);

  $effect(() => {
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !image || typeof image === 'string' || typeof ctx.createImageData !== 'function') return;
    canvas.width = image.width;
    canvas.height = image.height;
    const img = ctx.createImageData(image.width, image.height);
    img.data.set(image.data);
    ctx.putImageData(img, 0, 0);
  });
</script>

{#if typeof image === 'string'}
  <img src={image} alt={label} class="rounded object-contain" {style} />
{:else}
  <canvas bind:this={canvas} role="img" aria-label={label} class="rounded" {style} width={image?.width} height={image?.height}></canvas>
{/if}
