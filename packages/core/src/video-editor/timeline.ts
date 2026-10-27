import type { VideoAsset, VideoClip, VideoProject, VideoSequence, VideoTrack } from './types.js';

/** Clip edges closer than this (ms) count as touching: a cut, not a gap. */
export const VIDEO_TIME_EPSILON = 0.5;

export const videoClipEnd = (clip: VideoClip): number => clip.start + clip.duration;

/** What a clip is called in messages: "title", "colour", "effect clip", "adjustment clip", "compound clip" or "media clip". */
export const videoClipTypeLabel = (clip: Pick<VideoClip, 'type'>): string =>
	({ text: 'title', color: 'colour', effect: 'effect clip', adjustment: 'adjustment clip', sequence: 'compound clip', media: 'media clip' })[clip.type];

/** Whether a track moves with ripple edits on other tracks (`syncLocked`, default true). */
export const videoTrackSyncLocked = (track: VideoTrack): boolean => track.syncLocked !== false;

/** Playback speed of a clip (1 for titles and colours). */
export const videoClipSpeed = (clip: VideoClip): number => (clip.type === 'media' ? (clip.speed ?? 1) : 1);

/**
 * The stretch of source a media clip plays (ms), or of its sequence's time a compound plays; `null`
 * for titles and colours.
 */
export function videoClipSourceRange(clip: VideoClip): { in: number; out: number } | null {
	if (clip.type === 'sequence') return { in: clip.in ?? 0, out: (clip.in ?? 0) + clip.duration };
	if (clip.type !== 'media') return null;
	const start = clip.in ?? 0;
	// A ramp plays from its first key's source to its last's (holding before and after).
	if (clip.timeRemap?.keys.length) return { in: start + clip.timeRemap.keys[0].v, out: start + clip.timeRemap.keys[clip.timeRemap.keys.length - 1].v };
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

/**
 * Whether `fps` is an NTSC rate that SMPTE counts in drop-frame timecode: 29.97 (30000/1001) or
 * 59.94 (60000/1001). Other fractional rates (23.976) have no drop-frame form.
 */
export function isVideoDropFrameRate(fps: number): boolean {
	const nominal = Math.round(fps);
	return (nominal === 30 || nominal === 60) && Math.abs(fps - (nominal * 1000) / 1001) < 0.005;
}

/** The exact rate behind a rounded NTSC rate (29.97 → 30000/1001); other rates unchanged. */
const exactVideoRate = (fps: number): number => {
	const nominal = Math.round(fps);
	return nominal !== fps && Math.abs(fps - (nominal * 1000) / 1001) < 0.005 ? (nominal * 1000) / 1001 : fps;
};

/** Frames elapsed in `time` (ms), counted at the exact rate behind a rounded NTSC rate. */
export const videoTimecodeFrames = (time: number, fps: number): number => Math.max(0, Math.round((time * exactVideoRate(fps)) / 1000));

/**
 * SMPTE timecode for a time (ms): `HH:MM:SS:FF`, or `HH:MM:SS;FF` in drop-frame, which skips frame
 * numbers 0 and 1 (0–3 at 59.94) at the start of every minute except each tenth, so the clock keeps
 * up with real time at NTSC rates. `dropFrame` defaults to on at 29.97 and 59.94 and is ignored at
 * rates without a drop-frame form.
 */
export function formatVideoTimecode(time: number, fps: number, dropFrame = isVideoDropFrameRate(fps)): string {
	return formatVideoTimecodeFrames(videoTimecodeFrames(time, fps), fps, dropFrame);
}

/** SMPTE timecode for a frame count (see `formatVideoTimecode`). */
export function formatVideoTimecodeFrames(frames: number, fps: number, dropFrame = isVideoDropFrameRate(fps)): string {
	const base = Math.round(fps);
	let total = Math.max(0, Math.round(frames));
	const drop = dropFrame && isVideoDropFrameRate(fps);
	if (drop) {
		const skip = base / 15; // 2 at 29.97, 4 at 59.94
		const perMinute = base * 60 - skip;
		const perTen = perMinute * 10 + skip;
		const tens = Math.floor(total / perTen);
		const rest = total % perTen;
		total += skip * 9 * tens + (rest > skip ? skip * Math.floor((rest - skip) / perMinute) : 0);
	}
	const ff = total % base;
	const secs = Math.floor(total / base);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}${drop ? ';' : ':'}${pad(ff)}`;
}

/** Frames up to timecode `01:00:00:00` (`;00` in drop-frame), where record timecode usually starts. */
export const videoHourFrames = (fps: number, dropFrame = isVideoDropFrameRate(fps)): number => {
	const base = Math.round(fps);
	return dropFrame && isVideoDropFrameRate(fps) ? base * 3600 - (base / 15) * 54 : base * 3600;
};

/** Readable time for messages: `2.50 s`. */
export const formatVideoSeconds = (time: number): string => `${(time / 1000).toFixed(2)} s`;

/** Whether an asset carries sound: audio, or video not marked `hasAudio: false`. */
export const videoAssetHasSound = (asset: VideoAsset | undefined): boolean => !!asset && (asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio !== false));

export function videoAssetMap(project: VideoProject): Map<string, VideoAsset> {
	return new Map(project.assets.map((a) => [a.id, a]));
}

export function videoSequenceMap(project: VideoProject): Map<string, VideoSequence> {
	return new Map((project.sequences ?? []).map((q) => [q.id, q]));
}

/** A sequence's length: the end of its last clip (ms). */
export function videoSequenceDuration(sequence: Pick<VideoSequence, 'tracks'>): number {
	let end = 0;
	for (const track of sequence.tracks) for (const clip of track.clips) end = Math.max(end, videoClipEnd(clip));
	return end;
}

/** The sequences a sequence's compound clips play directly (ids, in order, without repeats). */
export const videoSequenceChildren = (sequence: Pick<VideoSequence, 'tracks'>): string[] => [...new Set(sequence.tracks.flatMap((t) => t.clips.flatMap((c) => (c.type === 'sequence' ? [c.sequence] : []))))];

/**
 * A path of sequence ids that leads from `id` back to itself through compound clips (`[a, b, a]`),
 * or `null` when it contains no cycle. Evaluating and exporting skip a compound that would close
 * one, and `checkVideoProject` reports it.
 */
export function findVideoSequenceCycle(project: VideoProject, id: string): string[] | null {
	const sequences = videoSequenceMap(project);
	const walk = (at: string, path: string[]): string[] | null => {
		const seq = sequences.get(at);
		if (!seq) return null;
		for (const child of videoSequenceChildren(seq)) {
			if (child === id) return [...path, child];
			if (path.includes(child)) continue;
			const found = walk(child, [...path, child]);
			if (found) return found;
		}
		return null;
	};
	return walk(id, [id]);
}

/** Every track with its sequence (`undefined` for the project's own), the project's first. */
export function allVideoTracks(project: VideoProject): { sequence?: string; track: VideoTrack }[] {
	return [...project.tracks.map((track) => ({ track })), ...(project.sequences ?? []).flatMap((q) => q.tracks.map((track) => ({ sequence: q.id, track })))];
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

/** Every clip id in the project, its sequences' clips included (ids are unique across them). */
export function allVideoClipIds(project: VideoProject): string[] {
	return allVideoTracks(project).flatMap(({ track }) => track.clips.map((c) => c.id));
}

/** The sequence a clip inside a sequence belongs to, with its track; `null` for clips of the project's own tracks (or no clip). */
export function findVideoSequenceClip(project: VideoProject, id: string): { sequence: VideoSequence; track: VideoTrack; clip: VideoClip } | null {
	for (const sequence of project.sequences ?? [])
		for (const track of sequence.tracks) {
			const clip = track.clips.find((c) => c.id === id);
			if (clip) return { sequence, track, clip };
		}
	return null;
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
 * whose length is unknown. A compound's handles are its sequence's time before `in` and after its
 * out point (pass `sequences`; without them they count as unlimited).
 */
export function videoClipHandles(clip: VideoClip, assets: Map<string, VideoAsset>, sequences?: Map<string, VideoSequence>): { before: number; after: number } {
	if (clip.type === 'sequence') {
		const seq = sequences?.get(clip.sequence);
		const range = videoClipSourceRange(clip)!;
		return { before: range.in, after: seq ? Math.max(0, videoSequenceDuration(seq) - range.out) : Infinity };
	}
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
