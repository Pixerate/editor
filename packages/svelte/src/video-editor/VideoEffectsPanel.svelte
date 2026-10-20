<script lang="ts">
  import { findVideoClip, isVideoKeyframes, type VideoEditorController, type VideoEffectEditResult, type VideoEffectValues } from '@pixerate/editor/video-editor';
  import EffectsBrowser from '../effects/EffectsBrowser.svelte';
  import EffectControls from './EffectControls.svelte';
  import { videoEditorStateOf } from './createVideoEditor.svelte.js';

  interface Props {
    controller: VideoEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();
  const view = videoEditorStateOf(() => controller);
  const ed = $derived(view.current);
  const provider = $derived(ed.effectsProvider);
  let browse = $state<null | 'clip' | 'transition' | 'generator'>(null);
  let message = $state<string | null>(null);
  let open = $state<string | null>(null);
  const at = $derived(ed.selection[0] ? findVideoClip(ed.project, ed.selection[0]) : null);
  const clip = $derived(at?.clip ?? null);
  const disabled = $derived(ed.readOnly);
  const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';

  function report(r: VideoEffectEditResult | Promise<VideoEffectEditResult>) {
    void Promise.resolve(r).then((x) => (message = x.ok ? null : x.error));
  }
  function addEffectClip(effect: string) {
    const track = at && at.track.kind === 'video' ? at.track.id : ed.project.tracks.find((t) => t.kind === 'video')?.id;
    if (!track) return (message = 'Add a video track first.');
    report(
      controller.addEffectClip(track, effect, { start: Math.round(ed.time), mode: 'overwrite' }).then((r) => {
        if (r.ok && r.clip) controller.select([r.clip]);
        return r;
      }),
    );
  }
  const merge = (gesture: string | null) => ({ merge: gesture ?? undefined });
</script>

<!--
  Provider effects for the selected clip: its effect stack (add, turn on and off, reorder, change
  controls, remove), its effect transition, and an effect clip's own controls; plus adding effect
  clips at the playhead. Every change is one undo step (a slider drag is one). Without a provider it
  lists what the project holds and says why nothing can be added.
-->
<section class="flex flex-col gap-2 rounded-md border border-border p-2 text-xs {className}" aria-label="Effects" data-video-effects="">
  <div class="flex items-center gap-1">
    <h3 class="flex-1 font-semibold">Effects</h3>
    <button type="button" class={btn} disabled={disabled || !provider} aria-pressed={browse === 'generator'} onclick={() => (browse = browse === 'generator' ? null : 'generator')}>Add effect clip</button>
  </div>
  {#if !provider}
    <p class="text-[11px] text-muted-foreground">No effects provider is registered. Effects in the project are kept and drawn as placeholders.</p>
  {/if}
  {#if browse === 'generator'}
    <EffectsBrowser {provider} uses={['generator', 'title', 'overlay']} title="Generators and titles" onpick={(e) => ((browse = null), addEffectClip(e.id))} />
  {/if}
  {#if !clip}
    <p class="text-[11px] text-muted-foreground">Select a clip to see its effects.</p>
  {:else}
    {#if clip.type === 'effect'}
      {@const c = clip}
      <div class="space-y-1" data-effect-part="generator">
        <div class="font-medium">{c.name ?? c.effect}</div>
        <EffectControls
          {provider}
          effect={c.effect}
          name={c.name}
          values={c.values}
          {disabled}
          onchange={(k, v, g) => report(controller.updateEffectValues(c.id, 'generator', { [k]: v } as VideoEffectValues, merge(g)))}
          onpreset={(values) => report(controller.updateEffectValues(c.id, 'generator', values as VideoEffectValues))}
        />
      </div>
    {/if}
    <div class="space-y-1" data-effect-part="transition">
      <div class="flex items-center gap-1">
        <span class="flex-1 font-medium">Transition in</span>
        {#if clip.transition?.type === 'effect'}
          <button type="button" class={btn} {disabled} onclick={() => report(controller.apply({ op: 'set_transition', clip: clip!.id, transition: null }, 'Remove transition') as VideoEffectEditResult)}>Remove</button>
        {:else}
          <button type="button" class={btn} disabled={disabled || !provider} aria-pressed={browse === 'transition'} onclick={() => (browse = browse === 'transition' ? null : 'transition')}>Effect transition…</button>
        {/if}
      </div>
      {#if browse === 'transition'}
        <EffectsBrowser {provider} uses={['transition']} title="Transitions" onpick={(e) => ((browse = null), report(controller.setEffectTransition(clip!.id, e.id)))} />
      {/if}
      {#if clip.transition?.type === 'effect' && clip.transition.effect}
        {@const t = clip.transition.effect}
        <EffectControls
          {provider}
          effect={t.effect}
          name={t.name}
          values={t.values}
          {disabled}
          onchange={(k, v, g) => report(controller.updateEffectValues(clip!.id, 'transition', { [k]: v } as VideoEffectValues, merge(g)))}
          onpreset={(values) => report(controller.updateEffectValues(clip!.id, 'transition', values as VideoEffectValues))}
        />
      {/if}
    </div>
    <div class="space-y-1" data-effect-part="stack">
      <div class="flex items-center gap-1">
        <span class="flex-1 font-medium">On this clip</span>
        <button type="button" class={btn} disabled={disabled || !provider} aria-pressed={browse === 'clip'} onclick={() => (browse = browse === 'clip' ? null : 'clip')}>Add effect…</button>
      </div>
      {#if browse === 'clip'}
        <EffectsBrowser {provider} uses={['filter', 'overlay']} title="Filters and overlays" onpick={(e) => ((browse = null), report(controller.applyClipEffect(clip!.id, e.id)))} />
      {/if}
      <ol class="space-y-1">
        {#each clip.effects ?? [] as e, i (e.id)}
          {@const label = e.name ?? e.effect}
          {@const count = clip.effects?.length ?? 0}
          <li class="rounded border border-border p-1" data-clip-effect={e.id}>
            <div class="flex items-center gap-1">
              <input type="checkbox" checked={e.enabled !== false} {disabled} aria-label="{label} on" onchange={(ev) => report(controller.updateClipEffect(clip!.id, e.id, { enabled: ev.currentTarget.checked }))} />
              <button type="button" class="min-w-0 flex-1 truncate text-left" aria-expanded={open === e.id} onclick={() => (open = open === e.id ? null : e.id)}>{label}</button>
              <button type="button" class={btn} disabled={disabled || i === 0} aria-label="Move up" onclick={() => report(controller.updateClipEffect(clip!.id, e.id, { index: i - 1 }))}>↑</button>
              <button type="button" class={btn} disabled={disabled || i === count - 1} aria-label="Move down" onclick={() => report(controller.updateClipEffect(clip!.id, e.id, { index: i + 1 }))}>↓</button>
              <button type="button" class={btn} {disabled} aria-label="Remove {label}" onclick={() => report(controller.removeClipEffect(clip!.id, e.id))}>✕</button>
            </div>
            {#if open === e.id}
              <div class="mt-1 space-y-2">
                <label class="flex items-center gap-1">
                  <span class="w-14 text-[11px]">Opacity</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    class="flex-1"
                    disabled={disabled || isVideoKeyframes(e.opacity)}
                    value={typeof e.opacity === 'number' ? e.opacity : 1}
                    aria-label="{label} opacity"
                    oninput={(ev) => report(controller.updateClipEffect(clip!.id, e.id, { opacity: Number(ev.currentTarget.value) }, { merge: `opacity:${clip!.id}:${e.id}` }))}
                  />
                </label>
                <EffectControls
                  {provider}
                  effect={e.effect}
                  name={e.name}
                  values={e.values}
                  {disabled}
                  onchange={(k, v, g) => report(controller.updateClipEffect(clip!.id, e.id, { values: { [k]: v as never } }, merge(g)))}
                  onpreset={(values) => report(controller.updateClipEffect(clip!.id, e.id, { values: values as never }))}
                />
              </div>
            {/if}
          </li>
        {/each}
      </ol>
      {#if !clip.effects?.length}<p class="text-[11px] text-muted-foreground">No effects on this clip.</p>{/if}
    </div>
  {/if}
  {#if message}<p role="alert" class="text-[11px] text-destructive">{message}</p>{/if}
</section>
