import { checkVideoProject, videoIssueKey, type VideoIssue } from './check.js';
import { applyVideoEdits, type VideoEdit } from './edit.js';
import { allVideoTracks, videoProjectDuration } from './timeline.js';
import type { VideoClip, VideoProject } from './types.js';

/**
 * Plan first, apply later: a `VideoEditPlan` is a batch of edits worked out against the project
 * and summarised (length before and after, clips added, removed and changed, stretches cut) without
 * changing anything. People and agents review the plan, preview it, then apply it as one undo step
 * or discard it. Plans are not part of the project or its history.
 */

/** A stretch a plan cuts or changes (timeline ms), with what is said there or why. */
export interface VideoEditPlanRange {
	from: number;
	to: number;
	/** The words in it, as the transcript tools return them. */
	text?: string;
	/** Why it is in the plan (e.g. `filler`, `pause`, `repetition`, `beat`). */
	reason?: string;
}

/** What applying a plan would do. */
export interface VideoEditPlanSummary {
	/** The project's length now and after (ms). */
	durationBefore: number;
	durationAfter: number;
	/** `durationAfter - durationBefore` (negative when it shortens). */
	durationDelta: number;
	/** Clip ids that would be new, gone or different. */
	clipsAdded: string[];
	clipsRemoved: string[];
	clipsChanged: string[];
	/** Problems the plan would add (issues the project does not have now). */
	newIssues: VideoIssue[];
	/** How many edits it applies. */
	edits: number;
}

/** A proposed batch of edits and what it would do. */
export interface VideoEditPlan {
	/** Unique among the open plans (e.g. `plan1`). */
	id: string;
	/** A short label, also the undo step's label when applied. */
	title: string;
	/** What it does and why, for the reviewer. */
	description?: string;
	/** Who proposed it (`agent`, `user`, a tool name…). */
	source?: string;
	edits: VideoEdit[];
	/** The stretches it cuts or changes, for a diff view. */
	ranges?: VideoEditPlanRange[];
	summary: VideoEditPlanSummary;
}

/** Every clip in the project (sequences included) by id. */
function clipIndex(project: VideoProject): Map<string, VideoClip> {
	const out = new Map<string, VideoClip>();
	for (const { track } of allVideoTracks(project)) for (const c of track.clips) out.set(c.id, c);
	return out;
}

/** What changed between two versions of a project: clips added, removed and changed, and the length. */
export function diffVideoProjects(before: VideoProject, after: VideoProject): Omit<VideoEditPlanSummary, 'newIssues' | 'edits'> {
	const a = clipIndex(before);
	const b = clipIndex(after);
	const clipsAdded = [...b.keys()].filter((id) => !a.has(id));
	const clipsRemoved = [...a.keys()].filter((id) => !b.has(id));
	const clipsChanged = [...b.keys()].filter((id) => a.has(id) && JSON.stringify(a.get(id)) !== JSON.stringify(b.get(id)));
	const durationBefore = videoProjectDuration(before);
	const durationAfter = videoProjectDuration(after);
	return { durationBefore, durationAfter, durationDelta: durationAfter - durationBefore, clipsAdded, clipsRemoved, clipsChanged };
}

export interface VideoEditPlanInput {
	/** Default: a fresh `plan<n>` id. */
	id?: string;
	title: string;
	description?: string;
	source?: string;
	edits: readonly VideoEdit[];
	ranges?: readonly VideoEditPlanRange[];
}

/**
 * Works a plan out against a project without changing it: the edits are applied to a copy, all or
 * nothing, and summarised. `ok: false` with the edit's error when they do not apply. `project` is
 * what the project would become (to preview).
 */
export function planVideoEdits(project: VideoProject, input: VideoEditPlanInput): { ok: true; plan: VideoEditPlan; project: VideoProject } | { ok: false; error: string } {
	if (!input.title?.trim()) return { ok: false, error: 'A plan needs a title saying what it does (e.g. "Remove 12 filler words").' };
	if (!input.edits.length) return { ok: false, error: 'The plan has no edits; there is nothing to propose.' };
	const result = applyVideoEdits(project, input.edits);
	if (!result.ok) return { ok: false, error: result.error };
	const known = new Set(checkVideoProject(project).map(videoIssueKey));
	const summary: VideoEditPlanSummary = { ...diffVideoProjects(project, result.project), newIssues: result.issues.filter((i) => !known.has(videoIssueKey(i))), edits: input.edits.length };
	const plan: VideoEditPlan = {
		id: input.id ?? 'plan',
		title: input.title.trim(),
		...(input.description ? { description: input.description } : {}),
		...(input.source ? { source: input.source } : {}),
		edits: structuredClone([...input.edits]),
		...(input.ranges?.length ? { ranges: input.ranges.map((r) => ({ ...r })) } : {}),
		summary
	};
	return { ok: true, plan, project: result.project };
}

/** One line describing a plan's effect, e.g. "Removes 4 stretches (3.2 s shorter): 5 clips changed, 1 removed". */
export function describeVideoEditPlan(plan: VideoEditPlan): string {
	const s = plan.summary;
	const parts: string[] = [];
	if (plan.ranges?.length) parts.push(`${plan.ranges.length} stretch${plan.ranges.length > 1 ? 'es' : ''}`);
	const delta = s.durationDelta;
	const length = Math.abs(delta) < 0.5 ? 'same length' : `${(Math.abs(delta) / 1000).toFixed(1)} s ${delta < 0 ? 'shorter' : 'longer'}`;
	const clips = [s.clipsAdded.length && `${s.clipsAdded.length} added`, s.clipsChanged.length && `${s.clipsChanged.length} changed`, s.clipsRemoved.length && `${s.clipsRemoved.length} removed`].filter(Boolean).join(', ');
	return `${plan.title} (${parts.length ? `${parts.join(', ')}, ` : ''}${length})${clips ? `: clips ${clips}` : ''}`;
}
