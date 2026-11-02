<script lang="ts">
  import { pathControlsOf, type EffectProvider } from '@pixerate/editor/effects';
  import { isVideoKeyframes, type VideoClip, type VideoEditorController, type VideoEffectEditResult, type VideoEffectValues } from '@pixerate/editor/video-editor';
  import PathControls from './PathControls.svelte';
  import EffectParameters from '../effects/EffectParameters.svelte';
  import { effectDescriptionOf } from '../effects/effects.svelte.js';

  interface Props {
    provider: EffectProvider | null;
    effect: string;
    name?: string;
    values: VideoEffectValues | undefined;
    disabled: boolean;
    onchange: (control: string, value: unknown, gesture: string | null) => void;
    onpreset: (values: Readonly<Record<string, unknown>>) => void;
    /** For an effect on a clip: where its path comes from, when it draws along one. */
    path?: { controller: VideoEditorController; clip: VideoClip; instance: string; report: (r: VideoEffectEditResult | Promise<VideoEffectEditResult>) => void };
  }

  let { provider, effect, name, values, disabled, onchange, onpreset, path }: Props = $props();
  const loaded = effectDescriptionOf(() => provider, () => effect);
  const keyed = $derived(new Set(Object.entries(values ?? {}).filter(([, v]) => isVideoKeyframes(v)).map(([k]) => k)));
</script>

<!-- One effect's controls, loaded from the provider; a note when the provider does not have it. -->
{#if !provider}
  <p class="text-[11px] text-muted-foreground">No effects provider: "{name ?? effect}" is kept and shown as a placeholder.</p>
{:else if loaded.error}
  <p class="text-[11px] text-amber-500">{loaded.error}</p>
{:else if !loaded.description}
  <p class="text-[11px] text-muted-foreground">Loading…</p>
{:else}
  {@const description = loaded.description}
  {#if path && pathControlsOf(description).length}
    <PathControls controller={path.controller} clip={path.clip} instance={path.instance} report={path.report} {provider} {disabled} />
  {/if}
  <EffectParameters {description} values={values ?? {}} keyframed={keyed} {disabled} {onchange} onreset={(k) => onchange(k, description.defaults[k], null)} {onpreset} />
{/if}
