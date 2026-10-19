import type { VideoEdit } from './edit.js';
import { isVideoKeyframes, removeVideoKey, setVideoKey, VIDEO_KEYFRAME_LIMITS, VIDEO_TRANSFORM_PROPERTIES, videoValueAt, type VideoAnimatable, type VideoKeyframeProperty } from './keyframes.js';
import { findVideoClip, formatVideoTimecode, videoClipEnd, videoClipSpeed, videoAssetMap, videoAssetHasSound } from './timeline.js';
import type { VideoTransitionType, VideoAsset, VideoAssetKind, VideoBlendMode, VideoClip, VideoFadeCurve, VideoPlacementMode, VideoProject } from './types.js';

// Framework-free helpers the React and Svelte timelines share, so both draw and drag alike.

export interface VideoRulerTick {
	time: number;
	/** Pixels from the timeline's left edge. */
	x: number;
	/** Major ticks carry a label. */
	major: boolean;
	label?: string;
}

const STEPS = [40, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];

/** Ruler ticks for `[0, duration]` at `pxPerSecond`: a major tick at least every ~80 px, labelled with timecode. */
export function videoRulerTicks(duration: number, pxPerSecond: number, fps: number): VideoRulerTick[] {
	const pxPerMs = pxPerSecond / 1000;
	const major = STEPS.find((s) => s * pxPerMs >= 80) ?? STEPS[STEPS.length - 1];
	const minor = STEPS.slice()
		.reverse()
		.find((s) => s < major && major % s === 0 && s * pxPerMs >= 10);
	const step = minor ?? major;
	const ticks: VideoRulerTick[] = [];
	for (let t = 0; t <= duration + 1e-6; t += step) {
		const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-9;
		ticks.push({ time: t, x: t * pxPerMs, major: isMajor, ...(isMajor ? { label: formatVideoTimecode(t, fps).replace(/^00:/, '') } : {}) });
	}
	return ticks;
}

/** Fill colour a timeline uses for a clip, by what it is. */
/** Which clips a timeline draws waveforms in: audio files only (default), anything with sound, or none. */
export type VideoWaveformMode = 'audio' | 'all' | 'none';

/** Whether a timeline in `mode` draws a waveform in this clip. */
export function videoClipShowsWaveform(clip: VideoClip, asset: VideoAsset | undefined, mode: VideoWaveformMode = 'audio'): asset is VideoAsset {
	if (clip.type !== 'media' || mode === 'none' || !videoAssetHasSound(asset)) return false;
	return mode === 'all' || asset!.kind === 'audio';
}

/** Names for the transitions, for menus. */
export const VIDEO_TRANSITION_LABELS: Readonly<Record<VideoTransitionType, string>> = {
	crossfade: 'Crossfade',
	dip: 'Dip to colour',
	wipe: 'Wipe',
	push: 'Push',
	slide: 'Slide',
	iris: 'Iris'
};

/** Whether a transition type takes a `direction`. */
export const videoTransitionHasDirection = (type: VideoTransitionType): boolean => type === 'wipe' || type === 'push' || type === 'slide';

/** Names for the blend modes, for menus. */
export const VIDEO_BLEND_MODE_LABELS: Readonly<Record<VideoBlendMode, string>> = {
	normal: 'Normal',
	multiply: 'Multiply',
	screen: 'Screen',
	overlay: 'Overlay',
	darken: 'Darken',
	lighten: 'Lighten',
	'color-dodge': 'Colour dodge',
	'color-burn': 'Colour burn',
	'hard-light': 'Hard light',
	'soft-light': 'Soft light',
	difference: 'Difference',
	exclusion: 'Exclusion',
	add: 'Add'
};

/** Names for the sound fade curves, for menus. */
export const VIDEO_FADE_CURVE_LABELS: Readonly<Record<VideoFadeCurve, string>> = {
	linear: 'Linear',
	'equal-power': 'Equal power',
	's-curve': 'S-curve',
	exponential: 'Exponential',
	logarithmic: 'Logarithmic'
};

export function videoClipTint(clip: VideoClip, asset?: VideoAsset): string {
	if (clip.type === 'text') return '#a855f7';
	if (clip.type === 'color') return clip.color;
	if (!asset) return '#ef4444';
	return asset.kind === 'audio' ? '#10b981' : asset.kind === 'image' ? '#f59e0b' : '#3b82f6';
}

/** A short label for a clip on the timeline. */
export function videoClipLabel(clip: VideoClip, asset?: VideoAsset): string {
	if (clip.name) return clip.name;
	if (clip.type === 'text') return clip.text.split('\n')[0];
	if (clip.type === 'color') return clip.color;
	const base = asset?.name ?? asset?.src.replace(/^.*[\\/]/, '') ?? clip.asset;
	const speed = videoClipSpeed(clip);
	return speed !== 1 ? `${base} (${Math.round(speed * 100)}%)` : base;
}

export type VideoClipDragMode = 'move' | 'trim-start' | 'trim-end';

export interface VideoClipDragInput {
	clip: string;
	mode: VideoClipDragMode;
	/** How far the pointer moved along the timeline (ms). */
	delta: number;
	/** For move: the track under the pointer (default the clip's own). */
	track?: string;
	/** Push later clips along instead of refusing overlaps (trims) — hold a modifier for it. */
	ripple?: boolean;
	/**
	 * For move: what to do with clips where it lands (default refuse). The timelines use Alt for
	 * insert and Shift for overwrite.
	 */
	placement?: VideoPlacementMode;
	/** Snaps a time (e.g. `controller.snap(t, { exclude: [clip] }).time`); default: none. */
	snap?: (time: number) => number;
}

export interface VideoClipDragPlan {
	/** Where the clip would be: draw this while dragging. */
	start: number;
	duration: number;
	track: string;
	/** The edit to apply on release (`null` when nothing changed). */
	edit: VideoEdit | null;
}

/**
 * What dragging a clip (or one of its edges) by `delta` would do: the clip's new place for drawing
 * while the pointer moves, and the edit to apply on release. Moves snap the edge nearer a snap
 * point; trims snap the edge being dragged. The edit is checked when it is applied, so an overlap
 * or a trim past the source is refused then (with the reason in the editor's state).
 */
export function planVideoClipDrag(project: VideoProject, input: VideoClipDragInput): VideoClipDragPlan | null {
	const at = findVideoClip(project, input.clip);
	if (!at) return null;
	const { clip, track } = at;
	const snap = input.snap ?? ((t: number) => t);
	if (input.mode === 'move') {
		const raw = Math.max(0, clip.start + input.delta);
		// Whichever edge snapped by less wins; an edge that did not snap does not count.
		const head = snap(raw) - raw;
		const tail = snap(raw + clip.duration) - (raw + clip.duration);
		const shifts = [head, tail].filter((d) => Math.abs(d) > 1e-9);
		const start = Math.max(0, raw + (shifts.length ? shifts.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a)) : 0));
		const target = input.track ?? track.id;
		const moved = Math.abs(start - clip.start) > 1e-6 || target !== track.id;
		const mode = input.placement && input.placement !== 'refuse' ? { mode: input.placement } : {};
		return { start, duration: clip.duration, track: target, edit: moved ? { op: 'move_clip', clip: clip.id, start, ...(target !== track.id ? { track: target } : {}), ...mode } : null };
	}
	const minimum = 1000 / project.fps;
	if (input.mode === 'trim-start') {
		const to = Math.min(snap(Math.max(0, clip.start + input.delta)), videoClipEnd(clip) - minimum);
		const changed = Math.abs(to - clip.start) > 1e-6;
		const plan = input.ripple ? { start: clip.start, duration: clip.duration - (to - clip.start) } : { start: to, duration: videoClipEnd(clip) - to };
		return { ...plan, track: track.id, edit: changed ? { op: 'trim_clip', clip: clip.id, edge: 'start', to, ...(input.ripple ? { ripple: true } : {}) } : null };
	}
	const to = Math.max(snap(videoClipEnd(clip) + input.delta), clip.start + minimum);
	const changed = Math.abs(to - videoClipEnd(clip)) > 1e-6;
	return { start: clip.start, duration: to - clip.start, track: track.id, edit: changed ? { op: 'trim_clip', clip: clip.id, edge: 'end', to, ...(input.ripple ? { ripple: true } : {}) } : null };
}

/** Tracks a clip may be dragged onto: the same kind as its own, unlocked. */
export function videoDropTracks(project: VideoProject, clipId: string): string[] {
	const at = findVideoClip(project, clipId);
	if (!at) return [];
	return project.tracks.filter((t) => t.kind === at.track.kind && !t.locked).map((t) => t.id);
}

/** The label for the undo step a drag makes. */
export function videoDragLabel(edit: VideoEdit): string {
	if (edit.op === 'move_clip') return edit.mode === 'insert' ? 'Insert clip' : edit.mode === 'overwrite' ? 'Overwrite clip' : 'Move clip';
	return edit.op === 'trim_clip' && edit.ripple ? 'Ripple trim' : 'Trim clip';
}

/** The edit that adds an asset as a clip where the person dropped it (or at the end of the first fitting track). */
export function videoAssetDropEdit(project: VideoProject, assetId: string, options: { track?: string; start?: number; ripple?: boolean; mode?: VideoPlacementMode } = {}): VideoEdit | null {
	const asset = videoAssetMap(project).get(assetId);
	if (!asset) return null;
	const kind = asset.kind === 'audio' ? 'audio' : 'video';
	const track = options.track ?? project.tracks.find((t) => t.kind === kind && !t.locked)?.id;
	if (!track) return null;
	return { op: 'add_clip', track, clip: { type: 'media', asset: asset.id, ...(options.start !== undefined ? { start: options.start } : {}) }, ...(options.ripple ? { ripple: true } : {}), ...(options.mode && options.mode !== 'refuse' ? { mode: options.mode } : {}) };
}

/** What `probeVideoMedia` found out about a file. */
export interface VideoMediaProbe {
	kind: VideoAssetKind;
	duration?: number;
	width?: number;
	height?: number;
}

/** The asset kind for a MIME type or file name, or `null` when it is not media. */
export function videoAssetKindOf(typeOrName: string): VideoAssetKind | null {
	// URLs may carry a query or hash after the extension (`song.mp3?v=2`).
	const s = typeOrName.toLowerCase().replace(/[?#].*$/, '');
	if (s.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|mkv)$/.test(s)) return 'video';
	if (s.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus)$/.test(s)) return 'audio';
	if (s.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/.test(s)) return 'image';
	return null;
}

/**
 * Reads a media file's length and size in the browser by loading its metadata into a detached
 * `<video>`, `<audio>` or `<img>`. Rejects with a readable error when it cannot be loaded.
 */
export function probeVideoMedia(src: string, kind: VideoAssetKind, timeout = 15000): Promise<VideoMediaProbe> {
	return new Promise((resolve, reject) => {
		if (typeof document === 'undefined') return reject(new Error('Media can only be probed in a browser.'));
		const timer = setTimeout(() => reject(new Error(`"${src}" took too long to load.`)), timeout);
		const done = (probe: VideoMediaProbe) => {
			clearTimeout(timer);
			resolve(probe);
		};
		const failed = () => {
			clearTimeout(timer);
			reject(new Error(`"${src}" could not be loaded as ${kind}.`));
		};
		if (kind === 'image') {
			const img = new Image();
			img.onload = () => done({ kind, width: img.naturalWidth, height: img.naturalHeight });
			img.onerror = failed;
			img.src = src;
			return;
		}
		const el = document.createElement(kind);
		el.preload = 'metadata';
		el.onloadedmetadata = () => {
			const duration = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : undefined;
			const v = el as HTMLVideoElement;
			done({ kind, ...(duration ? { duration } : {}), ...(kind === 'video' && v.videoWidth ? { width: v.videoWidth, height: v.videoHeight } : {}) });
		};
		el.onerror = failed;
		el.src = src;
	});
}

// ---------------------------------------------------------------------------------------------
// Keyframes in an inspector
// ---------------------------------------------------------------------------------------------

const KEY_LABELS: Record<VideoKeyframeProperty, { label: string; step: number }> = {
	opacity: { label: 'Opacity', step: 0.05 },
	volume: { label: 'Volume', step: 0.05 },
	x: { label: 'X', step: 1 },
	y: { label: 'Y', step: 1 },
	scale: { label: 'Scale', step: 0.05 },
	rotation: { label: 'Rotation', step: 1 }
};

/** One animatable property of a clip as an inspector shows it at the playhead. */
export interface VideoKeyframeRow {
	property: VideoKeyframeProperty;
	label: string;
	/** Its value at the playhead (the playhead held inside the clip). */
	value: number;
	/** Whether it has keyframes. */
	keyed: boolean;
	/** How many keys it has. */
	keys: number;
	/** Whether a key sits at the playhead. */
	onKey: boolean;
	/** The playhead in clip time (ms), where new keys go. */
	clipTime: number;
	step: number;
	min?: number;
	max?: number;
}

const animatableOf = (clip: VideoClip, property: VideoKeyframeProperty): VideoAnimatable | undefined =>
	(VIDEO_TRANSFORM_PROPERTIES as readonly string[]).includes(property) ? clip.transform?.[property as 'x'] : property === 'volume' ? (clip.type === 'media' ? clip.volume : undefined) : clip.opacity;

const playheadInClip = (clip: VideoClip, time: number) => Math.round(Math.min(clip.duration, Math.max(0, time - clip.start)));

/**
 * The clip's animatable properties for an inspector at timeline `time`: opacity and the transform
 * for pictures, volume for sound, each with its value there and whether it is keyed.
 */
export function videoKeyframeRows(project: VideoProject, clipId: string, time: number): VideoKeyframeRow[] {
	const at = findVideoClip(project, clipId);
	if (!at) return [];
	const { clip } = at;
	const asset = clip.type === 'media' ? videoAssetMap(project).get(clip.asset) : undefined;
	const visual = !(asset?.kind === 'audio' || at.track.kind === 'audio');
	const audible = clip.type === 'media' && videoAssetHasSound(asset);
	const properties: VideoKeyframeProperty[] = [...(visual ? (['opacity'] as const) : []), ...(audible ? (['volume'] as const) : []), ...(visual ? VIDEO_TRANSFORM_PROPERTIES : [])];
	const clipTime = playheadInClip(clip, time);
	return properties.map((property) => {
		const prop = animatableOf(clip, property);
		const keys = isVideoKeyframes(prop) ? prop.keys : [];
		const limits = VIDEO_KEYFRAME_LIMITS[property];
		return {
			property,
			...KEY_LABELS[property],
			value: Math.round(videoValueAt(prop, clipTime, limits.default) * 1000) / 1000,
			keyed: keys.length > 0,
			keys: keys.length,
			onKey: keys.some((k) => Math.abs(k.t - clipTime) < 0.5),
			clipTime,
			...(limits.min !== undefined ? { min: limits.min } : {}),
			...(limits.max !== undefined ? { max: limits.max } : {})
		};
	});
}

/** A plain (unkeyed) value as an edit: `undefined` puts it back to its default. */
function plainValueEdit(clip: VideoClip, property: VideoKeyframeProperty, value: number | undefined): VideoEdit {
	if (!(VIDEO_TRANSFORM_PROPERTIES as readonly string[]).includes(property))
		return value === undefined ? { op: 'update_clip', clip: clip.id, remove: [property] } : { op: 'update_clip', clip: clip.id, set: { [property]: value } };
	const transform: Record<string, unknown> = { ...clip.transform, [property]: value };
	if (value === undefined) delete transform[property];
	return Object.keys(transform).length ? { op: 'update_clip', clip: clip.id, set: { transform } } : { op: 'update_clip', clip: clip.id, remove: ['transform'] };
}

/**
 * Typing a value in an inspector: on a keyed property it sets (or moves) the key at the playhead;
 * otherwise it sets the plain value (`undefined` resets it).
 */
export function videoKeyframeValueEdit(project: VideoProject, clipId: string, property: VideoKeyframeProperty, time: number, value: number | undefined): VideoEdit | null {
	const at = findVideoClip(project, clipId);
	if (!at) return null;
	const prop = animatableOf(at.clip, property);
	if (!isVideoKeyframes(prop)) return plainValueEdit(at.clip, property, value);
	if (value === undefined) return null;
	return { op: 'set_keyframes', clip: clipId, property, keys: setVideoKey(prop, { t: playheadInClip(at.clip, time), v: value }, VIDEO_KEYFRAME_LIMITS[property].default).keys };
}

/**
 * The keyframe toggle: adds a key at the playhead holding the current value (the first key turns
 * the plain value into keys), or removes the key there (the last one leaves its value plain).
 */
export function videoKeyframeToggleEdit(project: VideoProject, clipId: string, property: VideoKeyframeProperty, time: number): VideoEdit | null {
	const at = findVideoClip(project, clipId);
	if (!at) return null;
	const prop = animatableOf(at.clip, property);
	const t = playheadInClip(at.clip, time);
	const fallback = VIDEO_KEYFRAME_LIMITS[property].default;
	if (isVideoKeyframes(prop)) {
		const key = prop.keys.find((k) => Math.abs(k.t - t) < 0.5);
		if (key) {
			const rest = removeVideoKey(prop, key.t);
			return isVideoKeyframes(rest) ? { op: 'set_keyframes', clip: clipId, property, keys: rest.keys } : plainValueEdit(at.clip, property, rest === fallback ? undefined : rest);
		}
	}
	const v = videoValueAt(prop, t, fallback);
	return { op: 'set_keyframes', clip: clipId, property, keys: isVideoKeyframes(prop) ? setVideoKey(prop, { t, v }, fallback).keys : [{ t, v }] };
}
