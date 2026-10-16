// Path morphing and live blends. Behaviour after ArtCraft effectcraft `interp.rs`, vectorcraft
// `blend.rs` and deckcraft `morph.rs` (MIT OR Apache-2.0, © ArtCraft Team and contributors),
// test cases re-expressed. See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import {
	correspondMorphContours,
	createVectorMorph,
	ellipseSubpath,
	evaluateVectorPathKeyframes,
	generateVectorBlendChildren,
	interpolateMorphContours,
	interpolateRigidMatrix,
	interpolateVectorPaint,
	interpolateVectorPaths,
	interpolateVectorStyle,
	interpolateWidthProfiles,
	morphPathsCross,
	refineMorphContour,
	refreshVectorBlends,
	reverseMorphContour,
	vectorBlendKeys,
	subpathToMorphContour,
	subpathsToBezier,
	turnMorphContour,
	vectorBlendStepCount,
	vectorNodeBounds,
	type VectorGroupNode,
	type VectorMorphContour,
	type VectorNode,
	type VectorPathNode,
	type VectorSubpath
} from '../src/vector/index.js';
import { bezierPathLength, bezierPathSignedArea } from '../src/canvas/pathops/bezier.js';
import { CommandRegistry } from '../src/commands/index.js';
import {
	createVectorCommands,
	findVectorNode,
	getVectorBlendControls,
	getVectorOverlayRenderData,
	parseVectorSvg,
	vectorDocumentToSvg,
	VectorEditorController,
	type VectorDocument
} from '../src/vector/index.js';

const poly = (pts: [number, number][], closed = true): VectorSubpath => ({ closed, anchors: pts.map(([x, y]) => ({ x, y })) });

const star = (cx: number, cy: number, r: number, points: number, rot: number): VectorSubpath =>
	poly(
		Array.from({ length: 2 * points }, (_, i) => {
			const a = rot + (i * Math.PI) / points;
			const rr = i % 2 === 0 ? r : r * 0.5;
			return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)] as [number, number];
		})
	);

const rotateList = <T,>(list: T[], k: number) => [...list.slice(k), ...list.slice(0, k)];

const path = (id: string, subpaths: VectorSubpath[], extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id, type: 'path', subpaths, fill: '#000000', ...extra });

const area = (n: VectorNode) => Math.abs(bezierPathSignedArea(subpathsToBezier((n as VectorPathNode).subpaths)));
const centre = (n: VectorNode) => {
	const b = vectorNodeBounds(n)!;
	return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

describe('arc-length anchor insertion', () => {
	it('keeps the outline and spreads anchors by length', () => {
		const e = ellipseSubpath({ x: 10, y: 30, width: 80, height: 40 });
		const c = subpathToMorphContour(e)!;
		const r = refineMorphContour(c, 23).contour;
		expect((r.pts.length - 1) / 3).toBe(23);
		const len = (x: VectorMorphContour) => bezierPathLength(subpathsToBezier([{ closed: true, anchors: [] }]).concat(subpathsToBezier([toSub(x)])));
		expect(Math.abs(len(r) - len(c))).toBeLessThan(0.05);
		// New anchors lie on the ellipse.
		for (let k = 0; k < 23; k++) {
			const [x, y] = r.pts[3 * k];
			expect(Math.abs(((x - 50) / 40) ** 2 + ((y - 50) / 20) ** 2 - 1)).toBeLessThan(0.01);
		}
		// A 100 × 20 bar gets most of its anchors on the long sides.
		const bar = refineMorphContour(subpathToMorphContour(poly([[0, 0], [100, 0], [100, 20], [0, 20]]))!, 16);
		expect(bar.anchors).toEqual([0, 6, 8, 14]);
	});

	it('turns and reverses closed contours keeping their outline', () => {
		const c = subpathToMorphContour(poly([[0, 0], [10, 0], [10, 10], [0, 10]]))!;
		expect(turnMorphContour(c, 2).pts[0]).toEqual([10, 10]);
		expect(turnMorphContour(c, 2).pts[12]).toEqual([10, 10]);
		const r = reverseMorphContour(c);
		expect(r.pts[0]).toEqual([0, 0]);
		expect(r.pts[3]).toEqual([0, 10]);
	});
});

function toSub(c: VectorMorphContour): VectorSubpath {
	const n = (c.pts.length - 1) / 3;
	const anchors = Array.from({ length: c.closed ? n : n + 1 }, (_, k) => ({ x: c.pts[3 * k][0], y: c.pts[3 * k][1] }) as VectorSubpath['anchors'][number]);
	for (let k = 0; k < n; k++) {
		anchors[k].out = { x: c.pts[3 * k + 1][0], y: c.pts[3 * k + 1][1] };
		anchors[(k + 1) % anchors.length].in = { x: c.pts[3 * k + 2][0], y: c.pts[3 * k + 2][1] };
	}
	return { anchors, closed: c.closed };
}

describe('correspondence', () => {
	const a = star(100, 100, 60, 5, 0);
	const b0 = star(140, 110, 50, 5, 0.3);
	const b = { closed: true, anchors: rotateList(b0.anchors, 3) };

	it('finds the cyclic start so anchor paths do not cross', () => {
		const ca = [subpathToMorphContour(a)!];
		const cb = [subpathToMorphContour(b)!];
		const r = correspondMorphContours(ca, cb, { minSegments: 1 });
		expect(r.reversed).toBe(false);
		expect(r.b[0].pts[0][0]).toBeCloseTo(b0.anchors[0].x, 9);
		expect(r.b[0].pts[0][1]).toBeCloseTo(b0.anchors[0].y, 9);
		expect(morphPathsCross(r.a, r.b)).toBeLessThanOrEqual(1);
		// Keeping the stored starts twists the morph.
		const kept = correspondMorphContours(ca, cb, { minSegments: 1, matchStart: false });
		expect(morphPathsCross(kept.a, kept.b)).toBeGreaterThan(5);
	});

	it('chooses the winding: a shape drawn the other way round runs backwards', () => {
		const ccw = { closed: true, anchors: b0.anchors.slice().reverse() };
		const r = correspondMorphContours([subpathToMorphContour(a)!], [subpathToMorphContour(ccw)!], { minSegments: 1 });
		expect(r.reversed).toBe(true);
		expect(morphPathsCross(r.a, r.b)).toBeLessThanOrEqual(1);
	});

	it('pairs shapes with different anchor counts', () => {
		const circle = ellipseSubpath({ x: 40, y: 40, width: 120, height: 120 });
		const r = correspondMorphContours([subpathToMorphContour(a)!], [subpathToMorphContour(circle)!]);
		expect(r.a[0].pts.length).toBe(r.b[0].pts.length);
		const n = (r.a[0].pts.length - 1) / 3;
		expect(n).toBeGreaterThanOrEqual(16);
		expect(morphPathsCross(r.a, r.b)).toBeLessThanOrEqual(n / 10);
	});

	it('starts from clicked anchors', () => {
		const sq = poly([[0, 0], [10, 0], [10, 10], [0, 10]]);
		const moved = { closed: true, anchors: rotateList(poly([[100, 0], [110, 0], [110, 10], [100, 10]]).anchors, 2) };
		const A = path('a', [sq]);
		const B = path('b', [moved]);
		// Both from anchor 0: each corner meets the opposite one and the middle collapses.
		const bad = interpolateVectorPaths(A, B, 0.5, { starts: [0, 0], minSegments: 1, linear: true });
		expect(vectorNodeBounds(bad)!.height).toBeLessThan(1e-6);
		const good = interpolateVectorPaths(A, B, 0.5, { starts: [0, 2], minSegments: 1 });
		expect(vectorNodeBounds(good)!.width).toBeCloseTo(10, 6);
		expect(vectorNodeBounds(good)!.height).toBeCloseTo(10, 6);
		// An open path clicked at its last anchor runs backwards.
		const line = (x: number) => path(`l${x}`, [poly([[x, 0], [x + 10, 0]], false)]);
		const m = interpolateVectorPaths(line(0), line(100), 0.5, { starts: [null, 1], minSegments: 1, matchStart: false }) as VectorPathNode;
		expect(m.subpaths[0].anchors[0].x).toBeCloseTo(55, 9);
	});
});

describe('in-betweens', () => {
	it('turns a rotating shape instead of collapsing it (Procrustes)', () => {
		const bar = path('a', [poly([[-50, -10], [50, -10], [50, 10], [-50, 10]])]);
		const turned = path('b', [poly([[10, -50], [10, 50], [-10, 50], [-10, -50]])]);
		const mid = interpolateVectorPaths(bar, turned, 0.5);
		expect(area(mid)).toBeCloseTo(area(bar), 3);
		const lin = interpolateVectorPaths(bar, turned, 0.5, { linear: true });
		expect(area(lin)).toBeLessThan(area(bar) * 0.8);
		// A quarter of the way through it has turned a quarter of 90°.
		const q = interpolateVectorPaths(bar, turned, 0.25, { minSegments: 4 }) as VectorPathNode;
		const [p0, p1] = q.subpaths[0].anchors;
		expect((Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI).toBeCloseTo(22.5, 6);
	});

	it('keeps the area of a rotated star through the morph', () => {
		const A = path('a', [star(100, 100, 60, 5, 0)]);
		const B = path('b', [star(300, 100, 60, 5, 0.5)]);
		for (const t of [0.25, 0.5, 0.75]) expect(area(interpolateVectorPaths(A, B, t))).toBeCloseTo(area(A), 2);
	});

	it('grows a hole out of a point when contour counts differ', () => {
		const ring = path('a', [poly([[0, 0], [100, 0], [100, 100], [0, 100]]), poly([[25, 25], [25, 75], [75, 75], [75, 25]])], { fillRule: 'evenodd' });
		const disc = path('b', [poly([[200, 0], [300, 0], [300, 100], [200, 100]])], { fillRule: 'evenodd' });
		const morph = createVectorMorph(ring, disc);
		const mid = morph.at(0.5) as VectorPathNode;
		expect(mid.subpaths).toHaveLength(2);
		const hole = vectorNodeBounds({ ...mid, subpaths: [mid.subpaths[1]] })!;
		expect(hole.width).toBeCloseTo(25, 0);
		const end = morph.at(1) as VectorPathNode;
		const gone = vectorNodeBounds({ ...end, subpaths: [end.subpaths[1]] })!;
		expect(gone.width).toBeLessThan(1e-9);
		expect(gone.x).toBeCloseTo(250, 6);
	});

	it('opens a closed contour on its way to an open one', () => {
		const sq = path('a', [poly([[0, 0], [10, 0], [10, 10], [0, 10]])]);
		const line = path('b', [poly([[100, 0], [140, 0]], false)]);
		const morph = createVectorMorph(sq, line);
		expect((morph.at(0) as VectorPathNode).subpaths[0].closed).toBe(true);
		expect((morph.at(0.5) as VectorPathNode).subpaths[0].closed).toBe(false);
		expect((morph.at(1) as VectorPathNode).subpaths[0].closed).toBe(false);
	});

	it('cuts live corners before blending', () => {
		const rounded = path('a', [{ closed: true, anchors: poly([[0, 0], [100, 0], [100, 100], [0, 100]]).anchors.map((a) => ({ ...a, corner: { radius: 50 } })) }]);
		const sq = path('b', [poly([[200, 0], [300, 0], [300, 100], [200, 100]])]);
		const start = interpolateVectorPaths(rounded, sq, 0);
		expect(area(start)).toBeCloseTo(Math.PI * 50 * 50, -1);
		expect((start as VectorPathNode).subpaths[0].anchors.every((a) => !a.corner)).toBe(true);
	});

	it('interpolates rigid transforms as rotation plus translation', () => {
		const m = interpolateRigidMatrix([Math.cos(3), Math.sin(3), -Math.sin(3), Math.cos(3), 0, 0], [Math.cos(-3), Math.sin(-3), -Math.sin(-3), Math.cos(-3), 10, 20], 0.5);
		expect(Math.abs(Math.atan2(m[1], m[0]))).toBeCloseTo(Math.PI, 9);
		expect(Math.hypot(m[0], m[1])).toBeCloseTo(1, 9);
		expect([m[4], m[5]]).toEqual([5, 10]);
		// Shapes are blended in their parent's space; the step's own transform is the mix.
		const r30 = (deg: number, x: number): [number, number, number, number, number, number] => {
			const a = (deg * Math.PI) / 180;
			return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), x, 0];
		};
		const sq = [poly([[-10, -10], [10, -10], [10, 10], [-10, 10]])];
		const A = path('a', sq, { transform: r30(0, 0) });
		const B = path('b', sq, { transform: r30(60, 100) });
		const mid = interpolateVectorPaths(A, B, 0.5) as VectorPathNode;
		expect((Math.atan2(mid.transform![1], mid.transform![0]) * 180) / Math.PI).toBeCloseTo(30, 6);
		expect(centre(mid).x).toBeCloseTo(50, 6);
		expect(area(mid)).toBeCloseTo(400, 6);
	});

	it('pairs the paths of groups and grows the extra ones', () => {
		const g1: VectorGroupNode = { id: 'g1', type: 'group', children: [path('p', [poly([[0, 0], [10, 0], [10, 10], [0, 10]])])] };
		const g2: VectorGroupNode = {
			id: 'g2',
			type: 'group',
			children: [path('q', [poly([[100, 0], [110, 0], [110, 10], [100, 10]])]), path('r', [poly([[100, 20], [110, 20], [110, 30], [100, 30]])])]
		};
		const mid = interpolateVectorPaths(g1, g2, 0.5) as VectorGroupNode;
		expect(mid.type).toBe('group');
		expect(mid.children).toHaveLength(2);
		expect(area(mid.children[0])).toBeCloseTo(100, 6);
		expect(area(mid.children[1])).toBeCloseTo(25, 6);
	});
});

describe('paint', () => {
	it('mixes colours in OKLab and fades a missing paint', () => {
		expect(interpolateVectorPaint('#ff0000', '#0000ff', 0)).toBe('#ff0000');
		const mid = interpolateVectorPaint('#ff0000', '#0000ff', 0.5) as string;
		expect(mid).toMatch(/^#[0-9a-f]{6}$/);
		expect(mid).not.toBe('#800080'); // not an sRGB mix
		expect(interpolateVectorPaint(null, '#ff0000', 0.5)).toBe('#ff000080');
	});

	it('resamples gradient stops to a common set', () => {
		const a = { type: 'linear' as const, angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] };
		const b = { type: 'linear' as const, angle: 90, stops: [{ offset: 0, color: '#000000' }, { offset: 0.5, color: '#ff0000' }, { offset: 1, color: '#ffffff' }] };
		const g = interpolateVectorPaint(a, b, 0.5) as typeof a;
		expect(g.stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
		expect(g.angle).toBe(45);
		// Solid to gradient goes through a gradient of the solid colour.
		const s = interpolateVectorPaint('#000000', a, 0.5) as typeof a;
		expect(s.type).toBe('linear');
		expect(s.stops[0].color).toBe('#000000');
		// Kinds that differ switch halfway.
		expect(interpolateVectorPaint(a, { type: 'radial', stops: a.stops }, 0.4)).toBe(a);
	});

	it('mixes stroke width, dashes, arrow scales and width profiles; switches caps', () => {
		const s = interpolateVectorStyle(
			{ strokeWidth: 2, strokeLinecap: 'butt', strokeDasharray: [4, 2], endArrowScale: 1 },
			{ strokeWidth: 6, strokeLinecap: 'round', endArrowScale: 3 },
			0.25
		);
		expect(s.strokeWidth).toBe(3);
		expect(s.strokeLinecap).toBe('butt');
		expect(s.endArrowScale).toBe(1.5);
		expect(s.strokeDasharray).toEqual([4.5, 1.5]);
		const p = interpolateWidthProfiles([{ t: 0, left: 0, right: 0 }, { t: 1, left: 2, right: 2 }], null, 0.5)!;
		expect(p.map((x) => x.left)).toEqual([0.5, 1.5]);
		const node = interpolateVectorPaths(path('a', [poly([[0, 0], [10, 0], [10, 10]])], { opacity: 0.2 }), path('b', [poly([[0, 0], [10, 0], [10, 10]])]), 0.5);
		expect(node.opacity).toBeCloseTo(0.6, 9);
	});
});

describe('path keyframes', () => {
	it('morphs between keyframes with easing', () => {
		const A = path('a', [poly([[0, 0], [10, 0], [10, 10], [0, 10]])]);
		const B = path('b', [poly([[100, 0], [110, 0], [110, 10], [100, 10]])]);
		const keys = [
			{ time: 0, value: A },
			{ time: 1000, value: B }
		];
		expect(evaluateVectorPathKeyframes(keys, -5)).toBe(A);
		expect(evaluateVectorPathKeyframes(keys, 2000)).toBe(B);
		expect(centre(evaluateVectorPathKeyframes(keys, 500)!).x).toBeCloseTo(55, 6);
		expect(centre(evaluateVectorPathKeyframes([{ ...keys[0], easing: 'hold' }, keys[1]], 500)!).x).toBe(5);
		expect(evaluateVectorPathKeyframes([], 0)).toBeNull();
	});
});

const square = (id: string, x: number, y = 0, extra: Partial<VectorPathNode> = {}) => path(id, [poly([[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10]])], extra);

describe('blend groups', () => {
	it('counts steps by number, distance or smooth colour', () => {
		const a = square('a', 0, 0, { fill: '#000000' });
		const b = square('b', 100, 0, { fill: '#000000' });
		expect(vectorBlendStepCount(a, b, { spacing: 'steps', steps: 3 }, 100)).toBe(3);
		expect(vectorBlendStepCount(a, b, { spacing: 'distance', distance: 25 }, 100)).toBe(3);
		expect(vectorBlendStepCount(a, b, { spacing: 'distance', distance: 200 }, 100)).toBe(0);
		expect(vectorBlendStepCount(a, b, { spacing: 'smoothColor' }, 100)).toBe(50);
		expect(vectorBlendStepCount(a, { ...b, fill: '#ffffff' }, { spacing: 'smoothColor' }, 100)).toBe(128);
	});

	it('generates steps between keys and keeps them fresh', () => {
		const group: VectorGroupNode = { id: 'g', type: 'group', blend: { steps: 3 }, children: [square('a', 0, 0, { fill: '#ff0000' }), square('b', 100, 0, { fill: '#0000ff' })] };
		const children = generateVectorBlendChildren(group);
		expect(children.map((c) => c.id)).toEqual(['a', 'g~1', 'g~2', 'g~3', 'b']);
		expect(children.slice(1, 4).every((c) => c.blendStep && c.locked)).toBe(true);
		expect(children.slice(1, 4).map((c) => centre(c).x)).toEqual([30, 55, 80]);
		// Straight runs keep no extra anchors: a square's steps are squares.
		expect((children[1] as VectorPathNode).subpaths[0].anchors).toHaveLength(4);
		// Refreshing: the same nodes back when nothing changed, new steps when a key moved.
		const nodes = refreshVectorBlends([group]);
		expect(refreshVectorBlends(nodes)).toBe(nodes);
		const g = nodes[0] as VectorGroupNode;
		const moved = { ...g, children: g.children.map((c) => (c.id === 'b' ? square('b', 100, 100, { fill: '#0000ff' }) : c)) };
		const next = refreshVectorBlends([moved])[0] as VectorGroupNode;
		expect(centre(next.children[2]).y).toBeCloseTo(55, 6);
		// Distance spacing.
		const spaced = generateVectorBlendChildren({ ...group, blend: { spacing: 'distance', distance: 20 } });
		expect(spaced.filter((c) => c.blendStep)).toHaveLength(4);
	});

	it('lays steps along a replaced spine and can orient them to it', () => {
		// Keys at the ends of an arch through (55, -95).
		const spine: VectorSubpath = poly([[5, 5], [55, -95], [105, 5]], false);
		const group: VectorGroupNode = { id: 'g', type: 'group', blend: { steps: 1, spine }, children: [square('a', 0), square('b', 100)] };
		const kids = generateVectorBlendChildren(group);
		expect(centre(kids[1]).x).toBeCloseTo(55, 6);
		expect(centre(kids[1]).y).toBeCloseTo(-95, 6);
		expect(centre(kids[0])).toEqual({ x: 5, y: 5 });
		// Three steps: the outer ones turn with the spine when oriented.
		const oriented = generateVectorBlendChildren({ ...group, blend: { steps: 3, spine, orientToSpine: true } });
		const left = oriented[1] as VectorPathNode;
		expect(left.transform).toBeDefined();
		expect(Math.abs(Math.atan2(left.transform![1], left.transform![0]))).toBeGreaterThan(0.5);
		const flat = generateVectorBlendChildren({ ...group, blend: { steps: 3, spine } });
		expect((flat[1] as VectorPathNode).transform).toBeUndefined();
	});
});

describe('blends in the editor', () => {
	const doc = (): VectorDocument => ({
		width: 400,
		height: 300,
		nodes: [square('a', 0, 0, { fill: '#ff0000' }), square('b', 100, 0, { fill: '#0000ff' }), path('s', [poly([[5, 100], [55, 0], [105, 100]], false)], { fill: null, stroke: '#000000' })]
	});
	let n = 0;
	const make = () => new VectorEditorController({ document: doc(), createId: () => `id${++n}` });
	const group = (c: VectorEditorController, id: string) => c.getNode(id) as VectorGroupNode;
	const steps = (g: VectorGroupNode) => g.children.filter((k) => k.blendStep);

	it('blends the selection as one undo step and regenerates on edits', () => {
		const c = make();
		c.select(['b', 'a']);
		expect(getVectorBlendControls(c.getState()).canBlend).toBe(true);
		const id = c.blend({ steps: 3 })!;
		expect(id).toBeTruthy();
		const g = group(c, id);
		expect(g.children.map((k) => k.id)).toEqual(['a', `${id}~1`, `${id}~2`, `${id}~3`, 'b']);
		expect(c.getState().selection).toEqual([id]);
		expect(c.getState().undoLabel).toBe('Blend');
		expect(getVectorBlendControls(c.getState())).toMatchObject({ ids: [id], options: { spacing: 'steps', steps: 3 } });
		// Moving a key moves the steps with it.
		c.translate(0, 100, { ids: ['b'] });
		expect(centre(steps(group(c, id))[1]).y).toBeCloseTo(55, 6);
		// Options regenerate the steps; a click on a step selects the blend.
		expect(c.setBlendOptions({ spacing: 'distance', distance: 10 }).ok).toBe(true);
		expect(steps(group(c, id)).length).toBeGreaterThan(5);
		c.setTool('select');
		c.clearSelection();
		const mid = centre(steps(group(c, id))[2]);
		c.pointerDown(mid);
		c.pointerUp(mid);
		expect(c.getState().selection).toEqual([id]);
		// Undo walks back one step at a time.
		c.undo();
		expect(steps(group(c, id))).toHaveLength(3);
		c.undo();
		c.undo();
		expect(c.getNode(id)).toBeUndefined();
		expect(c.getDocument().nodes.map((k) => k.id)).toEqual(['a', 'b', 's']);
	});

	it('expands to plain paths and releases back to the keys', () => {
		const c = make();
		const id = c.blend({ ids: ['a', 'b'], steps: 2 })!;
		expect(c.expandBlend()).toEqual([id]);
		const g = group(c, id);
		expect(g.blend).toBeUndefined();
		expect(g.children).toHaveLength(4);
		expect(g.children.some((k) => k.blendStep || k.locked)).toBe(false);
		expect(g.children[1].id).not.toContain('~');
		c.undo();
		expect(c.releaseBlend()).toEqual(['a', 'b']);
		expect(c.getDocument().nodes.map((k) => k.id)).toEqual(['a', 'b', 's']);
	});

	it('replaces the spine with a path and shows it in the overlay', () => {
		const c = make();
		const id = c.blend({ ids: ['a', 'b'], steps: 1 })!;
		expect(getVectorOverlayRenderData(c.getState()).blend.spines[0]).toMatchObject({ id, replaced: false });
		c.select([id, 's']);
		expect(getVectorBlendControls(c.getState()).canReplaceSpine).toBe(true);
		expect(c.replaceBlendSpine().ok).toBe(true);
		expect(c.getNode('s')).toBeUndefined();
		const g = group(c, id);
		expect(g.blend?.spine?.anchors).toHaveLength(3);
		// Keys sit at the spine's ends, the step at its apex.
		expect(centre(g.children[0])).toEqual({ x: 5, y: 100 });
		expect(centre(g.children[2]).x).toBeCloseTo(105, 9);
		expect(centre(g.children[1]).x).toBeCloseTo(55, 6);
		expect(centre(g.children[1]).y).toBeCloseTo(0, 6);
		const overlay = getVectorOverlayRenderData(c.getState()).blend.spines[0];
		expect(overlay.replaced).toBe(true);
		expect(overlay.keys).toEqual([{ x: 5, y: 100 }, { x: 105, y: 100 }]);
		// Rotating the blend carries its spine.
		c.rotate(90);
		const turned = group(c, id);
		expect(turned.transform).toBeDefined();
		expect(centre(turned.children[1]).x).toBeCloseTo(55, 6);
		// Release gives the spine back as a path.
		expect(c.releaseBlend()).toHaveLength(3);
	});

	it('blends with the Blend tool: click one shape, then another', () => {
		const c = make();
		c.setTool('blend');
		c.pointerMove({ x: 5, y: 5 });
		expect(c.getState().hover?.nodeId).toBe('a');
		c.pointerDown({ x: 5, y: 5 });
		c.pointerUp({ x: 5, y: 5 });
		expect(c.getState().blendStart).toEqual({ nodeId: 'a', anchor: null });
		expect(getVectorOverlayRenderData(c.getState()).blend.start?.d).toBeTruthy();
		// Click b on its third corner: the blend starts there.
		c.pointerDown({ x: 110, y: 10 });
		c.pointerUp({ x: 110, y: 10 });
		const g = c.getDocument().nodes.find((k) => k.type === 'group') as VectorGroupNode;
		expect(g.blend?.starts).toEqual({ b: 2 });
		expect(c.getState().blendStart).toBeNull();
		expect(c.getState().undoLabel).toBe('Blend');
		// Clicking on from the blend adds the next shape as a key.
		c.pointerDown(centre(g.children[1]));
		c.pointerDown({ x: 30, y: 50 });
		expect(vectorBlendKeys(group(c, g.id)).map((k) => k.id)).toEqual(['a', 'b', 's']);
	});

	it('runs the agent commands and survives an SVG round trip', () => {
		const c = make();
		const registry = new CommandRegistry();
		for (const spec of createVectorCommands(c)) registry.register(spec);
		const run = (cmd: string, params?: unknown) => registry.execute(cmd, params) as { ok: boolean; result?: any; message?: string };
		const { id } = run('vector.blend', { ids: ['a', 'b'], spacing: 'steps', steps: 4 }).result as { id: string };
		expect(steps(group(c, id))).toHaveLength(4);
		expect(run('vector.blendOptions', { ids: [id], steps: 2 }).ok).toBe(true);
		expect(steps(group(c, id))).toHaveLength(2);
		expect(run('vector.blendOptions', { ids: [id], spacing: 'nope' }).ok).toBe(false);
		expect(run('vector.blend', { ids: ['a'] }).ok).toBe(false);
		const listed = (run('vector.list').result as { nodes: { id: string; blend?: { keys: string[] } }[] }).nodes.find((k) => k.id === id);
		expect(listed?.blend?.keys).toEqual(['a', 'b']);
		// SVG keeps the blend live: steps are dropped on import and rebuilt.
		const svg = vectorDocumentToSvg(c.getDocument());
		expect(svg).toContain('data-vector-blend=');
		const back = new VectorEditorController({ document: parseVectorSvg(svg) });
		const g = back.getDocument().nodes.find((k) => k.type === 'group') as VectorGroupNode;
		expect(g.blend?.steps).toBe(2);
		expect(steps(g)).toHaveLength(2);
		expect(run('vector.expandBlend', { ids: [id] }).result).toEqual({ ids: [id] });
		expect(group(c, id).blend).toBeUndefined();
		expect(findVectorNode(c.getDocument().nodes, `${id}~1`)).toBeUndefined();
	});
});
