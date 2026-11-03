import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { createFakeEffectProvider } from '../src/effects';
import { VideoEditorController, createVideoEffectsToolProvider, framePointsToPicture, parseVideoProject, videoClipPicture, videoFrameAt } from '../src/video-editor';

/** A 400×200 frame: a 200×100 picture clip (contained, so doubled), and room for an effect clip on a second track. */
const project = () =>
	parseVideoProject({
		version: 1,
		width: 400,
		height: 200,
		fps: 10,
		assets: [{ id: 'img', kind: 'image', src: 'img.png', width: 200, height: 100 }],
		tracks: [
			{ id: 'v1', kind: 'video', clips: [{ id: 'pic', type: 'media', asset: 'img', start: 0, duration: 2000 }] },
			{ id: 'v2', kind: 'video', clips: [] },
		],
	});

function setup() {
	const controller = new VideoEditorController({ project: project(), effects: createFakeEffectProvider() });
	const registry = new ToolRegistry();
	registry.register(createVideoEffectsToolProvider(controller, { namespace: '' }));
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = await registry.callTool(name, args);
		return { error: r.isError ? (r.content[0] as { text: string }).text : null, data: r.structuredContent as any };
	};
	return { controller, call };
}

describe('effects along a path in the video editor', () => {
	it('search finds path effects, and describe names their path controls', async () => {
		const { call } = setup();
		const found = await call('search_effects', { accepts: ['path'] });
		expect(found.data.effects.map((e: { id: string }) => e.id)).toEqual(['fake.trail', 'fake.route']);
		expect(found.data.effects[0].accepts).toEqual(['path']);
		expect((await call('describe_effect', { effect: 'fake.trail' })).data.pathControls).toEqual(['path']);
		expect((await call('describe_effect', { effect: 'fake.gradient' })).data.pathControls).toBeUndefined();
	});

	it('runs an effect clip along frame points, which reach the effect as drawn', async () => {
		const { controller, call } = setup();
		const added = await call('add_video_effect_clip', { effect: 'fake.trail', track: 'v2', start: 0, duration: 1000 });
		expect(added.error).toBeNull();
		const clip = added.data.clip ?? added.data.id ?? controller.getProject().tracks[1].clips[0].id;
		const r = await call('set_video_effect_path', { clip, instance: 'generator', points: [40, 50, 360, 150] });
		expect(r.error).toBeNull();
		expect(r.data).toMatchObject({ control: 'path', value: [40, 50, 360, 150] });
		// The frame's effect layer carries the path, and the effect draws on it at the project size.
		const layer = videoFrameAt(controller.getProject(), 100).layers.find((l) => l.generator?.effect === 'fake.trail')!;
		expect(layer.generator!.values.path).toEqual([40, 50, 360, 150]);
		const renderer = await createFakeEffectProvider().createRenderer('fake.trail', { width: 400, height: 200 });
		const out = await renderer.render({ time: 0, values: layer.generator!.values as never });
		const alpha = (x: number, y: number) => out.data[(y * 400 + x) * 4 + 3];
		expect(alpha(200, 100)).toBe(255);
		expect(alpha(200, 20)).toBe(0);
		// One undo step.
		controller.undo();
		expect(controller.getProject().tracks[1].clips[0].values?.path ?? '').toBe('');
	});

	it('maps frame points into a clip effect\'s source pixels, so it follows a moved, scaled clip', async () => {
		const { controller, call } = setup();
		await call('apply_effect', { target: 'pic', effect: 'fake.trail' });
		const instance = controller.getProject().tracks[0].clips[0].effects![0].id;
		const r = await call('set_video_effect_path', { clip: 'pic', instance, points: [100, 50, 300, 150] });
		expect(r.error).toBeNull();
		// The picture is contained: 200×100 doubled to fill the 400×200 frame, so frame pixels halve.
		expect(r.data.value).toEqual([50, 25, 150, 75]);
		// The mapping round-trips through the placement, moved and turned too.
		const moved = { ...controller.getProject().tracks[0].clips[0], transform: { x: 30, y: -10, scale: 0.5, rotation: 30 } };
		const picture = videoClipPicture(controller.getProject(), moved as never);
		const [px, py] = framePointsToPicture([210, 95], picture);
		const a = (30 * Math.PI) / 180;
		const fx = picture.rect.x + (px / picture.size.width) * picture.rect.width;
		const fy = picture.rect.y + (py / picture.size.height) * picture.rect.height;
		const cx = picture.rect.x + picture.rect.width / 2;
		const cy = picture.rect.y + picture.rect.height / 2;
		expect(cx + (fx - cx) * Math.cos(a) - (fy - cy) * Math.sin(a)).toBeCloseTo(210, 1);
		expect(cy + (fx - cx) * Math.sin(a) + (fy - cy) * Math.cos(a)).toBeCloseTo(95, 1);
	});

	it('takes a mask outline, path data or words, and clears with ""', async () => {
		const { controller, call } = setup();
		await call('apply_effect', { target: 'pic', effect: 'fake.trail' });
		const instance = controller.getProject().tracks[0].clips[0].effects![0].id;
		const fx = () => controller.getProject().tracks[0].clips[0].effects![0].values!.path;
		expect((await call('set_video_effect_path', { clip: 'pic', instance, mask: { clip: 'pic' } })).error).toMatch(/has no mask; add one with set_video_clip_mask/);
		controller.apply({ op: 'update_clip', clip: 'pic', set: { mask: { shape: 'rectangle', x: 0.5, y: 0.5, width: 0.5, height: 0.5 } } } as never, 'Mask');
		const masked = await call('set_video_effect_path', { clip: 'pic', instance, mask: { clip: 'pic' } });
		expect(masked.error).toBeNull();
		// A closed rectangle in source pixels: the middle half of the 200×100 picture.
		const pts = masked.data.value as number[];
		expect(pts.slice(0, 2)).toEqual(pts.slice(-2));
		expect(Math.min(...pts.filter((_, i) => i % 2 === 0))).toBeCloseTo(50, 0);
		expect(Math.max(...pts.filter((_, i) => i % 2 === 0))).toBeCloseTo(150, 0);
		expect((await call('set_video_effect_path', { clip: 'pic', instance, d: 'M0 0 C 10 0 10 10 20 10' })).data.value).toBe('M0 0 C 10 0 10 10 20 10');
		const words = await call('set_video_effect_path', { clip: 'pic', instance, text: { text: 'hi' } });
		expect(words.data.value).toMatch(/^M0 10 L3 0/);
		expect((await call('set_video_effect_path', { clip: 'pic', instance, text: { text: 'hi', font: 'serif' } })).error).toMatch(/no font "serif"/);
		await call('set_video_effect_path', { clip: 'pic', instance, d: '' });
		expect(fx()).toBe('');
	});

	it('refuses what it cannot run along a path, saying what to do, and changes nothing', async () => {
		const { controller, call } = setup();
		await call('apply_effect', { target: 'pic', effect: 'fake.tint' });
		const tint = controller.getProject().tracks[0].clips[0].effects![0].id;
		const before = JSON.stringify(controller.getProject());
		expect((await call('set_video_effect_path', { clip: 'pic', instance: tint, points: [0, 0, 10, 10] })).error).toMatch(/does not draw along a path. Find one that does with search_effects accepts \["path"\]/);
		expect((await call('set_video_effect_path', { clip: 'pic', instance: 'nope', points: [0, 0, 10, 10] })).error).toMatch(/has no effect "nope"/);
		expect((await call('set_video_effect_path', { clip: 'pic', instance: tint, points: [0, 0, 10, 10], d: 'M0 0' })).error).not.toBeNull();
		expect((await call('set_video_effect_path', { clip: 'ghost', instance: tint, d: '' })).error).not.toBeNull();
		expect(JSON.stringify(controller.getProject())).toBe(before);
	});
});
