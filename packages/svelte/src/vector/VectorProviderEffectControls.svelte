<script lang="ts">
  import type { VectorEditorController, VectorGroupNode } from '@pixerate/editor/vector';
  import EffectParameters from '../effects/EffectParameters.svelte';
  import { effectDescriptionOf } from '../effects/effects.svelte.js';

  interface Props {
    controller: VectorEditorController;
    group: VectorGroupNode;
  }

  let { controller, group }: Props = $props();
  const loaded = effectDescriptionOf(() => controller.effectsProvider, () => group.providerEffect?.effect);
  let message = $state<string | null>(null);
  const run = (work: Promise<unknown>) =>
    void work.then(
      () => (message = null),
      (e: unknown) => (message = e instanceof Error ? e.message : String(e)),
    );
</script>

<!-- One effect group's controls, loaded from the provider. -->
{#if !controller.effectsProvider}
  <p class="text-[11px] text-muted-foreground">No effects provider: the shapes are kept as they are.</p>
{:else if loaded.error}
  <p class="text-[11px] text-amber-500">{loaded.error}</p>
{:else if !loaded.description}
  <p class="text-[11px] text-muted-foreground">Loading…</p>
{:else}
  <EffectParameters
    description={loaded.description}
    values={group.providerEffect?.values ?? {}}
    onchange={(k, v) => run(controller.updateVectorEffect(group.id, { [k]: v as never }))}
    onreset={(k) => run(controller.updateVectorEffect(group.id, { [k]: null }))}
    onpreset={(v) => run(controller.updateVectorEffect(group.id, v as never))}
  />
  {#if message}<p role="alert" class="text-[11px] text-destructive">{message}</p>{/if}
{/if}
