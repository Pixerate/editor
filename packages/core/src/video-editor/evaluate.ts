import { videoClipAnimated } from './clip-animation.js';
import { normalizeVideoGrade } from './grade.js';
import { videoValueAt } from './keyframes.js';
import { sortedVideoClips, videoAssetMap, videoClipAfter, videoClipBefore, videoClipEnd, videoClipSpeed, videoAssetHasSound } from './timeline.js';
import { videoTransitionAudioCurve } from './types.js';
import type { VideoAsset, VideoBlendMode, VideoGrade, VideoClip, VideoFadeCurve, VideoFit, VideoProject, VideoTransition, VideoTextClip, VideoTrack, VideoWipeDirection } from './types.js';

/** A rectangle in frame pixels. */
export interface VideoRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** One picture in a frame, in draw order (first is at the back). */
export interface VideoLayer {
	/** The clip it comes from, or `transition:<clip>` for a dip's colour. */
	clip: string;
	track: string;
	type: VideoClip['type'];
	/** For media: the asset, its kind and `src`, and the moment of the source to show (ms). */
	asset?: string;
	assetKind?: VideoAsset['kind'];
	src?: string;
	sourceTime?: number;
	/** 0–1, after fades and transitions. */
	opacity: number;
	/** Where the fitted picture sits before rotation (its centre is the rotation centre). */
	rect: VideoRect;
	/** Degrees clockwise about the rect's centre. */
	rotation: number;
	/** For a wipe: the part shown is the `progress` (0–1) of the rect from the edge opposite `direction`. */
	wipe?: { direction: VideoWipeDirection; progress: number };
	/** For an iris: only a circle on the frame's centre shows, its radius `progress` (0–1) of the way to the frame's corners. */
	iris?: { progress: number };
	/** For text: what to draw. */
	text?: { text: string; color: string; fontSize: number; fontFamily: string; fontWeight: number; background?: string };
	/** For colour clips and dips. */
	color?: string;
	/** How it mixes with the layers beneath (absent = normal). */
	blend?: VideoBlendMode;
	/** Colour correction (absent = none). */
	grade?: VideoGrade;
}

/** One sound playing at a moment. */
export interface VideoAudioSource {
	clip: string;
	track: string;
	asset: string;
	src: string;
	/** The moment of the source playing (ms). */
	sourceTime: number;
	/** Gain after clip and track volume, fades and transitions (0 = silent). */
	gain: number;
	speed: number;
}

export interface VideoFrame {
	time: number;
	width: number;
	height: number;
	background: string;
	layers: VideoLayer[];
	audio: VideoAudioSource[];
}

/** A transform's values at clip-relative time `clipTime` (ms), keyframes resolved and defaults filled in. */
export function videoTransformAt(transform: VideoClip['transform'], clipTime = 0): { x: number; y: number; scale: number; rotation: number } {
	return { x: videoValueAt(transform?.x, clipTime, 0), y: videoValueAt(transform?.y, clipTime, 0), scale: videoValueAt(transform?.scale, clipTime, 1), rotation: videoValueAt(transform?.rotation, clipTime, 0) };
}

/** Places a picture of `size` in the frame by `fit`, then the clip's transform at clip-relative `clipTime` (ms). */
export function placeVideoRect(frame: { width: number; height: number }, size: { width: number; height: number }, fit: VideoFit = 'contain', transform: VideoClip['transform'] = {}, clipTime = 0): VideoRect {
	let w = size.width;
	let h = size.height;
	if (fit === 'fill') {
		w = frame.width;
		h = frame.height;
	} else if (fit !== 'none') {
		const k = fit === 'cover' ? Math.max(frame.width / w, frame.height / h) : Math.min(frame.width / w, frame.height / h);
		w *= k;
		h *= k;
	}
	const t = videoTransformAt(transform, clipTime);
	w *= t.scale;
	h *= t.scale;
	const cx = frame.width / 2 + t.x;
	const cy = frame.height / 2 + t.y;
	return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

/** A title's text and style with the defaults filled in. */
export function videoTextStyle(clip: VideoTextClip): NonNullable<VideoLayer['text']> {
	return { text: clip.text, color: clip.color ?? '#ffffff', fontSize: clip.fontSize ?? 64, fontFamily: clip.fontFamily ?? 'sans-serif', fontWeight: clip.fontWeight ?? 700, ...(clip.background ? { background: clip.background } : {}) };
}

/**
 * A frame holding only one title, fully opaque on a transparent background, placed as the preview
 * places it: draw it with `drawVideoFrame` and save the canvas as a PNG to give the ffmpeg export
 * titles without `drawtext` (`VideoFfmpegOptions.titleImage`). Fades and opacity are left to the export.
 * A keyframed transform is placed as it is at `clipTime` (the export passes titles with keyframed
 * transforms without them, and moves the image itself).
 */
export function videoTitleFrame(project: VideoProject, clip: VideoTextClip, clipTime = 0): VideoFrame {
	const layer: VideoLayer = { clip: clip.id, track: '', type: 'text', opacity: 1, rect: placeVideoRect(project, project, 'fill', clip.transform, clipTime), rotation: videoTransformAt(clip.transform, clipTime).rotation, text: videoTextStyle(clip) };
	return { time: clip.start, width: project.width, height: project.height, background: 'rgba(0,0,0,0)', layers: [layer], audio: [] };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** How far a push or slide has moved at `progress` (0–1): eased in and out, (1 − cos πp) / 2. */
export const videoTransitionEase = (progress: number): number => (1 - Math.cos(Math.PI * clamp01(progress))) / 2;

/** Gain of a fade shape `x` of the way up (0–1); a fade out uses the time left, so it mirrors the fade in. */
export function videoFadeCurveGain(curve: VideoFadeCurve | undefined, x: number): number {
	const t = clamp01(x);
	switch (curve) {
		case 'equal-power':
			return Math.sin((t * Math.PI) / 2);
		case 's-curve':
			return (1 - Math.cos(t * Math.PI)) / 2;
		case 'exponential':
			return t * t * t;
		case 'logarithmic':
			return 1 - (1 - t) * (1 - t);
		default:
			return t;
	}
}

/** Fade-in / fade-out multiplier for a clip at timeline `time`: linear for pictures, shaped for sound. */
function fadeGain(clip: VideoClip, time: number, sound = false): number {
	let g = 1;
	const shape = sound && clip.type === 'media' ? clip : undefined;
	if (clip.fadeIn) g *= videoFadeCurveGain(shape?.fadeInCurve, (time - clip.start) / clip.fadeIn);
	if (clip.fadeOut) g *= videoFadeCurveGain(shape?.fadeOutCurve, (videoClipEnd(clip) - time) / clip.fadeOut);
	return g;
}

/**
 * A media clip's own gain at clip time `clipTime` (ms): its volume (or volume keyframes) times its
 * shaped fades. Leaves out track volume and transitions, which depend on the timeline around it.
 */
export function videoClipSoundGain(clip: VideoClip, clipTime: number): number {
	const volume = clip.type === 'media' ? videoValueAt(clip.volume, clipTime, 1) : 1;
	return volume * fadeGain(clip, clip.start + Math.min(Math.max(clipTime, 0), clip.duration), true);
}

interface Active {
	clip: VideoClip;
	/** 0–1 mix through a transition (1 = fully this clip); undefined outside one. */
	incoming?: { progress: number; type: NonNullable<VideoClip['transition']>['type']; transition: NonNullable<VideoClip['transition']> };
	outgoing?: { progress: number; type: NonNullable<VideoClip['transition']>['type']; next: VideoClip };
}

/** The clips of a track playing at `time`, with any transition they are in (outgoing first). */
function activeOnTrack(track: VideoTrack, time: number): Active[] {
	const out: Active[] = [];
	for (const clip of sortedVideoClips(track)) {
		const before = clip.transition ? videoClipBefore(track, clip) : null;
		const lead = before ? clip.transition!.duration / 2 : 0;
		const next = videoClipAfter(track, clip);
		const tail = next?.transition ? next.transition.duration / 2 : 0;
		if (time < clip.start - lead || time >= videoClipEnd(clip) + tail) continue;
		const a: Active = { clip };
		if (lead && time < clip.start + lead) a.incoming = { progress: clamp01((time - (clip.start - lead)) / (2 * lead)), type: clip.transition!.type, transition: clip.transition! };
		if (tail && time >= videoClipEnd(clip) - tail) a.outgoing = { progress: clamp01((time - (videoClipEnd(clip) - tail)) / (2 * tail)), type: next!.transition!.type, next: next! };
		out.push(a);
	}
	return out;
}

const sourceTimeAt = (clip: VideoClip, time: number) => (clip.type === 'media' ? (clip.in ?? 0) + (time - clip.start) * videoClipSpeed(clip) : 0);

/**
 * What plays at `time` (ms): the pictures to draw, back to front, with their placement, opacity
 * and the moment of source each shows, and the sounds with their gain. A pure function of the
 * project and the time, so previews, exporters and agents all agree on every frame.
 */
export function videoFrameAt(project: VideoProject, time: number): VideoFrame {
	const assets = videoAssetMap(project);
	const layers: VideoLayer[] = [];
	const audio: VideoAudioSource[] = [];
	// Later tracks are further back, so draw from the last track to the first.
	for (let ti = project.tracks.length - 1; ti >= 0; ti--) {
		const track = project.tracks[ti];
		for (const { clip, incoming, outgoing } of activeOnTrack(track, time)) {
			// A dip plays the outgoing clip down into its colour and this one up out of it, so neither
			// runs past the cut (and needs no handles).
			if (incoming?.type === 'dip' && incoming.progress < 0.5) continue;
			if (outgoing?.type === 'dip' && outgoing.progress >= 0.5) continue;
			const inside = Math.min(Math.max(time, clip.start), videoClipEnd(clip));
			const fade = fadeGain(clip, inside);
			const level = (t: { type: string; progress: number }, transition: VideoTransition, into: boolean) =>
				videoFadeCurveGain(videoTransitionAudioCurve(transition), t.type === 'dip' ? Math.abs(1 - 2 * t.progress) : into ? t.progress : 1 - t.progress);
			// Sound crossfades through a crossfade or wipe (equal power by default), and dips with the picture.
			const mix = (incoming ? level(incoming, incoming.transition, true) : 1) * (outgoing ? level(outgoing, outgoing.next.transition!, false) : 1);
			const asset = clip.type === 'media' ? assets.get(clip.asset) : undefined;
			const sourceTime = sourceTimeAt(clip, time);
			// Keyframes are in clip time, held before the first key and after the last.
			const clipTime = time - clip.start;
			const audible = videoAssetHasSound(asset);
			if (audible && clip.type === 'media' && !clip.muted && !track.muted) {
				const gain = videoValueAt(clip.volume, clipTime, 1) * (track.volume ?? 1) * fadeGain(clip, inside, true) * mix;
				audio.push({ clip: clip.id, track: track.id, asset: asset!.id, src: asset!.src, sourceTime, gain, speed: videoClipSpeed(clip) });
			}
			if (track.kind !== 'video' || track.hidden) continue;
			if (clip.type === 'media' && (!asset || asset.kind === 'audio')) continue;
			// Entrance and exit animations are keyframes on the picture's opacity and transform.
			const shown = videoClipAnimated(clip, project);
			let opacity = videoValueAt(shown.opacity, clipTime, 1) * fade;
			let wipe: VideoLayer['wipe'];
			let dip: { color: string; opacity: number } | null = null;
			let iris: VideoLayer['iris'];
			// Push and slide move whole pictures by a frame, eased in and out.
			let shift = 0;
			let shiftDirection: VideoWipeDirection = 'right';
			if (incoming) {
				if (incoming.type === 'crossfade') opacity *= incoming.progress;
				else if (incoming.type === 'wipe') wipe = { direction: incoming.transition.direction ?? 'right', progress: incoming.progress };
				else if (incoming.type === 'iris') iris = { progress: incoming.progress };
				else if (incoming.type === 'push' || incoming.type === 'slide') {
					shiftDirection = incoming.transition.direction ?? 'right';
					shift = videoTransitionEase(incoming.progress) - 1;
				} else dip = { color: incoming.transition.color ?? '#000000', opacity: (1 - incoming.progress) * 2 };
			}
			if (outgoing?.type === 'dip') dip = { color: outgoing.next.transition!.color ?? '#000000', opacity: outgoing.progress * 2 };
			if (outgoing?.type === 'push') {
				shiftDirection = outgoing.next.transition!.direction ?? 'right';
				shift = videoTransitionEase(outgoing.progress);
			}
			const size = clip.type === 'media' ? { width: asset!.width ?? project.width, height: asset!.height ?? project.height } : { width: project.width, height: project.height };
			const fit = clip.fit ?? (clip.type === 'media' ? 'contain' : 'fill');
			const placed = placeVideoRect(project, size, clip.type === 'text' ? 'fill' : fit, shown.transform, clipTime);
			const across = shiftDirection === 'left' || shiftDirection === 'right';
			const sign = shiftDirection === 'left' || shiftDirection === 'up' ? -1 : 1;
			const rect = shift ? { ...placed, ...(across ? { x: placed.x + sign * shift * project.width } : { y: placed.y + sign * shift * project.height }) } : placed;
			const layer: VideoLayer = { clip: clip.id, track: track.id, type: clip.type, opacity: clamp01(opacity), rect, rotation: videoValueAt(shown.transform?.rotation, clipTime, 0) };
			if (wipe) layer.wipe = wipe;
			if (iris) layer.iris = iris;
			if (clip.blend && clip.blend !== 'normal') layer.blend = clip.blend;
			const grade = normalizeVideoGrade(clip.grade);
			if (grade) layer.grade = grade;
			if (clip.type === 'media') Object.assign(layer, { asset: asset!.id, assetKind: asset!.kind, src: asset!.src, sourceTime });
			if (clip.type === 'text') layer.text = videoTextStyle(clip);
			if (clip.type === 'color') layer.color = clip.color;
			if (layer.opacity > 0) layers.push(layer);
			if (dip && dip.opacity > 0) layers.push({ clip: `transition:${incoming ? clip.id : outgoing!.next.id}`, track: track.id, type: 'color', color: dip.color, opacity: clamp01(dip.opacity), rect: { x: 0, y: 0, width: project.width, height: project.height }, rotation: 0 });
		}
	}
	return { time, width: project.width, height: project.height, background: project.background ?? '#000000', layers, audio };
}
