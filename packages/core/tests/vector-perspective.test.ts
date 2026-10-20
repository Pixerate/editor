// Drawing in perspective (CorelDRAW's Perspective Drawing, concept only): a 1-, 2- or 3-point grid
// whose planes art is drawn on or attached to. Test cases our own.
import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/tools';
import { bezierPathBounds } from '../src/canvas/pathops';
import {
	VectorEditorController,
	createVectorCommands,
	getVectorOverlayRenderData,
	rectSubpath,
	sanitizeVectorPerspective,
	subpathsToBezier,
	vectorPerspectiveFlatToPlane,
	vectorPerspectiveGridLines,
	vectorPerspectivePlaneToFlat,
	vectorPerspectivePlanes,
	vectorPerspectivePreset,
	type VectorDocument,
	type VectorPathNode,
	type VectorPerspective
} from '../src/vector';

// Two points on a horizon at y = 100, the origin below between them.
const two: VectorPerspective = { vanishingPoints: [{ x: -200, y: 100 }, { x: 600, y: 100 }], origin: { x: 200, y: 300 } };
const one: VectorPerspective = { vanishingPoints: [{ x: 200, y: 100 }], origin: { x: 200, y: 300 } };
const near = (a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) < eps;
const rect = (id: string, x: number, y: number, w: number, h: number): VectorPathNode => ({ id, type: 'path', subpaths: [rectSubpath({ x, y, width: w, height: h })], fill: '#ff0000', stroke: null });
const doc = (...nodes: VectorPathNode[]): VectorDocument => ({ width: 400, height: 400, nodes, perspective: two });
const corners = (n: VectorPathNode) => n.subpaths[0].anchors.map((a) => ({ x: a.x, y: a.y }));

describe('perspective planes', () => {
	it('has floor, left and right with two points, floor, side and front with one', () => {
		expect(vectorPerspectivePlanes(two)).toEqual(['floor', 'left', 'right']);
		expect(vectorPerspectivePlanes(one)).toEqual(['floor', 'side', 'front']);
	});

	it('keeps the origin and recedes toward the vanishing points', () => {
		const right = vectorPerspectiveFlatToPlane(two, 'right')!;
		expect(near(right(two.origin)!, two.origin)).toBe(true);
		// Along the right wall's ground line, points head for the right vanishing point.
		const a = right({ x: 300, y: 300 })!;
		const b = right({ x: 1000, y: 300 })!;
		const toVp = (p: { x: number; y: number }) => Math.atan2(100 - p.y, 600 - p.x);
		expect(toVp(a)).toBeCloseTo(toVp(two.origin), 6);
		expect(Math.hypot(600 - b.x, 100 - b.y)).toBeLessThan(Math.hypot(600 - a.x, 100 - a.y));
		// A wall's verticals stay vertical with two points.
		const top = right({ x: 300, y: 200 })!;
		expect(top.x).toBeCloseTo(a.x, 6);
		expect(top.y).toBeLessThan(a.y);
	});

	it('round-trips between flat art and the plane', () => {
		for (const plane of ['floor', 'left', 'right'] as const) {
			const to = vectorPerspectiveFlatToPlane(two, plane)!;
			const back = vectorPerspectivePlaneToFlat(two, plane)!;
			const q = { x: 230, y: 260 };
			expect(near(back(to(q)!)!, q, 1e-6)).toBe(true);
		}
		// The front plane of a 1-point grid is the page itself.
		expect(near(vectorPerspectiveFlatToPlane(one, 'front')!({ x: 50, y: 70 })!, { x: 50, y: 70 })).toBe(true);
	});

	it('refuses points behind the viewer and draws grid lines only in front', () => {
		// Far past the right vanishing point along the left wall's x direction is behind the viewer.
		expect(vectorPerspectiveFlatToPlane(two, 'left')!({ x: 2000, y: 300 })).toBeNull();
		const lines = vectorPerspectiveGridLines({ ...two, gridSize: 20, extent: 5 }, 'floor');
		expect(lines.length).toBe(22);
		expect(lines.every((l) => l.a.y >= 100 - 1e-6 && l.b.y >= 100 - 1e-6)).toBe(true);
		expect(vectorPerspectiveGridLines(two, 'front')).toEqual([]);
	});

	it('gives starting grids for a page', () => {
		expect(vectorPerspectivePreset(1, 400, 300).vanishingPoints).toEqual([{ x: 200, y: 105 }]);
		const three = vectorPerspectivePreset(3, 400, 300);
		expect(three.vanishingPoints).toHaveLength(3);
		expect(sanitizeVectorPerspective(three)).toEqual(three);
	});

	it('sanitizes grids', () => {
		expect(sanitizeVectorPerspective({ vanishingPoints: [], origin: { x: 0, y: 0 } })).toBeNull();
		expect(sanitizeVectorPerspective({ vanishingPoints: [{ x: 0, y: 0 }], origin: { x: 0, y: 0 } })).toBeNull();
		expect(sanitizeVectorPerspective({ ...two, extent: 999, gridSize: -1, visible: false })).toEqual({ ...two, extent: 100, visible: false });
	});
});

describe('perspective in the editor', () => {
	it('draws a rectangle on a plane, its corners where the drag starts and ends', () => {
		const c = new VectorEditorController({ document: doc() });
		expect(c.setPerspectivePlane('front').ok).toBe(false);
		expect(c.setPerspectivePlane('right').ok).toBe(true);
		c.setTool('rect');
		c.pointerDown({ x: 220, y: 200 });
		c.pointerMove({ x: 300, y: 280 });
		c.pointerUp({ x: 300, y: 280 });
		const n = c.getState().document.nodes[0] as VectorPathNode;
		const pts = corners(n);
		expect(pts).toHaveLength(4);
		expect(pts.some((p) => near(p, { x: 220, y: 200 }, 1e-6))).toBe(true);
		expect(pts.some((p) => near(p, { x: 300, y: 280 }, 1e-6))).toBe(true);
		// Not an axis-aligned rectangle: its top and bottom edges slope toward the vanishing point.
		const ys = new Set(pts.map((p) => Math.round(p.y)));
		expect(ys.size).toBe(4);
		expect(c.getState().perspectivePlane).toBe('right');
		const overlay = getVectorOverlayRenderData(c.getState());
		expect(overlay.perspective!.planes.find((p) => p.plane === 'right')!.active).toBe(true);
		expect(overlay.perspective!.vanishingPoints).toHaveLength(2);
	});

	it('attaches flat art to a plane in one undo step, and removes the grid', () => {
		const c = new VectorEditorController({ document: doc(rect('a', 200, 200, 100, 100)) });
		const r = c.attachToPerspective('right', { ids: ['a'] });
		expect(r).toMatchObject({ ok: true, ids: ['a'] });
		const n = c.getNode('a') as VectorPathNode;
		// The near edge stays at the origin's x; the far edge is shorter (receding).
		const b = bezierPathBounds(subpathsToBezier(n.subpaths))!;
		expect(b.minX).toBeCloseTo(200, 6);
		const pts = corners(n);
		const nearH = Math.abs(pts[0].y - pts[3].y);
		const farH = Math.abs(pts[1].y - pts[2].y);
		expect(farH).toBeLessThan(nearH);
		c.undo();
		expect(corners(c.getNode('a') as VectorPathNode)[1]).toEqual({ x: 300, y: 200 });
		expect(c.attachToPerspective('front', { ids: ['a'] }).ok).toBe(false);
		expect(c.setPerspective(null).ok).toBe(true);
		expect(c.getPerspective()).toBeNull();
		expect(c.attachToPerspective('right', { ids: ['a'] })).toMatchObject({ ok: false, message: expect.stringContaining('no perspective grid') });
		c.undo();
		expect(c.getPerspective()).toEqual(two);
	});
});

describe('perspective commands through the tool registry', () => {
	it('sets, reads, draws on, attaches to and removes a grid', async () => {
		const c = new VectorEditorController({ document: { width: 400, height: 400, nodes: [rect('a', 200, 200, 50, 50), { id: 't', type: 'text', text: 'Hi', x: 0, y: 0 } as never] } });
		const commands = new CommandRegistry();
		for (const spec of createVectorCommands(c)) commands.register(spec);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(commands));
		const run = async (id: string, params?: unknown) => {
			const r = await tools.callTool('run_command', { id, ...(params !== undefined ? { params } : {}) });
			return { isError: !!r.isError, text: r.content?.map((x: any) => x.text).join('') ?? '', ...(r.structuredContent as any) };
		};
		expect((await run('vector.getPerspective')).result).toEqual({ perspective: null, planes: [], drawingOn: null });
		const set = await run('vector.setPerspective', { vanishingPoints: [{ x: 200, y: 100 }], origin: { x: 200, y: 300 }, gridSize: 25 });
		expect(set.result).toMatchObject({ planes: ['floor', 'side', 'front'], perspective: { gridSize: 25 } });
		expect((await run('vector.setPerspectivePlane', { plane: 'floor' })).result.drawingOn).toBe('floor');
		expect((await run('vector.setPerspectivePlane', { plane: 'left' })).text).toContain('floor, side, front');
		expect((await run('vector.attachToPerspective', { ids: ['a'], plane: 'floor' })).result).toEqual({ ids: ['a'] });
		expect((await run('vector.attachToPerspective', { ids: ['t'], plane: 'floor' })).text).toContain('outlines');
		expect((await run('vector.setPerspective', { vanishingPoints: [{ x: 200, y: 300 }], origin: { x: 200, y: 300 } })).isError).toBe(true);
		expect((await run('vector.removePerspective')).result).toEqual({ perspective: null });
		expect(c.getState().perspectivePlane).toBeNull();
	});
});
