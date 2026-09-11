import { describe, it, expect, vi } from 'vitest';
import {
	createCanvasGraph,
	calculateGraphDifferences,
	replaceNodeInGraph
} from '../createCanvasGraph.svelte.js';
import type { CanvasNode, CanvasEdge } from '../types.js';

describe('createCanvasGraph & Graph Operations', () => {
	const createSampleNode = (id: string, x = 0, y = 0): CanvasNode => ({
		id,
		position: { x, y },
		data: { label: `Node ${id}` }
	});

	const createSampleEdge = (id: string, source: string, target: string): CanvasEdge => ({
		id,
		source,
		target
	});

	it('initializes with default empty or provided nodes and edges', () => {
		const graph = createCanvasGraph({
			initialNodes: [createSampleNode('1')],
			initialEdges: [createSampleEdge('e1', '1', '2')]
		});

		expect(graph.nodes).toHaveLength(1);
		expect(graph.edges).toHaveLength(1);
		expect(graph.nodes[0].id).toBe('1');
	});

	it('adds nodes and ignores duplicates', () => {
		const onNodesChange = vi.fn();
		const graph = createCanvasGraph({ onNodesChange });

		graph.addNodeOrNodes(createSampleNode('1'));
		expect(graph.nodes).toHaveLength(1);
		expect(onNodesChange).toHaveBeenCalledTimes(1);

		// Adding existing node does not duplicate
		graph.addNodeOrNodes(createSampleNode('1'));
		expect(graph.nodes).toHaveLength(1);

		// Adding multiple nodes
		graph.addNodeOrNodes([createSampleNode('2'), createSampleNode('3')]);
		expect(graph.nodes).toHaveLength(3);
	});

	it('adds and removes edges cleanly', () => {
		const onEdgesChange = vi.fn();
		const graph = createCanvasGraph({ onEdgesChange });

		const e1 = createSampleEdge('e1', '1', '2');
		const e2 = createSampleEdge('e2', '2', '3');

		graph.addEdge(e1);
		expect(graph.edges).toHaveLength(1);

		graph.addEdges([e2]);
		expect(graph.edges).toHaveLength(2);

		graph.removeEdges([e1]);
		expect(graph.edges).toHaveLength(1);
		expect(graph.edges[0].id).toBe('e2');
	});

	it('removes nodes by reference or ID matching', () => {
		const n1 = createSampleNode('1');
		const n2 = createSampleNode('2');
		const graph = createCanvasGraph({ initialNodes: [n1, n2] });

		graph.removeNodes([n1]);
		expect(graph.nodes).toHaveLength(1);
		expect(graph.nodes[0].id).toBe('2');
	});

	it('replaces a node and preserves connected edges when keepEdges is true', () => {
		const n1 = createSampleNode('1');
		const n2 = createSampleNode('2');
		const e1 = createSampleEdge('e1', '1', '2');
		const n1Replacement = createSampleNode('new-1', 10, 10);

		const result = replaceNodeInGraph([n1, n2], [e1], n1, n1Replacement, true);
		expect(result.nodes.some((n) => n.id === 'new-1')).toBe(true);
		expect(result.nodes.some((n) => n.id === '1')).toBe(false);

		// Edge should have updated source to new-1
		expect(result.edges).toHaveLength(1);
		expect(result.edges[0].source).toBe('new-1');
		expect(result.edges[0].target).toBe('2');
	});

	it('replaces a node without preserving edges when keepEdges is false', () => {
		const n1 = createSampleNode('1');
		const n2 = createSampleNode('2');
		const e1 = createSampleEdge('e1', '1', '2');
		const n1Replacement = createSampleNode('new-1', 10, 10);

		const result = replaceNodeInGraph([n1, n2], [e1], n1, n1Replacement, false);
		expect(result.nodes.some((n) => n.id === 'new-1')).toBe(true);
		expect(result.edges).toHaveLength(1);
		expect(result.edges[0].source).toBe('1'); // Unchanged
	});

	it('adds connected nodes connecting inbound and outbound targets', () => {
		const graph = createCanvasGraph();
		const inNode = createSampleNode('in');
		const outNode = createSampleNode('out');
		const midNode = createSampleNode('mid');

		graph.addNodeOrNodes([inNode, outNode]);

		graph.addConnectedNodes({
			nodesToAdd: [midNode],
			inboundNodes: [inNode],
			outboundNodes: [outNode],
			getEdgeLabel: (src, tgt) => `${src.id}->${tgt.id}`
		});

		expect(graph.nodes).toHaveLength(3);
		expect(graph.edges).toHaveLength(2);
		expect(graph.edges.find((e) => e.source === 'in' && e.target === 'mid')?.label).toBe('in->mid');
		expect(graph.edges.find((e) => e.source === 'mid' && e.target === 'out')?.label).toBe('mid->out');
	});

	it('accurately calculates graph differences against a baseline', () => {
		const n1 = createSampleNode('1', 0, 0);
		const n2 = createSampleNode('2', 50, 50);
		const e1 = createSampleEdge('e1', '1', '2');

		const baseline = {
			nodes: [n1, n2],
			edges: [e1]
		};

		// Node 2 position changed, node 3 added, edge 1 removed, edge 2 added
		const n2Changed = createSampleNode('2', 100, 100);
		const n3Added = createSampleNode('3', 200, 200);
		const e2Added = createSampleEdge('e2', '2', '3');

		const current = {
			nodes: [n1, n2Changed, n3Added],
			edges: [e2Added]
		};

		const diff = calculateGraphDifferences(current, baseline);

		expect(diff.changedNodes).toHaveLength(2); // n2 changed + n3 newly added
		expect(diff.changedNodes.map((n) => n.id)).toContain('2');
		expect(diff.changedNodes.map((n) => n.id)).toContain('3');
		expect(diff.removedNodes).toHaveLength(0);

		expect(diff.removedEdges).toHaveLength(1);
		expect(diff.removedEdges[0].id).toBe('e1');
		expect(diff.changedEdges).toHaveLength(1);
		expect(diff.changedEdges[0].id).toBe('e2');
	});
});
