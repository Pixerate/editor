import { placeVideoRect } from './evaluate.js';
import { isVideoKeyframes, VIDEO_TRANSFORM_PROPERTIES, videoKeyframeFfmpegExpr, type VideoAnimatable } from './keyframes.js';
import { formatVideoTimecode, formatVideoTimecodeFrames, isVideoDropFrameRate, videoHourFrames, videoTimecodeFrames, sortedVideoClips, videoAssetMap, videoClipBefore, videoClipEnd, videoClipOverhang, videoClipSpeed, videoProjectDuration } from './timeline.js';
import type { VideoAsset, VideoClip, VideoFadeCurve, VideoProject, VideoTextClip, VideoTrack } from './types.js';

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
			lines.push(row(n, reel, `${t.type === 'wipe' ? 'W001' : 'D'}    ${frames}`, sourceAt(clip, recIn), sourceAt(clip, recOut), recIn, recOut));
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
const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

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
	const notes: string[] = [];
	const assets = videoAssetMap(project);
	const D = videoProjectDuration(project);
	if (D <= 0) throw new Error('The project has no clips, so there is nothing to render.');
	const W = even(project.width);
	const H = even(project.height);
	const fps = project.fps;
	const inputs: string[][] = [];
	const graph: string[] = [`color=c=${color(project.background ?? '#000000')}:s=${W}x${H}:r=${fps}:d=${sec(D)},format=yuva420p[base]`];
	const audio: string[] = [];
	let cur = 'base';
	let usesDrawtext = false;
	const animated = new Set<string>();
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
		else inputs.push(['-ss', sec((clip.in ?? 0) - lead * speed), '-t', sec(span * speed), '-i', src]);
		return inputs.length - 1;
	};
	// Back to front: later tracks are further back.
	for (const track of [...project.tracks].reverse()) {
		for (const clip of sortedVideoClips(track)) {
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
			if (asset && asset.kind !== 'audio' && track.kind === 'video' && !track.hidden) index = input(clip as VideoClip & { type: 'media' }, asset, lead, tail);
			const audible = asset && (asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio !== false));
			if (audible && clip.type === 'media' && !clip.muted && !track.muted) {
				const ai = index ?? input(clip, asset!, lead, tail);
				const trackGain = track.volume ?? 1;
				const volume = isVideoKeyframes(clip.volume) ? `volume='${trackGain}*(${expr(clip.volume, `(t*1000${lead ? `-${Math.round(lead)}` : ''})`, 1, 'volume')})':eval=frame` : `volume=${(clip.volume ?? 1) * trackGain}`;
				const chain = ['asetpts=PTS-STARTPTS', ...atempo(videoClipSpeed(clip)), volume];
				const before = clip.transition ? videoClipBefore(track, clip) : null;
				if (lead) chain.push(`afade=t=in:st=0:d=${sec(2 * lead)}`);
				if (tail) chain.push(`afade=t=out:st=${sec(span - 2 * tail)}:d=${sec(2 * tail)}`);
				if (before && clip.transition!.type === 'dip') chain.push(`afade=t=in:st=0:d=${sec(clip.transition!.duration / 2)}`);
				const after = sortedVideoClips(track).find((c) => c !== clip && Math.abs(c.start - end) < 0.5 && c.transition?.type === 'dip');
				if (after) chain.push(`afade=t=out:st=${sec(span - after.transition!.duration / 2)}:d=${sec(after.transition!.duration / 2)}`);
				if (clip.fadeIn) chain.push(`afade=t=in:st=${sec(lead)}:d=${sec(clip.fadeIn)}${afadeCurve(clip.fadeInCurve)}`);
				if (clip.fadeOut) chain.push(`afade=t=out:st=${sec(lead + clip.duration - clip.fadeOut)}:d=${sec(clip.fadeOut)}${afadeCurve(clip.fadeOutCurve)}`);
				chain.push(`adelay=${Math.round(t0)}:all=1`);
				graph.push(`[${ai}:a]${chain.join(',')}[a${audio.length}]`);
				audio.push(`[a${audio.length}]`);
			}
			if (track.kind !== 'video' || track.hidden) continue;
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
				chain.push(`setpts=${videoClipSpeed(clip) !== 1 ? `(PTS-STARTPTS)/${videoClipSpeed(clip)}` : 'PTS-STARTPTS'}`, `fps=${fps}`, `scale=${even(rect.width)}:${even(rect.height)}`);
			}
			if (isVideoKeyframes(placed?.scale)) {
				const s = expr(placed.scale, onChain('t'), 1, 'scale');
				chain.push(`scale=w='max(2,trunc(${even(rect.width)}*(${s})/2)*2)':h='max(2,trunc(${even(rect.height)}*(${s})/2)*2)':eval=frame`);
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
			const rotation = placed?.rotation;
			if (isVideoKeyframes(rotation)) chain.push(`rotate=a='(${expr(rotation, onChain('t'), 0, 'rotation')})*PI/180':c=none:ow='hypot(iw,ih)':oh=ow`);
			else if (rotation) chain.push(`rotate=${rotation}*PI/180:c=none:ow=rotw(${rotation}*PI/180):oh=roth(${rotation}*PI/180)`);
			chain.push(`setpts=PTS+${sec(t0)}/TB`);
			const cx = rect.x + rect.width / 2;
			const cy = rect.y + rect.height / 2;
			const at = (axis: 'x' | 'y', c: number) => {
				const v = placed?.[axis];
				return isVideoKeyframes(v) ? `${axis}='${Math.round(axis === 'x' ? project.width / 2 : project.height / 2)}+(${expr(v, onTimeline, 0, 'position')})-${axis === 'x' ? 'w' : 'h'}/2'` : `${axis}='${Math.round(c)}-${axis === 'x' ? 'w' : 'h'}/2'`;
			};
			graph.push(`${source.startsWith('[') ? source : `${source},`}${chain.join(',')}[l${next}]`);
			graph.push(`[${cur}][l${next}]overlay=${at('x', cx)}:${at('y', cy)}:eof_action=pass:${enable}[${next}]`);
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
	graph.push(`[${cur}]format=yuv420p[vout]`);
	if (audio.length) graph.push(`${audio.join('')}amix=inputs=${audio.length}:normalize=0:duration=longest,apad,atrim=0:${sec(D)}[aout]`);
	if (project.tracks.some((t) => t.clips.some((c) => c.type === 'media' && assets.get(c.asset)?.kind === 'video' && assets.get(c.asset)?.hasAudio === undefined)))
		notes.push('Video assets are assumed to have sound; set "hasAudio": false on any that do not, or ffmpeg will stop at a missing audio stream.');
	if (animated.size)
		notes.push(`Keyframed ${[...animated].sort().join(', ')} ${animated.size > 1 ? 'are' : 'is'} rendered as straight lines between keys, with eased segments sampled every two frames${animated.has('scale') ? '; animated scale needs ffmpeg 5 or later (scale with eval=frame)' : ''}.`);
	if (usesDrawtext) notes.push('Titles use drawtext, which needs an ffmpeg built with libfreetype (Homebrew\'s is not: check `ffmpeg -filters | grep drawtext`); pass titleImage to render them as images instead.');
	const filterComplex = graph.join(';');
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
	return { args, command: ['ffmpeg', ...args].map(shellQuote).join(' '), filterComplex, duration: D, notes };
}
