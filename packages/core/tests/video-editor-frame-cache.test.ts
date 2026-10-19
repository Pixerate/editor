import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import {
	createVideoEditorToolProvider,
	planVideoPrefetch,
	VideoEditorController,
	VideoFrameCache,
	videoCacheEvictions,
	videoFrameCacheKey,
	videoFrameRequestsAt,
	VideoPreviewEngine,
	videoSourceFrame,
	videoSourceFrameTime,
	type VideoDecodedFrame,
	type VideoPreviewMedia,
	type VideoProject
} from '../src/video-editor';

// 10 fps keeps the numbers small: a frame is 100 ms.
const project = (): VideoProject => ({
	version: 1,
	width: 40,
	height: 20,
	fps: 10,
	assets: [
		{ id: 'a', kind: 'video', src: 'a.mp4', duration: 10_000, proxies: [{ scale: 0.5, src: 'a.half.mp4' }] },
		{ id: 'b', kind: 'video', src: 'b.mp4', duration: 10_000 }
	],
	tracks: [
		{
			id: 'v1',
			kind: 'video',
			clips: [
				{ id: 'a1', type: 'media', asset: 'a', start: 0, duration: 1000, in: 2000 },
				{ id: 'b1', type: 'media', asset: 'b', start: 1000, duration: 1000 },
				// The same source frames as a1, later on the timeline.
				{ id: 'a2', type: 'media', asset: 'a', start: 2000, duration: 500, in: 2000 }
			]
		}
	]
});

/** A decoded frame of `w` × `h` that records whether it was closed. */
const frame = (w = 2, h = 2): VideoDecodedFrame & { closed: boolean } => {
	const f: any = { width: w, height: h, closed: false };
	f.image = { close: () => (f.closed = true) };
	return f;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('frame keys and plans', () => {
	it('key frames by file and source frame', () => {
		expect(videoSourceFrame(2049, 10)).toBe(20);
		expect(videoSourceFrame(2100, 10)).toBe(21);
		expect(videoSourceFrame(-5, 10)).toBe(0);
		expect(videoSourceFrameTime(20, 10)).toBe(2050);
		expect(videoFrameCacheKey('a.mp4', 20)).toBe('20@a.mp4');
		expect(videoFrameRequestsAt(project(), 250)).toEqual([{ key: '22@a.mp4', src: 'a.mp4', frame: 22, sourceTime: 2250, time: 250 }]);
		// Clips of one asset share frames: a2 at 2.1 s needs what a1 needed at 0.1 s.
		expect(videoFrameRequestsAt(project(), 2100)[0].key).toBe(videoFrameRequestsAt(project(), 100)[0].key);
	});

	it('plan the window ahead (or behind), nearest first, each frame once, in the files the preview plays', () => {
		const ahead = planVideoPrefetch(project(), 800, { window: 400 });
		expect(ahead.map((r) => r.key)).toEqual(['28@a.mp4', '29@a.mp4', '0@b.mp4', '1@b.mp4', '2@b.mp4']);
		expect(planVideoPrefetch(project(), 200, { window: 300, direction: -1 }).map((r) => r.key)).toEqual(['22@a.mp4', '21@a.mp4', '20@a.mp4']);
		expect(planVideoPrefetch(project(), 0, { window: 100, srcFor: (l) => (l.asset === 'a' ? 'a.half.mp4' : l.src) }).map((r) => r.key)).toEqual(['20@a.half.mp4', '21@a.half.mp4']);
		// a2 repeats a1's frames: they are planned once.
		const repeat = planVideoPrefetch(project(), 1900, { window: 300 }).map((r) => r.key);
		expect(repeat).toEqual(['9@b.mp4', '20@a.mp4', '21@a.mp4', '22@a.mp4']);
	});
});

describe('eviction', () => {
	const entries = [-500, -200, 0, 100, 300, 900].map((t) => ({ key: `t${t}`, time: t, bytes: 10 }));
	it('drops the furthest first, counting frames behind the playhead as further, and never the window', () => {
		// Behind ×2: -500 → 1000, -200 → 400, 900 → 900, 300 → 300.
		expect(videoCacheEvictions(entries, { playhead: 0, maxBytes: 30 })).toEqual(['t-500', 't900', 't-200']);
		expect(videoCacheEvictions(entries, { playhead: 0, maxBytes: 30, behind: 1 })).toEqual(['t900', 't-500', 't300']);
		// Playing backwards, "behind" is later on the timeline.
		expect(videoCacheEvictions(entries, { playhead: 0, maxBytes: 50, direction: -1 })).toEqual(['t900']);
		expect(videoCacheEvictions(entries, { playhead: 0, maxBytes: 30, protect: new Set(['t-500', 't900']) })).toEqual(['t-200', 't300', 't100']);
		expect(videoCacheEvictions(entries, { playhead: 0, maxBytes: 60 })).toEqual([]);
	});
});

describe('VideoFrameCache', () => {
	it('prefetches the window nearest first, a few at a time, and serves hits', async () => {
		const decode = vi.fn(async (_src: string, _t: number) => frame());
		const cache = new VideoFrameCache({ decode, prefetch: 300, concurrency: 2 });
		cache.update(project(), 0);
		expect(decode.mock.calls.slice(0, 2)).toEqual([
			['a.mp4', 2050],
			['a.mp4', 2150]
		]);
		await flush();
		await flush();
		expect(decode.mock.calls.map((c) => c[1])).toEqual([2050, 2150, 2250, 2350]);
		expect(cache.stats()).toMatchObject({ frames: 4, bytes: 64, hits: 0, misses: 0, pending: 0, prefetch: 300 });
		expect(cache.get('a.mp4', 2120, 10)).toBeDefined();
		expect(cache.get('a.mp4', 2500, 10)).toBeUndefined();
		expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
		// a2 shows the same frames as a1: cached without decoding again.
		expect(cache.cachedRanges(project())).toEqual([
			{ start: 0, end: 400 },
			{ start: 2000, end: 2400 }
		]);
		expect(cache.cachedRanges(project(), { from: 100, to: 300 })).toEqual([{ start: 100, end: 300 }]);
	});

	it('keeps to its budget without evicting the window, and stops prefetching when the window fills it', async () => {
		const made: ReturnType<typeof frame>[] = [];
		const decode = vi.fn(async () => {
			const f = frame(); // 16 bytes
			made.push(f);
			return f;
		});
		const cache = new VideoFrameCache({ decode, prefetch: 100, maxBytes: 48 });
		cache.update(project(), 0); // frames 20, 21
		await flush();
		await flush();
		cache.update(project(), 500); // 25, 26: one of the old frames goes
		await flush();
		await flush();
		expect(cache.stats().frames).toBe(3);
		expect(made.filter((f) => f.closed)).toHaveLength(1);
		// The frame furthest behind went first.
		expect(cache.has('a.mp4', 2050, 10)).toBe(false);
		expect(cache.has('a.mp4', 2150, 10)).toBe(true);
		// A window larger than the budget: decoding stops once only the window is left.
		const tight = new VideoFrameCache({ decode, prefetch: 1000, maxBytes: 32 });
		tight.update(project(), 0);
		for (let i = 0; i < 6; i++) await flush();
		expect(tight.stats().frames).toBe(2);
		expect(tight.stats().pending).toBe(0);
	});

	it('keeps frames the preview hands over, and clears and closes them', async () => {
		const cache = new VideoFrameCache({ decode: null, capture: async () => frame(4, 4) });
		cache.capture('b.mp4', 30, 10, 1030, {} as CanvasImageSource);
		cache.capture('b.mp4', 30, 10, 1030, {} as CanvasImageSource);
		await flush();
		expect(cache.stats().frames).toBe(1);
		expect(cache.has('b.mp4', 0, 10)).toBe(true);
		const heard = vi.fn();
		cache.subscribe(heard);
		cache.clear();
		expect(cache.stats()).toMatchObject({ frames: 0, bytes: 0 });
		expect(heard).toHaveBeenCalled();
		cache.destroy();
		const late = frame();
		cache.put({ key: 'x', time: 0 }, late);
		expect(late.closed).toBe(true);
	});

	it('keeps going when a frame fails to decode', async () => {
		const decode = vi.fn(async (_s: string, t: number) => {
			if (t === 2150) throw new Error('bad frame');
			return frame();
		});
		const cache = new VideoFrameCache({ decode, prefetch: 200, concurrency: 1 });
		cache.update(project(), 0);
		for (let i = 0; i < 6; i++) await flush();
		expect(decode).toHaveBeenCalledTimes(3);
		expect(cache.stats().frames).toBe(2);
	});
});

function fakeMedia() {
	const made: VideoPreviewMedia[] = [];
	const createMedia = () => {
		const m: VideoPreviewMedia = { src: '', currentTime: 0, playbackRate: 1, volume: 1, muted: false, paused: true, seeking: false, readyState: 4, preload: '', play: () => {}, pause: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
		made.push(m);
		return m;
	};
	return { made, createMedia };
}

/** A context that records what drawImage drew. */
function recorder() {
	const drawn: unknown[] = [];
	const ctx: any = new Proxy({ measureText: () => ({ width: 0 }), drawImage: (img: unknown) => drawn.push(img) } as any, { get: (t, k) => (k in t ? t[k] : () => {}), set: () => true });
	return { ctx, drawn };
}

describe('the preview with a frame cache', () => {
	it('draws cached frames while scrubbing and while a seek is under way, and the element while playing', async () => {
		const decode = vi.fn(async () => frame());
		const cache = new VideoFrameCache({ decode, prefetch: 200 });
		const c = new VideoEditorController({ project: project(), clock: new ManualClock(), frameCache: cache });
		const media = fakeMedia();
		const { ctx, drawn } = recorder();
		const engine = new VideoPreviewEngine(c, { width: 0, height: 0 }, { context: ctx, resolution: 1, createMedia: media.createMedia, previewScale: 'full' });
		await flush();
		await flush();
		const element = media.made[0];
		// The frame at 0 is cached, so it is drawn rather than the element.
		c.seek(50);
		expect(drawn.at(-1)).not.toBe(element);
		// A frame outside the cache, with the element mid-seek: it counts as incomplete.
		c.seek(900);
		element.seeking = true;
		c.seek(950);
		expect(drawn.at(-1)).toBe(element);
		element.seeking = false;
		// Playing draws the element even where a frame is cached.
		c.seek(0);
		c.play();
		expect(drawn.at(-1)).toBe(element);
		c.pause();
		engine.destroy();
	});

	it('hands the frames it shows to the cache, under the file the preview plays', async () => {
		const capture = vi.fn(async () => frame());
		const cache = new VideoFrameCache({ decode: null, capture });
		const c = new VideoEditorController({ project: project(), clock: new ManualClock(), frameCache: cache, previewScale: 0.5 });
		const engine = new VideoPreviewEngine(c, { width: 0, height: 0 }, { context: recorder().ctx, resolution: 1, createMedia: fakeMedia().createMedia });
		await flush();
		expect(capture).toHaveBeenCalled();
		expect(cache.has('a.half.mp4', 2000, 10)).toBe(true);
		expect(cache.has('a.mp4', 2000, 10)).toBe(false);
		engine.destroy();
	});
});

describe('get_video_preview_cache', () => {
	const setup = (frameCache?: VideoFrameCache) => {
		const controller = new VideoEditorController({ project: project(), clock: new ManualClock(), ...(frameCache ? { frameCache } : {}) });
		const registry = new ToolRegistry();
		registry.register(createVideoEditorToolProvider(controller));
		const run = (args: Record<string, unknown> = {}) => registry.callTool('get_video_preview_cache', args);
		return { controller, run };
	};

	it('says when there is no cache', async () => {
		const r = await setup().run();
		expect(r.structuredContent).toEqual({ enabled: false, reason: expect.stringMatching(/has not given this editor a frame cache/) });
	});

	it('reports its contents and the cached stretches of the timeline', async () => {
		const cache = new VideoFrameCache({ decode: async () => frame(), prefetch: 300 });
		const { run } = setup(cache);
		cache.update(project(), 0);
		for (let i = 0; i < 4; i++) await flush();
		const r = (await run({ to: 1000 })).structuredContent as any;
		expect(r).toMatchObject({ enabled: true, frames: 4, bytes: 64, maxBytes: 512 * 1024 * 1024, pending: 0, prefetch: 300, cachedRanges: [{ start: 0, end: 400 }] });
		const bad = await run({ from: 500, to: 100 });
		expect(bad.isError).toBe(true);
		expect(bad.content[0]).toMatchObject({ text: expect.stringContaining('"to" (100 ms) must be after "from" (500 ms).') });
	});
});
