<script lang="ts">
  import {
    VECTOR_BLEND_SPACINGS,
    VECTOR_BLEND_SPACING_LABELS,
    applyVectorBlendOptions,
    getVectorBlendControls,
    type VectorBlendSpacing,
    type VectorEditorController
  } from '@pixerate/editor/vector';
  import { vectorStateOf } from './subscribe.svelte.js';
  import { vectorButtonClass } from './styles.js';

  /** Blend buttons and options: they edit the selected blends and the options new blends get. */
  let { controller }: { controller: VectorEditorController } = $props();

  const store = vectorStateOf(() => controller);
  const blend = $derived(getVectorBlendControls(store.current));
  const o = $derived(blend.options);
  const selected = $derived(blend.ids.length > 0);
</script>

<div class="ml-1 flex items-center gap-1" role="group" aria-label="Blend" data-vector-blend-controls="">
  <button type="button" data-vector-blend-action="make" class={vectorButtonClass} title="Make Blend" aria-label="Make Blend" disabled={!blend.canBlend} onclick={() => controller.blend()}>⧓</button>
  <select
    aria-label="Blend spacing"
    class="h-7 rounded border border-border bg-background px-1 text-xs"
    value={o.spacing}
    onchange={(e) => applyVectorBlendOptions(controller, { spacing: e.currentTarget.value as VectorBlendSpacing })}
  >
    {#each VECTOR_BLEND_SPACINGS as sp (sp)}
      <option value={sp}>{VECTOR_BLEND_SPACING_LABELS[sp]}</option>
    {/each}
  </select>
  {#if o.spacing !== 'smoothColor'}
    <input
      type="number"
      min={o.spacing === 'steps' ? 1 : 0.5}
      step="1"
      aria-label={o.spacing === 'steps' ? 'Blend steps' : 'Blend distance'}
      class="h-7 w-16 rounded border border-border bg-background px-1.5 text-xs"
      value={o.spacing === 'steps' ? o.steps : o.distance}
      oninput={(e) => {
        const n = parseFloat(e.currentTarget.value);
        if (!Number.isFinite(n) || n <= 0) return;
        applyVectorBlendOptions(controller, o.spacing === 'steps' ? { steps: n } : { distance: n });
      }}
    />
  {/if}
  <button
    type="button"
    data-vector-blend-action="orient"
    class={vectorButtonClass}
    aria-pressed={o.orientToSpine}
    title="Orient steps to the spine"
    aria-label="Orient to spine"
    onclick={() => applyVectorBlendOptions(controller, { orientToSpine: !o.orientToSpine })}>⤿</button
  >
  <button
    type="button"
    data-vector-blend-action="spine"
    class={vectorButtonClass}
    title="Replace Spine (select a blend and a path)"
    aria-label="Replace Spine"
    disabled={!blend.canReplaceSpine}
    onclick={() => controller.replaceBlendSpine()}>⌇</button
  >
  <button type="button" data-vector-blend-action="expand" class={vectorButtonClass} title="Expand Blend" aria-label="Expand Blend" disabled={!selected} onclick={() => controller.expandBlend()}>⧉</button>
  <button type="button" data-vector-blend-action="release" class={vectorButtonClass} title="Release Blend" aria-label="Release Blend" disabled={!selected} onclick={() => controller.releaseBlend()}>⧄</button>
</div>
