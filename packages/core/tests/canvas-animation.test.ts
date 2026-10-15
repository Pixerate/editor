import { describe, it, expect } from 'vitest';
import {
	ManualClock,
	AnimationPlayer,
	AnimationEditError,
	ANIMATION_DATA_KEY,
	addKeyframesAtTime,
	animateNode,
	applyAnimation,
	applyAnimationOverrides,
	copyKeyframes,
	createCanvasAnimationController,
	cubicBezierAt,
	deleteKeyframes,
	easingFromInfluence,
	easingToCss,
	evaluateAnimation,
	evaluateEasing,
	evaluateTrack,
	exportCssAnimation,
	getAnimationDuration,
	getKeyframeTimes,
	getTimelineRows,
	getTimelineTicks,
	interpolateAnimationValue,
	mixColorsOklab,
	moveKeyframes,
	normalizeKeyframes,
	oklabToRgb,
	parseCssEasing,
	parseKeyframeClipboard,
	pasteKeyframes,
	recordAnimationChanges,
	resolveCanvasTokens,
	rgbToOklab,
	sampleAnimationFrames,
	scaleKeyframes,
	setKeyframe,
	setKeyframeEasing,
	setMotionPath,
	setTrackEnabled,
	snapKeyframeDelta,
	springAt,
	toWebAnimations,
	updateKeyframe,
	withNodeAnimation,
	wrapAnimationTime,
	bindCanvasToken,
	type AnimationKeyframe,
	type CanvasNode,
	type KeyframeRef
} from '../src/canvas';
import { HistoryManager } from '../src/history';
import { CommandRegistry, createCanvasAnimationCommands, createCommandToolProvider } from '../src/commands';
import { ToolRegistry } from '../src/agent';
import { TokenStore } from '../src/tokens';
import { measureGrowth } from './helpers/growth';

const node = (id: string, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, position: { x: 0, y: 0 }, data: {}, ...extra });

function animated(id: string, tracks: Record<string, AnimationKeyframe[]>, extra: Partial<CanvasNode> = {}): CanvasNode {
	return withNodeAnimation(node(id, extra), { tracks: Object.fromEntries(Object.entries(tracks).map(([k, keyframes]) => [k, { keyframes }])) });
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === 'object') {
		Object.freeze(value);
		for (const v of Object.values(value)) deepFreeze(v);
	}
	return value;
}

/** Independent cubic-bezier reference: bisection on the curve parameter to 1e-12. */
function referenceBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
	const bx = (s: number) => 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s * s * x2 + s ** 3;
	const by = (s: number) => 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s * s * y2 + s ** 3;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 100; i++) {
		const mid = (lo + hi) / 2;
		if (bx(mid) < x) lo = mid;
		else hi = mid;
	}
	return by((lo + hi) / 2);
}

const keysOf = (n: CanvasNode, property: string) => n.data[ANIMATION_DATA_KEY].tracks[property].keyframes as AnimationKeyframe[];

describe('easing', () => {
	it('matches CSS cubic-bezier reference values for the presets', () => {
		const presets: [string, number, number, number, number][] = [
			['ease', 0.25, 0.1, 0.25, 1],
			['ease-in', 0.42, 0, 1, 1],
			['ease-out', 0, 0, 0.58, 1],
			['ease-in-out', 0.42, 0, 0.58, 1],
			['ease-out-back', 0.34, 1.56, 0.64, 1]
		];
		for (const [name, x1, y1, x2, y2] of presets) {
			for (let i = 0; i <= 50; i++) {
				const x = i / 50;
				expect(evaluateEasing(name, x)).toBeCloseTo(referenceBezier(x1, y1, x2, y2, x), 6);
			}
		}
		// Well-known value: CSS `ease` at 50% progress.
		expect(evaluateEasing('ease', 0.5)).toBeCloseTo(0.8024033877, 6);
		expect(evaluateEasing('ease-in-out', 0.5)).toBeCloseTo(0.5, 9);
		expect(evaluateEasing('linear', 0.37)).toBe(0.37);
		expect(cubicBezierAt(0.42, 0, 0.58, 1, 0)).toBe(0);
		expect(cubicBezierAt(0.42, 0, 0.58, 1, 1)).toBe(1);
		// The back preset overshoots above 1.
		expect(Math.max(...Array.from({ length: 99 }, (_, i) => evaluateEasing('ease-out-back', (i + 1) / 100)))).toBeGreaterThan(1.05);
	});

	it('holds, and handles springs (settling, overshoot, critical damping)', () => {
		expect(evaluateEasing('hold', 0.99)).toBe(0);
		expect(evaluateEasing('hold', 1)).toBe(1);
		const bouncy = { type: 'spring' as const, stiffness: 200, damping: 5 };
		const samples = Array.from({ length: 200 }, (_, i) => springAt(bouncy, i / 100));
		expect(samples[0]).toBe(0);
		expect(Math.max(...samples)).toBeGreaterThan(1.2);
		expect(springAt(bouncy, 10)).toBeCloseTo(1, 4);
		// Critically damped: monotonic, never above 1.
		const critical = { stiffness: 100, damping: 20, mass: 1 };
		let last = -1;
		for (let i = 0; i <= 300; i++) {
			const v = springAt(critical, i / 100);
			expect(v).toBeGreaterThanOrEqual(last - 1e-12);
			expect(v).toBeLessThanOrEqual(1 + 1e-9);
			last = v;
		}
		// Overdamped and nearly-critical springs are continuous with the critical one.
		expect(springAt({ stiffness: 100, damping: 20.0001 }, 0.3)).toBeCloseTo(springAt(critical, 0.3), 4);
		expect(springAt({ stiffness: 100, damping: 19.9999 }, 0.3)).toBeCloseTo(springAt(critical, 0.3), 4);
		expect(springAt({ stiffness: 100, damping: 60 }, 5)).toBeCloseTo(1, 3);
		// Initial velocity speeds the start up.
		expect(springAt({ ...critical, velocity: 10 }, 0.05)).toBeGreaterThan(springAt(critical, 0.05));
		// A segment eases to exactly 1 at its end.
		expect(evaluateEasing('spring', 1, 100)).toBe(1);
	});

	it('parses and prints CSS easings', () => {
		expect(parseCssEasing('cubic-bezier(0.1, 0.7, 1.0, 0.1)')).toEqual({ type: 'cubic-bezier', x1: 0.1, y1: 0.7, x2: 1, y2: 0.1 });
		expect(parseCssEasing('cubic-bezier(1.5, 0, 0, 1)')).toBeNull();
		expect(parseCssEasing('steps(1, end)')).toBe('hold');
		expect(parseCssEasing('ease-in')).toBe('ease-in');
		expect(parseCssEasing('nonsense')).toBeNull();
		expect(easingToCss('ease-in-out')).toBe('ease-in-out');
		expect(easingToCss('hold')).toBe('steps(1, end)');
		expect(easingToCss({ type: 'cubic-bezier', x1: 0.1, y1: 0.7, x2: 1, y2: 0.1 })).toBe('cubic-bezier(0.1, 0.7, 1, 0.1)');
		const spring = easingToCss('spring', 600, 10);
		expect(spring.startsWith('linear(0, ')).toBe(true);
		expect(spring.endsWith(', 1)')).toBe(true);
	});

	// Ported from filmcraft `keyframe.rs` tests (`bezier_eases`): flat influence handles ease both ends.
	it('eases with influence handles: slow start, symmetric midpoint, monotonic', () => {
		const easing = easingFromInfluence();
		const track = [
			{ time: 0, value: 0, easing },
			{ time: 1000, value: 100 }
		];
		expect(evaluateTrack(track, 100) as number).toBeLessThan(10);
		expect(Math.abs((evaluateTrack(track, 500) as number) - 50)).toBeLessThan(1);
		let last = -1;
		for (let i = 0; i <= 100; i++) {
			const v = evaluateTrack(track, i * 10) as number;
			expect(v).toBeGreaterThanOrEqual(last - 1e-9);
			last = v;
		}
	});
});

describe('colour interpolation', () => {
	it('converts to and from OKLab', () => {
		const red = rgbToOklab(1, 0, 0);
		expect(red.l).toBeCloseTo(0.62796, 4);
		expect(red.a).toBeCloseTo(0.22486, 4);
		expect(red.b).toBeCloseTo(0.12585, 4);
		const white = rgbToOklab(1, 1, 1);
		expect(white.l).toBeCloseTo(1, 5);
		expect(white.a).toBeCloseTo(0, 5);
		for (const [r, g, b] of [[0.2, 0.4, 0.6], [1, 0.5, 0], [0, 0, 0], [0.9, 0.1, 0.8]]) {
			const back = oklabToRgb(rgbToOklab(r, g, b));
			expect(back.r).toBeCloseTo(r, 5);
			expect(back.g).toBeCloseTo(g, 5);
			expect(back.b).toBeCloseTo(b, 5);
		}
	});

	it('mixes perceptually with premultiplied alpha', () => {
		// OKLab L 0.5 is linear 0.125, i.e. sRGB #636363 (not the sRGB midpoint #808080).
		expect(mixColorsOklab('#000000', '#ffffff', 0.5)).toBe('#636363');
		expect(mixColorsOklab('#ff0000', '#0000ff', 0)).toBe('#ff0000');
		expect(mixColorsOklab('#ff0000', '#0000ff', 1)).toBe('#0000ff');
		// Fading in from transparent red keeps blue's hue (no muddy midpoint).
		expect(mixColorsOklab('rgba(255, 0, 0, 0)', '#0000ff', 0.5)).toBe('#0000ff80');
		expect(mixColorsOklab('#ff000080', '#ff0000', 0.5)).toBe('#ff0000c0');
		expect(mixColorsOklab('not a colour', '#fff', 0.5)).toBeNull();
		// Colour tracks interpolate in OKLab; unreadable colours hold.
		expect(interpolateAnimationValue('#000000', '#ffffff', 0.5, 'color')).toBe('#636363');
		expect(interpolateAnimationValue('hsl(0 0% 0%)', '#ffffff', 0.5, 'color')).toBe('hsl(0 0% 0%)');
		expect(evaluateTrack([{ time: 0, value: '#000000' }, { time: 100, value: '#ffffff' }], 50, 'color')).toBe('#636363');
	});
});

describe('track evaluation', () => {
	// Ported from filmcraft `keyframe.rs` (`linear_and_hold`).
	it('interpolates linearly, holds outside the keys and on hold segments', () => {
		const keys: AnimationKeyframe[] = [
			{ time: 0, value: 0 },
			{ time: 100, value: 10 }
		];
		expect(evaluateTrack(keys, 50)).toBe(5);
		expect(evaluateTrack(keys, -5)).toBe(0);
		expect(evaluateTrack(keys, 500)).toBe(10);
		keys[0] = { ...keys[0], easing: 'hold' };
		expect(evaluateTrack(keys, 99)).toBe(0);
		expect(evaluateTrack(keys, 100)).toBe(10);
		expect(evaluateTrack([], 10)).toBeUndefined();
	});

	it('sorts unsorted keyframes and lets the later duplicate win', () => {
		const sorted = [
			{ time: 0, value: 0 },
			{ time: 100, value: 100 },
			{ time: 200, value: 0 }
		];
		const unsorted = [sorted[2], sorted[0], sorted[1]];
		for (const t of [0, 50, 100, 150, 200]) expect(evaluateTrack(unsorted, t)).toBe(evaluateTrack(sorted, t));
		const duplicates = [
			{ time: 0, value: 0 },
			{ time: 100, value: 50 },
			{ time: 100 + 1e-9, value: 80 },
			{ time: Number.NaN, value: 3 },
			{ time: 10, value: 'x' as any, easing: 'bogus' as any }
		];
		expect(normalizeKeyframes(duplicates)).toEqual([
			{ time: 0, value: 0 },
			{ time: 100 + 1e-9, value: 80 }
		]);
		expect(evaluateTrack(duplicates, 50)).toBeCloseTo(40, 6);
		// Cached per array.
		expect(normalizeKeyframes(duplicates)).toBe(normalizeKeyframes(duplicates));
	});

	it('evaluates documents without mutating them, and applies overrides to copies', () => {
		const card = animated('card', {
			x: [
				{ time: 0, value: -200, easing: 'ease-out' },
				{ time: 600, value: 0 }
			],
			opacity: [
				{ time: 0, value: 0 },
				{ time: 400, value: 1 }
			],
			fill: [
				{ time: 600, value: '#3b82f6' },
				{ time: 1200, value: '#ef4444' }
			]
		}, { style: { backgroundColor: '#3b82f6' } });
		const still = node('still');
		const nodes = deepFreeze([card, still]);
		const overrides = evaluateAnimation(nodes, 200);
		expect(Object.keys(overrides)).toEqual(['card']);
		expect(overrides.card.opacity).toBe(0.5);
		expect(overrides.card.fill).toBe('#3b82f6');
		const out = applyAnimation(nodes, 200);
		expect(out[1]).toBe(still);
		expect(out[0]).not.toBe(card);
		expect(out[0].style.opacity).toBe(0.5);
		expect(out[0].position.x).toBeCloseTo(-200 + 200 * evaluateEasing('ease-out', 1 / 3), 3);
		expect(applyAnimation(nodes, 1200)[0].style.backgroundColor).toBe('#ef4444');
		expect(applyAnimation([still], 100)).toEqual([still]);
		expect(getAnimationDuration(nodes)).toBe(1200);
		expect(evaluateAnimation({ nodes }, 200)).toEqual(overrides);
		// Disabled tracks do not animate.
		const off = setTrackEnabled(nodes, 'card', 'opacity', false);
		expect(evaluateAnimation(off, 200).card.opacity).toBeUndefined();
		expect(setTrackEnabled(off, 'card', 'opacity', true)[0].data.animation.tracks.opacity.enabled).toBeUndefined();
	});

	it('writes rotation and scale as individual transform properties in either style format', () => {
		const tracks = { rotation: [{ time: 0, value: 0 }, { time: 100, value: 90 }], scale: [{ time: 0, value: 1 }, { time: 100, value: 2 }] };
		const object = applyAnimation([animated('a', tracks, { style: { color: 'red' } })], 50)[0];
		expect(object.style).toEqual({ color: 'red', rotate: '45deg', scale: 1.5 });
		const string = applyAnimation([animated('a', tracks, { style: 'color: red' })], 50)[0];
		expect(string.style).toBe('color: red; rotate: 45deg; scale: 1.5');
	});

	it('animates shape fills, sizes and motion paths', () => {
		const shape = animated(
			's',
			{ fill: [{ time: 0, value: '#000000' }, { time: 100, value: '#ffffff' }], width: [{ time: 0, value: 10 }, { time: 100, value: 30 }] },
			{ type: 'shape', width: 10, height: 10, data: { shape: { kind: 'rect', fill: '#000000' } } }
		);
		const out = applyAnimation([shape], 50)[0];
		expect(out.data.shape.fill).toBe('#636363');
		expect(out.width).toBe(20);
		let moving = animated('m', { motionPath: [{ time: 0, value: 0 }, { time: 100, value: 1 }] }, { width: 20, height: 10 });
		moving = setMotionPath([moving], 'm', { d: 'M0 0 L100 0 L100 100', autoRotate: true })[0];
		const mid = applyAnimation([moving], 50)[0];
		expect(mid.position).toEqual({ x: 90, y: -5 });
		expect(mid.style.rotate).toBe('0deg');
		const late = applyAnimation([moving], 75)[0];
		expect(late.position.x).toBeCloseTo(90, 6);
		expect(late.position.y).toBeCloseTo(45, 6);
		expect(late.style.rotate).toBe('90deg');
	});

	it('composes with design tokens: animation is applied after tokens are materialised', () => {
		const store = new TokenStore({ createId: (kind) => `${kind}-1` });
		const c = store.createCollection('Theme', ['Light']);
		const accent = store.createVariable({ collectionId: c.id, name: 'accent', type: 'color', value: '#00ff00' });
		let nodes = [animated('n', { opacity: [{ time: 0, value: 0 }, { time: 100, value: 1 }] }, { style: { backgroundColor: '#000000' } })];
		nodes = bindCanvasToken(nodes, ['n'], 'fill', accent.id, store.getState());
		const resolved = resolveCanvasTokens(nodes, store.getState());
		const frame = applyAnimation(resolved, 50)[0];
		expect(frame.style.backgroundColor).toBe('#00ff00');
		expect(frame.style.opacity).toBe(0.5);
		// Animation data survives token resolution.
		expect(resolved[0].data.animation).toBe(nodes[0].data.animation);
	});

	it('wraps time for loop and ping-pong', () => {
		expect(wrapAnimationTime(1500, 1000, 'none')).toBe(1000);
		expect(wrapAnimationTime(-5, 1000, 'none')).toBe(0);
		expect(wrapAnimationTime(1500, 1000, 'loop')).toBe(500);
		expect(wrapAnimationTime(-250, 1000, 'loop')).toBe(750);
		expect(wrapAnimationTime(1250, 1000, 'ping-pong')).toBe(750);
		expect(wrapAnimationTime(2250, 1000, 'ping-pong')).toBe(250);
		expect(wrapAnimationTime(500, 0, 'loop')).toBe(0);
	});

	it('evaluates in time linear in the number of nodes', () => {
		const make = (n: number) =>
			Array.from({ length: n }, (_, i) =>
				animated(`n${i}`, { x: [{ time: 0, value: 0 }, { time: 1000, value: 100, easing: 'ease' }, { time: 2000, value: 0 }], opacity: [{ time: 0, value: 0 }, { time: 500, value: 1 }] })
			);
		const small = make(250);
		const large = make(1000);
		const ratio = measureGrowth(() => applyAnimation(small, 750), () => applyAnimation(large, 750), { limit: 10 });
		expect(ratio).toBeLessThan(10);
	});
});

describe('keyframe editing', () => {
	it('adds, replaces and updates keyframes; new keys inherit the previous easing', () => {
		let nodes = [node('a')];
		nodes = setKeyframe(nodes, 'a', 'x', 0, 0, { easing: 'ease-in' });
		nodes = setKeyframe(nodes, 'a', 'x', 500, 50);
		expect(keysOf(nodes[0], 'x')).toEqual([
			{ time: 0, value: 0, easing: 'ease-in' },
			{ time: 500, value: 50, easing: 'ease-in' }
		]);
		nodes = setKeyframe(nodes, 'a', 'x', 500, 60);
		expect(keysOf(nodes[0], 'x')[1]).toEqual({ time: 500, value: 60, easing: 'ease-in' });
		nodes = updateKeyframe(nodes, { nodeId: 'a', property: 'x', time: 500 }, { time: 0, easing: null });
		expect(keysOf(nodes[0], 'x')).toEqual([{ time: 0, value: 60 }]);
		nodes = setKeyframe(nodes, 'a', 'opacity', 100, '0.5' as any);
		expect(keysOf(nodes[0], 'opacity')).toEqual([{ time: 100, value: 0.5 }]);
		nodes = setKeyframe(nodes, 'a', 'opacity', 200, 7);
		expect(keysOf(nodes[0], 'opacity')[1].value).toBe(1);
		expect(() => setKeyframe(nodes, 'a', 'fill', 0, 'nope')).toThrow(AnimationEditError);
		expect(() => setKeyframe(nodes, 'a', 'bogus', 0, 1)).toThrow(/cannot be animated/);
		expect(() => setKeyframe(nodes, 'zzz', 'x', 0, 1)).toThrow(/does not exist/);
		expect(() => setKeyframeEasing(nodes, [{ nodeId: 'a', property: 'x', time: 0 }], 'wobbly')).toThrow(/easing/);
		expect(keysOf(setKeyframeEasing(nodes, [{ nodeId: 'a', property: 'x', time: 0 }], 'cubic-bezier(0.1, 0.2, 0.3, 0.4)')[0], 'x')[0].easing).toEqual({
			type: 'cubic-bezier',
			x1: 0.1,
			y1: 0.2,
			x2: 0.3,
			y2: 0.4
		});
	});

	it('deleting the last keyframe keeps its value on the node', () => {
		let nodes = [animated('a', { x: [{ time: 0, value: 10 }, { time: 100, value: 80 }] })];
		nodes = deleteKeyframes(nodes, [{ nodeId: 'a', property: 'x', time: 0 }]);
		expect(keysOf(nodes[0], 'x')).toEqual([{ time: 100, value: 80 }]);
		nodes = deleteKeyframes(nodes, [{ nodeId: 'a', property: 'x', time: 100 }]);
		expect(nodes[0].data.animation).toBeUndefined();
		expect(nodes[0].position.x).toBe(80);
	});

	it('keys nodes at a time with the values they show there', () => {
		const nodes = [animated('a', { x: [{ time: 0, value: 0 }, { time: 100, value: 100 }] }), node('b', { position: { x: 5, y: 6 } })];
		const { nodes: out, refs } = addKeyframesAtTime(nodes, ['a', 'b'], 50);
		expect(refs).toEqual([
			{ nodeId: 'a', property: 'x', time: 50 },
			{ nodeId: 'b', property: 'x', time: 50 },
			{ nodeId: 'b', property: 'y', time: 50 }
		]);
		expect(keysOf(out[0], 'x')[1]).toEqual({ time: 50, value: 50 });
		expect(keysOf(out[1], 'y')).toEqual([{ time: 50, value: 6 }]);
	});

	describe('moving keyframes (ported from filmcraft keyframe_move.rs)', () => {
		const fixture = () => [
			animated('clip', {
				scale: [
					{ time: 500, value: 1, easing: 'ease' },
					{ time: 1000, value: 2 }
				],
				rotation: [{ time: 1500, value: 45 }]
			}),
			node('other')
		];
		const refs: KeyframeRef[] = [
			{ nodeId: 'clip', property: 'scale', time: 500 },
			{ nodeId: 'clip', property: 'scale', time: 1000 },
			{ nodeId: 'clip', property: 'rotation', time: 1500 }
		];

		it('moves across lanes atomically, and keys can move into each other\'s old positions', () => {
			const nodes = fixture();
			// Scale's first key moves into the second one's old position: both must survive.
			const result = moveKeyframes(nodes, refs, 500);
			expect(result.delta).toBe(500);
			expect(keysOf(result.nodes[0], 'scale')).toEqual([
				{ time: 1000, value: 1, easing: 'ease' },
				{ time: 1500, value: 2 }
			]);
			expect(keysOf(result.nodes[0], 'rotation')).toEqual([{ time: 2000, value: 45 }]);
			expect(result.refs.map((r) => r.time)).toEqual([1000, 1500, 2000]);
			expect(result.nodes[1]).toBe(nodes[1]);
		});

		it('clamps the group at the bounds without changing its spacing; a boundary no-op is no edit', () => {
			const nodes = fixture();
			const result = moveKeyframes(nodes, refs, -10_000);
			expect(result.delta).toBe(-500);
			expect(result.refs.map((r) => r.time)).toEqual([0, 500, 1000]);
			const again = moveKeyframes(result.nodes, result.refs, -10_000);
			expect(again.delta).toBe(0);
			expect(again.nodes).toBe(result.nodes);
			const capped = moveKeyframes(nodes, refs, 10_000, { max: 2000 });
			expect(capped.delta).toBe(500);
		});

		it('invalid or duplicate references make no partial edits', () => {
			const nodes = deepFreeze(fixture());
			const bad = { ...refs[1], property: 'missing' };
			for (const request of [[refs[0], bad], [refs[0], refs[0]], [], [{ ...refs[0], nodeId: 'nope' }], [{ ...refs[0], time: 501 }]]) {
				expect(() => moveKeyframes(nodes, request as KeyframeRef[], 100)).toThrow(AnimationEditError);
			}
			expect(() => moveKeyframes(nodes, Array(4097).fill(refs[0]), 100)).toThrow(/at most/i);
			expect(() => moveKeyframes(nodes, refs, Number.NaN)).toThrow(AnimationEditError);
		});

		it('moved keys replace unselected keys at their destination', () => {
			const nodes = fixture();
			const result = moveKeyframes(nodes, [refs[0]], 500);
			expect(keysOf(result.nodes[0], 'scale')).toEqual([{ time: 1000, value: 1, easing: 'ease' }]);
		});
	});

	it('scales keyframe spacing around a pivot within bounds', () => {
		const nodes = [animated('a', { x: [{ time: 100, value: 0 }, { time: 200, value: 1 }, { time: 400, value: 2 }] })];
		const refs = [100, 200, 400].map((time) => ({ nodeId: 'a', property: 'x', time }));
		const doubled = scaleKeyframes(nodes, refs, 2);
		expect(keysOf(doubled.nodes[0], 'x').map((k) => k.time)).toEqual([100, 300, 700]);
		const capped = scaleKeyframes(nodes, refs, 10, { max: 1000 });
		expect(capped.factor).toBe(3);
		const around = scaleKeyframes(nodes, refs, 0.5, { pivot: 400 });
		expect(keysOf(around.nodes[0], 'x').map((k) => k.time)).toEqual([250, 300, 400]);
		const fromEnd = scaleKeyframes(nodes, refs, 3, { pivot: 400 });
		expect(fromEnd.factor).toBeCloseTo(4 / 3, 9);
		expect(() => scaleKeyframes(nodes, refs, 0)).toThrow(AnimationEditError);
	});

	it('snaps a group to the nearest target within the threshold, keeping spacing', () => {
		// Rightmost selected key snaps onto another row's key 3ms away.
		expect(snapKeyframeDelta([200, 400], 297, [700, 1000], 8)).toEqual({ delta: 300, target: 700 });
		expect(snapKeyframeDelta([200, 400], 280, [700], 8)).toEqual({ delta: 280, target: null });
		// The closest of several candidates wins.
		expect(snapKeyframeDelta([0, 100], 49, [50, 151], 5)).toEqual({ delta: 50, target: 50 });
		const nodes = [animated('a', { x: [{ time: 0, value: 0 }, { time: 300, value: 1 }] }), animated('b', { y: [{ time: 300, value: 0 }, { time: 900, value: 1 }] })];
		expect(getKeyframeTimes(nodes)).toEqual([0, 300, 900]);
		expect(getKeyframeTimes(nodes, { exclude: [{ nodeId: 'a', property: 'x', time: 0 }] })).toEqual([300, 900]);
		expect(getKeyframeTimes(nodes, { ids: ['b'] })).toEqual([300, 900]);
	});

	it('copies and pastes keyframes at a time, onto other nodes', () => {
		const nodes = [animated('a', { x: [{ time: 100, value: 0, easing: 'ease' }, { time: 300, value: 50 }], opacity: [{ time: 200, value: 1 }] }), node('b'), node('c')];
		const clip = copyKeyframes(nodes, [
			{ nodeId: 'a', property: 'x', time: 100 },
			{ nodeId: 'a', property: 'x', time: 300 },
			{ nodeId: 'a', property: 'opacity', time: 200 }
		]);
		expect(clip.keyframes.map((k) => k.offset)).toEqual([0, 200, 100]);
		const parsed = parseKeyframeClipboard(JSON.stringify(clip))!;
		expect(parsed).toEqual(clip);
		expect(parseKeyframeClipboard('{"type":"other"}')).toBeNull();
		const { nodes: out, refs } = pasteKeyframes(nodes, parsed, 1000, { nodeIds: ['b', 'c'] });
		expect(refs).toHaveLength(6);
		expect(keysOf(out[1], 'x')).toEqual([
			{ time: 1000, value: 0, easing: 'ease' },
			{ time: 1200, value: 50 }
		]);
		expect(keysOf(out[2], 'opacity')).toEqual([{ time: 1100, value: 1 }]);
		// Without targets, pastes back onto the source node.
		expect(keysOf(pasteKeyframes(nodes, parsed, 0).nodes[0], 'x').map((k) => k.time)).toEqual([0, 100, 200, 300]);
	});

	it('records edits on displayed nodes: animated properties key, record mode keys new tracks', () => {
		const base = [animated('a', { x: [{ time: 0, value: 0 }, { time: 1000, value: 100 }] }, { position: { x: 0, y: 20 } }), node('b')];
		const shown = applyAnimation(base, 500);
		expect(shown[0].position).toEqual({ x: 50, y: 20 });
		// Drag node a to (70, 40) at t=500, and select b.
		const after = [{ ...shown[0], position: { x: 70, y: 40 } }, { ...shown[1], selected: true }];
		const off = recordAnimationChanges(base, shown, after, 500);
		expect(off.keyed).toEqual([{ nodeId: 'a', property: 'x', time: 500 }]);
		expect(keysOf(off.nodes[0], 'x')).toEqual([
			{ time: 0, value: 0 },
			{ time: 500, value: 70 },
			{ time: 1000, value: 100 }
		]);
		// x keeps its stored value; y (not animated) is a static edit.
		expect(off.nodes[0].position).toEqual({ x: 0, y: 40 });
		expect(off.nodes[1].selected).toBe(true);
		const on = recordAnimationChanges(base, shown, after, 500, { recording: true });
		expect(on.keyed).toEqual([
			{ nodeId: 'a', property: 'x', time: 500 },
			{ nodeId: 'a', property: 'y', time: 500 }
		]);
		expect(keysOf(on.nodes[0], 'y')).toEqual([
			{ time: 0, value: 20 },
			{ time: 500, value: 40 }
		]);
		expect(on.nodes[0].position).toEqual({ x: 0, y: 20 });
		expect(applyAnimation(on.nodes, 500)[0].position).toEqual({ x: 70, y: 40 });
		// Unchanged nodes keep their stored identity.
		const same = recordAnimationChanges(base, shown, shown, 500, { recording: true });
		expect(same.nodes[0]).toBe(base[0]);
		expect(same.keyed).toEqual([]);
	});

	it('animates a node from its current values to targets', () => {
		const nodes = [node('card', { position: { x: -100, y: 0 }, style: { opacity: 0 } })];
		const { nodes: out, refs } = animateNode(nodes, 'card', { to: { x: 0, opacity: 1 }, duration: 600, delay: 200, easing: 'ease-out' });
		expect(refs).toHaveLength(4);
		expect(keysOf(out[0], 'x')).toEqual([
			{ time: 200, value: -100, easing: 'ease-out' },
			{ time: 800, value: 0 }
		]);
		expect(keysOf(out[0], 'opacity')[0].value).toBe(0);
		expect(() => animateNode(nodes, 'card', { to: {} })).toThrow(AnimationEditError);
		expect(() => animateNode(nodes, 'card', { to: { x: 1 }, duration: 0 })).toThrow(AnimationEditError);
		expect(() => animateNode(nodes, 'card', { to: { motionPath: 1 } })).toThrow(/motion path/);
	});
});

describe('AnimationPlayer', () => {
	it('plays on an injected clock, pauses, seeks and stops at the end', async () => {
		const clock = new ManualClock();
		const times: number[] = [];
		let ended = 0;
		const player = new AnimationPlayer({ clock, duration: 1000, onTime: (t) => times.push(t), onEnd: () => ended++ });
		player.play();
		expect(player.getState().playing).toBe(true);
		await clock.advance(250);
		expect(player.currentTime).toBe(250);
		await clock.advance(250);
		expect(player.currentTime).toBe(500);
		player.pause();
		await clock.advance(1000);
		expect(player.currentTime).toBe(500);
		expect(clock.pending).toBe(false);
		player.seek(900);
		player.play();
		await clock.advance(500);
		expect(player.currentTime).toBe(1000);
		expect(player.isPlaying).toBe(false);
		expect(ended).toBe(1);
		expect(times).toEqual([250, 500, 900, 1000]);
		// Playing again after the end restarts.
		player.play();
		expect(player.currentTime).toBe(0);
		player.stop();
		expect(player.getState()).toMatchObject({ playing: false, time: 0 });
	});

	it('loops, ping-pongs and respects playback rate', async () => {
		const clock = new ManualClock();
		const player = new AnimationPlayer({ clock, duration: 1000, loop: 'loop', playbackRate: 2 });
		player.play();
		await clock.advance(600);
		expect(player.currentTime).toBe(200);
		player.setLoop('ping-pong');
		await clock.advance(450);
		// Raw 1200 + 900 = 2100 → bounced to 100.
		expect(player.currentTime).toBe(100);
		player.pause();
		const back = new AnimationPlayer({ clock, duration: 1000, playbackRate: -1, time: 300 });
		back.play();
		await clock.advance(200);
		expect(back.currentTime).toBe(100);
		await clock.advance(200);
		expect(back.currentTime).toBe(0);
		expect(back.isPlaying).toBe(false);
	});

	it('scrubbing pauses playback and resumes it afterwards', async () => {
		const clock = new ManualClock();
		const player = new AnimationPlayer({ clock, duration: 1000 });
		player.play();
		await clock.advance(100);
		player.scrub(600);
		expect(player.getState()).toMatchObject({ playing: false, scrubbing: true, time: 600 });
		await clock.advance(100);
		expect(player.currentTime).toBe(600);
		player.endScrub();
		expect(player.isPlaying).toBe(true);
		await clock.advance(100);
		expect(player.currentTime).toBe(700);
		const states: unknown[] = [];
		const off = player.subscribe((s) => states.push(s));
		await clock.advance(16);
		expect(states.length).toBe(1);
		expect(player.getState()).toBe(player.getState());
		off();
		player.destroy();
		await clock.advance(100);
		expect(player.currentTime).toBe(716);
	});
});

describe('export', () => {
	const card = () =>
		animated(
			'card',
			{
				x: [
					{ time: 0, value: -100, easing: 'ease-out' },
					{ time: 500, value: 0 }
				],
				opacity: [
					{ time: 0, value: 0 },
					{ time: 250, value: 1 }
				]
			},
			{ position: { x: 0, y: 10 } }
		);

	it('exports exact tracks as CSS @keyframes with per-segment timing', () => {
		const out = exportCssAnimation([card()], 'card', { loop: 'ping-pong', name: 'slide' });
		expect(out.exact).toBe(true);
		expect(out.css).toContain('@keyframes slide-translate {\n  0% { translate: -100px 0px; animation-timing-function: ease-out; }\n  100% { translate: 0px 0px; }\n}');
		expect(out.css).toContain('@keyframes slide-opacity {\n  0% { opacity: 0; animation-timing-function: linear; }\n  50% { opacity: 1; }\n  100% { opacity: 1; }\n}');
		expect(out.animation).toBe('slide-translate 500ms linear 0ms infinite alternate both, slide-opacity 500ms linear 0ms infinite alternate both');
		expect(out.css).toContain('[data-id="card"] {\n  animation: slide-translate');
	});

	it('samples colour tracks (OKLab) and mismatched x / y timing', () => {
		const n = animated('n', {
			fill: [
				{ time: 0, value: '#000000' },
				{ time: 1000, value: '#ffffff' }
			],
			x: [{ time: 0, value: 0 }, { time: 1000, value: 10 }],
			y: [{ time: 0, value: 0 }, { time: 400, value: 10, easing: 'hold' }]
		});
		const out = exportCssAnimation([n], 'n', { sampleFps: 10 });
		expect(out.exact).toBe(false);
		const fill = toWebAnimations([n], 'n', { sampleFps: 10 }).find((s) => s.property === 'background-color')!;
		expect(fill.exact).toBe(false);
		expect(fill.keyframes).toHaveLength(11);
		expect(fill.keyframes[5]).toEqual({ offset: 0.5, backgroundColor: '#636363', easing: 'linear' });
		expect(fill.options).toEqual({ duration: 1000, iterations: 1, direction: 'normal', fill: 'both', easing: 'linear' });
	});

	it('produces Web Animations keyframes, and samples frames at an fps', () => {
		const specs = toWebAnimations([card()], 'card', { loop: 'loop', playbackRate: 2 });
		expect(specs[0].keyframes[0]).toEqual({ offset: 0, translate: '-100px 0px', easing: 'ease-out' });
		expect(specs[0].options).toMatchObject({ duration: 250, iterations: Infinity, direction: 'normal' });
		const animate = (keyframes: unknown, options: unknown) => ({ keyframes, options });
		expect(specs.map((s) => animate(s.keyframes, s.options))).toHaveLength(2);
		const frames = sampleAnimationFrames([card()], { fps: 10 });
		expect(frames).toHaveLength(6);
		expect(frames[5]).toMatchObject({ index: 5, time: 500 });
		expect(frames[2].overrides.card.opacity).toBeCloseTo(0.8, 9);
		const applied = applyAnimationOverrides([card()], frames[5].overrides);
		expect(applied[0].position.x).toBe(0);
		expect(() => sampleAnimationFrames([card()], { fps: 1000, duration: 1e9 })).toThrow(RangeError);
	});
});

describe('timeline view model', () => {
	it('lists rows per animated property with selection and drag preview', () => {
		const nodes = [animated('a', { opacity: [{ time: 0, value: 0 }], x: [{ time: 100, value: 1 }] }, { data: { label: 'Card' } })];
		const rows = getTimelineRows(nodes, ['a', 'missing'], { selection: [{ nodeId: 'a', property: 'x', time: 100 }], dragDelta: 50 });
		expect(rows.map((r) => r.id)).toEqual(['a:x', 'a:opacity']);
		expect(rows[0]).toMatchObject({ nodeLabel: 'Card', label: 'X', enabled: true });
		expect(rows[0].keyframes[0]).toMatchObject({ time: 150, selected: true });
		expect(rows[1].keyframes[0]).toMatchObject({ time: 0, selected: false });
		const ticks = getTimelineTicks(2000, 400);
		expect(ticks.map((t) => t.label)).toEqual(['0.00s', '0.50s', '1.00s', '1.50s', '2.00s']);
	});
});

describe('createCanvasAnimationController', () => {
	function setup(nodes: CanvasNode[]) {
		let state = nodes;
		const history = new HistoryManager();
		const clock = new ManualClock();
		const controller = createCanvasAnimationController({
			getNodes: () => state,
			setNodes: (next) => {
				state = next;
			},
			history,
			clock,
			getSelectedIds: () => state.filter((n) => n.selected).map((n) => n.id)
		});
		return { controller, history, clock, get nodes() { return state; } };
	}

	it('moves selected keyframes as one undo step; drag previews are not edits and Escape cancels', () => {
		const ctx = setup([animated('a', { x: [{ time: 0, value: 0 }, { time: 500, value: 1 }], y: [{ time: 800, value: 3 }] })]);
		const { controller, history } = ctx;
		const before = ctx.nodes;
		controller.selectKeyframes([{ nodeId: 'a', property: 'x', time: 0 }, { nodeId: 'a', property: 'x', time: 500 }]);
		controller.beginKeyframeDrag();
		controller.updateKeyframeDrag(290, { thresholdMs: 20 });
		// The 500 key snaps onto y's key at 800.
		expect(controller.getState().drag).toMatchObject({ delta: 300, target: 800 });
		expect(controller.timelineRows(['a'])[0].keyframes.map((k) => k.time)).toEqual([300, 800]);
		expect(ctx.nodes).toBe(before);
		controller.cancelKeyframeDrag();
		expect(history.getState().undoCount).toBe(0);
		controller.beginKeyframeDrag();
		controller.updateKeyframeDrag(110, { snap: false });
		expect(controller.endKeyframeDrag()).toBe(110);
		expect(keysOf(ctx.nodes[0], 'x').map((k) => k.time)).toEqual([110, 610]);
		expect(controller.selection.map((r) => r.time)).toEqual([110, 610]);
		expect(history.getState().undoCount).toBe(1);
		history.undo();
		expect(keysOf(ctx.nodes[0], 'x').map((k) => k.time)).toEqual([0, 500]);
		history.redo();
		expect(keysOf(ctx.nodes[0], 'x').map((k) => k.time)).toEqual([110, 610]);
		// Without snapping targets nearby, the drag snaps to whole frames (30 fps).
		controller.beginKeyframeDrag();
		controller.updateKeyframeDrag(52);
		expect(controller.getState().drag!.delta).toBeCloseTo((1000 / 30) * 5 - 110, 2);
		controller.cancelKeyframeDrag();
	});

	it('records drags at the playhead into one merged undo step', () => {
		const ctx = setup([animated('a', { x: [{ time: 0, value: 0 }, { time: 1000, value: 100 }] }, { selected: true })]);
		const { controller, history } = ctx;
		controller.seek(500);
		const shown = controller.display();
		expect(shown[0].position.x).toBe(50);
		expect(controller.display()).toBe(shown);
		for (const x of [55, 60, 70]) {
			const display = controller.display();
			controller.applyDisplayChanges([{ ...display[0], position: { x, y: 0 } }]);
		}
		expect(keysOf(ctx.nodes[0], 'x')).toEqual([
			{ time: 0, value: 0 },
			{ time: 500, value: 70 },
			{ time: 1000, value: 100 }
		]);
		expect(controller.display()[0].position.x).toBe(70);
		expect(history.getState().undoCount).toBe(1);
		history.undo();
		expect(keysOf(ctx.nodes[0], 'x')).toHaveLength(2);
		expect(ctx.nodes[0].selected).toBe(true);
		// Record mode keys an unanimated property.
		controller.setRecording(true);
		const display = controller.display();
		controller.applyDisplayChanges([{ ...display[0], style: { opacity: 0.25 } }]);
		expect(keysOf(ctx.nodes[0], 'opacity')).toEqual([
			{ time: 0, value: 1 },
			{ time: 500, value: 0.25 }
		]);
	});

	it('adds keyframes at the playhead, sets easing, deletes, copies and pastes with undo', () => {
		const ctx = setup([node('a', { selected: true, position: { x: 1, y: 2 } }), node('b')]);
		const { controller, history } = ctx;
		controller.seek(200);
		const refs = controller.addKeyframe();
		expect(refs).toEqual([
			{ nodeId: 'a', property: 'x', time: 200 },
			{ nodeId: 'a', property: 'y', time: 200 }
		]);
		expect(controller.selection).toEqual(refs);
		expect(controller.setEasing('ease-in')).toBe(true);
		expect(keysOf(ctx.nodes[0], 'x')[0].easing).toBe('ease-in');
		controller.copyKeyframes();
		controller.seek(600);
		const pasted = controller.pasteKeyframes(undefined, ['b']);
		expect(pasted.map((r) => r.time)).toEqual([600, 600]);
		expect(keysOf(ctx.nodes[1], 'x')).toEqual([{ time: 600, value: 1, easing: 'ease-in' }]);
		expect(controller.deleteKeyframes()).toBe(true);
		expect(ctx.nodes[1].data.animation).toBeUndefined();
		expect(controller.selection).toEqual([]);
		const steps = history.getState().undoCount;
		expect(steps).toBe(4);
		history.undo();
		expect(keysOf(ctx.nodes[1], 'y')).toHaveLength(1);
		const duration = controller.getState().duration;
		expect(duration).toBe(1000);
		controller.setDuration(3000);
		expect(controller.getState()).toMatchObject({ duration: 3000, autoDuration: false });
		controller.seek(0);
		expect(controller.nextKeyframe(['a', 'b'])).toBe(200);
		expect(controller.nextKeyframe(['a', 'b'])).toBe(600);
		expect(controller.nextKeyframe(['a', 'b'])).toBeNull();
		expect(controller.previousKeyframe(['a', 'b'])).toBe(200);
	});

	it('plays on the injected clock and displays the evaluated frame', async () => {
		const ctx = setup([animated('a', { opacity: [{ time: 0, value: 0 }, { time: 1000, value: 1 }] })]);
		const { controller, clock } = ctx;
		const seen: number[] = [];
		controller.subscribe((s) => seen.push(s.time));
		controller.play();
		await clock.advance(250);
		expect(controller.display()[0].style.opacity).toBe(0.25);
		await clock.advance(1000);
		expect(controller.getState()).toMatchObject({ playing: false, time: 1000 });
		expect(seen).toContain(250);
		controller.destroy();
	});
});

describe('animation commands and agent tools', () => {
	it('registers commands and animates a node through run_command', async () => {
		let nodes: CanvasNode[] = [node('card', { position: { x: -200, y: 0 } })];
		const history = new HistoryManager();
		const controller = createCanvasAnimationController({ getNodes: () => nodes, setNodes: (n) => (nodes = n), history, clock: new ManualClock() });
		const registry = new CommandRegistry();
		registry.register(createCanvasAnimationCommands(controller));
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(registry));
		const result = await tools.callTool('run_command', {
			id: 'canvas.animation.animateNode',
			params: { nodeId: 'card', to: { x: 0, opacity: 1 }, from: { opacity: 0 }, duration: 600, easing: 'ease-out' }
		});
		expect(result.isError).toBeFalsy();
		expect(keysOf(nodes[0], 'x')).toEqual([
			{ time: 0, value: -200, easing: 'ease-out' },
			{ time: 600, value: 0 }
		]);
		expect(history.getState().undoCount).toBe(1);
		expect(registry.isEnabled('canvas.animation.deleteKeyframes')).toEqual({ enabled: false, reason: 'Select keyframes first.' });
		expect(registry.execute('canvas.animation.seek', { time: 300 })).toMatchObject({ ok: true, result: { time: 300 } });
		const css = registry.execute('canvas.animation.exportCss', { nodeId: 'card' });
		expect((css as any).result.css).toContain('@keyframes');
		const bad = await tools.callTool('run_command', { id: 'canvas.animation.animateNode', params: { nodeId: 'card', to: { x: 'far' } } });
		expect(bad.isError).toBe(true);
		expect(registry.execute('canvas.animation.toggleRecord')).toMatchObject({ ok: true, result: { recording: true } });
		expect(registry.execute('canvas.animation.togglePlay')).toMatchObject({ ok: true, result: { playing: true } });
	});
});
