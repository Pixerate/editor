import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import {
	applyVideoEdits,
	checkVideoProject,
	createVideoProject,
	drawVideoFrame,
	ffmpegFilterValue,
	findVideoGaps,
	formatVideoTimecode,
	formatVideoTimecodeFrames,
	isVideoDropFrameRate,
	videoHourFrames,
	parseVideoProject,
	placeVideoRect,
	snapToVideoFrame,
	toVideoEdl,
	toVideoFfmpeg,
	videoContactSheetSvg,
	videoFrameAt,
	videoProjectSvg,
	VideoEditorController,
	VideoPreviewEngine,
	type VideoEdit,
	type VideoPreviewMedia,
	type VideoProject
} from '../src/video-editor';

/** Two 10 s shots and a song, on v1 / a1. */
function project(): VideoProject {
	const p = createVideoProject({ name: 'demo', width: 1280, height: 720, fps: 25 });
	const r = applyVideoEdits(p, [
		{ op: 'add_asset', asset: { id: 'beach', kind: 'video', src: 'beach.mp4', duration: 10000, width: 1920, height: 1080 } },
		{ op: 'add_asset', asset: { id: 'city', kind: 'video', src: 'city.mp4', duration: 10000, width: 1280, height: 720, hasAudio: false } },
		{ op: 'add_asset', asset: { id: 'song', kind: 'audio', src: 'song.mp3', duration: 60000 } },
		{ op: 'add_asset', asset: { id: 'logo', kind: 'image', src: 'logo.png', width: 400, height: 200 } },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'a', asset: 'beach', in: 2000, duration: 4000 } },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'b', asset: 'city', in: 1000, duration: 3000 } },
		{ op: 'add_clip', track: 'a1', clip: { type: 'media', id: 's', asset: 'song', duration: 7000, volume: 0.5 } }
	]);
	if (!r.ok) throw new Error(r.error);
	return r.project;
}

const ok = (r: ReturnType<typeof applyVideoEdits>) => {
	if (!r.ok) throw new Error(r.error);
	return r.project;
};
const clip = (p: VideoProject, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;

describe('parseVideoProject', () => {
	it('reads JSON and fills in the version and fps', () => {
		const p = parseVideoProject('{"width":640,"height":360,"tracks":[{"id":"v1","kind":"video"}]}');
		expect(p).toEqual({ version: 1, width: 640, height: 360, fps: 30, assets: [], tracks: [{ id: 'v1', kind: 'video', clips: [] }] });
	});

	it('names the first bad field', () => {
		expect(() => parseVideoProject({ width: 640, height: 360, tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'x', type: 'media', asset: 'a', start: 0, duration: -1 }] }] })).toThrow('tracks[0].clips[0].duration must be greater than 0.');
		expect(() => parseVideoProject({ width: 640, height: 360, tracks: [{ id: 'v1', kind: 'subtitles' }] })).toThrow('tracks[0].kind must be one of "video", "audio".');
		expect(() => parseVideoProject('{nope')).toThrow(/not valid JSON/);
	});

	it('refuses duplicate ids', () => {
		expect(() => parseVideoProject({ width: 1, height: 1, tracks: [{ id: 'v', kind: 'video' }, { id: 'v', kind: 'audio' }] })).toThrow('Two tracks share the id "v"');
	});
});

describe('applyVideoEdits', () => {
	it('appends clips at the end of the track by default and fills in the length', () => {
		const p = project();
		expect(clip(p, 'b')).toMatchObject({ start: 4000, duration: 3000, in: 1000 });
		const q = ok(applyVideoEdits(p, { op: 'add_clip', track: 'v1', clip: { type: 'media', asset: 'logo' } }));
		expect(clip(q, 'c1')).toMatchObject({ start: 7000, duration: 5000 });
		const r = ok(applyVideoEdits(p, { op: 'add_clip', track: 'v1', clip: { type: 'media', asset: 'beach', in: 4000 } }));
		expect(clip(r, 'c1').duration).toBe(6000);
	});

	it('refuses an overlap, naming the clip and the next free place', () => {
		const r = applyVideoEdits(project(), { op: 'add_clip', track: 'v1', clip: { type: 'text', text: 'Hi', start: 1000, duration: 1000 } });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error).toMatch(/would overlap clip "a" \(0\.00 s–4\.00 s\) on track "v1"; the next free place is 7\.00 s/);
	});

	it('inserts with ripple, pushing later clips along', () => {
		const p = ok(applyVideoEdits(project(), { op: 'add_clip', track: 'v1', clip: { type: 'color', color: '#ff0000', start: 4000, duration: 1000 }, ripple: true }));
		expect(clip(p, 'c1')).toMatchObject({ start: 4000 });
		expect(clip(p, 'b').start).toBe(5000);
		// The song is sync-locked: it is cut at the insert point and its rest pushed along too.
		expect(clip(p, 's')).toMatchObject({ start: 0, duration: 4000 });
		expect(clip(p, 's-1')).toMatchObject({ start: 5000, duration: 3000, in: 4000 });
		const inside = ok(applyVideoEdits(project(), { op: 'add_clip', track: 'v1', clip: { type: 'color', color: '#f00', start: 2000 }, ripple: true }));
		expect(inside.tracks[0].clips.map((c) => [c.id, c.start, c.duration])).toEqual([['a', 0, 2000], ['c1', 2000, 3000], ['a-1', 5000, 2000], ['b', 7000, 3000]]);
	});

	it('refuses the wrong kind of media for a track', () => {
		const r = applyVideoEdits(project(), { op: 'add_clip', track: 'a1', clip: { type: 'media', asset: 'logo', start: 8000 } });
		expect(!r.ok && r.error).toMatch(/audio track; images go on a video track/);
		const t = applyVideoEdits(project(), { op: 'add_clip', track: 'v1', clip: { type: 'media', asset: 'song' } });
		expect(!t.ok && t.error).toMatch(/audio asset "song" goes on an audio track/);
	});

	it('trims edges within the source and says how far it can go', () => {
		const p = project();
		const start = ok(applyVideoEdits(p, { op: 'trim_clip', clip: 'a', edge: 'start', to: 1000 }));
		expect(clip(start, 'a')).toMatchObject({ start: 1000, duration: 3000, in: 3000 });
		const back = applyVideoEdits(p, { op: 'trim_clip', clip: 'b', edge: 'start', to: 2500 });
		expect(!back.ok && back.error).toMatch(/"b" starts 1000 ms into its source, so its start can move at most that far earlier \(to 3\.00 s\)/);
		expect(applyVideoEdits(start, { op: 'trim_clip', clip: 'a', edge: 'start', to: -500 }).ok).toBe(false);
		const tooFar = applyVideoEdits(p, { op: 'trim_clip', clip: 'b', edge: 'end', to: 20000 });
		expect(!tooFar.ok && tooFar.error).toMatch(/can end at most at 13\.00 s, where "city" runs out/);
		const tiny = applyVideoEdits(p, { op: 'trim_clip', clip: 'b', edge: 'end', to: 4010 });
		expect(!tiny.ok && tiny.error).toMatch(/shorter than a frame/);
	});

	it('ripple trims keep the cut after it in sync', () => {
		const refused = applyVideoEdits(project(), { op: 'trim_clip', clip: 'a', edge: 'end', to: 3000, ripple: true });
		expect(!refused.ok && refused.error).toMatch(/would pull track "a1" out of sync: clip "s" \(0\.00 s–7\.00 s\) is in that stretch.*syncLocked false/);
		const free = ok(applyVideoEdits(project(), { op: 'update_track', track: 'a1', set: { syncLocked: false } }));
		const p = ok(applyVideoEdits(free, { op: 'trim_clip', clip: 'a', edge: 'end', to: 3000, ripple: true }));
		expect(clip(p, 'a').duration).toBe(3000);
		expect(clip(p, 'b').start).toBe(3000);
		expect(clip(p, 's').start).toBe(0);
		const q = ok(applyVideoEdits(free, { op: 'trim_clip', clip: 'a', edge: 'start', to: 1000, ripple: true }));
		expect(clip(q, 'a')).toMatchObject({ start: 0, duration: 3000, in: 3000 });
		expect(clip(q, 'b').start).toBe(3000);
	});

	it('splits a clip, moving the source in point and fade out to the right part', () => {
		const withFade = ok(applyVideoEdits(project(), { op: 'update_clip', clip: 'a', set: { fadeIn: 200, fadeOut: 300 } }));
		const r = applyVideoEdits(withFade, { op: 'split_clip', clip: 'a', at: 1500 });
		const p = ok(r);
		expect(clip(p, 'a')).toMatchObject({ start: 0, duration: 1500, in: 2000, fadeIn: 200 });
		expect(clip(p, 'a').fadeOut).toBeUndefined();
		expect(clip(p, 'a-1')).toMatchObject({ start: 1500, duration: 2500, in: 3500, fadeOut: 300 });
		expect(r.ok && r.outcomes[0]).toEqual({ op: 'split_clip', clips: ['a', 'a-1'], clip: 'a-1', track: 'v1' });
		const edge = applyVideoEdits(project(), { op: 'split_clip', clip: 'a', at: 4000 });
		expect(!edge.ok && edge.error).toMatch(/is not inside "a"/);
	});

	it('deletes with ripple and closes gaps', () => {
		const free = ok(applyVideoEdits(project(), { op: 'update_track', track: 'a1', set: { syncLocked: false } }));
		const p = ok(applyVideoEdits(free, { op: 'delete_clips', clips: ['a'], ripple: true }));
		expect(clip(p, 'b').start).toBe(0);
		const lifted = ok(applyVideoEdits(project(), { op: 'delete_clips', clips: ['a'] }));
		expect(findVideoGaps(lifted, 'v1')).toEqual([{ track: 'v1', start: 0, end: 4000 }]);
		const closed = ok(applyVideoEdits(lifted, { op: 'close_gaps', track: 'v1' }));
		expect(clip(closed, 'b').start).toBe(0);
	});

	it('a new speed keeps the stretch of source', () => {
		const p = ok(applyVideoEdits(project(), [{ op: 'delete_clips', clips: ['b'] }, { op: 'update_clip', clip: 'a', set: { speed: 2 } }]));
		expect(clip(p, 'a')).toMatchObject({ duration: 2000, speed: 2 });
		const back = ok(applyVideoEdits(p, { op: 'update_clip', clip: 'a', remove: ['speed'] }));
		expect(clip(back, 'a').duration).toBe(4000);
		const overlap = applyVideoEdits(project(), { op: 'update_clip', clip: 'a', set: { speed: 0.5 } });
		expect(!overlap.ok && overlap.error).toMatch(/would overlap clip "b"/);
	});

	it('is all or nothing and names the failing op', () => {
		const before = project();
		const r = applyVideoEdits(before, [{ op: 'add_marker', marker: { time: 1000 } }, { op: 'move_clip', clip: 'bb', start: 0 }]);
		expect(!r.ok && r.error).toBe('op 2 (move_clip): There is no clip "bb" (did you mean "b"?). Nothing was changed.');
		expect(before.markers).toBeUndefined();
	});

	it('refuses edits to locked tracks', () => {
		const p = ok(applyVideoEdits(project(), { op: 'update_track', track: 'v1', set: { locked: true } }));
		const r = applyVideoEdits(p, { op: 'delete_clips', clips: ['a'] });
		expect(!r.ok && r.error).toMatch(/Track "v1" is locked/);
	});

	it('will not add an error: a crossfade without handles is refused with the longest that fits', () => {
		// "a" ends at 6 s of a 10 s source (4 s after), "b" starts 1 s into its source.
		const r = applyVideoEdits(project(), { op: 'set_transition', clip: 'b', transition: { type: 'crossfade', duration: 3000 } });
		expect(!r.ok && r.error).toMatch(/That would leave an error: The 3000 ms transition into "b" needs 1500 ms of media past the cut on both sides, but "a" has 4000 ms after its out point and "b" 1000 ms before its in point; make it at most 2000 ms/);
		const long = applyVideoEdits(project(), { op: 'set_transition', clip: 'b', transition: { type: 'crossfade', duration: 4000 } });
		expect(!long.ok && long.error).toMatch(/is longer than "b" \(3000 ms\) or "a" \(4000 ms\); make it at most 3000 ms/);
		const fine = ok(applyVideoEdits(project(), { op: 'set_transition', clip: 'b', transition: { type: 'crossfade', duration: 1000 } }));
		expect(clip(fine, 'b').transition).toEqual({ type: 'crossfade', duration: 1000 });
		// A dip needs no handles.
		expect(applyVideoEdits(project(), { op: 'set_transition', clip: 'b', transition: { type: 'dip', duration: 3000 } }).ok).toBe(true);
	});

	it('keeps errors a loaded file already had from blocking other edits', () => {
		const broken = parseVideoProject({ width: 100, height: 100, tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'x', type: 'media', asset: 'gone', start: 0, duration: 1000 }] }] });
		expect(checkVideoProject(broken)[0]).toMatchObject({ code: 'missing-asset', severity: 'error', clip: 'x' });
		expect(applyVideoEdits(broken, { op: 'add_marker', marker: { time: 0 } }).ok).toBe(true);
	});

	it('removes assets only when unused, and suggests names', () => {
		const r = applyVideoEdits(project(), { op: 'remove_asset', asset: 'beach' });
		expect(!r.ok && r.error).toMatch(/used by clip "a"; delete it first/);
		const p = ok(applyVideoEdits(project(), { op: 'remove_asset', asset: 'logo' }));
		expect(p.assets.map((a) => a.id)).toEqual(['beach', 'city', 'song']);
		const typo = applyVideoEdits(project(), { op: 'remove_asset', asset: 'logoo' });
		expect(!typo.ok && typo.error).toMatch(/"logoo" \(did you mean "logo"\?\)/);
	});

	it('adds tracks: video on top, audio at the bottom', () => {
		const p = ok(applyVideoEdits(project(), [{ op: 'add_track', track: { kind: 'video' } }, { op: 'add_track', track: { kind: 'audio' } }]));
		expect(p.tracks.map((t) => t.id)).toEqual(['v2', 'v1', 'a1', 'a2']);
	});
});

describe('videoFrameAt', () => {
	it('places pictures by fit and maps timeline to source time', () => {
		const f = videoFrameAt(project(), 1000);
		expect(f.layers).toHaveLength(1);
		expect(f.layers[0]).toMatchObject({ clip: 'a', sourceTime: 3000, opacity: 1, rect: { x: 0, y: 0, width: 1280, height: 720 } });
		expect(f.audio.map((a) => [a.clip, a.gain])).toEqual([
			['s', 0.5],
			['a', 1]
		]);
		expect(placeVideoRect({ width: 100, height: 100 }, { width: 200, height: 100 }, 'cover')).toEqual({ x: -50, y: 0, width: 200, height: 100 });
		expect(placeVideoRect({ width: 100, height: 100 }, { width: 200, height: 100 }, 'contain', { x: 10, scale: 0.5 })).toEqual({ x: 35, y: 37.5, width: 50, height: 25 });
	});

	it('draws earlier tracks over later ones', () => {
		const p = ok(applyVideoEdits(project(), [{ op: 'add_track', track: { kind: 'video', id: 'titles' } }, { op: 'add_clip', track: 'titles', clip: { type: 'text', text: 'Hello', start: 0, duration: 2000 } }]));
		expect(videoFrameAt(p, 500).layers.map((l) => l.clip)).toEqual(['a', 'c1']);
	});

	it('fades and crossfades', () => {
		const p = ok(applyVideoEdits(project(), [{ op: 'update_clip', clip: 'a', set: { fadeIn: 1000 } }, { op: 'set_transition', clip: 'b', transition: { type: 'crossfade', duration: 1000 } }]));
		expect(videoFrameAt(p, 500).layers[0].opacity).toBeCloseTo(0.5);
		// Halfway through the crossfade (at the cut): "a" fully under, "b" half up, both running into handles.
		const mid = videoFrameAt(p, 4000);
		expect(mid.layers.map((l) => [l.clip, l.opacity, l.sourceTime])).toEqual([
			['a', 1, 6000],
			['b', 0.5, 1000]
		]);
		const early = videoFrameAt(p, 3600);
		expect(early.layers.map((l) => l.clip)).toEqual(['a', 'b']);
		expect(early.layers[1].sourceTime).toBe(600);
		expect(early.audio.find((a) => a.clip === 'a')!.gain).toBeCloseTo(0.9);
	});

	it('dips through a colour without running past the cut', () => {
		const p = ok(applyVideoEdits(project(), { op: 'set_transition', clip: 'b', transition: { type: 'dip', duration: 1000, color: '#ffffff' } }));
		const before = videoFrameAt(p, 3750);
		expect(before.layers.map((l) => [l.clip, l.type, l.opacity])).toEqual([
			['a', 'media', 1],
			['transition:b', 'color', 0.5]
		]);
		const after = videoFrameAt(p, 4250);
		expect(after.layers.map((l) => [l.clip, l.opacity])).toEqual([
			['b', 1],
			['transition:b', 0.5]
		]);
		expect(after.layers[0].sourceTime).toBe(1250);
	});

	it('wipes', () => {
		const p = ok(applyVideoEdits(project(), { op: 'set_transition', clip: 'b', transition: { type: 'wipe', duration: 1000, direction: 'left' } }));
		expect(videoFrameAt(p, 3750).layers[1].wipe).toEqual({ direction: 'left', progress: 0.25 });
	});

	it('leaves out hidden tracks and silences muted ones', () => {
		const p = ok(applyVideoEdits(project(), [{ op: 'update_track', track: 'v1', set: { hidden: true } }, { op: 'update_track', track: 'a1', set: { muted: true } }]));
		const f = videoFrameAt(p, 1000);
		expect(f.layers).toEqual([]);
		expect(f.audio.map((a) => a.clip)).toEqual(['a']);
	});
});

describe('rendering', () => {
	it('draws SVG with posters, placeholders, titles and wipes', () => {
		const p = ok(applyVideoEdits(project(), [{ op: 'add_track', track: { kind: 'video', id: 't' } }, { op: 'add_clip', track: 't', clip: { type: 'text', text: 'A & B\nline 2', start: 0, duration: 1000, background: '#000' } }]));
		const svg = videoProjectSvg(p, 500);
		expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 1280 720"/);
		expect(svg).toContain('beach · 00:00:02:13');
		expect(svg).toContain('<tspan x="640" y="321.6">A &amp; B</tspan>');
		const withPoster = ok(applyVideoEdits(p, { op: 'update_asset', asset: 'beach', set: { poster: 'beach.jpg' } }));
		expect(videoProjectSvg(withPoster, 500)).toContain('<image href="beach.jpg"');
		const wipe = ok(applyVideoEdits(project(), { op: 'set_transition', clip: 'b', transition: { type: 'wipe', duration: 1000 } }));
		expect(videoProjectSvg(wipe, 4000)).toMatch(/<clipPath id="w1"><rect x="0" y="0" width="640" height="720"\/>/);
	});

	it('draws a contact sheet with labels', () => {
		const sheet = videoContactSheetSvg(project(), [0, 2000, 5000], { columns: 3, width: 160 });
		expect(sheet.match(/<svg x=/g)).toHaveLength(3);
		expect(sheet).toContain('2.00 s · 00:00:02:00');
	});

	it('draws a frame on a canvas in order, with sources or placeholders', () => {
		const calls: string[] = [];
		const ctx: any = new Proxy(
			{ globalAlpha: 1, measureText: () => ({ width: 100 }) },
			{
				get: (t, k) => (k in t ? t[k] : (...args: unknown[]) => calls.push(`${String(k)}(${args.filter((a) => typeof a !== 'object').join(',')})`)),
				set: (t, k, v) => {
					t[k] = v;
					if (k === 'globalAlpha' || k === 'fillStyle') calls.push(`${String(k)}=${v}`);
					return true;
				}
			}
		);
		const p = ok(applyVideoEdits(project(), { op: 'set_transition', clip: 'b', transition: { type: 'crossfade', duration: 1000 } }));
		const source = {} as CanvasImageSource;
		drawVideoFrame(ctx, videoFrameAt(p, 4000), (l) => (l.clip === 'a' ? source : null), 0.5);
		expect(calls).toContain('setTransform(0.5,0,0,0.5,0,0)');
		expect(calls).toContain('drawImage(0,0,1280,720)');
		expect(calls).toContain('globalAlpha=0.5');
		expect(calls).toContain('fillStyle=#334155');
	});
});

describe('exports', () => {
	it('formats timecode and snaps to frames', () => {
		expect(formatVideoTimecode(3_723_480, 25)).toBe('01:02:03:12');
		expect(snapToVideoFrame(1013, 25)).toBe(1000);
		expect(snapToVideoFrame(1030, 25)).toBe(1040);
	});

	it('counts drop-frame timecode at 29.97 and 59.94 fps', () => {
		const at = (frames: number, fps: number) => (frames * 1001) / Math.round(fps);
		expect(isVideoDropFrameRate(29.97)).toBe(true);
		expect(isVideoDropFrameRate(30000 / 1001)).toBe(true);
		expect(isVideoDropFrameRate(59.94)).toBe(true);
		expect(isVideoDropFrameRate(30)).toBe(false);
		expect(isVideoDropFrameRate(23.976)).toBe(false);
		// Frame numbers 0 and 1 are skipped at each minute but not each tenth minute.
		expect(formatVideoTimecode(at(1799, 29.97), 29.97)).toBe('00:00:59;29');
		expect(formatVideoTimecode(at(1800, 29.97), 29.97)).toBe('00:01:00;02');
		expect(formatVideoTimecode(at(17982, 29.97), 29.97)).toBe('00:10:00;00');
		expect(formatVideoTimecode(at(17981, 29.97), 29.97)).toBe('00:09:59;29');
		expect(formatVideoTimecode(at(107892, 29.97), 29.97)).toBe('01:00:00;00');
		expect(formatVideoTimecode(at(3600, 59.94), 59.94)).toBe('00:01:00;04');
		// An hour of wall-clock time reads as an hour.
		expect(formatVideoTimecode(3_600_000, 29.97)).toBe('01:00:00;00');
		// Non-drop on request, and never at rates without a drop-frame form.
		expect(formatVideoTimecode(at(1800, 29.97), 29.97, false)).toBe('00:01:00:00');
		expect(formatVideoTimecode(1000, 25, true)).toBe('00:00:01:00');
		expect(videoHourFrames(29.97)).toBe(107892);
		expect(videoHourFrames(59.94)).toBe(215784);
		expect(videoHourFrames(29.97, false)).toBe(108000);
		expect(formatVideoTimecodeFrames(videoHourFrames(59.94), 59.94)).toBe('01:00:00;00');
	});

	it('writes drop-frame EDLs at NTSC rates', () => {
		const p = { ...project(), fps: 29.97 };
		const edl = toVideoEdl(p);
		expect(edl).toContain('FCM: DROP FRAME');
		expect(edl).toMatch(/01:00:00;00/);
		const ndf = toVideoEdl(p, { dropFrame: false });
		expect(ndf).toContain('FCM: NON-DROP FRAME');
		expect(ndf).not.toContain(';');
		expect(toVideoEdl(project(), { dropFrame: true })).toContain('FCM: NON-DROP FRAME');
	});

	it('writes a CMX 3600 EDL with dissolves and speed changes', () => {
		const p = ok(applyVideoEdits(project(), [{ op: 'set_transition', clip: 'b', transition: { type: 'crossfade', duration: 1000 } }]));
		const edl = toVideoEdl(p);
		expect(edl.split('\n').slice(0, 9)).toEqual([
			'TITLE: DEMO',
			'FCM: NON-DROP FRAME',
			'',
			'001  BEACH    V     C        00:00:02:00 00:00:05:13 01:00:00:00 01:00:03:13',
			'* FROM CLIP NAME: beach.mp4',
			'',
			'002  BEACH    V     C        00:00:05:13 00:00:05:13 01:00:03:13 01:00:03:13',
			'002  CITY     V     D    025 00:00:00:13 00:00:04:00 01:00:03:13 01:00:07:00',
			'* FROM CLIP NAME: city.mp4'
		]);
		const fast = ok(applyVideoEdits(project(), [{ op: 'delete_clips', clips: ['b'] }, { op: 'update_clip', clip: 'a', set: { speed: 2 } }]));
		expect(toVideoEdl(fast)).toContain('M2   BEACH      50.0      00:00:02:00');
		expect(() => toVideoEdl(project(), { track: 'nope' })).toThrow('There is no track "nope".');
	});

	it('builds an ffmpeg command: inputs trimmed with handles, overlays in track order, mixed sound', () => {
		const p = ok(
			applyVideoEdits(project(), [
				{ op: 'set_transition', clip: 'b', transition: { type: 'crossfade', duration: 1000 } },
				{ op: 'add_track', track: { kind: 'video', id: 't' } },
				{ op: 'add_clip', track: 't', clip: { type: 'text', text: "It's 10:30", start: 0, duration: 2000, fadeIn: 500 } }
			])
		);
		const ff = toVideoFfmpeg(p, { output: 'out.mp4' });
		expect(ff.duration).toBe(7000);
		// Back to front: the audio track (bottom) first, then v1.
		expect(ff.args.slice(0, 19)).toEqual(['-y', '-ss', '0', '-t', '7', '-i', 'song.mp3', '-ss', '2', '-t', '4.5', '-i', 'beach.mp4', '-ss', '0.5', '-t', '3.5', '-i', 'city.mp4']);
		expect(ff.filterComplex).toContain('color=c=0x000000:s=1280x720:r=25:d=7,format=yuva420p[base]');
		expect(ff.filterComplex).toContain('[1:v]setpts=PTS-STARTPTS,fps=25,scale=1280:720,format=yuva420p,setpts=PTS+0/TB[lv0]');
		expect(ff.filterComplex).toContain('[2:v]setpts=PTS-STARTPTS,fps=25,scale=1280:720,format=yuva420p,fade=t=in:st=0:d=1:alpha=1,setpts=PTS+3.5/TB[lv1]');
		expect(ff.filterComplex).toContain("[v0][lv1]overlay=x='640-w/2':y='360-h/2':eof_action=pass:enable='between(t,3.5,7)'[v1]");
		expect(ff.filterComplex).toContain("drawtext=text=It\\\\\\'s 10\\\\:30");
		expect(ff.filterComplex).toContain("alpha='1*min(1,(t-0)/0.5)'");
		expect(ff.filterComplex).toContain('[0:a]asetpts=PTS-STARTPTS,volume=0.5,adelay=0:all=1[a0]');
		expect(ff.filterComplex).toContain('[1:a]asetpts=PTS-STARTPTS,volume=1,afade=t=out:st=3.5:d=1,adelay=0:all=1[a1]');
		expect(ff.filterComplex).toMatch(/amix=inputs=2:normalize=0:duration=longest,apad,atrim=0:7\[aout\]/);
		expect(ff.args.slice(-3)).toEqual(['-t', '7', 'out.mp4']);
		expect(ff.command).toMatch(/^ffmpeg -y -ss 0 -t 7 -i song\.mp3 -ss 2 /);
		expect(ff.notes).toEqual([
			'Video assets are assumed to have sound; set "hasAudio": false on any that do not, or ffmpeg will stop at a missing audio stream.',
			'Titles use drawtext, which needs an ffmpeg built with libfreetype (Homebrew\'s is not: check `ffmpeg -filters | grep drawtext`); pass titleImage to render them as images instead.'
		]);
		// With titleImage, the title is an image input overlaid full-frame with its fade, and no drawtext.
		const imaged = toVideoFfmpeg(p, { output: 'out.mp4', titleImage: (c, size) => `${c.id}-${size.width}x${size.height}.png` });
		expect(imaged.filterComplex).not.toContain('drawtext');
		expect(imaged.args).toEqual(expect.arrayContaining(['-loop', '1', '-framerate', '25', '-t', '2', '-i', 'c1-1280x720.png']));
		expect(imaged.filterComplex).toMatch(/\[3:v\]setpts=PTS-STARTPTS,fps=25,scale=1280:720,format=yuva420p,fade=t=in:st=0:d=0\.5:alpha=1,setpts=PTS\+0\/TB\[lv\d\]/);
		expect(imaged.notes.some((n) => n.includes('drawtext'))).toBe(false);
		expect(() => toVideoFfmpeg(createVideoProject())).toThrow(/no clips/);
	});

	it('draws a title alone on a transparent frame, for titleImage', async () => {
		const { videoTitleFrame } = await import('../src/video-editor');
		const frame = videoTitleFrame(project(), { id: 't', type: 'text', text: 'Hi', start: 1000, duration: 500, opacity: 0.5, fadeIn: 200, transform: { y: 100, rotation: 10 } });
		expect(frame).toMatchObject({ width: 1280, height: 720, background: 'rgba(0,0,0,0)', audio: [] });
		expect(frame.layers).toEqual([{ clip: 't', track: '', type: 'text', opacity: 1, rect: { x: 0, y: 100, width: 1280, height: 720 }, rotation: 10, text: { text: 'Hi', color: '#ffffff', fontSize: 64, fontFamily: 'sans-serif', fontWeight: 700 } }]);
	});

	it('escapes filter values at both levels', () => {
		expect(ffmpegFilterValue("a:b'c,d")).toBe("a\\\\:b\\\\\\'c\\,d");
	});
});

describe('VideoEditorController', () => {
	it('applies edits as undo steps and reports refusals', () => {
		const c = new VideoEditorController({ project: project(), clock: new ManualClock() });
		const r = c.apply({ op: 'split_clip', clip: 'a', at: 2000 });
		expect(r.ok).toBe(true);
		expect(c.getState().undoLabel).toBe('Edit video');
		expect(c.undo()).toBe(true);
		expect(clip(c.getProject(), 'a').duration).toBe(4000);
		const bad = c.apply({ op: 'move_clip', clip: 'a', start: 3000 });
		expect(bad.ok).toBe(false);
		expect(c.getState().error).toMatch(/would overlap clip "b"/);
		c.setReadOnly(true);
		expect(c.apply({ op: 'add_marker', marker: { time: 0 } })).toEqual({ ok: false, error: 'The video project is read-only.' });
	});

	it('plays on a clock, steps frames and tracks the clips under the playhead', async () => {
		const clock = new ManualClock();
		const c = new VideoEditorController({ project: project(), clock });
		expect(c.getState().duration).toBe(7000);
		c.play();
		await clock.advance(4500);
		await clock.tick(60);
		expect(c.getState().time).toBeGreaterThanOrEqual(4500);
		expect(c.getState().current).toEqual(['b', 's']);
		c.step(-1);
		expect(c.getState().playing).toBe(false);
		c.seek(1000);
		c.step(2);
		expect(c.getState().time).toBe(1080);
	});

	it('selects, splits at the playhead and ripple deletes the selection', () => {
		const c = new VideoEditorController({ project: project(), clock: new ManualClock() });
		c.select(['a', 'nope']);
		expect(c.getState().selection).toEqual(['a']);
		c.select(['b'], { add: true });
		expect(c.getState().selection).toEqual(['a', 'b']);
		c.select(['a']);
		c.seek(1000);
		expect(c.splitAtPlayhead().ok).toBe(true);
		expect(c.getProject().tracks[0].clips.map((x) => x.id)).toEqual(['a', 'a-1', 'b']);
		// The song under it is sync-locked, so the ripple is refused until it is let go.
		expect(c.deleteSelection({ ripple: true }).ok).toBe(false);
		expect(c.apply({ op: 'update_track', track: 'a1', set: { syncLocked: false } }).ok).toBe(true);
		expect(c.deleteSelection({ ripple: true }).ok).toBe(true);
		expect(clip(c.getProject(), 'a-1').start).toBe(0);
		expect(c.getState().selection).toEqual([]);
	});

	it('snaps to clip edges, markers and the playhead, else to frames', () => {
		const c = new VideoEditorController({ project: project(), clock: new ManualClock() });
		expect(c.snap(4100)).toEqual({ time: 4000, snapped: 4000 });
		expect(c.snap(4090, { exclude: ['a', 'b'] })).toEqual({ time: 4080, snapped: null });
		c.seek(2500);
		expect(c.snap(2550).snapped).toBe(2500);
	});

	it('loads a file, clearing history', () => {
		const c = new VideoEditorController({ clock: new ManualClock() });
		c.apply({ op: 'add_marker', marker: { time: 0 } });
		expect(c.load(JSON.stringify(project()), { clearHistory: true }).ok).toBe(true);
		expect(c.getState().canUndo).toBe(false);
		expect(c.load('{}').ok).toBe(false);
	});
});

describe('VideoPreviewEngine', () => {
	const fakeMedia = () => {
		const made: (VideoPreviewMedia & { kind: string })[] = [];
		const createMedia = (kind: 'video' | 'audio') => {
			const m = {
				kind,
				src: '',
				currentTime: 0,
				playbackRate: 1,
				volume: 1,
				muted: false,
				paused: true,
				readyState: 4,
				preload: '',
				play: vi.fn(function (this: any) {
					m.paused = false;
				}),
				pause: vi.fn(() => {
					m.paused = true;
				}),
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				removeAttribute: vi.fn()
			};
			made.push(m);
			return m;
		};
		return { made, createMedia };
	};

	it('keeps an element per playing clip in step with the editor and releases the rest', () => {
		const clock = new ManualClock();
		const c = new VideoEditorController({ project: project(), clock });
		const { made, createMedia } = fakeMedia();
		const frames: number[] = [];
		const canvas = { width: 0, height: 0 };
		const engine = new VideoPreviewEngine(c, canvas, { createMedia, context: null, onFrame: (f) => frames.push(f.time) });
		expect(made.map((m) => [m.kind, m.src, m.currentTime, m.volume])).toEqual([
			['video', 'beach.mp4', 2, 1],
			['audio', 'song.mp3', 0, 0.5]
		]);
		c.seek(5000);
		// "a" ended: its element is released; "b" (no sound) gets a muted one.
		expect(made[0].pause).toHaveBeenCalled();
		expect(made[0].removeAttribute).toHaveBeenCalledWith('src');
		expect(made[2]).toMatchObject({ kind: 'video', src: 'city.mp4', currentTime: 2, muted: true });
		c.play();
		expect(made[2].play).toHaveBeenCalled();
		c.pause();
		expect(made[2].paused).toBe(true);
		engine.destroy();
		expect(made[2].removeAttribute).toHaveBeenCalledWith('src');
	});

	it('sizes the canvas to the frame at the given resolution', () => {
		const c = new VideoEditorController({ project: project(), clock: new ManualClock() });
		const canvas = { width: 0, height: 0 };
		const ctx: any = new Proxy({ measureText: () => ({ width: 0 }) }, { get: (t: any, k) => (k in t ? t[k] : () => {}), set: () => true });
		const engine = new VideoPreviewEngine(c, canvas, { createMedia: fakeMedia().createMedia, context: ctx, resolution: 0.25 });
		expect(canvas).toEqual({ width: 320, height: 180 });
		engine.destroy();
	});
});

describe('edits round-trip through JSON', () => {
	it('parses what it writes', () => {
		const edits: VideoEdit[] = [{ op: 'add_marker', marker: { time: 1500, label: 'beat' } }];
		const p = ok(applyVideoEdits(project(), edits));
		expect(parseVideoProject(JSON.stringify(p))).toEqual(p);
	});
});

describe('timeline helpers', () => {
	it('lays out ruler ticks with labelled majors', async () => {
		const { videoRulerTicks } = await import('../src/video-editor');
		const ticks = videoRulerTicks(3000, 100, 25);
		expect(ticks.filter((t) => t.major).map((t) => t.label)).toEqual(['00:00:00', '00:01:00', '00:02:00', '00:03:00']);
		expect(ticks.find((t) => t.time === 1000)!.x).toBe(100);
		expect(ticks.length).toBeGreaterThan(4);
	});

	it('plans drags: moves snap the nearer edge, trims the dragged edge', async () => {
		const { planVideoClipDrag, videoDropTracks, videoAssetDropEdit, videoClipLabel, videoAssetKindOf } = await import('../src/video-editor');
		const p = project();
		const snap = (t: number) => (Math.abs(t - 7000) < 200 ? 7000 : t);
		expect(planVideoClipDrag(p, { clip: 'b', mode: 'move', delta: 2900, snap })).toEqual({ start: 7000, duration: 3000, track: 'v1', edit: { op: 'move_clip', clip: 'b', start: 7000 } });
		expect(planVideoClipDrag(p, { clip: 'a', mode: 'move', delta: 0 })!.edit).toBeNull();
		expect(planVideoClipDrag(p, { clip: 'a', mode: 'trim-end', delta: -1000, ripple: true })!.edit).toEqual({ op: 'trim_clip', clip: 'a', edge: 'end', to: 3000, ripple: true });
		expect(planVideoClipDrag(p, { clip: 'b', mode: 'trim-start', delta: 500 })).toMatchObject({ start: 4500, duration: 2500, edit: { op: 'trim_clip', edge: 'start', to: 4500 } });
		expect(planVideoClipDrag(p, { clip: 'b', mode: 'trim-start', delta: 99999 })!.duration).toBe(40);
		expect(videoDropTracks(p, 's')).toEqual(['a1']);
		expect(videoAssetDropEdit(p, 'song', { start: 7000 })).toEqual({ op: 'add_clip', track: 'a1', clip: { type: 'media', asset: 'song', start: 7000 } });
		expect(videoClipLabel(ok(applyVideoEdits(p, [{ op: 'delete_clips', clips: ['b'] }, { op: 'update_clip', clip: 'a', set: { speed: 2 } }])).tracks[0].clips[0], p.assets[0])).toBe('beach.mp4 (200%)');
		expect([videoAssetKindOf('clip.MOV'), videoAssetKindOf('audio/mpeg'), videoAssetKindOf('x.txt'), videoAssetKindOf('https://x/song.mp3?x=1#t')]).toEqual(['video', 'audio', null, 'audio']);
	});
});
