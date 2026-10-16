import { describe, expect, it } from 'vitest';
import {
	bendSegment,
	bezierToSubpaths,
	curvatureMoveAnchor,
	cutSubpathAt,
	ellipseSubpath,
	eraseFromFill,
	eraseFromOutline,
	eraserRegion,
	insertAnchor,
	joinSubpaths,
	knifePath,
	LazyMouse,
	recognizeInkShape,
	rectSubpath,
	removeAnchorKeepingShape,
	removeAnchorsKeepingShape,
	removeRedundantPoints,
	simplifyPolyline,
	smoothSubpath,
	splitIntoFaces,
	splitSubpathAt,
	subpathPointAt,
	subpathSegment,
	subpathsToBezier,
	vectorInkShapeName,
	type VectorInkShape,
	type VectorSubpath
} from '../src/vector/index.js';
import { bezierPathArea, bezierPathBounds, segmentNearest, segmentPoint, pathToContours } from '../src/canvas/pathops/index.js';
import type { Point } from '../src/canvas/types.js';

/** Largest distance from points of `a`'s outline to `b`'s outline (both subpath lists). */
function deviation(a: VectorSubpath[], b: VectorSubpath[]): number {
	const segsOf = (list: VectorSubpath[]) => list.flatMap((sp) => Array.from({ length: sp.closed ? sp.anchors.length : sp.anchors.length - 1 }, (_, i) => subpathSegment(sp, i)));
	const sa = segsOf(a);
	const sb = segsOf(b);
	let worst = 0;
	for (const s of sa) {
		for (let i = 0; i <= 40; i++) {
			const p = segmentPoint(s, i / 40);
			worst = Math.max(worst, Math.min(...sb.map((t) => segmentNearest(t, p).distance)));
		}
	}
	return worst;
}

const area = (path: Parameters<typeof bezierPathArea>[0]) => bezierPathArea(path);

describe('removing anchors without changing the shape', () => {
	it('recovers a cubic that was split in two', () => {
		const sp = bezierToSubpaths('M0 0 C40 -80 160 -80 200 0')[0];
		const { subpath } = insertAnchor(sp, 0, 0.37);
		expect(subpath.anchors).toHaveLength(3);
		const back = removeAnchorKeepingShape(subpath, 1);
		expect(back.anchors).toHaveLength(2);
		expect(deviation([sp], [back])).toBeLessThan(1e-3);
		expect(deviation([back], [sp])).toBeLessThan(1e-3);
	});

	it('keeps an ellipse round and closed after losing an anchor', () => {
		const sp = ellipseSubpath({ x: 0, y: 0, width: 200, height: 100 });
		const kept = removeAnchorKeepingShape(sp, 1);
		expect(kept.closed).toBe(true);
		expect(kept.anchors).toHaveLength(3);
		// Plain removal (handles untouched) strays much further from the original.
		const plain: VectorSubpath = { closed: true, anchors: sp.anchors.filter((_, i) => i !== 1) };
		expect(deviation([sp], [kept])).toBeLessThan(2);
		expect(deviation([sp], [kept])).toBeLessThan(deviation([sp], [plain]) / 4);
	});

	it('follows an S-curve closer than a curve forced through the removed point would', () => {
		const sp = bezierToSubpaths('M0 0 C30 -60 70 -60 100 0 C130 60 170 60 200 0')[0];
		const kept = removeAnchorKeepingShape(sp, 1);
		expect(kept.anchors).toHaveLength(2);
		// The neighbours keep their handle directions.
		expect(kept.anchors[0].out!.x / kept.anchors[0].out!.y).toBeCloseTo(30 / -60, 6);
		expect(deviation([sp], [kept])).toBeLessThan(4);
	});

	it('joins two straight segments into one and drops ends of open paths', () => {
		const rect = rectSubpath({ x: 0, y: 0, width: 100, height: 50 });
		const tri = removeAnchorKeepingShape(rect, 2);
		expect(tri.anchors).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 50 }]);
		expect(tri.closed).toBe(true);
		const open = bezierToSubpaths('M0 0 C10 -20 30 -20 40 0 C50 20 70 20 80 0')[0];
		const end = removeAnchorKeepingShape(open, 2);
		expect(end.anchors).toHaveLength(2);
		expect(end.anchors[1].out).toBeUndefined();
		expect(end.anchors[1].in).toEqual({ x: 30, y: -20 });
		const start = removeAnchorKeepingShape(open, 0);
		expect(start.anchors[0].in).toBeUndefined();
	});

	it('removes several anchors and downgrades a symmetric pair that is no longer equal', () => {
		const sp = bezierToSubpaths('M0 0 C20 -40 40 -40 60 0 C80 40 100 40 120 0 C140 -40 160 -40 180 0 C200 40 220 40 240 0')[0];
		const out = removeAnchorsKeepingShape(sp, [1, 3]);
		expect(out.anchors).toHaveLength(3);
		for (const a of out.anchors) if (a.type === 'symmetric') expect(Math.hypot(a.in!.x - a.x, a.in!.y - a.y)).toBeCloseTo(Math.hypot(a.out!.x - a.x, a.out!.y - a.y), 6);
		expect(removeAnchorKeepingShape(sp, 99)).toEqual({ anchors: sp.anchors, closed: false });
	});
});

describe('bending a segment', () => {
	it('bends a straight segment so it passes through the pointer at the grabbed parameter', () => {
		const sp = rectSubpath({ x: 0, y: 0, width: 100, height: 100 });
		const bent = bendSegment(sp, 0, 0.5, { x: 50, y: -30 });
		const p = subpathPointAt(bent, 0, 0.5);
		expect(p.x).toBeCloseTo(50, 9);
		expect(p.y).toBeCloseTo(-30, 9);
		// Both handles take the same offset from the chord's thirds.
		expect(bent.anchors[0].out).toEqual({ x: 100 / 3, y: -40 });
		expect(bent.anchors[1].in!.x).toBeCloseTo(200 / 3, 9);
		expect(bent.anchors[1].in!.y).toBeCloseTo(-40, 9);
		// The corners stay corners: their other segments do not move.
		expect(bent.anchors[0].in).toBeUndefined();
		expect(bent.anchors[1].out).toBeUndefined();
	});

	it('bends a curve through the pointer off-centre, clamping t near the ends', () => {
		const sp = bezierToSubpaths('M0 0 C10 -50 90 -10 100 0')[0];
		const bent = bendSegment(sp, 0, 0.25, { x: 30, y: 20 });
		const p = subpathPointAt(bent, 0, 0.25);
		expect(p.x).toBeCloseTo(30, 9);
		expect(p.y).toBeCloseTo(20, 9);
		const end = bendSegment(sp, 0, 0, { x: 10, y: 10 });
		const q = subpathPointAt(end, 0, 0.05);
		expect(q.x).toBeCloseTo(10, 9);
		expect(q.y).toBeCloseTo(10, 9);
	});

	it('keeps smooth end anchors smooth', () => {
		const sp = ellipseSubpath({ x: 0, y: 0, width: 100, height: 100 });
		const bent = bendSegment(sp, 0, 0.5, { x: 90, y: 0 });
		const a = bent.anchors[0];
		const cross = (a.in!.x - a.x) * (a.out!.y - a.y) - (a.in!.y - a.y) * (a.out!.x - a.x);
		expect(Math.abs(cross)).toBeLessThan(1e-6);
	});
});

describe('Curvature-tool anchor moves', () => {
	it('moves a corner without handles and scales the neighbours’ facing handles with their chords', () => {
		const sp = bezierToSubpaths('M0 0 C0 -30 0 -30 50 -50 L100 0 C120 20 140 20 160 0')[0];
		// Anchor 1 at (50, -50): incoming curve, outgoing line.
		const moved = curvatureMoveAnchor(sp, 1, { x: 50, y: -100 });
		const before = Math.hypot(50, 50);
		const afterPrev = Math.hypot(50, 100);
		expect(moved.anchors[1]).toMatchObject({ x: 50, y: -100 });
		// The previous anchor's out handle keeps its direction, its length scaled by the chord.
		expect(moved.anchors[0].out!.x).toBeCloseTo(0, 9);
		expect(moved.anchors[0].out!.y).toBeCloseTo((-30 * afterPrev) / before, 9);
		// The segment beyond the next anchor does not change.
		expect(moved.anchors[2]).toEqual(sp.anchors[2]);
		expect(moved.anchors[3]).toEqual(sp.anchors[3]);
		expect(moved.anchors[1].out).toBeUndefined();
	});

	it('turns a smooth anchor along the line through its neighbours', () => {
		const sp = ellipseSubpath({ x: 0, y: 0, width: 100, height: 100 });
		const moved = curvatureMoveAnchor(sp, 0, { x: 80, y: -20 });
		const a = moved.anchors[0];
		const prev = sp.anchors[3];
		const next = sp.anchors[1];
		const d = [next.x - prev.x, next.y - prev.y];
		const h = [a.out!.x - a.x, a.out!.y - a.y];
		expect(Math.abs(d[0] * h[1] - d[1] * h[0])).toBeLessThan(1e-6);
		expect(a.in!.x + a.out!.x).toBeCloseTo(2 * a.x, 6); // symmetric stays symmetric
		expect(moved.anchors[2]).toEqual(sp.anchors[2]);
	});
});

describe('Scissors', () => {
	it('opens a closed subpath at one anchor, keeping the shape', () => {
		const rect = rectSubpath({ x: 0, y: 0, width: 100, height: 50 });
		const [piece, ...rest] = cutSubpathAt(rect, [1]);
		expect(rest).toHaveLength(0);
		expect(piece.closed).toBe(false);
		expect(piece.anchors.map((a) => [a.x, a.y])).toEqual([[100, 0], [100, 50], [0, 50], [0, 0], [100, 0]]);
	});

	it('splits an open curve in two at a point without moving it, and ignores its ends', () => {
		const sp = bezierToSubpaths('M0 0 C40 -80 160 -80 200 0')[0];
		const pieces = splitSubpathAt(sp, 0, 0.5);
		expect(pieces).toHaveLength(2);
		expect(pieces[0].anchors[1]).toMatchObject({ x: 100, y: -60 });
		expect(pieces[0].anchors[1].out).toBeUndefined();
		expect(pieces[1].anchors[0].in).toBeUndefined();
		expect(deviation(pieces, [sp])).toBeLessThan(1e-9);
		expect(cutSubpathAt(sp, [0, 1])).toEqual([sp]);
		const cutTwice = cutSubpathAt(rectSubpath({ x: 0, y: 0, width: 10, height: 10 }), [0, 2]);
		expect(cutTwice.map((p) => p.anchors.length)).toEqual([3, 3]);
	});
});

describe('Join, Smooth and Remove Redundant Points', () => {
	const line = (a: Point, b: Point): VectorSubpath => ({ anchors: [{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }], closed: false });

	it('joins nearest endpoints first, merging those within the tolerance', () => {
		const out = joinSubpaths([line([0, 0], [50, 0]), line([100, 0], [50.2, 0.1]), line([150, 0], [200, 0])], 0.5);
		expect(out).toHaveLength(1);
		expect(out[0].anchors.map((a) => [a.x, a.y])).toEqual([[0, 0], [50, 0], [100, 0], [150, 0], [200, 0]]);
	});

	it('closes a single open subpath, merging ends that meet', () => {
		const tri: VectorSubpath = { anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }, { x: 0.1, y: 0, in: { x: 10, y: 20 } }], closed: false };
		const [closed] = joinSubpaths([tri], 1);
		expect(closed.closed).toBe(true);
		expect(closed.anchors).toHaveLength(3);
		expect(closed.anchors[0].in).toEqual({ x: 10, y: 20 });
		const [open] = joinSubpaths([line([0, 0], [10, 10])], 1);
		expect(open).toMatchObject({ closed: true, anchors: [{ x: 0, y: 0 }, { x: 10, y: 10 }] });
	});

	it('smooths corners towards Catmull-Rom tangents', () => {
		const square = rectSubpath({ x: 0, y: 0, width: 90, height: 90 });
		const round = smoothSubpath(square, 1);
		expect(round.anchors.every((a) => a.type === 'symmetric')).toBe(true);
		expect(round.anchors[0].out!.x).toBeCloseTo(30 / Math.SQRT2, 9);
		expect(round.anchors[0].out!.y).toBeCloseTo(-30 / Math.SQRT2, 9);
		expect(smoothSubpath(square, 0)).toEqual(square);
		const some = smoothSubpath(square, 0.5, new Set([2]));
		expect(some.anchors[0]).toEqual(square.anchors[0]);
		expect(some.anchors[2].in).toBeDefined();
	});

	it('removes collinear and duplicate points and merges smooth joints that one cubic can replace', () => {
		const sp: VectorSubpath = { anchors: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], closed: false };
		expect(removeRedundantPoints(sp, 0.01).anchors.map((a) => [a.x, a.y])).toEqual([[0, 0], [100, 0], [100, 100]]);
		const curve = bezierToSubpaths('M0 0 C40 -80 160 -80 200 0')[0];
		const split = insertAnchor(insertAnchor(curve, 0, 0.3).subpath, 1, 0.5).subpath;
		const merged = removeRedundantPoints(split, 0.25);
		expect(merged.anchors).toHaveLength(2);
		expect(deviation([curve], [merged])).toBeLessThan(0.25);
		// A corner of a closed shape stays.
		expect(removeRedundantPoints(rectSubpath({ x: 0, y: 0, width: 10, height: 10 }), 0.01).anchors).toHaveLength(4);
	});
});

describe('Knife', () => {
	const rectPath = (x: number, y: number, w: number, h: number) => subpathsToBezier([rectSubpath({ x, y, width: w, height: h })]);

	it('cuts a rectangle in two along a line, with no gap between the pieces', () => {
		const pieces = knifePath(rectPath(0, 0, 100, 60), 'nonzero', [
			[40, -20],
			[60, 80]
		])!;
		expect(pieces).toHaveLength(2);
		expect(area(pieces[0]) + area(pieces[1])).toBeCloseTo(6000, 6);
		// The pieces share the cut edge exactly: their union has no slit.
		const xs = pieces.map((p) => bezierPathBounds(p)!);
		expect(Math.min(xs[0].maxX, xs[1].maxX)).toBeCloseTo(56, 9);
		expect(Math.max(xs[0].minX, xs[1].minX)).toBeCloseTo(44, 9);
	});

	it('follows a bent polyline and cuts a circle without approximating it', () => {
		const circle = subpathsToBezier([ellipseSubpath({ x: 0, y: 0, width: 100, height: 100 })]);
		const pieces = knifePath(circle, 'nonzero', [
			[-10, 50],
			[50, 30],
			[110, 50]
		])!;
		expect(pieces).toHaveLength(2);
		expect(area(pieces[0]) + area(pieces[1])).toBeCloseTo(area(circle), 6);
		// The curved arcs stay cubics.
		expect(pieces.flat().some((c) => c.type === 'C')).toBe(true);
	});

	it('does not cut when the stroke starts or ends inside the shape', () => {
		expect(knifePath(rectPath(0, 0, 100, 100), 'nonzero', [[-10, 50], [50, 50]])).toBeNull();
		expect(knifePath(rectPath(0, 0, 100, 100), 'nonzero', [[20, 50], [80, 50]])).toBeNull();
		expect(knifePath(rectPath(0, 0, 100, 100), 'nonzero', [[-10, -10], [-20, 200]])).toBeNull();
	});

	it('cuts a ring into two pieces: each cut through it joins the outline to the hole first', () => {
		const ring = [...rectPath(0, 0, 100, 100), ...subpathsToBezier([{ ...rectSubpath({ x: 30, y: 30, width: 40, height: 40 }), anchors: rectSubpath({ x: 30, y: 30, width: 40, height: 40 }).anchors.slice().reverse() }])];
		const once = knifePath(ring, 'nonzero', [[50, -10], [50, 50]])!;
		expect(once).toHaveLength(1);
		expect(area(once[0])).toBeCloseTo(8400, 6);
		const twice = knifePath(ring, 'nonzero', [[50, -10], [50, 110]])!;
		expect(twice).toHaveLength(2);
		expect(area(twice[0])).toBeCloseTo(4200, 6);
		expect(area(twice[1])).toBeCloseTo(4200, 6);
	});

	it('makes several cuts with one zig-zag stroke', () => {
		const pieces = knifePath(rectPath(0, 0, 100, 40), 'nonzero', [
			[20, -10],
			[20, 50],
			[50, 50],
			[50, -10],
			[80, -10],
			[80, 50]
		])!;
		expect(pieces).toHaveLength(4);
		expect(pieces.map(area).sort((a, b) => a - b)).toEqual([800, 800, 1200, 1200].map((v) => expect.closeTo(v, 6)));
	});

	it('splits a compound result into faces with their holes', () => {
		const two = [...rectPath(0, 0, 10, 10), ...rectPath(20, 0, 10, 10)];
		expect(splitIntoFaces(two)).toHaveLength(2);
	});
});

describe('Eraser', () => {
	it('erases a swath out of a filled shape, leaving separate pieces', () => {
		const rect = subpathsToBezier([rectSubpath({ x: 0, y: 0, width: 100, height: 40 })]);
		const region = eraserRegion([[50, -20], [50, 60]], 10);
		const pieces = eraseFromFill(rect, 'nonzero', region)!;
		expect(pieces).toHaveLength(2);
		expect(area(pieces[0]) + area(pieces[1])).toBeCloseTo(3600, 4);
		expect(eraseFromFill(rect, 'nonzero', eraserRegion([[300, 300]], 10))).toBeNull();
	});

	it('cuts an outline where it crosses the eraser, keeping the original curves', () => {
		const curve = bezierToSubpaths('M0 0 C40 -80 160 -80 200 0')[0];
		const region = eraserRegion([[100, -100], [100, 20]], 20);
		const pieces = eraseFromOutline(curve, region)!;
		expect(pieces).toHaveLength(2);
		expect(pieces[0].anchors[1].x).toBeCloseTo(90, 6);
		expect(pieces[1].anchors[0].x).toBeCloseTo(110, 6);
		expect(deviation(pieces, [curve])).toBeLessThan(1e-9);
		expect(eraseFromOutline(curve, eraserRegion([[500, 500]], 5))).toBeNull();
	});

	it('joins the pieces of a closed outline across its first anchor', () => {
		const square = rectSubpath({ x: 0, y: 0, width: 100, height: 100 });
		const pieces = eraseFromOutline(square, eraserRegion([[50, 100]], 20))!;
		expect(pieces).toHaveLength(1);
		expect(pieces[0].anchors.map((a) => [a.x, a.y])).toEqual([[40, 100], [0, 100], [0, 0], [100, 0], [100, 100], [60, 100]]);
		// Erasing everything leaves nothing.
		expect(eraseFromOutline(square, eraserRegion([[50, 50]], 400))).toEqual([]);
	});

	it('simplifies a dense polyline before outlining it', () => {
		const pts: Point[] = Array.from({ length: 101 }, (_, i) => [i, Math.sin(i / 100) * 0.01]);
		expect(simplifyPolyline(pts, 0.1)).toEqual([pts[0], pts[100]]);
		expect(pathToContours(eraserRegion(pts, 4)).length).toBe(1);
	});
});

describe('Pencil helpers', () => {
	it('lazy mouse holds the pen back by the string length and catches up at the end', () => {
		const lazy = new LazyMouse(10);
		expect(lazy.push([0, 0])).toEqual([[0, 0]]);
		expect(lazy.push([6, 0])).toEqual([]);
		expect(lazy.string()).toEqual([[0, 0], [6, 0]]);
		expect(lazy.push([25, 0])).toEqual([[15, 0]]);
		expect(lazy.finish()).toEqual([[25, 0]]);
		expect(lazy.string()).toBeNull();
		const off = new LazyMouse(0);
		expect(off.push([3, 4])).toEqual([[3, 4]]);
		expect(off.finish()).toEqual([]);
	});

	/** Points around a polygon, `per` to a side, with a little regular wobble. */
	const around = (corners: Point[], per: number): Point[] => {
		const out: Point[] = [];
		corners.forEach((a, i) => {
			const b = corners[(i + 1) % corners.length];
			for (let k = 0; k < per; k++) {
				const t = k / per;
				const w = Math.cos(out.length * 2.3) * 0.5;
				out.push([a[0] + (b[0] - a[0]) * t + w, a[1] + (b[1] - a[1]) * t + w]);
			}
		});
		out.push(corners[0]);
		return out;
	};
	const ring = (cx: number, cy: number, rx: number, ry: number): Point[] => Array.from({ length: 49 }, (_, i) => [cx + rx * Math.cos((i / 48) * 2 * Math.PI), cy + ry * Math.sin((i / 48) * 2 * Math.PI)]);
	const name = (s: VectorInkShape | null) => (s ? vectorInkShapeName(s) : null);

	it('recognises rectangles, squares, ellipses, circles, lines and polygons', () => {
		const rect = recognizeInkShape(around([[60, 20], [140, 20], [140, 70], [20, 70], [20, 20]], 10));
		expect(rect).toMatchObject({ kind: 'rect' });
		const r = rect as Extract<VectorInkShape, { kind: 'rect' }>;
		expect(Math.abs(r.x - 20)).toBeLessThan(2);
		expect(Math.abs(r.width - 120)).toBeLessThan(3);
		expect(name(recognizeInkShape(around([[0, 0], [80, 0], [80, 76], [0, 76]], 10)))).toBe('square');
		const e = recognizeInkShape(ring(100, 100, 50, 30)) as Extract<VectorInkShape, { kind: 'ellipse' }>;
		expect(e.kind).toBe('ellipse');
		expect(e.x).toBeCloseTo(50, 1);
		expect(e.height).toBeCloseTo(60, 1);
		expect(name(recognizeInkShape(ring(0, 0, 40, 39)))).toBe('circle');
		const wobbly: Point[] = Array.from({ length: 31 }, (_, i) => [i * 4, i * 2 + Math.sin(i) * 0.7]);
		expect(recognizeInkShape(wobbly)).toEqual({ kind: 'line', a: wobbly[0], b: wobbly[30] });
		expect(name(recognizeInkShape(around([[0, 90], [50, 0], [100, 90]], 14)))).toBe('triangle');
		const hexagon: Point[] = Array.from({ length: 6 }, (_, i) => [70 + 60 * Math.cos((i * Math.PI) / 3), 70 + 60 * Math.sin((i * Math.PI) / 3)]);
		expect(name(recognizeInkShape(around(hexagon, 10)))).toBe('polygon');
	});

	it('leaves scribbles, hooks, taps and junk as ink', () => {
		const zigzag: Point[] = Array.from({ length: 16 }, (_, i) => [i * 10, i % 2 ? 40 : 0]);
		expect(recognizeInkShape(zigzag)).toBeNull();
		expect(recognizeInkShape([[0, 0], [60, 0], [60, 60]])).toBeNull();
		expect(recognizeInkShape([[1, 1]])).toBeNull();
		expect(recognizeInkShape([[0, 0], [2, 2]])).toBeNull();
		const spiky: Point[] = Array.from({ length: 29 }, (_, i) => {
			const a = (i / 28) * 2 * Math.PI;
			const r = i % 2 ? 25 : 70;
			return [100 + r * Math.cos(a), 100 + r * Math.sin(a)];
		});
		expect(recognizeInkShape(spiky)).toBeNull();
		expect(recognizeInkShape([[NaN, 0], [Infinity, 1], [0, -Infinity]])).toBeNull();
		expect(recognizeInkShape([])).toBeNull();
		// A small stroke counts when the minimum size is lowered (e.g. zoomed in).
		expect(recognizeInkShape([[0, 0], [4, 0]], { minSize: 1 })).toMatchObject({ kind: 'line' });
	});
});
