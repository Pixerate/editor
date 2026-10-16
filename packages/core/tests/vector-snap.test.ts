import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ellipseSubpath,
	getAnchorWorld,
	getVectorOverlayRenderData,
	getVectorSelectionBoxGeometry,
	lineSubpath,
	rectSubpath,
	rotateMatrix,
	applyMatrix,
	scaleFor,
	vectorNodeBounds,
	VectorEditorController,
	VectorSnapTargets,
	type VectorDocument,
	type VectorNode,
	type VectorPathNode
} from '../src/vector/index.js';
import { segmentIntersections } from '../src/canvas/pathops/index.js';

const rect = (id: string, x: number, y: number, w = 50, h = 50, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [rectSubpath({ x, y, width: w, height: h })],
	fill: '#f00',
	stroke: null,
	...extra
});
const line = (id: string, a: [number, number], b: [number, number]): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [lineSubpath({ x: a[0], y: a[1] }, { x: b[0], y: b[1] })],
	fill: null,
	stroke: '#000'
});
const circle = (id: string, cx: number, cy: number, r: number): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [ellipseSubpath({ x: cx - r, y: cy - r, width: 2 * r, height: 2 * r })],
	fill: null,
	stroke: '#000'
});
const doc = (nodes: VectorNode[], width = 400, height = 300): VectorDocument => ({ width, height, nodes });
const labels = (r: { labels: { text: string }[] }) => r.labels.map((l) => l.text);

let n = 0;
const make = (document: VectorDocument, options: ConstructorParameters<typeof VectorEditorController>[0] = {}) =>
	new VectorEditorController({ document, createId: () => `id${++n}`, ...options });

afterEach(() => vi.restoreAllMocks());

describe('segmentIntersections', () => {
	it('finds every crossing of two curves, not just one', () => {
		// Two cubic arcs of overlapping circles cross twice.
		const a = circle('a', 50, 50, 50).subpaths[0];
		const b = circle('b', 110, 50, 50).subpaths[0];
		const segs = (sp: typeof a) => [0, 1, 2, 3].map((i) => {
			const p = sp.anchors[i];
			const q = sp.anchors[(i + 1) % 4];
			return [[p.x, p.y], [p.out!.x, p.out!.y], [q.in!.x, q.in!.y], [q.x, q.y]] as [number, number][];
		});
		const hits = segs(a).flatMap((s) => segs(b).flatMap((t) => segmentIntersections(s, t)));
		const points = hits.map((h) => h.point).sort((p, q) => p[1] - q[1]);
		expect(points).toHaveLength(2);
		expect(points[0][0]).toBeCloseTo(80, 1);
		expect(points[0][1]).toBeCloseTo(10, 1);
		expect(points[1][0]).toBeCloseTo(80, 1);
		expect(points[1][1]).toBeCloseTo(90, 1);
	});

	it('intersects lines exactly and reports nothing for parallel ones', () => {
		expect(segmentIntersections([[0, 0], [10, 10]], [[0, 10], [10, 0]]).map((h) => h.point)).toEqual([[5, 5]]);
		expect(segmentIntersections([[0, 0], [10, 0]], [[0, 1], [10, 1]])).toEqual([]);
	});
});

describe('VectorSnapTargets.snapFrom', () => {
	const t = VectorSnapTargets.forDrawing(doc([rect('a', 100, 100, 100, 100)]));

	it('lands on anchors and centres', () => {
		const a = t.snapPoint({ x: 102, y: 99 }, 4);
		expect(a.point).toEqual({ x: 100, y: 100 });
		expect(a.kind).toBe('anchor');
		expect(labels(a)).toEqual(['anchor']);
		const c = t.snapPoint({ x: 152, y: 149 }, 4);
		expect(c.point).toEqual({ x: 150, y: 150 });
		expect(labels(c)).toEqual(['centre']);
	});

	it('lands on a path before lining up', () => {
		const p = t.snapPoint({ x: 140, y: 102 }, 4);
		expect(p.kind).toBe('path');
		expect(p.point.x).toBeCloseTo(140);
		expect(p.point.y).toBeCloseTo(100);
		expect(labels(p)).toEqual(['path']);
	});

	it('lines up on x and y with the nearest targets', () => {
		const p = t.snapPoint({ x: 301, y: 199 }, 4);
		expect(p.kind).toBe('align');
		expect(p.point).toEqual({ x: 301, y: 200 });
		expect([p.x, p.y]).toEqual([false, true]);
		expect(p.lines).toEqual([{ kind: 'align', x1: 200, y1: 200, x2: 301, y2: 200 }]);
		expect(labels(p)).toEqual(['align']);
		// The artboard's edges and centre are targets too.
		expect(t.snapPoint({ x: 398, y: 20 }, 4).point).toEqual({ x: 400, y: 20 });
	});

	it('leaves a point out of reach alone', () => {
		const p = t.snapPoint({ x: 330, y: 260 }, 4);
		expect(p).toMatchObject({ point: { x: 330, y: 260 }, kind: null, lines: [], labels: [] });
	});

	it('lands on intersections of paths, before the paths themselves', () => {
		// y = x and y = 60 − x / 2 cross at (40, 40); their centres are far from it.
		const x = VectorSnapTargets.forDrawing(doc([line('a', [0, 0], [100, 100]), line('b', [0, 60], [120, 0])]));
		const p = x.snapPoint({ x: 42, y: 41 }, 4);
		expect(p.kind).toBe('intersect');
		expect(p.point.x).toBeCloseTo(40, 6);
		expect(p.point.y).toBeCloseTo(40, 6);
		expect(labels(p)).toEqual(['intersect']);
	});

	it('finds both crossings of two curves', () => {
		const x = VectorSnapTargets.forDrawing(doc([circle('a', 50, 50, 50), circle('b', 110, 50, 50)]));
		const top = x.snapPoint({ x: 81, y: 12 }, 4);
		const bottom = x.snapPoint({ x: 79, y: 88 }, 4);
		expect(top.kind).toBe('intersect');
		expect(bottom.kind).toBe('intersect');
		expect(top.point.x).toBeCloseTo(80, 1);
		expect(top.point.y).toBeCloseTo(10, 1);
		expect(bottom.point.x).toBeCloseTo(80, 1);
		expect(bottom.point.y).toBeCloseTo(90, 1);
	});

	it('prefers an anchor over an intersection at it', () => {
		const x = VectorSnapTargets.forDrawing(doc([line('a', [0, 0], [100, 100]), line('b', [0, 0], [100, 40])]));
		expect(x.snapPoint({ x: 1, y: 1 }, 4)).toMatchObject({ kind: 'anchor', point: { x: 0, y: 0 } });
	});

	it('lands on the perpendicular foot and tangent points from where the point leaves', () => {
		const h = VectorSnapTargets.forDrawing(doc([line('h', [0, 100], [200, 100])]));
		const foot = h.snapFrom({ x: 52, y: 101 }, { at: { x: 50, y: 20 } }, 4);
		expect(foot.kind).toBe('perpendicular');
		expect(foot.point.x).toBeCloseTo(50, 6);
		expect(foot.point.y).toBeCloseTo(100, 6);
		expect(foot.lines[0]).toMatchObject({ kind: 'construction', x1: 50, y1: 20 });
		// Without a point to leave from it is just on the path.
		expect(h.snapPoint({ x: 52, y: 101 }, 4).kind).toBe('path');

		// From (100, −50) the tangents touch a circle of radius 50 round (100, 100) at y = 83.33.
		const c = VectorSnapTargets.forDrawing(doc([circle('c', 100, 100, 50)]));
		const tan = c.snapFrom({ x: 147, y: 84 }, { at: { x: 100, y: -50 } }, 4);
		expect(tan.kind).toBe('tangent');
		expect(tan.point.x).toBeCloseTo(100 + (50 * Math.sqrt(8)) / 3, 1);
		expect(tan.point.y).toBeCloseTo(100 - 50 / 3, 1);
		expect(labels(tan)).toEqual(['tangent']);
	});

	it('lands on construction angles before lining up, sliding into line with a target', () => {
		const t0 = VectorSnapTargets.forDrawing(doc([]));
		const leave = { at: { x: 0, y: 0 }, angles: [0, 45, 90, 135] };
		const c = t0.snapFrom({ x: 100, y: 3 }, leave, 4);
		expect(c.kind).toBe('construction');
		expect(c.point).toEqual({ x: 100, y: 0 });
		expect(c.lines).toEqual([{ kind: 'construction', x1: 0, y1: 0, x2: 100, y2: 0 }]);
		// Near the artboard's centre line the point slides along the guide onto it.
		const s = t0.snapFrom({ x: 197, y: 3 }, leave, 4);
		expect(s.point).toEqual({ x: 200, y: 0 });
		expect(s.kind).toBe('align');
		expect(s.lines.map((l) => l.kind)).toEqual(['construction', 'align']);
		// 45° counter-clockwise on screen goes up and to the right.
		const d = t0.snapFrom({ x: 101, y: -99 }, leave, 4);
		expect(d.point.x).toBeCloseTo(100);
		expect(d.point.y).toBeCloseTo(-100);
	});

	it('keeps a Shift-constrained point on its ray, sliding it into line, ahead of every other snap', () => {
		const x = VectorSnapTargets.forDrawing(doc([rect('r', 99, 20, 30, 70)]));
		// Free, the point lands on the corner (99, 90)…
		expect(x.snapPoint({ x: 100, y: 91 }, 4)).toMatchObject({ kind: 'anchor', point: { x: 99, y: 90 } });
		// …with Shift it stays on the 45° ray and slides to the rectangle's left edge.
		const s = x.snapFrom({ x: 100, y: 91 }, { at: { x: 0, y: 0 }, constrain: 'angle' }, 4);
		expect(s.point.x).toBeCloseTo(99, 9);
		expect(s.point.y).toBeCloseTo(99, 9);
		expect(s.kind).toBe('align');
		// Out of reach of every line it just keeps the angle.
		const free = x.snapFrom({ x: 300, y: 250 }, { at: { x: 0, y: 0 }, constrain: 'axis' }, 4);
		expect(free).toMatchObject({ kind: null, point: { x: 300, y: 0 } });
	});

	it('gathers targets in document space for rotated nodes', () => {
		// A 100 × 100 square turned 45° about its centre (50, 50).
		const r = rect('r', 0, 0, 100, 100, { transform: rotateMatrix(45, { x: 50, y: 50 }) });
		const x = VectorSnapTargets.forDrawing(doc([r]));
		const half = 50 * Math.SQRT2;
		const right = x.snapPoint({ x: 50 + half - 1, y: 51 }, 4);
		expect(right.kind).toBe('anchor');
		expect(right.point.x).toBeCloseTo(50 + half, 9);
		expect(right.point.y).toBeCloseTo(50, 9);
		expect(x.snapPoint({ x: 52, y: 49 }, 4)).toMatchObject({ kind: 'centre' });
		// On the rotated edge from the top corner to the right one.
		const on = x.snapPoint({ x: 86, y: 14 }, 4);
		expect(on.kind).toBe('path');
		expect(on.point.x + on.point.y).toBeCloseTo(100, 6);
		// The bounding box's edges line up too.
		expect(x.snapPoint({ x: 300, y: 50 + half + 2 }, 4).point.y).toBeCloseTo(50 + half, 9);
	});

	it('leaves the dragged anchors and the segments through them out of an anchor drag', () => {
		const tri: VectorPathNode = { id: 't', type: 'path', fill: null, stroke: '#000', subpaths: [{ closed: true, anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }] }] };
		const x = VectorSnapTargets.forAnchorDrag(doc([tri]), [{ nodeId: 't', subpath: 0, index: 2 }]);
		expect(x.counts.segments).toBe(1);
		expect(x.snapPoint({ x: 51, y: 81 }, 4).kind).not.toBe('anchor');
		expect(x.snapPoint({ x: 99, y: 2 }, 4)).toMatchObject({ kind: 'anchor', point: { x: 100, y: 0 } });
		expect(x.snapPoint({ x: 30, y: 2 }, 4)).toMatchObject({ kind: 'path', point: { x: 30, y: 0 } });
	});

	it('looks targets up by bisection, finding what a scan finds', () => {
		let seed = 7;
		const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 1000;
		const nodes = Array.from({ length: 60 }, (_, i) => line(`l${i}`, [rnd(), rnd()], [rnd(), rnd()]));
		const d = doc(nodes, 1000, 1000);
		const x = VectorSnapTargets.forMove(d, []);
		const points = [{ x: 500, y: 500 }, ...nodes.flatMap((l) => {
			const [a, b] = l.subpaths[0].anchors;
			return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }];
		})];
		for (let i = 0; i < 300; i++) {
			const p = { x: rnd(), y: rnd() };
			let best: { x: number; y: number } | null = null;
			for (const q of points) if (Math.hypot(q.x - p.x, q.y - p.y) <= 25 && (!best || Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y))) best = q;
			const res = x.snapPoint(p, 25);
			if (best) {
				expect(res.point.x).toBeCloseTo(best.x, 9);
				expect(res.point.y).toBeCloseTo(best.y, 9);
			} else expect(res.kind === 'anchor' || res.kind === 'centre').toBe(false);
		}
	});
});

describe('VectorSnapTargets.snapRect', () => {
	it('lines a moved box up with edges and centres', () => {
		const t = VectorSnapTargets.forMove(doc([rect('a', 100, 100, 100, 100), rect('m', 0, 0)]), ['m']);
		const r = t.snapRect({ x: 2, y: 50, width: 50, height: 40 }, 4);
		// The artboard's left edge.
		expect(r).toMatchObject({ dx: -2, dy: 0, x: true, y: false });
		expect(r.lines).toHaveLength(1);
		expect(labels(r)).toEqual(['align']);
		const c = t.snapRect({ x: 127, y: 300, width: 50, height: 40 }, 4);
		// Its centre lines up with the square's centre (150).
		expect(c.dx).toBe(-2);
	});

	it('spaces a box evenly after a pair of boxes (repeating their gap)', () => {
		const t = VectorSnapTargets.forMove(doc([rect('a', 0, 0), rect('b', 100, 0)], 1000, 1000), []);
		const r = t.snapRect({ x: 202, y: 10, width: 50, height: 30 }, 4, { spacing: true });
		expect(r.dx).toBe(-2);
		expect(r.x).toBe(true);
		const gaps = r.lines.filter((l) => l.kind === 'spacing' && l.y1 === l.y2);
		expect(gaps.map((g) => [g.x1, g.x2]).sort((p, q) => p[0] - q[0])).toEqual([
			[50, 100],
			[150, 200]
		]);
		expect(r.labels.filter((l) => l.kind === 'spacing').map((l) => l.text)).toEqual(['50', '50']);
	});

	it('centres a box between its neighbours', () => {
		const t = VectorSnapTargets.forMove(doc([rect('a', 0, 0), rect('c', 200, 0)], 1000, 1000), []);
		const r = t.snapRect({ x: 101, y: 10, width: 50, height: 30 }, 4, { spacing: true });
		expect(r.dx).toBe(-1);
		expect(r.labels.filter((l) => l.kind === 'spacing').map((l) => l.text)).toEqual(['50', '50']);
	});

	it('spaces a box evenly before a pair of boxes, and in columns', () => {
		const t = VectorSnapTargets.forMove(doc([rect('a', 200, 0), rect('b', 300, 0)], 1000, 1000), []);
		expect(t.snapRect({ x: 98, y: 10, width: 50, height: 30 }, 4, { spacing: true }).dx).toBe(2);
		const col = VectorSnapTargets.forMove(doc([rect('a', 0, 600), rect('b', 0, 700)], 1000, 1000), []);
		const r = col.snapRect({ x: 10, y: 503, width: 30, height: 50 }, 4, { spacing: true });
		expect(r.dy).toBe(-3);
		expect(r.y).toBe(true);
	});

	it('prefers lining up over spacing, and leaves locked axes alone', () => {
		// c's left edge (203) is further than the even gap (200), but lining up comes first.
		const t = VectorSnapTargets.forMove(doc([rect('a', 0, 0), rect('b', 100, 0), rect('c', 203, 500)], 1000, 1000), []);
		const aligned = t.snapRect({ x: 201, y: 10, width: 50, height: 30 }, 4, { spacing: true });
		expect(aligned.dx).toBe(2);
		expect(aligned.lines.every((l) => l.kind === 'align')).toBe(true);
		const locked = t.snapRect({ x: 201, y: 2, width: 50, height: 30 }, 4, { spacing: true, axes: { x: false } });
		expect(locked).toMatchObject({ dx: 0, dy: -2, x: false, y: true });
	});
});

describe('VectorSnapTargets.snapScale', () => {
	// The neighbour spans 100–200 on both axes; the box (250, 100, 50 × 50) is resized beside it.
	const d = doc([rect('n', 100, 100, 100, 100), rect('box', 250, 100)]);
	const t = VectorSnapTargets.forResize(d, ['box']);
	const frame = { x: 250, y: 100, width: 50, height: 50, angle: 0 };
	const resize = (handle: 's' | 'se' | 'e', p: { x: number; y: number }, mods: { shift?: boolean; alt?: boolean } = {}) => {
		const { sx, sy } = scaleFor(handle, frame, p, mods);
		return t.snapScale(frame, handle, sx, sy, mods, 4);
	};

	it('lands the moving side on a target', () => {
		const r = resize('s', { x: 275, y: 197 });
		expect(r.sx).toBe(1);
		expect(r.sy).toBe(2);
		expect(r.lines).toHaveLength(1);
		expect(labels(r)).toEqual(['align']);
		// From the centre the dragged side still lands on the target.
		const c = resize('s', { x: 275, y: 198 }, { alt: true });
		expect(c.sy * 25 + 125).toBeCloseTo(200);
	});

	it('snaps each axis of a corner on its own, and keeps proportions with Shift', () => {
		const r = resize('se', { x: 330, y: 202 });
		expect(r.sx).toBeCloseTo(1.6);
		expect(r.sy).toBe(2);
		const p = resize('se', { x: 340, y: 198 }, { shift: true });
		expect(p.sx).toBe(2);
		expect(p.sy).toBe(2);
	});

	it("matches another object's width when no edge is in reach", () => {
		// 98 wide is 2 from the neighbour's 100.
		const r = resize('e', { x: 348, y: 125 });
		expect(r.sx).toBe(2);
		expect(r.snapped).toBe(true);
		expect(labels(r)).toEqual(['W 100']);
		expect(r.lines[0].kind).toBe('size');
	});

	it('leaves a resize out of reach alone', () => {
		const r = resize('s', { x: 275, y: 180 });
		expect(r).toMatchObject({ sx: 1, sy: 1.6, snapped: false, lines: [], labels: [] });
	});

	it('lands the corner of a rotated box on an anchor', () => {
		const rot = rotateMatrix(30);
		// The target sits where the corner (120, 110) of the box's own frame lands on the page.
		const target = applyMatrix(rot, { x: 120, y: 110 });
		const td = doc([rect('t', target.x, target.y, 10, 10)]);
		const tt = VectorSnapTargets.forResize(td, []);
		const f = { x: 0, y: 0, width: 100, height: 100, angle: 30 };
		const r = tt.snapScale(f, 'se', 1.19, 1.11, {}, 4);
		expect(r.sx).toBeCloseTo(1.2, 9);
		expect(r.sy).toBeCloseTo(1.1, 9);
		expect(labels(r)).toEqual(['anchor']);
	});
});

describe('VectorEditorController snapping', () => {
	const scene = () => doc([rect('a', 20, 20), rect('b', 200, 150)]);

	it('snaps a move to other objects and shows the guide', () => {
		const c = make(scene());
		c.pointerDown({ x: 40, y: 40 });
		c.pointerMove({ x: 100, y: 40 });
		c.pointerMove({ x: 167, y: 40 });
		// The right edge (197) lines up with b's left edge (200).
		expect(vectorNodeBounds(c.getNode('a')!)!.x).toBe(150);
		const guides = c.getState().guides!;
		expect(guides.lines).toEqual([{ kind: 'align', x1: 200, y1: 20, x2: 200, y2: 150 }]);
		expect(guides.labels.map((l) => l.text)).toEqual(['align']);
		c.pointerUp({ x: 167, y: 40 });
		expect(c.getState().guides).toBeNull();
		expect(vectorNodeBounds(c.getNode('a')!)!.x).toBe(150);
	});

	it('measures the pull in screen pixels', () => {
		const c = make(scene(), { viewport: { zoom: 2 } });
		c.pointerDown({ x: 80, y: 80 });
		c.pointerMove({ x: 334, y: 80 });
		// 3 document units off is 6 screen pixels at 2×: out of reach.
		expect(vectorNodeBounds(c.getNode('a')!)!.x).toBe(147);
		expect(c.getState().guides).toBeNull();
	});

	it('bypasses snapping while Cmd / Ctrl is held, and can be switched off', () => {
		const c = make(scene());
		c.pointerDown({ x: 40, y: 40 });
		c.pointerMove({ x: 167, y: 40 }, { mod: true });
		expect(vectorNodeBounds(c.getNode('a')!)!.x).toBe(147);
		expect(c.getState().guides).toBeNull();
		c.pointerMove({ x: 167, y: 40 });
		expect(vectorNodeBounds(c.getNode('a')!)!.x).toBe(150);
		c.pointerUp();
		c.undo();
		c.toggleSnapping();
		expect(c.getState().snap.objects).toBe(false);
		c.pointerDown({ x: 40, y: 40 });
		c.pointerMove({ x: 167, y: 40 });
		expect(vectorNodeBounds(c.getNode('a')!)!.x).toBe(147);
	});

	it('hides the guides but keeps the snap with guides off', () => {
		const c = make(scene(), { snap: { guides: false } });
		c.pointerDown({ x: 40, y: 40 });
		c.pointerMove({ x: 167, y: 40 });
		expect(vectorNodeBounds(c.getNode('a')!)!.x).toBe(150);
		expect(c.getState().guides).toBeNull();
	});

	it('gathers the targets once per gesture', () => {
		const spy = vi.spyOn(VectorSnapTargets, 'forMove');
		const c = make(scene());
		c.pointerDown({ x: 40, y: 40 });
		for (let x = 50; x < 170; x += 10) c.pointerMove({ x, y: 40 });
		c.pointerUp();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('falls back to the grid on an axis that lines up with nothing', () => {
		const c = make(scene(), { snap: { grid: 10 } });
		c.pointerDown({ x: 40, y: 40 });
		c.pointerMove({ x: 167, y: 84 });
		const b = vectorNodeBounds(c.getNode('a')!)!;
		expect(b.x).toBe(150);
		expect(b.y).toBe(60);
	});

	it('exposes the guides in screen space in the overlay', () => {
		const c = make(scene(), { viewport: { x: 10, y: 5, zoom: 1 } });
		c.pointerDown({ x: 50, y: 45 });
		c.pointerMove({ x: 177, y: 45 });
		const overlay = getVectorOverlayRenderData(c.getState());
		expect(overlay.guides.lines).toEqual([{ kind: 'align', x1: 210, y1: 25, x2: 210, y2: 155 }]);
		expect(overlay.guides.labels).toEqual([{ kind: 'align', x: 185, y: 50, text: 'align' }]);
		c.pointerUp();
		expect(getVectorOverlayRenderData(c.getState()).guides).toEqual({ lines: [], labels: [] });
	});

	it('snaps a selection-box resize', () => {
		const c = make(doc([rect('a', 20, 20), rect('b', 200, 20)]));
		c.select(['a']);
		const e = getVectorSelectionBoxGeometry(c.getState().selectionFrame!, c.getState().viewport).handles.find((h) => h.handle === 'e')!;
		c.pointerDown(e.screen);
		c.pointerMove({ x: 197, y: 45 });
		expect(vectorNodeBounds(c.getNode('a')!)!.width).toBeCloseTo(180, 9);
		// The side's top end passes b's corner, which comes before lining up.
		expect(c.getState().guides!.labels.map((l) => l.text)).toEqual(['anchor']);
	});

	it('snaps a dragged anchor onto a rotated node’s anchor, leaving the moving one out', () => {
		const r = rect('r', 200, 100, 100, 100, { transform: rotateMatrix(45, { x: 250, y: 150 }) });
		const p: VectorPathNode = { id: 'p', type: 'path', fill: null, stroke: '#000', subpaths: [{ closed: false, anchors: [{ x: 20, y: 20 }, { x: 60, y: 20 }] }] };
		const c = make(doc([r, p]));
		c.setTool('direct');
		c.select(['p']);
		const right = getAnchorWorld(c.getDocument(), { nodeId: 'r', subpath: 0, index: 1 })!;
		c.pointerDown({ x: 60, y: 20 });
		c.pointerMove({ x: right.x - 2, y: right.y + 1 });
		const moved = getAnchorWorld(c.getDocument(), { nodeId: 'p', subpath: 0, index: 1 })!;
		expect(moved.x).toBeCloseTo(right.x, 9);
		expect(moved.y).toBeCloseTo(right.y, 9);
		expect(c.getState().guides!.labels.map((l) => l.text)).toEqual(['anchor']);
	});

	it('snaps dragged handles', () => {
		const p: VectorPathNode = {
			id: 'p',
			type: 'path',
			fill: null,
			stroke: '#000',
			subpaths: [{ closed: false, anchors: [{ x: 20, y: 20, out: { x: 50, y: 60 } }, { x: 100, y: 20 }] }]
		};
		const c = make(doc([p, rect('t', 150, 200)]));
		c.setTool('direct');
		c.selectAnchors([{ nodeId: 'p', subpath: 0, index: 0 }]);
		c.pointerDown({ x: 50, y: 60 });
		c.pointerMove({ x: 148, y: 201 });
		expect(getAnchorWorld(c.getDocument(), { nodeId: 'p', subpath: 0, index: 0 })!.out).toEqual({ x: 150, y: 200 });
	});

	it('snaps pen clicks and shows the guide while hovering', () => {
		const c = make(scene());
		c.setTool('pen');
		c.pointerMove({ x: 69, y: 71 });
		expect(c.getState().pointer).toEqual({ x: 70, y: 70 });
		expect(c.getState().guides!.labels.map((l) => l.text)).toEqual(['anchor']);
		c.pointerDown({ x: 69, y: 71 });
		c.pointerUp({ x: 69, y: 71 });
		const pen = c.getState().pen!;
		expect(getAnchorWorld(c.getDocument(), { nodeId: pen.nodeId, subpath: 0, index: 0 })).toMatchObject({ x: 70, y: 70 });
		// The next point lands on the construction guide through the first.
		c.pointerDown({ x: 130, y: 72 });
		c.pointerUp({ x: 130, y: 72 });
		expect(getAnchorWorld(c.getDocument(), { nodeId: pen.nodeId, subpath: 0, index: 1 })).toMatchObject({ x: 130, y: 70 });
	});

	it('snaps the shape tools’ start and corner, matching sizes', () => {
		const c = make(scene());
		c.setTool('rect');
		c.pointerDown({ x: 71, y: 21 });
		// 49 wide is 1 from the other squares' 50; nothing matches or lines up with a height of 110.
		c.pointerMove({ x: 120, y: 130 });
		const id = c.getState().interaction?.type === 'draw' ? (c.getState().interaction as { nodeId: string }).nodeId : '';
		const b = vectorNodeBounds(c.getNode(id)!)!;
		expect(b).toEqual({ x: 70, y: 20, width: 50, height: 110 });
		expect(c.getState().guides!.labels.map((l) => l.text)).toContain('W 50');
	});
});
