import { describe, it, expect } from 'vitest';
import {
	applyShapeReplacement,
	canOffsetShapeNodes,
	canOutlineShapeNodeStrokes,
	combineShapeNodes,
	hasVisibleStroke,
	offsetShapeNodes,
	outlineShapeNodeStrokes,
	revertShapeCombination,
	shapeNodeToBezierPath,
	shapeToBezierPath
} from '../src/canvas/shapeNodes';
import { bezierPathArea, bezierPathBounds, countPathSegments, toBezierPath } from '../src/canvas/pathops';
import { createCanvasArrangeController } from '../src/canvas/arrangeController';
import { lockNodes } from '../src/canvas/arrange';
import { HistoryManager } from '../src/history';
import { CommandRegistry, createShapeCommands } from '../src/commands';
import type { CanvasNode } from '../src/canvas/types';
import type { ShapeDescription } from '../src/canvas/shapeGeometry';

const shapeNode = (id: string, x: number, y: number, w: number, h: number, shape: ShapeDescription, extra: Partial<CanvasNode> = {}): CanvasNode => ({
	id,
	type: 'shape',
	position: { x, y },
	width: w,
	height: h,
	data: { label: id, shape },
	...extra
});

/** The node's shape outline in absolute coordinates. */
const outlineOf = (node: CanvasNode) => shapeNodeToBezierPath(node)!.path;

describe('shapes as Bézier paths', () => {
	it('converts shapes exactly (arcs to cubics, view boxes and rotation applied)', () => {
		const ellipse = shapeToBezierPath({ kind: 'ellipse' }, { width: 100, height: 50 }).path;
		expect(countPathSegments(ellipse)).toEqual({ lines: 0, quads: 0, cubics: 4 });
		expect(bezierPathBounds(ellipse)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
		const rounded = shapeToBezierPath({ kind: 'rect', cornerRadius: 10 }, { width: 100, height: 50 }).path;
		expect(countPathSegments(rounded)).toEqual({ lines: 4, quads: 0, cubics: 4 });
		const viewBox = shapeToBezierPath({ kind: 'path', d: 'M0 0H1V1H0Z', viewBox: [0, 0, 1, 1], fillRule: 'evenodd' }, { width: 10, height: 20 });
		expect(viewBox.fillRule).toBe('evenodd');
		expect(bezierPathBounds(viewBox.path)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 20 });
		const rotated = shapeToBezierPath({ kind: 'rect', rotation: 90 }, { width: 100, height: 20 }).path;
		const b = bezierPathBounds(rotated)!;
		expect(b.minX).toBeCloseTo(40, 9);
		expect(b.minY).toBeCloseTo(-40, 9);
		expect(shapeToBezierPath({ kind: 'rect' }, { width: 0, height: 10 }).path).toEqual([]);
		const node = shapeNode('a', 10, 20, 100, 50, { kind: 'ellipse' });
		expect(bezierPathBounds(outlineOf(node))).toEqual({ minX: 10, minY: 20, maxX: 110, maxY: 70 });
		expect(shapeNodeToBezierPath({ id: 'x', position: { x: 0, y: 0 }, data: {} })).toBeNull();
	});
});

describe('combineShapeNodes with the curve engine', () => {
	it('keeps curves when uniting two circles', () => {
		const nodes = [shapeNode('a', 0, 0, 100, 100, { kind: 'ellipse', fill: 'red' }), shapeNode('b', 60, 0, 100, 100, { kind: 'ellipse' })];
		const result = combineShapeNodes(nodes, ['a', 'b'], 'unite', { createId: () => 'u' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.engine).toBe('curve');
		expect(result.fallbackReason).toBeUndefined();
		const node = result.nodes[0];
		expect(node).toMatchObject({ id: 'u', position: { x: 0, y: 0 }, width: 160, height: 100 });
		const counts = countPathSegments(node.data.shape.d);
		expect(counts.lines).toBe(0);
		expect(counts.cubics).toBeGreaterThan(0);
		expect(counts.cubics).toBeLessThanOrEqual(12);
		// Exact geometry: union area of two r = 50 circles 60 apart (cubic circles, within 1e-3).
		const r = 50;
		const d = 60;
		const lens = 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
		expect(Math.abs(bezierPathArea(outlineOf(node)) / (2 * Math.PI * r * r - lens) - 1)).toBeLessThan(1e-3);
	});

	it('divides circles into curved pieces and subtracts with curves', () => {
		const nodes = [shapeNode('a', 0, 0, 100, 100, { kind: 'ellipse' }), shapeNode('b', 60, 0, 100, 100, { kind: 'ellipse', fill: 'blue' })];
		const divided = combineShapeNodes(nodes, ['a', 'b'], 'divide');
		expect(divided.ok && divided.nodes).toHaveLength(3);
		if (!divided.ok) return;
		for (const n of divided.nodes) expect(countPathSegments(n.data.shape.d).lines).toBe(0);
		const sub = combineShapeNodes(nodes, ['a', 'b'], 'subtract');
		expect(sub.ok && countPathSegments(sub.nodes[0].data.shape.d).lines).toBe(0);
	});

	it('keeps the polygon engine available', () => {
		const nodes = [shapeNode('a', 0, 0, 100, 100, { kind: 'ellipse' }), shapeNode('b', 60, 0, 100, 100, { kind: 'ellipse' })];
		const lines = combineShapeNodes(nodes, ['a', 'b'], 'unite', { curves: 'lines' });
		expect(lines.ok && lines.engine).toBe('polygon');
		expect(lines.ok && countPathSegments(lines.nodes[0].data.shape.d).cubics).toBe(0);
		const fitted = combineShapeNodes(nodes, ['a', 'b'], 'divide', { engine: 'polygon' });
		expect(fitted.ok && fitted.engine).toBe('polygon');
		expect(fitted.ok && fitted.nodes).toHaveLength(3);
	});
});

describe('offsetShapeNodes', () => {
	const nodes = () => [
		shapeNode('r', 0, 0, 100, 50, { kind: 'rect', fill: 'red', stroke: 'black', strokeWidth: 2 }),
		shapeNode('c', 200, 0, 100, 100, { kind: 'ellipse' }),
		{ id: 'text', position: { x: 0, y: 0 }, data: {}, width: 10, height: 10 } as CanvasNode
	];

	it('grows and shrinks shapes in place, keeping paint and curves', () => {
		let n = 0;
		const result = offsetShapeNodes(nodes(), ['r', 'c', 'text'], 10, { createId: () => `o${n++}` });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.removeIds).toEqual(['r', 'c']);
		const [rect, circle] = result.nodes;
		expect(rect).toMatchObject({ id: 'o0', position: { x: -10, y: -10 }, width: 120, height: 70, selected: true });
		expect(rect.data.shape).toMatchObject({ kind: 'path', fill: 'red', stroke: 'black', strokeWidth: 2, viewBox: [0, 0, 120, 70] });
		expect(countPathSegments(rect.data.shape.d)).toEqual({ lines: 4, quads: 0, cubics: 0 });
		expect(circle.position.x).toBeCloseTo(190, 6);
		expect(circle.width).toBeCloseTo(120, 6);
		expect(countPathSegments(circle.data.shape.d).lines).toBe(0);
		const inset = offsetShapeNodes(nodes(), ['r'], -5, { join: 'round' });
		expect(inset.ok && inset.nodes[0]).toMatchObject({ position: { x: 5, y: 5 }, width: 90, height: 40 });
		const round = offsetShapeNodes(nodes(), ['r'], 10, { join: 'round' });
		expect(round.ok && countPathSegments(round.nodes[0].data.shape.d).cubics).toBe(4);
	});

	it('keeps the original above the offset shape on request and applies in place', () => {
		const list = nodes();
		const result = offsetShapeNodes(list, ['r'], 5, { keepOriginal: true, createId: () => 'o' });
		if (!result.ok) throw new Error('expected ok');
		expect(result.replacements[0].nodes.map((n) => n.id)).toEqual(['o', 'r']);
		const applied = applyShapeReplacement(list, result);
		expect(applied.map((n) => n.id)).toEqual(['o', 'r', 'c', 'text']);
		expect(applied.find((n) => n.id === 'r')!.selected).toBe(false);
		const reverted = revertShapeCombination(applied, result, list);
		expect(reverted).toEqual(list);
	});

	it('refuses locked shapes, empty selections, empty results and invalid distances', () => {
		expect(offsetShapeNodes(lockNodes(nodes(), ['r']), ['r', 'c'], 5)).toEqual({ ok: false, operation: 'offset', reason: 'locked' });
		expect(offsetShapeNodes(nodes(), ['text'], 5)).toMatchObject({ ok: false, reason: 'no-shapes' });
		expect(offsetShapeNodes(nodes(), ['r'], -30)).toMatchObject({ ok: false, reason: 'empty' });
		expect(offsetShapeNodes(nodes(), ['r'], NaN)).toMatchObject({ ok: false, reason: 'invalid' });
		expect(canOffsetShapeNodes(nodes(), ['r'])).toEqual({ ok: true, shapeIds: ['r'] });
		// A shape that vanishes is left alone while the others are offset.
		const mixed = offsetShapeNodes(nodes(), ['r', 'c'], -30);
		expect(mixed.ok && mixed.removeIds).toEqual(['c']);
	});

	it('uses absolute geometry in sub-flows and keeps the parent', () => {
		const group: CanvasNode = { id: 'g', position: { x: 1000, y: 500 }, data: {}, width: 400, height: 400 };
		const list = [group, shapeNode('a', 10, 10, 50, 50, { kind: 'rect' }, { parentId: 'g' })];
		const result = offsetShapeNodes(list, ['a'], 5);
		expect(result.ok && result.nodes[0]).toMatchObject({ parentId: 'g', position: { x: 5, y: 5 }, width: 60, height: 60 });
	});
});

describe('outlineShapeNodeStrokes', () => {
	const nodes = () => [
		shapeNode('r', 0, 0, 100, 50, { kind: 'rect', fill: 'red', stroke: 'black', strokeWidth: 4, opacity: 0.5 }),
		shapeNode('e', 200, 0, 100, 100, { kind: 'ellipse', fill: 'none', stroke: '#0af', strokeWidth: 6 }),
		shapeNode('plain', 400, 0, 10, 10, { kind: 'rect' })
	];

	it('converts strokes to filled shapes and keeps the fill below them', () => {
		let n = 0;
		const result = outlineShapeNodeStrokes(nodes(), ['r', 'e', 'plain'], { createId: () => `s${n++}` });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.removeIds).toEqual(['r', 'e']);
		const [fill, outline] = result.replacements[0].nodes;
		expect(fill.id).toBe('r');
		expect(fill.data.shape).toEqual({ kind: 'rect', fill: 'red', opacity: 0.5 });
		expect(outline).toMatchObject({ id: 's0', position: { x: -2, y: -2 }, width: 104, height: 54 });
		expect(outline.data.shape).toMatchObject({ kind: 'path', fill: 'black', opacity: 0.5 });
		expect(outline.data.shape.stroke).toBeUndefined();
		expect(outline.data.shape.strokeWidth).toBeUndefined();
		expect(bezierPathArea(outlineOf(outline))).toBeCloseTo(104 * 54 - 96 * 46, 6);
		// The unfilled ellipse is replaced by its outline alone, which stays curved.
		const ellipse = result.replacements[1].nodes;
		expect(ellipse).toHaveLength(1);
		expect(ellipse[0].data.shape.fill).toBe('#0af');
		expect(countPathSegments(ellipse[0].data.shape.d).lines).toBe(0);
	});

	it('honours width, cap, join and dash options', () => {
		const line = shapeNode('l', 0, 0, 100, 10, { kind: 'path', d: 'M0 5L100 5', fill: 'none', stroke: 'black', strokeWidth: 2 });
		const dashed = outlineShapeNodeStrokes([line], ['l'], { dash: [10, 10], width: 4 });
		expect(dashed.ok && bezierPathArea(outlineOf(dashed.nodes[0]))).toBeCloseTo(200, 6);
		const capped = outlineShapeNodeStrokes([line], ['l'], { cap: 'square' });
		expect(capped.ok && capped.nodes[0].width).toBeCloseTo(102, 6);
		const noFill = outlineShapeNodeStrokes(nodes(), ['r'], { keepFill: false });
		expect(noFill.ok && noFill.replacements[0].nodes).toHaveLength(1);
	});

	it('refuses shapes without a visible stroke and locked shapes', () => {
		expect(outlineShapeNodeStrokes(nodes(), ['plain'])).toEqual({ ok: false, operation: 'outlineStroke', reason: 'no-stroke' });
		expect(outlineShapeNodeStrokes(lockNodes(nodes(), ['r']), ['r'])).toMatchObject({ ok: false, reason: 'locked' });
		expect(outlineShapeNodeStrokes(nodes(), [])).toMatchObject({ ok: false, reason: 'no-shapes' });
		expect(outlineShapeNodeStrokes(nodes(), ['r'], { width: -1 })).toMatchObject({ ok: false, reason: 'invalid' });
		expect(canOutlineShapeNodeStrokes(nodes(), ['r', 'plain'])).toEqual({ ok: true, shapeIds: ['r'] });
		expect(hasVisibleStroke({ kind: 'rect', stroke: 'none' })).toBe(false);
		expect(hasVisibleStroke({ kind: 'rect', stroke: 'red', strokeWidth: 0 })).toBe(false);
		expect(hasVisibleStroke({ kind: 'rect', stroke: 'red' })).toBe(true);
	});
});

describe('arrange controller: offset path and outline stroke', () => {
	function setup(history?: HistoryManager) {
		let nodes: CanvasNode[] = [
			shapeNode('a', 0, 0, 100, 100, { kind: 'rect', stroke: 'black', strokeWidth: 2 }, { selected: true }),
			shapeNode('b', 150, 0, 100, 100, { kind: 'ellipse' }, { selected: true }),
			{ id: 'other', position: { x: 500, y: 0 }, data: {}, width: 10, height: 10 }
		];
		const controller = createCanvasArrangeController({ getNodes: () => nodes, setNodes: (next) => (nodes = next), history });
		return {
			controller,
			get nodes() {
				return nodes;
			}
		};
	}

	it('offsets the selection as one undoable step', () => {
		const history = new HistoryManager();
		const ctx = setup(history);
		expect(ctx.controller.canOffsetShapes()).toBe(true);
		let n = 0;
		const result = ctx.controller.offsetShapes(10, undefined, { createId: () => `o${n++}` });
		expect(result.ok).toBe(true);
		expect(ctx.nodes.map((x) => x.id)).toEqual(['o0', 'o1', 'other']);
		expect(history.getState().undoName).toBe('Offset Path');
		history.undo();
		expect(ctx.nodes.map((x) => x.id)).toEqual(['a', 'b', 'other']);
		history.redo();
		expect(ctx.nodes.map((x) => x.id)).toEqual(['o0', 'o1', 'other']);
	});

	it('outlines strokes as one undoable step and refuses without changes', () => {
		const history = new HistoryManager();
		const ctx = setup(history);
		expect(ctx.controller.canOutlineStroke()).toBe(true);
		const result = ctx.controller.outlineStroke(undefined, { createId: () => 's' });
		expect(result.ok).toBe(true);
		expect(ctx.nodes.map((x) => x.id)).toEqual(['a', 's', 'b', 'other']);
		expect(ctx.nodes[0].data.shape.stroke).toBeUndefined();
		history.undo();
		expect(ctx.nodes[0].data.shape.stroke).toBe('black');
		expect(ctx.nodes.map((x) => x.id)).toEqual(['a', 'b', 'other']);
		const before = ctx.nodes;
		expect(ctx.controller.outlineStroke(['b'])).toMatchObject({ ok: false, reason: 'no-stroke' });
		expect(ctx.controller.canOutlineStroke(['b'])).toBe(false);
		ctx.controller.lock(['a']);
		const locked = ctx.nodes;
		expect(ctx.controller.offsetShapes(5)).toMatchObject({ ok: false, reason: 'locked' });
		expect(ctx.nodes).toBe(locked);
		expect(before).not.toBe(locked);
	});

	it('exposes the shape operations as palette / context-menu commands', () => {
		const history = new HistoryManager();
		const ctx = setup(history);
		const registry = new CommandRegistry();
		registry.register(createShapeCommands(ctx.controller));
		const ids = registry.list().map((e) => e.id);
		expect(ids).toEqual(
			expect.arrayContaining(['canvas.unite', 'canvas.intersect', 'canvas.subtract', 'canvas.exclude', 'canvas.divide', 'canvas.offsetPath', 'canvas.outlineStroke'])
		);
		expect(registry.execute('canvas.outlineStroke', { ids: ['b'] })).toMatchObject({
			ok: false,
			code: 'disabled',
			message: 'Select an unlocked shape with a stroke.'
		});
		expect(registry.execute('canvas.offsetPath', { distance: 5, join: 'round', ids: ['b'] })).toMatchObject({ ok: true });
		expect(ctx.nodes.find((x) => x.id !== 'a' && x.id !== 'other')!.width).toBeCloseTo(110, 1);
		expect(registry.execute('canvas.unite', { ids: ['a'] })).toMatchObject({ ok: false, code: 'disabled' });
		const union = registry.execute('canvas.unite', { ids: ctx.nodes.map((x) => x.id) });
		expect(union).toMatchObject({ ok: true });
		expect(ctx.nodes).toHaveLength(2);
		expect(createShapeCommands(ctx.controller, { scope: null, prefix: 's/' })[0]).toMatchObject({ id: 's/unite' });
		expect(toBezierPath(ctx.nodes[0].data.shape.d).length).toBeGreaterThan(0);
	});
});
