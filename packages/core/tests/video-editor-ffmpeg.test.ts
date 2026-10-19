import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { applyVideoEdits, applyVideoGrade, createVideoEditorToolProvider, createVideoProject, videoLutFromFunction, videoProxyFfmpeg, videoLutToCube, VideoEditorController, videoSpeedRampKeys, parseVideoLoudnessMeasurement, toVideoFfmpeg, toVideoLoudnessMeasure, videoFrameAt, type VideoEdit, type VideoProject } from '../src/video-editor';

// Renders projects with a real ffmpeg (skipped when it is not on PATH): the string assertions in
// video-editor.test.ts cannot tell whether ffmpeg accepts the filter graph.
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
/** Homebrew's ffmpeg has no libfreetype, so no drawtext: titles then go in as images. */
const hasDrawtext = hasFfmpeg && /\bdrawtext\b/.test(spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout);

let dir = '';
const media = (name: string) => path.join(dir, name);
const ffmpeg = (args: string[]) => {
	const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status}):\n${r.stderr.slice(-3000)}`);
};
const probe = (file: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' })) as {
	format: { duration: string };
	streams: { codec_type: string; width?: number; height?: number }[];
};
/** Peak level of the sound in the 20 ms around `seconds` (mono, 0–1). */
const level = (file: string, seconds: number): number => {
	const out = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(seconds - 0.01), '-t', '0.02', '-i', file, '-vn', '-ac', '1', '-f', 'f32le', '-']);
	let peak = 0;
	for (let i = 0; i + 4 <= out.length; i += 4) peak = Math.max(peak, Math.abs(out.readFloatLE(i)));
	return peak;
};
/** Mean RGB of the frame at `seconds`. */
const pixel = (file: string, seconds: number, x: number, y: number): [number, number, number] => {
	const out = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', `crop=4:4:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
	return [out[0], out[1], out[2]];
};

function project(edits: VideoEdit[]): VideoProject {
	const r = applyVideoEdits(createVideoProject({ width: 640, height: 360, fps: 25, background: '#000000' }), [
		{ op: 'add_asset', asset: { id: 'a', kind: 'video', src: media('a.mp4'), duration: 6000, width: 640, height: 360 } },
		{ op: 'add_asset', asset: { id: 'b', kind: 'video', src: media('b.mp4'), duration: 6000, width: 320, height: 240, hasAudio: false } },
		{ op: 'add_asset', asset: { id: 'still', kind: 'image', src: media('still.png'), width: 200, height: 200 } },
		{ op: 'add_asset', asset: { id: 'tone', kind: 'audio', src: media('tone.wav'), duration: 10000 } },
		...edits
	]);
	if (!r.ok) throw new Error(r.error);
	return r.project;
}

function render(p: VideoProject, name: string, options: { titleImages?: boolean } = {}) {
	const out = media(name);
	// A stand-in for a title drawn with videoTitleFrame + drawVideoFrame: a yellow box mid-frame.
	const titleImage = options.titleImages || !hasDrawtext ? () => media('title.png') : undefined;
	const result = toVideoFfmpeg(p, { output: out, crf: 30, ...(titleImage ? { titleImage } : {}) });
	ffmpeg(result.args);
	return out;
}

describe.skipIf(!hasFfmpeg)('toVideoFfmpeg with a real ffmpeg', () => {
	beforeAll(() => {
		dir = mkdtempSync(path.join(tmpdir(), 'pixerate-video-'));
		ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', media('a.mp4')]);
		ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media('b.mp4')]);
		ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:size=200x200', '-frames:v', '1', media('still.png')]);
		ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=10', media('tone.wav')]);
		ffmpeg(['-f', 'lavfi', '-i', "color=c=yellow:size=640x360,format=rgba,geq=r=255:g=255:b=0:a='if(between(X,220,420)*between(Y,150,210),255,0)'", '-frames:v', '1', media('title.png')]);
	}, 60000);
	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it('renders every feature: transitions, speed, titles, colour, transforms, fades, mixed and muted sound', () => {
		const p = project([
			{ op: 'add_track', track: { kind: 'video', id: 'top' } },
			{ op: 'add_track', track: { kind: 'audio', id: 'a2', muted: true } },
			{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'c1', asset: 'a', in: 1000, duration: 3000, fadeIn: 300 } },
			{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'c2', asset: 'b', in: 1000, duration: 2000, fit: 'cover', transition: { type: 'crossfade', duration: 800 } } },
			{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'c3', asset: 'still', duration: 1500, transition: { type: 'dip', duration: 600, color: '#ffffff' } } },
			{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'c4', asset: 'a', in: 3000, duration: 1000, speed: 2, transition: { type: 'wipe', duration: 500, direction: 'left' }, fadeOut: 300 } },
			{ op: 'add_clip', track: 'top', clip: { type: 'text', id: 't1', text: "It's 10:30, 100% live; [ok]\nline two", start: 500, duration: 2000, fadeIn: 200, fadeOut: 200, background: '#00000099', fontSize: 32 } },
			{ op: 'add_clip', track: 'top', clip: { type: 'color', id: 'k1', color: '#00ff00', start: 2600, duration: 300, opacity: 0.5 } },
			{ op: 'add_clip', track: 'top', clip: { type: 'media', id: 'r1', asset: 'still', start: 3500, duration: 1000, transform: { x: 100, y: -40, scale: 0.4, rotation: 15 } } },
			{ op: 'add_clip', track: 'a1', clip: { type: 'media', id: 's1', asset: 'tone', duration: 8000, volume: 0.5, fadeOut: 1000 } },
			{ op: 'add_clip', track: 'a2', clip: { type: 'media', id: 's2', asset: 'tone', duration: 2000 } }
		]);
		const out = render(p, 'all.mp4');
		const info = probe(out);
		expect(Number(info.format.duration)).toBeCloseTo(8, 0);
		expect(info.streams.find((s) => s.codec_type === 'video')).toMatchObject({ width: 640, height: 360 });
		expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(true);
	}, 120000);

	it('puts pictures where the preview does', () => {
		const p = project([
			{ op: 'add_clip', track: 'v1', clip: { type: 'color', id: 'k', color: '#0000ff', duration: 1000 } },
			{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 's', asset: 'still', duration: 1000, fit: 'none', transform: { x: 150 } } },
			{ op: 'add_clip', track: 'v1', clip: { type: 'color', id: 'w', color: '#ffffff', duration: 1000, transition: { type: 'dip', duration: 400, color: '#000000' } } }
		]);
		const out = render(p, 'place.mp4');
		const near = (rgb: number[], want: number[]) => rgb.every((v, i) => Math.abs(v - want[i]) < 40);
		expect(near(pixel(out, 0.5, 300, 170), [0, 0, 255])).toBe(true);
		// The 200 × 200 red still, not fitted, centred 150 px right of the middle: x 370–570.
		expect(near(pixel(out, 1.5, 460, 170), [255, 0, 0])).toBe(true);
		expect(near(pixel(out, 1.5, 300, 170), [0, 0, 0])).toBe(true);
		// The dip is black at the cut, and the white clip shows after it.
		expect(near(pixel(out, 2.0, 300, 170), [0, 0, 0])).toBe(true);
		expect(near(pixel(out, 2.7, 300, 170), [255, 255, 255])).toBe(true);
	}, 120000);

	it('shapes sound fades as the preview does', () => {
		const p = project([
			{ op: 'add_clip', track: 'a1', clip: { type: 'media', id: 's', asset: 'tone', duration: 6000, fadeIn: 2000, fadeInCurve: 'equal-power', fadeOut: 2000, fadeOutCurve: 'exponential' } }
		]);
		const out = render(p, 'curves.mp4');
		const full = level(out, 3);
		for (const t of [0.5, 1, 1.5, 4.5, 5]) {
			const gain = videoFrameAt(p, t * 1000).audio[0].gain;
			expect(Math.abs(level(out, t) / full - gain), `gain at ${t} s`).toBeLessThan(0.05);
		}
	}, 120000);

	it('normalises loudness in two passes to the target', () => {
		const p = project([{ op: 'add_clip', track: 'a1', clip: { type: 'media', id: 's', asset: 'tone', duration: 6000, volume: 0.3 } }]);
		const measure = (args: string[]) => {
			const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
			if (r.status !== 0) throw new Error(r.stderr.slice(-2000));
			return parseVideoLoudnessMeasurement(r.stderr);
		};
		const before = measure(toVideoLoudnessMeasure(p, { loudness: { integrated: -16 } }).args);
		expect(before.integrated).toBeLessThan(-20);
		const out = media('loud.mp4');
		ffmpeg(toVideoFfmpeg(p, { output: out, crf: 30, loudness: { integrated: -16, measured: before } }).args);
		const after = measure(['-hide_banner', '-nostats', '-i', out, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
		expect(Math.abs(after.integrated - -16)).toBeLessThan(1);
		expect(after.truePeak).toBeLessThanOrEqual(-0.5);
	}, 120000);

	it('blends layers with what is beneath, through their opacity, only where they cover', () => {
		const p = project([
			{ op: 'add_clip', track: 'v1', clip: { type: 'color', id: 'grey', color: '#808080', duration: 3000 } },
			{ op: 'add_track', track: { kind: 'video', id: 'top' } },
			{ op: 'add_clip', track: 'top', clip: { type: 'media', id: 'm', asset: 'still', duration: 1000, fit: 'none', blend: 'multiply' } },
			{ op: 'add_clip', track: 'top', clip: { type: 'media', id: 's', asset: 'still', start: 1000, duration: 1000, fit: 'none', blend: 'screen', opacity: 0.5 } },
			{ op: 'add_clip', track: 'top', clip: { type: 'color', id: 'a', color: '#404040', start: 2000, duration: 1000, blend: 'add' } }
		]);
		const out = render(p, 'blend.mp4');
		const near = (rgb: number[], want: number[]) => rgb.every((v, i) => Math.abs(v - want[i]) < 24);
		// Multiply red over grey: (128, 0, 0) inside the 200 px still, grey outside it.
		expect(pixel(out, 0.5, 316, 176)).toSatisfy((rgb: number[]) => near(rgb, [128, 0, 0]));
		expect(pixel(out, 0.5, 40, 40)).toSatisfy((rgb: number[]) => near(rgb, [128, 128, 128]));
		// Screen red at half opacity: halfway between grey and (255, 128, 128).
		expect(pixel(out, 1.5, 316, 176)).toSatisfy((rgb: number[]) => near(rgb, [191, 128, 128]));
		// Add: 0x80 + 0x40.
		expect(pixel(out, 2.5, 316, 176)).toSatisfy((rgb: number[]) => near(rgb, [192, 192, 192]));
	}, 120000);

	it('pushes, slides and opens an iris as the preview does', () => {
		const cut = (transition: Record<string, unknown>) =>
			project([
				{ op: 'add_clip', track: 'v1', clip: { type: 'color', id: 'r', color: '#ff0000', duration: 2000 } },
				{ op: 'add_clip', track: 'v1', clip: { type: 'color', id: 'b', color: '#0000ff', duration: 2000, transition: transition as any } }
			]);
		const near = (rgb: number[], want: number[]) => rgb.every((v, i) => Math.abs(v - want[i]) < 40);
		const red = [255, 0, 0];
		const blue = [0, 0, 255];
		// Halfway through a push to the right, blue fills the left half and red the right.
		const push = render(cut({ type: 'push', duration: 1000 }), 'push.mp4');
		expect(pixel(push, 2, 100, 170)).toSatisfy((rgb: number[]) => near(rgb, blue));
		expect(pixel(push, 2, 540, 170)).toSatisfy((rgb: number[]) => near(rgb, red));
		// A slide up: blue comes up over the bottom half, red stays.
		const slide = render(cut({ type: 'slide', duration: 1000, direction: 'up' }), 'slide.mp4');
		expect(pixel(slide, 2, 300, 300)).toSatisfy((rgb: number[]) => near(rgb, blue));
		expect(pixel(slide, 2, 300, 40)).toSatisfy((rgb: number[]) => near(rgb, red));
		// Halfway through an iris, the centre is blue and the corners still red.
		const iris = render(cut({ type: 'iris', duration: 1000 }), 'iris.mp4');
		expect(pixel(iris, 2, 316, 176)).toSatisfy((rgb: number[]) => near(rgb, blue));
		expect(pixel(iris, 2, 10, 10)).toSatisfy((rgb: number[]) => near(rgb, red));
		for (const file of [push, slide, iris]) expect(Number(probe(file).format.duration)).toBeCloseTo(4, 0);
	}, 120000);

	it('animates a picture in as the preview does', () => {
		const p = project([
			{ op: 'add_clip', track: 'v1', clip: { type: 'color', id: 'bg', color: '#000000', duration: 2000 } },
			{ op: 'add_track', track: { kind: 'video', id: 'top' } },
			{ op: 'add_clip', track: 'top', clip: { type: 'color', id: 'z', color: '#00ff00', duration: 2000, animateIn: { effect: 'zoom', duration: 1000 } } }
		]);
		const out = render(p, 'zoom.mp4');
		const near = (rgb: number[], want: number[]) => rgb.every((v, i) => Math.abs(v - want[i]) < 40);
		// Early in the zoom the green box is small and faint: the corners are still black.
		expect(pixel(out, 0.12, 10, 10)).toSatisfy((rgb: number[]) => near(rgb, [0, 0, 0]));
		const early = videoFrameAt(p, 120).layers.find((l) => l.clip === 'z')!;
		const centre = pixel(out, 0.12, 316, 176);
		expect(Math.abs(centre[1] - 255 * early.opacity)).toBeLessThan(40);
		// Once in, it fills the frame.
		expect(pixel(out, 1.5, 10, 10)).toSatisfy((rgb: number[]) => near(rgb, [0, 255, 0]));
	}, 120000);

	it('plays a speed ramp with a freeze frame as the preview does', () => {
		// A clock: the picture's brightness is 25 × its time in seconds.
		ffmpeg(['-f', 'lavfi', '-i', "color=c=black:s=320x180:r=25:d=6,format=gray,geq=lum='25*T'", '-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', '-c:a', 'aac', '-shortest', media('clock.mp4')]);
		const ramp = videoSpeedRampKeys([{ duration: 1000, speed: 1 }, { duration: 1000, speed: 0 }, { duration: 1000, speed: 2 }, { duration: 1000, speed: 2, toSpeed: 0.5 }]);
		const p = project([
			{ op: 'add_asset', asset: { id: 'clock', kind: 'video', src: media('clock.mp4'), duration: 6000, width: 320, height: 180 } },
			{ op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'c', asset: 'clock', in: 500, duration: 1000 } },
			{ op: 'set_time_remap', clip: 'c', keys: ramp.keys, duration: ramp.duration }
		]);
		const out = render(p, 'ramp.mp4');
		const luma = (t: number) => pixel(out, t, 300, 170)[0];
		for (const t of [0.5, 1.2, 1.8, 2.5, 3.5]) {
			const want = (25 * videoFrameAt(p, t * 1000).layers[0].sourceTime!) / 1000;
			expect(Math.abs(luma(t) - want), `at ${t} s: source ${videoFrameAt(p, t * 1000).layers[0].sourceTime}`).toBeLessThan(6);
		}
		const info = probe(out);
		expect(Number(info.format.duration)).toBeCloseTo(4, 0);
		expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(true);
	}, 120000);

	it('grades colours as the preview does', () => {
		const grades = [{ exposure: 0.5, contrast: 0.3 }, { saturation: -0.6, hue: 40 }, { temperature: 0.8, tint: -0.5 }, { exposure: -1, saturation: 0.8, temperature: -0.5 }];
		const base: [number, number, number] = [180, 90, 60];
		const p = project(grades.map((grade, i) => ({ op: 'add_clip' as const, track: 'v1', clip: { type: 'color' as const, id: `g${i}`, color: '#b45a3c', start: i * 1000, duration: 1000, grade } })));
		const out = render(p, 'grade.mp4');
		grades.forEach((grade, i) => {
			const want = applyVideoGrade(grade, base);
			const got = pixel(out, i + 0.5, 300, 170);
			expect(got.every((v, k) => Math.abs(v - want[k]) < 10), `grade ${JSON.stringify(grade)}: got ${got}, want ${want}`).toBe(true);
		});
	}, 120000);

	it('applies a LUT after the grade, at full and part strength, as the preview does', () => {
		// A look no grade step can make: green into red, a curve on blue, a lift on black.
		const lut = videoLutFromFunction(17, ([r, g, b]) => [0.05 + 0.9 * g ** 0.8, (r + b) / 2, b ** 1.5], 'Swap');
		writeFileSync(media('look.cube'), videoLutToCube(lut));
		const grades = [{ lut: { src: 'look.cube' } }, { exposure: 0.3, lut: { src: 'look.cube', strength: 0.5 } }, { saturation: -0.4, lut: { src: 'look.cube', strength: 0.25 } }];
		const base: [number, number, number] = [180, 90, 60];
		const p = project(grades.map((grade, i) => ({ op: 'add_clip' as const, track: 'v1', clip: { type: 'color' as const, id: `l${i}`, color: '#b45a3c', start: i * 1000, duration: 1000, grade } })));
		const result = toVideoFfmpeg(p, { output: media('lut.mp4'), crf: 30, resolveLut: (src) => media(src) });
		expect(result.filterComplex).toContain('lut3d=file=');
		expect(result.filterComplex).toContain('blend=all_mode=normal:all_opacity=0.5');
		ffmpeg(result.args);
		grades.forEach((grade, i) => {
			const want = applyVideoGrade(grade, base, lut);
			const got = pixel(media('lut.mp4'), i + 0.5, 300, 170);
			expect(got.every((v, k) => Math.abs(v - want[k]) < 10), `grade ${JSON.stringify(grade)}: got ${got}, want ${want}`).toBe(true);
		});
	}, 120000);

	it('makes proxies that seek cheaply and keep the original\'s timing, while the export reads the original', () => {
		const asset = { id: 'a', kind: 'video' as const, src: media('a.mp4'), duration: 6000, width: 640, height: 360 };
		const made = videoProxyFfmpeg(asset, { scale: 0.5, gop: 10 });
		ffmpeg(made.args);
		const info = probe(made.proxy.src);
		const v = info.streams.find((s) => s.codec_type === 'video')!;
		expect([v.width, v.height]).toEqual([made.proxy.width, made.proxy.height]);
		expect(info.streams.some((s) => s.codec_type === 'audio')).toBe(true);
		expect(Math.abs(Number(info.format.duration) - 6)).toBeLessThan(0.1);
		// A keyframe every 10 frames: 150 frames make 15 of them.
		const keys = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', made.proxy.src], { encoding: 'utf8' }).trim().split('\n');
		expect(keys.length).toBe(15);
		// The same moment in the proxy and the original shows the same picture (scaled).
		for (const t of [1.2, 4.6]) {
			const a = pixel(media('a.mp4'), t, 300, 160);
			const b = pixel(made.proxy.src, t, 150, 80);
			expect(a.every((x, k) => Math.abs(x - b[k]) < 24), `at ${t}s: original ${a}, proxy ${b}`).toBe(true);
		}
		const p = project([{ op: 'update_asset', asset: 'a', set: { proxies: [made.proxy] } }, { op: 'add_clip', track: 'v1', clip: { type: 'media', id: 'c', asset: 'a', duration: 1000 } }]);
		const exported = toVideoFfmpeg(p, { output: media('proxied.mp4') });
		expect(exported.args).toContain(media('a.mp4'));
		expect(exported.args).not.toContain(made.proxy.src);
	}, 60000);

	it('measures an exported frame with get_video_scopes on a host without a preview', async () => {
		// A server host decodes the export's frame with ffmpeg and hands its pixels to the tool.
		const grade = { exposure: 0.5, saturation: -0.3 };
		const p = project([
			{ op: 'add_clip', track: 'v1', clip: { type: 'color', id: 'k', color: '#b45a3c', duration: 1000, grade } },
			{ op: 'add_clip', track: 'v1', clip: { type: 'color', id: 'w', color: '#ffffff', duration: 1000 } }
		]);
		const out = render(p, 'scopes.mp4');
		const framePixels = (time: number) => {
			const data = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(time / 1000), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
			return { width: 640, height: 360, data };
		};
		const registry = new ToolRegistry();
		registry.register(createVideoEditorToolProvider(new VideoEditorController({ project: p }), { framePixels }));
		const read = async (time: number) => (await registry.callTool('get_video_scopes', { time })).structuredContent as any;
		const graded = await read(500);
		const want = applyVideoGrade(grade, [180, 90, 60]);
		const got = [1, 3, 5].map((i) => parseInt(graded.stats.average.slice(i, i + 2), 16));
		expect(got.every((v, k) => Math.abs(v - want[k]) < 10), `average ${graded.stats.average}, want ${want}`).toBe(true);
		expect(graded.stats.clipped.highlights).toBe(0);
		const white = await read(1500);
		expect(white.stats.clipped.highlights).toBeGreaterThan(0.99);
		expect(white.notes.join(' ')).toMatch(/blown to white/);
	}, 60000);

	it('dodges and burns as the browser does', () => {
		const p = project([
			{ op: 'add_clip', track: 'v1', clip: { type: 'color', id: 'base', color: '#c8c8c8', duration: 2000 } },
			{ op: 'add_track', track: { kind: 'video', id: 'top' } },
			{ op: 'add_clip', track: 'top', clip: { type: 'color', id: 'd', color: '#1e1e1e', duration: 1000, blend: 'color-dodge' } },
			{ op: 'add_clip', track: 'top', clip: { type: 'color', id: 'b', color: '#c8c8c8', start: 1000, duration: 1000, blend: 'color-burn' } }
		]);
		const out = render(p, 'dodge.mp4');
		const near = (rgb: number[], want: number[]) => rgb.every((v, i) => Math.abs(v - want[i]) < 12);
		// CSS: dodge 200 / (1 - 30/255) = 227; burn 1 - (1 - 200/255) / (200/255) = 185.
		expect(pixel(out, 0.5, 300, 170)).toSatisfy((rgb: number[]) => near(rgb, [227, 227, 227]));
		expect(pixel(out, 1.5, 300, 170)).toSatisfy((rgb: number[]) => near(rgb, [185, 185, 185]));
	}, 120000);

	it('overlays titles given as images, with their fades', () => {
		const p = project([
			{ op: 'add_clip', track: 'v1', clip: { type: 'color', id: 'k', color: '#0000ff', duration: 2000 } },
			{ op: 'add_track', track: { kind: 'video', id: 'top' } },
			{ op: 'add_clip', track: 'top', clip: { type: 'text', id: 't', text: 'Hello', start: 500, duration: 1000, fadeIn: 400 } }
		]);
		const out = render(p, 'title.mp4', { titleImages: true });
		const near = (rgb: number[], want: number[]) => rgb.every((v, i) => Math.abs(v - want[i]) < 40);
		expect(near(pixel(out, 0.2, 316, 176), [0, 0, 255])).toBe(true);
		expect(near(pixel(out, 1.2, 316, 176), [255, 255, 0])).toBe(true);
		expect(near(pixel(out, 1.2, 100, 100), [0, 0, 255])).toBe(true);
		expect(near(pixel(out, 1.8, 316, 176), [0, 0, 255])).toBe(true);
	}, 120000);
});
