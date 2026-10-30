<script lang="ts">
  import ImageCheckbox from './controls/ImageCheckbox.svelte';
  import ImageRange from './controls/ImageRange.svelte';
  import ImageSelect from './controls/ImageSelect.svelte';
  import type {
    ColorRangePreset,
    ImageEditorController,
    SelectionDisplay,
    SelectionMask,
    SelectionModifyOp,
    SelectionToolOptions,
  } from '@pixerate/editor/image-editor';
  import {
    COLOR_RANGE_PRESETS,
    COLOR_RANGE_PRESET_LABELS,
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
    /** How the canvas shows the selection (`state.selectionDisplay`); wins over `quickMask`. */
    selectionDisplay?: SelectionDisplay;
    class?: string;
  }

  let { controller, options, onOptionsChange, selection, quickMask, selectionDisplay, class: className = '' }: Props = $props();

  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });
  const sel = $derived.by(() => {
    void tick;
    return selection === undefined ? controller.getSelection() : selection;
  });
  const display = $derived.by((): SelectionDisplay => {
    void tick;
    return selectionDisplay ?? (quickMask === undefined ? controller.getSelectionDisplay() : quickMask ? 'quickMask' : 'ants');
  });
  const DISPLAYS: { id: SelectionDisplay; label: string }[] = [
    { id: 'ants', label: 'Ants' },
    { id: 'quickMask', label: 'Quick Mask' },
    { id: 'none', label: 'Hidden' },
  ];
  const numberInput = 'w-14 bg-background border border-border rounded px-1 py-0.5 text-foreground';

  // Color Range presets.
  let preset = $state<ColorRangePreset>('reds');
  let rangeStatus = $state<string | null>(null);
  const canReselect = $derived.by(() => {
    void tick;
    void sel;
    return controller.canReselect();
  });
  let colorStatus = $state<string | null>(null);
  let strokeWidth = $state(4);
  let strokeLocation = $state<'inside' | 'center' | 'outside'>('outside');
  function edit(fn: () => unknown) {
    colorStatus = null;
    try {
      fn();
    } catch (err) {
      colorStatus = err instanceof Error ? err.message : String(err);
    }
  }
  async function runColor(op: 'grow' | 'similar') {
    colorStatus = null;
    const opts = { tolerance: options.tolerance, sampleMerged: options.sampleMerged, sample: options.sample };
    try {
      await (op === 'grow' ? controller.growSelection(opts) : controller.selectSimilar(opts));
    } catch (err) {
      colorStatus = err instanceof Error ? err.message : String(err);
    }
  }
  async function applyPreset() {
    rangeStatus = null;
    try {
      await controller.selectColorRangePreset(preset, {
        mode: options.mode,
        feather: options.feather ?? 0,
        invert: options.rangeInvert ?? false,
        falloff: options.fuzziness ?? 20,
        sampleMerged: options.sampleMerged,
        sample: options.sample,
      });
    } catch (err) {
      rangeStatus = err instanceof Error ? err.message : String(err);
    }
  }

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
    { op: 'expand', label: 'Expand' },
    { op: 'contract', label: 'Contract' },
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
        Distance
        <ImageSelect
          label="Colour distance"
          value={options.distance}
          options={[
            { value: 'rgb', label: 'RGB' },
            { value: 'perceptual', label: 'Perceptual' },
          ]}
          onchange={(v) => set({ distance: v as 'rgb' | 'perceptual' })}
        />
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
  {#if options.tool === 'polygon'}
    <p class="text-muted-foreground">Click to add corners (Shift for 45°), drag for a free-hand stretch; double-click, Enter or a click on the first corner closes it, Backspace removes a corner, Escape cancels.</p>
  {/if}
  {#if options.tool === 'magnetic'}
    <div data-testid="magnetic-lasso-options" class="flex flex-col gap-2">
      <p class="text-muted-foreground">Click on an edge, then move along it: the outline snaps to the edge and adds points as it goes. Click to add a point; double-click, Enter or a click on the start closes it, Backspace removes the last point, Escape cancels.</p>
      <label class="flex flex-col gap-1">
        <span class="flex justify-between text-muted-foreground">
          <span>Width</span>
          <span class="font-mono">{options.magneticWidth ?? 10} px</span>
        </span>
        <ImageRange label="Magnetic lasso width" min={1} max={256} step={1} value={options.magneticWidth ?? 10} oninput={(v) => set({ magneticWidth: v })} />
      </label>
      <label class="flex flex-col gap-1">
        <span class="flex justify-between text-muted-foreground">
          <span>Contrast</span>
          <span class="font-mono">{options.magneticContrast ?? 10}%</span>
        </span>
        <ImageRange label="Magnetic lasso contrast" min={1} max={100} step={1} value={options.magneticContrast ?? 10} oninput={(v) => set({ magneticContrast: v })} />
      </label>
      <label class="flex flex-col gap-1">
        <span class="flex justify-between text-muted-foreground">
          <span>Frequency</span>
          <span class="font-mono">{options.magneticFrequency ?? 57}</span>
        </span>
        <ImageRange label="Magnetic lasso frequency" min={0} max={100} step={1} value={options.magneticFrequency ?? 57} oninput={(v) => set({ magneticFrequency: v })} />
      </label>
    </div>
  {/if}
  {#if options.tool === 'type' || options.tool === 'type-vertical'}
    <div data-testid="type-mask-options" class="flex flex-col gap-2">
      <p class="text-muted-foreground">
        {options.tool === 'type-vertical' ? 'Click where the column starts: the letters are stacked down from there, centred on the click.' : 'Click where the text starts (its baseline).'} Shift-click adds, Alt-click subtracts.
      </p>
      <label class="flex items-center gap-1 text-muted-foreground">
        Text
        <input
          type="text"
          aria-label="Type mask text"
          value={options.typeText ?? 'Type'}
          oninput={(e) => set({ typeText: (e.currentTarget as HTMLInputElement).value })}
          class="min-w-0 flex-1 bg-background border border-border rounded px-1 py-0.5 text-foreground"
        />
      </label>
      <label class="flex items-center gap-1 text-muted-foreground">
        Size
        <input
          type="number"
          min="1"
          step="1"
          aria-label="Type mask size"
          value={options.typeSize ?? 72}
          oninput={(e) => set({ typeSize: Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 1) })}
          class={numberInput}
        />
        px
      </label>
      <label class="flex items-center gap-1 text-muted-foreground">
        Font
        <input
          type="text"
          aria-label="Type mask font"
          value={options.typeFamily ?? 'sans-serif'}
          oninput={(e) => set({ typeFamily: (e.currentTarget as HTMLInputElement).value })}
          class="min-w-0 flex-1 bg-background border border-border rounded px-1 py-0.5 text-foreground"
        />
      </label>
    </div>
  {/if}
  {#if options.tool === 'range'}
    <div data-testid="color-range-options" class="flex flex-col gap-2">
      <p class="text-muted-foreground">Click a colour to select it; Shift-click adds a colour, Alt-click removes one.</p>
      <label class="flex flex-col gap-1">
        <span class="flex justify-between text-muted-foreground">
          <span>Fuzziness</span>
          <span class="font-mono">{options.fuzziness ?? 40}</span>
        </span>
        <ImageRange label="Fuzziness" min={0} max={200} step={1} value={options.fuzziness ?? 40} oninput={(v) => set({ fuzziness: v })} />
      </label>
      <label class="flex items-center gap-1 text-muted-foreground">
        Localized radius
        <input
          type="number"
          min="0"
          step="1"
          aria-label="Localized radius"
          value={options.localized ?? 0}
          oninput={(e) => set({ localized: Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0) })}
          class={numberInput}
        />
        px
      </label>
      <label class="flex items-center gap-2 text-foreground">
        <ImageCheckbox label="Invert" checked={options.rangeInvert ?? false} onchange={(on) => set({ rangeInvert: on })} />
        Invert
      </label>
      <div class="flex items-center gap-1">
        <ImageSelect
          label="Color Range preset"
          value={preset}
          options={COLOR_RANGE_PRESETS.map((p) => ({ value: p, label: COLOR_RANGE_PRESET_LABELS[p] }))}
          onchange={(v) => (preset = v as ColorRangePreset)}
        />
        <button type="button" class={btn(false)} onclick={() => void applyPreset()}>Select</button>
      </div>
      {#if rangeStatus}
        <p role="status" class="text-muted-foreground">{rangeStatus}</p>
      {/if}
    </div>
  {/if}
  <label class="flex items-center gap-1 text-muted-foreground">
    Feather
    <input
      type="number"
      min="0"
      max="1000"
      step="0.5"
      aria-label="Feather"
      value={options.feather ?? 0}
      oninput={(e) => set({ feather: Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0) })}
      class={numberInput}
    />
    px
  </label>
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
    <button type="button" class={btn(false)} disabled={!canReselect} onclick={() => controller.reselect()}>Reselect</button>
    <button type="button" class={btn(false)} disabled={!sel} title="Add connected pixels of a selected colour (wand tolerance)" onclick={() => void runColor('grow')}>Grow</button>
    <button type="button" class={btn(false)} disabled={!sel} title="Add every pixel of a selected colour (wand tolerance)" onclick={() => void runColor('similar')}>Similar</button>
  </div>
  <div role="group" aria-label="Show selection" class="flex flex-wrap items-center gap-1">
    <span class="text-muted-foreground">Show</span>
    {#each DISPLAYS as d (d.id)}
      <button type="button" aria-pressed={display === d.id} class={btn(display === d.id)} onclick={() => controller.setSelectionDisplay(d.id)}>{d.label}</button>
    {/each}
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
        class={numberInput}
      />
    </label>
    {#each MODIFY_OPS as m (m.op)}
      <button type="button" class={btn(false)} disabled={!sel} onclick={() => controller.modifySelection(m.op, radius)}>{m.label}</button>
    {/each}
  </div>
  <div role="group" aria-label="Edit selection" class="flex flex-wrap items-center gap-1">
    <label class="flex items-center gap-1 text-muted-foreground">
      Stroke
      <input
        type="number"
        min="1"
        max="250"
        step="1"
        aria-label="Stroke width"
        value={strokeWidth}
        oninput={(e) => (strokeWidth = Math.min(250, Math.max(1, Number((e.currentTarget as HTMLInputElement).value) || 1)))}
        class={numberInput}
      />
      px
    </label>
    <ImageSelect
      label="Stroke location"
      value={strokeLocation}
      options={[
        { value: 'outside', label: 'Outside' },
        { value: 'center', label: 'Center' },
        { value: 'inside', label: 'Inside' },
      ]}
      onchange={(v) => (strokeLocation = v as 'inside' | 'center' | 'outside')}
    />
    <button type="button" class={btn(false)} disabled={!sel} onclick={() => edit(() => controller.strokeSelection({ width: strokeWidth, location: strokeLocation }))}>Stroke</button>
    <button type="button" class={btn(false)} disabled={!sel} onclick={() => edit(() => controller.cropToSelection())}>Crop to Selection</button>
    <button type="button" class={btn(false)} disabled={!sel} onclick={() => edit(() => controller.contentAwareFill({ output: 'new-layer' }))}>Content-Aware Fill</button>
  </div>
  <div role="group" aria-label="Clipboard" class="flex flex-wrap gap-1">
    <button type="button" class={btn(false)} onclick={() => edit(() => controller.copyPixels())}>Copy</button>
    <button type="button" class={btn(false)} onclick={() => edit(() => controller.copyPixels({ merged: true }))}>Copy Merged</button>
    <button type="button" class={btn(false)} disabled={!sel} onclick={() => edit(() => controller.cutPixels())}>Cut</button>
    <button type="button" class={btn(false)} onclick={() => edit(() => controller.pastePixels('new-layer'))}>Paste</button>
    <button type="button" class={btn(false)} onclick={() => edit(() => controller.pastePixels('in-place'))}>Paste in Place</button>
    <button type="button" class={btn(false)} disabled={!sel} onclick={() => edit(() => controller.pastePixels('into'))}>Paste Into</button>
    <button type="button" class={btn(false)} disabled={!sel} onclick={() => edit(() => controller.pastePixels('outside'))}>Paste Outside</button>
  </div>
  {#if colorStatus}
    <p role="status" class="text-muted-foreground">{colorStatus}</p>
  {/if}
  <p data-testid="selection-status" class="text-muted-foreground">{describeSelection(sel)}</p>
</div>
