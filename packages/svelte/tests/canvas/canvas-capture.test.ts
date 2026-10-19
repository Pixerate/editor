import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@pixerate/editor/tools';
import { createCanvasCapture } from '../../src/canvas/index.js';
import type { CanvasNode } from '../../src/canvas/types.js';

describe('createCanvasCapture', () => {
	it('exposes capture_view for a Svelte Flow canvas, reading the element through a getter', async () => {
		let pane: HTMLElement | undefined;
		let nodes: CanvasNode[] = [{ id: 'a', position: { x: 10, y: 20 }, data: {}, width: 40, height: 30, selected: true }];
		const capture = createCanvasCapture({
			namespace: 'canvas',
			element: () => pane,
			getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
			getNodes: () => nodes,
			rasterize: async () => 'data:image/png;base64,QUJD'
		});
		const registry = new ToolRegistry();
		registry.register(capture);

		const unmounted = await registry.callTool('canvas__capture_view', { region: 'selection' });
		expect(unmounted.content[0]).toMatchObject({ text: 'The canvas is not mounted, so there is nothing to capture.' });

		pane = document.createElement('div');
		pane.className = 'svelte-flow';
		document.body.appendChild(pane);
		const selection = await registry.callTool('canvas__capture_view', { region: 'selection', padding: 0 });
		expect(selection.isError).toBeFalsy();
		expect(selection.structuredContent).toMatchObject({ rect: { x: 10, y: 20, width: 40, height: 30 }, ids: ['a'], scale: 2 });

		nodes = [];
		const empty = await registry.callTool('canvas__capture_view', { region: 'content' });
		expect(empty.content[0]).toMatchObject({ text: expect.stringMatching(/surface is empty/) });
		pane.remove();
	});
});
