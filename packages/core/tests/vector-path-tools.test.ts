import { describe, expect, it } from 'vitest';
import {
	createVectorCommands,
	ellipseSubpath,
	getAnchorWorld,
	getVectorOverlayRenderData,
	rectSubpath,
	subpathPointAt,
	vectorNodeBounds,
	VECTOR_TOOLS,
	VectorEditorController,
	type VectorDocument,
	type VectorPathNode,
	type VectorSubpath
} from '../src/vector/index.js';
import { CommandRegistry } from '../src/commands/index.js';
import { applyMatrix, vectorWorldMatrix } from '../src/vector/geometry.js';
import { bezierPathArea } from '../src/canvas/pathops/index.js';
import { subpathsToBezier } from '../src/vector/geometry.js';

const pathNode = (id: string, subpaths: VectorSubpath[], extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id, type: 'path', subpaths, fill: '#f00', stroke: '#000', ...extra });
const rectNode = (id: string, x: number, y: number, w = 100, h = 100, extra: Partial<VectorPathNode> = {}) => pathNode(id, [rectSubpath({ x, y, width: w, height: h })], extra);
const lineNode = (id: string, pts: [number, number][], extra: Partial<VectorPathNode> = {}) =>
	pathNode(id, [{ anchors: pts.map(([x, y]) => ({ x, y })), closed: false }], { fill: null, ...extra });
const doc = (...nodes: VectorPathNode[]): VectorDocument => ({ width: 400, height: 300, nodes });

let n = 0;
const make = (document?: VectorDocument, editing = {}) => new VectorEditorController({ document, createId: () => `id${++n}`, editing });
const path = (c: VectorEditorController, id: string) => c.getNode(id) as VectorPathNode;
const area = (node: VectorPathNode) => bezierPathArea(subpathsToBezier(node.subpaths));
const drag = (c: VectorEditorController, pts: [number, number][], mods = {}) => {
	c.pointerDown({ x: pts[0][0], y: pts[0][1] }, mods);
	for (const [x, y] of pts.slice(1)) c.pointerMove({ x, y }, mods);
	const [x, y] = pts[pts.length - 1];
	c.pointerUp({ x, y }, mods);
};

describe('deleting anchors', () => {
	it('keeps the shape by default and joins the neighbours as they are when turned off', () => {
		const ellipse = pathNode('e', [ellipseSubpath({ x: 0, y: 0, width: 200, height: 100 })]);
		const c = make(doc(ellipse));
		c.setTool('direct');
		c.selectAnchors([{ nodeId: 'e', subpath: 0, index: 1 }]);
		expect(c.keyDown({ key: 'Delete' })).toBe(true);
		const kept = path(c, 'e').subpaths[0];
		expect(kept.anchors).toHaveLength(3);
		// The out handle of the top anchor was refitted (longer than the quarter-circle one).
		expect(kept.anchors[0].out!.x).toBeGreaterThan(ellipse.subpaths[0].anchors[0].out!.x + 10);
		expect(c.getState().undoLabel).toBe('Delete Points');
		c.undo();
		c.deleteAnchors([{ nodeId: 'e', subpath: 0, index: 1 }], { keepShape: false });
		expect(path(c, 'e').subpaths[0].anchors[0].out).toEqual(ellipse.subpaths[0].anchors[0].out);
		c.undo();
		c.setEditing({ keepShapeOnDelete: false });
		c.deleteAnchors([{ nodeId: 'e', subpath: 0, index: 1 }]);
		expect(path(c, 'e').subpaths[0].anchors[0].out).toEqual(ellipse.subpaths[0].anchors[0].out);
	});
});

describe('bending segments with the direct tool', () => {
	it('a drag bends the segment through the pointer as one undo step; a click still selects', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.setTool('direct');
		c.select(['a']);
		c.pointerDown({ x: 50, y: 0 });
		c.pointerUp({ x: 50, y: 0 });
		expect(c.getState().selectedAnchors).toEqual([
			{ nodeId: 'a', subpath: 0, index: 0 },
			{ nodeId: 'a', subpath: 0, index: 1 }
		]);
		expect(c.getState().canUndo).toBe(false);
		drag(c, [[25, 0], [30, -10], [25, -40]]);
		const sp = path(c, 'a').subpaths[0];
		const p = subpathPointAt(sp, 0, 0.25);
		expect(p.x).toBeCloseTo(25, 9);
		expect(p.y).toBeCloseTo(-40, 9);
		// The anchors stay where they were.
		expect(sp.anchors.map((a) => [a.x, a.y])).toEqual([[0, 0], [100, 0], [100, 100], [0, 100]]);
		expect(c.getState().undoLabel).toBe('Bend Segment');
		c.undo();
		expect(path(c, 'a').subpaths[0].anchors[0].out).toBeUndefined();
	});

	it('bends a rotated path in its own space', () => {
		const c = make(doc(rectNode('a', 0, 0)));
		c.rotate(90, { ids: ['a'], origin: { x: 0, y: 0 } });
		c.setTool('direct');
		c.select(['a']);
		// Local segment 0 (0,0)→(100,0) is now document (0,0)→(0,100).
		drag(c, [[0, 50], [-20, 50], [-30, 50]]);
		const m = vectorWorldMatrix(c.getState().document.nodes, 'a')!;
		const p = applyMatrix(m, subpathPointAt(path(c, 'a').subpaths[0], 0, 0.5));
		expect(p.x).toBeCloseTo(-30, 6);
		expect(p.y).toBeCloseTo(50, 6);
		expect(c.bendSegment({ nodeId: 'a', subpath: 0, segment: 9 }, { x: 0, y: 0 })).toMatchObject({ ok: false });
	});
});

describe('Curvature-tool anchor moves', () => {
	it('bends the two segments at a lone dragged point; Alt flips the setting during the drag', () => {
		const curve = pathNode('c', [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 50, y: 0, in: { x: 30, y: 0 }, out: { x: 70, y: 0 }, type: 'smooth' }, { x: 100, y: 0 }, { x: 150, y: 0 }] }], { fill: null });
		const c = make(doc(curve), { curvatureMoves: true });
		c.setTool('direct');
		c.selectAnchors([{ nodeId: 'c', subpath: 0, index: 1 }]);
		drag(c, [[50, 0], [50, -20], [50, -50]]);
		let sp = path(c, 'c').subpaths[0];
		expect(sp.anchors[1]).toMatchObject({ x: 50, y: -50 });
		// Smooth: its handles turn along the line through its neighbours (horizontal here).
		expect(sp.anchors[1].in!.y).toBeCloseTo(-50, 9);
		expect(sp.anchors[1].out!.y).toBeCloseTo(-50, 9);
		expect(sp.anchors[3]).toEqual({ x: 150, y: 0 });
		c.undo();
		drag(c, [[50, 0], [50, -20], [50, -50]], { alt: false });
		c.undo();
		// Alt during the drag (not at the press) moves the handles with the point instead.
		c.pointerDown({ x: 50, y: 0 });
		c.pointerMove({ x: 50, y: -50 }, { alt: true });
		c.pointerUp({ x: 50, y: -50 }, { alt: true });
		sp = path(c, 'c').subpaths[0];
		expect(sp.anchors[1].in).toEqual({ x: 30, y: -50 });
		expect(c.moveAnchor({ nodeId: 'c', subpath: 0, index: 1 }, { x: 60, y: 10 }, { curvature: false }).ok).toBe(true);
		expect(path(c, 'c').subpaths[0].anchors[1].in).toEqual({ x: 40, y: 10 });
	});
});

describe('path clean-up', () => {
	it('joins two open paths into one (lowest keeps its id and style), then closes it', () => {
		const c = make(doc(lineNode('a', [[0, 0], [100, 0]]), lineNode('b', [[100.5, 0], [100, 100]], { stroke: '#00f' })));
		c.select(['a', 'b']);
		expect(c.keyDown({ key: 'j', mod: true })).toBe(true);
		expect(c.getNode('b')).toBeUndefined();
		const a = path(c, 'a');
		expect(a.stroke).toBe('#000');
		expect(a.subpaths).toHaveLength(1);
		expect(a.subpaths[0].anchors.map((p) => [p.x, p.y])).toEqual([[0, 0], [100, 0], [100, 100]]);
		expect(c.getState().selection).toEqual(['a']);
		c.joinPaths();
		expect(a.subpaths[0].closed).toBe(false);
		expect(path(c, 'a').subpaths[0].closed).toBe(true);
		expect(c.joinPaths()).toMatchObject({ ok: false });
	});

	it('joins paths with different rotations in document space', () => {
		const c = make(doc(lineNode('a', [[0, 0], [100, 0]]), lineNode('b', [[0, 0], [100, 0]])));
		// Turn b about its start and move it to start where a ends.
		c.rotate(90, { ids: ['b'], origin: { x: 0, y: 0 } });
		c.translate(100, 0, { ids: ['b'] });
		c.joinPaths({ ids: ['a', 'b'], tolerance: 0.01 });
		const world = path(c, 'a').subpaths[0].anchors.map((_, i) => getAnchorWorld(c.getState().document, { nodeId: 'a', subpath: 0, index: i })!);
		expect(world.map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual([[0, 0], [100, 0], [100, 100]]);
	});

	it('averages points in document space', () => {
		const c = make(doc(lineNode('a', [[0, 0], [100, 40]]), lineNode('b', [[0, 100], [50, 20]])));
		const refs = [{ nodeId: 'a', subpath: 0, index: 1 }, { nodeId: 'b', subpath: 0, index: 1 }];
		c.averageAnchors('horizontal', refs);
		expect(path(c, 'a').subpaths[0].anchors[1]).toEqual({ x: 100, y: 30 });
		expect(path(c, 'b').subpaths[0].anchors[1]).toEqual({ x: 50, y: 30 });
		c.averageAnchors('both', refs);
		expect(path(c, 'b').subpaths[0].anchors[1]).toEqual({ x: 75, y: 30 });
		expect(c.averageAnchors('both', refs.slice(0, 1))).toMatchObject({ ok: false });
	});

	it('removes redundant points and smooths, each as one undo step', () => {
		const c = make(doc(lineNode('a', [[0, 0], [50, 0], [100, 0], [100, 100]])));
		c.select(['a']);
		c.removeRedundantPoints();
		expect(path(c, 'a').subpaths[0].anchors).toHaveLength(3);
		expect(c.getState().undoLabel).toBe('Remove Redundant Points');
		c.smoothPaths();
		expect(path(c, 'a').subpaths[0].anchors[1].type).toBe('symmetric');
		expect(c.getState().undoLabel).toBe('Smooth');
		c.undo();
		c.undo();
		expect(path(c, 'a').subpaths[0].anchors).toHaveLength(4);
	});
});

describe('Scissors, Knife and Eraser tools', () => {
	it('are tools with shortcuts', () => {
		expect(VECTOR_TOOLS).toEqual(expect.arrayContaining(['scissors', 'knife', 'eraser']));
		const c = make();
		c.keyDown({ key: 'c' });
		expect(c.getState().tool).toBe('scissors');
		c.keyDown({ key: 'k' });
		expect(c.getState().tool).toBe('knife');
		c.keyDown({ key: 'e' });
		expect(c.getState().tool).toBe('eraser');
	});

	it('scissors open a closed path and split an open one into two paths', () => {
		const c = make(doc(rectNode('r', 0, 0), lineNode('l', [[0, 200], [200, 200]])));
		c.setTool('scissors');
		c.pointerMove({ x: 50, y: 2 });
		expect(getVectorOverlayRenderData(c.getState()).cutPoint).toEqual({ x: 50, y: 0 });
		c.pointerDown({ x: 50, y: 2 });
		c.pointerUp({ x: 50, y: 2 });
		const r = path(c, 'r').subpaths[0];
		expect(r.closed).toBe(false);
		expect(r.anchors[0]).toMatchObject({ x: 50, y: 0 });
		expect(r.anchors[r.anchors.length - 1]).toMatchObject({ x: 50, y: 0 });
		expect(c.getState().undoLabel).toBe('Cut Path');
		c.pointerDown({ x: 120, y: 199 });
		c.pointerUp({ x: 120, y: 199 });
		const ids = c.getState().selection;
		expect(ids).toHaveLength(2);
		expect(ids[0]).toBe('l');
		expect(path(c, ids[0]).subpaths[0].anchors.map((a) => a.x)).toEqual([0, 120]);
		expect(path(c, ids[1]).subpaths[0].anchors.map((a) => a.x)).toEqual([120, 200]);
		// The end of an open path does not cut.
		expect(c.cutPathAt(ids[0], { x: 0, y: 200 })).toBeNull();
		// Cut at selected anchors.
		c.undo();
		c.undo();
		expect(c.cutAtAnchors([{ nodeId: 'r', subpath: 0, index: 2 }]).ok).toBe(true);
		expect(path(c, 'r').subpaths[0].anchors[0]).toMatchObject({ x: 100, y: 100 });
	});

	it('the knife cuts every shape the stroke crosses into pieces, as one undo step', () => {
		const c = make(doc(rectNode('a', 0, 0, 100, 100), rectNode('b', 200, 0, 100, 100), rectNode('far', 0, 200, 50, 50)));
		c.setTool('knife');
		c.pointerDown({ x: -10, y: 50 });
		c.pointerMove({ x: 150, y: 50 });
		expect(getVectorOverlayRenderData(c.getState()).toolStroke).toMatchObject({ tool: 'knife', width: 0 });
		c.pointerMove({ x: 310, y: 50 });
		c.pointerUp({ x: 310, y: 50 });
		const nodes = c.getState().document.nodes as VectorPathNode[];
		expect(nodes).toHaveLength(5);
		expect(nodes.map((p) => p.id).slice(0, 2)).toEqual(['a', nodes[1].id]);
		expect(nodes.filter((p) => p.id !== 'far').every((p) => Math.abs(area(p) - 5000) < 1e-6)).toBe(true);
		expect(c.getState().selection).toHaveLength(4);
		expect(c.getState().undoLabel).toBe('Knife');
		c.undo();
		expect(c.getState().document.nodes).toHaveLength(3);
		// A stroke that stays inside does nothing (and records nothing).
		c.pointerDown({ x: 20, y: 20 });
		c.pointerUp({ x: 80, y: 80 });
		expect(c.getState().document.nodes).toHaveLength(3);
		expect(c.getState().canRedo).toBe(true);
	});

	it('the knife works on rotated shapes, in their own space', () => {
		const c = make(doc(rectNode('a', 0, 0, 100, 100)));
		c.rotate(45, { ids: ['a'] });
		const ids = c.knife([{ x: 50, y: -100 }, { x: 50, y: 200 }], { ids: ['a'] });
		expect(ids).toHaveLength(2);
		expect(ids.map((id) => area(path(c, id))).reduce((s, v) => s + v)).toBeCloseTo(10000, 6);
		expect(path(c, ids[1]).transform).toEqual(path(c, 'a').transform);
	});

	it('the eraser removes area from fills and cuts outlines', () => {
		const c = make(doc(rectNode('a', 0, 0, 100, 40), lineNode('l', [[0, 100], [100, 100]])), { eraserSize: 10 });
		c.setTool('eraser');
		drag(c, [[50, -20], [50, 50], [50, 120]]);
		const nodes = c.getState().document.nodes as VectorPathNode[];
		expect(nodes).toHaveLength(4);
		const fills = nodes.filter((p) => p.fill);
		expect(fills.map(area).reduce((s, v) => s + v)).toBeCloseTo(3600, 3);
		const lines = nodes.filter((p) => !p.fill);
		expect(lines.map((p) => p.subpaths[0].anchors.map((a) => Math.round(a.x)))).toEqual([[0, 45], [55, 100]]);
		expect(c.getState().undoLabel).toBe('Erase');
		c.undo();
		expect(c.getState().document.nodes).toHaveLength(2);
		// Changing the size changes the swath.
		c.setEditing({ eraserSize: 30 });
		c.erase([{ x: 50, y: 100 }]);
		expect((c.getState().document.nodes as VectorPathNode[]).filter((p) => !p.fill).map((p) => p.subpaths[0].anchors.map((a) => Math.round(a.x)))).toEqual([[0, 35], [65, 100]]);
	});
});

describe('pencil', () => {
	it('lazy-mouse smoothing keeps small wobbles out of the stroke', () => {
		const c = make(undefined, { pencilSmoothing: 0.2 }); // a 20 px string at zoom 1
		c.setTool('pencil');
		c.pointerDown({ x: 0, y: 0 });
		for (let i = 1; i <= 60; i++) c.pointerMove({ x: i * 4, y: (i % 2 ? 6 : -6) });
		expect(getVectorOverlayRenderData(c.getState()).pencilString).not.toBeNull();
		c.pointerUp({ x: 240, y: 0 });
		const sp = (c.getState().document.nodes[0] as VectorPathNode).subpaths[0];
		const b = vectorNodeBounds(c.getState().document.nodes[0])!;
		expect(b.height).toBeLessThan(6);
		// The pen catches up with the pointer at the end.
		expect(sp.anchors[sp.anchors.length - 1]).toMatchObject({ x: 240, y: 0 });
	});

	it('recognises shapes when turned on', () => {
		const c = make(undefined, { recognizeShapes: true });
		c.setTool('pencil');
		const pts: [number, number][] = Array.from({ length: 49 }, (_, i) => [100 + 50 * Math.cos((i / 48) * 2 * Math.PI), 100 + 30 * Math.sin((i / 48) * 2 * Math.PI)]);
		drag(c, pts);
		const node = c.getState().document.nodes[0] as VectorPathNode;
		expect(node.name).toBe('Ellipse');
		expect(node.subpaths[0].anchors).toHaveLength(4);
		expect(c.getState().undoLabel).toBe('Draw Ellipse');
		const b = vectorNodeBounds(node)!;
		expect(b.width).toBeCloseTo(100, 0);
		drag(c, [[0, 250], [60, 252], [120, 250]]);
		expect((c.getState().document.nodes[1] as VectorPathNode).subpaths[0].anchors).toEqual([{ x: 0, y: 250 }, { x: 120, y: 250 }]);
		c.setEditing({ recognizeShapes: false });
		drag(c, pts);
		expect((c.getState().document.nodes[2] as VectorPathNode).name).toBe('Pencil');
	});
});

describe('agent commands', () => {
	it('expose the path-editing actions', () => {
		const c = make(doc(rectNode('a', 0, 0, 100, 100), lineNode('l', [[0, 200], [50, 200], [100, 200]])));
		const registry = new CommandRegistry({ history: c.history });
		registry.register(createVectorCommands(c));
		const run = (id: string, params?: unknown) => registry.execute(`vector.${id}`, params as any) as any;
		expect(run('bendSegment', { nodeId: 'a', subpath: 0, segment: 0, x: 50, y: -20 }).ok).toBe(true);
		expect(run('moveAnchor', { nodeId: 'a', subpath: 0, index: 2, x: 120, y: 120, curvature: true }).ok).toBe(true);
		expect(run('deleteAnchors', { anchors: [{ nodeId: 'l', subpath: 0, index: 1 }] }).ok).toBe(true);
		expect(path(c, 'l').subpaths[0].anchors).toHaveLength(2);
		expect(run('deleteAnchors', { anchors: [{ nodeId: 'l', subpath: 0, index: 7 }] })).toMatchObject({ ok: false });
		expect(run('average', { axis: 'vertical', anchors: [{ nodeId: 'l', subpath: 0, index: 0 }, { nodeId: 'l', subpath: 0, index: 1 }] }).ok).toBe(true);
		expect(path(c, 'l').subpaths[0].anchors.map((p) => p.x)).toEqual([50, 50]);
		const sm = run('smooth', { ids: ['a'], amount: 0.5 });
		expect(sm).toMatchObject({ ok: true });
		expect(run('removeRedundantPoints', { ids: ['a'] }).ok).toBe(true);
		expect(run('join', { ids: ['l'] }).ok).toBe(true);
		expect(path(c, 'l').subpaths[0].closed).toBe(true);
		const cut = run('cut', { nodeId: 'l', x: 50, y: 200 });
		expect(cut.ok).toBe(true);
		const knifed = run('knife', { points: [[-50, 150], [150, -50]], ids: ['a'] });
		expect(knifed.ok).toBe(true);
		expect(knifed.result.ids).toHaveLength(2);
		expect(run('knife', { points: [[1000, 1000], [1100, 1000]] })).toMatchObject({ ok: false });
		expect(run('erase', { points: [[1000, 1000]] })).toMatchObject({ ok: false });
		const erased = run('erase', { points: [[0, 50], [300, 50]], size: 4, ids: knifed.result.ids });
		expect(erased.ok).toBe(true);
		expect(run('setEditing', { curvatureMoves: true, pencilSmoothing: 0.3 }).result.editing).toMatchObject({ curvatureMoves: true, pencilSmoothing: 0.3, keepShapeOnDelete: true });
		expect(run('setTool', { tool: 'knife' }).ok).toBe(true);
	});
});
