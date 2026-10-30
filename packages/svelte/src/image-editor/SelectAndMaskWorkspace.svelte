<script lang="ts">
  import ImageCheckbox from './controls/ImageCheckbox.svelte';
  import ImageRange from './controls/ImageRange.svelte';
  import ImageSelect from './controls/ImageSelect.svelte';
  import { imageSectionTitleClass } from './styles.js';
  import type { ImageEditorController, RefineOutput, RefineOutputResult, SelectAndMaskSettings, SelectAndMaskView } from '@pixerate/editor/image-editor';
  import { REFINE_EDGE_CONTROLS, REFINE_OUTPUTS, SELECT_AND_MASK_TOOLS, SELECT_AND_MASK_VIEWS, SelectAndMaskSession } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  /**
   * Select and Mask: a full-window workspace over the editor with its own tools, view modes, edge
   * and output settings, and a live preview. OK applies everything as one undo step, the same
   * `refineSelectionTo` call an agent makes; Cancel leaves the document as it was. Keys as in
   * Photoshop, plus Enter (OK), Escape (Cancel) and Ctrl/⌘+Z (undo the last stroke).
   */
  interface Props {
    controller: ImageEditorController;
    /** Called with the result after OK, or `null` after Cancel. */
    onclose: (result: RefineOutputResult | null) => void;
    class?: string;
  }

  let { controller, onclose, class: className = '' }: Props = $props();

  const session = untrack(() => new SelectAndMaskSession(controller));
  let tick = $state(0);
  let zoom = $state(1);
  let pan = $state({ x: 0, y: 0 });
  let busy = $state(false);
  let error = $state<string | null>(null);
  let canvas: HTMLCanvasElement | undefined = $state();
  let panFrom: { x: number; y: number; pan: { x: number; y: number } } | null = null;

  $effect(() => {
    const off = session.subscribe(() => tick++);
    void session.open();
    return off;
  });

  const settings = $derived.by(() => {
    void tick;
    return session.settings;
  });
  const size = $derived.by(() => {
    void tick;
    return session.previewSize;
  });
  const edits = $derived.by(() => {
    void tick;
    return session.edits.length;
  });
  const sessionError = $derived.by(() => {
    void tick;
    return session.error;
  });
  const note = $derived.by(() => {
    void tick;
    return session.note;
  });

  // Draw the preview whenever it changes.
  $effect(() => {
    void tick;
    const ctx = canvas?.getContext?.('2d');
    if (!canvas || !ctx || !size.width || typeof ImageData === 'undefined') return;
    canvas.width = size.width;
    canvas.height = size.height;
    ctx.putImageData(new ImageData(session.render() as Uint8ClampedArray<ArrayBuffer>, size.width, size.height), 0, 0);
  });

  const set = (changes: Partial<SelectAndMaskSettings>) => session.update(changes);

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
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') session.undoEdit();
    else if (e.ctrlKey || e.metaKey || e.altKey || !session.handleKey(e.key)) return;
    e.preventDefault();
  }

  /** The pointer's position in natural image pixels. */
  function toImage(e: PointerEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const naturalW = size.width / size.scale;
    const naturalH = size.height / size.scale;
    return { x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * naturalW, y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * naturalH };
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

  const toLayer = $derived(settings.output === 'new-layer' || settings.output === 'new-layer-with-mask');
  const brushTool = $derived(settings.tool === 'quick-select' || settings.tool === 'brush' || settings.tool === 'refine-brush');

  const button =
    'px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';
  const toggle = (on: boolean) => `${button} ${on ? 'bg-primary text-primary-foreground border-primary' : ''}`;
</script>

<svelte:window {onkeydown} />

<div data-testid="select-and-mask-workspace" role="dialog" aria-label="Select and Mask" class="fixed inset-0 z-50 flex bg-background text-xs text-foreground {className}">
  <div role="group" aria-label="Select and Mask tool" class="flex flex-col gap-1 p-2 border-r border-border">
    {#each SELECT_AND_MASK_TOOLS as t (t.id)}
      <button type="button" title="{t.label} ({t.key.toUpperCase()})" aria-pressed={settings.tool === t.id} class={toggle(settings.tool === t.id)} onclick={() => set({ tool: t.id })}>
        {t.label}
      </button>
    {/each}
  </div>
  <div class="flex-1 flex flex-col min-w-0">
    <div class="flex flex-wrap items-center gap-2 p-2 border-b border-border">
      {#if brushTool}
        <label class="flex items-center gap-1 text-muted-foreground">
          Size
          <input
            type="number"
            min="1"
            aria-label="Brush size"
            value={settings.brushSize}
            oninput={(e) => set({ brushSize: Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 1) })}
            class="w-16 bg-background border border-border rounded px-1 py-0.5 text-foreground"
          />
          px
        </label>
      {/if}
      {#if settings.tool !== 'refine-brush' && settings.tool !== 'hand' && settings.tool !== 'zoom'}
        <div role="group" aria-label="Stroke mode" class="flex gap-1">
          <button type="button" aria-pressed={settings.brushMode === 'add'} class={toggle(settings.brushMode === 'add')} onclick={() => set({ brushMode: 'add' })}>Add</button>
          <button type="button" aria-pressed={settings.brushMode === 'subtract'} class={toggle(settings.brushMode === 'subtract')} onclick={() => set({ brushMode: 'subtract' })}>
            Subtract
          </button>
        </div>
      {/if}
      <span class="text-muted-foreground">{edits} strokes</span>
      <button type="button" class={button} disabled={!edits} onclick={() => session.undoEdit()}>Undo Stroke</button>
      <span class="font-mono text-muted-foreground">{Math.round(zoom * 100)}%</span>
    </div>
    <div class="flex-1 overflow-hidden flex items-center justify-center bg-muted/30">
      <canvas
        bind:this={canvas}
        data-testid="select-and-mask-preview"
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
  <div class="w-64 flex flex-col gap-3 p-3 border-l border-border overflow-y-auto">
    <span class={imageSectionTitleClass}>View Mode</span>
    <label class="flex items-center gap-2">
      View
      <ImageSelect
        label="View"
        value={settings.view}
        options={SELECT_AND_MASK_VIEWS.map((v) => ({ value: v.id, label: `${v.label} (${v.key.toUpperCase()})` }))}
        onchange={(v) => set({ view: v as SelectAndMaskView })}
      />
    </label>
    <label class="flex flex-col gap-1">
      <span class="flex justify-between text-muted-foreground">
        <span>Opacity</span>
        <span class="font-mono">{Math.round(settings.opacity * 100)}%</span>
      </span>
      <ImageRange label="View opacity" min={0} max={100} step={1} value={Math.round(settings.opacity * 100)} oninput={(v) => set({ opacity: v / 100 })} />
    </label>
    <label class="flex items-center gap-2">
      <ImageCheckbox label="Show Edge" checked={settings.showEdge} onchange={(on) => set({ showEdge: on })} />
      Show Edge (J)
    </label>
    <label class="flex items-center gap-2">
      <ImageCheckbox label="Show Original" checked={settings.showOriginal} onchange={(on) => set({ showOriginal: on })} />
      Show Original (P)
    </label>
    <label class="flex items-center gap-2">
      <ImageCheckbox label="Real-Time Refinement" checked={settings.realTime} onchange={(on) => set({ realTime: on })} />
      Real-Time Refinement
    </label>
    <label class="flex items-center gap-2">
      <ImageCheckbox label="High Quality Preview" checked={settings.highQuality} onchange={(on) => set({ highQuality: on })} />
      High Quality Preview
    </label>

    <span class={imageSectionTitleClass}>Edge Detection and Refinement</span>
    {#if controller.segmentationProvider}
      <label class="flex items-center gap-2">
        Mode
        <ImageSelect
          label="Refine mode"
          value={settings.refineMode}
          options={[
            { value: 'color', label: 'Color Aware' },
            { value: 'object', label: 'Object Aware' },
          ]}
          onchange={(v) => set({ refineMode: v as 'color' | 'object' })}
        />
      </label>
    {/if}
    {#each REFINE_EDGE_CONTROLS as c (c.id)}
      <label class="flex flex-col gap-1">
        <span class="flex justify-between text-muted-foreground">
          <span>{c.label}</span>
          <span class="font-mono">{settings.params[c.id]}{c.unit}</span>
        </span>
        <ImageRange label="Workspace {c.label}" min={c.min} max={c.max} step={c.step} value={settings.params[c.id]} oninput={(v) => set({ params: { ...settings.params, [c.id]: v } })} />
      </label>
    {/each}
    <label class="flex items-center gap-2">
      <ImageCheckbox label="Workspace Smart Radius" checked={settings.params.smartRadius} onchange={(on) => set({ params: { ...settings.params, smartRadius: on } })} />
      Smart Radius
    </label>

    <span class={imageSectionTitleClass}>Output Settings</span>
    <label class="flex flex-col gap-1">
      <span class="flex justify-between text-muted-foreground">
        <span>Decontaminate Colors{toLayer ? '' : ' (new layer outputs)'}</span>
        <span class="font-mono">{settings.decontaminate}%</span>
      </span>
      <ImageRange label="Workspace decontaminate amount" min={0} max={100} step={1} value={settings.decontaminate} disabled={!toLayer} oninput={(v) => set({ decontaminate: v })} />
    </label>
    <label class="flex items-center gap-2">
      Output To
      <ImageSelect label="Output to" value={settings.output} options={REFINE_OUTPUTS.map((o) => ({ value: o.id, label: o.label }))} onchange={(v) => set({ output: v as RefineOutput })} />
    </label>
    <label class="flex items-center gap-2">
      <ImageCheckbox label="Remember Settings" checked={settings.remember} onchange={(on) => set({ remember: on })} />
      Remember Settings
    </label>
    {#if error ?? sessionError}
      <p role="alert" class="text-destructive">{error ?? sessionError}</p>
    {/if}
    {#if note}
      <p class="text-muted-foreground">{note}</p>
    {/if}
    <div class="flex gap-1 mt-auto">
      <button type="button" class={button} onclick={() => session.reset()}>Reset</button>
      <button type="button" class={button} onclick={() => onclose(null)}>Cancel</button>
      <button type="button" class={toggle(true)} disabled={busy} aria-busy={busy} onclick={() => void ok()}>OK</button>
    </div>
  </div>
</div>
