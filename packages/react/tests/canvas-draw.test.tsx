import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HistoryManager } from '@pixerate/editor/history';
import {
	useCanvasDraw,
	CanvasDrawLayer,
	type CanvasDraw,
	type CanvasNode
} from '../src/canvas';

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
		url: 'https://example.com/editor'
	});
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

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

describe('useCanvasDraw and CanvasDrawLayer (react)', () => {
	it('manages drawing tool state and creates shape nodes on stroke completion', async () => {
		const ref: { draw: CanvasDraw | null; nodes: CanvasNode[] } = {
			draw: null,
			nodes: []
		};

		function TestComponent() {
			const [nodes, setNodes] = useState<CanvasNode[]>([]);
			ref.nodes = nodes;
			const draw = useCanvasDraw({
				nodes,
				setNodes,
				initialTool: 'pen'
			});
			ref.draw = draw;
			return <CanvasDrawLayer draw={draw} />;
		}

		await act(async () => {
			root.render(<TestComponent />);
		});

		expect(ref.draw).not.toBeNull();
		expect(ref.draw?.tool).toBe('pen');
		expect(ref.draw?.isDrawing).toBe(false);

		// Switch tool to highlighter
		act(() => {
			ref.draw?.setTool('highlighter');
		});
		expect(ref.draw?.tool).toBe('highlighter');
		expect(ref.draw?.style.width).toBe(24);
		expect(ref.draw?.style.opacity).toBe(0.35);

		// Perform a stroke
		act(() => {
			ref.draw?.startStroke([10, 10]);
		});
		expect(ref.draw?.isDrawing).toBe(true);
		expect(ref.draw?.activeStroke?.points.length).toBe(1);

		act(() => {
			ref.draw?.continueStroke([20, 20]);
			ref.draw?.continueStroke([30, 40]);
		});
		expect(ref.draw?.activeStroke?.points.length).toBe(3);

		let completedNode: CanvasNode | null = null;
		act(() => {
			completedNode = ref.draw?.endStroke() ?? null;
		});

		expect(ref.draw?.isDrawing).toBe(false);
		expect(completedNode).not.toBeNull();
		expect(ref.nodes.length).toBe(1);
		expect(ref.nodes[0].type).toBe('shape');
		expect((ref.nodes[0].data as any).shape.kind).toBe('path');
	});

	it('supports undo and redo with HistoryManager', async () => {
		const history = new HistoryManager();
		const ref: { draw: CanvasDraw | null; nodes: CanvasNode[] } = {
			draw: null,
			nodes: []
		};

		function TestComponent() {
			const [nodes, setNodes] = useState<CanvasNode[]>([]);
			ref.nodes = nodes;
			const draw = useCanvasDraw({
				nodes,
				setNodes,
				history,
				initialTool: 'pen'
			});
			ref.draw = draw;
			return <CanvasDrawLayer draw={draw} />;
		}

		await act(async () => {
			root.render(<TestComponent />);
		});

		act(() => {
			ref.draw?.startStroke([0, 0]);
			ref.draw?.continueStroke([50, 50]);
			ref.draw?.endStroke();
		});

		expect(ref.nodes.length).toBe(1);
		expect(history.getState().canUndo).toBe(true);

		act(() => {
			history.undo();
		});
		expect(ref.nodes.length).toBe(0);

		act(() => {
			history.redo();
		});
		expect(ref.nodes.length).toBe(1);
	});

	it('renders CanvasDrawLayer with interactive pointer events when tool is active', async () => {
		let drawInstance: CanvasDraw | null = null;

		function TestComponent() {
			const [nodes, setNodes] = useState<CanvasNode[]>([]);
			const draw = useCanvasDraw({
				nodes,
				setNodes,
				initialTool: 'pen'
			});
			drawInstance = draw;
			return <CanvasDrawLayer draw={draw} />;
		}

		await act(async () => {
			root.render(<TestComponent />);
		});

		const svg = container.querySelector('svg.pixerate-canvas-draw-layer') as SVGSVGElement;
		expect(svg).not.toBeNull();
		expect(svg.style.pointerEvents).toBe('all');
		expect(svg.style.cursor).toBe('crosshair');

		// Switching to select makes pointer-events none
		act(() => {
			drawInstance?.setTool('select');
		});
		expect(svg.style.pointerEvents).toBe('none');
	});
});
