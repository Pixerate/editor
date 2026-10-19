import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
	applyVideoEdits,
	checkVideoProject,
	createVideoEditorToolProvider,
	drawVideoFrame,
	findVideoSequenceCycle,
	parseVideoProject,
	toVideoEdl,
	toVideoFfmpeg,
	videoClipLabel,
	videoFrameAt,
	videoFrameLeafLayers,
	videoFrameRequestsAt,
	videoFrameToSvg,
	VideoEditorController,
	VideoPreviewEngine,
	videoSequenceDuration,
	type VideoProject
} from '../src/video-editor';

/** A 400 × 200 project whose track v1 plays 2 s of sequence "inner" from 1 s, starting at 0.5 s. */
const raw = () => ({
	version: 1,
	width: 400,
	height: 200,
	fps: 25,
	assets: [
		{ id: 'clip', kind: 'video', src: 'clip.mp4', duration: 10000, width: 400, height: 200, hasAudio: false },
		{ id: 'song', kind: 'audio', src: 'song.mp3', duration: 10000 }
	],
	sequences: [
		{
			id: 'inner',
			name: 'Inner',
			tracks: [
				{ id: 'iv', kind: 'video', clips: [{ id: 'shot', type: 'media', asset: 'clip', start: 0, duration: 4000, opacity: 0.5, in: 200 }] },
				{ id: 'ia', kind: 'audio', clips: [{ id: 'music', type: 'media', asset: 'song', start: 0, duration: 4000, volume: 0.8 }] }
			]
		}
	],
	tracks: [
		{ id: 'v1', kind: 'video', clips: [{ id: 'comp', type: 'sequence', sequence: 'inner', in: 1000, start: 500, duration: 2000, opacity: 0.6, volume: 0.5, blend: 'screen', grade: { exposure: 0.5 } }] },
		{ id: 'a1', kind: 'audio', clips: [] as any[] }
	]
});
const project = (change: (p: any) => void = () => {}): VideoProject => {
	const p = raw();
	change(p);
	return parseVideoProject(p);
};
const codes = (p: VideoProject) => checkVideoProject(p).map((i) => i.code);

describe('nested sequences: model', () => {
	it('parses sequences and compound clips', () => {
		const p = project();
		expect(p.sequences![0]).toMatchObject({ id: 'inner', name: 'Inner', tracks: [{ id: 'iv' }, { id: 'ia' }] });
		expect(p.tracks[0].clips[0]).toMatchObject({ type: 'sequence', sequence: 'inner', in: 1000, volume: 0.5 });
		expect(videoSequenceDuration(p.sequences![0])).toBe(4000);
		expect(checkVideoProject(p).filter((i) => i.severity === 'error')).toEqual([]);
	});

	it('refuses speed and ramps on compound clips, with what to do instead', () => {
		expect(() => project((p) => (p.tracks[0].clips[0].speed = 2))).toThrow(/tracks\[0\]\.clips\[0\]\.speed is not supported on a compound clip.*normal speed.*inside the sequence/);
		expect(() => project((p) => (p.tracks[0].clips[0].timeRemap = { keys: [{ t: 0, v: 0 }] }))).toThrow(/timeRemap is not supported on a compound clip/);
		expect(project((p) => (p.tracks[0].clips[0].speed = 1)).tracks[0].clips[0]).not.toHaveProperty('speed');
	});

	it('keeps clip ids unique across the project and its sequences', () => {
		expect(() => project((p) => (p.tracks[0].clips[0].id = 'shot'))).toThrow('Two clips share the id "shot"');
		expect(() => project((p) => p.sequences.push({ id: 'inner', tracks: [] }))).toThrow('Two sequences share the id "inner"');
		expect(() => project((p) => p.sequences[0].tracks.push({ id: 'iv', kind: 'video', clips: [] }))).toThrow('Two tracks in sequence "inner" share the id "iv"');
		expect(() => project((p) => (p.sequences = {}))).toThrow('sequences must be an array.');
	});

	it('reports a missing sequence, a cycle, a compound past the sequence\'s end, and issues inside sequences', () => {
		expect(codes(project((p) => (p.tracks[0].clips[0].sequence = 'nope')))).toContain('missing-sequence');
		const overrun = checkVideoProject(project((p) => (p.tracks[0].clips[0].duration = 3500)));
		expect(overrun.find((i) => i.code === 'source-overrun')).toMatchObject({ severity: 'error', clip: 'comp', message: expect.stringContaining('only 4.00 s long') });
		const loop = project((p) => {
			p.sequences.push({ id: 'b', tracks: [{ id: 'bv', kind: 'video', clips: [{ id: 'back', type: 'sequence', sequence: 'inner', start: 0, duration: 1000 }] }] });
			p.sequences[0].tracks[0].clips.push({ id: 'into-b', type: 'sequence', sequence: 'b', start: 4000, duration: 1000 });
		});
		expect(findVideoSequenceCycle(loop, 'inner')).toEqual(['inner', 'b', 'inner']);
		expect(findVideoSequenceCycle(project(), 'inner')).toBeNull();
		const cycle = checkVideoProject(loop).filter((i) => i.code === 'sequence-cycle');
		expect(cycle.map((i) => i.clip).sort()).toEqual(['back', 'comp', 'into-b']);
		expect(cycle[0].message).toMatch(/contains itself \(.* → .* → .*\)/);
		// Overlaps inside a sequence name it.
		const inside = checkVideoProject(project((p) => p.sequences[0].tracks[0].clips.push({ id: 'over', type: 'color', color: '#fff', start: 100, duration: 100 })));
		expect(inside.find((i) => i.code === 'overlap')).toMatchObject({ sequence: 'inner', track: 'iv', message: expect.stringContaining('track "iv" in sequence "inner"') });
		expect(codes(project((p) => (p.tracks[0].clips = [])))).toContain('unused-sequence');
		// Assets used only inside sequences are used.
		expect(codes(project())).not.toContain('unused-asset');
	});

	it('needs sequence time either side of a cut for a transition into a compound', () => {
		const p = project((p) => p.tracks[0].clips.unshift({ id: 'k', type: 'color', color: '#000', start: 0, duration: 500 }));
		const ok = { ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === 'comp' ? { ...c, transition: { type: 'crossfade' as const, duration: 400 } } : c)) })) };
		expect(codes(ok)).not.toContain('transition-handles');
		const tight = { ...ok, tracks: ok.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === 'comp' ? { ...c, in: 100 } : c)) })) };
		expect(checkVideoProject(tight).find((i) => i.code === 'transition-handles')?.message).toMatch(/"comp" 100 ms before its in point/);
	});
});

describe('nested sequences: evaluation', () => {
	it('makes a compound one layer holding its sequence\'s frame, with its own opacity, blend and grade', () => {
		const frame = videoFrameAt(project(), 1500);
		expect(frame.layers).toHaveLength(1);
		const [group] = frame.layers;
		expect(group).toMatchObject({ clip: 'comp', type: 'sequence', sequence: 'inner', sourceTime: 2000, opacity: 0.6, blend: 'screen', grade: { exposure: 0.5 }, rect: { x: 0, y: 0, width: 400, height: 200 } });
		// The inner clip keeps its own opacity: the compound's applies to the group, once.
		expect(group.layers).toEqual([expect.objectContaining({ clip: 'comp/shot', track: 'iv', asset: 'clip', sourceTime: 2200, opacity: 0.5 })]);
		expect(videoFrameLeafLayers(frame.layers).map((l) => l.clip)).toEqual(['comp/shot']);
	});

	it('mixes the sequence\'s sound in, through the compound\'s volume, fades and track', () => {
		const p = project((p) => (p.tracks[0].clips[0].fadeIn = 1000));
		expect(videoFrameAt(p, 1500).audio).toEqual([expect.objectContaining({ clip: 'comp/music', track: 'ia', asset: 'song', sourceTime: 2000, gain: 0.8 * 0.5 * 1, speed: 1 })]);
		expect(videoFrameAt(p, 1000).audio[0].gain).toBeCloseTo(0.8 * 0.5 * 0.5);
		expect(videoFrameAt(project((p) => (p.tracks[0].clips[0].muted = true)), 1500).audio).toEqual([]);
		expect(videoFrameAt(project((p) => (p.tracks[0].muted = true)), 1500).audio).toEqual([]);
		// Hidden: the sound plays on, the picture does not.
		const hidden = videoFrameAt(project((p) => (p.tracks[0].hidden = true)), 1500);
		expect([hidden.layers.length, hidden.audio.length]).toEqual([0, 1]);
	});

	it('plays only sound on an audio track, and the same sequence twice as distinct layers', () => {
		const sound = project((p) => {
			const comp = p.tracks[0].clips.pop();
			p.tracks[1].clips.push(comp);
		});
		expect(codes(sound)).not.toContain('wrong-track');
		expect(videoFrameAt(sound, 1500)).toMatchObject({ layers: [], audio: [{ clip: 'comp/music' }] });
		const twice = project((p) => {
			p.tracks.unshift({ id: 'v0', kind: 'video', clips: [{ id: 'comp2', type: 'sequence', sequence: 'inner', start: 0, duration: 3000 }] });
		});
		const frame = videoFrameAt(twice, 1500);
		expect(frame.layers.map((l) => [l.clip, l.sourceTime])).toEqual([
			['comp', 2000],
			['comp2', 1500]
		]);
		expect(frame.audio.map((a) => a.clip)).toEqual(['comp/music', 'comp2/music']);
	});

	it('nests compounds inside compounds, and skips one that would loop', () => {
		const deep = project((p) => {
			p.sequences.push({ id: 'outer', tracks: [{ id: 'ov', kind: 'video', clips: [{ id: 'mid', type: 'sequence', sequence: 'inner', start: 0, duration: 4000 }] }] });
			p.tracks[0].clips[0].sequence = 'outer';
		});
		const group = videoFrameAt(deep, 1500).layers[0];
		expect(group.layers![0]).toMatchObject({ clip: 'comp/mid', sequence: 'inner', sourceTime: 2000 });
		expect(group.layers![0].layers![0]).toMatchObject({ clip: 'comp/mid/shot', sourceTime: 2200 });
		const loop = project((p) => p.sequences[0].tracks[0].clips.push({ id: 'self', type: 'sequence', sequence: 'inner', start: 4000, duration: 1000 }));
		expect(() => videoFrameAt({ ...loop, tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'c', type: 'sequence', sequence: 'inner', start: 0, duration: 5000, in: 0 }] }] }, 4500)).not.toThrow();
	});

	it('applies the compound\'s transform, fades and transitions to the group', () => {
		const p = project((p) => {
			Object.assign(p.tracks[0].clips[0], { transform: { scale: 0.5, x: 50 }, fadeOut: 1000 });
		});
		const group = videoFrameAt(p, 2000).layers[0];
		expect(group.rect).toEqual({ x: 150, y: 50, width: 200, height: 100 });
		expect(group.opacity).toBeCloseTo(0.6 * 0.5);
		expect(group.layers![0].opacity).toBe(0.5);
		const wiped = project((p) => {
			p.tracks[0].clips.unshift({ id: 'k', type: 'color', color: '#000000', start: 0, duration: 500 });
			p.tracks[0].clips[1].transition = { type: 'wipe', duration: 400 };
		});
		expect(videoFrameAt(wiped, 500).layers.find((l) => l.clip === 'comp')).toMatchObject({ wipe: { direction: 'right', progress: 0.5 }, sourceTime: 1000 });
	});
});

describe('nested sequences: drawing', () => {
	it('renders a compound in SVG as an isolated group with its filter, scaled into its rect', () => {
		const p = project((p) => (p.tracks[0].clips[0].transform = { scale: 0.5 }));
		const svg = videoFrameToSvg(videoFrameAt(p, 1500), { imageFor: () => 'frame.png' });
		expect(svg).toContain('<g opacity="0.6" style="mix-blend-mode:screen;isolation:isolate" filter="url(#g0)">');
		expect(svg).toContain('<g transform="translate(100 50) scale(0.5 0.5)"><g opacity="0.5"><image href="frame.png" x="0" y="0" width="400" height="200"');
		expect(svg).toContain('<filter id="g0"');
	});

	/** A recording 2D context. */
	const recorder = (name: string) => {
		const calls: { ctx: string; op: string; args: unknown[]; alpha?: number }[] = [];
		const state: any = { globalAlpha: 1, measureText: () => ({ width: 0 }), getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) };
		const ctx = new Proxy(state, {
			get: (t, k: string) => (k in t ? t[k] : (...args: unknown[]) => calls.push({ ctx: name, op: k, args, alpha: t.globalAlpha })),
			set: (t, k, v) => ((t[k] = v), true)
		});
		return { ctx, calls };
	};

	it('draws a compound\'s layers on a scratch canvas, then lays that on as one picture', () => {
		const frame = videoFrameAt(project(), 1500);
		const main = recorder('main');
		const group = recorder('group');
		const canvas = { id: 'group' } as unknown as CanvasImageSource;
		const video = { id: 'video' } as unknown as CanvasImageSource;
		const slots: number[] = [];
		drawVideoFrame(main.ctx, frame, () => video, 0.5, { scratch: (w, h, slot) => (slots.push(slot), { canvas, ctx: group.ctx }) });
		expect(slots).toEqual([0]);
		// The inner shot goes on the group canvas at its own opacity…
		expect(group.calls.find((c) => c.op === 'drawImage')).toMatchObject({ args: [video, 0, 0, 400, 200], alpha: 0.5 });
		expect(group.calls[0]).toMatchObject({ op: 'save' });
		expect(group.calls.some((c) => c.op === 'clearRect')).toBe(true);
		// …and the group onto the frame at the compound's opacity, with its blend.
		expect(main.calls.find((c) => c.op === 'drawImage')).toMatchObject({ args: [canvas, 0, 0, 400, 200], alpha: 0.6 });
		expect(main.ctx.globalCompositeOperation).toBe('screen');
	});

	it('gives a compound inside a compound its own scratch slot, and draws straight on without one', () => {
		const deep = project((p) => {
			p.sequences.push({ id: 'outer', tracks: [{ id: 'ov', kind: 'video', clips: [{ id: 'mid', type: 'sequence', sequence: 'inner', start: 0, duration: 4000, opacity: 0.9 }] }] });
			p.tracks[0].clips[0].sequence = 'outer';
		});
		const slots: number[] = [];
		const main = recorder('main');
		drawVideoFrame(main.ctx, videoFrameAt(deep, 1500), () => null, 1, { scratch: (_w, _h, slot) => (slots.push(slot), { canvas: { slot } as any, ctx: recorder(`s${slot}`).ctx }) });
		expect(slots).toEqual([0, 2]);
		const flat = recorder('flat');
		drawVideoFrame(flat.ctx, videoFrameAt(project(), 1500), () => null, 1, {});
		// Without scratch canvases the inner shot's placeholder is drawn on the frame itself.
		expect(flat.calls.filter((c) => c.op === 'strokeRect')).toHaveLength(1);
	});

	it('plays media inside compounds in the preview, one element per path', () => {
		const p = project((p) => p.tracks.unshift({ id: 'v0', kind: 'video', clips: [{ id: 'comp2', type: 'sequence', sequence: 'inner', start: 0, duration: 3000, opacity: 0.5 }] }));
		const c = new VideoEditorController({ project: p });
		const made: any[] = [];
		const createMedia = (kind: string) => {
			const m: any = { kind, currentTime: 0, playbackRate: 1, volume: 1, muted: false, paused: true, readyState: 0, preload: '', play() {}, pause() {}, addEventListener() {}, removeEventListener() {} };
			made.push(m);
			return m;
		};
		const engine = new VideoPreviewEngine(c, { width: 0, height: 0 }, { context: null, resolution: 1, createMedia, createScratch: () => null });
		c.seek(1500);
		const sorted = (list: number[]) => [...list].sort((a, b) => a - b);
		expect(made.filter((m) => m.kind === 'video').every((m) => m.src === 'clip.mp4')).toBe(true);
		expect(sorted(made.filter((m) => m.kind === 'video').map((m) => m.currentTime))).toEqual([1.7, 2.2]);
		// The sound of each compound's music plays through its own audio element at the compound's gain.
		expect(sorted(made.filter((m) => m.kind === 'audio').map((m) => m.volume))).toEqual([0.4, 0.8]);
		engine.destroy();
		expect(videoFrameRequestsAt(p, 1500).map((r) => r.sourceTime)).toEqual([2220, 1700]);
	});

	it('labels compound clips with their sequence', () => {
		const p = project();
		expect(videoClipLabel(p.tracks[0].clips[0], undefined, p.sequences![0])).toBe('Compound: Inner');
	});
});

describe('nested sequences: edits on compound clips', () => {
	const edit = (p: VideoProject, e: any) => applyVideoEdits(p, [e]);
	it('trims and splits a compound through its sequence time, never past its end', () => {
		const head = edit(project(), { op: 'trim_clip', clip: 'comp', edge: 'start', to: 700 });
		expect(head.ok && head.project.tracks[0].clips[0]).toMatchObject({ start: 700, duration: 1800, in: 1200 });
		const tail = edit(project(), { op: 'trim_clip', clip: 'comp', edge: 'end', to: 4000 });
		expect(tail).toMatchObject({ ok: false, error: expect.stringContaining('can end at most at 3.50 s, where sequence "inner" ends') });
		const split = edit(project(), { op: 'split_clip', clip: 'comp', at: 1500, id: 'right' });
		expect(split.ok && split.project.tracks[0].clips.find((c) => c.id === 'right')).toMatchObject({ type: 'sequence', start: 1500, duration: 1000, in: 2000 });
		const slip = edit(project(), { op: 'slip_clip', clip: 'comp', delta: 5000 });
		expect(slip.ok && slip.outcomes[0].delta).toBe(1000);
	});

	it('refuses speed on compounds and edits inside sequences with what to do instead', () => {
		expect(edit(project(), { op: 'update_clip', clip: 'comp', set: { speed: 2 } })).toMatchObject({ ok: false, error: expect.stringContaining('not supported on a compound clip') });
		expect(edit(project(), { op: 'set_time_remap', clip: 'comp', keys: [{ t: 0, v: 0 }] })).toMatchObject({ ok: false, error: expect.stringContaining('compound clip, which plays its sequence at normal speed') });
		expect(edit(project(), { op: 'trim_clip', clip: 'shot', edge: 'end', to: 100 })).toMatchObject({ ok: false, error: expect.stringContaining('Clip "shot" is inside sequence "inner"') });
	});

	it('adds a compound for the rest of its sequence, and refuses an unknown sequence', () => {
		const added = edit(project(), { op: 'add_clip', track: 'v1', clip: { type: 'sequence', id: 'again', sequence: 'inner', in: 500, start: 3000 } });
		expect(added.ok && added.project.tracks[0].clips.find((c) => c.id === 'again')).toMatchObject({ duration: 3500 });
		expect(edit(project(), { op: 'add_clip', track: 'v1', clip: { type: 'sequence', sequence: 'innr' } })).toMatchObject({ ok: false, error: expect.stringContaining('There is no sequence "innr" (did you mean "inner"?)') });
		// A fresh id never collides with a clip inside a sequence.
		const fresh = edit(project((p) => (p.sequences[0].tracks[0].clips[0].id = 'c1')), { op: 'add_clip', track: 'v1', clip: { type: 'color', color: '#fff', start: 3000 } });
		expect(fresh.ok && fresh.outcomes[0].clip).not.toBe('c1');
	});
});

describe('nested sequences: export', () => {
	it('builds each compound as a sub-graph on a transparent frame, cut to what it plays', () => {
		const { filterComplex, notes } = toVideoFfmpeg(project());
		expect(filterComplex).toContain('color=c=black@0:s=400x200:r=25:d=4,format=yuva420p[nb0]');
		expect(filterComplex).toContain('trim=start=1:duration=2,setpts=PTS-STARTPTS[sq0]');
		expect(filterComplex).toMatch(/\[a0\]amix=inputs=1:normalize=0:duration=longest,apad,atrim=start=1:end=3\[sm0\]/);
		expect(filterComplex).toMatch(/\[sm0\]asetpts=PTS-STARTPTS,volume=0\.5,adelay=500:all=1\[a1\]/);
		expect(notes.join(' ')).not.toMatch(/left out/);
		const loop = toVideoFfmpeg(project((p) => p.sequences[0].tracks[0].clips.push({ id: 'self', type: 'sequence', sequence: 'inner', start: 4000, duration: 1000 })));
		expect(loop.notes).toContain('Compound clip "self" was left out: its sequence "inner" contains itself.');
	});

	it('leaves a muted compound\'s sound out and a compound on an audio track\'s picture out', () => {
		expect(toVideoFfmpeg(project((p) => (p.tracks[0].clips[0].muted = true))).filterComplex).not.toContain('amix');
		const sound = toVideoFfmpeg(project((p) => p.tracks[1].clips.push(p.tracks[0].clips.pop()))).filterComplex;
		expect(sound).not.toContain('[nb0]');
		expect(sound).toContain('[sm0]');
	});

	it('marks compound clips in an EDL', () => {
		expect(toVideoEdl(project(), { track: 'v1' })).toContain('* COMPOUND CLIP: inner (sequence inner from 00:00:01:00, not flattened)');
	});
});

describe('nested sequences: agent tools', () => {
	const registry = (p: VideoProject) => {
		const r = new ToolRegistry();
		r.register(createVideoEditorToolProvider(new VideoEditorController({ project: p })));
		return r;
	};

	it('list_video_sequences returns each sequence with its users and clips', async () => {
		const r = await registry(project()).callTool('list_video_sequences', {});
		expect(r.isError).toBeFalsy();
		const [seq] = (r.structuredContent as any).sequences;
		expect(seq).toMatchObject({ id: 'inner', name: 'Inner', duration: 4000, clipCount: 2, nests: [], usedBy: [{ clip: 'comp', track: 'v1', start: 500, end: 2500, source: { in: 1000, out: 3000 } }] });
		expect(seq.tracks[0].clips[0]).toMatchObject({ id: 'shot', end: 4000, source: { in: 200, out: 4200 } });
		const one = await registry(project()).callTool('list_video_sequences', { sequence: 'inner' });
		expect((one.structuredContent as any).sequences).toHaveLength(1);
	});

	it('list_video_sequences fails usefully', async () => {
		const unknown = await registry(project()).callTool('list_video_sequences', { sequence: 'nope' });
		expect(unknown.isError).toBe(true);
		expect(JSON.stringify(unknown.content)).toContain('There is no sequence \\"nope\\"; the sequences are \\"inner\\"');
		const bad = await registry(project()).callTool('list_video_sequences', { sequence: 3 });
		expect(bad.isError).toBe(true);
		const extra = await registry(project()).callTool('list_video_sequences', { foo: 1 });
		expect(extra.isError).toBe(true);
	});

	it('get_video_project summarises sequences and gives compound clips their source', async () => {
		const r = await registry(project()).callTool('get_video_project', {});
		const out = r.structuredContent as any;
		expect(out.sequences).toEqual([expect.objectContaining({ id: 'inner', duration: 4000, trackCount: 2, usedBy: [expect.objectContaining({ clip: 'comp' })] })]);
		expect(out.sequences[0]).not.toHaveProperty('tracks');
		expect(out.tracks[0].clips[0]).toMatchObject({ type: 'sequence', source: { in: 1000, out: 3000 } });
		expect(out.issues.errors).toBe(0);
	});

	it('refuses speed tools and sound levels on compound clips with a reason', async () => {
		const r = registry(project());
		const ramp = await r.callTool('set_video_speed_ramp', { clip: 'comp', segments: [{ duration: 1000, speed: 2 }] });
		expect(ramp.isError).toBe(true);
		expect(JSON.stringify(ramp.content)).toContain('compound clip, which plays its sequence at normal speed');
		const levels = await r.callTool('get_video_audio_levels', { clip: 'comp' });
		expect(levels.isError).toBe(true);
		expect(JSON.stringify(levels.content)).toContain('its sound is the mix of its sequence');
	});
});
