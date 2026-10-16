/**
 * Pathfinder operations, planar maps (faces, merges, edge runs) and fill regions.
 *
 * Cases re-expressed from vectorcraft-main/crates/pathops/src/{pathfinder.rs,planar.rs} tests and
 * cadcraft-main/crates/geom/src/region.rs tests (MIT OR Apache-2.0, © ArtCraft Team and
 * contributors). See THIRD_PARTY_NOTICES.md.
 */
import { describe, it, expect } from 'vitest';
import {
	bezierPathArea,
	bezierPathSignedArea,
	closeContour,
	pathToContours,
	pathfinder,
	PlanarMap,
	interiorPoint,
	pointInBezierPath,
	type BezierPath,
	type PathfinderShape
} from '../src/canvas/pathops';
import type { Point } from '../src/canvas/types';

const rect = (x0: number, y0: number, x1: number, y1: number) => `M${x0} ${y0}L${x1} ${y0}L${x1} ${y1}L${x0} ${y1}Z`;
const line = (a: Point, b: Point) => `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`;
const circle = (cx: number, cy: number, r: number) => {
	const k = 0.5522847498307936 * r;
	return `M${cx + r} ${cy}C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r}C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy}C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r}C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy}Z`;
};
const area = (p: BezierPath) => bezierPathArea(p);
const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('PlanarMap', () => {
	it('three crossing lines enclose one unfilled triangle, and the lines come back cut', () => {
		const map = PlanarMap.build([
			{ path: line([0, 0], [100, 100]) },
			{ path: line([100, 0], [0, 100]) },
			{ path: line([-10, 80], [110, 80]) }
		])!;
		const faces = map.faces;
		expect(faces).toHaveLength(1);
		near(faces[0].area, 900);
		expect(map.faceSources(0)).toEqual([]);
		expect(pathToContours(faces[0].path)).toHaveLength(1);
		expect(closeContour(pathToContours(faces[0].path)[0])).toHaveLength(3);
		const chains = map.chains();
		expect(chains).toHaveLength(9);
		expect(chains.filter((c) => c.source === 2)).toHaveLength(3);
		expect(chains.every((c) => !c.closed)).toBe(true);
	});

	it('a grid of lines makes its cells', () => {
		const inputs = [];
		for (let k = 0; k < 4; k++) {
			inputs.push({ path: line([k * 10, -5], [k * 10, 35]) }, { path: line([-5, k * 10], [35, k * 10]) });
		}
		const map = PlanarMap.build(inputs)!;
		expect(map.faces).toHaveLength(9);
		for (const f of map.faces) near(f.area, 100);
		const at = map.faceAt([15, 15]);
		expect(at).toBeGreaterThanOrEqual(0);
		expect(pointInBezierPath(map.faces[at].path, [15, 15])).toBe(true);
	});

	it('a line across a shape splits it, both halves keeping its fill', () => {
		const map = PlanarMap.build([{ path: rect(0, 0, 100, 50) }, { path: line([40, -20], [60, 70]), fills: false }])!;
		expect(map.faces).toHaveLength(2);
		expect(map.faces.map((_, i) => map.faceSources(i))).toEqual([[0], [0]]);
		near(map.faces.reduce((s, f) => s + f.area, 0), 5000);
		const chains = map.chains();
		expect(chains.filter((c) => c.source === 0)).toHaveLength(2);
		expect(chains.filter((c) => c.source === 1)).toHaveLength(3);
	});

	it('overlapping shapes keep their coverage per face', () => {
		const map = PlanarMap.build([{ path: rect(0, 0, 100, 100) }, { path: rect(50, 0, 150, 100) }])!;
		expect(map.faces).toHaveLength(3);
		expect(map.faceSources(map.faceAt([25, 50]))).toEqual([0]);
		expect(map.faceSources(map.faceAt([75, 50]))).toEqual([0, 1]);
		expect(map.faceSources(map.faceAt([125, 50]))).toEqual([1]);
	});

	it('a loop inside a shape is a hole of the face around it and a face of its own', () => {
		const map = PlanarMap.build([{ path: rect(0, 0, 100, 100) }, { path: rect(30, 30, 70, 70), fills: false }])!;
		expect(map.faces).toHaveLength(2);
		const outer = map.faceAt([10, 10]);
		const inner = map.faceAt([50, 50]);
		expect(outer).not.toBe(inner);
		near(map.faces[outer].area, 10000 - 1600);
		expect(pointInBezierPath(map.faces[outer].path, [50, 50])).toBe(false);
		expect(map.faceSources(inner)).toEqual([0]);
	});

	it('nested pieces are holes only of the face directly around them', () => {
		const map = PlanarMap.build([{ path: rect(0, 0, 100, 100) }, { path: rect(20, 20, 80, 80) }, { path: rect(40, 40, 60, 60) }])!;
		const ring = map.faceAt([10, 10]);
		near(map.faces[ring].area, 10000 - 3600);
		const middle = map.faceAt([30, 30]);
		near(map.faces[middle].area, 3600 - 400);
		expect(pointInBezierPath(map.faces[ring].path, [50, 50])).toBe(false);
		expect(map.faceSources(map.faceAt([50, 50]))).toEqual([0, 1, 2]);
	});

	it('merging faces leaves no seam, and loose line ends drop out', () => {
		const map = PlanarMap.build([{ path: rect(0, 0, 100, 50) }, { path: line([50, -20], [50, 70]), fills: false }])!;
		const merged = map.merge([0, 1]);
		const contours = pathToContours(merged);
		expect(contours).toHaveLength(1);
		// The two halves of the top and bottom sides join again into one line each.
		expect(contours[0].segments.length).toBeLessThanOrEqual(5);
		near(area(merged), 5000);
		expect(bezierPathSignedArea(merged)).toBeGreaterThan(0);
	});

	it('merging around a hole keeps the hole', () => {
		const map = PlanarMap.build([{ path: rect(0, 0, 100, 100) }, { path: line([50, -10], [50, 110]), fills: false }, { path: rect(20, 40, 30, 60) }])!;
		const left = map.faceAt([10, 10]);
		const right = map.faceAt([90, 10]);
		const merged = map.merge([left, right]);
		near(area(merged), 10000 - 200);
		expect(pointInBezierPath(merged, [25, 50])).toBe(false);
	});

	it('curves stay exact through the split and the merge', () => {
		const map = PlanarMap.build([{ path: circle(50, 50, 40) }, { path: line([-10, 50], [110, 50]), fills: false }])!;
		expect(map.faces).toHaveLength(2);
		near(map.faces[0].area + map.faces[1].area, Math.PI * 1600, 2);
		const merged = map.merge([0, 1]);
		// The quarter arcs cut by the line join back into four cubics.
		expect(pathToContours(merged)[0].segments.filter((s) => s.length === 4)).toHaveLength(4);
	});

	it('gives no map for nothing or non-finite input', () => {
		expect(PlanarMap.build([])).toBeNull();
		expect(PlanarMap.build([{ path: 'M0 0L0 0' }])).toBeNull();
		expect(PlanarMap.build([{ path: [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: NaN, y: 1 }] }])).toBeNull();
	});

	it('finds a point inside a ring, away from its hole', () => {
		const p = interiorPoint(rect(0, 0, 100, 100) + rect(10, 10, 90, 90).replace(/L/g, ' L'))!;
		expect(p).not.toBeNull();
	});
});

describe('PlanarMap.regionAt (fill regions)', () => {
	const square = (x: number, y: number, s: number) => rect(x, y, x + s, y + s);

	it('traces the loop around a point from four separate lines', () => {
		const map = PlanarMap.build([
			{ path: line([0, 0], [100, 0]) },
			{ path: line([100, -5], [100, 105]) },
			{ path: line([105, 100], [-5, 100]) },
			{ path: line([0, 100], [0, 0]) }
		])!;
		const region = map.regionAt([50, 50])!;
		near(area(region), 10000);
		expect(map.regionAt([200, 50])).toBeNull();
	});

	it('takes islands as holes but not islands inside islands', () => {
		const map = PlanarMap.build([{ path: square(0, 0, 100) }, { path: square(20, 20, 60) }, { path: square(40, 40, 20) }])!;
		const ring = map.regionAt([10, 10])!;
		near(area(ring), 10000 - 3600);
		expect(pointInBezierPath(ring, [50, 50])).toBe(false);
		const middle = map.regionAt([30, 30])!;
		near(area(middle), 3600 - 400);
		near(area(map.regionAt([50, 50])!), 400);
	});

	it('finds the face past an island the ray hits first', () => {
		const map = PlanarMap.build([{ path: square(0, 0, 100) }, { path: square(60, 40, 20) }])!;
		const region = map.regionAt([20, 50])!;
		near(area(region), 10000 - 400);
	});

	it('closes small gaps between loose ends only when asked', () => {
		const open = 'M0 0L100 0L100 100L0 100L0 4';
		expect(PlanarMap.build([{ path: open }])!.regionAt([50, 50])).toBeNull();
		const closed = PlanarMap.build([{ path: open }], { gap: 5 })!.regionAt([50, 50]);
		expect(closed).not.toBeNull();
		near(area(closed!), 10000);
		expect(PlanarMap.build([{ path: open }], { gap: 3 })?.regionAt([50, 50]) ?? null).toBeNull();
	});
});

describe('pathfinder', () => {
	const two: PathfinderShape[] = [{ path: rect(0, 0, 100, 100) }, { path: rect(50, 50, 150, 150) }];
	const covers = (p: BezierPath, x: number, y: number) => pointInBezierPath(p, [x, y]);

	it('divide: every face is a piece painted like its top-most shape', () => {
		const { pieces } = pathfinder('divide', two);
		expect(pieces).toHaveLength(3);
		near(pieces.reduce((s, p) => s + area(p.path), 0), 17500);
		const overlap = pieces.find((p) => covers(p.path, 75, 75))!;
		expect(overlap.source).toBe(1);
		near(area(overlap.path), 2500);
		expect(pieces.find((p) => covers(p.path, 10, 10))!.source).toBe(0);
	});

	it('divide: open lines cut the faces without becoming pieces', () => {
		const { pieces } = pathfinder('divide', [{ path: rect(0, 0, 100, 100), key: 7 }, { path: line([-10, 50], [110, 50]), line: true }]);
		expect(pieces).toHaveLength(2);
		expect(pieces.every((p) => p.source === 0)).toBe(true);
		near(pieces.reduce((s, p) => s + area(p.path), 0), 10000);
		const crossed = pathfinder('divide', [{ path: rect(0, 0, 100, 100) }, { path: line([-10, 50], [110, 50]), line: true }, { path: line([50, -10], [50, 110]), line: true }]);
		expect(crossed.pieces).toHaveLength(4);
	});

	it('divide keeps holes', () => {
		const ring = rect(0, 0, 100, 100) + rect(30, 30, 70, 70).replace('M30 30L70 30L70 70L30 70', 'M30 30L30 70L70 70L70 30');
		const { pieces } = pathfinder('divide', [{ path: ring }, { path: rect(50, -10, 150, 110) }]);
		const left = pieces.find((p) => covers(p.path, 10, 50))!;
		expect(left.source).toBe(0);
		expect(covers(left.path, 40, 50)).toBe(false);
		// The union: the ring (8400) and the rectangle (12000) less their overlap (5000 − 800).
		near(pieces.reduce((s, p) => s + area(p.path), 0), 8400 + 12000 - 4200);
	});

	it('trim removes hidden parts and merges nothing', () => {
		const { pieces } = pathfinder('trim', [...two, { path: rect(120, 0, 200, 40), key: 0 }]);
		expect(pieces.map((p) => p.source)).toEqual([0, 1, 2]);
		near(area(pieces[0].path), 7500);
		near(area(pieces[1].path), 10000);
		expect(covers(pieces[0].path, 75, 75)).toBe(false);
	});

	it('merge joins touching visible parts of one paint', () => {
		const same = pathfinder('merge', [
			{ path: rect(0, 0, 100, 100), key: 'red' },
			{ path: rect(50, 50, 150, 150), key: 'red' },
			{ path: rect(300, 0, 400, 100), key: 'red' }
		]);
		expect(same.pieces).toHaveLength(2);
		near(area(same.pieces[0].path), 17500);
		// Painted like the front-most shape of that paint.
		expect(same.pieces.every((p) => p.source === 2)).toBe(true);
		const different = pathfinder('merge', [
			{ path: rect(0, 0, 100, 100), key: 'red' },
			{ path: rect(50, 50, 150, 150), key: 'blue' }
		]);
		expect(different.pieces).toHaveLength(2);
		near(area(different.pieces.find((p) => p.source === 0)!.path), 7500);
	});

	it('crop keeps the parts of the lower shapes inside the top one', () => {
		const { pieces } = pathfinder('crop', [{ path: rect(0, 0, 100, 100) }, { path: rect(80, 0, 120, 100) }, { path: rect(50, 50, 150, 150) }]);
		expect(pieces.map((p) => p.source)).toEqual([0, 1]);
		near(area(pieces[0].path), 30 * 50);
		near(area(pieces[1].path), 40 * 50);
		expect(pathfinder('crop', [{ path: rect(0, 0, 10, 10) }]).pieces).toEqual([]);
	});

	it('outline cuts every outline where it meets another, keyed by the shape it bounds', () => {
		const { pieces } = pathfinder('outline', two);
		expect(pieces).toHaveLength(4);
		expect(pieces.every((p) => p.open)).toBe(true);
		expect(pieces.filter((p) => p.source === 0)).toHaveLength(2);
		const shared = pathfinder('outline', [{ path: rect(0, 0, 100, 100) }, { path: rect(100, 0, 200, 100) }]);
		// The shared side is one edge, painted like the front shape.
		expect(shared.pieces.filter((p) => p.source === 1)).toHaveLength(2);
		expect(shared.pieces).toHaveLength(3);
		const alone = pathfinder('outline', [{ path: rect(0, 0, 10, 10) }]);
		expect(alone.pieces).toHaveLength(1);
		expect(alone.pieces[0].open).toBe(false);
	});

	it('minus back subtracts everything behind from the top shape', () => {
		const { pieces } = pathfinder('minusBack', [{ path: rect(0, 0, 100, 100) }, { path: rect(-50, 80, 20, 200) }, ...two.slice(1)]);
		expect(pieces).toHaveLength(1);
		expect(pieces[0].source).toBe(2);
		near(area(pieces[0].path), 7500);
	});
});
