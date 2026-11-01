<script lang="ts">
	import { untrack } from 'svelte';
	import { canvasEffectStatus, isShapeDescription, type CanvasEffectsController, type ShapeDescription } from '@pixerate/editor/canvas';
	import type { EffectProvider } from '@pixerate/editor/effects';
	import EffectsBrowser from '../effects/EffectsBrowser.svelte';
	import CanvasEffectControls from './CanvasEffectControls.svelte';

	interface Props {
		controller: CanvasEffectsController;
		/** The node to edit (e.g. the selected shape). */
		nodeId?: string | null;
		/** The node's shape, to show its effect. */
		shape?: ShapeDescription | null;
		/** The scene to set a transition into (e.g. the current one). */
		sceneId?: string | null;
		class?: string;
	}

	let { controller, nodeId = null, shape = null, sceneId = null, class: className = '' }: Props = $props();
	let provider = $state.raw<EffectProvider | null>(untrack(() => controller.effectsProvider));
	let tick = $state(0);
	$effect(() => {
		const c = controller;
		provider = c.effectsProvider;
		return untrack(() => c.effects.subscribe((p) => (provider = p)));
	});
	let browse = $state<null | 'fill' | 'overlay' | 'transition'>(null);
	let message = $state<string | null>(null);
	const nodeEffect = $derived(isShapeDescription(shape) ? shape.effect : undefined);
	const nodeEffectStatus = $derived(nodeEffect && provider ? canvasEffectStatus(nodeEffect, provider) : null);
	const transition = $derived.by(() => {
		void tick;
		return sceneId ? controller.sceneTransition(sceneId) : undefined;
	});
	const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';
	function run(work: () => unknown) {
		message = null;
		Promise.resolve()
			.then(work)
			.then(
				() => tick++,
				(e: unknown) => (message = e instanceof Error ? e.message : String(e)),
			);
	}
</script>

<!-- Effects for a shape node (fill, overlay, controls, play / hold, remove) and the transition into a scene. -->
<section class="flex flex-col gap-2 text-xs {className}" aria-label="Canvas effects" data-canvas-effects="">
	<div class="flex flex-wrap items-center gap-1">
		<span class="flex-1 font-semibold">Effects</span>
		<button type="button" class={btn} disabled={!provider || !nodeId || !shape} aria-pressed={browse === 'fill'} onclick={() => (browse = browse === 'fill' ? null : 'fill')}>Fill…</button>
		<button type="button" class={btn} disabled={!provider || !nodeId || !shape} aria-pressed={browse === 'overlay'} onclick={() => (browse = browse === 'overlay' ? null : 'overlay')}>Overlay…</button>
		<button type="button" class={btn} disabled={!provider || !sceneId} aria-pressed={browse === 'transition'} onclick={() => (browse = browse === 'transition' ? null : 'transition')}>Scene transition…</button>
	</div>
	{#if !provider}<p class="text-[11px] text-muted-foreground">No effects provider is registered. Effects on the canvas are kept.</p>{/if}
	{#if browse === 'fill' && nodeId}
		{@const id = nodeId}
		<EffectsBrowser {provider} uses={['generator', 'interactive']} title="Fills" onpick={(e) => ((browse = null), run(() => controller.applyNodeEffect(id, e.id, { mode: 'fill' })))} />
	{/if}
	{#if browse === 'overlay' && nodeId}
		{@const id = nodeId}
		<EffectsBrowser {provider} uses={['overlay', 'title', 'interactive', 'generator']} title="Overlays" onpick={(e) => ((browse = null), run(() => controller.applyNodeEffect(id, e.id, { mode: 'overlay' })))} />
	{/if}
	{#if browse === 'transition' && sceneId}
		{@const id = sceneId}
		<EffectsBrowser {provider} uses={['transition']} title="Transitions" onpick={(e) => ((browse = null), run(() => controller.setSceneTransition(id, e.id)))} />
	{/if}
	{#if nodeEffect && nodeId}
		{@const id = nodeId}
		<div class="space-y-1 rounded border border-border p-1" data-canvas-node-effect={id}>
			<div class="flex items-center gap-1">
				<span class="min-w-0 flex-1 truncate font-medium">{nodeEffect.name ?? nodeEffect.effect} <span class="text-muted-foreground">· {nodeEffect.mode}</span></span>
				<label class="flex items-center gap-1">
					<input
						type="checkbox"
						checked={nodeEffect.playing !== false}
						aria-label="Play"
						onchange={(e) => {
							const playing = e.currentTarget.checked;
							run(() => controller.updateNodeEffect(id, { playing }));
						}}
					/> Play
				</label>
				<button type="button" class={btn} aria-label="Remove effect" onclick={() => run(() => controller.removeNodeEffect(id))}>✕</button>
			</div>
			{#if nodeEffectStatus && !nodeEffectStatus.ok}
				<p class="text-[11px] text-amber-500" data-canvas-effect-unavailable="">{nodeEffectStatus.reason}</p>
			{:else if provider}<CanvasEffectControls {controller} nodeId={id} effect={nodeEffect} />{/if}
		</div>
	{/if}
	{#if sceneId && transition}
		{@const id = sceneId}
		<div class="flex items-center gap-1" data-canvas-scene-transition={id}>
			<span class="min-w-0 flex-1 truncate">Into scene: {transition.name ?? transition.effect} ({transition.duration ?? 600} ms)</span>
			<button type="button" class={btn} aria-label="Remove transition" onclick={() => run(() => controller.setSceneTransition(id, null))}>✕</button>
		</div>
	{/if}
	{#if message}<p role="alert" class="text-[11px] text-destructive">{message}</p>{/if}
</section>
