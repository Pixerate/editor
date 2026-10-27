// Agent playback on the video timeline (see `tools/playback.ts`): the cursor grabs the clip a call
// names and drags it to its new start or track, pulls a trimmed edge to its new time, clicks a track
// at the time a clip goes in, or clicks the ruler where a split, seek or marker lands. Plans only
// name clips, tracks and times; the timeline component finds them at its zoom and scroll.
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { PlaybackRef, PlaybackStep } from '../tools/playback.js';

/** A point on the timeline: `time` (ms), on `track` or on the row of `clip` (else the ruler). */
export interface VideoPlaybackTime {
	time: number;
	track?: string;
	clip?: string;
}

/** A timeline point as a playback ref: `{ kind: 'time', id: 't=1200;track=v1' }`. */
export function videoTimeRef(at: VideoPlaybackTime): PlaybackRef {
	return { kind: 'time', id: [`t=${Math.round(at.time)}`, at.track ? `track=${at.track}` : '', at.clip ? `clip=${at.clip}` : ''].filter(Boolean).join(';') };
}

/** Reads a `time` ref back (null for any other ref). */
export function parseVideoTimeRef(ref: PlaybackRef): VideoPlaybackTime | null {
	if (ref.kind !== 'time') return null;
	const parts = Object.fromEntries(ref.id.split(';').map((p) => p.split('=') as [string, string]));
	const time = Number(parts.t);
	if (!Number.isFinite(time)) return null;
	return { time, ...(parts.track ? { track: parts.track } : {}), ...(parts.clip ? { clip: parts.clip } : {}) };
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Clip ids a call names: `clip`, `clips`, `ids`, or an effect `target`. */
function clipsOf(args: Record<string, any>): string[] {
	const out: string[] = [];
	const add = (v: unknown) => str(v) && !out.includes(v) && out.push(v);
	add(args.clip);
	add(args.target);
	for (const key of ['clips', 'ids']) if (Array.isArray(args[key])) args[key].forEach(add);
	return out.slice(0, 6);
}

/** The cursor steps for one video tool call (by bare name), or null to fall back to the ids it names. */
export function planVideoToolPlayback(tool: string, args: Record<string, any>): PlaybackStep[] | null {
	const clips = clipsOf(args);
	const track = str(args.track) ? args.track : undefined;
	const newClip = args.clip && typeof args.clip === 'object' ? (args.clip as Record<string, unknown>) : null;
	const time = [args.start, args.at, args.time, args.to, newClip?.start].find(num) as number | undefined;
	const click = (ref: PlaybackRef): PlaybackStep[] => [{ type: 'target', ref }, { type: 'press' }, { type: 'release' }];

	// A clip moved or trimmed to a time (or another track): drag it there.
	if (clips.length === 1 && (time !== undefined || track) && tool !== 'split_video_clip') {
		const clip = clips[0]!;
		const to = videoTimeRef({ time: time ?? 0, ...(track ? { track } : { clip }) });
		return [{ type: 'target', ref: { kind: 'clip', id: clip } }, { type: 'press' }, { type: 'target', ref: to }, { type: 'release' }];
	}
	// Split a clip at a time: click there on its row.
	if (clips.length === 1 && time !== undefined) return click(videoTimeRef({ time, clip: clips[0]! }));
	if (clips.length) return clips.flatMap((id) => click({ kind: 'clip', id }));
	// A new clip on a track, at its start (or the track itself when it goes at the end).
	if (track) return click(time !== undefined ? videoTimeRef({ time, track }) : { kind: 'track', id: track });
	// A time only (split at, seek, marker, lift a range): the ruler.
	if (time !== undefined) return click(videoTimeRef({ time }));
	if (str(args.marker)) return click({ kind: 'marker', id: args.marker });
	return null;
}

/**
 * Gives a video tool provider agent playback: each write tool plans its steps with
 * `planVideoToolPlayback` and every call plays on `surface`. An explicit `surface` wins over the
 * provider's own `playbackSurface`; with neither, it is `video` (where `VideoTimeline` attaches
 * itself). `seek_video` (a read in name only) and `edit_video` (a batch) play too.
 */
export function withVideoPlayback(provider: AgentToolProvider, surface?: string): AgentToolProvider {
	const plan = (tool: AgentTool): AgentTool =>
		tool.plan || tool.playback !== undefined ? tool : { ...tool, plan: (args) => planVideoToolPlayback(tool.name, args) };
	const tools = provider.tools;
	return {
		...provider,
		playbackSurface: surface ?? provider.playbackSurface ?? 'video',
		tools: typeof tools === 'function' ? () => tools().map(plan) : tools.map(plan)
	};
}
