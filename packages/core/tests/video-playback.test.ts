import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { PresenceStore, ToolRegistry, createAgentPlayback, createInstantPresenceClock, type PlaybackRef } from '../src/tools';
import { VideoEditorController, createVideoEditorToolProvider, parseVideoTimeRef, planVideoToolPlayback, videoTimeRef } from '../src/video-editor';

async function setup() {
	const controller = new VideoEditorController({ clock: new ManualClock() });
	const registry = new ToolRegistry();
	registry.register(createVideoEditorToolProvider(controller));
	const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
	playback.install(registry);
	// 1 px per 10 ms; track v1 is the row at y 0–40, a1 at 40–80; the ruler is above at y -20.
	const rows: Record<string, number> = { v1: 0, a1: 40 };
	const clipRow: Record<string, string> = {};
	const locate = (ref: PlaybackRef) => {
		if (ref.kind === 'clip') return clipRow[ref.id] ? { x: 0, y: rows[clipRow[ref.id]!]!, width: 100, height: 40 } : null;
		if (ref.kind === 'track') return rows[ref.id] !== undefined ? { x: 0, y: rows[ref.id]!, width: 1000, height: 40 } : null;
		const t = parseVideoTimeRef(ref);
		if (!t) return null;
		const y = t.track ? rows[t.track]! : t.clip ? rows[clipRow[t.clip]!]! : -20;
		return { x: t.time / 10 - 2, y, width: 4, height: t.track || t.clip ? 40 : 20 };
	};
	const presence = new PresenceStore();
	playback.attach('video', { presence, locate, defaultKind: 'clip', bounds: () => ({ x: 0, y: -20, width: 1000, height: 100 }) });
	const call = (name: string, args: Record<string, unknown>) => registry.callTool(name, args);
	await call('video__add_video_asset', { kind: 'video', src: 'a.mp4', duration: 30000, width: 1920, height: 1080 });
	const added = await call('video__add_video_clip', { track: 'v1', clip: { type: 'media', asset: 'a', duration: 6000 } });
	const clipId = (added.structuredContent as { clip: { id: string } }).clip.id;
	clipRow[clipId] = 'v1';
	return { controller, playback, presence, call, clipId };
}

describe('video time refs', () => {
	it('round-trips a time on a track or a clip row', () => {
		expect(parseVideoTimeRef(videoTimeRef({ time: 1200.4, track: 'v1' }))).toEqual({ time: 1200, track: 'v1' });
		expect(parseVideoTimeRef(videoTimeRef({ time: 50, clip: 'c1' }))).toEqual({ time: 50, clip: 'c1' });
		expect(parseVideoTimeRef({ kind: 'clip', id: 'c1' })).toBeNull();
	});
});

describe('planVideoToolPlayback', () => {
	it('drags a moved clip to its new start, on its own row or another track', () => {
		expect(planVideoToolPlayback('move_video_clip', { clip: 'c1', start: 4000 })).toEqual([
			{ type: 'target', ref: { kind: 'clip', id: 'c1' } },
			{ type: 'press' },
			{ type: 'target', ref: { kind: 'time', id: 't=4000;clip=c1' } },
			{ type: 'release' }
		]);
		expect(planVideoToolPlayback('move_video_clip', { clip: 'c1', track: 'v2' })![2]).toEqual({ type: 'target', ref: { kind: 'time', id: 't=0;track=v2' } });
		expect(planVideoToolPlayback('trim_video_clip', { clip: 'c1', edge: 'end', to: 9000 })![2]).toEqual({ type: 'target', ref: { kind: 'time', id: 't=9000;clip=c1' } });
	});

	it('clicks where a clip goes in, a split lands, or a seek moves the playhead', () => {
		expect(planVideoToolPlayback('add_video_clip', { track: 'v1', clip: { type: 'title', start: 2000 } })![0]).toEqual({ type: 'target', ref: { kind: 'time', id: 't=2000;track=v1' } });
		expect(planVideoToolPlayback('add_video_clip', { track: 'v1', clip: { type: 'title' } })![0]).toEqual({ type: 'target', ref: { kind: 'track', id: 'v1' } });
		expect(planVideoToolPlayback('split_video_at', { at: 3000 })![0]).toEqual({ type: 'target', ref: { kind: 'time', id: 't=3000' } });
		expect(planVideoToolPlayback('split_video_clip', { clip: 'c1', at: 3000 })![0]).toEqual({ type: 'target', ref: { kind: 'time', id: 't=3000;clip=c1' } });
		expect(planVideoToolPlayback('delete_video_clips', { clips: ['c1', 'c2'] })!.filter((s) => s.type === 'target')).toHaveLength(2);
		expect(planVideoToolPlayback('get_video_project', {})).toBeNull();
	});
});

describe('video tools through playback', () => {
	it('every write tool plans its steps, and the provider plays on the video surface', () => {
		const provider = createVideoEditorToolProvider(new VideoEditorController({ clock: new ManualClock() }));
		expect(provider.playbackSurface).toBe('video');
		const tools = typeof provider.tools === 'function' ? provider.tools() : provider.tools;
		expect(tools.filter((t) => !t.annotations?.readOnlyHint && typeof t.plan !== 'function').map((t) => t.name)).toEqual([]);
	});

	it('drags a clip to its new start and moves it', async () => {
		const { call, playback, presence, controller, clipId } = await setup();
		const steps = playback.record();
		const res = await call('video__move_video_clip', { clip: clipId, start: 4000 });
		expect(res.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'target', 'release', 'commit']);
		expect(presence.get('agent')).toMatchObject({ x: 400, y: 20 });
		const clip = controller.getProject().tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
		expect(clip.start).toBe(4000);
	});

	it('returns errors unchanged', async () => {
		const { call } = await setup();
		const res = await call('video__move_video_clip', { clip: 'ghost', start: 10 });
		expect(res.isError).toBe(true);
		expect((res.content[0] as { text: string }).text).toMatch(/ghost/);
	});
});
