import { describe, it, expect } from 'vitest';
import { HistoryManager } from '../src/history';
import {
	applyNodeUpdates,
	createCanvasArrangeController,
	createCanvasAutoLayoutController,
	getFlowChildren,
	layoutAll,
	type CanvasNode,
	type GuideLine
} from '../src/canvas';

const frame = (): CanvasNode[] => [
	{
		id: 'F',
		position: { x: 100, y: 100 },
		data: { layout: { mode: 'vertical', gap: 10, padding: 10, sizing: { width: 'hug', height: 'hug' } } },
		width: 10,
		height: 10
	},
	{ id: 'a', parentId: 'F', position: { x: 0, y: 0 }, data: {}, width: 100, height: 40 },
	{ id: 'b', parentId: 'F', position: { x: 0, y: 0 }, data: {}, width: 80, height: 30 },
	{ id: 'free', position: { x: 500, y: 0 }, data: {}, width: 50, height: 50 }
];

function setup(withHistory = true, extra: { onGuidesChange?: (g: GuideLine[]) => void } = {}) {
	let nodes = frame();
	nodes = applyNodeUpdates(nodes, layoutAll(nodes));
	const history = withHistory ? new HistoryManager() : undefined;
	const controller = createCanvasAutoLayoutController({
		getNodes: () => nodes,
		setNodes: (next) => {
			nodes = next;
		},
		history,
		...extra
	});
	return {
		controller,
		history,
		get nodes() {
			return nodes;
		},
		set nodes(next: CanvasNode[]) {
			nodes = next;
		},
		rect(id: string) {
			const n = nodes.find((x) => x.id === id)!;
			return [n.position.x, n.position.y, n.width, n.height];
		}
	};
}

describe('createCanvasAutoLayoutController', () => {
	it('starts from a laid out frame', () => {
		const t = setup();
		expect(t.rect('F')).toEqual([100, 100, 120, 100]);
		expect(t.rect('b')).toEqual([10, 60, 80, 30]);
	});

	it('adds a node into a frame and relayouts in one undo step', () => {
		const t = setup();
		t.controller.addNode({ id: 'c', parentId: 'F', position: { x: 0, y: 0 }, data: {}, width: 140, height: 20 }, { index: 0 });
		expect(getFlowChildren(t.nodes, 'F')).toEqual(['c', 'a', 'b']);
		expect(t.rect('c')).toEqual([10, 10, 140, 20]);
		expect(t.rect('a')).toEqual([10, 40, 100, 40]);
		expect(t.rect('F')).toEqual([100, 100, 160, 130]);
		expect(t.history!.getState().undoCount).toBe(1);
		t.history!.undo();
		expect(t.nodes.some((n) => n.id === 'c')).toBe(false);
		expect(t.rect('F')).toEqual([100, 100, 120, 100]);
		expect(t.rect('a')).toEqual([10, 10, 100, 40]);
		t.history!.redo();
		expect(t.rect('F')).toEqual([100, 100, 160, 130]);
	});

	it('removes nodes with their descendants and restores them on undo', () => {
		const t = setup();
		t.nodes = [...t.nodes, { id: 'a1', parentId: 'a', position: { x: 1, y: 1 }, data: {}, width: 5, height: 5 }];
		const before = t.nodes.map((n) => n.id);
		t.controller.removeNodes(['a']);
		expect(t.nodes.map((n) => n.id)).toEqual(['F', 'b', 'free']);
		expect(t.rect('b')).toEqual([10, 10, 80, 30]);
		expect(t.rect('F')).toEqual([100, 100, 100, 50]);
		t.history!.undo();
		expect(t.nodes.map((n) => n.id)).toEqual(before);
		expect(t.rect('b')).toEqual([10, 60, 80, 30]);
		expect(t.rect('F')).toEqual([100, 100, 120, 100]);
	});

	it('resizes a child and the hugging frame follows', () => {
		const t = setup();
		t.controller.resizeNode('a', { width: 200 });
		expect(t.rect('F')).toEqual([100, 100, 220, 100]);
		t.history!.undo();
		expect(t.rect('a')).toEqual([10, 10, 100, 40]);
		expect(t.rect('F')).toEqual([100, 100, 120, 100]);
	});

	it('applies constraints when resizing a plain parent', () => {
		const t = setup(false);
		t.nodes = [
			{ id: 'P', position: { x: 0, y: 0 }, data: {}, width: 100, height: 100 },
			{
				id: 'pin',
				parentId: 'P',
				position: { x: 80, y: 80 },
				data: { childLayout: { constraints: { horizontal: 'right', vertical: 'bottom' } } },
				width: 10,
				height: 10
			}
		];
		t.controller.resizeNode('P', { width: 200, height: 150 });
		expect(t.rect('pin')).toEqual([180, 130, 10, 10]);
	});

	it('moves a child to a new index and undoes it', () => {
		const t = setup();
		t.controller.moveChild('a', 1);
		expect(getFlowChildren(t.nodes, 'F')).toEqual(['b', 'a']);
		expect(t.rect('b')).toEqual([10, 10, 80, 30]);
		expect(t.rect('a')).toEqual([10, 50, 100, 40]);
		t.history!.undo();
		expect(getFlowChildren(t.nodes, 'F')).toEqual(['a', 'b']);
		expect(t.rect('a')).toEqual([10, 10, 100, 40]);
		expect(t.controller.moveChild('a', 0)).toEqual([]);
	});

	it('applies auto layout explicitly', () => {
		const t = setup();
		t.nodes = applyNodeUpdates(t.nodes, [{ id: 'b', position: { x: 70, y: 70 } }]);
		t.controller.applyAutoLayout('F');
		expect(t.rect('b')).toEqual([10, 60, 80, 30]);
		t.history!.undo();
		expect(t.rect('b')).toEqual([70, 70, 80, 30]);
		t.nodes = applyNodeUpdates(t.nodes, [{ id: 'a', width: 300 }]);
		t.controller.applyAutoLayout();
		expect(t.rect('F')[2]).toBe(320);
	});

	it('does not relayout automatically when disabled, except on explicit apply', () => {
		let nodes = applyNodeUpdates(frame(), layoutAll(frame()));
		const c = createCanvasAutoLayoutController({ getNodes: () => nodes, setNodes: (n) => (nodes = n), enabled: false });
		c.resizeNode('a', { width: 300 });
		expect(nodes.find((n) => n.id === 'F')!.width).toBe(120);
		c.applyAutoLayout('F');
		expect(nodes.find((n) => n.id === 'F')!.width).toBe(320);
	});

	it('relayouts after noted flow changes (measure, resize end, remove)', () => {
		const t = setup(false);
		// A measured size change.
		t.nodes = applyNodeUpdates(t.nodes, [{ id: 'b', height: 60 }]);
		t.controller.noteChanges([{ type: 'dimensions', id: 'b', dimensions: { width: 80, height: 60 } }]);
		expect(t.controller.hasPending).toBe(true);
		t.controller.flush();
		expect(t.rect('F')[3]).toBe(130);
		// A resize gesture of the frame's sibling-less child.
		t.controller.noteChanges([{ type: 'dimensions', id: 'a', resizing: true, dimensions: { width: 100, height: 40 } }]);
		t.nodes = applyNodeUpdates(t.nodes, [{ id: 'a', width: 150 }]);
		t.controller.noteChanges([{ type: 'dimensions', id: 'a', resizing: false, dimensions: { width: 150, height: 40 } }]);
		t.controller.flush();
		expect(t.rect('F')[2]).toBe(170);
		// Removal: the parent is looked up before the change is applied.
		t.controller.noteChanges([{ type: 'remove', id: 'a' }]);
		t.nodes = t.nodes.filter((n) => n.id !== 'a');
		t.controller.flush();
		expect(t.rect('b')).toEqual([10, 10, 80, 60]);
		expect(t.controller.hasPending).toBe(false);
		// Nothing left to do: no further writes.
		const same = t.nodes;
		t.controller.flush();
		expect(t.nodes).toBe(same);
	});

	it('reorders a child dropped inside its frame, with a drop marker and undo to the drag start', () => {
		const guides: GuideLine[][] = [];
		const t = setup(true, { onGuidesChange: (g) => guides.push(g) });
		// Drag `a` below `b` (frame-relative y 75 → centre at 95, below b's centre at 75).
		t.controller.noteChanges([{ type: 'position', id: 'a', dragging: true, position: { x: 10, y: 75 } }]);
		t.nodes = applyNodeUpdates(t.nodes, [{ id: 'a', position: { x: 10, y: 75 } }]);
		t.controller.flush();
		expect(t.controller.guides.length).toBe(1);
		expect(guides.at(-1)![0].orientation).toBe('horizontal');
		t.controller.noteChanges([{ type: 'position', id: 'a', dragging: false, position: { x: 10, y: 75 } }]);
		t.controller.flush();
		expect(getFlowChildren(t.nodes, 'F')).toEqual(['b', 'a']);
		expect(t.rect('a')).toEqual([10, 50, 100, 40]);
		expect(t.controller.guides).toEqual([]);
		t.history!.undo();
		expect(getFlowChildren(t.nodes, 'F')).toEqual(['a', 'b']);
		expect(t.rect('a')).toEqual([10, 10, 100, 40]);
	});

	it('snaps a child dropped in its own slot back into place', () => {
		const t = setup();
		t.controller.beginReorderDrag('a');
		t.nodes = applyNodeUpdates(t.nodes, [{ id: 'a', position: { x: 30, y: 12 } }]);
		t.controller.endReorderDrag('a');
		expect(t.rect('a')).toEqual([10, 10, 100, 40]);
		expect(t.controller.endReorderDrag('free')).toEqual([]);
	});
});

describe('arrange controller with autoLayout', () => {
	it('relayouts frames around arranged nodes in the same undo step', () => {
		let nodes = applyNodeUpdates(frame(), layoutAll(frame()));
		const history = new HistoryManager();
		const arrange = createCanvasArrangeController({
			getNodes: () => nodes,
			setNodes: (n) => (nodes = n),
			history,
			autoLayout: true
		});
		arrange.matchSize('width', ['a', 'b'], { reference: 'largest' });
		expect(nodes.find((n) => n.id === 'b')!.width).toBe(100);
		arrange.matchSize('height', ['a', 'free'], { reference: { id: 'free' } });
		expect(nodes.find((n) => n.id === 'a')!.height).toBe(50);
		expect(nodes.find((n) => n.id === 'F')!.height).toBe(110);
		expect(history.getState().undoCount).toBe(2);
		history.undo();
		expect(nodes.find((n) => n.id === 'a')!.height).toBe(40);
		expect(nodes.find((n) => n.id === 'F')!.height).toBe(100);
	});
});
