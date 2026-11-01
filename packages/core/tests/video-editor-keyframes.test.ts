import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/animation/clock';
import { ToolRegistry } from '../src/tools';
import {
	applyVideoEdits,
	checkVideoProject,
	createVideoEditorToolProvider,
	createVideoProject,
	findVideoClip,
	parseVideoProject,
	setVideoKey,
	removeVideoKey,
	splitVideoAnimatable,
	toVideoFfmpeg,
	videoEaseProgress,
	videoFrameAt,
	videoKeyframeFfmpegExpr,
	videoKeyframeRows,
	videoKeyframeToggleEdit,
	videoKeyframeValueEdit,
	videoValueAt,
	VideoEditorController,
	type VideoEase,
	type VideoEdit,
	type VideoKeyframes,
	type VideoProject
} from '../src/video-editor';

const EASES: VideoEase[] = ['linear', 'ease-in', 'ease-out', 'ease-in-out', [0.68, -0.55, 0.27, 1.55], [0, 1, 0, 1], [1, 0, 1, 0], [0.9, 0.1, 0.1, 0.9]];

/** y for x on a cubic-bezier by dense sampling, to check the solver against. */
function bruteBezier([x1, y1, x2, y2]: [number, number, number, number], x: number): number {
	const b = (a: number, c: number, s: number) => 3 * a * (1 - s) ** 2 * s + 3 * c * (1 - s) * s * s + s ** 3;
	let best = 0;
	let err = Infinity;
	for (let i = 0; i <= 200000; i++) {
		const s = i / 200000;
		const e = Math.abs(b(x1, x2, s) - x);
		if (e < err) {
			err = e;
			best = s;
		}
	}
	return b(y1, y2, best);
}

describe('easing curves', () => {
	it('a linear cubic-bezier is linear', () => {
		for (let p = 0; p <= 1; p += 0.05) {
			expect(videoEaseProgress([0, 0, 1, 1], p)).toBeCloseTo(p, 6);
			expect(videoEaseProgress([1 / 3, 1 / 3, 2 / 3, 2 / 3], p)).toBeCloseTo(p, 6);
			expect(videoEaseProgress('linear', p)).toBeCloseTo(p, 12);
			expect(videoEaseProgress(undefined, p)).toBeCloseTo(p, 12);
		}
	});

	it('hits the endpoints exactly', () => {
		for (const ease of EASES) {
			expect(videoEaseProgress(ease, 0)).toBe(0);
			expect(videoEaseProgress(ease, 1)).toBe(1);
		}
		const keys: VideoKeyframes = { keys: [{ t: 0, v: 3, ease: 'ease-in-out' }, { t: 1000, v: 7, ease: [0.68, -0.55, 0.27, 1.55] }, { t: 2000, v: -1 }] };
		expect(videoValueAt(keys, 0)).toBe(3);
		expect(videoValueAt(keys, 1000)).toBe(7);
		expect(videoValueAt(keys, 2000)).toBe(-1);
	});

	it('solves y for x like the curve (Newton, with bisection where it is flat)', () => {
		for (const ease of EASES.filter(Array.isArray) as [number, number, number, number][])
			for (let p = 0.01; p < 1; p += 0.07) expect(videoEaseProgress(ease, p)).toBeCloseTo(bruteBezier(ease, p), 3);
	});

	it('named curves are the CSS ones', () => {
		expect(videoEaseProgress('ease-in', 0.5)).toBeCloseTo(bruteBezier([0.42, 0, 1, 1], 0.5), 4);
		expect(videoEaseProgress('ease-out', 0.5)).toBeCloseTo(bruteBezier([0, 0, 0.58, 1], 0.5), 4);
		expect(videoEaseProgress('ease-in-out', 0.5)).toBeCloseTo(0.5, 6);
		expect(videoEaseProgress('ease-in', 0.25)).toBeLessThan(0.25);
		expect(videoEaseProgress('ease-out', 0.25)).toBeGreaterThan(0.25);
	});

	it('hold freezes its own segment and leaves the incoming one alone', () => {
		const keys: VideoKeyframes = { keys: [{ t: 0, v: 0 }, { t: 1000, v: 10, ease: 'hold' }, { t: 2000, v: 20 }] };
		expect(videoValueAt(keys, 500)).toBe(5);
		expect(videoValueAt(keys, 1000)).toBe(10);
		expect(videoValueAt(keys, 1999)).toBe(10);
		expect(videoValueAt(keys, 2000)).toBe(20);
	});
});

describe('videoValueAt', () => {
	it('passes numbers through and falls back when unset', () => {
		expect(videoValueAt(0.4, 123)).toBe(0.4);
		expect(videoValueAt(undefined, 123, 1)).toBe(1);
	});

	it('holds before the first key and after the last, and finds the segment among many', () => {
		const keys: VideoKeyframes = { keys: Array.from({ length: 101 }, (_, i) => ({ t: 500 + i * 100, v: i * 2 })) };
		expect(videoValueAt(keys, 0)).toBe(0);
		expect(videoValueAt(keys, 100000)).toBe(200);
		expect(videoValueAt(keys, 500 + 37 * 100 + 50)).toBeCloseTo(75, 9);
		expect(videoValueAt({ keys: [{ t: 200, v: 9 }] }, 0)).toBe(9);
	});

	it('adds and removes single keys (for a keyframe toggle)', () => {
		const a = setVideoKey(0.5, { t: 1000, v: 1 }, 1);
		expect(a).toEqual({ keys: [{ t: 0, v: 0.5 }, { t: 1000, v: 1 }] });
		expect(setVideoKey(undefined, { t: 0, v: 0 }, 1)).toEqual({ keys: [{ t: 0, v: 0 }] });
		expect(setVideoKey(a, { t: 1000, v: 0.2 }, 1).keys).toEqual([{ t: 0, v: 0.5 }, { t: 1000, v: 0.2 }]);
		expect(removeVideoKey(a, 1000)).toEqual({ keys: [{ t: 0, v: 0.5 }] });
		expect(removeVideoKey({ keys: [{ t: 0, v: 0.3 }] }, 0)).toBe(0.3);
	});
});

describe('splitting keyframes', () => {
	const cases: [string, VideoKeyframes, number][] = [
		['linear', { keys: [{ t: 0, v: 0 }, { t: 2000, v: 100 }] }, 700],
		['bezier', { keys: [{ t: 0, v: 0, ease: [0.68, -0.55, 0.27, 1.55] }, { t: 2000, v: 100 }] }, 700],
		['ease-in-out across several keys', { keys: [{ t: 0, v: 10, ease: 'ease-in-out' }, { t: 1000, v: 50, ease: 'ease-in' }, { t: 3000, v: -20 }] }, 1900],
		['hold', { keys: [{ t: 0, v: 1, ease: 'hold' }, { t: 1000, v: 5 }] }, 400],
		['on a key', { keys: [{ t: 0, v: 0 }, { t: 1000, v: 5, ease: 'ease-out' }, { t: 2000, v: 9 }] }, 1000],
		['before the first key', { keys: [{ t: 800, v: 2 }, { t: 1200, v: 4 }] }, 300],
		['after the last key', { keys: [{ t: 0, v: 2 }, { t: 1200, v: 4 }] }, 1500]
	];
	it.each(cases)('%s: both halves play as the whole did', (_name, prop, at) => {
		const [left, right] = splitVideoAnimatable(prop, at);
		expect(left.keys.at(-1)).toMatchObject({ t: at });
		expect(right.keys[0]).toMatchObject({ t: 0 });
		for (let t = 0; t <= 3000; t += 37) {
			const want = videoValueAt(prop, t);
			if (t <= at) expect(videoValueAt(left, t)).toBeCloseTo(want, 3);
			if (t >= at) expect(videoValueAt(right, t - at)).toBeCloseTo(want, 3);
		}
	});
});

function base(edits: VideoEdit[]): VideoProject {
	const r = applyVideoEdits(createVideoProject({ width: 640, height: 360, fps: 25 }), [
		{ op: 'add_asset', asset: { id: 'a', kind: 'video', src: 'a.mp4', duration: 10000, width: 640, height: 360 } },
		{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'c1', asset: 'a', start: 1000, duration: 4000 } },
		...edits
	]);
	if (!r.ok) throw new Error(r.error);
	return r.project;
}
const clip = (p: VideoProject, id: string) => findVideoClip(p, id)!.clip as any;

describe('keyframes in the project', () => {
	const keyed = base([
		{ op: 'set_keyframes', clip: 'c1', property: 'opacity', keys: [{ t: 0, v: 0 }, { t: 1000, v: 1 }] },
		{ op: 'set_keyframes', clip: 'c1', property: 'x', keys: [{ t: 2000, v: 100 }, { t: 0, v: 0, ease: 'ease-in-out' }] },
		{ op: 'set_keyframes', clip: 'c1', property: 'scale', keys: [{ t: 0, v: 1 }, { t: 4000, v: 2 }] },
		{ op: 'set_keyframes', clip: 'c1', property: 'rotation', keys: [{ t: 0, v: 0, ease: 'hold' }, { t: 3000, v: 90 }] },
		{ op: 'set_keyframes', clip: 'c1', property: 'volume', keys: [{ t: 0, v: 0 }, { t: 2000, v: 2 }] }
	]);

	it('sorts the keys and parses them back', () => {
		expect(clip(keyed, 'c1').transform.x.keys.map((k: { t: number }) => k.t)).toEqual([0, 2000]);
		expect(parseVideoProject(JSON.parse(JSON.stringify(keyed)))).toEqual(keyed);
	});

	it('animates opacity, placement, rotation and gain in videoFrameAt (clip time)', () => {
		const f = videoFrameAt(keyed, 1500);
		expect(f.layers[0].opacity).toBeCloseTo(0.5, 9);
		expect(f.layers[0].rect.width).toBeCloseTo(640 * 1.125, 6);
		expect(f.layers[0].rect.x + f.layers[0].rect.width / 2).toBeCloseTo(320 + 100 * videoEaseProgress('ease-in-out', 0.25), 6);
		expect(f.layers[0].rotation).toBe(0);
		expect(f.audio[0].gain).toBeCloseTo(0.5, 9);
		expect(videoFrameAt(keyed, 4500).layers[0].rotation).toBe(90);
	});

	it('split keeps both parts playing as before, with keys at the cut', () => {
		const r = applyVideoEdits(keyed, { op: 'split_clip', clip: 'c1', at: 2500, id: 'c2' });
		if (!r.ok) throw new Error(r.error);
		for (let t = 1050; t < 5000; t += 111) {
			const a = videoFrameAt(keyed, t).layers[0];
			const b = videoFrameAt(r.project, t).layers[0];
			expect(b.opacity).toBeCloseTo(a.opacity, 4);
			expect(b.rect.x).toBeCloseTo(a.rect.x, 3);
			expect(b.rect.width).toBeCloseTo(a.rect.width, 3);
			expect(b.rotation).toBeCloseTo(a.rotation, 4);
			expect(videoFrameAt(r.project, t).audio[0].gain).toBeCloseTo(videoFrameAt(keyed, t).audio[0].gain, 4);
		}
		expect(clip(r.project, 'c1').opacity.keys.at(-1)).toEqual({ t: 1500, v: 1 });
		expect(clip(r.project, 'c2').scale).toBeUndefined();
		expect(clip(r.project, 'c2').transform.scale.keys).toEqual([{ t: 0, v: 1.375 }, { t: 2500, v: 2 }]);
		expect(checkVideoProject(r.project).filter((i) => i.code === 'keyframes-outside-clip')).toEqual([]);
	});

	it('trimming the head keeps keys on the same frames; a speed change stretches them', () => {
		const r = applyVideoEdits(keyed, { op: 'trim_clip', clip: 'c1', edge: 'start', to: 1500 });
		if (!r.ok) throw new Error(r.error);
		expect(videoFrameAt(r.project, 1800).layers[0].opacity).toBeCloseTo(videoFrameAt(keyed, 1800).layers[0].opacity, 9);
		expect(clip(r.project, 'c1').opacity.keys[0].t).toBe(-500);
		expect(checkVideoProject(r.project).find((i) => i.code === 'keyframes-outside-clip')?.message).toContain('opacity key at -500 ms');
		const fast = applyVideoEdits(keyed, { op: 'update_clip', clip: 'c1', set: { speed: 2 } });
		if (!fast.ok) throw new Error(fast.error);
		expect(clip(fast.project, 'c1').duration).toBe(2000);
		expect(clip(fast.project, 'c1').transform.scale.keys).toEqual([{ t: 0, v: 1 }, { t: 2000, v: 2 }]);
	});

	it('removing keys keeps the value at the clip start', () => {
		const r = applyVideoEdits(keyed, [
			{ op: 'set_keyframes', clip: 'c1', property: 'opacity', keys: null },
			{ op: 'set_keyframes', clip: 'c1', property: 'x', keys: [{ t: 0, v: 40 }] },
			{ op: 'set_keyframes', clip: 'c1', property: 'x', keys: null }
		]);
		if (!r.ok) throw new Error(r.error);
		expect(clip(r.project, 'c1').opacity).toBe(0);
		expect(clip(r.project, 'c1').transform.x).toBe(40);
	});

	it('refuses bad keys with the field and the fix', () => {
		const bad = (e: VideoEdit) => {
			const r = applyVideoEdits(keyed, e);
			expect(r.ok).toBe(false);
			return (r as { error: string }).error;
		};
		expect(bad({ op: 'set_keyframes', clip: 'c1', property: 'opacity', keys: [{ t: 0, v: 2 }] })).toContain('opacity.keys[0].v must be at most 1');
		expect(bad({ op: 'set_keyframes', clip: 'c1', property: 'x', keys: [{ t: 5, v: 0 }, { t: 5, v: 1 }, { t: 5, v: 2 }] })).toContain('Three keys are at 5 ms; a time takes one key, or two for a jump');
		expect(bad({ op: 'set_keyframes', clip: 'c1', property: 'x', keys: [{ t: 0, v: 0, ease: 'bounce' as any }] })).toContain('ease must be one of');
		expect(bad({ op: 'set_keyframes', clip: 'c1', property: 'x', keys: [{ t: 0, v: 0, ease: [2, 0, 1, 1] }] })).toContain('x1 and x2 between 0 and 1');
		expect(bad({ op: 'set_keyframes', clip: 'c1', property: 'blur' as any, keys: [{ t: 0, v: 0 }] })).toContain('cannot be keyframed');
		expect(bad({ op: 'set_keyframes', clip: 'c1', property: 'x', keys: [] })).toContain('at least one key');
		expect(() => parseVideoProject({ width: 10, height: 10, tracks: [{ id: 'v', kind: 'video', clips: [{ id: 'k', type: 'color', color: 'red', start: 0, duration: 10, opacity: { keys: [{ t: 5, v: 1 }, { t: 1, v: 0 }] } }] }] })).toThrow(
			'tracks[0].clips[0].opacity.keys[1].t must not be before the key before'
		);
	});
});

describe('inspector keyframe helpers', () => {
	it('lists the animatable properties with their value at the playhead', () => {
		const p = base([{ op: 'set_keyframes', clip: 'c1', property: 'opacity', keys: [{ t: 0, v: 0 }, { t: 1000, v: 1 }] }]);
		const rows = videoKeyframeRows(p, 'c1', 1500);
		expect(rows.map((r) => r.property)).toEqual(['opacity', 'volume', 'x', 'y', 'scale', 'rotation']);
		expect(rows[0]).toMatchObject({ value: 0.5, keyed: true, keys: 2, onKey: false, clipTime: 500, min: 0, max: 1 });
		expect(videoKeyframeRows(p, 'c1', 9000)[0]).toMatchObject({ clipTime: 4000, value: 1 });
	});

	it('toggles keys and types values as single edits', () => {
		let p = base([{ op: 'update_clip', clip: 'c1', set: { transform: { x: 30 } } }]);
		const apply = (e: VideoEdit | null) => {
			const r = applyVideoEdits(p, e!);
			if (!r.ok) throw new Error(r.error);
			p = r.project;
		};
		apply(videoKeyframeToggleEdit(p, 'c1', 'x', 2000));
		expect(clip(p, 'c1').transform.x).toEqual({ keys: [{ t: 1000, v: 30 }] });
		apply(videoKeyframeValueEdit(p, 'c1', 'x', 3000, 90));
		expect(clip(p, 'c1').transform.x.keys).toEqual([{ t: 1000, v: 30 }, { t: 2000, v: 90 }]);
		apply(videoKeyframeToggleEdit(p, 'c1', 'x', 2000));
		// The last key's value stays as the plain value.
		apply(videoKeyframeToggleEdit(p, 'c1', 'x', 3000));
		expect(clip(p, 'c1').transform).toEqual({ x: 90 });
		apply(videoKeyframeValueEdit(p, 'c1', 'x', 0, undefined));
		expect(clip(p, 'c1').transform).toBeUndefined();
		apply(videoKeyframeValueEdit(p, 'c1', 'scale', 0, 2));
		expect(clip(p, 'c1').transform).toEqual({ scale: 2 });
	});
});

describe('keyframes in the ffmpeg export', () => {
	it('emits piecewise-linear expressions, baking eased segments to breakpoints', () => {
		expect(videoKeyframeFfmpegExpr(0.5, 't', 1, 80)).toBe('0.5');
		expect(videoKeyframeFfmpegExpr({ keys: [{ t: 0, v: 0 }, { t: 1000, v: 1 }] }, 'T', 1, 80)).toBe('if(lt(T,0),0,if(lt(T,1000),0+0.001*(T+0),1))');
		expect(videoKeyframeFfmpegExpr({ keys: [{ t: 0, v: 2, ease: 'hold' }, { t: 500, v: 4 }] }, 'T', 1, 80)).toBe('if(lt(T,0),2,if(lt(T,500),2,4))');
		const eased = videoKeyframeFfmpegExpr({ keys: [{ t: 0, v: 0, ease: 'ease-in' }, { t: 800, v: 1 }] }, 'T', 1, 80);
		expect(eased.match(/if\(lt/g)).toHaveLength(11);
		expect(eased).not.toContain('--');
	});

	it('animates alpha, overlay position, rotation, scale and volume', () => {
		const p = base([
			{ op: 'set_keyframes', clip: 'c1', property: 'opacity', keys: [{ t: 0, v: 0 }, { t: 1000, v: 1 }] },
			{ op: 'set_keyframes', clip: 'c1', property: 'x', keys: [{ t: 0, v: -100 }, { t: 1000, v: 100 }] },
			{ op: 'set_keyframes', clip: 'c1', property: 'rotation', keys: [{ t: 0, v: 0 }, { t: 1000, v: 45 }] },
			{ op: 'set_keyframes', clip: 'c1', property: 'scale', keys: [{ t: 0, v: 0.5, ease: 'ease-out' }, { t: 1000, v: 1 }] },
			{ op: 'set_keyframes', clip: 'c1', property: 'volume', keys: [{ t: 0, v: 0 }, { t: 1000, v: 1 }] }
		]);
		const { filterComplex, notes } = toVideoFfmpeg(p);
		expect(filterComplex).toContain("overlay=x='320+(if(lt((t*1000-1000),0),-100,");
		expect(filterComplex).toContain("geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*clip(if(lt((T*1000),0),0,");
		expect(filterComplex).toContain("rotate=a='(if(lt((t*1000),0),0,");
		// Scaled last, by the input size: geq and rotate keep the size they first see.
		expect(filterComplex).toMatch(/scale=w='max\(2,trunc\(iw\*\(if\(.*\)\/2\)\*2\)':h=.*:eval=frame/);
		expect(filterComplex).toContain("volume='1*(if(lt((t*1000),0),0,");
		expect(notes.join(' ')).toContain('Keyframed opacity, position, rotation, scale, volume are rendered as straight lines');
	});
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('keyframes with a real ffmpeg', () => {
	it('renders an animated still that moves, fades, grows and turns', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'pixerate-keys-'));
		try {
			const run = (args: string[]) => {
				const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
				if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}):\n${r.stderr.slice(-3000)}`);
			};
			run(['-f', 'lavfi', '-i', 'color=c=white:size=100x100', '-frames:v', '1', path.join(dir, 'still.png')]);
			run(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', path.join(dir, 'tone.wav')]);
			const r = applyVideoEdits(createVideoProject({ width: 320, height: 180, fps: 25, background: '#000000' }), [
				{ op: 'add_asset', asset: { id: 's', kind: 'image', src: path.join(dir, 'still.png'), width: 100, height: 100 } },
				{ op: 'add_asset', asset: { id: 'tone', kind: 'audio', src: path.join(dir, 'tone.wav'), duration: 4000 } },
				{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'k', asset: 's', start: 0, duration: 2000, fit: 'none' } },
				{ op: 'set_keyframes', clip: 'k', property: 'x', keys: [{ t: 0, v: -100 }, { t: 2000, v: 100, ease: 'ease-in-out' }] },
				{ op: 'set_keyframes', clip: 'k', property: 'opacity', keys: [{ t: 0, v: 1 }, { t: 1000, v: 1 }, { t: 1500, v: 0, ease: 'hold' }] },
				{ op: 'set_keyframes', clip: 'k', property: 'scale', keys: [{ t: 0, v: 0.5 }, { t: 1000, v: 1 }] },
				{ op: 'set_keyframes', clip: 'k', property: 'rotation', keys: [{ t: 0, v: 0 }, { t: 1000, v: 45 }] },
				{ op: 'add_clip', track: 'a1', clip: { type: 'media', id: 'm', asset: 'tone', duration: 2000 } },
				{ op: 'set_keyframes', clip: 'm', property: 'volume', keys: [{ t: 0, v: 0 }, { t: 2000, v: 1 }] }
			]);
			if (!r.ok) throw new Error(r.error);
			const out = path.join(dir, 'out.mp4');
			run(toVideoFfmpeg(r.project, { output: out, crf: 20 }).args);
			const pixel = (seconds: number, x: number, y: number) => {
				const b = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', out, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
				return b[0];
			};
			// At 0.2 s: centre ~ x 60.4 (eased), scale 0.6, little turn: white at its centre, black at the frame's.
			expect(pixel(0.2, 60, 90)).toBeGreaterThan(200);
			expect(pixel(0.2, 160, 90)).toBeLessThan(40);
			// At 1.0 s: centred, full size, turned 45°: the centre is white, the unturned corner is black.
			expect(pixel(1.0, 160, 90)).toBeGreaterThan(200);
			expect(pixel(1.0, 113, 43)).toBeLessThan(60);
			// Faded out by 1.6 s.
			expect(pixel(1.6, 250, 90)).toBeLessThan(40);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60000);

	it('moves a title drawn as an image: the image is placed unmoved and animated by the export', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'pixerate-keys-'));
		try {
			const png = path.join(dir, 'title.png');
			spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', "color=c=white:size=320x180,format=rgba,geq=r=255:g=255:b=255:a='if(between(X,140,180)*between(Y,70,110),255,0)'", '-frames:v', '1', png]);
			const r = applyVideoEdits(createVideoProject({ width: 320, height: 180, fps: 25, background: '#000000' }), [
				{ op: 'add_clip', track: 'v1', clip: { type: 'text', id: 't', text: 'Hi', start: 0, duration: 2000, transform: { y: 10 } } },
				{ op: 'set_keyframes', clip: 't', property: 'x', keys: [{ t: 0, v: -100 }, { t: 2000, v: 100 }] }
			]);
			if (!r.ok) throw new Error(r.error);
			const seen: unknown[] = [];
			const out = path.join(dir, 'out.mp4');
			const { args } = toVideoFfmpeg(r.project, { output: out, titleImage: (c) => (seen.push(c.transform), png) });
			expect(seen).toEqual([undefined]);
			const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
			expect(run.stderr).toBe('');
			const at = (seconds: number, x: number) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', out, '-frames:v', '1', '-vf', `crop=2:2:${x}:100,scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])[0];
			expect(at(0.5, 110)).toBeGreaterThan(200);
			expect(at(0.5, 160)).toBeLessThan(40);
			expect(at(1.5, 210)).toBeGreaterThan(200);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60000);
});

describe('keyframe tools', () => {
	const setup = async () => {
		const controller = new VideoEditorController({ clock: new ManualClock() });
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
		await call('add_video_asset', { id: 'a', kind: 'video', src: 'a.mp4', duration: 10000 });
		await call('add_video_clip', { track: 'v1', clip: { type: 'media', asset: 'a', duration: 3000 } });
		await call('add_video_clip', { track: 'v1', clip: { type: 'text', text: 'Hi', duration: 2000 } });
		return { controller, call, fail };
	};

	it('sets keys, returns them sorted, and removes them again as single undo steps', async () => {
		const { call, controller } = await setup();
		const set = await call('set_video_keyframes', { clip: 'c1', property: 'scale', keys: [{ t: 2000, v: 1.5, ease: [0.25, 0.1, 0.25, 1] }, { t: 0, v: 1 }] });
		expect(set).toMatchObject({ clip: 'c1', property: 'scale', keys: [{ t: 0, v: 1 }, { t: 2000, v: 1.5, ease: [0.25, 0.1, 0.25, 1] }], issues: { errors: 0 } });
		const frame = await call('get_video_frame', { time: 1000 });
		expect(frame.layers[0].rect.width).toBeGreaterThan(1920);
		expect(controller.getState().undoLabel).toBe('Keyframe scale');
		const removed = await call('remove_video_keyframes', { clip: 'c1', property: 'scale' });
		expect(removed).toMatchObject({ keys: [], value: null });
		await call('undo_video');
		expect((await call('get_video_project')).tracks[0].clips[0].transform.scale.keys).toHaveLength(2);
		const late = await call('set_video_keyframes', { clip: 'c2', property: 'opacity', keys: [{ t: 0, v: 1 }, { t: 5000, v: 0 }] });
		expect(late.issues.lines.join(' ')).toContain('outside the clip (0–2000 ms in clip time)');
	});

	it('fails usefully on bad arguments without changing anything', async () => {
		const { call, fail } = await setup();
		const before = JSON.stringify(await call('get_video_project'));
		expect(await fail('set_video_keyframes', { clip: 'c9', property: 'x', keys: [{ t: 0, v: 1 }] })).toContain('There is no clip');
		expect(await fail('set_video_keyframes', { clip: 'c2', property: 'volume', keys: [{ t: 0, v: 1 }] })).toContain('has no volume');
		expect(await fail('set_video_keyframes', { clip: 'c1', property: 'opacity', keys: [{ t: 0, v: 3 }] })).toContain('must be at most 1');
		expect(await fail('set_video_keyframes', { clip: 'c1', property: 'blur', keys: [{ t: 0, v: 3 }] })).toMatch(/property/);
		expect(await fail('set_video_keyframes', { clip: 'c1', property: 'x', keys: [] })).toMatch(/keys/);
		expect(await fail('set_video_keyframes', { clip: 'c1', property: 'x', keys: [{ t: 0 }] })).toMatch(/v/);
		expect(await fail('remove_video_keyframes', { clip: 'c1' })).toMatch(/property/);
		expect(JSON.stringify(await call('get_video_project'))).toBe(before);
	});
});
