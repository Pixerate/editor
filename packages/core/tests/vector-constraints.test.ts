import { describe, expect, it } from 'vitest';
import { nullSpace, rankQr, solveLm } from '../src/vector/constraints/lm';
import { evalVectorExpression, isValidVectorParameterName, VectorExprEnv } from '../src/vector/constraints/expr';
import {
	addVectorConstraint,
	measureVectorConstraint,
	purgeVectorConstraints,
	solveVectorConstraints,
	vectorConstraintDof,
	vectorConstraintResiduals,
	VectorConstraintError
} from '../src/vector/constraints/solve';
import { ellipseSubpath, type VectorDocument, type VectorPathNode } from '../src/vector';

/** Re-expressed from cadcraft's solver tests: a minimum-norm step, weights, rank and null space. */
describe('constraint maths', () => {
	it('takes the minimum-norm step and keeps heavy parameters still', () => {
		const f = (x: readonly number[], out: number[]) => out.push(x[0] + x[1] - 2);
		const o = solveLm(f, [0, 0], [0, 1], [1, 1], 1e-12, 50);
		expect(o.converged).toBe(true);
		expect(o.x[0]).toBeCloseTo(1, 8);
		expect(o.x[1]).toBeCloseTo(1, 8);
		const heavy = solveLm(f, [0, 0], [0, 1], [1e6, 1], 1e-12, 50);
		expect(Math.abs(heavy.x[0])).toBeLessThan(1e-4);
		expect(heavy.x[1]).toBeCloseTo(2, 4);
		const bad = solveLm((x, out) => out.push(x[0] - 1, x[0] - 2), [0], [0], [1], 1e-10, 100);
		expect(bad.converged).toBe(false);
	});

	it('finds rank and null space on balanced matrices', () => {
		expect(rankQr(Float64Array.from([1, 0, 0, 1, 1, 1]), 3, 2)).toBe(2);
		expect(rankQr(Float64Array.from([1, 2, 2, 4]), 2, 2)).toBe(1);
		expect(rankQr(Float64Array.from([1e-9, 0, 0, 1e6]), 2, 2)).toBe(2);
		const { rank, basis } = nullSpace(Float64Array.from([1, 1, 0]), 1, 3);
		expect(rank).toBe(1);
		expect(basis).toHaveLength(2);
		for (const v of basis) expect(v[0] + v[1]).toBeCloseTo(0, 10);
	});

	it('evaluates expressions with names, refusing cycles', () => {
		expect(evalVectorExpression('(1 + 2) * 3 - 4 / 2')).toBe(7);
		expect(evalVectorExpression('1e2 + .5')).toBe(100.5);
		expect(() => evalVectorExpression('1/0')).toThrow(/division by zero/);
		expect(() => evalVectorExpression('2 +')).toThrow(/syntax/);
		const env = new VectorExprEnv();
		env.set('w', '10');
		env.set('h', 'w / 2');
		env.set('a', 'b + 1');
		env.set('b', 'a + 1');
		expect(env.value('h')).toBe(5);
		expect(() => env.value('a')).toThrow(/refers to itself/);
		expect(isValidVectorParameterName('d1')).toBe(true);
		expect(isValidVectorParameterName('1d')).toBe(false);
		expect(isValidVectorParameterName('pi')).toBe(false);
	});
});

const polyline = (id: string, pts: [number, number][], closed = false): VectorPathNode => ({
	id,
	type: 'path',
	fill: null,
	stroke: '#000',
	subpaths: [{ closed, anchors: pts.map(([x, y], i) => ({ x, y, id: `${id}${i}` })) }]
});

const doc = (...nodes: VectorPathNode[]): VectorDocument => ({ width: 400, height: 300, nodes });
const seg = (nodeId: string, anchor: string) => ({ nodeId, anchor, segment: true });
const point = (nodeId: string, anchor: string) => ({ nodeId, anchor });
const anchors = (d: VectorDocument, id: string) => (d.nodes.find((n) => n.id === id) as VectorPathNode).subpaths[0].anchors;

describe('vector constraints', () => {
	it('makes a segment horizontal and sets a length, moving geometry as little as possible', () => {
		let d = doc(polyline('p', [
			[0, 0],
			[100, 10]
		]));
		d = addVectorConstraint(d, { id: 'h', kind: 'horizontal', refs: [seg('p', 'p0')] });
		let a = anchors(d, 'p');
		expect(a[0].y).toBeCloseTo(a[1].y, 6);
		// Minimum norm: both ends move half way.
		expect(a[0].y).toBeCloseTo(5, 4);
		d = addVectorConstraint(d, { id: 'len', kind: 'distance', refs: [seg('p', 'p0')], value: '50' });
		a = anchors(d, 'p');
		expect(Math.hypot(a[1].x - a[0].x, a[1].y - a[0].y)).toBeCloseTo(50, 6);
		expect(d.constraints!.map((c) => [c.id, c.name, c.value])).toEqual([
			['h', undefined, undefined],
			['len', 'd1', '50']
		]);
	});

	it('names and measures a dimensional constraint without a value', () => {
		const d = addVectorConstraint(doc(polyline('p', [
			[0, 0],
			[30, 40]
		])), { id: 'd', kind: 'distance', refs: [point('p', 'p0'), point('p', 'p1')] });
		expect(d.constraints![0]).toMatchObject({ name: 'd1', value: '50' });
		expect(measureVectorConstraint(d, { kind: 'distance', refs: [seg('p', 'p0')] })).toBeCloseTo(50);
	});

	it('joins points of different paths, keeps segments parallel and perpendicular, and fixes points', () => {
		let d = doc(
			polyline('a', [
				[0, 0],
				[100, 0]
			]),
			polyline('b', [
				[103, 2],
				[110, 60]
			])
		);
		d = addVectorConstraint(d, { id: 'fix', kind: 'fix', refs: [seg('a', 'a0')] });
		d = addVectorConstraint(d, { id: 'join', kind: 'coincident', refs: [point('a', 'a1'), point('b', 'b0')] });
		d = addVectorConstraint(d, { id: 'perp', kind: 'perpendicular', refs: [seg('a', 'a0'), seg('b', 'b0')] });
		const a = anchors(d, 'a');
		const b = anchors(d, 'b');
		expect([a[0].x, a[0].y, a[1].x, a[1].y]).toEqual([0, 0, 100, 0]);
		expect(b[0].x).toBeCloseTo(100, 6);
		expect(b[0].y).toBeCloseTo(0, 6);
		expect(b[1].x).toBeCloseTo(100, 6);
		const dof = vectorConstraintDof(d);
		// b's far end can still slide along the perpendicular: one degree of freedom.
		expect(dof).toMatchObject({ dof: 1, status: 'under', redundant: 0 });
	});

	it('refuses conflicting and redundant constraints, naming the others', () => {
		let d = doc(polyline('p', [
			[0, 0],
			[100, 5]
		]));
		d = addVectorConstraint(d, { id: 'h', kind: 'horizontal', refs: [seg('p', 'p0')] });
		expect(() => addVectorConstraint(d, { id: 'h2', kind: 'horizontal', refs: [seg('p', 'p0')] })).toThrow(/over-constrain.*"h"/);
		// Fixing both ends of a horizontal segment repeats the horizontal.
		expect(() => addVectorConstraint(d, { id: 'fix', kind: 'fix', refs: [seg('p', 'p0')] })).toThrow(/Fix would over-constrain.*"h"/);
		let f = doc(polyline('q', [
			[0, 0],
			[100, 5]
		]));
		f = addVectorConstraint(f, { id: 'fix', kind: 'fix', refs: [seg('q', 'q0')] });
		try {
			addVectorConstraint(f, { id: 'len', kind: 'distance', refs: [seg('q', 'q0')], value: '20' });
			throw new Error('should fail');
		} catch (e) {
			expect(e).toBeInstanceOf(VectorConstraintError);
			expect((e as VectorConstraintError).message).toMatch(/conflicts/);
			expect((e as VectorConstraintError).ids[0]).toBe('len');
		}
		expect(() => addVectorConstraint(d, { id: 'x', kind: 'parallel', refs: [seg('p', 'p0')] })).toThrow(/needs two segments/);
		expect(() => addVectorConstraint(d, { id: 'x', kind: 'horizontal', refs: [point('p', 'nope'), point('p', 'p0')] })).toThrow(/no anchor "nope"/);
	});

	it('constrains circles: radius, concentric and a tangent line', () => {
		const circle: VectorPathNode = { id: 'c', type: 'path', fill: null, stroke: '#000', subpaths: [ellipseSubpath({ x: 0, y: 0, width: 40, height: 40 })] };
		let d = doc(circle, polyline('l', [
			[-50, 35],
			[50, 30]
		]));
		d = addVectorConstraint(d, { id: 'r', kind: 'radius', refs: [{ nodeId: 'c', circle: true }], value: '25' });
		d = addVectorConstraint(d, { id: 'tan', kind: 'tangent', refs: [seg('l', 'l0'), { nodeId: 'c', circle: true }] });
		const res = vectorConstraintResiduals(d);
		expect(res.get('r')).toBeLessThan(1e-6);
		expect(res.get('tan')).toBeLessThan(1e-6);
		const c = (d.nodes[0] as VectorPathNode).subpaths[0].anchors;
		const xs = c.map((a) => a.x);
		expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(50, 4);
	});

	it('solves after an edit, moving the edited anchor least, and purges constraints on deleted anchors', () => {
		let d = doc(polyline('p', [
			[0, 0],
			[100, 0],
			[100, 100]
		]));
		d = addVectorConstraint(d, { id: 'h', kind: 'horizontal', refs: [seg('p', 'p0')] });
		d = addVectorConstraint(d, { id: 'v', kind: 'vertical', refs: [seg('p', 'p1')] });
		const solved = d;
		// Drag the corner anchor up and right.
		const edited: VectorDocument = { ...d, nodes: [{ ...(d.nodes[0] as VectorPathNode), subpaths: [{ closed: false, anchors: anchors(d, 'p').map((a, i) => (i === 1 ? { ...a, x: 120, y: -20 } : a)) }] }] };
		const r = solveVectorConstraints(edited, solved);
		expect(r.converged).toBe(true);
		const a = anchors(r.document, 'p');
		expect(a[1].x).toBeCloseTo(120, 2);
		expect(a[1].y).toBeCloseTo(-20, 2);
		expect(a[0].y).toBeCloseTo(-20, 2);
		expect(a[2].x).toBeCloseTo(120, 2);
		const cut: VectorDocument = { ...r.document, nodes: [{ ...(r.document.nodes[0] as VectorPathNode), subpaths: [{ closed: false, anchors: anchors(r.document, 'p').slice(0, 2) }] }] };
		expect(purgeVectorConstraints(cut).removed).toEqual(['v']);
	});
});

describe('auto-constrain', () => {
	it('infers what a rough rectangle nearly satisfies and adds it without redundancy', async () => {
		const { autoConstrainVector, inferVectorConstraints, withVectorDocumentAnchorIds } = await import('../src/vector/constraints/auto');
		const rough: VectorPathNode = {
			id: 'r',
			type: 'path',
			fill: null,
			stroke: '#000',
			subpaths: [{ closed: true, anchors: [{ x: 0, y: 0.2 }, { x: 100.3, y: 0 }, { x: 100, y: 50.4 }, { x: 0.1, y: 50 }] }]
		};
		const d = withVectorDocumentAnchorIds(doc(rough));
		expect((d.nodes[0] as VectorPathNode).subpaths[0].anchors.map((a) => a.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
		const candidates = inferVectorConstraints(d);
		expect(candidates.filter((c) => c.kind === 'horizontal')).toHaveLength(2);
		expect(candidates.filter((c) => c.kind === 'vertical')).toHaveLength(2);
		let n = 0;
		const r = autoConstrainVector(d, null, () => `c${++n}`);
		// Two horizontals and two verticals fix a rectangle's shape; parallels and equal lengths repeat them.
		expect(r.added.map((c) => c.kind).sort()).toEqual(['equal', 'equal', 'horizontal', 'horizontal', 'vertical', 'vertical'].filter((k) => r.added.some((c) => c.kind === k)).sort());
		expect(r.added.filter((c) => c.kind === 'horizontal')).toHaveLength(2);
		const a = (r.document.nodes[0] as VectorPathNode).subpaths[0].anchors;
		expect(a[0].y).toBeCloseTo(a[1].y, 6);
		expect(a[1].x).toBeCloseTo(a[2].x, 6);
		expect(vectorConstraintDof(r.document).redundant).toBe(0);
	});
});

describe('VectorEditorController constraints', () => {
	it('adds constraints by anchor index, solves drags with them, and undoes each step', async () => {
		const { VectorEditorController } = await import('../src/vector');
		const c = new VectorEditorController({ document: doc({ id: 'p', type: 'path', fill: null, stroke: '#000', subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 100, y: 3 }, { x: 98, y: 100 }] }] }) });
		const h = c.addConstraint({ kind: 'horizontal', refs: [{ nodeId: 'p', subpath: 0, index: 0, segment: true }] });
		expect(h.ok).toBe(true);
		const v = c.addConstraint({ kind: 'vertical', refs: [{ nodeId: 'p', subpath: 0, index: 1, segment: true }] });
		expect(v.ok).toBe(true);
		const len = c.addConstraint({ kind: 'distance', refs: [{ nodeId: 'p', subpath: 0, index: 0, segment: true }], value: 80 });
		expect(len.ok).toBe(true);
		const a = () => (c.getNode('p') as VectorPathNode).subpaths[0].anchors;
		expect(a().map((x) => x.id)).toEqual(['a1', 'a2', 'a3']);
		expect(Math.hypot(a()[1].x - a()[0].x, a()[1].y - a()[0].y)).toBeCloseTo(80, 5);
		// Dragging the corner: the constraints hold, the dragged anchor goes where it was put.
		expect(c.moveAnchor({ nodeId: 'p', subpath: 0, index: 1 }, { x: 150, y: 20 }).ok).toBe(true);
		expect(a()[1].x).toBeCloseTo(150, 3);
		expect(a()[1].y).toBeCloseTo(20, 3);
		expect(a()[0].y).toBeCloseTo(a()[1].y, 6);
		expect(a()[2].x).toBeCloseTo(a()[1].x, 6);
		expect(c.getState().constraintIssues).toBeNull();
		expect(c.setConstraintValue('d1', '60').ok).toBe(true);
		expect(Math.hypot(a()[1].x - a()[0].x, a()[1].y - a()[0].y)).toBeCloseTo(60, 5);
		expect(c.setConstraintValue('w', '45').ok).toBe(true);
		expect(c.setConstraintValue('d1', 'w * 2').ok).toBe(true);
		expect(Math.hypot(a()[1].x - a()[0].x, a()[1].y - a()[0].y)).toBeCloseTo(90, 5);
		expect(c.setConstraintValue('d1', 'nope + 1')).toMatchObject({ ok: false, message: expect.stringMatching(/unknown parameter `nope`/) });
		expect(c.addConstraint({ kind: 'horizontal', refs: [{ nodeId: 'p', subpath: 0, index: 0, segment: true }] })).toMatchObject({ ok: false, message: expect.stringMatching(/over-constrain/) });
		expect(c.getConstraintDof()).toMatchObject({ status: 'under' });
		c.undo();
		expect(Math.hypot(a()[1].x - a()[0].x, a()[1].y - a()[0].y)).toBeCloseTo(60, 5);
		expect(c.removeConstraints([h.id!]).ok).toBe(true);
		expect(c.getConstraints().map((x) => x.kind)).toEqual(['vertical', 'distance']);
		// Deleting an anchor drops the constraints on it.
		c.deleteAnchors([{ nodeId: 'p', subpath: 0, index: 2 }], { keepShape: false });
		expect(c.getConstraints().map((x) => x.kind)).toEqual(['distance']);
	});

	it('auto-constrains the selection', async () => {
		const { VectorEditorController } = await import('../src/vector');
		const c = new VectorEditorController({ document: doc({ id: 'p', type: 'path', fill: null, stroke: '#000', subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 100, y: 0.3 }] }] }) });
		c.select(['p']);
		const r = c.autoConstrain();
		expect(r.ok).toBe(true);
		expect(c.getConstraints().map((x) => x.kind)).toEqual(['horizontal']);
		expect(c.getState().canUndo).toBe(true);
	});
});

describe('constraint commands through the tool registry', () => {
	it('adds, lists, sets values, auto-constrains and removes; fails usefully', async () => {
		const { VectorEditorController, createVectorCommands } = await import('../src/vector');
		const { CommandRegistry, createCommandToolProvider } = await import('../src/commands');
		const { ToolRegistry } = await import('../src/tools');
		const controller = new VectorEditorController({ document: doc({ id: 'p', type: 'path', fill: null, stroke: '#000', subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 100, y: 2 }, { x: 101, y: 80 }] }] }) });
		const commands = new CommandRegistry({ context: undefined });
		commands.register(createVectorCommands(controller));
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params: Record<string, unknown> = {}) => {
			const r = await tools.callTool('run_command', { id, params });
			const sc = r.structuredContent as { result?: any; error?: { message: string } };
			return { ok: !r.isError, result: sc.result, message: sc.error?.message };
		};
		const h = await run('vector.addConstraint', { kind: 'horizontal', refs: [{ nodeId: 'p', subpath: 0, index: 0, segment: true }] });
		expect(h.ok).toBe(true);
		expect(h.result.constraint).toMatchObject({ kind: 'horizontal', refs: [{ nodeId: 'p', anchor: 'a1', segment: true }] });
		const d = await run('vector.addConstraint', { kind: 'distance', refs: [{ nodeId: 'p', subpath: 0, index: 0, segment: true }], value: 'w', name: 'width' });
		expect(d).toMatchObject({ ok: false, message: expect.stringMatching(/unknown parameter `w`/) });
		expect((await run('vector.setConstraintValue', { key: 'w', value: 120 })).ok).toBe(true);
		expect((await run('vector.addConstraint', { kind: 'distance', refs: [{ nodeId: 'p', subpath: 0, index: 0, segment: true }], value: 'w', name: 'width' })).ok).toBe(true);
		const auto = await run('vector.autoConstrain', { ids: ['p'], angleTolerance: 20 });
		expect(auto.result.ids.length).toBeGreaterThan(0);
		const listed = await run('vector.listConstraints');
		expect(listed.result.parameters).toEqual([{ name: 'w', value: '120' }]);
		expect(listed.result.constraints.find((c: any) => c.name === 'width')).toMatchObject({ evaluated: 120, satisfied: true });
		expect(listed.result.dof.status).toMatch(/under|fully/);
		expect(await run('vector.addConstraint', { kind: 'parallel', refs: [{ nodeId: 'p', subpath: 0, index: 0, segment: true }] })).toMatchObject({ ok: false, message: expect.stringMatching(/needs two segments/) });
		expect(await run('vector.addConstraint', { kind: 'fix', refs: [{ nodeId: 'p', subpath: 0, index: 9 }] })).toMatchObject({ ok: false, message: expect.stringMatching(/no anchor 9/) });
		expect(await run('vector.setConstraintValue', { key: h.result.id, value: 3 })).toMatchObject({ ok: false, message: expect.stringMatching(/has no value/) });
		expect(await run('vector.removeConstraint', { ids: ['ghost'] })).toMatchObject({ ok: false, message: expect.stringMatching(/no constraint "ghost"/) });
		expect((await run('vector.removeConstraint', { ids: [h.result.id] })).result).toEqual({ ids: [h.result.id] });
	});
});
