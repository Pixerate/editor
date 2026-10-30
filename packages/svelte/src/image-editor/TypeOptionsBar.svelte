<script lang="ts">
  import ImageColor from './controls/ImageColor.svelte';
  import { imageChipClass } from './styles.js';
  import type { ImageEditorController, TextAlign, TextEditSession, TextOrientation, TextStyle, TypeToolOptions } from '@pixerate/editor/image-editor';
  import { TEXT_ALIGNS, TEXT_ORIENTATIONS } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  /**
   * The type tool's options: font family (from the editor's fonts), size, bold, italic, colour,
   * alignment and orientation (horizontal or vertical type, with upright Latin in vertical text). While text is being edited they style the selection (or the whole text); with a
   * type layer active they style all of it; otherwise they set what the next text uses.
   */
  interface Props {
    controller: ImageEditorController;
    options: TypeToolOptions;
    onchange: (options: TypeToolOptions) => void;
    /** The text being edited on the canvas: changes style its selection (or all of it). */
    session?: TextEditSession | null;
    class?: string;
  }

  let { controller, options, onchange, session = null, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });
  $effect(() => {
    const s = session;
    if (!s) return;
    return untrack(() => s.subscribe(() => tick++));
  });
  const ALIGN_LABELS: Record<TextAlign, string> = { left: 'Left', center: 'Centre', right: 'Right', justify: 'Justify' };
  const ORIENTATION_LABELS: Record<TextOrientation, string> = { horizontal: 'Horizontal', vertical: 'Vertical' };
  

  const view = $derived.by(() => {
    void tick;
    const active = controller.getActiveLayer();
    const here: Partial<TextStyle> = session?.alive ? session.styleHere() : {};
    const shown: TypeToolOptions = {
      ...options,
      ...(here.fontFamily ? { fontFamily: here.fontFamily } : {}),
      ...(here.fontSize ? { fontSize: here.fontSize } : {}),
      ...(here.fontWeight ? { fontWeight: here.fontWeight } : {}),
      ...(session?.alive ? { italic: Boolean(here.italic), color: here.color ?? options.color } : {}),
    };
    const typeId = !session && active?.type === 'type' ? active.id : null;
    // The orientation of the text being edited or the active type layer, else the tool's.
    const editedId = session?.alive ? session.layerId : typeId;
    const edited = editedId ? controller.getLayer(editedId) : null;
    const orientation: TextOrientation = edited?.type === 'type' ? (edited.orientation ?? 'horizontal') : (options.orientation ?? 'horizontal');
    const upright = Boolean(session?.alive ? here.upright : edited?.type === 'type' && edited.runs[0]?.style.upright);
    return {
      shown,
      editedId,
      orientation,
      upright,
      typeId,
      missing: active?.type === 'type' ? (active.missingFonts ?? []) : [],
      fonts: controller.listFonts(),
    };
  });
  let error = $state<string | null>(null);

  function style(change: Partial<TypeToolOptions>) {
    onchange({ ...options, ...change });
    const s: Record<string, unknown> = {};
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'italic', 'color'] as const) if (k in change) s[k] = change[k];
    const p = change.align ? { align: change.align } : null;
    try {
      error = null;
      if (session?.alive) {
        if (Object.keys(s).length) session.setStyle(s as Partial<TextStyle>);
        if (p) session.setParagraph(p);
        if (session.error) error = session.error;
      } else if (view.typeId) {
        if (Object.keys(s).length) controller.setTextStyle(view.typeId, s);
        if (p) controller.setParagraphStyle(view.typeId, p);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  function orient(next: TextOrientation) {
    onchange({ ...options, orientation: next });
    try {
      error = null;
      if (view.editedId) controller.setTextOrientation(view.editedId, next);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  function toggleUpright() {
    try {
      error = null;
      if (session?.alive) session.setStyle({ upright: !view.upright });
      else if (view.typeId) controller.setTextStyle(view.typeId, { upright: !view.upright });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const value = (e: Event) => (e.target as HTMLInputElement).value;
</script>

<div class="flex flex-col gap-2 text-xs text-foreground {className}" data-testid="type-options">
  <div class="flex flex-wrap items-center gap-2">
    <label class="flex items-center gap-1">
      Font
      <input list="pixerate-type-fonts" aria-label="Font family" value={view.shown.fontFamily} oninput={(e) => value(e).trim() && style({ fontFamily: value(e) })} class="w-32 rounded border border-border bg-background px-1 py-0.5" />
      <datalist id="pixerate-type-fonts">
        {#each view.fonts as f (f)}
          <option value={f}></option>
        {/each}
      </datalist>
    </label>
    <label class="flex items-center gap-1">
      Size
      <input
        type="number"
        aria-label="Font size"
        min="1"
        max="2000"
        value={Math.round(view.shown.fontSize * 10) / 10}
        oninput={(e) => Number(value(e)) > 0 && style({ fontSize: Number(value(e)) })}
        class="w-16 rounded border border-border bg-background px-1 py-0.5"
      />
    </label>
    <button type="button" aria-pressed={view.shown.fontWeight >= 600} class="{imageChipClass(view.shown.fontWeight >= 600)} font-bold" onclick={() => style({ fontWeight: view.shown.fontWeight >= 600 ? 400 : 700 })}>B</button>
    <button type="button" aria-pressed={view.shown.italic} class="{imageChipClass(view.shown.italic)} italic" onclick={() => style({ italic: !view.shown.italic })}>I</button>
    <ImageColor label="Text colour" value={view.shown.color} oninput={(color) => style({ color })} />
  </div>
  <div class="flex gap-1" role="toolbar" aria-label="Alignment">
    {#each TEXT_ALIGNS as a (a)}
      <button type="button" aria-pressed={options.align === a} class={imageChipClass(options.align === a)} onclick={() => style({ align: a })}>{ALIGN_LABELS[a]}</button>
    {/each}
  </div>
  <div class="flex gap-1" role="toolbar" aria-label="Orientation">
    {#each TEXT_ORIENTATIONS as o (o)}
      <button type="button" aria-pressed={view.orientation === o} class={imageChipClass(view.orientation === o)} onclick={() => orient(o)}>{ORIENTATION_LABELS[o]}</button>
    {/each}
    {#if view.orientation === 'vertical' && view.editedId}
      <button type="button" aria-pressed={view.upright} class={imageChipClass(view.upright)} title="Set Latin upright, one letter under the other (else turned sideways)" onclick={toggleUpright}>Upright Latin</button>
    {/if}
  </div>
  <p class="text-[10px] text-muted-foreground">Click to type point text (vertical: a column down from the click), drag for a paragraph box, click text to edit it. Esc finishes.</p>
  {#if view.missing.length > 0}
    <p role="status" class="text-amber-600" data-testid="type-missing-fonts">Missing {view.missing.length === 1 ? 'font' : 'fonts'}: {view.missing.join(', ')}</p>
  {/if}
  {#if error}
    <p role="alert" class="text-destructive">{error}</p>
  {/if}
</div>
