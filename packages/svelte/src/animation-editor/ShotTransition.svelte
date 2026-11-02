<script lang="ts">
  import type { AnimationEditorController, MotionShotLayerResult } from '@pixerate/editor/animation-editor';
  import type { EffectSummary } from '@pixerate/editor/effects';
  import EffectParameters from '../effects/EffectParameters.svelte';
  import { effectDescriptionOf } from '../effects/effects.svelte.js';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    /** The shot the transition leads into (not the first shot). */
    shot: string;
    class?: string;
  }

  let { controller, shot, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const index = $derived(editor.scene.shots.findIndex((s) => s.id === shot));
  const transition = $derived(editor.scene.shots[index]?.transition);
  const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';

  // The provider's transitions, loaded when the provider changes.
  let transitions = $state<EffectSummary[]>([]);
  $effect(() => {
    const provider = editor.effectsProvider;
    let live = true;
    if (!provider) {
      transitions = [];
      return;
    }
    void Promise.resolve(provider.list()).then(
      (all) => live && (transitions = all.filter((e) => e.uses.includes('transition') && e.kind !== 'camera')),
      () => live && (transitions = [])
    );
    return () => (live = false);
  });
  const known = $derived(transitions.some((t) => t.id === transition?.effect));
  const loaded = effectDescriptionOf(() => controller.effectsProvider, () => transition?.effect);
  let message = $state<string | null>(null);

  function report(r: Promise<MotionShotLayerResult> | MotionShotLayerResult) {
    void Promise.resolve(r).then((x) => (message = x.ok ? null : x.error));
  }
  function pick(id: string) {
    report(id ? controller.setShotTransition(shot, { effect: id, ...(transition?.ms ? { ms: transition.ms } : {}) }) : controller.clearShotTransition(shot));
  }
  function set(changes: { ms?: number; values?: Record<string, unknown> | null; preset?: string | null }, merge?: string | null) {
    const next: Record<string, unknown> = { ...transition, ...changes };
    for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
    report(controller.setShotTransition(shot, next as never, { merge: merge ?? undefined }));
  }
  function length(raw: string) {
    if (Number(raw) > 0) set({ ms: Number(raw) });
    else message = 'Length is a number of ms above 0.';
  }
  function reset(k: string) {
    const { [k]: _gone, ...rest } = transition?.values ?? {};
    set({ values: Object.keys(rest).length ? rest : null, preset: null });
  }
</script>

<!--
  The provider transition into a shot from the one before: pick it, set its length, preset and
  controls, or clear it. Hidden on the first shot. Every change is one undo step.
-->
{#if index > 0 && (transitions.length || transition)}
  <div class="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1 {className}" data-shot-transition="">
    <span class="text-muted-foreground">Transition in</span>
    <select class={input} aria-label="Transition in" disabled={editor.readOnly} value={transition?.effect ?? ''} onchange={(e) => pick(e.currentTarget.value)}>
      <option value="">cut</option>
      {#if transition && !known}<option value={transition.effect}>{transition.name ?? transition.effect} (not in the provider)</option>{/if}
      {#each transitions as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
    </select>
    {#if transition && known && !editor.readOnly}
      <div class="col-span-2 flex flex-col gap-1 border-l border-border pl-2" data-shot-transition-controls="">
        <div class="flex items-center gap-1">
          <span class="w-16 text-muted-foreground">Length</span>
          <input class={input} type="number" min="1" step="50" aria-label="Transition length" value={transition.ms ?? ''} onchange={(e) => length(e.currentTarget.value)} />
          <span class="text-[10px] text-muted-foreground">ms</span>
        </div>
        {#if loaded.description}
          <EffectParameters
            description={loaded.description}
            values={transition.values ?? {}}
            onchange={(k, v, g) => set({ values: { ...(transition.values ?? {}), [k]: v }, preset: null }, g)}
            onreset={(k) => reset(k)}
            onpresetname={(name) => set({ preset: name, values: null })}
          />
        {/if}
      </div>
    {/if}
    {#if message}<p class="col-span-2 text-[11px] text-destructive" role="alert">{message}</p>{/if}
  </div>
{/if}
