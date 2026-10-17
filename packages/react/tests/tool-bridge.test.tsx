import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolRegistry } from '@pixerate/editor/tools';
import { createToolBridge } from '@pixerate/editor/bridge';
import { useToolBridge, type UseToolBridgeResult } from '../src';

beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
});

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn();
	cleanups = [];
});

const until = async (check: () => boolean) => {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > 3000) throw new Error('Timed out.');
		await act(async () => new Promise((r) => setTimeout(r, 10)));
	}
};

describe('useToolBridge', () => {
	it('connects the registry to a bridge while mounted', async () => {
		const bridge = await createToolBridge({ name: 'test', port: 0, stdio: false, log: () => {} });
		cleanups.push(() => bridge.close());
		const registry = new ToolRegistry();
		registry.register({
			id: 'demo',
			tools: [
				{
					name: 'ping',
					title: 'Ping',
					description: 'Answers pong.',
					inputSchema: { type: 'object', properties: {}, additionalProperties: false },
					annotations: { title: 'Ping', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
					handler: () => 'pong'
				}
			]
		});
		const container = document.createElement('div');
		const root = createRoot(container);
		let state!: UseToolBridgeResult;
		const options = { url: `ws://127.0.0.1:${bridge.port}`, name: 'React tab' };
		function Probe({ on }: { on: boolean }) {
			state = useToolBridge(registry, on ? options : null);
			return null;
		}
		await act(async () => root.render(<Probe on={false} />));
		expect(state.status).toBe('off');
		await act(async () => root.render(<Probe on />));
		await until(() => state.status === 'connected');
		expect(state.editorId).toBe('e1');
		const result: any = await bridge.registry.callTool('ping', {});
		expect(result.content[0].text).toBe('pong');
		await act(async () => root.unmount());
		await until(() => bridge.editors().length === 0);
	});
});
