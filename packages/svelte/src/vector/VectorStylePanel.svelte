<script lang="ts">
  import {
    VECTOR_ARROWHEADS,
    VECTOR_ARROWHEAD_LABELS,
    VECTOR_CORNER_KINDS,
    VECTOR_CORNER_KIND_LABELS,
    VECTOR_STROKE_ALIGN_LABELS,
    VECTOR_WIDTH_PRESETS,
    getVectorSelectionStyle,
    vectorPaintToHex,
    widthProfilePreset,
    widthProfilePresetId,
    type VectorCornerKind,
    type VectorEditorController,
    type VectorStrokeAlign,
    type VectorWidthPreset
  } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';
  import { vectorButtonClass } from './styles.js';
  import VectorEffectsPanel from './VectorEffectsPanel.svelte';
  import VectorAppearancePanel from './VectorAppearancePanel.svelte';
  import VectorEnvelopePanel from './VectorEnvelopePanel.svelte';
  import VectorMaskPanel from './VectorMaskPanel.svelte';
  import VectorTextPanel from './VectorTextPanel.svelte';
  import VectorSymbolsPanel from './VectorSymbolsPanel.svelte';
  import VectorConstraintsPanel from './VectorConstraintsPanel.svelte';
  import VectorFramePanel from './VectorFramePanel.svelte';
  import VectorConnectorPanel from './VectorConnectorPanel.svelte';
  import VectorShadingPanel from './VectorShadingPanel.svelte';
  import VectorTracePanel from './VectorTracePanel.svelte';
  import VectorSymmetryPanel from './VectorSymmetryPanel.svelte';
  import VectorPerspectivePanel from './VectorPerspectivePanel.svelte';
  import VectorLensPanel from './VectorLensPanel.svelte';
  import VectorGradientEditor from './VectorGradientEditor.svelte';

  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const style = $derived(getVectorSelectionStyle(view));
  const source = $derived.by(() => {
    if (style) return style;
    const d = view.defaults;
    return {
      fill: d.fill ?? null,
      stroke: d.stroke ?? null,
      strokeWidth: d.strokeWidth ?? 1,
      opacity: 1,
      strokeAlign: d.strokeAlign ?? 'center',
      startArrow: d.startArrow ?? null,
      endArrow: d.endArrow ?? null,
      arrowAlign: d.arrowAlign ?? 'extend',
      startArrowScale: d.startArrowScale ?? 1,
      endArrowScale: d.endArrowScale ?? 1,
      widthProfile: widthProfilePresetId(d.strokeWidthProfile),
      cornerRadius: d.cornerRadius,
      cornerKind: d.cornerKind ?? 'round',
      cornerSmoothing: 0,
      corners: 1,
      hasOpenPath: true
    };
  });
  const aligns = Object.keys(VECTOR_STROKE_ALIGN_LABELS) as VectorStrokeAlign[];
  const ends = [
    { end: 'start', key: 'startArrow', scaleKey: 'startArrowScale', label: 'Start' },
    { end: 'end', key: 'endArrow', scaleKey: 'endArrowScale', label: 'End' }
  ] as const;
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  const numberClass = 'h-7 w-16 rounded border border-border bg-background px-1.5 text-xs';

  function setCorners(patch: { radius?: number; kind?: VectorCornerKind }) {
    if (!style) controller.setDefaults({ ...(patch.radius !== undefined ? { cornerRadius: patch.radius } : {}), ...(patch.kind ? { cornerKind: patch.kind } : {}) });
    else if (patch.radius !== undefined) controller.setCornerRadius(patch.radius);
    else if (patch.kind) controller.setCornerKind(patch.kind);
  }

  function setProfile(id: VectorWidthPreset) {
    if (style) controller.setWidthProfile(id);
    else controller.setDefaults({ strokeWidthProfile: widthProfilePreset(id)?.length ? widthProfilePreset(id) : null });
  }

  function apply(patch: Record<string, unknown>) {
    if (style) controller.setStyle(patch);
    else controller.setDefaults(patch);
  }

  const paints = [
    { key: 'fill' as const, label: 'Fill' },
    { key: 'stroke' as const, label: 'Stroke' }
  ];
</script>

<div class="space-y-2 {className}" aria-label={style ? 'Selection style' : 'New shape style'}>
  <p class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{style ? 'Selection' : 'New shapes'}</p>
  {#each paints as { key, label } (key)}
    {@const paint = source[key]}
    {@const hex = vectorPaintToHex(paint)}
    {@const on = paint !== null && paint !== 'none'}
    <div class="flex items-center gap-2" data-vector-style={key}>
      <label class="flex w-16 items-center gap-1.5 text-xs text-foreground">
        <input type="checkbox" checked={on} aria-label="{label} on" onchange={(e) => apply({ [key]: e.currentTarget.checked ? (hex ?? '#000000') : null })} />
        {label}
      </label>
      <input
        type="color"
        aria-label="{label} colour"
        class="h-7 w-10 cursor-pointer rounded border border-border bg-background disabled:opacity-40"
        disabled={!on}
        value={hex ?? '#000000'}
        oninput={(e) => apply({ [key]: e.currentTarget.value })}
      />
      {#if on && !hex}<span class="truncate text-[11px] text-muted-foreground">{typeof paint === 'string' ? paint : 'Gradient'}</span>{/if}
      {#if style?.mixed[key]}<span class="text-[11px] text-muted-foreground">Mixed</span>{/if}
    </div>
  {/each}
  {#if style}<VectorGradientEditor {controller} />{/if}
  <label class="flex items-center gap-2 text-xs text-foreground">
    <span class="w-16">Width</span>
    <input
      type="number"
      min="0"
      step="0.5"
      aria-label="Stroke width"
      class="h-7 w-20 rounded border border-border bg-background px-1.5 text-xs"
      value={source.strokeWidth}
      oninput={(e) => {
        const n = parseFloat(e.currentTarget.value);
        if (Number.isFinite(n) && n >= 0) apply({ strokeWidth: n });
      }}
    />
  </label>
  <label class="flex items-center gap-2 text-xs text-foreground" data-vector-style="strokeAlign">
    <span class="w-16">Align</span>
    <select aria-label="Stroke alignment" class={selectClass} value={source.strokeAlign} onchange={(e) => apply({ strokeAlign: e.currentTarget.value })}>
      {#each aligns as a (a)}<option value={a}>{VECTOR_STROKE_ALIGN_LABELS[a]}</option>{/each}
    </select>
    {#if style?.mixed.strokeAlign}<span class="text-[11px] text-muted-foreground">Mixed</span>{/if}
  </label>
  <div class="flex items-center gap-2 text-xs text-foreground" data-vector-style="widthProfile">
    <span class="w-16">Profile</span>
    <select
      aria-label="Width profile"
      class={selectClass}
      value={source.widthProfile}
      onchange={(e) => {
        if (e.currentTarget.value !== 'custom') setProfile(e.currentTarget.value as VectorWidthPreset);
      }}
    >
      {#each VECTOR_WIDTH_PRESETS as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
      {#if source.widthProfile === 'custom'}<option value="custom" disabled>Custom</option>{/if}
    </select>
    <button
      type="button"
      class={vectorButtonClass}
      title="Reset to uniform width"
      aria-label="Reset to uniform width"
      disabled={source.widthProfile === 'uniform' && !style?.mixed.widthProfile}
      onclick={() => setProfile('uniform')}
    >
      ═
    </button>
    {#if style?.mixed.widthProfile}<span class="text-[11px] text-muted-foreground">Mixed</span>{/if}
  </div>
  {#if source.hasOpenPath}
    {#each ends as { key, scaleKey, label } (key)}
      <div class="flex items-center gap-2" data-vector-style={key}>
        <span class="w-16 text-xs text-foreground">{label}</span>
        <select aria-label="{label} arrowhead" class={selectClass} value={source[key] ?? ''} onchange={(e) => apply({ [key]: e.currentTarget.value || null })}>
          <option value="">None</option>
          {#each VECTOR_ARROWHEADS as h (h)}<option value={h}>{VECTOR_ARROWHEAD_LABELS[h]}</option>{/each}
        </select>
        <input
          type="number"
          min="0.1"
          step="0.25"
          aria-label="{label} arrowhead scale"
          title="Scale (× stroke width)"
          class={numberClass}
          value={source[scaleKey]}
          oninput={(e) => {
            const n = parseFloat(e.currentTarget.value);
            if (Number.isFinite(n) && n > 0) apply({ [scaleKey]: n });
          }}
        />
      </div>
    {/each}
    {#if source.startArrow || source.endArrow}
      <label class="flex items-center gap-2 text-xs text-foreground" data-vector-style="arrowAlign">
        <span class="w-16">Heads</span>
        <select aria-label="Arrowhead alignment" class={selectClass} value={source.arrowAlign} onchange={(e) => apply({ arrowAlign: e.currentTarget.value })}>
          <option value="extend">Tip past end</option>
          <option value="tip">Tip at end</option>
        </select>
      </label>
    {/if}
  {/if}
  {#if source.corners > 0}
    <div class="flex items-center gap-2" data-vector-style="corners">
      <span class="w-16 text-xs text-foreground">Corners</span>
      <input
        type="number"
        min="0"
        step="1"
        aria-label="Corner radius"
        class={numberClass}
        value={Math.round(source.cornerRadius * 100) / 100}
        oninput={(e) => {
          const n = parseFloat(e.currentTarget.value);
          if (Number.isFinite(n) && n >= 0) setCorners({ radius: n });
        }}
      />
      <select aria-label="Corner kind" class={selectClass} value={source.cornerKind} onchange={(e) => setCorners({ kind: e.currentTarget.value as VectorCornerKind })}>
        {#each VECTOR_CORNER_KINDS as k (k)}<option value={k}>{VECTOR_CORNER_KIND_LABELS[k]}</option>{/each}
      </select>
      {#if style?.mixed.cornerRadius}<span class="text-[11px] text-muted-foreground">Mixed</span>{/if}
    </div>
  {/if}
  {#if style && source.corners > 0 && source.cornerKind === 'round' && source.cornerRadius > 0}
    <label class="flex items-center gap-2 text-xs text-foreground" data-vector-style="corner-smoothing" title="Corner smoothing: squircle corners that ease into the curve (0.6 is iOS-like)">
      <span class="w-16">Smoothing</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        aria-label="Corner smoothing"
        class="h-4 flex-1 accent-primary"
        value={source.cornerSmoothing}
        oninput={(e) => controller.setCornerSmoothing(parseFloat(e.currentTarget.value), { merge: 'corner-smoothing' })}
        onpointerup={() => controller.endMergedEdit()}
      />
    </label>
  {/if}
  <VectorTextPanel {controller} />
  {#if style}
    <label class="flex items-center gap-2 text-xs text-foreground">
      <span class="w-16">Opacity</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        aria-label="Opacity"
        class="h-4 flex-1 accent-primary"
        value={source.opacity}
        oninput={(e) => apply({ opacity: parseFloat(e.currentTarget.value) })}
      />
    </label>
    <VectorAppearancePanel {controller} />
    <VectorEffectsPanel {controller} />
    <VectorEnvelopePanel {controller} />
    <VectorMaskPanel {controller} />
  {/if}
  <VectorFramePanel {controller} />
  <VectorConnectorPanel {controller} />
  <VectorShadingPanel {controller} />
  <VectorSymmetryPanel {controller} />
  <VectorPerspectivePanel {controller} />
  <VectorLensPanel {controller} />
  <VectorTracePanel {controller} />
  <VectorConstraintsPanel {controller} />
  <VectorSymbolsPanel {controller} />
</div>
