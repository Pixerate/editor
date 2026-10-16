// Variable-width strokes. Behaviour after ArtCraft effectcraft `varstroke.rs`, figcraft
// `props.rs` / `width.rs` and vectorcraft `width.rs` (MIT OR Apache-2.0, © ArtCraft Team and
// contributors), test cases re-expressed. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import {
	createVectorCommands,
	generateWidthProfile,
	getVectorOverlayRenderData,
	getVectorSceneRenderData,
	getVectorSelectionStyle,
	getVectorWidthHandles,
	hitTestVectorNode,
	insertWidthPoint,
	parseVectorSvg,
	pressureWidthProfile,
	reverseWidthProfile,
	sanitizeWidthProfile,
	setWidthPoint,
	subpathsToBezier,
	taperWaveFactor,
	toVectorPointerInput,
	variableStrokeOutline,
	variableStrokeRings,
	vectorDocumentToSvg,
	vectorStrokeOutline,
	vectorStrokeSvgParts,
	VectorEditorController,
	VECTOR_TOOL_SHORTCUTS,
	VECTOR_WIDTH_PRESETS,
	widthProfileAt,
	widthProfilePreset,
	widthProfilePresetId,
	type VectorDocument,
	type VectorPathNode,
	type VectorRenderPath,
	type VectorSubpath,
	type VectorWidthPoint
} from '../src/vector/index.js';
import { CommandRegistry } from '../src/commands/index.js';
import { bezierPathArea, bezierPathLength, outlineStroke, pointInBezierPath, toBezierPath, type BezierPath } from '../src/canvas/pathops/index.js';

const sym = (t: number, s: number): VectorWidthPoint => ({ t, left: s, right: s });
const line = (x0: number, y0: number, x1: number, y1: number): VectorSubpath => ({ anchors: [{ x: x0, y: y0 }, { x: x1, y: y1 }], closed: false });
const pathNode = (id: string, subpaths: VectorSubpath[], extra: Partial<VectorPathNode> = {}): VectorPathNode => ({
	id,
	type: 'path',
	subpaths,
	fill: null,
	stroke: '#000',
	strokeWidth: 20,
	...extra
});
const doc = (...nodes: VectorPathNode[]): VectorDocument => ({ width: 400, height: 300, nodes });
let n = 0;
const make = (document?: VectorDocument) => new VectorEditorController({ document, createId: () => `w${++n}` });
const path = (c: VectorEditorController, id: string) => c.getNode(id) as VectorPathNode;

/** How far the filled outline reaches from y = 0 at x, upwards (−y) and downwards, found by bisection. */
function reachAt(o: BezierPath, x: number, max = 100): { up: number; down: number } {
	const reach = (dir: number) => {
		if (!pointInBezierPath(o, [x, dir * 1e-3])) return 0;
		let lo = 0;
		let hi = max;
		for (let k = 0; k < 40; k++) {
			const mid = (lo + hi) / 2;
			if (pointInBezierPath(o, [x, dir * mid])) lo = mid;
			else hi = mid;
		}
		return lo;
	};
	return { up: reach(-1), down: reach(1) };
}

const CURVE = 'M10 100 C 60 0 140 0 190 100 S 300 200 380 100';

describe('width profiles', () => {
	it('interpolates each side with a monotone cubic that never overshoots its points', () => {
		const p = [sym(0, 1), sym(0.3, 3), sym(0.6, 2.9), sym(1, 0)];
		for (let i = 0; i <= 200; i++) {
			const t = i / 200;
			const { left } = widthProfileAt(p, t);
			// Between two points the width stays between their widths.
			const k = p.findIndex((q, j) => j + 1 < p.length && t >= q.t && t <= p[j + 1].t);
			expect(left).toBeGreaterThanOrEqual(Math.min(p[k].left, p[k + 1].left) - 1e-12);
			expect(left).toBeLessThanOrEqual(Math.max(p[k].left, p[k + 1].left) + 1e-12);
		}
		expect(widthProfileAt(p, 0.3).left).toBeCloseTo(3, 12);
		// Held flat outside the points; uniform without any.
		expect(widthProfileAt([sym(0.2, 2), sym(0.8, 0.5)], 0.1)).toEqual({ left: 2, right: 2 });
		expect(widthProfileAt([sym(0.2, 2), sym(0.8, 0.5)], 0.95)).toEqual({ left: 0.5, right: 0.5 });
		expect(widthProfileAt(null, 0.5)).toEqual({ left: 1, right: 1 });
		// Two points: a straight ramp (the tangents equal the secant).
		expect(widthProfileAt([sym(0, 0), sym(1, 1)], 0.37).left).toBeCloseTo(0.37, 12);
	});

	it('interpolates the two sides on their own and steps at a discontinuous point', () => {
		const p = [{ t: 0, left: 0, right: 2 }, { t: 1, left: 2, right: 0 }];
		expect(widthProfileAt(p, 0.25)).toEqual({ left: 0.5, right: 1.5 });
		const step = [sym(0, 1), sym(0.5, 1), sym(0.5, 3), sym(1, 3)];
		expect(widthProfileAt(step, 0.4999).left).toBeCloseTo(1, 6);
		expect(widthProfileAt(step, 0.5).left).toBe(3);
	});

	it('sanitises points and recognises presets', () => {
		const raw = [{ t: 2, left: 1, right: 1 }, { t: 0.5, left: -1, right: NaN }, { t: NaN, left: 1, right: 1 }, { t: 0, left: 3 }] as any;
		expect(sanitizeWidthProfile(raw)).toEqual([{ t: 0, left: 3, right: 3 }, { t: 0.5, left: 0, right: 0 }, { t: 1, left: 1, right: 1 }]);
		for (const p of VECTOR_WIDTH_PRESETS) expect(widthProfilePresetId(widthProfilePreset(p.id))).toBe(p.id);
		expect(widthProfilePresetId([sym(0, 1), sym(1, 1)])).toBe('uniform');
		expect(widthProfilePresetId([sym(0, 0.3)])).toBe('custom');
		expect(widthProfilePreset('nope')).toBeNull();
		for (const id of ['taperStart', 'taperEnd', 'taperBoth', 'bulge', 'pressure']) expect(widthProfilePreset(id)?.length).toBeGreaterThan(1);
	});

	it('inserts, moves, reverses and removes width points', () => {
		const ins = insertWidthPoint(null, 0.5, { left: 2, right: 3 });
		expect(ins.points).toEqual([sym(0, 1), { t: 0.5, left: 2, right: 3 }, sym(1, 1)]);
		expect(ins.index).toBe(1);
		// Moving is kept between the neighbours, so indices stay put.
		expect(setWidthPoint(ins.points, 1, { t: 1.5 })[1].t).toBe(1);
		expect(setWidthPoint(ins.points, 1, { left: 0 })[1]).toEqual({ t: 0.5, left: 0, right: 3 });
		// Inserting where the width already is keeps the shape there.
		const taper = widthProfilePreset('taperEnd')!;
		const here = insertWidthPoint(taper, 0.25);
		expect(here.points[here.index].left).toBeCloseTo(widthProfileAt(taper, 0.25).left, 12);
		expect(reverseWidthProfile([{ t: 0.2, left: 1, right: 2 }])).toEqual([{ t: 0.8, left: 2, right: 1 }]);
	});

	it('generates profiles from a parametric taper and wave', () => {
		const taper = { startLength: 0.25, startWidth: 0, endLength: 0 };
		expect(taperWaveFactor(0, taper)).toBe(0);
		expect(taperWaveFactor(0.125, taper)).toBeCloseTo(0.5, 12);
		expect(taperWaveFactor(0.5, taper)).toBe(1);
		// Ease bulges the taper outwards.
		expect(taperWaveFactor(0.125, { ...taper, startEase: 1 })).toBeGreaterThan(0.8);
		const wave = { amount: 1, cycles: 5 };
		expect(taperWaveFactor(0, null, wave)).toBeCloseTo(1, 12);
		expect(taperWaveFactor(0.1, null, wave)).toBeCloseTo(0, 12);
		const points = generateWidthProfile({ taper, wave: { amount: 0.4, cycles: 3 } });
		expect(points.length).toBeLessThanOrEqual(64);
		for (const t of [0.05, 0.3, 0.55, 0.9]) expect(widthProfileAt(points, t).left).toBeCloseTo(taperWaveFactor(t, taper, { amount: 0.4, cycles: 3 }), 1);
	});

	it('turns recorded pressure into a profile, half pressure drawing the stroke width', () => {
		const p = pressureWidthProfile([0, 0.25, 0.5, 0.75, 1].map((t) => ({ t, pressure: 0.25 + t / 2 })));
		expect(widthProfileAt(p, 0).left).toBeCloseTo(0.5, 3);
		expect(widthProfileAt(p, 0.5).left).toBeCloseTo(1, 3);
		expect(widthProfileAt(p, 1).left).toBeCloseTo(1.5, 3);
		// A straight ramp simplifies to its two ends.
		expect(p).toHaveLength(2);
		expect(pressureWidthProfile([{ t: 0, pressure: 0.5 }, { t: 1, pressure: 0.5 }])).toEqual([]);
	});
});

describe('variable-width outline', () => {
	it('reaches the profile width on each side at sampled positions', () => {
		const p = toBezierPath('M0 0 L200 0');
		const profile = [{ t: 0, left: 0, right: 0.5 }, { t: 0.5, left: 2, right: 1 }, { t: 1, left: 0.5, right: 0 }];
		const o = variableStrokeOutline(p, { width: 20, profile });
		for (const t of [0.1, 0.25, 0.4, 0.5, 0.7, 0.9]) {
			const w = widthProfileAt(profile, t);
			const r = reachAt(o, 200 * t);
			// Left of a path running +x is up on screen (−y).
			expect(r.up).toBeCloseTo(10 * w.left, 1);
			expect(r.down).toBeCloseTo(10 * w.right, 1);
		}
	});

	it('is a Bézier outline, not a polyline', () => {
		const o = variableStrokeOutline(toBezierPath(CURVE), { width: 12, profile: widthProfilePreset('taperBoth')! });
		const curves = o.filter((c) => c.type === 'C').length;
		const pieces = variableStrokeRings(toBezierPath(CURVE), { width: 12, profile: widthProfilePreset('taperBoth')! });
		expect(curves).toBeGreaterThan(4);
		// Far fewer commands than the flattened pieces have edges.
		expect(o.length).toBeLessThan(pieces.reduce((a, r) => a + r.length, 0) / 10);
	});

	it('matches outlineStroke for a constant profile (caps and joins included)', () => {
		const one = [sym(0, 1), sym(1, 1)];
		const paths = [CURVE, 'M0 0 L100 0 L100 100 L30 60', 'M100 50 A50 50 0 0 1 0 50 A50 50 0 0 1 100 50 Z', 'M20 20 L180 20 L180 120 L20 120 Z'];
		for (const d of paths) {
			for (const cap of ['butt', 'round', 'square'] as const) {
				for (const join of ['miter', 'round', 'bevel'] as const) {
					const p = toBezierPath(d);
					const ours = bezierPathArea(variableStrokeOutline(p, { width: 16, profile: one, cap, join }));
					const ref = bezierPathArea(outlineStroke(p, { width: 16, cap, join }));
					expect(Math.abs(ours - ref) / ref).toBeLessThan(1e-3);
				}
			}
		}
		// A constant scale of 2 is a stroke twice as wide.
		const p = toBezierPath(CURVE);
		const twice = bezierPathArea(variableStrokeOutline(p, { width: 8, profile: [sym(0.3, 2)], cap: 'round' }));
		expect(Math.abs(twice - bezierPathArea(outlineStroke(p, { width: 16, cap: 'round' }))) / twice).toBeLessThan(1e-3);
	});

	it('has the exact area of a linear taper', () => {
		const p = toBezierPath('M0 0 L300 0');
		const o = variableStrokeOutline(p, { width: 30, profile: [sym(0, 0), sym(1, 1)] });
		expect(bezierPathArea(o)).toBeCloseTo((300 * 30) / 2, 1);
		// On a curve too: the area is the integral of the width along the path.
		const c = toBezierPath('M10 100 C 60 0 140 0 190 100');
		const len = bezierPathLength(c);
		expect(bezierPathArea(variableStrokeOutline(c, { width: 10, profile: [sym(0, 0), sym(1, 1)] })) / ((len * 10) / 2)).toBeCloseTo(1, 3);
	});

	it('cuts dashes along the same arc length the profile follows', () => {
		const p = toBezierPath('M0 0 L200 0');
		const o = variableStrokeOutline(p, { width: 20, profile: [sym(0, 1), sym(1, 2)], dash: [20, 10] });
		expect(pointInBezierPath(o, [10, 0])).toBe(true);
		expect(pointInBezierPath(o, [25, 0])).toBe(false);
		expect(reachAt(o, 190).up).toBeCloseTo(10 * widthProfileAt([sym(0, 1), sym(1, 2)], 0.95).left, 1);
		// Three dashes of 20 in every 30 over 200: 6 whole dashes and a partial one.
		expect(o.filter((c) => c.type === 'M')).toHaveLength(7);
	});

	it('strokes closed paths continuously and empty paths with nothing', () => {
		const o = variableStrokeOutline(toBezierPath('M0 0 L100 0 L100 100 L0 100 Z'), { width: 10, profile: [sym(0, 1), sym(0.5, 2), sym(1, 1)], join: 'miter' });
		// One outer ring and one hole.
		expect(o.filter((c) => c.type === 'M')).toHaveLength(2);
		expect(pointInBezierPath(o, [50, 50])).toBe(false);
		expect(variableStrokeOutline([], { width: 10, profile: [sym(0, 1)] })).toEqual([]);
		expect(variableStrokeOutline(toBezierPath('M0 0 L10 0'), { width: 0, profile: [sym(0, 1)] })).toEqual([]);
	});
});

describe('profiled strokes in the editor', () => {
	const tapered = () => pathNode('t', [line(0, 50, 200, 50)], { strokeWidthProfile: widthProfilePreset('taperEnd')!, strokeLinecap: 'round' });

	it('renders as a filled outline through strokeParts, cached per node', () => {
		const node = tapered();
		const scene = getVectorSceneRenderData({ document: doc(node), viewport: { x: 0, y: 0, zoom: 1 } });
		const r = scene.nodes[0] as VectorRenderPath;
		expect(r.strokeParts?.outline).toMatch(/^M/);
		expect(r.strokeParts?.align).toBe('center');
		expect(vectorStrokeSvgParts(node, 've-clip-t')).toBe(vectorStrokeSvgParts(node, 've-clip-t'));
		// A uniform profile is a plain stroke.
		const plain = getVectorSceneRenderData({ document: doc(pathNode('u', [line(0, 0, 10, 0)], { strokeWidthProfile: [sym(0, 1), sym(1, 1)] })), viewport: { x: 0, y: 0, zoom: 1 } });
		expect((plain.nodes[0] as VectorRenderPath).strokeParts).toBeUndefined();
	});

	it('hit-tests the width at the nearest point of the path', () => {
		const node = tapered();
		expect(hitTestVectorNode(node, { x: 10, y: 58 })).toBe(true);
		expect(hitTestVectorNode(node, { x: 190, y: 58 })).toBe(false);
		expect(hitTestVectorNode(node, { x: 190, y: 50.3 })).toBe(true);
		// Round cap at the wide end.
		expect(hitTestVectorNode(node, { x: -6, y: 50 })).toBe(true);
	});

	it('clips an inside stroke and keeps arrowheads', () => {
		const inside = pathNode('i', [{ anchors: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], closed: true }], {
			strokeWidth: 10,
			strokeAlign: 'inside',
			strokeWidthProfile: [sym(0, 1), sym(1, 1.5)]
		});
		const area = vectorStrokeOutline(inside);
		// Left side, 7/8 of the way round: the inside stroke is 10 × 1.4375 wide there.
		expect(pointInBezierPath(area, [12, 50])).toBe(true);
		expect(pointInBezierPath(area, [17, 50])).toBe(false);
		expect(pointInBezierPath(area, [50, -3])).toBe(false);
		expect(pointInBezierPath(area, [50, 3])).toBe(true);
		const arrowed = { ...tapered(), endArrow: 'triangle' as const };
		expect(pointInBezierPath(vectorStrokeOutline(arrowed), [215, 50])).toBe(true);
	});

	it('exports the outline with the profile and imports it back', () => {
		const svg = vectorDocumentToSvg(doc(tapered()));
		expect(svg).toContain('data-vector-part="stroke-outline"');
		expect(svg).toContain('data-vector-width-profile="0,1,1;1,0,0"');
		const back = parseVectorSvg(svg).nodes[0] as VectorPathNode;
		expect(back.strokeWidthProfile).toEqual(widthProfilePreset('taperEnd'));
		expect(back.strokeLinecap).toBe('round');
		expect(back.stroke).toBe('#000');
		expect(back.strokeWidth).toBe(20);
		expect(back.subpaths[0].anchors).toHaveLength(2);
	});

	it('bakes the profile with Outline Stroke', () => {
		const c = make(doc(tapered()));
		c.select(['t']);
		const [id] = c.outlineStroke();
		const out = path(c, id);
		expect(out.strokeWidthProfile).toBeUndefined();
		expect(out.fill).toBe('#000');
		// The taper: the area of a 200 × 20 triangle plus the round cap at the wide end.
		const area = bezierPathArea(subpathsToBezier(out.subpaths));
		expect(area).toBeCloseTo(2000 + (Math.PI * 100) / 2, -1);
	});

	it('sets, reports and resets profiles through setStyle, setWidthProfile and commands', () => {
		const c = make(doc(pathNode('a', [line(0, 0, 100, 0)]), pathNode('b', [line(0, 50, 100, 50)])));
		c.select(['a']);
		expect(c.setWidthProfile('bulge').ok).toBe(true);
		expect(path(c, 'a').strokeWidthProfile).toEqual(widthProfilePreset('bulge'));
		let style = getVectorSelectionStyle(c.getState())!;
		expect(style.widthProfile).toBe('bulge');
		c.select(['a', 'b']);
		style = getVectorSelectionStyle(c.getState())!;
		expect(style.mixed.widthProfile).toBe(true);
		expect(c.setStyle({ strokeWidthProfile: null }).ok).toBe(true);
		expect('strokeWidthProfile' in path(c, 'a')).toBe(false);
		expect(getVectorSelectionStyle(c.getState())!.widthProfile).toBe('uniform');
		expect(c.setWidthProfile('nope' as any).ok).toBe(false);
		c.undo();
		expect(path(c, 'a').strokeWidthProfile).toEqual(widthProfilePreset('bulge'));

		const registry = new CommandRegistry();
		for (const spec of createVectorCommands(c)) registry.register(spec);
		const res = registry.execute('vector.setWidthProfile', { ids: ['b'], taper: { startLength: 0.3 } }) as any;
		expect(res.ok).toBe(true);
		expect(widthProfileAt(path(c, 'b').strokeWidthProfile, 0).left).toBeCloseTo(0, 6);
		registry.execute('vector.setStyle', { ids: ['b'], strokeWidthProfile: [{ t: 0, left: 2, right: 0 }] });
		expect(path(c, 'b').strokeWidthProfile).toEqual([{ t: 0, left: 2, right: 0 }]);
	});

	it('mirrors the profile with the path when reversing or flipping', () => {
		const c = make(doc(pathNode('a', [line(0, 0, 100, 0)], { strokeWidthProfile: [{ t: 0.2, left: 1, right: 2 }] })));
		c.select(['a']);
		c.reversePaths();
		expect(path(c, 'a').strokeWidthProfile).toEqual([{ t: 0.8, left: 2, right: 1 }]);
		c.flip('vertical');
		expect(path(c, 'a').strokeWidthProfile).toEqual([{ t: 0.8, left: 1, right: 2 }]);
	});
});

describe('width tool', () => {
	const setup = () => {
		const c = make(doc(pathNode('p', [line(50, 100, 250, 100)], { strokeWidth: 10 })));
		c.setTool('width');
		return c;
	};

	it('has the W shortcut', () => {
		const c = make();
		expect(VECTOR_TOOL_SHORTCUTS.width).toBe('W');
		expect(new Set(Object.values(VECTOR_TOOL_SHORTCUTS)).size).toBe(Object.keys(VECTOR_TOOL_SHORTCUTS).length);
		c.keyDown({ key: 'w' });
		expect(c.getState().tool).toBe('width');
	});

	it('drags a stroke wider at a point, symmetric by default', () => {
		const c = setup();
		c.pointerMove({ x: 150, y: 102 });
		expect(c.getState().hover?.strokeSpot?.t).toBeCloseTo(0.5, 6);
		expect(getVectorOverlayRenderData(c.getState()).widthSpot).not.toBeNull();
		c.pointerDown({ x: 150, y: 102 });
		c.pointerMove({ x: 150, y: 120 });
		c.pointerUp({ x: 150, y: 120 });
		const p = path(c, 'p').strokeWidthProfile!;
		expect(p).toHaveLength(3);
		// The edge follows the pointer: 20 from the path is a side scale of 4 (half width 5).
		expect(p[1]).toEqual({ t: 0.5, left: 4, right: 4 });
		expect(c.getState().selectedWidthPoint).toMatchObject({ nodeId: 'p', index: 1 });
		expect(c.getState().undoLabel).toBe('Width Point');
		const overlay = getVectorOverlayRenderData(c.getState());
		expect(overlay.widthPoints).toHaveLength(3);
		expect(overlay.widthPoints[1]).toMatchObject({ x: 150, y: 100, left: { x: 150, y: 80 }, right: { x: 150, y: 120 }, selected: true });
	});

	it('widens one side with Alt, moves a point along the path and deletes it', () => {
		const c = setup();
		c.pointerDown({ x: 100, y: 98 }, { alt: true });
		c.pointerMove({ x: 100, y: 85 });
		c.pointerUp({ x: 100, y: 85 });
		let p = path(c, 'p').strokeWidthProfile!;
		expect(p[1]).toEqual({ t: 0.25, left: 3, right: 1 });
		// Drag the centre to slide it.
		c.pointerMove({ x: 100, y: 100 });
		expect(c.getState().hover?.widthPoint).toMatchObject({ index: 1, part: 'center' });
		c.pointerDown({ x: 100, y: 100 });
		c.pointerMove({ x: 200, y: 104 });
		c.pointerUp({ x: 200, y: 104 });
		p = path(c, 'p').strokeWidthProfile!;
		expect(p[1].t).toBeCloseTo(0.75, 6);
		expect(c.getState().undoLabel).toBe('Move Width Point');
		// Drag the left end of the handle: both sides follow unless Alt is held.
		c.pointerDown({ x: 200, y: 85 });
		c.pointerMove({ x: 200, y: 75 });
		c.pointerUp({ x: 200, y: 75 });
		expect(path(c, 'p').strokeWidthProfile![1]).toMatchObject({ left: 5, right: 5 });
		expect(c.keyDown({ key: 'Delete' })).toBe(true);
		expect(path(c, 'p').strokeWidthProfile).toHaveLength(2);
		expect(path(c, 'p').subpaths).toHaveLength(1);
	});

	it('adds nothing on a click', () => {
		const c = setup();
		c.pointerDown({ x: 150, y: 100 });
		c.pointerUp({ x: 150, y: 100 });
		expect(path(c, 'p').strokeWidthProfile).toBeUndefined();
		expect(c.getState().canUndo).toBe(false);
		// Away from any stroke nothing happens either.
		c.pointerDown({ x: 150, y: 200 });
		c.pointerUp({ x: 150, y: 220 });
		expect(path(c, 'p').strokeWidthProfile).toBeUndefined();
		expect(getVectorWidthHandles(c.getState())).toEqual([]);
	});
});

describe('pencil pressure', () => {
	const draw = (input: { pointerType?: string; pressures?: number[] }, editing?: { pencilPressure: 'pen' | 'all' | 'off' }) => {
		const c = make();
		if (editing) c.setEditing(editing);
		c.setTool('pencil');
		const ps = input.pressures ?? [0.2, 0.4, 0.6, 0.8, 1];
		c.pointerDown({ x: 10, y: 10 }, { pointerType: input.pointerType, pressure: ps[0] });
		for (let i = 1; i <= 40; i++) c.pointerMove({ x: 10 + i * 5, y: 10 + Math.sin(i / 5) * 10 }, { pointerType: input.pointerType, pressure: ps[Math.min(ps.length - 1, Math.floor((i / 40) * ps.length))] });
		c.pointerUp({ x: 210, y: 10 }, { pointerType: input.pointerType, pressure: 0 });
		return path(c, c.getState().selection[0]);
	};

	it('records pen pressure as a width profile', () => {
		const node = draw({ pointerType: 'pen' });
		const p = node.strokeWidthProfile!;
		expect(p.length).toBeGreaterThan(1);
		expect(widthProfileAt(p, 0).left).toBeCloseTo(0.4, 1);
		// The lift (pressure 0) does not pinch the end.
		expect(widthProfileAt(p, 1).left).toBeCloseTo(2, 1);
	});

	it('ignores the mouse unless asked, and can be turned off', () => {
		expect(draw({ pointerType: 'mouse' }).strokeWidthProfile).toBeUndefined();
		expect(draw({ pointerType: 'mouse' }, { pencilPressure: 'all' }).strokeWidthProfile?.length).toBeGreaterThan(1);
		expect(draw({ pointerType: 'pen' }, { pencilPressure: 'off' }).strokeWidthProfile).toBeUndefined();
	});

	it('passes pressure and pointer type through toVectorPointerInput', () => {
		expect(toVectorPointerInput({ button: 0, pressure: 0.7, pointerType: 'pen' })).toMatchObject({ pressure: 0.7, pointerType: 'pen' });
		expect(toVectorPointerInput({ button: 0 })).not.toHaveProperty('pressure');
	});
});
