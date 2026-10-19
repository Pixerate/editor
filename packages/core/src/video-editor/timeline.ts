import type { VideoAsset, VideoClip, VideoProject, VideoTrack } from './types.js';

/** Clip edges closer than this (ms) count as touching: a cut, not a gap. */
export const VIDEO_TIME_EPSILON = 0.5;

export const videoClipEnd = (clip: VideoClip): number => clip.start + clip.duration;

/** Playback speed of a clip (1 for titles and colours). */
export const videoClipSpeed = (clip: VideoClip): number => (clip.type === 'media' ? (clip.speed ?? 1) : 1);

/** The stretch of source a media clip plays (ms), or `null` for titles and colours. */
export function videoClipSourceRange(clip: VideoClip): { in: number; out: number } | null {
	if (clip.type !== 'media') return null;
	const start = clip.in ?? 0;
	return { in: start, out: start + clip.duration * videoClipSpeed(clip) };
}

/** Length of one frame (ms). */
export const videoFrameDuration = (fps: number): number => 1000 / fps;

/** `time` moved to the nearest frame boundary. */
export function snapToVideoFrame(time: number, fps: number): number {
	const frame = Math.round((time * fps) / 1000);
	return Math.round(((frame * 1000) / fps) * 1000) / 1000;
}

/** Whole frames in `time` at `fps` (rounded). */
export const videoFrames = (time: number, fps: number): number => Math.round((time * fps) / 1000);

/** Non-drop SMPTE timecode `HH:MM:SS:FF` for a time (ms). */
export function formatVideoTimecode(time: number, fps: number): string {
	const base = Math.round(fps);
	const total = Math.max(0, videoFrames(time, fps));
	const ff = total % base;
	const secs = Math.floor(total / base);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(ff)}`;
}

/** Readable time for messages: `2.50 s`. */
export const formatVideoSeconds = (time: number): string => `${(time / 1000).toFixed(2)} s`;

export function videoAssetMap(project: VideoProject): Map<string, VideoAsset> {
	return new Map(project.assets.map((a) => [a.id, a]));
}

/** A track's clips in timeline order. */
export function sortedVideoClips(track: VideoTrack): VideoClip[] {
	return [...track.clips].sort((a, b) => a.start - b.start || a.duration - b.duration);
}

export interface VideoClipLocation {
	track: VideoTrack;
	trackIndex: number;
	clip: VideoClip;
	/** Index in `track.clips`. */
	index: number;
}

export function findVideoClip(project: VideoProject, id: string): VideoClipLocation | null {
	for (let trackIndex = 0; trackIndex < project.tracks.length; trackIndex++) {
		const track = project.tracks[trackIndex];
		const index = track.clips.findIndex((c) => c.id === id);
		if (index >= 0) return { track, trackIndex, clip: track.clips[index], index };
	}
	return null;
}

export function allVideoClipIds(project: VideoProject): string[] {
	return project.tracks.flatMap((t) => t.clips.map((c) => c.id));
}

/** Total length: the end of the last clip (ms). */
export function videoProjectDuration(project: VideoProject): number {
	let end = 0;
	for (const track of project.tracks) for (const clip of track.clips) end = Math.max(end, videoClipEnd(clip));
	return end;
}

/** The clip that ends where `clip` starts on its track (a cut), if any. */
export function videoClipBefore(track: VideoTrack, clip: VideoClip): VideoClip | null {
	let best: VideoClip | null = null;
	for (const c of track.clips) if (c !== clip && Math.abs(videoClipEnd(c) - clip.start) <= VIDEO_TIME_EPSILON) best = c;
	return best;
}

/** The clip that starts where `clip` ends on its track (a cut), if any. */
export function videoClipAfter(track: VideoTrack, clip: VideoClip): VideoClip | null {
	for (const c of track.clips) if (c !== clip && Math.abs(c.start - videoClipEnd(clip)) <= VIDEO_TIME_EPSILON) return c;
	return null;
}

/**
 * Timeline time (ms) a clip can run past its edges into source media: before its in point
 * (`before`) and after its out point (`after`). Unlimited for stills, titles, colours and media
 * whose length is unknown.
 */
export function videoClipHandles(clip: VideoClip, assets: Map<string, VideoAsset>): { before: number; after: number } {
	if (clip.type !== 'media') return { before: Infinity, after: Infinity };
	const asset = assets.get(clip.asset);
	const speed = videoClipSpeed(clip);
	const range = videoClipSourceRange(clip)!;
	const before = range.in / speed;
	if (!asset || asset.kind === 'image' || asset.duration === undefined) return { before: asset?.kind === 'image' ? Infinity : before, after: Infinity };
	return { before, after: Math.max(0, (asset.duration - range.out) / speed) };
}

/**
 * How far a clip plays past each edge because of transitions: `lead` before its start (its own
 * transition in) and `tail` after its end (the next clip's transition in). Dips need neither.
 */
export function videoClipOverhang(track: VideoTrack, clip: VideoClip): { lead: number; tail: number } {
	// A dip cuts under its colour, so neither clip plays past the cut.
	const lead = clip.transition && clip.transition.type !== 'dip' && videoClipBefore(track, clip) ? clip.transition.duration / 2 : 0;
	const next = videoClipAfter(track, clip);
	const tail = next?.transition && next.transition.type !== 'dip' ? next.transition.duration / 2 : 0;
	return { lead, tail };
}

export interface VideoSnapOptions {
	/** Clip ids whose edges are not snap targets (the ones being dragged). */
	exclude?: Iterable<string>;
	/** Also snap to this time (usually the playhead). */
	playhead?: number;
}

/** Times worth snapping to: 0, every clip edge, every marker and the playhead, ascending. */
export function videoSnapPoints(project: VideoProject, options: VideoSnapOptions = {}): number[] {
	const exclude = new Set(options.exclude ?? []);
	const points = new Set<number>([0]);
	for (const track of project.tracks)
		for (const clip of track.clips) {
			if (exclude.has(clip.id)) continue;
			points.add(clip.start);
			points.add(videoClipEnd(clip));
		}
	for (const marker of project.markers ?? []) points.add(marker.time);
	if (options.playhead !== undefined) points.add(options.playhead);
	return [...points].sort((a, b) => a - b);
}

/** The snap point nearest `time` if it is within `threshold` (ms), else `time`. */
export function snapVideoTime(time: number, points: readonly number[], threshold: number): { time: number; snapped: number | null } {
	let best: number | null = null;
	for (const p of points) if (Math.abs(p - time) <= threshold && (best === null || Math.abs(p - time) < Math.abs(best - time))) best = p;
	return best === null ? { time, snapped: null } : { time: best, snapped: best };
}

export interface VideoGap {
	track: string;
	start: number;
	end: number;
}

/** Empty stretches between clips (and before the first) on each track, or one track. */
export function findVideoGaps(project: VideoProject, trackId?: string): VideoGap[] {
	const gaps: VideoGap[] = [];
	for (const track of project.tracks) {
		if (trackId !== undefined && track.id !== trackId) continue;
		let at = 0;
		for (const clip of sortedVideoClips(track)) {
			if (clip.start - at > VIDEO_TIME_EPSILON) gaps.push({ track: track.id, start: at, end: clip.start });
			at = Math.max(at, videoClipEnd(clip));
		}
	}
	return gaps;
}

/** The first clip on `track` (other than `ignore`) that overlaps `[start, end)`, if any. */
export function videoOverlap(track: VideoTrack, start: number, end: number, ignore: ReadonlySet<string> = new Set()): VideoClip | null {
	for (const c of sortedVideoClips(track)) {
		if (ignore.has(c.id)) continue;
		if (c.start < end - VIDEO_TIME_EPSILON && videoClipEnd(c) > start + VIDEO_TIME_EPSILON) return c;
	}
	return null;
}

/** The first free stretch on `track` at or after `from` that fits `duration`. */
export function nextFreeVideoSlot(track: VideoTrack, from: number, duration: number, ignore: ReadonlySet<string> = new Set()): number {
	let at = from;
	for (const c of sortedVideoClips(track)) {
		if (ignore.has(c.id)) continue;
		if (videoClipEnd(c) <= at + VIDEO_TIME_EPSILON) continue;
		if (c.start >= at + duration - VIDEO_TIME_EPSILON) break;
		at = videoClipEnd(c);
	}
	return at;
}

/** Clips under `time` (start inclusive, end exclusive), top track first. */
export function videoClipsAt(project: VideoProject, time: number): { track: string; clip: VideoClip }[] {
	const out: { track: string; clip: VideoClip }[] = [];
	for (const track of project.tracks) for (const clip of track.clips) if (time >= clip.start && time < videoClipEnd(clip)) out.push({ track: track.id, clip });
	return out;
}
