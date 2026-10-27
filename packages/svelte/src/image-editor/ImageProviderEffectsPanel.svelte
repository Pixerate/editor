<script lang="ts">
  import { imageOutlineButtonClass } from './styles.js';
  import { findLayer, type ImageEditorController, type ImageLayer, type SmartObjectLayer } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';
  import EffectsBrowser from '../effects/EffectsBrowser.svelte';
  import ImageEffectControls from './ImageEffectControls.svelte';

  interface Props {
    controller: ImageEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();
  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });
  let browse = $state<null | 'filter' | 'layer'>(null);
  let message = $state<string | null>(null);
  let open = $state<string | null>(null);
  const snapshot = $derived.by(() => {
    void tick;
    const s = controller.getState();
    const layer: ImageLayer | null = s.activeLayerId ? (findLayer(s.layers, s.activeLayerId)?.layer ?? null) : null;
    return { provider: controller.effectsProvider, layer };
  });
  const provider = $derived(snapshot.provider);
  const layer = $derived(snapshot.layer);
  const all = $derived(layer?.type === 'smart' ? ((layer as SmartObjectLayer).smartFilters?.filters ?? []) : []);
  const generator = $derived(layer?.type === 'pixel' ? layer.generator : undefined);
  const canFilter = $derived(!!layer && layer.type !== 'adjustment' && layer.type !== 'annotation');
  const drags = new Set<string>();
  /** Changes during a drag skip the undo stack after the first, so the drag is one step. */
  function commit(gesture: string | null) {
    if (!gesture) return true;
    if (drags.has(gesture)) return false;
    drags.add(gesture);
    return true;
  }
  function run(work: () => unknown) {
    message = null;
    Promise.resolve()
      .then(work)
      .catch((e: unknown) => (message = e instanceof Error ? e.message : String(e)));
  }
</script>

<!--
  Provider effects for the active layer: its effect smart filters (apply, turn on and off, opacity,
  reorder, change controls, remove) and, for an effect layer, its own controls; plus adding effect
  layers. Applying a filter effect to a pixel layer converts it to a smart object in the same undo
  step. Without a provider it says why nothing can be added.
-->
<section class="flex flex-col gap-2 text-xs {className}" aria-label="Provider effects" data-image-provider-effects="">
  <div class="flex items-center gap-1">
    <span class="flex-1 text-[11px] font-semibold uppercase tracking-wider text-foreground">Effects</span>
    <button type="button" class={imageOutlineButtonClass} disabled={!provider || !canFilter} aria-pressed={browse === 'filter'} onclick={() => (browse = browse === 'filter' ? null : 'filter')}>Apply effect…</button>
    <button type="button" class={imageOutlineButtonClass} disabled={!provider} aria-pressed={browse === 'layer'} onclick={() => (browse = browse === 'layer' ? null : 'layer')}>Effect layer…</button>
  </div>
  {#if !provider}<p class="text-[11px] text-muted-foreground">No effects provider is registered. Effects in the document are kept.</p>{/if}
  {#if browse === 'filter' && layer}
    {@const id = layer.id}
    <EffectsBrowser {provider} uses={['filter']} title="Filters" onpick={(e) => ((browse = null), run(() => controller.applyEffectFilter(id, e.id)))} />
  {/if}
  {#if browse === 'layer'}
    <EffectsBrowser {provider} uses={['generator', 'overlay', 'title']} title="Generators and overlays" onpick={(e) => ((browse = null), run(() => controller.addEffectLayer(e.id)))} />
  {/if}
  {#if generator && layer}
    {@const id = layer.id}
    <div class="space-y-1" data-effect-part="generator">
      <div class="flex items-center gap-1">
        <span class="flex-1 font-medium text-foreground">{generator.name ?? generator.effect}</span>
        <button type="button" class={imageOutlineButtonClass} title="Keep the pixels as a plain layer" onclick={() => run(() => controller.rasterizeEffectLayer(id))}>Rasterize</button>
      </div>
      <ImageEffectControls
        {provider}
        effect={generator.effect}
        name={generator.name}
        values={generator.values}
        onchange={(k, v, g) => run(() => controller.updateEffectLayer(id, { values: { [k]: v as never } }, commit(g)))}
        onpreset={(values) => run(() => controller.updateEffectLayer(id, { values: values as never }))}
      />
    </div>
  {/if}
  {#if layer && all.some((f) => f.kind === 'effect')}
    {@const id = layer.id}
    <ol class="space-y-1" data-effect-part="filters">
      {#each all as f, index (f.id)}
        {#if f.kind === 'effect'}
          {@const label = f.name ?? f.effect}
          <li class="rounded border border-border p-1" data-smart-effect={f.id}>
            <div class="flex items-center gap-1">
              <input type="checkbox" checked={f.enabled} aria-label="{label} on" onchange={(e) => {
                const enabled = e.currentTarget.checked;
                run(() => controller.updateEffectFilter(id, f.id, { enabled }));
              }} />
              <button type="button" class="min-w-0 flex-1 truncate text-left text-foreground" aria-expanded={open === f.id} onclick={() => (open = open === f.id ? null : f.id)}>{label}</button>
              <button type="button" class={imageOutlineButtonClass} disabled={index === all.length - 1} aria-label="Move up" onclick={() => run(() => controller.updateEffectFilter(id, f.id, { index: index + 1 }))}>↑</button>
              <button type="button" class={imageOutlineButtonClass} disabled={index === 0} aria-label="Move down" onclick={() => run(() => controller.updateEffectFilter(id, f.id, { index: index - 1 }))}>↓</button>
              <button type="button" class={imageOutlineButtonClass} aria-label="Remove {label}" onclick={() => run(() => controller.removeSmartFilter(id, f.id))}>✕</button>
            </div>
            {#if open === f.id}
              <div class="mt-1 space-y-2">
                <label class="flex items-center gap-1">
                  <span class="w-14 text-[11px] text-foreground">Opacity</span>
                  <input type="range" min="0" max="1" step="0.01" class="flex-1" value={f.opacity} aria-label="{label} opacity" oninput={(e) => {
                    const opacity = Number(e.currentTarget.value);
                    run(() => controller.updateEffectFilter(id, f.id, { opacity }));
                  }} />
                </label>
                <ImageEffectControls
                  {provider}
                  effect={f.effect}
                  name={f.name}
                  values={f.values}
                  onchange={(k, v, g) => run(() => controller.updateEffectFilter(id, f.id, { values: { [k]: v as never } }, commit(g)))}
                  onpreset={(values) => run(() => controller.updateEffectFilter(id, f.id, { values: values as never }))}
                />
              </div>
            {/if}
          </li>
        {/if}
      {/each}
    </ol>
  {/if}
  {#if !layer}<p class="text-[11px] text-muted-foreground">Select a layer to apply effects to it.</p>{/if}
  {#if message}<p role="alert" class="text-[11px] text-destructive">{message}</p>{/if}
</section>
