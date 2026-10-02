import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
	useCanvasGraph,
	useCanvasLayout,
	useCanvasDocking,
	useCanvasClipboard,
	type CanvasNode,
	type CanvasEdge
} from '../src/canvas';

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const dom = new JSDOM(
		'<!DOCTYPE html><html><body><div id="root"></div></body></html>',
		{ url: 'https://example.com/editor' }
	);
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
	(globalThis as any).HTMLElement = dom.window.HTMLElement;
});

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

describe('React Canvas - useCanvasGraph', () => {
	it('manages nodes and tracks graph differences accurately', async () => {
		const initialNodes: CanvasNode[] = [
			{ id: '1', position: { x: 0, y: 0 }, data: { label: 'Node 1' } },
			{ id: '2', position: { x: 100, y: 100 }, data: { label: 'Node 2' } }
		];

		let graphResult: ReturnType<typeof useCanvasGraph> | null = null;

		function TestComponent() {
			graphResult = useCanvasGraph({ initialNodes });
			return null;
		}

		await act(async () => {
			root.render(<TestComponent />);
		});

		expect(graphResult!.nodes).toHaveLength(2);

		// Initially, no differences
		let diffs = graphResult!.getDifferences();
		expect(diffs.changedNodes).toHaveLength(0);
		expect(diffs.removedNodes).toHaveLength(0);

		// Update position of Node 1
		await act(async () => {
			graphResult!.updateNodePosition('1', { x: 50, y: 50 });
		});

		diffs = graphResult!.getDifferences();
		expect(diffs.changedNodes).toHaveLength(1);
		expect(diffs.changedNodes[0].id).toBe('1');
		expect(diffs.changedNodes[0].position).toEqual({ x: 50, y: 50 });

		// Add a new node
		await act(async () => {
			graphResult!.addNode({ id: '3', position: { x: 200, y: 200 }, data: {} });
		});

		expect(graphResult!.nodes).toHaveLength(3);

		// Reset baseline
		await act(async () => {
			graphResult!.resetBaseline();
		});

		diffs = graphResult!.getDifferences();
		expect(diffs.changedNodes).toHaveLength(0);
	});
});

describe('React Canvas - useCanvasLayout', () => {
	it('applies hierarchical and incremental layout', async () => {
		const nodes: CanvasNode[] = [
			{ id: 'a', position: { x: 0, y: 0 }, data: {} },
			{ id: 'b', position: { x: 0, y: 0 }, data: {} }
		];
		const edges: CanvasEdge[] = [{ id: 'e1', source: 'a', target: 'b' }];
		const setNodes = vi.fn();

		let layoutResult: ReturnType<typeof useCanvasLayout> | null = null;

		function TestComponent() {
			layoutResult = useCanvasLayout({
				nodes,
				edges,
				setNodes,
				getNodesBounds: () => ({ x: 0, y: 0, width: 300, height: 100 })
			});
			return null;
		}

		await act(async () => {
			root.render(<TestComponent />);
		});

		act(() => {
			const layouted = layoutResult!.applyLayout({ direction: 'LR' });
			expect(layouted).toHaveLength(2);
			const nodeA = layouted.find((n) => n.id === 'a')!;
			const nodeB = layouted.find((n) => n.id === 'b')!;
			expect(nodeB.position.x).toBeGreaterThan(nodeA.position.x);
		});

		expect(setNodes).toHaveBeenCalled();
	});

	it('calculates collision-free adjacent placement position', async () => {
		const nodes: CanvasNode[] = [
			{ id: 'anchor', position: { x: 100, y: 100 }, width: 200, height: 60, data: {} },
			{ id: 'obstacle', position: { x: 348, y: 100 }, width: 200, height: 60, data: {} }
		];
		const setNodes = vi.fn();

		let layoutResult: ReturnType<typeof useCanvasLayout> | null = null;

		function TestComponent() {
			layoutResult = useCanvasLayout({ nodes, edges: [], setNodes });
			return null;
		}

		await act(async () => {
			root.render(<TestComponent />);
		});

		const pos = layoutResult!.getPlacementPosition(
			{ width: 200, height: 60 },
			'right',
			'anchor'
		);

		// Must have shifted away from y=100 because of the obstacle
		expect(pos.y).not.toBe(100);
	});
});

describe('React Canvas - useCanvasDocking', () => {
	it('identifies docking target candidates on overlap', async () => {
		const draggedNode: CanvasNode = {
			id: 'dragged',
			position: { x: 110, y: 110 },
			width: 100,
			height: 50,
			data: {}
		};

		const candidateNode: CanvasNode = {
			id: 'target',
			position: { x: 100, y: 100 },
			width: 200,
			height: 100,
			data: {}
		};

		const onDockHover = vi.fn();
		const onDockDrop = vi.fn();

		let dockingResult: ReturnType<typeof useCanvasDocking> | null = null;

		function TestComponent() {
			dockingResult = useCanvasDocking({
				onDockHover,
				onDockDrop
			});
			return null;
		}

		await act(async () => {
			root.render(<TestComponent />);
		});

		act(() => {
			dockingResult!.updateDragOver(draggedNode, [candidateNode]);
		});

		expect(onDockHover).toHaveBeenCalledWith(candidateNode, draggedNode);

		act(() => {
			dockingResult!.finalizeDock(draggedNode);
		});

		expect(onDockDrop).toHaveBeenCalledWith(candidateNode, draggedNode);
	});
});

describe('React Canvas - useCanvasClipboard', () => {
	it('handles copy and paste events with ID remapping', async () => {
		const onPasteNodes = vi.fn();
		let clipboardResult: ReturnType<typeof useCanvasClipboard> | null = null;

		function TestComponent() {
			clipboardResult = useCanvasClipboard({ onPasteNodes });
			return null;
		}

		await act(async () => {
			root.render(<TestComponent />);
		});

		const fakeEvent = {
			nativeEvent: {
				target: document.createElement('div'),
				clipboardData: {
					getData: (type: string) => {
						if (type === 'application/json') {
							return JSON.stringify({
								version: 1,
								nodes: [{ id: 'orig', position: { x: 10, y: 10 }, data: {} }],
								edges: []
							});
						}
						return '';
					}
				},
				preventDefault: vi.fn()
			}
		};

		await act(async () => {
			const handled = await clipboardResult!.handlePasteEvent(fakeEvent as any);
			expect(handled).toBe(true);
		});

		expect(onPasteNodes).toHaveBeenCalled();
		const pastedNodes = onPasteNodes.mock.calls[0][0];
		expect(pastedNodes[0].id).not.toBe('orig');
	});
});
