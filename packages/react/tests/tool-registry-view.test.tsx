import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolRegistry, type AgentToolProvider, type ToolRegistryView, type ToolViewOptions } from '@pixerate/editor/tools';
import { useToolRegistryView } from '../src';

beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
});

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

describe('useToolRegistryView', () => {
	it('scopes the registry, follows toolset changes in place, and discovers on request', async () => {
		const registry = new ToolRegistry();
		registry.register(provider('chart', ['get_chart']));
		registry.register(provider('video', ['add_video_clip'], false));
		let view!: ToolRegistryView | null;
		const Probe = ({ options }: { options: ToolViewOptions }) => {
			view = useToolRegistryView(registry, options);
			return null;
		};
		const root = createRoot(document.createElement('div'));
		await act(async () => root.render(<Probe options={{ toolsets: ['chart'] }} />));
		const first = view!;
		expect(first.listTools().tools.map((t) => t.name)).toEqual(['chart__get_chart']);

		await act(async () => root.render(<Probe options={{ toolsets: ['video'] }} />));
		expect(view).toBe(first);
		expect(first.listTools().tools.map((t) => t.name)).toEqual(['video__add_video_clip']);

		await act(async () => root.render(<Probe options={{ readOnly: true }} />));
		expect(view).not.toBe(first);
		expect(view!.listTools().tools.map((t) => t.name)).toEqual(['chart__get_chart']);

		const discovery = { enabled: ['chart'] };
		await act(async () => root.render(<Probe options={{ discovery }} />));
		expect(view!.listTools().tools.map((t) => t.name)).toEqual(['list_toolsets', 'search_tools', 'enable_tools', 'disable_tools', 'chart__get_chart']);
		await act(async () => root.unmount());
	});

	it('is null without a registry', async () => {
		let view: ToolRegistryView | null = {} as any;
		const Probe = () => {
			view = useToolRegistryView(null);
			return null;
		};
		const root = createRoot(document.createElement('div'));
		await act(async () => root.render(<Probe />));
		expect(view).toBeNull();
		await act(async () => root.unmount());
	});
});
