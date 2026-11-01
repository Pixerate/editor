import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { createFakeEffectProvider, type CameraView } from '../src/effects';
import {
	VideoEditorController,
	applyVideoEdits,
	bakeVideoClipCamera,
	checkVideoProject,
	createVideoEffectsToolProvider,
	findVideoClip,
	parseVideoProject,
	sortVideoKeys,
	splitVideoAnimatable,
	videoCameraView,
	videoKeyframeFfmpegExpr,
	videoTransformOfView,
	videoValueAt,
	type VideoKeyframes,
	type VideoProject
} from '../src/video-editor';

const camera = createFakeEffectProvider({ camera: true });
const plain = createFakeEffectProvider();
const stage = { width: 320, height: 180 };
const FPS = 25;

const project = (clip: Record<string, unknown> = {}): VideoProject =>
	parseVideoProject({
		version: 1,
		width: stage.width,
		height: stage.height,
		fps: FPS,
		assets: [],
		tracks: [
			{ id: 'v1', kind: 'video', clips: [{ id: 'a', type: 'color', color: '#000000', start: 0, duration: 2000, ...clip }, { id: 'b', type: 'color', color: '#ffffff', start: 2000, duration: 1000 }] },
			{ id: 'adj', kind: 'video', clips: [{ id: 'fix', type: 'adjustment', start: 0, duration: 1000 }] }
		]
	});
const clipOf = (p: VideoProject, id: string) => findVideoClip(p, id)!.clip;
const value = (p: VideoProject, id: string, prop: 'x' | 'y' | 'scale' | 'rotation', t: number) => videoValueAt(clipOf(p, id).transform?.[prop], t, prop === 'scale' ? 1 : 0);
const at = (view: CameraView, base = {}) => videoTransformOfView(view, base, stage);

describe('jump keys', () => {
	const jump: VideoKeyframes = { keys: [{ t: 0, v: 0 }, { t: 100, v: 10 }, { t: 100, v: 90 }, { t: 200, v: 100 }] };

	it('holds the value before a jump up to it and the value after from it, never between', () => {
		expect(videoValueAt(jump, 50)).toBe(5);
		expect(videoValueAt(jump, 99.999)).toBeCloseTo(10, 2);
		expect(videoValueAt(jump, 100)).toBe(90);
		expect(videoValueAt(jump, 150)).toBe(95);
	});

	it('sorts a jump keeping its order, refuses three at a time, and refuses jumps when asked', () => {
		expect(sortVideoKeys([{ t: 200, v: 100 }, { t: 100, v: 10 }, { t: 100, v: 90 }]).map((k) => k.v)).toEqual([10, 90, 100]);
		expect(() => sortVideoKeys([{ t: 1, v: 0 }, { t: 1, v: 1 }, { t: 1, v: 2 }])).toThrow('Three keys are at 1 ms');
		expect(() => sortVideoKeys([{ t: 1, v: 0 }, { t: 1, v: 1 }], { jumps: false })).toThrow('Two keys are at 1 ms');
	});

	it('writes a jump as a step in the ffmpeg expression', () => {
		const expr = videoKeyframeFfmpegExpr(jump, 'T', 0, 40);
		expect(expr).not.toMatch(/Infinity|NaN/);
		expect(expr).toBe('if(lt(T,0),0,if(lt(T,100),0+0.1*(T+0),if(lt(T,100),10,if(lt(T,200),90+0.1*(T-100),100))))');
	});

	it('parses jumps in a project but not in a speed ramp, and splits at one', () => {
		expect(() => project({ opacity: { keys: [{ t: 0, v: 1 }, { t: 5, v: 1 }, { t: 5, v: 0 }] } })).not.toThrow();
		expect(() => project({ opacity: { keys: [{ t: 5, v: 1 }, { t: 5, v: 0 }, { t: 5, v: 1 }] } })).toThrow(/third key at 5 ms/);
		const [left, right] = splitVideoAnimatable(jump, 100);
		expect(videoValueAt(left, 99.99)).toBeCloseTo(10, 2);
		expect(videoValueAt(right, 0)).toBe(90);
	});
});

describe('baking camera moves', () => {
	const from = videoCameraView(undefined, stage);
	const to = videoCameraView({ zoom: 2, x: 40, y: -20 }, stage);

	it('maps a framing to a view and a view to a transform over the base', () => {
		expect(at(from)).toEqual({ x: 0, y: 0, scale: 1, rotation: 0 });
		// Zoom 2 on the point (40, -20) from the centre: the picture doubles and moves the other way.
		expect(at(to)).toEqual({ x: -80, y: 40, scale: 2, rotation: 0 });
		expect(at(to, { x: 10, scale: 0.5, rotation: 5 })).toEqual({ x: -60, y: 40, scale: 1, rotation: 5 });
		expect(at({ zoom: 1, scrollX: -10, scrollY: 0, roll: 90 })).toEqual({ x: 0, y: -10, scale: 1, rotation: 90 });
	});

	it("keys match cameraView at every frame time, and a cut keeps its two keys", async () => {
		const p = project();
		const bake = await bakeVideoClipCamera(clipOf(p, 'a'), { in: { move: 'fake.whip', ms: 400 }, framing: { zoom: 2, x: 40, y: -20 }, base: {} }, p, camera);
		expect(bake.cuts).toEqual([200]);
		expect(bake.windows).toEqual({ in: { start: 0, end: 400 } });
		expect(bake.notes.join(' ')).toMatch(/no tilt, turn or motion blur/);
		const x = bake.transform.x as VideoKeyframes;
		const times = x.keys.map((k) => k.t);
		expect(times.filter((t) => t === 200)).toHaveLength(2);
		for (let t = 0; t <= 400; t += 1000 / FPS) {
			const view = camera.cameraView!('fake.whip', { from, to, u: t / 400, ms: 400, stage });
			for (const prop of ['x', 'y', 'scale'] as const) expect(videoValueAt(bake.transform[prop], t, 1)).toBeCloseTo(at(view)[prop], 2);
		}
		// Never a tween across the cut: just before it the view is the whip out, from it the whip in.
		const before = camera.cameraView!('fake.whip', { from, to, u: 0.4999999, ms: 400, stage });
		const after = camera.cameraView!('fake.whip', { from, to, u: 0.5, ms: 400, stage });
		expect(videoValueAt(x, 199.999)).toBeCloseTo(at(before).x, 0);
		expect(videoValueAt(x, 200)).toBeCloseTo(at(after).x, 3);
	});

	it('plays a hold move across the rest of the clip from where the move in landed', async () => {
		const p = project();
		const bake = await bakeVideoClipCamera(clipOf(p, 'a'), { in: { move: 'fake.glide', ms: 800 }, during: { move: 'fake.drift', values: { scale: 1.5 } }, framing: { zoom: 2 }, base: {} }, p, camera);
		expect(bake.windows).toEqual({ in: { start: 0, end: 800 }, during: { start: 800, end: 2000 } });
		const held = videoCameraView({ zoom: 2 }, stage);
		for (const t of [800, 1200, 1600, 2000]) {
			const view = camera.cameraView!('fake.drift', { from: held, to: held, u: (t - 800) / 1200, ms: 1200, stage }, { scale: 1.5 });
			expect(videoValueAt(bake.transform.scale, t, 1)).toBeCloseTo(at(view).scale, 3);
		}
		expect((bake.transform.scale as VideoKeyframes).keys.at(-1)!.t).toBe(2000);
	});

	it('refuses a move in longer than the clip', async () => {
		const p = project();
		await expect(bakeVideoClipCamera(clipOf(p, 'a'), { in: { move: 'fake.glide', ms: 2500 }, base: {} }, p, camera)).rejects.toThrow('takes 2500 ms, longer than the clip (2000 ms)');
	});
});

describe('VideoEditorController camera moves', () => {
	const make = (provider = camera, clip: Record<string, unknown> = { transform: { x: 10, scale: 0.8 } }) => new VideoEditorController({ project: project(clip), effects: provider });

	it('bakes, re-bakes, clears back to the base, one undo step each, and saves', async () => {
		const c = make();
		const r = await c.setClipCameraMove('a', 'hold', 'fake.drift', { framing: { zoom: 1.5 } });
		expect(r).toMatchObject({ ok: true, clip: 'a', windows: { during: { start: 0, end: 2000 } }, camera: { during: 'fake.drift', framing: { zoom: 1.5 }, base: { x: 10, scale: 0.8 } } });
		expect((r as any).keys.scale).toBeGreaterThan(40);
		expect(value(c.getProject(), 'a', 'scale', 0)).toBeCloseTo(0.8 * 1.5, 6);
		const r2 = await c.setClipCameraMove('a', 'transition', { move: 'fake.whip', preset: 'Clean' }, { from: { zoom: 1 } });
		expect(r2).toMatchObject({ ok: true, cuts: [200], windows: { in: { start: 0, end: 400 }, during: { start: 400, end: 2000 } }, camera: { in: { move: 'fake.whip', ms: 400, preset: 'Clean', values: { blur: 0 } } } });
		expect(checkVideoProject(c.getProject()).filter((i) => i.code === 'camera-stale')).toEqual([]);
		// Saved and opened again, the baked keys play without the provider.
		const reopened = parseVideoProject(JSON.parse(JSON.stringify(c.getProject())));
		expect(clipOf(reopened, 'a').camera).toEqual(clipOf(c.getProject(), 'a').camera);
		expect(value(reopened, 'a', 'x', 1000)).toBe(value(c.getProject(), 'a', 'x', 1000));
		expect(await c.clearClipCameraMove('a', 'transition')).toMatchObject({ ok: true, camera: { during: 'fake.drift' } });
		expect(await c.clearClipCameraMove('a', 'hold')).toMatchObject({ ok: true, camera: null });
		expect(clipOf(c.getProject(), 'a').transform).toEqual({ x: 10, scale: 0.8 });
		expect(clipOf(c.getProject(), 'a').camera).toBeUndefined();
		c.undo();
		expect(clipOf(c.getProject(), 'a').camera?.during).toBe('fake.drift');
	});

	it('warns when a trim leaves the baked move stale', async () => {
		const c = make();
		await c.setClipCameraMove('a', 'hold', 'fake.drift');
		const trimmed = applyVideoEdits(c.getProject(), { op: 'trim_clip', clip: 'a', edge: 'end', to: 1500 });
		expect(trimmed.ok).toBe(true);
		const stale = checkVideoProject((trimmed as any).project).find((i) => i.code === 'camera-stale');
		expect(stale?.message).toMatch(/baked for 2000 ms but the clip is 1500 ms.*set the move again/);
	});

	it('refuses with what to do next and changes nothing', async () => {
		const c = make();
		const before = c.getProject();
		expect(await c.setClipCameraMove('zz', 'hold', 'fake.drift')).toMatchObject({ ok: false, error: expect.stringContaining('There is no clip "zz"; the clips are "a", "b", "fix"') });
		expect(await c.setClipCameraMove('fix', 'hold', 'fake.drift')).toMatchObject({ ok: false, error: expect.stringContaining('adjustment clip') });
		expect(await c.setClipCameraMove('a', 'transition', 'fake.drift')).toMatchObject({ ok: false, error: expect.stringContaining('camera "in" takes one of "fake.glide", "fake.whip"') });
		expect(await c.setClipCameraMove('a', 'hold', 'fake.drift', { from: { zoom: 2 } })).toMatchObject({ ok: false, error: expect.stringContaining('"from" is where a move in starts') });
		expect(await c.clearClipCameraMove('a', 'hold')).toMatchObject({ ok: false, error: 'Clip "a" has no camera "during" move to clear.' });
		expect(await make(plain).setClipCameraMove('a', 'hold', 'fake.drift')).toMatchObject({ ok: false, error: expect.stringContaining('has no camera moves') });
		const keyed = make(camera, { transform: { x: { keys: [{ t: 0, v: 0 }, { t: 100, v: 5 }] } } });
		expect(await keyed.setClipCameraMove('a', 'hold', 'fake.drift')).toMatchObject({ ok: false, error: expect.stringContaining('keys its x, which a camera move would replace') });
		expect(c.getProject()).toBe(before);
	});
});

describe('video camera move tools', () => {
	const setup = (provider: ReturnType<typeof createFakeEffectProvider> | null = camera, readOnly = false) => {
		const controller = new VideoEditorController({ project: project(), effects: provider, readOnly });
		const registry = new ToolRegistry();
		registry.register(createVideoEffectsToolProvider(controller, { namespace: '' }));
		return { controller, registry };
	};
	const data = (r: { structuredContent?: unknown }) => r.structuredContent as any;
	const error = (r: { isError?: boolean; content: { type: string; text?: string }[] }) => (expect(r.isError).toBe(true), r.content.map((x) => x.text).join(' '));

	it('lists moves by role, or says why there are none', async () => {
		const { registry } = setup();
		expect(data(await registry.callTool('list_video_camera_moves', { role: 'hold' })).moves.map((m: any) => m.id)).toEqual(['fake.drift']);
		expect(data(await setup(plain).registry.callTool('list_video_camera_moves', {}))).toMatchObject({ available: false, reason: expect.stringContaining('has no camera moves') });
		error(await registry.callTool('list_video_camera_moves', { role: 'zoom' }));
	});

	it('sets and clears a move, returning the baked keys, cuts and windows', async () => {
		const { registry, controller } = setup();
		const set = data(await registry.callTool('set_clip_camera_move', { clip: 'a', role: 'transition', move: 'fake.whip', ms: 400, values: { blur: 0 }, framing: { zoom: 2, x: 40 } }));
		expect(set).toMatchObject({ clip: 'a', cuts: [200], windows: { in: { start: 0, end: 400 } }, camera: { in: { move: 'fake.whip', ms: 400, values: { blur: 0 } }, framing: { zoom: 2, x: 40 } } });
		expect(set.keys.x).toBeGreaterThan(10);
		expect(set.notes).toBeUndefined();
		expect(data(await registry.callTool('clear_clip_camera_move', { clip: 'a', role: 'transition' }))).toMatchObject({ clip: 'a', camera: null });
		expect(clipOf(controller.getProject(), 'a').transform).toBeUndefined();
	});

	it('refuses bad arguments the way a model can act on', async () => {
		const { registry, controller } = setup();
		const before = controller.getProject();
		expect(error(await registry.callTool('set_clip_camera_move', { clip: 'a', role: 'hold', move: 'fake.whip' }))).toContain('"fake.whip" moves the camera into a shot, so it goes in camera "in", not "during"; camera "during" takes one of "fake.drift".');
		expect(error(await registry.callTool('set_clip_camera_move', { clip: 'a', role: 'hold', move: 'fake.drift', ms: 300 }))).toContain('set the hold\'s length instead');
		expect(error(await registry.callTool('set_clip_camera_move', { clip: 'a', role: 'transition', move: 'fake.glide', ms: 5000 }))).toContain('longer than the clip (2000 ms)');
		expect(error(await registry.callTool('set_clip_camera_move', { clip: 'a', role: 'transition', move: 'fake.glide', framing: { zoom: 0 } }))).toMatch(/zoom/);
		expect(error(await registry.callTool('set_clip_camera_move', { clip: 'a', move: 'fake.glide' }))).toMatch(/role/);
		expect(error(await registry.callTool('set_clip_camera_move', { clip: 'a', role: 'transition', move: 'fake.glide', speed: 2 }))).toMatch(/speed/);
		expect(error(await setup(null).registry.callTool('set_clip_camera_move', { clip: 'a', role: 'hold', move: 'fake.drift' }))).toMatch(/No effects provider/);
		expect(controller.getProject()).toBe(before);
	});

	it('hides the writes on a read-only project, keeping the list', () => {
		const names = setup(camera, true).registry.listTools().tools.map((t) => t.name);
		expect(names).toContain('list_video_camera_moves');
		expect(names).not.toContain('set_clip_camera_move');
		expect(names).not.toContain('clear_clip_camera_move');
	});
});
