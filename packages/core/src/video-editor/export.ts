import { videoClipAnimated } from './clip-animation.js';
import { placeVideoRect } from './evaluate.js';
import { videoIrisRadius } from './render.js';
import { videoTimeRemapBreakpoints, videoTimeRemapSpan } from './remap.js';
import { normalizeVideoGradeLut, videoGradeFfmpegFilters } from './grade.js';
import { isVideoKeyframes, VIDEO_TRANSFORM_PROPERTIES, videoKeyframeFfmpegExpr, type VideoAnimatable, type VideoKeyframes } from './keyframes.js';
import { formatVideoTimecode, formatVideoTimecodeFrames, isVideoDropFrameRate, videoHourFrames, videoTimecodeFrames, sortedVideoClips, videoAssetMap, videoClipBefore, videoClipEnd, videoClipOverhang, videoClipSpeed, videoProjectDuration, videoAssetHasSound } from './timeline.js';
import { videoTransitionAudioCurve } from './types.js';
import type { VideoWipeDirection, VideoAsset, VideoBlendMode, VideoClip, VideoFadeCurve, VideoProject, VideoTextClip, VideoTrack } from './types.js';

// ---------------------------------------------------------------------------------------------
// CMX 3600 EDL
// ---------------------------------------------------------------------------------------------

export interface VideoEdlOptions {
	/** Track to export (default: the bottom video track, V1 in most NLEs). */
	track?: string;
	/** Record timecode of the timeline's start (ms; default timecode 01:00:00:00, the usual start). */
	recordStart?: number;
	/** Title line (default: the project's name). */
	title?: string;
	/** Drop-frame timecode (default on at 29.97 and 59.94 fps, where it is the norm; ignored at other rates). */
	dropFrame?: boolean;
}

/** Reel names are at most 8 characters, letters and digits. */
const reelName = (asset: VideoAsset | undefined) => (asset?.name ?? asset?.id ?? 'AX').replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) || 'AX';

/**
 * One track as a CMX 3600 edit decision list, for conforming in another NLE: an event per clip with
 * source and record timecode at the project's frame rate (drop-frame at 29.97 and 59.94), dissolves (`D`) for crossfades, dips and
 * wipes (`W001`), `M2` lines for speed changes, and `* FROM CLIP NAME` comments. Titles and colour
 * clips become black (`BL`) events.
 */
export function toVideoEdl(project: VideoProject, options: VideoEdlOptions = {}): string {
	const track = options.track !== undefined ? project.tracks.find((t) => t.id === options.track) : [...project.tracks].reverse().find((t) => t.kind === 'video');
	if (!track) throw new Error(options.track !== undefined ? `There is no track "${options.track}".` : 'The project has no video track.');
	const fps = project.fps;
	const dropFrame = (options.dropFrame ?? true) && isVideoDropFrameRate(fps);
	const tc = (ms: number) => formatVideoTimecode(ms, fps, dropFrame);
	// Record time counts from a timecode, not a clock time: an hour of 29.97 frames is not 01:00:00:00 in non-drop.
	const rec0 = options.recordStart !== undefined ? videoTimecodeFrames(options.recordStart, fps) : videoHourFrames(fps, dropFrame);
	const rtc = (ms: number) => formatVideoTimecodeFrames(rec0 + videoTimecodeFrames(ms, fps), fps, dropFrame);
	const assets = videoAssetMap(project);
	const channel = track.kind === 'video' ? 'V' : 'A';
	const lines = [`TITLE: ${(options.title ?? project.name ?? 'Untitled').toUpperCase()}`, `FCM: ${dropFrame ? 'DROP FRAME' : 'NON-DROP FRAME'}`, ''];
	let event = 0;
	const num = () => String(++event).padStart(3, '0');
	const sourceAt = (clip: VideoClip, time: number) => (clip.type === 'media' ? (clip.in ?? 0) + (time - clip.start) * videoClipSpeed(clip) : time - clip.start);
	const row = (n: string, reel: string, kind: string, srcIn: number, srcOut: number, recIn: number, recOut: number) =>
		`${n}  ${reel.padEnd(8)} ${channel.padEnd(5)} ${kind.padEnd(8)} ${tc(srcIn)} ${tc(srcOut)} ${rtc(recIn)} ${rtc(recOut)}`;
	for (const clip of sortedVideoClips(track)) {
		const asset = clip.type === 'media' ? assets.get(clip.asset) : undefined;
		const reel = clip.type === 'media' ? reelName(asset) : 'BL';
		const end = videoClipEnd(clip);
		const before = clip.transition ? videoClipBefore(track, clip) : null;
		// The cut moves to where the transition starts; this clip's event begins there.
		const half = before && clip.transition!.type !== 'dip' ? clip.transition!.duration / 2 : 0;
		const next = sortedVideoClips(track).find((c) => c !== clip && Math.abs(c.start - end) < 0.5 && c.transition && c.transition.type !== 'dip');
		const recOut = next ? end - next.transition!.duration / 2 : end;
		const recIn = clip.start - half;
		const n = num();
		if (before) {
			const t = clip.transition!;
			const frames = String(Math.round((t.duration * fps) / 1000)).padStart(3, '0');
			const outReel = before.type === 'media' ? reelName(assets.get(before.asset)) : 'BL';
			const at = sourceAt(before, recIn);
			lines.push(row(n, outReel, 'C', at, at, recIn, recIn));
			lines.push(row(n, reel, `${t.type === 'crossfade' || t.type === 'dip' ? 'D' : 'W001'}    ${frames}`, sourceAt(clip, recIn), sourceAt(clip, recOut), recIn, recOut));
		} else lines.push(row(n, reel, 'C', sourceAt(clip, recIn), sourceAt(clip, recOut), recIn, recOut));
		if (clip.type === 'media' && videoClipSpeed(clip) !== 1) lines.push(`M2   ${reel.padEnd(8)} ${(videoClipSpeed(clip) * fps).toFixed(1).padStart(6)}      ${tc(sourceAt(clip, recIn))}`);
		if (clip.type === 'media') lines.push(`* FROM CLIP NAME: ${asset?.name ?? asset?.src ?? clip.asset}`);
		if (clip.type === 'text') lines.push(`* TITLE: ${clip.text.replace(/\n/g, ' ')}`);
		if (clip.type === 'color') lines.push(`* COLOR: ${clip.color}`);
		lines.push('');
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------------------------

export interface VideoFfmpegOptions {
	/** Output file (default `output.mp4`). */
	output?: string;
	/** The path or URL ffmpeg should open for an asset (default its `src`). */
	resolve?: (asset: VideoAsset) => string;
	/** The path ffmpeg's `lut3d` should read for a grade's LUT `src` (default the `src`; it must be a local file). */
	resolveLut?: (src: string) => string;
	/** Default `libx264`. */
	videoCodec?: string;
	/** Default `aac`. */
	audioCodec?: string;
	/** x264 quality (default 18). */
	crf?: number;
	/** A font file for titles (drawtext's `fontfile`); default the system's font for the family. */
	fontFile?: string;
	/**
	 * Titles as images instead of `drawtext` (which needs an ffmpeg built with libfreetype; Homebrew's
	 * is not): return the path or URL of a transparent PNG the size of the frame showing the title as
	 * the preview draws it (`videoTitleFrame` + `drawVideoFrame`). It is overlaid like a still, with
	 * the title's opacity and fades.
	 */
	titleImage?: (clip: VideoTextClip, size: { width: number; height: number }) => string;
	/** Normalise the mix's loudness with ffmpeg's `loudnorm` (EBU R128). */
	loudness?: VideoLoudnessTarget;
}

/** A loudness to normalise the mix to (`loudnorm`'s I, TP and LRA). */
export interface VideoLoudnessTarget {
	/** Integrated loudness, in LUFS (default -14, as streaming services play; -16 for podcasts, -23 for EBU R128 broadcast). */
	integrated?: number;
	/** Highest true peak, in dBTP (default -1). */
	truePeak?: number;
	/** Loudness range, in LU (default 11). */
	range?: number;
	/**
	 * The mix as a first pass measured it (`toVideoLoudnessMeasure` then
	 * `parseVideoLoudnessMeasurement`). With it the second pass applies one fixed gain where it can
	 * (linear), so the dynamics are kept; without it `loudnorm` adjusts as it goes in one pass.
	 */
	measured?: VideoLoudnessMeasurement;
}

/** What a measuring pass found (`loudnorm`'s input_i, input_tp, input_lra, input_thresh and target_offset). */
export interface VideoLoudnessMeasurement {
	/** Integrated loudness (LUFS). */
	integrated: number;
	/** True peak (dBTP). */
	truePeak: number;
	/** Loudness range (LU). */
	range: number;
	/** Gating threshold (LUFS). */
	threshold: number;
	/** Offset for the second pass (LU). */
	offset: number;
}

/** `loudnorm` with a target, measuring (`print_format=json`) or applying a measurement; then back to 48 kHz (it outputs 192 kHz). */
function loudnormFilter(target: VideoLoudnessTarget = {}, measure = false): string {
	const I = target.integrated ?? -14;
	const TP = target.truePeak ?? -1;
	const LRA = target.range ?? 11;
	if (!(I >= -70 && I <= -5)) throw new Error(`The loudness target must be between -70 and -5 LUFS (got ${I}); -14 suits streaming, -23 broadcast.`);
	if (!(TP >= -9 && TP <= 0)) throw new Error(`The true peak ceiling must be between -9 and 0 dBTP (got ${TP}); -1 is usual.`);
	if (!(LRA >= 1 && LRA <= 50)) throw new Error(`The loudness range must be between 1 and 50 LU (got ${LRA}).`);
	const parts = [`loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`];
	const m = target.measured;
	if (m && !measure) {
		for (const [k, v] of Object.entries(m)) if (!Number.isFinite(v)) throw new Error(`The measured ${k} is not a number (${v}); measure again, or leave "measured" out for a one-pass normalisation.`);
		parts.push(`measured_I=${m.integrated}:measured_TP=${m.truePeak}:measured_LRA=${m.range}:measured_thresh=${m.threshold}:offset=${m.offset}:linear=true`);
	}
	if (measure) parts.push('print_format=json');
	return `${parts.join(':')},aresample=48000`;
}

/**
 * Reads the loudness a measuring pass printed (the JSON `loudnorm` writes to stderr at the end of
 * `toVideoLoudnessMeasure`'s command). Throws when there is none, or when the mix is silent.
 */
export function parseVideoLoudnessMeasurement(output: string): VideoLoudnessMeasurement {
	const blocks = output.match(/\{[^{}]*"input_i"[^{}]*\}/g);
	if (!blocks) throw new Error('No loudness measurement found: pass the stderr of the command from toVideoLoudnessMeasure.');
	const json = JSON.parse(blocks[blocks.length - 1]) as Record<string, string>;
	const n = (k: string) => Number(json[k]);
	const m = { integrated: n('input_i'), truePeak: n('input_tp'), range: n('input_lra'), threshold: n('input_thresh'), offset: n('target_offset') };
	if (!Number.isFinite(m.integrated)) throw new Error('The mix is silent, so its loudness cannot be normalised.');
	return m;
}

export interface VideoFfmpegExport {
	/** Arguments after `ffmpeg` (pass to `spawn('ffmpeg', args)`; no shell quoting needed). */
	args: string[];
	/** The same as one shell command line, quoted for a POSIX shell. */
	command: string;
	/** The `-filter_complex` graph on its own. */
	filterComplex: string;
	/** Length rendered (ms). */
	duration: number;
	/** Anything the render only approximates. */
	notes: string[];
}

const sec = (ms: number) => String(Math.round(ms) / 1000);
/** A number for an expression, to a hundredth. */
const fmtMs = (v: number) => String(Math.round(v * 100) / 100);
/** ffmpeg `blend` modes for the blend modes. */
const FFMPEG_BLEND: Record<Exclude<VideoBlendMode, 'normal'>, string> = {
	multiply: 'multiply',
	screen: 'screen',
	overlay: 'overlay',
	darken: 'darken',
	lighten: 'lighten',
	'color-dodge': 'dodge',
	'color-burn': 'burn',
	'hard-light': 'hardlight',
	'soft-light': 'softlight',
	difference: 'difference',
	exclusion: 'exclusion',
	add: 'addition'
};
/** `afade`'s curve for a fade shape (the same formulas as `videoFadeCurveGain`); nothing for linear, its default. */
const AFADE_CURVES: Record<VideoFadeCurve, string> = { linear: 'tri', 'equal-power': 'qsin', 's-curve': 'hsin', exponential: 'cub', logarithmic: 'ipar' };
const afadeCurve = (curve: VideoFadeCurve | undefined) => (curve && curve !== 'linear' ? `:curve=${AFADE_CURVES[curve]}` : '');
const even = (v: number) => Math.max(2, 2 * Math.round(v / 2));
/** Escapes a value for a filter option inside a filtergraph (option level, then graph level). */
export const ffmpegFilterValue = (s: string): string =>
	s
		.replace(/[\\':%]/g, (c) => `\\${c}`)
		.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
const color = (c: string) => {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
	if (!hex) return c.replace(/[^A-Za-z0-9@.]/g, '');
	const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join('') : hex[1];
	return `0x${h.slice(0, 6)}${h.length === 8 ? `@${(parseInt(h.slice(6), 16) / 255).toFixed(3)}` : ''}`;
};
/** Quotes an argument for a POSIX shell when it needs it. */
export const videoShellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** `atempo` only takes 0.5–2 (100 in newer builds), so larger changes chain several. */
function atempo(speed: number): string[] {
	const out: string[] = [];
	let s = speed;
	while (s > 2) {
		out.push('atempo=2');
		s /= 2;
	}
	while (s < 0.5) {
		out.push('atempo=0.5');
		s /= 0.5;
	}
	if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${Math.round(s * 1e6) / 1e6}`);
	return out;
}

/**
 * The project as an ffmpeg command: each clip an input trimmed to what it plays (plus transition
 * overlap), scaled and placed as `videoFrameAt` places it, faded, and overlaid on a background in
 * track order between its start and end; titles with `drawtext`; sound delayed into place, faded,
 * mixed and trimmed to the project's length. Render on a server or with ffmpeg.wasm.
 */
export function toVideoFfmpeg(project: VideoProject, options: VideoFfmpegOptions = {}): VideoFfmpegExport {
	return buildFfmpeg(project, options, false);
}

/**
 * The first pass of a two-pass loudness normalisation: an ffmpeg command that mixes only the sound,
 * as `toVideoFfmpeg` would, and prints its loudness as JSON on stderr instead of writing a file.
 * Read it with `parseVideoLoudnessMeasurement` and pass it as `loudness.measured` to
 * `toVideoFfmpeg`. Throws when nothing on the timeline makes a sound.
 */
export function toVideoLoudnessMeasure(project: VideoProject, options: Pick<VideoFfmpegOptions, 'resolve' | 'loudness'> = {}): VideoFfmpegExport {
	return buildFfmpeg(project, { ...options, loudness: { ...options.loudness, measured: undefined } }, true);
}

function buildFfmpeg(project: VideoProject, options: VideoFfmpegOptions, measure: boolean): VideoFfmpegExport {
	const notes: string[] = [];
	const assets = videoAssetMap(project);
	const D = videoProjectDuration(project);
	if (D <= 0) throw new Error('The project has no clips, so there is nothing to render.');
	const W = even(project.width);
	const H = even(project.height);
	const fps = project.fps;
	const inputs: string[][] = [];
	const graph: string[] = measure ? [] : [`color=c=${color(project.background ?? '#000000')}:s=${W}x${H}:r=${fps}:d=${sec(D)},format=yuva420p[base]`];
	const audio: string[] = [];
	let cur = 'base';
	let usesDrawtext = false;
	const animated = new Set<string>();
	const ramped = new Set<'sound'>();
	/**
	 * A ramped picture: each source frame moved to the clip time where the ramp first shows it (the
	 * ramp's inverse, as straight lines), `fps` repeating frames through slow stretches and freezes,
	 * and `tpad` holding the first and last frames before and after the ramp (and through handles).
	 */
	const rampedPicture = (remap: VideoKeyframes, lead: number, end: number): string[] => {
		const pts = videoTimeRemapBreakpoints(remap, 2000 / fps);
		const first = pts[0];
		const last = pts[pts.length - 1];
		const s = `(T*1000+${fmtMs(first.v)})`;
		let e = fmtMs(last.t - first.t);
		for (let i = pts.length - 2; i >= 0; i--) {
			const a = pts[i];
			const b = pts[i + 1];
			if (b.v - a.v < 1e-6) continue; // a freeze: its frames come from the next stretch
			e = `if(lt(${s},${fmtMs(b.v)}),${fmtMs(a.t - first.t)}+(${s}-${fmtMs(a.v)})*${fmtMs((b.t - a.t) / (b.v - a.v))},${e})`;
		}
		const before = lead + first.t;
		const after = Math.max(0, end - last.t);
		return ['setpts=PTS-STARTPTS', `setpts='(${e})/1000/TB'`, `fps=${fps}`, ...(before > 0.5 || after > 0.5 ? [`tpad=start_mode=clone:start_duration=${sec(before)}:stop_mode=clone:stop_duration=${sec(after + 1000 / fps)}`] : [`tpad=stop_mode=clone:stop_duration=${sec(1000 / fps)}`]), `trim=duration=${sec(lead + end)}`];
	};
	/**
	 * Ramped sound: the ramp cut into straight stretches, each played at its own speed with
	 * `atempo` (silence where it is frozen or slower than a tenth), joined with `concat`, with silence
	 * for the handles and holds around it. Gliding speed changes become small steps.
	 */
	const rampedSound = (remap: VideoKeyframes, input: string, output: string, lead: number, end: number): string[] => {
		const pts = videoTimeRemapBreakpoints(remap, Math.max(80, 2000 / fps));
		const first = pts[0];
		const last = pts[pts.length - 1];
		const n = audio.length;
		const fmtA = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
		const silence = (ms: number) => `anullsrc=r=48000:cl=stereo,atrim=duration=${sec(ms)},${fmtA}`;
		const pieces: string[] = [];
		const out: string[] = [];
		const parts: string[] = [];
		if (lead + first.t > 0.5) parts.push(silence(lead + first.t));
		const played: { from: number; to: number; speed: number }[] = [];
		for (let i = 0; i + 1 < pts.length; i++) {
			const dt = pts[i + 1].t - pts[i].t;
			if (dt < 0.5) continue;
			const speed = (pts[i + 1].v - pts[i].v) / dt;
			if (speed < 0.1) parts.push(silence(dt));
			else {
				played.push({ from: pts[i].v - first.v, to: pts[i + 1].v - first.v, speed });
				parts.push(`#${played.length - 1}`);
			}
		}
		if (end - last.t > 0.5) parts.push(silence(end - last.t));
		if (played.length) out.push(`[${input}]asplit=${played.length}${played.map((_, k) => `[r${n}s${k}]`).join('')}`);
		parts.forEach((p, k) => {
			const label = `[r${n}p${k}]`;
			if (p.startsWith('#')) {
				const piece = played[Number(p.slice(1))];
				out.push(`[r${n}s${p.slice(1)}]atrim=start=${sec(piece.from)}:end=${sec(piece.to)},asetpts=PTS-STARTPTS,${atempo(piece.speed).join(',') || 'anull'},${fmtA}${label}`);
			} else out.push(`${p}${label}`);
			pieces.push(label);
		});
		out.push(`${pieces.join('')}concat=n=${pieces.length}:v=0:a=1${output}`);
		return out;
	};
	const blended = new Set<VideoBlendMode>();
	let k = 0;
	// Keyframes become piecewise-linear expressions; eased segments get a breakpoint every two frames.
	const step = 2000 / fps;
	const expr = (prop: VideoAnimatable | undefined, clipTime: string, fallback: number, what: string) => {
		if (isVideoKeyframes(prop)) animated.add(what);
		return videoKeyframeFfmpegExpr(prop, clipTime, fallback, step);
	};
	const input = (clip: VideoClip & { type: 'media' }, asset: VideoAsset, lead: number, tail: number) => {
		const speed = videoClipSpeed(clip);
		const src = options.resolve ? options.resolve(asset) : asset.src;
		const span = clip.duration + lead + tail;
		if (asset.kind === 'image') inputs.push(['-loop', '1', '-framerate', String(fps), '-t', sec(span), '-i', src]);
		else if (clip.timeRemap) {
			// A ramp reads just the source it plays (plus a frame); it holds its ends for any handles.
			const { from, to } = videoTimeRemapSpan(clip.timeRemap);
			inputs.push(['-ss', sec((clip.in ?? 0) + from), '-t', sec(to - from + 1000 / fps), '-i', src]);
		} else inputs.push(['-ss', sec((clip.in ?? 0) - lead * speed), '-t', sec(span * speed), '-i', src]);
		return inputs.length - 1;
	};
	// Back to front: later tracks are further back.
	for (const track of [...project.tracks].reverse()) {
		for (const raw of sortedVideoClips(track)) {
			// Entrance and exit animations go out as keyframes on opacity and the transform.
			const clip = videoClipAnimated(raw, project);
			const { lead, tail } = videoClipOverhang(track, clip);
			const t0 = clip.start - lead;
			const span = clip.duration + lead + tail;
			const end = videoClipEnd(clip);
			const asset = clip.type === 'media' ? assets.get(clip.asset) : undefined;
			if (clip.type === 'media' && !asset) {
				notes.push(`Clip "${clip.id}" was left out: its asset "${clip.asset}" is missing.`);
				continue;
			}
			let index: number | undefined;
			if (!measure && asset && asset.kind !== 'audio' && track.kind === 'video' && !track.hidden) index = input(clip as VideoClip & { type: 'media' }, asset, lead, tail);
			const audible = videoAssetHasSound(asset);
			if (audible && clip.type === 'media' && !clip.muted && !track.muted) {
				const ai = index ?? input(clip, asset!, lead, tail);
				const trackGain = track.volume ?? 1;
				const volume = isVideoKeyframes(clip.volume) ? `volume='${trackGain}*(${expr(clip.volume, `(t*1000${lead ? `-${Math.round(lead)}` : ''})`, 1, 'volume')})':eval=frame` : `volume=${(clip.volume ?? 1) * trackGain}`;
				let source = `[${ai}:a]`;
				if (clip.timeRemap) {
					source = `[r${audio.length}]`;
					graph.push(...rampedSound(clip.timeRemap, `${ai}:a`, source, lead, clip.duration + tail));
					ramped.add('sound');
				}
				const chain = [...(clip.timeRemap ? [] : ['asetpts=PTS-STARTPTS', ...atempo(videoClipSpeed(clip))]), volume];
				const before = clip.transition ? videoClipBefore(track, clip) : null;
				const next = sortedVideoClips(track).find((c) => c !== clip && Math.abs(c.start - end) < 0.5 && c.transition);
				const inCurve = clip.transition ? afadeCurve(videoTransitionAudioCurve(clip.transition)) : '';
				const outCurve = next ? afadeCurve(videoTransitionAudioCurve(next.transition!)) : '';
				if (lead) chain.push(`afade=t=in:st=0:d=${sec(2 * lead)}${inCurve}`);
				if (tail) chain.push(`afade=t=out:st=${sec(span - 2 * tail)}:d=${sec(2 * tail)}${outCurve}`);
				if (before && clip.transition!.type === 'dip') chain.push(`afade=t=in:st=0:d=${sec(clip.transition!.duration / 2)}${inCurve}`);
				if (next?.transition!.type === 'dip') chain.push(`afade=t=out:st=${sec(span - next.transition!.duration / 2)}:d=${sec(next.transition!.duration / 2)}${outCurve}`);
				if (clip.fadeIn) chain.push(`afade=t=in:st=${sec(lead)}:d=${sec(clip.fadeIn)}${afadeCurve(clip.fadeInCurve)}`);
				if (clip.fadeOut) chain.push(`afade=t=out:st=${sec(lead + clip.duration - clip.fadeOut)}:d=${sec(clip.fadeOut)}${afadeCurve(clip.fadeOutCurve)}`);
				chain.push(`adelay=${Math.round(t0)}:all=1`);
				graph.push(`${source}${chain.join(',')}[a${audio.length}]`);
				audio.push(`[a${audio.length}]`);
			}
			if (measure || track.kind !== 'video' || track.hidden) continue;
			const enable = `enable='between(t,${sec(t0)},${sec(t0 + span)})'`;
			const next = `v${k++}`;
			// Clip time (ms) in a filter's `t`: timeline time on the composite, time from t0 on the clip's own chain.
			const onTimeline = `(t*1000-${Math.round(clip.start)})`;
			const onChain = (v: string) => `(${v}*1000${lead ? `-${Math.round(lead)}` : ''})`;
			const tf = clip.transform;
			const moving = VIDEO_TRANSFORM_PROPERTIES.some((p) => isVideoKeyframes(tf?.[p]));
			if (clip.type === 'text' && options.titleImage) {
				// A title image has its transform baked in, unless the transform moves: then the image is drawn unplaced and moved here.
				inputs.push(['-loop', '1', '-framerate', String(fps), '-t', sec(span), '-i', options.titleImage(moving ? { ...clip, transform: undefined } : clip, { width: project.width, height: project.height })]);
				index = inputs.length - 1;
			} else if (clip.type === 'text') {
				usesDrawtext = true;
				const op = isVideoKeyframes(clip.opacity) ? `clip(${expr(clip.opacity, onTimeline, 1, 'opacity')},0,1)` : String(clip.opacity ?? 1);
				const alpha = [op, clip.fadeIn ? `min(1,(t-${sec(clip.start)})/${sec(clip.fadeIn)})` : '', clip.fadeOut ? `min(1,(${sec(end)}-t)/${sec(clip.fadeOut)})` : ''].filter(Boolean).join('*');
				const coord = (axis: 'x' | 'y') => {
					const v = tf?.[axis];
					const base = `(${axis === 'x' ? 'w-text_w' : 'h-text_h'})/2`;
					return isVideoKeyframes(v) ? `${axis}='${base}+(${expr(v, onTimeline, 0, 'position')})'` : `${axis}=${base}+${v ?? 0}`;
				};
				const fontSize = clip.fontSize ?? 64;
				const opts = [
					`text=${ffmpegFilterValue(clip.text)}`,
					options.fontFile ? `fontfile=${ffmpegFilterValue(options.fontFile)}` : `font=${ffmpegFilterValue(clip.fontFamily ?? 'sans-serif')}`,
					isVideoKeyframes(tf?.scale) ? `fontsize='${fontSize}*(${expr(tf.scale, onTimeline, 1, 'scale')})'` : `fontsize=${Math.round(fontSize * ((tf?.scale as number | undefined) ?? 1))}`,
					`fontcolor=${color(clip.color ?? '#ffffff')}`,
					coord('x'),
					coord('y'),
					`alpha='${alpha}'`,
					...(clip.background ? ['box=1', `boxcolor=${color(clip.background)}`, `boxborderw=${Math.round((clip.fontSize ?? 64) / 2)}`] : []),
					`enable='between(t,${sec(clip.start)},${sec(end)})'`
				];
				if (tf?.rotation) notes.push(`Title "${clip.id}" is drawn without its rotation (drawtext cannot rotate).`);
				if (videoGradeFfmpegFilters(clip.grade).length || normalizeVideoGradeLut(clip.grade?.lut)) notes.push(`Title "${clip.id}" is drawn without its grade (drawtext draws straight onto the picture); pass titleImage to grade titles.`);
				if (clip.blend && clip.blend !== 'normal') notes.push(`Title "${clip.id}" is drawn without its blend mode (drawtext draws straight onto the picture); pass titleImage to blend titles.`);
				graph.push(`[${cur}]drawtext=${opts.join(':')}[${next}]`);
				cur = next;
				continue;
			}
			const size = asset ? { width: asset.width ?? project.width, height: asset.height ?? project.height } : { width: project.width, height: project.height };
			// A title image already has the title placed (and turned) in a full frame, unless its transform moves.
			const placed = clip.type === 'text' && !moving ? undefined : tf;
			// Keyframed fields are left out of the fitted rect and animated by the filters below.
			const still = Object.fromEntries(Object.entries(placed ?? {}).filter(([, v]) => !isVideoKeyframes(v)));
			const rect = placeVideoRect(project, size, clip.type === 'text' ? 'fill' : (clip.fit ?? (clip.type === 'media' ? 'contain' : 'fill')), still);
			const chain: string[] = [];
			let source: string;
			if (clip.type === 'color') source = `color=c=${color(clip.color)}:s=${even(rect.width)}x${even(rect.height)}:r=${fps}:d=${sec(span)}`;
			else {
				source = `[${index}:v]`;
				if (clip.type === 'media' && clip.timeRemap) chain.push(...rampedPicture(clip.timeRemap, lead, clip.duration + tail), `scale=${even(rect.width)}:${even(rect.height)}`);
				else chain.push(`setpts=${videoClipSpeed(clip) !== 1 ? `(PTS-STARTPTS)/${videoClipSpeed(clip)}` : 'PTS-STARTPTS'}`, `fps=${fps}`, `scale=${even(rect.width)}:${even(rect.height)}`);
			}
			const grade = videoGradeFfmpegFilters(clip.grade);
			if (grade.length) chain.push('format=rgba', ...grade);
			const lut = normalizeVideoGradeLut(clip.grade?.lut);
			if (lut) {
				// The LUT runs on planar RGB after the other steps; at part strength the graded picture is
				// split and the LUT's result laid over it at that opacity (a straight mix).
				chain.push('format=gbrap');
				const path = options.resolveLut ? options.resolveLut(lut.src) : lut.src;
				if (/^(blob|data|https?):/i.test(path)) notes.push(`ffmpeg's lut3d reads only local files, and clip "${clip.id}"'s LUT is "${path.slice(0, 80)}"; save it and pass resolveLut to give its path.`);
				const file = ffmpegFilterValue(path);
				const into = `q${next}`;
				graph.push(`${source.startsWith('[') ? source : `${source},`}${chain.join(',')}[${into}]`);
				const lut3d = `lut3d=file=${file}:interp=tetrahedral`;
				if ((lut.strength ?? 1) >= 1) graph.push(`[${into}]${lut3d}[r${next}]`);
				else graph.push(`[${into}]split[o${next}][p${next}]`, `[p${next}]${lut3d}[s${next}]`, `[s${next}][o${next}]blend=all_mode=normal:all_opacity=${lut.strength}[r${next}]`);
				source = `[r${next}]`;
				chain.length = 0;
			}
			chain.push('format=yuva420p');
			if (isVideoKeyframes(clip.opacity)) chain.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*clip(${expr(clip.opacity, onChain('T'), 1, 'opacity')},0,1)'`);
			else if (clip.opacity !== undefined && clip.opacity < 1) chain.push(`colorchannelmixer=aa=${clip.opacity}`);
			if (clip.fadeIn) chain.push(`fade=t=in:st=${sec(lead)}:d=${sec(clip.fadeIn)}:alpha=1`);
			if (clip.fadeOut) chain.push(`fade=t=out:st=${sec(lead + clip.duration - clip.fadeOut)}:d=${sec(clip.fadeOut)}:alpha=1`);
			if (lead && clip.transition!.type === 'crossfade') chain.push(`fade=t=in:st=0:d=${sec(2 * lead)}:alpha=1`);
			if (lead && clip.transition!.type === 'wipe') {
				const d = sec(2 * lead);
				const p = `min(1,T/${d})`;
				const dir = clip.transition!.direction ?? 'right';
				const test = dir === 'right' ? `lt(X,W*${p})` : dir === 'left' ? `gt(X,W*(1-${p}))` : dir === 'down' ? `lt(Y,H*${p})` : `gt(Y,H*(1-${p}))`;
				chain.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(${test},alpha(X,Y),0)'`);
			}
			if (lead && clip.transition!.type === 'iris') {
				// The circle is on the frame's centre: in the picture's own pixels, offset by where it sits.
				const r = videoIrisRadius({ width: W, height: H }, 1);
				chain.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lte(hypot(X+${Math.round(rect.x)}-${W / 2},Y+${Math.round(rect.y)}-${H / 2}),${Math.round(r)}*min(1,T/${sec(2 * lead)})),alpha(X,Y),0)'`);
			}
			const rotation = placed?.rotation;
			if (isVideoKeyframes(rotation)) chain.push(`rotate=a='(${expr(rotation, onChain('t'), 0, 'rotation')})*PI/180':c=black@0:ow='hypot(iw,ih)':oh=ow`);
			else if (rotation) chain.push(`rotate=${rotation}*PI/180:c=black@0:ow=rotw(${rotation}*PI/180):oh=roth(${rotation}*PI/180)`);
			// Animated scale goes last: geq and rotate keep the frame size they first see, so a size that
			// changes before them is frozen. Scaling the turned picture by iw / ih gives the same result.
			if (isVideoKeyframes(placed?.scale)) {
				const s = expr(placed.scale, onChain('t'), 1, 'scale');
				chain.push(`scale=w='max(2,trunc(iw*(${s})/2)*2)':h='max(2,trunc(ih*(${s})/2)*2)':eval=frame`);
			}
			chain.push(`setpts=PTS+${sec(t0)}/TB`);
			const cx = rect.x + rect.width / 2;
			const cy = rect.y + rect.height / 2;
			// Push and slide move the whole picture by a frame, eased as videoTransitionEase does.
			const shifts: Record<'x' | 'y', string[]> = { x: [], y: [] };
			const shiftBy = (direction: VideoWipeDirection | undefined, from: number, d: number, entering: boolean) => {
				const dir = direction ?? 'right';
				const axis = dir === 'left' || dir === 'right' ? 'x' : 'y';
				const size = axis === 'x' ? W : H;
				const sign = dir === 'left' || dir === 'up' ? -1 : 1;
				const ease = `(1-cos(PI*clip((t-${sec(from)})/${sec(d)},0,1)))/2`;
				shifts[axis].push(`${sign * size}*(${ease}${entering ? '-1' : ''})`);
			};
			const into = lead ? clip.transition!.type : undefined;
			if (into === 'push' || into === 'slide') shiftBy(clip.transition!.direction, clip.start - lead, 2 * lead, true);
			const after = tail ? sortedVideoClips(track).find((c) => c !== clip && Math.abs(c.start - end) < 0.5 && c.transition) : undefined;
			if (after?.transition!.type === 'push') shiftBy(after.transition!.direction, end - tail, 2 * tail, false);
			const at = (axis: 'x' | 'y', c: number) => {
				const v = placed?.[axis];
				const extra = shifts[axis].map((s) => `+${s}`).join('');
				return isVideoKeyframes(v) ? `${axis}='${Math.round(axis === 'x' ? project.width / 2 : project.height / 2)}+(${expr(v, onTimeline, 0, 'position')})-${axis === 'x' ? 'w' : 'h'}/2${extra}'` : `${axis}='${Math.round(c)}-${axis === 'x' ? 'w' : 'h'}/2${extra}'`;
			};
			graph.push(`${source.startsWith('[') ? source : `${source},`}${chain.join(',')}[l${next}]`);
			if (clip.blend && clip.blend !== 'normal') {
				// Place the layer on a transparent full frame, blend that with the composite in RGB, then
				// lay the blend over the composite through the layer's own alpha (its opacity and fades).
				graph.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${sec(D)},format=yuva420p[t${next}]`);
				graph.push(`[t${next}][l${next}]overlay=${at('x', cx)}:${at('y', cy)}:eof_action=pass:${enable},format=gbrap,split[f${next}][g${next}]`);
				graph.push(`[${cur}]format=gbrap,split[c${next}][d${next}]`);
				// ffmpeg's dodge and burn divide by the first ("top") input, the others test it: measured against
				// the CSS formulas, dodge and burn match with the layer first, the rest with the composite first.
				const layerFirst = clip.blend === 'color-dodge' || clip.blend === 'color-burn';
				graph.push(`${layerFirst ? `[f${next}][c${next}]` : `[c${next}][f${next}]`}blend=all_mode=${FFMPEG_BLEND[clip.blend]}[b${next}]`);
				graph.push(`[g${next}]alphaextract[m${next}]`);
				graph.push(`[b${next}][m${next}]alphamerge[x${next}]`);
				graph.push(`[d${next}][x${next}]overlay=format=gbrp,format=yuva420p[${next}]`);
				blended.add(clip.blend);
			} else graph.push(`[${cur}][l${next}]overlay=${at('x', cx)}:${at('y', cy)}:eof_action=pass:${enable}[${next}]`);
			cur = next;
			const before = clip.transition ? videoClipBefore(track, clip) : null;
			if (before && clip.transition!.type === 'dip') {
				const d = clip.transition!.duration;
				const dip = `d${k}`;
				graph.push(`color=c=${color(clip.transition!.color ?? '#000000')}:s=${W}x${H}:r=${fps}:d=${sec(d)},format=yuva420p,fade=t=in:st=0:d=${sec(d / 2)}:alpha=1,fade=t=out:st=${sec(d / 2)}:d=${sec(d / 2)}:alpha=1,setpts=PTS+${sec(clip.start - d / 2)}/TB[l${dip}]`);
				graph.push(`[${cur}][l${dip}]overlay=eof_action=pass:enable='between(t,${sec(clip.start - d / 2)},${sec(clip.start + d / 2)})'[${dip}]`);
				cur = dip;
			}
		}
	}
	if (!measure) graph.push(`[${cur}]format=yuv420p[vout]`);
	if (measure && !audio.length) throw new Error('Nothing on the timeline makes a sound, so there is no loudness to measure.');
	const loudness = options.loudness || measure ? `,${loudnormFilter(options.loudness, measure)}` : '';
	if (audio.length) graph.push(`${audio.join('')}amix=inputs=${audio.length}:normalize=0:duration=longest,apad,atrim=0:${sec(D)}${loudness}[aout]`);
	if (options.loudness && !audio.length) notes.push('Nothing makes a sound, so there was no loudness to normalise.');
	else if (options.loudness && !options.loudness.measured)
		notes.push('Loudness is normalised in one pass, which adjusts the level as it goes; for a fixed gain that keeps the dynamics, run toVideoLoudnessMeasure first and pass its result as loudness.measured.');
	if (project.tracks.some((t) => t.clips.some((c) => c.type === 'media' && assets.get(c.asset)?.kind === 'video' && assets.get(c.asset)?.hasAudio === undefined)))
		notes.push('Video assets are assumed to have sound; set "hasAudio": false on any that do not, or ffmpeg will stop at a missing audio stream.');
	if (animated.size)
		notes.push(`Keyframed ${[...animated].sort().join(', ')} ${animated.size > 1 ? 'are' : 'is'} rendered as straight lines between keys, with eased segments sampled every two frames${animated.has('scale') ? '; animated scale needs ffmpeg 5 or later (scale with eval=frame)' : ''}.`);
	if (blended.has('soft-light')) notes.push("ffmpeg's soft-light blend uses a slightly different formula from the browser's, so the render can differ a little from the preview.");
	if (ramped.has('sound')) notes.push('Sound through a speed ramp plays each stretch at its own speed, so a gliding change is heard in small steps (about every 80 ms), and freezes are silent.');
	if (usesDrawtext) notes.push('Titles use drawtext, which needs an ffmpeg built with libfreetype (Homebrew\'s is not: check `ffmpeg -filters | grep drawtext`); pass titleImage to render them as images instead.');
	const filterComplex = graph.join(';');
	if (measure) {
		const args = ['-hide_banner', '-nostats', ...inputs.flat(), '-filter_complex', filterComplex, '-map', '[aout]', '-f', 'null', '-'];
		return { args, command: ['ffmpeg', ...args].map(videoShellQuote).join(' '), filterComplex, duration: D, notes };
	}
	const args = [
		'-y',
		...inputs.flat(),
		'-filter_complex',
		filterComplex,
		'-map',
		'[vout]',
		...(audio.length ? ['-map', '[aout]', '-c:a', options.audioCodec ?? 'aac'] : ['-an']),
		'-c:v',
		options.videoCodec ?? 'libx264',
		...((options.videoCodec ?? 'libx264') === 'libx264' ? ['-crf', String(options.crf ?? 18), '-preset', 'medium'] : []),
		'-pix_fmt',
		'yuv420p',
		'-r',
		String(fps),
		'-t',
		sec(D),
		options.output ?? 'output.mp4'
	];
	return { args, command: ['ffmpeg', ...args].map(videoShellQuote).join(' '), filterComplex, duration: D, notes };
}
