/**
 * Curve-preserving path operations: booleans, divide, offset path, outline stroke, dashes
 * and arc-length utilities.
 *
 * Portions re-expressed from vectorcraft-main/crates/pathops/tests/{ops.rs,props.rs,
 * prop_pathops.rs}, crates/pathops/src/offset.rs and crates/engine/src/tests_outlinestroke.rs
 * (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
 */
import { describe, it, expect } from 'vitest';
import {
	bezierPathArea,
	bezierPathBounds,
	bezierPathLength,
	bezierPathPointAtLength,
	bezierPathSignedArea,
	bezierPathToSvg,
	countPathSegments,
	dashContours,
	distanceToBezierPath,
	dividePaths,
	excludePaths,
	intersectPaths,
	normalizeBezierPath,
	offsetPath,
	outlineStroke,
	pathBoolean,
	pathToContours,
	pointInBezierPath,
	segmentLength,
	segmentParamAtLength,
	segmentNearest,
	segmentPoint,
	subSegment,
	subtractPaths,
	toBezierPath,
	transformBezierPath,
	trimSegments,
	unitePaths,
	arcToCubics,
	strokeOutlineRings,
	type BezierPath,
	type BezierPathInput,
	type StrokeJoin
} from '../src/canvas/pathops';
import { polygonBoolean } from '../src/canvas/polygonBoolean';
import { flattenSvgPath } from '../src/canvas/shapeGeometry';
import type { Point } from '../src/canvas/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
const circle = (cx: number, cy: number, r: number) =>
	`M${cx - r} ${cy}A${r} ${r} 0 1 1 ${cx + r} ${cy}A${r} ${r} 0 1 1 ${cx - r} ${cy}Z`;
const ellipse = (cx: number, cy: number, rx: number, ry: number, deg = 0) => {
	const a = (deg * Math.PI) / 180;
	const sx = cx - rx * Math.cos(a);
	const sy = cy - rx * Math.sin(a);
	const ex = cx + rx * Math.cos(a);
	const ey = cy + rx * Math.sin(a);
	return `M${sx} ${sy}A${rx} ${ry} ${deg} 1 1 ${ex} ${ey}A${rx} ${ry} ${deg} 1 1 ${sx} ${sy}Z`;
};
const polygon = (pts: Point[]) => `M${pts.map((p) => `${p[0]} ${p[1]}`).join('L')}Z`;

const area = (p: BezierPathInput, rule: 'nonzero' | 'evenodd' = 'nonzero') => bezierPathArea(p, rule);
const segs = (p: BezierPathInput) => {
	const c = countPathSegments(p);
	return c.lines + c.quads + c.cubics;
};
const subpaths = (p: BezierPathInput) => pathToContours(p).length;
const close = (a: number, b: number, rel: number) => Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b), 1);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function starPolygon(random: () => number, cx: number, cy: number, radius: number, n: number): Point[] {
	const out: Point[] = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2;
		const r = radius * (0.35 + 0.65 * random());
		out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
	}
	return out;
}

function convexPolygon(random: () => number, cx: number, cy: number, radius: number): Point[] {
	const n = 3 + Math.floor(random() * 7);
	const angles = Array.from({ length: n }, () => random() * Math.PI * 2).sort((a, b) => a - b);
	return angles.map((a) => [cx + radius * Math.cos(a), cy + radius * Math.sin(a)] as Point);
}

/** A smooth closed blob of cubic segments (Catmull-Rom through random radial points). */
function blob(random: () => number, cx: number, cy: number, radius: number, n = 5): string {
	const pts = starPolygon(random, cx, cy, radius, n);
	let d = `M${pts[0][0]} ${pts[0][1]}`;
	for (let i = 0; i < n; i++) {
		const p0 = pts[(i - 1 + n) % n];
		const p1 = pts[i];
		const p2 = pts[(i + 1) % n];
		const p3 = pts[(i + 2) % n];
		const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
		const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
		d += `C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p2[0]} ${p2[1]}`;
	}
	return d + 'Z';
}

/** Random closed shape inside [0, 230]²: rectangle, circle, rotated ellipse, star polygon or blob. */
function randomShape(random: () => number): string {
	const kind = Math.floor(random() * 5);
	const cx = 40 + random() * 150;
	const cy = 40 + random() * 150;
	const r = 10 + random() * 35;
	switch (kind) {
		case 0:
			return rect(cx - r, cy - r * 0.7, r * (1 + random()), r * (0.5 + random()));
		case 1:
			return circle(cx, cy, r);
		case 2:
			return ellipse(cx, cy, r, r * (0.3 + 0.7 * random()), random() * 180);
		case 3:
			return polygon(starPolygon(random, cx, cy, r, 5 + Math.floor(random() * 8)));
		default:
			return blob(random, cx, cy, r, 4 + Math.floor(random() * 4));
	}
}

/** A normalised result: its signed area equals its filled area (no overlaps, consistent orientation). */
function expectClean(p: BezierPath, rel = 1e-6) {
	expect(close(Math.abs(bezierPathSignedArea(p)), area(p), rel)).toBe(true);
	expect(close(area(p), area(p, 'evenodd'), rel)).toBe(true);
}

const lens = (r: number, d: number) => 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d);
/** Area of the 4-cubic approximation of a circle (slightly larger than πr²). */
const cubicCircleArea = (r: number) => bezierPathSignedArea(circle(0, 0, r));

// ---------------------------------------------------------------------------
// Path model
// ---------------------------------------------------------------------------

describe('Bézier path model', () => {
	it('parses SVG data, turning arcs into at most 90° cubics', () => {
		const c = toBezierPath(circle(0, 0, 10));
		expect(c.filter((x) => x.type === 'C')).toHaveLength(4);
		expect(c[c.length - 1]).toEqual({ type: 'Z' });
		const p = toBezierPath('m10 10 h10 v10 q-5 5 -10 0 t-5 -5 s1 1 2 2 z');
		expect(p.map((x) => x.type)).toEqual(['M', 'L', 'L', 'Q', 'Q', 'C', 'Z']);
		expect(arcToCubics([0, 0], { rx: 5, ry: 5, rotation: 0, largeArc: false, sweep: true, x: 10, y: 0 })).toHaveLength(2);
		expect(arcToCubics([0, 0], { rx: 0, ry: 5, rotation: 0, largeArc: false, sweep: true, x: 10, y: 0 })).toEqual([
			[
				[0, 0],
				[10, 0]
			]
		]);
		// Round trip through SVG text.
		const d = bezierPathToSvg(p, { precision: 4 });
		expect(bezierPathToSvg(toBezierPath(d), { precision: 4 })).toBe(d);
	});

	it('measures exact areas, bounds and windings of curves', () => {
		expect(bezierPathSignedArea(rect(0, 0, 10, 20))).toBe(200);
		expect(Math.abs(bezierPathSignedArea(circle(0, 0, 10)) / (Math.PI * 100) - 1)).toBeLessThan(3e-4);
		// A quadratic: area under y = 1 − x² style parabola with control (0, 2): 4/3 · base · height / 2.
		expect(bezierPathSignedArea('M-1 0Q0 2 1 0Z')).toBeCloseTo(-4 / 3, 12);
		expect(bezierPathBounds(circle(5, 5, 10))).toEqual({ minX: -5, minY: -5, maxX: 15, maxY: 15 });
		expect(bezierPathBounds('M0 0C0 10 10 10 10 0')!.maxY).toBeCloseTo(7.5, 12);
		expect(pointInBezierPath(circle(0, 0, 10), [7, 7])).toBe(true);
		expect(pointInBezierPath(circle(0, 0, 10), [7.2, 7.2])).toBe(false);
		const ring = `${rect(0, 0, 10, 10)}${rect(3, 3, 4, 4)}`;
		expect(pointInBezierPath(ring, [5, 5], 'nonzero')).toBe(true);
		expect(pointInBezierPath(ring, [5, 5], 'evenodd')).toBe(false);
		expect(distanceToBezierPath(circle(0, 0, 10), [20, 0])).toBeCloseTo(10, 9);
	});

	it('transforms paths exactly', () => {
		const t = transformBezierPath(circle(0, 0, 10), [2, 0, 0, 3, 5, 7]);
		expect(bezierPathBounds(t)).toEqual({ minX: -15, minY: -23, maxX: 25, maxY: 37 });
		expect(bezierPathSignedArea(t)).toBeCloseTo(cubicCircleArea(10) * 6, 9);
	});
});

describe('arc length', () => {
	it('measures lines and curves and inverts arc length', () => {
		expect(bezierPathLength('M0 0L30 40')).toBe(50);
		expect(bezierPathLength(rect(0, 0, 10, 20))).toBe(60);
		expect(bezierPathLength(circle(0, 0, 10)) / (2 * Math.PI * 10)).toBeCloseTo(1, 3);
		const c: Point[] = [
			[0, 0],
			[0, 55],
			[45, 100],
			[100, 100]
		];
		const total = segmentLength(c);
		for (const f of [0.1, 0.33, 0.5, 0.9]) {
			const t = segmentParamAtLength(c, total * f, total);
			expect(segmentLength(c, 0, t) / total).toBeCloseTo(f, 9);
		}
		// Halves add up.
		expect(segmentLength(c, 0, 0.5) + segmentLength(c, 0.5, 1)).toBeCloseTo(total, 9);
	});

	it('finds points and tangents along a path', () => {
		const at = bezierPathPointAtLength('M0 0L10 0L10 10', 15)!;
		expect(at.point).toEqual([10, 5]);
		expect(at.angle).toBeCloseTo(Math.PI / 2, 12);
		expect(bezierPathPointAtLength('M0 0L10 0', 99)!.point).toEqual([10, 0]);
		expect(bezierPathPointAtLength('', 1)).toBeNull();
	});

	it('trims segment chains by arc length', () => {
		const chain: Point[][] = [
			[
				[0, 0],
				[10, 0]
			],
			[
				[10, 0],
				[10, 10]
			]
		];
		const piece = trimSegments(chain, 5, 15);
		expect(piece).toEqual([
			[
				[5, 0],
				[10, 0]
			],
			[
				[10, 0],
				[10, 5]
			]
		]);
		const curve: Point[] = [
			[0, 0],
			[30, 60],
			[70, 60],
			[100, 0]
		];
		const sub = subSegment(curve, 0.25, 0.75);
		for (const t of [0, 0.3, 1]) expect(segmentNearest(curve, segmentPoint(sub, t)).distance).toBeLessThan(1e-9);
		expect(subSegment(curve, 0.75, 0.25)[0]).toEqual(sub[3]);
	});
});

// ---------------------------------------------------------------------------
// Booleans (vectorcraft ops.rs cases)
// ---------------------------------------------------------------------------

describe('pathBoolean: basic operations', () => {
	it('unites, intersects, subtracts and excludes rectangles with minimal anchors', () => {
		const a = rect(0, 0, 10, 10);
		const b = rect(5, 5, 10, 10);
		const u = unitePaths(a, b);
		expect(area(u)).toBeCloseTo(175, 9);
		expect(subpaths(u)).toBe(1);
		expect(segs(u)).toBe(8);
		const i = intersectPaths(a, b);
		expect(area(i)).toBeCloseTo(25, 9);
		expect(segs(i)).toBe(4);
		const d = subtractPaths(a, b);
		expect(area(d)).toBeCloseTo(75, 9);
		expect(segs(d)).toBe(6);
		expect(area(excludePaths(a, b))).toBeCloseTo(150, 9);
		for (const p of [u, i, d]) expectClean(p);
	});

	it('keeps disjoint shapes and empties A − A', () => {
		const u = unitePaths(rect(0, 0, 1, 1), rect(5, 5, 1, 1));
		expect(subpaths(u)).toBe(2);
		expect(area(u)).toBeCloseTo(2, 12);
		expect(subtractPaths(circle(3, 4, 7), circle(3, 4, 7))).toEqual([]);
		const r = rect(1, 2, 3, 4);
		const same = unitePaths(r, r);
		expect(segs(same)).toBe(4);
		expect(area(same)).toBeCloseTo(12, 12);
	});

	it('unites circles keeping curves (circles stay cubic arcs)', () => {
		const u = unitePaths(circle(0, 0, 10), circle(10, 0, 10));
		const counts = countPathSegments(u);
		expect(counts.lines).toBe(0);
		expect(counts.cubics).toBeGreaterThan(0);
		expect(counts.cubics).toBeLessThanOrEqual(12);
		const expected = 2 * Math.PI * 100 - lens(10, 10);
		expect(close(area(u), expected, 1e-3)).toBe(true);
		expectClean(u);
		// The two arcs meet at the exact intersection points (5, ±5√3).
		expect(bezierPathToSvg(u)).toContain('5 -8.66');
	});

	it('intersects a circle with a rectangle keeping the curve', () => {
		const i = intersectPaths(circle(0, 0, 10), rect(0, -20, 20, 40));
		const counts = countPathSegments(i);
		expect(counts.cubics).toBe(2);
		expect(counts.lines).toBe(1);
		expect(close(area(i), Math.PI * 50, 1e-3)).toBe(true);
	});

	it('creates holes oriented for both fill rules', () => {
		const d = subtractPaths(rect(0, 0, 10, 10), rect(3, 3, 4, 4));
		expect(subpaths(d)).toBe(2);
		expect(area(d)).toBeCloseTo(84, 9);
		expect(area(d, 'evenodd')).toBeCloseTo(84, 9);
		const ring = subtractPaths(circle(0, 0, 20), circle(0, 0, 10));
		expect(countPathSegments(ring).cubics).toBe(8);
		expect(close(area(ring), cubicCircleArea(20) - cubicCircleArea(10), 1e-9)).toBe(true);
	});

	it('honours fill rules of nested same-direction subpaths', () => {
		const p = `${rect(0, 0, 10, 10)}${rect(3, 3, 4, 4)}`;
		expect(area(p, 'nonzero')).toBeCloseTo(100, 9);
		expect(area(p, 'evenodd')).toBeCloseTo(84, 9);
		const u = pathBoolean('union', [{ path: p, fillRule: 'evenodd' }, rect(20, 0, 1, 1)]);
		expect(area(u.path)).toBeCloseTo(85, 9);
		expect(u.engine).toBe('curve');
	});

	it('closes open subpaths for filling and resolves figure eights', () => {
		expect(area('M0 0L10 0L0 10')).toBeCloseTo(50, 9);
		const eight = normalizeBezierPath('M0 0L10 10L10 0L0 10Z');
		expect(subpaths(eight)).toBe(2);
		expect(area(eight)).toBeCloseTo(50, 9);
		// A cubic with a self-loop.
		const loop = normalizeBezierPath('M0 0C100 100 100 -100 0 0Z');
		expectClean(loop);
	});

	it('returns an empty result for non-finite input and empty operand lists', () => {
		const bad: BezierPath = [
			{ type: 'M', x: NaN, y: 0 },
			{ type: 'L', x: 1, y: 0 },
			{ type: 'L', x: 0, y: 1 },
			{ type: 'Z' }
		];
		const r = pathBoolean('union', [bad, rect(0, 0, 1, 1)]);
		expect(r.path).toEqual([]);
		expect(r.error).toBe('non-finite coordinates');
		expect(pathBoolean('union', []).path).toEqual([]);
		expect(area(unitePaths('', rect(5, 5, 10, 10)))).toBeCloseTo(100, 9);
		expect(intersectPaths('', rect(5, 5, 10, 10))).toEqual([]);
		expect(dividePaths([]).pieces).toEqual([]);
	});

	it('handles n-ary intersect and exclude (odd coverage)', () => {
		const s = [rect(0, 0, 10, 10), rect(5, 0, 10, 10), rect(8, 0, 10, 10)];
		expect(area(pathBoolean('intersection', s).path)).toBeCloseTo(20, 9);
		// Coverage [0,5)=1, [5,8)=2, [8,10)=3, [10,15)=2, [15,18)=1 → 5 + 2 + 3 wide.
		expect(area(pathBoolean('xor', s).path)).toBeCloseTo(100, 9);
	});

	it('divides into faces that sum to the union', () => {
		const r = dividePaths([rect(0, 0, 10, 10), rect(5, 5, 10, 10)]);
		expect(r.pieces).toHaveLength(3);
		const total = r.pieces.reduce((s, p) => s + area(p.path), 0);
		expect(total).toBeCloseTo(175, 9);
		const overlap = r.pieces.find((p) => close(area(p.path), 25, 1e-9))!;
		expect(overlap.operands).toEqual([0, 1]);
		const circles = dividePaths([circle(0, 0, 10), circle(10, 0, 10)]);
		// Ordered by coverage key ('01', '10', '11').
		expect(circles.pieces.map((p) => p.operands)).toEqual([[1], [0], [0, 1]]);
		expect(circles.pieces.every((p) => countPathSegments(p.path).lines === 0)).toBe(true);
		// A shape cut in two by a bar becomes two pieces.
		const cut = dividePaths([rect(0, 0, 30, 10), rect(10, -5, 10, 20)]);
		expect(cut.pieces.filter((p) => p.operands.join() === '0')).toHaveLength(2);
	});
});

describe('pathBoolean: tangencies, coincidences and degeneracies', () => {
	it('keeps externally tangent circles as two touching rings', () => {
		const u = unitePaths(circle(0, 0, 10), circle(20, 0, 10));
		expect(subpaths(u)).toBe(2);
		expect(close(area(u), 2 * cubicCircleArea(10), 1e-9)).toBe(true);
		expect(intersectPaths(circle(0, 0, 10), circle(20, 0, 10))).toEqual([]);
	});

	it('handles internally tangent circles', () => {
		const big = circle(0, 0, 20);
		const small = circle(10, 0, 10);
		expect(close(area(unitePaths(big, small)), cubicCircleArea(20), 1e-9)).toBe(true);
		expect(close(area(intersectPaths(big, small)), cubicCircleArea(10), 1e-9)).toBe(true);
		const crescent = subtractPaths(big, small);
		expect(close(area(crescent), cubicCircleArea(20) - cubicCircleArea(10), 1e-9)).toBe(true);
		expectClean(crescent);
	});

	it('handles a circle tangent to a rectangle side and touching corners', () => {
		const u = unitePaths(circle(0, 0, 10), rect(10, -5, 10, 10));
		expect(close(area(u), cubicCircleArea(10) + 100, 1e-9)).toBe(true);
		const corner = unitePaths(rect(0, 0, 10, 10), rect(10, 10, 10, 10));
		expect(subpaths(corner)).toBe(2);
		expect(area(corner)).toBeCloseTo(200, 9);
	});

	it('merges coincident curves and shared edges', () => {
		const shared = unitePaths(rect(0, 0, 10, 10), rect(10, 0, 10, 10));
		expect(segs(shared)).toBe(4);
		const half = ellipse(0, 0, 10, 10);
		const u = pathBoolean('union', [half, circle(0, 0, 10), circle(0, 0, 10)]);
		expect(close(area(u.path), cubicCircleArea(10), 1e-9)).toBe(true);
		expect(countPathSegments(u.path).cubics).toBe(4);
		// Partially overlapping collinear edges.
		expect(area(unitePaths(rect(0, 0, 10, 10), rect(5, 10, 10, 10)))).toBeCloseTo(200, 9);
		// A semicircle sharing an arc with the full circle.
		const semi = 'M-10 0A10 10 0 0 1 10 0Z';
		expect(close(area(subtractPaths(circle(0, 0, 10), semi)), cubicCircleArea(10) / 2, 1e-9)).toBe(true);
	});

	it('is exact on integer-grid rectangles with many shared edges', () => {
		const random = rng(7);
		for (let trial = 0; trial < 30; trial++) {
			const n = 2 + Math.floor(random() * 4);
			const rects = Array.from({ length: n }, () => [
				Math.floor(random() * 6),
				Math.floor(random() * 6),
				1 + Math.floor(random() * 4),
				1 + Math.floor(random() * 4)
			]);
			let cells = 0;
			for (let cx = 0; cx < 12; cx++) {
				for (let cy = 0; cy < 12; cy++) {
					if (rects.some(([x, y, w, h]) => cx >= x && cx < x + w && cy >= y && cy < y + h)) cells++;
				}
			}
			const shapes = rects.map(([x, y, w, h]) => rect(x, y, w, h));
			const u = pathBoolean('union', shapes);
			expect(u.engine).toBe('curve');
			expect(area(u.path)).toBeCloseTo(cells, 9);
			const faces = dividePaths(shapes);
			expect(faces.pieces.reduce((s, p) => s + area(p.path), 0)).toBeCloseTo(cells, 9);
		}
	});

	it('is stable under tiny perturbations of shared edges', () => {
		for (const delta of [1e-12, 1e-10, 1e-7]) {
			const u = unitePaths(rect(0, 0, 10, 10), rect(10 + delta, 0, 10, 10));
			expect(area(u)).toBeCloseTo(200, 5);
		}
	});

	it('is continuous through near-tangency', () => {
		const single = cubicCircleArea(10);
		for (const delta of [-1e-3, -1e-6, -1e-9, 0, 1e-9, 1e-6, 1e-3]) {
			const u = pathBoolean('union', [circle(0, 0, 10), circle(20 + delta, 0, 10)]);
			expect(u.engine).toBe('curve');
			expect(Math.abs(area(u.path) - 2 * single)).toBeLessThan(1e-3);
			expectClean(u.path, 1e-6);
			const i = intersectPaths(circle(0, 0, 10), circle(20 + delta, 0, 10));
			expect(area(i)).toBeLessThan(1e-3);
		}
	});

	it('is invariant under scaling, translation and rotation', () => {
		const random = rng(8);
		for (let k = 0; k < 12; k++) {
			const a = randomShape(random);
			const b = randomShape(random);
			const base = area(unitePaths(a, b));
			const baseI = area(intersectPaths(a, b));
			for (const [sc, tx, rot] of [
				[1e-3, 0, 0],
				[1, 1e5, 0],
				[250, -3e4, 0],
				[1, 0, 0.7]
			]) {
				const c = Math.cos(rot) * sc;
				const sn = Math.sin(rot) * sc;
				const m = [c, sn, -sn, c, tx, tx / 2] as const;
				const u = pathBoolean('union', [transformBezierPath(a, m), transformBezierPath(b, m)]);
				expect(u.engine).toBe('curve');
				expect(close(area(u.path) / (sc * sc), base, 1e-6)).toBe(true);
				expect(Math.abs(area(intersectPaths(transformBezierPath(a, m), transformBezierPath(b, m))) / (sc * sc) - baseI)).toBeLessThan(
					1e-6 * base
				);
			}
		}
	});

	it('handles shapes sharing exact curves and repeated operands', () => {
		const random = rng(9);
		for (let k = 0; k < 10; k++) {
			const a = blob(random, 100, 100, 50, 5);
			const b = randomShape(random);
			const ab = unitePaths(a, b);
			// A against the union that contains its own curves.
			expect(close(area(intersectPaths(a, ab)), area(a), 1e-9)).toBe(true);
			expect(area(subtractPaths(a, ab))).toBeLessThan(1e-6 * area(a));
			expect(close(area(pathBoolean('union', [a, a, a, b]).path), area(ab), 1e-9)).toBe(true);
			expect(area(pathBoolean('xor', [a, a]).path)).toBeLessThan(1e-6 * area(a));
		}
	});

	it('ignores degenerate operands', () => {
		expect(area(unitePaths('M0 0L10 0L20 0Z', rect(0, 0, 5, 5)))).toBeCloseTo(25, 9);
		expect(area(unitePaths('M3 3Z', rect(0, 0, 5, 5)))).toBeCloseTo(25, 9);
		expect(area(unitePaths('M0 0C1 1 2 2 3 3Z', rect(0, 0, 5, 5)))).toBeCloseTo(25, 9);
		expect(normalizeBezierPath('M0 0L10 0L10 0L10 10L10 10Z').length).toBeGreaterThan(0);
	});

	it('falls back to the polygon engine and reports it', () => {
		const reasons: string[] = [];
		const r = pathBoolean('union', [circle(0, 0, 10), circle(10, 0, 10)], {
			subdivisionBudget: 1,
			onFallback: (reason) => reasons.push(reason)
		});
		expect(r.engine).toBe('polygon');
		expect(r.fallbackReason).toBe('curve intersection did not converge');
		expect(reasons).toEqual([r.fallbackReason]);
		expect(close(area(r.path), 2 * Math.PI * 100 - lens(10, 10), 5e-3)).toBe(true);
		const d = dividePaths([circle(0, 0, 10), circle(10, 0, 10)], { subdivisionBudget: 1 });
		expect(d.engine).toBe('polygon');
		expect(d.pieces).toHaveLength(3);
		expect(() => pathBoolean('union', [circle(0, 0, 10), circle(10, 0, 10)], { subdivisionBudget: 1, fallback: false })).toThrow(
			/did not converge/
		);
	});
});

// ---------------------------------------------------------------------------
// Property tests (vectorcraft props.rs / prop_pathops.rs re-expressed)
// ---------------------------------------------------------------------------

describe('pathBoolean: property tests', () => {
	const pairs = (seed: number, n: number) => {
		const random = rng(seed);
		return Array.from({ length: n }, () => [randomShape(random), randomShape(random)] as const);
	};

	it('satisfies the area identities', () => {
		const tol = 1e-6;
		for (const [a, b] of pairs(11, 60)) {
			const aa = area(a);
			const ab = area(b);
			const u = area(unitePaths(a, b));
			const u2 = area(unitePaths(b, a));
			const i = area(intersectPaths(a, b));
			const i2 = area(intersectPaths(b, a));
			const d = area(subtractPaths(a, b));
			const d2 = area(subtractPaths(b, a));
			const x = area(excludePaths(a, b));
			const scale = Math.max(aa, ab);
			const near = (p: number, q: number) => Math.abs(p - q) <= tol * scale;
			expect(near(u + i, aa + ab)).toBe(true);
			expect(near(d + i, aa)).toBe(true);
			expect(near(d + d2, x)).toBe(true);
			expect(near(x, u - i)).toBe(true);
			expect(near(u, u2) && near(i, i2)).toBe(true);
			expect(i).toBeLessThanOrEqual(Math.min(aa, ab) * (1 + tol));
			expect(u).toBeGreaterThanOrEqual(Math.max(aa, ab) * (1 - tol));
		}
	});

	it('produces clean results that keep curves', () => {
		for (const [a, b] of pairs(12, 30)) {
			for (const op of ['union', 'intersection', 'difference', 'xor'] as const) {
				const r = pathBoolean(op, [a, b]);
				expect(r.engine).toBe('curve');
				expectClean(r.path, 1e-6);
			}
		}
	});

	it('agrees with point membership away from the outlines', () => {
		const ops = ['union', 'intersection', 'difference', 'xor'] as const;
		for (const [a, b] of pairs(13, 20)) {
			const results = ops.map((op) => pathBoolean(op, [a, b]).path);
			for (let gx = 0; gx <= 230; gx += 23) {
				for (let gy = 0; gy <= 230; gy += 23) {
					const q: Point = [gx + 0.37, gy + 0.61];
					if (distanceToBezierPath(a, q) < 0.5 || distanceToBezierPath(b, q) < 0.5) continue;
					const ia = pointInBezierPath(a, q);
					const ib = pointInBezierPath(b, q);
					const want = [ia || ib, ia && ib, ia && !ib, ia !== ib];
					results.forEach((r, k) => expect(pointInBezierPath(r, q)).toBe(want[k]));
				}
			}
		}
	});

	it('is idempotent: A ∪ A = A ∩ A = A, A − A = ∅, (A ∪ B) ∪ (A ∪ B) = A ∪ B', () => {
		const random = rng(14);
		for (let k = 0; k < 30; k++) {
			const a = randomShape(random);
			const b = randomShape(random);
			const aa = area(a);
			const u = unitePaths(a, a);
			expect(close(area(u), aa, 1e-9)).toBe(true);
			expect(segs(u)).toBeLessThanOrEqual(segs(a) + 4);
			expect(close(area(intersectPaths(a, a)), aa, 1e-9)).toBe(true);
			expect(area(subtractPaths(a, a))).toBeLessThan(1e-6 * aa);
			const ab = unitePaths(a, b);
			const again = unitePaths(ab, ab);
			expect(close(area(again), area(ab), 1e-9)).toBe(true);
			expect(segs(again)).toBe(segs(ab));
		}
	});

	it('divides into faces that partition the union, each covered by exactly its operands', () => {
		const random = rng(15);
		for (let trial = 0; trial < 12; trial++) {
			const shapes = Array.from({ length: 2 + Math.floor(random() * 3) }, () => randomShape(random));
			const faces = dividePaths(shapes);
			expect(faces.engine).toBe('curve');
			const sum = faces.pieces.reduce((s, p) => s + area(p.path), 0);
			const u = area(pathBoolean('union', shapes).path);
			expect(close(sum, u, 1e-6)).toBe(true);
			for (let gx = 0; gx <= 230; gx += 17) {
				for (let gy = 0; gy <= 230; gy += 17) {
					const q: Point = [gx + 0.29, gy + 0.43];
					if (shapes.some((s) => distanceToBezierPath(s, q) < 0.5)) continue;
					const covering = shapes.flatMap((s, i) => (pointInBezierPath(s, q) ? [i] : []));
					const hits = faces.pieces.filter((p) => pointInBezierPath(p.path, q));
					if (covering.length === 0) expect(hits).toHaveLength(0);
					else {
						expect(hits).toHaveLength(1);
						expect(hits[0].operands).toEqual(covering);
					}
				}
			}
		}
	});

	it('n-ary union equals folding binary unions and matches the polygon engine', () => {
		const random = rng(16);
		const shapes = Array.from({ length: 6 }, () => randomShape(random));
		const all = pathBoolean('union', shapes).path;
		let folded: BezierPath = toBezierPath(shapes[0]);
		for (const s of shapes.slice(1)) folded = unitePaths(folded, s);
		expect(close(area(all), area(folded), 1e-9)).toBe(true);
		const poly = polygonBoolean(
			'union',
			shapes.map((s) => ({ rings: flattenSvgPath(s, { tolerance: 0.01 }) }))
		);
		const polyArea = poly.reduce((sum, polygonRings) => {
			const ringArea = (ring: Point[]) => ring.reduce((acc, p, i) => acc + (p[0] * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * p[1]) / 2, 0);
			return sum + Math.abs(ringArea(polygonRings[0])) - polygonRings.slice(1).reduce((h, r) => h + Math.abs(ringArea(r)), 0);
		}, 0);
		expect(close(area(all), polyArea, 2e-3)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Offset path
// ---------------------------------------------------------------------------

describe('offsetPath', () => {
	it('grows and insets circles keeping few curves', () => {
		const grown = offsetPath(circle(0, 0, 10), 3, { join: 'round' });
		expect(close(area(grown), Math.PI * 169, 2e-3)).toBe(true);
		expect(segs(grown)).toBeLessThanOrEqual(16);
		expect(countPathSegments(grown).lines).toBe(0);
		expect(close(area(offsetPath(circle(0, 0, 10), -4, { join: 'round' })), Math.PI * 36, 2e-3)).toBe(true);
	});

	it('applies miter, bevel and round joins to rectangle corners', () => {
		const r = rect(0, 0, 20, 10);
		const miter = offsetPath(r, 2, { join: 'miter' });
		expect(area(miter)).toBeCloseTo(24 * 14, 6);
		expect(segs(miter)).toBe(4);
		expect(area(offsetPath(r, 2, { join: 'bevel' }))).toBeCloseTo(24 * 14 - 4 * 2, 6);
		expect(close(area(offsetPath(r, 2, { join: 'round' })), 200 + 2 * 2 * 30 + Math.PI * 4, 1e-3)).toBe(true);
		expect(area(offsetPath(r, -2, { join: 'miter' }))).toBeCloseTo(16 * 6, 6);
		expect(offsetPath(r, -6)).toEqual([]);
	});

	it('bevels miters beyond the miter limit', () => {
		// A thin triangle: its sharp tip exceeds a miter limit of 2 but not 40.
		const tri = polygon([
			[0, 0],
			[100, 5],
			[0, 10]
		]);
		const limited = offsetPath(tri, 2, { join: 'miter', miterLimit: 2 });
		const unlimited = offsetPath(tri, 2, { join: 'miter', miterLimit: 40 });
		expect(bezierPathBounds(limited)!.maxX).toBeLessThan(103);
		expect(bezierPathBounds(unlimited)!.maxX).toBeGreaterThan(130);
	});

	it('keeps the area of large offsets of small curves', () => {
		for (const [r, d] of [
			[1, 5],
			[1, 3],
			[10, 30]
		]) {
			expect(close(area(offsetPath(circle(0, 0, r), d, { join: 'round' })), Math.PI * (r + d) ** 2, 1e-2)).toBe(true);
		}
	});

	it('follows Steiner’s formula for convex polygons with round joins', () => {
		const random = rng(21);
		for (let k = 0; k < 20; k++) {
			const pts = convexPolygon(random, 100, 100, 20 + random() * 60);
			const d = 0.5 + random() * 9.5;
			let perimeter = 0;
			for (let i = 0; i < pts.length; i++) {
				const p = pts[i];
				const q = pts[(i + 1) % pts.length];
				perimeter += Math.hypot(q[0] - p[0], q[1] - p[1]);
			}
			const base = area(polygon(pts));
			const want = base + perimeter * d + Math.PI * d * d;
			expect(close(area(offsetPath(polygon(pts), d, { join: 'round' })), want, 5e-3)).toBe(true);
		}
	});

	it('is monotone: a larger offset contains a smaller one and the original', () => {
		const random = rng(22);
		for (let k = 0; k < 12; k++) {
			const kind = k % 3;
			const p =
				kind === 0
					? ellipse(100, 100, 30 + random() * 40, 20 + random() * 30, random() * 180)
					: kind === 1
						? polygon(convexPolygon(random, 100, 100, 50))
						: polygon(starPolygon(random, 100, 100, 60, 7));
			const d1 = -3 + random() * 6;
			const d2 = d1 + 0.5 + random() * 5;
			for (const join of ['round', 'miter', 'bevel'] as StrokeJoin[]) {
				const small = offsetPath(p, d1, { join });
				const big = offsetPath(p, d2, { join });
				expect(area(big) + 1e-6).toBeGreaterThanOrEqual(area(small));
				expect(area(subtractPaths(small, big))).toBeLessThanOrEqual(2e-3 * Math.max(area(small), 1));
			}
			const big = offsetPath(p, Math.max(d2, 0.5), { join: 'round' });
			expect(area(subtractPaths(p, big))).toBeLessThanOrEqual(2e-3 * area(p));
		}
	});

	it('is the identity for a zero offset and outlines open subpaths when growing', () => {
		const random = rng(23);
		for (let k = 0; k < 10; k++) {
			const p = randomShape(random);
			expect(close(area(offsetPath(p, 0)), area(p), 1e-9)).toBe(true);
		}
		const line = offsetPath('M0 0L100 0', 5);
		expect(area(line)).toBeCloseTo(1000, 6);
		expect(offsetPath('M0 0L100 0', -5)).toEqual([]);
		expect(offsetPath(rect(0, 0, 10, 10), NaN)).toEqual([]);
	});

	it('removes the loops of inset curves (no spurious islands)', () => {
		// A peanut: insetting past the waist corners (15, ±13.23) splits it in two.
		const peanut = unitePaths(circle(0, 0, 20), circle(30, 0, 20));
		expect(subpaths(offsetPath(peanut, -12, { join: 'round' }))).toBe(1);
		const inset = offsetPath(peanut, -14, { join: 'round' });
		expect(subpaths(inset)).toBe(2);
		expectClean(inset);
		// The pieces reach (10.42, 0): just over 14 from both waist corners.
		expect(pointInBezierPath(inset, [10.3, 0])).toBe(true);
		expect(pointInBezierPath(inset, [10.6, 0])).toBe(false);
	});

	it('matches the exact round offset (Minkowski sum / erosion with a disk) on random shapes', () => {
		const random = rng(24);
		for (let k = 0; k < 16; k++) {
			const shape = randomShape(random);
			const d = (random() < 0.5 ? -1 : 1) * (1 + random() * 7);
			const result = offsetPath(shape, d, { join: 'round' });
			expect(pathBoolean('union', [result]).engine).toBe('curve');
			const b = bezierPathBounds(shape)!;
			for (let i = 0; i <= 14; i++) {
				for (let j = 0; j <= 14; j++) {
					const q: Point = [b.minX - 9 + ((b.maxX - b.minX + 18) * (i + 0.31)) / 14, b.minY - 9 + ((b.maxY - b.minY + 18) * (j + 0.57)) / 14];
					const dq = distanceToBezierPath(shape, q);
					if (Math.abs(dq - Math.abs(d)) < 0.05) continue;
					const inside = pointInBezierPath(shape, q);
					const want = d > 0 ? inside || dq < d : inside && dq > -d;
					expect(pointInBezierPath(result, q)).toBe(want);
				}
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Outline stroke
// ---------------------------------------------------------------------------

describe('outlineStroke', () => {
	it('outlines lines with butt, square and round caps', () => {
		expect(area(outlineStroke('M0 0L30 40', { width: 4 }))).toBeCloseTo(200, 6);
		expect(area(outlineStroke('M0 0L30 40', { width: 4, cap: 'square' }))).toBeCloseTo(216, 6);
		expect(close(area(outlineStroke('M0 0L30 40', { width: 4, cap: 'round' })), 200 + Math.PI * 4, 1e-3)).toBe(true);
		const random = rng(31);
		for (let k = 0; k < 25; k++) {
			const x = -50 + random() * 100;
			const y = -50 + random() * 100;
			const len = 1 + random() * 99;
			const ang = random() * 6;
			const w = 0.5 + random() * 9.5;
			const l = `M${x} ${y}L${x + len * Math.cos(ang)} ${y + len * Math.sin(ang)}`;
			expect(close(area(outlineStroke(l, { width: w, join: 'miter' })), len * w, 1e-6)).toBe(true);
		}
	});

	it('outlines a closed square as a ring with mitred corners', () => {
		const o = outlineStroke(rect(0, 0, 10, 10), { width: 2, miterLimit: 10 });
		expect(subpaths(o)).toBe(2);
		expect(area(o)).toBeCloseTo(144 - 64, 6);
		expect(segs(o)).toBe(8);
	});

	it('cleans self-overlapping strokes', () => {
		const z = outlineStroke('M0 0L10 0L0 1L10 2', { width: 3, cap: 'round', join: 'round' });
		expect(z.length).toBeGreaterThan(0);
		expectClean(z);
	});

	it('fills the middle of a stroke wider than its circle', () => {
		const o = outlineStroke(circle(0, 0, 2), { width: 10 });
		expect(subpaths(o)).toBe(1);
		expect(close(area(o), Math.PI * 49, 2e-3)).toBe(true);
	});

	it('matches outer − inner offsets for closed convex polygons', () => {
		const random = rng(32);
		for (let k = 0; k < 15; k++) {
			const p = polygon(convexPolygon(random, 100, 100, 30 + random() * 50));
			const w = 0.5 + random() * 3.5;
			const ring = area(outlineStroke(p, { width: w, join: 'round' }));
			const outer = area(offsetPath(p, w / 2, { join: 'round' }));
			const inner = area(offsetPath(p, -w / 2, { join: 'round' }));
			expect(close(ring, outer - inner, 1e-2)).toBe(true);
		}
	});

	it('strokes curves within tolerance of the true offset', () => {
		const curve = 'M0 0C30 80 70 -80 100 0';
		const o = outlineStroke(curve, { width: 8, tolerance: 0.01 });
		expectClean(o);
		// Every outline point sits half a width from the curve (caps aside).
		for (const contour of pathToContours(o)) {
			for (const s of contour.segments) {
				for (const t of [0.25, 0.5, 0.75]) {
					const q = segmentPoint(s, t);
					const d = distanceToBezierPath(curve, q);
					// Skip the butt caps at both ends.
					if (Math.hypot(q[0], q[1]) > 4.01 && Math.hypot(q[0] - 100, q[1]) > 4.01) expect(Math.abs(d - 4)).toBeLessThan(0.02);
				}
			}
		}
	});

	it('dashes along arc length, one subpath per dash', () => {
		const o = outlineStroke('M0 50L100 50', { width: 4, dash: [10, 10] });
		expect(subpaths(o)).toBe(5);
		expect(area(o)).toBeCloseTo(5 * 10 * 4, 6);
		const b = bezierPathBounds(o)!;
		expect(b.minX).toBeCloseTo(0, 9);
		expect(b.maxX).toBeCloseTo(90, 9);
		expect(b.minY).toBeCloseTo(48, 9);
		expect(b.maxY).toBeCloseTo(52, 9);
		// Odd patterns repeat twice; the offset shifts the pattern.
		expect(area(outlineStroke('M0 0L100 0', { width: 2, dash: [10], dashOffset: 5 }))).toBeCloseTo(100, 6);
		// Invalid patterns draw the line solid.
		expect(area(outlineStroke('M0 0L100 0', { width: 2, dash: [-1, 2] }))).toBeCloseTo(200, 6);
		expect(area(outlineStroke('M0 0L100 0', { width: 2, dash: [0, 0] }))).toBeCloseTo(200, 6);
	});

	it('joins the dash across the start of a closed subpath and paints dots with caps', () => {
		const contours = pathToContours(rect(0, 0, 10, 10));
		const dashed = dashContours(contours, [5, 5], 0)!;
		// 40 long: dashes at 0, 10, 20, 30 — the last gap ends at the start, so none join.
		expect(dashed.contours).toHaveLength(4);
		const joined = dashContours(contours, [5, 5], 2.5)!;
		// Starting 2.5 into the pattern: the dash running through the start corner is one piece.
		expect(joined.contours).toHaveLength(4);
		const across = joined.contours.find((c) => c.segments.length === 2)!;
		expect(across.segments[0][0]).toEqual([0, 2.5]);
		expect(across.segments[1][1]).toEqual([2.5, 0]);
		// Dots at 0, 20, 40, 60 and 80 (a dash starting exactly at the end is not drawn).
		const dots = outlineStroke('M0 0L100 0', { width: 4, dash: [0, 20], cap: 'round' });
		expect(subpaths(dots)).toBe(5);
		expect(close(area(dots), 5 * cubicCircleArea(2), 1e-6)).toBe(true);
		const squares = outlineStroke('M0 0L0 100', { width: 4, dash: [0, 20], cap: 'square' });
		expect(area(squares)).toBeCloseTo(5 * 16, 6);
		expect(outlineStroke('M0 0L100 0', { width: 4, dash: [0, 20] })).toEqual([]);
		expect(dashContours(contours, [1e-9], 0)).toBeNull();
	});

	it('returns nothing for invalid widths and empty input', () => {
		expect(outlineStroke(rect(0, 0, 10, 10), { width: Infinity })).toEqual([]);
		expect(outlineStroke(rect(0, 0, 10, 10), { width: 0 })).toEqual([]);
		expect(outlineStroke('', { width: 2 })).toEqual([]);
		expect(strokeOutlineRings(rect(0, 0, 10, 10), { width: -1 })).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

/** Best of several runs: the least disturbed by other processes. */
function timeIt(fn: () => void, runs = 5) {
	fn();
	const times: number[] = [];
	for (let i = 0; i < runs; i++) {
		const start = performance.now();
		fn();
		times.push(performance.now() - start);
	}
	return Math.min(...times);
}

describe('performance', () => {
	it(
		'grows at most about quadratically with the number of shapes',
		() => {
			const shapesOf = (n: number) => {
				const random = rng(41);
				return Array.from({ length: n }, () => circle(random() * 600, random() * 600, 10 + random() * 30));
			};
			const small = shapesOf(40);
			const large = shapesOf(80);
			const t1 = timeIt(() => pathBoolean('union', small));
			const t2 = timeIt(() => pathBoolean('union', large));
			// Doubling the input: quadratic work would be 4×; allow generous slack for noise.
			expect(t2 / Math.max(t1, 1)).toBeLessThan(10);
		},
		60_000
	);

	it(
		'grows at most about quadratically with the number of segments',
		() => {
			const random = rng(42);
			const star = (n: number) => polygon(starPolygon(random, 100, 100, 80, n));
			const a1 = star(300);
			const b1 = star(300);
			const a2 = star(600);
			const b2 = star(600);
			const t1 = timeIt(() => unitePaths(a1, b1));
			const t2 = timeIt(() => unitePaths(a2, b2));
			expect(t2 / Math.max(t1, 1)).toBeLessThan(10);
		},
		60_000
	);
});
