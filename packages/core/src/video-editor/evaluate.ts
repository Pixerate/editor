import { sortedVideoClips, videoAssetMap, videoClipAfter, videoClipBefore, videoClipEnd, videoClipSpeed } from './timeline.js';
import type { VideoAsset, VideoClip, VideoFit, VideoProject, VideoTrack, VideoWipeDirection } from './types.js';

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
	/** For text: what to draw. */
	text?: { text: string; color: string; fontSize: number; fontFamily: string; fontWeight: number; background?: string };
	/** For colour clips and dips. */
	color?: string;
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

/** Places a picture of `size` in the frame by `fit`, then the clip's transform. */
export function placeVideoRect(frame: { width: number; height: number }, size: { width: number; height: number }, fit: VideoFit = 'contain', transform: VideoClip['transform'] = {}): VideoRect {
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
	const scale = transform?.scale ?? 1;
	w *= scale;
	h *= scale;
	const cx = frame.width / 2 + (transform?.x ?? 0);
	const cy = frame.height / 2 + (transform?.y ?? 0);
	return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Fade-in / fade-out multiplier for a clip at timeline `time`. */
function fadeGain(clip: VideoClip, time: number): number {
	let g = 1;
	if (clip.fadeIn) g *= clamp01((time - clip.start) / clip.fadeIn);
	if (clip.fadeOut) g *= clamp01((videoClipEnd(clip) - time) / clip.fadeOut);
	return g;
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
			const fade = fadeGain(clip, Math.min(Math.max(time, clip.start), videoClipEnd(clip)));
			const level = (t: { type: string; progress: number }, into: boolean) => (t.type === 'dip' ? Math.abs(1 - 2 * t.progress) : into ? t.progress : 1 - t.progress);
			// Sound crossfades through a crossfade or wipe, and dips with the picture.
			const mix = (incoming ? level(incoming, true) : 1) * (outgoing ? level(outgoing, false) : 1);
			const asset = clip.type === 'media' ? assets.get(clip.asset) : undefined;
			const sourceTime = sourceTimeAt(clip, time);
			const audible = asset && (asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio !== false));
			if (audible && clip.type === 'media' && !clip.muted && !track.muted) {
				const gain = (clip.volume ?? 1) * (track.volume ?? 1) * fade * mix;
				audio.push({ clip: clip.id, track: track.id, asset: asset!.id, src: asset!.src, sourceTime, gain, speed: videoClipSpeed(clip) });
			}
			if (track.kind !== 'video' || track.hidden) continue;
			if (clip.type === 'media' && (!asset || asset.kind === 'audio')) continue;
			let opacity = (clip.opacity ?? 1) * fade;
			let wipe: VideoLayer['wipe'];
			let dip: { color: string; opacity: number } | null = null;
			if (incoming) {
				if (incoming.type === 'crossfade') opacity *= incoming.progress;
				else if (incoming.type === 'wipe') wipe = { direction: incoming.transition.direction ?? 'right', progress: incoming.progress };
				else dip = { color: incoming.transition.color ?? '#000000', opacity: (1 - incoming.progress) * 2 };
			}
			if (outgoing?.type === 'dip') dip = { color: outgoing.next.transition!.color ?? '#000000', opacity: outgoing.progress * 2 };
			const size = clip.type === 'media' ? { width: asset!.width ?? project.width, height: asset!.height ?? project.height } : { width: project.width, height: project.height };
			const fit = clip.fit ?? (clip.type === 'media' ? 'contain' : 'fill');
			const rect = clip.type === 'text' ? placeVideoRect(project, size, 'fill', clip.transform) : placeVideoRect(project, size, fit, clip.transform);
			const layer: VideoLayer = { clip: clip.id, track: track.id, type: clip.type, opacity: clamp01(opacity), rect, rotation: clip.transform?.rotation ?? 0 };
			if (wipe) layer.wipe = wipe;
			if (clip.type === 'media') Object.assign(layer, { asset: asset!.id, assetKind: asset!.kind, src: asset!.src, sourceTime });
			if (clip.type === 'text') layer.text = { text: clip.text, color: clip.color ?? '#ffffff', fontSize: clip.fontSize ?? 64, fontFamily: clip.fontFamily ?? 'sans-serif', fontWeight: clip.fontWeight ?? 700, ...(clip.background ? { background: clip.background } : {}) };
			if (clip.type === 'color') layer.color = clip.color;
			if (layer.opacity > 0) layers.push(layer);
			if (dip && dip.opacity > 0) layers.push({ clip: `transition:${incoming ? clip.id : outgoing!.next.id}`, track: track.id, type: 'color', color: dip.color, opacity: clamp01(dip.opacity), rect: { x: 0, y: 0, width: project.width, height: project.height }, rotation: 0 });
		}
	}
	return { time, width: project.width, height: project.height, background: project.background ?? '#000000', layers, audio };
}
