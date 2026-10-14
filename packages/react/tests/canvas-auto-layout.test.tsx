import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HistoryManager } from '@pixerate/editor/history';
import { useCanvasAutoLayout, useCanvasArrange, getFlowChildren, layoutAll, applyNodeUpdates, type CanvasNode } from '../src/canvas';

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.com/editor' });
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).HTMLElement = dom.window.HTMLElement;
});

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

const initial = (): CanvasNode[] => {
	const nodes: CanvasNode[] = [
		{
			id: 'F',
			position: { x: 0, y: 0 },
			data: { layout: { mode: 'horizontal', gap: 8, padding: 8, sizing: { width: 'hug', height: 'hug' } } },
			width: 10,
			height: 10
		},
		{ id: 'a', parentId: 'F', position: { x: 0, y: 0 }, data: {}, width: 40, height: 40 },
		{ id: 'b', parentId: 'F', position: { x: 0, y: 0 }, data: {}, width: 60, height: 40 }
	];
	return applyNodeUpdates(nodes, layoutAll(nodes));
};

function render(history?: HistoryManager) {
	const ref: {
		auto: ReturnType<typeof useCanvasAutoLayout> | null;
		nodes: CanvasNode[];
		setNodes: (u: CanvasNode[] | ((p: CanvasNode[]) => CanvasNode[])) => void;
	} = { auto: null, nodes: [], setNodes: () => {} };
	function Test() {
		const [nodes, setNodes] = useState(initial);
		ref.nodes = nodes;
		ref.setNodes = setNodes;
		ref.auto = useCanvasAutoLayout({ nodes, setNodes, history });
		return null;
	}
	return { ref, Test };
}

const rect = (nodes: CanvasNode[], id: string) => {
	const n = nodes.find((x) => x.id === id)!;
	return [n.position.x, n.position.y, n.width, n.height];
};

describe('useCanvasAutoLayout', () => {
	it('adds, reorders and undoes as single steps', async () => {
		const history = new HistoryManager();
		const { ref, Test } = render(history);
		await act(async () => root.render(<Test />));
		expect(rect(ref.nodes, 'F')).toEqual([0, 0, 124, 56]);
		await act(async () => {
			ref.auto!.addNode({ id: 'c', parentId: 'F', position: { x: 0, y: 0 }, data: {}, width: 20, height: 60 });
		});
		expect(rect(ref.nodes, 'c')).toEqual([124, 8, 20, 60]);
		expect(rect(ref.nodes, 'F')).toEqual([0, 0, 152, 76]);
		await act(async () => {
			ref.auto!.moveChild('c', 0);
		});
		expect(getFlowChildren(ref.nodes, 'F')).toEqual(['c', 'a', 'b']);
		expect(rect(ref.nodes, 'a')).toEqual([36, 8, 40, 40]);
		await act(async () => history.undo());
		expect(getFlowChildren(ref.nodes, 'F')).toEqual(['a', 'b', 'c']);
		await act(async () => history.undo());
		expect(ref.nodes.some((n) => n.id === 'c')).toBe(false);
		expect(rect(ref.nodes, 'F')).toEqual([0, 0, 124, 56]);
	});

	it('relayouts after noted onNodesChange batches once React commits', async () => {
		const { ref, Test } = render();
		await act(async () => root.render(<Test />));
		await act(async () => {
			const changes = ref.auto!.noteChanges([{ type: 'dimensions', id: 'a', dimensions: { width: 100, height: 40 } }]);
			expect(changes.length).toBe(1);
			ref.setNodes((prev) => applyNodeUpdates(prev, [{ id: 'a', width: 100 }]));
		});
		expect(ref.auto!.hasPending).toBe(false);
		expect(rect(ref.nodes, 'b')).toEqual([116, 8, 60, 40]);
		expect(rect(ref.nodes, 'F')[2]).toBe(184);
	});

	it('reorders a child dragged within its frame and shows a drop marker', async () => {
		const history = new HistoryManager();
		const { ref, Test } = render(history);
		await act(async () => root.render(<Test />));
		await act(async () => {
			ref.auto!.noteChanges([{ type: 'position', id: 'a', dragging: true, position: { x: 90, y: 8 } }]);
			ref.setNodes((prev) => applyNodeUpdates(prev, [{ id: 'a', position: { x: 90, y: 8 } }]));
		});
		expect(ref.auto!.guides.length).toBe(1);
		await act(async () => {
			ref.auto!.noteChanges([{ type: 'position', id: 'a', dragging: false, position: { x: 90, y: 8 } }]);
			ref.setNodes((prev) => [...prev]);
		});
		expect(getFlowChildren(ref.nodes, 'F')).toEqual(['b', 'a']);
		expect(rect(ref.nodes, 'a')).toEqual([76, 8, 40, 40]);
		expect(ref.auto!.guides).toEqual([]);
		await act(async () => history.undo());
		expect(getFlowChildren(ref.nodes, 'F')).toEqual(['a', 'b']);
		expect(rect(ref.nodes, 'a')).toEqual([8, 8, 40, 40]);
	});

	it('lets useCanvasArrange relayout frames around arranged nodes', async () => {
		const ref: { arrange: ReturnType<typeof useCanvasArrange> | null; nodes: CanvasNode[] } = { arrange: null, nodes: [] };
		function Test() {
			const [nodes, setNodes] = useState(initial);
			ref.nodes = nodes;
			ref.arrange = useCanvasArrange({ nodes, setNodes, autoLayout: true });
			return null;
		}
		await act(async () => root.render(<Test />));
		await act(async () => {
			ref.arrange!.matchSize('width', ['a', 'b']);
		});
		expect(rect(ref.nodes, 'a')[2]).toBe(60);
		expect(rect(ref.nodes, 'b')[0]).toBe(76);
		expect(rect(ref.nodes, 'F')[2]).toBe(144);
	});
});
