<script lang="ts">
  import ImageCheckbox from './controls/ImageCheckbox.svelte';
  import ImageRange from './controls/ImageRange.svelte';
  import ImageSelect from './controls/ImageSelect.svelte';
  import type {
    ImageEditorController,
    SelectionMask,
    SelectionModifyOp,
    SelectionToolOptions,
  } from '@pixerate/editor/image-editor';
  import {
    SELECTION_MODES,
    SELECTION_MODE_LABELS,
    SELECTION_TOOLS,
    describeSelection,
  } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';

  interface Props {
    controller: ImageEditorController;
    options: SelectionToolOptions;
    onOptionsChange: (next: SelectionToolOptions) => void;
    /** The current selection (`state.selection`). Omit to follow the controller. */
    selection?: SelectionMask | null;
    /** The Quick Mask view flag (`state.quickMask`). Omit to follow the controller. */
    quickMask?: boolean;
    class?: string;
  }

  let { controller, options, onOptionsChange, selection, quickMask, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });
  const sel = $derived.by(() => {
    void tick;
    return selection === undefined ? controller.getSelection() : selection;
  });
  const qm = $derived.by(() => {
    void tick;
    return quickMask ?? Boolean(controller.getState().quickMask);
  });

  let radius = $state(2);

  // Select › Subject (only with a segmentation provider).
  const canSegment = $derived.by(() => {
    void tick;
    return Boolean(controller.segmentationProvider);
  });
  let subject = $state('');
  let segmenting = $state(false);
  let subjectStatus = $state<string | null>(null);
  async function selectSubject() {
    const target = subject.trim();
    if (!target || segmenting) return;
    segmenting = true;
    subjectStatus = null;
    try {
      const { segments } = await controller.selectSubject(target, { mode: options.mode });
      subjectStatus = segments.length ? null : `Nothing matching “${target}” was found.`;
    } catch (err) {
      subjectStatus = err instanceof Error ? err.message : String(err);
    } finally {
      segmenting = false;
    }
  }

  const MODIFY_OPS: { op: SelectionModifyOp; label: string }[] = [
    { op: 'grow', label: 'Grow' },
    { op: 'shrink', label: 'Shrink' },
    { op: 'feather', label: 'Feather' },
    { op: 'border', label: 'Border' },
    { op: 'smooth', label: 'Smooth' },
  ];

  function set(patch: Partial<SelectionToolOptions>) {
    onOptionsChange({ ...options, ...patch });
  }

  const btn = (on: boolean) =>
    `px-2 py-1 rounded-md border text-[11px] transition-colors ${
      on ? 'bg-primary border-primary text-primary-foreground' : 'bg-background border-border text-foreground hover:bg-accent hover:text-accent-foreground'
    }`;
</script>

<div data-testid="selection-options-bar" class="flex flex-col gap-3 text-xs {className}">
  <div role="group" aria-label="Selection tool" class="flex flex-wrap gap-1">
    {#each SELECTION_TOOLS as t (t.id)}
      <button type="button" aria-pressed={options.tool === t.id} class={btn(options.tool === t.id)} onclick={() => set({ tool: t.id })}>
        {t.label}
      </button>
    {/each}
  </div>
  <div role="group" aria-label="Selection mode" class="flex flex-wrap gap-1">
    {#each SELECTION_MODES as m (m)}
      <button type="button" aria-pressed={options.mode === m} class={btn(options.mode === m)} onclick={() => set({ mode: m })}>
        {SELECTION_MODE_LABELS[m]}
      </button>
    {/each}
  </div>
  {#if options.tool === 'wand'}
    <div class="flex flex-col gap-2">
      <label class="flex flex-col gap-1">
        <span class="flex justify-between text-muted-foreground">
          <span>Tolerance</span>
          <span class="font-mono">{options.tolerance}</span>
        </span>
        <ImageRange label="Tolerance" min={0} max={255} step={1} value={options.tolerance} oninput={(v) => set({ tolerance: v })} />
      </label>
      <label class="flex items-center gap-2 text-foreground">
        <ImageCheckbox label="Contiguous" checked={options.contiguous} onchange={(on) => set({ contiguous: on })} />
        Contiguous
      </label>
      <label class="flex items-center gap-2 text-foreground">
        <ImageCheckbox label="Sample adjusted image" checked={options.sampleMerged} onchange={(on) => set({ sampleMerged: on })} />
        Sample adjusted image
      </label>
      <label class="flex items-center gap-2 text-foreground">
        Sample
        <ImageSelect
          label="Sample from"
          value={options.sample ?? 'composite'}
          options={[
            { value: 'composite', label: 'All layers' },
            { value: 'active-layer', label: 'Active layer' },
          ]}
          onchange={(v) => set({ sample: v as 'composite' | 'active-layer' })}
        />
      </label>
    </div>
  {/if}
  {#if canSegment}
    <form
      data-testid="select-subject"
      class="flex flex-col gap-1"
      onsubmit={(e) => {
        e.preventDefault();
        void selectSubject();
      }}
    >
      <div class="flex gap-1">
        <input
          type="text"
          aria-label="Subject to select"
          placeholder="Subject, e.g. the dog"
          bind:value={subject}
          disabled={segmenting}
          class="min-w-0 flex-1 bg-background border border-border rounded px-2 py-1 text-foreground"
        />
        <button type="submit" class={btn(false)} disabled={segmenting || !subject.trim()} aria-busy={segmenting}>
          {segmenting ? 'Selecting…' : 'Select Subject'}
        </button>
      </div>
      {#if subjectStatus}
        <p role="status" class="text-muted-foreground">{subjectStatus}</p>
      {/if}
    </form>
  {/if}
  <label class="flex items-center gap-2 text-foreground">
    <ImageCheckbox label="Anti-alias" checked={options.antiAlias} onchange={(on) => set({ antiAlias: on })} />
    Anti-alias
  </label>
  <div class="flex flex-wrap gap-1">
    <button type="button" class={btn(false)} onclick={() => controller.selectAll()}>Select All</button>
    <button type="button" class={btn(false)} disabled={!sel} onclick={() => controller.deselect()}>Deselect</button>
    <button type="button" class={btn(false)} onclick={() => controller.invertSelection()}>Inverse</button>
    <button type="button" aria-pressed={qm} class={btn(qm)} onclick={() => controller.setQuickMask(!qm)}>Quick Mask</button>
  </div>
  <div class="flex flex-wrap items-center gap-1">
    <label class="flex items-center gap-1 text-muted-foreground">
      Radius
      <input
        type="number"
        min="0"
        max="500"
        step="1"
        aria-label="Modify radius"
        value={radius}
        oninput={(e) => (radius = Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0))}
        class="w-14 bg-background border border-border rounded px-1 py-0.5 text-foreground"
      />
    </label>
    {#each MODIFY_OPS as m (m.op)}
      <button type="button" class={btn(false)} disabled={!sel} onclick={() => controller.modifySelection(m.op, radius)}>{m.label}</button>
    {/each}
  </div>
  <p data-testid="selection-status" class="text-muted-foreground">{describeSelection(sel)}</p>
</div>
