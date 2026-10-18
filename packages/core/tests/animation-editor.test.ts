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
	type MotionIssueCode,
	type MotionScene
} from '../src/animation-editor';
import { ManualClock } from '../src/animation';
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
						{ type: 'fade', targets: ['box'], to: 0.5, duration: 50 }
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

	it('samples only the demo scene\'s follow, shape changes and pulse', () => {
		const out = toFlairSvgMotion(DEMO_SCENE);
		const old = toFlairSvgMotion(DEMO_SCENE, { curves: false });
		expect(old.sampled).toBe(152);
		// The badge's back-eased pop and the spark's ease-in exit are now one change each.
		expect(out.sampled).toBe(114);
		const animate = out.motion.animate ?? [];
		expect(animate).toContainEqual(expect.objectContaining({ id: 'badge', delay: 300, ms: 600, ease: [0.34, 1.56, 0.64, 1] }));
		expect(animate.filter((a) => a.id === 'spark' && Array.isArray(a.ease)).map((a) => Object.keys(a.attrs ?? {})[0]).sort()).toEqual(['opacity', 'transform']);
		// What is left: the follow (spark's transform), the morph and wobble (each path's d) and the pulse (badge's transform).
		const steps = animate.filter((a) => a.ease === 'linear').map((a) => `${a.id} ${Object.keys(a.attrs ?? {})[0]}`);
		expect(new Set(steps)).toEqual(new Set(['spark transform', 'ring d', 'tile d', 'badge transform']));
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
		// The pulse is sampled into linear steps.
		expect(out.sampled).toBeGreaterThan(3);
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
