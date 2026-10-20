<script lang="ts">
  import type { AnimationEditorController, MotionEffectResult } from '@pixerate/editor/animation-editor';
  import EffectParameters from '../effects/EffectParameters.svelte';
  import { effectDescriptionOf } from '../effects/effects.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    instance: string;
    effect: string;
    values: Readonly<Record<string, unknown>>;
  }

  let { controller, instance, effect, values }: Props = $props();
  const loaded = effectDescriptionOf(() => controller.effectsProvider, () => effect);
  let message = $state<string | null>(null);
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
  <EffectParameters
    description={loaded.description}
    {values}
    onchange={(k, v, g) => report(controller.updateMotionEffect(instance, { [k]: v as never }, { merge: g ?? undefined }))}
    onreset={(k) => report(controller.updateMotionEffect(instance, { [k]: null }))}
    onpreset={(v) => report(controller.updateMotionEffect(instance, v as never))}
  />
  {#if message}<p role="alert" class="text-[11px] text-destructive">{message}</p>{/if}
{/if}
