<script lang="ts">
	import type { AgentPlayback, ToolRegistry, AgentToolProvider, PresenceStore, PlaybackChromeOptions } from '@pixerate/editor/tools';
	import type { CanvasNode } from '@pixerate/editor/canvas';
	import { createCanvasPlaybackSurface } from '../../src/canvas';
	import { createElementPlaybackSurface, createPlaybackSurface, useAgentToolProvider } from '../../src';

	let {
		playback,
		registry,
		provider,
		mode,
		chrome = {},
		onpresence
	}: {
		playback: AgentPlayback;
		registry: ToolRegistry;
		provider: AgentToolProvider;
		mode: 'canvas' | 'element' | 'plain';
		chrome?: PlaybackChromeOptions;
		onpresence?: (p: PresenceStore) => void;
	} = $props();
	const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
	const nodes: CanvasNode[] = [{ id: 'a', position: { x: 0, y: 0 }, data: {}, width: 100, height: 40 }];
	let el: HTMLDivElement | undefined = $state();
	$effect(() => {
		if (el) el.getBoundingClientRect = mode === 'canvas' ? rect(10, 20, 400, 300) : rect(100, 10, 200, 100);
	});
	// svelte-ignore state_referenced_locally
	const presence =
		mode === 'canvas'
			? createCanvasPlaybackSurface(playback, provider.id, { getNodes: () => nodes, getViewport: () => ({ x: 50, y: 0, zoom: 2 }), container: () => el, visible: () => true, ...chrome })
			: mode === 'element'
				? createElementPlaybackSurface(playback, provider.id, () => el, chrome)
				: createPlaybackSurface(playback, provider.id, { locate: () => ({ x: 0, y: 0, width: 10, height: 10 }), ...chrome });
	// svelte-ignore state_referenced_locally
	onpresence?.(presence);
	useAgentToolProvider(() => registry, () => provider, { playback: () => playback });
</script>

<div bind:this={el}></div>
