import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import { createVideoEditorToolProvider, VideoEditorController } from '../src/video-editor';

const tools = (options: Parameters<typeof createVideoEditorToolProvider>[1] = {}) => {
	const controller = new VideoEditorController({ clock: new ManualClock() });
	const registry = new ToolRegistry();
	registry.register(createVideoEditorToolProvider(controller, options));
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
	return { controller, registry, call, fail };
};

// Tasks an agent would be given, done only through the tools, checked only through the tools.
describe('video agent tasks, through the tools only', () => {
	it('makes a rough cut: media, clips, a title, a transition, music; then checks and exports', async () => {
		const { call } = tools();
		const interview = await call('add_video_asset', { kind: 'video', src: 'interview.mp4', duration: 30000, width: 1920, height: 1080 });
		expect(interview.asset).toBe('interview');
		await call('add_video_asset', { kind: 'video', src: 'broll.mp4', duration: 12000, hasAudio: false });
		await call('add_video_asset', { id: 'music', kind: 'audio', src: 'music.mp3', duration: 90000 });

		const first = await call('add_video_clip', { track: 'v1', clip: { type: 'media', asset: 'interview', in: 5000, duration: 6000 } });
		expect(first.clip).toMatchObject({ id: 'c1', track: 'v1', start: 0, end: 6000, source: { in: 5000, out: 11000 } });
		const second = await call('add_video_clip', { track: 'v1', clip: { type: 'media', asset: 'broll', in: 2000, duration: 4000 } });
		expect(second.clip).toMatchObject({ id: 'c2', start: 6000 });
		const title = await call('add_video_track', { kind: 'video', id: 'titles' });
		expect(title.tracks).toEqual(['titles', 'v1', 'a1']);
		await call('add_video_clip', { track: 'titles', clip: { type: 'text', text: 'Jo Smith, founder', start: 500, duration: 3000, fadeIn: 300, fadeOut: 300 } });
		const t = await call('set_video_transition', { clip: 'c2', transition: { type: 'crossfade', duration: 1000 } });
		expect(t.clip.transition).toEqual({ type: 'crossfade', duration: 1000 });
		const music = await call('add_video_clip', { track: 'a1', clip: { type: 'media', asset: 'music', duration: 10000, volume: 0.3, fadeOut: 2000 } });
		expect(music.duration).toBe(10000);

		const frame = await call('get_video_frame', { time: 6000 });
		expect(frame.layers.map((l: { clip: string }) => l.clip)).toEqual(['c1', 'c2']);
		expect(frame.timecode).toBe('00:00:06:00');
		const check = await call('check_video_project');
		expect(check.errors).toBe(0);
		const svg = await call('render_video_frame', { times: [0, 1000, 6000, 9000] });
		expect(svg.svg.match(/<svg x=/g)).toHaveLength(4);
		const edl = await call('export_video_edl');
		expect(edl.edl).toContain('* FROM CLIP NAME: interview.mp4');
		const ff = await call('export_video_ffmpeg', { output: 'cut.mp4' });
		expect(ff.args.at(-1)).toBe('cut.mp4');
		expect(ff.filterComplex).toContain('drawtext=text=Jo Smith\\, founder');
	});

	it('exports drop-frame EDLs at 29.97 fps unless asked not to', async () => {
		const { call, fail } = tools();
		await call('set_video_settings', { fps: 29.97 });
		await call('add_video_asset', { kind: 'video', src: 'take.mp4', duration: 120000 });
		await call('add_video_clip', { track: 'v1', clip: { type: 'media', asset: 'take', duration: 61000 } });
		const df = await call('export_video_edl');
		expect(df.edl).toContain('FCM: DROP FRAME');
		// 61 s of footage reads as 61 s in drop-frame…
		expect(df.edl).toContain('00:00:00;00 00:01:01;00 01:00:00;00 01:01:01;00');
		const ndf = await call('export_video_edl', { dropFrame: false });
		expect(ndf.edl).toContain('FCM: NON-DROP FRAME');
		// …and as 1828 frames in non-drop, still recorded from 01:00:00:00.
		expect(ndf.edl).toContain('00:00:00:00 00:01:00:28 01:00:00:00 01:01:00:28');
		expect(await fail('export_video_edl', { dropFrame: 'yes' })).toContain('dropFrame');
	});

	it('normalises loudness in two passes through the tools', async () => {
		const { call, fail } = tools();
		await call('add_video_asset', { id: 'vo', kind: 'audio', src: 'vo.wav', duration: 5000 });
		expect(await fail('export_video_loudness_measure')).toContain('no clips');
		await call('add_video_clip', { track: 'a1', clip: { type: 'media', asset: 'vo' } });
		const pass1 = await call('export_video_loudness_measure', { integrated: -16 });
		expect(pass1.args).toContain('null');
		expect(pass1.filterComplex).toContain('print_format=json');
		const pass2 = await call('export_video_ffmpeg', { loudness: { integrated: -16, measured: { integrated: -30, truePeak: -12, range: 3, threshold: -40, offset: 0.2 } } });
		expect(pass2.filterComplex).toContain('measured_I=-30');
		expect(await fail('export_video_ffmpeg', { loudness: { integrated: 0 } })).toContain('integrated');
		expect(await fail('export_video_ffmpeg', { loudness: { measured: { integrated: -30 } } })).toContain('truePeak');
	});

	it('blends a light leak over the footage and takes it back to normal', async () => {
		const { call, fail } = tools();
		await call('add_video_asset', { id: 'leak', kind: 'video', src: 'leak.mp4', duration: 5000, hasAudio: false });
		await call('add_video_track', { kind: 'video', id: 'fx', at: 0 });
		await call('add_video_clip', { track: 'fx', clip: { type: 'media', id: 'l', asset: 'leak', blend: 'screen' } });
		expect((await call('get_video_frame', { time: 100 })).layers[0].blend).toBe('screen');
		const set = await call('update_video_clip', { clip: 'l', set: { blend: 'add' } });
		expect(set.clip.blend).toBe('add');
		expect(await fail('update_video_clip', { clip: 'l', set: { blend: 'dodge' } })).toContain('blend');
		const reset = await call('update_video_clip', { clip: 'l', remove: ['blend'] });
		expect(reset.clip.blend).toBeUndefined();
	});

	it('crossfades sound at equal power unless told otherwise', async () => {
		const { call, fail } = tools();
		await call('add_video_asset', { id: 'm', kind: 'audio', src: 'm.wav', duration: 20000 });
		await call('add_video_clip', { track: 'a1', clip: { type: 'media', id: 'x', asset: 'm', in: 1000, duration: 4000 } });
		await call('add_video_clip', { track: 'a1', clip: { type: 'media', id: 'y', asset: 'm', in: 8000, duration: 4000 } });
		await call('set_video_transition', { clip: 'y', transition: { type: 'crossfade', duration: 1000 } });
		const atCut = await call('get_video_frame', { time: 4000 });
		expect(atCut.audio.map((a: { gain: number }) => a.gain)).toEqual([expect.closeTo(Math.SQRT1_2, 6), expect.closeTo(Math.SQRT1_2, 6)]);
		const set = await call('set_video_transition', { clip: 'y', transition: { type: 'crossfade', duration: 1000, audioCurve: 'linear' } });
		expect(set.clip.transition.audioCurve).toBe('linear');
		expect((await call('get_video_frame', { time: 4000 })).audio[0].gain).toBeCloseTo(0.5, 6);
		expect(await fail('set_video_transition', { clip: 'y', transition: { type: 'crossfade', duration: 1000, audioCurve: 'loud' } })).toContain('audioCurve');
	});

	it('shapes a sound fade and reads the gain back', async () => {
		const { call, fail } = tools();
		await call('add_video_asset', { id: 'music', kind: 'audio', src: 'music.mp3', duration: 30000 });
		await call('add_video_clip', { track: 'a1', clip: { type: 'media', id: 'm', asset: 'music', duration: 10000 } });
		const set = await call('update_video_clip', { clip: 'm', set: { fadeOut: 4000, fadeOutCurve: 'exponential' } });
		expect(set.clip).toMatchObject({ fadeOut: 4000, fadeOutCurve: 'exponential' });
		// Halfway through the fade out: 0.5³.
		const frame = await call('get_video_frame', { time: 8000 });
		expect(frame.audio[0].gain).toBeCloseTo(0.125, 6);
		expect(await fail('update_video_clip', { clip: 'm', set: { fadeOutCurve: 'bendy' } })).toContain('fadeOutCurve');
		await call('add_video_clip', { track: 'v1', clip: { type: 'text', id: 't', text: 'Hi' } });
		expect(await fail('update_video_clip', { clip: 't', set: { fadeInCurve: 'linear' } })).toContain('cannot be set on a text clip');
		const reset = await call('update_video_clip', { clip: 'm', remove: ['fadeOutCurve'] });
		expect(reset.clip.fadeOutCurve).toBeUndefined();
	});

	it('tightens an edit: split, ripple delete, trim, close gaps, undo', async () => {
		const { call, controller } = tools();
		await call('add_video_asset', { kind: 'video', id: 'take', src: 'take.mp4', duration: 20000 });
		await call('add_video_clip', { track: 'v1', clip: { type: 'media', asset: 'take', duration: 10000 } });
		const split = await call('split_video_clip', { clip: 'c1', at: 4000 });
		expect(split.left).toMatchObject({ id: 'c1', duration: 4000 });
		expect(split.right).toMatchObject({ id: 'c1-1', start: 4000, source: { in: 4000, out: 10000 } });
		await call('split_video_clip', { clip: 'c1-1', at: 6000, id: 'umm' });
		const del = await call('delete_video_clips', { clips: ['c1-1'], ripple: true });
		expect(del).toMatchObject({ removed: ['c1-1'], duration: 8000 });
		const trimmed = await call('trim_video_clip', { clip: 'umm', edge: 'end', to: 7000 });
		expect(trimmed.clip).toMatchObject({ start: 4000, end: 7000 });
		await call('move_video_clip', { clip: 'umm', start: 5000 });
		expect((await call('find_video_gaps', { track: 'v1' })).gaps).toEqual([{ track: 'v1', start: 4000, end: 5000 }]);
		expect((await call('close_video_gaps', { track: 'v1' })).moved).toEqual(['umm']);
		expect(await call('undo_video')).toEqual({ undone: true, label: 'Close gaps' });
		expect(controller.getProject().tracks[0].clips[1].start).toBe(5000);
		expect(await call('redo_video')).toEqual({ redone: true, label: 'Close gaps' });
	});

	it('does several edits as one undo step, all or nothing', async () => {
		const { call, fail, controller } = tools();
		const batch = await call('edit_video', {
			ops: [
				{ op: 'add_asset', asset: { id: 'x', kind: 'image', src: 'x.png' } },
				{ op: 'add_clip', track: 'v1', clip: { type: 'media', asset: 'x' } },
				{ op: 'add_marker', marker: { time: 2500, label: 'beat' } }
			]
		});
		expect(batch.outcomes).toEqual([
			{ op: 'add_asset', asset: 'x' },
			{ op: 'add_clip', clip: 'c1', track: 'v1' },
			{ op: 'add_marker', marker: 'm1' }
		]);
		expect(controller.getState().undoLabel).toBe('Edit video');
		const before = controller.getProject();
		const error = await fail('edit_video', { ops: [{ op: 'add_marker', marker: { time: 0 } }, { op: 'trim_clip', clip: 'c9', edge: 'end', to: 100 }] });
		expect(error).toMatch(/op 2 \(trim_clip\): There is no clip \\"c9\\" \(did you mean \\"c1\\"\?\)/);
		expect(controller.getProject()).toBe(before);
		const dry = await call('edit_video', { ops: [{ op: 'delete_clips', clips: ['c1'] }], dry_run: true });
		expect(dry).toMatchObject({ dry_run: true, duration: 0 });
		expect(controller.getProject()).toBe(before);
		expect(await fail('edit_video', { ops: [{ op: 'replace_project', project: {} }] })).toMatch(/Expected one of .*got \\"replace_project\\"/);
	});

	it('fails usefully', async () => {
		const { call, fail } = tools();
		await call('add_video_asset', { kind: 'video', id: 'a', src: 'a.mp4', duration: 5000 });
		await call('add_video_clip', { track: 'v1', clip: { type: 'media', asset: 'a' } });
		expect(await fail('add_video_clip', { track: 'v1', clip: { type: 'media', asset: 'a', start: 1000 } })).toMatch(/would overlap clip \\"c1\\".*next free place is 5\.00 s/);
		expect(await fail('trim_video_clip', { clip: 'c1', edge: 'end', to: 8000 })).toMatch(/can end at most at 5\.00 s/);
		expect(await fail('add_video_clip', { track: 'vv1', clip: { type: 'text', text: 'x' } })).toMatch(/no track \\"vv1\\" \(did you mean \\"v1\\"\?\)/);
		expect(await fail('update_video_clip', { clip: 'c1', set: { text: 'hi' } })).toMatch(/\\"text\\" cannot be set on a media clip/);
		expect(await fail('move_video_clip', { clip: 'c1' })).toMatch(/Give \\"start\\", \\"track\\" or both/);
		expect(await fail('remove_video_asset', { asset: 'a' })).toMatch(/used by clip \\"c1\\"/);
		// Schema checks happen before the handler.
		expect(await fail('add_video_clip', { track: 'v1', clip: { type: 'media', asset: 'a', speed: 'fast' } })).toMatch(/speed/);
		expect(await fail('set_video_settings', {})).toMatch(/at least one setting/);
		expect(await fail('render_video_frame', { format: 'png' })).toMatch(/cannot make PNG/);
	});

	it('seeks the person\'s playhead to a clip or marker', async () => {
		const { call } = tools();
		await call('add_video_clip', { track: 'v1', clip: { type: 'color', color: '#123456', duration: 2000 } });
		await call('add_video_clip', { track: 'v1', clip: { type: 'text', text: 'end card' } });
		await call('add_video_marker', { time: 1500, label: 'hit' });
		expect(await call('seek_video', { clip: 'c2' })).toMatchObject({ time: 2000, clips: ['c2'], playing: false });
		expect(await call('seek_video', { marker: 'm1' })).toMatchObject({ time: 1500, timecode: '00:00:01:15', clips: ['c1'] });
		expect((await call('remove_video_marker', { marker: 'm1' })).markers).toEqual([]);
	});

	it('hides write tools while read-only and says why', async () => {
		const { registry, call, controller } = tools();
		const all = registry.listTools().tools.length;
		controller.setReadOnly(true);
		const names = registry.listTools().tools.map((t) => t.name);
		expect(names.length).toBeLessThan(all);
		expect(names).toContain('get_video_project');
		expect(names).not.toContain('add_video_clip');
		expect(await call('get_video_project')).toMatchObject({ editable: false, readOnlyReason: 'The video project is read-only.' });
	});

	it('returns a PNG when the host can rasterize', async () => {
		const { registry } = tools({ rasterize: (_svg, size) => ({ data: `${size.width}x${size.height}`, mimeType: 'image/png' }) });
		const r = await registry.callTool('render_video_frame', { format: 'png' });
		expect(r.content).toEqual([{ type: 'image', data: '1920x1080', mimeType: 'image/png' }]);
	});
});
