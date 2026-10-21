<script lang="ts">
	import type { AgentPlayback, ToolRegistry, AgentToolProvider } from '@pixerate/editor/tools';
	import type { CanvasNode } from '@pixerate/editor/canvas';
	import { createCanvasPlaybackSurface, PresenceLayer } from '../../src/canvas';
	import { setAgentPlayback, useAgentToolProvider } from '../../src';

	let { playback, registry, provider, getNodes }: { playback: AgentPlayback; registry: ToolRegistry; provider: AgentToolProvider; getNodes: () => CanvasNode[] } = $props();
	const viewport = { x: 50, y: 0, zoom: 2 };
	let container: HTMLDivElement | undefined = $state();
	// svelte-ignore state_referenced_locally
	setAgentPlayback(playback);
	// svelte-ignore state_referenced_locally
	const presence = createCanvasPlaybackSurface(undefined, 'canvas', { getNodes: () => getNodes(), getViewport: () => viewport, container: () => container, visible: () => true });
	useAgentToolProvider(() => registry, () => provider, { playback: () => playback });
</script>

<div bind:this={container} style="position: relative;">
	<PresenceLayer {presence} {viewport} />
</div>
