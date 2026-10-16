// Live path effects, the repeater, live booleans and Expand Appearance. Behaviour after ArtCraft
// effectcraft `crates/path/src/ops.rs` / `crates/render/src/shapes.rs` and figcraft
// `crates/render/src/boolean.rs` (MIT OR Apache-2.0, © ArtCraft Team and contributors), test cases
// re-expressed. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import {
	VectorEditorController,
	applyMatrix,
	applyVectorEffects,
	clearVectorLiveBooleanCache,
	createVectorCommands,
	createVectorEffect,
	effectPathLength,
	effectPathVertexCount,
	expandVectorAppearance,
	findVectorNode,
	getVectorSceneRenderData,
	hitTestVectorNode,
	hitTestVectorNodes,
	mergePaths,
	offsetPaths,
	parseVectorSvg,
	puckerBloatPaths,
	rectSubpath,
	roundCornerPaths,
	subpathsToBezier,
	trimPaths,
	trimPathsIndividually,
	twistPaths,
	vectorAppearanceShapes,
	vectorDocumentToSvg,
	vectorLiveBooleanSteps,
	vectorNodeBounds,
	vectorRepeaterCopies,
	wigglePaths,
	zigzagPaths,
	VECTOR_EFFECT_DEFAULTS,
	type VectorDocument,
	type VectorEffect,
	type VectorGroupNode,
	type VectorNode,
	type VectorPathNode
} from '../src/vector/index.js';
import { bezierPathBounds, pathToContours, type BezierPath } from '../src/canvas/pathops/bezier.js';
import { bezierPathArea } from '../src/canvas/pathops/boolean.js';
import { CommandRegistry } from '../src/commands/index.js';

const square = (x: number, y: number, s: number): BezierPath => subpathsToBezier([rectSubpath({ x, y, width: s, height: s })]);
const line = (x0: number, y0: number, x1: number, y1: number): BezierPath => [
	{ type: 'M', x: x0, y: y0 },
	{ type: 'L', x: x1, y: y1 }
];
const rectNode = (id: string, x: number, y: number, w: number, h = w, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [rectSubpath({ x, y, width: w, height: h })],
	fill: '#336699',
	...extra
});
const fx = <T extends VectorEffect['type']>(type: T, params: Record<string, unknown> = {}, id = `${type}-1`) => createVectorEffect(type, id, params)!;
const points = (p: BezierPath) => p.filter((c) => c.type !== 'Z').map((c) => ({ x: (c as { x: number }).x, y: (c as { y: number }).y }));
const moves = (p: BezierPath) => p.filter((c) => c.type === 'M').length;
const shapesOf = (node: VectorNode) => vectorAppearanceShapes(node);

describe('path effect operators', () => {
	it('trims simultaneously by the same fraction of each path', () => {
		const [a, b] = trimPaths([square(0, 0, 100), square(0, 0, 50)], 0, 50);
		expect(effectPathLength(a)).toBeCloseTo(200, 6);
		expect(effectPathLength(b)).toBeCloseTo(100, 6);
		// Start above end swaps; the offset turns the kept part round the path.
		expect(effectPathLength(trimPaths([square(0, 0, 100)], 75, 25)[0])).toBeCloseTo(200, 6);
		expect(effectPathLength(trimPaths([square(0, 0, 100)], 0, 25, 90)[0])).toBeCloseTo(100, 6);
		// Nothing kept: the slot stays, empty; everything kept: the path unchanged.
		expect(trimPaths([square(0, 0, 100)], 30, 30)[0]).toEqual([]);
		const whole = square(0, 0, 100);
		expect(trimPaths([whole], 0, 100, 45)[0]).toBe(whole);
	});

	it('keeps a trim that crosses the start of a closed path in one piece', () => {
		const t = trimPaths([square(0, 0, 100)], 0, 50, 270)[0];
		expect(effectPathLength(t)).toBeCloseTo(200, 6);
		expect(moves(t)).toBe(1);
		expect(points(t)[0]).toEqual({ x: 0, y: 100 }); // 300 along: the start is crossed halfway
	});

	it('trims individually as one length laid end to end', () => {
		const paths = [square(0, 0, 100), square(0, 0, 50)]; // 400 + 200
		let t = trimPathsIndividually(paths, 0, 50);
		expect(effectPathLength(t[0])).toBeCloseTo(300, 6);
		expect(t[1]).toEqual([]);
		t = trimPathsIndividually(paths, 50, 100);
		expect(effectPathLength(t[0])).toBeCloseTo(100, 6);
		expect(effectPathLength(t[1])).toBeCloseTo(200, 6);
		t = trimPathsIndividually(paths, 10, 90);
		expect(effectPathLength(t[0]) + effectPathLength(t[1])).toBeCloseTo(0.8 * 600, 6);
	});

	it('rounds corners with a true radius, keeping smooth points and open ends', () => {
		const r = roundCornerPaths([square(0, 0, 100)], 10)[0];
		expect(effectPathVertexCount(r)).toBe(8);
		expect(bezierPathArea(r)).toBeCloseTo(100 * 100 - (4 - Math.PI) * 100, 0);
		expect(bezierPathBounds(r)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
		// Too large for the sides: shrinks to fit (a circle).
		expect(bezierPathArea(roundCornerPaths([square(0, 0, 20)], 50)[0])).toBeCloseTo(Math.PI * 100, 0);
		const open: BezierPath = [...line(0, 0, 100, 0), { type: 'L', x: 100, y: 100 }];
		const ro = roundCornerPaths([open], 20)[0];
		expect(effectPathVertexCount(ro)).toBe(4);
		expect(points(ro)[0]).toEqual({ x: 0, y: 0 });
		expect(points(ro).at(-1)).toEqual({ x: 100, y: 100 });
	});

	it('bloats towards the centre with bulging segments, and puckers outwards', () => {
		const s = square(-50, -50, 100);
		const b = puckerBloatPaths([s], 50)[0];
		for (const p of points(b)) expect([Math.abs(p.x), Math.abs(p.y)]).toEqual([25, 25]);
		const bb = bezierPathBounds(b)!;
		expect(bb.maxX - bb.minX).toBeGreaterThan(51);
		const p = puckerBloatPaths([s], -50)[0];
		const ends = p.filter((c) => c.type === 'M' || c.type === 'C') as { x: number; y: number }[];
		for (const q of ends) expect([Math.abs(q.x), Math.abs(q.y)]).toEqual([75, 75]);
		expect(puckerBloatPaths([s], 0)[0]).toBe(s);
	});

	it('twists by an angle growing with the distance from the centre', () => {
		const t = twistPaths([line(0, 0, 100, 0)], 90, { x: 0, y: 0 })[0];
		const pts = points(t);
		expect(pts[0].x).toBeCloseTo(0, 9);
		expect(pts.at(-1)!.x).toBeCloseTo(0, 9);
		expect(pts.at(-1)!.y).toBeCloseTo(100, 9);
		expect(pts.length).toBeGreaterThan(4);
		for (const q of pts) {
			const r = Math.hypot(q.x, q.y);
			if (r > 1e-6) expect(Math.atan2(q.y, q.x)).toBeCloseTo((Math.PI / 2) * (r / 100), 6);
		}
	});

	it('zig zags with ridges + 1 points per segment', () => {
		const z = zigzagPaths([square(0, 0, 100)], 5, 5)[0];
		expect(effectPathVertexCount(z)).toBe(4 * 6);
		const open = zigzagPaths([line(0, 0, 100, 0)], 4, 3)[0];
		expect(effectPathVertexCount(open)).toBe(5);
		points(open).forEach((p, i) => {
			expect(p.x).toBeCloseTo(25 * i, 9);
			expect(Math.abs(p.y)).toBeCloseTo(4, 9);
			if (i > 0) expect(Math.sign(p.y)).toBe(-Math.sign(points(open)[i - 1].y));
		});
		expect(open.filter((c) => c.type === 'C')).toHaveLength(0);
		expect(zigzagPaths([line(0, 0, 100, 0)], 4, 3, true)[0].filter((c) => c.type === 'C')).toHaveLength(4);
	});

	it('wiggles deterministically for a seed and time', () => {
		const w = { ...VECTOR_EFFECT_DEFAULTS.wiggle, size: 8, detail: 4, seed: 7, time: 0.3 };
		const a = wigglePaths([square(0, 0, 100)], w)[0];
		expect(wigglePaths([square(0, 0, 100)], { ...w })[0]).toEqual(a);
		expect(wigglePaths([square(0, 0, 100)], { ...w, seed: 8 })[0]).not.toEqual(a);
		expect(wigglePaths([square(0, 0, 100)], { ...w, time: 0.31 })[0]).not.toEqual(a);
		expect(effectPathVertexCount(a)).toBe(4 * 5);
		// Every point stays within `size` of where resampling put it (on the square's outline).
		for (const p of points(a)) {
			const d = Math.min(Math.abs(p.x), Math.abs(p.x - 100), Math.abs(p.y), Math.abs(p.y - 100));
			expect(d).toBeLessThanOrEqual(8 * Math.SQRT2 + 1e-9);
		}
		const flat = square(0, 0, 100);
		expect(wigglePaths([flat], { ...w, size: 0 })[0]).toBe(flat);
	});

	it('offsets with joins and copies', () => {
		const o = offsetPaths([square(0, 0, 100)], 10)[0];
		expect(bezierPathArea(o)).toBeCloseTo(120 * 120, 3);
		expect(bezierPathBounds(o)).toMatchObject({ minX: -10, maxX: 110 });
		const round = offsetPaths([square(0, 0, 100)], 10, 'round')[0];
		expect(bezierPathArea(round)).toBeCloseTo(100 * 100 + 400 * 10 + Math.PI * 100, 0);
		expect(bezierPathArea(offsetPaths([square(0, 0, 100)], -10)[0])).toBeCloseTo(80 * 80, 3);
		const copies = offsetPaths([square(0, 0, 100)], 10, 'miter', 4, 3)[0];
		expect(pathToContours(copies)).toHaveLength(3);
		expect(bezierPathBounds(copies)).toMatchObject({ minX: -30, maxX: 130 });
	});

	it('merges paths with each mode', () => {
		const a = square(0, 0, 100);
		const b = square(50, 0, 100);
		expect(mergePaths([a, b], 'merge')).toEqual([...a, ...b]);
		expect(bezierPathArea(mergePaths([a, b], 'add'))).toBeCloseTo(15000, 6);
		expect(bezierPathArea(mergePaths([a, b], 'subtract'))).toBeCloseTo(5000, 6);
		expect(bezierPathArea(mergePaths([a, b], 'intersect'))).toBeCloseTo(5000, 6);
		expect(bezierPathArea(mergePaths([a, b], 'exclude'))).toBeCloseTo(10000, 6);
	});
});

describe('repeater', () => {
	const r = (patch: Record<string, unknown> = {}) => ({ ...VECTOR_EFFECT_DEFAULTS.repeater, ...patch });

	it('transforms copy i by translate(position·k) · rotate(rotation·k) · scale^k about the anchor', () => {
		const pivot = { x: 10, y: 20 };
		const copies = vectorRepeaterCopies(r({ copies: 3, position: { x: 30, y: 0 }, rotation: 90, scale: { x: 50, y: 50 } }), pivot);
		expect(copies.map((c) => c.index)).toEqual([0, 1, 2]);
		const close = (p: { x: number; y: number }, x: number, y: number) => {
			expect(p.x).toBeCloseTo(x, 9);
			expect(p.y).toBeCloseTo(y, 9);
		};
		close(applyMatrix(copies[0].matrix, { x: 14, y: 20 }), 14, 20);
		// The pivot only moves by the position; a point 4 right of it turns 90° and halves.
		close(applyMatrix(copies[1].matrix, pivot), 40, 20);
		close(applyMatrix(copies[1].matrix, { x: 14, y: 20 }), 40, 22);
		close(applyMatrix(copies[2].matrix, { x: 14, y: 20 }), 69, 20);
		// The offset shifts every copy along.
		close(applyMatrix(vectorRepeaterCopies(r({ copies: 1, offset: 1, position: { x: 30, y: 0 } }), pivot)[0].matrix, pivot), 40, 20);
	});

	it('ramps opacity from start to end and fades a fractional last copy', () => {
		expect(vectorRepeaterCopies(r({ copies: 3, startOpacity: 100, endOpacity: 0 }), { x: 0, y: 0 }).map((c) => c.opacity)).toEqual([1, 0.5, 0]);
		vectorRepeaterCopies(r({ copies: 5, startOpacity: 20, endOpacity: 100 }), { x: 0, y: 0 }).forEach((c, i) => expect(c.opacity).toBeCloseTo(0.2 * (i + 1), 12));
		const frac = vectorRepeaterCopies(r({ copies: 2.25 }), { x: 0, y: 0 });
		expect(frac).toHaveLength(3);
		expect(frac.map((c) => c.opacity)).toEqual([1, 1, 0.25]);
		expect(vectorRepeaterCopies(r({ copies: 0 }), { x: 0, y: 0 })).toEqual([]);
	});

	it('draws copies below or above the ones before them', () => {
		const node = rectNode('a', 0, 0, 10, 10, { effects: [fx('repeater', { copies: 3, position: { x: 20, y: 0 } })] });
		const xs = (n: VectorNode) => shapesOf(n).map((s) => bezierPathBounds(s.path)!.minX);
		expect(xs(node)).toEqual([40, 20, 0]); // the original on top
		const above = { ...node, effects: [fx('repeater', { copies: 3, position: { x: 20, y: 0 }, composite: 'above' })] };
		expect(xs(above)).toEqual([0, 20, 40]);
	});
});

describe('effect stacks', () => {
	const lengths = (n: VectorNode) => shapesOf(n).map((s) => Math.round(effectPathLength(s.path) * 1e6) / 1e6);

	it('applies effects after a repeater to its copies', () => {
		// Below the repeater: the trim runs over the copies end to end.
		const after = rectNode('a', 0, 0, 100, 100, { effects: [fx('repeater', { copies: 3, position: { x: 150, y: 0 } }), fx('trim', { start: 0, end: 50, mode: 'individual' })] });
		expect(lengths(after)).toEqual([0, 200, 400]);
		// Above it: each copy is a copy of the trimmed path.
		const before = { ...after, effects: [after.effects![1], after.effects![0]] };
		expect(lengths(before)).toEqual([200, 200, 200]);
		// Merge after the repeater makes one shape of the copies.
		const merged = rectNode('a', 0, 0, 100, 100, { effects: [fx('repeater', { copies: 2, position: { x: 50, y: 0 } }), fx('merge', { mode: 'add' })] });
		expect(shapesOf(merged)).toHaveLength(1);
		expect(bezierPathArea(shapesOf(merged)[0].path)).toBeCloseTo(15000, 6);
	});

	it('acts on every path of a group, nested groups included', () => {
		const group: VectorGroupNode = {
			id: 'g',
			type: 'group',
			children: [rectNode('a', 0, 0, 100), { id: 'h', type: 'group', transform: [1, 0, 0, 1, 200, 0], children: [rectNode('b', 0, 0, 50)] }],
			effects: [fx('trim', { start: 0, end: 50, mode: 'individual' })]
		};
		expect(lengths(group)).toEqual([300, 0]);
		expect(shapesOf(group).map((s) => s.source.id)).toEqual(['a', 'b']);
		// The child's transform is applied before the group's effects.
		const moved = { ...group, effects: [] };
		expect(bezierPathBounds(shapesOf(moved)[1].path)).toMatchObject({ minX: 200, maxX: 250 });
	});

	it('skips disabled effects and keeps the anchors as stored', () => {
		const node = rectNode('a', 0, 0, 100, 100, { effects: [{ ...fx('offset', { amount: 10 }), enabled: false }] });
		expect(vectorNodeBounds(node)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
		const on = { ...node, effects: [fx('offset', { amount: 10 })] };
		expect(vectorNodeBounds(on)).toEqual({ x: -10, y: -10, width: 120, height: 120 });
		expect(on.subpaths[0].anchors).toHaveLength(4);
	});

	it('caches per node object and recomputes only replaced nodes', () => {
		const a = rectNode('a', 0, 0, 100, 100, { effects: [fx('zigzag')] });
		const b = rectNode('b', 200, 0, 100, 100, { effects: [fx('zigzag')] });
		const group: VectorGroupNode = { id: 'g', type: 'group', children: [a, b] };
		expect(vectorAppearanceShapes(a)).toBe(vectorAppearanceShapes(a));
		const first = vectorAppearanceShapes(group);
		expect(vectorAppearanceShapes(group)).toBe(first);
		expect(expandVectorAppearance(group)).toBe(expandVectorAppearance(group));
		const aShapes = vectorAppearanceShapes(a);
		const b2 = { ...b, effects: [fx('zigzag', { size: 9 })] };
		const group2 = { ...group, children: [a, b2] };
		expect(vectorAppearanceShapes(group2)).not.toBe(first);
		expect(vectorAppearanceShapes(a)).toBe(aShapes);
		// A node without anything live expands to itself.
		const plain = rectNode('p', 0, 0, 10);
		expect(expandVectorAppearance(plain)).toBe(plain);
	});

	it('is what hit-testing, bounds and rendering see', () => {
		const node = rectNode('a', 0, 0, 10, 10, { effects: [fx('repeater', { copies: 3, position: { x: 20, y: 0 } })] });
		expect(hitTestVectorNode(node, { x: 45, y: 5 })).toBe(true);
		expect(hitTestVectorNode(node, { x: 15, y: 5 })).toBe(false);
		expect(vectorNodeBounds(node)).toEqual({ x: 0, y: 0, width: 50, height: 10 });
		const scene = getVectorSceneRenderData({ document: { width: 100, height: 100, nodes: [node] }, viewport: { x: 0, y: 0, zoom: 1 } });
		const g = scene.nodes[0];
		expect(g.kind).toBe('group');
		expect(g.kind === 'group' && g.children.map((c) => c.id)).toEqual(['a~fx0', 'a~fx1', 'a~fx2']);
		const fade = { ...node, effects: [fx('repeater', { copies: 2, startOpacity: 100, endOpacity: 40, composite: 'above' })] };
		const faded = getVectorSceneRenderData({ document: { width: 100, height: 100, nodes: [fade] }, viewport: { x: 0, y: 0, zoom: 1 } }).nodes[0];
		expect(faded.kind === 'group' && faded.children.map((c) => c.opacity)).toEqual([1, 0.4]);
	});

	it('runs the stack through applyVectorEffects', () => {
		const base = [{ source: rectNode('a', 0, 0, 100), path: square(0, 0, 100), opacity: 1, order: [] }];
		expect(applyVectorEffects(base, [])).toEqual(base);
		expect(applyVectorEffects(base, [fx('roundCorners', { radius: 10 })])[0].path).toEqual(roundCornerPaths([square(0, 0, 100)], 10)[0]);
	});
});

describe('live booleans', () => {
	const group = (children: VectorNode[], op: VectorGroupNode['liveBoolean'] = 'union'): VectorGroupNode => ({ id: 'g', type: 'group', liveBoolean: op, children });

	it('folds operands bottom to top, each by its own operation', () => {
		const g = group([rectNode('a', 0, 0, 100), rectNode('b', 50, 0, 100), rectNode('c', 0, 0, 30, 30, { booleanOperation: 'subtract' })]);
		const shapes = shapesOf(g);
		expect(shapes).toHaveLength(1);
		expect(shapes[0].source.id).toBe('a');
		expect(bezierPathArea(shapes[0].path)).toBeCloseTo(15000 - 900, 6);
		expect(bezierPathArea(shapesOf({ ...g, liveBoolean: 'intersect', children: g.children.slice(0, 2) })[0].path)).toBeCloseTo(5000, 6);
	});

	it('caches every prefix of the fold', () => {
		clearVectorLiveBooleanCache();
		const ops = [rectNode('a', 0, 0, 100), rectNode('b', 50, 0, 100), rectNode('c', 20, 20, 30), rectNode('d', 120, 40, 60)];
		const steps = () => vectorLiveBooleanSteps();
		let s0 = steps();
		shapesOf(group(ops));
		expect(steps() - s0).toBe(3);
		// Editing the top operand recombines only it.
		s0 = steps();
		shapesOf(group([...ops.slice(0, 3), rectNode('d', 130, 40, 60)]));
		expect(steps() - s0).toBe(1);
		// Editing the second recombines it and everything above it.
		s0 = steps();
		shapesOf(group([ops[0], rectNode('b', 40, 0, 100), ops[2], ops[3]]));
		expect(steps() - s0).toBe(3);
		// Back to an earlier state: all cached.
		s0 = steps();
		shapesOf(group(ops.map((o) => ({ ...o }))));
		expect(steps() - s0).toBe(0);
	});

	it('hits the result, or the operands while the group is entered', () => {
		const g = group([rectNode('a', 0, 0, 100), rectNode('hole', 25, 25, 50)], 'subtract');
		const p = { x: 50, y: 50 };
		expect(hitTestVectorNodes([g], p)).toBeNull();
		expect(hitTestVectorNodes([g], { x: 10, y: 10 })?.id).toBe('g');
		expect(hitTestVectorNodes([g], p, 0, { entered: new Set(['g']) })?.id).toBe('g');
		// Inside a plain group too.
		const outer: VectorGroupNode = { id: 'outer', type: 'group', children: [g] };
		expect(hitTestVectorNodes([outer], p)).toBeNull();
		expect(hitTestVectorNodes([outer], p, 0, { entered: new Set(['g']) })?.id).toBe('outer');
		const c = new VectorEditorController({ document: { width: 200, height: 200, nodes: [g] } });
		c.setTool('direct');
		c.pointerDown({ x: 50, y: 50 });
		c.pointerUp({ x: 50, y: 50 });
		expect(c.getState().editingId).toBeNull();
		c.pointerDown({ x: 10, y: 10 });
		c.pointerUp({ x: 10, y: 10 });
		expect(c.getState().editingId).toBe('a');
		// Entered (an operand being edited): the hole's operand can be picked.
		c.pointerDown({ x: 50, y: 50 });
		c.pointerUp({ x: 50, y: 50 });
		expect(c.getState().editingId).toBe('hole');
	});
});

describe('controller', () => {
	const doc = (): VectorDocument => ({
		width: 400,
		height: 300,
		nodes: [rectNode('a', 10, 10, 100), rectNode('b', 60, 10, 100, 100, { fill: '#ff0000' }), rectNode('c', 300, 200, 40)]
	});
	let n = 0;
	const make = () => new VectorEditorController({ document: doc(), createId: () => `id${++n}` });

	it('adds, edits, reorders and removes effects as undo steps', () => {
		const c = make();
		const [id] = c.addEffect('offset', { ids: ['c'], params: { amount: 5 } });
		expect(c.getNode('c')!.effects).toEqual([{ id, type: 'offset', params: { ...VECTOR_EFFECT_DEFAULTS.offset, amount: 5 } }]);
		expect(c.getState().undoLabel).toBe('Add Offset Paths');
		expect(c.getState().selectionBounds).toBeNull();
		c.select(['c']);
		expect(c.getState().selectionBounds).toEqual({ x: 295, y: 195, width: 50, height: 50 });
		expect(c.updateEffect('c', id, { params: { amount: 8, bogus: 1, join: 'nope' } }).ok).toBe(true);
		expect(c.getNode('c')!.effects![0].params).toEqual({ ...VECTOR_EFFECT_DEFAULTS.offset, amount: 8 });
		c.updateEffect('c', id, { enabled: false });
		expect(c.getNode('c')!.effects![0].enabled).toBe(false);
		const [twist] = c.addEffect('twist', { ids: ['c'], index: 0 });
		expect(c.getNode('c')!.effects!.map((e) => e.id)).toEqual([twist, id]);
		c.moveEffect('c', twist, 1);
		expect(c.getNode('c')!.effects!.map((e) => e.id)).toEqual([id, twist]);
		c.removeEffect('c', id);
		c.removeEffect('c', twist);
		expect(c.getNode('c')!.effects).toBeUndefined();
		expect(c.updateEffect('c', 'nope', { enabled: true }).ok).toBe(false);
		for (let i = 0; i < 7; i++) c.undo();
		expect(c.getNode('c')!.effects).toBeUndefined();
	});

	it('merges slider drags into one undo step', () => {
		const c = make();
		const [id] = c.addEffect('roundCorners', { ids: ['a'] });
		for (const radius of [12, 14, 16, 18]) c.updateEffect('a', id, { params: { radius } }, { merge: true });
		expect(c.getNode('a')!.effects![0].params).toEqual({ radius: 18 });
		c.endMergedEdit();
		c.updateEffect('a', id, { params: { radius: 30 } }, { merge: true });
		c.undo();
		expect(c.getNode('a')!.effects![0].params).toEqual({ radius: 18 });
		c.undo();
		expect(c.getNode('a')!.effects![0].params).toEqual({ radius: 10 });
		c.redo();
		expect(c.getNode('a')!.effects![0].params).toEqual({ radius: 18 });
	});

	it('starts repeater copies a shape width apart', () => {
		const c = make();
		c.addEffect('repeater', { ids: ['c'] });
		expect((c.getNode('c')!.effects![0].params as { position: unknown }).position).toEqual({ x: 50, y: 0 });
	});

	it('expands the appearance into plain paths', () => {
		const c = make();
		c.addEffect('repeater', { ids: ['a'], params: { copies: 3 } });
		c.addEffect('offset', { ids: ['b'], params: { amount: 5 } });
		expect(c.expandAppearance({ ids: ['c'] })).toEqual([]);
		expect(c.expandAppearance({ ids: ['a', 'b'] })).toEqual(['a', 'b']);
		expect(c.getState().undoLabel).toBe('Expand Appearance');
		const a = c.getNode('a') as VectorGroupNode;
		expect(a.type).toBe('group');
		expect(a.children).toHaveLength(3);
		for (const child of a.children) {
			expect(child.id).not.toContain('~');
			expect(child.effects).toBeUndefined();
			expect((child as VectorPathNode).fill).toBe('#336699');
		}
		const b = c.getNode('b') as VectorPathNode;
		expect(b.type).toBe('path');
		expect(b.effects).toBeUndefined();
		expect(vectorNodeBounds(b)).toEqual({ x: 55, y: 5, width: 110, height: 110 });
		c.undo();
		expect(c.getNode('a')!.type).toBe('path');
		expect(c.getNode('a')!.effects).toHaveLength(1);
	});

	it('makes and edits live booleans, keeping the destructive one', () => {
		const c = make();
		const gid = c.booleanOp('subtract', { ids: ['a', 'b'], live: true })!;
		const g = c.getNode(gid) as VectorGroupNode;
		expect(g).toMatchObject({ type: 'group', liveBoolean: 'subtract', name: 'Subtract' });
		expect(g.children.map((k) => k.id)).toEqual(['a', 'b']);
		expect(vectorNodeBounds(g)).toEqual({ x: 10, y: 10, width: 50, height: 100 });
		// Operands get their own operation; the lone group sets everyone's again.
		expect(c.booleanOp('union', { ids: ['b'], live: true })).toBe(gid);
		expect(c.getNode('b')!.booleanOperation).toBe('union');
		expect(vectorNodeBounds(c.getNode(gid)!)).toEqual({ x: 10, y: 10, width: 150, height: 100 });
		c.booleanOp('intersect', { ids: [gid], live: true });
		expect(c.getNode('b')!.booleanOperation).toBeUndefined();
		expect((c.getNode(gid) as VectorGroupNode).liveBoolean).toBe('intersect');
		// Editing an operand redraws the result.
		c.translate(-40, 0, { ids: ['b'] });
		expect(vectorNodeBounds(c.getNode(gid)!)).toEqual({ x: 20, y: 10, width: 90, height: 100 });
		// Expand Appearance flattens it into one path in the group's place.
		c.expandAppearance({ ids: [gid] });
		const flat = c.getNode(gid) as VectorPathNode;
		expect(flat.type).toBe('path');
		expect(flat.fill).toBe('#336699');
		expect(c.getNode('a')).toBeUndefined();
		c.undo();
		c.undo();
		// The destructive operation still makes one path.
		const id = c.booleanOp('union', { ids: ['c', gid] })!;
		expect(c.getNode(id)!.type).toBe('path');
	});

	it('ungroups a live boolean back to plain shapes', () => {
		const c = make();
		const gid = c.booleanOp('subtract', { ids: ['a', 'b'], live: true })!;
		c.booleanOp('exclude', { ids: ['b'], live: true });
		c.ungroup({ ids: [gid] });
		expect(c.getNode('b')!.booleanOperation).toBeUndefined();
	});
});

describe('SVG and agent commands', () => {
	it('round-trips effects and live booleans through SVG', () => {
		const doc: VectorDocument = {
			width: 300,
			height: 200,
			nodes: [
				rectNode('z', 0, 0, 40, 40, { transform: [0, 1, -1, 0, 100, 0], effects: [fx('zigzag', { size: 3, ridges: 2 }, 'z1'), { ...fx('twist', { angle: 30 }, 'z2'), enabled: false }] }),
				{
					id: 'g',
					type: 'group',
					liveBoolean: 'subtract',
					opacity: 0.5,
					children: [rectNode('a', 100, 0, 100), rectNode('b', 150, 50, 20, 20, { booleanOperation: 'exclude' })],
					effects: [fx('repeater', { copies: 2, position: { x: 0, y: 110 } }, 'r')]
				}
			]
		};
		const svg = vectorDocumentToSvg(doc);
		expect(svg).toContain('data-vector-live=');
		expect(svg).toContain('data-vector-part="appearance"');
		const back = parseVectorSvg(svg);
		const z = findVectorNode(back.nodes, 'z') as VectorPathNode;
		expect(z.effects).toEqual(doc.nodes[0].effects);
		z.transform!.forEach((v, i) => expect(v).toBeCloseTo([0, 1, -1, 0, 100, 0][i], 9));
		expect(z.subpaths[0].anchors).toHaveLength(4);
		const g = findVectorNode(back.nodes, 'g') as VectorGroupNode;
		expect(g).toMatchObject({ type: 'group', liveBoolean: 'subtract', opacity: 0.5 });
		expect(g.effects).toEqual(doc.nodes[1].effects);
		expect(g.children.map((k) => [k.id, k.booleanOperation])).toEqual([
			['a', undefined],
			['b', 'exclude']
		]);
		expect(vectorNodeBounds(g)).toEqual(vectorNodeBounds(doc.nodes[1]));
	});

	it('runs the effect commands', () => {
		const c = new VectorEditorController({ document: { width: 300, height: 200, nodes: [rectNode('a', 0, 0, 50), rectNode('b', 25, 0, 50)] } });
		const registry = new CommandRegistry();
		for (const spec of createVectorCommands(c)) registry.register(spec);
		const run = (cmd: string, params?: unknown) => registry.execute(cmd, params) as { ok: boolean; result?: any; message?: string };
		const added = run('vector.addEffect', { type: 'trim', ids: ['a'], params: { end: 25 } });
		expect(added.ok).toBe(true);
		const effectId = added.result.effects[0].effectId;
		expect(run('vector.addEffect', { type: 'sparkle', ids: ['a'] }).ok).toBe(false);
		const updated = run('vector.updateEffect', { nodeId: 'a', effectId, params: { end: 75 }, enabled: true });
		expect(updated.result.effects[0].params.end).toBe(75);
		expect(run('vector.list').result.nodes[0].effects).toHaveLength(1);
		expect(run('vector.removeEffect', { nodeId: 'a', effectId }).ok).toBe(true);
		expect(run('vector.removeEffect', { nodeId: 'a', effectId }).ok).toBe(false);
		expect(run('vector.expandAppearance', { ids: ['a'] }).ok).toBe(false);
		const live = run('vector.boolean', { operation: 'union', ids: ['a', 'b'], live: true });
		expect(live.ok).toBe(true);
		expect(run('vector.list').result.nodes[0]).toMatchObject({ type: 'group', liveBoolean: 'union' });
		expect(run('vector.expandAppearance', { ids: [live.result.id] }).ok).toBe(true);
		expect(c.getNode(live.result.id)!.type).toBe('path');
	});
});
