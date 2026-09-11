import { describe, it, expect } from 'vitest';
import {
	getCenteredNodePosition,
	centerNodes,
	getLayoutedNodes
} from '../createCanvasLayout.js';
import type { CanvasNode, CanvasEdge } from '../types.js';

describe('createCanvasLayout & Geometry Helpers', () => {
	it('calculates centered node position correctly', () => {
		const screenDimensions = { width: 1000, height: 800 };
		const screenToFlowPosition = (pos: { x: number; y: number }) => ({ x: pos.x, y: pos.y });

		const pos = getCenteredNodePosition(200, 100, screenToFlowPosition, screenDimensions);
		// Center of 1000x800 is (500, 400). Top-left of 200x100 is (500 - 100, 400 - 50) = (400, 350)
		expect(pos.x).toBe(400);
		expect(pos.y).toBe(350);
	});

	it('centers multiple nodes using centerNodes', () => {
		const screenDimensions = { width: 1000, height: 800 };
		const screenToFlowPosition = (pos: { x: number; y: number }) => pos;

		const nodes: CanvasNode[] = [
			{ id: '1', position: { x: 0, y: 0 }, data: {} },
			{ id: '2', position: { x: 200, y: 100 }, data: {} }
		];

		const getNodesBounds = () => ({ x: 0, y: 0, width: 300, height: 200 });

		const centered = centerNodes(nodes, screenToFlowPosition, getNodesBounds, screenDimensions);

		// Center of viewport is (500, 400). Upper left for 300x200 bounding box is (350, 300).
		// DeltaX = 350 - 0 = 350, DeltaY = 300 - 0 = 300.
		expect(centered[0].position.x).toBe(350);
		expect(centered[0].position.y).toBe(300);
		expect(centered[1].position.x).toBe(550);
		expect(centered[1].position.y).toBe(400);
	});

	it('computes Dagre hierarchical layout positions for nodes and edges', () => {
		const nodes: CanvasNode[] = [
			{ id: 'root', position: { x: 0, y: 0 }, data: {}, measured: { width: 100, height: 100 } },
			{ id: 'child1', position: { x: 0, y: 0 }, data: {}, measured: { width: 100, height: 100 } },
			{ id: 'child2', position: { x: 0, y: 0 }, data: {}, measured: { width: 100, height: 100 } }
		];

		const edges: CanvasEdge[] = [
			{ id: 'e1', source: 'root', target: 'child1' },
			{ id: 'e2', source: 'root', target: 'child2' }
		];

		const getNodesBounds = () => ({ x: 100, y: 100, width: 400, height: 400 });

		const layouted = getLayoutedNodes(nodes, edges, getNodesBounds, {
			direction: 'LR',
			ranksep: 80,
			nodesep: 40
		});

		expect(layouted).toHaveLength(3);

		const root = layouted.find((n) => n.id === 'root')!;
		const child1 = layouted.find((n) => n.id === 'child1')!;
		const child2 = layouted.find((n) => n.id === 'child2')!;

		// Root should be to the left of child nodes in 'LR' layout
		expect(root.position.x).toBeLessThan(child1.position.x);
		expect(root.position.x).toBeLessThan(child2.position.x);

		// Target and source positions should be configured for horizontal layout
		expect(root.sourcePosition).toBe('right');
		expect(child1.targetPosition).toBe('left');
	});
});
