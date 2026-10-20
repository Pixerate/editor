<script lang="ts">
  import type { EffectProvider } from '@pixerate/editor/effects';
  import EffectParameters from '../effects/EffectParameters.svelte';
  import { effectDescriptionOf } from '../effects/effects.svelte.js';

  interface Props {
    provider: EffectProvider | null;
    effect: string;
    name?: string;
    values: Readonly<Record<string, unknown>>;
    onchange: (control: string, value: unknown, gesture: string | null) => void;
    onpreset: (values: Readonly<Record<string, unknown>>) => void;
  }

  let { provider, effect, name, values, onchange, onpreset }: Props = $props();
  const loaded = effectDescriptionOf(() => provider, () => effect);
</script>

<!-- One effect's controls, loaded from the provider; a note when it does not have the effect. -->
{#if !provider}
  <p class="text-[11px] text-slate-400">No effects provider: "{name ?? effect}" is kept but not drawn.</p>
{:else if loaded.error}
  <p class="text-[11px] text-amber-400">{loaded.error}</p>
{:else if !loaded.description}
  <p class="text-[11px] text-slate-400">Loading…</p>
{:else}
  {@const description = loaded.description}
  <EffectParameters {description} {values} {onchange} onreset={(k) => onchange(k, description.defaults[k], null)} {onpreset} />
{/if}
