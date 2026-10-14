import { describe, it, expect } from 'vitest';
import { HistoryManager } from '@pixerate/editor/history';
import { createCanvasAutoLayout } from '../../src/canvas/createCanvasAutoLayout.svelte.js';
import { createCanvasArrange } from '../../src/canvas/createCanvasArrange.svelte.js';
import { applyNodeUpdates, getFlowChildren, layoutAll } from '../../src/canvas/index.js';
import type { CanvasNode } from '../../src/canvas/types.js';

const initial = (): CanvasNode[] => {
	const nodes = [
		{
			id: 'F',
			position: { x: 0, y: 0 },
			data: { layout: { mode: 'vertical', gap: 8, padding: 8, sizing: { width: 'hug', height: 'hug' } } },
			width: 10,
			height: 10
		},
		{ id: 'a', parentId: 'F', position: { x: 0, y: 0 }, data: {}, width: 40, height: 40 },
		{ id: 'b', parentId: 'F', position: { x: 0, y: 0 }, data: {}, width: 60, height: 20 }
	] as CanvasNode[];
	return applyNodeUpdates(nodes, layoutAll(nodes));
};

function setup(history?: HistoryManager) {
	let nodes = initial();
	const autoLayout = createCanvasAutoLayout({
		getNodes: () => nodes,
		setNodes: (next) => {
			nodes = next;
		},
		history
	});
	return {
		autoLayout,
		get nodes() {
			return nodes;
		},
		set nodes(n) {
			nodes = n;
		}
	};
}

const rect = (nodes: CanvasNode[], id: string) => {
	const n = nodes.find((x) => x.id === id)!;
	return [n.position.x, n.position.y, n.width, n.height];
};
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('createCanvasAutoLayout (Svelte rune)', () => {
	it('relayouts in the same undoable step as its actions', () => {
		const history = new HistoryManager();
		const ctx = setup(history);
		expect(rect(ctx.nodes, 'F')).toEqual([0, 0, 76, 84]);
		ctx.autoLayout.resizeNode('b', { width: 100 });
		expect(rect(ctx.nodes, 'F')).toEqual([0, 0, 116, 84]);
		ctx.autoLayout.removeNodes(['a']);
		expect(rect(ctx.nodes, 'b')).toEqual([8, 8, 100, 20]);
		history.undo();
		history.undo();
		expect(rect(ctx.nodes, 'F')).toEqual([0, 0, 76, 84]);
		expect(rect(ctx.nodes, 'b')).toEqual([8, 56, 60, 20]);
	});

	it('relayouts after SvelteFlow deletes, measures and resizes nodes', async () => {
		const ctx = setup();
		const removed = ctx.nodes.find((n) => n.id === 'a')!;
		ctx.nodes = ctx.nodes.filter((n) => n.id !== 'a');
		ctx.autoLayout.nodesDeleted([removed]);
		await tick();
		expect(rect(ctx.nodes, 'b')).toEqual([8, 8, 60, 20]);
		ctx.nodes = applyNodeUpdates(ctx.nodes, [{ id: 'b', height: 50 }]);
		ctx.autoLayout.measured('b');
		await tick();
		expect(rect(ctx.nodes, 'F')[3]).toBe(66);
		const handlers = ctx.autoLayout.resizerHandlers('b');
		handlers.onResizeStart();
		ctx.nodes = applyNodeUpdates(ctx.nodes, [{ id: 'b', width: 90 }]);
		handlers.onResizeEnd();
		await tick();
		expect(rect(ctx.nodes, 'F')[2]).toBe(106);
	});

	it('reorders a dragged child with a reactive drop marker', () => {
		const history = new HistoryManager();
		const ctx = setup(history);
		ctx.nodes = applyNodeUpdates(ctx.nodes, [{ id: 'a', position: { x: 8, y: 60 } }]);
		ctx.autoLayout.dragReorder('a');
		expect(ctx.autoLayout.guides.length).toBe(1);
		ctx.autoLayout.endReorderDrag('a');
		expect(ctx.autoLayout.guides).toEqual([]);
		expect(getFlowChildren(ctx.nodes, 'F')).toEqual(['b', 'a']);
		expect(rect(ctx.nodes, 'a')).toEqual([8, 36, 40, 40]);
		history.undo();
		expect(getFlowChildren(ctx.nodes, 'F')).toEqual(['a', 'b']);
	});

	it('flushes noted change batches on a microtask', async () => {
		const ctx = setup();
		ctx.autoLayout.handleChanges([{ type: 'dimensions', id: 'a' }]);
		ctx.nodes = applyNodeUpdates(ctx.nodes, [{ id: 'a', height: 10 }]);
		expect(ctx.autoLayout.hasPending).toBe(true);
		await tick();
		expect(ctx.autoLayout.hasPending).toBe(false);
		expect(rect(ctx.nodes, 'b')).toEqual([8, 26, 60, 20]);
	});

	it('lets createCanvasArrange relayout frames around arranged nodes', () => {
		let nodes = initial();
		const arrange = createCanvasArrange({ getNodes: () => nodes, setNodes: (n) => (nodes = n), autoLayout: true });
		arrange.matchSize('width', ['a', 'b']);
		expect(rect(nodes, 'a')[2]).toBe(60);
		expect(rect(nodes, 'F')[2]).toBe(76);
	});
});
