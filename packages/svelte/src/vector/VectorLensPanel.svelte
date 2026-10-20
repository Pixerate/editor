<script lang="ts">
  import { VECTOR_LENS_LABELS, VECTOR_LENS_SPECS, VECTOR_LENS_TYPES, type VectorEditorController, type VectorLensType, type VectorPathNode } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';

  /**
   * Lens: for a selected closed path, what it does to what is below it (none, magnify, fish eye,
   * brighten, invert, tinted grayscale, colour add, colour limit, heat map, wireframe,
   * transparency), its amount and colour. Each change is one undo step.
   */
  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();

  const store = vectorStateOf(() => controller);
  const view = $derived(store.current);
  const path = $derived(
    view.selection.map((id) => controller.getNode(id)).find((n): n is VectorPathNode => n?.type === 'path' && n.subpaths.some((sp) => sp.closed) && !n.connector) ?? null
  );
  const lens = $derived(path?.lens ?? null);
  const spec = $derived(lens ? VECTOR_LENS_SPECS[lens.type] : null);
  const ids = $derived(path ? [path.id] : []);

  const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
  const numberClass = 'h-7 w-16 rounded border border-border bg-background px-1.5 text-xs';
</script>

{#if path}
  <div class="space-y-2 {className}" data-vector-lens-panel="" aria-label="Lens">
    <div class="flex flex-wrap items-center gap-1">
      <span class="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Lens</span>
      <select
        aria-label="Lens type"
        class={selectClass}
        value={lens?.type ?? ''}
        onchange={(e) => (e.currentTarget.value ? controller.setLens({ type: e.currentTarget.value as VectorLensType }, { ids }) : controller.setLens(null, { ids }))}
      >
        <option value="">None</option>
        {#each VECTOR_LENS_TYPES as t (t)}<option value={t}>{VECTOR_LENS_LABELS[t]}</option>{/each}
      </select>
    </div>
    {#if lens && spec}
      <div class="flex flex-wrap items-center gap-1">
        <span class="w-16"></span>
        <input
          type="number"
          aria-label="Lens amount"
          title={`Amount: ${spec.unit} (${spec.min} to ${spec.max})`}
          class={numberClass}
          min={spec.min}
          max={spec.max}
          step={lens.type === 'magnify' ? 0.1 : 1}
          value={lens.amount}
          oninput={(e) => {
            const v = parseFloat(e.currentTarget.value);
            if (Number.isFinite(v) && spec) controller.setLens({ amount: Math.min(spec.max, Math.max(spec.min, v)) }, { ids, merge: `lens-amount-${path!.id}` });
          }}
        />
        {#if spec.color !== null}
          <input type="color" aria-label="Lens colour" title="Lens colour" class="h-7 w-9 rounded border border-border bg-background" value={lens.color ?? spec.color} oninput={(e) => controller.setLens({ color: e.currentTarget.value }, { ids, merge: `lens-color-${path!.id}` })} />
        {/if}
      </div>
    {/if}
  </div>
{/if}
