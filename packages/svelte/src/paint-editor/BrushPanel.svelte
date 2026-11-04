<script lang="ts">
  import StickerPicker from './StickerPicker.svelte';
  import { brushLoadColor, brushTakesPaint, downloadBytes, toggleStickerRef, DEFAULT_PAINT_GRADIENT, type PaintEditorController } from '@pixerate/editor/paint-editor';
  import { brushColourHex, PAINT_PROFILE, type Brush, type BrushLibraryEntry } from '@pixerate/editor/brushes';
  import { untrack } from 'svelte';
  import BrushEditor from '../brushes/BrushEditor.svelte';
  import BrushLibraryBrowser from '../brushes/BrushLibraryBrowser.svelte';
  import PaintGradientEditor from './PaintGradientEditor.svelte';
  import { attempt, button, chip, paintEditorState, panel } from './paintEditorRune.svelte.js';

  interface Props {
    controller: PaintEditorController;
    thumbnailWidth?: number;
    thumbnailHeight?: number;
    class?: string;
  }
  let { controller, thumbnailWidth = 112, thumbnailHeight = 32, class: className = '' }: Props = $props();
  const editor = paintEditorState(() => controller);
  const snap = $derived(editor.current);
  const brush = $derived(snap.brush);
  let error = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  const run = (fn: () => unknown) => attempt(fn, (m) => (error = m));
  // Thumbnails follow the library and the paper.
  // Separate deriveds keep their identity across unrelated changes, so thumbnails are not redrawn.
  const library = $derived(snap.brushes);
  const paper = $derived(snap.document.paper);
  const thumbs = $derived.by(() => {
    const list = library;
    void paper;
    return untrack(() => new Map(list.map((b) => [b.id, controller.brushThumbnail(b.id, { width: thumbnailWidth, height: thumbnailHeight, color: '#26324a' })])));
  });
  const entries = $derived.by<BrushLibraryEntry[]>(() => {
    const list = library;
    return untrack(() => list.map((b) => ({ brush: controller.getBrushSpec(b.id)!, builtin: Boolean(b.builtin) })));
  });
  // The active brush as facets and its preview follow every change to it.
  const spec = $derived.by<Brush>(() => {
    void brush;
    return untrack(() => controller.getBrushSpec()!);
  });
  // Previewed in the brush's own default colour when it has one, else the paint colour.
  const own = $derived(typeof spec.colour?.default === 'string' && /^#[0-9a-f]{6}/i.test(spec.colour.default) ? spec.colour.default.slice(0, 7) : undefined);
  const preview = $derived.by(() => {
    void brush;
    void paper;
    void snap.color;
    const color = own;
    return untrack(() => controller.brushThumbnail(brush.id, { width: 240, height: 64, color }));
  });
  const carried = $derived(brushLoadColor(snap.mixerLoad));
  // The brush's suggested colours, resolved for the colour scheme: one click makes one the paint colour.
  const palette = $derived((spec.colour?.palette ?? []).flatMap((c) => brushColourHex(c, snap.colorScheme) ?? []));
  const loads = $derived(['dab', 'mixer', 'impasto'].includes(brush.engine) || (brush.engine === 'wet' && brush.wet.tool === 'paint'));
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'brush';
</script>

{#snippet extra(section: string)}
  {#if section === 'shape' && brush.engine === 'sticker'}
    <StickerPicker {controller} label="Sticker stamps" selected={brush.sticker.stamps} onpick={(ref) => controller.setBrush({ sticker: { stamps: toggleStickerRef(brush.sticker.stamps, ref) } })} />
  {:else if section === 'behaviour' && loads}
    <div class="flex items-center gap-1">
      <span class="text-slate-400">Carries</span>
      <span aria-label="Brush load" title={carried ?? 'Clean'} class="h-4 w-4 rounded ring-1 ring-slate-700" style={`background: ${carried ?? 'transparent'}`}></span>
      {#if brush.engine === 'mixer'}
        <button type="button" class={button} onclick={() => controller.loadMixerBrush()}>Load</button>
      {/if}
      <button type="button" class={button} onclick={() => controller.cleanMixerBrush(brush.engine === 'mixer')}>Clean</button>
    </div>
  {:else if section === 'colour'}
    {#if palette.length}
      <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Paint with a palette colour">
        {#each palette as hex, i (`${hex}-${i}`)}
          <button type="button" aria-label={`Paint with ${hex}`} title={hex} aria-pressed={snap.color === hex} class={`h-5 w-5 rounded ring-1 ${snap.color === hex ? 'ring-white' : 'ring-slate-700'}`} style={`background: ${hex}`} onclick={() => controller.setColor(hex)}></button>
        {/each}
      </div>
    {/if}
    <label class="flex items-center gap-2" title="Choosing a brush with a default colour (the highlighter's yellow) makes it your colour unless this is on">
      <input type="checkbox" aria-label="Keep my colour" checked={snap.colorLocked} onchange={(e) => controller.setColorLocked(e.currentTarget.checked)} /> Keep my colour when choosing a brush
    </label>
    {#if brushTakesPaint(brush)}
    <div class="flex flex-col gap-1.5" data-testid="brush-gradient">
      <div class="flex items-center justify-between gap-2">
        <span class="text-slate-400" title="A gradient of the brush's own, used instead of the paint (the multi-colour brush)">Brush gradient</span>
        <button type="button" aria-pressed={brush.paint !== null} class={chip(brush.paint !== null)} onclick={() => run(() => controller.setBrush({ paint: brush.paint ? null : DEFAULT_PAINT_GRADIENT }))}>{brush.paint ? 'On' : 'Off'}</button>
      </div>
      {#if brush.paint}
        <PaintGradientEditor value={brush.paint} colors={{ paint: snap.color, secondary: snap.secondaryColor }} onchange={(g) => run(() => controller.setBrush({ paint: g }))} />
      {/if}
    </div>
    {/if}
  {/if}
{/snippet}

<!-- The brush library (BrushLibraryBrowser) and the active brush in the BrushEditor, plus the brush gradient, sticker stamps, what the brush carries, import and export. -->
<div class={`${panel} ${className}`} data-testid="brush-panel">
  <BrushLibraryBrowser {entries} activeId={brush.id} onselect={(id) => controller.setBrush({ id })} thumbnail={(id) => thumbs.get(id) ?? null} {thumbnailWidth} {thumbnailHeight} />
  <BrushEditor brush={spec} profile={PAINT_PROFILE} {preview} onchange={(next) => run(() => controller.setBrushSpec(next))} onsaveas={(name) => controller.saveBrush({ id: slug(name), name })} {extra} />
  <div class="flex flex-wrap items-center gap-1">
    <button type="button" class={button} onclick={() => run(async () => downloadBytes(JSON.stringify(await controller.exportBrushes(), null, 2), 'brushes.json', 'application/json'))}>Export</button>
    <button type="button" class={button} onclick={() => fileInput?.click()}>Import…</button>
    <input
      bind:this={fileInput}
      type="file"
      accept=".json,application/json"
      aria-label="Import brushes"
      class="hidden"
      onchange={(e) => {
        const input = e.currentTarget;
        const f = input.files?.[0];
        input.value = '';
        if (f) run(async () => controller.importBrushes(JSON.parse(await f.text())));
      }}
    />
  </div>
  {#if error}<p role="alert" class="text-[11px] text-rose-400">{error}</p>{/if}
</div>
