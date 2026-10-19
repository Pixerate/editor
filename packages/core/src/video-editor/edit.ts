import { checkVideoProject, videoIssueKey, type VideoIssue } from './check.js';
import { parseVideoAsset, parseVideoClip, parseVideoMarker, parseVideoProject, parseVideoTransition } from './parse.js';
import { findVideoClip, formatVideoSeconds, nextFreeVideoSlot, sortedVideoClips, VIDEO_TIME_EPSILON, videoAssetMap, videoClipEnd, videoClipSpeed, videoOverlap } from './timeline.js';
import type { VideoAsset, VideoClip, VideoMarker, VideoProject, VideoTrack, VideoTrackKind, VideoTransition } from './types.js';
import { namedWithSuggestion } from '../animation-editor/issues.js';

type Settings = { name?: string; width?: number; height?: number; fps?: number; background?: string };
type TrackFields = { name?: string; muted?: boolean; hidden?: boolean; locked?: boolean; volume?: number };
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
	| { op: 'add_clip'; track: string; clip: NewVideoClip; ripple?: boolean }
	| { op: 'move_clip'; clip: string; start?: number; track?: string }
	| { op: 'trim_clip'; clip: string; edge: 'start' | 'end'; to: number; ripple?: boolean }
	| { op: 'split_clip'; clip: string; at: number; id?: string }
	| { op: 'delete_clips'; clips: string[]; ripple?: boolean }
	| { op: 'update_clip'; clip: string; set?: Record<string, unknown>; remove?: string[] }
	| { op: 'set_transition'; clip: string; transition: VideoTransition | null }
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

const OPTIONAL_CLIP_FIELDS = ['name', 'opacity', 'transform', 'fit', 'fadeIn', 'fadeOut', 'transition', 'in', 'speed', 'volume', 'muted', 'color', 'fontSize', 'fontFamily', 'fontWeight', 'background'];

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
			refuse(`${what} at ${formatVideoSeconds(start)}–${formatVideoSeconds(start + duration)} would overlap clip "${hit.id}" (${formatVideoSeconds(hit.start)}–${formatVideoSeconds(videoClipEnd(hit))}) on track "${track.id}"; the next free place is ${formatVideoSeconds(free)}, or pass ripple to push later clips along.`);
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
	}

	run(e: VideoEdit) {
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
				for (const k of Object.keys(e.set ?? {})) if (!['name', 'muted', 'hidden', 'locked', 'volume'].includes(k)) refuse(`"${k}" cannot be set on a track; use name, muted, hidden, locked or volume.`);
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
				if (e.ripple) {
					const inside = track.clips.find((c) => c.start < clip.start - VIDEO_TIME_EPSILON && videoClipEnd(c) > clip.start + VIDEO_TIME_EPSILON);
					if (inside) refuse(`${formatVideoSeconds(clip.start)} is inside clip "${inside.id}"; split it there first (split_clip), or insert at its start or end.`);
					this.shift(track, clip.start, clip.duration);
				} else this.fits(track, clip.start, clip.duration, new Set(), `Clip "${clip.id}"`);
				track.clips.push(clip);
				track.clips.sort((a, b) => a.start - b.start);
				return this.outcomes.push({ op: e.op, clip: clip.id, track: track.id });
			}
			case 'move_clip': {
				const from = this.clip(e.clip);
				this.unlocked(from.track);
				const to = e.track !== undefined ? this.track(e.track) : from.track;
				this.unlocked(to);
				if (to !== from.track) this.kindFits(to, from.clip);
				const start = e.start ?? from.clip.start;
				this.fits(to, start, from.clip.duration, new Set([from.clip.id]), `Clip "${from.clip.id}"`);
				from.clip.start = start;
				if (to !== from.track) {
					from.track.clips.splice(from.index, 1);
					to.clips.push(from.clip);
				}
				to.clips.sort((a, b) => a.start - b.start);
				return this.outcomes.push({ op: e.op, clip: from.clip.id, track: to.id });
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
					if (e.ripple) {
						clip.duration -= delta;
						this.shift(track, end, -delta, new Set([clip.id]));
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
					if (e.ripple) this.shift(track, end, e.to - end, new Set([clip.id]));
					else if (e.to > end) this.fits(track, end, e.to - end, new Set([clip.id]), `Extending "${clip.id}"`);
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
				const ids = this.p.tracks.flatMap((t) => t.clips.map((c) => c.id));
				if (e.id !== undefined && ids.includes(e.id)) refuse(`There is already a clip "${e.id}".`);
				const id = e.id ?? freshId(`${clip.id}-`, ids);
				const left = e.at - clip.start;
				const right: any = { ...structuredClone(clip), id, start: e.at, duration: end - e.at };
				delete right.transition;
				delete right.fadeIn;
				if (clip.type === 'media') {
					right.in = (clip.in ?? 0) + left * videoClipSpeed(clip);
				}
				clip.duration = left;
				delete clip.fadeOut;
				track.clips.push(right);
				track.clips.sort((a, b) => a.start - b.start);
				return this.outcomes.push({ op: e.op, clips: [clip.id, id], clip: id, track: track.id });
			}
			case 'delete_clips': {
				const found = [...new Set(e.clips)].map((id) => this.clip(id));
				for (const f of found) this.unlocked(f.track);
				for (const track of new Set(found.map((f) => f.track))) {
					const gone = found.filter((f) => f.track === track).map((f) => f.clip);
					track.clips = track.clips.filter((c) => !gone.includes(c));
					if (e.ripple) for (const c of [...gone].sort((a, b) => b.start - a.start)) this.shift(track, videoClipEnd(c), -c.duration);
				}
				return this.outcomes.push({ op: e.op, clips: found.map((f) => f.clip.id) });
			}
			case 'update_clip': {
				const at = this.clip(e.clip);
				this.unlocked(at.track);
				const set = { ...(e.set ?? {}) };
				for (const k of ['id', 'type']) if (k in set) refuse(`A clip's ${k} cannot be changed; delete it and add a new one.`);
				for (const k of e.remove ?? []) if (!OPTIONAL_CLIP_FIELDS.includes(k)) refuse(`"${k}" cannot be removed; removable fields are ${OPTIONAL_CLIP_FIELDS.join(', ')}.`);
				// A new speed keeps the stretch of source and changes the length, as in an NLE's rate stretch.
				if ('speed' in set && (typeof set.speed !== 'number' || !(set.speed > 0))) refuse('"speed" must be a number greater than 0 (1 = normal speed).');
				if (at.clip.type === 'media' && !('duration' in set)) {
					const was = videoClipSpeed(at.clip);
					const now = 'speed' in set ? (set.speed as number) : e.remove?.includes('speed') ? 1 : was;
					if (now !== was) set.duration = (at.clip.duration * was) / now;
				}
				const next: any = { ...at.clip, ...set };
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
