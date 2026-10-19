// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolRegistry, type AgentToolProvider } from '@pixerate/editor/tools';
import { useCanvasCapture, type CanvasNode } from '../src/canvas';
import { useAgentToolProvider } from '../src';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useCanvasCapture', () => {
	it('registers canvas capture_view, reads the latest nodes and keeps one provider across renders', async () => {
		const registry = new ToolRegistry();
		const providers: AgentToolProvider[] = [];
		const rasterized: { width?: number; pixelWidth?: number }[] = [];
		const Host = ({ nodes }: { nodes: CanvasNode[] }) => {
			const pane = useRef<HTMLDivElement>(null);
			const capture = useCanvasCapture({
				namespace: 'canvas',
				element: pane,
				getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
				getNodes: () => nodes,
				rasterize: async (_el, options) => {
					rasterized.push(options);
					return 'data:image/png;base64,QUJD';
				}
			});
			providers.push(capture);
			useAgentToolProvider(registry, capture);
			return <div ref={pane} className="react-flow" />;
		};
		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container);
		const first: CanvasNode[] = [{ id: 'a', position: { x: 0, y: 0 }, data: {}, width: 100, height: 50 }];
		await act(async () => root.render(<Host nodes={first} />));
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['canvas__capture_view']);

		const second: CanvasNode[] = [...first, { id: 'b', position: { x: 300, y: 0 }, data: {}, width: 100, height: 50, selected: true }];
		await act(async () => root.render(<Host nodes={second} />));
		expect(new Set(providers).size).toBe(1);

		const result = await registry.callTool('canvas__capture_view', { region: 'nodes', ids: ['b'], padding: 0 });
		expect(result.isError).toBeFalsy();
		expect(result.content[0]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/png' });
		expect(result.structuredContent).toMatchObject({ rect: { x: 300, y: 0, width: 100, height: 50 }, ids: ['b'] });
		expect(rasterized[0]).toMatchObject({ width: 200, pixelWidth: 200 });

		const unknown = await registry.callTool('canvas__capture_view', { region: 'nodes', ids: ['zz'] });
		expect(unknown.isError).toBe(true);

		await act(async () => root.unmount());
		expect(registry.listTools().tools).toEqual([]);
	});
});
