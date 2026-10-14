// Fitting cases re-expressed from vectorcraft-main/crates/pathops/src/fit.rs and
// vectorcraft-main/crates/pathops/tests/ops.rs (MIT OR Apache-2.0, © ArtCraft Team and
// contributors). See THIRD_PARTY_NOTICES.md.
import { describe, it, expect } from 'vitest';
import {
	combineShapeNodes,
	cubicPointAt,
	fitCubicRun,
	fitCubics,
	fitFreehandPath,
	fitPathData,
	flattenSvgPath,
	isStraightCubic,
	multiPolygonArea,
	parseSvgPath,
	polygonToSvgPath,
	shapeNodeToPolygon,
	unionPolygons,
	type CanvasNode,
	type CubicSegment,
	type Point
} from '../src/canvas';

const sampleCubic = (c: CubicSegment, n: number): Point[] =>
	Array.from({ length: n + 1 }, (_, i) => cubicPointAt(c, i / n));

/** Largest distance from any input point to the (densely sampled) fitted curve. */
function maxDeviation(points: readonly Point[], segments: CubicSegment[]): number {
	const polylines = segments.map((c) => sampleCubic(c, 400));
	const segDist = (p: Point, a: Point, b: Point) => {
		const dx = b[0] - a[0];
		const dy = b[1] - a[1];
		const len2 = dx * dx + dy * dy;
		const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
		return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
	};
	let worst = 0;
	for (const p of points) {
		let best = Infinity;
		for (const line of polylines) for (let i = 1; i < line.length; i++) best = Math.min(best, segDist(p, line[i - 1], line[i]));
		worst = Math.max(worst, best);
	}
	return worst;
}

const circle = (cx: number, cy: number, r: number, n: number): Point[] =>
	Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)] as Point);

describe('fitCubics', () => {
	it('fits points sampled from one cubic with one cubic', () => {
		const c: CubicSegment = { p0: [0, 0], p1: [30, 60], p2: [70, 60], p3: [100, 0] };
		const pts = sampleCubic(c, 40);
		const out = fitCubicRun(pts, 0.05, [30, 60], [30, -60]);
		expect(out).toHaveLength(1);
		expect(Math.hypot(out[0].p1[0] - 30, out[0].p1[1] - 60)).toBeLessThan(1);
		// The default corner test sees no corner either.
		expect(fitCubics(pts, 0.05)).toHaveLength(1);
	});

	it('splits when one cubic is not enough and stays continuous', () => {
		const pts = Array.from({ length: 41 }, (_, i) => [i, Math.sin(i * 0.5) * 10] as Point);
		const out = fitCubics(pts, 0.1, { cornerAngleDeg: 180 });
		expect(out.length).toBeGreaterThan(1);
		for (let i = 1; i < out.length; i++) expect(out[i - 1].p3).toEqual(out[i].p0);
		expect(maxDeviation(pts, out)).toBeLessThanOrEqual(0.1 + 1e-6);
	});

	it('stays within tolerance on random smooth curves', () => {
		let seed = 7;
		const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 200 - 100;
		for (let trial = 0; trial < 20; trial++) {
			const c: CubicSegment = { p0: [rand(), rand()], p1: [rand(), rand()], p2: [rand(), rand()], p3: [rand(), rand()] };
			const pts = sampleCubic(c, 60);
			const tol = 0.2 + (trial % 5);
			const out = fitCubics(pts, tol, { cornerAngleDeg: 180 });
			expect(maxDeviation(pts, out)).toBeLessThanOrEqual(tol * 1.01 + 1e-6);
		}
	});

	it('fits a dense circle with few segments within tolerance', () => {
		const ring = circle(0, 0, 100, 128);
		const out = fitCubics(ring, 0.5, { closed: true });
		expect(out.length).toBeGreaterThanOrEqual(2);
		expect(out.length).toBeLessThanOrEqual(8);
		expect(maxDeviation(ring, out)).toBeLessThanOrEqual(0.5 + 1e-6);
		// Closed: ends where it starts, smoothly.
		expect(out[out.length - 1].p3).toEqual(out[0].p0);
	});

	it('keeps sharp corners as segment ends', () => {
		const square: Point[] = [];
		for (let i = 0; i <= 10; i++) square.push([i * 10, 0]);
		for (let i = 1; i <= 10; i++) square.push([100, i * 10]);
		for (let i = 1; i <= 10; i++) square.push([100 - i * 10, 100]);
		for (let i = 1; i < 10; i++) square.push([0, 100 - i * 10]);
		const out = fitCubics(square, 0.1, { closed: true });
		expect(out).toHaveLength(4);
		expect(out.every((c) => isStraightCubic(c, 1e-6))).toBe(true);
		const ends = out.map((c) => c.p0.join(',')).sort();
		expect(ends).toEqual(['0,0', '0,100', '100,0', '100,100']);
	});

	it('handles degenerate input', () => {
		expect(fitCubics([], 1)).toEqual([]);
		expect(fitCubics([[1, 1]], 1)).toEqual([]);
		expect(fitCubics([[1, 1], [1, 1], [1, 1]], 1)).toEqual([]);
		expect(fitCubics([[0, 0], [NaN, 1], [10, 0]], 1)).toHaveLength(1);
		const line = fitCubics([[0, 0], [5, 0], [10, 0]], 0.1);
		expect(line).toHaveLength(1);
		expect(isStraightCubic(line[0], 1e-9)).toBe(true);
		expect(fitCubics([[0, 0], [10, 0]], 1, { closed: true })).toHaveLength(2);
	});
});

describe('isStraightCubic', () => {
	it('detects straight cubics', () => {
		expect(isStraightCubic({ p0: [0, 0], p1: [3, 0], p2: [6, 0], p3: [9, 0] }, 1e-6)).toBe(true);
		expect(isStraightCubic({ p0: [0, 0], p1: [3, 1], p2: [6, 0], p3: [9, 0] }, 1e-6)).toBe(false);
		expect(isStraightCubic({ p0: [0, 0], p1: [0, 0], p2: [0, 0], p3: [0, 0] }, 1e-6)).toBe(true);
	});
});

describe('fitPathData', () => {
	it('turns a flattened circle back into a handful of curves of the same area', () => {
		const [ring] = flattenSvgPath('M0 50A50 50 0 1 1 100 50A50 50 0 1 1 0 50Z', { tolerance: 0.05 });
		const d = fitPathData(ring, { tolerance: 0.25 });
		const commands = parseSvgPath(d);
		expect(commands.filter((c) => c.type === 'C').length).toBeLessThanOrEqual(8);
		expect(commands.some((c) => c.type === 'L')).toBe(false);
		const area = multiPolygonArea(unionPolygons({ rings: flattenSvgPath(d, { tolerance: 0.05 }) }, []));
		expect(area).toBeGreaterThan(Math.PI * 2500 * 0.99);
		expect(area).toBeLessThan(Math.PI * 2500 * 1.01);
	});

	it('keeps polygons without curves as they are', () => {
		expect(fitPathData([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe('M0 0L10 0L10 10L0 10Z');
		expect(fitPathData([[0, 0], [10, 0], [10, 10], [0, 10]], { offset: { x: 1, y: 2 } })).toBe('M1 2L11 2L11 12L1 12Z');
		expect(fitPathData([])).toBe('');
	});

	it('mixes straight edges, corners and curves (a D shape)', () => {
		const ring: Point[] = [[0, 0]];
		for (let i = 0; i <= 64; i++) {
			const a = -Math.PI / 2 + (Math.PI * i) / 64;
			ring.push([50 + 50 * Math.cos(a), 50 + 50 * Math.sin(a)]);
		}
		ring.push([0, 100]);
		const d = fitPathData(ring, { tolerance: 0.25 });
		const commands = parseSvgPath(d);
		expect(commands.some((c) => c.type === 'C')).toBe(true);
		expect(commands.filter((c) => c.type === 'L').length).toBeGreaterThanOrEqual(2);
		expect(commands.length).toBeLessThan(ring.length / 4);
	});
});

describe('fitFreehandPath', () => {
	it('smooths a noisy open stroke and keeps its end points', () => {
		const pts = Array.from({ length: 80 }, (_, i) => [i * 2, Math.sin(i / 10) * 30 + (i % 2 ? 0.3 : -0.3)] as Point);
		const d = fitFreehandPath(pts, { tolerance: 1 });
		expect(d.startsWith('M0 -0.3')).toBe(true);
		expect(d.endsWith('Z')).toBe(false);
		const commands = parseSvgPath(d);
		expect(commands.filter((c) => c.type === 'C').length).toBeLessThan(10);
		const last = commands[commands.length - 1] as { x: number; y: number };
		expect(last.x).toBeCloseTo(158);
	});
});

describe('curves in polygonToSvgPath and combineShapeNodes', () => {
	it('writes lines by default and fitted curves with curves: "fit"', () => {
		const multi = [[circle(50, 50, 50, 96)]];
		expect(polygonToSvgPath(multi)).not.toContain('C');
		const fitted = polygonToSvgPath(multi, { curves: 'fit', curveTolerance: 0.25 });
		expect(fitted).toContain('C');
		expect(fitted.length).toBeLessThan(polygonToSvgPath(multi).length / 4);
	});

	const ellipse = (id: string, x: number): CanvasNode => ({
		id,
		type: 'shape',
		position: { x, y: 0 },
		width: 100,
		height: 100,
		data: { shape: { kind: 'ellipse' } }
	});

	it('unites ellipses into a curved path that keeps the area and the corners', () => {
		const nodes = [ellipse('a', 0), ellipse('b', 60)];
		const curved = combineShapeNodes(nodes, ['a', 'b'], 'unite');
		const straight = combineShapeNodes(nodes, ['a', 'b'], 'unite', { curves: 'lines' });
		expect(curved.ok && straight.ok).toBe(true);
		if (!curved.ok || !straight.ok) return;
		const d: string = curved.nodes[0].data.shape.d;
		expect(d).toContain('C');
		expect(straight.nodes[0].data.shape.d).not.toContain('C');
		expect(d.length).toBeLessThan(straight.nodes[0].data.shape.d.length / 1.5);
		expect(parseSvgPath(d).filter((c) => c.type === 'C').length).toBeLessThanOrEqual(12);
		const area = (node: CanvasNode) => multiPolygonArea(unionPolygons({ rings: shapeNodeToPolygon(node)!.rings }, []));
		// Exact union of two r = 50 circles 60 apart: 2πr² minus the lens.
		const exact = 2 * Math.PI * 2500 - (5000 * Math.acos(0.6) - 30 * 80);
		expect(Math.abs(area(curved.nodes[0]) - exact) / exact).toBeLessThan(0.005);
		expect(Math.abs(area(curved.nodes[0]) - exact)).toBeLessThan(Math.abs(area(straight.nodes[0]) - exact));
		// The two cusps where the circles cross stay sharp: segments start and end there.
		const ends = parseSvgPath(d)
			.filter((c) => c.type === 'C' || c.type === 'M')
			.map((c: any) => `${Math.round(c.x)},${Math.round(c.y)}`);
		expect(ends).toContain('80,10');
		expect(ends).toContain('80,90');
	});
});
