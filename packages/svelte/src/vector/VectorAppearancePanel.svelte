<script lang="ts">
  import {
    VECTOR_BLEND_MODE_MENU,
    VECTOR_FILTER_MENU,
    VECTOR_STROKE_ALIGN_LABELS,
    getVectorAppearancePanel,
    type VectorAppearancePanelLayer,
    type VectorBlendMode,
    type VectorEditorController,
    type VectorFilterType,
    type VectorFiltersPanelItem,
    type VectorStrokeAlign,
    randomVectorBrushstrokeSeed,
    vectorBrushstrokeBrushes
  } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * The appearance of the selection: its fill and stroke stacks (listed top first; add, remove,
   * reorder, show / hide, paint, opacity and blend mode per layer, width and alignment per
   * stroke), the node blend mode, and for one selected node its filters (drop and inner shadows,
   * glows, blurs, feather). The pencil on a layer points the gradient editor and tool at it.
   * Slider drags and typing are one undo step each.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const panel = $derived(getVectorAppearancePanel(view));

  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
  const numberClass = 'h-7 w-14 rounded border border-border bg-background px-1.5 text-xs';
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  const headingClass = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
  const labelClass = 'w-full truncate text-[11px] text-muted-foreground';
  const ALIGNS = Object.keys(VECTOR_STROKE_ALIGN_LABELS) as VectorStrokeAlign[];

  const end = () => controller.endMergedEdit();
  const nameOf = (l: VectorAppearancePanelLayer) => `${l.kind === 'fill' ? 'Fill' : 'Stroke'} ${l.index + 1}`;
  function update(l: VectorAppearancePanelLayer, patch: Record<string, unknown>, merge = false) {
    if (panel) controller.updatePaintLayer(l.kind, l.index, patch, { ids: panel.pathIds, merge });
  }
  function setNumber(l: VectorAppearancePanelLayer, key: 'opacity' | 'strokeWidth', raw: string) {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return;
    if (key === 'opacity') update(l, { opacity: Math.min(100, Math.max(0, n)) / 100 }, true);
    else if (n >= 0) update(l, { strokeWidth: n }, true);
  }
  function setFilter(f: VectorFiltersPanelItem, key: string, value: unknown, merge: boolean) {
    if (panel?.filterNodeId) controller.updateFilter(panel.filterNodeId, f.id, { params: { [key]: value } }, { merge });
  }
  function setFilterNumber(f: VectorFiltersPanelItem, key: string, raw: string) {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) setFilter(f, key, n, true);
  }
  const hexOf = (v: unknown) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : '#000000');
  const round = (n: number) => Math.round(n * 1000) / 1000;
</script>

{#snippet layerRow(l: VectorAppearancePanelLayer, count: number, ids: string[])}
  {@const name = nameOf(l)}
  {#if l.brushstroke}
    {@const bs = l.brushstroke}
    <div class="space-y-1 rounded border border-border p-1" data-vector-layer="{l.kind}-{l.index}" data-vector-brushstroke="">
      <div class="flex items-center gap-1">
        <input type="checkbox" aria-label="{name} visible" title="Show" checked={l.visible} onchange={(e) => update(l, { visible: e.currentTarget.checked })} />
        <input type="color" aria-label="{name} colour" class="h-7 w-10 cursor-pointer rounded border border-border bg-background" value={l.color ?? '#000000'} oninput={(e) => controller.setBrushstroke(l.index, { color: e.currentTarget.value }, { ids, merge: true })} onblur={() => controller.endMergedEdit()} />
        <select aria-label="{name} brush" class={selectClass} value={bs.brushId} onchange={(e) => controller.setBrushstroke(l.index, { brushId: e.currentTarget.value }, { ids })}>
          {#each vectorBrushstrokeBrushes() as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
        </select>
        <input type="number" min="0.5" step="0.5" aria-label="{name} brush size" title="Brush size" class={numberClass} value={bs.size} oninput={(e) => {
          const n = parseFloat(e.currentTarget.value);
          if (Number.isFinite(n) && n > 0) controller.setBrushstroke(l.index, { size: Math.min(500, n) }, { ids, merge: true });
        }} onblur={() => controller.endMergedEdit()} />
        <label class="flex items-center gap-0.5 text-[11px]" title="Brush character: seeded jitter and paper grain">
          <input type="checkbox" aria-label="{name} grain" data-vector-brushstroke-grain="" checked={bs.grain} onchange={(e) => controller.setBrushstroke(l.index, e.currentTarget.checked ? { paper: {}, ...(bs.seed === undefined ? { seed: randomVectorBrushstrokeSeed() } : {}) } : { paper: null }, { ids })} />
          Grain
        </label>
        <button type="button" class={buttonClass} title="Remove" aria-label="Remove {name}" onclick={() => controller.removePaintLayer('stroke', l.index, { ids })}>×</button>
      </div>
    </div>
  {:else if l.unknownKind}
    <div class="text-[11px] text-muted-foreground" data-vector-layer="{l.kind}-{l.index}">{name}: {l.unknownKind} (not drawn by this version)</div>
  {:else}
    <div class="space-y-1 rounded border border-border p-1" data-vector-layer="{l.kind}-{l.index}" data-vector-layer-editing={l.editing ? '' : undefined}>
      <div class="flex items-center gap-1">
        <input type="checkbox" aria-label="{name} visible" title="Show" checked={l.visible} onchange={(e) => update(l, { visible: e.currentTarget.checked })} />
        {#if l.gradient}
          <button
            type="button"
            aria-label="{name} gradient"
            title="Edit this gradient"
            class="h-7 w-10 rounded border border-border"
            style="background: {l.swatch}"
            onclick={() => controller.setGradientTarget(l.kind, l.index)}
          ></button>
        {:else}
          <input
            type="color"
            aria-label="{name} colour"
            class="h-7 w-10 cursor-pointer rounded border border-border bg-background"
            value={l.color ?? '#000000'}
            oninput={(e) => update(l, { paint: e.currentTarget.value }, true)}
            onblur={end}
          />
        {/if}
        <input
          type="number"
          min={0}
          max={100}
          step={5}
          aria-label="{name} opacity"
          title="Opacity %"
          class={numberClass}
          value={Math.round(l.opacity * 100)}
          oninput={(e) => setNumber(l, 'opacity', e.currentTarget.value)}
          onblur={end}
        />
        <select aria-label="{name} blend mode" class={selectClass} value={l.blendMode} onchange={(e) => update(l, { blendMode: e.currentTarget.value })}>
          {#each VECTOR_BLEND_MODE_MENU as m (m.mode)}<option value={m.mode}>{m.label}</option>{/each}
        </select>
      </div>
      {#if l.kind === 'stroke'}
        <div class="flex items-center gap-1">
          <input
            type="number"
            min={0}
            step={0.5}
            aria-label="{name} width"
            title="Width"
            class={numberClass}
            value={l.strokeWidth ?? 1}
            oninput={(e) => setNumber(l, 'strokeWidth', e.currentTarget.value)}
            onblur={end}
          />
          <select aria-label="{name} alignment" class={selectClass} value={l.strokeAlign ?? 'center'} onchange={(e) => update(l, { strokeAlign: e.currentTarget.value })}>
            {#each ALIGNS as a (a)}<option value={a}>{VECTOR_STROKE_ALIGN_LABELS[a]}</option>{/each}
          </select>
        </div>
      {/if}
      <div class="flex items-center gap-1">
        <span class="flex-1"></span>
        <button type="button" class={buttonClass} title="Edit gradient" aria-label="Edit {name} gradient" aria-pressed={l.editing} onclick={() => controller.setGradientTarget(l.kind, l.index)}>✎</button>
        <button type="button" class={buttonClass} title="Move up" aria-label="Move {name} up" disabled={l.index === count - 1} onclick={() => controller.movePaintLayer(l.kind, l.index, l.index + 1, { ids })}>↑</button>
        <button type="button" class={buttonClass} title="Move down" aria-label="Move {name} down" disabled={l.index === 0} onclick={() => controller.movePaintLayer(l.kind, l.index, l.index - 1, { ids })}>↓</button>
        <button type="button" class={buttonClass} title="Remove" aria-label="Remove {name}" onclick={() => controller.removePaintLayer(l.kind, l.index, { ids })}>×</button>
      </div>
    </div>
  {/if}
{/snippet}

{#snippet stack(kind: 'fill' | 'stroke', layers: VectorAppearancePanelLayer[], mixed: boolean, ids: string[])}
  <div class="space-y-1" data-vector-stack={kind}>
    <div class="flex items-center gap-2">
      <span class="flex-1 {headingClass}">{kind === 'fill' ? 'Fills' : 'Strokes'}</span>
      {#if mixed}<span class="text-[11px] text-muted-foreground">Mixed</span>{/if}
      <button
        type="button"
        class={buttonClass}
        title={kind === 'fill' ? 'Add fill' : 'Add stroke'}
        aria-label={kind === 'fill' ? 'Add fill' : 'Add stroke'}
        disabled={!ids.length}
        onclick={() => controller.addPaintLayer(kind, {}, { ids })}>+</button
      >
      {#if kind === 'stroke'}
        <button type="button" class={buttonClass} title="Add a brushstroke (a natural-media brush along the path)" aria-label="Add brushstroke" data-vector-add-brushstroke="" disabled={!ids.length} onclick={() => controller.addBrushstroke({ brushId: vectorBrushstrokeBrushes()[0].id, seed: randomVectorBrushstrokeSeed() }, { ids })}>✎+</button>
      {/if}
    </div>
    <!-- Top layer first, as it draws. -->
    {#each [...layers].reverse() as l (`${l.kind}-${l.index}`)}{@render layerRow(l, layers.length, ids)}{/each}
  </div>
{/snippet}

{#if panel}
  <div class="space-y-2 {className}" data-vector-appearance="" aria-label="Appearance">
    {#if panel.pathIds.length}
      {@render stack('stroke', panel.strokes, panel.mixed.strokes, panel.pathIds)}
      {@render stack('fill', panel.fills, panel.mixed.fills, panel.pathIds)}
    {/if}
    <label class="flex items-center gap-2 text-xs text-foreground" data-vector-style="blendMode">
      <span class="w-16">Blend</span>
      <select aria-label="Blend mode" class={selectClass} value={panel.blendMode} onchange={(e) => panel && controller.setBlendMode(e.currentTarget.value as VectorBlendMode, { ids: panel.nodeIds })}>
        {#each VECTOR_BLEND_MODE_MENU as m (m.mode)}<option value={m.mode}>{m.label}</option>{/each}
      </select>
      {#if panel.mixed.blendMode}<span class="text-[11px] text-muted-foreground">Mixed</span>{/if}
    </label>
    <div class="space-y-2" data-vector-filters="">
      <div class="flex items-center gap-2">
        <span class="w-16 {headingClass}">Filters</span>
        <select
          aria-label="Add filter"
          class={selectClass}
          value=""
          onchange={(e) => {
            const type = e.currentTarget.value;
            e.currentTarget.value = '';
            if (type && panel) controller.addFilter(type as VectorFilterType, { ids: panel.nodeIds });
          }}
        >
          <option value="">Add filter…</option>
          {#each VECTOR_FILTER_MENU as m (m.type)}<option value={m.type}>{m.label}</option>{/each}
        </select>
      </div>
      {#if !panel.filterNodeId}<p class="text-[11px] text-muted-foreground">Select one object to edit its filters.</p>{/if}
      {#if panel.filterNodeId}
        {@const nodeId = panel.filterNodeId}
        {#each panel.filters as f, i (f.id)}
          <div class="space-y-1 rounded border border-border p-1.5" data-vector-filter={f.id} data-vector-filter-type={f.type}>
            <div class="flex items-center gap-1">
              <label class="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium text-foreground">
                <input type="checkbox" aria-label="{f.label} on" checked={f.enabled} onchange={(e) => controller.updateFilter(nodeId, f.id, { enabled: e.currentTarget.checked })} />
                <span class="truncate">{f.label}</span>
              </label>
              <button type="button" class={buttonClass} title="Move up" aria-label="Move {f.label} up" disabled={i === 0} onclick={() => controller.moveFilter(nodeId, f.id, i - 1)}>↑</button>
              <button type="button" class={buttonClass} title="Move down" aria-label="Move {f.label} down" disabled={i === panel.filters.length - 1} onclick={() => controller.moveFilter(nodeId, f.id, i + 1)}>↓</button>
              <button type="button" class={buttonClass} title="Remove" aria-label="Remove {f.label}" onclick={() => controller.removeFilter(nodeId, f.id)}>×</button>
            </div>
            {#each f.specs as spec (spec.key)}
              {#if spec.kind === 'color'}
                <label class="flex items-center gap-2 text-xs text-foreground" data-vector-filter-param={spec.key}>
                  <span class="w-14 truncate text-[11px] text-muted-foreground">{spec.label}</span>
                  <input
                    type="color"
                    aria-label="{f.label} {spec.label}"
                    class="h-7 w-10 cursor-pointer rounded border border-border bg-background"
                    value={hexOf(f.params[spec.key])}
                    oninput={(e) => setFilter(f, spec.key, e.currentTarget.value, true)}
                    onblur={end}
                  />
                </label>
              {:else if spec.kind === 'number'}
                {@const value = Number(f.params[spec.key] ?? 0)}
                <label class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground" data-vector-filter-param={spec.key}>
                  <span class={labelClass}>{spec.label}</span>
                  {#if spec.slider}
                    <input
                      type="range"
                      min={spec.min}
                      max={spec.max}
                      step={spec.step}
                      aria-label="{f.label} {spec.label} slider"
                      class="h-4 min-w-0 flex-1 accent-primary"
                      {value}
                      oninput={(e) => setFilterNumber(f, spec.key, e.currentTarget.value)}
                      onpointerup={end}
                      onkeyup={end}
                      onblur={end}
                    />
                  {/if}
                  <input
                    type="number"
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    aria-label="{f.label} {spec.label}"
                    class={numberClass}
                    value={round(value)}
                    oninput={(e) => setFilterNumber(f, spec.key, e.currentTarget.value)}
                    onblur={end}
                  />
                </label>
              {/if}
            {/each}
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}
