import { describe, expect, it } from 'vitest';
import {
	arrowheadInset,
	createVectorCommands,
	expandVectorCorners,
	getVectorCornerWidgets,
	getVectorOverlayRenderData,
	getVectorSceneRenderData,
	getVectorSelectionStyle,
	hitTestVectorNode,
	KAPPA,
	parseVectorSvg,
	rectSubpath,
	subpathsToBezier,
	vectorCorners,
	vectorDocumentToSvg,
	vectorNodeBounds,
	vectorStrokeOutline,
	vectorStrokeParts,
	VectorEditorController,
	type VectorDocument,
	type VectorPathNode,
	type VectorRenderPath,
	type VectorSubpath
} from '../src/vector/index.js';
import { CommandRegistry } from '../src/commands/index.js';
import { bezierPathArea, bezierPathBounds, distanceToBezierPath, pathBoolean, segmentLength, segmentPoint, pathToContours } from '../src/canvas/pathops/index.js';

const pathNode = (id: string, subpaths: VectorSubpath[], extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id, type: 'path', subpaths, fill: '#f00', stroke: null, ...extra });
const square = (r: number, kind?: 'round' | 'inverted' | 'chamfer'): VectorSubpath => rectSubpath({ x: 0, y: 0, width: 100, height: 100 }, r, kind);
const doc = (...nodes: VectorPathNode[]): VectorDocument => ({ width: 400, height: 300, nodes });
let n = 0;
const make = (document?: VectorDocument) => new VectorEditorController({ document, createId: () => `id${++n}` });
const path = (c: VectorEditorController, id: string) => c.getNode(id) as VectorPathNode;
const segmentsOf = (sp: VectorSubpath) => pathToContours(subpathsToBezier([sp], { corners: false }))[0].segments;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (seg: readonly (readonly [number, number])[]) => {
	const p = segmentPoint(seg as any, 0.5);
	return { x: p[0], y: p[1] };
};

/** The cubic between output anchors `i` and `i + 1`. */
const arcAt = (sp: VectorSubpath, i: number) => segmentsOf(sp)[i];

describe('live corners', () => {
	it('draws a rounded rectangle from four sharp anchors without changing them', () => {
		const sp = square(10);
		const [out] = expandVectorCorners([sp]);
		expect(sp.anchors).toHaveLength(4);
		expect(out.anchors).toHaveLength(8);
		expect(out.anchors.some((a) => a.corner)).toBe(false);
		// The closed subpath starts where its first corner's cut ends, and the cut of corner 0 closes it.
		expect(out.anchors[0]).toMatchObject({ x: 10, y: 0 });
		expect(out.anchors[7]).toMatchObject({ x: 0, y: 10 });
		// Each cut is a quarter circle: handles KAPPA·r long, midpoint r from the arc's centre.
		const arc = arcAt(out, 1);
		expect(arc).toHaveLength(4);
		expect(dist({ x: arc[0][0], y: arc[0][1] }, { x: arc[1][0], y: arc[1][1] })).toBeCloseTo(10 * KAPPA, 9);
		expect(dist(mid(arc), { x: 90, y: 10 })).toBeCloseTo(10, 2);
		// Area of a rounded square: s² − (4 − π)·r².
		expect(Math.abs(bezierPathArea(subpathsToBezier([sp])))).toBeCloseTo(100 * 100 - (4 - Math.PI) * 100, 0);
	});

	it('makes a true circular arc tangent to both sides at any angle', () => {
		for (const deg of [30, 60, 120, 150]) {
			const t = (deg * Math.PI) / 180;
			// Corner at the origin between a side along +x and one at `deg` degrees.
			const sp: VectorSubpath = {
				closed: true,
				anchors: [{ x: 0, y: 0, corner: { radius: 8 } }, { x: 100, y: 0 }, { x: 100 * Math.cos(t), y: 100 * Math.sin(t) }]
			};
			const [c] = vectorCorners([sp]);
			expect(c.angle).toBeCloseTo(deg, 6);
			const out = expandVectorCorners([sp])[0];
			// Output: [end of corner 0, anchor 1, anchor 2, start of corner 0]; the cut is the closing segment.
			const segs = segmentsOf(out);
			const arc = segs[segs.length - 1];
			const centre = { x: 8 / Math.tan(t / 2), y: 8 };
			// One cubic per cut: within 0.03% of the radius at a right angle, under 1% even at a 150° turn.
			for (const s of [0.25, 0.5, 0.75]) {
				const p = segmentPoint(arc, s);
				expect(Math.abs(Math.hypot(p[0] - centre.x, p[1] - centre.y) - 8)).toBeLessThan(8 * (deg >= 90 ? 1e-3 : 1e-2));
			}
			// Tangent: the arc leaves each end along its side.
			const end = out.anchors[0];
			expect(end.in!.y).toBeCloseTo(0, 9);
			expect(end.x).toBeCloseTo(centre.x, 9);
		}
	});

	it('clamps each cut to half of the shorter side', () => {
		const tri: VectorSubpath = { closed: true, anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 40 }].map((a) => ({ ...a, corner: { radius: 1e6 } })) };
		const corners = vectorCorners([tri]);
		const out = expandVectorCorners([tri])[0];
		expect(out.anchors).toHaveLength(6);
		for (const c of corners) {
			const shorter = Math.min(c.lu, c.lv);
			const ends = out.anchors.filter((a) => Math.abs(dist(a, c.at) - shorter / 2) < 1e-6);
			expect(ends.length).toBeGreaterThanOrEqual(1);
		}
	});

	it('trims a curved side by arc length where the cut meets it', () => {
		// A corner where a line meets a cubic bulging upwards.
		const sp: VectorSubpath = {
			closed: false,
			anchors: [
				{ x: 0, y: 100 },
				{ x: 0, y: 0, out: { x: 40, y: -40 }, corner: { radius: 15 } },
				{ x: 100, y: 0, in: { x: 60, y: -40 } }
			]
		};
		const curve = segmentsOf(sp)[1];
		const out = expandVectorCorners([sp])[0];
		expect(out.anchors).toHaveLength(4);
		const end = out.anchors[2];
		// The cut's end lies on the original curve, the rest of the curve is kept.
		expect(distanceToBezierPath(subpathsToBezier([sp], { corners: false }), [end.x, end.y])).toBeLessThan(1e-6);
		const rest = segmentsOf(out)[2];
		expect(segmentLength(rest)).toBeLessThan(segmentLength(curve));
		// Both sides are trimmed by the same arc length.
		const start = out.anchors[1];
		const along = segmentLength(curve) - segmentLength(rest);
		expect(along).toBeCloseTo(start.y, 4);
	});

	it('cuts inverted and chamfered corners', () => {
		const inv = expandVectorCorners([square(20, 'inverted')])[0];
		// An arc centred on the corner (100, 0) through both cut ends: its midpoint is 20 from it.
		expect(dist(mid(arcAt(inv, 1)), { x: 100, y: 0 })).toBeCloseTo(20, 2);
		const ch = expandVectorCorners([square(20, 'chamfer')])[0];
		expect(arcAt(ch, 1)).toHaveLength(2);
		expect(Math.abs(bezierPathArea(subpathsToBezier([square(20, 'chamfer')])))).toBeCloseTo(10000 - 4 * 200, 6);
	});

	it('skips smooth anchors, open ends and straight-on anchors', () => {
		const sp: VectorSubpath = {
			closed: false,
			anchors: [
				{ x: 0, y: 0, corner: { radius: 5 } },
				{ x: 50, y: 0, corner: { radius: 5 } },
				{ x: 100, y: 0, corner: { radius: 5 } },
				{ x: 100, y: 50, in: { x: 100, y: 40 }, out: { x: 100, y: 60 }, type: 'smooth', corner: { radius: 5 } },
				{ x: 100, y: 100 }
			]
		};
		expect(vectorCorners([sp]).map((c) => c.index)).toEqual([2]);
		expect(expandVectorCorners([sp])[0].anchors).toHaveLength(6);
	});

	it('uses the cut geometry for hit-testing, bounds, booleans and export', () => {
		const node = pathNode('a', [square(30)]);
		expect(hitTestVectorNode(node, { x: 2, y: 2 })).toBe(false);
		expect(hitTestVectorNode(node, { x: 50, y: 50 })).toBe(true);
		expect(vectorNodeBounds(node)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
		const united = pathBoolean('union', [subpathsToBezier(node.subpaths), subpathsToBezier([rectSubpath({ x: 200, y: 0, width: 10, height: 10 })])]);
		// (Cubic quarter circles hold a hair more area than true ones.)
		expect(Math.abs(Math.abs(bezierPathArea(united.path)) - (10000 - (4 - Math.PI) * 900 + 100))).toBeLessThan(1);
		const svg = vectorDocumentToSvg(doc(node));
		expect(svg).toContain('data-vector-corners="0.0:30 0.1:30 0.2:30 0.3:30"');
		const back = parseVectorSvg(svg).nodes[0] as VectorPathNode;
		expect(back.subpaths[0].anchors).toHaveLength(4);
		expect(back.subpaths[0].anchors.every((a) => a.corner?.radius === 30)).toBe(true);
	});

	it('gives the rectangle, polygon and star tools editable corners', () => {
		const c = make(doc());
		c.setDefaults({ cornerRadius: 6 });
		for (const kind of ['rect', 'polygon', 'star'] as const) {
			const id = c.addShape({ kind, x: 0, y: 0, width: 100, height: 100 });
			const anchors = path(c, id).subpaths[0].anchors;
			expect(anchors.every((a) => a.corner?.radius === 6 && !a.in && !a.out)).toBe(true);
		}
		const sharp = c.addShape({ kind: 'rect', x: 0, y: 0, width: 10, height: 10, cornerRadius: 0 });
		expect(path(c, sharp).subpaths[0].anchors.some((a) => a.corner)).toBe(false);
	});

	it('sets radii and kinds on the selected anchors or whole paths, with undo', () => {
		const c = make(doc(pathNode('a', [square(0)])));
		c.select(['a']);
		expect(c.setCornerRadius(12).ok).toBe(true);
		expect(path(c, 'a').subpaths[0].anchors.every((a) => a.corner?.radius === 12)).toBe(true);
		expect(getVectorSelectionStyle(c.getState())).toMatchObject({ cornerRadius: 12, corners: 4, mixed: { cornerRadius: false } });
		c.setTool('direct');
		c.selectAnchors([{ nodeId: 'a', subpath: 0, index: 2 }]);
		c.setCornerRadius(4, { kind: 'chamfer' });
		const anchors = path(c, 'a').subpaths[0].anchors;
		expect(anchors[2].corner).toEqual({ radius: 4, kind: 'chamfer' });
		expect(anchors[1].corner).toEqual({ radius: 12 });
		expect(getVectorSelectionStyle(c.getState())).toMatchObject({ cornerRadius: 4, cornerKind: 'chamfer', corners: 1 });
		c.setCornerKind('inverted', { ids: ['a'] });
		expect(path(c, 'a').subpaths[0].anchors.map((a) => a.corner?.kind)).toEqual(['inverted', 'inverted', 'inverted', 'inverted']);
		c.undo();
		c.undo();
		expect(path(c, 'a').subpaths[0].anchors[2].corner).toEqual({ radius: 12 });
		expect(c.setCornerRadius(-1).ok).toBe(false);
	});

	it('keeps corners through moves, scaling, reversal and copies', () => {
		const c = make(doc(pathNode('a', [square(8)])));
		c.select(['a']);
		c.transform([2, 0, 0, 1, 5, 0]);
		expect(path(c, 'a').subpaths[0].anchors.every((a) => a.corner?.radius === 8)).toBe(true);
		expect(path(c, 'a').subpaths[0].anchors[1].x).toBe(205);
		c.transform([Math.cos(1), Math.sin(1), -Math.sin(1), Math.cos(1), 0, 0]);
		expect(path(c, 'a').subpaths[0].anchors.every((a) => a.corner?.radius === 8)).toBe(true);
		c.copy();
		const [pasted] = c.paste();
		expect(path(c, pasted).subpaths[0].anchors.every((a) => a.corner?.radius === 8)).toBe(true);
	});
});

describe('corner widgets', () => {
	const setup = () => {
		const c = make(doc(pathNode('a', [rectSubpath({ x: 0, y: 0, width: 200, height: 200 })])));
		c.setTool('direct');
		c.select(['a']);
		return c;
	};

	it('shows a widget inside every corner and drags the radius along the bisector', () => {
		const c = setup();
		const widgets = getVectorCornerWidgets(c.getState());
		expect(widgets).toHaveLength(4);
		// At zoom 1 the widget sits the minimum inset inside each side of a right angle.
		expect(widgets[0]).toMatchObject({ x: 10, y: 10, radius: 0, kind: 'round' });
		expect(getVectorOverlayRenderData(c.getState()).cornerWidgets).toHaveLength(4);
		c.pointerDown({ x: 10, y: 10 });
		c.pointerMove({ x: 20, y: 20 });
		expect(getVectorOverlayRenderData(c.getState()).status).toBe('R 10');
		c.pointerMove({ x: 30, y: 30 });
		c.pointerUp({ x: 30, y: 30 });
		// The centre moved 20·√2 along the bisector: a radius of 20 at a right angle (every shown corner).
		expect(path(c, 'a').subpaths[0].anchors.map((a) => a.corner?.radius)).toEqual([20, 20, 20, 20]);
		expect(c.getState().undoLabel).toBe('Corner Radius');
		// The widget now sits at the arc's centre.
		expect(getVectorCornerWidgets(c.getState())[0]).toMatchObject({ x: 20, y: 20, radius: 20 });
		// Dragging past fully round stops at the largest radius.
		c.pointerDown({ x: 20, y: 20 });
		c.pointerMove({ x: 400, y: 400 });
		c.pointerUp({ x: 400, y: 400 });
		expect(path(c, 'a').subpaths[0].anchors[0].corner?.radius).toBeCloseTo(100, 9);
	});

	it('cycles the kind with an Alt-click and picks one corner with a click', () => {
		const c = setup();
		c.pointerDown({ x: 10, y: 10 }, { alt: true });
		c.pointerUp({ x: 10, y: 10 }, { alt: true });
		expect(path(c, 'a').subpaths[0].anchors.map((a) => a.corner?.kind)).toEqual(['inverted', 'inverted', 'inverted', 'inverted']);
		c.pointerDown({ x: 190, y: 190 });
		c.pointerUp({ x: 190, y: 190 });
		expect(c.getState().selectedAnchors).toEqual([{ nodeId: 'a', subpath: 0, index: 2 }]);
		const widgets = getVectorCornerWidgets(c.getState());
		expect(widgets.map((w) => w.ref.index)).toEqual([2]);
		c.pointerDown({ x: 190, y: 190 });
		c.pointerMove({ x: 180, y: 180 });
		c.pointerUp({ x: 180, y: 180 });
		expect(path(c, 'a').subpaths[0].anchors.map((a) => a.corner?.radius ?? 0)).toEqual([0, 0, 10, 0]);
	});

	it('hides widgets on corners too small to grab and outside the direct tool', () => {
		const c = make(doc(pathNode('a', [rectSubpath({ x: 0, y: 0, width: 20, height: 20 })])));
		c.select(['a']);
		expect(getVectorCornerWidgets(c.getState())).toHaveLength(0);
		c.setTool('direct');
		expect(getVectorCornerWidgets(c.getState())).toHaveLength(0);
		c.setViewport({ zoom: 4 });
		expect(getVectorCornerWidgets(c.getState())).toHaveLength(4);
	});
});

describe('stroke alignment', () => {
	const stroked = (align: 'center' | 'inside' | 'outside', extra: Partial<VectorPathNode> = {}) =>
		pathNode('s', [square(0)], { fill: null, stroke: '#000', strokeWidth: 10, strokeAlign: align, ...extra });

	it('hit-tests the side of the outline the stroke is on', () => {
		const inside = stroked('inside');
		expect(hitTestVectorNode(inside, { x: 8, y: 50 })).toBe(true);
		expect(hitTestVectorNode(inside, { x: -3, y: 50 })).toBe(false);
		expect(hitTestVectorNode(inside, { x: 12, y: 50 })).toBe(false);
		const outside = stroked('outside');
		expect(hitTestVectorNode(outside, { x: -8, y: 50 })).toBe(true);
		expect(hitTestVectorNode(outside, { x: 3, y: 50 })).toBe(false);
		const centre = stroked('center');
		expect(hitTestVectorNode(centre, { x: -4, y: 50 })).toBe(true);
		expect(hitTestVectorNode(centre, { x: 4, y: 50 })).toBe(true);
		expect(hitTestVectorNode(centre, { x: 8, y: 50 })).toBe(false);
		// Open paths have no inside: they stroke centred.
		const open = pathNode('o', [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }], { fill: null, stroke: '#000', strokeWidth: 10, strokeAlign: 'inside' });
		expect(hitTestVectorNode(open, { x: 50, y: -4 })).toBe(true);
		expect(vectorStrokeParts(subpathsToBezier(open.subpaths), open).align).toBe('center');
	});

	it('outlines the stroke as twice the width clipped by the fill', () => {
		const area = (node: VectorPathNode) => Math.abs(bezierPathArea(vectorStrokeOutline(node)));
		expect(area(stroked('center'))).toBeCloseTo(110 * 110 - 90 * 90, 3);
		expect(area(stroked('inside'))).toBeCloseTo(100 * 100 - 80 * 80, 3);
		expect(area(stroked('outside'))).toBeCloseTo(120 * 120 - 100 * 100, 3);
		// Rounded corners are followed: the inside stroke stays inside the rounded fill.
		const rounded = stroked('inside', { subpaths: [square(20)] });
		const b = bezierPathBounds(vectorStrokeOutline(rounded))!;
		expect(b.minX).toBeCloseTo(0, 6);
		expect(b.maxX).toBeCloseTo(100, 6);
	});

	it('renders aligned strokes as a double-width stroke clipped or masked by the shape', () => {
		const c = make(doc(stroked('inside', { fill: '#ff0', id: 'i' }), stroked('outside', { id: 'o', transform: [1, 0, 0, 1, 150, 0] })));
		const [inside, outside] = getVectorSceneRenderData(c.getState(), { idPrefix: 't-' }).nodes as VectorRenderPath[];
		expect(inside.strokeParts).toMatchObject({ align: 'inside', width: 20, clip: { kind: 'clip', id: 't-clip-i' }, heads: [] });
		expect(outside.strokeParts?.clip).toMatchObject({ kind: 'mask', id: 't-clip-o' });
		const b = outside.strokeParts!.clip!.bounds;
		expect(b.x).toBeLessThan(-10);
		expect(b.x + b.width).toBeGreaterThan(110);
		expect(getVectorSceneRenderData({ ...c.getState(), document: doc(stroked('center')) }).nodes[0]).not.toHaveProperty('strokeParts');
	});

	it('exports a clip or mask and imports it back as one aligned path', () => {
		const svg = vectorDocumentToSvg(doc(stroked('inside', { id: 'i', fill: '#ff0' }), stroked('outside', { id: 'o', opacity: 0.5 })));
		expect(svg).toContain('<clipPath id="vg-clip-i">');
		expect(svg).toContain('<mask id="vg-clip-o" maskUnits="userSpaceOnUse"');
		expect(svg).toMatch(/data-vector-part="stroke"[^>]*stroke-width="20"[^>]*clip-path="url\(#vg-clip-i\)"/);
		const back = parseVectorSvg(svg);
		expect(back.nodes.map((n) => n.type)).toEqual(['path', 'path']);
		const [i, o] = back.nodes as VectorPathNode[];
		expect(i).toMatchObject({ id: 'i', fill: '#ff0', stroke: '#000', strokeWidth: 10, strokeAlign: 'inside' });
		expect(o).toMatchObject({ id: 'o', fill: null, strokeWidth: 10, strokeAlign: 'outside', opacity: 0.5 });
		expect(i.subpaths[0].anchors).toHaveLength(4);
		// Outlines instead of clips.
		const outlined = vectorDocumentToSvg(doc(stroked('inside', { id: 'i' })), { strokes: 'outline' });
		expect(outlined).toContain('data-vector-part="stroke-outline"');
		expect(outlined).not.toContain('<clipPath');
		expect(parseVectorSvg(outlined).nodes[0]).toMatchObject({ stroke: '#000', strokeWidth: 10, strokeAlign: 'inside' });
	});
});

describe('arrowheads', () => {
	const line = (extra: Partial<VectorPathNode> = {}) =>
		pathNode('l', [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }], { fill: null, stroke: '#000', strokeWidth: 2, ...extra });
	const parts = (node: VectorPathNode) => vectorStrokeParts(subpathsToBezier(node.subpaths), node);

	it('extends the tip past the end, or sits it on the end and shortens the stroke', () => {
		const extend = parts(line({ endArrow: 'triangle' }));
		expect(extend.heads).toHaveLength(1);
		// A head of weight 2 is 8 long; the stroke stops halfway into a solid head.
		expect(extend.heads[0]).toMatchObject({ end: 'end', kind: 'triangle', inset: 4, tip: { x: 104, y: 0 }, dir: { x: 1, y: 0 } });
		expect(bezierPathBounds(extend.line)!.maxX).toBe(100);
		const tip = parts(line({ endArrow: 'triangle', arrowAlign: 'tip' }));
		expect(tip.heads[0].tip).toEqual({ x: 100, y: 0 });
		expect(bezierPathBounds(tip.line)!.maxX).toBeCloseTo(96, 9);
		const head = bezierPathBounds(tip.heads[0].path)!;
		expect(head).toEqual({ minX: 92, minY: -4, maxX: 100, maxY: 4 });
	});

	it('points start heads backwards and scales each end on its own', () => {
		const p = parts(line({ startArrow: 'circle', endArrow: 'bar', endArrowScale: 2 }));
		const start = p.heads.find((h) => h.end === 'start')!;
		expect(start.dir.x).toBeCloseTo(-1, 9);
		// Extended: the tip sits the inset (half the head) before the start point.
		expect(bezierPathBounds(start.path)!.minX).toBeCloseTo(-4, 6);
		expect(bezierPathBounds(start.path)!.maxX).toBeCloseTo(4, 6);
		const end = p.heads.find((h) => h.end === 'end')!;
		// Bar: 4 weights across (weight 4 at scale 2), 0.75 weight thick.
		const b = bezierPathBounds(end.path)!;
		expect(b.maxY - b.minY).toBeCloseTo(16, 9);
		expect(b.maxX - b.minX).toBeCloseTo(3, 9);
	});

	it('keeps caps behind the tip and the line out of hollow heads', () => {
		expect(arrowheadInset('triangle', 1, 0)).toBe(2);
		expect(arrowheadInset('bar', 1, 2)).toBe(2);
		expect(arrowheadInset('open', 1, 0)).toBeCloseTo(Math.sqrt(5), 9);
		expect(arrowheadInset('arrow', 1, 0)).toBeCloseTo(1.4, 9);
	});

	it('follows curves, skips closed paths and puts heads on the outer ends only', () => {
		const curved = pathNode('c', [{ closed: false, anchors: [{ x: 0, y: 0, out: { x: 50, y: -50 } }, { x: 100, y: 0, in: { x: 100, y: -50 } }] }], {
			fill: null,
			stroke: '#000',
			endArrow: 'open',
			arrowAlign: 'tip'
		});
		const h = parts(curved).heads[0];
		expect(h.dir.y).toBeGreaterThan(0.5);
		expect(parts(pathNode('sq', [square(0)], { stroke: '#000', endArrow: 'triangle' })).heads).toHaveLength(0);
		const two = pathNode('t', [
			{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
			{ closed: false, anchors: [{ x: 0, y: 50 }, { x: 10, y: 50 }] }
		], { stroke: '#000', startArrow: 'square', endArrow: 'square' });
		const heads = parts(two).heads;
		expect(heads.map((x) => [x.end, Math.round(x.tip.y)])).toEqual([['start', 0], ['end', 50]]);
	});

	it('hit-tests, renders, outlines and round-trips heads', () => {
		const node = line({ endArrow: 'triangle', startArrow: 'open', arrowAlign: 'tip', startArrowScale: 1.5 });
		expect(hitTestVectorNode(node, { x: 98, y: 3 })).toBe(false);
		expect(hitTestVectorNode(node, { x: 97, y: 1.2 })).toBe(true);
		const scene = getVectorSceneRenderData({ document: doc(node), viewport: { x: 0, y: 0, zoom: 1 } }).nodes[0] as VectorRenderPath;
		expect(scene.strokeParts?.heads).toHaveLength(2);
		expect(scene.strokeParts?.clip).toBeNull();
		expect(Math.abs(bezierPathArea(vectorStrokeOutline(node)))).toBeGreaterThan(2 * 90);
		const svg = vectorDocumentToSvg(doc(node));
		expect(svg.match(/data-vector-part="head"/g)).toHaveLength(2);
		const back = parseVectorSvg(svg).nodes[0] as VectorPathNode;
		expect(back).toMatchObject({ id: 'l', startArrow: 'open', endArrow: 'triangle', arrowAlign: 'tip', startArrowScale: 1.5, strokeWidth: 2, fill: null });
		expect(back.subpaths[0].anchors).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
	});
});

describe('style panel and commands', () => {
	it('reports the new stroke fields and mixed values', () => {
		const c = make(doc(pathNode('a', [square(0)], { stroke: '#000', strokeAlign: 'inside' }), pathNode('b', [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 5, y: 5 }] }], { endArrow: 'bar' })));
		c.select(['a', 'b']);
		const style = getVectorSelectionStyle(c.getState())!;
		expect(style).toMatchObject({ strokeAlign: 'inside', startArrow: null, endArrow: null, arrowAlign: 'extend', endArrowScale: 1, hasOpenPath: true });
		expect(style.mixed).toMatchObject({ strokeAlign: true, endArrow: true, startArrow: false });
	});

	it('exposes the new style fields, corners and Outline Stroke as commands', () => {
		const c = make(doc(pathNode('a', [square(0)], { stroke: '#000', strokeWidth: 4 })));
		const registry = new CommandRegistry({ history: c.history });
		registry.register(createVectorCommands(c));
		expect(registry.execute('vector.setStyle', { ids: ['a'], strokeAlign: 'outside', endArrow: 'circle', arrowAlign: 'tip', endArrowScale: 2 }).ok).toBe(true);
		expect(path(c, 'a')).toMatchObject({ strokeAlign: 'outside', endArrow: 'circle', arrowAlign: 'tip', endArrowScale: 2 });
		expect(registry.execute('vector.setStyle', { ids: ['a'], endArrow: null }).ok).toBe(true);
		expect(path(c, 'a').endArrow).toBeNull();
		expect(registry.execute('vector.setCorners', { ids: ['a'], radius: 10, kind: 'chamfer' }).ok).toBe(true);
		expect(path(c, 'a').subpaths[0].anchors[0].corner).toEqual({ radius: 10, kind: 'chamfer' });
		expect(registry.execute('vector.setCorners', { anchors: [{ nodeId: 'a', subpath: 0, index: 1 }], kind: 'round' }).ok).toBe(true);
		expect(path(c, 'a').subpaths[0].anchors[1].corner).toEqual({ radius: 10 });
		expect(registry.execute('vector.setCorners', { ids: ['a'] })).toMatchObject({ ok: false });
		const out = registry.execute('vector.outlineStroke', { ids: ['a'] }) as any;
		expect(out.ok).toBe(true);
		const [fillNode, strokeNode] = c.getState().document.nodes as VectorPathNode[];
		expect(fillNode).toMatchObject({ id: 'a', stroke: null, fill: '#f00' });
		expect(strokeNode).toMatchObject({ id: out.result.ids[0], fill: '#000', stroke: null });
		expect(strokeNode.strokeAlign).toBeUndefined();
		// Outside stroke of a chamfered square: everything is outside the fill.
		expect(hitTestVectorNode(strokeNode, { x: 50, y: 50 })).toBe(false);
		expect(hitTestVectorNode(strokeNode, { x: 50, y: -2 })).toBe(true);
		c.undo();
		expect(c.getState().document.nodes).toHaveLength(1);
	});
});
