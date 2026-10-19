import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyVideoEdits, createVideoProject, toVideoFfmpeg, type VideoEdit, type VideoProject } from '../src/video-editor';

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
