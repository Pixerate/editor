import { describe, it, expect } from 'vitest';
import {
	polygonBoolean,
	unionPolygons,
	intersectPolygons,
	subtractPolygons,
	xorPolygons,
	dividePolygons,
	multiPolygonArea,
	polygonArea,
	ringSignedArea,
	pointInMultiPolygon,
	pointInRings,
	multiPolygonBounds,
	type MultiPolygon,
	type PolygonRing,
	type PolygonInput
} from '../src/canvas/polygonBoolean';
import {
	parseSvgPath,
	flattenSvgPath,
	shapeToPolygon,
	getShapeSvg,
	polygonToSvgPath,
	simplifyRing,
	isShapeDescription,
	formatNumber,
	getShapeRenderData
} from '../src/canvas/shapeGeometry';
import {
	combineShapeNodes,
	canCombineShapeNodes,
	applyShapeCombination,
	revertShapeCombination,
	shapeNodeToPolygon,
	isShapeNode,
	getNodeShape
} from '../src/canvas/shapeNodes';
import { createCanvasArrangeController } from '../src/canvas/arrangeController';
import { lockNodes } from '../src/canvas/arrange';
import { HistoryManager } from '../src/history';
import type { CanvasNode, Point } from '../src/canvas/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rect = (x: number, y: number, w: number, h: number): MultiPolygon => [
	[
		[
			[x, y],
			[x + w, y],
			[x + w, y + h],
			[x, y + h]
		]
	]
];

const circle = (cx: number, cy: number, r: number, n = 64): PolygonRing =>
	Array.from({ length: n }, (_, i) => {
		const a = (i / n) * Math.PI * 2;
		return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Point;
	});

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

/** Random star-shaped (simple) polygon around a centre. */
function randomPolygon(random: () => number, cx: number, cy: number, radius: number, n: number): MultiPolygon {
	const ring: Point[] = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2 + random() * 0.5 * ((Math.PI * 2) / n);
		const r = radius * (0.3 + 0.7 * random());
		ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
	}
	return [[ring]];
}

function segmentsOf(multi: MultiPolygon): [Point, Point][] {
	const out: [Point, Point][] = [];
	for (const polygon of multi) {
		for (const ring of polygon) {
			for (let i = 0; i < ring.length; i++) out.push([ring[i], ring[(i + 1) % ring.length]]);
		}
	}
	return out;
}

/** Counts proper crossings (interiors intersecting at one point) between result edges. */
function properCrossings(multi: MultiPolygon): number {
	const segs = segmentsOf(multi);
	let count = 0;
	const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	for (let i = 0; i < segs.length; i++) {
		for (let j = i + 1; j < segs.length; j++) {
			const [p1, p2] = segs[i];
			const [p3, p4] = segs[j];
			const d1 = cross(p3, p4, p1);
			const d2 = cross(p3, p4, p2);
			const d3 = cross(p1, p2, p3);
			const d4 = cross(p1, p2, p4);
			const scale = 1e-9;
			if (
				((d1 > scale && d2 < -scale) || (d1 < -scale && d2 > scale)) &&
				((d3 > scale && d4 < -scale) || (d3 < -scale && d4 > scale))
			) {
				count++;
			}
		}
	}
	return count;
}

function expectValid(multi: MultiPolygon) {
	for (const polygon of multi) {
		expect(polygon.length).toBeGreaterThan(0);
		expect(ringSignedArea(polygon[0])).toBeGreaterThan(0);
		for (const hole of polygon.slice(1)) expect(ringSignedArea(hole)).toBeLessThan(0);
		for (const ring of polygon) expect(ring.length).toBeGreaterThanOrEqual(3);
	}
	expect(properCrossings(multi)).toBe(0);
}

const area = multiPolygonArea;

// ---------------------------------------------------------------------------
// Boolean engine
// ---------------------------------------------------------------------------

describe('polygonBoolean: basic operations', () => {
	const a = rect(0, 0, 10, 10);
	const b = rect(5, 5, 10, 10);

	it('computes union, intersection, difference and xor of overlapping squares', () => {
		const u = unionPolygons(a, b);
		const i = intersectPolygons(a, b);
		const d = subtractPolygons(a, b);
		const x = xorPolygons(a, b);
		[u, i, d, x].forEach(expectValid);
		expect(area(u)).toBeCloseTo(175);
		expect(area(i)).toBeCloseTo(25);
		expect(area(d)).toBeCloseTo(75);
		expect(area(x)).toBeCloseTo(150);
		expect(u).toHaveLength(1);
		expect(u[0][0]).toHaveLength(8);
		expect(i[0][0]).toHaveLength(4);
		expect(d[0][0]).toHaveLength(6);
		// xor of two overlapping squares: two L-shapes touching at the corners of the overlap
		expect(x).toHaveLength(2);
	});

	it('accepts an empty operand list and empty operands', () => {
		expect(polygonBoolean('union', [])).toEqual([]);
		expect(area(unionPolygons([], a))).toBeCloseTo(100);
		expect(intersectPolygons([], a)).toEqual([]);
		expect(area(subtractPolygons(a, []))).toBeCloseTo(100);
	});

	it('handles disjoint inputs', () => {
		const far = rect(50, 50, 5, 5);
		expect(area(unionPolygons(a, far))).toBeCloseTo(125);
		expect(unionPolygons(a, far)).toHaveLength(2);
		expect(intersectPolygons(a, far)).toEqual([]);
		expect(area(subtractPolygons(a, far))).toBeCloseTo(100);
		expect(area(xorPolygons(a, far))).toBeCloseTo(125);
	});

	it('merges squares sharing an edge into one rectangle without collinear vertices', () => {
		const u = unionPolygons(rect(0, 0, 10, 10), rect(10, 0, 10, 10));
		expectValid(u);
		expect(u).toHaveLength(1);
		expect(u[0]).toHaveLength(1);
		expect(u[0][0]).toHaveLength(4);
		expect(area(u)).toBeCloseTo(200);
		expect(intersectPolygons(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toEqual([]);
	});

	it('handles partially overlapping collinear edges', () => {
		const u = unionPolygons(rect(0, 0, 10, 10), rect(10, 3, 10, 4));
		expectValid(u);
		expect(u).toHaveLength(1);
		expect(u[0][0]).toHaveLength(8);
		expect(area(u)).toBeCloseTo(140);
		const sameBase = unionPolygons(rect(0, 0, 10, 10), rect(4, 0, 10, 5));
		expectValid(sameBase);
		expect(area(sameBase)).toBeCloseTo(100 + 20);
	});

	it('keeps shapes touching at a single vertex as separate simple polygons', () => {
		const u = unionPolygons(rect(0, 0, 10, 10), rect(10, 10, 10, 10));
		expectValid(u);
		expect(u).toHaveLength(2);
		expect(area(u)).toBeCloseTo(200);
		expect(intersectPolygons(rect(0, 0, 10, 10), rect(10, 10, 10, 10))).toEqual([]);
	});

	it('handles a vertex touching an edge (T-junction)', () => {
		const tri: MultiPolygon = [[[[10, 5], [20, 0], [20, 10]]]];
		const u = unionPolygons(rect(0, 0, 10, 10), tri);
		expectValid(u);
		// They only share the point (10, 5), so they stay two polygons.
		expect(u).toHaveLength(2);
		expect(area(u)).toBeCloseTo(150);
		const notched = subtractPolygons(rect(0, 0, 10, 10), [[[[10, 5], [5, 0], [5, 10]]]]);
		expectValid(notched);
		expect(area(notched)).toBeCloseTo(75);
		// The notch touches the top, bottom and right edges: a left rectangle and two corner
		// triangles remain, meeting only at points.
		expect(notched).toHaveLength(3);
	});

	it('handles identical operands', () => {
		expect(area(unionPolygons(a, a))).toBeCloseTo(100);
		expect(area(intersectPolygons(a, a))).toBeCloseTo(100);
		expect(subtractPolygons(a, a)).toEqual([]);
		expect(xorPolygons(a, a)).toEqual([]);
	});

	it('creates holes and handles inputs with holes', () => {
		const ring = subtractPolygons(rect(0, 0, 10, 10), rect(3, 3, 4, 4));
		expectValid(ring);
		expect(ring).toHaveLength(1);
		expect(ring[0]).toHaveLength(2);
		expect(area(ring)).toBeCloseTo(84);
		expect(pointInMultiPolygon([5, 5], ring)).toBe(false);
		expect(pointInMultiPolygon([1, 1], ring)).toBe(true);

		// Filling the hole exactly restores the square.
		const filled = unionPolygons(ring, rect(3, 3, 4, 4));
		expectValid(filled);
		expect(filled).toHaveLength(1);
		expect(filled[0]).toHaveLength(1);
		expect(area(filled)).toBeCloseTo(100);

		// A shape inside the hole stays an island.
		const island = unionPolygons(ring, rect(4, 4, 2, 2));
		expectValid(island);
		expect(island).toHaveLength(2);
		expect(area(island)).toBeCloseTo(88);

		// Intersection with a shape crossing the hole.
		const bar = intersectPolygons(ring, rect(-1, 4, 12, 2));
		expectValid(bar);
		expect(area(bar)).toBeCloseTo(20 - 8);
		expect(bar).toHaveLength(2);
	});

	it('assigns holes that touch their outer ring at a vertex', () => {
		const tri: MultiPolygon = [[[[0, 0], [5, 5], [0, 10]]]];
		const result = subtractPolygons(rect(0, 0, 10, 10), [[[[0, 5], [5, 3], [5, 7]]]]);
		expectValid(result);
		expect(area(result)).toBeCloseTo(100 - 10);
		const notch = subtractPolygons(rect(0, 0, 10, 10), tri);
		expectValid(notch);
		expect(area(notch)).toBeCloseTo(75);
	});

	it('normalises ring orientation and closing points of multi-polygon input', () => {
		const clockwise: MultiPolygon = [[[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]]];
		expect(area(unionPolygons(clockwise, rect(5, 0, 10, 10)))).toBeCloseTo(150);
		const holeSameOrientation: MultiPolygon = [rect(0, 0, 10, 10)[0].concat(rect(2, 2, 2, 2)[0])];
		expect(area(unionPolygons(holeSameOrientation, []))).toBeCloseTo(96);
	});

	it('resolves self-intersecting operands with their fill rule', () => {
		// A pentagram: the centre has winding 2.
		const star: Point[] = Array.from({ length: 5 }, (_, i) => {
			const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
			return [Math.cos(a) * 10, Math.sin(a) * 10] as Point;
		});
		const nonzero = unionPolygons({ rings: [star], fillRule: 'nonzero' }, []);
		const evenodd = unionPolygons({ rings: [star], fillRule: 'evenodd' }, []);
		expectValid(nonzero);
		expectValid(evenodd);
		expect(nonzero).toHaveLength(1);
		expect(evenodd).toHaveLength(5);
		expect(area(nonzero)).toBeGreaterThan(area(evenodd));
		expect(pointInMultiPolygon([0, 0], nonzero)).toBe(true);
		expect(pointInMultiPolygon([0, 0], evenodd)).toBe(false);
	});

	it('handles a figure-eight (bow tie) ring', () => {
		const bowtie: PolygonRing = [[0, 0], [10, 10], [10, 0], [0, 10]];
		const result = unionPolygons({ rings: [bowtie] }, []);
		expectValid(result);
		expect(result).toHaveLength(2);
		expect(area(result)).toBeCloseTo(50);
	});

	it('merges points within epsilon and ignores near-duplicate slivers', () => {
		const nearly = rect(0, 0, 10, 10 + 1e-12);
		expect(area(unionPolygons(rect(0, 0, 10, 10), nearly))).toBeCloseTo(100);
		const shifted = unionPolygons(rect(0, 0, 10, 10), rect(10 + 1e-12, 0, 10, 10));
		expectValid(shifted);
		expect(shifted).toHaveLength(1);
		// A large epsilon closes the 0.5 gap: the shapes become one polygon.
		expect(unionPolygons(rect(0, 0, 10, 10), rect(10.5, 0, 10, 10), { epsilon: 1 })).toHaveLength(1);
		expect(unionPolygons(rect(0, 0, 10, 10), rect(10.5, 0, 10, 10))).toHaveLength(2);
	});

	it('ignores degenerate rings and non-finite points', () => {
		const junk: MultiPolygon = [[[[0, 0], [1, 1]]], [[[0, 0], [5, 0], [10, 0]]], [[[NaN, 0], [0, 0], [3, 0], [3, 3]]]];
		const result = unionPolygons(junk, rect(0, 0, 1, 1));
		// The triangle overlaps the unit square by 0.5.
		expect(area(result)).toBeCloseTo(1 + 4.5 - 0.5);
	});

	it('supports n-ary operations', () => {
		const ops: PolygonInput[] = [rect(0, 0, 10, 10), rect(5, 0, 10, 10), rect(10, 0, 10, 10)];
		expect(area(polygonBoolean('union', ops))).toBeCloseTo(200);
		expect(area(polygonBoolean('intersection', ops))).toBeCloseTo(0);
		expect(area(polygonBoolean('intersection', ops.slice(0, 2)))).toBeCloseTo(50);
		expect(area(polygonBoolean('difference', ops))).toBeCloseTo(50);
		// Exclude keeps areas covered an odd number of times: x in [0,5] and [15,20].
		expect(area(polygonBoolean('xor', ops))).toBeCloseTo(100);
		const triple = polygonBoolean('xor', [rect(0, 0, 10, 10), rect(0, 0, 10, 10), rect(0, 0, 10, 10)]);
		expect(area(triple)).toBeCloseTo(100);
	});

	it('handles curved (many-vertex) shapes', () => {
		const c1 = [[circle(0, 0, 10, 128)]];
		const c2 = [[circle(10, 0, 10, 128)]];
		const lens = intersectPolygons(c1, c2);
		expectValid(lens);
		// Lens area of two unit-distance circles: 2r²acos(d/2r) − (d/2)√(4r²−d²)
		const exact = 2 * 100 * Math.acos(0.5) - 5 * Math.sqrt(400 - 100);
		expect(Math.abs(area(lens) - exact) / exact).toBeLessThan(0.01);
	});
});

describe('polygonBoolean: property tests', () => {
	const tolerance = (x: number) => 1e-6 * Math.max(1, Math.abs(x));

	it('satisfies the inclusion–exclusion identities on random integer rectangles', () => {
		const random = rng(42);
		for (let trial = 0; trial < 150; trial++) {
			// Small integer grid: lots of shared edges, collinear overlaps and touching corners.
			const r = () => rect(Math.floor(random() * 6), Math.floor(random() * 6), 1 + Math.floor(random() * 5), 1 + Math.floor(random() * 5));
			const a = unionPolygons(r(), r());
			const b = unionPolygons(r(), r());
			const u = unionPolygons(a, b);
			const i = intersectPolygons(a, b);
			const d = subtractPolygons(a, b);
			const x = xorPolygons(a, b);
			[a, b, u, i, d, x].forEach(expectValid);
			const A = area(a);
			const B = area(b);
			const I = area(i);
			expect(Math.abs(area(u) - (A + B - I))).toBeLessThan(tolerance(A + B));
			expect(Math.abs(area(d) - (A - I))).toBeLessThan(tolerance(A));
			expect(Math.abs(area(x) - (area(u) - I))).toBeLessThan(tolerance(A + B));
		}
	});

	it('satisfies the identities and point membership on random polygons', () => {
		const random = rng(7);
		for (let trial = 0; trial < 60; trial++) {
			const a = randomPolygon(random, random() * 20, random() * 20, 5 + random() * 15, 3 + Math.floor(random() * 12));
			const b = randomPolygon(random, random() * 20, random() * 20, 5 + random() * 15, 3 + Math.floor(random() * 12));
			const u = unionPolygons(a, b);
			const i = intersectPolygons(a, b);
			const d = subtractPolygons(a, b);
			const x = xorPolygons(a, b);
			[u, i, d, x].forEach(expectValid);
			const A = area(a);
			const B = area(b);
			const I = area(i);
			expect(Math.abs(area(u) - (A + B - I))).toBeLessThan(tolerance(A + B));
			expect(Math.abs(area(d) - (A - I))).toBeLessThan(tolerance(A));
			expect(Math.abs(area(x) - (area(u) - I))).toBeLessThan(tolerance(A + B));
			for (let k = 0; k < 40; k++) {
				const p: Point = [-20 + random() * 60, -20 + random() * 60];
				const inA = pointInMultiPolygon(p, a);
				const inB = pointInMultiPolygon(p, b);
				expect(pointInMultiPolygon(p, u)).toBe(inA || inB);
				expect(pointInMultiPolygon(p, i)).toBe(inA && inB);
				expect(pointInMultiPolygon(p, d)).toBe(inA && !inB);
				expect(pointInMultiPolygon(p, x)).toBe(inA !== inB);
			}
		}
	});

	it('divides into pieces that tile the union without overlap', () => {
		const random = rng(99);
		for (let trial = 0; trial < 25; trial++) {
			const shapes = Array.from({ length: 2 + Math.floor(random() * 3) }, () =>
				trial % 2
					? rect(Math.floor(random() * 6), Math.floor(random() * 6), 1 + Math.floor(random() * 5), 1 + Math.floor(random() * 5))
					: randomPolygon(random, random() * 20, random() * 20, 5 + random() * 10, 3 + Math.floor(random() * 8))
			);
			const pieces = dividePolygons(shapes);
			const union = polygonBoolean('union', shapes);
			const total = pieces.reduce((sum, p) => sum + polygonArea(p.polygon), 0);
			expect(Math.abs(total - area(union))).toBeLessThan(1e-6 * Math.max(1, area(union)));
			for (const piece of pieces) {
				expectValid([piece.polygon]);
				expect(piece.operands.length).toBeGreaterThan(0);
			}
			for (let k = 0; k < 30; k++) {
				const p: Point = [random() * 30 - 5, random() * 30 - 5];
				const containing = pieces.filter((piece) => pointInMultiPolygon(p, [piece.polygon]));
				expect(containing.length).toBeLessThanOrEqual(1);
				if (containing.length === 1) {
					const expected = shapes.flatMap((s, idx) => (pointInMultiPolygon(p, s) ? [idx] : []));
					expect(containing[0].operands).toEqual(expected);
				}
			}
		}
	});

	it('handles self-intersecting integer-grid polygons with heavy degeneracy', () => {
		const random = rng(1234);
		for (let trial = 0; trial < 80; trial++) {
			const make = () => ({
				rings: [Array.from({ length: 3 + Math.floor(random() * 6) }, () => [Math.floor(random() * 5), Math.floor(random() * 5)] as Point)],
				fillRule: (random() < 0.5 ? 'evenodd' : 'nonzero') as 'evenodd' | 'nonzero'
			});
			const a = make();
			const b = make();
			const results = {
				union: unionPolygons(a, b),
				intersection: intersectPolygons(a, b),
				difference: subtractPolygons(a, b),
				xor: xorPolygons(a, b)
			};
			Object.values(results).forEach(expectValid);
			for (let k = 0; k < 40; k++) {
				const p: Point = [random() * 5 + 1e-7 * Math.PI, random() * 5 + 1e-7 * Math.E];
				const inA = pointInRings(p, a.rings, a.fillRule);
				const inB = pointInRings(p, b.rings, b.fillRule);
				expect(pointInMultiPolygon(p, results.union)).toBe(inA || inB);
				expect(pointInMultiPolygon(p, results.intersection)).toBe(inA && inB);
				expect(pointInMultiPolygon(p, results.difference)).toBe(inA && !inB);
				expect(pointInMultiPolygon(p, results.xor)).toBe(inA !== inB);
			}
		}
	});

	it('is stable under tiny perturbations of shared edges', () => {
		const random = rng(77);
		for (let trial = 0; trial < 40; trial++) {
			const jitter = () => (random() - 0.5) * 1e-11;
			const a = rect(0, 0, 10, 10);
			const b: MultiPolygon = [[[[10 + jitter(), jitter()], [20, 0], [20, 10], [10 + jitter(), 10 + jitter()]]]];
			const u = unionPolygons(a, b);
			expectValid(u);
			expect(u).toHaveLength(1);
			expect(area(u)).toBeCloseTo(200, 6);
			expect(area(intersectPolygons(a, b))).toBeCloseTo(0, 6);
		}
	});

	it('n-ary union equals folding binary unions', () => {
		const random = rng(5);
		const shapes = Array.from({ length: 8 }, () =>
			rect(Math.floor(random() * 10), Math.floor(random() * 10), 1 + Math.floor(random() * 6), 1 + Math.floor(random() * 6))
		);
		const folded = shapes.reduce<MultiPolygon>((acc, s) => unionPolygons(acc, s), []);
		const nary = polygonBoolean('union', shapes);
		expectValid(nary);
		expect(area(nary)).toBeCloseTo(area(folded), 6);
	});
});

describe('dividePolygons', () => {
	it('splits two overlapping circles into three regions', () => {
		const pieces = dividePolygons([[[circle(0, 0, 10)]], [[circle(10, 0, 10)]]]);
		expect(pieces).toHaveLength(3);
		expect(pieces.map((p) => p.operands)).toEqual(expect.arrayContaining([[0], [1], [0, 1]]));
	});

	it('splits a shape cut in two by a bar into separate pieces', () => {
		const pieces = dividePolygons([rect(0, 0, 10, 10), rect(-5, 4, 20, 2)]);
		const onlyA = pieces.filter((p) => p.operands.length === 1 && p.operands[0] === 0);
		const onlyB = pieces.filter((p) => p.operands.length === 1 && p.operands[0] === 1);
		expect(onlyA).toHaveLength(2);
		expect(onlyB).toHaveLength(2);
		expect(pieces.filter((p) => p.operands.length === 2)).toHaveLength(1);
		expect(dividePolygons([])).toEqual([]);
	});
});

describe('polygon helpers', () => {
	it('measures rings, bounds and point membership', () => {
		expect(ringSignedArea([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(100);
		expect(ringSignedArea([[0, 0], [0, 10], [10, 10], [10, 0]])).toBe(-100);
		expect(multiPolygonBounds(rect(1, 2, 3, 4))).toEqual({ minX: 1, minY: 2, maxX: 4, maxY: 6 });
		expect(multiPolygonBounds([])).toBeNull();
		expect(pointInRings([5, 5], rect(0, 0, 10, 10)[0])).toBe(true);
		expect(pointInRings([15, 5], rect(0, 0, 10, 10)[0])).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Shape geometry
// ---------------------------------------------------------------------------

describe('parseSvgPath', () => {
	it('normalises relative, H/V and implicit commands', () => {
		expect(parseSvgPath('m10 10 l5 0 h5 v5 H0 V0 z')).toEqual([
			{ type: 'M', x: 10, y: 10 },
			{ type: 'L', x: 15, y: 10 },
			{ type: 'L', x: 20, y: 10 },
			{ type: 'L', x: 20, y: 15 },
			{ type: 'L', x: 0, y: 15 },
			{ type: 'L', x: 0, y: 0 },
			{ type: 'Z' }
		]);
		// implicit lineto after moveto, compact numbers
		expect(parseSvgPath('M0,0 10,0 10-10.5.5')).toEqual([
			{ type: 'M', x: 0, y: 0 },
			{ type: 'L', x: 10, y: 0 },
			{ type: 'L', x: 10, y: -10.5 }
		]);
		expect(parseSvgPath('M0 0L1e1 2E-1')[1]).toEqual({ type: 'L', x: 10, y: 0.2 });
	});

	it('reflects control points for S and T', () => {
		const [, c, s] = parseSvgPath('M0 0 C0 10 10 10 10 0 S20 -10 20 0');
		expect(c).toMatchObject({ type: 'C', x2: 10, y2: 10 });
		expect(s).toEqual({ type: 'C', x1: 10, y1: -10, x2: 20, y2: -10, x: 20, y: 0 });
		const [, q, t] = parseSvgPath('M0 0 Q5 10 10 0 t10 0');
		expect(q).toMatchObject({ type: 'Q', x1: 5, y1: 10 });
		expect(t).toEqual({ type: 'Q', x1: 15, y1: -10, x: 20, y: 0 });
		// S without a preceding C uses the current point
		expect(parseSvgPath('M1 1 S5 5 9 9')[1]).toMatchObject({ x1: 1, y1: 1 });
	});

	it('parses arcs including compact flags', () => {
		expect(parseSvgPath('M0 0a5 5 0 0110 0')[1]).toEqual({
			type: 'A',
			rx: 5,
			ry: 5,
			rotation: 0,
			largeArc: false,
			sweep: true,
			x: 10,
			y: 0
		});
		expect(parseSvgPath('M0 0A5,5,30,1,0,10,0')[1]).toMatchObject({ largeArc: true, sweep: false, rotation: 30 });
	});

	it('stops at malformed data and tolerates empty input', () => {
		expect(parseSvgPath('M0 0 L10')).toEqual([{ type: 'M', x: 0, y: 0 }]);
		expect(parseSvgPath('')).toEqual([]);
		expect(parseSvgPath('10 10')).toEqual([]);
		// relative moveto after closepath starts from the subpath start
		expect(parseSvgPath('M10 10 h5 v5 z m1 1')[4]).toEqual({ type: 'M', x: 11, y: 11 });
	});
});

describe('flattenSvgPath and shapes', () => {
	it('flattens arcs into circles within the tolerance', () => {
		const rings = flattenSvgPath('M0 50A50 50 0 1 1 100 50A50 50 0 1 1 0 50Z', { tolerance: 0.1 });
		expect(rings).toHaveLength(1);
		const a = Math.abs(ringSignedArea(rings[0]));
		expect(Math.abs(a - Math.PI * 2500) / (Math.PI * 2500)).toBeLessThan(0.005);
		const coarse = flattenSvgPath('M0 50A50 50 0 1 1 100 50A50 50 0 1 1 0 50Z', { tolerance: 5 });
		expect(coarse[0].length).toBeLessThan(rings[0].length);
		for (const [x, y] of rings[0]) expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(50, 5);
	});

	it('flattens cubic and quadratic curves through their end points', () => {
		const [ring] = flattenSvgPath('M0 0C0 50 100 50 100 0Q50 -50 0 0Z', { tolerance: 0.05 });
		expect(ring[0]).toEqual([0, 0]);
		expect(ring).toContainEqual([100, 0]);
		// Cubic midpoint is at y = 37.5
		const maxY = Math.max(...ring.map((p) => p[1]));
		expect(maxY).toBeCloseTo(37.5, 1);
		const minY = Math.min(...ring.map((p) => p[1]));
		expect(minY).toBeCloseTo(-25, 1);
	});

	it('splits subpaths, closes open ones and scales arcs that are too small', () => {
		const rings = flattenSvgPath('M0 0H10V10H0Z M20 0 H30 V10 M40 0 A1 1 0 0 1 50 0 Z', { tolerance: 0.01 });
		expect(rings).toHaveLength(3);
		expect(Math.abs(ringSignedArea(rings[1]))).toBeCloseTo(50);
		// radius scaled up to 5: a half circle
		expect(Math.abs(ringSignedArea(rings[2]))).toBeCloseTo((Math.PI * 25) / 2, 0);
	});

	it('converts rect, rounded rect, ellipse, polygon and star shapes', () => {
		const size = { width: 100, height: 60 };
		const r = shapeToPolygon({ kind: 'rect' }, size);
		expect(Math.abs(ringSignedArea(r.rings[0]))).toBeCloseTo(6000);
		const rr = shapeToPolygon({ kind: 'rect', cornerRadius: 10 }, size, { tolerance: 0.01 });
		expect(Math.abs(ringSignedArea(rr.rings[0]))).toBeCloseTo(6000 - (4 - Math.PI) * 100, 0);
		const clamped = shapeToPolygon({ kind: 'rect', cornerRadius: [100, 100, 0, 0] }, size);
		expect(multiPolygonBounds(clamped.rings)).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 60 });
		const e = shapeToPolygon({ kind: 'ellipse' }, size, { tolerance: 0.01 });
		expect(Math.abs(ringSignedArea(e.rings[0]))).toBeCloseTo(Math.PI * 50 * 30, -1);
		const hex = shapeToPolygon({ kind: 'polygon', sides: 6 }, size);
		expect(hex.rings[0]).toHaveLength(6);
		const b = multiPolygonBounds(hex.rings)!;
		expect(b.minX).toBeCloseTo(0);
		expect(b.maxX).toBeCloseTo(100);
		expect(b.minY).toBeCloseTo(0);
		expect(b.maxY).toBeCloseTo(60);
		const star = shapeToPolygon({ kind: 'star', points: 5, innerRadius: 0.4 }, size);
		expect(star.rings[0]).toHaveLength(10);
		expect(shapeToPolygon({ kind: 'polygon', sides: 1 }, size).rings[0]).toHaveLength(3);
		expect(shapeToPolygon({ kind: 'rect' }, { width: 0, height: 10 }).rings).toEqual([]);
	});

	it('applies rotation about the box centre', () => {
		const rotated = shapeToPolygon({ kind: 'rect', rotation: 90 }, { width: 100, height: 20 });
		const b = multiPolygonBounds(rotated.rings)!;
		expect(b.minX).toBeCloseTo(40);
		expect(b.maxX).toBeCloseTo(60);
		expect(b.minY).toBeCloseTo(-40);
		expect(b.maxY).toBeCloseTo(60);
	});

	it('maps path view boxes to the node size and keeps the fill rule', () => {
		const shape = { kind: 'path' as const, d: 'M0 0H10V10H0Z', viewBox: [0, 0, 10, 10] as const, fillRule: 'evenodd' as const };
		const p = shapeToPolygon(shape, { width: 200, height: 50 });
		expect(p.fillRule).toBe('evenodd');
		expect(multiPolygonBounds(p.rings)).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 50 });
		const noViewBox = shapeToPolygon({ kind: 'path', d: 'M0 0H10V10H0Z' }, { width: 200, height: 50 });
		expect(multiPolygonBounds(noViewBox.rings)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
	});

	it('renders exact SVG for shapes', () => {
		expect(getShapeSvg({ kind: 'rect' }, { width: 10, height: 5 })).toEqual({ d: 'M0 0H10V5H0Z', fillRule: 'nonzero' });
		expect(getShapeSvg({ kind: 'rect', cornerRadius: 2 }, { width: 10, height: 5 }).d).toContain('A2 2 0 0 1 10 2');
		expect(getShapeSvg({ kind: 'ellipse' }, { width: 10, height: 6 }).d).toBe('M0 3A5 3 0 1 1 10 3A5 3 0 1 1 0 3Z');
		expect(getShapeSvg({ kind: 'rect', rotation: 45 }, { width: 10, height: 10 }).transform).toBe('rotate(45 5 5)');
		const path = getShapeSvg({ kind: 'path', d: 'M0 0L1 1', viewBox: [1, 2, 4, 5] }, { width: 8, height: 10 });
		expect(path.transform).toBe('scale(2 2) translate(-1 -2)');
	});

	it('resolves render data with paint defaults and size fallbacks', () => {
		expect(getShapeRenderData({ kind: 'rect' }, { width: 20, height: 10 })).toEqual({
			viewBox: '0 0 20 10',
			width: 20,
			height: 10,
			d: 'M0 0H20V10H0Z',
			fillRule: 'nonzero',
			fill: 'currentColor',
			stroke: 'none',
			strokeWidth: 1
		});
		const path = getShapeRenderData({ kind: 'path', d: 'M0 0H4V4Z', viewBox: [0, 0, 4, 8], fill: 'red', opacity: 0.5 });
		expect(path).toMatchObject({ viewBox: '0 0 4 8', fill: 'red', opacity: 0.5 });
		expect(path.transform).toBe('scale(1 1) translate(0 0)');
		expect(getShapeRenderData({ kind: 'ellipse' }).viewBox).toBe('0 0 100 100');
	});

	it('validates shape descriptions', () => {
		expect(isShapeDescription({ kind: 'rect' })).toBe(true);
		expect(isShapeDescription({ kind: 'path' })).toBe(false);
		expect(isShapeDescription({ kind: 'blob' })).toBe(false);
		expect(isShapeDescription(null)).toBe(false);
	});
});

describe('polygonToSvgPath and simplifyRing', () => {
	it('writes M/L/Z path data with precision and offset, round-tripping through the parser', () => {
		const multi = subtractPolygons(rect(0, 0, 10, 10), rect(2.123456, 2, 3, 3));
		const d = polygonToSvgPath(multi, { precision: 2 });
		expect(d).toMatch(/^M/);
		expect(d).toContain('2.12');
		expect(d.match(/Z/g)).toHaveLength(2);
		const back = flattenSvgPath(d);
		expect(Math.abs(back.reduce((s, r) => s + ringSignedArea(r), 0))).toBeCloseTo(91, 1);
		expect(polygonToSvgPath(rect(5, 5, 1, 1), { offset: { x: -5, y: -5 } })).toBe('M0 0L1 0L1 1L0 1Z');
		expect(formatNumber(-0.0001, 3)).toBe('0');
	});

	it('simplifies dense rings', () => {
		const dense = circle(0, 0, 100, 400);
		const simple = simplifyRing(dense, 1);
		expect(simple.length).toBeLessThan(80);
		expect(simple.length).toBeGreaterThan(8);
		expect(Math.abs(ringSignedArea(simple))).toBeGreaterThan(Math.PI * 10000 * 0.97);
		expect(simplifyRing([[0, 0], [1, 0], [2, 0], [3, 0]], 0.5)).toEqual([]);
		const d = polygonToSvgPath([[dense]], { simplify: 1 });
		expect(d.split('L').length).toBeLessThan(80);
	});
});

// ---------------------------------------------------------------------------
// Shape nodes
// ---------------------------------------------------------------------------

const shapeNode = (id: string, x: number, y: number, w: number, h: number, shape: any, extra: Partial<CanvasNode> = {}): CanvasNode => ({
	id,
	type: 'shape',
	position: { x, y },
	width: w,
	height: h,
	data: { label: id, shape },
	...extra
});

describe('combineShapeNodes', () => {
	const nodes = () => [
		shapeNode('a', 0, 0, 100, 100, { kind: 'rect', fill: 'red' }),
		shapeNode('b', 50, 50, 100, 100, { kind: 'rect', fill: 'blue', stroke: 'black' }),
		{ id: 'text', position: { x: 0, y: 0 }, data: { label: 'html' }, width: 50, height: 20 } as CanvasNode
	];

	it('unites shapes into one path node at the bounding box, styled from the back-most shape', () => {
		const result = combineShapeNodes(nodes(), ['a', 'b', 'text'], 'unite', { createId: () => 'u' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.removeIds).toEqual(['a', 'b']);
		expect(result.nodes).toHaveLength(1);
		const node = result.nodes[0];
		expect(node).toMatchObject({ id: 'u', type: 'shape', position: { x: 0, y: 0 }, width: 150, height: 150, selected: true });
		expect(node.data.label).toBe('a');
		expect(node.data.shape).toMatchObject({ kind: 'path', viewBox: [0, 0, 150, 150], fill: 'red' });
		expect(node.data.shape.stroke).toBeUndefined();
		const poly = shapeNodeToPolygon(node)!;
		expect(area(unionPolygons({ rings: poly.rings }, []))).toBeCloseTo(17500);
	});

	it('respects stacking order and the styleFrom option', () => {
		const stacked = nodes().map((n) => (n.id === 'a' ? { ...n, zIndex: 5 } : n));
		const top = combineShapeNodes(stacked, ['a', 'b'], 'unite', { createId: () => 'x', styleFrom: 'bottom' });
		expect(top.ok && top.nodes[0].data.shape.fill).toBe('blue');
		const first = combineShapeNodes(stacked, ['a', 'b'], 'unite', { styleFrom: 'first' });
		expect(first.ok && first.nodes[0].data.shape.fill).toBe('red');
		const byId = combineShapeNodes(stacked, ['a', 'b'], 'unite', { styleFrom: { id: 'b' }, nodeType: 'custom' });
		expect(byId.ok && byId.nodes[0].data.shape.fill).toBe('blue');
		expect(byId.ok && byId.nodes[0].type).toBe('custom');
		// Subtract removes the others from the back-most shape ('b' when 'a' is raised).
		const sub = combineShapeNodes(stacked, ['a', 'b'], 'subtract');
		expect(sub.ok && sub.nodes[0].position).toEqual({ x: 50, y: 50 });
	});

	it('subtracts, intersects and excludes', () => {
		const sub = combineShapeNodes(nodes(), ['a', 'b'], 'subtract');
		expect(sub.ok && sub.nodes[0]).toMatchObject({ position: { x: 0, y: 0 }, width: 100, height: 100 });
		const inter = combineShapeNodes(nodes(), ['a', 'b'], 'intersect');
		expect(inter.ok && inter.nodes[0]).toMatchObject({ position: { x: 50, y: 50 }, width: 50, height: 50 });
		const ex = combineShapeNodes(nodes(), ['a', 'b'], 'exclude');
		expect(ex.ok && ex.nodes).toHaveLength(1);
		const exPoly = ex.ok ? shapeNodeToPolygon(ex.nodes[0])! : null;
		expect(area(unionPolygons({ rings: exPoly!.rings }, []))).toBeCloseTo(15000);
	});

	it('divides into one node per region, styled from the top-most covering shape', () => {
		const result = combineShapeNodes(nodes(), ['a', 'b'], 'divide');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.nodes).toHaveLength(3);
		const overlap = result.nodes.find((n) => n.width === 50)!;
		expect(overlap.data.shape.fill).toBe('blue');
		expect(new Set(result.nodes.map((n) => n.id)).size).toBe(3);
	});

	it('refuses locked shapes, too few shapes and empty results', () => {
		const locked = lockNodes(nodes(), ['b']);
		expect(combineShapeNodes(locked, ['a', 'b'], 'unite')).toEqual({ ok: false, operation: 'unite', reason: 'locked' });
		expect(canCombineShapeNodes(locked, ['a', 'b'])).toEqual({ ok: false, reason: 'locked' });
		// A locked non-shape node in the selection does not matter.
		expect(canCombineShapeNodes(lockNodes(nodes(), ['text']), ['a', 'b', 'text']).ok).toBe(true);
		expect(combineShapeNodes(nodes(), ['a', 'text'], 'unite')).toMatchObject({ ok: false, reason: 'too-few' });
		const apart = [shapeNode('a', 0, 0, 10, 10, { kind: 'rect' }), shapeNode('b', 50, 0, 10, 10, { kind: 'ellipse' })];
		expect(combineShapeNodes(apart, ['a', 'b'], 'intersect')).toMatchObject({ ok: false, reason: 'empty' });
		expect(combineShapeNodes(apart, ['a', 'b'], 'unite').ok).toBe(true);
	});

	it('uses absolute geometry for sub-flows and keeps a shared parent', () => {
		const group: CanvasNode = { id: 'g', position: { x: 1000, y: 500 }, data: {}, width: 400, height: 400 };
		const list = [
			group,
			shapeNode('a', 10, 10, 50, 50, { kind: 'ellipse' }, { parentId: 'g' }),
			shapeNode('b', 40, 10, 50, 50, { kind: 'ellipse' }, { parentId: 'g' })
		];
		const result = combineShapeNodes(list, ['a', 'b'], 'unite');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.nodes[0].parentId).toBe('g');
		expect(result.nodes[0].position.x).toBeCloseTo(10, 1);
		expect(result.nodes[0].width).toBeCloseTo(80, 1);
		const mixed = [group, list[1], shapeNode('c', 1040, 510, 50, 50, { kind: 'ellipse' })];
		const top = combineShapeNodes(mixed, ['a', 'c'], 'unite');
		expect(top.ok && top.nodes[0].parentId).toBeUndefined();
		expect(top.ok && top.nodes[0].position.x).toBeCloseTo(1010, 1);
	});

	it('bakes rotation and view-box scaling into the result', () => {
		const list = [
			shapeNode('a', 0, 0, 100, 20, { kind: 'rect', rotation: 90 }),
			shapeNode('b', 0, 0, 10, 10, { kind: 'path', d: 'M0 0H1V1H0Z', viewBox: [0, 0, 1, 1] })
		];
		const result = combineShapeNodes(list, ['a', 'b'], 'unite');
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.nodes[0].position.x).toBeCloseTo(0);
		expect(result.nodes[0].position.y).toBeCloseTo(-40);
		expect(result.nodes[0].height).toBeCloseTo(100);
		expect(result.nodes[0].data.shape.rotation).toBeUndefined();
	});

	it('updates style sizes and drops lock / measurement fields', () => {
		const list = [
			shapeNode('a', 0, 0, 100, 100, { kind: 'rect' }, { style: { width: 100, height: 100, color: 'red' }, measured: { width: 100, height: 100 }, selected: true }),
			shapeNode('b', 50, 0, 100, 100, { kind: 'rect' }, { selected: true })
		];
		const result = combineShapeNodes(list, ['a', 'b'], 'unite');
		expect(result.ok && result.nodes[0].style).toEqual({ width: 150, height: 100, color: 'red' });
		expect(result.ok && result.nodes[0].measured).toBeUndefined();
	});

	it('applies and reverts a combination preserving array order', () => {
		const list = nodes();
		const result = combineShapeNodes(list, ['a', 'b'], 'unite', { createId: () => 'u' });
		if (!result.ok) throw new Error('expected ok');
		const applied = applyShapeCombination(list, result);
		expect(applied.map((n) => n.id)).toEqual(['u', 'text']);
		const reverted = revertShapeCombination(applied, result, list);
		expect(reverted.map((n) => n.id)).toEqual(['a', 'b', 'text']);
	});

	it('identifies shape nodes', () => {
		expect(isShapeNode(nodes()[0])).toBe(true);
		expect(isShapeNode(nodes()[2])).toBe(false);
		expect(getNodeShape(nodes()[2])).toBeNull();
		expect(shapeNodeToPolygon(nodes()[2])).toBeNull();
	});
});

describe('arrange controller shape operations', () => {
	function setup(history?: HistoryManager) {
		let nodes: CanvasNode[] = [
			shapeNode('a', 0, 0, 100, 100, { kind: 'rect' }, { selected: true }),
			shapeNode('b', 50, 50, 100, 100, { kind: 'ellipse' }, { selected: true }),
			{ id: 'other', position: { x: 500, y: 0 }, data: {}, width: 10, height: 10 }
		];
		let n = 0;
		const controller = createCanvasArrangeController({
			getNodes: () => nodes,
			setNodes: (next) => (nodes = next),
			history
		});
		return { controller, get nodes() { return nodes; }, nextId: () => `new-${n++}` };
	}

	it('combines the selection as one undoable step', () => {
		const history = new HistoryManager();
		const ctx = setup(history);
		expect(ctx.controller.canCombineShapes()).toBe(true);
		const result = ctx.controller.unite(undefined, { createId: () => 'u' });
		expect(result.ok).toBe(true);
		expect(ctx.nodes.map((n) => n.id)).toEqual(['u', 'other']);
		expect(history.getState().canUndo).toBe(true);
		history.undo();
		expect(ctx.nodes.map((n) => n.id)).toEqual(['a', 'b', 'other']);
		history.redo();
		expect(ctx.nodes.map((n) => n.id)).toEqual(['u', 'other']);
	});

	it('runs every operation and leaves nodes untouched on refusal', () => {
		for (const op of ['intersect', 'subtract', 'exclude', 'divide'] as const) {
			const ctx = setup();
			const result = ctx.controller[op]();
			expect(result.ok).toBe(true);
			expect(ctx.nodes.some((n) => n.id === 'a')).toBe(false);
		}
		const history = new HistoryManager();
		const ctx = setup(history);
		ctx.controller.lock(['a']);
		const before = ctx.nodes;
		expect(ctx.controller.canCombineShapes()).toBe(false);
		expect(ctx.controller.combineShapes('unite')).toMatchObject({ ok: false, reason: 'locked' });
		expect(ctx.nodes).toBe(before);
		expect(ctx.controller.unite(['b', 'other'])).toMatchObject({ ok: false, reason: 'too-few' });
	});
});
