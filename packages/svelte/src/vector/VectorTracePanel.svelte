<script lang="ts">
  import type { VectorEditorController } from '@pixerate/editor/vector';

  /**
   * Image Trace: pick an image file and trace it into paths, in one colour (dark areas) or a
   * stacked path per colour. The traced group goes on the artboard at its width. One undo step.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  let input: HTMLInputElement | undefined = $state();
  let mode: 'threshold' | 'color' = $state('threshold');
  let colors = $state(6);
  let message: string | null = $state(null);

  /** Decodes an image file in the browser into RGBA pixels (at most `max` pixels, scaled down to fit). */
  async function filePixels(file: File, max = 1_000_000) {
    const bitmap = await createImageBitmap(file);
    const k = Math.min(1, Math.sqrt(max / (bitmap.width * bitmap.height)));
    const width = Math.max(1, Math.round(bitmap.width * k));
    const height = Math.max(1, Math.round(bitmap.height * k));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, width, height);
    return { width, height, data: ctx.getImageData(0, 0, width, height).data };
  }

  async function trace(file: File) {
    try {
      const pixels = await filePixels(file);
      const doc = controller.getState().document;
      const width = Math.min(doc.width, pixels.width);
      const r = controller.traceImage(pixels, { mode, colors, width, name: file.name.replace(/\.[^.]+$/, '') || 'Image Trace' });
      message = r.ok ? null : r.message;
    } catch {
      message = 'That file could not be read as an image.';
    }
  }

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  const numberClass = 'h-7 w-12 rounded border border-border bg-background px-1.5 text-xs';
</script>

<div class="space-y-1 {className}" data-vector-trace-panel="" aria-label="Image trace">
  <div class="flex items-center gap-1">
    <span class="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Trace</span>
    <select aria-label="Trace mode" class={selectClass} bind:value={mode}>
      <option value="threshold">Black &amp; white</option>
      <option value="color">Colours</option>
    </select>
    {#if mode === 'color'}
      <input type="number" min="2" max="32" aria-label="Trace colours" title="Colours" class={numberClass} value={colors} oninput={(e) => (colors = Math.max(2, Math.min(32, parseInt(e.currentTarget.value, 10) || 2)))} />
    {/if}
    <button type="button" class={buttonClass} data-vector-trace-action="" title="Image Trace: pick an image to turn into paths" onclick={() => input?.click()}>Image…</button>
    <input
      bind:this={input}
      type="file"
      accept="image/*"
      hidden
      onchange={(e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        if (file) void trace(file);
      }}
    />
  </div>
  {#if message}<p class="text-[11px] text-red-600">{message}</p>{/if}
</div>
