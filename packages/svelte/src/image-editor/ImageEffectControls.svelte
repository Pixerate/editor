<script lang="ts">
  import type { EffectProvider } from '@pixerate/editor/effects';
  import EffectParameters from '../effects/EffectParameters.svelte';
  import { effectDescriptionOf } from '../effects/effects.svelte.js';
  import { getImageEditorControls } from './controls/controls.js';
  import type { ParameterComponents } from '../parameters/index.js';

  interface Props {
    provider: EffectProvider | null;
    effect: string;
    name?: string;
    values: Readonly<Record<string, unknown>>;
    onchange: (control: string, value: unknown, gesture: string | null) => void;
    onpreset: (values: Readonly<Record<string, unknown>>) => void;
    /** Custom host components for inputs, sliders, and selects. */
    components?: ParameterComponents;
    /** Extra classes on the root element. */
    class?: string;
  }

  let { provider, effect, name, values, onchange, onpreset, components, class: className = '' }: Props = $props();
  const loaded = effectDescriptionOf(() => provider, () => effect);
  const imageControls = getImageEditorControls();
  const effectiveComponents = $derived({
    ...(imageControls.Range ? { Range: imageControls.Range } : {}),
    ...(imageControls.Select ? { Select: imageControls.Select } : {}),
    ...components
  });
</script>

<!-- One effect's controls, loaded from the provider; a note when it does not have the effect. -->
<div class={className || undefined} data-testid="image-effect-controls">
  {#if !provider}
    <p class="text-[11px] text-muted-foreground">No effects provider: "{name ?? effect}" is kept but not drawn.</p>
  {:else if loaded.error}
    <p class="text-[11px] text-amber-600">{loaded.error}</p>
  {:else if !loaded.description}
    <p class="text-[11px] text-muted-foreground">Loading…</p>
  {:else}
    {@const description = loaded.description}
    <EffectParameters {description} {values} {onchange} onreset={(k) => onchange(k, description.defaults[k], null)} {onpreset} components={effectiveComponents} />
  {/if}
</div>
