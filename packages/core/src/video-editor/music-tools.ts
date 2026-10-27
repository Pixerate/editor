/**
 * Agent tools for music and the mix: beats of a music track and a plan that snaps cuts to them,
 * ducking music under speech, and loudness measured and normalised the way streaming services
 * measure it (LUFS). Skill: `pixerate-bgm-alignment`.
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import { findVideoAudioSilences, videoAudioLevels } from './audio.js';
import type { VideoEditorController } from './controller.js';
import { applyVideoEdits, type VideoEdit } from './edit.js';
import { isVideoKeyframes } from './keyframes.js';
import { findVideoAudioBeats, nearestVideoBeat, videoAudioLoudness, videoDuckingKeys, videoLoudnessGain, videoSpeechRanges } from './mix.js';
import { withVideoPlayback } from './playback.js';
import { describeVideoEditPlan } from './plan.js';
import { findVideoClip, sortedVideoClips, VIDEO_TIME_EPSILON, videoClipEnd } from './timeline.js';
import { videoTimelineTranscript, videoTranscriptTrack } from './transcript.js';
import type { VideoAsset, VideoMediaClip, VideoProject } from './types.js';

export interface VideoMusicToolProviderOptions {
	/** Provider id (unique per registry). Default `video-music`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** The project cannot be edited: write tools are hidden. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
	/** The agent playback surface its calls are acted out on (default `video`). */
	playbackSurface?: string;
}

const round = (ms: number) => Math.round(ms * 10) / 10;
const object = (properties: Record<string, JsonSchema>, required: string[] = [], description?: string): JsonSchema & { type: 'object' } => ({ type: 'object', ...(description ? { description } : {}), properties, ...(required.length ? { required } : {}), additionalProperties: false });
const MS = (what: string) => ({ type: 'number', minimum: 0, description: `${what}, in milliseconds.` }) as const;
const CLIP_ID = { type: 'string', minLength: 1, description: 'A clip id from get_video_project (e.g. "c1").' } as const;
const TRACK_ID = { type: 'string', minLength: 1, description: 'A track id from get_video_project (e.g. "v1" or "a1").' } as const;
const SOUND_TARGET: Record<string, JsonSchema> = {
	clip: { ...CLIP_ID, description: 'A media clip with sound: read the stretch of source it plays, times on the timeline. Pass this or asset.' },
	asset: { type: 'string', minLength: 1, description: 'A video or audio asset: read its source, times in the source. Pass this or clip.' },
	from: MS("Start of the stretch (default: the clip's start, or 0 for an asset)"),
	to: MS("End of the stretch (default: the clip's end, or the asset's duration)")
};
const SOUND = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** The music and mix tools for a video editor (see the module comment). */
export function createVideoMusicToolProvider(controller: VideoEditorController, options: VideoMusicToolProviderOptions = {}): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (r) return typeof r === 'string' ? r : 'This video project is read-only.';
		return controller.readOnlyReason();
	};
	const project = () => controller.getProject();

	/** A media clip with sound. */
	const soundClip = (p: VideoProject, id: string): { clip: VideoMediaClip; asset: VideoAsset; track: string } => {
		const at = findVideoClip(p, id);
		if (!at) throw new Error(`There is no clip "${id}"; get_video_project lists the clips.`);
		const c = at.clip;
		if (c.type !== 'media') throw new Error(`Clip "${id}" is a ${c.type} clip and has no sound of its own; pass a video or audio clip.`);
		const asset = p.assets.find((a) => a.id === c.asset);
		if (!asset) throw new Error(`Clip "${id}" plays a missing asset "${c.asset}".`);
		if (asset.kind === 'image' || asset.hasAudio === false) throw new Error(`Clip "${id}" has no sound (asset "${asset.id}").`);
		return { clip: c, asset, track: at.track.id };
	};
	/** The stretch a measurement reads, in source ms, and how to map times back. */
	const stretch = (args: { clip?: string; asset?: string; from?: number; to?: number }) => {
		const p = project();
		if ((args.clip === undefined) === (args.asset === undefined)) throw new Error('Pass either "clip" (a media clip, times on the timeline) or "asset" (times in the source), not both.');
		if (args.clip !== undefined) {
			const { clip, asset } = soundClip(p, args.clip);
			const speed = clip.speed ?? 1;
			const from = Math.max(clip.start, args.from ?? clip.start);
			const to = Math.min(videoClipEnd(clip), args.to ?? videoClipEnd(clip));
			if (!(to > from)) throw new Error(`The stretch is empty (${from}–${to} ms); "from" and "to" must be inside the clip (${clip.start}–${videoClipEnd(clip)} ms) with "to" after "from".`);
			return { asset, from: (clip.in ?? 0) + (from - clip.start) * speed, to: (clip.in ?? 0) + (to - clip.start) * speed, out: (s: number) => clip.start + (s - (clip.in ?? 0)) / speed };
		}
		const asset = p.assets.find((a) => a.id === args.asset);
		if (!asset) throw new Error(`There is no asset "${args.asset}"; the assets are ${p.assets.map((a) => `"${a.id}"`).join(', ') || 'none'}.`);
		if (asset.kind === 'image' || asset.hasAudio === false) throw new Error(`Asset "${asset.id}" has no sound.`);
		const from = args.from ?? 0;
		const to = args.to ?? asset.duration ?? 0;
		if (!(to > from)) throw new Error(`The stretch is empty (${from}–${to} ms)${asset.duration === undefined ? '; the asset has no duration, so pass "to"' : ''}.`);
		return { asset, from, to, out: (s: number) => s };
	};

	// -----------------------------------------------------------------------------------------
	// Loudness
	// -----------------------------------------------------------------------------------------

	const measureLoudness: AgentTool = {
		name: 'measure_video_loudness',
		title: 'Measure loudness',
		description:
			'Measures how loud the source sound of a clip or an asset is, as streaming services and broadcasters do (ITU-R BS.1770, gated): integrated loudness in LUFS, the sample peak in dBFS, and the gain that would bring it to -14 LUFS (streaming) without the peak passing -1 dBFS. Before clip volume and fades. Changes nothing. The first call for an asset decodes its file. Use normalize_video_loudness to apply the gain.',
		inputSchema: object(SOUND_TARGET),
		annotations: { title: 'Measure loudness', ...SOUND },
		handler: async (args) => {
			const r = stretch(args);
			const peaks = await controller.audioPeaks.load(r.asset);
			const lufs = videoAudioLoudness(peaks, r.from, r.to);
			const peakDb = Math.max(...videoAudioLevels(peaks, r.from, r.to, 50).map((l) => l.peakDb));
			return { asset: r.asset.id, lufs, peakDb, ...(lufs === null ? { note: 'The stretch is silent (everything is below the -70 LUFS gate).' } : { toStreaming: videoLoudnessGain(lufs, -14, { peakDb }) }) };
		}
	};

	const normalizeLoudness: AgentTool = {
		name: 'normalize_video_loudness',
		title: 'Normalise loudness',
		description:
			'Sets each clip\'s volume so its sound plays at a target loudness (default -14 LUFS, streaming; -16 podcasts, -23 EBU R128 broadcast), keeping its peak under the ceiling and the gain at most 4× (one undo step). Measures each clip\'s own stretch of source first; silent clips are skipped. Refuses clips with volume keyframes (a constant gain would replace them) unless replace is true. Returns each clip\'s measured loudness, the gain set (linear and dB) and whether a cap held it short of the target.',
		inputSchema: object(
			{
				clips: { type: 'array', items: CLIP_ID, minItems: 1, maxItems: 200, uniqueItems: true, description: 'Media clips with sound.' },
				target: { type: 'number', minimum: -40, maximum: -5, description: 'Loudness to reach, in LUFS (default -14).' },
				ceiling: { type: 'number', minimum: -20, maximum: 0, description: 'Highest sample peak allowed after the gain, in dBFS (default -1).' },
				replace: { type: 'boolean', description: 'Replace volume keyframes with the constant gain (default false: refuse).' }
			},
			['clips']
		),
		annotations: { title: 'Normalise loudness', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		handler: async ({ clips, target, ceiling, replace }) => {
			const p = project();
			const targets = (clips as string[]).map((id) => soundClip(p, id));
			for (const t of targets) if (isVideoKeyframes(t.clip.volume) && !replace) throw new Error(`Clip "${t.clip.id}" has volume keyframes, which a constant gain would replace; pass replace: true, or remove them first.`);
			const results: Record<string, unknown>[] = [];
			const edits: VideoEdit[] = [];
			for (const { clip, asset } of targets) {
				const peaks = await controller.audioPeaks.load(asset);
				const speed = clip.speed ?? 1;
				const from = clip.in ?? 0;
				const to = from + clip.duration * speed;
				const lufs = videoAudioLoudness(peaks, from, to);
				if (lufs === null) {
					results.push({ clip: clip.id, skipped: 'silent' });
					continue;
				}
				const peakDb = Math.max(...videoAudioLevels(peaks, from, to, 50).map((l) => l.peakDb));
				const g = videoLoudnessGain(lufs, target ?? -14, { peakDb, ceiling });
				edits.push({ op: 'update_clip', clip: clip.id, set: { volume: g.gain } });
				results.push({ clip: clip.id, lufs, gain: g.gain, gainDb: g.gainDb, ...(g.limitedBy ? { limitedBy: g.limitedBy } : {}) });
			}
			if (!edits.length) throw new Error('Every clip is silent, so there is nothing to normalise.');
			const r = controller.apply(edits, 'Normalise loudness');
			if (!r.ok) throw new Error(r.error);
			return { target: target ?? -14, clips: results };
		}
	};

	// -----------------------------------------------------------------------------------------
	// Ducking
	// -----------------------------------------------------------------------------------------

	const duckMusic: AgentTool = {
		name: 'duck_video_music',
		title: 'Duck music under speech',
		description:
			'Dips music clips under speech with volume keyframes (one undo step): before each stretch of speech the level eases down by duck_db over "attack" ms, holds, and eases back over "release" ms after it; gaps shorter than merge_gap stay ducked. Speech comes from the transcript of the dialogue track ("transcript", the default when it has one) or from where its sound is above -40 dBFS ("audio", which decodes it). Refuses music clips that already have volume keyframes unless replace is true. Returns each music clip\'s keys and the speech stretches used.',
		inputSchema: object(
			{
				music: { type: 'array', items: CLIP_ID, minItems: 1, maxItems: 100, uniqueItems: true, description: 'The music clips to duck (media clips with sound).' },
				dialogue_track: { ...TRACK_ID, description: 'Track the speech is on (default: the transcript track for "transcript"; required for "audio").' },
				speech: { type: 'string', enum: ['transcript', 'audio'], description: 'Where speech is found: transcript words (default when transcribed) or the dialogue track\'s sound levels.' },
				duck_db: { type: 'number', minimum: -40, maximum: -1, description: 'How far to dip, in dB (default -14; -12 to -18 is usual).' },
				attack: { type: 'number', minimum: 0, maximum: 2000, description: 'Ms the dip takes to come in before speech (default 200).' },
				release: { type: 'number', minimum: 0, maximum: 4000, description: 'Ms the music takes to come back after speech (default 400).' },
				merge_gap: { type: 'number', minimum: 0, maximum: 10000, description: 'Speech gaps shorter than this stay ducked, in ms (default 600).' },
				replace: { type: 'boolean', description: 'Replace existing volume keyframes (default false: refuse).' }
			},
			['music']
		),
		annotations: { title: 'Duck music under speech', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		handler: async (args) => {
			const p = project();
			const music = (args.music as string[]).map((id) => soundClip(p, id));
			for (const m of music) if (isVideoKeyframes(m.clip.volume) && !args.replace) throw new Error(`Music clip "${m.clip.id}" already has volume keyframes; pass replace: true to replace them, or remove them first.`);
			const transcriptTrack = videoTranscriptTrack(p, args.dialogue_track);
			const mode = args.speech ?? (transcriptTrack && videoTimelineTranscript(p, { track: transcriptTrack }).length ? 'transcript' : 'audio');
			let ranges: { from: number; to: number }[] = [];
			if (mode === 'transcript') {
				const words = videoTimelineTranscript(p, { track: args.dialogue_track });
				if (!words.length) throw new Error(`No transcribed speech${args.dialogue_track ? ` on track "${args.dialogue_track}"` : ''}; attach a transcript with set_video_transcript, or pass speech: "audio" with dialogue_track.`);
				ranges = videoSpeechRanges(words, 250);
			} else {
				if (!args.dialogue_track) throw new Error('speech "audio" needs dialogue_track: the track whose sound is the speech.');
				const track = p.tracks.find((t) => t.id === args.dialogue_track);
				if (!track) throw new Error(`There is no track "${args.dialogue_track}".`);
				const musicIds = new Set(music.map((m) => m.clip.id));
				for (const c of sortedVideoClips(track)) {
					if (c.type !== 'media' || musicIds.has(c.id)) continue;
					const asset = p.assets.find((a) => a.id === c.asset);
					if (!asset || asset.kind === 'image' || asset.hasAudio === false) continue;
					const peaks = await controller.audioPeaks.load(asset);
					const speed = c.speed ?? 1;
					const src0 = c.in ?? 0;
					const silences = findVideoAudioSilences(peaks, src0, src0 + c.duration * speed, { thresholdDb: -40, minDuration: 250 });
					let at = c.start;
					for (const s of silences) {
						const a = c.start + (s.start - src0) / speed;
						if (a - at > VIDEO_TIME_EPSILON) ranges.push({ from: at, to: a });
						at = c.start + (s.end - src0) / speed;
					}
					if (videoClipEnd(c) - at > VIDEO_TIME_EPSILON) ranges.push({ from: at, to: videoClipEnd(c) });
				}
				if (!ranges.length) throw new Error(`Track "${args.dialogue_track}" has no sound above -40 dBFS, so there is no speech to duck under.`);
			}
			const edits: VideoEdit[] = [];
			const out: Record<string, unknown>[] = [];
			for (const { clip } of music) {
				const base = typeof clip.volume === 'number' ? clip.volume : 1;
				const keys = videoDuckingKeys(clip, ranges, { duckDb: args.duck_db, attack: args.attack, release: args.release, mergeGap: args.merge_gap, base });
				out.push({ clip: clip.id, keys: keys.length, ...(keys.length ? { keyframes: keys } : { note: 'No speech overlaps it.' }) });
				if (keys.length) edits.push({ op: 'set_keyframes', clip: clip.id, property: 'volume', keys });
			}
			if (!edits.length) throw new Error('No speech overlaps the music clips, so there is nothing to duck.');
			const r = controller.apply(edits, 'Duck music');
			if (!r.ok) throw new Error(r.error);
			return { speech: mode, speechRanges: ranges.map((x) => ({ from: round(x.from), to: round(x.to) })), music: out };
		}
	};

	// -----------------------------------------------------------------------------------------
	// Beats
	// -----------------------------------------------------------------------------------------

	const BEAT_FIELDS: Record<string, JsonSchema> = {
		sensitivity: { type: 'number', minimum: 0.5, maximum: 4, description: 'How far above the local average a hit must rise, in standard deviations (default 1.5; lower finds more).' },
		min_bpm: { type: 'number', minimum: 30, maximum: 300, description: 'Slowest tempo to consider (default 60).' },
		max_bpm: { type: 'number', minimum: 30, maximum: 300, description: 'Fastest tempo to consider (default 200).' }
	};
	const beatsOf = async (args: Record<string, any>) => {
		const r = stretch(args);
		const peaks = await controller.audioPeaks.load(r.asset);
		const found = findVideoAudioBeats(peaks, r.from, r.to, { sensitivity: args.sensitivity, minBpm: args.min_bpm, maxBpm: args.max_bpm });
		return { asset: r.asset.id, bpm: found.bpm, beats: found.beats.map((t) => round(r.out(t))), onsets: found.onsets.map((t) => round(r.out(t))) };
	};

	const findBeats: AgentTool = {
		name: 'find_video_beats',
		title: 'Find the beats',
		description:
			'Finds the beat of a music clip or asset: the tempo (BPM, or null when the hits do not repeat), a steady beat grid at that tempo, and the onsets (each hit) — timeline ms for a clip, source ms for an asset. Changes nothing. Use the beats to cut on the music (plan_video_beat_snap), place markers (add_video_marker) or time titles. Works best on percussive music. The first call for an asset decodes its file.',
		inputSchema: object({ ...SOUND_TARGET, ...BEAT_FIELDS }),
		annotations: { title: 'Find the beats', ...SOUND },
		handler: (args) => beatsOf(args)
	};

	const planBeatSnap: AgentTool = {
		name: 'plan_video_beat_snap',
		title: 'Propose cuts on the beat',
		description:
			'Proposes, as a plan for review, moving each cut on a track to the nearest beat within "tolerance" ms with roll edits (the outgoing clip gets longer as the incoming one gets shorter, so nothing else moves). Beats come from a music clip (found as find_video_beats does) or are given. Cuts already on a beat, with none in reach, or without enough media to roll are left (listed in "skipped"). Nothing changes until apply_video_edit_plan. Returns the plan and what was skipped.',
		inputSchema: object(
			{
				track: { ...TRACK_ID, description: 'The track whose cuts to move (default the first video track).' },
				music: { ...CLIP_ID, description: 'A music clip to take the beats from. Pass this or beats.' },
				beats: { type: 'array', minItems: 1, maxItems: 5000, items: { type: 'number', minimum: 0 }, description: 'Beat times on the timeline, in ms. Pass this or music.' },
				tolerance: { type: 'number', exclusiveMinimum: 0, maximum: 2000, description: 'Furthest a cut may move, in ms (default 150).' },
				...BEAT_FIELDS
			}
		),
		annotations: { title: 'Propose cuts on the beat', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		handler: async (args) => {
			const p = project();
			if ((args.music === undefined) === (args.beats === undefined)) throw new Error('Pass either "music" (a music clip to find the beats in) or "beats" (times in ms), not both.');
			const track = args.track !== undefined ? p.tracks.find((t) => t.id === args.track) : p.tracks.find((t) => t.kind === 'video');
			if (!track) throw new Error(args.track !== undefined ? `There is no track "${args.track}".` : 'The project has no video track.');
			let beats: number[];
			if (args.music !== undefined) {
				const found = await beatsOf({ clip: args.music, sensitivity: args.sensitivity, min_bpm: args.min_bpm, max_bpm: args.max_bpm });
				beats = found.beats.length ? found.beats : found.onsets;
				if (!beats.length) throw new Error(`No beats were found in "${args.music}"; try a lower sensitivity, or pass beats.`);
			} else beats = [...(args.beats as number[])].sort((a, b) => a - b);
			const tolerance = args.tolerance ?? 150;
			const clips = sortedVideoClips(track);
			const edits: VideoEdit[] = [];
			const ranges: { from: number; to: number; reason: string }[] = [];
			const skipped: { cut: number; reason: string }[] = [];
			let working = p;
			for (let i = 0; i + 1 < clips.length; i++) {
				const left = clips[i];
				const right = clips[i + 1];
				const cut = videoClipEnd(left);
				if (Math.abs(right.start - cut) > VIDEO_TIME_EPSILON) continue;
				const beat = nearestVideoBeat(beats, cut, tolerance);
				if (beat === null) {
					skipped.push({ cut: round(cut), reason: `no beat within ${tolerance} ms` });
					continue;
				}
				const delta = Math.round((beat - cut) * 10) / 10;
				if (Math.abs(delta) < 1) {
					skipped.push({ cut: round(cut), reason: 'already on the beat' });
					continue;
				}
				const edit: VideoEdit = { op: 'roll_edit', left: left.id, right: right.id, delta };
				const tried = applyVideoEdits(working, edit);
				if (!tried.ok) {
					skipped.push({ cut: round(cut), reason: tried.error });
					continue;
				}
				working = tried.project;
				edits.push(edit);
				ranges.push({ from: Math.min(cut, beat), to: Math.max(cut, beat), reason: 'beat' });
			}
			if (!edits.length) throw new Error(`No cut on track "${track.id}" can move to a beat${skipped.length ? `: ${skipped.slice(0, 5).map((s) => `${s.cut} ms (${s.reason})`).join('; ')}` : ' (it has no cuts between touching clips)'}.`);
			const r = controller.proposePlan({ title: `Snap ${edits.length} cut${edits.length > 1 ? 's' : ''} to the beat`, description: `Rolls cuts on track "${track.id}" to the nearest beat within ${tolerance} ms.`, edits, ranges, source: 'plan_video_beat_snap' });
			if (!r.ok) throw new Error(r.error);
			return { plan: { id: r.plan.id, title: r.plan.title, summary: r.plan.summary, text: describeVideoEditPlan(r.plan) }, moved: edits.length, skipped, hint: `Nothing changed yet. Call apply_video_edit_plan with plan "${r.plan.id}" once the user agrees.` };
		}
	};

	const reads = [measureLoudness, findBeats];
	const writes = [normalizeLoudness, duckMusic, planBeatSnap];
	return withVideoPlayback(
		{
			id: options.id ?? 'video-music',
			namespace: options.namespace,
			title: 'Video music and mix',
			description: 'Music and the mix: beats and cuts on the beat, ducking music under speech, and loudness in LUFS.',
			skill: 'pixerate-bgm-alignment',
			tools: () => (readOnlyReason() ? reads : [...reads, ...writes]),
			subscribe: (notify) => {
				let last = readOnlyReason();
				return controller.subscribe(() => {
					const now = readOnlyReason();
					if (now !== last) {
						last = now;
						notify();
					}
				});
			}
		},
		options.playbackSurface
	);
}
