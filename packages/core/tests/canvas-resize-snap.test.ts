// Resize / grid cases re-expressed from vectorcraft-main/crates/tools/src/guides.rs and
// vectorcraft-main/crates/geom/src/snap.rs (MIT OR Apache-2.0, © ArtCraft Team and
// contributors). See THIRD_PARTY_NOTICES.md.
import { describe, it, expect, vi } from 'vitest';
import {
	computeSnapGuides,
	createCanvasArrangeController,
	inferResizeHandle,
	lockNodes,
	resizeHandleAxes,
	snapNodeDrag,
	snapNodeResize,
	snapResize,
	snapToGrid,
	type CanvasNode,
	type Rect
} from '../src/canvas';

const box = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });

describe('snapToGrid', () => {
	it('rounds to the nearest grid line', () => {
		expect(snapToGrid(13, 10)).toBe(10);
		expect(snapToGrid(16, 10)).toBe(20);
		expect(snapToGrid(16, 10, 3)).toBe(13);
		expect(snapToGrid(16, 0)).toBe(16);
		expect(snapToGrid(16, -5)).toBe(16);
	});
});

describe('snapResize', () => {
	// The neighbour is 100..200 on both axes; the resized box starts at 250,100 – 300,150.
	const targets = [box(100, 100, 200, 200), box(0, 0, 500, 500)];
	const opts = { threshold: 4 };

	it('lands a side handle on a target edge and keeps the opposite edge', () => {
		const r = snapResize(box(250, 100, 300, 197), 'bottom', targets, opts);
		expect(r.rect).toEqual(box(250, 100, 300, 200));
		expect(r.snappedY).toBe(true);
		expect(r.snappedX).toBe(false);
		expect(r.guides).toHaveLength(1);
		expect(r.guides[0]).toMatchObject({ orientation: 'horizontal', kind: 'edge', y1: 200, y2: 200, x1: 100, x2: 300 });
	});

	it('snaps a corner on each axis independently', () => {
		const r = snapResize(box(250, 100, 330, 202), 'bottom-right', targets, opts);
		expect(r.rect).toEqual(box(250, 100, 330, 200));
		expect(r.guides).toHaveLength(1);
		const both = snapResize(box(250, 100, 498, 202), 'bottom-right', targets, opts);
		expect(both.rect).toEqual(box(250, 100, 500, 200));
		expect(both.snappedX && both.snappedY).toBe(true);
		expect(both.guides).toHaveLength(2);
	});

	it('carries the other axis with keepAspectRatio', () => {
		const r = snapResize(box(250, 100, 348, 198), 'bottom-right', targets, { ...opts, keepAspectRatio: true });
		expect(r.rect).toEqual(box(250, 100, 350, 200));
	});

	it('leaves boxes out of reach untouched and rejects collapsing snaps', () => {
		const far = snapResize(box(250, 100, 300, 180), 'bottom', targets, opts);
		expect(far.rect).toEqual(box(250, 100, 300, 180));
		expect(far.changed).toBe(false);
		expect(far.guides).toEqual([]);
		// The only target in reach (100) is the fixed top edge: snapping would collapse the box.
		const collapse = snapResize(box(250, 100, 300, 102), 'bottom', targets, opts);
		expect(collapse.rect).toEqual(box(250, 100, 300, 102));
		expect(collapse.guides).toEqual([]);
		// Flipping past the fixed edge is rejected too.
		const flip = snapResize(box(150, 300, 202, 340), 'left', [box(203, 0, 210, 10)], opts);
		expect(flip.rect.x).toBe(150);
	});

	it('respects minWidth / minHeight', () => {
		const r = snapResize(box(0, 0, 13, 10), 'right', [box(10, 50, 20, 60)], { threshold: 4, minWidth: 12 });
		// 10 would leave 10 < 12; the centre (15) is within reach and valid.
		expect(r.rect.width).toBe(15);
		expect(r.guides[0].kind).toBe('centre');
	});

	it('keeps the right edge fixed for left handles and snaps to centres', () => {
		const r = snapResize(box(148, 300, 300, 340), 'left', targets, opts);
		expect(r.rect).toEqual(box(150, 300, 300, 340));
		expect(r.guides[0]).toMatchObject({ orientation: 'vertical', kind: 'centre', x1: 150 });
	});

	it('snaps the moving edge to the grid when no shape is in reach', () => {
		const r = snapResize(box(250, 100, 333, 150), 'right', [], { gridSize: 10 });
		expect(r.rect).toEqual(box(250, 100, 330, 150));
		expect(r.guides).toEqual([]);
		expect(r.snappedX).toBe(false);
		// Shapes win over the grid.
		const shape = snapResize(box(250, 100, 333, 150), 'right', [box(335, 0, 400, 10)], { gridSize: 10 });
		expect(shape.rect.x + shape.rect.width).toBe(335);
		// The grid never collapses the box (253 would round to 250, the fixed edge).
		const tiny = snapResize(box(250, 100, 253, 150), 'right', [], { gridSize: 10 });
		expect(tiny.rect.width).toBe(3);
		// A grid origin shifts the lines.
		const shifted = snapResize(box(250, 100, 333, 150), 'right', [], { gridSize: 10, gridOrigin: { x: 5, y: 0 } });
		expect(shifted.rect.x + shifted.rect.width).toBe(335);
	});

	it('scales a side handle with keepAspectRatio about the cross-axis centre', () => {
		const r = snapResize(box(250, 100, 298, 150), 'right', [box(300, 0, 310, 10)], { threshold: 4, keepAspectRatio: true });
		expect(r.rect.width).toBe(50);
		expect(r.rect.height).toBeCloseTo(52.0833, 3);
		expect(r.rect.y + r.rect.height / 2).toBeCloseTo(125);
	});
});

describe('resize handles', () => {
	it('maps handles to moving edges and infers them from moved edges', () => {
		expect(resizeHandleAxes('top-left')).toEqual({ x: -1, y: -1 });
		expect(resizeHandleAxes('bottom')).toEqual({ x: 0, y: 1 });
		const start = box(0, 0, 100, 100);
		expect(inferResizeHandle(start, box(0, 0, 120, 100))).toBe('right');
		expect(inferResizeHandle(start, box(-5, -5, 100, 100))).toBe('top-left');
		expect(inferResizeHandle(start, box(0, 0, 100, 130))).toBe('bottom');
		expect(inferResizeHandle(start, start)).toBeNull();
	});
});

describe('grid snapping while dragging', () => {
	it('snaps the top-left to the grid on axes without a shape snap', () => {
		const r = computeSnapGuides(box(13, 27, 63, 77), [], { gridSize: 10, spacing: false });
		expect(r.position).toEqual({ x: 10, y: 30 });
		expect(r.guides).toEqual([]);
		expect(r.snappedX).toBe(false);
		// x aligns with a shape (left edge 14 within 6px); y falls back to the grid.
		const mixed = computeSnapGuides(box(13, 27, 63, 77), [box(14, 500, 30, 510)], { gridSize: 10 });
		expect(mixed.position).toEqual({ x: 14, y: 30 });
		expect(mixed.snappedX).toBe(true);
	});

	it('flows through snapNodeDrag options', () => {
		const nodes: CanvasNode[] = [{ id: 'a', position: { x: 21, y: 38 }, width: 10, height: 10, data: {} }];
		expect(snapNodeDrag(nodes, ['a'], { gridSize: 20 }).updates).toEqual([{ id: 'a', position: { x: 20, y: 40 } }]);
	});
});

const n = (id: string, x: number, y: number, w: number, h: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({
	id,
	position: { x, y },
	width: w,
	height: h,
	data: {},
	...extra
});

describe('snapNodeResize', () => {
	it('snaps against other nodes, writing parent-relative positions', () => {
		const nodes = [n('g', 100, 100, 400, 400), n('a', 10, 10, 50, 50, { parentId: 'g' }), n('b', 200, 200, 50, 50)];
		const r = snapNodeResize(nodes, 'a', box(110, 110, 160, 198), 'bottom', { threshold: 4 });
		expect(r.updates).toEqual([{ id: 'a', position: { x: 10, y: 10 }, width: 50, height: 90 }]);
		// The parent's edges are targets too.
		const edge = snapNodeResize(nodes, 'a', box(110, 110, 497, 160), 'right', { threshold: 4 });
		expect(edge.rect.x + edge.rect.width).toBe(500);
	});

	it('does not snap locked nodes', () => {
		const nodes = lockNodes([n('a', 0, 0, 50, 50), n('b', 0, 100, 50, 50)], ['a']);
		expect(snapNodeResize(nodes, 'a', box(0, 0, 50, 98), 'bottom').updates).toEqual([]);
	});
});

describe('arrange controller resize snapping', () => {
	const setup = (initial: CanvasNode[], extra = {}) => {
		let nodes = initial;
		const onGuidesChange = vi.fn();
		const controller = createCanvasArrangeController({
			getNodes: () => nodes,
			setNodes: (next) => (nodes = next),
			onGuidesChange,
			...extra
		});
		return { controller, get nodes() { return nodes; }, set: (next: CanvasNode[]) => (nodes = next), onGuidesChange };
	};

	it('snaps React Flow dimensions changes and keeps the snapped size on resize end', () => {
		const s = setup([n('a', 0, 0, 50, 50), n('b', 100, 0, 50, 80)]);
		const frame = s.controller.snapResizeChanges([
			{ id: 'a', type: 'dimensions', resizing: true, setAttributes: true, dimensions: { width: 50, height: 77 } }
		]);
		expect(frame).toEqual([
			{ id: 'a', type: 'dimensions', resizing: true, setAttributes: true, dimensions: { width: 50, height: 80 } }
		]);
		expect(s.controller.guides).toHaveLength(1);
		expect(s.onGuidesChange).toHaveBeenCalled();
		// The flow applies the change; the end change carries the raw pointer size.
		s.set(s.nodes.map((x) => (x.id === 'a' ? { ...x, height: 80 } : x)));
		const end = s.controller.snapResizeChanges([{ id: 'a', type: 'dimensions', resizing: false, dimensions: { width: 50, height: 77 } }]);
		expect(end[0].dimensions).toEqual({ width: 50, height: 80 });
		expect(s.controller.guides).toEqual([]);
	});

	it('moves the position change for top / left handles', () => {
		const s = setup([n('a', 100, 100, 50, 50), n('b', 0, 0, 52, 20)]);
		const out = s.controller.snapResizeChanges([
			{ id: 'a', type: 'position', position: { x: 54, y: 100 } },
			{ id: 'a', type: 'dimensions', resizing: true, dimensions: { width: 96, height: 50 } }
		]);
		expect(out[0].position).toEqual({ x: 52, y: 100 });
		expect(out[1].dimensions).toEqual({ width: 98, height: 50 });
	});

	it('leaves unrelated batches alone and drops resize changes of locked nodes', () => {
		const s = setup(lockNodes([n('a', 0, 0, 50, 50), n('b', 100, 0, 50, 80)], ['a']));
		const plain = [{ id: 'b', type: 'select', selected: true }];
		expect(s.controller.snapResizeChanges(plain)).toBe(plain);
		const locked = s.controller.snapResizeChanges([
			{ id: 'a', type: 'dimensions', resizing: true, dimensions: { width: 50, height: 77 } },
			{ id: 'b', type: 'select', selected: true }
		]);
		expect(locked).toEqual([{ id: 'b', type: 'select', selected: true }]);
	});

	it('honours resizeSnapping: false', () => {
		const s = setup([n('a', 0, 0, 50, 50), n('b', 100, 0, 50, 80)], { resizeSnapping: false });
		const changes = [{ id: 'a', type: 'dimensions', resizing: true, dimensions: { width: 50, height: 77 } }];
		expect(s.controller.snapResizeChanges(changes)).toBe(changes);
	});

	it('resize() snaps a node the flow already resized (SvelteFlow) and endResize re-applies it', () => {
		const s = setup([n('a', 0, 0, 50, 50), n('b', 100, 0, 50, 80)], { guides: { gridSize: 0 } });
		s.controller.beginResize('a');
		s.set(s.nodes.map((x) => (x.id === 'a' ? { ...x, height: 78 } : x)));
		const r = s.controller.resize('a');
		expect(r?.rect.height).toBe(80);
		expect(s.nodes[0].height).toBe(80);
		expect(s.controller.guides).toHaveLength(1);
		// The flow writes the raw size once more; ending the resize restores the snap.
		s.set(s.nodes.map((x) => (x.id === 'a' ? { ...x, height: 78 } : x)));
		s.controller.endResize();
		expect(s.nodes[0].height).toBe(80);
		expect(s.controller.guides).toEqual([]);
	});

	it('resize() restores a locked node to its starting box', () => {
		const s = setup(lockNodes([n('a', 0, 0, 50, 50)], ['a']));
		s.controller.beginResize('a');
		s.set(s.nodes.map((x) => (x.id === 'a' ? { ...x, width: 70, position: { x: -20, y: 0 } } : x)));
		expect(s.controller.resize('a')).toBeNull();
		expect(s.nodes[0]).toMatchObject({ width: 50, position: { x: 0, y: 0 } });
	});
});
