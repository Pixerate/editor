import { describe, it, expect, afterEach } from 'vitest';
import { HistoryManager } from '@pixerate/editor/history';
import {
	createCanvasDraw,
	type CanvasDraw
} from '../../src/canvas/createCanvasDraw.svelte.js';
import type { CanvasNode } from '../../src/canvas/types.js';

function setup(initial: CanvasNode[] = [], history?: HistoryManager) {
	let nodes = initial;
	const draw = createCanvasDraw({
		getNodes: () => nodes,
		setNodes: (next) => {
			nodes = next;
		},
		history,
		tool: 'pen'
	});
	return {
		draw,
		get nodes() {
			return nodes;
		},
		set nodes(n) {
			nodes = n;
		}
	};
}

describe('createCanvasDraw (Svelte rune)', () => {
	it('manages drawing tool state and creates shape nodes on stroke completion', () => {
		const ctx = setup([]);
		expect(ctx.draw.tool).toBe('pen');
		expect(ctx.draw.isDrawing).toBe(false);

		// Switch tool to highlighter
		ctx.draw.setTool('highlighter');
		expect(ctx.draw.tool).toBe('highlighter');
		expect(ctx.draw.style.width).toBe(24);
		expect(ctx.draw.style.opacity).toBe(0.35);

		// Perform a stroke
		ctx.draw.startStroke([10, 10]);
		expect(ctx.draw.isDrawing).toBe(true);
		expect(ctx.draw.activeStroke?.points.length).toBe(1);

		ctx.draw.continueStroke([20, 20]);
		ctx.draw.continueStroke([30, 40]);
		expect(ctx.draw.activeStroke?.points.length).toBe(3);

		const completedNode = ctx.draw.endStroke();
		expect(ctx.draw.isDrawing).toBe(false);
		expect(completedNode).not.toBeNull();
		expect(ctx.nodes.length).toBe(1);
		expect(ctx.nodes[0].type).toBe('shape');
		expect((ctx.nodes[0].data as any).shape.kind).toBe('path');
	});

	it('supports undo and redo with HistoryManager', () => {
		const history = new HistoryManager();
		const ctx = setup([], history);

		ctx.draw.startStroke([0, 0]);
		ctx.draw.continueStroke([50, 50]);
		ctx.draw.endStroke();

		expect(ctx.nodes.length).toBe(1);
		expect(history.getState().canUndo).toBe(true);

		history.undo();
		expect(ctx.nodes.length).toBe(0);

		history.redo();
		expect(ctx.nodes.length).toBe(1);
	});

	it('erases strokes with the eraser tool', () => {
		const ctx = setup([]);
		// Create a stroke first
		ctx.draw.startStroke([10, 10]);
		ctx.draw.continueStroke([50, 10]);
		ctx.draw.endStroke();
		expect(ctx.nodes.length).toBe(1);

		// Switch to eraser and erase
		ctx.draw.setTool('eraser');
		expect(ctx.draw.tool).toBe('eraser');

		ctx.draw.startStroke([25, 10]);
		ctx.draw.endStroke();
		expect(ctx.nodes.length).toBe(0);
	});
});
