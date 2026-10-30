<script lang="ts">
  import {
    VECTOR_FONT_WEIGHTS,
    VECTOR_TEXT_ALIGN_OPTIONS,
    applyVectorParagraphStyle,
    applyVectorTextOrientation,
    applyVectorTextStyle,
    getVectorTextPanel,
    type VectorEditorController,
    type VectorTextAlign
  } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * Character and paragraph style of text: family, weight, size, italic, underline, strike-through,
   * tracking, leading, alignment, horizontal / vertical orientation (with upright Latin in vertical
   * text) and point / area text. It edits the selected characters while text
   * is being edited, else the selected text, else the defaults for new text. Type on a Path turns a
   * selected path into path text, and Create Outlines turns text into paths (with an outline
   * shaper). Each change is one undo step.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const listId = `vector-fonts-${Math.random().toString(36).slice(2, 10)}`;
  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const panel = $derived(getVectorTextPanel(view));
  const f = $derived(panel?.font);
  const where = $derived(panel?.target === 'range' ? 'Selected characters' : panel?.target === 'nodes' ? 'Selected text' : 'New text');

  const style = (patch: Record<string, unknown>, merge?: string) => applyVectorTextStyle(controller, patch, merge ? { merge } : {});
  const num = (v: string) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  function onFamily(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value.trim();
    if (v && v !== f?.fontFamily) style({ fontFamily: v });
  }
  function typeOnPath() {
    if (!panel?.pathId) return;
    const r = controller.typeOnPath(panel.pathId, { text: 'Text on a path' });
    if (r.ok && r.id) controller.editText(r.id, { anchor: 0, focus: 'Text on a path'.length });
  }

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
  const inputClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  const labelClass = 'w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
</script>

{#if panel && f}
  <div class="space-y-2 {className}" data-vector-text-panel={panel.target} aria-label="Text">
    <div class="flex items-center gap-1">
      <span class={labelClass}>Text</span>
      <span class="text-[11px] text-muted-foreground">{where}</span>
    </div>
    <div class="flex items-center gap-1">
      {#key f.fontFamily}
        <input
          aria-label="Font family"
          class={inputClass}
          list={listId}
          placeholder="Mixed"
          value={f.fontFamily ?? ''}
          onkeydown={(e) => {
            if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          }}
          onblur={onFamily}
        />
      {/key}
      <datalist id={listId}>
        {#each panel.families as fam (fam)}
          <option value={fam}></option>
        {/each}
      </datalist>
    </div>
    <div class="flex items-center gap-1">
      <select aria-label="Font weight" class={inputClass} value={f.fontWeight ?? ''} onchange={(e) => style({ fontWeight: Number((e.currentTarget as HTMLSelectElement).value) })}>
        {#if f.fontWeight === null}<option value="">Mixed</option>{/if}
        {#each VECTOR_FONT_WEIGHTS as w (w.value)}
          <option value={w.value}>{w.label}</option>
        {/each}
        {#if f.fontWeight !== null && !VECTOR_FONT_WEIGHTS.some((w) => w.value === f.fontWeight)}<option value={f.fontWeight}>{f.fontWeight}</option>{/if}
      </select>
      <input
        type="number"
        aria-label="Font size"
        title="Font size"
        class="{inputClass} w-14 flex-none"
        min="0.5"
        step="1"
        placeholder="—"
        value={f.fontSize === null ? '' : Math.round(f.fontSize * 100) / 100}
        oninput={(e) => {
          const v = num((e.currentTarget as HTMLInputElement).value);
          if (v !== null && v >= 0.5) style({ fontSize: v }, 'text-size');
        }}
        onblur={() => controller.endMergedEdit()}
      />
    </div>
    <div class="flex flex-wrap items-center gap-1">
      <button type="button" class={buttonClass} aria-label="Bold" aria-pressed={(f.fontWeight ?? 0) >= 600} onclick={() => style({ fontWeight: (f.fontWeight ?? 400) >= 600 ? 400 : 700 })}><b>B</b></button>
      <button type="button" class={buttonClass} aria-label="Italic" aria-pressed={f.italic === true} onclick={() => style({ italic: !f.italic })}><i>I</i></button>
      <button type="button" class={buttonClass} aria-label="Underline" aria-pressed={f.underline === true} onclick={() => style({ underline: !f.underline })}><u>U</u></button>
      <button type="button" class={buttonClass} aria-label="Strike through" aria-pressed={f.strikethrough === true} onclick={() => style({ strikethrough: !f.strikethrough })}><s>S</s></button>
    </div>
    {#if panel.target !== 'defaults'}
      <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Orientation">
        <button type="button" class={buttonClass} aria-pressed={panel.orientation === 'horizontal'} title="Horizontal text: lines left to right" onclick={() => applyVectorTextOrientation(controller, 'horizontal')}>Horizontal</button>
        <button
          type="button"
          class={buttonClass}
          aria-pressed={panel.orientation === 'vertical'}
          disabled={!panel.canOrient}
          title={panel.canOrient ? 'Vertical text: columns top to bottom, right to left' : 'Text on a path cannot be vertical'}
          onclick={() => applyVectorTextOrientation(controller, 'vertical')}>Vertical</button
        >
        {#if panel.orientation === 'vertical'}
          <button type="button" class={buttonClass} aria-pressed={f.upright === true} title="Set Latin upright, one letter under the other (else turned sideways)" onclick={() => style({ upright: !f.upright })}>Upright Latin</button>
        {/if}
      </div>
    {/if}
    <div class="flex items-center gap-1">
      <label class="flex flex-1 items-center gap-1 text-xs text-foreground" title="Tracking (1/1000 em)">
        <span class="text-[11px] text-muted-foreground">VA</span>
        <input
          type="number"
          aria-label="Tracking"
          class={inputClass}
          step="10"
          placeholder="—"
          value={f.tracking ?? ''}
          oninput={(e) => style({ tracking: num((e.currentTarget as HTMLInputElement).value) ?? 0 }, 'text-tracking')}
          onblur={() => controller.endMergedEdit()}
        />
      </label>
      <label class="flex flex-1 items-center gap-1 text-xs text-foreground" title="Leading (empty: auto)">
        <span class="text-[11px] text-muted-foreground">↕</span>
        <input
          type="number"
          aria-label="Leading"
          class={inputClass}
          min="0"
          step="1"
          placeholder="Auto"
          value={f.leading ?? ''}
          oninput={(e) => style({ leading: num((e.currentTarget as HTMLInputElement).value) }, 'text-leading')}
          onblur={() => controller.endMergedEdit()}
        />
      </label>
    </div>
    <div class="flex flex-wrap items-center gap-1" role="group" aria-label="Alignment">
      {#each VECTOR_TEXT_ALIGN_OPTIONS as o (o.value)}
        <button type="button" class={buttonClass} aria-label="Align {o.label}" aria-pressed={panel.align === o.value} onclick={() => applyVectorParagraphStyle(controller, { align: o.value as VectorTextAlign })}>{o.label}</button>
      {/each}
    </div>
    {#if panel.target !== 'defaults' && panel.ids.length === 1}
      <div class="flex flex-wrap items-center gap-1">
        <button type="button" class={buttonClass} aria-pressed={panel.frame === 'point'} title="Point text: no wrapping" onclick={() => controller.setTextFrame(panel.ids[0], { kind: 'point' })}>Point</button>
        <button type="button" class={buttonClass} aria-pressed={panel.frame === 'area'} title="Area text: wraps in a box" onclick={() => controller.setTextFrame(panel.ids[0], { kind: 'area' })}>Area</button>
      </div>
    {/if}
    <div class="flex flex-wrap items-center gap-1">
      <button
        type="button"
        class={buttonClass}
        data-vector-text-action="type-on-path"
        disabled={!panel.pathId}
        title={panel.pathId ? 'Type on a Path: set text along the selected path' : 'Select a path to set text along it'}
        onclick={typeOnPath}>Type on path</button
      >
      <button
        type="button"
        class={buttonClass}
        data-vector-text-action="create-outlines"
        disabled={panel.target !== 'nodes' || !panel.outlines}
        title={panel.outlines ? 'Create Outlines: turn the text into paths' : 'Create Outlines needs a font with outlines (load one)'}
        onclick={() => controller.createOutlines({ ids: panel.ids })}>Create outlines</button
      >
    </div>
  </div>
{/if}
