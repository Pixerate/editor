import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	bezierToSubpaths,
	boundsFromPoints,
	boundsIntersect,
	cloneAnchor,
	cloneVectorNode,
	collectPaintedNodes,
	collectPathNodes,
	convertAnchor,
	decomposeRigid,
	ellipseSubpath,
	expandVectorCorners,
	findVectorNode,
	hasPaint,
	inferAnchorType,
	insertAnchor,
	invertMatrix,
	lineSubpath,
	locateVectorNode,
	matrixRotation,
	moveAnchorHandle,
	multiplyMatrices,
	nearestSegment,
	polygonSubpath,
	rectSubpath,
	removeAnchors,
	reverseSubpath,
	rotateMatrix,
	roundSubpaths,
	scaleMatrix,
	setSubpathCorners,
	starSubpath,
	subpathsToBezier,
	transformVectorNode,
	translateAnchor,
	translateMatrix,
	unionBounds,
	vectorCorners,
	vectorNodeBounds,
	vectorNodeRotation,
	vectorParentMatrix,
	vectorPathData,
	vectorWorldMatrix,
	walkVectorNodes,
	VectorEditorController,
	type AffineMatrix,
	type VectorAnchor,
	type VectorDocument,
	type VectorNode,
	type VectorSubpath
} from '../src/vector/index.js';
import type { BezierPath } from '../src/canvas/pathops/index.js';
import { skewMatrix } from '../src/geom/affine.js';
import { conformanceValuesMatch } from '../src/tools/conformance.js';

/**
 * Test vectors the Swift vector model (`packages/swift`, `PixerateVector`, #624) checks itself
 * against: document JSON round trips (key order, optional-key omission and unknown members), the
 * plain-path geometry of `vector/geometry.ts` (anchors ↔ Bézier, path data, bounds, transforms,
 * anchor edits, shape builders) and the live corners of `vector/corners.ts`. Computed here from
 * the TS core (the spec); a drift from the committed file fails this test (run with
 * UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended change, then rerun the Swift tests).
 *
 * As in `swift-geometry-vectors.test.ts`, numbers compare within the conformance tolerance
 * (relative 1e-9) because trig differs across CPUs; every entry says whether its numbers went
 * through trig (`trig: true`) or are plain arithmetic the Swift port matches exactly. Key order
 * is checked separately: the Swift tests compare it too, since it is what `toJSON` writes.
 *
 * Shape: `{ version, documents: [{ name, doc }], geometry: [{ fn, trig, ...inputs, out }] }`.
 * Bézier paths are command arrays (`["M",x,y]`, `["L",x,y]`, `["C",x1,y1,x2,y2,x,y]`, `["Z"]`),
 * matrices `[a,b,c,d,e,f]`, and a missing result is `null`.
 */
const FILE = join(__dirname, '../../swift/Tests/PixerateVectorTests/Fixtures/vector-model-vectors.json');

type Entry = Record<string, unknown>;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
function vec(fn: string, trig: boolean, inputs: Entry, compute: () => unknown): Entry {
	return { fn, trig, ...inputs, out: json(compute()) };
}
const P = (path: BezierPath) =>
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

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** A document built by the controller, so its key order is what the editor writes. */
function controllerDocument(): VectorDocument {
	let n = 0;
	const c = new VectorEditorController({ document: { width: 400, height: 300, nodes: [] }, createId: () => `n${++n}` });
	c.addShape({ kind: 'rect', x: 20, y: 20, width: 100, height: 60, fill: '#2563eb', stroke: '#111827', strokeWidth: 2, cornerRadius: 8 });
	c.addShape({ kind: 'ellipse', x: 150, y: 30, width: 80, height: 80, fill: '#e11d48' });
	const poly = c.addShape({ kind: 'polygon', x: 260, y: 30, width: 90, height: 80, sides: 6, fill: '#16a34a' });
	c.addShape({ kind: 'star', x: 40, y: 140, width: 90, height: 90, points: 5, innerRatio: 0.45 });
	c.addShape({ kind: 'line', x: 160, y: 160, width: 120, height: 40, stroke: '#111827', strokeWidth: 3 });
	const blob = c.addPath('M300 150 C 340 130 370 190 330 220 L 290 210 Z', { fill: '#7c3aed', name: 'Blob' });
	c.rotate(30, { ids: [poly] });
	c.scale(1.5, 0.5, { ids: [blob] });
	const g = c.group({ ids: [poly, blob], name: 'Pair' });
	if (g) c.rotate(-15, { ids: [g] });
	c.setStyle({ strokeDasharray: [6, 3], strokeLinecap: 'round' }, ['n1']);
	return c.toJSON();
}

/** A hand-written document with every advanced member, unknown members, nulls and unusual key orders. */
const RICH: VectorDocument = JSON.parse(
	JSON.stringify({
		nodes: [
			{
				type: 'path',
				id: 'p1',
				subpaths: [
					{
						closed: true,
						extraSubpathField: [1, { deep: true }],
						anchors: [
							{ y: 0, x: 0, in: null, out: { x: 5, y: 0 }, type: 'corner', corner: { radius: 4, kind: 'chamfer', smoothing: 0.5, future: 'x' }, id: 'a0' },
							{ x: 10, y: 0, out: null, corner: null, custom: { any: 'thing' } },
							{ x: 10, y: 10, type: 'mystery', id: 7 },
							{ x: 0, y: 10, in: { x: 0, y: 12 } }
						]
					}
				],
				fill: { type: 'linear', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff', opacity: 0.5, midpoint: 0.3 }], start: { x: 0, y: 0 }, end: { x: 10, y: 10 }, units: 'userSpaceOnUse', spread: 'reflect', interpolation: 'oklab' },
				stroke: { type: 'mesh', rows: 1, columns: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }], colors: ['#f00', '#0f0', '#00f', '#fff'] },
				strokeWidth: 3,
				strokeWidthProfile: [{ t: 0, left: 1, right: 0.5 }, { t: 1, left: 2, right: 1 }],
				fills: [{ paint: '#ff0000', opacity: 0.5, blendMode: 'multiply', visible: false }],
				strokes: [{ paint: null, kind: 'brushstroke', brush: { brushId: 'pencil', seed: 3, paper: null } }],
				effects: [{ id: 'e1', type: 'zigzag', enabled: false, params: { size: 4, ridges: 3, smooth: true } }],
				filters: [{ id: 'f1', type: 'dropShadow', params: { color: '#000', opacity: 0.5, blur: 4, spread: 0, offsetX: 2, offsetY: 2 } }],
				connector: null,
				lens: { type: 'magnify', amount: 2, color: null },
				resizing: { horizontal: 'scale' },
				blendMode: 'screen',
				transform: [0.8660254037844387, 0.49999999999999994, -0.49999999999999994, 0.8660254037844387, 10, -5],
				unknownTopLevel: { nested: [null, true, 1e-7, 1e21] }
			},
			{
				id: 'g1',
				type: 'group',
				name: 'Frame',
				frame: { x: 0, y: 0, width: 200, height: 100, fill: '#eee', clip: false, master: false, masterId: null },
				children: [
					{ id: 't1', type: 'text', text: 'Hello', font: { fontFamily: 'Inter', fontWeight: 400, fontSize: 16 }, runs: [{ length: 2, style: { fontWeight: 700, fill: '#f00' } }], paragraph: { align: 'center' }, frame: { kind: 'path', path: { anchors: [{ x: 0, y: 0 }, { x: 50, y: 0 }], closed: false }, flip: true }, orientation: 'vertical', fill: '#111' },
					{ id: 'i1', type: 'instance', symbolId: 's1', scaleStrokes: false, overrides: { fill: '#0f0', hidden: ['sp'] }, transform: [2, 0, 0, 2, 5, 5] },
					{ id: 'm1', type: 'group', mask: { type: 'luminance', invert: true }, children: [{ id: 'mk', type: 'path', subpaths: [], fill: '#fff' }], symmetry: { mode: 'radial', center: { x: 1, y: 2 }, copies: 8 }, providerEffect: { effect: 'halftone', values: { size: 3, mode: 'dots', on: true, list: [1, 2] } }, generation: { prompt: 'p' }, blend: null, liveBoolean: null }
				],
				locked: true,
				visible: false,
				opacity: 0.25
			},
			{ id: 'x1', type: 'futureNode', payload: { a: 1 } }
		],
		height: 300,
		width: 400,
		background: '#ffffff',
		symbols: [{ id: 's1', name: 'Dot', nodes: [{ id: 'sp', type: 'path', subpaths: [{ anchors: [{ x: 0, y: 0 }], closed: false }] }], extra: 1 }],
		constraints: [{ id: 'c1', kind: 'distance', refs: [{ nodeId: 'p1', anchor: 'a0' }, { nodeId: 'p1', anchor: 'a0', handle: 'out' }], value: 'w / 2', name: 'd1', axis: 'horizontal' }],
		parameters: [{ name: 'w', value: '40', description: 'Width' }],
		perspective: { vanishingPoints: [{ x: 0, y: 0 }], origin: { x: 1, y: 1 }, gridSize: 20 },
		futureDocumentField: 'kept'
	})
);

function documentVectors(): Entry[] {
	return [
		{ name: 'controller', doc: controllerDocument() },
		{ name: 'rich', doc: RICH },
		{ name: 'empty', doc: { width: 1, height: 2, nodes: [] } },
		{ name: 'symbols-null', doc: { width: 1, height: 2, nodes: [], symbols: null, perspective: null } }
	];
}

// ---------------------------------------------------------------------------
// Geometry inputs
// ---------------------------------------------------------------------------

const A = (x: number, y: number, extra: Partial<VectorAnchor> = {}): VectorAnchor => ({ x, y, ...extra });
const SUBPATHS: Record<string, VectorSubpath[]> = {
	square: [rectSubpath({ x: 0, y: 0, width: 10, height: 10 })],
	open: [{ anchors: [A(0, 0), A(10, 0, { in: { x: 8, y: -3 }, out: { x: 12, y: 3 }, type: 'smooth' }), A(20, 10)], closed: false }],
	curves: [{ anchors: [A(0, 0, { out: { x: 5, y: -5 } }), A(20, 0, { in: { x: 15, y: -5 }, out: { x: 25, y: 5 } }), A(20, 20, { in: { x: 25, y: 15 } }), A(0, 20)], closed: true }],
	ellipse: [ellipseSubpath({ x: 1.5, y: -2.25, width: 33.3, height: 17 })],
	compound: [rectSubpath({ x: 0, y: 0, width: 100, height: 60 }), rectSubpath({ x: 20, y: 20, width: 10, height: 10 }), { anchors: [A(5, 5)], closed: false }, { anchors: [], closed: true }],
	twoClosed: [{ anchors: [A(0, 0), A(10, 0, { out: { x: 10, y: 5 } })], closed: true }],
	onAnchorHandles: [{ anchors: [A(0, 0, { out: { x: 0, y: 0 } }), A(10, 10, { in: { x: 10 + 1e-10, y: 10 } })], closed: false }],
	fractional: [{ anchors: [A(0.1 + 0.2, 1 / 3), A(1e-7, -0.0005), A(123456.789, 2.5e-4, { in: { x: 1.0005, y: -1.0005 } })], closed: true }]
};
const CORNERED: Record<string, VectorSubpath[]> = {
	round: [rectSubpath({ x: 20, y: 20, width: 100, height: 60 }, 8)],
	roundTooBig: [rectSubpath({ x: 0, y: 0, width: 30, height: 10 }, 50)],
	chamfer: [rectSubpath({ x: 0, y: 0, width: 40, height: 40 }, 6, 'chamfer')],
	inverted: [rectSubpath({ x: 0, y: 0, width: 40, height: 40 }, 6, 'inverted')],
	smoothed: [setSubpathCorners(rectSubpath({ x: 0, y: 0, width: 80, height: 50 }), 10, 'round', 0.6)],
	star: [setSubpathCorners(starSubpath({ x: 0, y: 0, width: 90, height: 90 }, 5, 0.45), 3)],
	curvedSides: [setSubpathCorners({ anchors: [A(0, 0, { out: { x: 10, y: -10 } }), A(40, 0, { in: { x: 30, y: -10 } }), A(40, 40), A(0, 40)], closed: true }, 5)],
	openEnds: [setSubpathCorners({ anchors: [A(0, 0), A(30, 0), A(30, 30)], closed: false }, 4)],
	mixed: [{ anchors: [A(0, 0, { corner: { radius: 5 } }), A(50, 0), A(50, 50, { corner: { radius: 0 } }), A(25, 70, { type: 'smooth', corner: { radius: 9 } }), A(0, 50, { corner: { radius: 3, kind: 'inverted' } })], closed: true }]
};

const MATRICES: { name: string; m: AffineMatrix; trig: boolean }[] = [
	{ name: 'identity', m: [1, 0, 0, 1, 0, 0], trig: false },
	{ name: 'translate', m: translateMatrix(12.5, -7), trig: false },
	{ name: 'scale', m: scaleMatrix(1.5, 0.5, { x: 100, y: 30 }), trig: false },
	{ name: 'mirror', m: scaleMatrix(-1, 1, { x: 10, y: 0 }), trig: false },
	{ name: 'flipBoth', m: scaleMatrix(-2, -0.5), trig: false },
	{ name: 'rotate', m: rotateMatrix(30, { x: 30, y: 30 }), trig: true },
	{ name: 'rotate90', m: rotateMatrix(90), trig: true },
	{ name: 'skew', m: skewMatrix(20, 0, { x: 250, y: 80 }), trig: true },
	{ name: 'rotateScale', m: multiplyMatrices(scaleMatrix(2, 3), rotateMatrix(-45, { x: 5, y: 5 })), trig: true }
];

const path = (id: string, subpaths: VectorSubpath[], extra: Record<string, unknown> = {}): VectorNode => ({ id, type: 'path', name: id, fill: '#f00', stroke: null, strokeWidth: 1, ...extra, subpaths }) as VectorNode;

/** Nodes for bounds, transforms and tree helpers (no feature the Swift port lacks yet). */
function nodes(): VectorNode[] {
	return [
		path('rect', [rectSubpath({ x: 10, y: 10, width: 40, height: 30 })]),
		path('rotated', [rectSubpath({ x: 0, y: 0, width: 40, height: 20 })], { transform: rotateMatrix(30, { x: 20, y: 10 }) }),
		path('cornered', CORNERED.round),
		path('curves', SUBPATHS.curves, { strokeWidth: 4 }),
		path('empty', []),
		path('gradients', SUBPATHS.square, {
			fill: { type: 'radial', stops: [{ offset: 0, color: '#000' }], start: { x: 5, y: 5 }, end: { x: 10, y: 5 }, focal: { x: 6, y: 5 }, units: 'userSpaceOnUse' },
			stroke: { type: 'linear', stops: [{ offset: 0, color: '#000' }], angle: 90 },
			strokeWidthProfile: [{ t: 0, left: 1, right: 0.2 }, { t: 1, left: 0.5, right: 1 }],
			fills: [{ paint: { type: 'freeform', points: [{ x: 1, y: 2, color: '#f00', spread: 0.5 }] }, opacity: 0.5 }, { paint: '#00f' }],
			strokes: [{ paint: { type: 'mesh', rows: 1, columns: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }], colors: ['#000', '#000', '#000', '#000'] }, strokeWidth: 2, strokeWidthProfile: [{ t: 0.5, left: 2, right: 1 }] }],
			disabledEffects: 'kept'
		}),
		{
			id: 'group',
			type: 'group',
			name: 'Group',
			transform: rotateMatrix(-20, { x: 50, y: 50 }),
			children: [
				path('child1', [rectSubpath({ x: 0, y: 0, width: 20, height: 20 })], { transform: translateMatrix(5, 5) }),
				{ id: 'inner', type: 'group', children: [path('child2', SUBPATHS.open, { fill: null, stroke: '#000' })] }
			]
		} as VectorNode,
		{
			id: 'symmetry',
			type: 'group',
			children: [path('half', [rectSubpath({ x: 0, y: 0, width: 10, height: 10 })])],
			symmetry: { mode: 'radial', center: { x: 5, y: 5 }, rotation: 10, copies: 6 }
		} as VectorNode,
		{
			id: 'blend',
			type: 'group',
			children: [path('k1', [rectSubpath({ x: 0, y: 0, width: 5, height: 5 })]), path('k2', [rectSubpath({ x: 50, y: 0, width: 5, height: 5 })])],
			blend: { steps: 3, spine: { anchors: [{ x: 2.5, y: 2.5, out: { x: 20, y: -20 } }, { x: 52.5, y: 2.5, id: 'end', type: 'corner' }], closed: false } }
		} as VectorNode,
		{
			id: 'frame',
			type: 'group',
			frame: { x: 0, y: 0, width: 100, height: 80, fill: '#fff' },
			children: [
				path('pinned', [rectSubpath({ x: 10, y: 10, width: 20, height: 20 })]),
				path('stretched', [rectSubpath({ x: 10, y: 50, width: 80, height: 10 })], { resizing: { horizontal: 'leftRight', vertical: 'bottom' } }),
				path('centred', [rectSubpath({ x: 40, y: 30, width: 20, height: 20 })], { resizing: { horizontal: 'center', vertical: 'scale' } }),
				path('none', []),
				{ id: 'area', type: 'text', text: 'Hi', font: { fontFamily: 'Inter', fontWeight: 400, fontSize: 12 }, frame: { kind: 'area', x: 5, y: 5, width: 50, height: 20 }, resizing: { horizontal: 'right' } } as VectorNode
			]
		} as VectorNode,
		{
			id: 'openFrame',
			type: 'group',
			transform: translateMatrix(200, 0),
			frame: { x: 0, y: 0, width: 50, height: 50, clip: false },
			children: [path('outside', [rectSubpath({ x: 40, y: 40, width: 30, height: 30 })])]
		} as VectorNode,
		{ id: 'inst', type: 'instance', symbolId: 's1', transform: [2, 0, 0, 2, 10, 10] } as VectorNode
	];
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function geometryVectors(): Entry[] {
	const out: Entry[] = [];
	const all = { ...SUBPATHS, ...CORNERED };
	for (const [name, subpaths] of Object.entries(all)) {
		const trig = name in CORNERED && name !== 'chamfer';
		out.push(vec('subpathsToBezier', trig, { name, subpaths, corners: true }, () => P(subpathsToBezier(subpaths))));
		out.push(vec('subpathsToBezier', false, { name, subpaths, corners: false }, () => P(subpathsToBezier(subpaths, { corners: false }))));
		for (const precision of [0, 1, 2, 3, 6]) out.push(vec('vectorPathData', trig, { name, subpaths, precision }, () => vectorPathData(subpaths, precision)));
		out.push(vec('expandVectorCorners', trig, { name, subpaths }, () => expandVectorCorners(subpaths)));
		out.push(vec('vectorCorners', true, { name, subpaths }, () => vectorCorners(subpaths)));
		out.push(vec('roundSubpaths', trig, { name, subpaths, precision: 2 }, () => roundSubpaths(subpaths, 2)));
		out.push(vec('cloneSubpaths', false, { name, subpaths }, () => subpaths.map((s) => ({ anchors: s.anchors.map(cloneAnchor), closed: s.closed }))));
	}
	const ds = [
		'M300 150 C 340 130 370 190 330 220 L 290 210 Z',
		'M0 0 Q 10 10 20 0 T 40 0',
		'M0 0 L10 0 L10 10 L0 0 Z',
		'M0 0 C 0 -5 10 -5 10 0 C 10 5 0 5 0 0 Z',
		'M0 0 C 5 -5 15 -5 20 0 L 20 10 C 15 15 5 15 0 10 Z M 30 30 L 40 40',
		'M10 10 A 10 10 0 1 1 30 10 A 10 10 0 1 1 10 10 Z',
		'M0 0 C 0 0 10 10 10 10',
		'M5 5',
		'',
		'M 1 1 l 2 2 z m 5 5 h 3 v 3 z',
		'M0 0 C -10 0 10 20 20 20 S 40 0 50 0'
	];
	for (const d of ds) out.push(vec('bezierToSubpaths', /A/i.test(d), { d }, () => bezierToSubpaths(d)));
	const anchors: VectorAnchor[] = [
		A(0, 0),
		A(0, 0, { in: { x: -5, y: 0 }, out: { x: 5, y: 0 } }),
		A(0, 0, { in: { x: -5, y: 0 }, out: { x: 10, y: 0 } }),
		A(0, 0, { in: { x: -5, y: 0 }, out: { x: 5, y: 1 } }),
		A(0, 0, { in: { x: -5, y: 0 }, out: { x: -5, y: 1 } }),
		A(0, 0, { in: { x: 0, y: 0 }, out: { x: 5, y: 0 } }),
		A(1, 1, { in: { x: 1 - 3, y: 1 - 4 }, out: { x: 1 + 3.0029, y: 1 + 4.004 } })
	];
	out.push(vec('inferAnchorType', false, { anchors }, () => anchors.map(inferAnchorType)));
	const edit = A(10, 10, { in: { x: 5, y: 10 }, out: { x: 20, y: 10 }, type: 'smooth', corner: { radius: 2 }, id: 'k' });
	const sym = A(10, 10, { in: { x: 5, y: 8 }, out: { x: 15, y: 12 }, type: 'symmetric' });
	const bare = A(10, 10, { type: 'corner' });
	out.push(vec('cloneAnchor', false, { anchors: [edit, sym, bare] }, () => [edit, sym, bare].map(cloneAnchor)));
	out.push(vec('translateAnchor', false, { anchors: [edit, sym, bare], dx: 2.5, dy: -1 }, () => [edit, sym, bare].map((a) => translateAnchor(a, 2.5, -1))));
	const moves: { anchor: VectorAnchor; side: 'in' | 'out'; pos: { x: number; y: number }; breakHandles: boolean }[] = [];
	for (const anchor of [edit, sym, bare])
		for (const side of ['in', 'out'] as const)
			for (const pos of [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 13, y: 17 }])
				for (const breakHandles of [false, true]) moves.push({ anchor, side, pos, breakHandles });
	out.push(vec('moveAnchorHandle', false, { cases: moves }, () => moves.map((c) => moveAnchorHandle(c.anchor, c.side, c.pos, c.breakHandles))));
	const editPaths: VectorSubpath[] = [
		SUBPATHS.curves[0],
		SUBPATHS.open[0],
		{ anchors: [A(0, 0), A(10, 0), A(10, 10, { in: { x: 12, y: 5 } })], closed: true },
		{ anchors: [A(0, 0), A(0, 0)], closed: false },
		{ anchors: [A(3, 4)], closed: false }
	];
	for (const [i, sp] of editPaths.entries()) {
		const name = `edit${i}`;
		for (const type of ['corner', 'smooth', 'symmetric'] as const) {
			const indices = [-1, 0, 1, sp.anchors.length - 1, sp.anchors.length];
			out.push(vec('convertAnchor', false, { name, subpath: sp, type, indices }, () => indices.map((k) => convertAnchor(sp, k, type))));
		}
		const segs: { segment: number; t: number }[] = [];
		const count = sp.anchors.length < 2 ? 0 : sp.closed ? sp.anchors.length : sp.anchors.length - 1;
		for (let s = 0; s < count; s++) for (const t of [0, 0.25, 0.5, 1]) segs.push({ segment: s, t });
		if (segs.length) out.push(vec('insertAnchor', false, { name, subpath: sp, cases: segs }, () => segs.map((c) => insertAnchor(sp, c.segment, c.t))));
		out.push(vec('removeAnchors', false, { name, subpath: sp, indices: [0, 2, 9] }, () => removeAnchors(sp, [0, 2, 9])));
		out.push(vec('reverseSubpath', false, { name, subpath: sp }, () => reverseSubpath(sp)));
	}
	out.push(vec('reverseSubpath', false, { name: 'cornered', subpath: CORNERED.mixed[0] }, () => reverseSubpath(CORNERED.mixed[0])));
	// Shape builders.
	const boxes = [{ x: 0, y: 0, width: 100, height: 60 }, { x: -10.5, y: 3.25, width: 33, height: 0 }, { x: 0, y: 0, width: 0, height: 10 }];
	for (const b of boxes) {
		out.push(vec('rectSubpath', false, { box: b }, () => rectSubpath(b)));
		out.push(vec('rectSubpath', false, { box: b, radius: 8 }, () => rectSubpath(b, 8)));
		out.push(vec('rectSubpath', false, { box: b, radius: 8, kind: 'inverted' }, () => rectSubpath(b, 8, 'inverted')));
		out.push(vec('rectSubpath', false, { box: b, radius: -1, kind: 'chamfer' }, () => rectSubpath(b, -1, 'chamfer')));
		out.push(vec('ellipseSubpath', false, { box: b }, () => ellipseSubpath(b)));
		for (const sides of [3, 6, 7.6, 2]) out.push(vec('polygonSubpath', true, { box: b, sides }, () => polygonSubpath(b, sides)));
		for (const [points, inner] of [[5, 0.45], [3, 0.5], [8.4, 0.2]]) out.push(vec('starSubpath', true, { box: b, points, innerRatio: inner }, () => starSubpath(b, points, inner)));
		out.push(vec('lineSubpath', false, { a: { x: b.x, y: b.y }, b: { x: b.x + b.width, y: b.y + b.height } }, () => lineSubpath({ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height })));
	}
	out.push(vec('setSubpathCorners', false, { subpath: CORNERED.mixed[0], radius: 6, kind: null, smoothing: null }, () => setSubpathCorners(CORNERED.mixed[0], 6)));
	out.push(vec('setSubpathCorners', false, { subpath: CORNERED.mixed[0], radius: 0, kind: null, smoothing: null }, () => setSubpathCorners(CORNERED.mixed[0], 0)));
	out.push(vec('setSubpathCorners', false, { subpath: CORNERED.mixed[0], radius: 0, kind: 'chamfer', smoothing: 2 }, () => setSubpathCorners(CORNERED.mixed[0], 0, 'chamfer', 2)));
	out.push(vec('setSubpathCorners', false, { subpath: CORNERED.smoothed[0], radius: 4, kind: 'round', smoothing: null }, () => setSubpathCorners(CORNERED.smoothed[0], 4, 'round')));
	return out;
}

function matrixVectors(): Entry[] {
	const out: Entry[] = [];
	for (const { name, m, trig } of MATRICES) {
		out.push(vec('matrix', trig, { name }, () => m));
		out.push(vec('invertMatrix', trig, { name, m }, () => invertMatrix(m)));
		out.push(vec('matrixRotation', true, { name, m }, () => matrixRotation(m)));
		out.push(vec('decomposeRigid', true, { name, m }, () => decomposeRigid(m)));
		for (const { name: other, m: n, trig: t2 } of MATRICES.slice(0, 4)) out.push(vec('multiplyMatrices', trig || t2, { name: `${name}*${other}`, a: m, b: n }, () => multiplyMatrices(m, n)));
	}
	out.push(vec('invertMatrix', false, { name: 'singular', m: [1, 2, 2, 4, 0, 0] }, () => invertMatrix([1, 2, 2, 4, 0, 0])));
	return out;
}

function nodeVectors(): Entry[] {
	const out: Entry[] = [];
	const list = nodes();
	const rotatedIds = new Set(['rotated', 'group']);
	const walked: unknown[] = [];
	walkVectorNodes(list, (n, parent, depth) => walked.push([n.id, parent?.id ?? null, depth]));
	out.push(vec('walkVectorNodes', false, { nodes: list }, () => walked));
	const ids = ['rect', 'child2', 'inner', 'frame', 'area', 'missing'];
	out.push(vec('findVectorNode', false, { nodes: list, ids }, () => ids.map((id) => findVectorNode(list, id)?.id ?? null)));
	out.push(
		vec('locateVectorNode', false, { nodes: list, ids }, () =>
			ids.map((id) => {
				const hit = locateVectorNode(list, id);
				if (!hit) return null;
				// The index path from the root list.
				const pathTo = (nodesIn: VectorNode[], prefix: number[]): number[] | null => {
					for (let i = 0; i < nodesIn.length; i++) {
						if (nodesIn[i].id === id) return [...prefix, i];
						const n = nodesIn[i];
						if (n.type === 'group') {
							const found = pathTo(n.children, [...prefix, i]);
							if (found) return found;
						}
					}
					return null;
				};
				return { path: pathTo(list, []), index: hit.index, parent: hit.parent?.id ?? null };
			})
		)
	);
	out.push(vec('vectorWorldMatrix', true, { nodes: list, ids }, () => ids.map((id) => vectorWorldMatrix(list, id))));
	out.push(vec('vectorParentMatrix', true, { nodes: list, ids }, () => ids.map((id) => vectorParentMatrix(list, id))));
	for (const node of list) {
		const trig = rotatedIds.has(node.id) || node.id === 'cornered';
		out.push(vec('collectPaintedNodes', false, { node }, () => collectPaintedNodes(node).map((n) => n.id)));
		out.push(vec('collectPathNodes', false, { node }, () => collectPathNodes(node).map((n) => n.id)));
		out.push(vec('vectorNodeRotation', true, { node }, () => vectorNodeRotation(node)));
		out.push(vec('cloneVectorNode', false, { node }, () => cloneVectorNode(node)));
		if (node.type !== 'instance' && node.id !== 'frame') {
			out.push(vec('vectorNodeBounds', trig, { node, parent: null }, () => vectorNodeBounds(node)));
			out.push(vec('vectorNodeBounds', true, { node, parent: rotateMatrix(10) }, () => vectorNodeBounds(node, rotateMatrix(10))));
		}
		for (const { name, m, trig: mt } of MATRICES) {
			out.push(vec('transformVectorNode', trig || mt || node.id === 'symmetry', { node, matrix: name, m }, () => transformVectorNode(node, m)));
		}
		if (node.type === 'path') {
			const pts = [{ x: 0, y: 0 }, { x: 25, y: 12 }, { x: 100, y: -3 }];
			out.push(vec('nearestSegment', false, { node, points: pts }, () => pts.map((p) => nearestSegment(node, p))));
		}
	}
	const boxes = [{ x: 0, y: 0, width: 10, height: 10 }, null, { x: -5, y: 20, width: 2, height: 0 }, { x: 10, y: 10, width: 0, height: 0 }];
	out.push(vec('unionBounds', false, { boxes }, () => [unionBounds(boxes), unionBounds([]), unionBounds([null])]));
	const pairs = [[boxes[0], boxes[3]], [boxes[0], boxes[2]], [boxes[2], boxes[2]]];
	out.push(vec('boundsIntersect', false, { pairs }, () => pairs.map(([a, b]) => boundsIntersect(a!, b!))));
	out.push(vec('boundsFromPoints', false, { a: { x: 5, y: -2 }, b: { x: -3, y: 7.5 } }, () => boundsFromPoints({ x: 5, y: -2 }, { x: -3, y: 7.5 })));
	const paints = [undefined, null, '', '  NONE ', 'transparent', '#fff', { type: 'linear', stops: [] }];
	out.push(vec('hasPaint', false, { paints: paints.map((p) => (p === undefined ? { absent: true } : { paint: p })) }, () => paints.map(hasPaint)));
	return out;
}

function vectors() {
	return { version: 1, documents: documentVectors(), geometry: [...geometryVectors(), ...matrixVectors(), ...nodeVectors()] };
}

/** The value with every number replaced by 0, so only structure and key order remain. */
function shape(v: unknown): unknown {
	if (typeof v === 'number') return 0;
	if (Array.isArray(v)) return v.map(shape);
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
	return v;
}

describe('Swift vector model test vectors', () => {
	it('match the committed fixture (the Swift tests read it)', () => {
		const now = json(vectors());
		if (process.env.UPDATE_SWIFT_VECTORS) writeFileSync(FILE, JSON.stringify(now) + '\n');
		const committed = JSON.parse(readFileSync(FILE, 'utf8'));
		// Numbers within relative 1e-9 (trig differs across CPUs in the last bit); key order exactly.
		if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
		expect(JSON.stringify(shape(now))).toBe(JSON.stringify(shape(committed)));
	});

	it('round-trips every document through JSON unchanged', () => {
		for (const { doc } of documentVectors()) expect(JSON.stringify(JSON.parse(JSON.stringify(doc)))).toBe(JSON.stringify(doc));
	});
});
