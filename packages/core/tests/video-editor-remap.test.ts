import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import {
	applyVideoEdits,
	checkVideoProject,
	checkVideoTimeRemap,
	createVideoEditorToolProvider,
	createVideoProject,
	parseVideoProject,
	toVideoEdl,
	toVideoFfmpeg,
	VideoEditorController,
	videoClipSourceRange,
	videoClipSourceTime,
	videoClipSpeedAt,
	videoFrameAt,
	videoSpeedRampKeys,
	videoValueAt,
	type VideoEdit,
	type VideoMediaClip,
	type VideoProject
} from '../src/video-editor';

const ok = (p: VideoProject, edits: VideoEdit | VideoEdit[]) => {
	const r = applyVideoEdits(p, edits);
	if (!r.ok) throw new Error(r.error);
	return r.project;
};
const fail = (p: VideoProject, edits: VideoEdit | VideoEdit[]) => {
	const r = applyVideoEdits(p, edits);
	if (r.ok) throw new Error('expected a refusal');
	return r.error;
};
const shot = () =>
	ok(createVideoProject({ width: 640, height: 360, fps: 25 }), [
		{ op: 'add_asset', asset: { id: 'run', kind: 'video', src: 'run.mp4', duration: 10000 } },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'c', asset: 'run', in: 1000, duration: 2000 } },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'next', asset: 'run', in: 5000, duration: 1000 } }
	]);
const clip = (p: VideoProject, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id) as VideoMediaClip;

describe('speed ramp keys', () => {
	it('turn stretches of speed into keys, merging steady stretches and easing ramps exactly', () => {
		const r = videoSpeedRampKeys([{ duration: 1000, speed: 1 }, { duration: 500, speed: 1 }, { duration: 1000, speed: 1, toSpeed: 0.25 }, { duration: 500, speed: 0 }]);
		expect(r.keys.map((k) => [k.t, k.v])).toEqual([[0, 0], [1500, 1500], [2500, 2125], [3000, 2125]]);
		expect(r).toMatchObject({ duration: 3000, source: 2125 });
		// Through the ramp the speed falls evenly from 1 to 0.25: the source is quadratic in time.
		const remap = { keys: r.keys };
		for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) expect(videoValueAt(remap, 1500 + 1000 * u)).toBeCloseTo(1500 + 1000 * (u - (0.75 * u * u) / 2), 0);
		expect(() => videoSpeedRampKeys([])).toThrow('at least one stretch');
		expect(() => videoSpeedRampKeys([{ duration: 0, speed: 1 }])).toThrow('Stretch 1 needs a duration');
		expect(() => videoSpeedRampKeys([{ duration: 10, speed: 30 }])).toThrow("Stretch 1's speed must be from 0");
	});

	it('are checked: forwards only', () => {
		expect(() => checkVideoTimeRemap({ keys: [{ t: 0, v: 500 }, { t: 100, v: 200 }] })).toThrow('goes back in the source');
		expect(() => checkVideoTimeRemap({ keys: [{ t: 0, v: 0, ease: [0.5, -1, 0.5, 2] }, { t: 100, v: 100 }] })).toThrow('overshoots');
		expect(() => checkVideoTimeRemap({ keys: [{ t: 0, v: -1 }] })).toThrow('must be at least 0');
		expect(() => parseVideoProject({ width: 640, height: 360, assets: [], tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'x', type: 'media', asset: 'a', start: 0, duration: 100, speed: 2, timeRemap: { keys: [{ t: 0, v: 0 }] } }] }] })).toThrow('cannot be used with a speed');
	});
});

describe('ramped clips', () => {
	const ramped = () => {
		const r = videoSpeedRampKeys([{ duration: 1000, speed: 1 }, { duration: 1000, speed: 0 }, { duration: 1000, speed: 2 }]);
		return ok(shot(), { op: 'set_time_remap', clip: 'c', keys: r.keys, duration: r.duration, ripple: true });
	};

	it('play their source through the ramp, freezing and speeding up', () => {
		const p = ramped();
		const c = clip(p, 'c');
		expect(c.duration).toBe(3000);
		expect(clip(p, 'next').start).toBe(3000);
		expect([500, 1500, 2500].map((t) => videoClipSourceTime(c, t))).toEqual([1500, 2000, 3000]);
		expect([500, 1500, 2500].map((t) => Math.round(videoClipSpeedAt(c, t)))).toEqual([1, 0, 2]);
		expect(videoClipSourceRange(c)).toEqual({ in: 1000, out: 4000 });
		const f = videoFrameAt(p, 1500);
		expect(f.layers[0].sourceTime).toBe(2000);
		expect(f.audio[0].speed).toBe(0);
		expect(checkVideoProject(p).filter((i) => i.severity !== 'note')).toEqual([]);
	});

	it('keep their frames of source through trims, splits and slips', () => {
		const p = ramped();
		const trimmed = ok(p, { op: 'trim_clip', clip: 'c', edge: 'start', to: 500 });
		expect(videoClipSourceTime(clip(trimmed, 'c'), 0)).toBe(1500);
		const split = ok(p, { op: 'split_clip', clip: 'c', at: 2500, id: 'c2' });
		expect(videoFrameAt(split, 2700).layers[0].sourceTime).toBe(videoFrameAt(p, 2700).layers[0].sourceTime);
		expect(clip(split, 'c2').timeRemap!.keys[0]).toMatchObject({ t: 0, v: 2000 });
		const slipped = ok(p, { op: 'slip_clip', clip: 'c', delta: 400 });
		expect(videoClipSourceTime(clip(slipped, 'c'), 500)).toBe(1900);
		// Holds past its ends: lengthening the tail freezes the last frame.
		const longer = ok(p, { op: 'trim_clip', clip: 'c', edge: 'end', to: 3500, ripple: true });
		expect(videoClipSourceTime(clip(longer, 'c'), 3400)).toBe(4000);
	});

	it('refuse what would break them, and come off at normal speed from where they began', () => {
		const p = ramped();
		expect(fail(p, { op: 'update_clip', clip: 'c', set: { speed: 2 } })).toMatch(/has a speed ramp, which sets its speed/);
		expect(fail(p, { op: 'update_clip', clip: 'c', set: { timeRemap: { keys: [{ t: 0, v: 0 }] } } })).toMatch(/set_time_remap/);
		expect(fail(shot(), { op: 'set_time_remap', clip: 'c', keys: [{ t: 0, v: 0 }, { t: 1000, v: 9500 }] })).toMatch(/past the end of "run" \(10000 ms\); it can use at most 9000 ms/);
		expect(fail(shot(), { op: 'set_time_remap', clip: 'c', keys: [{ t: 0, v: 0 }, { t: 3000, v: 3000 }], duration: 3000 })).toMatch(/Lengthening "c"/);
		expect(fail(shot(), { op: 'set_time_remap', clip: 'c', keys: null })).toMatch(/no speed ramp to remove/);
		const plain = ok(p, { op: 'set_time_remap', clip: 'c', keys: null });
		expect(clip(plain, 'c')).toMatchObject({ in: 1000, duration: 3000 });
		expect(clip(plain, 'c').timeRemap).toBeUndefined();
	});

	it('export as a re-timed picture and stepped sound, and as one EDL event', () => {
		const p = ramped();
		const ff = toVideoFfmpeg(p);
		expect(ff.filterComplex).toMatch(/setpts='\(if\(lt\(\(T\*1000\+0\),1000\),0\+\(\(T\*1000\+0\)-0\)\*1,/);
		expect(ff.filterComplex).toContain('fps=25,tpad=stop_mode=clone');
		expect(ff.filterComplex).toMatch(/asplit=2/);
		expect(ff.filterComplex).toMatch(/anullsrc=r=48000:cl=stereo,atrim=duration=1,/);
		expect(ff.filterComplex).toMatch(/atempo=2,aformat/);
		expect(ff.notes.join(' ')).toMatch(/speed ramp/);
		expect(ff.args).toEqual(expect.arrayContaining(['-ss', '1', '-t', '3.04']));
		expect(toVideoEdl(p)).toContain('00:00:01:00 00:00:04:00');
	});
});

describe('speed ramp tools', () => {
	const setup = () => {
		const controller = new VideoEditorController({ clock: new ManualClock(), project: shot() });
		const registry = new ToolRegistry();
		registry.register(createVideoEditorToolProvider(controller));
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const r = await registry.callTool(name, args);
			if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`);
			return r.structuredContent as any;
		};
		const failTool = async (name: string, args: Record<string, unknown> = {}) => {
			const r = await registry.callTool(name, args);
			expect(r.isError, `${name} should fail`).toBe(true);
			return r.content.map((c) => ('text' in c ? c.text : '')).join('\n');
		};
		return { controller, call, failTool };
	};

	it('ramp into slow motion, freeze a frame and go back to normal, each one undo step', async () => {
		const { controller, call, failTool } = setup();
		const ramp = await call('set_video_speed_ramp', { clip: 'c', segments: [{ duration: 1000, speed: 1 }, { duration: 500, speed: 1, toSpeed: 0.25 }, { duration: 1000, speed: 0.25 }] });
		expect(ramp.clip.duration).toBe(2500);
		// 1000 ms at 1, 500 ms gliding to 0.25 (an average of 0.625), 1000 ms at 0.25.
		expect(ramp.clip.source).toEqual({ in: 1000, out: 2562.5 });
		expect(ramp).toMatchObject({ rippled: ['v1', 'a1'], source: 1563 });
		expect((await call('get_video_project')).tracks[0].clips[1].start).toBe(2500);

		const frozen = await call('add_video_freeze_frame', { clip: 'c', at: 500, duration: 1000 });
		expect(frozen.clip.duration).toBe(3500);
		const during = await call('get_video_frame', { time: 1200 });
		expect(during.layers[0].sourceTime).toBe(1500);
		expect(during.audio[0].speed).toBe(0);
		expect((await call('get_video_frame', { time: 1600 })).layers[0].sourceTime).toBeCloseTo(1600, 0);
		expect(controller.getState().undoLabel).toBe('Freeze frame');

		const back = await call('remove_video_speed_ramp', { clip: 'c' });
		expect(back.clip).toMatchObject({ in: 1000, duration: 3500 });
		expect(back.clip.timeRemap).toBeUndefined();

		expect(await failTool('add_video_freeze_frame', { clip: 'c', at: 9000, duration: 500 })).toContain('is outside clip "c"');
		expect(await failTool('set_video_speed_ramp', { clip: 'c', segments: [{ duration: 100, speed: 25 }] })).toContain('speed');
		expect(await failTool('set_video_speed_ramp', { clip: 'c', segments: [{ duration: 100, speed: 1, toSpeed: 1, extra: 1 }] })).toContain('extra');
		await call('add_video_clip', { track: 'v2', clip: { type: 'text', id: 't', text: 'Hi' } }).catch(() => call('add_video_track', { kind: 'video', id: 'v2' }).then(() => call('add_video_clip', { track: 'v2', clip: { type: 'text', id: 't', text: 'Hi' } })));
		expect(await failTool('set_video_speed_ramp', { clip: 't', segments: [{ duration: 100, speed: 1 }] })).toContain('is a title');
		expect(await failTool('set_video_speed_ramp', { clip: 'c', segments: [{ duration: 20000, speed: 1 }], ripple: false })).toContain('past the end of "run"');
	});
});
