import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import type { VideoIssue } from './check.js';
import type { VideoEditorController } from './controller.js';
import { VIDEO_EDIT_OPS, type VideoEdit, type VideoEditOutcome, type VideoEditResult } from './edit.js';
import { findVideoAudioSilences, videoAudioLevels } from './audio.js';
import { findVideoFillers, findVideoTranscriptPauses, findVideoTranscriptText, mergeVideoRanges, parseVideoTranscript, VIDEO_DEFAULT_FILLERS, videoRemoveRangesEdits, videoTimelineTranscript, videoTranscriptTrack, type VideoTranscriptRange } from './transcript.js';
import { videoFreezeFrameEdit, videoSpeedRampEdit, videoSpeedRampKeys } from './remap.js';
import { VIDEO_GRADE_CONTROLS, VIDEO_GRADE_PRESET_NAMES, videoGradeLook } from './grade.js';
import { videoLutEdits } from './ui.js';
import { videoFrameAt } from './evaluate.js';
import { summarizeVideoScopes, type VideoPixels } from './scopes.js';
import { videoAssetProxy, videoProxyPlan } from './proxy.js';
import { VIDEO_EASE_NAMES, VIDEO_KEYFRAME_PROPERTIES, VIDEO_TRANSFORM_PROPERTIES, type VideoAnimatable, type VideoKeyframeProperty } from './keyframes.js';
import { videoContactSheetSvg, videoProjectSvg } from './render.js';
import { allVideoTracks, findVideoClip, findVideoGaps, findVideoSequenceCycle, formatVideoSeconds, formatVideoTimecode, sortedVideoClips, VIDEO_TIME_EPSILON, videoClipEnd, videoClipSourceRange, videoProjectDuration, videoSequenceChildren, videoSequenceDuration } from './timeline.js';
import { VIDEO_BLEND_MODES, VIDEO_CLIP_ANIMATION_EFFECTS, VIDEO_FADE_CURVES, VIDEO_FITS, VIDEO_PLACEMENT_MODES, VIDEO_TRANSITION_TYPES, VIDEO_WIPE_DIRECTIONS, type VideoAsset, type VideoProject, type VideoSequence, type VideoTrack } from './types.js';

/** Times in results, to a tenth of a millisecond. */
const round = (ms: number) => Math.round(ms * 10) / 10;

export interface VideoEditorToolProviderOptions {
	/** Provider id (unique per registry). Default `video`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** The project cannot be edited: write tools are hidden and `get_video_project` says why. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
	/** Turns SVG into PNG (e.g. `rasterizeSvg`), so `render_video_frame` can return an image. */
	rasterize?: (svg: string, size: { width: number; height: number }) => Promise<{ data: string; mimeType: string }> | { data: string; mimeType: string };
	/**
	 * The rendered pixels of the frame at `time` (ms), for `get_video_scopes` (e.g. a frame decoded
	 * by ffmpeg on a server). Default: what the editor's `<VideoPreview>` draws, through
	 * `controller.previewPixels`, seeking it there and back when `time` is not the playhead.
	 */
	framePixels?: (time: number) => VideoPixels | null | Promise<VideoPixels | null>;
	/** How long `get_video_scopes` waits for the preview to finish drawing a frame (ms, default 5000). */
	framePixelsTimeout?: number;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const object = (properties: Record<string, JsonSchema>, required: string[] = [], description?: string): JsonSchema & { type: 'object' } => ({
	type: 'object' as const,
	...(description ? { description } : {}),
	properties,
	...(required.length ? { required } : {}),
	additionalProperties: false
});

const MS = (what: string) => ({ type: 'number', minimum: 0, description: `${what}, in milliseconds.` }) as const;
const CLIP_ID = { type: 'string', minLength: 1, description: 'A clip id from get_video_project (e.g. "c1").' } as const;
const TRACK_ID = { type: 'string', minLength: 1, description: 'A track id from get_video_project (e.g. "v1" or "a1").' } as const;
const ASSET_ID = { type: 'string', minLength: 1, description: 'An asset id from get_video_project.' } as const;
const COLOR = (what: string) => ({ type: 'string', minLength: 1, description: `${what}: a CSS colour such as "#ffcc00".` }) as const;
const RIPPLE = {
	type: 'boolean',
	description:
		'Push (or pull) later material along by the change, keeping the cuts after it in sync (default false: refuse if it would overlap). When the track is sync-locked (the default), every other unlocked sync-locked track moves too: clips across the edit point are cut when time opens, and closing time is refused if another sync-locked track has a clip in that stretch.'
} as const;
const MODE = {
	type: 'string',
	enum: [...VIDEO_PLACEMENT_MODES],
	description:
		'What to do with clips already where it lands: "refuse" (default) fails with the next free place; "overwrite" cuts, trims or removes what is underneath on that track; "insert" cuts everything across the start and pushes later material along by its length on this track and every sync-locked track.'
} as const;
const DELTA = (what: string) => ({ type: 'number', description: `${what}, in milliseconds of timeline time: positive is later, negative earlier. It is clamped to what the media and neighbours allow; the result says how far it went.` }) as const;
const RANGE_TRACKS = { type: 'array', items: TRACK_ID, minItems: 1, uniqueItems: true, description: 'Tracks to work on (default: every unlocked track). Locked tracks are refused.' } as const;

const TRANSFORM = object(
	{
		x: { type: 'number', description: 'Offset of the centre to the right of the frame\'s centre, in pixels (default 0).' },
		y: { type: 'number', description: 'Offset of the centre below the frame\'s centre, in pixels (default 0).' },
		scale: { type: 'number', minimum: 0, description: 'Size after fitting (1 = fitted size, default 1).' },
		rotation: { type: 'number', description: 'Degrees clockwise (default 0).' }
	},
	[],
	'Where the picture sits after it is fitted.'
);
const TRANSITION = object(
	{
		type: { type: 'string', enum: VIDEO_TRANSITION_TYPES.filter((t) => t !== 'effect'), description: 'crossfade (this clip fades up over the one before), dip (down into a colour and up out of it), wipe (an edge travels across revealing this clip), push (this clip slides in and pushes the one before out), slide (this clip slides in over the one before) or iris (a circle opens from the centre). For a transition effect from the effects provider use set_video_effect_transition.' },
		duration: { type: 'number', exclusiveMinimum: 0, description: 'Length in ms, centred on the cut. Every type but dip needs half of it in media past the cut on both sides (handles); a dip needs none.' },
		color: COLOR('For dip: the colour passed through (default black)'),
		direction: { type: 'string', enum: [...VIDEO_WIPE_DIRECTIONS], description: 'For wipe, push and slide: the way the edge or picture travels (default right, coming in from the left).' },
		audioCurve: { type: 'string', enum: [...VIDEO_FADE_CURVES], description: 'Shape of the sound\'s fades through it: default equal-power for every type but dip (steady loudness while the two sounds overlap), linear for dip; or s-curve, exponential, logarithmic.' }
	},
	['type', 'duration'],
	'A transition from the clip that ends where this one starts on the same track.'
);
const LUT_SRC = { type: 'string', minLength: 1, description: 'A .cube 3D LUT file the host can load and ffmpeg can read: a URL or path, often from the user (e.g. "luts/teal-orange.cube").' } as const;
const LUT_STRENGTH = { type: 'number', minimum: 0, maximum: 1, description: 'How much of the LUT\'s change to apply, 0 (none) to 1 (full, the default); 0.3-0.7 for a subtler look.' } as const;
const GRADE = object(
	{
		...Object.fromEntries(VIDEO_GRADE_CONTROLS.map((c) => [c.key, { type: 'number', minimum: c.min, maximum: c.max, description: c.description }])),
		lut: object({ src: LUT_SRC, strength: LUT_STRENGTH, name: { type: 'string', minLength: 1, description: 'A label for the look.' } }, ['src'], 'A 3D LUT applied after the other settings (set_video_lut checks the file first).')
	},
	[],
	'Colour correction of the picture, applied in order: exposure, contrast, saturation, hue, white balance (temperature, tint), then a LUT. Leave a setting out for no change; the object replaces the clip\'s whole grade.'
);
const ANIMATION = (when: string) =>
	object(
		{
			effect: { type: 'string', enum: [...VIDEO_CLIP_ANIMATION_EFFECTS], description: 'fade; rise (up into place) or drop (down into place); slide-left / slide-right (moving that way); zoom (grows into place); pop (grows past its size and settles). Each also fades; an exit plays the movement backwards.' },
			duration: { type: 'number', exclusiveMinimum: 0, description: 'Length in ms (default 500).' }
		},
		['effect'],
		when
	);
const CLIP_COMMON: Record<string, JsonSchema> = {
	name: { type: 'string', description: 'A label for the clip.' },
	opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Opacity 0–1 (default 1). A number replaces any keyframes; set_video_keyframes animates it.' },
	transform: TRANSFORM,
	fit: { type: 'string', enum: [...VIDEO_FITS], description: 'How the picture fits the frame before the transform, as CSS object-fit (default contain for media, fill for colours).' },
	grade: GRADE,
	animateIn: ANIMATION('How the picture enters, from the clip\'s start (on top of any fade in). Titles usually rise, pop or fade in.'),
	animateOut: ANIMATION('How the picture leaves, ending at the clip\'s end.'),
	blend: { type: 'string', enum: [...VIDEO_BLEND_MODES], description: 'How the picture mixes with what is beneath it, as CSS mix-blend-mode (default normal): multiply darkens (shadows, textures), screen and add lighten (light leaks, flares, glows), overlay and soft-light add contrast, difference and exclusion invert.' },
	fadeIn: MS('Fade up from nothing (picture and sound) over this long'),
	fadeOut: MS('Fade down to nothing over this long')
};
const MEDIA_FIELDS: Record<string, JsonSchema> = {
	in: MS('Where in the source it starts (default 0)'),
	speed: { type: 'number', minimum: 0.05, maximum: 20, description: 'Playback speed (default 1). Changing it keeps the stretch of source, so the clip gets shorter or longer.' },
	volume: { type: 'number', minimum: 0, maximum: 4, description: 'Gain (1 = unchanged, default 1). A number replaces any keyframes; set_video_keyframes animates it.' },
	muted: { type: 'boolean', description: 'Silence this clip (default false).' },
	fadeInCurve: { type: 'string', enum: [...VIDEO_FADE_CURVES], description: 'Shape of the sound\'s fade in (default linear; the picture always fades linearly): linear, equal-power (steady loudness, best for crossfades), s-curve (gentle at both ends), exponential (slow start, natural from silence) or logarithmic (fast start).' },
	fadeOutCurve: { type: 'string', enum: [...VIDEO_FADE_CURVES], description: 'Shape of the sound\'s fade out (default linear), the same choices as fadeInCurve; exponential sounds natural fading to silence.' }
};
const TEXT_FIELDS: Record<string, JsonSchema> = {
	text: { type: 'string', minLength: 1, description: 'The title\'s text ("\\n" breaks lines).' },
	color: COLOR('Text colour (default white)'),
	fontSize: { type: 'number', exclusiveMinimum: 0, description: 'Pixels (default 64).' },
	fontFamily: { type: 'string', description: 'CSS font family (default sans-serif).' },
	fontWeight: { type: 'number', minimum: 100, maximum: 1000, description: 'CSS weight (default 700).' },
	background: COLOR('A box behind the text (default none)')
};
const PLACEMENT: Record<string, JsonSchema> = {
	id: { type: 'string', minLength: 1, description: 'Id for the clip (default: a fresh one such as "c3").' },
	start: MS('Where it starts on the timeline (default: the end of the track)'),
	duration: { type: 'number', exclusiveMinimum: 0, description: 'Length on the timeline, in ms (default: the rest of the source for media, 5000 for stills, 3000 for titles and colours).' }
};
const NEW_CLIP: JsonSchema = {
	description: 'The clip: media (a stretch of an asset), text (a title) or color (a solid fill).',
	oneOf: [
		object({ type: { const: 'media', description: 'A stretch of an asset.' }, asset: ASSET_ID, ...PLACEMENT, ...CLIP_COMMON, ...MEDIA_FIELDS }, ['type', 'asset'], 'A media clip.'),
		object({ type: { const: 'text', description: 'A title over the picture.' }, ...PLACEMENT, ...CLIP_COMMON, ...TEXT_FIELDS }, ['type', 'text'], 'A title.'),
		object({ type: { const: 'color', description: 'A solid colour filling the frame.' }, color: COLOR('The fill'), ...PLACEMENT, ...CLIP_COMMON }, ['type', 'color'], 'A colour.')
	]
};
const SETTINGS: Record<string, JsonSchema> = {
	name: { type: 'string', description: 'Project name.' },
	width: { type: 'integer', minimum: 16, maximum: 8192, description: 'Frame width in pixels.' },
	height: { type: 'integer', minimum: 16, maximum: 8192, description: 'Frame height in pixels.' },
	fps: { type: 'number', exclusiveMinimum: 0, maximum: 240, description: 'Frames per second (e.g. 24, 25, 30, 60).' },
	background: COLOR('What shows where no clip covers the frame (default black)')
};
const TRACK_FIELDS: Record<string, JsonSchema> = {
	name: { type: 'string', description: 'Track label.' },
	muted: { type: 'boolean', description: 'Silence every clip on it.' },
	hidden: { type: 'boolean', description: 'Leave its pictures out of the frame.' },
	locked: { type: 'boolean', description: 'Refuse edits to its clips.' },
	syncLocked: { type: 'boolean', description: 'Move with ripple edits on other sync-locked tracks so it stays in sync (default true). Turn off for a track that should stay put, e.g. a music bed.' },
	volume: { type: 'number', minimum: 0, maximum: 4, description: 'Gain for every clip on it (1 = unchanged).' }
};
const ASSET_FIELDS: Record<string, JsonSchema> = {
	src: { type: 'string', minLength: 1, description: 'URL, path or data URL the player and exporter can open.' },
	name: { type: 'string', description: 'Display name (e.g. the file name).' },
	duration: { type: 'number', exclusiveMinimum: 0, description: 'Length of the source in ms (required to check trims of video and audio).' },
	width: { type: 'number', exclusiveMinimum: 0, description: 'Pixel width (video and image; default the project width).' },
	height: { type: 'number', exclusiveMinimum: 0, description: 'Pixel height.' },
	hasAudio: { type: 'boolean', description: 'For video: whether it has sound (default true).' },
	poster: { type: 'string', description: 'For video: a still (URL) to show in rendered frames.' }
};

const KEY_PROPERTY = {
	type: 'string',
	enum: [...VIDEO_KEYFRAME_PROPERTIES],
	description: 'Which property: opacity (0–1), volume (media only, 0–4 gain), x / y (pixels from the frame\'s centre, right / down), scale (1 = fitted size) or rotation (degrees clockwise).'
} as const;
const KEYS: JsonSchema = {
	type: 'array',
	minItems: 1,
	maxItems: 500,
	description: 'The keys, replacing any the property had (any order, one per time). Before the first key the property holds the first value, after the last the last value.',
	items: object(
		{
			t: { type: 'number', description: 'Time in ms from the clip\'s start (clip time, not timeline time: 0 is the clip\'s first frame, its duration the end). Keys stay with the clip when it moves, is trimmed or split.' },
			v: { type: 'number', description: 'The value at that time, in the property\'s units.' },
			ease: {
				description: 'How the value moves from this key to the next (default linear): linear, hold (stays, then jumps at the next key), ease-in, ease-out, ease-in-out, or CSS cubic-bezier points [x1, y1, x2, y2] with x1 and x2 in 0–1.',
				anyOf: [
					{ type: 'string', enum: [...VIDEO_EASE_NAMES] },
					{ type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }
				]
			}
		},
		['t', 'v'],
		'One keyframe.'
	)
};

const issueSummary = (issues: readonly VideoIssue[]) => ({
	errors: issues.filter((i) => i.severity === 'error').length,
	warnings: issues.filter((i) => i.severity === 'warning').length,
	notes: issues.filter((i) => i.severity === 'note').length,
	lines: issues.map((i) => `${i.severity}: ${i.message}`)
});

/** An asset as agents see it: a transcript is summarised as its word count (get_video_transcript reads it). */
const videoAssetOut = (a: VideoAsset) => {
	const { transcript, ...rest } = a;
	return transcript ? { ...rest, transcriptWords: transcript.length } : rest;
};

/** Tracks as agents see them: each with its clips in time order, their ends and (media and compounds) the source they play. */
const describeVideoTracks = (tracks: readonly VideoTrack[]) =>
	tracks.map((t, index) => ({
		id: t.id,
		kind: t.kind,
		index,
		...(t.name ? { name: t.name } : {}),
		...(t.muted ? { muted: true } : {}),
		...(t.hidden ? { hidden: true } : {}),
		...(t.locked ? { locked: true } : {}),
		...(t.syncLocked === false ? { syncLocked: false } : {}),
		...(t.volume !== undefined ? { volume: t.volume } : {}),
		clips: sortedVideoClips(t).map((c) => ({ ...c, end: videoClipEnd(c), ...(c.type === 'media' || c.type === 'sequence' ? { source: videoClipSourceRange(c) } : {}) }))
	}));

/** The compound clips that play a sequence, wherever they are (the project's tracks or other sequences). */
const videoSequenceUsers = (project: VideoProject, id: string) =>
	allVideoTracks(project).flatMap(({ sequence, track }) =>
		track.clips.flatMap((c) => (c.type === 'sequence' && c.sequence === id ? [{ clip: c.id, ...(sequence ? { inSequence: sequence } : {}), track: track.id, start: c.start, end: videoClipEnd(c), source: videoClipSourceRange(c)! }] : []))
	);

/** A sequence as agents see it: its length, the sequences it nests, who plays it, and (with `tracks`) its tracks and clips. */
export function describeVideoSequence(project: VideoProject, sequence: VideoSequence, tracks = true) {
	const cycle = findVideoSequenceCycle(project, sequence.id);
	return {
		id: sequence.id,
		...(sequence.name ? { name: sequence.name } : {}),
		duration: videoSequenceDuration(sequence),
		clipCount: sequence.tracks.reduce((n, t) => n + t.clips.length, 0),
		nests: videoSequenceChildren(sequence),
		usedBy: videoSequenceUsers(project, sequence.id),
		...(cycle ? { cycle } : {}),
		...(tracks ? { tracks: describeVideoTracks(sequence.tracks) } : { trackCount: sequence.tracks.length })
	};
}

/** A project as agents see it: settings, assets, each track's clips in order with their times, and a summary of each sequence. */
export function describeVideoProject(project: VideoProject) {
	return {
		...(project.name ? { name: project.name } : {}),
		width: project.width,
		height: project.height,
		fps: project.fps,
		duration: videoProjectDuration(project),
		...(project.background ? { background: project.background } : {}),
		assets: project.assets.map(videoAssetOut),
		tracks: describeVideoTracks(project.tracks),
		...(project.sequences?.length ? { sequences: project.sequences.map((q) => describeVideoSequence(project, q, false)) } : {}),
		markers: project.markers ?? []
	};
}

/**
 * Agent tools for a `VideoEditorController`: read the project (assets, tracks with clips and their
 * times, gaps, what plays at a moment), check it, render frames, export to ffmpeg or an EDL, and
 * edit it a step at a time (add assets and tracks, add / move / trim / split / delete clips with
 * overwrite, insert and sync-locked ripple, slip / roll / slide, lift / extract a range, cut across
 * tracks, transitions, markers). Every write is checked first (unknown ids with "did you mean", overlaps,
 * trims past the source, locked tracks), applies as one undo step, and returns what it made and
 * the resulting length and issues. Write tools are hidden while the project is read-only.
 */
export function createVideoEditorToolProvider(controller: VideoEditorController, options: VideoEditorToolProviderOptions = {}): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (r) return typeof r === 'string' ? r : 'This video project is read-only.';
		return controller.readOnlyReason();
	};
	const project = () => controller.getProject();
	const outcome = (result: VideoEditResult, extra: Record<string, unknown> = {}) => {
		if (!result.ok) throw new Error(result.error);
		return { ...extra, duration: videoProjectDuration(result.project), issues: issueSummary(result.issues) };
	};
	const apply = (edits: VideoEdit | VideoEdit[], label: string, extra?: (r: Extract<VideoEditResult, { ok: true }>) => Record<string, unknown>) => {
		const result = controller.apply(edits, label);
		return outcome(result, result.ok && extra ? extra(result) : {});
	};
	const clipOut = (p: VideoProject, id: string) => {
		for (const t of p.tracks) {
			const c = t.clips.find((x) => x.id === id);
			if (c) return { track: t.id, ...c, end: videoClipEnd(c), ...(c.type === 'media' || c.type === 'sequence' ? { source: videoClipSourceRange(c) } : {}) };
		}
		return null;
	};

	/** What a placement or ripple did besides the clip itself. */
	const placed = (o: VideoEditOutcome) => ({
		...(o.created?.length ? { created: o.created } : {}),
		...(o.trimmed?.length ? { trimmed: o.trimmed } : {}),
		...(o.removed?.length ? { removed: o.removed } : {}),
		...(o.rippled ? { rippled: o.rippled } : {})
	});
	const keysOut = (p: VideoProject, clip: string, property: VideoKeyframeProperty) => {
		const c = clipOut(p, clip) as any;
		const value: VideoAnimatable | undefined = (VIDEO_TRANSFORM_PROPERTIES as readonly string[]).includes(property) ? c?.transform?.[property] : c?.[property];
		return typeof value === 'object' ? { keys: value.keys } : { keys: [], value: value ?? null };
	};

	const getProject: AgentTool = {
		name: 'get_video_project',
		title: 'Read the video project',
		description:
			'Returns the whole project: frame size, fps, length (ms), assets (id, kind, src, duration), tracks top to bottom (an earlier video track draws over a later one) with each clip in time order (id, type, start, duration, end, source in/out for media and compound clips, fades, transition), a summary of each nested sequence (id, name, length, clip count, the sequences it nests, the compound clips that play it) and markers, plus the playhead, selection, issues and whether it can be edited. Compound clips (type "sequence") play a sequence\'s tracks as one picture and sound; list_video_sequences reads what is inside them.',
		inputSchema: object({}),
		annotations: { title: 'Read the video project', ...READ },
		handler: () => {
			const state = controller.getState();
			const reason = readOnlyReason();
			return { ...describeVideoProject(state.project), playhead: state.time, previewScale: state.previewScale, selection: state.selection, issues: issueSummary(state.issues), editable: !reason, ...(reason ? { readOnlyReason: reason } : {}) };
		}
	};

	const getFrame: AgentTool = {
		name: 'get_video_frame',
		title: 'What plays at a moment',
		description: 'Returns what plays at a time without changing anything: the pictures back to front (clip, track, asset, source time in ms, opacity, placement rect, rotation, any wipe or iris) and the sounds (clip, source time, gain after volumes, fades and transitions). A compound clip is one picture with its sequence, the moment of the sequence it shows (sourceTime) and the sequence\'s own pictures as "layers"; its sounds are listed with clip paths such as "compound/inner".',
		inputSchema: object({ time: MS('Time from the start (default: the playhead)') }),
		annotations: { title: 'What plays at a moment', ...READ },
		handler: ({ time }) => {
			const frame = videoFrameAt(project(), time ?? controller.getState().time);
			return { ...frame, timecode: formatVideoTimecode(frame.time, project().fps) };
		}
	};

	const listSequences: AgentTool = {
		name: 'list_video_sequences',
		title: 'List nested sequences',
		description:
			'Lists the project\'s nested sequences, the tracks that compound clips (type "sequence") play as one picture and sound, without changing anything. For each: id, name, length (ms), the sequences it nests, the compound clips that play it (clip id, the track and sequence they sit on, timeline start and end, and the stretch of the sequence they play as source in / out) and its tracks with their clips, in the same shape as get_video_project. A sequence that contains itself lists the loop as "cycle". Clips inside sequences can be read here but not edited yet; edit the compound clip instead (move, trim, its opacity, blend, grade, volume).',
		inputSchema: object({ sequence: { type: 'string', minLength: 1, description: 'Only this sequence id (default: every sequence).' } }),
		annotations: { title: 'List nested sequences', ...READ },
		handler: ({ sequence }) => {
			const p = project();
			const all = p.sequences ?? [];
			if (sequence !== undefined) {
				const found = all.find((q) => q.id === sequence);
				if (!found) throw new Error(`There is no sequence "${sequence}"; ${all.length ? `the sequences are ${all.map((q) => `"${q.id}"`).join(', ')}` : 'the project has no sequences'}.`);
				return { sequences: [describeVideoSequence(p, found)] };
			}
			return { sequences: all.map((q) => describeVideoSequence(p, q)) };
		}
	};

	const findGaps: AgentTool = {
		name: 'find_video_gaps',
		title: 'Find gaps',
		description: 'Lists empty stretches between clips (and before the first) on every track or one track, as { track, start, end } in ms. close_video_gaps removes them.',
		inputSchema: object({ track: { ...TRACK_ID, description: 'Only this track (default all).' } }),
		annotations: { title: 'Find gaps', ...READ },
		handler: ({ track }) => {
			if (track !== undefined && !project().tracks.some((t) => t.id === track)) throw new Error(`There is no track "${track}"; the tracks are ${project().tracks.map((t) => `"${t.id}"`).join(', ')}.`);
			return { gaps: findVideoGaps(project(), track) };
		}
	};

	const checkProject: AgentTool = {
		name: 'check_video_project',
		title: 'Check the video project',
		description: 'Lists the project\'s problems, errors first, each with a code, the clip / track / asset it is about and how to fix it: missing assets, overlaps, clips past the end of their source, transitions without a cut or handles, fades or animations longer than the clip, animations a clip\'s own keyframes override, keyframes outside their clip, assets with no duration, unused assets.',
		inputSchema: object({}),
		annotations: { title: 'Check the video project', ...READ },
		handler: () => {
			const issues = controller.getState().issues;
			return { ...issueSummary(issues), issues };
		}
	};

	const renderFrame: AgentTool = {
		name: 'render_video_frame',
		title: 'Render a frame',
		description:
			'Draws the project at one moment (or several, as one labelled contact sheet) to check the picture, without changing it: SVG by default, PNG (format "png") when the host can rasterize. Images and video posters are drawn; video without a poster shows as a labelled box with its source timecode.',
		inputSchema: object({
			time: MS('Time from the start (default: the playhead)'),
			times: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 2, maxItems: 16, description: 'Several moments (ms) drawn as one contact sheet instead of "time".' },
			columns: { type: 'integer', minimum: 1, maximum: 8, description: 'With times: frames a row (default about square).' },
			format: { type: 'string', enum: ['svg', 'png'], description: 'svg (default) or png (only when the host supports it).' }
		}),
		annotations: { title: 'Render a frame', ...READ },
		handler: async ({ time, times, columns, format = 'svg' }) => {
			const p = project();
			// LUTs are drawn from their tables (approximated in SVG), so load the ones in use first.
			const lutSrcs = [...new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.grade?.lut?.src).filter((x): x is string => !!x)))];
			const missing = (await Promise.all(lutSrcs.map((src) => controller.luts.load(src).then(() => null, (e: Error) => e.message)))).filter((m): m is string => !!m);
			const svgOptions = { lutFor: (src: string) => controller.luts.peek(src), ...(columns ? { columns } : {}) };
			const svg = times ? videoContactSheetSvg(p, times, svgOptions) : videoProjectSvg(p, time ?? controller.getState().time, svgOptions);
			const notes = [...missing.map((m) => `${m}; that LUT is left out of the picture.`), ...(lutSrcs.length > missing.length ? ['LUTs are drawn approximately in SVG (curves and a colour matrix); the preview and export apply them exactly.'] : [])];
			if (format === 'png') {
				if (!options.rasterize) throw new Error('This host cannot make PNG images; call render_video_frame with format "svg".');
				const size = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!;
				const image = await options.rasterize(svg, { width: Number(size[1]), height: Number(size[2]) });
				return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }, ...(notes.length ? [{ type: 'text' as const, text: notes.join(' ') }] : [])] };
			}
			return { svg, ...(notes.length ? { notes } : {}) };
		}
	};

	const LOUDNESS_TARGET: Record<string, JsonSchema> = {
		integrated: { type: 'number', minimum: -70, maximum: -5, description: 'Integrated loudness to reach, in LUFS (default -14, what streaming services play at; -16 for podcasts, -23 for EBU R128 broadcast).' },
		truePeak: { type: 'number', minimum: -9, maximum: 0, description: 'Highest true peak, in dBTP (default -1).' },
		range: { type: 'number', minimum: 1, maximum: 50, description: 'Loudness range, in LU (default 11).' }
	};
	const exportFfmpeg: AgentTool = {
		name: 'export_video_ffmpeg',
		title: 'Export an ffmpeg command',
		description:
			'Returns the ffmpeg command that renders the project to a file: { args (for spawn), command (one shell line), filterComplex, duration, notes on anything approximated }. With loudness, the mix is normalised to a target loudness (EBU R128); add loudness.measured from a measuring pass (export_video_loudness_measure) for an exact fixed gain. Fails when the project has no clips.',
		inputSchema: object({
			output: { type: 'string', minLength: 1, description: 'Output file name (default output.mp4).' },
			crf: { type: 'integer', minimum: 0, maximum: 51, description: 'x264 quality, lower is better (default 18).' },
			loudness: object(
				{
					...LOUDNESS_TARGET,
					measured: object(
						{
							integrated: { type: 'number', description: 'Measured integrated loudness, LUFS (loudnorm\'s "input_i").' },
							truePeak: { type: 'number', description: 'Measured true peak, dBTP ("input_tp").' },
							range: { type: 'number', description: 'Measured loudness range, LU ("input_lra").' },
							threshold: { type: 'number', description: 'Measured gating threshold, LUFS ("input_thresh").' },
							offset: { type: 'number', description: 'Offset for the second pass, LU ("target_offset").' }
						},
						['integrated', 'truePeak', 'range', 'threshold', 'offset'],
						'What the measuring pass printed (the JSON at the end of its stderr), for a linear second pass that keeps the dynamics. Leave out for one-pass normalisation.'
					)
				},
				[],
				'Normalise the mix\'s loudness (default: not normalised). An empty object uses -14 LUFS, -1 dBTP.'
			)
		}),
		annotations: { title: 'Export an ffmpeg command', ...READ },
		handler: ({ output, crf, loudness }) => controller.toFfmpeg({ ...(output ? { output } : {}), ...(crf !== undefined ? { crf } : {}), ...(loudness ? { loudness } : {}) })
	};

	const exportLoudnessMeasure: AgentTool = {
		name: 'export_video_loudness_measure',
		title: 'Export a loudness measuring command',
		description:
			'Returns the ffmpeg command for the first pass of a loudness normalisation: it mixes only the sound and prints its loudness as JSON at the end of stderr (input_i, input_tp, input_lra, input_thresh, target_offset) instead of writing a file. Pass those numbers as loudness.measured (integrated, truePeak, range, threshold, offset) to export_video_ffmpeg, with the same target. Fails when nothing makes a sound.',
		inputSchema: object(LOUDNESS_TARGET),
		annotations: { title: 'Export a loudness measuring command', ...READ },
		handler: (target) => controller.toLoudnessMeasure({ loudness: target })
	};

	const exportEdl: AgentTool = {
		name: 'export_video_edl',
		title: 'Export an EDL',
		description: 'Returns one track as a CMX 3600 edit decision list (text) for conforming in another editor: events with source and record timecode (drop-frame at 29.97 and 59.94 fps unless dropFrame is false), dissolves, speed changes and clip names.',
		inputSchema: object({
			track: { ...TRACK_ID, description: 'Track to export (default: the bottom video track).' },
			title: { type: 'string', description: 'TITLE line (default: the project name).' },
			dropFrame: { type: 'boolean', description: 'Drop-frame timecode (HH:MM:SS;FF). Default true at 29.97 and 59.94 fps, where it is the norm; ignored at other rates, which have no drop-frame form.' }
		}),
		annotations: { title: 'Export an EDL', ...READ },
		handler: ({ track, title, dropFrame }) => ({ edl: controller.toEdl({ ...(track ? { track } : {}), ...(title ? { title } : {}), ...(dropFrame !== undefined ? { dropFrame } : {}) }) })
	};

	const seek: AgentTool = {
		name: 'seek_video',
		title: 'Show a moment',
		description: 'Moves the playhead the person sees to a time, a clip\'s start or a marker, and plays or pauses. Does not change the project. Returns the playhead and the clips under it.',
		inputSchema: object({
			time: MS('Time from the start'),
			clip: { ...CLIP_ID, description: 'Go to the start of this clip instead of "time".' },
			marker: { type: 'string', minLength: 1, description: 'Go to this marker instead of "time".' },
			play: { type: 'boolean', description: 'true plays from there, false pauses (default: leave as is).' }
		}),
		annotations: { title: 'Show a moment', ...WRITE_IDEMPOTENT },
		handler: ({ time, clip, marker, play }) => {
			const p = project();
			if (clip !== undefined) {
				const c = clipOut(p, clip);
				if (!c) throw new Error(`There is no clip "${clip}".`);
				controller.seek(c.start);
			} else if (marker !== undefined) {
				const m = (p.markers ?? []).find((x) => x.id === marker);
				if (!m) throw new Error(`There is no marker "${marker}"; the markers are ${(p.markers ?? []).map((x) => `"${x.id}"`).join(', ') || 'none'}.`);
				controller.seek(m.time);
			} else if (time !== undefined) controller.seek(time);
			if (play === true) controller.play();
			if (play === false) controller.pause();
			const state = controller.getState();
			return { time: state.time, timecode: formatVideoTimecode(state.time, p.fps), playing: state.playing, clips: state.current };
		}
	};

	const setSettings: AgentTool = {
		name: 'set_video_settings',
		title: 'Change project settings',
		description: 'Sets the name, frame size, frame rate or background colour (one undo step). Returns the length and issues.',
		inputSchema: object(SETTINGS),
		annotations: { title: 'Change project settings', ...WRITE_IDEMPOTENT },
		handler: (args) => {
			if (!Object.keys(args).length) throw new Error('Give at least one setting to change (name, width, height, fps, background).');
			return apply({ op: 'set_settings', ...args }, 'Change settings');
		}
	};

	const addAsset: AgentTool = {
		name: 'add_video_asset',
		title: 'Add media',
		description: 'Adds a video, audio or image file to the project so clips can use it (one undo step). Give the duration of video and audio so trims can be checked. Returns the asset id.',
		inputSchema: object({ id: { type: 'string', minLength: 1, description: 'Id for it (default: from its name or file name).' }, kind: { type: 'string', enum: ['video', 'audio', 'image'], description: 'What it is.' }, ...ASSET_FIELDS }, ['kind', 'src']),
		annotations: { title: 'Add media', ...WRITE },
		handler: (asset) => apply({ op: 'add_asset', asset: asset as any }, 'Add media', (r) => ({ asset: r.outcomes[0].asset }))
	};

	const updateAsset: AgentTool = {
		name: 'update_video_asset',
		title: 'Change media details',
		description: 'Changes an asset\'s src, name, duration, size, sound or poster (e.g. relinking moved media). Clips that now run past its end are refused. Returns the asset.',
		inputSchema: object({ asset: ASSET_ID, set: object(ASSET_FIELDS, [], 'Fields to replace.'), remove: { type: 'array', items: { type: 'string', enum: ['name', 'duration', 'width', 'height', 'hasAudio', 'poster', 'transcript', 'proxies'] }, description: 'Fields to clear (transcript removes its words, proxies its proxies).' } }, ['asset']),
		annotations: { title: 'Change media details', ...WRITE_IDEMPOTENT },
		handler: ({ asset, set, remove }) => apply({ op: 'update_asset', asset, set, remove }, 'Change media', (r) => ({ asset: videoAssetOut(r.project.assets.find((a) => a.id === asset)!) }))
	};

	const removeAsset: AgentTool = {
		name: 'remove_video_asset',
		title: 'Remove media',
		description: 'Removes an asset no clip uses (one undo step); refused while clips use it, naming them. Returns the remaining asset ids.',
		inputSchema: object({ asset: ASSET_ID }, ['asset']),
		annotations: { title: 'Remove media', ...DESTRUCTIVE },
		handler: ({ asset }) => apply({ op: 'remove_asset', asset }, 'Remove media', (r) => ({ removed: asset, assets: r.project.assets.map((a) => a.id) }))
	};

	const addTrack: AgentTool = {
		name: 'add_video_track',
		title: 'Add a track',
		description: 'Adds an empty video or audio track (one undo step). By default a video track goes on top (drawing over the others) and an audio track at the bottom. Returns its id and the track order.',
		inputSchema: object({ kind: { type: 'string', enum: ['video', 'audio'], description: 'Video (pictures, titles, colours) or audio.' }, id: { type: 'string', minLength: 1, description: 'Id (default "v2", "a2", …).' }, at: { type: 'integer', minimum: 0, description: 'Position, 0 = top.' }, ...TRACK_FIELDS }, ['kind']),
		annotations: { title: 'Add a track', ...WRITE },
		handler: ({ kind, id, at, ...fields }) => apply({ op: 'add_track', track: { kind, ...(id ? { id } : {}), ...fields }, at }, 'Add track', (r) => ({ track: r.outcomes[0].track, tracks: r.project.tracks.map((t) => t.id) }))
	};

	const updateTrack: AgentTool = {
		name: 'update_video_track',
		title: 'Change a track',
		description: 'Renames, mutes, hides, locks, sync-locks or sets the volume of a track (one undo step). Returns the track\'s settings.',
		inputSchema: object({ track: TRACK_ID, set: object(TRACK_FIELDS, [], 'Fields to replace.'), remove: { type: 'array', items: { type: 'string', enum: ['name', 'muted', 'hidden', 'locked', 'syncLocked', 'volume'] }, description: 'Fields to clear.' } }, ['track']),
		annotations: { title: 'Change a track', ...WRITE_IDEMPOTENT },
		handler: ({ track, set, remove }) =>
			apply({ op: 'update_track', track, set, remove }, 'Change track', (r) => {
				const { clips, ...t } = r.project.tracks.find((x) => x.id === track)!;
				return { track: { ...t, clips: clips.length } };
			})
	};

	const removeTrack: AgentTool = {
		name: 'remove_video_track',
		title: 'Remove a track',
		description: 'Deletes a track and every clip on it (one undo step; refused when locked). Returns the clips removed with it.',
		inputSchema: object({ track: TRACK_ID }, ['track']),
		annotations: { title: 'Remove a track', ...DESTRUCTIVE },
		handler: ({ track }) => apply({ op: 'remove_track', track }, 'Remove track', (r) => ({ removed: track, clips: r.outcomes[0].clips }))
	};

	const moveTrack: AgentTool = {
		name: 'move_video_track',
		title: 'Reorder a track',
		description: 'Moves a track to a new position (0 = top; an earlier video track draws over later ones). Returns the track order.',
		inputSchema: object({ track: TRACK_ID, to: { type: 'integer', minimum: 0, description: 'New position, 0 = top.' } }, ['track', 'to']),
		annotations: { title: 'Reorder a track', ...WRITE_IDEMPOTENT },
		handler: ({ track, to }) => apply({ op: 'move_track', track, to }, 'Move track', (r) => ({ tracks: r.project.tracks.map((t) => t.id) }))
	};

	const addClip: AgentTool = {
		name: 'add_video_clip',
		title: 'Add a clip',
		description:
			'Puts a clip on a track (one undo step): media (a stretch of an asset from its "in" point), a title or a colour. With no start it goes at the end of the track. Where it lands on other clips, mode decides: refuse (default, with the next free place), overwrite (replace what is underneath) or insert (push later material along on every sync-locked track). Returns the clip with its end and source range, plus any clips it cut (created), trimmed or removed and the tracks it rippled.',
		inputSchema: object({ track: TRACK_ID, clip: NEW_CLIP, mode: MODE, ripple: { type: 'boolean', description: 'Same as mode "insert" (kept for older callers; default false).' } }, ['track', 'clip']),
		annotations: { title: 'Add a clip', ...WRITE },
		handler: ({ track, clip, mode, ripple }) => apply({ op: 'add_clip', track, clip, mode, ripple }, mode === 'overwrite' ? 'Overwrite clip' : mode === 'insert' || ripple ? 'Insert clip' : 'Add clip', (r) => ({ clip: clipOut(r.project, r.outcomes[0].clip!), ...placed(r.outcomes[0]) }))
	};

	const moveClip: AgentTool = {
		name: 'move_video_clip',
		title: 'Move a clip',
		description:
			'Moves a clip to a new start and/or another track of the same kind (one undo step), leaving a gap where it was. Where it lands on other clips, mode decides: refuse (default, naming the clip and the next free place), overwrite or insert. Returns the clip, plus any clips it cut (created), trimmed or removed and the tracks it rippled.',
		inputSchema: object({ clip: CLIP_ID, start: MS('New start on the timeline (default: unchanged)'), track: { ...TRACK_ID, description: 'Track to move it to (default: its own).' }, mode: MODE }, ['clip']),
		annotations: { title: 'Move a clip', ...WRITE },
		handler: ({ clip, start, track, mode }) => {
			if (start === undefined && track === undefined) throw new Error('Give "start", "track" or both.');
			return apply({ op: 'move_clip', clip, start, track, mode }, mode === 'overwrite' ? 'Overwrite clip' : mode === 'insert' ? 'Insert clip' : 'Move clip', (r) => ({ clip: clipOut(r.project, clip), ...placed(r.outcomes[0]) }));
		}
	};

	const trimClip: AgentTool = {
		name: 'trim_video_clip',
		title: 'Trim a clip',
		description:
			'Moves one edge of a clip to a timeline time (one undo step): "start" also moves its source in point, "end" its out point. Refused past the ends of the source (the error says how far it can go) or below one frame. With ripple the clip keeps its start and the later clips on the track move by the change, so no gap or overlap opens. Returns the clip.',
		inputSchema: object({ clip: CLIP_ID, edge: { type: 'string', enum: ['start', 'end'], description: 'Which edge to move.' }, to: MS('Where that edge goes on the timeline'), ripple: RIPPLE }, ['clip', 'edge', 'to']),
		annotations: { title: 'Trim a clip', ...WRITE_IDEMPOTENT },
		handler: ({ clip, edge, to, ripple }) => apply({ op: 'trim_clip', clip, edge, to, ripple }, ripple ? 'Ripple trim' : 'Trim clip', (r) => ({ clip: clipOut(r.project, clip), ...placed(r.outcomes[0]) }))
	};

	const splitClip: AgentTool = {
		name: 'split_video_clip',
		title: 'Split a clip',
		description: 'Cuts a clip in two at a timeline time (at least a frame from either end), as one undo step. The left part keeps the id, fade in and transition; the right part gets a new id and the fade out. Returns both parts.',
		inputSchema: object({ clip: CLIP_ID, at: MS('Where to cut, on the timeline'), id: { type: 'string', minLength: 1, description: 'Id for the right part (default "<clip>-1").' } }, ['clip', 'at']),
		annotations: { title: 'Split a clip', ...WRITE },
		handler: ({ clip, at, id }) => apply({ op: 'split_clip', clip, at, id }, 'Split clip', (r) => ({ left: clipOut(r.project, clip), right: clipOut(r.project, r.outcomes[0].clip!) }))
	};

	const deleteClips: AgentTool = {
		name: 'delete_video_clips',
		title: 'Delete clips',
		description:
			'Removes clips (one undo step). With ripple the later material moves up to close the gaps they leave: on every sync-locked track when they were on one (refused, naming the clip, if another sync-locked track has something in a gap), else on their own track. Returns the ids removed and the tracks rippled.',
		inputSchema: object(
			{ clips: { type: 'array', items: CLIP_ID, minItems: 1, description: 'Clip ids.' }, ripple: { type: 'boolean', description: 'Close the gaps they leave, on every sync-locked track (default false).' } },
			['clips']
		),
		annotations: { title: 'Delete clips', ...DESTRUCTIVE },
		handler: ({ clips, ripple }) => apply({ op: 'delete_clips', clips, ripple }, ripple ? 'Ripple delete' : 'Delete clips', (r) => ({ removed: clips, ...(r.outcomes[0].rippled ? { rippled: r.outcomes[0].rippled } : {}) }))
	};

	const updateClip: AgentTool = {
		name: 'update_video_clip',
		title: 'Change a clip',
		description:
			'Changes a clip\'s properties (one undo step): opacity, transform, fit, blend mode, colour grade, entrance and exit animations, fades, name; for media volume, mute, the sound\'s fade curves, speed (keeps the stretch of source, so the length changes) or asset; for compound clips in point, volume, mute and fade curves (no speed); for titles text and style; for colours the colour. Fields in "remove" go back to their defaults. Use move / trim for timing. Returns the clip.',
		inputSchema: object(
			{
				clip: CLIP_ID,
				set: object({ ...CLIP_COMMON, ...MEDIA_FIELDS, asset: { ...ASSET_ID, description: 'For media: play another asset (same in point).' }, ...TEXT_FIELDS, color: COLOR('Text colour, or a colour clip\'s fill') }, [], 'Fields to replace (only those that fit the clip\'s type).'),
				remove: { type: 'array', items: { type: 'string', enum: ['name', 'opacity', 'transform', 'fit', 'blend', 'grade', 'animateIn', 'animateOut', 'fadeIn', 'fadeOut', 'fadeInCurve', 'fadeOutCurve', 'in', 'speed', 'volume', 'muted', 'fontSize', 'fontFamily', 'fontWeight', 'background'] }, description: 'Fields to reset to their defaults.' }
			},
			['clip']
		),
		annotations: { title: 'Change a clip', ...WRITE_IDEMPOTENT },
		handler: ({ clip, set, remove }) => {
			const current = clipOut(project(), clip);
			if (current && set) {
				const allowed = new Set(['name', 'opacity', 'transform', 'fit', 'blend', 'grade', 'animateIn', 'animateOut', 'fadeIn', 'fadeOut', ...(current.type === 'media' ? ['in', 'speed', 'volume', 'muted', 'asset', 'fadeInCurve', 'fadeOutCurve'] : current.type === 'sequence' ? ['in', 'volume', 'muted', 'fadeInCurve', 'fadeOutCurve'] : current.type === 'text' ? Object.keys(TEXT_FIELDS) : ['color'])]);
				const wrong = Object.keys(set).filter((k) => !allowed.has(k));
				if (wrong.length) throw new Error(`${wrong.map((k) => `"${k}"`).join(', ')} cannot be set on a ${current.type} clip; it takes ${[...allowed].join(', ')}.`);
			}
			return apply({ op: 'update_clip', clip, set, remove }, 'Change clip', (r) => ({ clip: clipOut(r.project, clip) }));
		}
	};

	/** Clips a grade can change: pictures, on video tracks. */
	const gradeTargets = (ids: string[]) => {
		const p = project();
		for (const id of ids) {
			const at = findVideoClip(p, id);
			if (!at) throw new Error(`There is no clip "${id}"; get_video_project lists the clips.`);
			const { clip } = at;
			if (at.track.kind !== 'video' || (clip.type === 'media' && p.assets.find((a) => a.id === clip.asset)?.kind === 'audio'))
				throw new Error(`Clip "${id}" is sound only; grades change pictures. Pass clips on video tracks.`);
		}
	};

	const applyGradePreset: AgentTool = {
		name: 'apply_video_grade_preset',
		title: 'Apply a colour look',
		description:
			'Gives clips a named colour look at a strength (one undo step), replacing their grade settings (a LUT stays): warm, cool, punchy (more contrast and colour), faded (lifted and muted), black-and-white, bleach-bypass (desaturated, contrasty), day-for-night (dark and blue). Returns each clip\'s resulting grade; tweak it with update_video_clip set.grade.',
		inputSchema: object(
			{
				clips: { type: 'array', items: CLIP_ID, minItems: 1, description: 'Clips on video tracks to grade.' },
				preset: { type: 'string', enum: [...VIDEO_GRADE_PRESET_NAMES], description: 'The look.' },
				amount: { type: 'number', minimum: 0, maximum: 1, description: 'Strength, 0 (none) to 1 (full, the default); 0.5 is a subtler version.' }
			},
			['clips', 'preset']
		),
		annotations: { title: 'Apply a colour look', ...WRITE_IDEMPOTENT },
		handler: ({ clips, preset, amount }) => {
			gradeTargets(clips);
			// A clip's LUT stays: the look replaces only the grade's settings.
			const edits: VideoEdit[] = clips.map((clip: string) => {
				const grade = videoGradeLook(findVideoClip(project(), clip)!.clip.grade, preset, amount ?? 1);
				return grade ? { op: 'update_clip', clip, set: { grade } } : { op: 'update_clip', clip, remove: ['grade'] };
			});
			return apply(edits, `Apply ${preset} look`, (r) => ({ clips: clips.map((id: string) => ({ id, grade: findVideoClip(r.project, id)?.clip.grade ?? null })) }));
		}
	};

	const copyGrade: AgentTool = {
		name: 'copy_video_grade',
		title: 'Copy a colour grade',
		description:
			'Gives clips the same colour grade as another clip (one undo step), to match shots in a scene; a source with no grade clears theirs. Returns the grade copied and the clips changed.',
		inputSchema: object({ from: { ...CLIP_ID, description: 'The clip whose grade to copy.' }, to: { type: 'array', items: CLIP_ID, minItems: 1, description: 'Clips on video tracks to give it to.' } }, ['from', 'to']),
		annotations: { title: 'Copy a colour grade', ...WRITE_IDEMPOTENT },
		handler: ({ from, to }) => {
			gradeTargets([from, ...to]);
			const grade = findVideoClip(project(), from)!.clip.grade;
			const edits: VideoEdit[] = to.map((clip: string) => (grade ? { op: 'update_clip', clip, set: { grade: { ...grade } } } : { op: 'update_clip', clip, remove: ['grade'] }));
			return apply(edits, 'Copy grade', () => ({ grade: grade ?? null, clips: to }));
		}
	};


	const setLut: AgentTool = {
		name: 'set_video_lut',
		title: 'Apply a LUT',
		description:
			'Gives clips a 3D LUT (a .cube file) at a strength, applied after the rest of their grade (one undo step); their other grade settings stay. Reads the file first and fails, changing nothing, if it cannot be loaded or is not a 3D .cube. Returns the LUT\'s title and size and each clip\'s resulting grade. Remove it with remove_video_lut.',
		inputSchema: object(
			{
				clips: { type: 'array', items: CLIP_ID, minItems: 1, uniqueItems: true, description: 'Clips on video tracks to grade.' },
				src: LUT_SRC,
				strength: LUT_STRENGTH,
				name: { type: 'string', minLength: 1, description: 'A label for the look (default the file\'s TITLE).' }
			},
			['clips', 'src']
		),
		annotations: { title: 'Apply a LUT', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		handler: async ({ clips, src, strength, name }) => {
			if (strength === 0) throw new Error('A strength of 0 changes nothing; pass a strength above 0, or remove the LUT with remove_video_lut.');
			gradeTargets(clips);
			const lut = await controller.luts.load(src);
			const label = name ?? lut.title;
			const setting = { src, ...(strength !== undefined && strength !== 1 ? { strength } : {}), ...(label ? { name: label } : {}) };
			return apply(videoLutEdits(project(), clips, setting), 'Apply LUT', (r) => ({ lut: { src, ...(lut.title ? { title: lut.title } : {}), size: lut.size }, clips: clips.map((id: string) => ({ id, grade: findVideoClip(r.project, id)?.clip.grade ?? null })) }));
		}
	};

	const removeLut: AgentTool = {
		name: 'remove_video_lut',
		title: 'Remove a LUT',
		description: 'Takes the LUT off clips\' grades (one undo step), keeping their other grade settings. Fails if none of them has one. Returns each clip\'s resulting grade.',
		inputSchema: object({ clips: { type: 'array', items: CLIP_ID, minItems: 1, uniqueItems: true, description: 'Clips whose LUT to remove.' } }, ['clips']),
		annotations: { title: 'Remove a LUT', ...WRITE_IDEMPOTENT },
		handler: ({ clips }) => {
			gradeTargets(clips);
			const p = project();
			const withLut = clips.filter((id: string) => findVideoClip(p, id)!.clip.grade?.lut);
			if (!withLut.length) throw new Error(`None of ${clips.map((c: string) => `"${c}"`).join(', ')} has a LUT; get_video_project shows each clip's grade.`);
			return apply(videoLutEdits(p, withLut, null), 'Remove LUT', (r) => ({ clips: clips.map((id: string) => ({ id, grade: findVideoClip(r.project, id)?.clip.grade ?? null })) }));
		}
	};

	// -----------------------------------------------------------------------------------------
	// Proxies
	// -----------------------------------------------------------------------------------------

	const PROXY_SCALE = { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, description: 'Proxy size as a fraction of the original: 0.5 (half width and height, the default) or 0.25 for very large footage.' } as const;
	const planProxies: AgentTool = {
		name: 'plan_video_proxies',
		title: 'Plan proxy files',
		description:
			'Returns the ffmpeg commands that make smaller proxy copies of video assets for smooth preview playback, without changing anything: one per video asset (or each of "assets") that has no proxy at that scale yet, each with { asset, args, command, proxy }. Proxies are scaled, H.264 with a keyframe every few frames so scrubbing is quick, and keep the sound. After the host runs a command, attach its "proxy" with set_video_proxies. The export always uses the originals.',
		inputSchema: object({
			scale: PROXY_SCALE,
			assets: { type: 'array', items: ASSET_ID, minItems: 1, uniqueItems: true, description: 'Only these video assets (default: every video asset without a proxy at this scale).' },
			gop: { type: 'integer', minimum: 1, maximum: 300, description: 'Frames between keyframes (default 12): fewer makes seeking cheaper and files larger.' },
			crf: { type: 'integer', minimum: 0, maximum: 51, description: 'x264 quality, lower is better (default 28: proxies are for editing).' }
		}),
		annotations: { title: 'Plan proxy files', ...READ },
		handler: ({ scale, assets, gop, crf }) => {
			const commands = videoProxyPlan(project(), { scale, assets, gop, crf });
			return { scale: scale ?? 0.5, commands, ...(commands.length ? {} : { note: 'Every video asset already has a proxy at this scale.' }) };
		}
	};

	const setProxies: AgentTool = {
		name: 'set_video_proxies',
		title: 'Attach proxies',
		description:
			'Sets a video asset\'s proxies, the smaller copies the preview plays instead of the original (one undo step); an empty list removes them. Each proxy must match the original\'s length and timing (plan_video_proxies makes such files). The export, EDL and source times always use the original. Returns the asset.',
		inputSchema: object(
			{
				asset: { ...ASSET_ID, description: 'A video asset id from get_video_project.' },
				proxies: {
					type: 'array',
					maxItems: 8,
					description: 'Its proxies, one per scale (empty removes them all).',
					items: object({ scale: PROXY_SCALE, src: { type: 'string', minLength: 1, description: 'Where the preview loads the proxy from (URL or path).' }, width: { type: 'number', exclusiveMinimum: 0, description: 'Its width in pixels.' }, height: { type: 'number', exclusiveMinimum: 0, description: 'Its height in pixels.' } }, ['scale', 'src'], 'One proxy.')
				}
			},
			['asset', 'proxies']
		),
		annotations: { title: 'Attach proxies', ...WRITE_IDEMPOTENT },
		handler: ({ asset, proxies }) => {
			const a = project().assets.find((x) => x.id === asset);
			if (!a) throw new Error(`There is no asset "${asset}"; the assets are ${project().assets.map((x) => `"${x.id}"`).join(', ') || 'none'}.`);
			if (a.kind !== 'video') throw new Error(`Asset "${asset}" is ${a.kind === 'image' ? 'an image' : 'audio'}; only video assets have proxies.`);
			const edit: VideoEdit = proxies.length ? { op: 'update_asset', asset, set: { proxies } } : { op: 'update_asset', asset, remove: ['proxies'] };
			return apply(edit, proxies.length ? 'Attach proxies' : 'Remove proxies', (r) => ({ asset: videoAssetOut(r.project.assets.find((x) => x.id === asset)!) }));
		}
	};

	const setPreviewScale: AgentTool = {
		name: 'set_video_preview_scale',
		title: 'Set the preview size',
		description:
			'Sets how large a picture the preview plays, without changing the project (no undo step): "full" plays the originals, a fraction (0.5, 0.25) plays the smallest proxy at least that large (or the original where there is none), "auto" (the default) picks by the size the preview is shown at. Use a proxy scale when playback stutters on large footage. Returns the setting and, for each video asset, what the preview plays at a fixed scale.',
		inputSchema: object(
			{ scale: { anyOf: [{ type: 'string', enum: ['auto', 'full'] }, { type: 'number', exclusiveMinimum: 0, maximum: 1 }], description: '"auto", "full", or a fraction above 0 up to 1 (0.5 is half size).' } },
			['scale']
		),
		annotations: { title: 'Set the preview size', ...WRITE_IDEMPOTENT },
		handler: ({ scale }) => {
			controller.setPreviewScale(scale);
			const s = controller.getState().previewScale;
			const fixed = s === 'full' ? 1 : typeof s === 'number' ? s : null;
			const plays = fixed === null ? undefined : project().assets.filter((a) => a.kind === 'video').map((a) => ({ asset: a.id, src: videoAssetProxy(a, fixed)?.src ?? a.src, proxy: !!videoAssetProxy(a, fixed) }));
			return { previewScale: s, ...(plays ? { plays } : { note: 'auto picks the smallest proxy at least as large as the preview canvas shows, so it depends on the preview\'s size.' }) };
		}
	};

	const previewCache: AgentTool = {
		name: 'get_video_preview_cache',
		title: 'Read the preview\'s frame cache',
		description:
			'Reports the preview\'s cache of decoded frames, without changing anything: whether the host has one, how many frames and bytes it holds against its budget, hits and misses, frames still decoding, how far ahead it prefetches (ms), and the stretches of the timeline between "from" and "to" whose frames are all cached (these play and scrub without waiting). Use it to tell whether stuttering is the cache filling, and before asking the person to review a passage. With no cache, says so.',
		inputSchema: object({ from: MS('Start of the stretch to report cached ranges for (default 0)'), to: MS('End of it (default: the end of the project)') }),
		annotations: { title: 'Read the preview\'s frame cache', ...READ },
		handler: ({ from, to }) => {
			const cache = controller.frameCache;
			if (!cache) return { enabled: false, reason: 'The host has not given this editor a frame cache (VideoEditorController frameCache), so the preview decodes each frame as it plays.' };
			if (from !== undefined && to !== undefined && !(to > from)) throw new Error(`"to" (${to} ms) must be after "from" (${from} ms).`);
			const ranges = cache.cachedRanges(project(), { from, to });
			return { enabled: true, ...cache.stats(), cachedRanges: ranges };
		}
	};

	// -----------------------------------------------------------------------------------------
	// Text-based editing
	// -----------------------------------------------------------------------------------------

	const TRANSCRIPT_TRACK = { ...TRACK_ID, description: 'Track whose words to read (default: the first audio track with a transcribed clip, else the first video track with one).' };
	const RANGE_OUT = (r: VideoTranscriptRange) => ({ from: round(r.from), to: round(r.to), text: r.text });
	const timelineWords = (track?: string) => {
		const words = videoTimelineTranscript(project(), { track });
		if (!words.length) throw new Error(track ? `No clip on track "${track}" plays a transcribed asset; attach one with set_video_transcript.` : 'No clip plays a transcribed asset; attach a transcript to the media with set_video_transcript first.');
		return words;
	};

	const setTranscript: AgentTool = {
		name: 'set_video_transcript',
		title: 'Attach a transcript',
		description:
			'Attaches what is said in a video or audio asset, word by word, so the edit can be cut by text (one undo step). Pass "text" (Whisper-style JSON with word timings, SubRip or WebVTT, as the file says it) or "words" ([{ word, start, end }] in ms of the source). Captions have no word timings, so their words are spread across each cue (approximate). Replaces any transcript the asset had. Returns the word count, whether timings are approximate, and the first and last words.',
		inputSchema: object(
			{
				asset: { ...ASSET_ID, description: 'A video or audio asset.' },
				text: { type: 'string', minLength: 1, description: 'The transcript file\'s contents: Whisper-style JSON (times in seconds), .srt or .vtt. Pass this or words.' },
				words: { type: 'array', minItems: 1, items: object({ word: { type: 'string', minLength: 1, description: 'The word as said.' }, start: { type: 'number', minimum: 0, description: 'Start in ms of the source.' }, end: { type: 'number', minimum: 0, description: 'End in ms of the source.' } }, ['word', 'start', 'end'], 'One word.'), description: 'Words with source times in ms. Pass this or text.' }
			},
			['asset']
		),
		annotations: { title: 'Attach a transcript', ...WRITE_IDEMPOTENT },
		handler: ({ asset, text, words }) => {
			if ((text === undefined) === (words === undefined)) throw new Error('Pass either "text" (a transcript file\'s contents) or "words", not both.');
			const a = project().assets.find((x) => x.id === asset);
			if (!a) throw new Error(`There is no asset "${asset}"; the assets are ${project().assets.map((x) => `"${x.id}"`).join(', ') || 'none'}.`);
			if (a.kind === 'image') throw new Error(`Asset "${asset}" is an image and has no sound to transcribe.`);
			const parsed = text !== undefined ? parseVideoTranscript(text) : { words, approximate: false };
			const list = parsed.words as { word: string; start: number; end: number }[];
			return apply({ op: 'update_asset', asset, set: { transcript: list } }, 'Attach transcript', () => ({
				asset,
				words: list.length,
				approximate: parsed.approximate,
				first: list[0],
				last: list[list.length - 1],
				...(a.duration !== undefined && list[list.length - 1].end > a.duration + VIDEO_TIME_EPSILON ? { warning: `The transcript runs to ${list[list.length - 1].end} ms, past the asset's ${a.duration} ms: is it for this asset?` } : {})
			}));
		}
	};

	const getTranscript: AgentTool = {
		name: 'get_video_transcript',
		title: 'Read the transcript',
		description:
			'Returns what the timeline says, in order, from the transcripts of the media its clips play on one track: the text, and each word with its timeline start and end (ms) and the clip that plays it, so ranges can go straight to remove_video_ranges or split_video_at. Words cut out of the edit are not included.',
		inputSchema: object({
			track: TRANSCRIPT_TRACK,
			from: MS('Only words from this timeline time (default 0)'),
			to: MS('Only words up to this timeline time (default the end)'),
			limit: { type: 'integer', minimum: 1, maximum: 5000, description: 'Most words to return (default 1000); "more" says if there are others.' }
		}),
		annotations: { title: 'Read the transcript', ...READ },
		handler: ({ track, from, to, limit }) => {
			const all = timelineWords(track).filter((w) => w.end > (from ?? 0) && w.start < (to ?? Infinity));
			const words = all.slice(0, limit ?? 1000);
			return { track: words[0]?.track ?? videoTranscriptTrack(project(), track), text: words.map((w) => w.word).join(' '), words: words.map((w) => ({ word: w.word, start: round(w.start), end: round(w.end), clip: w.clip })), more: all.length > words.length };
		}
	};

	const findText: AgentTool = {
		name: 'find_video_transcript_text',
		title: 'Find words in the transcript',
		description: 'Lists every place a word or phrase is said on the timeline (case and punctuation ignored) as { from, to, text } ranges in timeline ms, ready for remove_video_ranges, split_video_at or seek_video.',
		inputSchema: object({ query: { type: 'string', minLength: 1, description: 'The word or phrase.' }, track: TRANSCRIPT_TRACK }, ['query']),
		annotations: { title: 'Find words in the transcript', ...READ },
		handler: ({ query, track }) => ({ matches: findVideoTranscriptText(timelineWords(track), query).map(RANGE_OUT) })
	};

	const findFillers: AgentTool = {
		name: 'find_video_fillers',
		title: 'Find filler words',
		description: `Lists filler words and phrases on the timeline as { from, to, text } ranges in timeline ms, longest phrase first so "you know" is found whole. Default fillers: ${VIDEO_DEFAULT_FILLERS.join(', ')} ("like" and "so" are left out as too often meant). Check them, then pass the ones to cut to remove_video_ranges.`,
		inputSchema: object({ track: TRANSCRIPT_TRACK, fillers: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Words or phrases to treat as fillers instead of the defaults.' } }),
		annotations: { title: 'Find filler words', ...READ },
		handler: ({ track, fillers }) => {
			const found = findVideoFillers(timelineWords(track), fillers);
			return { fillers: found.map(RANGE_OUT), total: round(found.reduce((n, r) => n + r.to - r.from, 0)) };
		}
	};

	const findPauses: AgentTool = {
		name: 'find_video_pauses',
		title: 'Find pauses between words',
		description:
			'Lists the gaps between consecutive words on the timeline (within one clip) longer than "min", less "keep" next to each word so speech is not clipped, snapped inward to frames, as { from, to } ranges in timeline ms ready for remove_video_ranges. Uses word timings; find_video_silences measures the sound instead.',
		inputSchema: object({
			track: TRANSCRIPT_TRACK,
			min: { type: 'number', exclusiveMinimum: 0, description: 'Shortest gap that counts, in ms (default 700).' },
			keep: { type: 'number', minimum: 0, description: 'Silence to keep after the word before and before the word after, in ms (default 150).' }
		}),
		annotations: { title: 'Find pauses between words', ...READ },
		handler: ({ track, min, keep }) => {
			const found = findVideoTranscriptPauses(timelineWords(track), { min, keep, fps: project().fps });
			return { pauses: found.map(RANGE_OUT), total: round(found.reduce((n, r) => n + r.to - r.from, 0)) };
		}
	};

	const removeRanges: AgentTool = {
		name: 'remove_video_ranges',
		title: 'Cut out stretches',
		description:
			'Cuts stretches of the timeline out and closes them up, as one undo step: the ranges are merged where they touch and extracted from the last to the first, so the times from find_video_fillers, find_video_pauses, find_video_transcript_text or find_video_silences can be passed as they are. Like extract_video_range, every sync-locked track moves with the cut. Returns how many stretches and how much time were removed and the new length.',
		inputSchema: object(
			{
				ranges: { type: 'array', minItems: 1, maxItems: 500, items: object({ from: MS('Start, on the timeline'), to: MS('End, on the timeline'), text: { type: 'string', description: 'Ignored: the words in the stretch, as the find tools return them.' } }, ['from', 'to'], 'A stretch to remove.'), description: 'The stretches, in any order (timeline ms).' },
				tracks: { type: 'array', items: TRACK_ID, minItems: 1, description: 'Tracks to cut (default every unlocked track).' }
			},
			['ranges']
		),
		annotations: { title: 'Cut out stretches', ...DESTRUCTIVE },
		handler: ({ ranges, tracks }) => {
			const bad = (ranges as { from: number; to: number }[]).findIndex((r) => !(r.to > r.from));
			if (bad >= 0) throw new Error(`Range ${bad + 1} is empty or backwards (${ranges[bad].from}–${ranges[bad].to} ms); "to" must be after "from".`);
			const merged = mergeVideoRanges(ranges);
			const before = videoProjectDuration(project());
			return apply(videoRemoveRangesEdits(merged, tracks), merged.length > 1 ? `Cut ${merged.length} stretches` : 'Cut stretch', (r) => ({ removed: merged.length, time: round(before - videoProjectDuration(r.project)), duration: videoProjectDuration(r.project) }));
		}
	};

	// -----------------------------------------------------------------------------------------
	// Speed ramps and freeze frames
	// -----------------------------------------------------------------------------------------

	/** A media clip a ramp can change, with its asset. */
	const rampTarget = (id: string) => {
		const at = findVideoClip(project(), id);
		if (!at) throw new Error(`There is no clip "${id}"; get_video_project lists the clips.`);
		const { clip } = at;
		if (clip.type === 'sequence') throw new Error(`Clip "${id}" is a compound clip, which plays its sequence at normal speed; change the speed of the clips inside the sequence instead.`);
		if (clip.type !== 'media') throw new Error(`Clip "${id}" is a ${clip.type === 'text' ? 'title' : clip.type === 'effect' ? 'effect clip' : 'colour'}, so it has no source to change the speed of; use a video or audio clip.`);
		if (project().assets.find((a) => a.id === clip.asset)?.kind === 'image') throw new Error(`Clip "${id}" is a still, so it has no motion to change the speed of.`);
		return clip;
	};
	const rampOut = (r: Extract<VideoEditResult, { ok: true }>, id: string) => {
		const outcome = r.outcomes[r.outcomes.length - 1];
		return { clip: clipOut(r.project, id), ...(outcome.rippled ? { rippled: outcome.rippled } : {}), duration: videoProjectDuration(r.project) };
	};
	const RIPPLE_RAMP = { type: 'boolean', description: 'Move later material on every sync-locked track by the change in length (default true); false refuses if the clip would overlap the next one.' } as const;

	const setSpeedRamp: AgentTool = {
		name: 'set_video_speed_ramp',
		title: 'Ramp the speed',
		description:
			'Plays a video or audio clip through stretches of speed, from its first frame: e.g. [{ duration: 1500, speed: 1 }, { duration: 500, speed: 1, toSpeed: 0.25 }, { duration: 2000, speed: 0.25 }] for a slow-motion ramp. "toSpeed" glides evenly to a new speed over the stretch; speed 0 is a freeze frame. The clip\'s length becomes the stretches\' total (one undo step). Replaces any ramp or speed it had. Returns the clip (with its timeRemap keys and source range).',
		inputSchema: object(
			{
				clip: CLIP_ID,
				segments: {
					type: 'array',
					minItems: 1,
					maxItems: 100,
					description: 'The stretches in order, from the clip\'s start.',
					items: object(
						{
							duration: { type: 'number', exclusiveMinimum: 0, description: 'Length of the stretch on the timeline, in ms.' },
							speed: { type: 'number', minimum: 0, maximum: 20, description: 'Speed at its start: 1 normal, 0.5 half speed (slow motion), 2 double, 0 a freeze frame.' },
							toSpeed: { type: 'number', minimum: 0, maximum: 20, description: 'Glide evenly to this speed by the stretch\'s end (default: stay at speed). A ramp between two speeds.' }
						},
						['duration', 'speed'],
						'One stretch.'
					)
				},
				ripple: RIPPLE_RAMP
			},
			['clip', 'segments']
		),
		annotations: { title: 'Ramp the speed', ...WRITE_IDEMPOTENT },
		handler: ({ clip, segments, ripple }) => {
			// Starts from the moment of source the clip shows at its first frame now.
			const edit = videoSpeedRampEdit(rampTarget(clip), segments, ripple ?? true);
			return apply(edit, 'Speed ramp', (r) => ({ ...rampOut(r, clip), source: Math.round(videoSpeedRampKeys(segments).source) }));
		}
	};

	const addFreeze: AgentTool = {
		name: 'add_video_freeze_frame',
		title: 'Add a freeze frame',
		description:
			'Holds the frame a video clip shows at a timeline time for a while, then plays on (one undo step): the clip gets longer by the hold, and with ripple (default) everything after it on sync-locked tracks moves along. Works on clips with or without a speed ramp. Returns the clip.',
		inputSchema: object(
			{
				clip: CLIP_ID,
				at: MS('Timeline time of the frame to hold (inside the clip)'),
				duration: { type: 'number', exclusiveMinimum: 0, description: 'How long to hold it, in ms.' },
				ripple: RIPPLE_RAMP
			},
			['clip', 'at', 'duration']
		),
		annotations: { title: 'Add a freeze frame', ...WRITE },
		handler: ({ clip, at, duration, ripple }) => {
			const c = rampTarget(clip);
			const t = at - c.start;
			if (t < 0 || t > c.duration) throw new Error(`${formatVideoSeconds(at)} is outside clip "${clip}" (${formatVideoSeconds(c.start)}–${formatVideoSeconds(videoClipEnd(c))}); pick a time inside it.`);
			return apply(videoFreezeFrameEdit(c, t, duration, ripple ?? true), 'Freeze frame', (r) => rampOut(r, clip));
		}
	};

	const removeRamp: AgentTool = {
		name: 'remove_video_speed_ramp',
		title: 'Remove a speed ramp',
		description: 'Puts a ramped clip back to normal speed from the moment its ramp started (one undo step), keeping its length unless "duration" is given. Returns the clip.',
		inputSchema: object({ clip: CLIP_ID, duration: { type: 'number', exclusiveMinimum: 0, description: 'New length in ms (default: unchanged).' }, ripple: RIPPLE_RAMP }, ['clip']),
		annotations: { title: 'Remove a speed ramp', ...WRITE },
		handler: ({ clip, duration, ripple }) => {
			rampTarget(clip);
			return apply({ op: 'set_time_remap', clip, keys: null, ...(duration !== undefined ? { duration } : {}), ripple: ripple ?? true }, 'Remove speed ramp', (r) => rampOut(r, clip));
		}
	};

	const setTransition: AgentTool = {
		name: 'set_video_transition',
		title: 'Set a transition',
		description:
			'Sets (or with null removes) a built-in transition into a clip from the clip that ends where it starts on the same track: crossfade (a cross dissolve), dip to a colour, wipe, push, slide or iris. One undo step. Use set_video_effect_transition only for a transition effect from the effects provider. Every type but dip plays half before and half after the cut, so both clips need that much media past the cut; when they do not, the error says the longest that fits. Returns the clip.',
		inputSchema: object({ clip: { ...CLIP_ID, description: 'The incoming clip (the one after the cut).' }, transition: { anyOf: [TRANSITION, { type: 'null' }], description: 'The transition, or null to remove it.' } }, ['clip', 'transition']),
		annotations: { title: 'Set a transition', ...WRITE_IDEMPOTENT },
		handler: ({ clip, transition }) => apply({ op: 'set_transition', clip, transition }, transition ? 'Set transition' : 'Remove transition', (r) => ({ clip: clipOut(r.project, clip) }))
	};

	const slipClip: AgentTool = {
		name: 'slip_video_clip',
		title: 'Slip a clip',
		description:
			'Shows a different stretch of a video or audio clip\'s source without moving it on the timeline: its in and out points both move by delta (one undo step). Clamped to the media past either end, keeping what its transitions need. Returns the clip (with its new source range) and the delta applied.',
		inputSchema: object({ clip: CLIP_ID, delta: DELTA('How far to move the source (positive shows later media)') }, ['clip', 'delta']),
		annotations: { title: 'Slip a clip', ...WRITE },
		handler: ({ clip, delta }) => apply({ op: 'slip_clip', clip, delta }, 'Slip clip', (r) => ({ clip: clipOut(r.project, clip), delta: r.outcomes[0].delta }))
	};

	const rollEdit: AgentTool = {
		name: 'roll_video_edit',
		title: 'Roll a cut',
		description:
			'Moves the cut between two clips that meet on one track (one undo step): the left one\'s out point and the right one\'s in point move together, so nothing else moves and no gap opens. Clamped to each clip\'s media and at least a frame of each. Returns both clips, the new cut time and the delta applied.',
		inputSchema: object({ left: { ...CLIP_ID, description: 'The clip before the cut (from get_video_project).' }, right: { ...CLIP_ID, description: 'The clip after the cut, starting where "left" ends.' }, delta: DELTA('How far to move the cut') }, ['left', 'right', 'delta']),
		annotations: { title: 'Roll a cut', ...WRITE },
		handler: ({ left, right, delta }) =>
			apply({ op: 'roll_edit', left, right, delta }, 'Roll edit', (r) => {
				const after = clipOut(r.project, right)!;
				return { left: clipOut(r.project, left), right: after, cut: after.start, delta: r.outcomes[0].delta };
			})
	};

	const slideClip: AgentTool = {
		name: 'slide_video_clip',
		title: 'Slide a clip',
		description:
			'Moves a clip along its track keeping its content, trimming the clips either side so the stretch stays gapless (one undo step): the one before gets longer as the one after gets shorter, or the other way. Without a neighbour on one side it moves through the gap there. Clamped to the neighbours\' media and at least a frame of each. Returns the clip, its neighbours and the delta applied.',
		inputSchema: object({ clip: CLIP_ID, delta: DELTA('How far to move it') }, ['clip', 'delta']),
		annotations: { title: 'Slide a clip', ...WRITE },
		handler: ({ clip, delta }) =>
			apply({ op: 'slide_clip', clip, delta }, 'Slide clip', (r) => {
				const ids = r.outcomes[0].clips!;
				const i = ids.indexOf(clip);
				return { clip: clipOut(r.project, clip), ...(i > 0 ? { before: clipOut(r.project, ids[0]) } : {}), ...(i < ids.length - 1 ? { after: clipOut(r.project, ids[ids.length - 1]) } : {}), delta: r.outcomes[0].delta };
			})
	};

	const rangeArgs = object({ from: MS('Start of the range on the timeline'), to: MS('End of the range on the timeline (after "from")'), tracks: RANGE_TRACKS }, ['from', 'to']);
	const rangeOut = (o: VideoEditOutcome) => ({ removed: o.removed ?? [], trimmed: o.trimmed ?? [], created: o.created ?? [], ...(o.rippled ? { rippled: o.rippled } : {}) });

	const liftRange: AgentTool = {
		name: 'lift_video_range',
		title: 'Lift a range',
		description:
			'Empties a stretch of time on some or all tracks, leaving a gap (one undo step): clips inside are deleted, clips across an edge are trimmed to it, and a clip across both is cut in two. Returns the clips removed, trimmed and created (right-hand parts of cuts).',
		inputSchema: rangeArgs,
		annotations: { title: 'Lift a range', ...DESTRUCTIVE },
		handler: ({ from, to, tracks }) => apply({ op: 'lift_range', from, to, tracks }, 'Lift', (r) => rangeOut(r.outcomes[0]))
	};

	const extractRange: AgentTool = {
		name: 'extract_video_range',
		title: 'Extract a range',
		description:
			'Removes a stretch of time and closes it up (one undo step): like lift, then everything after it moves earlier by its length on those tracks and every sync-locked track. Refused, naming the clip, when a sync-locked track left out of "tracks" has something in the range. Returns the clips removed, trimmed and created and the tracks that moved.',
		inputSchema: rangeArgs,
		annotations: { title: 'Extract a range', ...DESTRUCTIVE },
		handler: ({ from, to, tracks }) => apply({ op: 'extract_range', from, to, tracks }, 'Extract', (r) => rangeOut(r.outcomes[0]))
	};

	const splitAt: AgentTool = {
		name: 'split_video_at',
		title: 'Cut across tracks',
		description:
			'Cuts every clip that runs across a time on some or all tracks (a razor through the timeline), as one undo step. Each left part keeps its id, fade in and transition; each right part gets a new id and the fade out. Refused when no clip runs across that time. Returns the pairs { left, right }.',
		inputSchema: object({ at: MS('Where to cut, on the timeline'), tracks: RANGE_TRACKS }, ['at']),
		annotations: { title: 'Cut across tracks', ...WRITE },
		handler: ({ at, tracks }) =>
			apply({ op: 'split_at', at, tracks }, 'Split', (r) => {
				const o = r.outcomes[0];
				return { cuts: o.clips!.map((left, i) => ({ left: clipOut(r.project, left), right: clipOut(r.project, o.created![i]) })) };
			})
	};

	const setKeyframes: AgentTool = {
		name: 'set_video_keyframes',
		title: 'Animate a clip property',
		description:
			'Animates one property of a clip with keyframes (one undo step), replacing any keys it had: opacity, volume, or the transform\'s x, y, scale and rotation. Times are clip time (ms from the clip\'s start), so a key at 0 is the clip\'s first frame; get_video_project gives each clip\'s duration. Plays in the preview, renders and the ffmpeg export. Returns the property\'s keys, sorted.',
		inputSchema: object({ clip: CLIP_ID, property: KEY_PROPERTY, keys: KEYS }, ['clip', 'property', 'keys']),
		annotations: { title: 'Animate a clip property', ...WRITE_IDEMPOTENT },
		handler: ({ clip, property, keys }) => apply({ op: 'set_keyframes', clip, property, keys }, `Keyframe ${property}`, (r) => ({ clip, property, ...keysOut(r.project, clip, property) }))
	};

	const removeKeyframes: AgentTool = {
		name: 'remove_video_keyframes',
		title: 'Stop animating a clip property',
		description:
			'Removes all of a property\'s keyframes (one undo step), leaving it at the value it had at the clip\'s start. Returns the remaining keys (none) and that value (null for the default).',
		inputSchema: object({ clip: CLIP_ID, property: KEY_PROPERTY }, ['clip', 'property']),
		annotations: { title: 'Stop animating a clip property', ...WRITE_IDEMPOTENT },
		handler: ({ clip, property }) => apply({ op: 'set_keyframes', clip, property, keys: null }, `Remove ${property} keyframes`, (r) => ({ clip, property, ...keysOut(r.project, clip, property) }))
	};

	const closeGaps: AgentTool = {
		name: 'close_video_gaps',
		title: 'Close gaps',
		description: 'Slides the clips on a track earlier so no gaps are left between them (from a time on, default the start), as one undo step. Returns the clips that moved.',
		inputSchema: object({ track: TRACK_ID, from: MS('Only close gaps after this time (default 0)') }, ['track']),
		annotations: { title: 'Close gaps', ...WRITE_IDEMPOTENT },
		handler: ({ track, from }) => apply({ op: 'close_gaps', track, from }, 'Close gaps', (r) => ({ moved: r.outcomes[0].clips }))
	};

	const addMarker: AgentTool = {
		name: 'add_video_marker',
		title: 'Add a marker',
		description: 'Adds a named marker at a time (one undo step), e.g. a beat or a note for review. Clip edges snap to markers. Returns its id.',
		inputSchema: object({ time: MS('Where it goes'), label: { type: 'string', description: 'What it marks.' }, color: COLOR('Marker colour'), id: { type: 'string', minLength: 1, description: 'Id (default "m1", "m2", …).' } }, ['time']),
		annotations: { title: 'Add a marker', ...WRITE },
		handler: (marker) => apply({ op: 'add_marker', marker: marker as any }, 'Add marker', (r) => ({ marker: r.outcomes[0].marker }))
	};

	const removeMarker: AgentTool = {
		name: 'remove_video_marker',
		title: 'Remove a marker',
		description: 'Removes a marker by id (one undo step). Returns the remaining markers.',
		inputSchema: object({ marker: { type: 'string', minLength: 1, description: 'Marker id from get_video_project.' } }, ['marker']),
		annotations: { title: 'Remove a marker', ...DESTRUCTIVE },
		handler: ({ marker }) => apply({ op: 'remove_marker', marker }, 'Remove marker', (r) => ({ markers: r.project.markers ?? [] }))
	};

	const EDIT_OP: JsonSchema = {
		type: 'object',
		description: `One edit: { "op": one of ${VIDEO_EDIT_OPS.filter((o) => o !== 'replace_project').join(', ')}, …its fields }. Fields match the single tools: add_clip { track, clip, mode, ripple }, move_clip { clip, start, track, mode }, trim_clip { clip, edge, to, ripple }, split_clip { clip, at, id }, delete_clips { clips, ripple }, update_clip { clip, set, remove }, set_transition { clip, transition }, set_keyframes { clip, property, keys (null removes) }, set_time_remap { clip, keys (clip ms → source ms after the in point; null removes), duration, ripple }, slip_clip { clip, delta }, roll_edit { left, right, delta }, slide_clip { clip, delta }, lift_range { from, to, tracks }, extract_range { from, to, tracks }, split_at { at, tracks }, close_gaps { track, from }, add_asset { asset }, update_asset { asset, set, remove }, remove_asset { asset }, add_track { track: { kind, id, … }, at }, update_track { track, set, remove }, remove_track { track }, move_track { track, to }, add_marker { marker: { time, label } }, update_marker { marker, set }, remove_marker { marker }, set_settings { name, width, height, fps, background }.`,
		properties: { op: { type: 'string', enum: VIDEO_EDIT_OPS.filter((o) => o !== 'replace_project'), description: 'Which edit.' } },
		required: ['op']
	};

	const editVideo: AgentTool = {
		name: 'edit_video',
		title: 'Make several edits at once',
		description:
			'Applies several edits in order as one undo step, all or nothing: if one fails nothing changes and the error names the op ("op 2 (trim_clip): …"). Use it for a rough cut (assets, then clips) or anything that only makes sense together. Returns each op\'s outcome (the clip, clips, track, asset or marker it made or changed), the length and issues. With dry_run it only reports them.',
		inputSchema: object({ ops: { type: 'array', items: EDIT_OP, minItems: 1, maxItems: 200, description: 'Edits, applied in order.' }, dry_run: { type: 'boolean', description: 'Check without applying (default false).' } }, ['ops']),
		annotations: { title: 'Make several edits at once', ...WRITE },
		handler: ({ ops, dry_run = false }) => {
			if (ops.some((o: { op: string }) => o.op === 'replace_project')) throw new Error('edit_video cannot replace the whole project; use the individual ops.');
			const result = controller.apply(ops as VideoEdit[], 'Edit video', { dryRun: dry_run });
			return outcome(result, result.ok ? { outcomes: result.outcomes, ...(dry_run ? { dry_run: true, hint: 'Nothing was applied; call again without dry_run to apply.' } : {}) } : {});
		}
	};

	const undo: AgentTool = {
		name: 'undo_video',
		title: 'Undo a video edit',
		description: 'Undoes the last edit. Returns whether something was undone and its label.',
		inputSchema: object({}),
		annotations: { title: 'Undo a video edit', ...WRITE },
		handler: () => {
			const label = controller.getState().undoLabel;
			const undone = controller.undo();
			return { undone, ...(undone ? { label } : {}) };
		}
	};

	const redo: AgentTool = {
		name: 'redo_video',
		title: 'Redo a video edit',
		description: 'Redoes the last undone edit. Returns whether something was redone and its label.',
		inputSchema: object({}),
		annotations: { title: 'Redo a video edit', ...WRITE },
		handler: () => {
			const label = controller.getState().redoLabel;
			const redone = controller.redo();
			return { redone, ...(redone ? { label } : {}) };
		}
	};

	/** The source stretch a level or silence query reads, and how to map its times back. */
	const soundRange = (args: { clip?: string; asset?: string; from?: number; to?: number }) => {
		const p = project();
		if ((args.clip === undefined) === (args.asset === undefined)) throw new Error('Pass either "clip" (a media clip, times on the timeline) or "asset" (times in the source), not both.');
		let asset: VideoAsset | undefined;
		let toSource = (t: number) => t;
		let toOut = (t: number) => t;
		let from: number;
		let to: number;
		if (args.clip !== undefined) {
			const found = findVideoClip(p, args.clip);
			if (!found) throw new Error(`There is no clip "${args.clip}"; get_video_project lists the clips.`);
			const c = found.clip;
			if (c.type === 'sequence') throw new Error(`Clip "${c.id}" is a compound clip; its sound is the mix of its sequence "${c.sequence}", so read the levels of the media in it (list_video_sequences lists its clips and assets).`);
			if (c.type !== 'media') throw new Error(`Clip "${c.id}" is a ${c.type} clip and has no sound; pass a media clip.`);
			asset = p.assets.find((a) => a.id === c.asset);
			const speed = c.speed ?? 1;
			toSource = (t: number) => (c.in ?? 0) + (t - c.start) * speed;
			toOut = (s: number) => c.start + (s - (c.in ?? 0)) / speed;
			from = Math.max(c.start, args.from ?? c.start);
			to = Math.min(videoClipEnd(c), args.to ?? videoClipEnd(c));
		} else {
			asset = p.assets.find((a) => a.id === args.asset);
			if (!asset) throw new Error(`There is no asset "${args.asset}"; the assets are ${p.assets.map((a) => `"${a.id}"`).join(', ') || 'none'}.`);
			from = args.from ?? 0;
			to = args.to ?? asset.duration ?? 0;
		}
		if (!asset) throw new Error(`Clip "${args.clip}" uses a missing asset.`);
		if (asset.kind === 'image' || asset.hasAudio === false) throw new Error(`Asset "${asset.id}" has no sound.`);
		if (!(to > from)) throw new Error(`The stretch to read is empty (${from}–${to} ms); "to" must be after "from"${args.clip !== undefined ? ' and both inside the clip' : asset.duration === undefined ? ', and the asset has no duration, so pass "to"' : ''}.`);
		return { asset, from, to, toSource, toOut };
	};
	const SOUND_TARGET = {
		clip: { ...CLIP_ID, description: 'A media clip: read the stretch of source it plays, with times on the timeline. Pass this or asset.' },
		asset: { ...ASSET_ID, description: 'A video or audio asset: read its source, with times in the source. Pass this or clip.' },
		from: MS('Start of the stretch (default: the clip\'s start, or 0 for an asset)'),
		to: MS('End of the stretch (default: the clip\'s end, or the asset\'s duration)')
	};
	const SOUND_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

	const audioLevels: AgentTool = {
		name: 'get_video_audio_levels',
		title: 'Read sound levels',
		description:
			'Measures how loud the source sound is over a clip or an asset, without changing anything: the peak level in dBFS (0 = full scale, -100 = silence) for each of "buckets" equal stretches, plus the loudest peak. Levels are the recording as it is, before clip volume and fades. Use it to find where speech or a beat starts, or to judge whether a clip is too loud. The first call for an asset decodes its file, which can take a moment.',
		inputSchema: object({ ...SOUND_TARGET, buckets: { type: 'integer', minimum: 1, maximum: 500, description: 'How many equal stretches to measure (default 50).' } }),
		annotations: { title: 'Read sound levels', ...SOUND_ANNOTATIONS },
		handler: async (args) => {
			const r = soundRange(args);
			const peaks = await controller.audioPeaks.load(r.asset);
			const levels = videoAudioLevels(peaks, r.toSource(r.from), r.toSource(r.to), args.buckets ?? 50).map((l) => ({ start: round(r.toOut(l.start)), end: round(r.toOut(l.end)), peakDb: l.peakDb }));
			return { asset: r.asset.id, from: r.from, to: r.to, peakDb: Math.max(...levels.map((l) => l.peakDb)), levels };
		}
	};

	const findSilences: AgentTool = {
		name: 'find_video_silences',
		title: 'Find silences',
		description:
			'Lists the stretches of a clip or an asset whose source sound stays below a level for at least a minimum length, as { start, end } ms (timeline times for a clip, so they can go straight to extract_video_range or split_video_at; source times for an asset). Use it to cut pauses, dead air or the gaps between takes. The first call for an asset decodes its file.',
		inputSchema: object({
			...SOUND_TARGET,
			thresholdDb: { type: 'number', minimum: -100, maximum: 0, description: 'Quieter than this peak level counts as silence, in dBFS (default -40; -50 for a quiet room, -30 over background noise).' },
			minDuration: { type: 'number', exclusiveMinimum: 0, description: 'Shortest silence to report, in ms (default 300).' }
		}),
		annotations: { title: 'Find silences', ...SOUND_ANNOTATIONS },
		handler: async (args) => {
			const r = soundRange(args);
			const peaks = await controller.audioPeaks.load(r.asset);
			const silences = findVideoAudioSilences(peaks, r.toSource(r.from), r.toSource(r.to), { thresholdDb: args.thresholdDb, minDuration: args.minDuration }).map((x) => ({ start: round(r.toOut(x.start)), end: round(r.toOut(x.end)) }));
			return { asset: r.asset.id, from: r.from, to: r.to, silences, total: round(silences.reduce((n, x) => n + x.end - x.start, 0)) };
		}
	};


	/** The pixels of the frame at `time`: the host's, or the preview's (seeking it there and back). */
	const pixelsAt = async (time: number): Promise<VideoPixels> => {
		if (options.framePixels) {
			const px = await options.framePixels(time);
			if (!px) throw new Error(`The host could not render the frame at ${Math.round(time)} ms; use render_video_frame to look at it instead.`);
			return px;
		}
		const feed = controller.previewPixels;
		if (!feed.attached) throw new Error('No preview is showing this project, so there are no pixels to measure. The host must show a <VideoPreview> for this editor (or pass framePixels to the tool provider); until then use get_video_frame and render_video_frame.');
		const state = controller.getState();
		if (Math.abs(time - state.time) < 0.5) return (await feed.next(state.time, options.framePixelsTimeout)).pixels;
		const { time: before, playing } = state;
		if (playing) controller.pause();
		controller.seek(time);
		try {
			return (await feed.next(controller.getState().time, options.framePixelsTimeout)).pixels;
		} finally {
			controller.seek(before);
			if (playing) controller.play();
		}
	};

	const getScopes: AgentTool = {
		name: 'get_video_scopes',
		title: 'Measure a frame with scopes',
		description:
			'Measures the rendered picture at a moment as colour scopes would, without changing the project: luma (0 = black, 1 = white) mean, median, min, max and 1st / 99th percentiles; the share of pixels crushed to black or blown to white (and per channel); saturation; the average colour (a cast shows as a tint); a coarse luma and RGB histogram; the luma spread of vertical strips left to right (a waveform); the main hue and strength on a vectorscope; and notes on what to fix. Use it before and after grading (update_video_clip grade, apply_video_grade_preset) to check exposure and colour. Needs the pixels the host draws: fails with a reason when no preview is showing.',
		inputSchema: object({
			time: MS('Time from the start to measure (default: the playhead). Another time is shown briefly and the playhead put back'),
			bins: { type: 'integer', minimum: 2, maximum: 64, description: 'Histogram steps, darkest first (default 16).' },
			columns: { type: 'integer', minimum: 1, maximum: 32, description: 'Waveform strips across the picture, left to right (default 8).' }
		}),
		annotations: { title: 'Measure a frame with scopes', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async ({ time, bins, columns }) => {
			const p = project();
			const end = videoProjectDuration(p);
			const t = time ?? controller.getState().time;
			if (time !== undefined && time > end) throw new Error(`Time ${time} ms is past the end of the project (${end} ms).`);
			const pixels = await pixelsAt(t);
			return { time: t, timecode: formatVideoTimecode(t, p.fps), width: pixels.width, height: pixels.height, ...summarizeVideoScopes(pixels, { bins, columns }) };
		}
	};

	const reads = [getProject, listSequences, getFrame, getTranscript, findText, findFillers, findPauses, findGaps, checkProject, renderFrame, getScopes, previewCache, planProxies, exportFfmpeg, exportLoudnessMeasure, exportEdl, audioLevels, findSilences, seek, setPreviewScale];
	const writes = [setSettings, addAsset, updateAsset, removeAsset, setProxies, addTrack, updateTrack, removeTrack, moveTrack, addClip, moveClip, trimClip, splitClip, deleteClips, updateClip, setTransition, setSpeedRamp, addFreeze, removeRamp, setTranscript, removeRanges, applyGradePreset, copyGrade, setLut, removeLut, setKeyframes, removeKeyframes, slipClip, rollEdit, slideClip, liftRange, extractRange, splitAt, closeGaps, addMarker, removeMarker, editVideo, undo, redo];

	return {
		id: options.id ?? 'video',
		namespace: options.namespace,
		title: 'Video editor',
		description: 'Non-linear video editing: assets, tracks and clips, trims, ripples and gaps, transitions and speed, grading and LUTs, keyframes, audio, transcripts, markers, and EDL or ffmpeg export.',
		skill: 'pixerate-video-editor',
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
	};
}
