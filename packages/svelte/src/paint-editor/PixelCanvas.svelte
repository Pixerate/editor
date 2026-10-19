<script lang="ts">
  interface Props {
    pixels: { width: number; height: number; data: Uint8ClampedArray } | null;
    label: string;
    class?: string;
    style?: string;
  }
  let { pixels, label, class: className = '', style = '' }: Props = $props();
  let canvas = $state<HTMLCanvasElement | null>(null);

  $effect(() => {
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !pixels || typeof ctx.createImageData !== 'function') return;
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    const img = ctx.createImageData(pixels.width, pixels.height);
    img.data.set(pixels.data);
    ctx.putImageData(img, 0, 0);
  });
</script>

<canvas bind:this={canvas} aria-label={label} class={className} {style} width={pixels?.width} height={pixels?.height}></canvas>
