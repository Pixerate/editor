<script lang="ts">
	import type { EffectProvider } from '@pixerate/editor/effects';
	import type { ShapeDescription } from '@pixerate/editor/canvas';
	import { ShapeNode, setCanvasEffectsProvider } from '../../src/canvas';

	let { provider, shape }: { provider: EffectProvider | null; shape: ShapeDescription } = $props();
	// svelte-ignore state_referenced_locally
	setCanvasEffectsProvider(() => provider);
</script>

<ShapeNode data={{ shape }} width={40} height={20} />
