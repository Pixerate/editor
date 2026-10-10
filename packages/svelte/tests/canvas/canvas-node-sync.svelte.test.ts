import { describe, it, expect } from 'vitest';
import { flushSync } from 'svelte';
import { Position } from '@xyflow/svelte';
import {
	preserveNodeMeasurements,
	normalizeNodeHandles,
	createCanvasNodeSync,
	type HandleConfig
} from '../../src/canvas/createCanvasNodeSync.svelte.js';
import type { CanvasNode } from '../../src/canvas/types.js';

describe('createCanvasNodeSync & Node Measurement Caching', () => {
	it('preserves measured dimensions from existing nodes to newly created nodes', () => {
		const existingNodes: CanvasNode[] = [
			{
				id: 'node-1',
				position: { x: 100, y: 100 },
				data: {},
				measured: { width: 280, height: 160 }
			} as any,
			{
				id: 'node-2',
				position: { x: 200, y: 200 },
				data: {}
			} as any
		];

		const freshNodes: CanvasNode[] = [
			{ id: 'node-1', position: { x: 100, y: 100 }, data: { title: 'Updated' } } as any,
			{ id: 'node-2', position: { x: 200, y: 200 }, data: { title: 'Fresh' } } as any,
			{ id: 'node-3', position: { x: 300, y: 300 }, data: { title: 'Brand New' } } as any
		];

		const preserved = preserveNodeMeasurements(freshNodes, existingNodes);

		expect((preserved[0] as any).measured).toEqual({ width: 280, height: 160 });
		expect((preserved[1] as any).measured).toBeUndefined();
		expect((preserved[2] as any).measured).toBeUndefined();
	});

	it('normalizes node handles to prevent xyflow forceInitialRender selection flash', () => {
		const rawNode: CanvasNode = {
			id: 'node-1',
			position: { x: 0, y: 0 },
			data: {}
		};

		const defaultHandles: HandleConfig[] = [
			{ id: null, type: 'target', position: Position.Left, x: 0, y: 50, width: 12, height: 12 },
			{ id: null, type: 'source', position: Position.Right, x: 260, y: 50, width: 12, height: 12 }
		];

		const normalized = normalizeNodeHandles(rawNode, defaultHandles);

		expect((normalized as any).handles).toHaveLength(2);
		expect((normalized as any).handles[0].position).toBe(Position.Left);
		expect((normalized as any).handles[1].position).toBe(Position.Right);
	});

	it('synchronizes domain items to nodes and edges while caching measurements across ticks', () => {
		let domainItems = [
			{ id: 'item-1', name: 'Task 1', dependencies: [] },
			{ id: 'item-2', name: 'Task 2', dependencies: ['item-1'] }
		];

		let sync: ReturnType<typeof createCanvasNodeSync<any>>;

		const cleanup = $effect.root(() => {
			sync = createCanvasNodeSync({
				items: () => domainItems,
				toNode: (item) => ({
					id: item.id,
					position: { x: 10, y: 20 },
					data: { label: item.name }
				}),
				toEdges: (items) =>
					items.flatMap((item) =>
						item.dependencies.map((depId) => ({
							id: `edge-${depId}-${item.id}`,
							source: depId,
							target: item.id
						}))
					),
				defaultHandles: () => [
					{ id: 'in', type: 'target', position: Position.Left },
					{ id: 'out', type: 'source', position: Position.Right }
				]
			});
		});

		flushSync();

		expect(sync!.nodes).toHaveLength(2);
		expect(sync!.edges).toHaveLength(1);
		expect(sync!.edges[0].id).toBe('edge-item-1-item-2');
		expect((sync!.nodes[0] as any).handles).toHaveLength(2);

		// Simulate xyflow measuring node-1
		sync!.updateNodeMeasurements('item-1', 250, 120);
		expect((sync!.nodes[0] as any).measured).toEqual({ width: 250, height: 120 });

		cleanup();
	});
});
