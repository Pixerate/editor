import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import {
	applyVideoEdits,
	buildVideoAudioPeaks,
	createVideoDialogueToolProvider,
	createVideoEditorToolProvider,
	createVideoMusicToolProvider,
	createVideoProject,
	findVideoAudioBeats,
	measureVideoLoudness,
	nearestVideoBeat,
	VideoEditorController,
	videoAudioLoudness,
	videoDuckingKeys,
	videoLoudnessGain,
	videoSpeechRanges,
	videoValueAt,
	type VideoAsset,
	type VideoEdit,
	type VideoProject
} from '../src/video-editor';

const RATE = 48000;

/** A sine of `amplitude` at `hz` for `ms`. */
const sine = (ms: number, amplitude: number, hz = 997, rate = RATE) => {
	const out = new Float32Array(Math.round((ms * rate) / 1000));
	for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
	return out;
};
/** Clicks (short decaying bursts) every `period` ms for `ms`. */
const clicks = (ms: number, period: number, rate = 8000) => {
	const out = new Float32Array(Math.round((ms * rate) / 1000));
	for (let t = 0; t < ms; t += period) {
		const at = Math.round((t * rate) / 1000);
		for (let k = 0; k < rate / 50 && at + k < out.length; k++) out[at + k] = 0.9 * Math.exp(-k / (rate / 400)) * (k % 2 ? 1 : -1);
	}
	return out;
};

describe('loudness (BS.1770)', () => {
	it('measures a full-scale 997 Hz sine at -3 LUFS and scales with level', () => {
		expect(measureVideoLoudness([sine(3000, 1)], RATE)).toBeCloseTo(-3, 0);
		expect(measureVideoLoudness([sine(3000, 0.1)], RATE)).toBeCloseTo(-23, 0);
		// Two identical channels add 3 dB.
		expect(measureVideoLoudness([sine(3000, 0.1), sine(3000, 0.1)], RATE)).toBeCloseTo(-20, 0);
	});

	it('gates out silence: quiet stretches do not pull the level down, and silence is null', () => {
		const loudThenSilent = new Float32Array(RATE * 4);
		loudThenSilent.set(sine(2000, 0.1));
		expect(measureVideoLoudness([loudThenSilent], RATE)).toBeCloseTo(-23, 0);
		expect(measureVideoLoudness([new Float32Array(RATE)], RATE)).toBeNull();
	});

	it('reads any stretch of an asset from its peaks', () => {
		const samples = new Float32Array(RATE * 4);
		samples.set(sine(2000, 0.05));
		samples.set(sine(2000, 0.5), RATE * 2);
		const peaks = buildVideoAudioPeaks([samples], RATE);
		expect(videoAudioLoudness(peaks, 0, 2000)).toBeCloseTo(-29, 0);
		expect(videoAudioLoudness(peaks, 2000, 4000)).toBeCloseTo(-9, 0);
		expect(() => videoAudioLoudness({ ...peaks, loudness: undefined })).toThrow(/no loudness data/);
	});

	it('works out the gain to a target, capped by the peak ceiling and the most gain', () => {
		expect(videoLoudnessGain(-20, -14)).toEqual({ gain: 1.995, gainDb: 6 });
		expect(videoLoudnessGain(-20, -14, { peakDb: -3 })).toEqual({ gain: 1.259, gainDb: 2, limitedBy: 'peak' });
		expect(videoLoudnessGain(-40, -14)).toMatchObject({ gain: 4, limitedBy: 'max-gain' });
		expect(videoLoudnessGain(-10, -14).gainDb).toBe(-4);
	});
});

describe('ducking', () => {
	it('merges speech across short gaps', () => {
		expect(videoSpeechRanges([{ start: 0, end: 300 }, { start: 400, end: 800 }, { start: 2000, end: 2500 }], 500)).toEqual([
			{ from: 0, to: 800 },
			{ from: 2000, to: 2500 }
		]);
	});

	it('eases music down before speech, holds, and back after, in clip time', () => {
		const keys = videoDuckingKeys({ start: 1000, duration: 10000 }, [{ from: 3000, to: 5000 }], { duckDb: -20, attack: 200, release: 500 });
		expect(keys).toEqual([
			{ t: 1800, v: 1, ease: 'ease-in-out' },
			{ t: 2000, v: 0.1 },
			{ t: 4000, v: 0.1, ease: 'ease-in-out' },
			{ t: 4500, v: 1 }
		]);
		const clip = { start: 1000, duration: 10000 };
		expect(videoValueAt({ keys }, 3000, 1)).toBeCloseTo(0.1);
		expect(videoValueAt({ keys }, 6000, 1)).toBe(1);
		expect(clip.duration).toBe(10000);
	});

	it('keeps close stretches ducked, clamps to the clip, scales the base level and finds nothing outside', () => {
		const keys = videoDuckingKeys({ start: 0, duration: 4000 }, [{ from: 0, to: 1000 }, { from: 1300, to: 2000 }, { from: 3900, to: 6000 }], { base: 0.5, duckDb: -6 });
		const low = Math.round(0.5 * 10 ** (-6 / 20) * 10000) / 10000;
		expect(keys).toEqual([
			{ t: 0, v: low },
			{ t: 2000, v: low, ease: 'ease-in-out' },
			{ t: 2400, v: 0.5 },
			{ t: 3700, v: 0.5, ease: 'ease-in-out' },
			{ t: 3900, v: low }
		]);
		expect(videoDuckingKeys({ start: 0, duration: 1000 }, [{ from: 5000, to: 6000 }])).toEqual([]);
	});
});

describe('beats', () => {
	it('finds the onsets and tempo of a click track and a grid through them', () => {
		const peaks = buildVideoAudioPeaks([clicks(8000, 500)], 8000);
		const found = findVideoAudioBeats(peaks, 0, 8000);
		expect(found.bpm).toBeCloseTo(120, 0);
		expect(found.onsets.length).toBeGreaterThanOrEqual(14);
		for (const o of found.onsets) expect(Math.abs(((o + 250) % 500) - 250)).toBeLessThanOrEqual(20);
		expect(found.beats.length).toBeGreaterThanOrEqual(15);
		expect(Math.abs(((found.beats[3] + 250) % 500) - 250)).toBeLessThanOrEqual(20);
	});

	it('reports no tempo for steady sound, and picks the nearest beat in reach', () => {
		const peaks = buildVideoAudioPeaks([sine(3000, 0.5, 440, 8000)], 8000);
		expect(findVideoAudioBeats(peaks, 0, 3000).bpm).toBeNull();
		expect(nearestVideoBeat([0, 500, 1000], 620, 150)).toBe(500);
		expect(nearestVideoBeat([0, 500, 1000], 760, 150)).toBeNull();
	});
});

const ok = (p: VideoProject, edits: VideoEdit | VideoEdit[]) => {
	const r = applyVideoEdits(p, edits);
	if (!r.ok) throw new Error(r.error);
	return r.project;
};

/** Dialogue (with a transcript) on v1, a music bed on a2, picture cuts on v2 at 1020 and 2030 ms. */
const scene = () =>
	ok(createVideoProject({ width: 320, height: 180, fps: 25 }), [
		{ op: 'add_asset', asset: { id: 'talk', kind: 'video', src: 'talk.mp4', duration: 6000, transcript: [{ word: 'Hello', start: 1000, end: 1500 }, { word: 'there', start: 1600, end: 2000 }, { word: 'friends', start: 4000, end: 4600 }] } },
		{ op: 'add_asset', asset: { id: 'song', kind: 'audio', src: 'song.wav', duration: 8000 } },
		{ op: 'add_asset', asset: { id: 'broll', kind: 'video', src: 'broll.mp4', duration: 10000, hasAudio: false } },
		{ op: 'add_track', track: { id: 'a2', kind: 'audio', syncLocked: false } },
		{ op: 'add_track', track: { id: 'v2', kind: 'video' }, at: 0 },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'd', asset: 'talk', start: 0, duration: 6000 } },
		{ op: 'add_clip', track: 'a2', clip: { type: 'media', id: 'm', asset: 'song', start: 0, duration: 6000 } },
		{ op: 'add_clip', track: 'v2', clip: { type: 'media', id: 'b1', asset: 'broll', in: 2000, start: 0, duration: 1020 } },
		{ op: 'add_clip', track: 'v2', clip: { type: 'media', id: 'b2', asset: 'broll', in: 4000, start: 1020, duration: 1010 } },
		{ op: 'add_clip', track: 'v2', clip: { type: 'media', id: 'b3', asset: 'broll', in: 6000, start: 2030, duration: 1000 } }
	]);

describe('music tools', () => {
	const setup = () => {
		const samples = (asset: VideoAsset) => {
			if (asset.id === 'song') return [clicks(8000, 500, 8000)];
			const s = new Float32Array(8000 * 6);
			s.set(sine(1000, 0.05, 440, 8000), 8000);
			s.set(sine(600, 0.05, 440, 8000), 8000 * 4);
			return [s];
		};
		const controller = new VideoEditorController({ clock: new ManualClock(), project: scene(), audioPeaks: async (a) => buildVideoAudioPeaks(samples(a), 8000) });
		const registry = new ToolRegistry();
		registry.register(createVideoEditorToolProvider(controller, { namespace: '' }));
		registry.register(createVideoMusicToolProvider(controller, { namespace: '' }));
		registry.register(createVideoDialogueToolProvider(controller, { namespace: '' }));
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

	it('duck_video_music dips the music under the transcript\'s speech as one undo step', async () => {
		const { controller, call, fail } = setup();
		const r = await call('duck_video_music', { music: ['m'], duck_db: -12 });
		expect(r.speech).toBe('transcript');
		expect(r.speechRanges).toEqual([{ from: 1000, to: 2000 }, { from: 4000, to: 4600 }]);
		expect(r.music[0].keys).toBe(8);
		expect(controller.getState().undoLabel).toBe('Duck music');
		const clip = controller.getProject().tracks.find((t) => t.id === 'a2')!.clips[0] as any;
		expect(videoValueAt(clip.volume, 1500, 1)).toBeCloseTo(10 ** (-12 / 20), 3);
		expect(videoValueAt(clip.volume, 3000, 1)).toBe(1);
		expect(await fail('duck_video_music', { music: ['m'] })).toMatch(/already has volume keyframes/);
		expect((await call('duck_video_music', { music: ['m'], replace: true })).music[0].keys).toBe(8);
		expect(await fail('duck_video_music', { music: ['b1'] })).toMatch(/has no sound/);
		expect(await fail('duck_video_music', { music: ['m'], speech: 'audio', replace: true })).toMatch(/needs dialogue_track/);
		expect(await fail('duck_video_music', { music: ['m'], duck_db: 3 })).toMatch(/duck_db/);
	});

	it('duck_video_music can find speech in the dialogue\'s sound instead', async () => {
		const { call } = setup();
		const r = await call('duck_video_music', { music: ['m'], speech: 'audio', dialogue_track: 'v1' });
		expect(r.speechRanges.length).toBe(2);
		expect(r.speechRanges[0].from).toBeGreaterThanOrEqual(900);
		expect(r.speechRanges[0].to).toBeLessThanOrEqual(2100);
	});

	it('measure_video_loudness and normalize_video_loudness level clips to a target', async () => {
		const { controller, call, fail } = setup();
		const m = await call('measure_video_loudness', { clip: 'd' });
		expect(m.lufs).toBeLessThan(-20);
		expect(m.toStreaming.gain).toBeGreaterThan(1);
		const n = await call('normalize_video_loudness', { clips: ['d'], target: -16 });
		expect(n.clips[0]).toMatchObject({ clip: 'd' });
		const volume = (controller.getProject().tracks.find((t) => t.id === 'v1')!.clips[0] as any).volume;
		expect(volume).toBe(n.clips[0].gain);
		expect(await fail('measure_video_loudness', {})).toMatch(/either "clip"/);
		expect(await fail('normalize_video_loudness', { clips: ['b1'] })).toMatch(/has no sound/);
	});

	it('find_video_beats and plan_video_beat_snap propose rolling cuts onto the beat', async () => {
		const { controller, call, fail } = setup();
		const beats = await call('find_video_beats', { clip: 'm' });
		expect(beats.bpm).toBeCloseTo(120, 0);
		const before = controller.getProject();
		const r = await call('plan_video_beat_snap', { track: 'v2', music: 'm', tolerance: 100 });
		expect(r.moved).toBe(2);
		expect(controller.getProject()).toBe(before);
		const plan = controller.getPlan(r.plan.id)!;
		expect(plan.edits).toEqual([
			{ op: 'roll_edit', left: 'b1', right: 'b2', delta: expect.any(Number) },
			{ op: 'roll_edit', left: 'b2', right: 'b3', delta: expect.any(Number) }
		]);
		await call('apply_video_edit_plan', { plan: r.plan.id });
		const v2 = controller.getProject().tracks.find((t) => t.id === 'v2')!.clips;
		expect(Math.abs(v2[1].start - 1000)).toBeLessThanOrEqual(20);
		expect(Math.abs(v2[2].start - 2000)).toBeLessThanOrEqual(20);
		expect(await fail('plan_video_beat_snap', { track: 'v2', beats: [5000] })).toMatch(/No cut on track "v2" can move/);
		expect(await fail('plan_video_beat_snap', { track: 'v2' })).toMatch(/either "music"/);
	});
});
