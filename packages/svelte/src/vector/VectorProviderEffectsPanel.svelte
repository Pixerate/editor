<script lang="ts">
  import { untrack } from 'svelte';
  import type { EffectProvider } from '@pixerate/editor/effects';
  import type { VectorEditorController } from '@pixerate/editor/vector';
  import EffectsBrowser from '../effects/EffectsBrowser.svelte';
  import VectorProviderEffectControls from './VectorProviderEffectControls.svelte';
  import { vectorStateOf } from './subscribe.svelte.js';

  interface Props {
    controller: VectorEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();
  const view = vectorStateOf(() => controller);
  let provider = $state.raw<EffectProvider | null>(untrack(() => controller.effects.provider));
  $effect(() => {
    const c = controller;
    provider = c.effects.provider;
    return untrack(() => c.effects.subscribe((p) => (provider = p)));
  });
  let browse = $state(false);
  let message = $state<string | null>(null);
  const groups = $derived.by(() => {
    void view.current.document;
    return controller.vectorEffectGroups();
  });
  const selected = $derived(groups.filter((g) => view.current.selection.includes(g.id)));
  const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';
  function run(work: () => unknown) {
    message = null;
    Promise.resolve()
      .then(work)
      .catch((e: unknown) => (message = e instanceof Error ? e.message : String(e)));
  }
</script>

<!--
  Provider vector effects in a drawing: add one (its picture at rest becomes a selected group of
  editable shapes), draw it again with new values, or detach it to keep the shapes. Motion is
  applied in the animation editor.
-->
<section class="flex flex-col gap-2 text-xs {className}" aria-label="Vector effects" data-vector-provider-effects="">
  <div class="flex items-center gap-1">
    <span class="flex-1 font-semibold">Effects</span>
    <button type="button" class={btn} disabled={!provider} aria-pressed={browse} onclick={() => (browse = !browse)}>Add effect…</button>
  </div>
  {#if !provider}<p class="text-[11px] text-muted-foreground">No effects provider is registered. Effect groups are kept as shapes.</p>{/if}
  {#if browse}
    <EffectsBrowser {provider} kinds={['vector']} title="Vector effects" onpick={(e) => ((browse = false), run(() => controller.addVectorEffect(e.id)))} />
  {/if}
  {#each selected as g (g.id)}
    <div class="space-y-1 rounded border border-border p-1" data-vector-effect-group={g.id}>
      <div class="flex items-center gap-1">
        <span class="min-w-0 flex-1 truncate font-medium">{g.providerEffect?.name ?? g.providerEffect?.effect}</span>
        <button type="button" class={btn} title="Keep the shapes as a plain group" onclick={() => run(() => controller.detachVectorEffect(g.id))}>Detach</button>
      </div>
      <VectorProviderEffectControls {controller} group={g} />
    </div>
  {/each}
  {#if groups.length > 0 && !selected.length}<p class="text-[11px] text-muted-foreground">Select an effect group ({groups.length} in the drawing) to change it.</p>{/if}
  {#if message}<p role="alert" class="text-[11px] text-destructive">{message}</p>{/if}
</section>
