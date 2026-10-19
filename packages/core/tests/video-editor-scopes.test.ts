import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import {
	createVideoEditorToolProvider,
	summarizeVideoScopes,
	VIDEO_VECTORSCOPE_TARGETS,
	VideoEditorController,
	videoChroma,
	videoExposureNotes,
	videoExposureStats,
	videoHistogram,
	videoLuma,
	videoLumaWaveform,
	VideoPreviewEngine,
	VideoPreviewPixels,
	videoScopeImage,
	videoVectorscope,
	videoVectorscopeAngle,
	videoVectorscopePoint,
	type VideoPixels,
	type VideoPreviewMedia,
	type VideoProject
} from '../src/video-editor';

/** A picture `width` × `height` coloured by `rgb(x, y)`. */
function picture(width: number, height: number, rgb: (x: number, y: number) => [number, number, number]): VideoPixels {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			data.set([...rgb(x, y), 255], i);
		}
	return { width, height, data };
}
const solid = (rgb: [number, number, number], w = 8, h = 8) => picture(w, h, () => rgb);

describe('scopes', () => {
	it('use Rec. 709 luma and chroma', () => {
		expect(videoLuma(1, 1, 1)).toBeCloseTo(1, 6);
		expect(videoLuma(0, 1, 0)).toBeCloseTo(0.7152, 6);
		expect(videoChroma(0.5, 0.5, 0.5)).toEqual([0, 0]);
		const [cb, cr] = videoChroma(1, 0, 0);
		expect(cr).toBeCloseTo(0.5, 6);
		expect(cb).toBeCloseTo(-0.1146, 4);
		// Red sits at about 103° on a vectorscope, blue near 350°.
		expect(videoVectorscopeAngle(cb, cr)).toBeCloseTo(102.9, 1);
		expect(videoVectorscopeAngle(...videoChroma(0, 0, 1))).toBeCloseTo(354.8, 1);
		expect(VIDEO_VECTORSCOPE_TARGETS.map((t) => t.name)).toEqual(['R', 'Mg', 'B', 'Cy', 'G', 'Yl']);
	});

	it('count a histogram per channel and luma', () => {
		const px = picture(2, 2, (x, y) => [[0, 0, 0], [255, 255, 255], [255, 0, 0], [128, 128, 128]][y * 2 + x] as [number, number, number]);
		const h = videoHistogram(px, { bins: 4 });
		expect(h.total).toBe(4);
		expect(h.r).toEqual([1, 0, 1, 2]);
		expect(h.g).toEqual([2, 0, 1, 1]);
		// Luma: black, red (54), grey (128), white.
		expect(h.luma).toEqual([2, 0, 1, 1]);
	});

	it('draw a luma waveform column by column', () => {
		const px = picture(8, 4, (x) => (x < 4 ? [0, 0, 0] : [255, 255, 255]));
		const w = videoLumaWaveform(px, { columns: 2, levels: 4 });
		expect([...w.data]).toEqual([16, 0, 0, 0, 0, 0, 0, 16]);
		expect(w.peak).toBe(16);
	});

	it('place colours on a vectorscope by hue and saturation', () => {
		const grey = videoVectorscope(solid([90, 90, 90]), { size: 65 });
		expect(grey.data[32 * 65 + 32]).toBe(64);
		const red = videoVectorscope(solid([255, 0, 0]), { size: 65 });
		const [x, y] = videoVectorscopePoint(...videoChroma(1, 0, 0), 65);
		expect(red.data[Math.round(y) * 65 + Math.round(x)]).toBe(64);
		expect(y).toBeLessThan(2); // Cr +0.5 is the top edge.
	});

	it('measure exposure, clipping and colour', () => {
		const px = picture(10, 10, (x) => (x < 3 ? [0, 0, 0] : x < 4 ? [255, 255, 255] : [100, 100, 100]));
		const s = videoExposureStats(px);
		expect(s.pixels).toBe(100);
		expect(s.clipped).toEqual({ shadows: 0.3, highlights: 0.1, r: 0.1, g: 0.1, b: 0.1 });
		expect(s.luma.min).toBe(0);
		expect(s.luma.max).toBe(1);
		expect(s.luma.median).toBeCloseTo(100 / 255, 2);
		expect(s.saturation.max).toBe(0);
		expect(videoExposureNotes(s)).toEqual(['30% of the picture is crushed to black; raise exposure or lower contrast.', '10% of the picture is blown to white; lower exposure.']);
		// A flat, dim, orange-tinted picture.
		const warm = videoExposureStats(solid([60, 40, 20]));
		expect(warm.average).toBe('#3c2814');
		const notes = videoExposureNotes(warm).join(' ');
		expect(notes).toMatch(/dark/);
		expect(notes).toMatch(/flat/);
		expect(notes).toMatch(/warm \(orange\) cast/);
		expect(videoExposureNotes(videoExposureStats(solid([20, 40, 90])))).toEqual(expect.arrayContaining([expect.stringMatching(/cool \(blue\) cast/)]));
		// One channel clipping without the luma being blown.
		expect(videoExposureNotes(videoExposureStats(solid([255, 60, 40]))).join(' ')).toMatch(/red channel clips in 100%/);
	});

	it('read a large frame by sampling it evenly', () => {
		const big = picture(1000, 1000, (x) => (x < 500 ? [0, 0, 0] : [255, 255, 255]));
		const s = videoExposureStats(big, { maxPixels: 10_000 });
		expect(s.pixels).toBe(10_000);
		expect(s.clipped.shadows).toBe(0.5);
	});

	it('refuse a buffer of the wrong size', () => {
		expect(() => videoHistogram({ width: 4, height: 4, data: new Uint8ClampedArray(10) })).toThrow('The pixels are not 4 × 4 RGBA: there are 10 values, and 64 are needed.');
	});

	it('summarise a frame for agents', () => {
		const px = picture(16, 8, (x) => (x < 8 ? [255, 0, 0] : [40, 40, 40]));
		const s = summarizeVideoScopes(px, { bins: 4, columns: 2 });
		expect(s.histogram.bins).toBe(4);
		expect(s.histogram.r).toEqual([0.5, 0, 0, 0.5]);
		expect(s.waveform).toEqual([
			{ start: 0, end: 0.5, min: 0.212, median: 0.212, max: 0.212 },
			{ start: 0.5, end: 1, min: 0.157, median: 0.157, max: 0.157 }
		]);
		expect(s.vectorscope.hue).toBe(103);
		expect(s.vectorscope.strength).toBe(1);
		expect(summarizeVideoScopes(solid([128, 128, 128])).vectorscope).toEqual({ hue: null, strength: 0, spread: 1 });
	});

	it('draw scope images of the asked size', () => {
		const px = picture(32, 16, (x, y) => [x * 8, y * 16, 128]);
		for (const kind of ['histogram', 'waveform'] as const) {
			const img = videoScopeImage(kind, px, 64, 32);
			expect([img.width, img.height, img.data.length]).toEqual([64, 32, 64 * 32 * 4]);
		}
		const v = videoScopeImage('vectorscope', px, 64, 48);
		expect([v.width, v.height]).toEqual([48, 48]);
		// Something brighter than the backdrop was drawn.
		expect(Math.max(...v.data.filter((_, i) => i % 4 === 1))).toBeGreaterThan(100);
	});
});

describe('VideoPreviewPixels', () => {
	afterEach(() => vi.useRealTimers());
	const snap = (time: number) => ({ time, complete: true, pixels: solid([1, 2, 3], 1, 1) });

	it('reads the attached preview and waits for a complete frame', async () => {
		const feed = new VideoPreviewPixels();
		expect(feed.read()).toBeNull();
		let drawn = snap(0);
		const detach = feed.attach(() => drawn);
		expect(feed.attached).toBe(true);
		const waiting = feed.next(500);
		feed.drawn(500, false);
		drawn = snap(500);
		feed.drawn(500, true);
		await expect(waiting).resolves.toEqual(snap(500));
		// Already drawn: resolves at once.
		await expect(feed.next(500)).resolves.toEqual(snap(500));
		detach();
		expect(feed.attached).toBe(false);
	});

	it('times out, fails when the preview closes, and explains an unreadable canvas', async () => {
		vi.useFakeTimers();
		const feed = new VideoPreviewPixels();
		const detach = feed.attach(() => snap(0));
		const late = feed.next(100, 1000);
		vi.advanceTimersByTime(1000);
		await expect(late).rejects.toThrow('The preview did not finish drawing 100 ms within 1000 ms');
		const closed = feed.next(200);
		detach();
		await expect(closed).rejects.toThrow('The preview was closed before it drew the frame.');
		feed.attach(() => {
			throw new Error('The operation is insecure.');
		});
		expect(() => feed.read()).toThrow(/cannot be read \(The operation is insecure\.\)\. Media from another origin must be served with CORS/);
	});
});

const project = (): VideoProject => ({
	version: 1,
	width: 64,
	height: 36,
	fps: 25,
	assets: [{ id: 'm', kind: 'video', src: 'm.mp4', duration: 10_000 }],
	tracks: [
		{
			id: 'v1',
			kind: 'video',
			clips: [
				{ id: 'red', type: 'color', color: '#ff0000', start: 0, duration: 2000 },
				{ id: 'clip', type: 'media', asset: 'm', start: 2000, duration: 2000 }
			]
		}
	]
});

/** A 2D context that paints every frame one colour per time, read back with getImageData. */
function fakeContext(colourAt: () => [number, number, number]) {
	const base: any = { measureText: () => ({ width: 0 }), getImageData: (_x: number, _y: number, w: number, h: number) => solid(colourAt(), w, h) };
	return new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => {}), set: () => true });
}

function fakeMedia() {
	const made: VideoPreviewMedia[] = [];
	const listeners = new Map<string, () => void>();
	const createMedia = () => {
		const m: VideoPreviewMedia = {
			src: '',
			currentTime: 0,
			playbackRate: 1,
			volume: 1,
			muted: false,
			paused: true,
			seeking: false,
			readyState: 4,
			preload: '',
			play: () => {},
			pause: () => {},
			addEventListener: (type, l) => listeners.set(type, l),
			removeEventListener: () => {}
		};
		made.push(m);
		return m;
	};
	return { made, listeners, createMedia };
}

describe('the preview publishes its pixels', () => {
	it('to the controller, marking frames whose media is still seeking as incomplete', () => {
		const c = new VideoEditorController({ project: project(), clock: new ManualClock() });
		const media = fakeMedia();
		const engine = new VideoPreviewEngine(c, { width: 0, height: 0 }, { context: fakeContext(() => [255, 0, 0]), createMedia: media.createMedia, resolution: 1 });
		const seen: boolean[] = [];
		c.previewPixels.subscribe(() => c.previewPixels.attached && seen.push(c.previewPixels.read()!.complete));
		expect(c.previewPixels.read()).toMatchObject({ time: 0, complete: true, pixels: { width: 64, height: 36 } });
		c.seek(3000);
		media.made[0].seeking = true;
		c.seek(3040);
		expect(seen.at(-1)).toBe(false);
		media.made[0].seeking = false;
		media.listeners.get('seeked')!();
		return Promise.resolve().then(() => {
			expect(seen.at(-1)).toBe(true);
			engine.destroy();
			expect(c.previewPixels.attached).toBe(false);
		});
	});

	it('only when asked to', () => {
		const c = new VideoEditorController({ project: project(), clock: new ManualClock() });
		const engine = new VideoPreviewEngine(c, { width: 0, height: 0 }, { context: fakeContext(() => [0, 0, 0]), createMedia: fakeMedia().createMedia, pixels: null });
		expect(c.previewPixels.attached).toBe(false);
		engine.destroy();
	});
});

describe('get_video_scopes', () => {
	const setup = (options: Parameters<typeof createVideoEditorToolProvider>[1] = {}) => {
		const controller = new VideoEditorController({ project: project(), clock: new ManualClock() });
		const registry = new ToolRegistry();
		registry.register(createVideoEditorToolProvider(controller, options));
		const call = async (args: Record<string, unknown> = {}) => {
			const r = await registry.callTool('get_video_scopes', args);
			if (r.isError) throw new Error(JSON.stringify(r.content));
			return r.structuredContent as any;
		};
		const fail = async (args: Record<string, unknown> = {}) => {
			const r = await registry.callTool('get_video_scopes', args);
			expect(r.isError).toBe(true);
			return r.content.map((c) => ('text' in c ? c.text : '')).join('\n');
		};
		return { controller, call, fail };
	};

	it('explains that it needs a preview, and checks its arguments', async () => {
		const { fail } = setup();
		expect(await fail()).toMatch(/No preview is showing this project, so there are no pixels to measure/);
		expect(await fail({ bins: 1 })).toMatch(/bins/);
		expect(await fail({ time: 99_000 })).toMatch('Time 99000 ms is past the end of the project (4000 ms).');
		expect(await fail({ colour: true })).toMatch(/colour/);
	});

	it('measures the preview at the playhead, or at another time and puts the playhead back', async () => {
		const { controller, call } = setup();
		const media = fakeMedia();
		// The canvas is red over the colour clip and dark grey over the video.
		const engine = new VideoPreviewEngine(controller, { width: 0, height: 0 }, { context: fakeContext(() => (controller.getState().time < 2000 ? [255, 0, 0] : [30, 30, 30])), createMedia: media.createMedia, resolution: 1 });
		const here = await call({ bins: 4, columns: 2 });
		expect(here).toMatchObject({ time: 0, timecode: '00:00:00:00', width: 64, height: 36, histogram: { bins: 4 }, vectorscope: { hue: 103, strength: 1 } });
		expect(here.stats.clipped.r).toBe(1);
		expect(here.notes.join(' ')).toMatch(/red channel clips/);
		const there = await call({ time: 3000 });
		expect(there.stats.average).toBe('#1e1e1e');
		expect(there.notes.join(' ')).toMatch(/crushed|dark/);
		expect(controller.getState().time).toBe(0);
		engine.destroy();
	});

	it('uses the host\'s pixels when given', async () => {
		const framePixels = vi.fn(async (t: number) => (t === 1000 ? solid([255, 255, 255]) : null));
		const { call, fail } = setup({ framePixels });
		expect((await call({ time: 1000 })).stats.clipped.highlights).toBe(1);
		expect(await fail({ time: 500 })).toMatch('The host could not render the frame at 500 ms');
	});

	it('fails usefully when the frame never finishes loading', async () => {
		const { controller, fail } = setup({ framePixelsTimeout: 20 });
		const media = fakeMedia();
		const engine = new VideoPreviewEngine(controller, { width: 0, height: 0 }, { context: fakeContext(() => [0, 0, 0]), createMedia: () => ({ ...media.createMedia(), readyState: 0 }), resolution: 1 });
		expect(await fail({ time: 3000 })).toMatch(/did not finish drawing 3000 ms within 20 ms; its media may still be loading/);
		expect(controller.getState().time).toBe(0);
		engine.destroy();
	});
});
