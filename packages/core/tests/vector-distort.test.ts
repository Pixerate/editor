// Distort and envelope geometry: homographies, adaptive path mapping, warp presets and Bézier
// meshes. Behaviour after ArtCraft pdfcraft `crates/geom/src/perspective.rs`, photocraft
// `crates/vector/src/map.rs` and `crates/geom/src/warp.rs` (MIT OR Apache-2.0, © ArtCraft Team and
// contributors), test cases re-expressed. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import {
	VECTOR_WARP_STYLES,
	VectorEditorController,
	applyMatrix,
	createVectorCommands,
	getVectorEffectsPanel,
	getVectorEnvelopePanel,
	getVectorOverlayRenderData,
	parseVectorSvg,
	rotateMatrix,
	vectorAppearanceShapes,
	vectorNodeBounds,
	vectorPathWorldBezier,
	vectorWorldMatrix,
	type VectorNode,
	type VectorPathNode,
	applyVectorHomography,
	dragVectorMeshPoint,
	ellipseSubpath,
	evalVectorMesh,
	fitVectorMesh,
	mapBezierPath,
	mapVectorPoints,
	mapVectorSubpaths,
	orderVectorQuad,
	pullVectorMesh,
	rectSubpath,
	removeVectorMeshSplitU,
	resizeVectorMesh,
	splitVectorMeshU,
	splitVectorMeshV,
	subpathsToBezier,
	vectorHomography,
	vectorHomographyKeepsQuad,
	vectorIdentityMesh,
	vectorMeshColumns,
	vectorMeshFromOutline,
	vectorMeshOutline,
	vectorMeshRows,
	vectorWarpPresetMesh,
	type Vec2,
	type VectorSubpath,
	type VectorWarpMesh,
	type VectorWarpStyle
} from '../src/vector/index.js';
import { pathToContours, segmentNearest, segmentPoint } from '../src/canvas/pathops/bezier.js';
import { CommandRegistry } from '../src/commands/index.js';

const near = (a: Vec2, b: Vec2, eps = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) <= eps;

/** Largest distance from samples of `truth(t)` (t in 0–1) to the nearest point of `path`. */
function maxDeviation(path: ReturnType<typeof subpathsToBezier>, truth: (t: number) => Vec2, n = 200): number {
	const segs = pathToContours(path).flatMap((c) => c.segments);
	let worst = 0;
	for (let i = 0; i <= n; i++) {
		const p = truth(i / n);
		let best = Infinity;
		for (const s of segs) best = Math.min(best, segmentNearest(s, [p.x, p.y]).distance);
		worst = Math.max(worst, best);
	}
	return worst;
}

const anchorsOf = (sps: VectorSubpath[]) => sps.reduce((n, sp) => n + sp.anchors.length, 0);

describe('homography', () => {
	const from: Vec2[] = [
		{ x: 20, y: 35 },
		{ x: 380, y: 10 },
		{ x: 420, y: 500 },
		{ x: -10, y: 470 }
	];
	const to: Vec2[] = [
		{ x: 0, y: 0 },
		{ x: 300, y: 0 },
		{ x: 300, y: 450 },
		{ x: 0, y: 450 }
	];

	it('takes each of the four corners exactly onto its target', () => {
		const h = vectorHomography(from, to)!;
		from.forEach((p, i) => expect(near(applyVectorHomography(h, p)!, to[i], 1e-7)).toBe(true));
	});

	it('is the identity from a rectangle onto itself, and its inverse takes points back', () => {
		const id = vectorHomography(to, to)!;
		expect(near(applyVectorHomography(id, { x: 12, y: 99 })!, { x: 12, y: 99 })).toBe(true);
		const h = vectorHomography(from, to)!;
		const back = vectorHomography(to, from)!;
		const p = { x: 150, y: 210 };
		expect(near(applyVectorHomography(back, applyVectorHomography(h, p)!)!, p, 1e-7)).toBe(true);
	});

	it('keeps straight lines straight', () => {
		const h = vectorHomography(to, from)!;
		const a = { x: 30, y: 400 };
		const b = { x: 280, y: 25 };
		const pa = applyVectorHomography(h, a)!;
		const pb = applyVectorHomography(h, b)!;
		for (const t of [0.1, 0.37, 0.5, 0.81]) {
			const q = applyVectorHomography(h, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })!;
			const cross = (pb.x - pa.x) * (q.y - pa.y) - (pb.y - pa.y) * (q.x - pa.x);
			expect(Math.abs(cross) / Math.hypot(pb.x - pa.x, pb.y - pa.y)).toBeLessThan(1e-7);
		}
	});

	it('has no map for collinear, coincident or non-finite points', () => {
		expect(vectorHomography([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 5, y: 5 }], to)).toBeNull();
		expect(vectorHomography([{ x: 3, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 3 }], to)).toBeNull();
		expect(vectorHomography([{ x: NaN, y: 0 }, ...to.slice(1)], to)).toBeNull();
		expect(vectorHomography([{ x: Infinity, y: 0 }, ...to.slice(1)], to)).toBeNull();
	});

	it('knows when a quad would be sent through infinity', () => {
		const ok = vectorHomography(to, from)!;
		expect(vectorHomographyKeepsQuad(ok, to)).toBe(true);
		// A bow-tie target folds the box over the horizon.
		const twisted = vectorHomography(to, [to[0], to[2], to[1], to[3]]);
		expect(!twisted || !vectorHomographyKeepsQuad(twisted, to)).toBe(true);
	});

	it('orders a convex quad top-left first, clockwise on screen, and refuses darts', () => {
		const [tl, tr, br, bl] = [
			{ x: 8, y: 14 },
			{ x: 190, y: 4 },
			{ x: 215, y: 290 },
			{ x: 2, y: 280 }
		];
		for (const q of [
			[br, tl, bl, tr],
			[bl, br, tr, tl],
			[tr, bl, tl, br]
		])
			expect(orderVectorQuad(q)).toEqual([tl, tr, br, bl]);
		expect(orderVectorQuad([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 25, y: 25 }, { x: 0, y: 100 }])).toBeNull();
		expect(orderVectorQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }])).toBeNull();
	});
});

describe('adaptive path mapping', () => {
	const square: VectorSubpath[] = [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })];

	it('maps every anchor and handle without adding any (mapVectorPoints)', () => {
		const out = mapVectorPoints(square, (p) => ({ x: p.x * 2, y: p.y + p.x }));
		expect(out[0].anchors).toHaveLength(4);
		expect(out[0].anchors[2]).toMatchObject({ x: 200, y: 200 });
	});

	it('keeps lines straight through a projective map and puts the corners exactly', () => {
		const quad = [
			{ x: 10, y: 0 },
			{ x: 90, y: 20 },
			{ x: 120, y: 110 },
			{ x: -15, y: 95 }
		];
		const h = vectorHomography(
			[
				{ x: 0, y: 0 },
				{ x: 100, y: 0 },
				{ x: 100, y: 100 },
				{ x: 0, y: 100 }
			],
			quad
		)!;
		const out = mapVectorSubpaths(square, (p) => applyVectorHomography(h, p)!, 0.01);
		expect(out[0].anchors).toHaveLength(4);
		out[0].anchors.forEach((a, i) => {
			expect(near(a, quad[i], 1e-9)).toBe(true);
			expect(a.in ?? null).toBeNull();
			expect(a.out ?? null).toBeNull();
		});
	});

	it('follows a curve through a projective map within the tolerance', () => {
		const ellipse = [ellipseSubpath({ x: 0, y: 0, width: 100, height: 60 })];
		const h = vectorHomography(
			[
				{ x: 0, y: 0 },
				{ x: 100, y: 0 },
				{ x: 100, y: 60 },
				{ x: 0, y: 60 }
			],
			[
				{ x: 0, y: 0 },
				{ x: 140, y: 30 },
				{ x: 120, y: 90 },
				{ x: 10, y: 70 }
			]
		)!;
		const f = (p: Vec2) => applyVectorHomography(h, p)!;
		const tol = 0.05;
		const out = subpathsToBezier(mapVectorSubpaths(ellipse, f, tol), { corners: false });
		const src = pathToContours(subpathsToBezier(ellipse)).flatMap((c) => c.segments);
		const truth = (t: number) => {
			const k = Math.min(src.length - 1, Math.floor(t * src.length));
			const p = segmentPoint(src[k], t * src.length - k);
			return f({ x: p[0], y: p[1] });
		};
		expect(maxDeviation(out, truth, 400)).toBeLessThan(tol * 1.5);
	});

	it('splits segments a curved map bends, stays within tolerance, and refits to fewer anchors', () => {
		const bend = (p: Vec2) => ({ x: p.x, y: p.y - (p.x - 50) ** 2 * 0.02 });
		const tol = 0.02;
		const split = mapVectorSubpaths(square, bend, tol, { refit: false });
		const fitted = mapVectorSubpaths(square, bend, tol);
		expect(anchorsOf(split)).toBeGreaterThan(4);
		expect(anchorsOf(fitted)).toBeLessThan(anchorsOf(split));
		// Every point of the top edge (y = 0) lands on y = −(x − 50)² / 50.
		const top = (t: number) => bend({ x: 100 * t, y: 0 });
		for (const sps of [split, fitted]) {
			const path = subpathsToBezier(sps, { corners: false });
			expect(maxDeviation(path, top)).toBeLessThan(tol * 1.5);
			// The sides are only shifted, so the corners stay exact.
			expect(near(sps[0].anchors[0], bend({ x: 0, y: 0 }))).toBe(true);
		}
		// The right side moves straight down by the same amount: it stays one straight segment.
		const k = fitted[0].anchors.findIndex((a) => near(a, bend({ x: 100, y: 0 })));
		expect(near(fitted[0].anchors[k + 1], bend({ x: 100, y: 100 }))).toBe(true);
		expect(fitted[0].anchors[k].out ?? null).toBeNull();
	});

	it('maps Bézier commands too', () => {
		const out = mapBezierPath('M0 0L10 0L10 10Z', (p) => ({ x: p.x + 5, y: p.y * 2 }));
		expect(out[0]).toMatchObject({ type: 'M', x: 5, y: 0 });
		expect(out.filter((c) => c.type === 'L')).toHaveLength(2);
	});
});

const BOX = { x: 100, y: 50, width: 200, height: 120 };
const warp = (style: VectorWarpStyle, bend = 50, extra: { horizontal?: number; vertical?: number; orientation?: 'horizontal' | 'vertical' } = {}) =>
	vectorWarpPresetMesh({ style, bend, ...extra }, BOX)!;
const at = (m: VectorWarpMesh, s: number, t: number) => evalVectorMesh(m, s, t);
const rest = (s: number, t: number) => ({ x: BOX.x + s * BOX.width, y: BOX.y + t * BOX.height });
const delta = (m: VectorWarpMesh, s: number, t: number) => {
	const p = at(m, s, t);
	const r = rest(s, t);
	return { x: p.x - r.x, y: p.y - r.y };
};
const CORNERS: [number, number][] = [
	[0, 0],
	[1, 0],
	[1, 1],
	[0, 1]
];

describe('warp presets', () => {
	it('are the identity at bend 0 and move something at bend 50', () => {
		for (const style of VECTOR_WARP_STYLES) {
			expect(vectorWarpPresetMesh({ style, bend: 0 }, BOX)).toBeNull();
			const m = warp(style);
			let moved = 0;
			for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) moved = Math.max(moved, Math.hypot(delta(m, i / 8, j / 8).x, delta(m, i / 8, j / 8).y));
			expect(moved, style).toBeGreaterThan(1);
		}
		expect(vectorWarpPresetMesh({ style: 'arc', bend: 50 }, { x: 0, y: 0, width: 0, height: 10 })).toBeNull();
	});

	// For each preset at bend +50: whether the corners stay, and which way the middle of each edge
	// goes (y for top / bottom, x for left / right; 0: stays).
	type Edge = -1 | 0 | 1;
	const table: Record<VectorWarpStyle, { corners: 'fixed' | 'left moved' | 'top moved' | 'bottom moved'; top: Edge; bottom: Edge; left: Edge; right: Edge }> = {
		// The inside edge of the bend keeps its chord; the outside one spreads.
		arc: { corners: 'top moved', top: -1, bottom: -1, left: -1, right: 1 },
		arcLower: { corners: 'fixed', top: 0, bottom: 1, left: 0, right: 0 },
		arcUpper: { corners: 'fixed', top: -1, bottom: 0, left: 0, right: 0 },
		arch: { corners: 'fixed', top: -1, bottom: -1, left: 0, right: 0 },
		bulge: { corners: 'fixed', top: -1, bottom: 1, left: 0, right: 0 },
		shellLower: { corners: 'bottom moved', top: 0, bottom: 1, left: -1, right: 1 },
		shellUpper: { corners: 'top moved', top: -1, bottom: 0, left: -1, right: 1 },
		flag: { corners: 'fixed', top: 0, bottom: 0, left: 0, right: 0 },
		wave: { corners: 'fixed', top: 0, bottom: 0, left: 0, right: 0 },
		fish: { corners: 'fixed', top: 0, bottom: 0, left: 0, right: 0 },
		rise: { corners: 'left moved', top: 1, bottom: 1, left: 1, right: 0 },
		fisheye: { corners: 'fixed', top: 0, bottom: 0, left: 0, right: 0 },
		inflate: { corners: 'fixed', top: -1, bottom: 1, left: -1, right: 1 },
		squeeze: { corners: 'fixed', top: -1, bottom: 1, left: 1, right: -1 },
		twist: { corners: 'fixed', top: 0, bottom: 0, left: 0, right: 0 }
	};
	const sign = (v: number): Edge => (Math.abs(v) < 1e-6 ? 0 : v > 0 ? 1 : -1);

	for (const style of Object.keys(table) as VectorWarpStyle[]) {
		it(`${style}: corners and edges`, () => {
			const want = table[style];
			const m = warp(style);
			const moved = CORNERS.map(([s, t]) => Math.hypot(delta(m, s, t).x, delta(m, s, t).y) > 1e-6);
			const expected =
				want.corners === 'fixed'
					? [false, false, false, false]
					: want.corners === 'left moved'
						? [true, false, false, true]
						: want.corners === 'top moved'
							? [true, true, false, false]
							: [false, false, true, true];
			expect(moved).toEqual(expected);
			// Rise moves the left half of the box down, so the edge midpoints are measured there too.
			expect(sign(delta(m, 0.5, 0).y), 'top').toBe(want.top);
			expect(sign(delta(m, 0.5, 1).y), 'bottom').toBe(want.bottom);
			expect(sign(delta(m, 0, 0.5)[style === 'rise' ? 'y' : 'x']), 'left').toBe(want.left);
			expect(sign(delta(m, 1, 0.5).x), 'right').toBe(want.right);
		});
	}

	it('flag, fish and wave move the quarters of their edges, fisheye and twist only the inside', () => {
		expect(delta(warp('flag'), 0.25, 0).y).toBeLessThan(-1);
		expect(delta(warp('flag'), 0.75, 0).y).toBeGreaterThan(1);
		expect(delta(warp('fish'), 0.25, 0).y).toBeLessThan(-1);
		expect(delta(warp('fish'), 0.25, 1).y).toBeGreaterThan(1);
		expect(Math.abs(delta(warp('wave'), 0.25, 0).y)).toBeLessThan(1e-9);
		expect(Math.abs(delta(warp('wave'), 0.25, 0.5).y)).toBeGreaterThan(1);
		for (const style of ['fisheye', 'twist'] as const) {
			const m = warp(style);
			for (let k = 0; k <= 10; k++) {
				for (const [s, t] of [
					[k / 10, 0],
					[k / 10, 1],
					[0, k / 10],
					[1, k / 10]
				])
					expect(Math.hypot(delta(m, s, t).x, delta(m, s, t).y)).toBeLessThan(1e-9);
			}
			expect(Math.hypot(delta(m, 0.5, 0.5).x, delta(m, 0.5, 0.5).y)).toBeLessThan(1e-9);
		}
		// Fisheye pushes points away from the centre.
		expect(delta(warp('fisheye'), 0.3, 0.3).x).toBeLessThan(0);
		expect(delta(warp('fisheye'), 0.7, 0.7).y).toBeGreaterThan(0);
	});

	it('bends the arc family into circles in the box’s own pixels', () => {
		for (const style of ['arc', 'arch', 'bulge'] as const) {
			const m = warp(style, 60);
			const pts = [0, 0.2, 0.5, 0.8, 1].map((s) => at(m, s, 0));
			// The circle through three of the points passes through the others.
			const [a, b, c] = [pts[0], pts[2], pts[4]];
			const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
			const ux = ((a.x ** 2 + a.y ** 2) * (b.y - c.y) + (b.x ** 2 + b.y ** 2) * (c.y - a.y) + (c.x ** 2 + c.y ** 2) * (a.y - b.y)) / d;
			const uy = ((a.x ** 2 + a.y ** 2) * (c.x - b.x) + (b.x ** 2 + b.y ** 2) * (a.x - c.x) + (c.x ** 2 + c.y ** 2) * (b.x - a.x)) / d;
			const r = Math.hypot(a.x - ux, a.y - uy);
			for (const p of pts) expect(Math.abs(Math.hypot(p.x - ux, p.y - uy) - r) / r, style).toBeLessThan(0.003);
		}
	});

	it('bends the other way with a negative bend, and vertically as the transposed warp', () => {
		expect(delta(warp('bulge', -50), 0.5, 0).y).toBeGreaterThan(1);
		const v = warp('arcLower', 50, { orientation: 'vertical' });
		// The right side bows out and the left one stays.
		expect(delta(v, 1, 0.5).x).toBeGreaterThan(1);
		expect(Math.abs(delta(v, 0, 0.5).x)).toBeLessThan(1e-9);
	});

	it('distorts horizontally and vertically by scaling the columns and rows', () => {
		const h = vectorWarpPresetMesh({ style: 'arc', bend: 0, horizontal: 50 }, BOX)!;
		// The left column shrinks to half its height about its middle, the right grows by half.
		expect(near(at(h, 0, 0), { x: BOX.x, y: BOX.y + BOX.height / 4 })).toBe(true);
		expect(near(at(h, 1, 0), { x: BOX.x + BOX.width, y: BOX.y - BOX.height / 4 })).toBe(true);
		const v = vectorWarpPresetMesh({ style: 'arc', bend: 0, vertical: 50 }, BOX)!;
		expect(near(at(v, 0, 0), { x: BOX.x + BOX.width / 4, y: BOX.y })).toBe(true);
		expect(near(at(v, 1, 1), { x: BOX.x + BOX.width * 1.25, y: BOX.y + BOX.height })).toBe(true);
	});
});

describe('Bézier meshes', () => {
	const samples = (m: VectorWarpMesh) => [0, 0.13, 0.4, 0.5, 0.77, 1].flatMap((s) => [0, 0.21, 0.5, 0.9, 1].map((t) => at(m, s, t)));

	it('the identity mesh is the box, and fitting reproduces an affine map exactly', () => {
		const id = vectorIdentityMesh(BOX, 3, 2);
		expect(vectorMeshColumns(id)).toBe(10);
		expect(vectorMeshRows(id)).toBe(7);
		for (const [s, t] of [
			[0.3, 0.7],
			[0.95, 0.05]
		])
			expect(near(at(id, s, t), rest(s, t), 1e-9)).toBe(true);
		const affine = (s: number, t: number) => ({ x: 3 + 2 * s - t, y: 7 + 0.5 * s + 4 * t });
		const fit = fitVectorMesh(affine, [0, 0.5, 1], [0, 1]);
		expect(near(at(fit, 0.33, 0.61), affine(0.33, 0.61), 1e-9)).toBe(true);
	});

	it('splits exactly with de Casteljau, refuses splits on a boundary, and merges back', () => {
		const m = warp('fisheye', 70);
		const split = splitVectorMeshV(splitVectorMeshU(m, 0.35)!, 0.6)!;
		expect(split.us).toEqual([0, 0.35, 1]);
		expect(split.vs).toEqual([0, 0.6, 1]);
		samples(m).forEach((p, i) => expect(near(p, samples(split)[i], 1e-9)).toBe(true));
		expect(splitVectorMeshU(split, 0.351)).toBeNull();
		const merged = removeVectorMeshSplitU(splitVectorMeshU(m, 0.35)!, 1)!;
		merged.points.forEach((p, i) => expect(near(p, m.points[i], 1e-9)).toBe(true));
		// A preset resized into a 3 × 2 mesh is still the same surface.
		const resized = resizeVectorMesh(m, 3, 2);
		expect(resized.us).toHaveLength(4);
		samples(m).forEach((p, i) => expect(near(p, samples(resized)[i], 1e-9)).toBe(true));
	});

	/** The largest mismatch between the tangents on either side of any interior grid line. */
	function tangentDefect(m: VectorWarpMesh): number {
		const nx = vectorMeshColumns(m);
		let worst = 0;
		for (let a = 1; a < m.us.length - 1; a++) {
			const hl = m.us[a] - m.us[a - 1];
			const hr = m.us[a + 1] - m.us[a];
			for (let j = 0; j < vectorMeshRows(m); j++) {
				const [l, c, r] = [m.points[j * nx + 3 * a - 1], m.points[j * nx + 3 * a], m.points[j * nx + 3 * a + 1]];
				worst = Math.max(worst, Math.abs((c.x - l.x) / hl - (r.x - c.x) / hr), Math.abs((c.y - l.y) / hl - (r.y - c.y) / hr));
			}
		}
		for (let b = 1; b < m.vs.length - 1; b++) {
			const hl = m.vs[b] - m.vs[b - 1];
			const hr = m.vs[b + 1] - m.vs[b];
			for (let i = 0; i < nx; i++) {
				const [l, c, r] = [m.points[(3 * b - 1) * nx + i], m.points[3 * b * nx + i], m.points[(3 * b + 1) * nx + i]];
				worst = Math.max(worst, Math.abs((c.x - l.x) / hl - (r.x - c.x) / hr), Math.abs((c.y - l.y) / hl - (r.y - c.y) / hr));
			}
		}
		return worst;
	}

	it('drags anchors and handles onto the pointer and keeps the surface smooth across the lines', () => {
		let base = vectorIdentityMesh({ x: 0, y: 0, width: 240, height: 240 }, 1, 1);
		for (const s of [0.25, 0.6]) base = splitVectorMeshV(splitVectorMeshU(base, s)!, s)!;
		const nx = vectorMeshColumns(base);
		for (const [i, j] of [
			[3, 3],
			[4, 3],
			[2, 3],
			[3, 4],
			[3, 2],
			[0, 3],
			[3, 0],
			[6, 6],
			[5, 6],
			[9, 9]
		]) {
			const idx = j * nx + i;
			const m = dragVectorMeshPoint(base, idx, { x: 17, y: -11 });
			expect(near(m.points[idx], { x: base.points[idx].x + 17, y: base.points[idx].y - 11 }, 1e-9)).toBe(true);
			expect(tangentDefect(m), `${i},${j}`).toBeLessThan(1e-6);
		}
	});

	it('pulls the grabbed surface point exactly, keeps the corners and leaves the border of an inside grab', () => {
		const base = vectorIdentityMesh({ x: 0, y: 0, width: 300, height: 300 }, 3, 3);
		const m = pullVectorMesh(base, 0.45, 0.5, { x: 20, y: -14 });
		const before = at(base, 0.45, 0.5);
		expect(near(at(m, 0.45, 0.5), { x: before.x + 20, y: before.y - 14 }, 1e-6)).toBe(true);
		for (const [s, t] of CORNERS) expect(near(at(m, s, t), at(base, s, t), 1e-9)).toBe(true);
		for (let k = 0; k <= 10; k++) expect(near(at(m, k / 10, 0), at(base, k / 10, 0), 1e-9)).toBe(true);
		expect(tangentDefect(m)).toBeLessThan(1e-6);
		// Near the border, the border bows and the corners still stay.
		const edge = pullVectorMesh(base, 0.5, 0.02, { x: 0, y: -30 });
		expect(at(edge, 0.5, 0).y).toBeLessThan(-5);
		for (const [s, t] of CORNERS) expect(near(at(edge, s, t), at(base, s, t), 1e-9)).toBe(true);
	});

	it('makes a mesh whose border follows an outline (Make with Top Object) and gives the border back', () => {
		const rect = vectorMeshFromOutline(rectSubpath({ x: 10, y: 20, width: 100, height: 50 }), 2, 2)!;
		for (const [s, t] of [
			[0, 0],
			[0.5, 0],
			[1, 0.3],
			[0.2, 1],
			[0, 0.8],
			[0.4, 0.6]
		])
			expect(near(at(rect, s, t), { x: 10 + 100 * s, y: 20 + 50 * t }, 1e-6)).toBe(true);
		const circle = vectorMeshFromOutline(ellipseSubpath({ x: 0, y: 0, width: 200, height: 200 }), 4, 4)!;
		for (let k = 0; k <= 12; k++) {
			for (const [s, t] of [
				[k / 12, 0],
				[1, k / 12],
				[k / 12, 1],
				[0, k / 12]
			]) {
				const p = at(circle, s, t);
				expect(Math.abs(Math.hypot(p.x - 100, p.y - 100) - 100)).toBeLessThan(1.5);
			}
		}
		expect(vectorMeshFromOutline({ closed: false, anchors: [{ x: 0, y: 0 }, { x: 5, y: 5 }] })).toBeNull();
		const outline = vectorMeshOutline(vectorIdentityMesh({ x: 0, y: 0, width: 10, height: 10 }, 2, 1));
		expect(outline.closed).toBe(true);
		expect(outline.anchors.map((a) => [a.x, a.y])).toEqual([
			[0, 0],
			[5, 0],
			[10, 0],
			[10, 10],
			[5, 10],
			[0, 10]
		]);
	});
});

// ---------------------------------------------------------------------------
// The editor: envelopes, the Envelope tool, Free Distort and skew
// ---------------------------------------------------------------------------

const rect = (id: string, x: number, y: number, width: number, height: number, extra: Partial<VectorPathNode> = {}): VectorPathNode => ({
	id,
	type: 'path',
	subpaths: [rectSubpath({ x, y, width, height })],
	fill: '#0ea5e9',
	...extra
});

const editor = (nodes: VectorNode[]) => new VectorEditorController({ document: { width: 600, height: 400, nodes } });
const undoSteps = (c: VectorEditorController) => {
	const labels: string[] = [];
	while (c.getState().canUndo) {
		labels.push(c.getState().undoLabel);
		c.undo();
	}
	return labels;
};
const drag = (c: VectorEditorController, from: Vec2, to: Vec2, mods: { shift?: boolean; alt?: boolean; mod?: boolean } = {}) => {
	c.pointerDown(from, mods);
	c.pointerMove({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, mods);
	c.pointerMove(to, mods);
	c.pointerUp(to, mods);
};
const worldAnchors = (c: VectorEditorController, id: string) => {
	const node = c.getNode(id) as VectorPathNode;
	const m = vectorWorldMatrix(c.getDocument().nodes, id)!;
	return node.subpaths[0].anchors.map((a) => applyMatrix(m, a));
};
const appearance = (c: VectorEditorController, id: string) => vectorAppearanceShapes(c.getNode(id)!)[0].path;
const pathAt = (path: ReturnType<typeof subpathsToBezier>, p: Vec2) => {
	const segs = pathToContours(path).flatMap((k) => k.segments);
	return Math.min(...segs.map((s) => segmentNearest(s, [p.x, p.y]).distance));
};

describe('envelope effect', () => {
	it('warps the appearance live, keeps the stored path, and Expand Appearance bakes it', () => {
		const c = editor([rect('r', 100, 100, 200, 100)]);
		c.select(['r']);
		const made = c.envelope({ style: 'bulge', bend: 50 });
		expect(made).toEqual([{ nodeId: 'r', effectId: 'fx1' }]);
		expect(c.getState().undoLabel).toBe('Make Envelope with Warp');
		const node = c.getNode('r') as VectorPathNode;
		expect(node.subpaths[0].anchors).toHaveLength(4);
		const path = appearance(c, 'r');
		// Bulge: the corners stay, the top bows up and the bottom down.
		expect(pathAt(path, { x: 100, y: 100 })).toBeLessThan(1e-6);
		const b = vectorNodeBounds(node)!;
		expect(b.y).toBeLessThan(90);
		expect(b.y + b.height).toBeGreaterThan(210);
		// The warp is followed within its tolerance (0.12 for a box this size).
		const mesh = vectorWarpPresetMesh({ style: 'bulge', bend: 50 }, { x: 100, y: 100, width: 200, height: 100 })!;
		for (const s of [0.1, 0.3, 0.5, 0.85]) expect(pathAt(path, evalVectorMesh(mesh, s, 0))).toBeLessThan(0.2);
		const expanded = c.expandAppearance();
		expect(expanded).toEqual(['r']);
		const baked = c.getNode('r') as VectorPathNode;
		expect(baked.effects).toBeUndefined();
		expect(baked.subpaths[0].anchors.length).toBeGreaterThan(4);
		expect(vectorNodeBounds(baked)!.y).toBeCloseTo(b.y, 3);
		c.undo();
		expect((c.getNode('r') as VectorPathNode).effects).toHaveLength(1);
	});

	it('regenerates from the contents’ new bounds when they are edited', () => {
		const c = editor([rect('r', 0, 0, 100, 100)]);
		c.select(['r']);
		c.envelope({ style: 'arch', bend: 40 });
		c.moveAnchor({ nodeId: 'r', subpath: 0, index: 1 }, { x: 200, y: 0 });
		c.moveAnchor({ nodeId: 'r', subpath: 0, index: 2 }, { x: 200, y: 100 });
		const path = appearance(c, 'r');
		// The arch now spans the wider box: its corners are the new corners.
		expect(pathAt(path, { x: 200, y: 0 })).toBeLessThan(1e-6);
		expect(pathAt(path, { x: 0, y: 100 })).toBeLessThan(1e-6);
		const mesh = vectorWarpPresetMesh({ style: 'arch', bend: 40 }, { x: 0, y: 0, width: 200, height: 100 })!;
		expect(pathAt(path, evalVectorMesh(mesh, 0.5, 0))).toBeLessThan(0.2);
	});

	it('turns a preset into the mesh it stands for, and follows mesh rows and columns', () => {
		const c = editor([rect('r', 0, 0, 120, 60)]);
		c.select(['r']);
		c.envelope({ style: 'flag', bend: 30 });
		const before = appearance(c, 'r');
		expect(c.updateEffect('r', 'fx1', { params: { style: 'mesh', rows: 3, columns: 2 } }).ok).toBe(true);
		const e = c.getNode('r')!.effects![0];
		expect(e.type === 'envelope' && e.params.mesh?.us).toEqual([0, 0.5, 1]);
		expect(e.type === 'envelope' && e.params.mesh?.vs).toHaveLength(4);
		// The same surface, so the same appearance.
		const after = appearance(c, 'r');
		for (const cmd of before) if ('x' in cmd) expect(pathAt(after, cmd)).toBeLessThan(0.05);
		// A flat mesh changes nothing.
		const flat = editor([rect('q', 0, 0, 50, 50)]);
		flat.envelope({ style: 'mesh', rows: 2, columns: 2 }, { ids: ['q'] });
		expect(vectorAppearanceShapes(flat.getNode('q')!)[0].path).toEqual(subpathsToBezier([rectSubpath({ x: 0, y: 0, width: 50, height: 50 })]));
	});

	it('moves its mesh with the node, and a mirror turns a preset into a mesh', () => {
		const c = editor([rect('r', 0, 0, 100, 50)]);
		c.select(['r']);
		c.envelope({ style: 'mesh', rows: 1, columns: 1, mesh: vectorIdentityMesh({ x: 0, y: 0, width: 100, height: 50 }, 1, 1) });
		c.translate(10, 5);
		const e = c.getNode('r')!.effects![0];
		expect(e.type === 'envelope' && e.params.mesh!.points[0]).toEqual({ x: 10, y: 5 });
		const d = editor([rect('r', 0, 0, 100, 50)]);
		d.select(['r']);
		d.envelope({ style: 'arc', bend: 50 });
		const box = vectorNodeBounds(d.getNode('r')!)!;
		const apex = { x: 50, y: box.y };
		const corner = { x: 0, y: 50 };
		const world = () => vectorPathWorldBezier(d.getNode('r') as VectorPathNode);
		expect(pathAt(world(), apex)).toBeLessThan(0.2);
		d.flip('vertical');
		const f = d.getNode('r')!.effects![0];
		expect(f.type === 'envelope' && f.params.style).toBe('mesh');
		// Flipped about the box's middle: the apex and the corners trade heights.
		const mid = box.y + box.height / 2;
		expect(pathAt(world(), { x: apex.x, y: 2 * mid - apex.y })).toBeLessThan(0.2);
		expect(pathAt(world(), { x: corner.x, y: 2 * mid - corner.y })).toBeLessThan(0.2);
	});

	it('round-trips through SVG and lists in the effects and envelope panels', () => {
		const c = editor([rect('r', 0, 0, 100, 50)]);
		c.select(['r']);
		c.envelope({ style: 'mesh', rows: 1, columns: 2 });
		c.setTool('envelope');
		drag(c, { x: 50, y: 0 }, { x: 50, y: -20 });
		const svg = c.toSvg();
		const back = parseVectorSvg(svg);
		const node = back.nodes.find((n) => n.id === 'r')!;
		expect(node.effects).toEqual(c.getNode('r')!.effects);
		expect(vectorNodeBounds(node)).toEqual(vectorNodeBounds(c.getNode('r')!));
		const effects = getVectorEffectsPanel(c.getState())!;
		expect(effects.effects[0]).toMatchObject({ type: 'envelope', specs: [] });
		const panel = getVectorEnvelopePanel(c.getState())!;
		expect(panel).toMatchObject({ nodeId: 'r', canRelease: true, canMakeWithTopObject: false });
		expect(panel.envelope!.params.style).toBe('mesh');
	});

	it('makes an envelope from the top object, and Release gives its shape back', () => {
		const c = editor([rect('a', 20, 20, 80, 40), { id: 'top', type: 'path', subpaths: [ellipseSubpath({ x: 0, y: 0, width: 200, height: 200 })], stroke: '#000' }]);
		c.select(['a', 'top']);
		const r = c.makeEnvelopeWithTopObject({ rows: 4, columns: 4 });
		expect(r).toMatchObject({ ok: true, nodeId: 'a' });
		expect(c.getNode('top')).toBeUndefined();
		expect(c.getState().selection).toEqual(['a']);
		// The rectangle now fills the circle: its corners land on the circle.
		const path = appearance(c, 'a');
		for (const cmd of path) if ('x' in cmd) expect(Math.hypot(cmd.x - 100, cmd.y - 100)).toBeLessThan(101.5);
		expect(vectorNodeBounds(c.getNode('a')!)!.width).toBeGreaterThan(180);
		expect(undoSteps(c)).toEqual(['Make Envelope with Top Object']);
		expect(c.getNode('top')).toBeDefined();
		// Several objects are grouped; an open top path is refused.
		const g = editor([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10), rect('t', -5, -5, 50, 30)]);
		g.select(['a', 'b', 't']);
		const grouped = g.makeEnvelopeWithTopObject();
		expect(grouped.ok).toBe(true);
		expect(g.getDocument().nodes.map((n) => n.type)).toEqual(['group']);
		const open = editor([rect('a', 0, 0, 10, 10), { id: 'l', type: 'path', subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 9, y: 9 }] }] }]);
		open.select(['a', 'l']);
		expect(open.makeEnvelopeWithTopObject().ok).toBe(false);
		// Release.
		const rel = editor([rect('r', 0, 0, 100, 50)]);
		rel.select(['r']);
		rel.envelope({ style: 'bulge', bend: 50 });
		const shapes = rel.releaseEnvelope();
		expect(shapes).toHaveLength(1);
		expect(rel.getNode('r')!.effects).toBeUndefined();
		const shape = rel.getNode(shapes[0]) as VectorPathNode;
		expect(shape.subpaths[0].closed).toBe(true);
		expect(vectorNodeBounds(shape)!.y).toBeLessThan(-5);
		expect(rel.getState().undoLabel).toBe('Release Envelope');
	});
});

describe('Envelope tool', () => {
	const setup = () => {
		const c = editor([rect('r', 100, 100, 200, 100)]);
		c.select(['r']);
		c.envelope({ style: 'mesh', rows: 2, columns: 2 });
		c.setTool('envelope');
		return c;
	};

	it('shows the mesh in the overlay: grid lines, anchors and their handles', () => {
		const c = setup();
		const o = getVectorOverlayRenderData(c.getState()).envelope!;
		expect(o.nodeId).toBe('r');
		expect(o.anchors).toHaveLength(9);
		expect(o.handles).toHaveLength(24);
		expect(o.grid.match(/C/g)).toHaveLength(12);
		expect(o.anchors[4]).toMatchObject({ x: 200, y: 150 });
		c.select([]);
		expect(getVectorOverlayRenderData(c.getState()).envelope).toBeNull();
	});

	it('drags an anchor (one undo step) and pulls the surface from inside a patch', () => {
		const c = setup();
		drag(c, { x: 200, y: 150 }, { x: 220, y: 130 });
		const e = c.getNode('r')!.effects![0];
		const mesh = e.type === 'envelope' ? e.params.mesh! : null;
		expect(mesh!.points[3 * 7 + 3]).toEqual({ x: 220, y: 130 });
		expect(undoSteps(c)[0]).toBe('Edit Envelope');
		const d = setup();
		const before = getVectorOverlayRenderData(d.getState()).envelope!.anchors.map((a) => [a.x, a.y]);
		drag(d, { x: 140, y: 120 }, { x: 140, y: 100 });
		const pulled = d.getNode('r')!.effects![0];
		const m = pulled.type === 'envelope' ? pulled.params.mesh! : null;
		const at0 = evalVectorMesh(m!, 0.2, 0.2);
		expect(at0.y).toBeCloseTo(100, 6);
		// The outer corners stay.
		const after = getVectorOverlayRenderData(d.getState()).envelope!.anchors.map((a) => [a.x, a.y]);
		for (const k of [0, 2, 6, 8]) expect(after[k]).toEqual(before[k]);
	});

	it('edits a preset by turning it into a mesh, and on a rotated node', () => {
		const c = editor([rect('r', 100, 100, 200, 100)]);
		c.select(['r']);
		c.envelope({ style: 'arc', bend: 30, rows: 1, columns: 1 });
		c.rotate(90);
		c.setTool('envelope');
		const o = getVectorOverlayRenderData(c.getState()).envelope!;
		const a = o.anchors[0];
		drag(c, { x: a.x, y: a.y }, { x: a.x + 15, y: a.y });
		const e = c.getNode('r')!.effects![0];
		expect(e.type === 'envelope' && e.params.style).toBe('mesh');
		const o2 = getVectorOverlayRenderData(c.getState()).envelope!;
		expect(o2.anchors[0].x).toBeCloseTo(a.x + 15, 6);
		expect(o2.anchors[0].y).toBeCloseTo(a.y, 6);
	});
});

describe('Free Distort and skew', () => {
	it('drags a corner in perspective: that corner lands on the pointer, the others stay, lines stay straight', () => {
		const c = editor([rect('r', 100, 100, 200, 100)]);
		c.select(['r']);
		c.setFreeDistort(true);
		expect(c.getState().freeDistort).toBe(true);
		c.pointerDown({ x: 100, y: 100 });
		c.pointerMove({ x: 120, y: 110 });
		expect(getVectorOverlayRenderData(c.getState()).distort).toMatchObject({ mode: 'distort' });
		expect(getVectorOverlayRenderData(c.getState()).selectionBox).toBeNull();
		c.pointerUp({ x: 120, y: 110 });
		const pts = worldAnchors(c, 'r');
		expect(pts).toHaveLength(4);
		expect(near(pts[0], { x: 120, y: 110 }, 1e-9)).toBe(true);
		expect(near(pts[1], { x: 300, y: 100 }, 1e-9)).toBe(true);
		expect(near(pts[2], { x: 300, y: 200 }, 1e-9)).toBe(true);
		expect(c.getState().undoLabel).toBe('Distort');
	});

	it('Shift+Alt+Mod drags a symmetric perspective; Mod on a side skews along it', () => {
		const c = editor([rect('r', 100, 100, 200, 100)]);
		c.select(['r']);
		c.setFreeDistort(true);
		drag(c, { x: 300, y: 100 }, { x: 320, y: 103 }, { shift: true, alt: true, mod: true });
		const pts = worldAnchors(c, 'r');
		expect(near(pts[1], { x: 320, y: 100 }, 1e-9)).toBe(true);
		expect(near(pts[0], { x: 80, y: 100 }, 1e-9)).toBe(true);
		expect(near(pts[2], { x: 300, y: 200 }, 1e-9)).toBe(true);
		expect(c.getState().undoLabel).toBe('Perspective');
		const s = editor([rect('r', 100, 100, 200, 100)]);
		s.select(['r']);
		s.setFreeDistort(true);
		drag(s, { x: 300, y: 150 }, { x: 300, y: 170 }, { mod: true });
		const q = worldAnchors(s, 'r');
		expect(near(q[1], { x: 300, y: 120 }, 1e-9)).toBe(true);
		expect(near(q[0], { x: 100, y: 100 }, 1e-9)).toBe(true);
		expect(s.getState().undoLabel).toBe('Skew');
		// Out of Free Distort mode a corner scales as before.
		const n = editor([rect('r', 100, 100, 200, 100)]);
		n.select(['r']);
		drag(n, { x: 300, y: 200 }, { x: 400, y: 250 });
		expect(n.getState().undoLabel).toBe('Scale');
	});

	it('distorts to given corners, keeps a folded quad out, and maps user-space gradient handles', () => {
		const gradient = { type: 'linear' as const, units: 'userSpaceOnUse' as const, start: { x: 0, y: 0 }, end: { x: 100, y: 100 }, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] };
		const c = editor([rect('r', 0, 0, 100, 100, { fill: gradient }), { id: 'e', type: 'path', subpaths: [ellipseSubpath({ x: 0, y: 0, width: 100, height: 100 })], stroke: '#000' }]);
		c.select(['r', 'e']);
		const corners = [
			{ x: 10, y: 0 },
			{ x: 90, y: 20 },
			{ x: 110, y: 120 },
			{ x: -20, y: 90 }
		];
		expect(c.distort(corners).ok).toBe(true);
		worldAnchors(c, 'r').forEach((p, i) => expect(near(p, corners[i], 1e-9)).toBe(true));
		const fill = (c.getNode('r') as VectorPathNode).fill as typeof gradient;
		expect(near(fill.start, corners[0], 1e-9)).toBe(true);
		expect(near(fill.end, corners[2], 1e-9)).toBe(true);
		// The circle's rightmost point (100, 50) goes where the homography sends it.
		const h = vectorHomography(
			[
				{ x: 0, y: 0 },
				{ x: 100, y: 0 },
				{ x: 100, y: 100 },
				{ x: 0, y: 100 }
			],
			corners
		)!;
		expect(pathAt(subpathsToBezier((c.getNode('e') as VectorPathNode).subpaths), applyVectorHomography(h, { x: 100, y: 50 })!)).toBeLessThan(0.1);
		expect(c.getState().undoLabel).toBe('Distort');
		const folded = c.distort([corners[0], corners[2], corners[1], corners[3]]);
		expect(folded.ok).toBe(false);
	});

	it('distorts a rotated node in document space and keeps its rotation', () => {
		const c = editor([rect('r', 100, 100, 200, 100)]);
		c.select(['r']);
		c.rotate(30);
		const frame = c.getState().selectionFrame!;
		expect(frame.angle).toBeCloseTo(30, 9);
		const rot = (p: Vec2) => applyMatrix(rotateMatrix(30), p);
		const box = [
			{ x: frame.x, y: frame.y },
			{ x: frame.x + frame.width, y: frame.y },
			{ x: frame.x + frame.width, y: frame.y + frame.height },
			{ x: frame.x, y: frame.y + frame.height }
		].map(rot);
		const target = box.map((p, i) => (i === 2 ? { x: p.x + 25, y: p.y + 10 } : p));
		expect(c.distort(target).ok).toBe(true);
		const pts = worldAnchors(c, 'r');
		const sorted = (list: Vec2[]) => list.map((p) => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		expect(sorted(pts)).toEqual(sorted(target));
		expect(c.getNode('r')!.transform).toBeDefined();
		expect(c.getState().selectionFrame!.angle).toBeCloseTo(30, 9);
	});

	it('skews by angles about the centre, along a rotated box’s axes too', () => {
		const c = editor([rect('r', 0, 0, 100, 100)]);
		c.select(['r']);
		expect(c.skew(45, 0).ok).toBe(true);
		const pts = worldAnchors(c, 'r');
		// x' = x + tan 45° · (y − 50).
		expect(near(pts[0], { x: -50, y: 0 }, 1e-9)).toBe(true);
		expect(near(pts[2], { x: 150, y: 100 }, 1e-9)).toBe(true);
		expect(c.getState().undoLabel).toBe('Skew');
		expect(c.skew(90).ok).toBe(false);
		const r = editor([rect('r', 0, 0, 100, 100)]);
		r.select(['r']);
		r.rotate(90);
		r.skew(0, 30);
		// In the box's own frame the skew is vertical, which on screen (turned 90°) is horizontal.
		const q = worldAnchors(r, 'r');
		const ys = q.map((p) => Math.round(p.y * 1e6) / 1e6);
		expect(new Set(ys).size).toBe(2);
	});

	it('runs vector.distort, vector.skew and vector.envelope as one undo step each', () => {
		const c = editor([rect('a', 0, 0, 100, 60), rect('b', 200, 0, 40, 40), rect('t', -10, -10, 120, 80)]);
		const registry = new CommandRegistry();
		for (const spec of createVectorCommands(c)) registry.register(spec);
		const run = (cmd: string, params?: unknown) => registry.execute(cmd, params) as { ok: boolean; result?: any; message?: string };
		expect(run('vector.envelope', { ids: ['a'], preset: 'wave', bend: 40, horizontal: 10 }).result).toEqual({ envelopes: [{ nodeId: 'a', effectId: 'fx1' }] });
		expect(run('vector.envelope', { ids: ['a'], bend: -20 }).ok).toBe(true);
		const e = c.getNode('a')!.effects!;
		expect(e).toHaveLength(1);
		expect(e[0].type === 'envelope' && [e[0].params.style, e[0].params.bend, e[0].params.horizontal]).toEqual(['wave', -20, 10]);
		expect(run('vector.envelope', { ids: ['a'], preset: 'sparkle' }).ok).toBe(false);
		expect(run('vector.envelope', { ids: ['b'], mesh: { rows: 1, columns: 1, points: [{ x: 0, y: 0 }] } }).ok).toBe(false);
		expect(run('vector.envelope', { ids: ['b'], mesh: { rows: 1, columns: 2 } }).ok).toBe(true);
		expect(run('vector.skew', { ids: ['b'], ax: 20 }).ok).toBe(true);
		expect(
			run('vector.distort', {
				ids: ['b'],
				corners: [
					{ x: 190, y: 0 },
					{ x: 250, y: 5 },
					{ x: 245, y: 40 },
					{ x: 195, y: 45 }
				]
			}).ok
		).toBe(true);
		expect(run('vector.envelope', { ids: ['b'], release: true }).result.shapes).toHaveLength(1);
		expect(run('vector.envelope', { ids: ['a'], expand: true }).result.expanded).toEqual(['a']);
		expect(undoSteps(c)).toEqual([
			'Expand Appearance',
			'Release Envelope',
			'Distort',
			'Skew',
			'Make Envelope with Mesh',
			'Edit Envelope',
			'Make Envelope with Warp'
		]);
		expect(run('vector.envelope', { ids: ['b', 't'], topObject: true }).result).toEqual({ nodeId: 'b' });
	});
});
