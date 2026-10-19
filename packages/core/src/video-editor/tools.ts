import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import type { VideoIssue } from './check.js';
import type { VideoEditorController } from './controller.js';
import { VIDEO_EDIT_OPS, type VideoEdit, type VideoEditResult } from './edit.js';
import { videoFrameAt } from './evaluate.js';
import { VIDEO_EASE_NAMES, VIDEO_KEYFRAME_PROPERTIES, VIDEO_TRANSFORM_PROPERTIES, type VideoAnimatable, type VideoKeyframeProperty } from './keyframes.js';
import { videoContactSheetSvg, videoProjectSvg } from './render.js';
import { findVideoGaps, formatVideoTimecode, sortedVideoClips, videoClipEnd, videoClipSourceRange, videoProjectDuration } from './timeline.js';
import { VIDEO_FITS, VIDEO_TRANSITION_TYPES, VIDEO_WIPE_DIRECTIONS, type VideoProject } from './types.js';

export interface VideoEditorToolProviderOptions {
	/** Provider id (unique per registry). Default `video`. */
	id?: string;
	/** Always prefix tool names with `<namespace>__`. */
	namespace?: string;
	/** The project cannot be edited: write tools are hidden and `get_video_project` says why. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
	/** Turns SVG into PNG (e.g. `rasterizeSvg`), so `render_video_frame` can return an image. */
	rasterize?: (svg: string, size: { width: number; height: number }) => Promise<{ data: string; mimeType: string }> | { data: string; mimeType: string };
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
const RIPPLE = { type: 'boolean', description: 'Push (or pull) the later clips on the same track along by the change, keeping the cuts after it in sync (default false: refuse if it would overlap).' } as const;

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
		type: { type: 'string', enum: [...VIDEO_TRANSITION_TYPES], description: 'crossfade (this clip fades up over the one before), dip (down into a colour and up out of it) or wipe (an edge travels across revealing this clip).' },
		duration: { type: 'number', exclusiveMinimum: 0, description: 'Length in ms, centred on the cut. A crossfade or wipe needs half of it in media past the cut on both sides (handles); a dip needs none.' },
		color: COLOR('For dip: the colour passed through (default black)'),
		direction: { type: 'string', enum: [...VIDEO_WIPE_DIRECTIONS], description: 'For wipe: the way the edge travels (default right).' }
	},
	['type', 'duration'],
	'A transition from the clip that ends where this one starts on the same track.'
);
const CLIP_COMMON: Record<string, JsonSchema> = {
	name: { type: 'string', description: 'A label for the clip.' },
	opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Opacity 0–1 (default 1). A number replaces any keyframes; set_video_keyframes animates it.' },
	transform: TRANSFORM,
	fit: { type: 'string', enum: [...VIDEO_FITS], description: 'How the picture fits the frame before the transform, as CSS object-fit (default contain for media, fill for colours).' },
	fadeIn: MS('Fade up from nothing (picture and sound) over this long'),
	fadeOut: MS('Fade down to nothing over this long')
};
const MEDIA_FIELDS: Record<string, JsonSchema> = {
	in: MS('Where in the source it starts (default 0)'),
	speed: { type: 'number', minimum: 0.05, maximum: 20, description: 'Playback speed (default 1). Changing it keeps the stretch of source, so the clip gets shorter or longer.' },
	volume: { type: 'number', minimum: 0, maximum: 4, description: 'Gain (1 = unchanged, default 1). A number replaces any keyframes; set_video_keyframes animates it.' },
	muted: { type: 'boolean', description: 'Silence this clip (default false).' }
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

/** A project as agents see it: settings, assets, and each track's clips in order with their times. */
export function describeVideoProject(project: VideoProject) {
	return {
		...(project.name ? { name: project.name } : {}),
		width: project.width,
		height: project.height,
		fps: project.fps,
		duration: videoProjectDuration(project),
		...(project.background ? { background: project.background } : {}),
		assets: project.assets,
		tracks: project.tracks.map((t, index) => ({
			id: t.id,
			kind: t.kind,
			index,
			...(t.name ? { name: t.name } : {}),
			...(t.muted ? { muted: true } : {}),
			...(t.hidden ? { hidden: true } : {}),
			...(t.locked ? { locked: true } : {}),
			...(t.volume !== undefined ? { volume: t.volume } : {}),
			clips: sortedVideoClips(t).map((c) => ({ ...c, end: videoClipEnd(c), ...(c.type === 'media' ? { source: videoClipSourceRange(c) } : {}) }))
		})),
		markers: project.markers ?? []
	};
}

/**
 * Agent tools for a `VideoEditorController`: read the project (assets, tracks with clips and their
 * times, gaps, what plays at a moment), check it, render frames, export to ffmpeg or an EDL, and
 * edit it a step at a time (add assets and tracks, add / move / trim / split / delete clips, ripple,
 * transitions, markers). Every write is checked first (unknown ids with "did you mean", overlaps,
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
			if (c) return { track: t.id, ...c, end: videoClipEnd(c), ...(c.type === 'media' ? { source: videoClipSourceRange(c) } : {}) };
		}
		return null;
	};

	const keysOut = (p: VideoProject, clip: string, property: VideoKeyframeProperty) => {
		const c = clipOut(p, clip) as any;
		const value: VideoAnimatable | undefined = (VIDEO_TRANSFORM_PROPERTIES as readonly string[]).includes(property) ? c?.transform?.[property] : c?.[property];
		return typeof value === 'object' ? { keys: value.keys } : { keys: [], value: value ?? null };
	};

	const getProject: AgentTool = {
		name: 'get_video_project',
		title: 'Read the video project',
		description:
			'Returns the whole project: frame size, fps, length (ms), assets (id, kind, src, duration), tracks top to bottom (an earlier video track draws over a later one) with each clip in time order (id, type, start, duration, end, source in/out for media, fades, transition) and markers, plus the playhead, selection, issues and whether it can be edited.',
		inputSchema: object({}),
		annotations: { title: 'Read the video project', ...READ },
		handler: () => {
			const state = controller.getState();
			const reason = readOnlyReason();
			return { ...describeVideoProject(state.project), playhead: state.time, selection: state.selection, issues: issueSummary(state.issues), editable: !reason, ...(reason ? { readOnlyReason: reason } : {}) };
		}
	};

	const getFrame: AgentTool = {
		name: 'get_video_frame',
		title: 'What plays at a moment',
		description: 'Returns what plays at a time without changing anything: the pictures back to front (clip, track, asset, source time in ms, opacity, placement rect, rotation, any wipe) and the sounds (clip, source time, gain after volumes, fades and transitions).',
		inputSchema: object({ time: MS('Time from the start (default: the playhead)') }),
		annotations: { title: 'What plays at a moment', ...READ },
		handler: ({ time }) => {
			const frame = videoFrameAt(project(), time ?? controller.getState().time);
			return { ...frame, timecode: formatVideoTimecode(frame.time, project().fps) };
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
		description: 'Lists the project\'s problems, errors first, each with a code, the clip / track / asset it is about and how to fix it: missing assets, overlaps, clips past the end of their source, transitions without a cut or handles, fades longer than the clip, keyframes outside their clip, assets with no duration, unused assets.',
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
			const svg = times ? videoContactSheetSvg(p, times, columns ? { columns } : {}) : videoProjectSvg(p, time ?? controller.getState().time);
			if (format === 'png') {
				if (!options.rasterize) throw new Error('This host cannot make PNG images; call render_video_frame with format "svg".');
				const size = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)!;
				const image = await options.rasterize(svg, { width: Number(size[1]), height: Number(size[2]) });
				return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
			}
			return { svg };
		}
	};

	const exportFfmpeg: AgentTool = {
		name: 'export_video_ffmpeg',
		title: 'Export an ffmpeg command',
		description: 'Returns the ffmpeg command that renders the project to a file: { args (for spawn), command (one shell line), filterComplex, duration, notes on anything approximated }. Fails when the project has no clips.',
		inputSchema: object({
			output: { type: 'string', minLength: 1, description: 'Output file name (default output.mp4).' },
			crf: { type: 'integer', minimum: 0, maximum: 51, description: 'x264 quality, lower is better (default 18).' }
		}),
		annotations: { title: 'Export an ffmpeg command', ...READ },
		handler: ({ output, crf }) => controller.toFfmpeg({ ...(output ? { output } : {}), ...(crf !== undefined ? { crf } : {}) })
	};

	const exportEdl: AgentTool = {
		name: 'export_video_edl',
		title: 'Export an EDL',
		description: 'Returns one track as a CMX 3600 edit decision list (text) for conforming in another editor: events with source and record timecode, dissolves, speed changes and clip names.',
		inputSchema: object({
			track: { ...TRACK_ID, description: 'Track to export (default: the bottom video track).' },
			title: { type: 'string', description: 'TITLE line (default: the project name).' }
		}),
		annotations: { title: 'Export an EDL', ...READ },
		handler: ({ track, title }) => ({ edl: controller.toEdl({ ...(track ? { track } : {}), ...(title ? { title } : {}) }) })
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
		inputSchema: object({ asset: ASSET_ID, set: object(ASSET_FIELDS, [], 'Fields to replace.'), remove: { type: 'array', items: { type: 'string', enum: ['name', 'duration', 'width', 'height', 'hasAudio', 'poster'] }, description: 'Fields to clear.' } }, ['asset']),
		annotations: { title: 'Change media details', ...WRITE_IDEMPOTENT },
		handler: ({ asset, set, remove }) => apply({ op: 'update_asset', asset, set, remove }, 'Change media', (r) => ({ asset: r.project.assets.find((a) => a.id === asset) }))
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
		description: 'Renames, mutes, hides, locks or sets the volume of a track (one undo step). Returns the track\'s settings.',
		inputSchema: object({ track: TRACK_ID, set: object(TRACK_FIELDS, [], 'Fields to replace.'), remove: { type: 'array', items: { type: 'string', enum: ['name', 'muted', 'hidden', 'locked', 'volume'] }, description: 'Fields to clear.' } }, ['track']),
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
			'Puts a clip on a track (one undo step): media (a stretch of an asset from its "in" point), a title or a colour. With no start it goes at the end of the track; with ripple it is inserted at "start", pushing later clips along; otherwise an overlap is refused with the next free place. Returns the clip with its end and source range.',
		inputSchema: object({ track: TRACK_ID, clip: NEW_CLIP, ripple: RIPPLE }, ['track', 'clip']),
		annotations: { title: 'Add a clip', ...WRITE },
		handler: ({ track, clip, ripple }) => apply({ op: 'add_clip', track, clip, ripple }, 'Add clip', (r) => ({ clip: clipOut(r.project, r.outcomes[0].clip!) }))
	};

	const moveClip: AgentTool = {
		name: 'move_video_clip',
		title: 'Move a clip',
		description: 'Moves a clip to a new start and/or another track of the same kind (one undo step). Refused if it would overlap another clip, naming it and the next free place. Returns the clip.',
		inputSchema: object({ clip: CLIP_ID, start: MS('New start on the timeline (default: unchanged)'), track: { ...TRACK_ID, description: 'Track to move it to (default: its own).' } }, ['clip']),
		annotations: { title: 'Move a clip', ...WRITE_IDEMPOTENT },
		handler: ({ clip, start, track }) => {
			if (start === undefined && track === undefined) throw new Error('Give "start", "track" or both.');
			return apply({ op: 'move_clip', clip, start, track }, 'Move clip', (r) => ({ clip: clipOut(r.project, clip) }));
		}
	};

	const trimClip: AgentTool = {
		name: 'trim_video_clip',
		title: 'Trim a clip',
		description:
			'Moves one edge of a clip to a timeline time (one undo step): "start" also moves its source in point, "end" its out point. Refused past the ends of the source (the error says how far it can go) or below one frame. With ripple the clip keeps its start and the later clips on the track move by the change, so no gap or overlap opens. Returns the clip.',
		inputSchema: object({ clip: CLIP_ID, edge: { type: 'string', enum: ['start', 'end'], description: 'Which edge to move.' }, to: MS('Where that edge goes on the timeline'), ripple: RIPPLE }, ['clip', 'edge', 'to']),
		annotations: { title: 'Trim a clip', ...WRITE_IDEMPOTENT },
		handler: ({ clip, edge, to, ripple }) => apply({ op: 'trim_clip', clip, edge, to, ripple }, 'Trim clip', (r) => ({ clip: clipOut(r.project, clip) }))
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
		description: 'Removes clips (one undo step). With ripple the later clips on each track move up to close the gaps. Returns the ids removed.',
		inputSchema: object({ clips: { type: 'array', items: CLIP_ID, minItems: 1, description: 'Clip ids.' }, ripple: { type: 'boolean', description: 'Close the gaps they leave (default false).' } }, ['clips']),
		annotations: { title: 'Delete clips', ...DESTRUCTIVE },
		handler: ({ clips, ripple }) => apply({ op: 'delete_clips', clips, ripple }, ripple ? 'Ripple delete' : 'Delete clips', () => ({ removed: clips }))
	};

	const updateClip: AgentTool = {
		name: 'update_video_clip',
		title: 'Change a clip',
		description:
			'Changes a clip\'s properties (one undo step): opacity, transform, fit, fades, name; for media volume, mute, speed (keeps the stretch of source, so the length changes) or asset; for titles text and style; for colours the colour. Fields in "remove" go back to their defaults. Use move / trim for timing. Returns the clip.',
		inputSchema: object(
			{
				clip: CLIP_ID,
				set: object({ ...CLIP_COMMON, ...MEDIA_FIELDS, asset: { ...ASSET_ID, description: 'For media: play another asset (same in point).' }, ...TEXT_FIELDS, color: COLOR('Text colour, or a colour clip\'s fill') }, [], 'Fields to replace (only those that fit the clip\'s type).'),
				remove: { type: 'array', items: { type: 'string', enum: ['name', 'opacity', 'transform', 'fit', 'fadeIn', 'fadeOut', 'in', 'speed', 'volume', 'muted', 'fontSize', 'fontFamily', 'fontWeight', 'background'] }, description: 'Fields to reset to their defaults.' }
			},
			['clip']
		),
		annotations: { title: 'Change a clip', ...WRITE_IDEMPOTENT },
		handler: ({ clip, set, remove }) => {
			const current = clipOut(project(), clip);
			if (current && set) {
				const allowed = new Set(['name', 'opacity', 'transform', 'fit', 'fadeIn', 'fadeOut', ...(current.type === 'media' ? ['in', 'speed', 'volume', 'muted', 'asset'] : current.type === 'text' ? Object.keys(TEXT_FIELDS) : ['color'])]);
				const wrong = Object.keys(set).filter((k) => !allowed.has(k));
				if (wrong.length) throw new Error(`${wrong.map((k) => `"${k}"`).join(', ')} cannot be set on a ${current.type} clip; it takes ${[...allowed].join(', ')}.`);
			}
			return apply({ op: 'update_clip', clip, set, remove }, 'Change clip', (r) => ({ clip: clipOut(r.project, clip) }));
		}
	};

	const setTransition: AgentTool = {
		name: 'set_video_transition',
		title: 'Set a transition',
		description:
			'Sets (or with null removes) the transition into a clip from the clip that ends where it starts on the same track (one undo step). A crossfade or wipe plays half before and half after the cut, so both clips need that much media past the cut; when they do not, the error says the longest that fits. Returns the clip.',
		inputSchema: object({ clip: { ...CLIP_ID, description: 'The incoming clip (the one after the cut).' }, transition: { anyOf: [TRANSITION, { type: 'null' }], description: 'The transition, or null to remove it.' } }, ['clip', 'transition']),
		annotations: { title: 'Set a transition', ...WRITE_IDEMPOTENT },
		handler: ({ clip, transition }) => apply({ op: 'set_transition', clip, transition }, transition ? 'Set transition' : 'Remove transition', (r) => ({ clip: clipOut(r.project, clip) }))
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
		description: `One edit: { "op": one of ${VIDEO_EDIT_OPS.filter((o) => o !== 'replace_project').join(', ')}, …its fields }. Fields match the single tools: add_clip { track, clip, ripple }, move_clip { clip, start, track }, trim_clip { clip, edge, to, ripple }, split_clip { clip, at, id }, delete_clips { clips, ripple }, update_clip { clip, set, remove }, set_transition { clip, transition }, set_keyframes { clip, property, keys (null removes) }, close_gaps { track, from }, add_asset { asset }, update_asset { asset, set, remove }, remove_asset { asset }, add_track { track: { kind, id, … }, at }, update_track { track, set, remove }, remove_track { track }, move_track { track, to }, add_marker { marker: { time, label } }, update_marker { marker, set }, remove_marker { marker }, set_settings { name, width, height, fps, background }.`,
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

	const reads = [getProject, getFrame, findGaps, checkProject, renderFrame, exportFfmpeg, exportEdl, seek];
	const writes = [setSettings, addAsset, updateAsset, removeAsset, addTrack, updateTrack, removeTrack, moveTrack, addClip, moveClip, trimClip, splitClip, deleteClips, updateClip, setTransition, setKeyframes, removeKeyframes, closeGaps, addMarker, removeMarker, editVideo, undo, redo];

	return {
		id: options.id ?? 'video',
		namespace: options.namespace,
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
