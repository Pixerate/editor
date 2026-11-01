import { describe, expect, it } from 'vitest';
import {
	AnimationEditorController,
	checkMotionCameraMoves,
	checkMotionScene,
	compileMotionScene,
	createAnimationEffectsToolProvider,
	motionCameraTransform,
	motionCameraViewAt,
	motionCameraWindows,
	motionFrameAt,
	motionFrameToSvg,
	parseMotionScene,
	toFlairSvgMotion,
	type MotionScene
} from '../src/animation-editor';
import { cameraBoxOfView, cameraViewOfBox, createFakeEffectProvider, resolveCameraMoveSpec } from '../src/effects';
import { rectSubpath, type VectorDocument } from '../src/vector';
import { ToolRegistry } from '../src/tools';

const ARTWORK: VectorDocument = {
	width: 400,
	height: 200,
	background: '#ffffff',
	nodes: [
		{ id: 'left', type: 'path', fill: '#ef4444', subpaths: [rectSubpath({ x: 20, y: 20, width: 100, height: 50 })] },
		{ id: 'right', type: 'path', fill: '#0ea5e9', subpaths: [rectSubpath({ x: 280, y: 130, width: 100, height: 50 })] }
	]
};
const stage = { width: 400, height: 200 };
const LEFT = { x: 0, y: 0, width: 200, height: 100 };
const RIGHT = { x: 200, y: 100, width: 200, height: 100 };

const scene = (shots: MotionScene['shots']): MotionScene => ({ version: 1, name: 'camera', artwork: ARTWORK, shots });
const twoShots = (second: Record<string, unknown> = {}, first: Record<string, unknown> = {}): MotionScene =>
	scene([
		{ id: 'one', camera: { ...LEFT, ...first }, run: [], hold: 1000 },
		{ id: 'two', camera: { ...RIGHT, ...second }, run: [], hold: 1000 }
	] as MotionScene['shots']);

const camera = createFakeEffectProvider({ camera: true });
const plain = createFakeEffectProvider();
const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('camera views and boxes', () => {
	it('round-trip a box through a view', () => {
		const view = cameraViewOfBox(RIGHT, stage);
		expect(view.zoom).toBe(2);
		expect(cameraBoxOfView(view, stage)).toEqual(RIGHT);
	});
});

describe('resolveCameraMoveSpec', () => {
	it('writes out a preset and keeps a transition length', async () => {
		const { spec } = await resolveCameraMoveSpec(camera, { move: 'fake.whip', preset: 'Clean', ms: 600 }, 'transition');
		expect(spec).toEqual({ move: 'fake.whip', ms: 600, preset: 'Clean', values: { blur: 0 } });
	});

	it('refuses with what to do next', async () => {
		await expect(resolveCameraMoveSpec(camera, 'fake.drift', 'transition')).rejects.toThrow('"fake.drift" moves the camera while a shot holds, so it goes in camera "during", not "in"; camera "in" takes one of "fake.glide", "fake.whip".');
		await expect(resolveCameraMoveSpec(camera, 'fake.nope', 'hold')).rejects.toThrow('There is no camera move "fake.nope"; camera "during" takes one of "fake.drift".');
		await expect(resolveCameraMoveSpec(camera, 'fake.invert', 'hold')).rejects.toThrow(/is a shader effect, not a camera move; camera "during" takes one of "fake.drift"/);
		await expect(resolveCameraMoveSpec(camera, { move: 'fake.drift', ms: 500 }, 'hold')).rejects.toThrow(/plays across the shot's hold; set the hold's length instead/);
		await expect(resolveCameraMoveSpec(camera, { move: 'fake.whip', preset: 'Dirty' }, 'transition')).rejects.toThrow('"fake.whip" has no preset "Dirty"; its presets are "Clean".');
		await expect(resolveCameraMoveSpec(camera, { move: 'fake.whip', values: { blur: 500 } }, 'transition')).rejects.toThrow(/blur/);
		await expect(resolveCameraMoveSpec(plain, 'fake.glide', 'transition')).rejects.toThrow(/has no camera moves/);
	});
});

describe('animation editor: camera moves', () => {
	it('parse keeps the moves and refuses malformed ones', () => {
		const s = twoShots({ in: { move: 'fake.whip', ms: 400, values: { blur: 10 } }, during: 'fake.drift' });
		expect(parseMotionScene(JSON.stringify(s))).toEqual(s);
		expect(parseMotionScene({ ...s, shots: [s.shots[0], { id: 'two', camera: { in: 'fake.glide' }, run: [] }] }).shots[1].camera).toEqual({ in: 'fake.glide' });
		expect(() => parseMotionScene({ ...s, shots: [{ id: 'x', camera: { during: { move: 'fake.drift', ms: 3 } }, run: [] }] })).toThrow(/set the hold instead/);
		expect(() => parseMotionScene({ ...s, shots: [{ id: 'x', camera: { in: { mvoe: 'fake.glide' } }, run: [] }] })).toThrow(/camera: "in" is a camera move's id/);
		expect(() => parseMotionScene({ ...s, shots: [{ id: 'x', camera: { padding: 4 }, run: [] }] })).toThrow(/give \{ x, y, width, height \}/);
	});

	it('times the in move with its ms and records the windows', () => {
		const t = compileMotionScene(twoShots({ in: { move: 'fake.whip', ms: 400 }, during: 'fake.drift' }));
		expect(t.shots[1]).toMatchObject({ start: 1000, commandsStart: 1400, commandsEnd: 1400, end: 2400, cameraIn: 'fake.whip', cameraDuring: 'fake.drift' });
		expect(t.shots[0].cameraIn).toBeUndefined();
	});

	it('plays the in move through cameraView, then rests on the framing', () => {
		const s = twoShots({ in: { move: 'fake.whip', ms: 400 } });
		for (const time of [1000, 1100, 1199, 1200, 1300]) {
			const want = camera.cameraView!('fake.whip', { from: cameraViewOfBox(LEFT, stage), to: cameraViewOfBox(RIGHT, stage), u: (time - 1000) / 400, ms: 400, stage });
			const view = motionCameraViewAt(s, time, camera)!;
			expect(view).toEqual(want);
			const frame = motionFrameAt(s, time, { effects: camera });
			expect(frame.view).toEqual(want);
			close(frame.camera.width, 400 / want.zoom);
		}
		// After the move the box track rules (it is on the framing).
		expect(motionCameraViewAt(s, 1400, camera)).toBeNull();
		expect(motionFrameAt(s, 1500, { effects: camera }).camera).toEqual(RIGHT);
	});

	it('jumps at a cut: no view between the two framings across it', () => {
		const s = twoShots({ in: { move: 'fake.whip', ms: 400, values: { blur: 0 } } });
		const before = motionFrameAt(s, 1199.9, { effects: camera }).camera;
		const after = motionFrameAt(s, 1200, { effects: camera }).camera;
		// The view jumps at the cut: a frame's worth of time apart, a long way apart.
		expect(Math.abs(after.x - before.x)).toBeGreaterThan(100);
		const keys = [1150, 1190, 1199].map((t) => motionFrameAt(s, t, { effects: camera }).camera.x);
		expect(Math.abs(keys[2] - keys[1])).toBeLessThan(Math.abs(after.x - before.x));
	});

	it('plays a hold move across the hold and starts the next move from where it left off', () => {
		const s = scene([
			{ id: 'one', camera: { ...LEFT, during: { move: 'fake.drift', values: { scale: 2 } } }, run: [], hold: 1000 },
			{ id: 'two', camera: { ...RIGHT, in: 'fake.glide' }, run: [], hold: 500 },
			{ id: 'three', run: [], hold: 500 }
		] as MotionScene['shots']);
		const held = cameraViewOfBox(LEFT, stage);
		const end = camera.cameraView!('fake.drift', { from: held, to: held, u: 1, ms: 1000, stage }, { scale: 2 });
		expect(motionCameraViewAt(s, 500, camera)).toEqual(camera.cameraView!('fake.drift', { from: held, to: held, u: 0.5, ms: 1000, stage }, { scale: 2 }));
		close(end.zoom, held.zoom * 2);
		// The glide into shot two (1000 ms default) starts from the drift's last view.
		expect(motionCameraViewAt(s, 1000, camera)).toEqual(camera.cameraView!('fake.glide', { from: end, to: cameraViewOfBox(RIGHT, stage), u: 0, ms: 1000, stage }));
		expect(motionFrameAt(s, 2200, { effects: camera }).camera).toEqual(RIGHT);
		const windows = motionCameraWindows(s, camera);
		expect(windows.map((w) => [w.kind, w.move, w.start, w.end])).toEqual([
			['during', 'fake.drift', 0, 1000],
			['in', 'fake.glide', 1000, 2000]
		]);
	});

	it('stays where a hold move left off until the next framing', () => {
		const s = scene([
			{ id: 'one', camera: { ...LEFT, during: { move: 'fake.drift', values: { scale: 2 } } }, run: [], hold: 1000 },
			{ id: 'two', run: [], hold: 500 },
			{ id: 'three', camera: RIGHT, run: [], hold: 500 }
		] as MotionScene['shots']);
		const held = cameraViewOfBox(LEFT, stage);
		const end = camera.cameraView!('fake.drift', { from: held, to: held, u: 1, ms: 1000, stage }, { scale: 2 });
		expect(motionCameraViewAt(s, 1200, camera)).toEqual(end);
		// Shot three eases from that view to its framing, then the box track rules.
		const easing = motionCameraViewAt(s, 1500, camera)!;
		close(easing.zoom, end.zoom);
		expect(motionCameraViewAt(s, 2600, camera)).toBeNull();
	});

	it('degrades cleanly without a provider that plays camera moves', () => {
		const s = twoShots({ in: 'fake.whip', during: 'fake.drift' });
		const without = twoShots();
		for (const provider of [undefined, null, plain]) {
			expect(motionCameraWindows(s, provider)).toEqual([]);
			expect(motionFrameAt(s, 1200, { effects: provider }).view).toBeUndefined();
		}
		// It eases like a scene without moves (the move's length aside: whip has none here, so 1000 ms).
		expect(motionFrameAt(s, 1500).camera).toEqual(motionFrameAt(without, 1500).camera);
	});

	it('draws the roll and blur in the SVG and the tilt as CSS', () => {
		const s = twoShots({ in: { move: 'fake.whip', ms: 400, values: { blur: 40 } } });
		const svg = motionFrameToSvg(s, 1150, { effects: camera });
		expect(svg).toMatch(/<filter id="vg-camera-blur"[^>]*><feGaussianBlur stdDeviation="[\d.]+ [\d.]+"\/><\/filter>/);
		expect(svg).toContain('filter="url(#vg-camera-blur)"');
		expect(motionFrameToSvg(s, 1500, { effects: camera })).not.toContain('camera-blur');
		expect(motionCameraTransform({ zoom: 1, scrollX: 0, scrollY: 0, tilt: 20, turn: -10, perspective: 3 }, 400)).toBe('perspective(1200px) rotateX(20deg) rotateY(10deg)');
		expect(motionCameraTransform({ zoom: 1, scrollX: 0, scrollY: 0 }, 400)).toBe('');
	});

	it('checks moves against the provider', async () => {
		const s = scene([
			{ id: 'one', camera: { ...LEFT, in: 'fake.glide' }, run: [], hold: 100 },
			{ id: 'two', camera: { ...RIGHT, in: 'fake.drift', during: { move: 'fake.drift', values: { scale: 9 } } }, run: [], hold: 100 }
		] as MotionScene['shots']);
		expect(checkMotionScene(s).map((i) => i.code)).toContain('camera-move-first-shot');
		const issues = await checkMotionCameraMoves(s, camera);
		expect(issues.map((i) => [i.code, i.shot])).toEqual([
			['camera-move-unknown', 'two'],
			['camera-move-values', 'two']
		]);
		expect((await checkMotionCameraMoves(s, plain))[0]).toMatchObject({ code: 'camera-move-not-played' });
	});
});

describe('AnimationEditorController camera moves', () => {
	const make = (provider = camera) => new AnimationEditorController({ scene: twoShots(), effects: provider });

	it('sets and clears a move in one undo step each, round-tripping through save', async () => {
		const c = make();
		expect((await c.cameraMoves('hold')).map((m) => m.id)).toEqual(['fake.drift']);
		const set = await c.setShotCameraMove('two', 'transition', { move: 'fake.whip', preset: 'Clean' });
		// The move's own length is written out, so the scene times it the same without a provider.
		expect(set).toMatchObject({ ok: true, shot: 'two', window: { start: 1000, end: 1400 } });
		expect(c.getState().scene.shots[1].camera).toEqual({ ...RIGHT, in: { move: 'fake.whip', ms: 400, preset: 'Clean', values: { blur: 0 } } });
		const hold = await c.setShotCameraMove('two', 'hold', 'fake.drift');
		expect(hold).toMatchObject({ ok: true, window: { start: 1400, end: 2400 } });
		const reopened = new AnimationEditorController({ scene: JSON.parse(JSON.stringify(c.getState().scene)), effects: camera });
		expect(reopened.getState().scene.shots[1].camera).toEqual({ ...RIGHT, in: { move: 'fake.whip', ms: 400, preset: 'Clean', values: { blur: 0 } }, during: 'fake.drift' });
		expect(reopened.frame(1100).view).toBeDefined();
		expect(c.clearShotCameraMove('two', 'transition')).toMatchObject({ ok: true, camera: { ...RIGHT, during: 'fake.drift' } });
		c.undo();
		expect(c.getState().scene.shots[1].camera?.in).toBeDefined();
	});

	it('refuses with what to do next and changes nothing', async () => {
		const c = make();
		const before = c.getState().scene;
		expect(await c.setShotCameraMove('nope', 'hold', 'fake.drift')).toEqual({ ok: false, error: 'There is no shot "nope"; the shots are "one", "two".' });
		expect(await c.setShotCameraMove('two', 'hold', 'fake.whip')).toMatchObject({ ok: false, error: expect.stringContaining('camera "during" takes one of "fake.drift"') });
		expect(c.clearShotCameraMove('two', 'hold')).toMatchObject({ ok: false, error: 'Shot "two" has no camera "during" move to clear.' });
		expect(await make(plain).setShotCameraMove('two', 'hold', 'fake.drift')).toMatchObject({ ok: false, error: expect.stringContaining('has no camera moves') });
		expect(c.getState().scene).toBe(before);
	});

	it('gives a shot without a camera one that keeps the framing', async () => {
		const c = new AnimationEditorController({ scene: scene([{ id: 'one', camera: LEFT, run: [], hold: 100 }, { id: 'two', run: [], hold: 500 }]), effects: camera });
		await c.setShotCameraMove('two', 'hold', 'fake.drift');
		expect(c.getState().scene.shots[1].camera).toEqual({ during: 'fake.drift' });
		expect(c.frame(300).view).toBeDefined();
		c.clearShotCameraMove('two', 'hold');
		expect(c.getState().scene.shots[1].camera).toBeUndefined();
	});
});

describe('Flair export of camera moves', () => {
	it('tags the move without a provider and notes how to sample it', () => {
		const out = toFlairSvgMotion(twoShots({ in: { move: 'fake.whip', ms: 400 } }));
		const views = out.motion.animate!.filter((a) => a.view);
		expect(views.find((a) => a.delay === 1000)).toMatchObject({ ms: 400, tag: 'fake.whip@two', view: [200, 100, 200, 100] });
		expect(out.notes.join(' ')).toMatch(/"two" are written as eased framings, tagged with the move's id; pass an effects provider/);
	});

	it('samples the move from the provider, keeping its cut as a change of no length', () => {
		const s = twoShots({ in: { move: 'fake.whip', ms: 400, values: { blur: 0 } } });
		const out = toFlairSvgMotion(s, { effects: camera, fps: 30 });
		const views = out.motion.animate!.filter((a) => a.view && (a.delay ?? 0) >= 1000 && (a.delay ?? 0) < 1400);
		expect(views.every((a) => a.tag === 'fake.whip@two')).toBe(true);
		const cut = views.find((a) => a.ms === 0)!;
		expect(cut.delay).toBeCloseTo(1200, 1);
		const box = (t: number) => Object.values(motionFrameAt(s, t, { effects: camera }).camera).map((n) => Math.round(n * 1000) / 1000);
		expect(cut.view).toEqual(box(cut.delay!));
		// Every sampled change lands where the stage puts the camera.
		for (const a of views) (a.view as number[]).forEach((n, k) => expect(n).toBeCloseTo(box((a.delay ?? 0) + (a.ms ?? 0) - (a.ms ? 1e-3 : 0))[k], 1));
		expect(out.notes.join(' ')).toMatch(/tilt, turn, roll and motion blur are not carried over/);
	});

	it('holds where a hold move left off', () => {
		const s = scene([{ id: 'one', camera: { ...LEFT, during: { move: 'fake.drift', values: { scale: 2 } } }, run: [], hold: 1000 }] as MotionScene['shots']);
		const views = toFlairSvgMotion(s, { effects: camera }).motion.animate!.filter((a) => a.view);
		expect(views.length).toBeGreaterThan(5);
		expect(views.every((a) => a.tag === 'fake.drift@one' || (a.delay ?? 0) === 0)).toBe(true);
		const last = views[views.length - 1];
		expect((last.view as number[])[2]).toBeCloseTo(100, 3);
	});
});

describe('camera move tools', () => {
	const setup = (provider: ReturnType<typeof createFakeEffectProvider> | null = camera, readOnly = false) => {
		const c = new AnimationEditorController({ scene: twoShots(), effects: provider });
		const registry = new ToolRegistry();
		registry.register(createAnimationEffectsToolProvider(c, { namespace: '', readOnly }));
		return { c, registry };
	};
	const data = (r: { structuredContent?: unknown }) => r.structuredContent as any;
	const error = (r: { isError?: boolean; content: { type: string; text?: string }[] }) => (expect(r.isError).toBe(true), r.content.map((x) => x.text).join(' '));

	it('lists moves by role, or says why there are none', async () => {
		const { registry } = setup();
		expect(data(await registry.callTool('list_camera_moves', { role: 'transition' })).moves.map((m: any) => [m.id, m.role, m.durationMs, m.cut])).toEqual([
			['fake.glide', 'transition', 800, undefined],
			['fake.whip', 'transition', 400, 0.5]
		]);
		expect(data(await registry.callTool('list_camera_moves', {})).moves).toHaveLength(3);
		expect(data(await setup(plain).registry.callTool('list_camera_moves', {}))).toMatchObject({ available: false, reason: expect.stringContaining('has no camera moves'), moves: [] });
		expect(data(await setup(null).registry.callTool('list_camera_moves', {}))).toMatchObject({ available: false, reason: expect.stringContaining('No effects provider') });
		error(await registry.callTool('list_camera_moves', { role: 'pan' }));
	});

	it('sets a move and returns the camera and when it plays, then clears it', async () => {
		const { c, registry } = setup();
		const set = data(await registry.callTool('set_shot_camera_move', { shot: 'two', role: 'transition', move: 'fake.whip', ms: 300, values: { blur: 12 } }));
		expect(set).toEqual({ shot: 'two', camera: { ...RIGHT, in: { move: 'fake.whip', ms: 300, values: { blur: 12 } } }, window: { start: 1000, end: 1300 } });
		const hold = data(await registry.callTool('set_shot_camera_move', { shot: 'one', role: 'hold', move: 'fake.drift' }));
		expect(hold.window).toEqual({ start: 0, end: 1000 });
		const first = data(await registry.callTool('set_shot_camera_move', { shot: 'one', role: 'transition', move: 'fake.glide' }));
		expect(first.notes[0]).toMatch(/first shot, which cuts to its framing/);
		expect(data(await registry.callTool('clear_shot_camera_move', { shot: 'two', role: 'transition' }))).toEqual({ shot: 'two', camera: RIGHT });
		expect(c.getState().scene.shots[1].camera).toEqual(RIGHT);
	});

	it('refuses bad arguments the way a model can act on, changing nothing', async () => {
		const { c, registry } = setup();
		const before = c.getState().scene;
		expect(error(await registry.callTool('set_shot_camera_move', { shot: 'two', role: 'hold', move: 'fake.whip' }))).toContain('"fake.whip" moves the camera into a shot, so it goes in camera "in", not "during"; camera "during" takes one of "fake.drift".');
		expect(error(await registry.callTool('set_shot_camera_move', { shot: 'three', role: 'hold', move: 'fake.drift' }))).toContain('There is no shot "three"; the shots are "one", "two".');
		expect(error(await registry.callTool('set_shot_camera_move', { shot: 'two', role: 'hold', move: 'fake.drift', ms: 500 }))).toContain('set the hold\'s length instead');
		expect(error(await registry.callTool('set_shot_camera_move', { shot: 'two', role: 'transition', move: 'fake.whip', preset: 'Messy' }))).toContain('its presets are "Clean"');
		expect(error(await registry.callTool('set_shot_camera_move', { shot: 'two', role: 'transition', move: 'fake.whip', values: { speed: 2 } }))).toMatch(/speed/);
		expect(error(await registry.callTool('set_shot_camera_move', { shot: 'two', move: 'fake.whip' }))).toMatch(/role/);
		expect(error(await registry.callTool('set_shot_camera_move', { shot: 'two', role: 'transition', move: 'fake.whip', ms: -5 }))).toMatch(/ms/);
		expect(error(await registry.callTool('set_shot_camera_move', { shot: 'two', role: 'transition', move: 'fake.whip', extra: 1 }))).toMatch(/extra/);
		expect(error(await registry.callTool('clear_shot_camera_move', { shot: 'two', role: 'hold' }))).toContain('has no camera "during" move to clear');
		expect(error(await setup(null).registry.callTool('set_shot_camera_move', { shot: 'two', role: 'hold', move: 'fake.drift' }))).toMatch(/No effects provider/);
		expect(c.getState().scene).toBe(before);
	});

	it('hides the writes on a read-only editor, keeping the list', async () => {
		const names = setup(camera, true).registry.listTools().tools.map((t) => t.name);
		expect(names).toContain('list_camera_moves');
		expect(names).not.toContain('set_shot_camera_move');
		expect(names).not.toContain('clear_shot_camera_move');
	});
});
