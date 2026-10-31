<script lang="ts">
  import ImageCheckbox from './controls/ImageCheckbox.svelte';
  import ImageRange from './controls/ImageRange.svelte';
  import ImageSelect from './controls/ImageSelect.svelte';
  import { imageSectionTitleClass } from './styles.js';
  import type { ContentAwareFillSettings, CropBox, ImageEditorController } from '@pixerate/editor/image-editor';
  import { CONTENT_AWARE_FILL_SAMPLING, CONTENT_AWARE_FILL_TOOLS, ContentAwareFillSession } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  /**
   * Content-Aware Fill: a full-window workspace with the selection's surroundings on the left, the
   * sampling area shown in green and painted with the Sampling Brush (Alt subtracts), and a live
   * preview of the fill on the right. OK fills as one undo step, the same fill the
   * `content_aware_fill` tool makes; Cancel and Escape change nothing.
   */
  interface Props {
    controller: ImageEditorController;
    /** Called with the result after OK, or `null` after Cancel. */
    onclose: (result: { layerId: string; bounds: CropBox; output: 'current' | 'new-layer' | 'duplicate-layer' } | null) => void;
    class?: string;
  }

  let { controller, onclose, class: className = '' }: Props = $props();

  const session = untrack(() => new ContentAwareFillSession(controller));
  let tick = $state(0);
  let zoom = $state(1);
  let pan = $state({ x: 0, y: 0 });
  let busy = $state(false);
  let error = $state<string | null>(null);
  let source: HTMLCanvasElement | undefined = $state();
  let preview: HTMLCanvasElement | undefined = $state();
  let panFrom: { x: number; y: number; pan: { x: number; y: number } } | null = null;

  // Untracked: opening emits before its first await, and `tick++` reads `tick`.
  $effect(() =>
    untrack(() => {
      const off = session.subscribe(() => tick++);
      void session.open();
      return off;
    })
  );

  const settings = $derived.by(() => {
    void tick;
    return session.settings;
  });
  const win = $derived.by(() => {
    void tick;
    return session.window;
  });
  const computing = $derived.by(() => {
    void tick;
    return session.computing;
  });
  const wholeImage = $derived.by(() => {
    void tick;
    return session.showsWholeImage;
  });
  const sessionError = $derived.by(() => {
    void tick;
    return session.error;
  });

  // Draw both views whenever the session changes.
  $effect(() => {
    void tick;
    if (!win || typeof ImageData === 'undefined') return;
    for (const [canvas, rgba] of [
      [source, session.renderSource()],
      [preview, session.renderPreview()],
    ] as const) {
      const ctx = canvas?.getContext?.('2d');
      if (!canvas || !ctx || !rgba.length) continue;
      canvas.width = win.width;
      canvas.height = win.height;
      ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, win.width, win.height), 0, 0);
    }
  });

  const set = (changes: Partial<ContentAwareFillSettings>) => session.update(changes);

  async function ok() {
    busy = true;
    error = null;
    try {
      onclose(await session.commit());
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      busy = false;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === 'Escape') onclose(null);
    else if (e.key === 'Enter') void ok();
    else if (e.ctrlKey || e.metaKey || e.altKey || !session.handleKey(e.key)) return;
    e.preventDefault();
  }

  /** The pointer's position in document pixels on the source view. */
  function toImage(e: PointerEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const w = win ?? { x: 0, y: 0, width: 1, height: 1 };
    return { x: w.x + ((e.clientX - rect.left) / Math.max(1, rect.width)) * w.width, y: w.y + ((e.clientY - rect.top) / Math.max(1, rect.height)) * w.height };
  }
  function onpointerdown(e: PointerEvent) {
    if (settings.tool === 'hand') {
      panFrom = { x: e.clientX, y: e.clientY, pan };
      return;
    }
    if (settings.tool === 'zoom') {
      zoom = Math.min(16, Math.max(0.25, e.altKey ? zoom / 1.25 : zoom * 1.25));
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    session.begin(toImage(e), { altKey: e.altKey });
  }
  function onpointermove(e: PointerEvent) {
    if (panFrom) {
      pan = { x: panFrom.pan.x + e.clientX - panFrom.x, y: panFrom.pan.y + e.clientY - panFrom.y };
      return;
    }
    if (e.buttons) session.move(toImage(e));
  }
  function onpointerup() {
    panFrom = null;
    session.end();
  }

  const button =
    'px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';
  const toggle = (on: boolean) => `${button} ${on ? 'bg-primary text-primary-foreground border-primary' : ''}`;
</script>

<svelte:window {onkeydown} />

<div data-testid="content-aware-fill-workspace" role="dialog" aria-label="Content-Aware Fill" class="fixed inset-0 z-50 flex bg-background text-xs text-foreground {className}">
  <div role="group" aria-label="Content-Aware Fill tool" class="flex flex-col gap-1 p-2 border-r border-border">
    {#each CONTENT_AWARE_FILL_TOOLS as t (t.id)}
      <button type="button" title="{t.label} ({t.key.toUpperCase()})" aria-pressed={settings.tool === t.id} class={toggle(settings.tool === t.id)} onclick={() => set({ tool: t.id })}>
        {t.label}
      </button>
    {/each}
  </div>
  <div class="flex-1 flex flex-col min-w-0">
    <div class="flex flex-wrap items-center gap-2 p-2 border-b border-border">
      {#if settings.tool === 'sampling-brush'}
        <label class="flex items-center gap-1 text-muted-foreground">
          Size
          <input
            type="number"
            min="1"
            aria-label="Sampling brush size"
            value={settings.brushSize}
            oninput={(e) => set({ brushSize: Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 1) })}
            class="w-16 bg-background border border-border rounded px-1 py-0.5 text-foreground"
          />
          px
        </label>
        <div role="group" aria-label="Sampling brush mode" class="flex gap-1">
          <button type="button" aria-pressed={settings.brushMode === 'add'} class={toggle(settings.brushMode === 'add')} onclick={() => set({ brushMode: 'add' })}>Add</button>
          <button type="button" aria-pressed={settings.brushMode === 'subtract'} class={toggle(settings.brushMode === 'subtract')} onclick={() => set({ brushMode: 'subtract' })}>
            Subtract
          </button>
        </div>
      {/if}
      <span class="font-mono text-muted-foreground">{Math.round(zoom * 100)}%</span>
      {#if !wholeImage}
        <button type="button" class={button} title="Show (and sample from) more of the image around the selection" onclick={() => session.expandView()}>Expand View</button>
      {/if}
      {#if computing}
        <span role="status" class="text-muted-foreground">Updating preview…</span>
      {/if}
    </div>
    <div class="flex-1 grid grid-cols-2 gap-2 p-2 min-h-0">
      <div class="flex flex-col min-h-0">
        <span class="text-muted-foreground">Source (green: sampling area)</span>
        <div class="flex-1 overflow-hidden flex items-center justify-center bg-muted/30">
          <canvas
            bind:this={source}
            data-testid="content-aware-fill-source"
            {onpointerdown}
            {onpointermove}
            {onpointerup}
            style:max-width="100%"
            style:max-height="100%"
            style:transform="translate({pan.x}px, {pan.y}px) scale({zoom})"
            style:image-rendering={zoom > 2 ? 'pixelated' : undefined}
            style:cursor={settings.tool === 'hand' ? 'grab' : settings.tool === 'zoom' ? 'zoom-in' : 'crosshair'}
          ></canvas>
        </div>
      </div>
      <div class="flex flex-col min-h-0">
        <span class="text-muted-foreground">Preview</span>
        <div class="flex-1 overflow-hidden flex items-center justify-center bg-muted/30">
          <canvas
            bind:this={preview}
            data-testid="content-aware-fill-preview"
            style:max-width="100%"
            style:max-height="100%"
            style:transform="translate({pan.x}px, {pan.y}px) scale({zoom})"
            style:image-rendering={zoom > 2 ? 'pixelated' : undefined}
          ></canvas>
        </div>
      </div>
    </div>
  </div>
  <div class="w-64 flex flex-col gap-3 p-3 border-l border-border overflow-y-auto">
    <span class={imageSectionTitleClass}>Sampling Area Options</span>
    <div role="group" aria-label="Sampling area" class="flex gap-1">
      {#each CONTENT_AWARE_FILL_SAMPLING as m (m.id)}
        <button type="button" aria-pressed={settings.sampling === m.id} class={toggle(settings.sampling === m.id)} onclick={() => set({ sampling: m.id })}>{m.label}</button>
      {/each}
    </div>
    <label class="flex items-center gap-2">
      <ImageCheckbox label="Show Sampling Area" checked={settings.showSampling} onchange={(on) => set({ showSampling: on })} />
      Show Sampling Area
    </label>
    <label class="flex flex-col gap-1">
      <span class="flex justify-between text-muted-foreground">
        <span>Opacity</span>
        <span class="font-mono">{Math.round(settings.opacity * 100)}%</span>
      </span>
      <ImageRange label="Sampling overlay opacity" min={0} max={100} step={1} value={Math.round(settings.opacity * 100)} oninput={(v) => set({ opacity: v / 100 })} />
    </label>

    <span class={imageSectionTitleClass}>Fill Settings</span>
    <label class="flex items-center gap-2 text-muted-foreground">
      Seed
      <input
        type="number"
        min="0"
        aria-label="Fill seed"
        value={settings.seed}
        oninput={(e) => set({ seed: Math.max(0, Math.round(Number((e.currentTarget as HTMLInputElement).value) || 0)) })}
        class="w-16 bg-background border border-border rounded px-1 py-0.5 text-foreground"
      />
      <button type="button" class={button} onclick={() => set({ seed: settings.seed + 1 })}>Try Another</button>
    </label>
    <label class="flex items-center gap-2">
      <ImageCheckbox label="Live Preview" checked={settings.livePreview} onchange={(on) => set({ livePreview: on })} />
      Live Preview
    </label>
    {#if !settings.livePreview}
      <button type="button" class={button} disabled={computing} onclick={() => void session.refresh()}>Preview</button>
    {/if}

    <span class={imageSectionTitleClass}>Output Settings</span>
    <label class="flex items-center gap-2">
      Output To
      <ImageSelect
        label="Fill output"
        value={settings.output}
        options={[
          { value: 'new-layer', label: 'New Layer' },
          { value: 'current', label: 'Current Layer' },
          { value: 'duplicate-layer', label: 'Duplicate Layer' },
        ]}
        onchange={(v) => set({ output: v as 'current' | 'new-layer' | 'duplicate-layer' })}
      />
    </label>
    {#if error ?? sessionError}
      <p role="alert" class="text-destructive">{error ?? sessionError}</p>
    {/if}
    <div class="flex gap-1 mt-auto">
      <button type="button" class={button} onclick={() => session.reset()}>Reset</button>
      <button type="button" class={button} onclick={() => onclose(null)}>Cancel</button>
      <button type="button" class={toggle(true)} disabled={busy || !win} aria-busy={busy} onclick={() => void ok()}>OK</button>
    </div>
  </div>
</div>
