import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import {
	buildVideoAudioPeaks,
	createVideoEditorToolProvider,
	findVideoAudioSilences,
	videoAudioLevels,
	videoAudioPeakRange,
	videoAudioPeaksDuration,
	videoAudioPeakSpans,
	VideoAudioPeaksCache,
	videoClipWaveform,
	VideoEditorController,
	videoPeakDb,
	videoWaveformPath,
	type VideoAudioPeaks,
	type VideoMediaClip
} from '../src/video-editor';

const RATE = 8000;

/** Seeded noise so failures reproduce. */
function noise(n: number, seed = 1): Float32Array {
	let x = seed;
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		x = (x * 1103515245 + 12345) % 2147483648;
		out[i] = (x / 2147483648) * 2 - 1;
	}
	return out;
}

/** `ms` of sound at `amp`, then silence, as described by [ms, amp] pairs. */
function tone(parts: [number, number][]): Float32Array {
	const total = parts.reduce((n, [ms]) => n + (ms * RATE) / 1000, 0);
	const out = new Float32Array(total);
	let i = 0;
	for (const [ms, amp] of parts) for (let k = 0; k < (ms * RATE) / 1000; k++, i++) out[i] = amp * Math.sin((2 * Math.PI * 440 * i) / RATE);
	return out;
}

describe('audio peaks', () => {
	it('answer any stretch exactly as a brute-force scan of whole blocks would', () => {
		const left = noise(100_003, 7);
		const right = noise(100_003, 9).map((v) => v * 0.5);
		const peaks = buildVideoAudioPeaks([left, right], RATE);
		expect(peaks.levels.at(-1)!.length).toBe(2);
		expect(videoAudioPeaksDuration(peaks)).toBeCloseTo(12500.375, 3);
		let seed = 3;
		const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		for (let k = 0; k < 200; k++) {
			const a = rand() * 12000;
			const b = a + rand() * 3000 + 1;
			const s = Math.floor((a * RATE) / 1000 / 32) * 32;
			const e = Math.min(left.length, Math.ceil((b * RATE) / 1000 / 32) * 32);
			let lo = Infinity;
			let hi = -Infinity;
			for (let i = s; i < e; i++) {
				lo = Math.min(lo, left[i], right[i]);
				hi = Math.max(hi, left[i], right[i]);
			}
			const got = videoAudioPeakRange(peaks, a, b);
			expect(got.min).toBeCloseTo(lo, 6);
			expect(got.max).toBeCloseTo(hi, 6);
		}
	});

	it('read nothing outside the audio and survive bad samples', () => {
		const samples = tone([[100, 0.5]]);
		samples[10] = NaN;
		const peaks = buildVideoAudioPeaks([samples], RATE);
		expect(videoAudioPeakRange(peaks, 500, 600)).toEqual({ min: 0, max: 0 });
		expect(videoAudioPeakRange(peaks, 0, 100).max).toBeCloseTo(0.5, 2);
		// Narrower than a block still reads the block it falls in.
		expect(videoAudioPeakRange(peaks, 50, 50.01).max).toBeGreaterThan(0);
		expect(buildVideoAudioPeaks([], RATE).levels[0]).toEqual(new Float32Array([0, 0]));
		expect(() => buildVideoAudioPeaks([samples], 0)).toThrow('sample rate');
	});

	it('give spans per column, levels in dBFS and silences', () => {
		const peaks = buildVideoAudioPeaks([tone([[1000, 0.5], [800, 0.001], [1000, 1]])], RATE);
		const spans = videoAudioPeakSpans(peaks, 0, 2800, 28);
		expect(spans.length).toBe(56);
		expect(spans[1]).toBeCloseTo(0.5, 2);
		expect(spans[2 * 12 + 1]).toBeLessThan(0.01);
		expect(videoPeakDb(1)).toBe(0);
		expect(videoPeakDb(0.5)).toBe(-6);
		expect(videoPeakDb(0)).toBe(-100);
		const levels = videoAudioLevels(peaks, 0, 2800, 4);
		expect(levels.map((l) => l.start)).toEqual([0, 700, 1400, 2100]);
		expect(levels[0].peakDb).toBe(-6);
		const silences = findVideoAudioSilences(peaks, 0, 2800);
		expect(silences).toHaveLength(1);
		expect(silences[0].start).toBeCloseTo(1000, -1);
		expect(silences[0].end).toBeCloseTo(1800, -1);
		expect(findVideoAudioSilences(peaks, 0, 2800, { minDuration: 900 })).toEqual([]);
		expect(findVideoAudioSilences(peaks, 0, 2800, { thresholdDb: -3 })[0]).toMatchObject({ start: 0 });
	});

	it('draw a clip as it plays: through its in point and speed, scaled by volume and fades', () => {
		const peaks = buildVideoAudioPeaks([tone([[1000, 0], [1000, 1]])], RATE);
		const clip: VideoMediaClip = { type: 'media', id: 'c', asset: 'a', start: 5000, duration: 500, in: 1000, speed: 2, volume: 0.5, fadeOut: 250, fadeOutCurve: 'exponential' };
		const w = videoClipWaveform(clip, peaks, 10);
		expect(w[1]).toBeCloseTo(0.5, 2);
		// The last column is 25 ms from the end of a 250 ms exponential fade: 0.5 × 0.1³.
		expect(w[19]).toBeCloseTo(0.5 * 0.001, 3);
		const silentPart = videoClipWaveform({ ...clip, in: 0, speed: 1, fadeOut: undefined }, peaks, 5);
		expect(Math.max(...silentPart)).toBe(0);
		const d = videoWaveformPath(w, 100, 40);
		expect(d.startsWith('M5.0 ')).toBe(true);
		expect(d.endsWith('Z')).toBe(true);
		expect(d.match(/L/g)).toHaveLength(19);
		expect(videoWaveformPath(new Float32Array(), 100, 40)).toBe('');
		// Clipping is drawn at the edge, not past it.
		expect(videoWaveformPath(new Float32Array([-2, 2]), 10, 40)).toBe('M5.0 0.0L5.0 40.0Z');
	});
});

describe('VideoAudioPeaksCache', () => {
	const asset = { id: 'a', kind: 'audio' as const, src: 'a.wav', duration: 1000 };
	const peaks = buildVideoAudioPeaks([tone([[1000, 0.5]])], RATE);

	it('loads each source once, tells subscribers, and hands back what is ready', async () => {
		const loader = vi.fn(async () => peaks);
		const cache = new VideoAudioPeaksCache(loader);
		const heard = vi.fn();
		cache.subscribe(heard);
		expect(cache.get(asset)).toBeUndefined();
		expect(cache.get(asset)).toBeUndefined();
		expect(await cache.load(asset)).toBe(peaks);
		expect(loader).toHaveBeenCalledTimes(1);
		expect(cache.get(asset)).toBe(peaks);
		expect(heard).toHaveBeenCalledTimes(1);
		const other: VideoAudioPeaks = { ...peaks };
		cache.set('b.wav', other);
		expect(cache.get({ ...asset, id: 'b', src: 'b.wav' })).toBe(other);
	});

	it('remembers a failure with a readable reason instead of retrying', async () => {
		const loader = vi.fn(async () => {
			throw new Error('404');
		});
		const cache = new VideoAudioPeaksCache(loader);
		await expect(cache.load(asset)).rejects.toThrow('The sound of "a" could not be read: 404');
		expect(cache.error(asset)).toMatch(/404/);
		expect(cache.get(asset)).toBeUndefined();
		await expect(cache.load(asset)).rejects.toThrow('404');
		expect(loader).toHaveBeenCalledTimes(1);
	});
});

describe('sound tools', () => {
	const setup = () => {
		const controller = new VideoEditorController({
			clock: new ManualClock(),
			// 1 s of speech, 0.8 s of pause, 1.2 s of speech.
			audioPeaks: async () => buildVideoAudioPeaks([tone([[1000, 0.5], [800, 0], [1200, 0.5]])], RATE)
		});
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
		return { controller, call, fail };
	};

	it('find a pause in a clip in timeline time and cut it out', async () => {
		const { call } = setup();
		await call('add_video_asset', { id: 'vo', kind: 'audio', src: 'vo.wav', duration: 3000 });
		await call('add_video_asset', { id: 'still', kind: 'image', src: 'still.png' });
		await call('add_video_clip', { track: 'a1', clip: { type: 'media', id: 'v', asset: 'vo', start: 2000, in: 500, duration: 2500 } });
		const found = await call('find_video_silences', { clip: 'v' });
		expect(found.silences).toHaveLength(1);
		const [pause] = found.silences;
		expect(pause.start).toBeCloseTo(2500, -1);
		expect(pause.end).toBeCloseTo(3300, -1);
		await call('extract_video_range', { from: pause.start, to: pause.end });
		const after = await call('get_video_project');
		expect(after.duration).toBeCloseTo(4500 - (pause.end - pause.start), 0);

		const levels = await call('get_video_audio_levels', { asset: 'vo', buckets: 3 });
		expect(levels.levels).toHaveLength(3);
		expect(levels.levels[0]).toMatchObject({ start: 0, end: 1000, peakDb: -6 });
		expect(levels.levels[1].peakDb).toBe(-6); // 1000–2000 ms still has speech at its end
		expect(levels.peakDb).toBe(-6);
	});

	it('say what is wrong with the request', async () => {
		const { call, fail } = setup();
		await call('add_video_asset', { id: 'vo', kind: 'audio', src: 'vo.wav', duration: 3000 });
		await call('add_video_asset', { id: 'still', kind: 'image', src: 'still.png' });
		await call('add_video_clip', { track: 'v1', clip: { type: 'text', id: 't', text: 'Hi' } });
		expect(await fail('get_video_audio_levels', {})).toContain('Pass either "clip"');
		expect(await fail('get_video_audio_levels', { clip: 't', asset: 'vo' })).toContain('not both');
		expect(await fail('get_video_audio_levels', { clip: 'nope' })).toContain('There is no clip "nope"');
		expect(await fail('get_video_audio_levels', { clip: 't' })).toContain('has no sound');
		expect(await fail('find_video_silences', { asset: 'still' })).toContain('has no sound');
		expect(await fail('find_video_silences', { asset: 'vo', from: 2000, to: 1000 })).toContain('"to" must be after "from"');
		expect(await fail('get_video_audio_levels', { asset: 'vo', buckets: 0 })).toContain('buckets');
		expect(await fail('find_video_silences', { asset: 'vo', thresholdDb: 3 })).toContain('thresholdDb');
	});

	it('report a file that cannot be decoded', async () => {
		const controller = new VideoEditorController({ clock: new ManualClock(), audioPeaks: async () => { throw new Error('unsupported format'); } });
		const registry = new ToolRegistry();
		registry.register(createVideoEditorToolProvider(controller));
		controller.apply({ op: 'add_asset', asset: { id: 'vo', kind: 'audio', src: 'vo.xyz', duration: 1000 } });
		const r = await registry.callTool('get_video_audio_levels', { asset: 'vo' });
		expect(r.isError).toBe(true);
		expect(JSON.stringify(r.content)).toContain('The sound of \\"vo\\" could not be read: unsupported format');
	});
});
