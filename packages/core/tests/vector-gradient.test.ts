// Vector gradients: sampling, geometry, SVG paint servers, import / export and blends. Behaviour
// after ArtCraft vectorcraft `gradient.rs` / `spread.rs` / `stroke/gradient.rs`, photocraft
// `gradient_fill.rs` / `gradient_bake.rs`, effectcraft `shapes.rs` and figcraft `color/lib.rs`
// (MIT OR Apache-2.0, © ArtCraft Team and contributors), test cases re-expressed. See
// THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import {
	applyVectorGradientSpread,
	expandVectorGradientSpread,
	expandVectorGradientStops,
	gradientMidpointRemap,
	interpolateVectorPaint,
	moveVectorGradientHandle,
	parseVectorColor,
	parseVectorSvg,
	pinVectorGradient,
	rectSubpath,
	reverseVectorGradient,
	samplePlainStops,
	sampleVectorGradient,
	sampleVectorGradientAt,
	sampleVectorPaintDefAt,
	sanitizeVectorGradient,
	setVectorGradientVector,
	transformVectorNode,
	vectorDocumentToSvg,
	vectorGradientFocalParam,
	vectorGradientHandles,
	vectorGradientRamp,
	vectorGradientSvgDefs,
	vectorPaintToSvg,
	vectorPathLocalBounds,
	vectorGradientTAt,
	getVectorSceneRenderData,
	getVectorOverlayRenderData,
	createVectorCommands,
	lineSubpath,
	VectorEditorController,
	VECTOR_TOOL_SHORTCUTS,
	type Vec2,
	type VectorBounds,
	type VectorDocument,
	type VectorGradient,
	type VectorMatrix,
	type VectorPathNode,
	type VectorRgba
} from '../src/vector/index.js';
import { mixColorsOklab } from '../src/animation/color.js';
import { CommandRegistry } from '../src/commands/index.js';

const BW: VectorGradient = { type: 'linear', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] };
const RGB = [
	{ offset: 0, color: '#ff0000' },
	{ offset: 0.5, color: '#00ff00' },
	{ offset: 1, color: '#0000ff' }
];
const box: VectorBounds = { x: 10, y: 20, width: 200, height: 100 };

const diff = (a: readonly number[], b: readonly number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const apply = (m: VectorMatrix, p: Vec2): Vec2 => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
const invert = (m: VectorMatrix): VectorMatrix => {
	const [a, b, c, d, e, f] = m;
	const det = a * d - b * c;
	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
const rotation = (deg: number, tx = 0, ty = 0): VectorMatrix => {
	const r = (deg * Math.PI) / 180;
	return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), tx, ty];
};
/** Points on a grid over `b`. */
const grid = (b: VectorBounds, n = 12): Vec2[] => {
	const out: Vec2[] = [];
	for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) out.push({ x: b.x + (b.width * i) / n, y: b.y + (b.height * j) / n });
	return out;
};

describe('gradient sampling', () => {
	it('remaps a segment around its midpoint', () => {
		expect(gradientMidpointRemap(0.25, 0.25)).toBeCloseTo(0.5);
		expect(gradientMidpointRemap(0.1, 0.5)).toBe(0.1);
		expect(gradientMidpointRemap(0.625, 0.25)).toBeCloseTo(0.75);
		expect(gradientMidpointRemap(1, 0.9)).toBeCloseTo(1);
	});

	it('puts the half-way colour at the midpoint', () => {
		const g: VectorGradient = { ...BW, stops: [{ offset: 0, color: '#000000', midpoint: 0.25 }, { offset: 1, color: '#ffffff' }] };
		const ramp = vectorGradientRamp(g)!;
		expect(ramp.sample(0.25)[0]).toBeCloseTo(0.5, 6);
		expect(ramp.sample(0)[0]).toBe(0);
		expect(ramp.sample(1)[0]).toBe(1);
		// One extra stop at the midpoint makes it exact in SVG.
		const ex = expandVectorGradientStops(g);
		expect(ex).toHaveLength(3);
		expect(ex[1].offset).toBeCloseTo(0.25);
		for (let t = 0; t <= 1; t += 0.01) expect(diff(samplePlainStops(ex, t), ramp.sample(t))).toBeLessThan(1 / 255);
	});

	it('interpolates in sRGB, linear light or Oklab', () => {
		const stops = [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }];
		const srgb = vectorGradientRamp({ stops })!.sample(0.5);
		expect(diff(srgb, [0.5, 0, 0.5, 1])).toBeLessThan(1e-9);
		const lin = vectorGradientRamp({ stops, interpolation: 'linear' })!.sample(0.5);
		// Half of each in linear light is about 0.735 in sRGB.
		expect(lin[0]).toBeCloseTo(0.7354, 3);
		expect(lin[2]).toBeCloseTo(0.7354, 3);
		const ok = vectorGradientRamp({ stops, interpolation: 'oklab' })!.sample(0.5);
		const expected = parseVectorColor(mixColorsOklab('#ff0000', '#0000ff', 0.5)!)!;
		expect(diff(ok, expected)).toBeLessThan(1.5 / 255);
		expect(sampleVectorGradient({ type: 'linear', stops, interpolation: 'oklab' }, 0.5).color).toBe(mixColorsOklab('#ff0000', '#0000ff', 0.5));
	});

	it('bends the ramp with smoothness without leaving each segment', () => {
		const plain = vectorGradientRamp({ stops: RGB })!;
		const smooth = vectorGradientRamp({ stops: RGB, smoothness: 1 })!;
		expect(diff(plain.sample(0.25), smooth.sample(0.25))).toBeGreaterThan(0.01);
		for (let t = 0; t <= 0.5; t += 0.02) {
			const c = smooth.sample(t);
			// Red → green: blue stays 0 and red falls monotonically.
			expect(c[2]).toBe(0);
			expect(c[0]).toBeLessThanOrEqual(1);
		}
		expect(diff(smooth.sample(0.5), [0, 1, 0, 1])).toBeLessThan(1e-9);
	});

	it('mixes opacity linearly with the midpoint mapping', () => {
		const g: VectorGradient = { type: 'linear', stops: [{ offset: 0, color: '#000000', opacity: 0, midpoint: 0.2 }, { offset: 1, color: '#000000' }] };
		expect(vectorGradientRamp(g)!.sample(0.2)[3]).toBeCloseTo(0.5);
	});

	it('expands Oklab, linear-light and smooth ramps into stops within half a level', () => {
		for (const extra of [{ interpolation: 'oklab' as const }, { interpolation: 'linear' as const }, { smoothness: 0.7 }, { interpolation: 'oklab' as const, smoothness: 1 }]) {
			const g: VectorGradient = { type: 'linear', stops: [{ offset: 0, color: '#ff0000', midpoint: 0.3 }, { offset: 0.4, color: '#00ff00', opacity: 0.5 }, { offset: 1, color: '#2244ff' }], ...extra };
			const ex = expandVectorGradientStops(g);
			expect(ex.length).toBeGreaterThan(3);
			expect(ex.length).toBeLessThan(200);
			expect(ex.every((s) => s.midpoint === undefined)).toBe(true);
			const ramp = vectorGradientRamp(g)!;
			let worst = 0;
			for (let k = 0; k <= 2000; k++) worst = Math.max(worst, diff(samplePlainStops(ex, k / 2000), ramp.sample(k / 2000)));
			// Half a level of tolerance plus the hex rounding of the stops.
			expect(worst).toBeLessThan(1.5 / 255);
		}
	});

	it('keeps plain gradients as they are, hard stops included', () => {
		const g: VectorGradient = { type: 'linear', stops: [{ offset: 0, color: 'red' }, { offset: 0.5, color: '#00f' }, { offset: 0.5, color: '#0f0' }, { offset: 1, color: '#000' }] };
		expect(expandVectorGradientStops(g)).toEqual(g.stops);
		const ok = expandVectorGradientStops({ ...g, stops: g.stops.slice(1), interpolation: 'oklab' });
		// The hard stop survives expansion.
		expect(ok.filter((s) => s.offset === 0.5).map((s) => s.color)).toEqual(['#0000ff', '#00ff00']);
	});

	it('reverses stops and mirrors their midpoints', () => {
		const g: VectorGradient = { type: 'linear', stops: [{ offset: 0, color: '#000000', midpoint: 0.3 }, { offset: 0.6, color: '#ff0000' }, { offset: 1, color: '#ffffff' }] };
		const r = reverseVectorGradient(g);
		expect(r.stops.map((s) => [s.offset, s.color])).toEqual([[0, '#ffffff'], [0.4, '#ff0000'], [1, '#000000']]);
		expect(r.stops[1].midpoint).toBeCloseTo(0.7);
		for (let t = 0; t <= 1; t += 0.05) expect(diff(vectorGradientRamp(r)!.sample(1 - t), vectorGradientRamp(g)!.sample(t))).toBeLessThan(1e-9);
		expect(reverseVectorGradient(r).stops[0].midpoint).toBeCloseTo(0.3);
	});
});

describe('gradient geometry', () => {
	it('measures t along the focal ray', () => {
		const f = { x: 0.4, y: -0.2 };
		// On the circle t = 1, at the focal point 0.
		for (let a = 0; a < 6.28; a += 0.3) expect(vectorGradientFocalParam({ x: Math.cos(a), y: Math.sin(a) }, f)).toBeCloseTo(1, 9);
		expect(vectorGradientFocalParam(f, f)).toBeCloseTo(0, 9);
		// The ray from the focal point: t is the distance over the distance to the circle.
		const p = { x: -0.3, y: 0.25 };
		const d = Math.hypot(p.x - f.x, p.y - f.y);
		const u = { x: (p.x - f.x) / d, y: (p.y - f.y) / d };
		const b = u.x * f.x + u.y * f.y;
		const lambda = -b + Math.sqrt(b * b - (f.x * f.x + f.y * f.y - 1));
		expect(vectorGradientFocalParam(p, f)).toBeCloseTo(d / lambda, 9);
		// No focal point: the radius; a focal radius: 0 on the focal circle.
		expect(vectorGradientFocalParam({ x: 0.3, y: 0.4 })).toBeCloseTo(0.5, 9);
		expect(vectorGradientFocalParam({ x: 0.2, y: 0 }, { x: 0, y: 0 }, 0.2)).toBeCloseTo(0, 9);
		expect(vectorGradientFocalParam({ x: 0.6, y: 0 }, { x: 0, y: 0 }, 0.2)).toBeCloseTo(0.5, 9);
	});

	it('folds t by the spread', () => {
		expect(applyVectorGradientSpread(1.25, 'pad')).toBe(1);
		expect(applyVectorGradientSpread(1.25, 'repeat')).toBeCloseTo(0.25);
		expect(applyVectorGradientSpread(-0.25, 'repeat')).toBeCloseTo(0.75);
		expect(applyVectorGradientSpread(1.25, 'reflect')).toBeCloseTo(0.75);
		expect(applyVectorGradientSpread(-0.25, 'reflect')).toBeCloseTo(0.25);
	});

	it('reads the styles: linear, reflected, radial, conic and diamond', () => {
		const unit = { x: 0, y: 0, width: 1, height: 1 };
		const at = (g: Partial<VectorGradient>, p: Vec2) => vectorGradientTAt({ type: 'linear', stops: BW.stops, ...g } as VectorGradient, unit, p);
		const frame = { start: { x: 0.5, y: 0.5 }, end: { x: 1, y: 0.5 }, units: 'userSpaceOnUse' as const };
		expect(at({ angle: 90 }, { x: 0.25, y: 0.9 })).toBeCloseTo(0.25);
		expect(at({ type: 'reflected', ...frame }, { x: 0.25, y: 0.3 })).toBeCloseTo(0.5);
		expect(at({ type: 'radial', ...frame }, { x: 0.5, y: 0.8 })).toBeCloseTo(0.6);
		// Conic: clockwise on screen from the end's direction.
		expect(at({ type: 'conic', ...frame }, { x: 0.5, y: 0.9 })).toBeCloseTo(0.25);
		expect(at({ type: 'conic', ...frame }, { x: 0.1, y: 0.5 })).toBeCloseTo(0.5);
		// Diamond: the sum of the distances along both axes (figcraft).
		expect(at({ type: 'diamond', ...frame }, { x: 0.75, y: 0.6 })).toBeCloseTo(0.7);
		expect(at({ type: 'diamond', ...frame }, { x: 0.25, y: 0.25 })).toBeCloseTo(1);
	});

	it('pins box gradients to the node space without changing what they paint', () => {
		const types: VectorGradient[] = [
			{ type: 'linear', angle: 30, stops: RGB },
			{ type: 'radial', cx: 0.4, cy: 0.6, r: 0.4, stops: RGB },
			{ type: 'radial', start: { x: 0.5, y: 0.5 }, end: { x: 0.9, y: 0.6 }, width: { x: 0.45, y: 0.7 }, focal: { x: 0.6, y: 0.5 }, stops: RGB },
			{ type: 'conic', angle: 40, stops: RGB },
			{ type: 'reflected', angle: 120, stops: RGB, spread: 'repeat' },
			{ type: 'diamond', r: 0.3, stops: RGB, spread: 'reflect' }
		];
		for (const g of types) {
			const pinned = pinVectorGradient(g, box);
			expect(pinned.units).toBe('userSpaceOnUse');
			for (const p of grid(box, 8)) expect(diff(sampleVectorGradientAt(pinned, null, p), sampleVectorGradientAt(g, box, p))).toBeLessThan(1e-9);
		}
	});

	it('paints a box gradient on a line with no height', () => {
		const line: VectorBounds = { x: 0, y: 50, width: 100, height: 0 };
		expect(vectorGradientTAt({ ...BW, angle: 90 }, line, { x: 25, y: 50 })).toBeCloseTo(0.25);
	});

	it('maps handles to the node and back under a rotated node', () => {
		const world = rotation(30, 300, 40);
		const toLocal = invert(world);
		for (const g of [{ type: 'linear', angle: 135, stops: BW.stops } as VectorGradient, { type: 'radial', cx: 0.3, cy: 0.6, r: 0.3, stops: BW.stops } as VectorGradient]) {
			const h = vectorGradientHandles(g, box, world);
			// The handles are the model's points carried through the box and the node's rotation.
			const pinned = pinVectorGradient(g, box);
			expect(diff([h.start.x, h.start.y], [apply(world, pinned.start!).x, apply(world, pinned.start!).y])).toBeLessThan(1e-9);
			// Drag the end to a world point: the end handle lands there.
			const target = { x: 420, y: 160 };
			const moved = moveVectorGradientHandle(g, box, g.type === 'linear' ? 'end' : 'radius', apply(toLocal, target));
			const after = vectorGradientHandles(moved, box, world);
			expect(diff([after.end.x, after.end.y], [target.x, target.y])).toBeLessThan(1e-9);
			expect(diff([after.start.x, after.start.y], [h.start.x, h.start.y])).toBeLessThan(1e-9);
			// The colour at the end handle is the last stop.
			expect(sampleVectorGradientAt(moved, box, apply(toLocal, target))[0]).toBeCloseTo(1);
			// Move the start: everything moves with it.
			const shifted = moveVectorGradientHandle(moved, box, 'start', apply(toLocal, { x: h.start.x + 10, y: h.start.y }), apply(toLocal, h.start));
			const s = vectorGradientHandles(shifted, box, world);
			expect(s.end.x - after.end.x).toBeCloseTo(10);
			expect(s.end.y - after.end.y).toBeCloseTo(0);
		}
	});

	it('keeps the aspect and focal point relative to the axis, and clamps the focal point', () => {
		let g: VectorGradient = { type: 'radial', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, units: 'userSpaceOnUse', stops: BW.stops };
		g = moveVectorGradientHandle(g, null, 'aspect', { x: 3, y: 5 });
		expect(g.width!.x).toBeCloseTo(0);
		expect(g.width!.y).toBeCloseTo(5);
		g = moveVectorGradientHandle(g, null, 'focal', { x: 4, y: 0 });
		expect(g.focal).toEqual({ x: 4, y: 0 });
		// Rotate the radius a quarter turn: the aspect handle and focal point turn with it.
		g = moveVectorGradientHandle(g, null, 'radius', { x: 0, y: 20 });
		expect(g.width!.x).toBeCloseTo(-10);
		expect(g.width!.y).toBeCloseTo(0);
		expect(g.focal!.x).toBeCloseTo(0);
		expect(g.focal!.y).toBeCloseTo(8);
		// Beyond the circle the focal point stays just inside.
		g = moveVectorGradientHandle(g, null, 'focal', { x: 0, y: 100 });
		expect(g.focal!.y).toBeCloseTo(19.8);
		expect(moveVectorGradientHandle(g, null, 'focal', { x: 0, y: 0 }).focal).toBeUndefined();
	});

	it('follows scale and skew of the node for gradients in its own space', () => {
		const g: VectorGradient = { type: 'conic', start: { x: 50, y: 50 }, end: { x: 90, y: 60 }, units: 'userSpaceOnUse', stops: RGB };
		const node: VectorPathNode = { id: 'a', type: 'path', subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })], fill: g };
		const m: VectorMatrix = [2, 0.3, 0.5, 1.5, 10, -5];
		const moved = transformVectorNode(node, m);
		const fill = moved.fill as VectorGradient;
		const local = moved.transform ? invert(moved.transform) : ([1, 0, 0, 1, 0, 0] as VectorMatrix);
		for (const p of grid({ x: 5, y: 5, width: 90, height: 90 }, 7)) {
			const q = apply(local, apply(m, p));
			expect(diff(sampleVectorGradientAt(fill, null, q), sampleVectorGradientAt(g, null, p))).toBeLessThan(1e-6);
		}
		// Box gradients follow the box.
		const boxed = transformVectorNode({ ...node, fill: { type: 'linear', angle: 90, stops: BW.stops } }, m);
		expect(boxed.fill).toEqual({ type: 'linear', angle: 90, stops: BW.stops });
	});

	it('sets the vector, keeping the aspect', () => {
		const g = setVectorGradientVector({ type: 'radial', r: 0.25, stops: BW.stops }, box, { x: 0, y: 0 }, { x: 0, y: 10 });
		expect(g.start).toEqual({ x: 0, y: 0 });
		// The box's radius 50 × 25 keeps its aspect of 0.5.
		expect(g.width!.x).toBeCloseTo(-5);
		expect(g.units).toBe('userSpaceOnUse');
	});
});

describe('gradient paint servers', () => {
	const paintAt = (g: VectorGradient, p: Vec2, bounds: VectorBounds = box) => sampleVectorPaintDefAt(vectorGradientSvgDefs(g, 'p', { bounds }), 'p', p);

	it('exports linear and radial gradients that paint what the model says', () => {
		const cases: VectorGradient[] = [
			{ type: 'linear', angle: 60, stops: RGB },
			{ type: 'linear', start: { x: 0.13, y: 0.21 }, end: { x: 0.8, y: 0.9 }, stops: RGB, spread: 'repeat' },
			{ type: 'radial', cx: 0.4, cy: 0.5, r: 0.3, stops: RGB, spread: 'reflect' },
			{ type: 'radial', start: { x: 100, y: 70 }, end: { x: 180, y: 90 }, width: { x: 90, y: 110 }, focal: { x: 130, y: 80 }, focalRadius: 0.1, units: 'userSpaceOnUse', stops: RGB },
			{ type: 'reflected', angle: 100, stops: RGB },
			{ type: 'reflected', start: { x: 0.51, y: 0.5 }, end: { x: 0.58, y: 0.53 }, stops: RGB, spread: 'repeat' },
			{ type: 'reflected', start: { x: 0.51, y: 0.5 }, end: { x: 0.58, y: 0.53 }, stops: RGB, spread: 'reflect' }
		];
		for (const g of cases)
			for (const p of grid(box)) {
				const t = vectorGradientTAt(g, box, p);
				if (g.spread === 'repeat' && (t < 1e-4 || t > 1 - 1e-4)) continue; // on a period's edge either end is right
				expect(diff(paintAt(g, p)!, sampleVectorGradientAt(g, box, p))).toBeLessThan(2 / 255);
			}
		const radial = vectorGradientSvgDefs(cases[3], 'r', { bounds: box })[0];
		expect(radial).toMatchObject({ type: 'radial', attrs: { gradientUnits: 'userSpaceOnUse', cx: 0, cy: 0, r: 1, fr: '0.1' } });
		expect(radial.attrs.fx).toBeDefined();
		expect(vectorGradientSvgDefs(cases[2], 'r', { bounds: box })[0].attrs.spreadMethod).toBe('reflect');
	});

	it('tessellates a diamond into four exact quadrants', () => {
		for (const spread of ['pad', 'repeat', 'reflect'] as const) {
			const g: VectorGradient = { type: 'diamond', cx: 0.5, cy: 0.5, r: 0.3, angle: 70, stops: RGB, spread };
			const def = vectorGradientSvgDefs(g, 'd', { bounds: box })[0];
			expect(def.type).toBe('pattern');
			if (def.type !== 'pattern') return;
			expect(def.tiles).toHaveLength(4);
			const m = invert(pinVectorGradientMatrix(g));
			for (const p of grid(box, 20)) {
				const q = apply(m, p);
				if (Math.abs(q.x) < 0.02 || Math.abs(q.y) < 0.02) continue; // the quadrants overlap there
				expect(diff(paintAt(g, p)!, sampleVectorGradientAt(g, box, p))).toBeLessThan(2 / 255);
			}
		}
	});

	it('tessellates a conic gradient into wedges painting the sweep', () => {
		const g: VectorGradient = { type: 'conic', start: { x: 110, y: 70 }, end: { x: 150, y: 70 }, width: { x: 110, y: 100 }, units: 'userSpaceOnUse', stops: RGB };
		const def = vectorGradientSvgDefs(g, 'c', { bounds: box })[0];
		expect(def.type === 'pattern' && def.tiles.length).toBe(72);
		let worst = 0;
		let onCircle = 0;
		for (let k = 0; k < 360; k += 1.7) {
			if (k < 3 || k > 357) continue; // the seam where t wraps
			const a = (k * Math.PI) / 180;
			for (const r of [5, 20, 40, 80]) {
				// The frame is an ellipse 40 × 30.
				const p = { x: 110 + Math.cos(a) * (40 * r) / 40, y: 70 + Math.sin(a) * (30 * r) / 40 };
				const e = diff(paintAt(g, p)!, sampleVectorGradientAt(g, box, p));
				worst = Math.max(worst, e);
				if (r === 40) onCircle = Math.max(onCircle, e);
			}
		}
		// Off the frame's unit circle a point takes a colour from within its 5° wedge.
		expect(worst).toBeLessThan(0.035);
		expect(onCircle).toBeLessThan(2 / 255);
		// Sharp stops inside a wedge stay sharp.
		const hard: VectorGradient = { ...g, stops: [{ offset: 0, color: '#000000' }, { offset: 0.3, color: '#000000' }, { offset: 0.3, color: '#ffffff' }, { offset: 1, color: '#ffffff' }] };
		const before = paintAt(hard, { x: 110 + 40 * Math.cos(0.3 * 2 * Math.PI - 0.02), y: 70 + 30 * Math.sin(0.3 * 2 * Math.PI - 0.02) })!;
		const after = paintAt(hard, { x: 110 + 40 * Math.cos(0.3 * 2 * Math.PI + 0.02), y: 70 + 30 * Math.sin(0.3 * 2 * Math.PI + 0.02) })!;
		expect(before[0]).toBeLessThan(0.05);
		expect(after[0]).toBeGreaterThan(0.95);
	});

	it('repeats stop periods to emulate spread modes', () => {
		const g: VectorGradient = { type: 'linear', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, units: 'userSpaceOnUse', stops: [{ offset: 0, color: '#000000', midpoint: 0.3 }, { offset: 1, color: '#ffffff' }], spread: 'repeat' };
		const area = { x: -5, y: 0, width: 30, height: 10 };
		const ex = expandVectorGradientSpread(g, null, area)!;
		// From −10 to 30: four periods.
		expect([ex.start.x, ex.end.x]).toEqual([-10, 30]);
		for (const spread of ['repeat', 'reflect'] as const) {
			const e = expandVectorGradientSpread({ ...g, spread }, null, area)!;
			for (let x = -5; x <= 25; x += 0.37) {
				const t = (x - e.start.x) / (e.end.x - e.start.x);
				expect(diff(samplePlainStops(e.stops, t), sampleVectorGradientAt({ ...g, spread }, null, { x, y: 3 }))).toBeLessThan(2 / 255);
			}
		}
		expect(expandVectorGradientSpread({ ...g, spread: 'pad' }, null, area)).toBeNull();
	});

	it('lays gradients along and across a stroke', () => {
		const line: VectorPathNode = { id: 'l', type: 'path', subpaths: [lineSubpath({ x: 0, y: 50 }, { x: 100, y: 50 })], stroke: { type: 'linear', stops: BW.stops, strokeMode: 'along' }, strokeWidth: 10 };
		const along = vectorPaintToSvg(line.stroke, 's', { node: line, role: 'stroke' });
		expect(along.defs[0].type).toBe('pattern');
		for (const x of [5, 25, 50, 90]) for (const y of [46, 50, 54]) expect(sampleVectorPaintDefAt(along.defs, 's', { x, y })![0]).toBeCloseTo(x / 100, 2);
		const across = vectorPaintToSvg({ ...(line.stroke as VectorGradient), strokeMode: 'across' }, 's', { node: { ...line, stroke: { ...(line.stroke as VectorGradient), strokeMode: 'across' } }, role: 'stroke' });
		// Left of a path running right is up: t = 0 at y = 45, 1 at y = 55.
		for (const x of [10, 60]) {
			expect(sampleVectorPaintDefAt(across.defs, 's', { x, y: 46 })![0]).toBeCloseTo(0.1, 2);
			expect(sampleVectorPaintDefAt(across.defs, 's', { x, y: 52.5 })![0]).toBeCloseTo(0.75, 2);
		}
		// Around a closed square the along gradient runs once round, a sharp corner painted in its colour.
		const square: VectorPathNode = { id: 'q', type: 'path', subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })], stroke: { type: 'linear', stops: BW.stops, strokeMode: 'along' }, strokeWidth: 4 };
		const round = vectorPaintToSvg(square.stroke, 'q', { node: square, role: 'stroke' });
		expect(sampleVectorPaintDefAt(round.defs, 'q', { x: 50, y: 0 })![0]).toBeCloseTo(0.125, 2);
		expect(sampleVectorPaintDefAt(round.defs, 'q', { x: 100, y: 50 })![0]).toBeCloseTo(0.375, 2);
		expect(sampleVectorPaintDefAt(round.defs, 'q', { x: 101.5, y: -1.5 })![0]).toBeCloseTo(0.25, 2);
	});
});

/** The unit frame → node matrix of a box gradient on `box` (via the pinned points). */
function pinVectorGradientMatrix(g: VectorGradient): VectorMatrix {
	const p = pinVectorGradient(g, box);
	return [p.end!.x - p.start!.x, p.end!.y - p.start!.y, p.width!.x - p.start!.x, p.width!.y - p.start!.y, p.start!.x, p.start!.y];
}

describe('gradient SVG import / export', () => {
	const docOf = (...nodes: VectorPathNode[]): VectorDocument => ({ width: 300, height: 200, nodes });
	const rect = (id: string, extra: Partial<VectorPathNode>): VectorPathNode => ({ id, type: 'path', subpaths: [rectSubpath({ x: 20, y: 30, width: 120, height: 60 })], ...extra });

	it('round-trips every gradient field through export and import', () => {
		const paints: VectorGradient[] = [
			{ type: 'linear', angle: 45, stops: [{ offset: 0, color: '#ff0000', midpoint: 0.3 }, { offset: 1, color: '#0000ff', opacity: 0.5 }], interpolation: 'oklab', smoothness: 0.4 },
			{ type: 'radial', start: { x: 60, y: 50 }, end: { x: 100, y: 60 }, width: { x: 55, y: 70 }, focal: { x: 70, y: 55 }, focalRadius: 0.2, units: 'userSpaceOnUse', spread: 'reflect', stops: RGB },
			{ type: 'conic', angle: 30, stops: RGB, interpolation: 'linear' },
			{ type: 'reflected', start: { x: 0.5, y: 0.5 }, end: { x: 0.8, y: 0.6 }, units: 'objectBoundingBox', spread: 'repeat', stops: RGB },
			{ type: 'diamond', cx: 0.3, cy: 0.4, r: 0.2, stops: RGB }
		];
		const nodes = paints.map((fill, i) => rect(`n${i}`, { fill, stroke: { ...fill, strokeMode: i % 2 ? 'across' : 'along' }, strokeWidth: 6 }));
		const svg = vectorDocumentToSvg(docOf(...nodes));
		expect(svg).not.toMatch(/NaN|undefined|Infinity/);
		expect(svg).toContain('<pattern id="vg-fill-n2"');
		expect(svg).toContain('<radialGradient id="vg-fill-n1"');
		const back = parseVectorSvg(svg);
		back.nodes.forEach((n, i) => {
			expect((n as VectorPathNode).fill).toEqual(paints[i]);
			expect((n as VectorPathNode).stroke).toEqual({ ...paints[i], strokeMode: i % 2 ? 'across' : 'along' });
		});
	});

	it('reads fx, fy, fr, spreadMethod and gradientTransform', () => {
		const parsed = parseVectorSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
			<defs>
				<radialGradient id="r" cx="0.5" cy="0.5" r="0.5" fx="0.7" fy="0.5" fr="0.1" spreadMethod="repeat" gradientTransform="rotate(90 0.5 0.5)"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient>
				<linearGradient id="base" spreadMethod="reflect"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
				<linearGradient id="child" href="#base" x1="0" x2="0.5"/>
			</defs>
			<rect id="a" x="0" y="0" width="100" height="100" fill="url(#r)"/>
			<rect id="b" x="0" y="0" width="100" height="50" fill="url(#child)"/>
		</svg>`);
		const r = (parsed.nodes[0] as VectorPathNode).fill as VectorGradient;
		expect(r).toMatchObject({ type: 'radial', spread: 'repeat', units: 'objectBoundingBox', focalRadius: 0.2 });
		// Rotated a quarter turn about the centre: the focal point moves below it.
		expect(r.focal!.x).toBeCloseTo(0.5);
		expect(r.focal!.y).toBeCloseTo(0.7);
		const b = (parsed.nodes[1] as VectorPathNode).fill as VectorGradient;
		expect(b).toMatchObject({ type: 'linear', spread: 'reflect', start: { x: 0, y: 0 }, end: { x: 0.5, y: 0 } });
		expect(b.stops.map((s) => s.color)).toEqual(['#f00', '#00f']);
	});

	it('reads userSpaceOnUse gradients through element transforms', () => {
		const parsed = parseVectorSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
			<defs><linearGradient id="u" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>
			<g transform="translate(50 10) scale(2 1)"><rect x="0" y="0" width="100" height="50" fill="url(#u)"/></g>
		</svg>`);
		const node = parsed.nodes[0].type === 'group' ? (parsed.nodes[0].children[0] as VectorPathNode) : (parsed.nodes[0] as VectorPathNode);
		const g = node.fill as VectorGradient;
		expect(g.units).toBe('userSpaceOnUse');
		// Document x = 50 + 2·u: t = 0.5 at x = 150.
		expect(vectorGradientTAt(g, null, { x: 150, y: 30 })).toBeCloseTo(0.5);
		expect(vectorGradientTAt(g, null, { x: 250, y: 30 })).toBeCloseTo(1);
	});

	it('keeps the angle shorthand for plain box gradients', () => {
		const parsed = parseVectorSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>`);
		// (0,0) → (1,1) is not CSS 135°: it stays explicit.
		expect((parsed.nodes[0] as VectorPathNode).fill).toMatchObject({ type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } });
	});

	it('renders pattern defs in the scene for conic fills', () => {
		const scene = getVectorSceneRenderData({ document: docOf(rect('a', { fill: { type: 'conic', stops: RGB } })), viewport: { x: 0, y: 0, zoom: 1 } });
		expect(scene.defs[0]).toMatchObject({ id: 've-fill-a', type: 'pattern' });
		// Without a matching viewBox the pattern's content would start at the tile's corner.
		const attrs = scene.defs[0].attrs;
		expect(attrs.viewBox).toBe(`${attrs.x} ${attrs.y} ${attrs.width} ${attrs.height}`);
		expect(scene.nodes[0]).toMatchObject({ fill: 'url(#ve-fill-a)' });
		expect(vectorPathLocalBounds(rect('a', {}))).toEqual({ x: 20, y: 30, width: 120, height: 60 });
	});

	it('sanitizes gradients from untrusted input', () => {
		expect(sanitizeVectorGradient({ type: 'spiral', stops: [] })).toBeNull();
		expect(sanitizeVectorGradient({ type: 'linear', stops: [{ offset: 2, color: '#000', midpoint: 3 }], spread: 'bogus', smoothness: 4 })).toEqual({ type: 'linear', stops: [{ offset: 1, color: '#000', midpoint: 0.95 }], smoothness: 1 });
	});
});

describe('gradient blends', () => {
	it('mixes explicit geometry, midpoints and focal points', () => {
		const a: VectorGradient = { type: 'radial', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, units: 'userSpaceOnUse', stops: [{ offset: 0, color: '#000000', midpoint: 0.2 }, { offset: 1, color: '#ffffff' }] };
		const b: VectorGradient = { ...a, end: { x: 30, y: 0 }, focal: { x: 5, y: 0 }, stops: [{ offset: 0, color: '#000000', midpoint: 0.6 }, { offset: 1, color: '#ffffff' }] };
		const m = interpolateVectorPaint(a, b, 0.5) as VectorGradient;
		expect(m.end).toEqual({ x: 20, y: 0 });
		expect(m.focal).toEqual({ x: 2.5, y: 0 });
		expect(m.stops[0].midpoint).toBeCloseTo(0.4);
		// Different colour models resample through what each paints.
		const c = interpolateVectorPaint(a, { ...a, interpolation: 'oklab' }, 0.5) as VectorGradient;
		expect(c.stops.length).toBeGreaterThan(2);
		expect(c.stops.every((s) => s.midpoint === undefined)).toBe(true);
		const rgba: VectorRgba = samplePlainStops(c.stops, 0.2);
		expect(rgba[0]).toBeGreaterThan(0.3);
	});
});

describe('gradient tool', () => {
	const make = (nodes: VectorPathNode[]) => {
		let n = 0;
		return new VectorEditorController({ document: { width: 400, height: 300, nodes }, createId: () => `id${++n}` });
	};
	const square = (extra: Partial<VectorPathNode> = {}): VectorPathNode => ({ id: 'a', type: 'path', subpaths: [rectSubpath({ x: 0, y: 0, width: 100, height: 100 })], fill: '#ff0000', ...extra });
	const drag = (c: VectorEditorController, from: Vec2, to: Vec2, mods = {}) => {
		c.pointerDown(from, mods);
		c.pointerMove({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, mods);
		c.pointerMove(to, mods);
		c.pointerUp(to, mods);
	};
	const fill = (c: VectorEditorController) => (c.getNode('a') as VectorPathNode).fill as VectorGradient;

	it('has a shortcut of its own', () => {
		expect(VECTOR_TOOL_SHORTCUTS.gradient).toBe('G');
		const keys = Object.values(VECTOR_TOOL_SHORTCUTS);
		expect(new Set(keys).size).toBe(keys.length);
		const c = make([square()]);
		expect(c.keyDown({ key: 'g' })).toBe(true);
		expect(c.getState().tool).toBe('gradient');
		// Cmd+G still groups.
		c.select(['a']);
		c.keyDown({ key: 'g', mod: true });
		expect(c.getState().document.nodes[0].type).toBe('group');
	});

	it('drags out a gradient vector in one undo step', () => {
		const c = make([square()]);
		c.setTool('gradient');
		drag(c, { x: 10, y: 50 }, { x: 90, y: 50 });
		expect(c.getState().selection).toEqual(['a']);
		const g = fill(c);
		expect(g).toMatchObject({ type: 'linear', units: 'userSpaceOnUse', start: { x: 10, y: 50 }, end: { x: 90, y: 50 } });
		expect(g.stops.map((s) => s.color)).toEqual(['#ff0000', '#ffffff']);
		expect(c.getState().undoLabel).toBe('Gradient');
		c.undo();
		expect((c.getNode('a') as VectorPathNode).fill).toBe('#ff0000');
		// Shift keeps 45° steps.
		c.redo();
		drag(c, { x: 10, y: 10 }, { x: 80, y: 70 }, { shift: true });
		expect(fill(c).end!.x - fill(c).start!.x).toBeCloseTo(fill(c).end!.y - fill(c).start!.y);
	});

	it('moves the end handle of a rotated shape onto the pointer', () => {
		const c = make([square({ transform: rotation(30, 150, 20), fill: { type: 'radial', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] } })]);
		c.setViewport({ x: 20, y: 10, zoom: 2 });
		c.select(['a']);
		c.setTool('gradient');
		const a = c.getGradientAnnotator()!;
		expect(a).not.toBeNull();
		const target = { x: a.end.x + 30, y: a.end.y + 40 };
		const before = c.history.getState().undoName;
		drag(c, a.end, target);
		const after = c.getGradientAnnotator()!;
		expect(after.end.x).toBeCloseTo(target.x, 6);
		expect(after.end.y).toBeCloseTo(target.y, 6);
		expect(after.start.x).toBeCloseTo(a.start.x, 6);
		expect(c.getState().undoLabel).toBe('Gradient Handle');
		c.undo();
		expect(c.getState().undoLabel).toBe(before);
		expect(fill(c).start).toBeUndefined();
		// The overlay draws it, with the radius, aspect and focal handles.
		c.redo();
		const overlay = getVectorOverlayRenderData(c.getState()).gradient!;
		expect(overlay.end).toMatchObject({ handle: 'radius' });
		expect(overlay.aspect).not.toBeNull();
		expect(overlay.focal).not.toBeNull();
		expect(overlay.extent).toMatch(/^M/);
	});

	it('adds, moves and removes stops on the bar, and drags midpoints', () => {
		const c = make([square({ fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] } })]);
		c.select(['a']);
		c.setTool('gradient');
		let a = c.getGradientAnnotator()!;
		const onBar = (t: number) => ({ x: a.start.x + (a.end.x - a.start.x) * t + a.normal.x * 6, y: a.start.y + (a.end.y - a.start.y) * t + a.normal.y * 6 });
		// Click the bar: a stop painting the colour there, selected.
		const p = onBar(0.5);
		c.pointerDown(p);
		c.pointerUp(p);
		expect(fill(c).stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
		expect(fill(c).stops[1].color).toBe('#808080');
		expect(c.getState().gradientEdit.stop).toBe(1);
		expect(c.getState().undoLabel).toBe('Add Gradient Stop');
		// Drag it along the bar.
		a = c.getGradientAnnotator()!;
		drag(c, a.stops[1], { x: a.stops[1].x - 25, y: a.stops[1].y });
		expect(fill(c).stops[1].offset).toBeCloseTo(0.25);
		expect(c.getState().undoLabel).toBe('Move Gradient Stop');
		// Drag a midpoint.
		a = c.getGradientAnnotator()!;
		const m = a.midpoints[0];
		drag(c, m, { x: m.x - 6.25, y: m.y });
		expect(fill(c).stops[0].midpoint).toBeCloseTo(0.25);
		// Drag the stop off the bar: deleted, in one step.
		a = c.getGradientAnnotator()!;
		const s = a.stops[1];
		c.pointerDown(s);
		c.pointerMove({ x: s.x, y: s.y + 60 });
		expect(getVectorOverlayRenderData(c.getState()).status).toBe('Release to delete the stop');
		c.pointerUp({ x: s.x, y: s.y + 60 });
		expect(fill(c).stops).toHaveLength(2);
		expect(c.getState().undoLabel).toBe('Delete Gradient Stop');
		c.undo();
		expect(fill(c).stops).toHaveLength(3);
		// Two stops stay: dragging one off does nothing; Delete removes the selected one when there are more.
		c.selectGradientStop(1);
		expect(c.keyDown({ key: 'Delete' })).toBe(true);
		expect(fill(c).stops).toHaveLength(2);
		expect(c.removeGradientStop(0).ok).toBe(false);
	});

	it('edits stops, type and colour space from the editor API and commands', () => {
		const c = make([square()]);
		c.select(['a']);
		expect(c.setGradient({ type: 'conic' }).ok).toBe(true);
		expect(fill(c)).toMatchObject({ type: 'conic', stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#ffffff' }] });
		c.setGradientStop(0, { color: '#00ff00', midpoint: 0.3, opacity: 0.5 });
		expect(fill(c).stops[0]).toEqual({ offset: 0, color: '#00ff00', midpoint: 0.3, opacity: 0.5 });
		c.setGradientStop(0, { offset: 0.8 });
		expect(fill(c).stops.map((s) => s.offset)).toEqual([0.8, 1]);
		c.reverseGradient();
		expect(fill(c).stops[1].color).toBe('#00ff00');
		c.setGradientTarget('stroke');
		c.setGradient({ type: 'linear', strokeMode: 'along' });
		expect((c.getNode('a') as VectorPathNode).stroke).toMatchObject({ type: 'linear', strokeMode: 'along' });

		const registry = new CommandRegistry({ history: c.history });
		registry.register(createVectorCommands(c));
		const r = registry.execute('vector.setGradient', { ids: ['a'], type: 'diamond', interpolation: 'oklab', spread: 'repeat', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff', midpoint: 0.7 }], aspect: 0.5 });
		expect(r.ok).toBe(true);
		expect(fill(c)).toMatchObject({ type: 'diamond', interpolation: 'oklab', spread: 'repeat', units: 'objectBoundingBox' });
		expect(registry.execute('vector.setGradient', { ids: ['a'], type: 'spiral' }).ok).toBe(false);
		expect(registry.execute('vector.setStyle', { ids: ['a'], fill: { type: 'linear', stops: [] } }).ok).toBe(false);
		expect(registry.execute('vector.setStyle', { ids: ['a'], fill: { type: 'reflected', angle: 30, stops: [{ offset: 0, color: '#000' }], junk: 1 } }).ok).toBe(true);
		expect(fill(c)).toEqual({ type: 'reflected', angle: 30, stops: [{ offset: 0, color: '#000' }] });
	});
});
