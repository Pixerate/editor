import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import {
	createVideoEditorToolProvider,
	parseVideoPreviewScale,
	parseVideoProject,
	resolveVideoPreviewScale,
	toVideoEdl,
	toVideoFfmpeg,
	VIDEO_PREVIEW_SCALE_OPTIONS,
	VideoEditorController,
	videoAssetProxy,
	VideoPreviewEngine,
	videoPreviewSrc,
	videoProjectHasProxies,
	videoProxyFfmpeg,
	videoProxyName,
	videoProxyPlan,
	type VideoAsset,
	type VideoPreviewMedia,
	type VideoProject
} from '../src/video-editor';
import { baseToolName } from '../src/tools';

const clipAsset: VideoAsset = {
	id: 'clip',
	kind: 'video',
	src: 'media/clip.mov',
	duration: 10_000,
	width: 3840,
	height: 2160,
	proxies: [
		{ scale: 0.25, src: 'media/clip.proxy-25.mp4' },
		{ scale: 0.5, src: 'media/clip.proxy-50.mp4' }
	]
};

const project = (): VideoProject => ({
	version: 1,
	width: 1920,
	height: 1080,
	fps: 25,
	assets: [clipAsset, { id: 'raw', kind: 'video', src: 'raw.mp4', duration: 10_000 }, { id: 'song', kind: 'audio', src: 'song.mp3', duration: 10_000 }],
	tracks: [
		{ id: 'v1', kind: 'video', clips: [{ id: 'c', type: 'media', asset: 'clip', start: 0, duration: 4000, in: 1000 }, { id: 'r', type: 'media', asset: 'raw', start: 4000, duration: 1000 }] },
		{ id: 'a1', kind: 'audio', clips: [{ id: 'm', type: 'media', asset: 'song', start: 0, duration: 4000 }] }
	]
});

describe('picking a proxy', () => {
	it('plays the smallest proxy at least as large as the scale, else the original', () => {
		expect(videoAssetProxy(clipAsset, 0.5)!.src).toBe('media/clip.proxy-50.mp4');
		expect(videoAssetProxy(clipAsset, 0.3)!.src).toBe('media/clip.proxy-50.mp4');
		expect(videoAssetProxy(clipAsset, 0.2)!.src).toBe('media/clip.proxy-25.mp4');
		expect(videoAssetProxy(clipAsset, 0.6)).toBeNull();
		expect(videoAssetProxy(clipAsset, 1)).toBeNull();
		expect(videoPreviewSrc(clipAsset, 0.6)).toBe('media/clip.mov');
		expect(videoPreviewSrc(undefined, 0.5, 'fallback.mp4')).toBe('fallback.mp4');
	});

	it('reads preview scales', () => {
		expect(resolveVideoPreviewScale('auto', 0.4)).toBe(0.4);
		expect(resolveVideoPreviewScale('auto', 2)).toBe(1);
		expect(resolveVideoPreviewScale('full', 0.1)).toBe(1);
		expect(resolveVideoPreviewScale(0.25, 1)).toBe(0.25);
		expect(VIDEO_PREVIEW_SCALE_OPTIONS.map((o) => [o.value, o.label])).toEqual([
			['auto', 'Auto'],
			['full', 'Full'],
			['0.5', '½'],
			['0.25', '¼']
		]);
		expect(VIDEO_PREVIEW_SCALE_OPTIONS.map((o) => parseVideoPreviewScale(o.value))).toEqual(['auto', 'full', 0.5, 0.25]);
		expect(parseVideoPreviewScale('nonsense')).toBe('auto');
		expect(videoProjectHasProxies(project())).toBe(true);
	});

	it('are checked when the project is read', () => {
		const withProxies = (kind: string, proxies: unknown) => ({ ...project(), assets: [{ id: 'x', kind, src: 'x', ...(kind === 'image' ? {} : { duration: 1000 }), proxies }], tracks: [] });
		expect(parseVideoProject(project()).assets[0].proxies).toHaveLength(2);
		expect(() => parseVideoProject(withProxies('image', [{ scale: 0.5, src: 'y' }]))).toThrow('assets[0].proxies are only for video assets.');
		expect(() => parseVideoProject(withProxies('video', [{ scale: 1, src: 'y' }]))).toThrow('assets[0].proxies[0].scale must be less than 1 (0.5 is half size).');
		expect(() => parseVideoProject(withProxies('video', [{ scale: 0.5, src: 'y' }, { scale: 0.5, src: 'z' }]))).toThrow('assets[0].proxies[1].scale repeats 0.5; give each proxy its own scale.');
		expect(() => parseVideoProject(withProxies('video', [{ scale: 0.5, url: 'y' }]))).toThrow('assets[0].proxies[0].url is not a proxy setting; use scale, src, width, height.');
		expect(() => parseVideoProject(withProxies('video', 'y'))).toThrow('assets[0].proxies must be a list of { scale, src }.');
	});
});

describe('making proxies', () => {
	it('builds a short-GOP, scaled H.264 command and the entry to attach', () => {
		expect(videoProxyName('media/clip.mov?v=2', 0.25)).toBe('media/clip.proxy-25.mp4');
		const p = videoProxyFfmpeg(clipAsset, { scale: 0.5, gop: 10 });
		expect(p.args).toEqual(['-y', '-i', 'media/clip.mov', '-vf', 'scale=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'fastdecode', '-crf', '28', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', 'media/clip.proxy-50.mp4']);
		expect(p.proxy).toEqual({ scale: 0.5, src: 'media/clip.proxy-50.mp4', width: 1920, height: 1080 });
		expect(p.command).toMatch(/^ffmpeg -y -i media\/clip.mov -vf 'scale=trunc\(iw\*0.5\/2\)\*2:trunc\(ih\*0.5\/2\)\*2' /);
		expect(videoProxyFfmpeg({ id: 'q', kind: 'video', src: 'q.mp4', hasAudio: false }, { output: 'out.mp4', resolve: () => '/abs/q.mp4' }).args).toEqual(expect.arrayContaining(['-an', '/abs/q.mp4', 'out.mp4']));
		expect(() => videoProxyFfmpeg(clipAsset, { scale: 1 })).toThrow("A proxy's scale must be between 0 and 1 (not including either), not 1; 0.5 is half size.");
		expect(() => videoProxyFfmpeg({ id: 's', kind: 'audio', src: 's.mp3' })).toThrow('Asset "s" is audio; only video assets have proxies.');
	});

	it('plans only the video assets missing a proxy at that scale', () => {
		expect(videoProxyPlan(project()).map((c) => c.asset)).toEqual(['raw']);
		expect(videoProxyPlan(project(), { scale: 0.75 }).map((c) => c.asset)).toEqual(['clip', 'raw']);
		expect(() => videoProxyPlan(project(), { assets: ['song'] })).toThrow('Asset "song" is audio; only video assets have proxies.');
		expect(() => videoProxyPlan(project(), { assets: ['nope'] })).toThrow('There is no asset "nope"');
	});

	it('never reach the export or the EDL', () => {
		const ff = toVideoFfmpeg(project());
		expect(ff.args).toContain('media/clip.mov');
		expect(ff.command).not.toContain('proxy');
		expect(toVideoEdl(project())).not.toContain('proxy');
	});
});

function fakeMedia() {
	const made: VideoPreviewMedia[] = [];
	const createMedia = () => {
		const m: VideoPreviewMedia = { src: '', currentTime: 0, playbackRate: 1, volume: 1, muted: false, paused: true, readyState: 4, preload: '', play: () => {}, pause: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
		made.push(m);
		return m;
	};
	return { made, createMedia };
}

describe('the preview with proxies', () => {
	it('plays the proxy its preview scale picks, switching when the scale changes', () => {
		const c = new VideoEditorController({ project: project(), clock: new ManualClock() });
		expect(c.getState().previewScale).toBe('auto');
		const media = fakeMedia();
		// A canvas shown at a third of the frame's width: auto picks the half-size proxy.
		const engine = new VideoPreviewEngine(c, { width: 0, height: 0, clientWidth: 640 }, { context: null, createMedia: media.createMedia });
		const live = () => media.made.filter((m) => m.src).map((m) => m.src);
		expect(live()).toEqual(['media/clip.proxy-50.mp4', 'song.mp3']);
		c.setPreviewScale(0.25);
		expect(live()).toContain('media/clip.proxy-25.mp4');
		expect(media.made.at(-1)!.currentTime).toBe(1);
		c.setPreviewScale('full');
		expect(media.made.at(-1)!.src).toBe('media/clip.mov');
		// An asset without proxies plays its original at any scale.
		c.setPreviewScale(0.25);
		c.seek(4500);
		expect(media.made.at(-1)!.src).toBe('raw.mp4');
		engine.destroy();
	});

	it('takes the engine\'s own scale over the controller\'s, and refuses nonsense', () => {
		const c = new VideoEditorController({ project: project(), clock: new ManualClock(), previewScale: 0.25 });
		const media = fakeMedia();
		const engine = new VideoPreviewEngine(c, { width: 0, height: 0 }, { context: null, createMedia: media.createMedia, previewScale: 'full' });
		expect(media.made[0].src).toBe('media/clip.mov');
		engine.destroy();
		expect(() => c.setPreviewScale(0)).toThrow('A preview scale is "auto", "full" or a fraction above 0 up to 1 (0.5 is half size), not 0.');
		c.setPreviewScale(1);
		expect(c.getState().previewScale).toBe('full');
		expect(c.getState().canUndo).toBe(false);
	});
});

describe('proxy tools', () => {
	const setup = (readOnly = false) => {
		const controller = new VideoEditorController({ project: project(), clock: new ManualClock(), readOnly });
		const registry = new ToolRegistry();
		registry.register(createVideoEditorToolProvider(controller));
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const r = await registry.callTool(name, args);
			if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
			return r.structuredContent as any;
		};
		const fail = async (name: string, args: Record<string, unknown> = {}) => {
			const r = await registry.callTool(name, args);
			expect(r.isError, `${name} should fail`).toBe(true);
			return r.content.map((c) => ('text' in c ? c.text : '')).join('\n');
		};
		return { controller, registry, call, fail };
	};

	it('plan proxies, attach them in one undo step, and remove them', async () => {
		const { controller, call, fail } = setup();
		const plan = await call('plan_video_proxies', { scale: 0.5 });
		expect(plan.commands.map((c: any) => c.asset)).toEqual(['raw']);
		expect(plan.commands[0].proxy).toEqual({ scale: 0.5, src: 'raw.proxy-50.mp4' });
		const set = await call('set_video_proxies', { asset: 'raw', proxies: [plan.commands[0].proxy] });
		expect(set.asset.proxies).toEqual([{ scale: 0.5, src: 'raw.proxy-50.mp4' }]);
		expect(controller.getState().undoLabel).toBe('Attach proxies');
		expect((await call('plan_video_proxies', {})).note).toBe('Every video asset already has a proxy at this scale.');
		const off = await call('set_video_proxies', { asset: 'raw', proxies: [] });
		expect(off.asset.proxies).toBeUndefined();
		expect(await fail('set_video_proxies', { asset: 'song', proxies: [] })).toMatch('Asset "song" is audio; only video assets have proxies.');
		expect(await fail('set_video_proxies', { asset: 'raw', proxies: [{ scale: 0.5, src: 'a' }, { scale: 0.5, src: 'b' }] })).toMatch('repeats 0.5');
		expect(await fail('set_video_proxies', { asset: 'raw', proxies: [{ scale: 1.5, src: 'a' }] })).toMatch(/scale/);
		expect(await fail('plan_video_proxies', { assets: ['song'] })).toMatch('only video assets have proxies');
		const removed = await call('update_video_asset', { asset: 'clip', remove: ['proxies'] });
		expect(removed.asset.proxies).toBeUndefined();
	});

	it('set the preview size, even when the project is read-only, and report it', async () => {
		const { controller, call, registry } = setup(true);
		expect(registry.listTools().tools.map((t) => baseToolName(t.name))).toContain('set_video_preview_scale');
		expect(registry.listTools().tools.map((t) => baseToolName(t.name))).not.toContain('set_video_proxies');
		const r = await call('set_video_preview_scale', { scale: 0.25 });
		expect(r).toEqual({ previewScale: 0.25, plays: [{ asset: 'clip', src: 'media/clip.proxy-25.mp4', proxy: true }, { asset: 'raw', src: 'raw.mp4', proxy: false }] });
		expect((await call('set_video_preview_scale', { scale: 'auto' })).note).toMatch(/depends on the preview's size/);
		expect((await call('get_video_project')).previewScale).toBe('auto');
		expect(controller.getState().previewScale).toBe('auto');
	});
});
