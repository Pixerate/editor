<script lang="ts">
  import {
    VECTOR_GRADIENT_TYPES,
    VECTOR_GRADIENT_SPREADS,
    VECTOR_GRADIENT_INTERPOLATIONS,
    VECTOR_STROKE_GRADIENT_MODES,
    VECTOR_GRADIENT_TYPE_LABELS,
    VECTOR_GRADIENT_SPREAD_LABELS,
    VECTOR_GRADIENT_INTERPOLATION_LABELS,
    VECTOR_STROKE_GRADIENT_MODE_LABELS,
    getVectorGradientEditor,
    vectorPaintToHex,
    type VectorEditorController,
    type VectorGradientInterpolation,
    type VectorGradientSpread,
    type VectorGradientType,
    type VectorStrokeGradientMode
  } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  /**
   * Gradient editor for the selection's fill or stroke: style (or solid), the stop ramp (click it
   * to add a stop, pick a stop to edit its colour, opacity, position and midpoint), interpolation
   * space, smoothness, spread, how it lies on a stroke, and reverse.
   */
  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const ed = $derived(getVectorGradientEditor(store.current));
  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  const numberClass = 'h-7 w-14 rounded border border-border bg-background px-1.5 text-xs';
  const buttonClass =
    'inline-flex h-7 min-w-7 items-center justify-center rounded border border-border bg-background px-1.5 text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
  const percent = (v: number) => Math.round(v * 1000) / 10;
  const end = () => controller.endMergedEdit();

  function setType(value: string) {
    if (!ed) return;
    if (value === 'solid') {
      const first = ed.stops[0];
      controller.setStyle({ [ed.target]: vectorPaintToHex(first?.color) ?? first?.color ?? '#000000' }, undefined, { label: 'Solid Colour' });
    } else controller.setGradient({ type: value as VectorGradientType });
  }

  function numberOf(e: Event & { currentTarget: HTMLInputElement }, fn: (n: number) => void) {
    const n = parseFloat(e.currentTarget.value);
    if (Number.isFinite(n)) fn(n);
  }

  function addAt(e: MouseEvent & { currentTarget: HTMLElement }) {
    const r = e.currentTarget.getBoundingClientRect();
    controller.addGradientStop(r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0.5);
  }
</script>

{#if ed}
  {@const sel = ed.selected}
  <div class="space-y-1.5 {className}" data-vector-gradient-editor={ed.target} aria-label="Gradient">
    <div class="flex items-center gap-1.5">
      <span class="w-16 text-xs text-foreground">Gradient</span>
      {#each ['fill', 'stroke'] as const as t (t)}
        <button type="button" class={buttonClass} aria-pressed={ed.target === t} onclick={() => controller.setGradientTarget(t)}>{t === 'fill' ? 'Fill' : 'Stroke'}</button>
      {/each}
      {#if ed.mixed}<span class="text-[11px] text-muted-foreground">Mixed</span>{/if}
    </div>
    <div class="flex items-center gap-1.5">
      <span class="w-16 text-xs text-foreground">Type</span>
      <select aria-label="Gradient type" class={selectClass} value={ed.type ?? 'solid'} onchange={(e) => setType(e.currentTarget.value)}>
        <option value="solid">Solid</option>
        {#each VECTOR_GRADIENT_TYPES as t (t)}<option value={t}>{VECTOR_GRADIENT_TYPE_LABELS[t]}</option>{/each}
      </select>
      <button type="button" class={buttonClass} aria-label="Reverse gradient" title="Reverse gradient" disabled={!ed.gradient} onclick={() => controller.reverseGradient()}>⇄</button>
    </div>
    {#if ed.gradient}
      <div class="relative h-8" data-vector-gradient-ramp="">
        <div
          role="button"
          tabindex="-1"
          aria-label="Add gradient stop"
          class="absolute inset-x-1.5 top-0 h-4 cursor-copy rounded border border-border"
          style="background-image: {ed.preview}, repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%); background-size: auto, 8px 8px"
          onclick={addAt}
          onkeydown={() => {}}
        ></div>
        {#each ed.stops as s (s.index)}
          <button
            type="button"
            data-vector-gradient-stop={s.index}
            aria-label="Gradient stop {s.index + 1} at {percent(s.offset)}%"
            aria-pressed={s.selected}
            class="absolute top-4 h-3.5 w-3 -translate-x-1/2 rounded-sm border border-border aria-pressed:ring-2 aria-pressed:ring-primary"
            style="left: calc(6px + (100% - 12px) * {s.offset}); background: {s.color}; opacity: {0.4 + 0.6 * (s.opacity ?? 1)}"
            onclick={() => controller.selectGradientStop(s.selected ? null : s.index)}
          ></button>
        {/each}
      </div>
      {#if sel}
        <div class="flex flex-wrap items-center gap-1.5" data-vector-gradient-selected-stop={sel.index}>
          <input
            type="color"
            aria-label="Stop colour"
            class="h-7 w-9 cursor-pointer rounded border border-border bg-background"
            value={vectorPaintToHex(sel.color) ?? '#000000'}
            oninput={(e) => controller.setGradientStop(sel.index, { color: e.currentTarget.value }, { merge: `gradient-stop-color-${sel.index}` })}
            onblur={end}
          />
          <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
            Opacity
            <input type="number" min="0" max="100" step="5" aria-label="Stop opacity" class={numberClass} value={percent(sel.opacity ?? 1)} oninput={(e) => numberOf(e, (n) => controller.setGradientStop(sel.index, { opacity: n / 100 }))} />
          </label>
          <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
            At
            <input type="number" min="0" max="100" step="1" aria-label="Stop position" class={numberClass} value={percent(sel.offset)} oninput={(e) => numberOf(e, (n) => controller.setGradientStop(sel.index, { offset: n / 100 }))} />
          </label>
          {#if !sel.last}
            <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
              Midpoint
              <input type="number" min="5" max="95" step="1" aria-label="Stop midpoint" class={numberClass} value={percent(sel.midpoint ?? 0.5)} oninput={(e) => numberOf(e, (n) => controller.setGradientStop(sel.index, { midpoint: n / 100 }))} />
            </label>
          {/if}
          <button type="button" class={buttonClass} aria-label="Delete stop" title="Delete stop" disabled={ed.stops.length <= 2} onclick={() => controller.removeGradientStop(sel.index)}>✕</button>
        </div>
      {/if}
      <label class="flex items-center gap-1.5 text-xs text-foreground">
        <span class="w-16">Colours</span>
        <select aria-label="Gradient interpolation" class={selectClass} value={ed.interpolation} onchange={(e) => controller.setGradient({ interpolation: e.currentTarget.value as VectorGradientInterpolation })}>
          {#each VECTOR_GRADIENT_INTERPOLATIONS as i (i)}<option value={i}>{VECTOR_GRADIENT_INTERPOLATION_LABELS[i]}</option>{/each}
        </select>
      </label>
      <label class="flex items-center gap-1.5 text-xs text-foreground">
        <span class="w-16">Smooth</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          aria-label="Gradient smoothness"
          class="h-4 flex-1 accent-primary"
          value={ed.smoothness}
          oninput={(e) => controller.setGradient({ smoothness: parseFloat(e.currentTarget.value) }, { merge: 'gradient-smoothness' })}
          onpointerup={end}
          onblur={end}
        />
      </label>
      <label class="flex items-center gap-1.5 text-xs text-foreground">
        <span class="w-16">Spread</span>
        <select aria-label="Gradient spread" class={selectClass} value={ed.spread} onchange={(e) => controller.setGradient({ spread: e.currentTarget.value as VectorGradientSpread })}>
          {#each VECTOR_GRADIENT_SPREADS as sp (sp)}<option value={sp}>{VECTOR_GRADIENT_SPREAD_LABELS[sp]}</option>{/each}
        </select>
      </label>
      {#if ed.target === 'stroke'}
        <label class="flex items-center gap-1.5 text-xs text-foreground">
          <span class="w-16">On stroke</span>
          <select aria-label="Gradient on stroke" class={selectClass} value={ed.strokeMode} onchange={(e) => controller.setGradient({ strokeMode: e.currentTarget.value as VectorStrokeGradientMode })}>
            {#each VECTOR_STROKE_GRADIENT_MODES as m (m)}<option value={m}>{VECTOR_STROKE_GRADIENT_MODE_LABELS[m]}</option>{/each}
          </select>
        </label>
      {/if}
    {/if}
  </div>
{/if}
