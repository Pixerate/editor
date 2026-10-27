/**
 * Agent tools for talking-head cleanup: find fillers, long pauses and stutters in one pass, and
 * propose cutting them as one plan for review (plan first, then `apply_video_edit_plan`). Skill:
 * `pixerate-talking-head-edit`.
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { JsonSchema } from '../tools/schema.js';
import type { VideoEditorController } from './controller.js';
import { withVideoPlayback } from './playback.js';
import { describeVideoEditPlan } from './plan.js';
import { videoProjectDuration } from './timeline.js';
import { detectVideoDisfluencies, mergeVideoRanges, VIDEO_DEFAULT_FILLERS, VIDEO_DISFLUENCY_KINDS, videoCutsWithMargin, videoRemoveRangesEdits, videoTimelineTranscript, type VideoDisfluency, type VideoDisfluencyKind } from './transcript.js';

export interface VideoDialogueToolProviderOptions {
	/** Provider id (unique per registry). Default `video-dialogue`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** The project cannot be edited: the planning tool is hidden. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
	/** The agent playback surface its calls are acted out on (default `video`). */
	playbackSurface?: string;
}

const round = (ms: number) => Math.round(ms * 10) / 10;
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema & { type: 'object' } => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

const FIND_FIELDS: Record<string, JsonSchema> = {
	track: { type: 'string', minLength: 1, description: 'Track whose words to read (default: the first audio track with a transcribed clip, else the first video track with one).' },
	kinds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...VIDEO_DISFLUENCY_KINDS] }, description: 'What to look for: filler (um, uh, you know…), pause (long gaps between words), repetition (stutters such as "I I think"). Default all three.' },
	fillers: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: `Words or phrases counted as fillers instead of the defaults (${VIDEO_DEFAULT_FILLERS.join(', ')}).` },
	min_pause: { type: 'number', exclusiveMinimum: 0, description: 'Shortest gap between words that counts as a pause, in ms (default 700; 600 for brisk talking heads).' },
	keep: { type: 'number', minimum: 0, maximum: 1000, description: 'Breath kept either side of a pause cut, in ms (default 150; 150–250 sounds natural).' },
	max_phrase: { type: 'integer', minimum: 1, maximum: 6, description: 'Longest phrase checked for a repeat, in words (default 3).' }
};

/** The talking-head cleanup tools for a video editor (see the module comment). */
export function createVideoDialogueToolProvider(controller: VideoEditorController, options: VideoDialogueToolProviderOptions = {}): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (r) return typeof r === 'string' ? r : 'This video project is read-only.';
		return controller.readOnlyReason();
	};
	const find = (args: Record<string, any>): VideoDisfluency[] => {
		const project = controller.getProject();
		const words = videoTimelineTranscript(project, { track: args.track });
		if (!words.length) throw new Error(args.track ? `No clip on track "${args.track}" plays a transcribed asset; attach one with set_video_transcript.` : 'No clip plays a transcribed asset; attach a transcript to the media with set_video_transcript first.');
		return detectVideoDisfluencies(words, {
			kinds: args.kinds as VideoDisfluencyKind[] | undefined,
			fillers: args.fillers,
			pauses: { fps: project.fps, ...(args.min_pause !== undefined ? { min: args.min_pause } : {}), ...(args.keep !== undefined ? { keep: args.keep } : {}) },
			repetitions: args.max_phrase !== undefined ? { maxPhrase: args.max_phrase } : undefined
		});
	};
	const out = (d: VideoDisfluency) => ({ kind: d.kind, from: round(d.from), to: round(d.to), text: d.text, words: d.words });

	const findDisfluencies: AgentTool = {
		name: 'find_video_disfluencies',
		title: 'Find fillers, pauses and stutters',
		description:
			'Reads the timeline transcript and lists, in time order, every filler word, long pause and repeated word or phrase as { kind, from, to, text, words } (timeline ms; "words" are the first and last word indexes in get_video_transcript\'s list), with a count and total per kind. Changes nothing. Review the list (some repeats and pauses are meant), then call plan_video_dialogue_cleanup or remove_video_ranges with the ones to cut.',
		inputSchema: object(FIND_FIELDS),
		annotations: { title: 'Find fillers, pauses and stutters', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: (args) => {
			const found = find(args);
			const totals = Object.fromEntries(VIDEO_DISFLUENCY_KINDS.map((k) => [k, { count: found.filter((d) => d.kind === k).length, time: round(found.filter((d) => d.kind === k).reduce((n, d) => n + d.to - d.from, 0)) }]));
			const merged = mergeVideoRanges(found);
			return { disfluencies: found.map(out), totals, removable: round(merged.reduce((n, r) => n + r.to - r.from, 0)) };
		}
	};

	const planCleanup: AgentTool = {
		name: 'plan_video_dialogue_cleanup',
		title: 'Propose a dialogue cleanup',
		description:
			'Finds fillers, long pauses and stutters (as find_video_disfluencies) and proposes cutting them as one plan for review: nothing changes until apply_video_edit_plan. Pass "exclude" to keep finds the user wants (by their from time), and "margin" to keep a little breath around filler and stutter cuts. Every sync-locked track is cut with the dialogue. Returns the plan (id, title, length change, the stretches it cuts) for the user to review.',
		inputSchema: object(
			{
				...FIND_FIELDS,
				exclude: { type: 'array', maxItems: 500, items: { type: 'number', minimum: 0 }, description: 'The "from" times (ms) of finds to keep, from find_video_disfluencies.' },
				margin: { type: 'number', minimum: 0, maximum: 200, description: 'Ms left uncut at each end of a filler or stutter cut, so the words around it are not clipped (default 0).' },
				title: { type: 'string', minLength: 1, maxLength: 120, description: 'The plan\'s title (default: what it cleans up, e.g. "Clean up 12 fillers, 3 pauses").' }
			}
		),
		annotations: { title: 'Propose a dialogue cleanup', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		handler: (args) => {
			const skip = new Set(((args.exclude ?? []) as number[]).map((t) => Math.round(t)));
			const found = find(args).filter((d) => !skip.has(Math.round(d.from)));
			if (!found.length) throw new Error('Nothing to clean up: no fillers, long pauses or repetitions were found (or all were excluded).');
			const margin = args.margin ?? 0;
			const cuts = found.flatMap((d) => (d.kind === 'pause' || !margin ? [d] : videoCutsWithMargin([d], margin)));
			const counts = VIDEO_DISFLUENCY_KINDS.map((k) => [k, found.filter((d) => d.kind === k).length] as const).filter(([, n]) => n);
			const title = args.title ?? `Clean up ${counts.map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`).join(', ')}`;
			const r = controller.proposePlan({ title, description: 'Cuts fillers, long pauses and stutters found in the transcript, closing up every sync-locked track.', edits: videoRemoveRangesEdits(cuts), ranges: cuts.map((d) => ({ from: d.from, to: d.to, text: d.text, reason: d.kind })), source: 'plan_video_dialogue_cleanup' });
			if (!r.ok) throw new Error(r.error);
			const p = r.plan;
			return { plan: { id: p.id, title: p.title, summary: p.summary, text: describeVideoEditPlan(p), cuts: cuts.length }, durationNow: videoProjectDuration(controller.getProject()), hint: `Nothing changed yet. Show the user the plan, then call apply_video_edit_plan with plan "${p.id}" (or discard_video_edit_plan).` };
		}
	};

	return withVideoPlayback(
		{
			id: options.id ?? 'video-dialogue',
			namespace: options.namespace,
			title: 'Video dialogue cleanup',
			description: 'Talking-head cleanup by transcript: find fillers, long pauses and stutters, and propose cutting them as one plan for review.',
			skill: 'pixerate-talking-head-edit',
			tools: () => (readOnlyReason() ? [findDisfluencies] : [findDisfluencies, planCleanup]),
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
