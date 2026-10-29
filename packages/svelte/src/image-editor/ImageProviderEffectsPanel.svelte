<script lang="ts">
  import { imageOutlineButtonClass } from './styles.js';
  import { EFFECT_LAYER_USES, LAYER_EFFECT_MENU, effectLayerTiming, findLayer, layerEffectsPanel, type ImageEditorController, type ImageLayer, type LayerEffectKind, type SmartObjectLayer } from '@pixerate/editor/image-editor';
  import { untrack } from 'svelte';
  import EffectsBrowser from '../effects/EffectsBrowser.svelte';
  import { effectDescriptionOf } from '../effects/effects.svelte.js';
  import ImageEffectControls from './ImageEffectControls.svelte';
  import LayerEffectsPanel from './LayerEffectsPanel.svelte';
  import ImageCheckbox from './controls/ImageCheckbox.svelte';
  import ImageRange from './controls/ImageRange.svelte';
  import ImageSelect from './controls/ImageSelect.svelte';
  import type { ParameterComponents } from '../parameters/index.js';

  interface Props {
    controller: ImageEditorController;
    /** Host controls for the effects' parameters. */
    components?: ParameterComponents;
    class?: string;
  }

  let { controller, components, class: className = '' }: Props = $props();
  let tick = $state(0);
  $effect(() => {
    const c = controller;
    return untrack(() => c.subscribe(() => tick++));
  });
  /** The open effect browser: filters to apply, or effects to change an effect layer to. */
  let browse = $state<null | 'filter' | 'change'>(null);
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
  const styles = $derived(layerEffectsPanel(layer));
  const described = effectDescriptionOf(() => provider, () => generator?.effect);
  const timing = $derived(generator ? effectLayerTiming(generator, described.description) : null);
  const addOptions = $derived([
    ...(provider && canFilter ? [{ value: 'filter', label: 'Filter…' }] : []),
    ...(styles.available && !styles.readOnly ? LAYER_EFFECT_MENU.map((m) => ({ value: `style:${m.kind}`, label: m.label })) : []),
  ]);
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
  function add(value: string) {
    const id = layer?.id;
    if (!value || !id) return;
    if (value === 'filter') browse = browse === 'filter' ? null : 'filter';
    else run(() => controller.addLayerEffect(id, value.slice('style:'.length) as LayerEffectKind));
  }

  // Scrubbing the frame draws the effect again: one render at a time, the latest frame wins.
  let scrub: { layerId: string; time: number; commit: boolean } | null = null;
  let scrubbing = false;
  let gesture: string | null = null;
  let scrubbed = $state<number | null>(null);
  function scrubTo(layerId: string, time: number) {
    scrubbed = time;
    scrub = { layerId, time, commit: commit(gesture) };
    if (scrubbing) return;
    scrubbing = true;
    const next = (): Promise<void> => {
      const s = scrub;
      scrub = null;
      if (!s) return Promise.resolve();
      return controller.updateEffectLayer(s.layerId, { time: s.time }, s.commit).then(next);
    };
    next()
      .catch((e: unknown) => (message = e instanceof Error ? e.message : String(e)))
      .finally(() => {
        scrubbing = false;
        scrubbed = null;
      });
  }
  const fmt = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
</script>

<!--
  Effects for the active layer, in one place. An effect layer first: its effect (change it or
  rasterize it), a still frame or an animation for an effect that moves, and its controls. Then
  what is applied to any layer: provider filters (smart filters; applying one converts a pixel
  layer to a smart object in the same undo step) and layer styles, added from one menu. New
  effect layers come from the layers panel. Without a provider it says why nothing can be added.
-->
<section class="flex flex-col gap-2 text-xs {className}" aria-label="Effects" data-image-provider-effects="">
  {#if !provider}<p class="text-[11px] text-muted-foreground">No effects provider is registered. Effects in the document are kept.</p>{/if}
  {#if generator && layer}
    {@const id = layer.id}
    <div class="space-y-2" data-effect-part="generator">
      <div class="flex items-center gap-1">
        <span class="min-w-0 flex-1 truncate font-medium text-foreground" title={generator.name ?? generator.effect}>{generator.name ?? generator.effect}</span>
        <button type="button" class={imageOutlineButtonClass} disabled={!provider} aria-pressed={browse === 'change'} onclick={() => (browse = browse === 'change' ? null : 'change')}>Change…</button>
        <button type="button" class={imageOutlineButtonClass} title="Keep the pixels as a plain layer" onclick={() => run(() => controller.rasterizeEffectLayer(id))}>Rasterize</button>
      </div>
      {#if browse === 'change'}
        <EffectsBrowser {provider} uses={EFFECT_LAYER_USES} title="Change the effect to" onpick={(e) => ((browse = null), run(() => controller.updateEffectLayer(id, { effect: e.id })))} />
      {/if}
      {#if timing}
        {@const shown = scrubbed ?? timing.time}
        <div class="space-y-1.5 rounded border border-border p-1.5" data-effect-part="timing" role="group" aria-label="Frames">
          <div class="flex gap-1" role="radiogroup" aria-label="Output">
            <button type="button" role="radio" aria-checked={timing.mode === 'still'} class="{imageOutlineButtonClass} flex-1 {timing.mode === 'still' ? 'bg-accent text-accent-foreground' : ''}" onclick={() => run(() => controller.updateEffectLayer(id, { animate: null }))}>Still frame</button>
            <button type="button" role="radio" aria-checked={timing.mode === 'animate'} class="{imageOutlineButtonClass} flex-1 {timing.mode === 'animate' ? 'bg-accent text-accent-foreground' : ''}" onclick={() => run(() => controller.updateEffectLayer(id, { animate: { duration: timing.duration } }))}>Animate</button>
          </div>
          <label class="flex items-center gap-1.5">
            <span class="w-16 shrink-0 text-[11px] text-foreground">{timing.mode === 'still' ? 'Frame' : 'Starts at'}</span>
            <ImageRange
              min={0}
              max={timing.range}
              step={Math.max(1, Math.round(timing.range / 200))}
              class="flex-1"
              value={shown}
              label={timing.mode === 'still' ? 'Frame' : 'Starts at'}
              onstart={() => (gesture = `time:${Date.now()}`)}
              onend={() => (gesture = null)}
              oninput={(t) => scrubTo(id, t)}
            />
            <span class="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{fmt(shown)}</span>
          </label>
          {#if timing.mode === 'animate'}
            <label class="flex items-center gap-1.5">
              <span class="w-16 shrink-0 text-[11px] text-foreground">Length</span>
              <input
                type="number"
                aria-label="Animation length in seconds"
                min="0.1"
                max="60"
                step="0.1"
                value={Math.round(timing.duration / 100) / 10}
                class="w-16 rounded border border-border bg-muted px-1 text-foreground"
                onchange={(e) => {
                  const s = Number((e.currentTarget as HTMLInputElement).value);
                  if (s > 0) run(() => controller.updateEffectLayer(id, { animate: { duration: Math.min(60, s) * 1000 } }));
                }}
              />
              <span class="text-muted-foreground">s{timing.loops ? ` · loops every ${fmt(timing.range)}` : ''}</span>
            </label>
          {/if}
        </div>
      {/if}
      <ImageEffectControls
        {provider}
        effect={generator.effect}
        name={generator.name}
        values={generator.values}
        {components}
        onchange={(k, v, g) => run(() => controller.updateEffectLayer(id, { values: { [k]: v as never } }, commit(g)))}
        onpreset={(values) => run(() => controller.updateEffectLayer(id, { values: values as never }))}
      />
    </div>
  {/if}
  {#if layer && canFilter}
    <div class="flex items-center gap-1" data-effect-part="applied">
      <span class="flex-1 text-[11px] font-semibold uppercase tracking-wider text-foreground">{generator ? 'On this layer' : 'Effects'}</span>
      {#if addOptions.length}
        <ImageSelect label="Add effect" value="" placeholder="Add…" options={addOptions} onchange={add} />
      {/if}
    </div>
    {#if browse === 'filter'}
      {@const id = layer.id}
      <EffectsBrowser {provider} uses={['filter']} title="Filters" onpick={(e) => ((browse = null), run(() => controller.applyEffectFilter(id, e.id)))} />
    {/if}
  {/if}
  {#if layer && all.some((f) => f.kind === 'effect')}
    {@const id = layer.id}
    <ol class="space-y-1" data-effect-part="filters" aria-label="Filters">
      {#each all as f, index (f.id)}
        {#if f.kind === 'effect'}
          {@const label = f.name ?? f.effect}
          <li class="rounded border border-border p-1" data-smart-effect={f.id}>
            <div class="flex items-center gap-1">
              <ImageCheckbox checked={f.enabled} label="{label} on" onchange={(enabled) => {
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
                  <ImageRange min={0} max={1} step={0.01} class="flex-1" value={f.opacity} label="{label} opacity" oninput={(opacity) => {
                    run(() => controller.updateEffectFilter(id, f.id, { opacity }));
                  }} />
                </label>
                <ImageEffectControls
                  {provider}
                  effect={f.effect}
                  name={f.name}
                  values={f.values}
                  {components}
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
  {#if layer && styles.available && styles.rows.length}
    <LayerEffectsPanel {controller} layerId={layer.id} heading={false} />
  {/if}
  {#if layer && canFilter && !generator && !all.some((f) => f.kind === 'effect') && !styles.rows.length}
    <p class="text-[11px] text-muted-foreground">No effects yet. Add a filter, or a style such as a drop shadow. New effect layers are added from the layers panel.</p>
  {/if}
  {#if !layer}<p class="text-[11px] text-muted-foreground">Select a layer to apply effects to it.</p>{/if}
  {#if message}<p role="alert" class="text-[11px] text-destructive">{message}</p>{/if}
</section>
