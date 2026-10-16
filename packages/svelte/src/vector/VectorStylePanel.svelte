<script lang="ts">
  import { getVectorSelectionStyle, vectorPaintToHex, type VectorEditorController } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const style = $derived(getVectorSelectionStyle(view));
  const source = $derived(
    style ?? { fill: view.defaults.fill ?? null, stroke: view.defaults.stroke ?? null, strokeWidth: view.defaults.strokeWidth ?? 1, opacity: 1 }
  );

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
  {/if}
</div>
