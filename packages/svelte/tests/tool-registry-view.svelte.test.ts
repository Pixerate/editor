import { describe, it, expect } from 'vitest';
import { flushSync } from 'svelte';
import { ToolRegistry, type AgentToolProvider, type ToolViewOptions } from '@pixerate/editor/tools';
import { useToolRegistryView } from '../src/toolRegistryView.svelte.js';

const provider = (id: string, names: string[], readOnly = true): AgentToolProvider => ({
	id,
	title: id,
	tools: names.map((name) => ({
		name,
		title: name,
		description: `${name}.`,
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: name, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: () => name
	}))
});

describe('useToolRegistryView (Svelte)', () => {
	it('scopes the registry and follows toolset changes in place (parity with React)', () => {
		const registry = new ToolRegistry();
		registry.register(provider('chart', ['get_chart']));
		registry.register(provider('video', ['add_video_clip'], false));
		let options = $state<ToolViewOptions>({ toolsets: ['chart'] });
		let link!: ReturnType<typeof useToolRegistryView>;
		const cleanup = $effect.root(() => {
			link = useToolRegistryView(registry, () => options);
		});
		flushSync();
		const first = link.view!;
		expect(first.listTools().tools.map((t) => t.name)).toEqual(['chart__get_chart']);

		options = { toolsets: ['video'] };
		flushSync();
		expect(link.view).toBe(first);
		expect(first.listTools().tools.map((t) => t.name)).toEqual(['video__add_video_clip']);

		options = { readOnly: true };
		flushSync();
		expect(link.view).not.toBe(first);
		expect(link.view!.listTools().tools.map((t) => t.name)).toEqual(['chart__get_chart']);

		options = { discovery: { enabled: ['chart'] } };
		flushSync();
		expect(link.view!.listTools().tools.map((t) => t.name)).toEqual(['list_toolsets', 'search_tools', 'enable_tools', 'disable_tools', 'chart__get_chart']);
		cleanup();
	});
});
