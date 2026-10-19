import { checkVideoProject, videoIssueKey, type VideoIssue } from './check.js';
import { isVideoKeyframes, retimeVideoAnimatable, sortVideoKeys, splitVideoAnimatable, VIDEO_KEYFRAME_LIMITS, VIDEO_KEYFRAME_PROPERTIES, VIDEO_TRANSFORM_PROPERTIES, videoValueAt, type VideoAnimatable, type VideoKey, type VideoKeyframeProperty } from './keyframes.js';
import { parseVideoAnimatable, parseVideoAsset, parseVideoClip, parseVideoMarker, parseVideoProject, parseVideoTransition } from './parse.js';
import {
	findVideoClip,
	formatVideoSeconds,
	nextFreeVideoSlot,
	sortedVideoClips,
	VIDEO_TIME_EPSILON,
	videoAssetMap,
	videoClipAfter,
	videoClipBefore,
	videoClipEnd,
	videoClipHandles,
	videoClipOverhang,
	videoClipSpeed,
	videoOverlap,
	videoTrackSyncLocked
} from './timeline.js';
import { VIDEO_PLACEMENT_MODES, type VideoAsset, type VideoClip, type VideoMarker, type VideoPlacementMode, type VideoProject, type VideoTrack, type VideoTrackKind, type VideoTransition } from './types.js';
import { namedWithSuggestion } from '../animation-editor/issues.js';

type Settings = { name?: string; width?: number; height?: number; fps?: number; background?: string };
type TrackFields = { name?: string; muted?: boolean; hidden?: boolean; locked?: boolean; syncLocked?: boolean; volume?: number };
const TRACK_FIELD_KEYS = ['name', 'muted', 'hidden', 'locked', 'syncLocked', 'volume'];
/** A clip to add: `id` and `start` are optional (default: a fresh id, the end of the track). */
export type NewVideoClip = { [K in VideoClip['type']]: Omit<Extract<VideoClip, { type: K }>, 'id' | 'start' | 'duration'> & { id?: string; start?: number; duration?: number } }[VideoClip['type']];

/** One change to a project. `applyVideoEdits` applies a list of them all or nothing. */
export type VideoEdit =
	| ({ op: 'set_settings' } & Settings)
	| { op: 'add_asset'; asset: Omit<VideoAsset, 'id'> & { id?: string } }
	| { op: 'update_asset'; asset: string; set?: Partial<Omit<VideoAsset, 'id'>>; remove?: string[] }
	| { op: 'remove_asset'; asset: string }
	| { op: 'add_track'; track: TrackFields & { id?: string; kind: VideoTrackKind }; at?: number }
	| { op: 'update_track'; track: string; set?: TrackFields; remove?: string[] }
	| { op: 'remove_track'; track: string }
	| { op: 'move_track'; track: string; to: number }
	| { op: 'add_clip'; track: string; clip: NewVideoClip; mode?: VideoPlacementMode; ripple?: boolean }
	| { op: 'move_clip'; clip: string; start?: number; track?: string; mode?: VideoPlacementMode }
	| { op: 'trim_clip'; clip: string; edge: 'start' | 'end'; to: number; ripple?: boolean }
	| { op: 'split_clip'; clip: string; at: number; id?: string }
	| { op: 'delete_clips'; clips: string[]; ripple?: boolean }
	| { op: 'update_clip'; clip: string; set?: Record<string, unknown>; remove?: string[] }
	| { op: 'set_transition'; clip: string; transition: VideoTransition | null }
	| { op: 'slip_clip'; clip: string; delta: number }
	| { op: 'roll_edit'; left: string; right: string; delta: number }
	| { op: 'slide_clip'; clip: string; delta: number }
	| { op: 'lift_range'; from: number; to: number; tracks?: string[] }
	| { op: 'extract_range'; from: number; to: number; tracks?: string[] }
	| { op: 'split_at'; at: number; tracks?: string[] }
	/** Keys for one property (in any order; clip-relative ms), or null to stop animating it and keep its value at the clip's start. */
	| { op: 'set_keyframes'; clip: string; property: VideoKeyframeProperty; keys: VideoKey[] | null }
	| { op: 'close_gaps'; track: string; from?: number }
	| { op: 'add_marker'; marker: Omit<VideoMarker, 'id'> & { id?: string } }
	| { op: 'update_marker'; marker: string; set?: Partial<Omit<VideoMarker, 'id'>>; remove?: string[] }
	| { op: 'remove_marker'; marker: string }
	| { op: 'replace_project'; project: VideoProject };

export type VideoEditOp = VideoEdit['op'];
export const VIDEO_EDIT_OPS: readonly VideoEditOp[] = [
	'set_settings',
	'add_asset',
	'update_asset',
	'remove_asset',
	'add_track',
	'update_track',
	'remove_track',
	'move_track',
	'add_clip',
	'move_clip',
	'trim_clip',
	'split_clip',
	'delete_clips',
	'update_clip',
	'set_transition',
	'slip_clip',
	'roll_edit',
	'slide_clip',
	'lift_range',
	'extract_range',
	'split_at',
	'set_keyframes',
	'close_gaps',
	'add_marker',
	'update_marker',
	'remove_marker',
	'replace_project'
];

/** What one op made or changed, so the next step can refer to it. */
export interface VideoEditOutcome {
	op: VideoEditOp;
	clip?: string;
	clips?: string[];
	track?: string;
	asset?: string;
	marker?: string;
	/** Clips the op made by cutting others (the right-hand parts). */
	created?: string[];
	/** Clips it deleted to make room (overwrite, lift, extract). */
	removed?: string[];
	/** Clips it shortened to make room. */
	trimmed?: string[];
	/** Tracks a ripple moved (the edited ones and every sync-locked one with them). */
	rippled?: string[];
	/** For slip, roll and slide: how far it actually moved (ms), after clamping to what the media allows. */
	delta?: number;
}

export type VideoEditResult =
	| { ok: true; project: VideoProject; issues: VideoIssue[]; outcomes: VideoEditOutcome[] }
	| { ok: false; error: string };

/** Default lengths (ms) for clips added without one. */
export const VIDEO_DEFAULT_STILL_DURATION = 5000;
export const VIDEO_DEFAULT_TITLE_DURATION = 3000;

class EditError extends Error {}
const refuse = (message: string): never => {
	throw new EditError(message);
};

function freshId(prefix: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

const slug = (s: string) =>
	s
		.replace(/^.*[\\/]/, '')
		.replace(/\.[a-z0-9]+(\?.*)?$/i, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 32);

/** Sorts `[from, to]` spans and merges the ones that overlap or touch. */
function mergeSpans(spans: [number, number][]): [number, number][] {
	const out: [number, number][] = [];
	for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
		const last = out[out.length - 1];
		if (last && from <= last[1] + VIDEO_TIME_EPSILON) last[1] = Math.max(last[1], to);
		else out.push([from, to]);
	}
	return out;
}

/** Every keyframeable value of a clip, with a way to read and replace it. */
function clipAnimatables(clip: VideoClip): { get: () => VideoAnimatable | undefined; set: (v: VideoAnimatable | undefined) => void }[] {
	const c = clip as VideoClip & { volume?: VideoAnimatable };
	const out = [
		{ get: () => c.opacity, set: (v: VideoAnimatable | undefined) => (c.opacity = v) },
		{ get: () => c.volume, set: (v: VideoAnimatable | undefined) => (c.volume = v) }
	];
	for (const p of VIDEO_TRANSFORM_PROPERTIES) out.push({ get: () => c.transform?.[p], set: (v) => c.transform && (c.transform[p] = v) });
	return out;
}

/** Applies `fn` to every keyframed value of a clip (plain numbers are left alone). */
function retimeClipKeys(clip: VideoClip, fn: (v: VideoAnimatable) => VideoAnimatable) {
	for (const a of clipAnimatables(clip)) {
		const v = a.get();
		if (isVideoKeyframes(v)) a.set(fn(v));
	}
}

const OPTIONAL_CLIP_FIELDS = ['name', 'opacity', 'transform', 'fit', 'fadeIn', 'fadeOut', 'fadeInCurve', 'fadeOutCurve', 'transition', 'in', 'speed', 'volume', 'muted', 'color', 'fontSize', 'fontFamily', 'fontWeight', 'background'];

/** Times the new range and nudge ops require, checked before anything changes. */
const TIME_FIELDS: Partial<Record<VideoEditOp, string[]>> = { slip_clip: ['delta'], roll_edit: ['delta'], slide_clip: ['delta'], lift_range: ['from', 'to'], extract_range: ['from', 'to'], split_at: ['at'] };

/** Applies edits to a mutable copy of a project. */
class Editor {
	readonly outcomes: VideoEditOutcome[] = [];
	constructor(public p: VideoProject) {}

	track(id: string): VideoTrack {
		const t = this.p.tracks.find((x) => x.id === id);
		if (!t) refuse(`There is no track ${namedWithSuggestion(id, this.p.tracks.map((x) => x.id))}; the tracks are ${this.p.tracks.map((x) => `"${x.id}" (${x.kind})`).join(', ') || 'none'}.`);
		return t!;
	}

	clip(id: string) {
		const at = findVideoClip(this.p, id);
		if (!at) {
			const ids = this.p.tracks.flatMap((t) => t.clips.map((c) => c.id));
			refuse(`There is no clip ${namedWithSuggestion(id, ids)}${ids.length ? '' : '; the project has no clips yet'}.`);
		}
		return at!;
	}

	unlocked(track: VideoTrack) {
		if (track.locked) refuse(`Track "${track.id}" is locked; unlock it (update_track with locked false) first.`);
	}

	asset(id: string): VideoAsset {
		const a = this.p.assets.find((x) => x.id === id);
		if (!a) refuse(`There is no asset ${namedWithSuggestion(id, this.p.assets.map((x) => x.id))}; add it first (the assets are ${this.p.assets.map((x) => `"${x.id}"`).join(', ') || 'none yet'}).`);
		return a!;
	}

	fits(track: VideoTrack, start: number, duration: number, ignore: Set<string>, what: string) {
		const hit = videoOverlap(track, start, start + duration, ignore);
		if (hit) {
			const free = nextFreeVideoSlot(track, start, duration, ignore);
			refuse(`${what} at ${formatVideoSeconds(start)}–${formatVideoSeconds(start + duration)} would overlap clip "${hit.id}" (${formatVideoSeconds(hit.start)}–${formatVideoSeconds(videoClipEnd(hit))}) on track "${track.id}"; the next free place is ${formatVideoSeconds(free)}, or use mode "insert" to push later clips along or "overwrite" to replace what is there.`);
		}
	}

	kindFits(track: VideoTrack, clip: { type: string; asset?: string }) {
		const asset = clip.type === 'media' ? this.asset(clip.asset!) : null;
		if (track.kind === 'audio' && (clip.type !== 'media' || asset!.kind === 'image')) refuse(`Track "${track.id}" is an audio track; ${clip.type === 'media' ? 'images' : `${clip.type} clips`} go on a video track.`);
		if (track.kind === 'video' && asset?.kind === 'audio') refuse(`Track "${track.id}" is a video track; audio asset "${asset.id}" goes on an audio track.`);
	}

	/** Moves every clip on `track` starting at or after `from` by `delta`. */
	shift(track: VideoTrack, from: number, delta: number, except: ReadonlySet<string> = new Set()) {
		if (!delta) return;
		for (const c of track.clips) if (!except.has(c.id) && c.start >= from - VIDEO_TIME_EPSILON) c.start = Math.max(0, c.start + delta);
		track.clips.sort((a, b) => a.start - b.start);
	}

	get frame() {
		return 1000 / this.p.fps;
	}

	ids() {
		return this.p.tracks.flatMap((t) => t.clips.map((c) => c.id));
	}

	/**
	 * The tracks a ripple on `sources` moves, top to bottom: the sources, and every unlocked
	 * sync-locked track when one of the sources is sync-locked.
	 */
	rippleTracks(sources: Iterable<VideoTrack>): VideoTrack[] {
		const set = new Set(sources);
		if ([...set].some(videoTrackSyncLocked)) for (const t of this.p.tracks) if (videoTrackSyncLocked(t) && !t.locked) set.add(t);
		return this.p.tracks.filter((t) => set.has(t));
	}

	/** The tracks a range edit works on: the named ones (unlocked), or every unlocked track. */
	rangeTracks(ids: readonly string[] | undefined): VideoTrack[] {
		if (ids) {
			if (!ids.length) refuse('"tracks" is empty; name at least one track, or leave it out for every unlocked track.');
			const tracks = [...new Set(ids)].map((id) => this.track(id));
			tracks.forEach((t) => this.unlocked(t));
			return this.p.tracks.filter((t) => tracks.includes(t));
		}
		const open = this.p.tracks.filter((t) => !t.locked);
		if (!open.length) refuse('Every track is locked; unlock one (update_track with locked false) first.');
		return open;
	}

	range(from: number, to: number) {
		if (!(to - from > VIDEO_TIME_EPSILON)) refuse(`"to" (${formatVideoSeconds(to)}) must be after "from" (${formatVideoSeconds(from)}).`);
	}

	/** Moves a media clip's in point by `delta` of timeline time (stills, titles and colours have none). */
	moveIn(clip: VideoClip, delta: number) {
		if (clip.type !== 'media' || videoAssetMap(this.p).get(clip.asset)?.kind === 'image') return;
		clip.in = Math.max(0, (clip.in ?? 0) + delta * videoClipSpeed(clip));
		if (clip.in < 1e-9) delete clip.in;
	}

	/** Moves a clip's head `delta` later in time (start, in point and keys); the caller sets start and duration. */
	trimHead(clip: VideoClip, delta: number) {
		this.moveIn(clip, delta);
		// Keys stay on the picture they were set on, so they move by the trim.
		retimeClipKeys(clip, (v) => retimeVideoAnimatable(v, -delta));
	}

	/** Cuts `clip` at `at` (inside it): the left part keeps the id, the right part is returned. */
	cut(track: VideoTrack, clip: VideoClip, at: number, id?: string): VideoClip {
		const end = videoClipEnd(clip);
		const right: any = { ...structuredClone(clip), id: id ?? freshId(`${clip.id}-`, this.ids()), start: at, duration: end - at };
		delete right.transition;
		delete right.fadeIn;
		delete right.fadeInCurve;
		// Each part keeps the keys on its side, with a key at the cut so both play as the whole did.
		const leftValues = clipAnimatables(clip);
		clipAnimatables(right).forEach((r, i) => {
			const [l, rr] = splitVideoAnimatable(leftValues[i].get(), at - clip.start);
			if (isVideoKeyframes(l)) leftValues[i].set(l);
			if (isVideoKeyframes(rr)) r.set(rr);
		});
		this.moveIn(right, at - clip.start);
		clip.duration = at - clip.start;
		delete clip.fadeOut;
		if (clip.type === 'media') delete clip.fadeOutCurve;
		track.clips.push(right);
		track.clips.sort((a, b) => a.start - b.start);
		return right;
	}

	/** Cuts every clip on `tracks` that runs across `at`; returns the new right-hand parts. */
	cutAcross(tracks: readonly VideoTrack[], at: number): VideoClip[] {
		const made: VideoClip[] = [];
		for (const t of tracks) for (const c of [...t.clips]) if (c.start < at - VIDEO_TIME_EPSILON && videoClipEnd(c) > at + VIDEO_TIME_EPSILON) made.push(this.cut(t, c, at));
		return made;
	}

	/**
	 * Opens `amount` of empty time at `at` on `tracks`: clips across `at` are cut there and everything
	 * from `at` on moves later. Returns the clips made by cutting.
	 */
	open(tracks: readonly VideoTrack[], at: number, amount: number, except: ReadonlySet<string> = new Set()): string[] {
		const made = this.cutAcross(tracks, at).map((c) => c.id);
		for (const t of tracks) this.shift(t, at, amount, except);
		return made;
	}

	/**
	 * Closes `[from, to)` on `tracks`, pulling everything after it earlier. Refuses, before moving
	 * anything, when a track still has a clip in that stretch (it would be pulled out of sync).
	 */
	close(tracks: readonly VideoTrack[], from: number, to: number) {
		for (const t of tracks) {
			const hit = videoOverlap(t, from, to);
			if (hit)
				refuse(
					`Rippling out ${formatVideoSeconds(from)}–${formatVideoSeconds(to)} would pull track "${t.id}" out of sync: clip "${hit.id}" (${formatVideoSeconds(hit.start)}–${formatVideoSeconds(videoClipEnd(hit))}) is in that stretch. Extract the range across "${t.id}" too (extract_range with its id in "tracks"), turn its sync lock off (update_track with syncLocked false) or lock it, or lift instead of rippling.`
				);
		}
		for (const t of tracks) this.shift(t, to, from - to);
	}

	/**
	 * Empties `[from, to)` on one track, leaving a gap: clips inside go, clips across an edge are
	 * trimmed back to it, and a clip across both is cut in two around the gap.
	 */
	clear(track: VideoTrack, from: number, to: number, report: { removed: string[]; trimmed: string[]; created: string[] }) {
		for (const c of [...track.clips]) {
			const start = c.start;
			const end = videoClipEnd(c);
			if (end <= from + VIDEO_TIME_EPSILON || start >= to - VIDEO_TIME_EPSILON) continue;
			const coversHead = start >= from - VIDEO_TIME_EPSILON;
			const coversTail = end <= to + VIDEO_TIME_EPSILON;
			if (coversHead && coversTail) {
				track.clips = track.clips.filter((x) => x !== c);
				report.removed.push(c.id);
				continue;
			}
			if (!coversHead && !coversTail) report.created.push(this.cut(track, c, to).id);
			else if (coversHead) {
				// The head goes: start later in the source; a transition in has no cut left to play over.
				this.trimHead(c, to - start);
				c.start = to;
				c.duration = end - to;
				delete c.transition;
				report.trimmed.push(c.id);
				continue;
			}
			c.duration = from - start;
			if (!report.trimmed.includes(c.id)) report.trimmed.push(c.id);
		}
		track.clips.sort((a, b) => a.start - b.start);
	}

	/** Clamps a slip, roll or slide to `[lo, hi]`, refusing when it cannot move that way at all. */
	clamp(delta: number, lo: number, hi: number, why: () => string): number {
		const applied = Math.min(Math.max(delta, Math.min(0, lo)), Math.max(0, hi));
		if (Math.abs(delta) > VIDEO_TIME_EPSILON && Math.abs(applied) <= VIDEO_TIME_EPSILON) refuse(why());
		return Math.abs(applied) <= VIDEO_TIME_EPSILON ? 0 : applied;
	}

	/** Places a clip on a track by `mode`, returning what it cut, trimmed, removed and rippled. */
	place(track: VideoTrack, clip: VideoClip, mode: VideoPlacementMode, outcome: VideoEditOutcome) {
		if (mode === 'insert') {
			const tracks = this.rippleTracks([track]);
			outcome.created = this.open(tracks, clip.start, clip.duration);
			outcome.rippled = tracks.map((t) => t.id);
		} else if (mode === 'overwrite') {
			const report = { removed: [] as string[], trimmed: [] as string[], created: [] as string[] };
			this.clear(track, clip.start, videoClipEnd(clip), report);
			Object.assign(outcome, report);
		} else this.fits(track, clip.start, clip.duration, new Set([clip.id]), `Clip "${clip.id}"`);
		track.clips.push(clip);
		track.clips.sort((a, b) => a.start - b.start);
	}

	placement(mode: unknown, ripple?: boolean): VideoPlacementMode {
		if (mode !== undefined && !VIDEO_PLACEMENT_MODES.includes(mode as VideoPlacementMode)) refuse(`"mode" must be ${VIDEO_PLACEMENT_MODES.map((m) => `"${m}"`).join(', ')}.`);
		if (ripple && mode !== undefined && mode !== 'insert') refuse(`"ripple" means mode "insert", so it cannot go with mode "${mode}"; pass one or the other.`);
		return (mode as VideoPlacementMode | undefined) ?? (ripple ? 'insert' : 'refuse');
	}

	run(e: VideoEdit) {
		for (const k of TIME_FIELDS[e.op] ?? []) {
			const v = (e as Record<string, unknown>)[k];
			if (typeof v !== 'number' || !Number.isFinite(v)) refuse(`"${k}" must be a number of milliseconds.`);
			if (k !== 'delta' && (v as number) < 0) refuse(`"${k}" must be a time of at least 0.`);
		}
		switch (e.op) {
			case 'set_settings': {
				const { op: _op, ...settings } = e;
				for (const [k, v] of Object.entries(settings)) {
					if (!['name', 'width', 'height', 'fps', 'background'].includes(k)) refuse(`"${k}" is not a setting; use name, width, height, fps or background.`);
					if (v !== undefined) (this.p as any)[k] = v;
				}
				return this.outcomes.push({ op: e.op });
			}
			case 'add_asset': {
				const ids = this.p.assets.map((a) => a.id);
				if (e.asset.id !== undefined && ids.includes(e.asset.id)) refuse(`There is already an asset "${e.asset.id}"; pick another id or use update_asset.`);
				const base = slug(e.asset.name ?? e.asset.src ?? '') || e.asset.kind || 'asset';
				const unique = e.asset.id ?? (ids.includes(base) ? freshId(`${base}-`, ids) : base);
				this.p.assets.push(parseVideoAsset({ ...e.asset, id: unique }));
				return this.outcomes.push({ op: e.op, asset: unique });
			}
			case 'update_asset': {
				const asset = this.asset(e.asset);
				if (e.set && 'id' in e.set) refuse('An asset\'s id cannot be changed.');
				const next: any = { ...asset, ...e.set };
				for (const k of e.remove ?? []) delete next[k];
				this.p.assets[this.p.assets.indexOf(asset)] = parseVideoAsset(next);
				return this.outcomes.push({ op: e.op, asset: asset.id });
			}
			case 'remove_asset': {
				const asset = this.asset(e.asset);
				const users = this.p.tracks.flatMap((t) => t.clips.filter((c) => c.type === 'media' && c.asset === asset.id).map((c) => c.id));
				if (users.length) refuse(`Asset "${asset.id}" is used by clip${users.length > 1 ? 's' : ''} ${users.map((u) => `"${u}"`).join(', ')}; delete ${users.length > 1 ? 'them' : 'it'} first.`);
				this.p.assets = this.p.assets.filter((a) => a !== asset);
				return this.outcomes.push({ op: e.op, asset: asset.id });
			}
			case 'add_track': {
				const ids = this.p.tracks.map((t) => t.id);
				if (e.track.id && ids.includes(e.track.id)) refuse(`There is already a track "${e.track.id}".`);
				const id = e.track.id ?? freshId(e.track.kind === 'video' ? 'v' : 'a', ids);
				const n = this.p.tracks.filter((t) => t.kind === e.track.kind).length + 1;
				const track: VideoTrack = { name: `${e.track.kind === 'video' ? 'Video' : 'Audio'} ${n}`, ...e.track, id, clips: [] };
				// By default a video track goes above the other video tracks, an audio track below everything.
				const at = e.at ?? (e.track.kind === 'video' ? 0 : this.p.tracks.length);
				if (at > this.p.tracks.length) refuse(`"at" is ${at} but there are only ${this.p.tracks.length} tracks; use 0–${this.p.tracks.length}.`);
				this.p.tracks.splice(at, 0, track);
				return this.outcomes.push({ op: e.op, track: id });
			}
			case 'update_track': {
				const track = this.track(e.track);
				for (const k of Object.keys(e.set ?? {})) if (!TRACK_FIELD_KEYS.includes(k)) refuse(`"${k}" cannot be set on a track; use ${TRACK_FIELD_KEYS.join(', ')}.`);
				Object.assign(track, e.set);
				for (const k of e.remove ?? []) delete (track as any)[k];
				return this.outcomes.push({ op: e.op, track: track.id });
			}
			case 'remove_track': {
				const track = this.track(e.track);
				this.unlocked(track);
				this.p.tracks = this.p.tracks.filter((t) => t !== track);
				return this.outcomes.push({ op: e.op, track: track.id, clips: track.clips.map((c) => c.id) });
			}
			case 'move_track': {
				const track = this.track(e.track);
				if (e.to < 0 || e.to >= this.p.tracks.length) refuse(`"to" must be 0–${this.p.tracks.length - 1}.`);
				this.p.tracks.splice(this.p.tracks.indexOf(track), 1);
				this.p.tracks.splice(e.to, 0, track);
				return this.outcomes.push({ op: e.op, track: track.id });
			}
			case 'add_clip': {
				const track = this.track(e.track);
				this.unlocked(track);
				const mode = this.placement(e.mode, e.ripple);
				const draft: any = { ...e.clip, type: e.clip.type ?? 'media' };
				this.kindFits(track, draft);
				const ids = this.p.tracks.flatMap((t) => t.clips.map((c) => c.id));
				if (draft.id !== undefined && ids.includes(draft.id)) refuse(`There is already a clip "${draft.id}".`);
				draft.id ??= freshId('c', ids);
				if (draft.duration === undefined) {
					if (draft.type === 'media') {
						const asset = this.asset(draft.asset);
						if (asset.kind === 'image') draft.duration = VIDEO_DEFAULT_STILL_DURATION;
						else if (asset.duration === undefined) refuse(`Asset "${asset.id}" has no duration, so give the clip a "duration".`);
						else draft.duration = (asset.duration - (draft.in ?? 0)) / (draft.speed ?? 1);
						if (!(draft.duration > 0)) refuse(`"in" (${draft.in} ms) is at or past the end of "${asset.id}" (${asset.duration} ms).`);
					} else draft.duration = VIDEO_DEFAULT_TITLE_DURATION;
				}
				const end = sortedVideoClips(track).reduce((m, c) => Math.max(m, videoClipEnd(c)), 0);
				draft.start ??= end;
				const clip = parseVideoClip(draft, 'clip');
				const outcome: VideoEditOutcome = { op: e.op, clip: clip.id, track: track.id };
				this.place(track, clip, mode, outcome);
				return this.outcomes.push(outcome);
			}
			case 'move_clip': {
				const from = this.clip(e.clip);
				this.unlocked(from.track);
				const to = e.track !== undefined ? this.track(e.track) : from.track;
				this.unlocked(to);
				if (to !== from.track) this.kindFits(to, from.clip);
				const mode = this.placement(e.mode);
				const start = e.start ?? from.clip.start;
				if (start < 0) refuse('A clip cannot start before 0.');
				// Lift it out (leaving a gap where it was), then place it as if it were new.
				from.track.clips.splice(from.index, 1);
				from.clip.start = start;
				const outcome: VideoEditOutcome = { op: e.op, clip: from.clip.id, track: to.id };
				this.place(to, from.clip, mode, outcome);
				return this.outcomes.push(outcome);
			}
			case 'trim_clip': {
				const { track, clip } = this.clip(e.clip);
				this.unlocked(track);
				const speed = videoClipSpeed(clip);
				const end = videoClipEnd(clip);
				const minimum = 1000 / this.p.fps;
				const assets = videoAssetMap(this.p);
				if (e.edge === 'start') {
					const delta = e.to - clip.start;
					if (clip.duration - delta < minimum - VIDEO_TIME_EPSILON) refuse(`Trimming the start to ${formatVideoSeconds(e.to)} would leave "${clip.id}" shorter than a frame; it ends at ${formatVideoSeconds(end)}.`);
					if (clip.type === 'media') {
						const sourceIn = (clip.in ?? 0) + delta * speed;
						if (sourceIn < -VIDEO_TIME_EPSILON) refuse(`"${clip.id}" starts ${Math.round((clip.in ?? 0) / speed)} ms into its source, so its start can move at most that far earlier (to ${formatVideoSeconds(clip.start - (clip.in ?? 0) / speed)}).`);
						clip.in = Math.max(0, sourceIn);
						if (clip.in === 0) delete clip.in;
					}
					// Keys stay on the picture they were set on, so they move by the trim.
					retimeClipKeys(clip, (v) => retimeVideoAnimatable(v, -delta));
					if (e.ripple) {
						// Ripple at the edit point: the head comes out (or goes in) there, on every sync-locked track.
						const tracks = this.rippleTracks([track]);
						if (delta > 0) {
							clip.start += delta;
							clip.duration -= delta;
							this.close(tracks, clip.start - delta, clip.start);
						} else if (delta < 0) {
							const created = this.open(tracks, clip.start, -delta, new Set([clip.id]));
							clip.duration -= delta;
							return this.outcomes.push({ op: e.op, clip: clip.id, track: track.id, rippled: tracks.map((t) => t.id), ...(created.length ? { created } : {}) });
						}
						return this.outcomes.push({ op: e.op, clip: clip.id, track: track.id, rippled: tracks.map((t) => t.id) });
					} else {
						if (e.to < 0) refuse('A clip cannot start before 0.');
						if (delta < 0) this.fits(track, e.to, -delta, new Set([clip.id]), `Extending "${clip.id}"`);
						clip.start = e.to;
						clip.duration -= delta;
					}
				} else {
					const duration = e.to - clip.start;
					if (duration < minimum - VIDEO_TIME_EPSILON) refuse(`Trimming the end to ${formatVideoSeconds(e.to)} would leave "${clip.id}" shorter than a frame; it starts at ${formatVideoSeconds(clip.start)}.`);
					if (clip.type === 'media') {
						const asset = assets.get(clip.asset);
						const out = (clip.in ?? 0) + duration * speed;
						if (asset?.duration !== undefined && out > asset.duration + VIDEO_TIME_EPSILON)
							refuse(`"${clip.id}" can end at most at ${formatVideoSeconds(clip.start + (asset.duration - (clip.in ?? 0)) / speed)}, where "${asset.id}" runs out.`);
					}
					if (e.ripple) {
						const tracks = this.rippleTracks([track]);
						let created: string[] = [];
						if (e.to < end) {
							clip.duration = duration;
							this.close(tracks, e.to, end);
						} else if (e.to > end) {
							created = this.open(tracks, end, e.to - end, new Set([clip.id]));
							clip.duration = duration;
						}
						return this.outcomes.push({ op: e.op, clip: clip.id, track: track.id, rippled: tracks.map((t) => t.id), ...(created.length ? { created } : {}) });
					}
					if (e.to > end) this.fits(track, end, e.to - end, new Set([clip.id]), `Extending "${clip.id}"`);
					clip.duration = duration;
				}
				return this.outcomes.push({ op: e.op, clip: clip.id, track: track.id });
			}
			case 'split_clip': {
				const { track, clip } = this.clip(e.clip);
				this.unlocked(track);
				const end = videoClipEnd(clip);
				const minimum = 1000 / this.p.fps;
				if (e.at < clip.start + minimum - VIDEO_TIME_EPSILON || e.at > end - minimum + VIDEO_TIME_EPSILON) refuse(`${formatVideoSeconds(e.at)} is not inside "${clip.id}" (${formatVideoSeconds(clip.start)}–${formatVideoSeconds(end)}), at least a frame from either end.`);
				if (e.id !== undefined && this.ids().includes(e.id)) refuse(`There is already a clip "${e.id}".`);
				const right = this.cut(track, clip, e.at, e.id);
				return this.outcomes.push({ op: e.op, clips: [clip.id, right.id], clip: right.id, track: track.id });
			}
			case 'delete_clips': {
				const found = [...new Set(e.clips)].map((id) => this.clip(id));
				for (const f of found) this.unlocked(f.track);
				for (const track of new Set(found.map((f) => f.track))) track.clips = track.clips.filter((c) => !found.some((f) => f.clip === c));
				if (!e.ripple) return this.outcomes.push({ op: e.op, clips: found.map((f) => f.clip.id) });
				// A track out of sync lock closes only its own gaps; the gaps of sync-locked tracks are
				// merged into spans closed on every sync-locked track, right to left so earlier spans stay put.
				const rippled = new Set<VideoTrack>();
				const groups = [...new Set(found.map((f) => f.track))].filter((t) => !videoTrackSyncLocked(t)).map((t) => [t]);
				if (found.some((f) => videoTrackSyncLocked(f.track))) groups.push(found.filter((f) => videoTrackSyncLocked(f.track)).map((f) => f.track));
				for (const sources of groups) {
					const tracks = this.rippleTracks(sources);
					tracks.forEach((t) => rippled.add(t));
					const spans = mergeSpans(found.filter((f) => sources.includes(f.track)).map((f) => [f.clip.start, videoClipEnd(f.clip)]));
					for (const [from, to] of spans.reverse()) this.close(tracks, from, to);
				}
				return this.outcomes.push({ op: e.op, clips: found.map((f) => f.clip.id), rippled: this.p.tracks.filter((t) => rippled.has(t)).map((t) => t.id) });
			}
			case 'update_clip': {
				const at = this.clip(e.clip);
				this.unlocked(at.track);
				const set = { ...(e.set ?? {}) };
				for (const k of ['id', 'type']) if (k in set) refuse(`A clip's ${k} cannot be changed; delete it and add a new one.`);
				for (const k of e.remove ?? []) if (!OPTIONAL_CLIP_FIELDS.includes(k)) refuse(`"${k}" cannot be removed; removable fields are ${OPTIONAL_CLIP_FIELDS.join(', ')}.`);
				// A new speed keeps the stretch of source and changes the length, as in an NLE's rate stretch.
				if ('speed' in set && (typeof set.speed !== 'number' || !(set.speed > 0))) refuse('"speed" must be a number greater than 0 (1 = normal speed).');
				let stretch = 1;
				if (at.clip.type === 'media' && !('duration' in set)) {
					const was = videoClipSpeed(at.clip);
					const now = 'speed' in set ? (set.speed as number) : e.remove?.includes('speed') ? 1 : was;
					if (now !== was) {
						set.duration = (at.clip.duration * was) / now;
						stretch = was / now;
					}
				}
				const next: any = { ...structuredClone(at.clip), ...set };
				// A rate stretch keeps keys on the same frames of source.
				if (stretch !== 1) retimeClipKeys(next, (v) => retimeVideoAnimatable(v, 0, stretch));
				for (const k of e.remove ?? []) delete next[k];
				const clip = parseVideoClip(next, 'set');
				if (clip.type === 'media' && clip.asset !== (at.clip as any).asset) this.kindFits(at.track, clip);
				if (clip.start !== at.clip.start || clip.duration !== at.clip.duration) this.fits(at.track, clip.start, clip.duration, new Set([clip.id]), `Clip "${clip.id}"`);
				at.track.clips[at.index] = clip;
				at.track.clips.sort((a, b) => a.start - b.start);
				return this.outcomes.push({ op: e.op, clip: clip.id, track: at.track.id });
			}
			case 'set_transition': {
				const { track, clip } = this.clip(e.clip);
				this.unlocked(track);
				if (e.transition === null) delete clip.transition;
				else clip.transition = parseVideoTransition(e.transition, 'transition');
				return this.outcomes.push({ op: e.op, clip: clip.id, track: track.id });
			}
			case 'slip_clip': {
				const { track, clip } = this.clip(e.clip);
				this.unlocked(track);
				if (clip.type !== 'media') refuse(`Clip "${clip.id}" is a ${clip.type === 'text' ? 'title' : 'colour'}, so it has no source to slip; only video and audio clips slip.`);
				const asset = this.asset((clip as { asset: string }).asset);
				if (asset.kind === 'image') refuse(`Clip "${clip.id}" is a still ("${asset.id}"), so it has no source to slip; only video and audio clips slip.`);
				// Keep the media a transition at either edge plays past the cut.
				const handles = videoClipHandles(clip, videoAssetMap(this.p));
				const { lead, tail } = videoClipOverhang(track, clip);
				const delta = this.clamp(e.delta, lead - handles.before, handles.after - tail, () =>
					e.delta > 0
						? `"${clip.id}" already plays to the end of "${asset.id}"${tail ? ` (less the ${tail} ms the transition after it needs)` : ''}, so it cannot slip later; slip it earlier (a negative delta).`
						: `"${clip.id}" already starts at the beginning of "${asset.id}"${lead ? ` (plus the ${lead} ms its transition needs)` : ''}, so it cannot slip earlier; slip it later (a positive delta).`
				);
				this.moveIn(clip, delta);
				return this.outcomes.push({ op: e.op, clip: clip.id, track: track.id, delta });
			}
			case 'roll_edit': {
				const left = this.clip(e.left);
				const right = this.clip(e.right);
				if (left.track !== right.track) refuse(`"${e.left}" is on track "${left.track.id}" and "${e.right}" on "${right.track.id}"; a roll moves the cut between two clips on one track.`);
				const track = left.track;
				this.unlocked(track);
				const L = left.clip;
				const R = right.clip;
				if (Math.abs(videoClipEnd(L) - R.start) > VIDEO_TIME_EPSILON) {
					if (Math.abs(videoClipEnd(R) - L.start) <= VIDEO_TIME_EPSILON) refuse(`"${R.id}" comes before "${L.id}"; pass left "${R.id}" and right "${L.id}".`);
					refuse(`"${L.id}" ends at ${formatVideoSeconds(videoClipEnd(L))} but "${R.id}" starts at ${formatVideoSeconds(R.start)}; a roll needs two clips that meet at a cut (use trim_clip to move one edge).`);
				}
				const assets = videoAssetMap(this.p);
				const lo = Math.max(-(L.duration - this.frame), -(videoClipHandles(R, assets).before - videoClipOverhang(track, R).lead));
				const hi = Math.min(R.duration - this.frame, videoClipHandles(L, assets).after - videoClipOverhang(track, L).tail);
				const delta = this.clamp(e.delta, lo, hi, () =>
					e.delta > 0
						? `The cut cannot move later: ${R.duration - this.frame < 1 ? `"${R.id}" is already a frame long` : `"${L.id}" has no media after its out point`}. Roll it earlier (a negative delta).`
						: `The cut cannot move earlier: ${L.duration - this.frame < 1 ? `"${L.id}" is already a frame long` : `"${R.id}" has no media before its in point`}. Roll it later (a positive delta).`
				);
				L.duration += delta;
				R.start += delta;
				R.duration -= delta;
				this.trimHead(R, delta);
				return this.outcomes.push({ op: e.op, clip: R.id, clips: [L.id, R.id], track: track.id, delta });
			}
			case 'slide_clip': {
				const { track, clip } = this.clip(e.clip);
				this.unlocked(track);
				const before = videoClipBefore(track, clip);
				const after = videoClipAfter(track, clip);
				if (!before && !after) refuse(`"${clip.id}" has no clip right before or after it on track "${track.id}", so there is nothing to slide against; use move_clip.`);
				const assets = videoAssetMap(this.p);
				const end = videoClipEnd(clip);
				const others = track.clips.filter((c) => c !== clip);
				// Without a neighbour on one side the clip moves through the gap there, up to the next clip.
				const room = {
					earlier: before ? before.duration - this.frame : clip.start - others.filter((c) => videoClipEnd(c) <= clip.start + VIDEO_TIME_EPSILON).reduce((m, c) => Math.max(m, videoClipEnd(c)), 0),
					later: after ? after.duration - this.frame : others.filter((c) => c.start >= end - VIDEO_TIME_EPSILON).reduce((m, c) => Math.min(m, c.start - end), Infinity)
				};
				const lo = -Math.min(room.earlier, after ? videoClipHandles(after, assets).before - videoClipOverhang(track, after).lead : Infinity);
				const hi = Math.min(room.later, before ? videoClipHandles(before, assets).after - videoClipOverhang(track, before).tail : Infinity);
				const delta = this.clamp(e.delta, lo, hi, () =>
					e.delta > 0
						? `"${clip.id}" cannot slide later: ${room.later < 1 ? (after ? `"${after.id}" is already a frame long` : 'the next clip is right after it') : `"${before!.id}" has no media after its out point to fill in behind it`}. Slide it earlier (a negative delta).`
						: `"${clip.id}" cannot slide earlier: ${room.earlier < 1 ? (before ? `"${before.id}" is already a frame long` : 'it is against the clip before it or the start') : `"${after!.id}" has no media before its in point to fill in behind it`}. Slide it later (a positive delta).`
				);
				clip.start += delta;
				if (before) before.duration += delta;
				if (after) {
					after.start += delta;
					after.duration -= delta;
					this.trimHead(after, delta);
				}
				track.clips.sort((a, b) => a.start - b.start);
				return this.outcomes.push({ op: e.op, clip: clip.id, clips: [before?.id, clip.id, after?.id].filter((x): x is string => !!x), track: track.id, delta });
			}
			case 'lift_range':
			case 'extract_range': {
				this.range(e.from, e.to);
				const tracks = this.rangeTracks(e.tracks);
				const report = { removed: [] as string[], trimmed: [] as string[], created: [] as string[] };
				for (const t of tracks) this.clear(t, e.from, e.to, report);
				const outcome: VideoEditOutcome = { op: e.op, ...report };
				if (e.op === 'extract_range') {
					const rippled = this.rippleTracks(tracks);
					this.close(rippled, e.from, e.to);
					outcome.rippled = rippled.map((t) => t.id);
				}
				return this.outcomes.push(outcome);
			}
			case 'split_at': {
				const tracks = this.rangeTracks(e.tracks);
				const lefts = tracks.flatMap((t) => t.clips.filter((c) => c.start < e.at - VIDEO_TIME_EPSILON && videoClipEnd(c) > e.at + VIDEO_TIME_EPSILON).map((c) => c.id));
				if (!lefts.length) refuse(`No clip runs across ${formatVideoSeconds(e.at)} on ${e.tracks ? `track${tracks.length > 1 ? 's' : ''} ${tracks.map((t) => `"${t.id}"`).join(', ')}` : 'the unlocked tracks'}, so there is nothing to split there.`);
				const created = this.cutAcross(tracks, e.at).map((c) => c.id);
				return this.outcomes.push({ op: e.op, clips: lefts, created });
			}
			case 'set_keyframes': {
				const { track, clip } = this.clip(e.clip);
				this.unlocked(track);
				if (!VIDEO_KEYFRAME_PROPERTIES.includes(e.property)) refuse(`"${e.property}" cannot be keyframed; use one of ${VIDEO_KEYFRAME_PROPERTIES.join(', ')}.`);
				if (e.property === 'volume' && clip.type !== 'media') refuse(`Clip "${clip.id}" is a ${clip.type} clip and has no volume; volume keys go on media clips.`);
				const limits = VIDEO_KEYFRAME_LIMITS[e.property];
				const transform = (VIDEO_TRANSFORM_PROPERTIES as readonly string[]).includes(e.property);
				const c = clip as any;
				const current: VideoAnimatable | undefined = transform ? c.transform?.[e.property] : c[e.property];
				let value: VideoAnimatable | undefined;
				if (e.keys === null) {
					// Stop animating: keep what it shows at the clip's start.
					const v = videoValueAt(current, 0, limits.default);
					value = isVideoKeyframes(current) ? (v === limits.default ? undefined : v) : current;
				} else {
					if (!Array.isArray(e.keys) || !e.keys.length) refuse('"keys" must list at least one key { t, v }; pass null to remove the keyframes.');
					let sorted: VideoKey[] = [];
					try {
						sorted = sortVideoKeys(e.keys);
					} catch (error) {
						refuse((error as Error).message);
					}
					value = parseVideoAnimatable({ keys: sorted }, e.property, limits);
				}
				if (transform) {
					c.transform = { ...c.transform, [e.property]: value };
					if (value === undefined) delete c.transform[e.property];
					if (!Object.keys(c.transform).length) delete c.transform;
				} else if (value === undefined) delete c[e.property];
				else c[e.property] = value;
				return this.outcomes.push({ op: e.op, clip: clip.id, track: track.id });
			}
			case 'close_gaps': {
				const track = this.track(e.track);
				this.unlocked(track);
				let at = 0;
				const moved: string[] = [];
				for (const clip of sortedVideoClips(track)) {
					if (clip.start >= (e.from ?? 0) - VIDEO_TIME_EPSILON && clip.start > at + VIDEO_TIME_EPSILON) {
						clip.start = Math.max(at, e.from ?? 0);
						moved.push(clip.id);
					}
					at = Math.max(at, videoClipEnd(clip));
				}
				return this.outcomes.push({ op: e.op, track: track.id, clips: moved });
			}
			case 'add_marker': {
				const markers = (this.p.markers ??= []);
				if (e.marker.id !== undefined && markers.some((m) => m.id === e.marker.id)) refuse(`There is already a marker "${e.marker.id}".`);
				const marker = parseVideoMarker({ ...e.marker, id: e.marker.id ?? freshId('m', markers.map((m) => m.id)) });
				markers.push(marker);
				markers.sort((a, b) => a.time - b.time);
				return this.outcomes.push({ op: e.op, marker: marker.id });
			}
			case 'update_marker': {
				const markers = this.p.markers ?? [];
				const i = markers.findIndex((m) => m.id === e.marker);
				if (i < 0) refuse(`There is no marker ${namedWithSuggestion(e.marker, markers.map((m) => m.id))}.`);
				if (e.set && 'id' in e.set) refuse('A marker\'s id cannot be changed.');
				const next: any = { ...markers[i], ...e.set };
				for (const k of e.remove ?? []) delete next[k];
				markers[i] = parseVideoMarker(next);
				markers.sort((a, b) => a.time - b.time);
				return this.outcomes.push({ op: e.op, marker: e.marker });
			}
			case 'remove_marker': {
				const markers = this.p.markers ?? [];
				if (!markers.some((m) => m.id === e.marker)) refuse(`There is no marker ${namedWithSuggestion(e.marker, markers.map((m) => m.id))}.`);
				this.p.markers = markers.filter((m) => m.id !== e.marker);
				if (!this.p.markers.length) delete this.p.markers;
				return this.outcomes.push({ op: e.op, marker: e.marker });
			}
			case 'replace_project': {
				this.p = parseVideoProject(e.project);
				return this.outcomes.push({ op: e.op });
			}
			default:
				refuse(`Unknown op ${namedWithSuggestion(String((e as { op: unknown }).op), VIDEO_EDIT_OPS)}; the ops are ${VIDEO_EDIT_OPS.join(', ')}.`);
		}
	}
}

/**
 * Applies edits in order, all or nothing: the first that fails (an unknown id, an overlap, a trim
 * past the end of the source, a locked track) stops the lot and the project is unchanged. Edits
 * may not add errors (`checkVideoProject`); ones already there (from a loaded file) do not block.
 * With several edits, errors name the op (`op 2 (trim_clip): …`).
 */
export function applyVideoEdits(project: VideoProject, edits: VideoEdit | readonly VideoEdit[]): VideoEditResult {
	const list = Array.isArray(edits) ? edits : [edits as VideoEdit];
	if (!list.length) return { ok: true, project, issues: checkVideoProject(project), outcomes: [] };
	const editor = new Editor(structuredClone(project));
	for (let i = 0; i < list.length; i++) {
		const edit = list[i];
		try {
			editor.run(edit);
		} catch (error) {
			const message = (error as Error).message;
			return { ok: false, error: `${list.length > 1 ? `op ${i + 1} (${edit?.op}): ` : ''}${message}${/Nothing was changed\.$/.test(message) ? '' : ' Nothing was changed.'}` };
		}
	}
	let next: VideoProject;
	try {
		next = parseVideoProject(editor.p);
	} catch (error) {
		return { ok: false, error: `${(error as Error).message} Nothing was changed.` };
	}
	const before = new Set(checkVideoProject(project).filter((i) => i.severity === 'error').map(videoIssueKey));
	const issues = checkVideoProject(next);
	const added = issues.find((i) => i.severity === 'error' && !before.has(videoIssueKey(i)));
	if (added) return { ok: false, error: `That would leave an error: ${added.message} Nothing was changed.` };
	if (JSON.stringify(next) === JSON.stringify(project)) return { ok: true, project, issues, outcomes: editor.outcomes };
	return { ok: true, project: next, issues, outcomes: editor.outcomes };
}
