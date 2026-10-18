import { describe, it, expect } from 'vitest';
import {
	AnimationEditorController,
	MOTION_DRAW_EFFECT_ID,
	MOTION_ISSUE_CODES,
	MotionSceneFormatError,
	applyMotionEdits,
	checkMotionScene,
	compileMotionScene,
	createAnimationEditorToolProvider,
	createMotionScene,
	flairCurveFor,
	flairEaseFor,
	motionFrameAt,
	motionFrameToSvg,
	parseMotionScene,
	toFlairEffectDocument,
	toFlairSvgMotion,
	toFlairVectorEffect,
	MOTION_EASE_OUT,
	motionGhosts,
	motionMovingIds,
	motionPath,
	motionStageSvg,
	motionFlairPrimitive,
	fromFlairSvgMotion,
	fromFlairVectorEffect,
	type FlairSvgAnimation,
	type MotionIssueCode,
	type MotionScene
} from '../src/animation-editor';
import { ManualClock, SPRING_PRESETS, springSettleMs } from '../src/animation';
import { ToolRegistry } from '../src/tools';
import { createVectorEffect, ellipseSubpath, findVectorNode, rectSubpath, starSubpath, type VectorDocument, type VectorPathNode } from '../src/vector';

const ARTWORK: VectorDocument = {
	width: 400,
	height: 200,
	background: '#ffffff',
	nodes: [
		{ id: 'box', type: 'path', name: 'Box', fill: '#ef4444', stroke: '#111111', strokeWidth: 2, subpaths: [rectSubpath({ x: 20, y: 20, width: 60, height: 60 })] },
		{ id: 'dot', type: 'path', fill: '#0ea5e9', subpaths: [ellipseSubpath({ x: 300, y: 120, width: 40, height: 40 })] },
		{ id: 'line', type: 'path', fill: null, stroke: '#111111', strokeWidth: 3, subpaths: [{ closed: false, anchors: [{ x: 20, y: 150 }, { x: 380, y: 150 }] }] },
		{ id: 'track', type: 'path', visible: false, fill: null, stroke: '#999999', subpaths: [{ closed: false, anchors: [{ x: 0, y: 100 }, { x: 400, y: 100 }] }] },
		{ id: 'circle', type: 'path', visible: false, fill: '#22c55e', subpaths: [ellipseSubpath({ x: 20, y: 20, width: 60, height: 60 })] },
		{ id: 'spin', type: 'path', fill: '#a855f7', subpaths: [rectSubpath({ x: 160, y: 40, width: 40, height: 40 })], effects: [createVectorEffect('twist', 'tw', { angle: 0, center: { x: 0.5, y: 0.5 } })!] },
		{ id: 'pair', type: 'group', children: [
			{ id: 'a', type: 'path', fill: '#f59e0b', subpaths: [rectSubpath({ x: 220, y: 20, width: 20, height: 20 })] },
			{ id: 'b', type: 'path', fill: '#f59e0b', subpaths: [rectSubpath({ x: 250, y: 20, width: 20, height: 20 })] }
		] }
	]
};

const scene = (shots: MotionScene['shots'], extra: Partial<MotionScene> = {}): MotionScene => ({ version: 1, name: 'test', artwork: ARTWORK, shots, ...extra });
const path = (doc: VectorDocument, id: string) => findVectorNode(doc.nodes, id) as VectorPathNode;

describe('parseMotionScene', () => {
	it('lists every shape problem at once, with suggestions', () => {
		const bad = { version: 1, name: 'x', artwork: ARTWORK, shots: [{ id: 'one', run: [{ type: 'entr', targets: ['box'] }, { type: 'move', targets: ['box'] }], hodl: 5 }] };
		try {
			parseMotionScene(bad);
			throw new Error('expected a format error');
		} catch (error) {
			expect(error).toBeInstanceOf(MotionSceneFormatError);
			const problems = (error as MotionSceneFormatError).problems.join('\n');
			expect(problems).toContain('"hodl" (did you mean "hold"?)');
			expect(problems).toContain('"entr" (did you mean "enter"?)');
			expect(problems).toContain('give "by" (an offset) or "to" (a point)');
		}
	});

	it('reads JSON text and rejects invalid JSON', () => {
		const text = JSON.stringify(scene([{ id: 'one', run: [] }]));
		expect(parseMotionScene(text).shots[0].id).toBe('one');
		expect(() => parseMotionScene('{')).toThrow(/not valid JSON/);
	});
});

describe('compileMotionScene', () => {
	it('times commands one after another, together with "previous", with delays and stagger', () => {
		const s = scene([
			{ id: 'one', run: [{ type: 'enter', targets: ['box'], duration: 500 }, { type: 'enter', targets: ['dot'], duration: 300, with: 'previous' }, { type: 'move', targets: ['a', 'b'], by: { x: 10, y: 0 }, duration: 200, stagger: 100, delay: 50 }], hold: 400 },
			{ id: 'two', run: [{ type: 'wait', duration: 250 }] }
		]);
		const t = compileMotionScene(s);
		expect(t.commands.map((c) => [c.start, c.end])).toEqual([[0, 500], [0, 300], [550, 850], [1250, 1500]]);
		expect(t.shots.map((x) => [x.start, x.end])).toEqual([[0, 1250], [1250, 2100]]);
		expect(t.duration).toBe(2100);
	});

	it('cuts the camera on the first shot and eases it later', () => {
		const s = scene([
			{ id: 'one', camera: { x: 0, y: 0, width: 200, height: 100 }, run: [] },
			{ id: 'two', camera: { frame: 'dot', padding: 10 }, run: [{ type: 'pulse', targets: ['dot'] }] }
		]);
		const t = compileMotionScene(s);
		expect(t.shots[0].commandsStart).toBe(0);
		expect(t.shots[1].commandsStart - t.shots[1].start).toBe(1000);
		const end = motionFrameAt(s, t.duration).camera;
		// Framing a node fits the artwork's 2:1 shape around it.
		expect(end.width / end.height).toBeCloseTo(2);
		expect(end.x + end.width / 2).toBeCloseTo(320);
	});

	it('lets a draw take as long as its line is long', () => {
		const t = compileMotionScene(scene([{ id: 'one', run: [{ type: 'draw', targets: ['line'] }] }]));
		expect(t.commands[0].duration).toBe(540); // 360 units × 1.5 ms
	});
});

describe('motionFrameAt', () => {
	const s = scene([
		{ id: 'in', run: [{ type: 'enter', targets: ['box'], duration: 400 }], hold: 0 },
		{ id: 'go', run: [{ type: 'move', targets: ['box'], by: { x: 100, y: 0 }, duration: 400, ease: 'linear' }, { type: 'style', targets: ['box'], fill: '#0000ff', duration: 200, ease: 'linear' }], hold: 0 }
	]);

	it('hides what enters later and fades it in', () => {
		expect(path(motionFrameAt(s, 0).document, 'box').opacity).toBe(0);
		expect(path(motionFrameAt(s, 200).document, 'box').opacity).toBeCloseTo(1 - 0.5 ** 3, 3);
		expect(path(motionFrameAt(s, 400).document, 'box').opacity).toBeUndefined();
		// Things that never enter show from the start.
		expect(path(motionFrameAt(s, 0).document, 'dot').opacity).toBeUndefined();
	});

	it('moves with a transform and blends colours, frame by frame', () => {
		expect(path(motionFrameAt(s, 600).document, 'box').transform).toEqual([1, 0, 0, 1, 50, 0]);
		expect(path(motionFrameAt(s, 800).document, 'box').transform).toEqual([1, 0, 0, 1, 100, 0]);
		expect(path(motionFrameAt(s, 1000).document, 'box').fill).toBe('#0000ff');
		const mid = path(motionFrameAt(s, 900).document, 'box').fill as string;
		expect(mid).not.toBe('#ef4444');
		expect(mid).not.toBe('#0000ff');
	});

	it('draws strokes on with a trim effect and turns about the centre', () => {
		const d = scene([{ id: 'one', run: [{ type: 'draw', targets: ['line'], duration: 1000, ease: 'linear' }, { type: 'rotate', targets: ['box'], by: 90, ease: 'linear', duration: 100 }] }]);
		const line = path(motionFrameAt(d, 500).document, 'line');
		expect(line.effects?.[0]).toMatchObject({ id: MOTION_DRAW_EFFECT_ID, type: 'trim', params: { start: 0, end: 50 } });
		expect(path(motionFrameAt(d, 2000).document, 'line').effects ?? []).toEqual([]);
		const m = path(motionFrameAt(d, 2000).document, 'box').transform!;
		// 90° about (50, 50): (x, y) → (100 − y, x).
		expect(m.map((v) => Math.round(v))).toEqual([0, 1, -1, 0, 100, 0]);
	});

	it('morphs into another shape, follows a path and tweens live effects', () => {
		const d = scene([
			{ id: 'one', run: [
				{ type: 'morph', targets: ['box'], into: 'circle', duration: 400 },
				{ type: 'follow', targets: ['dot'], path: 'track', duration: 400, ease: 'linear', with: 'previous' },
				{ type: 'effect', targets: ['spin'], effect: 'tw', param: 'angle', to: 90, duration: 400, with: 'previous' }
			] }
		]);
		const end = motionFrameAt(d, 400).document;
		const box = path(end, 'box');
		expect(box.visible).not.toBe(false);
		expect(box.fill).toBe('#22c55e');
		expect(box.subpaths[0].anchors[0].out).toBeTruthy(); // the circle's curves
		const mid = path(motionFrameAt(d, 200).document, 'box');
		expect(mid.subpaths[0].anchors.length).toBeGreaterThan(4); // an in-between
		// The dot's centre (320, 140) rides the track from (0, 100) to (400, 100).
		expect(path(motionFrameAt(d, 200).document, 'dot').transform).toEqual([1, 0, 0, 1, -120, -40]);
		expect((path(end, 'spin').effects![0].params as { angle: number }).angle).toBe(90);
	});

	it('returns to rest after a pulse and recolours through control values', () => {
		const d = scene([{ id: 'one', run: [{ type: 'pulse', targets: ['dot'], duration: 400 }] }], { controls: [{ name: 'accent', type: 'color', default: '#0ea5e9' }] });
		const peak = path(motionFrameAt(d, 200).document, 'dot').transform!;
		expect(peak[0]).toBeCloseTo(1.15);
		expect(path(motionFrameAt(d, 400).document, 'dot').transform).toBeUndefined();
		expect(path(motionFrameAt(d, 0, { values: { accent: '#ff00ff' } }).document, 'dot').fill).toBe('#ff00ff');
	});

	it('renders SVG with the camera as the viewBox', () => {
		const d = scene([{ id: 'one', camera: { x: 10, y: 20, width: 200, height: 100 }, run: [] }]);
		const svg = motionFrameToSvg(d, 0);
		expect(svg).toMatch(/viewBox="10 20 200 100"/);
		expect(svg).toContain('id="box"');
	});
});

describe('checkMotionScene', () => {
	it('reports every issue code', () => {
		const reported = new Set<MotionIssueCode>();
		const collect = (s: MotionScene) => checkMotionScene(s).forEach((i) => reported.add(i.code));
		collect(scene([]));
		collect(
			scene(
				[
					{ id: 'x', camera: { x: 0, y: 0, width: 100, height: 100 }, run: [
						{ type: 'enter', targets: ['bx'] },
						{ type: 'follow', targets: ['dot'], path: 'nope' },
						{ type: 'follow', targets: ['dot'], path: 'pair' },
						{ type: 'morph', targets: ['box'], into: 'nothing' },
						{ type: 'effect', targets: ['spin'], effect: 'tww', param: 'angle', to: 1 },
						{ type: 'effect', targets: ['spin'], effect: 'tw', param: 'angel', to: 1 },
						{ type: 'style', targets: ['box'], fill: 'not-a-colour' },
						{ type: 'fade', targets: ['box'], to: 0.5, duration: 50 },
						{ type: 'enter', targets: ['line'], style: 'wipe' },
						{ type: 'scale', targets: ['box'], to: 1.2, ease: 'spring-gentle', duration: 300 }
					] },
					{ id: 'x', run: [] },
					{ id: 'y', camera: { frame: 'ghost' }, run: [] },
					{ id: 'z', camera: { x: 0, y: 0, width: 0, height: 10 }, run: [{ type: 'enter', targets: ['dot'] }] },
					{ id: 'w', run: [{ type: 'enter', targets: ['dot'] }, { type: 'move', targets: ['box'], by: { x: 900, y: 0 } }, { type: 'move', targets: ['box'], by: { x: 1, y: 0 }, with: 'previous', delay: 100 }] },
					{ id: 'v', run: [{ type: 'exit', targets: ['dot'] }, { type: 'pulse', targets: ['dot'] }] }
				],
				{ target: [100, 200], controls: [{ name: 'accent', type: 'color', default: '#123456' }] }
			)
		);
		collect(scene([{ id: 'g', run: [{ type: 'style', targets: ['box'], fill: '#000000' }] }], { artwork: { ...ARTWORK, nodes: [{ ...ARTWORK.nodes[0], fill: { type: 'linear', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] } } as VectorPathNode] }, target: [0, 0.5] }));
		expect([...reported].sort()).toEqual(Object.keys(MOTION_ISSUE_CODES).sort());
	});

	it('suggests the id that was meant', () => {
		const issues = checkMotionScene(scene([{ id: 'one', run: [{ type: 'enter', targets: ['bx'] }] }]));
		expect(issues[0]).toMatchObject({ code: 'unknown-target', severity: 'error', shot: 'one', command: 0, ids: ['bx'] });
		expect(issues[0].message).toContain('"bx" (did you mean "box"?)');
	});
});

describe('applyMotionEdits', () => {
	const base = scene([{ id: 'one', run: [{ type: 'enter', targets: ['box'] }] }]);

	it('is all or nothing, naming the op that failed', () => {
		const result = applyMotionEdits(base, [
			{ op: 'insert_shots', shots: [{ id: 'two', run: [] }] },
			{ op: 'add_commands', shot: 'tow', commands: [{ type: 'fade', targets: ['box'], to: 0 }] }
		]);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain('op 2 (add_commands): There is no shot "tow" (did you mean "two"?)');
	});

	it('refuses edits that add an error but not unrelated edits to a broken scene', () => {
		const refused = applyMotionEdits(base, { op: 'add_commands', shot: 'one', commands: [{ type: 'fade', targets: ['bxo'], to: 0 }] });
		expect(!refused.ok && refused.error).toMatch(/did you mean "box"/);
		const broken: MotionScene = { ...base, shots: [{ id: 'one', run: [{ type: 'enter', targets: ['gone'] }] }] };
		expect(applyMotionEdits(broken, { op: 'set_settings', name: 'renamed' }).ok).toBe(true);
	});

	it('updates, moves and deletes shots and commands', () => {
		const r = applyMotionEdits(base, [
			{ op: 'insert_shots', shots: [{ id: 'zero', run: [] }], at: 0 },
			{ op: 'move_shot', shot: 'zero', to: 1 },
			{ op: 'add_commands', shot: 'one', commands: [{ type: 'pulse', targets: ['box'] }, { type: 'shake', targets: ['box'] }] },
			{ op: 'update_command', shot: 'one', command: 1, set: { count: 2 } },
			{ op: 'delete_commands', shot: 'one', commands: [2] },
			{ op: 'update_shot', shot: 'one', set: { label: 'Hello', hold: 100 } },
			{ op: 'delete_shots', shots: ['zero'] }
		]);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.scene.shots).toEqual([{ id: 'one', label: 'Hello', hold: 100, run: [{ type: 'enter', targets: ['box'] }, { type: 'pulse', targets: ['box'], count: 2 }] }]);
	});
});

describe('AnimationEditorController', () => {
	it('edits with undo, plays on a manual clock and refuses edits while read-only', async () => {
		const clock = new ManualClock();
		const changes: MotionScene[] = [];
		const c = new AnimationEditorController({ scene: createMotionScene(ARTWORK), clock, onChange: (s) => changes.push(s) });
		expect(c.apply({ op: 'insert_shots', shots: [{ id: 'one', run: [{ type: 'enter', targets: ['box'], duration: 400 }], hold: 0 }] }).ok).toBe(true);
		expect(c.getState().duration).toBe(400);
		expect(changes).toHaveLength(1);
		c.play();
		await clock.advance(200);
		expect(c.getState().time).toBe(200);
		expect(c.getState().currentShot).toBe('one');
		expect(path(c.frame().document, 'box').opacity).toBeGreaterThan(0);
		c.pause();
		expect(c.undo()).toBe(true);
		expect(c.getState().scene.shots).toEqual([]);
		c.setReadOnly(true);
		const refused = c.apply({ op: 'set_settings', name: 'x' });
		expect(refused).toEqual({ ok: false, error: 'The animation is read-only.' });
		expect(c.getState().error).toBe('The animation is read-only.');
		c.destroy();
	});

	it('reconnects after destroy when subscribed again (React StrictMode remounts)', () => {
		const c = new AnimationEditorController({ scene: scene([{ id: 'one', run: [{ type: 'enter', targets: ['box'], duration: 400 }] }]) });
		c.destroy();
		const seen: number[] = [];
		c.subscribe((s) => seen.push(s.time));
		c.seek(200);
		expect(c.getState().time).toBe(200);
		expect(seen).toContain(200);
		c.destroy();
	});

	it('loads JSON, clearing history, and selects shots', () => {
		const c = new AnimationEditorController();
		c.apply({ op: 'set_settings', name: 'first' });
		expect(c.load(JSON.stringify(scene([{ id: 'one', run: [] }])), { clearHistory: true }).ok).toBe(true);
		expect(c.getState().canUndo).toBe(false);
		c.select({ shot: 'one', command: 3 });
		expect(c.getState().selection).toEqual({ shot: 'one' });
		expect(c.load('{').ok).toBe(false);
		c.destroy();
	});
});

// The scene of the demo's Animation tab (apps/demo/src/components/AnimationTab.tsx).
const animateOf = (out: { motion: { animate?: FlairSvgAnimation[] } }) => out.motion.animate ?? [];

const DEMO_SCENE: MotionScene = {
	version: 1,
	name: 'Badge reveal',
	artwork: {
		width: 640,
		height: 360,
		background: '#0f172a',
		nodes: [
			{ id: 'ring', type: 'path', fill: null, stroke: '#38bdf8', strokeWidth: 6, subpaths: [ellipseSubpath({ x: 220, y: 80, width: 200, height: 200 })], effects: [createVectorEffect('wiggle', 'wobble', { size: 4, detail: 8, time: 0 })!] },
			{ id: 'badge', type: 'path', fill: '#f43f5e', stroke: null, subpaths: [ellipseSubpath({ x: 250, y: 110, width: 140, height: 140 })] },
			{ id: 'check', type: 'path', fill: null, stroke: '#ffffff', strokeWidth: 12, strokeLinecap: 'round', strokeLinejoin: 'round', subpaths: [{ closed: false, anchors: [{ x: 285, y: 182 }, { x: 310, y: 208 }, { x: 356, y: 156 }] }] },
			{ id: 'arc', type: 'path', visible: false, fill: null, stroke: '#94a3b8', subpaths: [{ closed: false, anchors: [{ x: 60, y: 300, out: { x: 160, y: 20 } }, { x: 580, y: 60, in: { x: 420, y: 0 } }] }] },
			{ id: 'spark', type: 'path', fill: '#fde047', stroke: null, subpaths: [starSubpath({ x: 48, y: 288, width: 24, height: 24 }, 4, 0.35)] },
			{ id: 'tile', type: 'path', fill: '#a78bfa', stroke: null, subpaths: [rectSubpath({ x: 500, y: 250, width: 70, height: 70 }, 10)] },
			{ id: 'star', type: 'path', visible: false, fill: '#facc15', stroke: null, subpaths: [starSubpath({ x: 495, y: 245, width: 80, height: 80 }, 5, 0.45)] }
		]
	},
	loop: 'loop',
	shots: [
		{ id: 'badge', run: [{ type: 'enter', targets: ['ring'], style: 'draw', duration: 900 }, { type: 'enter', targets: ['badge'], style: 'pop', with: 'previous', delay: 300 }, { type: 'enter', targets: ['check'], style: 'draw', duration: 500 }] },
		{ id: 'spark', run: [{ type: 'enter', targets: ['spark'], duration: 200 }, { type: 'follow', targets: ['spark'], path: 'arc', rotate: true, duration: 1200 }, { type: 'exit', targets: ['spark'], style: 'shrink' }], hold: 200 },
		{ id: 'star', run: [{ type: 'enter', targets: ['tile'], style: 'grow' }, { type: 'morph', targets: ['tile'], into: 'star' }, { type: 'effect', targets: ['ring'], effect: 'wobble', param: 'time', to: 2, duration: 900, with: 'previous' }] },
		{ id: 'focus', camera: { frame: 'ring', padding: 40 }, run: [{ type: 'pulse', targets: ['badge'], count: 2, duration: 800 }], hold: 800 }
	]
};

describe('Flair export', () => {
	const s = scene(
		[
			{ id: 'one', run: [{ type: 'enter', targets: ['box'], duration: 500 }, { type: 'draw', targets: ['line'], duration: 600 }], hold: 300 },
			{ id: 'two', camera: { frame: 'dot' }, run: [{ type: 'move', targets: ['box'], by: { x: 50, y: 0 }, duration: 400 }, { type: 'pulse', targets: ['dot'], duration: 300 }, { type: 'style', targets: ['pair'], fill: '#000000', duration: 200 }] }
		],
		{ name: 'Logo Reveal', controls: [{ name: 'accent', type: 'color', default: '#ef4444', label: 'Accent' }], presets: [{ name: 'Sea', values: { accent: '#0ea5e9' } }], loop: 'loop' }
	);

	it('matches eases to Flair curves', () => {
		expect(flairEaseFor('linear')).toBe('linear');
		expect(flairEaseFor(MOTION_EASE_OUT)).toBe('out');
		expect(flairEaseFor('ease-in-back')).toBeUndefined();
	});

	it('writes cubic-bezier eases as curves, keeping Flair names where they match', () => {
		expect(flairCurveFor(MOTION_EASE_OUT)).toBe('out');
		expect(flairCurveFor('ease-in-back')).toEqual([0.36, 0, 0.66, -0.56]);
		expect(flairCurveFor({ type: 'cubic-bezier', x1: 0.2, y1: 0.8, x2: 0.4, y2: 1 })).toEqual([0.2, 0.8, 0.4, 1]);
		expect(flairCurveFor('ease-in-back', false)).toBeUndefined();
		for (const ease of ['spring', 'elastic', 'ease-out-elastic', 'hold', { type: 'spring', stiffness: 300 }] as const) expect(flairCurveFor(ease)).toBeUndefined();
	});

	it('exports a back-eased move as one change, and samples it with curves off', () => {
		const back = scene([{ id: 'one', run: [{ type: 'move', targets: ['box'], by: { x: 100, y: 0 }, duration: 500, ease: 'ease-in-back' }] }]);
		const out = toFlairSvgMotion(back);
		const moves = (out.motion.animate ?? []).filter((a) => a.id === 'box' && a.attrs?.transform);
		expect(moves).toHaveLength(1);
		expect(moves[0]).toMatchObject({ ms: 500, ease: [0.36, 0, 0.66, -0.56] });
		expect(moves[0].attrs?.transform?.[1]).toMatch(/^translate\(100 0\)/);
		expect(out.sampled).toBe(0);
		const old = toFlairSvgMotion(back, { curves: false });
		expect(old.sampled).toBe(15);
		expect(old.motion.animate?.every((a) => typeof a.ease === 'string')).toBe(true);
	});

	it('samples overshooting curves on colours and opacity, which cannot pass their ends', () => {
		const pop = scene([{ id: 'one', run: [{ type: 'style', targets: ['box'], fill: '#000000', duration: 300, ease: 'ease-out-back' }, { type: 'style', targets: ['dot'], fill: '#000000', duration: 300, ease: 'ease-in' }] }]);
		const animate = toFlairSvgMotion(pop).motion.animate ?? [];
		expect(animate.filter((a) => a.id === 'box').length).toBeGreaterThan(1);
		expect(animate.filter((a) => a.id === 'dot')).toEqual([expect.objectContaining({ ms: 300, ease: [0.42, 0, 1, 1], attrs: { fill: ['#0ea5e9', '#000000'] } })]);
	});

	it('samples only the demo scene\'s shape changes', () => {
		const out = toFlairSvgMotion(DEMO_SCENE);
		const old = toFlairSvgMotion(DEMO_SCENE, { curves: false, behaviors: false });
		expect(old.sampled).toBe(116);
		// The badge's back-eased pop, the spark's ease-in exit and the badge's pulse are now one change each.
		expect(out.sampled).toBe(54);
		// The spark's follow is one `along` on a wrapper, turning with a copy of the arc.
		expect(animateOf(out).filter((a) => a.along)).toEqual([{ id: 'spark--follow', along: 'spark--follow-route', orient: true, delay: 2200, ms: 1200, ease: 'in-out', at: [0, 1] }]);
		expect(out.motion.svg).toContain('<defs><path id="spark--follow-route" d="M60 300C160 20 420 0 580 60" fill="none"/></defs>');
		expect(out.motion.svg).toMatch(/<g id="spark--follow" transform="translate\(60 300\) rotate\(-70\.\d+\)"><g id="spark--follow-centre" transform="translate\(-60 -300\)"><path id="spark"/);
		expect(animateOf(out).filter((a) => a.behavior)).toEqual([expect.objectContaining({ id: 'badge', ease: 'linear', behavior: { type: 'pulse', count: 2 } })]);
		const animate = out.motion.animate ?? [];
		expect(animate).toContainEqual(expect.objectContaining({ id: 'badge', delay: 300, ms: 600, ease: [0.34, 1.56, 0.64, 1] }));
		expect(animate.filter((a) => a.id === 'spark' && Array.isArray(a.ease)).map((a) => Object.keys(a.attrs ?? {})[0]).sort()).toEqual(['opacity', 'transform']);
		// What is left: the morph and wobble (each path's d).
		const steps = animate.filter((a) => a.ease === 'linear' && !a.behavior).map((a) => `${a.id} ${Object.keys(a.attrs ?? {})[0]}`);
		expect(new Set(steps)).toEqual(new Set(['ring d', 'tile d']));
		expect(out.duration).toBe(old.duration);
	});

	it('writes one exact change where Flair can, and samples the rest', () => {
		const out = toFlairSvgMotion(s);
		const { svg, animate = [] } = out.motion;
		expect(svg).toMatch(/^<svg[^>]*viewBox="0 0 400 200"/);
		expect(svg).not.toMatch(/<animate|<set\b|<script/);
		for (const a of animate) if (a.id) expect(svg).toContain(`id="${a.id}"`);
		expect(animate).toContainEqual({ id: 'box', ms: 500, ease: 'out', attrs: { opacity: [0, 1] } });
		expect(animate).toContainEqual(expect.objectContaining({ id: 'line', delay: 500, ms: 600, ease: 'in-out', draw: [0, 1] }));
		const move = animate.find((a) => a.id === 'box' && a.attrs?.transform);
		expect(move?.attrs?.transform?.[1]).toMatch(/^translate\(50 0\)/);
		expect(animate.some((a) => a.view)).toBe(true);
		// Group paint goes to each path in it.
		expect(animate.filter((a) => a.attrs?.fill?.[1] === '#000000').map((a) => a.id).sort()).toEqual(['a', 'b']);
		// The pulse is one change with a behaviour (sampled into linear steps for Flair before 0.38).
		expect(animate.filter((a) => a.id === 'dot' && a.attrs?.transform)).toEqual([expect.objectContaining({ ease: 'linear', behavior: { type: 'pulse', count: 1 } })]);
		expect(out.sampled).toBe(0);
		expect(toFlairSvgMotion(s, { behaviors: false }).sampled).toBeGreaterThan(3);
		expect(out.hold).toBe(600);
		expect(out.duration).toBe(compileMotionScene(s).duration);
	});

	it('makes a catalog effect with colour controls and an editor document', () => {
		const effect = toFlairVectorEffect(s, { category: 'loader', tags: ['logo'] });
		expect(effect).toMatchObject({ kind: 'vector', id: 'logo-reveal', name: 'Logo Reveal', category: 'loader', tags: ['logo'], presets: s.presets });
		expect(effect.motion.svg).toContain("<!-- {{accent: color default=#EF4444 label='Accent'}} -->");
		expect(effect.motion.svg).toContain('fill="{{accent}}"');
		expect(effect.motion.svg.replace(/<!--.*?-->/, '')).not.toMatch(/#ef4444/i);
		const doc = toFlairEffectDocument(s);
		expect(doc).toMatchObject({ version: 1, name: 'Logo Reveal', values: { accent: '#ef4444' }, loop: true, effect: { kind: 'vector' } });
	});
});

describe('animation editor tools', () => {
	const setup = (options: Parameters<typeof createAnimationEditorToolProvider>[1] = {}) => {
		const controller = new AnimationEditorController({ scene: createMotionScene(ARTWORK, { name: 'demo' }) });
		const registry = new ToolRegistry();
		registry.register(createAnimationEditorToolProvider(controller, options));
		return { controller, registry };
	};
	const json = (result: { structuredContent?: Record<string, unknown> }) => result.structuredContent as any;

	it('reads the artwork and adds shots and commands, returning their timing', async () => {
		const { registry, controller } = setup();
		const read = json(await registry.callTool('get_animation', {}));
		expect(read.elements.map((e: { id: string }) => e.id)).toEqual(expect.arrayContaining(['box', 'pair', 'a']));
		expect(read.elements.find((e: { id: string }) => e.id === 'spin').effects[0]).toMatchObject({ id: 'tw', type: 'twist', numericParams: { angle: 0 } });
		const added = await registry.callTool('insert_shots', { shots: [{ id: 'intro', label: 'Box arrives', run: [{ type: 'enter', targets: ['box'], style: 'pop' }] }] });
		expect(added.isError).toBeFalsy();
		expect(json(added)).toMatchObject({ added: ['intro'], duration: 1200, shots: [{ id: 'intro', start: 0, end: 1200 }] });
		const cmds = json(await registry.callTool('add_commands', { shot: 'intro', commands: [{ type: 'pulse', targets: ['box'] }] }));
		expect(cmds.added).toEqual([{ index: 1, type: 'pulse', start: 600, end: 1200 }]);
		expect(controller.getState().scene.shots[0].run).toHaveLength(2);
		const updated = json(await registry.callTool('update_command', { shot: 'intro', command: 1, set: { count: 2 } }));
		expect(updated.command).toMatchObject({ index: 1, type: 'pulse', count: 2 });
		const frame = json(await registry.callTool('render_animation_frame', { shot: 'intro', at: 'end' }));
		expect(frame.svg).toContain('<svg');
		const undone = json(await registry.callTool('undo_animation', {}));
		expect(undone).toEqual({ undone: true, label: 'Change command' });
	});

	it('fails usefully without changing anything', async () => {
		const { registry, controller } = setup();
		const badSchema = await registry.callTool('add_commands', { shot: 'x', commands: [{ type: 'enter', targets: ['box'], speed: 2 }] });
		expect(badSchema.isError).toBe(true);
		await registry.callTool('insert_shots', { shots: [{ id: 'intro', run: [] }] });
		const unknown = await registry.callTool('add_commands', { shot: 'intro', commands: [{ type: 'enter', targets: ['boxx'] }] });
		expect(unknown.isError).toBe(true);
		expect((unknown.content[0] as { text: string }).text).toContain('did you mean "box"');
		const noShot = await registry.callTool('delete_shots', { shots: ['intr'] });
		expect((noShot.content[0] as { text: string }).text).toContain('did you mean "intro"');
		expect(controller.getState().scene.shots).toEqual([{ id: 'intro', run: [] }]);
	});

	it('batches edits with a dry run, exports to Flair and replaces the artwork from SVG', async () => {
		const { registry, controller } = setup();
		const ops = [
			{ op: 'insert_shots', shots: [{ id: 'one', run: [{ type: 'enter', targets: ['dot'] }] }] },
			{ op: 'add_commands', shot: 'one', commands: [{ type: 'move', targets: ['dot'], by: { x: -100, y: 0 } }] }
		];
		const dry = json(await registry.callTool('edit_animation', { ops, dry_run: true }));
		expect(dry).toMatchObject({ dry_run: true, duration: 1900 });
		expect(controller.getState().scene.shots).toEqual([]);
		expect(json(await registry.callTool('edit_animation', { ops })).duration).toBe(1900);
		expect(controller.getState().canUndo).toBe(true);
		const effect = json(await registry.callTool('export_flair_effect', { category: 'icon' }));
		expect(effect).toMatchObject({ kind: 'vector', id: 'demo', category: 'icon' });
		expect((await registry.callTool('export_flair_effect', { curves: 'no' })).isError).toBe(true);
		await registry.callTool('add_commands', { shot: 'one', commands: [{ type: 'move', targets: ['dot'], by: { x: 50, y: 0 }, duration: 400, ease: 'ease-out-back' }] });
		const curved = json(await registry.callTool('export_flair_motion', {}));
		expect(curved.motion.animate).toContainEqual(expect.objectContaining({ id: 'dot', ms: 400, ease: [0.34, 1.56, 0.64, 1] }));
		expect(json(await registry.callTool('export_flair_motion', { curves: false })).sampled).toBe(curved.sampled + 12);
		const replaced = await registry.callTool('set_animation_artwork_svg', { svg: '<svg viewBox="0 0 100 100"><circle id="dot" cx="50" cy="50" r="10" fill="#000"/></svg>' });
		expect(replaced.isError).toBeFalsy();
		expect(json(replaced).elements.map((e: { id: string }) => e.id)).toEqual(['dot']);
		const refused = await registry.callTool('set_animation_artwork_svg', { svg: '<svg viewBox="0 0 10 10"><rect id="other" width="5" height="5"/></svg>' });
		expect(refused.isError).toBe(true);
	});

	it('hides write tools while read-only', () => {
		const { registry } = setup({ readOnly: 'Locked for review' });
		const names = registry.listTools().tools.map((t) => t.name);
		expect(names).toContain('get_animation');
		expect(names).not.toContain('add_commands');
	});
});

describe('Flair motion primitives', () => {
	const transformOf = (doc: VectorDocument, id: string) => path(doc, id).transform;
	const offsetX = (doc: VectorDocument, id: string) => transformOf(doc, id)?.[4] ?? 0;

	it('names the Flair primitive each command plays', () => {
		expect(motionFlairPrimitive({ type: 'enter', targets: ['box'] })).toBe('entrance.fade');
		expect(motionFlairPrimitive({ type: 'enter', targets: ['box'], style: 'zoom' })).toBe('entrance.zoom');
		expect(motionFlairPrimitive({ type: 'exit', targets: ['box'], style: 'undraw' })).toBe('exit.undraw');
		expect(motionFlairPrimitive({ type: 'color-pulse', targets: ['box'] })).toBe('emphasis.color-pulse');
		expect(motionFlairPrimitive({ type: 'rotate', targets: ['box'], by: 360 })).toBe('emphasis.spin');
		expect(motionFlairPrimitive({ type: 'follow', targets: ['box'], path: 'track' })).toBe('path.follow');
		expect(motionFlairPrimitive({ type: 'move', targets: ['box'], by: { x: 1, y: 0 } })).toBeUndefined();
	});

	it('times new commands by their Flair defaults and zooms and rises in', () => {
		const s = scene([{ id: 'one', run: [{ type: 'enter', targets: ['box'], style: 'zoom' }, { type: 'enter', targets: ['dot'], style: 'rise' }, { type: 'teeter', targets: ['box'] }, { type: 'wave', targets: ['dot'] }, { type: 'wiggle', targets: ['box'] }, { type: 'color-pulse', targets: ['dot'] }] }]);
		expect(compileMotionScene(s).commands.map((c) => c.duration)).toEqual([600, 600, 600, 1000, 1500, 600]);
		const start = motionFrameAt(s, 0).document;
		expect(path(start, 'box').opacity).toBe(0);
		expect(transformOf(start, 'box')?.[0]).toBeCloseTo(1.6, 6);
		// The rise starts when the zoom ends, 20 units low.
		expect(transformOf(motionFrameAt(s, 600).document, 'dot')?.[5]).toBeCloseTo(20, 6);
		expect(transformOf(motionFrameAt(s, 600).document, 'box')).toBeUndefined();
		const risen = motionFrameAt(s, 1200).document;
		expect(transformOf(risen, 'dot')).toBeUndefined();
		expect(path(risen, 'dot').opacity).toBeUndefined();
	});

	it('swings emphasis round the pose and comes back to rest', () => {
		const s = scene([{ id: 'one', run: [{ type: 'teeter', targets: ['box'] }, { type: 'wave', targets: ['dot'], with: 'previous' }, { type: 'color-pulse', targets: ['a'], color: '#000000', with: 'previous' }, { type: 'shake', targets: ['b'], axis: 'vertical', with: 'previous' }] }]);
		const mid = motionFrameAt(s, 125).document;
		expect(transformOf(mid, 'box')).toBeDefined();
		expect(transformOf(mid, 'dot')?.[5]).toBeLessThan(0);
		expect(path(mid, 'a').fill).not.toBe('#f59e0b');
		expect(transformOf(mid, 'b')?.[5]).not.toBe(0);
		const end = motionFrameAt(s, 1000).document;
		for (const id of ['box', 'dot', 'b']) (transformOf(end, id) ?? [1, 0, 0, 1, 0, 0]).forEach((v, i) => expect(v).toBeCloseTo([1, 0, 0, 1, 0, 0][i], 6));
		expect(path(end, 'a').fill).toBe('#f59e0b');
	});

	it('wiggles the same way every time, each target on its own seed', () => {
		const s = scene([{ id: 'one', run: [{ type: 'wiggle', targets: ['box', 'dot'], amount: 10, rotate: 15 }] }]);
		const at = (t: number) => motionFrameAt(s, t).document;
		expect(offsetX(at(700), 'box')).toBe(offsetX(at(700), 'box'));
		expect(offsetX(at(700), 'box')).not.toBe(offsetX(at(700), 'dot'));
		expect(offsetX(at(0), 'box')).toBe(0);
		expect(transformOf(at(1500), 'box')).toBeUndefined();
		const seeded = scene([{ id: 'one', run: [{ type: 'wiggle', targets: ['box', 'dot'], amount: 10, seed: 5 }] }]);
		const a = path(motionFrameAt(seeded, 700).document, 'box').transform!;
		const b = path(motionFrameAt(seeded, 700).document, 'dot').transform!;
		expect([a[4], a[5]]).toEqual([b[4], b[5]]);
	});

	it('exports emphasis as one change with a Flair behaviour, x and y on their own wriggle channels', () => {
		const s = scene([{ id: 'one', run: [{ type: 'wiggle', targets: ['box'], amount: 10, seed: 3 }, { type: 'teeter', targets: ['dot'] }, { type: 'color-pulse', targets: ['line'], paint: 'stroke', color: '#ff0000' }] }]);
		const out = toFlairSvgMotion(s);
		expect(out.sampled).toBe(0);
		const animate = animateOf(out);
		const wiggle = animate.find((a) => a.id === 'box')!;
		expect(wiggle).toMatchObject({ ms: 1500, ease: 'linear', behavior: { type: 'wriggle', frequency: 3, octaves: 2, seed: 3 } });
		expect(wiggle.attrs!.transform![0]).toMatch(/^translate\(0 0\) rotate\(0 /);
		expect(wiggle.attrs!.transform![1]).toMatch(/^translate\(10 10\) rotate\(0 /);
		expect(animate.find((a) => a.id === 'dot')).toMatchObject({ behavior: { type: 'oscillate', count: 3, decay: 1 } });
		expect(animate.find((a) => a.id === 'line')).toMatchObject({ attrs: { stroke: ['#111111', '#ff0000'] }, behavior: { type: 'pulse', count: 1 } });
		const old = toFlairSvgMotion(s, { behaviors: false });
		expect(old.sampled).toBeGreaterThan(30);
		expect(animateOf(old).some((a) => a.behavior)).toBe(false);
	});

	it('checks new commands: shapes, defaults and paint', () => {
		expect(() => parseMotionScene(scene([{ id: 'one', run: [{ type: 'wiggle', targets: ['box'], octaves: 9, seed: -1 } as never, { type: 'shake', targets: ['box'], axis: 'diagonal' } as never, { type: 'color-pulse', targets: ['box'], paint: 'both' } as never, { type: 'enter', targets: ['box'], style: 'zom' } as never] }]))).toThrow(
			/"octaves" must be a whole number from 1 to 8[\s\S]*"seed" must be a whole number ≥ 0[\s\S]*"axis" must be "horizontal" or "vertical"[\s\S]*"paint" must be "fill" or "stroke"[\s\S]*"zom" \(did you mean "zoom"\?\)/
		);
		const issues = checkMotionScene(scene([{ id: 'one', run: [{ type: 'color-pulse', targets: ['line'] }, { type: 'color-pulse', targets: ['box'], color: 'nope' }] }]));
		expect(issues.map((i) => i.code)).toEqual(['paint-not-color', 'invalid-color']);
		expect(issues[0].message).toContain('"line" has a gradient or no fill');
	});

	it('are reachable through the agent tools, with useful errors', async () => {
		const controller = new AnimationEditorController({ scene: createMotionScene(ARTWORK, { name: 'demo' }) });
		const registry = new ToolRegistry();
		registry.register(createAnimationEditorToolProvider(controller));
		const ok = await registry.callTool('insert_shots', { shots: [{ id: 'hey', run: [{ type: 'enter', targets: ['box'], style: 'rise', distance: 30 }, { type: 'wave', targets: ['box'], count: 3 }] }] });
		expect(ok.isError).toBeFalsy();
		const read = (await registry.callTool('get_animation', {})).structuredContent as any;
		expect(read.shots[0].commands.map((c: { flairPrimitive?: string }) => c.flairPrimitive)).toEqual(['entrance.rise', 'emphasis.wave']);
		const bad = await registry.callTool('add_commands', { shot: 'hey', commands: [{ type: 'wiggle', targets: ['box'], octaves: 0 }] });
		expect(bad.isError).toBe(true);
		expect(JSON.stringify(bad.content)).toMatch(/octaves/);
		expect(controller.getState().scene.shots[0].run).toHaveLength(2);
		const flair = (await registry.callTool('export_flair_motion', { behaviors: false })).structuredContent as any;
		expect(flair.sampled).toBeGreaterThan(0);
		expect((await registry.callTool('export_flair_motion', {})).structuredContent).toMatchObject({ sampled: 0 });
	});
});

describe('Flair clip reveals and follows', () => {
	// The box is 60 × 60 with a 2-unit stroke: Flair pads its clip by 1/60 + 0.02 of the box.
	const P = Math.round((1 / 60 + 0.02) * 1e4) / 1e4;
	const W = Math.round((1 + 2 * (1 / 60 + 0.02)) * 1e4) / 1e4;
	const R = Math.round(Math.hypot(0.5 + 1 / 60 + 0.02, 0.5 + 1 / 60 + 0.02) * 1e4) / 1e4;
	const clipsOf = (s: MotionScene, t: number) => motionFrameAt(s, t).clips;

	it('names the Flair primitives', () => {
		for (const style of ['wipe', 'iris', 'split'] as const) expect(motionFlairPrimitive({ type: 'enter', targets: ['box'], style })).toBe(`entrance.${style}`);
		expect(motionFlairPrimitive({ type: 'exit', targets: ['box'], style: 'wipe' })).toBe('exit.wipe');
	});

	it("reveals through Flair's clips in the node's box units, padded for the stroke", () => {
		const reveal = (extra: Record<string, unknown>) => scene([{ id: 'one', run: [{ type: 'enter', targets: ['box'], ...extra } as never] }]);
		// wipe (default right): the width opens from the left edge.
		expect(clipsOf(reveal({ style: 'wipe' }), 0).box).toEqual([{ shape: 'rect', x: -P, y: -P, width: 0, height: W }]);
		expect(clipsOf(reveal({ style: 'wipe' }), 600).box).toEqual([{ shape: 'rect', x: -P, y: -P, width: W, height: W }]);
		expect(clipsOf(reveal({ style: 'wipe' }), 300).box[0]).toMatchObject({ width: Math.round(W * (1 - 0.5 ** 3) * 1e6) / 1e6 });
		expect(clipsOf(reveal({ style: 'wipe', direction: 'left' }), 0).box).toEqual([{ shape: 'rect', x: 1 + P, y: -P, width: 0, height: W }]);
		expect(clipsOf(reveal({ style: 'wipe', direction: 'up' }), 0).box).toEqual([{ shape: 'rect', x: -P, y: 1 + P, width: W, height: 0 }]);
		// iris: a circle (an ellipse on a box that is not square) from the centre, or a box.
		expect(clipsOf(reveal({ style: 'iris' }), 0).box).toEqual([{ shape: 'circle', cx: 0.5, cy: 0.5, r: 0 }]);
		expect(clipsOf(reveal({ style: 'iris' }), 600).box).toEqual([{ shape: 'circle', cx: 0.5, cy: 0.5, r: R }]);
		expect(clipsOf(reveal({ style: 'iris', shape: 'box' }), 0).box).toEqual([{ shape: 'rect', x: 0.5, y: 0.5, width: 0, height: 0 }]);
		// split: from a line through the middle.
		expect(clipsOf(reveal({ style: 'split' }), 0).box).toEqual([{ shape: 'rect', x: -P, y: 0.5, width: W, height: 0 }]);
		expect(clipsOf(reveal({ style: 'split', orientation: 'vertical' }), 0).box).toEqual([{ shape: 'rect', x: 0.5, y: -P, width: 0, height: W }]);
		// No stroke: just Flair's 0.02.
		expect(clipsOf(scene([{ id: 'one', run: [{ type: 'enter', targets: ['dot'], style: 'wipe' }] }]), 0).dot).toEqual([{ shape: 'rect', x: -0.02, y: -0.02, width: 0, height: 1.04 }]);
	});

	it('wipes out the other way, and opens the clip again on the next enter', () => {
		const s = scene([{ id: 'one', run: [{ type: 'enter', targets: ['box'], style: 'iris' }, { type: 'exit', targets: ['box'], style: 'wipe' }, { type: 'enter', targets: ['box'], delay: 100 }] }]);
		expect(compileMotionScene(s).commands[1].duration).toBe(450);
		expect(clipsOf(s, 600).box).toEqual([{ shape: 'rect', x: -P, y: -P, width: W, height: W }, { shape: 'circle', cx: 0.5, cy: 0.5, r: R }]);
		// The edge travels right: the left of the box goes first.
		expect(clipsOf(s, 1050).box[0]).toEqual({ shape: 'rect', x: 1 + P, y: -P, width: 0, height: W });
		// The fade in opens the clip at once.
		expect(clipsOf(s, 1151).box[0]).toEqual({ shape: 'rect', x: -P, y: -P, width: W, height: W });
		expect(path(motionFrameAt(s, 1151).document, 'box').opacity).toBeLessThan(0.1);
		expect(checkMotionScene(s).map((i) => i.code)).toEqual([]);
		const late = scene([{ id: 'one', run: [{ type: 'enter', targets: ['box'], style: 'wipe' }, { type: 'exit', targets: ['box'], style: 'wipe' }, { type: 'pulse', targets: ['box'] }] }]);
		expect(checkMotionScene(late).map((i) => i.code)).toEqual(['exit-hidden']);
	});

	it('draws the frame inside a group clipped in objectBoundingBox units', () => {
		const s = scene([{ id: 'one', run: [{ type: 'enter', targets: ['box'], style: 'iris' }] }]);
		const svg = motionFrameToSvg(s, 300, { idPrefix: 'ae-', pretty: false });
		expect(svg).toContain(`<clipPath id="ae-reveal-box-0" clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="`);
		expect(svg).toMatch(/<g clip-path="url\(#ae-reveal-box-0\)"><path id="box"[^>]*\/><\/g>/);
		expect(motionFrameToSvg(scene([]), 0)).not.toContain('clip-path');
	});

	it('fades a straight line it cannot clip, with a warning', () => {
		const s = scene([{ id: 'one', run: [{ type: 'enter', targets: ['line'], style: 'split' }] }]);
		expect(path(motionFrameAt(s, 0).document, 'line').opacity).toBe(0);
		expect(motionFrameAt(s, 0).clips).toEqual({});
		const issue = checkMotionScene(s).find((i) => i.code === 'reveal-no-box');
		expect(issue).toMatchObject({ severity: 'warning', ids: ['line'] });
		expect(issue?.message).toContain('use style "draw"');
	});

	it('exports a wrapper group and its animated clip shape exactly, as Flair writes them', () => {
		const s = scene([{ id: 'one', run: [{ type: 'enter', targets: ['box'], style: 'wipe' }, { type: 'enter', targets: ['dot'], style: 'iris', with: 'previous' }, { type: 'exit', targets: ['box'], style: 'wipe', direction: 'down' }] }]);
		const out = toFlairSvgMotion(s);
		const { svg, animate = [] } = out.motion;
		expect(out.sampled).toBe(0);
		expect(svg).toContain(`<clipPath id="box--reveal-clip" clipPathUnits="objectBoundingBox"><rect id="box--reveal-clip-shape" x="${-P}" y="${-P}" width="0" height="${W}"/></clipPath>`);
		expect(svg).toMatch(/<g id="box--reveal" clip-path="url\(#box--reveal-clip\)"><path id="box"/);
		expect(svg).toContain('<clipPath id="dot--iris-clip" clipPathUnits="objectBoundingBox"><circle id="dot--iris-clip-shape" cx="0.5" cy="0.5" r="0"/>');
		expect(animate).toContainEqual({ id: 'box--reveal-clip-shape', ms: 600, ease: 'out', attrs: { width: [0, W] } });
		expect(animate).toContainEqual({ id: 'dot--iris-clip-shape', ms: 600, ease: 'out', attrs: { r: [0, 0.7354] } });
		// exit.wipe down: the reveal upwards, reversed; Flair's exit ease.
		expect(animate).toContainEqual({ id: 'box--reveal-clip-shape', delay: 600, ms: 450, ease: [0.42, 0, 1, 1], attrs: { y: [-P, 1 + P], height: [W, 0] } });
		for (const a of animate) expect(svg).toContain(`id="${a.id}"`);
	});

	it('follows in the parent\'s units, with moves turning with the path, and exports it as along + orient', () => {
		const art: VectorDocument = {
			width: 400,
			height: 400,
			nodes: [
				{ id: 'route', type: 'path', visible: false, fill: null, stroke: '#999999', subpaths: [{ closed: false, anchors: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }] },
				{ id: 'shrunk', type: 'group', transform: [0.5, 0, 0, 0.5, 0, 0], children: [{ id: 'dart', type: 'path', fill: '#000000', subpaths: [rectSubpath({ x: 300, y: 100, width: 40, height: 40 })] }] }
			]
		};
		const s: MotionScene = { version: 1, name: 'f', artwork: art, shots: [{ id: 'one', run: [{ type: 'follow', targets: ['dart'], path: 'route', rotate: true, ease: 'linear', duration: 1000 }, { type: 'move', targets: ['dart'], by: { x: 10, y: 0 }, ease: 'linear', duration: 1000, with: 'previous' }] }] };
		// The route is (0, 0) → (200, 200) in the group's units, at 45°; the move turns with it.
		const m = path(motionFrameAt(s, 1000).document, 'dart').transform!;
		const centre = { x: m[0] * 320 + m[2] * 120 + m[4], y: m[1] * 320 + m[3] * 120 + m[5] };
		expect(centre.x).toBeCloseTo(200 + 10 * Math.SQRT1_2, 3);
		expect(centre.y).toBeCloseTo(200 + 10 * Math.SQRT1_2, 3);
		expect(Math.atan2(m[1], m[0]) * (180 / Math.PI)).toBeCloseTo(45, 4);
		const out = toFlairSvgMotion(s);
		const { svg, animate = [] } = out.motion;
		expect(out.sampled).toBe(0);
		expect(svg).toContain('<path id="dart--follow-route" d="M0 0L200 200" fill="none"/>');
		expect(svg).toContain('<g id="dart--follow" transform="translate(0 0) rotate(45)"><g id="dart--follow-centre" transform="translate(-320 -120)"><path id="dart"');
		expect(animate).toContainEqual({ id: 'dart--follow', along: 'dart--follow-route', orient: true, ms: 1000, ease: 'linear', at: [0, 1] });
		// The node's own transform leaves the follow to the wrapper.
		expect(animate.find((a) => a.id === 'dart')?.attrs?.transform).toEqual(['translate(0 0) rotate(0 320 120) translate(320 120) scale(1 1) translate(-320 -120)', 'translate(10 0) rotate(0 320 120) translate(320 120) scale(1 1) translate(-320 -120)']);
		// A spring is one change for Flair 0.39; older Flair gets it sampled into linear steps along the path.
		const springScene: MotionScene = { ...s, shots: [{ id: 'one', run: [{ type: 'follow', targets: ['dart'], path: 'route', ease: 'spring', duration: 500 }] }] };
		expect(animateOf(toFlairSvgMotion(springScene))).toEqual([expect.objectContaining({ along: 'dart--follow-route', ms: 500, ease: { spring: { mass: 1, stiffness: 170, damping: 26, velocity: 0 } } })]);
		const sprung = toFlairSvgMotion(springScene, { flair: '0.38' });
		expect(sprung.sampled).toBe(15);
		expect(animateOf(sprung).every((a) => a.along === 'dart--follow-route' && a.ease === 'linear')).toBe(true);
	});

	it('are reachable through the agent tools, with useful errors', async () => {
		const controller = new AnimationEditorController({ scene: createMotionScene(ARTWORK, { name: 'demo' }) });
		const registry = new ToolRegistry();
		registry.register(createAnimationEditorToolProvider(controller));
		const ok = await registry.callTool('insert_shots', {
			shots: [{ id: 'in', run: [{ type: 'enter', targets: ['box'], style: 'wipe', direction: 'left' }, { type: 'enter', targets: ['dot'], style: 'iris', shape: 'box' }, { type: 'enter', targets: ['pair'], style: 'split', orientation: 'vertical' }, { type: 'exit', targets: ['box'], style: 'wipe' }] }]
		});
		expect(ok.isError).toBeFalsy();
		const read = (await registry.callTool('get_animation', {})).structuredContent as any;
		expect(read.shots[0].commands.map((c: { flairPrimitive?: string }) => c.flairPrimitive)).toEqual(['entrance.wipe', 'entrance.iris', 'entrance.split', 'exit.wipe']);
		const frame = (await registry.callTool('render_animation_frame', { shot: 'in', at: 'start' })).structuredContent as any;
		expect(frame.svg).toContain('clipPathUnits="objectBoundingBox"');
		const flair = (await registry.callTool('export_flair_motion', {})).structuredContent as any;
		expect(flair.sampled).toBe(0);
		expect(flair.motion.animate.map((a: FlairSvgAnimation) => a.id)).toEqual(expect.arrayContaining(['box--reveal-clip-shape', 'dot--reveal-clip-shape', 'pair--reveal-clip-shape']));
		for (const [cmd, field] of [[{ type: 'enter', targets: ['box'], style: 'iris', shape: 'star' }, 'shape'], [{ type: 'enter', targets: ['box'], style: 'split', orientation: 'diagonal' }, 'orientation'], [{ type: 'exit', targets: ['box'], style: 'iris' }, '']] as const) {
			const bad = await registry.callTool('add_commands', { shot: 'in', commands: [cmd] });
			expect(bad.isError).toBe(true);
			expect(JSON.stringify(bad.content)).toContain(field);
		}
		expect(controller.getState().scene.shots[0].run).toHaveLength(4);
		await registry.callTool('add_commands', { shot: 'in', commands: [{ type: 'enter', targets: ['line'], style: 'wipe' }] });
		const check = (await registry.callTool('check_animation', {})).structuredContent as any;
		expect(JSON.stringify(check)).toContain('reveal-no-box');
		expect(() => parseMotionScene(scene([{ id: 'one', run: [{ type: 'enter', targets: ['box'], style: 'iris', shape: 'star' } as never] }]))).toThrow(/"shape" must be one of circle, box/);
	});
});

describe('timing: springs, repeats, stepped time and geometric zoom', () => {
	const rotationAt = (s: MotionScene, t: number, id = 'box') => {
		const m = path(motionFrameAt(s, t).document, id).transform;
		return m ? (Math.atan2(m[1], m[0]) * 180) / Math.PI : 0;
	};

	it('lets a spring set its own length, and warns when one is cut short', () => {
		expect(springSettleMs(SPRING_PRESETS['spring-quick'])).toBe(Math.round(6.9 / ((20 / (2 * Math.sqrt(300))) * Math.sqrt(300)) * 1000));
		const s = scene([{ id: 'one', run: [{ type: 'scale', targets: ['box'], to: 1.5, ease: 'spring-bouncy' }, { type: 'move', targets: ['dot'], by: { x: 10, y: 0 }, ease: { type: 'spring', stiffness: 100, damping: 15 } }] }]);
		expect(compileMotionScene(s).commands.map((c) => c.duration)).toEqual([springSettleMs(SPRING_PRESETS['spring-bouncy']), springSettleMs({ stiffness: 100, damping: 15 })]);
		// A bouncy spring overshoots before it settles.
		const peak = Math.max(...Array.from({ length: 40 }, (_, i) => path(motionFrameAt(s, i * 20).document, 'box').transform?.[0] ?? 1));
		expect(peak).toBeGreaterThan(1.5);
		const cut = checkMotionScene(scene([{ id: 'one', run: [{ type: 'scale', targets: ['box'], to: 1.5, ease: 'spring-slow', duration: 200 }] }]));
		expect(cut.find((i) => i.code === 'spring-cut-short')).toMatchObject({ measured: 200, needed: springSettleMs(SPRING_PRESETS['spring-slow']) });
	});

	it('repeats in loop, mirror and offset modes', () => {
		const make = (repeatMode: 'loop' | 'mirror' | 'offset') => scene([{ id: 'one', run: [{ type: 'rotate', targets: ['box'], by: 90, ease: 'linear', duration: 100, repeat: 4, repeatMode }] }]);
		expect(compileMotionScene(make('loop')).commands[0]).toMatchObject({ start: 0, end: 400, duration: 400 });
		expect(rotationAt(make('loop'), 150)).toBeCloseTo(45, 6);
		expect(rotationAt(make('mirror'), 150)).toBeCloseTo(45, 6);
		expect(rotationAt(make('mirror'), 125)).toBeCloseTo(67.5, 3);
		expect(rotationAt(make('mirror'), 400)).toBeCloseTo(0, 6);
		expect(rotationAt(make('offset'), 250)).toBeCloseTo(-135, 6); // 225°
		expect(rotationAt(make('offset'), 400)).toBeCloseTo(0, 6); // 360°
		expect(() => parseMotionScene(scene([{ id: 'one', run: [{ type: 'enter', targets: ['box'], repeat: 2 } as never, { type: 'fade', targets: ['box'], to: 0, repeat: 1.5, repeatMode: 'bounce' } as never] }]))).toThrow(/"repeat" is not for enter[\s\S]*"repeat" must be a whole number[\s\S]*"repeatMode" must be one of loop, mirror, offset/);
	});

	it('exports mirrored repeats as one change each with the curve run backwards', () => {
		const s = scene([{ id: 'one', run: [{ type: 'move', targets: ['box'], by: { x: 40, y: 0 }, ease: 'ease-in', duration: 200, repeat: 2, repeatMode: 'mirror' }] }]);
		const out = toFlairSvgMotion(s);
		expect(out.sampled).toBe(0);
		const moves = animateOf(out).filter((a) => a.id === 'box');
		expect(moves.map((a) => [a.delay ?? 0, a.ease])).toEqual([[0, [0.42, 0, 1, 1]], [200, [0, 0, 0.58, 1]]]);
		expect(moves[1].attrs!.transform![0]).toMatch(/^translate\(40 0\)/);
	});

	it('holds poses on stepped time and exports it as a Flair strobe', () => {
		const s = scene([{ id: 'one', run: [{ type: 'move', targets: ['box'], by: { x: 100, y: 0 }, ease: 'linear', duration: 1000 }] }], { steps: 12 });
		const x = (t: number) => path(motionFrameAt(s, t).document, 'box').transform?.[4] ?? 0;
		expect(x(90)).toBeCloseTo(8.333, 2);
		expect(x(160)).toBeCloseTo(8.333, 2);
		expect(x(170)).toBeCloseTo(16.667, 2);
		expect(x(1000)).toBe(100);
		const out = toFlairSvgMotion(s);
		expect(animateOf(out)).toEqual([expect.objectContaining({ id: 'box', ms: 1000, ease: 'linear', strobe: 12 })]);
		expect(toFlairSvgMotion(s, { flair: '0.38' }).sampled).toBeGreaterThan(10);
	});

	it('zooms at a steady rate with geometric scale and cameras', () => {
		const s = scene([{ id: 'one', run: [{ type: 'scale', targets: ['box'], to: 4, ease: 'linear', duration: 1000, geometric: true }] }]);
		expect(path(motionFrameAt(s, 500).document, 'box').transform?.[0]).toBeCloseTo(2, 6);
		const cam = scene([{ id: 'a', run: [{ type: 'wait', duration: 10 }] }, { id: 'b', camera: { x: 150, y: 50, width: 100, height: 50, ms: 1000, ease: 'linear', geometric: true }, run: [] }]);
		const start = compileMotionScene(cam).shots[1].start;
		const mid = motionFrameAt(cam, start + 500).camera;
		expect(mid.width).toBeCloseTo(200, 6);
		// The centre (200, 100) → (200, 75) keeps pace with the size: two thirds of the way when the width has gone 400 → 200 of 400 → 100.
		expect(mid.y + mid.height / 2).toBeCloseTo(100 - 25 * (2 / 3), 3);
		expect(toFlairSvgMotion(s).sampled).toBeGreaterThan(0);
	});

	it('takes the new options through the agent tools', async () => {
		const controller = new AnimationEditorController({ scene: createMotionScene(ARTWORK, { name: 'demo' }) });
		const registry = new ToolRegistry();
		registry.register(createAnimationEditorToolProvider(controller));
		const ok = await registry.callTool('insert_shots', { shots: [{ id: 'spin', run: [{ type: 'rotate', targets: ['box'], by: 90, repeat: 4, repeatMode: 'offset', ease: 'spring-quick', steps: 12 }] }] });
		expect(ok.isError).toBeFalsy();
		expect((ok.structuredContent as any).duration).toBe(springSettleMs(SPRING_PRESETS['spring-quick']) * 4 + 600);
		expect((await registry.callTool('set_animation_settings', { steps: 8 })).isError).toBeFalsy();
		expect(controller.getState().scene.steps).toBe(8);
		const bad = await registry.callTool('set_animation_settings', { steps: 0 });
		expect(bad.isError).toBe(true);
		const flair = (await registry.callTool('export_flair_motion', { flair: '0.36' })).structuredContent as any;
		expect(flair.sampled).toBeGreaterThan(0);
	});
});

describe('importing from Flair', () => {
	const ART_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><path id="dot" d="M40 40h20v20h-20z" fill="{{accent: color default=#0EA5E9 label=\'Accent\'}}"/><path id="line" d="M10 90L190 90" fill="none" stroke="#111111" stroke-width="2"/><path id="route" d="M0 50L200 50" fill="none" stroke="none"/></svg>';

	it('round-trips an exported scene to the same frames', () => {
		const s = scene([
			{ id: 'one', run: [{ type: 'enter', targets: ['box'] }, { type: 'move', targets: ['box'], by: { x: 40, y: 10 }, ease: 'ease-in' }, { type: 'rotate', targets: ['dot'], by: 30, with: 'previous' }, { type: 'draw', targets: ['line'], from: 0 }] },
			{ id: 'two', run: [{ type: 'pulse', targets: ['box'], count: 2 }, { type: 'teeter', targets: ['dot'], with: 'previous' }, { type: 'wiggle', targets: ['a'], amount: 5, seed: 9, with: 'previous' }, { type: 'color-pulse', targets: ['b'], color: '#000000', with: 'previous' }] }
		]);
		const exported = toFlairSvgMotion(s);
		expect(exported.sampled).toBe(0);
		// One Flair step: the import has one shot holding every command at the times they had.
		const { scene: back, notes } = fromFlairSvgMotion(exported.motion, { hold: exported.hold });
		expect(notes).toEqual([]);
		expect(back.shots).toHaveLength(1);
		const types = back.shots[0].run.map((c) => c.type);
		expect(types).toEqual(expect.arrayContaining(['enter', 'move', 'rotate', 'draw', 'pulse', 'teeter', 'wiggle', 'color-pulse']));
		expect(compileMotionScene(back).duration).toBe(compileMotionScene(s).duration);
		for (const t of [0, 300, 700, 1000, 1500, 2100, 2500, 2900]) {
			const a = motionFrameAt(s, t).document;
			const b = motionFrameAt(back, t).document;
			for (const id of ['box', 'dot', 'line', 'a', 'b']) {
				const pa = path(a, id);
				const pb = path(b, id);
				(pa.transform ?? [1, 0, 0, 1, 0, 0]).forEach((v, i) => expect((pb.transform ?? [1, 0, 0, 1, 0, 0])[i]).toBeCloseTo(v, 2));
				expect(pb.opacity ?? 1).toBeCloseTo(pa.opacity ?? 1, 3);
				expect(pb.fill).toEqual(pa.fill);
			}
		}
	});

	it('reads placeholders as colour controls, steps as shots, and follows and views', () => {
		const effect = {
			kind: 'vector' as const,
			id: 'dot-run',
			name: 'Dot run',
			description: 'A dot runs along.',
			category: 'icon',
			tags: [],
			hold: 300,
			trigger: 'hover' as const,
			presets: [{ name: 'Rose', values: { accent: '#f43f5e', size: '3' } }],
			motion: {
				svg: ART_SVG,
				animate: [
					{ id: 'dot', ms: 400, ease: 'out' as const, attrs: { opacity: [0, 1] as const } },
					{ id: 'line', delay: 200, ms: 500, draw: true },
					{ step: 1, view: [0, 0, 100, 50] as const, ms: 300 },
					{ step: 1, id: 'dot', delay: 300, ms: 1000, along: 'route', at: [0, 1] as const, orient: true, ease: { spring: { stiffness: 200, damping: 20 } } },
					{ step: 1, id: 'line', delay: 300, ms: 600, count: [0, 10] as const },
					{ step: 1, id: 'ghost', ms: 200, attrs: { opacity: [1, 0] as const } }
				]
			}
		};
		const { scene: s, notes } = fromFlairVectorEffect(effect);
		expect(s).toMatchObject({ name: 'dot-run', description: 'A dot runs along.', controls: [{ name: 'accent', type: 'color', default: '#0ea5e9', label: 'Accent' }], presets: [{ name: 'Rose', values: { accent: '#f43f5e' } }] });
		expect(path(s.artwork, 'dot').fill).toBe('#0ea5e9');
		expect(s.shots.map((x) => x.id)).toEqual(['step-0', 'step-1']);
		expect(s.shots[0].run).toEqual([
			{ type: 'enter', targets: ['dot'], style: 'fade', duration: 400, ease: MOTION_EASE_OUT },
			{ type: 'draw', targets: ['line'], from: 0, to: 1, duration: 500, ease: expect.anything(), with: 'previous', delay: 200 }
		]);
		expect(s.shots[1]).toMatchObject({ camera: { x: 0, y: 0, width: 100, height: 50, ms: 300 }, hold: 300, run: [{ type: 'follow', path: 'route', rotate: true, ease: { type: 'spring', stiffness: 200, damping: 20 } }] });
		for (const said of [/Each Flair step became a shot/, /"line": count is not part of scenes/, /"ghost" was skipped: the artwork has no element with that id/, /plays on hover/]) expect(notes.join('\n')).toMatch(said);
	});

	it('imports through the agent tool, with a dry run and useful errors', async () => {
		const controller = new AnimationEditorController({ scene: createMotionScene(ARTWORK, { name: 'demo' }) });
		const registry = new ToolRegistry();
		registry.register(createAnimationEditorToolProvider(controller));
		const motion = { svg: ART_SVG, animate: [{ id: 'dot', ms: 600, behavior: { type: 'oscillate', count: 3, decay: 1 }, attrs: { transform: ['translate(0 0)', 'translate(8 0)'] } }] };
		const dry = (await registry.callTool('import_flair_effect', { motion, dry_run: true })).structuredContent as any;
		expect(dry).toMatchObject({ dry_run: true, notes: [], shots: [{ id: 'step-0', commands: 1 }] });
		expect(controller.getState().scene.name).toBe('demo');
		const done = await registry.callTool('import_flair_effect', { motion, name: 'shaker' });
		expect(done.isError).toBeFalsy();
		expect(controller.getState().scene).toMatchObject({ name: 'shaker', shots: [{ run: [{ type: 'shake', targets: ['dot'], amount: 8, count: 3 }] }] });
		expect((await registry.callTool('undo_animation', {})).structuredContent).toMatchObject({ undone: true, label: 'Import Flair effect' });
		const both = await registry.callTool('import_flair_effect', { motion, effect: { kind: 'vector', motion } });
		expect(both.isError).toBe(true);
		expect(JSON.stringify(both.content)).toMatch(/exactly one of/);
		const broken = await registry.callTool('import_flair_effect', { motion: { svg: '<nope/>' } });
		expect(broken.isError).toBe(true);
		expect(JSON.stringify(broken.content)).toMatch(/could not be imported[\s\S]*Nothing was changed/);
	});
});

describe('onion skin and motion paths', () => {
	const s = scene([{ id: 'one', run: [{ type: 'enter', targets: ['dot'], duration: 200 }, { type: 'move', targets: ['box'], by: { x: 100, y: 0 }, ease: 'linear', duration: 1000 }, { type: 'move', targets: ['box'], by: { x: 0, y: 50 }, ease: 'linear', duration: 500 }] }]);

	it('places ghosts either side of the playhead, fading with distance', () => {
		expect(motionGhosts(s, 500, { before: 2, after: 1, spacing: 100 })).toEqual([
			{ time: 400, offset: -1, opacity: 0.35 },
			{ time: 300, offset: -2, opacity: 0.175 },
			{ time: 600, offset: 1, opacity: 0.35 }
		]);
		expect(motionGhosts(s, 50, { before: 3, spacing: 100 })).toEqual([]);
		expect(motionGhosts(s, 900, { before: 2, after: 1, spacing: 'commands' }).map((g) => g.time)).toEqual([200, 0, 1200]);
	});

	it('traces where a node travels, with a dot at each change', () => {
		expect(motionMovingIds(s)).toEqual(['box']);
		const p = motionPath(s, 'box', { step: 250 });
		expect(p.points[0]).toEqual({ t: 0, x: 50, y: 50 });
		expect(p.points.find((q) => q.t === 500)).toEqual({ t: 500, x: 80, y: 50 }); // the move starts at 200 ms
		expect(p.keys.map((k) => [k.x, k.y])).toEqual([[50, 50], [150, 50], [150, 100]]);
		expect(() => motionPath(s, 'nope')).toThrow(/no element "nope"/);
	});

	it('draws ghosts under the frame and paths over it, keeping ids unique', () => {
		const svg = motionStageSvg(s, 600, { onionSkin: { before: 2, spacing: 200 }, motionPaths: true, pretty: false });
		expect(svg.match(/data-onion="before"/g)).toHaveLength(2);
		expect(svg.match(/ id="box"/g)).toHaveLength(1);
		expect(svg.indexOf('data-onion')).toBeLessThan(svg.indexOf(' id="box"'));
		expect(svg.indexOf('data-motion-path="box"')).toBeGreaterThan(svg.indexOf(' id="box"'));
		expect(svg).toMatch(/^<svg[^>]*><rect width="400" height="200" fill="#ffffff"\/><g data-onion/);
		expect(motionStageSvg(s, 600, { pretty: false })).toBe(motionFrameToSvg(s, 600, { pretty: false }));
	});

	it('shows motion to agents in pictures and in numbers', async () => {
		const controller = new AnimationEditorController({ scene: s });
		const registry = new ToolRegistry();
		registry.register(createAnimationEditorToolProvider(controller));
		const frame = (await registry.callTool('render_animation_frame', { time: 600, onion_skin: { before: 1 }, motion_paths: ['box'] })).structuredContent as any;
		expect(frame.svg).toContain('data-onion="before"');
		expect(frame.svg).toContain('data-motion-path="box"');
		const bad = await registry.callTool('render_animation_frame', { time: 600, motion_paths: ['bx'] });
		expect(bad.isError).toBe(true);
		expect(JSON.stringify(bad.content)).toContain('did you mean');
		const path = (await registry.callTool('get_motion_path', { node: 'box', step: 500 })).structuredContent as any;
		expect(path.keys).toHaveLength(3);
		expect((await registry.callTool('get_motion_path', { node: 'ghost' })).isError).toBe(true);
	});
});
