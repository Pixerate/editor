<script lang="ts">
  import type { AnimationEditorController, MotionEffectResult } from '@pixerate/editor/animation-editor';
  import { pathControlsOf } from '@pixerate/editor/effects';
  import EffectParameters from '../effects/EffectParameters.svelte';
  import { effectDescriptionOf } from '../effects/effects.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    instance: string;
    effect: string;
    values: Readonly<Record<string, unknown>>;
    pathNodes?: readonly string[];
    defaultPathNode?: string;
    disabled?: boolean;
  }

  let { controller, instance, effect, values, pathNodes = [], defaultPathNode = '', disabled = false }: Props = $props();
  const loaded = effectDescriptionOf(() => controller.effectsProvider, () => effect);
  let message = $state<string | null>(null);
  let pathNode = $state('');
  let words = $state('');
  const chosenPathNode = $derived(
    pathNode && pathNodes.includes(pathNode) ? pathNode : defaultPathNode && pathNodes.includes(defaultPathNode) ? defaultPathNode : pathNodes[0] ?? ''
  );
  const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';
  const report = (r: Promise<MotionEffectResult>) => void r.then((x) => (message = x.ok ? null : x.error));
</script>

<!-- One applied effect's controls, loaded from the provider. -->
{#if !controller.effectsProvider}
  <p class="text-[11px] text-muted-foreground">No effects provider: its commands are kept as they are.</p>
{:else if loaded.error}
  <p class="text-[11px] text-amber-500">{loaded.error}</p>
{:else if !loaded.description}
  <p class="text-[11px] text-muted-foreground">Loading…</p>
{:else}
  {@const description = loaded.description}
  {@const pathControls = pathControlsOf(description)}
  {#if pathControls.length > 0}
    <div class="mb-1 flex flex-wrap items-center gap-1" data-effect-part="path">
      <span class="text-muted-foreground">Path</span>
      <select
        class="rounded border border-border bg-transparent px-1 py-0.5 text-[11px]"
        aria-label="Path node"
        value={chosenPathNode}
        disabled={disabled || !pathNodes.length}
        onchange={(e) => (pathNode = e.currentTarget.value)}
      >
        <option value="">Path node…</option>
        {#each pathNodes as id (id)}<option value={id}>{id}</option>{/each}
      </select>
      <button type="button" class={btn} disabled={disabled || !chosenPathNode} onclick={() => report(controller.setVectorEffectPath(instance, { node: chosenPathNode }))}>
        Use path node
      </button>
      {#if controller.effectsProvider.pathFromText}
        <input
          class="w-24 rounded border border-border bg-transparent px-1 py-0.5"
          aria-label="Words to write along the path"
          placeholder="Words"
          bind:value={words}
          {disabled}
        />
        <button type="button" class={btn} disabled={disabled || !words.trim()} onclick={() => report(controller.setVectorEffectPath(instance, { text: words }))}>
          Write
        </button>
      {/if}
      <button type="button" class={btn} {disabled} onclick={() => report(controller.updateMotionEffect(instance, { [pathControls[0]]: '' }))}>
        Clear path
      </button>
    </div>
  {/if}
  <EffectParameters
    {description}
    {values}
    {disabled}
    onchange={(k, v, g) => report(controller.updateMotionEffect(instance, { [k]: v as never }, { merge: g ?? undefined }))}
    onreset={(k) => report(controller.updateMotionEffect(instance, { [k]: null }))}
    onpreset={(v) => report(controller.updateMotionEffect(instance, v as never))}
  />
  {#if message}<p role="alert" class="text-[11px] text-destructive">{message}</p>{/if}
{/if}
