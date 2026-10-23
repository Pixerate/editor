import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import {
	AnimationEditorController,
	createAnimationEditorToolProvider,
	createMotionScene,
	motionClientToDocument,
	motionNodePose,
	motionTakeShot,
	parseMotionScene,
	simplifyTimedSamples,
	type MotionScene,
	type MotionTakeSample
} from '../src/animation-editor';
import { ToolRegistry } from '../src/tools';
import { parseVectorSvg } from '../src/vector/svg';

// A 40 × 40 square centred on (60, 60) and a circle centred on (200, 80).
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 160"><rect id="box" x="40" y="40" width="40" height="40" fill="#e2e8f0" stroke="#0f172a" stroke-width="2"/><circle id="dot" cx="200" cy="80" r="12" fill="#f43f5e"/></svg>';
const scene = (): MotionScene => createMotionScene(parseVectorSvg(SVG), { name: 'perform', shots: [{ id: 'intro', run: [{ type: 'fade', targets: ['dot'], to: 0.5, duration: 400 }], hold: 100 }] });

/** A drag along a quarter circle of radius 100 about (60, 160), over `ms`, sampled at 60 fps. */
const arc = (node: string, ms: number, from = 0): MotionTakeSample[] => {
	const out: MotionTakeSample[] = [];
	for (let t = 0; t <= ms + 1e-9; t += 1000 / 60) {
		const a = -Math.PI / 2 + (t / ms) * (Math.PI / 2);
		out.push({ node, t: from + t, x: 60 + 100 * Math.cos(a), y: 160 + 100 * Math.sin(a) + 0 });
	}
	return out;
};

describe('simplifyTimedSamples', () => {
	it('keeps the ends of a straight run and the corner of a bent one', () => {
		expect(simplifyTimedSamples([0, 1, 2, 3], [[0], [1], [2], [3]], 0.1)).toEqual([0, 3]);
		expect(simplifyTimedSamples([0, 1, 2, 3, 4], [[0], [1], [2], [1], [0]], 0.1)).toEqual([0, 2, 4]);
		// A pause shows as two kept points with the same value.
		expect(simplifyTimedSamples([0, 1, 2, 3, 4, 5], [[0], [5], [5], [5], [5], [10]], 0.1)).toEqual([0, 1, 4, 5]);
	});
});

describe('motionTakeShot', () => {
	it('turns a drag into one move through waypoints at the recorded times', () => {
		const s = scene();
		// The square starts at its rest centre (60, 60), the top of the arc.
		const { shot, start, samples, at } = motionTakeShot(s, { samples: arc('box', 1200), length: 1500 });
		expect(at).toBe(1);
		expect(start).toBe(500);
		expect(shot).toMatchObject({ id: 'take', label: 'Recorded take' });
		expect(shot.run).toHaveLength(1);
		const move = shot.run[0] as Extract<(typeof shot.run)[number], { type: 'move' }>;
		expect(move).toMatchObject({ type: 'move', targets: ['box'], duration: 1200, ease: 'linear', to: { x: 160, y: 160 } });
		expect(move.via!.length).toBeGreaterThan(2);
		expect(move.via!.length).toBeLessThan(20);
		expect(move.times).toHaveLength(move.via!.length);
		expect(samples.given).toBe(73);
		// Played back, the square is where the performance had it.
		const played = { ...s, shots: [...s.shots, shot] };
		expect(() => parseMotionScene(played)).not.toThrow();
		for (const t of [0, 300, 600, 900, 1200]) {
			const a = -Math.PI / 2 + (t / 1200) * (Math.PI / 2);
			const pose = motionNodePose(played, 'box', start + t);
			expect(Math.hypot(pose.x - (60 + 100 * Math.cos(a)), pose.y - (160 + 100 * Math.sin(a)))).toBeLessThan(2);
		}
		// The shot lasts as long as the take.
		expect(shot.hold).toBe(300);
	});

	it('keeps waypoint times rising on a long take', () => {
		const s = scene();
		// Two quick turns of direction a few ms apart, near the start of a 10-minute take.
		const samples: MotionTakeSample[] = [
			{ node: 'box', t: 0, x: 60, y: 60 },
			{ node: 'box', t: 10, x: 90, y: 60 },
			{ node: 'box', t: 11, x: 60, y: 90 },
			{ node: 'box', t: 12, x: 90, y: 90 },
			{ node: 'box', t: 600_000, x: 100, y: 100 }
		];
		const { shot } = motionTakeShot(s, { samples });
		const move = shot.run[0] as { times?: number[]; via?: unknown[] };
		expect(move.times!.length).toBe(move.via!.length);
		expect(move.times!.every((f, i) => f > 0 && f < 1 && (i === 0 || f > move.times![i - 1]))).toBe(true);
		expect(() => parseMotionScene({ ...s, shots: [...s.shots, shot] })).not.toThrow();
	});

	it('places each change when it happened, chained with delays', () => {
		const s = scene();
		const samples: MotionTakeSample[] = [
			{ node: 'dot', t: 200, fill: '#0ea5e9' },
			...arc('box', 600, 500),
			{ node: 'box', t: 1500, rotation: 0 },
			{ node: 'box', t: 2000, rotation: 90 }
		];
		const { shot } = motionTakeShot(s, { samples });
		expect(shot.run.map((c) => c.type)).toEqual(['style', 'move', 'rotate']);
		expect(shot.run[0]).toMatchObject({ fill: '#0ea5e9', duration: 0, delay: 200 });
		expect(shot.run[1]).toMatchObject({ with: 'previous', delay: 300, duration: 600 });
		expect(shot.run[2]).toMatchObject({ with: 'previous', delay: 1000, duration: 500, to: 90 });
		const played = { ...s, shots: [...s.shots, shot] };
		expect(motionNodePose(played, 'dot', 500 + 199).fill).toBe('#f43f5e');
		expect(motionNodePose(played, 'dot', 500 + 200).fill).toBe('#0ea5e9');
		expect(motionNodePose(played, 'box', 500 + 2000).rotation).toBeCloseTo(90);
	});

	it('jumps into a first sample away from the pose, and starts from the pose otherwise', () => {
		const s = scene();
		const { shot } = motionTakeShot(s, { samples: [{ node: 'box', t: 100, scaleX: 2 }, { node: 'box', t: 600, scaleX: 1 }, { node: 'dot', t: 0, opacity: 0.5 }, { node: 'dot', t: 400, opacity: 1 }] });
		// The dot is at 0.5 after "intro", so its fade starts there; the square jumps to 2× first.
		expect(shot.run).toEqual([
			{ type: 'fade', targets: ['dot'], duration: 400, ease: expect.anything(), to: 1 },
			{ type: 'scale', targets: ['box'], duration: 0, ease: 'linear', to: 2, with: 'previous', delay: 100 },
			{ type: 'scale', targets: ['box'], duration: 500, ease: expect.anything(), to: 1, with: 'previous' }
		]);
	});

	it('records a non-uniform resize, stroke width and paint picks', () => {
		const s = scene();
		const { shot } = motionTakeShot(s, {
			samples: [
				{ node: 'box', t: 0, scaleX: 1, scaleY: 1 },
				{ node: 'box', t: 500, scaleX: 2, scaleY: 1.5 },
				{ node: 'box', t: 0, strokeWidth: 2 },
				{ node: 'box', t: 400, strokeWidth: 6 },
				{ node: 'box', t: 100, stroke: '#ff0000' },
				{ node: 'box', t: 130, stroke: '#00ff00' },
				{ node: 'box', t: 300, stroke: '#0000ff' }
			]
		});
		const types = shot.run.map((c) => [c.type, 'to' in c ? c.to : 'strokeWidth' in c && c.strokeWidth !== undefined ? c.strokeWidth : (c as { stroke?: string }).stroke]);
		// The green pick 30 ms after the red one is thinned out; the blue one tweens from red.
		expect(types).toEqual([
			['scale', { x: 2, y: 1.5 }],
			['style', 6],
			['style', '#ff0000'],
			['style', '#0000ff']
		]);
		expect(shot.run[3]).toMatchObject({ duration: 200, ease: 'linear' });
	});

	it('refuses unknown nodes and bad values, saying how to fix them', () => {
		const s = scene();
		expect(() => motionTakeShot(s, { samples: [] })).toThrow(/at least one sample/);
		expect(() => motionTakeShot(s, { samples: [{ node: 'bx', t: 0, x: 1, y: 1 }] })).toThrow(/no element "bx" \(did you mean "box"\?\)/);
		expect(() => motionTakeShot(s, { samples: [{ node: 'box', t: 0, x: 1 }] })).toThrow(/"x" and "y" together/);
		expect(() => motionTakeShot(s, { samples: [{ node: 'box', t: 0, opacity: 2 }] })).toThrow(/"opacity" must be from 0 to 1/);
		expect(() => motionTakeShot(s, { samples: [{ node: 'box', t: 0, fill: 'nope' }] })).toThrow(/must be a colour/);
		expect(() => motionTakeShot(s, { samples: [{ node: 'box', t: 0 }] })).toThrow(/records nothing/);
		expect(() => motionTakeShot(s, { samples: [{ node: 'box', t: 0, x: 1, y: 1 }] }, { at: 9 })).toThrow(/"at" must be a whole number from 0 to 1/);
	});
});

describe('move times', () => {
	it('reaches each waypoint at its fraction of the duration, and is checked', () => {
		const s = scene();
		const shot = { id: 'm', run: [{ type: 'move' as const, targets: ['box'], to: { x: 160, y: 60 }, via: [{ x: 70, y: 60 }], times: [0.5], duration: 1000, ease: 'linear' as const }], hold: 0 };
		const played = { ...s, shots: [...s.shots, shot] };
		expect(motionNodePose(played, 'box', 500 + 500).x).toBeCloseTo(70, 0);
		expect(() => parseMotionScene({ ...s, shots: [{ ...shot, run: [{ ...shot.run[0], times: [0.5, 0.7] }] }] })).toThrow(/"times" must be 1 rising fractions/);
		expect(() => parseMotionScene({ ...s, shots: [{ ...shot, run: [{ ...shot.run[0], via: undefined, times: [0.5] }] }] })).toThrow(/"times" goes with "via"/);
	});
});

describe('motionClientToDocument', () => {
	it('maps stage pixels through a letterboxed camera', () => {
		const camera = { x: 0, y: 0, width: 320, height: 160 };
		expect(motionClientToDocument(camera, { left: 10, top: 20, width: 640, height: 320 }, 10 + 320, 20 + 160)).toEqual({ x: 160, y: 80 });
		// A box taller than the camera centres it vertically.
		expect(motionClientToDocument(camera, { left: 0, top: 0, width: 320, height: 260 }, 0, 50)).toEqual({ x: 0, y: 0 });
	});
});

describe('AnimationEditorController recording', () => {
	const setup = () => {
		const clock = new ManualClock();
		const controller = new AnimationEditorController({ scene: scene(), clock });
		return { clock, controller };
	};

	it('records stage gestures live, previews them, and adds one undoable shot', async () => {
		const { clock, controller } = setup();
		const started = controller.startRecording();
		expect(started).toMatchObject({ ok: true, recording: { shot: 'take', at: 1, start: 500, samples: 0 } });
		expect(controller.getState()).toMatchObject({ playing: true, time: 500 });
		// Edits, seeks and undo wait.
		expect(controller.apply({ op: 'delete_shots', shots: ['intro'] })).toMatchObject({ ok: false, error: expect.stringMatching(/stop or cancel the recording/) });
		controller.seek(0);
		expect(controller.getState().time).toBe(500);

		await clock.advance(100);
		expect(controller.beginRecordGesture('box', 'move', { x: 60, y: 60 })).toBe(true);
		expect(controller.getState().recording?.gesture).toEqual({ node: 'box', mode: 'move' });
		for (let i = 1; i <= 10; i++) {
			await clock.advance(50);
			controller.updateRecordGesture({ x: 60 + i * 10, y: 60 });
		}
		controller.endRecordGesture();
		// The stage shows the take so far.
		expect(controller.pose('box').x).toBeCloseTo(160, 0);
		expect(controller.frame().document.nodes).toBeDefined();
		await clock.advance(400);
		const done = controller.stopRecording();
		expect(done.ok).toBe(true);
		if (!done.ok) return;
		expect(done.shot.run).toEqual([{ type: 'move', targets: ['box'], duration: 500, ease: 'linear', to: { x: 160, y: 60 }, delay: 100 }]);
		expect(done.shot.hold).toBe(400);
		const state = controller.getState();
		expect(state).toMatchObject({ recording: null, playing: false, time: 500, selection: { shot: 'take' }, undoLabel: 'Record take', duration: 1500 });
		expect(controller.undo()).toBe(true);
		expect(controller.getScene().shots.map((s) => s.id)).toEqual(['intro']);
	});

	it('scales and turns with the pointer about the centre', async () => {
		const { clock, controller } = setup();
		controller.startRecording({ id: 'spin' });
		controller.beginRecordGesture('box', 'scale', { x: 80, y: 60 });
		await clock.advance(200);
		controller.updateRecordGesture({ x: 100, y: 60 });
		controller.endRecordGesture();
		await clock.advance(100);
		controller.beginRecordGesture('box', 'rotate', { x: 100, y: 60 });
		for (const deg of [90, 180, 270]) {
			await clock.advance(100);
			const a = (deg * Math.PI) / 180;
			controller.updateRecordGesture({ x: 60 + 40 * Math.cos(a), y: 60 + 40 * Math.sin(a) });
		}
		controller.endRecordGesture();
		const done = controller.stopRecording();
		if (!done.ok) throw new Error(done.error);
		expect(done.shot.id).toBe('spin');
		const scale = done.shot.run.find((c) => c.type === 'scale');
		expect(scale).toMatchObject({ to: 2, duration: 200 });
		// Past 180° it keeps turning the same way.
		const turns = done.shot.run.filter((c) => c.type === 'rotate').map((c) => (c as { to: number }).to);
		expect(turns.at(-1)).toBeCloseTo(270, 0);
	});

	it('records paint and opacity changes as samples, and refuses bad ones', async () => {
		const { clock, controller } = setup();
		expect(controller.recordSample('box', { fill: '#000000' })).toMatch(/startRecording first/);
		controller.startRecording();
		await clock.advance(250);
		expect(controller.recordSample('box', { fill: '#0ea5e9' })).toBeNull();
		expect(controller.recordSample('nope', { fill: '#0ea5e9' })).toMatch(/no element "nope"/);
		expect(controller.recordSample('box', { opacity: 3 })).toMatch(/The sample: "opacity" must be from 0 to 1/);
		expect(controller.getState().recording?.samples).toBe(1);
		const done = controller.stopRecording();
		expect(done.ok && done.shot.run).toEqual([{ type: 'style', targets: ['box'], fill: '#0ea5e9', duration: 0, ease: 'linear', delay: 250 }]);
	});

	it('cancels, refuses an empty take, and stops when made read-only', () => {
		const { controller } = setup();
		controller.startRecording();
		expect(controller.startRecording()).toMatchObject({ ok: false, error: 'A take is already being recorded.' });
		controller.cancelRecording();
		expect(controller.getState().recording).toBeNull();
		expect(controller.getScene().shots).toHaveLength(1);
		controller.startRecording();
		expect(controller.stopRecording()).toMatchObject({ ok: false, error: expect.stringMatching(/Nothing was recorded/) });
		expect(controller.getState().canUndo).toBe(false);
		controller.startRecording({ id: 'intro' });
		expect(controller.getState().error).toMatch(/"intro" is already used/);
		controller.startRecording();
		controller.setReadOnly(true);
		expect(controller.getState().recording).toBeNull();
		expect(controller.startRecording()).toMatchObject({ ok: false, error: 'The animation is read-only.' });
	});
});

describe('record_animation_take tool', () => {
	const tools = () => {
		const controller = new AnimationEditorController({ scene: scene() });
		const registry = new ToolRegistry();
		registry.register(createAnimationEditorToolProvider(controller));
		return { controller, registry };
	};

	it('adds a performed take as a shot and returns its commands', async () => {
		const { controller, registry } = tools();
		const dry = await registry.callTool('animation__record_animation_take', { samples: arc('box', 900), dry_run: true });
		expect(dry.isError).toBeFalsy();
		expect(dry.structuredContent).toMatchObject({ dry_run: true, shot: 'take', at: 1, start: 500 });
		expect(controller.getScene().shots).toHaveLength(1);
		const r = await registry.callTool('animation__record_animation_take', { samples: [...arc('box', 900), { node: 'dot', t: 900, fill: '#22c55e' }], label: 'Swoop', length: 1200 });
		expect(r.isError).toBeFalsy();
		const out = r.structuredContent as any;
		expect(out).toMatchObject({ shot: 'take', at: 1, start: 500, duration: 1700, issues: { errors: 0 } });
		expect(out.commands).toEqual([
			{ index: 0, type: 'move', targets: ['box'], start: 500, end: 1400 },
			{ index: 1, type: 'style', targets: ['dot'], start: 1400, end: 1400 }
		]);
		expect(controller.getScene().shots[1].label).toBe('Swoop');
		expect(controller.getState().undoLabel).toBe('Record take');
	});

	it('fails usefully and changes nothing', async () => {
		const { controller, registry } = tools();
		const before = controller.getScene();
		const bad = await registry.callTool('animation__record_animation_take', { samples: [{ node: 'bx', t: 0, x: 1, y: 2 }] });
		expect(bad.isError).toBe(true);
		expect(JSON.stringify(bad.content)).toMatch(/did you mean \\"box\\"/);
		const schema = await registry.callTool('animation__record_animation_take', { samples: [{ node: 'box' }] });
		expect(schema.isError).toBe(true);
		expect(controller.getScene()).toBe(before);
	});

	it('is hidden while the animation is read-only', () => {
		const controller = new AnimationEditorController({ scene: scene(), readOnly: true });
		const registry = new ToolRegistry();
		registry.register(createAnimationEditorToolProvider(controller));
		expect(registry.listTools().tools.map((t) => t.name)).not.toContain('animation__record_animation_take');
	});
});
