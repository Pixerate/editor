<script lang="ts">
	import type { CanvasEffectsController, CanvasShapeEffect } from '@pixerate/editor/canvas';
	import EffectParameters from '../effects/EffectParameters.svelte';
	import { effectDescriptionOf } from '../effects/effects.svelte.js';

	interface Props {
		controller: CanvasEffectsController;
		nodeId: string;
		effect: CanvasShapeEffect;
		onchanged?: () => void;
	}

	let { controller, nodeId, effect, onchanged }: Props = $props();
	const loaded = effectDescriptionOf(() => controller.effectsProvider, () => effect.effect);
	let message = $state<string | null>(null);
	const run = (work: Promise<unknown>) =>
		void work.then(
			() => ((message = null), onchanged?.()),
			(e: unknown) => (message = e instanceof Error ? e.message : String(e)),
		);
</script>

{#if loaded.error}
	<p class="text-[11px] text-amber-500">{loaded.error}</p>
{:else if !loaded.description}
	<p class="text-[11px] text-muted-foreground">Loading…</p>
{:else}
	<EffectParameters
		description={loaded.description}
		values={effect.values}
		onchange={(k, v) => run(controller.updateNodeEffect(nodeId, { values: { [k]: v as never } }))}
		onreset={(k) => run(controller.updateNodeEffect(nodeId, { values: { [k]: null } }))}
		onpreset={(v) => run(controller.updateNodeEffect(nodeId, { values: v as never }))}
	/>
	{#if message}<p role="alert" class="text-[11px] text-destructive">{message}</p>{/if}
{/if}
