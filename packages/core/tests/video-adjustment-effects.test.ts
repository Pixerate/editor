import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import { createFakeEffectProvider } from '../src/effects/fake';
import {
	animationEasingToVideoEase,
	applyVideoEdits,
	applyVideoGrade,
	applyVideoLutToPixels,
	checkVideoProject,
	createVideoEditorToolProvider,
	createVideoProject,
	drawVideoFrame,
	normalizeVideoGradeLut,
	openVideoClipEffectAuthoring,
	parseVideoProject,
	toVideoEdl,
	toVideoFfmpeg,
	VideoEditorController,
	videoClipEffectDocument,
	videoClipLabel,
	videoEaseToAnimationEasing,
	videoEffectValuesFromDocument,
	videoFfmpegUnsupportedFeatures,
	videoFrameAt,
	videoLayerMask,
	videoLutFromFunction,
	videoMaskContains,
	videoMaskPolygon,
	videoProjectSvg,
	videoSkinToneWeight,
	type VideoEdit,
	type VideoLayer,
	type VideoProject
} from '../src/video-editor';

const ok = (p: VideoProject, edits: VideoEdit | VideoEdit[]) => {
	const r = applyVideoEdits(p, edits);
	if (!r.ok) throw new Error(r.error);
	return r.project;
};

/** Three video tracks: titles on top, an adjustment track in the middle, footage at the bottom. */
const base = () =>
	ok(createVideoProject({ width: 160, height: 90, fps: 25 }), [
		{ op: 'add_asset', asset: { id: 'shot', kind: 'image', src: 'shot.png', width: 160, height: 90 } },
		{ op: 'add_track', track: { id: 'fx', kind: 'video' }, at: 0 },
		{ op: 'add_track', track: { id: 'top', kind: 'video' }, at: 0 },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'a', asset: 'shot', start: 0, duration: 2000 } },
		{ op: 'add_clip', track: 'top', clip: { type: 'text', id: 't', text: 'Hi', start: 0, duration: 2000 } }
	]);
const withAdjustment = (fields: Record<string, unknown> = {}) => ok(base(), { op: 'add_clip', track: 'fx', clip: { type: 'adjustment', id: 'adj', start: 500, duration: 1000, grade: { saturation: -1 }, ...fields } as any });

/** A recording 2D context; `getImageData` returns `fill` everywhere. */
function recorder(fill: [number, number, number, number] = [0, 0, 0, 0]) {
	const calls: { op: string; args: unknown[]; composite?: string; filter?: string }[] = [];
	const state: any = { globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none', measureText: () => ({ width: 0 }) };
	state.getImageData = (_x: number, _y: number, w: number, h: number) => {
		const data = new Uint8ClampedArray(w * h * 4);
		for (let i = 0; i < data.length; i += 4) data.set(fill, i);
		return { width: w, height: h, data };
	};
	const ctx = new Proxy(state, {
		get: (t, k: string) => (k in t ? t[k] : (...args: unknown[]) => calls.push({ op: k, args, composite: t.globalCompositeOperation, filter: t.filter })),
		set: (t, k, v) => ((t[k] = v), true)
	});
	return { ctx, calls };
}

describe('adjustment clips', () => {
	it('parse with a scope, need a target for scope "track", and refuse audio tracks', () => {
		const p = withAdjustment({ scope: 'track', targetTrack: 'v1' });
		const clip = p.tracks.find((t) => t.id === 'fx')!.clips[0];
		expect(clip).toMatchObject({ type: 'adjustment', scope: 'track', targetTrack: 'v1' });
		expect(parseVideoProject(JSON.stringify(p))).toEqual(p);
		expect(() => withAdjustment({ scope: 'track' })).toThrow(/targetTrack is required when scope is "track"/);
		expect(() => withAdjustment({ targetTrack: 'v1' })).toThrow(/targetTrack is only for scope "track"/);
		expect(applyVideoEdits(base(), { op: 'add_clip', track: 'fx', clip: { type: 'adjustment', scope: 'track', targetTrack: 'v9', duration: 500 } as any })).toMatchObject({ ok: false, error: expect.stringMatching(/targets track "v9".*which does not exist/) });
		expect(applyVideoEdits(base(), { op: 'add_clip', track: 'a1', clip: { type: 'adjustment', duration: 500 } as any })).toMatchObject({ ok: false, error: expect.stringContaining('audio track') });
		expect(videoClipLabel(clip)).toBe('Adjustment (v1)');
	});

	it('wrap the pictures underneath while they play, and nothing outside their time', () => {
		const p = withAdjustment();
		expect(videoFrameAt(p, 200).layers.map((l) => l.clip)).toEqual(['a', 't']);
		const layers = videoFrameAt(p, 1000).layers;
		expect(layers.map((l) => l.clip)).toEqual(['adj', 't']);
		const adj = layers[0];
		expect(adj).toMatchObject({ type: 'adjustment', adjustment: { scope: 'underneath' }, grade: { saturation: -1 }, rect: { x: 0, y: 0, width: 160, height: 90 } });
		expect(adj.layers!.map((l) => l.clip)).toEqual(['a']);
	});

	it('scope "all" wraps every track; scope "track" only its target, in place', () => {
		const all = videoFrameAt(withAdjustment({ scope: 'all' }), 1000).layers;
		expect(all.map((l) => l.clip)).toEqual(['adj']);
		expect(all[0].layers!.map((l) => l.clip)).toEqual(['a', 't']);
		const only = videoFrameAt(withAdjustment({ scope: 'track', targetTrack: 'top' }), 1000).layers;
		expect(only.map((l) => l.clip)).toEqual(['a', 'adj']);
		expect(only[1].layers!.map((l) => l.clip)).toEqual(['t']);
	});

	it('keep the unadjusted pictures beneath when they mix (opacity, mask), and change nothing without a look', () => {
		const half = videoFrameAt(withAdjustment({ opacity: 0.5 }), 1000).layers;
		expect(half.map((l) => l.clip)).toEqual(['a', 'adj', 't']);
		expect(half[1].opacity).toBe(0.5);
		const masked = videoFrameAt(withAdjustment({ mask: { shape: 'ellipse' } }), 1000).layers;
		expect(masked.map((l) => l.clip)).toEqual(['a', 'adj', 't']);
		expect(masked[1].mask!.points.length).toBe(64);
		const empty = ok(base(), { op: 'add_clip', track: 'fx', clip: { type: 'adjustment', id: 'adj', start: 0, duration: 1000 } as any });
		expect(videoFrameAt(empty, 500).layers.map((l) => l.clip)).toEqual(['a', 't']);
	});

	it('draw as one picture of what is underneath, graded (SVG and canvas)', () => {
		const p = withAdjustment();
		const svg = videoProjectSvg(p, 1000);
		expect(svg).toMatch(/<g filter="url\(#g0\)" style="isolation:isolate">|<g style="isolation:isolate" filter="url\(#g0\)">|<g [^>]*filter="url\(#g0\)"[^>]*>/);
		const main = recorder();
		const group = recorder();
		const canvas = { id: 'group' } as unknown as CanvasImageSource;
		drawVideoFrame(main.ctx, videoFrameAt(p, 1000), () => ({ id: 'img' }) as unknown as CanvasImageSource, 1, { scratch: () => ({ canvas, ctx: group.ctx }) });
		// The footage is drawn into the group, which is laid on the frame with the grade's filter.
		expect(group.calls.some((c) => c.op === 'drawImage')).toBe(true);
		const laid = main.calls.find((c) => c.op === 'drawImage' && c.args[0] === canvas)!;
		expect(laid.filter).toContain('saturate(0)');
	});

	it('export to ffmpeg as an enabled grade on the composite, and are left out of EDLs', () => {
		const p = withAdjustment();
		const out = toVideoFfmpeg(p, { titleImage: () => 't.png' });
		expect(out.filterComplex).toMatch(/format=rgba,colorchannelmixer=[^;]*:enable='between\(t,0\.5,1\.5\)',format=yuva420p\[adj\d+\]/);
		const all = toVideoFfmpeg(withAdjustment({ scope: 'all' }), { titleImage: () => 't.png' });
		expect(all.filterComplex).toMatch(/enable='between\(t,0\.5,1\.5\)'/);
		expect(toVideoEdl(p, { track: 'fx' })).not.toContain('BL');
	});

	it('refuse what ffmpeg cannot draw unless frames are rendered', () => {
		const p = withAdjustment({ scope: 'track', targetTrack: 'v1', fadeIn: 200 });
		expect(videoFfmpegUnsupportedFeatures(p)).toEqual(['adjustment clip "adj" changes one track only, fades']);
		expect(() => toVideoFfmpeg(p)).toThrow(/ffmpeg's filters cannot draw adjustment clip "adj"/);
		expect(() => toVideoFfmpeg(p, { frames: { input: 'f/%06d.png' } })).not.toThrow();
	});

	it('warn when scope "track" points at no track beside them', () => {
		const p = parseVideoProject({ ...withAdjustment(), tracks: withAdjustment().tracks.map((t) => (t.id === 'fx' ? { ...t, clips: [{ ...t.clips[0], scope: 'track', targetTrack: 'gone' }] } : t)) } as any);
		expect(checkVideoProject(p).find((i) => i.code === 'missing-target-track')).toMatchObject({ severity: 'warning', clip: 'adj' });
	});
});

describe('clip masks', () => {
	const rect = { x: 0, y: 0, width: 100, height: 50 };
	it('resolve shapes to outlines in frame pixels', () => {
		const box = videoMaskPolygon({ shape: 'rectangle', width: 0.5, height: 0.5 }, rect);
		expect(box).toEqual([[25, 12.5], [75, 12.5], [75, 37.5], [25, 37.5]]);
		const rounded = videoMaskPolygon({ shape: 'rectangle', cornerRadius: 1 }, rect);
		expect(rounded.length).toBe(36);
		const ellipse = videoLayerMask({ shape: 'ellipse', width: 1, height: 1 }, rect);
		expect(videoMaskContains(ellipse, 50, 25)).toBe(true);
		expect(videoMaskContains(ellipse, 2, 2)).toBe(false);
		const split = videoLayerMask({ shape: 'linear' }, rect);
		expect(videoMaskContains(split, 50, 10)).toBe(true);
		expect(videoMaskContains(split, 50, 40)).toBe(false);
		const turned = videoLayerMask({ shape: 'linear', rotation: 90 }, rect);
		// Turned a quarter clockwise, the kept side is the right.
		expect(videoMaskContains(turned, 90, 25)).toBe(true);
		const tri = videoLayerMask({ shape: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], inverted: true }, rect);
		expect(videoMaskContains(tri, 5, 5)).toBe(false);
		expect(videoMaskContains(tri, 95, 45)).toBe(true);
	});

	it('parse, follow the clip and draw in SVG and on the canvas', () => {
		const p = ok(base(), { op: 'update_clip', clip: 'a', set: { mask: { shape: 'ellipse', feather: 10, inverted: true } } });
		expect(() => ok(base(), { op: 'update_clip', clip: 'a', set: { mask: { shape: 'polygon' } } })).toThrow(/points is required/);
		expect(() => ok(base(), { op: 'update_clip', clip: 'a', set: { mask: { shape: 'star' } } })).toThrow(/mask.shape must be one of/);
		const layer = videoFrameAt(p, 100).layers.find((l) => l.clip === 'a') as VideoLayer;
		expect(layer.mask).toMatchObject({ feather: 10, inverted: true });
		const svg = videoProjectSvg(p, 100);
		expect(svg).toContain('<mask id="m0"');
		expect(svg).toContain('feGaussianBlur stdDeviation="5"');
		const main = recorder();
		const scratch = recorder();
		drawVideoFrame(main.ctx, videoFrameAt(p, 100), () => ({ id: 'img' }) as unknown as CanvasImageSource, 1, { scratch: () => ({ canvas: {} as CanvasImageSource, ctx: scratch.ctx }) });
		const fill = scratch.calls.find((c) => c.op === 'fill')!;
		expect(fill.composite).toBe('destination-out');
		expect(fill.filter).toBe('blur(5px)');
		expect(scratch.calls.filter((c) => c.op === 'lineTo').length).toBe(63);
	});
});

describe('skin-tone protected LUTs', () => {
	const GREEN = videoLutFromFunction(9, () => [0, 1, 0]);
	it('find skin by chroma, across complexions, and not sky, grass or grey', () => {
		expect(videoSkinToneWeight(224 / 255, 172 / 255, 140 / 255)).toBe(1);
		expect(videoSkinToneWeight(141 / 255, 85 / 255, 36 / 255)).toBe(1);
		expect(videoSkinToneWeight(100 / 255, 150 / 255, 230 / 255)).toBe(0);
		expect(videoSkinToneWeight(60 / 255, 160 / 255, 60 / 255)).toBe(0);
		expect(videoSkinToneWeight(0.5, 0.5, 0.5)).toBe(0);
		expect(videoSkinToneWeight(0, 0, 0)).toBe(0);
	});

	it('hold the LUT back on skin, by the amount, in pixels and single colours', () => {
		const px = new Uint8ClampedArray([224, 172, 140, 255, 100, 150, 230, 255]);
		applyVideoLutToPixels(GREEN, px, 1, 1);
		expect([...px.slice(0, 3)]).toEqual([224, 172, 140]);
		expect([...px.slice(4, 7)]).toEqual([0, 255, 0]);
		const half = applyVideoGrade({ lut: { src: 'x', preserveSkinTones: 0.5 } }, [224, 172, 140], GREEN);
		expect(half).toEqual([112, 214, 70]);
		expect(normalizeVideoGradeLut({ src: 'x', preserveSkinTones: 2 })).toEqual({ src: 'x', preserveSkinTones: 1 });
		expect(normalizeVideoGradeLut({ src: 'x', preserveSkinTones: 0 })).toEqual({ src: 'x' });
	});

	it('are applied by the canvas LUT pass and noted by the ffmpeg export', () => {
		const p = ok(base(), { op: 'update_clip', clip: 'a', set: { grade: { lut: { src: '/luts/green.cube', preserveSkinTones: 1 } } } });
		const main = recorder();
		const scratch = recorder([224, 172, 140, 255]);
		drawVideoFrame(main.ctx, videoFrameAt(p, 100), () => ({ id: 'img' }) as unknown as CanvasImageSource, 1, { lutFor: () => GREEN, scratch: () => ({ canvas: {} as CanvasImageSource, ctx: scratch.ctx }) });
		const put = scratch.calls.find((c) => c.op === 'putImageData')!;
		expect([...(put.args[0] as ImageData).data.slice(0, 3)]).toEqual([224, 172, 140]);
		expect(toVideoFfmpeg(p, { titleImage: () => 't.png' }).notes.join(' ')).toMatch(/protects skin tones in the preview, which ffmpeg's lut3d cannot/);
	});
});

describe('adjustment, mask and skin tools', () => {
	const setup = (luts?: (src: string) => Promise<string>) => {
		const controller = new VideoEditorController({ clock: new ManualClock(), project: base(), luts: luts ?? (async () => 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n') });
		const registry = new ToolRegistry();
		registry.register(createVideoEditorToolProvider(controller, { namespace: '' }));
		const call = async (name: string, args: Record<string, unknown>) => {
			const r = await registry.callTool(name, args);
			if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
			return r.structuredContent as any;
		};
		const fail = async (name: string, args: Record<string, unknown>) => {
			const r = await registry.callTool(name, args);
			expect(r.isError, `${name} should fail`).toBe(true);
			return r.content.map((c) => ('text' in c ? c.text : '')).join('\n');
		};
		return { controller, call, fail };
	};

	it('add_video_adjustment_clip adds a look over what is underneath, as one undo step', async () => {
		const { controller, call, fail } = setup();
		const r = await call('add_video_adjustment_clip', { track: 'fx', start: 0, duration: 1000, preset: 'cool', amount: 0.5, grade: { exposure: 0.5 }, name: 'Night' });
		expect(r.clip).toMatchObject({ type: 'adjustment', track: 'fx', start: 0, duration: 1000, end: 1000, name: 'Night', grade: { exposure: 0.5, temperature: -0.2 } });
		expect(controller.getState().undoLabel).toBe('Add adjustment clip');
		const bare = await call('add_video_adjustment_clip', { track: 'fx', start: 1000 });
		expect(bare.hint).toMatch(/changes nothing yet/);
		expect(await fail('add_video_adjustment_clip', { track: 'a1' })).toMatch(/audio track/);
		expect(await fail('add_video_adjustment_clip', { track: 'fx', scope: 'track' })).toMatch(/needs target_track/);
		expect(await fail('add_video_adjustment_clip', { track: 'fx', target_track: 'v1' })).toMatch(/only for scope "track"/);
		expect(await fail('add_video_adjustment_clip', { track: 'fx', scope: 'sideways' })).toMatch(/scope/);
	});

	it('set_video_clip_mask and remove_video_clip_mask', async () => {
		const { call, fail } = setup();
		const r = await call('set_video_clip_mask', { clip: 'a', shape: 'rectangle', width: 0.4, height: 0.6, corner_radius: 0.5, feather: 30 });
		expect(r.clip.mask).toEqual({ shape: 'rectangle', width: 0.4, height: 0.6, cornerRadius: 0.5, feather: 30 });
		expect(await fail('set_video_clip_mask', { clip: 'a', shape: 'polygon' })).toMatch(/needs "points"/);
		expect(await fail('set_video_clip_mask', { clip: 'a', shape: 'ellipse', corner_radius: 0.2 })).toMatch(/only for shape "rectangle"/);
		expect(await fail('set_video_clip_mask', { clip: 'nope', shape: 'ellipse' })).toMatch(/There is no clip "nope"/);
		expect(await fail('set_video_clip_mask', { clip: 'a', shape: 'ellipse', extra: 1 })).toMatch(/extra/);
		expect((await call('remove_video_clip_mask', { clip: 'a' })).clip.mask).toBeUndefined();
		expect(await fail('remove_video_clip_mask', { clip: 'a' })).toMatch(/has no mask/);
	});

	it('set_video_lut takes preserve_skin_tones, and set_video_skin_protection changes it', async () => {
		const { call, fail } = setup();
		const r = await call('set_video_lut', { clips: ['a'], src: 'look.cube', preserve_skin_tones: 0.7 });
		expect(r.clips[0].grade.lut).toMatchObject({ src: 'look.cube', preserveSkinTones: 0.7 });
		expect((await call('set_video_skin_protection', { clips: ['a'], amount: 0.3 })).clips[0].lut.preserveSkinTones).toBe(0.3);
		expect((await call('set_video_skin_protection', { clips: ['a'], amount: 0 })).clips[0].lut.preserveSkinTones).toBeUndefined();
		expect(await fail('set_video_skin_protection', { clips: ['t'], amount: 0.5 })).toMatch(/has no LUT/);
		expect(await fail('set_video_skin_protection', { clips: ['a'], amount: 2 })).toMatch(/amount/);
	});
});

describe('adjustment clip effects in the effect authoring editor', () => {
	it('convert eases both ways and bake curves video keys cannot hold', () => {
		expect(videoEaseToAnimationEasing([0.1, 0.2, 0.3, 0.4])).toEqual({ type: 'cubic-bezier', x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 });
		expect(videoEaseToAnimationEasing('hold')).toBe('hold');
		expect(animationEasingToVideoEase('ease')).toEqual([0.25, 0.1, 0.25, 1]);
		expect(animationEasingToVideoEase({ type: 'spring' })).toBeNull();
		const { values, notes } = videoEffectValuesFromDocument({
			values: { amount: 0, tint: '#ff0000' },
			tracks: {
				amount: [
					{ time: 0, value: 0, easing: { type: 'spring' } },
					{ time: 1000, value: 1 }
				],
				tint: [
					{ time: 0, value: '#ff0000' },
					{ time: 500, value: '#00ff00' }
				]
			}
		});
		expect((values.amount as any).keys.length).toBe(13);
		expect((values.amount as any).keys.at(-1)).toEqual({ t: 1000, v: 1 });
		expect(values.tint).toBe('#ff0000');
		expect(notes.join(' ')).toMatch(/spring or elastic/);
		expect(notes.join(' ')).toMatch(/non-numeric/);
	});

	it('open an adjustment clip effect as a session with its keys as tracks, and write it back as one undo step', async () => {
		const provider = createFakeEffectProvider();
		const controller = new VideoEditorController({ clock: new ManualClock(), project: withAdjustment(), effects: provider });
		const numeric = { id: 'fake.invert' };
		const d = await provider.describe(numeric.id);
		const control = Object.entries(d.controls.properties).find(([, s]: any) => s.type === 'number')![0];
		const applied = await controller.applyClipEffect('adj', numeric.id);
		expect(applied.ok).toBe(true);
		const instance = (applied as any).effect.id;
		await controller.setClipEffectKeyframes('adj', instance, control, [
			{ t: 0, v: (d.controls.properties[control] as any).minimum ?? 0, ease: 'ease-in' },
			{ t: 800, v: (d.controls.properties[control] as any).maximum ?? 1 }
		]);
		const clip = controller.getProject().tracks.find((t) => t.id === 'fx')!.clips[0];
		const doc = videoClipEffectDocument(clip, instance, provider.id);
		expect(doc.duration).toBe(1000);
		expect(doc.tracks[control]).toEqual([
			{ time: 0, value: (d.controls.properties[control] as any).minimum ?? 0, easing: 'ease-in' },
			{ time: 800, value: (d.controls.properties[control] as any).maximum ?? 1 }
		]);
		const authoring = await openVideoClipEffectAuthoring(controller, 'adj', instance, { schedule: () => () => {} });
		expect(authoring.session.getState().tracks[control].length).toBe(2);
		expect(authoring.session.removeKeyframe(control, 800).ok).toBe(true);
		const before = controller.history.undoStack?.length;
		const r = await authoring.commit();
		expect(r.ok).toBe(true);
		const values = controller.getProject().tracks.find((t) => t.id === 'fx')!.clips[0].effects![0].values!;
		expect((values[control] as any).keys.length).toBe(1);
		expect(controller.getState().canUndo).toBe(true);
		if (before !== undefined) expect(controller.history.undoStack.length).toBe(before + 1);
		authoring.dispose();
		await expect(openVideoClipEffectAuthoring(controller, 'adj', 'nope')).rejects.toThrow(/has no effect "nope"/);
		await expect(openVideoClipEffectAuthoring(new VideoEditorController(), 'adj', instance)).rejects.toThrow(/No effects provider/);
	});
});
