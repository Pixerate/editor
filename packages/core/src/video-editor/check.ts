import { findVideoSequenceCycle, formatVideoSeconds, sortedVideoClips, VIDEO_TIME_EPSILON, videoAssetMap, videoClipBefore, videoClipEnd, videoClipHandles, videoClipSourceRange, videoProjectDuration, videoSequenceDuration, videoSequenceMap } from './timeline.js';
import { VIDEO_CLIP_ANIMATION_DURATION, videoClipAnimationProperties } from './clip-animation.js';
import { VIDEO_TRANSFORM_PROPERTIES, videoKeysOf } from './keyframes.js';
import type { VideoClip, VideoProject, VideoTrack } from './types.js';

/** A clip's keyframed properties (`opacity`, `volume`, `x`…) with their keys. */
export function videoClipKeyframes(clip: VideoClip): { property: string; keys: ReturnType<typeof videoKeysOf> }[] {
	const out = [
		{ property: 'opacity', keys: videoKeysOf(clip.opacity) },
		{ property: 'volume', keys: clip.type === 'media' || clip.type === 'sequence' ? videoKeysOf(clip.volume) : [] },
		...VIDEO_TRANSFORM_PROPERTIES.map((p) => ({ property: p as string, keys: videoKeysOf(clip.transform?.[p]) }))
	];
	return out.filter((o) => o.keys.length);
}

export type VideoIssueSeverity = 'error' | 'warning' | 'note';

export const VIDEO_ISSUE_CODES = [
	'missing-asset',
	'missing-sequence',
	'sequence-cycle',
	'wrong-track',
	'overlap',
	'source-overrun',
	'transition-without-cut',
	'transition-too-long',
	'transition-handles',
	'fades-too-long',
	'animations-too-long',
	'animation-keyed',
	'keyframes-outside-clip',
	'unknown-duration',
	'unused-asset',
	'unused-sequence',
	'marker-past-end',
	'missing-target-track',
	'empty'
] as const;
export type VideoIssueCode = (typeof VIDEO_ISSUE_CODES)[number];

export interface VideoIssue {
	code: VideoIssueCode;
	severity: VideoIssueSeverity;
	/** One sentence saying what is wrong and how to fix it. */
	message: string;
	/** The sequence whose track it is about (absent for the project's own tracks). */
	sequence?: string;
	track?: string;
	clip?: string;
	asset?: string;
	marker?: string;
}

/** A stable key for an issue (code and what it is about), to tell new problems from old ones. */
export const videoIssueKey = (i: VideoIssue): string => [i.code, i.sequence ?? '', i.track ?? '', i.clip ?? '', i.asset ?? '', i.marker ?? ''].join('|');

/**
 * Everything wrong with a project, errors first: clips pointing at missing media or sitting on the
 * wrong kind of track, overlaps, clips running past the end of their source, transitions with no
 * cut to play over or not enough media either side of it, and softer notes (unused assets, markers
 * past the end). Sequences' tracks are checked the same way, and compound clips must play a
 * sequence that exists, does not contain itself and is long enough. Edits never add errors (see `applyVideoEdits`), so errors only come from a loaded file.
 */
export function checkVideoProject(project: VideoProject): VideoIssue[] {
	const issues: VideoIssue[] = [];
	const assets = videoAssetMap(project);
	const sequences = videoSequenceMap(project);
	const used = new Set<string>();
	const usedSequences = new Set<string>();
	const cycles = new Map<string, string[] | null>();
	for (const asset of project.assets)
		if ((asset.kind === 'video' || asset.kind === 'audio') && asset.duration === undefined)
			issues.push({ code: 'unknown-duration', severity: 'warning', asset: asset.id, message: `Asset "${asset.id}" has no duration, so clips of it cannot be checked against its length; set "duration" in ms.` });
	const checkTrack = (track: VideoTrack, sequence?: string) => {
		const clips = sortedVideoClips(track);
		const where = sequence ? ` in sequence "${sequence}"` : '';
		for (let i = 0; i < clips.length; i++) {
			const clip = clips[i];
			const at = { ...(sequence ? { sequence } : {}), track: track.id, clip: clip.id };
			if (clip.type === 'sequence') {
				usedSequences.add(clip.sequence);
				const seq = sequences.get(clip.sequence);
				if (!seq) issues.push({ code: 'missing-sequence', severity: 'error', ...at, message: `Compound clip "${clip.id}" plays sequence "${clip.sequence}", which is not in the project; add the sequence or delete the clip.` });
				else {
					if (!cycles.has(seq.id)) cycles.set(seq.id, findVideoSequenceCycle(project, seq.id));
					const cycle = cycles.get(seq.id);
					if (cycle) issues.push({ code: 'sequence-cycle', severity: 'error', ...at, message: `Compound clip "${clip.id}" plays sequence "${seq.id}", which contains itself (${cycle.join(' → ')}), so it is left out of the picture and sound; remove the compound clip that closes the loop.` });
					const length = videoSequenceDuration(seq);
					const range = videoClipSourceRange(clip)!;
					if (range.out > length + VIDEO_TIME_EPSILON)
						issues.push({ code: 'source-overrun', severity: 'error', ...at, message: `Compound clip "${clip.id}" plays to ${formatVideoSeconds(range.out)} of sequence "${seq.id}", which is only ${formatVideoSeconds(length)} long; shorten the clip or move its in point.` });
				}
			} else if (clip.type === 'media') {
				used.add(clip.asset);
				const asset = assets.get(clip.asset);
				if (!asset) issues.push({ code: 'missing-asset', severity: 'error', ...at, asset: clip.asset, message: `Clip "${clip.id}" plays asset "${clip.asset}", which is not in the project; add the asset or delete the clip.` });
				else {
					if (track.kind === 'audio' && asset.kind === 'image') issues.push({ code: 'wrong-track', severity: 'error', ...at, message: `Clip "${clip.id}" is an image on audio track "${track.id}"; move it to a video track.` });
					if (track.kind === 'video' && asset.kind === 'audio') issues.push({ code: 'wrong-track', severity: 'error', ...at, message: `Clip "${clip.id}" is audio on video track "${track.id}"; move it to an audio track.` });
					const range = videoClipSourceRange(clip)!;
					if (asset.duration !== undefined && range.out > asset.duration + VIDEO_TIME_EPSILON)
						issues.push({ code: 'source-overrun', severity: 'error', ...at, message: `Clip "${clip.id}" plays to ${formatVideoSeconds(range.out)} of "${asset.id}", which is only ${formatVideoSeconds(asset.duration)} long; shorten the clip or move its in point.` });
				}
			} else if (track.kind === 'audio') issues.push({ code: 'wrong-track', severity: 'error', ...at, message: `Clip "${clip.id}" is a ${clip.type} clip on audio track "${track.id}"; move it to a video track.` });
			if (clip.type === 'adjustment' && (clip.scope ?? 'underneath') === 'track' && !(sequence ? (sequences.get(sequence)?.tracks ?? []) : project.tracks).some((t) => t.id === clip.targetTrack))
				issues.push({ code: 'missing-target-track', severity: 'warning', ...at, message: `Adjustment clip "${clip.id}" changes track "${clip.targetTrack}", which is not ${sequence ? `in sequence "${sequence}"` : 'in the project'}, so it changes nothing; set its targetTrack to a track beside it or change its scope.` });
			const next = clips[i + 1];
			if (next && next.start < videoClipEnd(clip) - VIDEO_TIME_EPSILON)
				issues.push({ code: 'overlap', severity: 'error', ...at, message: `Clips "${clip.id}" and "${next.id}" overlap on track "${track.id}"${where} from ${formatVideoSeconds(next.start)}; move one of them.` });
			if ((clip.fadeIn ?? 0) + (clip.fadeOut ?? 0) > clip.duration + VIDEO_TIME_EPSILON)
				issues.push({ code: 'fades-too-long', severity: 'warning', ...at, message: `Clip "${clip.id}"'s fades (${clip.fadeIn ?? 0} + ${clip.fadeOut ?? 0} ms) are longer than the clip (${clip.duration} ms); shorten them.` });
			const anim = (clip.animateIn ? (clip.animateIn.duration ?? VIDEO_CLIP_ANIMATION_DURATION) : 0) + (clip.animateOut ? (clip.animateOut.duration ?? VIDEO_CLIP_ANIMATION_DURATION) : 0);
			if (anim > clip.duration + VIDEO_TIME_EPSILON)
				issues.push({ code: 'animations-too-long', severity: 'warning', ...at, message: `Clip "${clip.id}"'s entrance and exit (${anim} ms together) are longer than the clip (${clip.duration} ms), so both are shortened; give them shorter durations.` });
			for (const which of ['animateIn', 'animateOut'] as const) {
				const a = clip[which];
				if (!a) continue;
				const keyed = videoClipAnimationProperties(a).filter((p) => videoKeysOf(p === 'opacity' ? clip.opacity : clip.transform?.[p]).length);
				if (keyed.length)
					issues.push({ code: 'animation-keyed', severity: 'note', ...at, message: `Clip "${clip.id}"'s ${a.effect} ${which === 'animateIn' ? 'entrance' : 'exit'} leaves ${keyed.join(', ')} alone, because the clip keys ${keyed.length > 1 ? 'them' : 'it'} itself; remove those keyframes or the animation.` });
			}
			for (const { property, keys } of videoClipKeyframes(clip)) {
				const outside = keys.filter((k) => k.t < -VIDEO_TIME_EPSILON || k.t > clip.duration + VIDEO_TIME_EPSILON);
				if (outside.length)
					issues.push({
						code: 'keyframes-outside-clip',
						severity: 'warning',
						...at,
						message: `Clip "${clip.id}" has ${property} key${outside.length > 1 ? 's' : ''} at ${outside.map((k) => `${Math.round(k.t)} ms`).join(', ')}, outside the clip (0–${Math.round(clip.duration)} ms in clip time), so ${outside.length > 1 ? 'they never play' : 'it never plays'} directly; move ${outside.length > 1 ? 'them' : 'it'} inside or remove ${outside.length > 1 ? 'them' : 'it'} (set_video_keyframes).`
					});
			}
			if (clip.transition) {
				const d = clip.transition.duration;
				const before = videoClipBefore(track, clip);
				if (!before) {
					issues.push({ code: 'transition-without-cut', severity: 'warning', ...at, message: `Clip "${clip.id}" has a transition but no clip ends where it starts on track "${track.id}", so it plays as nothing; butt a clip up against it or remove the transition.` });
					continue;
				}
				if (d > clip.duration + VIDEO_TIME_EPSILON || d > before.duration + VIDEO_TIME_EPSILON) {
					issues.push({ code: 'transition-too-long', severity: 'error', ...at, message: `The ${d} ms transition into "${clip.id}" is longer than "${clip.id}" (${clip.duration} ms) or "${before.id}" (${before.duration} ms); make it at most ${Math.min(clip.duration, before.duration)} ms.` });
					continue;
				}
				// A dip cuts under its colour, so it plays no media past the cut.
				if (clip.transition.type === 'dip') continue;
				const outgoing = videoClipHandles(before, assets, sequences).after;
				const incoming = videoClipHandles(clip, assets, sequences).before;
				const half = d / 2;
				if (outgoing < half - VIDEO_TIME_EPSILON || incoming < half - VIDEO_TIME_EPSILON) {
					const fits = 2 * Math.min(outgoing, incoming);
					issues.push({
						code: 'transition-handles',
						severity: 'error',
						...at,
						message: `The ${d} ms transition into "${clip.id}" needs ${half} ms of media past the cut on both sides, but "${before.id}" has ${Math.floor(outgoing)} ms after its out point and "${clip.id}" ${Math.floor(incoming)} ms before its in point; make it at most ${Math.floor(fits)} ms, or trim the clips to leave handles.`
					});
				}
			}
		}
	};
	for (const track of project.tracks) checkTrack(track);
	for (const sequence of project.sequences ?? []) for (const track of sequence.tracks) checkTrack(track, sequence.id);
	for (const sequence of project.sequences ?? [])
		if (!usedSequences.has(sequence.id)) issues.push({ code: 'unused-sequence', severity: 'note', sequence: sequence.id, message: `Sequence "${sequence.id}" is not played by any compound clip.` });
	for (const asset of project.assets) if (!used.has(asset.id)) issues.push({ code: 'unused-asset', severity: 'note', asset: asset.id, message: `Asset "${asset.id}" is not used by any clip.` });
	const end = videoProjectDuration(project);
	for (const marker of project.markers ?? [])
		if (marker.time > end + VIDEO_TIME_EPSILON) issues.push({ code: 'marker-past-end', severity: 'note', marker: marker.id, message: `Marker "${marker.id}" at ${formatVideoSeconds(marker.time)} is past the end (${formatVideoSeconds(end)}).` });
	if (!project.tracks.some((t) => t.clips.length)) issues.push({ code: 'empty', severity: 'note', message: 'The project has no clips yet; add assets and then clips.' });
	const rank = { error: 0, warning: 1, note: 2 } as const;
	return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
