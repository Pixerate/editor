import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	arcToCubics,
	bezierPathBounds,
	bezierPathLength,
	bezierPathPointAtLength,
	bezierPathSignedArea,
	bezierPathToSvg,
	closeContour,
	contoursToPath,
	countPathSegments,
	cutOutPiece,
	contourEnclosesArea,
	dashContours,
	distanceToBezierPath,
	dividePaths,
	hatchPath,
	interiorPoint,
	normalizeBezierPath,
	bezierPathArea,
	offsetPath,
	outlineStroke,
	pathBoolean,
	pathBooleanSelect,
	pathfinder,
	PATHFINDER_OPERATIONS,
	pathToContours,
	PlanarMap,
	planarSplit,
	pointInBezierPath,
	segmentBounds,
	segmentCurvature,
	segmentDerivative,
	segmentExtrema,
	segmentIntersections,
	segmentLength,
	segmentNearest,
	segmentParamAtLength,
	segmentPoint,
	segmentTangent,
	splitSegment,
	strokeOutlineRings,
	subSegment,
	toBezierPath,
	transformBezierPath,
	trimSegments,
	windingNumber,
	type BezierContour,
	type BezierPath,
	type BezierSegment,
	type OutlineStrokeOptions,
	type PathfinderShape,
	type PathOperand,
	type PlanarInput,
	type StrokeCap,
	type StrokeJoin
} from '../src/canvas/pathops/index.js';
import {
	flattenChain,
	isStraightSegment,
	monotoneParams,
	segmentAreaTerm,
	segmentSecondDerivative,
	solveMonotone
} from '../src/canvas/pathops/bezier.js';
import { pathBooleanRings } from '../src/canvas/pathops/boolean.js';
import {
	cubicPointAt,
	cubicsToPathData,
	fitCubicRun,
	fitCubics,
	fitCubicWithTangents,
	fitFreehandPath,
	fitPathData,
	isStraightCubic,
	type CubicSegment
} from '../src/canvas/curveFit.js';
import {
	flattenSvgPath,
	formatNumber,
	parseSvgPath,
	polygonToSvgPath,
	shapeToPolygon,
	simplifyRing,
	type ShapeDescription
} from '../src/canvas/shapeGeometry.js';
import {
	dividePolygons,
	multiPolygonArea,
	multiPolygonBounds,
	pointInRings,
	polygonBoolean,
	ringSignedArea,
	type PolygonBooleanOperation,
	type PolygonFillRule,
	type PolygonInput
} from '../src/canvas/polygonBoolean.js';
import type { Point } from '../src/canvas/types.js';
import { conformanceValuesMatch } from '../src/tools/conformance.js';

/**
 * Test vectors the Swift geometry module (`packages/swift`, `PixerateGeometry`, #621) checks
 * itself against: Bézier segment maths, path utilities, segment intersections, the curve and
 * polygon booleans, outline stroke / offset / dashes, the planar map, Pathfinder, hatching,
 * curve fitting and the shape / SVG helpers. Computed here from the TS core (the spec); a drift
 * from the committed file fails this test (run with UPDATE_SWIFT_VECTORS=1 to rewrite it after
 * an intended change, then rerun the Swift tests).
 *
 * The file is recorded on arm64 but this test also runs on x64, where V8's `Math.sin` / `cos` /
 * `atan2` / `tan` / `acos` may differ in the last bit. So it is compared as data, numbers within
 * the conformance tolerance (relative 1e-9), not as a string. Every entry says whether its
 * numbers went through trig (`trig: true`: compare with a tolerance) or come from plain
 * arithmetic on the inputs (`trig: false`: the Swift port should match them exactly; trig there
 * at most orders edges round a vertex or picks a branch far from its threshold).
 *
 * Shape of an entry: `{ fn, trig, ...inputs, out }` (or `throws` with the error message instead
 * of `out`). Paths in are SVG strings or segment lists; `BezierPath` results are command arrays
 * `["M",x,y]`, `["L",x,y]`, `["Q",x1,y1,x,y]`, `["C",x1,y1,x2,y2,x,y]`, `["Z"]`. Non-finite
 * numbers are the strings "NaN", "Infinity" and "-Infinity".
 */
const FILE = join(__dirname, '../../swift/Tests/PixerateGeometryTests/Fixtures/geometry-vectors.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Cmd = (string | number)[];
const P = (path: readonly BezierPath[number][]): Cmd[] =>
	path.map((c) => {
		switch (c.type) {
			case 'M':
			case 'L':
				return [c.type, c.x, c.y];
			case 'Q':
				return ['Q', c.x1, c.y1, c.x, c.y];
			case 'C':
				return ['C', c.x1, c.y1, c.x2, c.y2, c.x, c.y];
			default:
				return ['Z'];
		}
	});
const contoursOut = (cs: readonly BezierContour[]) => cs.map((c) => ({ segments: c.segments, closed: c.closed }));
const cubicOut = (c: CubicSegment) => [c.p0, c.p1, c.p2, c.p3];
const cubicIn = (c: readonly Point[]): CubicSegment => ({ p0: c[0], p1: c[1], p2: c[2], p3: c[3] });
const hasArc = (d: string) => /[Aa]/.test(d);

/** Replaces non-finite numbers with strings, drops `undefined` (JSON can hold neither). */
function sanitize(v: unknown): unknown {
	if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
	if (Array.isArray(v)) return v.map(sanitize);
	if (v && typeof v === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = sanitize(x);
		return out;
	}
	return v;
}

type Entry = Record<string, unknown>;
/** One entry: its inputs, then `out` (or `throws`). */
function vec(fn: string, trig: boolean, inputs: Entry, compute: () => unknown): Entry {
	try {
		return { fn, trig, ...inputs, out: compute() };
	} catch (error) {
		return { fn, trig, ...inputs, throws: error instanceof Error ? error.message : String(error) };
	}
}

/** Deterministic PRNG (mulberry32), values in [0, 1). */
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

const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
const rectRev = (x: number, y: number, w: number, h: number) => `M${x} ${y}V${y + h}H${x + w}V${y}Z`;
const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}A${r} ${r} 0 1 1 ${cx + r} ${cy}A${r} ${r} 0 1 1 ${cx - r} ${cy}Z`;
const poly = (pts: Point[]) => `M${pts.map((p) => `${p[0]} ${p[1]}`).join('L')}Z`;

// ---------------------------------------------------------------------------
// Shared inputs
// ---------------------------------------------------------------------------

const SEGMENTS: Record<string, Point[]> = {
	line: [[0, 0], [4, 3]],
	lineZero: [[2, 2], [2, 2]],
	lineVertical: [[1, -3], [1, 5]],
	quad: [[0, 0], [2, 4], [4, 0]],
	quadHandleOnAnchor: [[0, 0], [0, 0], [4, 2]],
	quadCollinear: [[0, 0], [6, 0], [2, 0]],
	cubic: [[0, 0], [1, 2], [3, 2], [4, 0]],
	cubicS: [[0, 0], [3, 4], [1, -4], [4, 0]],
	cubicHandlesOnAnchors: [[0, 0], [0, 0], [4, 4], [4, 4]],
	cubicCusp: [[0, 0], [4, 4], [0, 4], [4, 0]],
	cubicLoop: [[0, 0], [6, 4], [-2, 4], [4, 0]],
	cubicCollinear: [[0, 0], [5, 0], [-1, 0], [4, 0]],
	cubicPoint: [[1, 1], [1, 1], [1, 1], [1, 1]],
	cubicWide: [[100.5, -20.25], [180, 60], [20, 140.75], [250, 90]]
};
const TS = [0, 0.1, 0.25, 1 / 3, 0.5, 0.75, 0.9, 1];
const NEAR: Point[] = [[2, 1], [0, 0], [-1, -1], [2, 5], [10, 10], [2, 1.5], [150, 60]];

const PATHS: string[] = [
	'M10 10 h10 v10 q-5 5 -10 0 t-5 -5 s1 1 2 2 z',
	'M0 0 10 0 10 10 Z L 5 5',
	'm1 1 l2 0 m5 5 l1 1 2 -3',
	'M0 0 C10 0 10 10 0 10 S-10 0 0 0Z',
	'M0 0Q5 10 10 0T20 0',
	'M0 0L10 0L10 10',
	`${rect(0, 0, 10, 10)}${rect(3, 3, 4, 4)}`,
	`${rect(0, 0, 10, 10)}${rectRev(3, 3, 4, 4)}`,
	'M0 0L10 10L10 0L0 10Z',
	'M5 5',
	'',
	'M0 0L0 0L5 0Z',
	'M0 0C0 0 10 10 10 10',
	'M0 0C100 100 100 -100 0 0Z',
	'M0 0A10 5 30 1 1 20 0',
	'M0 0A1 1 0 0 1 10 0',
	'M0 0A0 5 0 0 1 10 0Z',
	circle(0, 0, 10)
];
const PATH_POINTS: Point[] = [[5, 5], [0, 0], [15, 15], [-3, 2], [5, 2], [10, 5], [1.5, 1.5], [12, 3]];

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function segmentVectors(): Entry[] {
	const out: Entry[] = [];
	for (const [name, seg] of Object.entries(SEGMENTS)) {
		const base = { name, seg };
		out.push(vec('segmentPoint', false, { ...base, ts: TS }, () => TS.map((t) => segmentPoint(seg, t))));
		out.push(vec('segmentDerivative', false, { ...base, ts: TS }, () => TS.map((t) => segmentDerivative(seg, t))));
		out.push(vec('segmentSecondDerivative', false, { ...base, ts: TS }, () => TS.map((t) => segmentSecondDerivative(seg, t))));
		out.push(vec('segmentTangent', false, { ...base, ts: TS }, () => TS.map((t) => segmentTangent(seg, t))));
		out.push(vec('segmentCurvature', false, { ...base, ts: TS }, () => TS.map((t) => segmentCurvature(seg, t))));
		const splits = [0, 0.3, 0.5, 1];
		out.push(vec('splitSegment', false, { ...base, ts: splits }, () => splits.map((t) => splitSegment(seg, t))));
		const ranges: [number, number][] = [[0.2, 0.7], [0, 1], [0.5, 0.5], [0.7, 0.2], [0, 0.4], [0.6, 1], [-0.5, 1.5]];
		out.push(vec('subSegment', false, { ...base, ranges }, () => ranges.map(([a, b]) => subSegment(seg, a, b))));
		out.push(vec('segmentExtrema', false, base, () => [segmentExtrema(seg, 0), segmentExtrema(seg, 1)]));
		out.push(vec('segmentBounds', false, base, () => segmentBounds(seg)));
		out.push(vec('monotoneParams', false, base, () => monotoneParams(seg)));
		out.push(vec('segmentAreaTerm', false, base, () => segmentAreaTerm(seg)));
		const lenRanges: [number, number][] = [[0, 1], [0, 0.5], [0.25, 0.75], [0.8, 0.1], [0.3, 0.3]];
		out.push(vec('segmentLength', false, { ...base, ranges: lenRanges }, () => lenRanges.map(([a, b]) => segmentLength(seg, a, b))));
		out.push(vec('segmentLength', false, { ...base, ranges: [[0, 1]], tolerance: 1e-3 }, () => [segmentLength(seg, 0, 1, 1e-3)]));
		const total = segmentLength(seg);
		const lengths = [-1, 0, total * 0.1, total * 0.5, total * 0.9, total, total + 1];
		out.push(vec('segmentParamAtLength', false, { ...base, lengths }, () => lengths.map((l) => segmentParamAtLength(seg, l))));
		out.push(vec('segmentNearest', false, { ...base, points: NEAR }, () => NEAR.map((p) => segmentNearest(seg, p))));
		const tols = [0, 1e-9, 0.1, 1, 3];
		out.push(vec('isStraightSegment', false, { ...base, tolerances: tols }, () => tols.map((tol) => isStraightSegment(seg, tol))));
		// solveMonotone on each monotone piece, at a value 37% of the way between its ends.
		const cuts = [0, ...monotoneParams(seg), 1];
		const pieces: Point[][] = [];
		for (let i = 0; i + 1 < cuts.length; i++) pieces.push(subSegment(seg, cuts[i], cuts[i + 1]));
		const solves = pieces.flatMap((piece) =>
			([0, 1] as const).map((axis) => {
				const a = piece[0][axis];
				const b = piece[piece.length - 1][axis];
				return { piece, axis, value: a + (b - a) * 0.37 };
			})
		);
		out.push(vec('solveMonotone', false, { name, cases: solves }, () => solves.map((s) => solveMonotone(s.piece, s.axis, s.value))));
	}
	return out;
}

function pathVectors(): Entry[] {
	const out: Entry[] = [];
	const M: [number, number, number, number, number, number] = [2, 0.5, -0.25, 3, 5, 7];
	for (const d of PATHS) {
		const trig = hasArc(d);
		const p = { path: d };
		out.push(vec('toBezierPath', trig, p, () => P(toBezierPath(d))));
		out.push(vec('pathToContours', trig, p, () => contoursOut(pathToContours(d))));
		out.push(vec('contoursToPath', trig, p, () => P(contoursToPath(pathToContours(d)))));
		if (!trig) {
			const opts = [{}, { precision: 1 }, { precision: 4, offset: { x: 0.5, y: -2 } }, { precision: 0 }];
			out.push(vec('bezierPathToSvg', false, { ...p, options: opts }, () => opts.map((o) => bezierPathToSvg(d, o))));
		}
		out.push(vec('transformBezierPath', trig, { ...p, matrix: M }, () => P(transformBezierPath(d, M))));
		out.push(vec('countPathSegments', false, p, () => countPathSegments(d)));
		out.push(vec('bezierPathBounds', trig, p, () => bezierPathBounds(d)));
		out.push(vec('bezierPathSignedArea', trig, p, () => bezierPathSignedArea(d)));
		const total = bezierPathLength(d);
		out.push(vec('bezierPathLength', trig, p, () => total));
		const lengths = [-1, 0, 3.3, 15, total / 2, total, 1e9];
		out.push(vec('bezierPathPointAtLength', true, { ...p, lengths }, () => lengths.map((l) => bezierPathPointAtLength(d, l))));
		const chains = pathToContours(d).map((c) => closeContour(c, true));
		out.push(vec('windingNumber', trig, { ...p, points: PATH_POINTS, note: 'chains = pathToContours(path).map(c => closeContour(c, true))' }, () => PATH_POINTS.map((q) => windingNumber(chains, q))));
		for (const rule of ['nonzero', 'evenodd'] as const) {
			out.push(vec('pointInBezierPath', trig, { ...p, fillRule: rule, points: PATH_POINTS }, () => PATH_POINTS.map((q) => pointInBezierPath(d, q, rule))));
		}
		out.push(vec('distanceToBezierPath', trig, { ...p, points: PATH_POINTS }, () => PATH_POINTS.map((q) => distanceToBezierPath(d, q))));
		const closedChains = pathToContours(d).map((c) => closeContour(c));
		out.push(vec('closeContour', trig, p, () => pathToContours(d).map((c) => [closeContour(c), closeContour(c, true)])));
		for (const tol of [0.1, 1]) {
			out.push(vec('flattenChain', trig, { chains: closedChains, tolerance: tol }, () => closedChains.map((c) => flattenChain(c, tol))));
		}
		const ranges: [number, number][] = [[0, total], [2, 7], [5, 15], [total / 3, (2 * total) / 3], [7, 7], [-5, 3]];
		out.push(vec('trimSegments', trig, { chains: closedChains, ranges }, () => closedChains.map((c) => ranges.map(([a, b]) => trimSegments(c, a, b)))));
	}
	const arcs = [
		{ from: [0, 0], cmd: { rx: 10, ry: 5, rotation: 30, largeArc: true, sweep: true, x: 20, y: 0 } },
		{ from: [0, 0], cmd: { rx: 10, ry: 10, rotation: 0, largeArc: false, sweep: false, x: 10, y: 10 } },
		{ from: [0, 0], cmd: { rx: 1, ry: 1, rotation: 0, largeArc: false, sweep: true, x: 10, y: 0 } },
		{ from: [0, 0], cmd: { rx: 0, ry: 5, rotation: 0, largeArc: false, sweep: true, x: 10, y: 0 } },
		{ from: [3, 3], cmd: { rx: 5, ry: 5, rotation: 0, largeArc: false, sweep: true, x: 3, y: 3 } },
		{ from: [-5, 2], cmd: { rx: -4, ry: 7, rotation: -45, largeArc: true, sweep: false, x: 6, y: -1 } },
		{ from: [0, 0], cmd: { rx: 50, ry: 50, rotation: 0, largeArc: true, sweep: true, x: 0.001, y: 0 } }
	];
	for (const a of arcs) out.push(vec('arcToCubics', true, a, () => arcToCubics(a.from as Point, a.cmd)));
	return out;
}

function intersectionVectors(): Entry[] {
	const S = SEGMENTS;
	const pairs: [string, Point[], Point[]][] = [
		['line/line cross', [[0, 0], [10, 10]], [[0, 10], [10, 0]]],
		['line/line parallel', [[0, 0], [10, 0]], [[0, 1], [10, 1]]],
		['line/line collinear overlap', [[0, 0], [10, 0]], [[5, 0], [15, 0]]],
		['line/line touch at ends', [[0, 0], [5, 5]], [[5, 5], [10, 0]]],
		['line/line T', [[0, 0], [10, 0]], [[5, 0], [5, 5]]],
		['line/quad two hits', [[-1, 1], [5, 1]], S.quad],
		['line/quad tangent', [[0, 2], [4, 2]], S.quad],
		['line/cubic', [[0, 1], [4, 1]], S.cubic],
		['line/cubicS three hits', [[-1, 0.1], [5, 0.1]], S.cubicS],
		['line/cubic loop', [[-1, 1.5], [5, 1.5]], S.cubicLoop],
		['cubic/cubic arches', [[0, 0], [1, 3], [3, 3], [4, 0]], [[0, 2], [1, -1], [3, -1], [4, 2]]],
		['cubic/cubic touch at end', S.cubic, [[4, 0], [5, -2], [7, -2], [8, 0]]],
		['cubic loop/self-crossing other', S.cubicLoop, [[2, -1], [2, 1], [2, 2], [2, 4]]],
		['quad/cubic', S.quad, S.cubicS],
		['cusp/line', S.cubicCusp, [[0, 2], [4, 2]]],
		['wide/wide', S.cubicWide, [[100, 100], [150, 0], [200, 150], [250, -10]]],
		['disjoint', [[0, 0], [1, 1]], [[5, 5], [6, 7], [8, 5]]]
	];
	const out = pairs.map(([name, a, b]) => vec('segmentIntersections', false, { name, a, b }, () => segmentIntersections(a, b)));
	// Coincident stretches report every hit the search finds (hundreds at the default budget), so
	// these run with a small budget to keep the file small.
	const coincident: [string, Point[], Point[]][] = [
		['cubic/cubic same', S.cubic, S.cubic],
		['cubic/subcubic overlap', S.cubic, subSegment(S.cubic, 0.3, 0.9)],
		['line/subline overlap', [[0, 0], [10, 5]], [[2, 1], [6, 3]]]
	];
	for (const [name, a, b] of coincident) out.push(vec('segmentIntersections', false, { name, a, b, options: { budget: 50 } }, () => segmentIntersections(a, b, { budget: 50 })));
	out.push(vec('segmentIntersections', false, { name: 'with epsilon', a: S.cubic, b: [[0, 1], [4, 1]], options: { epsilon: 1e-3 } }, () => segmentIntersections(S.cubic, [[0, 1], [4, 1]], { epsilon: 1e-3 })));
	return out;
}

// --- curve booleans ---------------------------------------------------------

type OperandSpec = { path: string; fillRule?: PolygonFillRule };
const BLOB = 'M0 5C0 -2 10 -2 10 5C10 12 0 12 0 5Z';
const STAR = 'M50 0L79 90L2 35L98 35L21 90Z';
const EIGHT = 'M0 0L10 10L10 0L0 10Z';
const LOOP = 'M0 0C100 100 100 -100 0 0Z';
const BOOLEAN_CASES: { name: string; operands: OperandSpec[] }[] = [
	{ name: 'overlapping rects', operands: [{ path: rect(0, 0, 10, 10) }, { path: rect(5, 5, 10, 10) }] },
	{ name: 'shared edge', operands: [{ path: rect(0, 0, 10, 10) }, { path: rect(10, 0, 10, 10) }] },
	{ name: 'touching corner', operands: [{ path: rect(0, 0, 10, 10) }, { path: rect(10, 10, 5, 5) }] },
	{ name: 'collinear overlap', operands: [{ path: rect(0, 0, 10, 10) }, { path: rect(5, 0, 10, 10) }] },
	{ name: 'identical', operands: [{ path: rect(1, 2, 3, 4) }, { path: rect(1, 2, 3, 4) }] },
	{ name: 'opposite orientation identical', operands: [{ path: rect(1, 2, 3, 4) }, { path: rectRev(1, 2, 3, 4) }] },
	{ name: 'nested', operands: [{ path: rect(0, 0, 30, 30) }, { path: rect(10, 10, 10, 10) }] },
	{ name: 'disjoint', operands: [{ path: rect(0, 0, 1, 1) }, { path: rect(5, 5, 1, 1) }] },
	{ name: 'figure-8 vs rect', operands: [{ path: EIGHT }, { path: rect(2, 2, 6, 3) }] },
	{ name: 'star nonzero vs rect', operands: [{ path: STAR }, { path: rect(40, 30, 20, 40) }] },
	{ name: 'star evenodd vs rect', operands: [{ path: STAR, fillRule: 'evenodd' }, { path: rect(40, 30, 20, 40) }] },
	{ name: 'hole evenodd vs rect', operands: [{ path: `${rect(0, 0, 10, 10)}${rect(3, 3, 4, 4)}`, fillRule: 'evenodd' }, { path: rect(5, -2, 10, 6) }] },
	{ name: 'hole nonzero same orientation vs rect', operands: [{ path: `${rect(0, 0, 10, 10)}${rect(3, 3, 4, 4)}` }, { path: rect(5, -2, 10, 6) }] },
	{ name: 'hole nonzero reversed vs rect', operands: [{ path: `${rect(0, 0, 10, 10)}${rectRev(3, 3, 4, 4)}` }, { path: rect(5, -2, 10, 6) }] },
	{ name: 'blob vs rect', operands: [{ path: BLOB }, { path: rect(5, 0, 10, 10) }] },
	{ name: 'blob vs triangle', operands: [{ path: BLOB }, { path: poly([[-2, 8], [12, 8], [5, -3]]) }] },
	{ name: 'loop vs rect', operands: [{ path: LOOP }, { path: rect(20, -30, 20, 60) }] },
	{ name: 'quad lens', operands: [{ path: 'M0 0Q5 10 10 0Q5 -10 0 0Z' }, { path: 'M5 -6Q15 0 5 6Q-5 0 5 -6Z' }] },
	{ name: 'open path vs rect', operands: [{ path: 'M0 0L10 0L10 10' }, { path: rect(5, 2, 10, 2) }] },
	{ name: 'three operands', operands: [{ path: rect(0, 0, 10, 10) }, { path: rect(5, 5, 10, 10) }, { path: BLOB }] },
	{ name: 'circles', operands: [{ path: circle(0, 0, 10) }, { path: circle(10, 0, 10) }] },
	{ name: 'circle vs rect', operands: [{ path: circle(0, 0, 10) }, { path: rect(0, -20, 20, 40) }] },
	{ name: 'concentric circles', operands: [{ path: circle(0, 0, 20) }, { path: circle(0, 0, 10) }] },
	{ name: 'single operand', operands: [{ path: EIGHT }] },
	{ name: 'non-finite', operands: [{ path: 'M0 0L1e999 0L0 5Z' }, { path: rect(0, 0, 1, 1) }] }
];
const OPS: PolygonBooleanOperation[] = ['union', 'intersection', 'difference', 'xor'];
const caseTrig = (operands: OperandSpec[]) => operands.some((o) => hasArc(o.path));
const reportOut = (r: { engine: string; fallbackReason?: string; error?: string }) => ({ engine: r.engine, fallbackReason: r.fallbackReason, error: r.error });

/** `pathBooleanSelect` selectors as data: every listed condition must hold for the covering set. */
type SelectorSpec = { includes?: number[]; excludes?: number[]; minCount?: number; maxCount?: number; top?: number };
const selectorFn = (s: SelectorSpec) => (cov: readonly number[]) =>
	(s.includes ?? []).every((k) => cov.includes(k)) &&
	(s.excludes ?? []).every((k) => !cov.includes(k)) &&
	cov.length >= (s.minCount ?? 1) &&
	cov.length <= (s.maxCount ?? Infinity) &&
	(s.top === undefined || cov[cov.length - 1] === s.top);

function booleanVectors(): Entry[] {
	const out: Entry[] = [];
	for (const c of BOOLEAN_CASES) {
		const trig = caseTrig(c.operands);
		for (const op of OPS) {
			out.push(vec('pathBoolean', trig, { name: c.name, op, operands: c.operands }, () => {
				const r = pathBoolean(op, c.operands as PathOperand[]);
				return { path: P(r.path), ...reportOut(r) };
			}));
			out.push(vec('pathBooleanRings', trig, { name: c.name, op, operands: c.operands }, () =>
				pathBooleanRings(op, c.operands as PathOperand[]).map((r) => ({ segments: r.segments, area: r.area, parent: r.parent }))
			));
		}
		out.push(vec('dividePaths', trig, { name: c.name, operands: c.operands }, () => {
			const r = dividePaths(c.operands as PathOperand[]);
			return { pieces: r.pieces.map((p) => ({ path: P(p.path), operands: p.operands })), ...reportOut(r) };
		}));
		const selectors: SelectorSpec[] = [{}, { minCount: c.operands.length }, { includes: [0], maxCount: 1 }, { top: c.operands.length - 1 }, { excludes: [0] }];
		out.push(vec('pathBooleanSelect', trig, { name: c.name, operands: c.operands, selectors }, () => {
			const r = pathBooleanSelect(c.operands as PathOperand[], selectors.map(selectorFn));
			return { parts: r.parts.map((parts) => parts.map(P)), ...reportOut(r) };
		}));
	}
	out.push(vec('pathBoolean', false, { name: 'no operands', op: 'union', operands: [] }, () => {
		const r = pathBoolean('union', []);
		return { path: P(r.path), ...reportOut(r) };
	}));
	const singles: OperandSpec[] = [
		{ path: EIGHT }, { path: STAR }, { path: STAR, fillRule: 'evenodd' }, { path: LOOP }, { path: BLOB },
		{ path: `${rect(0, 0, 10, 10)}${rect(3, 3, 4, 4)}` }, { path: `${rect(0, 0, 10, 10)}${rect(3, 3, 4, 4)}`, fillRule: 'evenodd' },
		{ path: `${rect(0, 0, 10, 10)}${rect(5, 5, 10, 10)}` }, { path: 'M0 0L10 0L10 10' }, { path: 'M0 0L10 0L20 0Z' }, { path: '' },
		{ path: circle(5, 5, 5) }
	];
	for (const s of singles) {
		const trig = hasArc(s.path);
		const rule = s.fillRule ?? 'nonzero';
		out.push(vec('normalizeBezierPath', trig, { path: s.path, fillRule: rule }, () => P(normalizeBezierPath(s.path, rule))));
		out.push(vec('bezierPathArea', trig, { path: s.path, fillRule: rule }, () => bezierPathArea(s.path, rule)));
	}
	// planarSplit takes segment chains as given (nothing closed for filling).
	const splitCases: { name: string; paths: string[] }[] = [
		{ name: 'overlapping rects', paths: [rect(0, 0, 10, 10), rect(5, 5, 10, 10)] },
		{ name: 'shared edge', paths: [rect(0, 0, 10, 10), rect(10, 0, 10, 10)] },
		{ name: 'figure-8', paths: [EIGHT] },
		{ name: 'open line across blob', paths: [BLOB, 'M-5 5L15 5'] },
		{ name: 'loop', paths: [LOOP] },
		{ name: 'circles', paths: [circle(0, 0, 10), circle(10, 0, 10)] }
	];
	for (const s of splitCases) {
		const inputs = s.paths.map((d) => pathToContours(d).map((c) => closeContour(c)).filter((c) => c.length));
		out.push(vec('planarSplit', s.paths.some(hasArc), { name: s.name, inputs }, () => planarSplit(inputs)));
	}
	out.push(vec('planarSplit', false, { name: 'non-finite', inputs: [[[[[0, 0], [Infinity, 0]]]]] }, () => planarSplit([[[[[0, 0], [Infinity, 0]]]]])));
	return out;
}

// --- polygons ----------------------------------------------------------------

const sq = (x: number, y: number, s: number): Point[] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const POLY_CASES: { name: string; operands: PolygonInput[] }[] = [
	{ name: 'overlapping squares', operands: [[[sq(0, 0, 10)]], [[sq(5, 5, 10)]]] },
	{ name: 'shared edge', operands: [[[sq(0, 0, 10)]], [[sq(10, 0, 10)]]] },
	{ name: 'touching corner', operands: [[[sq(0, 0, 10)]], [[sq(10, 10, 5)]]] },
	{ name: 'collinear overlap', operands: [[[sq(0, 0, 10)]], [[[[5, 0], [15, 0], [15, 10], [5, 10]]]]] },
	{ name: 'identical', operands: [[[sq(1, 1, 4)]], [[sq(1, 1, 4)]]] },
	{ name: 'nested', operands: [[[sq(0, 0, 30)]], [[sq(10, 10, 10)]]] },
	{ name: 'disjoint', operands: [[[sq(0, 0, 1)]], [[sq(5, 5, 1)]]] },
	{ name: 'polygon with hole vs square', operands: [[[sq(0, 0, 10), [...sq(3, 3, 4)].reverse()]], [[sq(5, -2, 6)]]] },
	{ name: 'figure-8 nonzero', operands: [{ rings: [[[0, 0], [10, 10], [10, 0], [0, 10]]], fillRule: 'nonzero' }, [[sq(2, 2, 3)]]] },
	{ name: 'star nonzero', operands: [{ rings: [[[50, 0], [79, 90], [2, 35], [98, 35], [21, 90]]], fillRule: 'nonzero' }, [[[[40, 30], [60, 30], [60, 70], [40, 70]]]]] },
	{ name: 'star evenodd', operands: [{ rings: [[[50, 0], [79, 90], [2, 35], [98, 35], [21, 90]]], fillRule: 'evenodd' }, [[[[40, 30], [60, 30], [60, 70], [40, 70]]]]] },
	{ name: 'rings evenodd same orientation', operands: [{ rings: [sq(0, 0, 10), sq(3, 3, 4)], fillRule: 'evenodd' }, [[sq(5, -2, 6)]]] },
	{ name: 'rings nonzero same orientation', operands: [{ rings: [sq(0, 0, 10), sq(3, 3, 4)] }, [[sq(5, -2, 6)]]] },
	{ name: 'three operands', operands: [[[sq(0, 0, 10)]], [[sq(5, 5, 10)]], [[[[2, 12], [12, 2], [14, 14]]]]] },
	{ name: 'fractional', operands: [[[[[0.1, 0.2], [7.3, 0.25], [6.9, 8.05], [0.15, 7.7]]]], [[[[3.3, 3.1], [11.6, 2.9], [10.2, 9.95]]]]] }
];

function polygonVectors(): Entry[] {
	const out: Entry[] = [];
	for (const c of POLY_CASES) {
		for (const op of OPS) {
			out.push(vec('polygonBoolean', false, { name: c.name, op, operands: c.operands }, () => {
				const multi = polygonBoolean(op, c.operands);
				return { result: multi, area: multiPolygonArea(multi), bounds: multiPolygonBounds(multi) };
			}));
		}
		out.push(vec('dividePolygons', false, { name: c.name, operands: c.operands }, () => dividePolygons(c.operands)));
	}
	const rings: Point[][] = [sq(0, 0, 10), [...sq(0, 0, 10)].reverse(), [[0, 0], [10, 10], [10, 0], [0, 10]], [[50, 0], [79, 90], [2, 35], [98, 35], [21, 90]], [[0, 0], [1, 0]], []];
	for (const r of rings) out.push(vec('ringSignedArea', false, { ring: r }, () => ringSignedArea(r)));
	const pts: Point[] = [[5, 5], [0, 0], [10, 5], [50, 45], [50, 20], [-1, 5], [4, 4]];
	const ringSets: Point[][][] = [[sq(0, 0, 10), sq(3, 3, 4)], [sq(0, 0, 10), [...sq(3, 3, 4)].reverse()], [[[50, 0], [79, 90], [2, 35], [98, 35], [21, 90]]]];
	for (const set of ringSets) {
		for (const rule of ['nonzero', 'evenodd'] as const) out.push(vec('pointInRings', false, { rings: set, fillRule: rule, points: pts }, () => pts.map((p) => pointInRings(p, set, rule))));
	}
	out.push(vec('multiPolygonBounds', false, { input: [] }, () => multiPolygonBounds([])));
	out.push(vec('multiPolygonBounds', false, { input: [sq(1, 2, 3), sq(-4, 0, 1)] }, () => multiPolygonBounds([sq(1, 2, 3), sq(-4, 0, 1)])));
	return out;
}

// --- stroke ----------------------------------------------------------------

const STROKE_PATHS: string[] = [
	'M0 0L20 0L20 20',
	'M0 0L20 0L0 5',
	'M0 0L20 0L30 10',
	'M0 0L20 0L10 15Z',
	'M0 0C10 -10 20 10 30 0',
	'M0 0C30 0 -20 5 10 5',
	'M0 0Q10 20 20 0',
	'M5 5L5 5',
	'M0 0L10 0L0 0'
];
const JOINS: StrokeJoin[] = ['miter', 'round', 'bevel'];
const CAPS: StrokeCap[] = ['butt', 'round', 'square'];

function strokeVectors(): Entry[] {
	const out: Entry[] = [];
	for (const d of STROKE_PATHS) {
		for (const join of JOINS) {
			for (const cap of CAPS) {
				const options: OutlineStrokeOptions = { width: 4, join, cap };
				const trig = join === 'round' || cap === 'round';
				out.push(vec('outlineStroke', trig, { path: d, options }, () => P(outlineStroke(d, options))));
			}
		}
		const raw: OutlineStrokeOptions = { width: 3, join: 'miter', cap: 'square' };
		out.push(vec('strokeOutlineRings', false, { path: d, options: raw }, () => P(strokeOutlineRings(d, raw))));
	}
	const extra: { path: string; options: OutlineStrokeOptions }[] = [
		{ path: 'M0 0L20 0L0 5', options: { width: 4, join: 'miter', miterLimit: 10 } },
		{ path: 'M0 0L20 0L20 20', options: { width: 4, join: 'miter', miterLimit: 1.2 } },
		{ path: 'M0 0L20 0L30 10', options: { width: 2, miterLimit: 1 } },
		{ path: 'M0 0L40 0L40 30', options: { width: 2, dash: [5, 3], cap: 'butt' } },
		{ path: 'M0 0L40 0L40 30', options: { width: 2, dash: [5, 3, 1], dashOffset: 2, cap: 'square' } },
		{ path: 'M0 0C10 -10 20 10 30 0', options: { width: 2, dash: [4, 4], dashOffset: -1 } },
		{ path: 'M0 0L40 0', options: { width: 2, dash: [0, 5], cap: 'square' } },
		{ path: rect(0, 0, 20, 20), options: { width: 2, dash: [6, 2] } },
		{ path: 'M0 0L20 0', options: { width: 0 } },
		{ path: 'M0 0L20 0', options: { width: 2, tolerance: 0.5 } }
	];
	for (const e of extra) {
		const trig = e.options.join === 'round' || e.options.cap === 'round';
		out.push(vec('outlineStroke', trig, e, () => P(outlineStroke(e.path, e.options))));
	}
	const dashes: { path: string; pattern: number[]; offset: number }[] = [
		{ path: 'M0 0L40 0L40 30', pattern: [5, 3], offset: 0 },
		{ path: 'M0 0L40 0L40 30', pattern: [5, 3, 1], offset: 2 },
		{ path: 'M0 0L40 0L40 30', pattern: [5, 3], offset: -4 },
		{ path: 'M0 0C10 -10 20 10 30 0', pattern: [4, 2], offset: 0 },
		{ path: rect(0, 0, 10, 10), pattern: [3, 1], offset: 0 },
		{ path: 'M0 0L20 0', pattern: [0, 5], offset: 0 },
		{ path: 'M0 0L20 0', pattern: [-1, 5], offset: 0 },
		{ path: 'M0 0L20 0', pattern: [0, 0], offset: 0 },
		{ path: 'M0 0L20 0', pattern: [], offset: 0 }
	];
	for (const e of dashes) {
		out.push(vec('dashContours', false, e, () => {
			const r = dashContours(pathToContours(e.path), e.pattern, e.offset);
			return r && { contours: contoursOut(r.contours), dots: r.dots };
		}));
	}
	const offsets: { path: string; distance: number; options: { join?: StrokeJoin; miterLimit?: number; fillRule?: PolygonFillRule } }[] = [];
	for (const d of [rect(0, 0, 20, 20), STAR, BLOB, 'M0 0L20 0L20 20', `${rect(0, 0, 20, 20)}${rect(5, 5, 10, 10)}`]) {
		for (const distance of [2, -2]) offsets.push({ path: d, distance, options: {} });
	}
	offsets.push({ path: STAR, distance: 3, options: { join: 'round' } });
	offsets.push({ path: STAR, distance: 3, options: { join: 'bevel' } });
	offsets.push({ path: STAR, distance: 3, options: { join: 'miter', miterLimit: 10 } });
	offsets.push({ path: `${rect(0, 0, 20, 20)}${rect(5, 5, 10, 10)}`, distance: 1, options: { fillRule: 'evenodd' } });
	offsets.push({ path: rect(0, 0, 4, 4), distance: -3, options: {} });
	offsets.push({ path: BLOB, distance: 0, options: {} });
	for (const e of offsets) out.push(vec('offsetPath', e.options.join === 'round', e, () => P(offsetPath(e.path, e.distance, e.options))));
	return out;
}

// --- planar map ------------------------------------------------------------

function planarVectors(): Entry[] {
	const out: Entry[] = [];
	const cases: { name: string; inputs: PlanarInput[]; options?: { gap?: number }; points: Point[] }[] = [
		{ name: 'overlapping rects', inputs: [{ path: rect(0, 0, 10, 10) }, { path: rect(5, 5, 10, 10) }], points: [[2, 2], [7, 7], [12, 12], [20, 20]] },
		{ name: 'rect with line across', inputs: [{ path: rect(0, 0, 10, 10) }, { path: 'M-2 5L12 5', fills: false }], points: [[5, 2], [5, 8], [-1, 5]] },
		{ name: 'blob and triangle', inputs: [{ path: BLOB }, { path: poly([[-2, 8], [12, 8], [5, -3]]) }], points: [[5, 5], [5, 10], [5, -2]] },
		{ name: 'nested evenodd', inputs: [{ path: `${rect(0, 0, 30, 30)}${rect(10, 10, 10, 10)}`, fillRule: 'evenodd' }, { path: rect(12, 12, 4, 4) }], points: [[5, 5], [11, 11], [14, 14]] },
		{ name: 'gap closing', inputs: [{ path: 'M0 0L10 0L10 10L0 10L0 0.5', fills: false }], options: { gap: 1 }, points: [[5, 5]] },
		{ name: 'figure-8', inputs: [{ path: EIGHT }], points: [[2, 5], [8, 5], [5, 1]] },
		{ name: 'single open line', inputs: [{ path: 'M0 0L10 0' }], points: [[5, 5]] }
	];
	for (const c of cases) {
		out.push(vec('PlanarMap', false, { name: c.name, inputs: c.inputs, options: c.options ?? {}, points: c.points }, () => {
			const map = PlanarMap.build(c.inputs, c.options ?? {});
			if (!map) return null;
			const faces = map.faces;
			const chains = map.chains();
			return {
				vertices: map.vertices,
				eps: map.eps,
				inputCount: map.inputCount,
				faces: faces.map((f) => ({ path: P(f.path), area: f.area, bounds: f.bounds })),
				faceSources: faces.map((_, i) => map.faceSources(i)),
				faceInterior: faces.map((_, i) => map.faceInterior(i)),
				faceAt: c.points.map((p) => map.faceAt(p)),
				mergeAll: P(map.merge(faces.map((_, i) => i))),
				mergeFirstTwo: P(map.merge([0, 1])),
				chains: chains.map((ch) => ({ segments: ch.segments, closed: ch.closed, source: ch.source })),
				regionAt: c.points.map((p) => {
					const r = map.regionAt(p);
					return r && P(r);
				})
			};
		}));
	}
	for (const d of [rect(0, 0, 10, 10), STAR, BLOB, EIGHT, `${rect(0, 0, 10, 10)}${rect(3, 3, 4, 4)}`, 'M0 0L10 0', '', LOOP]) {
		out.push(vec('interiorPoint', false, { path: d }, () => interiorPoint(d)));
		out.push(vec('contourEnclosesArea', false, { path: d }, () => pathToContours(d).map(contourEnclosesArea)));
	}
	// cutOutPiece: pieces from PlanarMap.chains of the path with a line through it.
	const cutCases: { path: string; cutter: string; fillCloses: boolean }[] = [
		{ path: rect(0, 0, 10, 10), cutter: 'M5 -2L5 12', fillCloses: false },
		{ path: 'M0 0L10 0L10 10L0 10', cutter: 'M5 -2L5 12', fillCloses: true },
		{ path: 'M0 0L10 0L10 10L0 10', cutter: 'M5 -2L5 12', fillCloses: false },
		{ path: BLOB, cutter: 'M-2 5L12 5', fillCloses: false }
	];
	for (const c of cutCases) {
		const map = PlanarMap.build([{ path: c.path }, { path: c.cutter, fills: false }]);
		const pieces = (map?.chains() ?? []).filter((ch) => ch.source === 0).map((ch) => ({ segments: ch.segments, closed: ch.closed }));
		for (const piece of pieces) {
			out.push(vec('cutOutPiece', false, { path: c.path, piece, fillCloses: c.fillCloses, tolerance: 1e-6 }, () => {
				const r = cutOutPiece(c.path, piece, c.fillCloses, 1e-6);
				return r && P(r);
			}));
		}
	}
	out.push(vec('cutOutPiece', false, { path: rect(0, 0, 10, 10), piece: { segments: [[[20, 20], [30, 20]]], closed: false }, fillCloses: false, tolerance: 1e-6 }, () => cutOutPiece(rect(0, 0, 10, 10), { segments: [[[20, 20], [30, 20]]] }, false, 1e-6)));
	return out;
}

function pathfinderVectors(): Entry[] {
	const out: Entry[] = [];
	const sets: { name: string; shapes: PathfinderShape[] }[] = [
		{ name: 'two rects', shapes: [{ path: rect(0, 0, 10, 10) }, { path: rect(5, 5, 10, 10) }] },
		{ name: 'three rects shared key', shapes: [{ path: rect(0, 0, 10, 10), key: 'a' }, { path: rect(5, 5, 10, 10), key: 'b' }, { path: rect(8, -2, 6, 6), key: 'a' }] },
		{ name: 'blob triangle rect line', shapes: [{ path: BLOB }, { path: poly([[-2, 8], [12, 8], [5, -3]]) }, { path: rect(4, 2, 8, 4) }, { path: 'M-5 3L15 9', line: true }] },
		{ name: 'nested evenodd and star', shapes: [{ path: `${rect(0, 0, 100, 100)}${rect(30, 30, 40, 40)}`, fillRule: 'evenodd' }, { path: STAR }, { path: rect(45, -10, 10, 120) }] },
		{ name: 'circle and rects', shapes: [{ path: circle(10, 10, 10) }, { path: rect(10, 0, 15, 15) }, { path: rect(0, 12, 25, 4) }] }
	];
	for (const s of sets) {
		const trig = s.shapes.some((sh) => hasArc(sh.path as string));
		for (const op of PATHFINDER_OPERATIONS) {
			out.push(vec('pathfinder', trig, { name: s.name, op, shapes: s.shapes }, () => {
				const r = pathfinder(op, s.shapes);
				return { pieces: r.pieces.map((p) => ({ path: P(p.path), source: p.source, open: p.open })), ...reportOut(r) };
			}));
		}
	}
	return out;
}

function hatchVectors(): Entry[] {
	const out: Entry[] = [];
	const options = [{}, { gap: 2 }, { gap: 0.5, maxLines: 10 }];
	for (const d of [rect(0, 0, 20, 10), STAR, BLOB, `${rect(0, 0, 20, 20)}${rect(5, 5, 10, 10)}`, 'M0 0L10 0', circle(10, 10, 8)]) {
		for (const o of options) out.push(vec('hatchPath', hasArc(d), { path: d, options: o }, () => P(hatchPath(d, o))));
	}
	return out;
}

// --- curve fitting ---------------------------------------------------------

/** Rational unit-circle point (no trig): t ∈ [-1, 1] covers the right half. */
const rat = (t: number, r: number, cx: number, cy: number, side: 1 | -1): Point => [cx + side * r * ((1 - t * t) / (1 + t * t)), cy + r * ((2 * t) / (1 + t * t))];

function pointSets(): Record<string, { points: Point[]; closed?: boolean }> {
	const noise = (seed: number, amp: number) => {
		const r = rng(seed);
		return (p: Point): Point => [p[0] + (r() - 0.5) * amp, p[1] + (r() - 0.5) * amp];
	};
	const n1 = noise(1, 0.6);
	const arc = Array.from({ length: 40 }, (_, i) => n1(rat(-1 + (2 * i) / 39, 50, 0, 0, 1)));
	const n2 = noise(2, 0.4);
	const corner: Point[] = [];
	for (let i = 0; i <= 20; i++) corner.push(n2([i * 2, 0]));
	for (let i = 1; i <= 20; i++) corner.push(n2([40, i * 2]));
	const n3 = noise(3, 0.3);
	const ring: Point[] = [];
	for (let i = 0; i < 24; i++) ring.push(n3(rat(-1 + (2 * i) / 24, 30, 0, 0, 1)));
	for (let i = 0; i < 24; i++) ring.push(n3(rat(1 - (2 * i) / 24, 30, 0, 0, -1)));
	const n4 = noise(4, 0.2);
	const straight = Array.from({ length: 15 }, (_, i) => n4([i * 3, i * 1.5]));
	const r5 = rng(5);
	const zigzag = Array.from({ length: 30 }, (_, i): Point => [i * 4 + r5(), (i % 6 < 3 ? i % 6 : 6 - (i % 6)) * 5 + r5()]);
	const squareRing: Point[] = [[0, 0], [10, 0], [20, 0], [20, 10], [20, 20], [10, 20], [0, 20], [0, 10]];
	return {
		arc: { points: arc },
		corner: { points: corner },
		ring: { points: ring, closed: true },
		straight: { points: straight },
		zigzag: { points: zigzag },
		squareRing: { points: squareRing, closed: true },
		duplicates: { points: [[0, 0], [0, 0], [5, 5], [5, 5], [10, 0]] },
		twoPoints: { points: [[0, 0], [10, 5]] },
		onePoint: { points: [[3, 3]] }
	};
}

function curveFitVectors(): Entry[] {
	const out: Entry[] = [];
	for (const [name, { points, closed }] of Object.entries(pointSets())) {
		for (const tolerance of [0.5, 2]) {
			for (const cornerAngleDeg of [30, 180]) {
				const options = { closed: closed ?? false, cornerAngleDeg };
				out.push(vec('fitCubics', false, { name, points, tolerance, options }, () => fitCubics(points, tolerance, options).map(cubicOut)));
			}
		}
		if (points.length >= 2) {
			out.push(vec('fitCubicRun', false, { name, points, tolerance: 1 }, () => fitCubicRun(points, 1).map(cubicOut)));
			out.push(vec('fitCubicRun', false, { name, points, tolerance: 1, t0: [1, 0], t1: [0, 1] }, () => fitCubicRun(points, 1, [1, 0], [0, 1]).map(cubicOut)));
			// Chord-length parameters for fitCubicWithTangents, computed here and recorded.
			const acc = [0];
			for (let i = 1; i < points.length; i++) acc.push(acc[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
			const total = acc[acc.length - 1] || 1;
			const params = acc.map((a) => a / total);
			out.push(vec('fitCubicWithTangents', false, { name, points, params, t0: [1, 0], t1: [0.6, 0.8] }, () => {
				const r = fitCubicWithTangents(points, params, [1, 0], [0.6, 0.8]);
				return { curve: cubicOut(r.curve), error: r.error };
			}));
		}
		for (const o of [{}, { tolerance: 0.25, precision: 2, offset: { x: 1, y: -1 } }, { noWorse: false }, { closed: !closed }]) {
			out.push(vec('fitPathData', false, { name, points, options: o }, () => fitPathData(points, o)));
		}
		out.push(vec('fitFreehandPath', false, { name, points, options: {} }, () => fitFreehandPath(points)));
		out.push(vec('fitFreehandPath', false, { name, points, options: { tolerance: 3, cornerAngleDeg: 60 } }, () => fitFreehandPath(points, { tolerance: 3, cornerAngleDeg: 60 })));
	}
	const cubics: Point[][] = [SEGMENTS.cubic, SEGMENTS.cubicCollinear, SEGMENTS.cubicPoint, SEGMENTS.cubicHandlesOnAnchors, [[0, 0], [3, 0.0005], [7, -0.0005], [10, 0]], [[0, 0], [-1, 0], [11, 0], [10, 0]]];
	for (const c of cubics) {
		out.push(vec('cubicPointAt', false, { cubic: c, ts: TS }, () => TS.map((t) => cubicPointAt(cubicIn(c), t))));
		const tols = [1e-3, 0.01, 1];
		out.push(vec('isStraightCubic', false, { cubic: c, tolerances: tols }, () => tols.map((t) => isStraightCubic(cubicIn(c), t))));
	}
	const chainCases: { cubics: Point[][]; options: { precision?: number; offset?: { x: number; y: number }; closed?: boolean; straightTolerance?: number } }[] = [
		{ cubics: [SEGMENTS.cubic, [[4, 0], [5, 0], [7, 0], [8, 0]]], options: {} },
		{ cubics: [SEGMENTS.cubic, [[4, 0], [4, 4], [0, 4], [0, 0]]], options: { closed: true, precision: 1 } },
		{ cubics: [[[0.12345, 0.98765], [1, 2], [3, 2], [4.0004, 0]]], options: { offset: { x: 10, y: 10 }, straightTolerance: 0.5 } },
		{ cubics: [], options: {} }
	];
	for (const c of chainCases) out.push(vec('cubicsToPathData', false, c, () => cubicsToPathData(c.cubics.map(cubicIn), c.options)));
	return out;
}

// --- shapes / SVG helpers --------------------------------------------------

function shapeVectors(): Entry[] {
	const out: Entry[] = [];
	const ds = [
		'M10 10 L', 'M 1.5.5 2', 'M1e-3 2E2L-1e+1 .5', 'M0 0a1 1 0 01 1 1', 'M0 0a1 1 0 1110 0', 'M0,0L10-5', 'Mx', 'L5 5', 'M1 2 3 4 5 6',
		'm1 1 2 2 z m3 3 1 1', 'M0 0 h-1e2 v.5 H3 V-.25', 'M0 0 A 5 5 0 1 0 10 0', 'M0 0Q1 1 2 2T4 0', 'M0 0 C 1 1 2 2 3 3 S 5 5 6 6',
		'M0 0L1 1Z L 2 2', '', '   ', 'M0 0 L 1 1 junk 2 2', 'M-.5-.5l.5.5'
	];
	for (const d of ds) out.push(vec('parseSvgPath', false, { d }, () => parseSvgPath(d)));
	const flat = ['M0 0L10 0L10 10Z', 'M0 0Q5 10 10 0Z', 'M0 0C0 10 10 10 10 0', `${rect(0, 0, 10, 10)}${rect(3, 3, 4, 4)}`, 'M0 0 A 5 5 0 1 0 10 0Z', 'M5 5', '', 'M0 0C0 0 0 0 0 0'];
	for (const d of flat) {
		for (const options of [{}, { tolerance: 0.01 }, { tolerance: 1, maxSegments: 4 }]) out.push(vec('flattenSvgPath', hasArc(d), { d, options }, () => flattenSvgPath(d, options)));
	}
	const shapes: { shape: ShapeDescription; size: { width: number; height: number }; trig: boolean }[] = [
		{ shape: { kind: 'rect' }, size: { width: 100, height: 60 }, trig: false },
		{ shape: { kind: 'rect', cornerRadius: 10 }, size: { width: 100, height: 60 }, trig: true },
		{ shape: { kind: 'rect', cornerRadius: [0, 10, 40, 80] }, size: { width: 100, height: 60 }, trig: true },
		{ shape: { kind: 'rect', rotation: 30 }, size: { width: 100, height: 60 }, trig: true },
		{ shape: { kind: 'ellipse' }, size: { width: 100, height: 60 }, trig: true },
		{ shape: { kind: 'polygon', sides: 6 }, size: { width: 100, height: 60 }, trig: true },
		{ shape: { kind: 'star', points: 5, innerRadius: 0.4 }, size: { width: 100, height: 100 }, trig: true },
		{ shape: { kind: 'path', d: 'M0 0L10 0L5 10Z', viewBox: [0, 0, 10, 10] }, size: { width: 100, height: 50 }, trig: false },
		{ shape: { kind: 'path', d: 'M0 0Q5 10 10 0Z' }, size: { width: 10, height: 10 }, trig: false },
		{ shape: { kind: 'path', d: `${rect(0, 0, 10, 10)}${rect(3, 3, 4, 4)}`, fillRule: 'evenodd', rotation: 45 }, size: { width: 10, height: 10 }, trig: true },
		{ shape: { kind: 'rect' }, size: { width: 0, height: 10 }, trig: false }
	];
	for (const s of shapes) {
		for (const options of [{}, { tolerance: 1 }]) out.push(vec('shapeToPolygon', s.trig, { shape: s.shape, size: s.size, options }, () => shapeToPolygon(s.shape, s.size, options)));
	}
	const nums = [0, -0, 1.0005, 1.0015, 2.5e-4, -2.5e-4, 0.0005, -0.0005, 1e21, 1.23e-7, 123456789.123456, 0.1 + 0.2, 1.005, -1.0005, 1e-10, 12.3456, -12.5, 2.5, 1e300, 5e-324];
	for (const precision of [0, 1, 3, 6]) out.push(vec('formatNumber', false, { values: nums, precision }, () => nums.map((v) => formatNumber(v, precision))));
	const rng7 = rng(7);
	const noisyRing: Point[] = [];
	for (let i = 0; i < 40; i++) noisyRing.push(rat(-1 + (2 * i) / 40, 20, 0, 0, 1).map((v) => v + (rng7() - 0.5) * 0.2) as Point);
	for (let i = 0; i < 40; i++) noisyRing.push(rat(1 - (2 * i) / 40, 20, 0, 0, -1));
	const sqRing: Point[] = [[0, 0], [5, 0.01], [10, 0], [10, 10], [5, 10.02], [0, 10]];
	for (const [ring, tol] of [[noisyRing, 0.5], [noisyRing, 3], [sqRing, 0.05], [sqRing, 0], [[[0, 0], [1, 0], [2, 0], [3, 0]] as Point[], 0.1], [[[0, 0], [1, 1], [2, 0]] as Point[], 5]] as [Point[], number][]) {
		out.push(vec('simplifyRing', false, { ring, tolerance: tol }, () => simplifyRing(ring, tol)));
	}
	const multi = [[sqRing, [[2, 2], [2, 8], [8, 8], [8, 2]]], [noisyRing.map(([x, y]) => [x + 50, y] as Point)]];
	const p2s = [{}, { precision: 1 }, { offset: { x: -0.5, y: 2 } }, { simplify: 0.5 }, { curves: 'fit' as const }, { curves: 'fit' as const, curveTolerance: 1, cornerAngleDeg: 60, precision: 2 }];
	for (const options of p2s) {
		out.push(vec('polygonToSvgPath', false, { input: multi, options }, () => polygonToSvgPath(multi, options)));
		out.push(vec('polygonToSvgPath', false, { input: [sqRing, [[0, 0], [1, 1]]], options }, () => polygonToSvgPath([sqRing, [[0, 0], [1, 1]]], options)));
	}
	return out;
}

function vectors() {
	return {
		version: 1,
		segment: segmentVectors(),
		path: pathVectors(),
		intersection: intersectionVectors(),
		boolean: booleanVectors(),
		polygon: polygonVectors(),
		stroke: strokeVectors(),
		planar: planarVectors(),
		pathfinder: pathfinderVectors(),
		hatch: hatchVectors(),
		curveFit: curveFitVectors(),
		shape: shapeVectors()
	};
}

describe('Swift geometry test vectors', () => {
	it('match the committed fixture (the Swift tests read it)', () => {
		const now = JSON.parse(JSON.stringify(sanitize(vectors())));
		if (process.env.UPDATE_SWIFT_VECTORS) writeFileSync(FILE, JSON.stringify(now) + '\n');
		const committed = JSON.parse(readFileSync(FILE, 'utf8'));
		// Numbers within relative 1e-9 (trig differs across CPUs in the last bit); show the diff otherwise.
		if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
	});
});
