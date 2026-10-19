import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import {
	applyVideoEdits,
	checkVideoProject,
	createVideoEditorToolProvider,
	createVideoProject,
	describeVideoProject,
	parseVideoProject,
	planVideoClipDrag,
	sortedVideoClips,
	VIDEO_TIME_EPSILON,
	videoClipEnd,
	VideoEditorController,
	type VideoClip,
	type VideoEdit,
	type VideoProject
} from '../src/video-editor';

/** v1: a (beach 2–6 s) at 0–4 s, b (city 1–4 s) at 4–7 s; a1: song s at 0–7 s. 25 fps (a frame is 40 ms). */
function project(): VideoProject {
	const r = applyVideoEdits(createVideoProject({ fps: 25 }), [
		{ op: 'add_asset', asset: { id: 'beach', kind: 'video', src: 'beach.mp4', duration: 10000 } },
		{ op: 'add_asset', asset: { id: 'city', kind: 'video', src: 'city.mp4', duration: 10000 } },
		{ op: 'add_asset', asset: { id: 'song', kind: 'audio', src: 'song.mp3', duration: 60000 } },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'a', asset: 'beach', in: 2000, duration: 4000 } },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'b', asset: 'city', in: 1000, duration: 3000 } },
		{ op: 'add_clip', track: 'a1', clip: { type: 'media', id: 's', asset: 'song', duration: 7000 } }
	]);
	if (!r.ok) throw new Error(r.error);
	return r.project;
}

const ok = (r: ReturnType<typeof applyVideoEdits>) => {
	if (!r.ok) throw new Error(r.error);
	return r;
};
const run = (p: VideoProject, edits: VideoEdit | VideoEdit[]) => ok(applyVideoEdits(p, edits)).project;
const error = (p: VideoProject, edits: VideoEdit | VideoEdit[]) => {
	const r = applyVideoEdits(p, edits);
	expect(r.ok, 'should be refused').toBe(false);
	return r.ok ? '' : r.error;
};
const clip = (p: VideoProject, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
const lane = (p: VideoProject, track: string) => sortedVideoClips(p.tracks.find((t) => t.id === track)!).map((c) => [c.id, c.start, c.duration]);

describe('slip_clip', () => {
	it('moves the source under a clip that stays put, clamped to its media', () => {
		const r = ok(applyVideoEdits(project(), { op: 'slip_clip', clip: 'a', delta: 1000 }));
		expect(clip(r.project, 'a')).toMatchObject({ start: 0, duration: 4000, in: 3000 });
		expect(r.outcomes[0]).toEqual({ op: 'slip_clip', clip: 'a', track: 'v1', delta: 1000 });
		// beach is 10 s: a plays 2–6 s, so it can slip 4 s later and 2 s earlier.
		expect(ok(applyVideoEdits(project(), { op: 'slip_clip', clip: 'a', delta: 9999 })).outcomes[0].delta).toBe(4000);
		const early = ok(applyVideoEdits(project(), { op: 'slip_clip', clip: 'a', delta: -5000 }));
		expect(early.outcomes[0].delta).toBe(-2000);
		expect(clip(early.project, 'a').in).toBeUndefined();
	});

	it('keeps the handles a transition needs', () => {
		const p = run(project(), { op: 'set_transition', clip: 'b', transition: { type: 'crossfade', duration: 1000 } });
		// b starts 1000 ms into city and the crossfade needs 500 of it.
		expect(ok(applyVideoEdits(p, { op: 'slip_clip', clip: 'b', delta: -1000 })).outcomes[0].delta).toBe(-500);
	});

	it('refuses what cannot slip, saying which way can', () => {
		const p = run(project(), { op: 'slip_clip', clip: 'a', delta: -2000 });
		expect(error(p, { op: 'slip_clip', clip: 'a', delta: -100 })).toMatch(/already starts at the beginning of "beach".*slip it later \(a positive delta\)/);
		const t = run(project(), { op: 'add_clip', track: 'v1', clip: { type: 'text', id: 't', text: 'Hi' } });
		expect(error(t, { op: 'slip_clip', clip: 't', delta: 100 })).toMatch(/"t" is a title, so it has no source to slip/);
		expect(error(project(), { op: 'slip_clip', clip: 'a' } as any)).toMatch(/"delta" must be a number of milliseconds/);
	});
});

describe('roll_edit', () => {
	it('moves a cut, clamped to both clips\' media', () => {
		const r = ok(applyVideoEdits(project(), { op: 'roll_edit', left: 'a', right: 'b', delta: 1000 }));
		expect(lane(r.project, 'v1')).toEqual([['a', 0, 5000], ['b', 5000, 2000]]);
		expect(clip(r.project, 'b').in).toBe(2000);
		expect(r.outcomes[0]).toMatchObject({ delta: 1000, clips: ['a', 'b'] });
		// b has 1000 ms before its in point, so the cut moves at most that much earlier.
		const back = ok(applyVideoEdits(project(), { op: 'roll_edit', left: 'a', right: 'b', delta: -9999 }));
		expect(back.outcomes[0].delta).toBe(-1000);
		expect(lane(back.project, 'v1')).toEqual([['a', 0, 3000], ['b', 3000, 4000]]);
		// b is 3000 ms long, so the cut moves at most 2960 later (a frame of b is left).
		expect(ok(applyVideoEdits(project(), { op: 'roll_edit', left: 'a', right: 'b', delta: 9999 })).outcomes[0].delta).toBe(2960);
	});

	it('needs two clips that meet, in order, on one track', () => {
		expect(error(project(), { op: 'roll_edit', left: 'b', right: 'a', delta: 100 })).toMatch(/"a" comes before "b"; pass left "a" and right "b"/);
		expect(error(project(), { op: 'roll_edit', left: 'a', right: 's', delta: 100 })).toMatch(/on track "v1" and "s" on "a1"/);
		const apart = run(project(), { op: 'move_clip', clip: 'b', start: 5000 });
		expect(error(apart, { op: 'roll_edit', left: 'a', right: 'b', delta: 100 })).toMatch(/a roll needs two clips that meet at a cut/);
		const locked = run(project(), { op: 'update_track', track: 'v1', set: { locked: true } });
		expect(error(locked, { op: 'roll_edit', left: 'a', right: 'b', delta: 100 })).toMatch(/Track "v1" is locked/);
	});
});

describe('slide_clip', () => {
	const three = () => run(project(), { op: 'add_clip', track: 'v1', clip: { type: 'color', id: 'c', color: '#000' } });

	it('moves a clip between its neighbours, keeping the stretch gapless', () => {
		const r = ok(applyVideoEdits(three(), { op: 'slide_clip', clip: 'b', delta: 500 }));
		expect(lane(r.project, 'v1')).toEqual([['a', 0, 4500], ['b', 4500, 3000], ['c', 7500, 2500]]);
		expect(clip(r.project, 'b').in).toBe(1000);
		expect(r.outcomes[0]).toMatchObject({ clips: ['a', 'b', 'c'], delta: 500 });
		const back = run(three(), { op: 'slide_clip', clip: 'b', delta: -1500 });
		expect(lane(back, 'v1')).toEqual([['a', 0, 2500], ['b', 2500, 3000], ['c', 5500, 4500]]);
		// c is 3000 ms long: it keeps a frame.
		expect(ok(applyVideoEdits(three(), { op: 'slide_clip', clip: 'b', delta: 9999 })).outcomes[0].delta).toBe(2960);
	});

	it('moves through a gap where there is no neighbour', () => {
		const r = ok(applyVideoEdits(project(), { op: 'slide_clip', clip: 'a', delta: 1000 }));
		expect(lane(r.project, 'v1')).toEqual([['a', 1000, 4000], ['b', 5000, 2000]]);
		expect(clip(r.project, 'b').in).toBe(2000);
		expect(error(project(), { op: 'slide_clip', clip: 'a', delta: -100 })).toMatch(/"a" cannot slide earlier: it is against the clip before it or the start/);
		expect(error(project(), { op: 'slide_clip', clip: 's', delta: 100 })).toMatch(/no clip right before or after it.*use move_clip/);
	});
});

describe('lift_range, extract_range and split_at', () => {
	it('lifts a range, trimming and cutting what runs across it', () => {
		const r = ok(applyVideoEdits(project(), { op: 'lift_range', from: 1000, to: 5000 }));
		expect(lane(r.project, 'v1')).toEqual([['a', 0, 1000], ['b', 5000, 2000]]);
		expect(clip(r.project, 'b').in).toBe(2000);
		expect(lane(r.project, 'a1')).toEqual([['s', 0, 1000], ['s-1', 5000, 2000]]);
		expect(clip(r.project, 's-1').in).toBe(5000);
		expect(r.outcomes[0]).toEqual({ op: 'lift_range', removed: [], trimmed: ['a', 'b', 's'], created: ['s-1'] });
		const only = run(project(), { op: 'lift_range', from: 0, to: 4000, tracks: ['v1'] });
		expect(lane(only, 'v1')).toEqual([['b', 4000, 3000]]);
		expect(lane(only, 'a1')).toEqual([['s', 0, 7000]]);
	});

	it('extracts a range and closes it on every sync-locked track', () => {
		const r = ok(applyVideoEdits(project(), { op: 'extract_range', from: 1000, to: 5000 }));
		expect(lane(r.project, 'v1')).toEqual([['a', 0, 1000], ['b', 1000, 2000]]);
		expect(lane(r.project, 'a1')).toEqual([['s', 0, 1000], ['s-1', 1000, 2000]]);
		expect(r.outcomes[0].rippled).toEqual(['v1', 'a1']);
		expect(error(project(), { op: 'extract_range', from: 1000, to: 2000, tracks: ['v1'] })).toMatch(/would pull track "a1" out of sync: clip "s"/);
		const free = run(project(), { op: 'update_track', track: 'a1', set: { syncLocked: false } });
		const v = run(free, { op: 'extract_range', from: 1000, to: 2000, tracks: ['v1'] });
		expect(lane(v, 'v1')).toEqual([['a', 0, 1000], ['a-1', 1000, 2000], ['b', 3000, 3000]]);
		expect(clip(v, 'a-1').in).toBe(4000);
		expect(lane(v, 'a1')).toEqual([['s', 0, 7000]]);
	});

	it('refuses bad ranges and locked tracks', () => {
		expect(error(project(), { op: 'lift_range', from: 3000, to: 3000 })).toMatch(/"to" \(3\.00 s\) must be after "from"/);
		expect(error(project(), { op: 'extract_range', from: -10, to: 3000 })).toMatch(/"from" must be a time of at least 0/);
		expect(error(project(), { op: 'lift_range', from: 0, to: 1000, tracks: ['v9'] })).toMatch(/There is no track "v9"/);
		const locked = run(project(), { op: 'update_track', track: 'a1', set: { locked: true } });
		expect(error(locked, { op: 'lift_range', from: 0, to: 1000, tracks: ['a1'] })).toMatch(/Track "a1" is locked/);
		// Left out by default, and a locked track never ripples.
		const r = run(locked, { op: 'extract_range', from: 0, to: 1000 });
		expect(lane(r, 'a1')).toEqual([['s', 0, 7000]]);
		expect(lane(r, 'v1')).toEqual([['a', 0, 3000], ['b', 3000, 3000]]);
	});

	it('cuts across tracks', () => {
		const r = ok(applyVideoEdits(project(), { op: 'split_at', at: 2000 }));
		expect(r.outcomes[0]).toEqual({ op: 'split_at', clips: ['a', 's'], created: ['a-1', 's-1'] });
		expect(lane(r.project, 'v1')).toEqual([['a', 0, 2000], ['a-1', 2000, 2000], ['b', 4000, 3000]]);
		// At a cut only the song runs across.
		expect(ok(applyVideoEdits(project(), { op: 'split_at', at: 4000 })).outcomes[0].clips).toEqual(['s']);
		expect(ok(applyVideoEdits(project(), { op: 'split_at', at: 2000, tracks: ['a1'] })).outcomes[0].clips).toEqual(['s']);
		expect(error(project(), { op: 'split_at', at: 8000 })).toMatch(/No clip runs across 8\.00 s on the unlocked tracks/);
	});
});

describe('placement modes', () => {
	it('overwrites what is underneath', () => {
		const r = ok(applyVideoEdits(project(), { op: 'add_clip', track: 'v1', clip: { type: 'color', color: '#f00', start: 3000, duration: 2000 }, mode: 'overwrite' }));
		expect(lane(r.project, 'v1')).toEqual([['a', 0, 3000], ['c1', 3000, 2000], ['b', 5000, 2000]]);
		expect(r.outcomes[0]).toMatchObject({ trimmed: ['a', 'b'], removed: [], created: [] });
		const inside = ok(applyVideoEdits(project(), { op: 'add_clip', track: 'v1', clip: { type: 'color', color: '#f00', start: 4500, duration: 1000 }, mode: 'overwrite' }));
		expect(lane(inside.project, 'v1')).toEqual([['a', 0, 4000], ['b', 4000, 500], ['c1', 4500, 1000], ['b-1', 5500, 1500]]);
		expect(clip(inside.project, 'b-1').in).toBe(2500);
		const over = ok(applyVideoEdits(project(), { op: 'add_clip', track: 'v1', clip: { type: 'color', color: '#f00', start: 4000, duration: 3000 }, mode: 'overwrite' }));
		expect(over.outcomes[0].removed).toEqual(['b']);
	});

	it('inserts, pushing every sync-locked track along', () => {
		const r = ok(applyVideoEdits(project(), { op: 'move_clip', clip: 'b', start: 2000, mode: 'insert' }));
		expect(lane(r.project, 'v1')).toEqual([['a', 0, 2000], ['b', 2000, 3000], ['a-1', 5000, 2000]]);
		expect(lane(r.project, 'a1')).toEqual([['s', 0, 2000], ['s-1', 5000, 5000]]);
		expect(r.outcomes[0]).toMatchObject({ created: ['a-1', 's-1'], rippled: ['v1', 'a1'] });
		const over = run(project(), { op: 'move_clip', clip: 'b', start: 2000, mode: 'overwrite' });
		expect(lane(over, 'v1')).toEqual([['a', 0, 2000], ['b', 2000, 3000]]);
	});

	it('refuses by default, pointing at the modes', () => {
		expect(error(project(), { op: 'move_clip', clip: 'b', start: 2000 })).toMatch(/would overlap clip "a".*use mode "insert" to push later clips along or "overwrite"/);
		expect(error(project(), { op: 'move_clip', clip: 'b', start: 2000, mode: 'push' as any })).toMatch(/"mode" must be "refuse", "overwrite", "insert"/);
		expect(error(project(), { op: 'add_clip', track: 'v1', clip: { type: 'color', color: '#f00' }, mode: 'overwrite', ripple: true })).toMatch(/"ripple" means mode "insert"/);
	});
});

describe('sync lock', () => {
	/** A titles track over v1 (t1 over a, t2 just after b, t3 later) and the song let go. */
	const titled = () =>
		run(project(), [
			{ op: 'add_track', track: { id: 'titles', kind: 'video' } },
			{ op: 'add_clip', track: 'titles', clip: { type: 'text', id: 't1', text: 'One', start: 0, duration: 4000 } },
			{ op: 'add_clip', track: 'titles', clip: { type: 'text', id: 't2', text: 'Two', start: 7000, duration: 1000 } },
			{ op: 'add_clip', track: 'titles', clip: { type: 'text', id: 't3', text: 'Three', start: 9000, duration: 1000 } },
			{ op: 'update_track', track: 'a1', set: { syncLocked: false } }
		]);

	it('is on by default, parsed, and shown to agents only when off', () => {
		const p = parseVideoProject({ width: 1, height: 1, tracks: [{ id: 'm', kind: 'audio', syncLocked: false }] });
		expect(p.tracks[0].syncLocked).toBe(false);
		expect(() => parseVideoProject({ width: 1, height: 1, tracks: [{ id: 'm', kind: 'audio', syncLocked: 'no' }] })).toThrow('tracks[0].syncLocked must be true or false.');
		expect(describeVideoProject(titled()).tracks.map((t) => (t as { syncLocked?: boolean }).syncLocked)).toEqual([undefined, undefined, false]);
	});

	it('keeps titles in sync with a ripple delete while the music bed stays', () => {
		const r = ok(applyVideoEdits(titled(), { op: 'delete_clips', clips: ['a', 't1'], ripple: true }));
		expect(lane(r.project, 'v1')).toEqual([['b', 0, 3000]]);
		expect(lane(r.project, 'titles')).toEqual([['t2', 3000, 1000], ['t3', 5000, 1000]]);
		expect(lane(r.project, 'a1')).toEqual([['s', 0, 7000]]);
		expect(r.outcomes[0].rippled).toEqual(['titles', 'v1']);
	});

	it('closes merged spans right to left, and refuses a span a sync-locked track still uses', () => {
		const r = run(titled(), { op: 'delete_clips', clips: ['a', 't1', 't2'], ripple: true });
		expect(lane(r, 'v1')).toEqual([['b', 0, 3000]]);
		expect(lane(r, 'titles')).toEqual([['t3', 4000, 1000]]);
		expect(error(titled(), { op: 'delete_clips', clips: ['a', 't2'], ripple: true })).toMatch(/Rippling out 0\.00 s–4\.00 s would pull track "titles" out of sync: clip "t1"/);
	});

	it('ripple trims open time on every sync-locked track', () => {
		const r = ok(applyVideoEdits(project(), { op: 'trim_clip', clip: 'a', edge: 'end', to: 5000, ripple: true }));
		expect(lane(r.project, 'v1')).toEqual([['a', 0, 5000], ['b', 5000, 3000]]);
		expect(lane(r.project, 'a1')).toEqual([['s', 0, 4000], ['s-1', 5000, 3000]]);
		expect(r.outcomes[0]).toMatchObject({ created: ['s-1'], rippled: ['v1', 'a1'] });
	});

	it('leaves a locked track alone', () => {
		const p = run(project(), { op: 'update_track', track: 'a1', set: { locked: true } });
		expect(lane(run(p, { op: 'delete_clips', clips: ['a'], ripple: true }), 'a1')).toEqual([['s', 0, 7000]]);
	});
});

describe('timeline drags place clips by mode', () => {
	it('passes the mode through, and only when it is not the default', () => {
		expect(planVideoClipDrag(project(), { clip: 'b', mode: 'move', delta: -2000, placement: 'insert' })!.edit).toEqual({ op: 'move_clip', clip: 'b', start: 2000, mode: 'insert' });
		expect(planVideoClipDrag(project(), { clip: 'b', mode: 'move', delta: -2000, placement: 'overwrite' })!.edit).toEqual({ op: 'move_clip', clip: 'b', start: 2000, mode: 'overwrite' });
		expect(planVideoClipDrag(project(), { clip: 'b', mode: 'move', delta: 1000, placement: 'refuse' })!.edit).toEqual({ op: 'move_clip', clip: 'b', start: 5000 });
	});
});

// Through the agent tools, as a model would call them.
describe('pro edit tools', () => {
	const tools = () => {
		const controller = new VideoEditorController({ project: project(), clock: new ManualClock() });
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
			return JSON.stringify(r.content);
		};
		return { controller, call, fail };
	};

	it('slips, rolls and slides, returning the delta applied', async () => {
		const { call, fail, controller } = tools();
		const slip = await call('slip_video_clip', { clip: 'a', delta: 9999 });
		expect(slip).toMatchObject({ delta: 4000, clip: { id: 'a', start: 0, source: { in: 6000, out: 10000 } } });
		expect(controller.getState().undoLabel).toBe('Slip clip');
		const roll = await call('roll_video_edit', { left: 'a', right: 'b', delta: -500 });
		expect(roll).toMatchObject({ cut: 3500, delta: -500, left: { id: 'a', end: 3500 }, right: { id: 'b', start: 3500, source: { in: 500 } } });
		const slide = await call('slide_video_clip', { clip: 'b', delta: -1000 });
		expect(slide).toMatchObject({ delta: -1000, clip: { id: 'b', start: 2500 }, before: { id: 'a', end: 2500 } });
		expect(slide.after).toBeUndefined();
		expect(await fail('slip_video_clip', { clip: 'aa', delta: 100 })).toMatch(/There is no clip \\"aa\\"/);
		expect(await fail('slip_video_clip', { clip: 'a' })).toMatch(/delta/);
		expect(await fail('roll_video_edit', { left: 'b', right: 'a', delta: 100 })).toMatch(/pass left/);
		expect(await fail('slide_video_clip', { clip: 's', delta: 100, extra: 1 })).toMatch(/extra/);
	});

	it('lifts, extracts and cuts across tracks, each one undo step', async () => {
		const { call, fail, controller } = tools();
		const before = controller.getProject();
		const ex = await call('extract_video_range', { from: 1000, to: 5000 });
		expect(ex).toMatchObject({ removed: [], trimmed: ['a', 'b', 's'], created: ['s-1'], rippled: ['v1', 'a1'], duration: 3000 });
		expect(await call('undo_video')).toEqual({ undone: true, label: 'Extract' });
		expect(controller.getProject()).toEqual(before);
		const lift = await call('lift_video_range', { from: 0, to: 4000, tracks: ['v1'] });
		expect(lift).toMatchObject({ removed: ['a'], trimmed: [], created: [] });
		expect(lift.rippled).toBeUndefined();
		const cut = await call('split_video_at', { at: 5000 });
		expect(cut.cuts).toMatchObject([{ left: { id: 'b', end: 5000 }, right: { id: 'b-1', start: 5000 } }, { left: { id: 's', end: 5000 }, right: { id: 's-1', start: 5000 } }]);
		expect(await fail('extract_video_range', { from: 3000, to: 1000 })).toMatch(/must be after/);
		expect(await fail('lift_video_range', { from: 0, to: 1000, tracks: [] })).toMatch(/tracks/);
		expect(await fail('split_video_at', { at: 20000 })).toMatch(/No clip runs across/);
		expect(await fail('split_video_at', {})).toMatch(/at/);
	});

	it('places clips by mode and toggles sync lock', async () => {
		const { call, fail } = tools();
		const over = await call('add_video_clip', { track: 'v1', clip: { type: 'color', color: '#f00', start: 3000, duration: 2000 }, mode: 'overwrite' });
		expect(over).toMatchObject({ clip: { id: 'c1', start: 3000, end: 5000 }, trimmed: ['a', 'b'] });
		const ins = await call('move_video_clip', { clip: 'c1', start: 0, mode: 'insert' });
		expect(ins).toMatchObject({ clip: { start: 0 }, rippled: ['v1', 'a1'] });
		expect(await fail('move_video_clip', { clip: 'c1', start: 0, mode: 'push' })).toMatch(/mode/);
		const t = await call('update_video_track', { track: 'a1', set: { syncLocked: false } });
		expect(t.track).toMatchObject({ id: 'a1', syncLocked: false });
		const del = await call('delete_video_clips', { clips: ['c1'], ripple: true });
		expect(del.rippled).toEqual(['v1']);
		expect((await call('get_video_project')).tracks[1].syncLocked).toBe(false);
	});
});

// ---- Properties over random projects and edit sequences ----

const FRAME = 40;
const frames = (max: number) => fc.integer({ min: 0, max }).map((f) => f * FRAME);
const span = fc.record({ gap: frames(50), length: fc.integer({ min: 1, max: 75 }).map((f) => f * FRAME) });

/** A project with two video tracks of colour clips and an audio track of song clips, each gap-separated. */
const projectArb = fc
	.record({
		v1: fc.array(span, { maxLength: 5 }),
		v2: fc.array(span, { maxLength: 4 }),
		a1: fc.array(fc.record({ gap: frames(50), length: fc.integer({ min: 1, max: 75 }).map((f) => f * FRAME), in: frames(100) }), { maxLength: 4 }),
		syncLocked: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean())
	})
	.map(({ v1, v2, a1, syncLocked }): VideoProject => {
		const lay = <T extends { gap: number; length: number }>(spans: T[], make: (s: T, i: number, start: number) => VideoClip) => {
			let at = 0;
			return spans.map((s, i) => {
				const c = make(s, i, at + s.gap);
				at += s.gap + s.length;
				return c;
			});
		};
		return parseVideoProject({
			width: 640,
			height: 360,
			fps: 25,
			assets: [{ id: 'song', kind: 'audio', src: 'song.mp3', duration: 600000 }],
			tracks: [
				{ id: 'v1', kind: 'video', syncLocked: syncLocked[0], clips: lay(v1, (s, i, start) => ({ type: 'color', id: `x${i}`, color: ['#f00', '#0f0', '#00f'][i % 3], start, duration: s.length })) },
				{ id: 'v2', kind: 'video', syncLocked: syncLocked[1], clips: lay(v2, (s, i, start) => ({ type: 'text', id: `y${i}`, text: `T${i}`, start, duration: s.length })) },
				{ id: 'a1', kind: 'audio', syncLocked: syncLocked[2], clips: lay(a1, (s, i, start) => ({ type: 'media', id: `z${i}`, asset: 'song', in: s.in, start, duration: s.length })) }
			]
		});
	});

/** An edit with clip references as indexes into whatever clips exist when it is applied. */
type Pick = (p: VideoProject) => VideoEdit | null;
const nth = (p: VideoProject, i: number) => {
	const all = p.tracks.flatMap((t) => t.clips.map((c) => ({ t, c })));
	return all.length ? all[i % all.length] : null;
};
const tracksArb = fc.option(fc.subarray(['v1', 'v2', 'a1'], { minLength: 1 }), { nil: undefined });
const modeArb = fc.constantFrom('refuse', 'overwrite', 'insert') as fc.Arbitrary<'refuse' | 'overwrite' | 'insert'>;
const editArb: fc.Arbitrary<Pick> = fc.oneof(
	fc.record({ track: fc.constantFrom('v1', 'v2'), start: frames(400), length: fc.integer({ min: 1, max: 60 }).map((f) => f * FRAME), mode: modeArb }).map(
		(a): Pick => () => ({ op: 'add_clip', track: a.track, clip: { type: 'color', color: '#fff', start: a.start, duration: a.length }, mode: a.mode })
	),
	fc.record({ i: fc.nat(), start: frames(400), mode: modeArb }).map((a): Pick => (p) => {
		const at = nth(p, a.i);
		return at && { op: 'move_clip', clip: at.c.id, start: a.start, mode: a.mode };
	}),
	fc.record({ i: fc.nat(), delta: fc.integer({ min: -3000, max: 3000 }) }).map((a): Pick => (p) => {
		const at = nth(p, a.i);
		return at && { op: 'slip_clip', clip: at.c.id, delta: a.delta };
	}),
	fc.record({ i: fc.nat(), delta: fc.integer({ min: -3000, max: 3000 }) }).map((a): Pick => (p) => {
		const at = nth(p, a.i);
		const right = at && at.t.clips.find((c) => Math.abs(c.start - videoClipEnd(at.c)) < VIDEO_TIME_EPSILON);
		return right ? { op: 'roll_edit', left: at!.c.id, right: right.id, delta: a.delta } : null;
	}),
	fc.record({ i: fc.nat(), delta: fc.integer({ min: -3000, max: 3000 }) }).map((a): Pick => (p) => {
		const at = nth(p, a.i);
		return at && { op: 'slide_clip', clip: at.c.id, delta: a.delta };
	}),
	fc.record({ i: fc.nat(), edge: fc.constantFrom('start', 'end') as fc.Arbitrary<'start' | 'end'>, by: fc.integer({ min: -2000, max: 2000 }), ripple: fc.boolean() }).map((a): Pick => (p) => {
		const at = nth(p, a.i);
		return at && { op: 'trim_clip', clip: at.c.id, edge: a.edge, to: Math.max(0, (a.edge === 'start' ? at.c.start : videoClipEnd(at.c)) + a.by), ripple: a.ripple };
	}),
	fc.record({ i: fc.nat(), j: fc.nat(), ripple: fc.boolean() }).map((a): Pick => (p) => {
		const x = nth(p, a.i);
		const y = nth(p, a.j);
		return x && y && { op: 'delete_clips', clips: [x.c.id, y.c.id], ripple: a.ripple };
	}),
	fc.record({ from: frames(400), length: fc.integer({ min: 1, max: 60 }).map((f) => f * FRAME), tracks: tracksArb, extract: fc.boolean() }).map(
		(a): Pick => () => ({ op: a.extract ? 'extract_range' : 'lift_range', from: a.from, to: a.from + a.length, ...(a.tracks ? { tracks: a.tracks } : {}) })
	),
	fc.record({ at: frames(400), tracks: tracksArb }).map((a): Pick => () => ({ op: 'split_at', at: a.at, ...(a.tracks ? { tracks: a.tracks } : {}) }))
);

const overlaps = (p: VideoProject) =>
	p.tracks.flatMap((t) => {
		const clips = sortedVideoClips(t);
		return clips.slice(1).flatMap((c, i) => (c.start < videoClipEnd(clips[i]) - VIDEO_TIME_EPSILON ? [`${t.id}: ${clips[i].id} / ${c.id}`] : []));
	});

/** A track's content with cuts that continue the same material joined up, ids and cut points ignored. */
function material(p: VideoProject) {
	return p.tracks.map((t) => {
		const out: { key: string; start: number; end: number; in: number }[] = [];
		for (const c of sortedVideoClips(t)) {
			const key = c.type === 'media' ? `media:${c.asset}` : c.type === 'text' ? `text:${c.text}` : `color:${c.color}`;
			const source = c.type === 'media' ? (c.in ?? 0) : c.start;
			const last = out[out.length - 1];
			const continues = last && last.key === key && Math.abs(last.end - c.start) < VIDEO_TIME_EPSILON && (c.type !== 'media' || Math.abs(last.in + (last.end - last.start) - source) < VIDEO_TIME_EPSILON);
			if (continues) last.end = videoClipEnd(c);
			else out.push({ key, start: c.start, end: videoClipEnd(c), in: c.type === 'media' ? source : 0 });
		}
		return { track: t.id, material: out };
	});
}

describe('properties', () => {
	it('random edit sequences never overlap clips, never trip the error guard, and fail with "Nothing was changed."', () => {
		const applied = new Map<string, number>();
		fc.assert(
			fc.property(projectArb, fc.array(editArb, { minLength: 1, maxLength: 25 }), (start, picks) => {
				let p = start;
				for (const pick of picks) {
					const edit = pick(p);
					if (!edit) continue;
					const r = applyVideoEdits(p, edit);
					if (!r.ok) {
						// The op itself refused (with a reason); the after-the-fact error check never had to.
						expect(r.error, JSON.stringify(edit)).not.toMatch(/^That would leave an error/);
						expect(r.error).toMatch(/Nothing was changed\.$/);
						continue;
					}
					p = r.project;
					const kind = edit.op + ('mode' in edit && edit.mode ? `:${edit.mode}` : 'ripple' in edit && edit.ripple ? ':ripple' : '');
					applied.set(kind, (applied.get(kind) ?? 0) + 1);
					expect(overlaps(p), JSON.stringify(edit)).toEqual([]);
					expect(checkVideoProject(p).filter((i) => i.severity === 'error')).toEqual([]);
				}
			}),
			{ numRuns: 300 }
		);
		// Every kind of edit actually ran, so the property is not passing on refusals alone.
		const kinds = ['add_clip:refuse', 'add_clip:overwrite', 'add_clip:insert', 'move_clip:refuse', 'move_clip:overwrite', 'move_clip:insert', 'slip_clip', 'roll_edit', 'slide_clip', 'trim_clip', 'trim_clip:ripple', 'delete_clips', 'delete_clips:ripple', 'lift_range', 'extract_range', 'split_at'];
		expect(kinds.filter((k) => !(applied.get(k)! > 10))).toEqual([]);
	});

	it('inserting a clip and extracting the same range restores the project', () => {
		fc.assert(
			fc.property(projectArb, frames(400), fc.integer({ min: 1, max: 60 }).map((f) => f * FRAME), fc.constantFrom('v1', 'v2'), (start, at, length, track) => {
				const p = parseVideoProject({ ...start, tracks: start.tracks.map((t) => ({ ...t, syncLocked: true })) });
				const inserted = applyVideoEdits(p, { op: 'add_clip', track, clip: { type: 'color', id: 'ins', color: '#123456', start: at, duration: length }, mode: 'insert' });
				if (!inserted.ok) throw new Error(inserted.error);
				const back = applyVideoEdits(inserted.project, { op: 'extract_range', from: at, to: at + length });
				if (!back.ok) throw new Error(back.error);
				expect(material(back.project)).toEqual(material(p));
				// When nothing ran across the insert point, nothing was cut, so it comes back exactly.
				const across = p.tracks.some((t) => t.clips.some((c) => c.start < at - VIDEO_TIME_EPSILON && videoClipEnd(c) > at + VIDEO_TIME_EPSILON));
				if (!across) expect(back.project).toEqual(p);
			}),
			{ numRuns: 300 }
		);
	});
});
