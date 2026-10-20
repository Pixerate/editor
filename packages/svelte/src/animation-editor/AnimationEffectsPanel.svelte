<script lang="ts">
  import { indexMotionNodes, type AnimationEditorController, type MotionEffectResult } from '@pixerate/editor/animation-editor';
  import EffectsBrowser from '../effects/EffectsBrowser.svelte';
  import AnimationEffectControls from './AnimationEffectControls.svelte';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    /** The node motion effects are applied to (e.g. the element picked on the stage). */
    node?: string | null;
    class?: string;
  }

  let { controller, node = null, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const ed = $derived(view.current);
  const provider = $derived(ed.effectsProvider);
  const nodes = $derived([...indexMotionNodes(ed.scene.artwork.nodes).keys()]);
  let chosen = $state('');
  const target = $derived(node && nodes.includes(node) ? node : chosen && nodes.includes(chosen) ? chosen : '');
  let browse = $state<null | 'motion' | 'vector'>(null);
  let open = $state<string | null>(null);
  let message = $state<string | null>(null);
  const applied = $derived.by(() => {
    void ed.scene;
    return controller.appliedEffects();
  });
  const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';
  function report(r: MotionEffectResult | Promise<MotionEffectResult>) {
    void Promise.resolve(r).then((x) => (message = x.ok ? (x.notes.length ? x.notes.join(' ') : null) : x.error));
  }
</script>

<!--
  Provider effects in an animation: apply a motion effect to a node (its changes become commands in
  a new shot), add a vector effect with its own picture, and change or remove the effects the scene
  holds. Every change is one undo step (a slider drag is one).
-->
<section class="flex flex-col gap-2 text-xs {className}" aria-label="Effects" data-animation-effects="">
  <div class="flex flex-wrap items-center gap-1">
    <span class="flex-1 font-semibold">Effects</span>
    <select class="rounded border border-border bg-transparent px-1 py-0.5 text-[11px]" aria-label="Node to animate" value={target} disabled={!!node} onchange={(e) => (chosen = e.currentTarget.value)}>
      <option value="">Node…</option>
      {#each nodes as id (id)}<option value={id}>{id}</option>{/each}
    </select>
    <button type="button" class={btn} disabled={ed.readOnly || !provider || !target} aria-pressed={browse === 'motion'} onclick={() => (browse = browse === 'motion' ? null : 'motion')}>Animate…</button>
    <button type="button" class={btn} disabled={ed.readOnly || !provider} aria-pressed={browse === 'vector'} onclick={() => (browse = browse === 'vector' ? null : 'vector')}>Vector effect…</button>
  </div>
  {#if !provider}<p class="text-[11px] text-muted-foreground">No effects provider is registered. Commands effects made are kept.</p>{/if}
  {#if browse === 'motion'}
    <EffectsBrowser {provider} uses={['motion']} kinds={['motion']} title="Motion for {target}" onpick={(e) => ((browse = null), report(controller.applyMotionEffect(e.id, [target])))} />
  {/if}
  {#if browse === 'vector'}
    <EffectsBrowser {provider} kinds={['vector']} title="Vector effects" onpick={(e) => ((browse = null), report(controller.addVectorEffect(e.id)))} />
  {/if}
  <ol class="space-y-1">
    {#each applied as e (e.instance)}
      <li class="rounded border border-border p-1" data-motion-effect={e.instance}>
        <div class="flex items-center gap-1">
          <button type="button" class="min-w-0 flex-1 truncate text-left" aria-expanded={open === e.instance} onclick={() => (open = open === e.instance ? null : e.instance)}>
            {e.name ?? e.effect} <span class="text-muted-foreground">· {e.kind === 'vector' ? 'picture' : e.targets.join(', ')}</span>
          </button>
          <button type="button" class={btn} disabled={ed.readOnly} aria-label="Remove {e.name ?? e.effect}" onclick={() => report(controller.removeMotionEffect(e.instance))}>✕</button>
        </div>
        {#if open === e.instance}<div class="mt-1"><AnimationEffectControls {controller} instance={e.instance} effect={e.effect} values={e.values} /></div>{/if}
      </li>
    {/each}
  </ol>
  {#if !applied.length}<p class="text-[11px] text-muted-foreground">No provider effects in this scene.</p>{/if}
  {#if message}<p role="status" class="text-[11px] text-muted-foreground" data-effects-message="">{message}</p>{/if}
</section>
