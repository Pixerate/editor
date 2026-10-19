import type { VideoEdit } from './edit.js';
import { snapToVideoFrame, sortedVideoClips, videoAssetMap, videoClipEnd, videoClipSpeed, VIDEO_TIME_EPSILON } from './timeline.js';
import type { VideoProject, VideoTranscriptWord } from './types.js';

/**
 * Text-based editing: an asset's transcript is a list of words timed in its source, so it stays
 * right however the clips that use it are cut. `videoTimelineTranscript` maps the words through the
 * clips onto the timeline; searches, fillers and pauses come back as timeline ranges that
 * `videoRemoveRangesEdits` cuts out in one step.
 */

// ---------------------------------------------------------------------------------------------
// Reading transcripts
// ---------------------------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `HH:MM:SS,mmm`, `HH:MM:SS.mmm` or `MM:SS.mmm` as ms. */
function cueTime(s: string): number {
	const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
	if (!m) throw new Error(`"${s.trim()}" is not a cue time (HH:MM:SS,mmm).`);
	return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, '0'));
}

/** Words of a cue spread evenly across its time (cues have no word timings). */
function cueWords(text: string, start: number, end: number): VideoTranscriptWord[] {
	const words = text
		.replace(/<[^>]+>/g, '')
		.split(/\s+/)
		.filter(Boolean);
	const step = (end - start) / Math.max(1, words.length);
	return words.map((word, i) => ({ word, start: Math.round(start + i * step), end: Math.round(start + (i + 1) * step) }));
}

/**
 * A transcript from text a speech-to-text service or captioning tool wrote: Whisper-style JSON
 * (`{ segments: [{ words: [{ word, start, end }] }] }` or `{ words: [...] }`, times in seconds, or a
 * plain `[{ word, start, end }]` array in ms), SubRip (`.srt`) or WebVTT. Captions have no word
 * timings, so their words are spread evenly across each cue (`approximate: true`). Throws when it
 * finds no words.
 */
export function parseVideoTranscript(input: string | unknown): { words: VideoTranscriptWord[]; approximate: boolean } {
	let data: unknown = input;
	if (typeof input === 'string') {
		const text = input.replace(/^﻿/, '').trim();
		if (text.startsWith('{') || text.startsWith('[')) {
			try {
				data = JSON.parse(text);
			} catch {
				throw new Error('The transcript looks like JSON but is not valid JSON.');
			}
		} else {
			// SubRip or WebVTT: blocks of an optional id, a "start --> end" line and text lines.
			const words: VideoTranscriptWord[] = [];
			for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
				const lines = block.split('\n');
				const at = lines.findIndex((l) => l.includes('-->'));
				if (at < 0) continue;
				const [a, b] = lines[at].split('-->');
				words.push(...cueWords(lines.slice(at + 1).join(' '), cueTime(a), cueTime(b.trim().split(/\s+/)[0])));
			}
			if (!words.length) throw new Error('No words found: expected Whisper-style JSON with word timings, SubRip (.srt) or WebVTT.');
			return { words, approximate: true };
		}
	}
	const seconds = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) : NaN);
	const fromList = (list: unknown[], toMs: (v: unknown) => number) =>
		list.map((w, i) => {
			if (!isRecord(w)) throw new Error(`Word ${i + 1} is not an object { word, start, end }.`);
			const word = String(w.word ?? w.text ?? '').trim();
			const start = toMs(w.start);
			const end = toMs(w.end);
			if (!word || !Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`Word ${i + 1} needs a word and numeric start and end.`);
			return { word, start, end: Math.max(start, end) };
		});
	let words: VideoTranscriptWord[] = [];
	if (Array.isArray(data)) words = fromList(data, (v) => (typeof v === 'number' ? v : NaN));
	else if (isRecord(data) && Array.isArray(data.words)) words = fromList(data.words, seconds);
	else if (isRecord(data) && Array.isArray(data.segments)) {
		const segments = data.segments.filter(isRecord);
		if (segments.some((s) => Array.isArray(s.words))) words = fromList(segments.flatMap((s) => (Array.isArray(s.words) ? s.words : [])), seconds);
		else {
			for (const s of segments) words.push(...cueWords(String(s.text ?? ''), seconds(s.start), seconds(s.end)));
			if (!words.length) throw new Error('No words found in the segments.');
			return { words, approximate: true };
		}
	}
	if (!words.length) throw new Error('No words found: expected Whisper-style JSON with word timings, SubRip (.srt) or WebVTT.');
	return { words: words.sort((a, b) => a.start - b.start), approximate: false };
}

// ---------------------------------------------------------------------------------------------
// Words on the timeline
// ---------------------------------------------------------------------------------------------

/** A word where it plays on the timeline. */
export interface VideoTimelineWord {
	word: string;
	/** Timeline times (ms). */
	start: number;
	end: number;
	/** The clip that plays it. */
	clip: string;
	track: string;
	/** Its index in the asset's transcript. */
	index: number;
}

/**
 * The track whose words make the timeline transcript: `track` if given, else the first audio track
 * with a transcribed clip, else the first video track with one. `null` when nothing is transcribed.
 */
export function videoTranscriptTrack(project: VideoProject, track?: string): string | null {
	if (track !== undefined) {
		if (!project.tracks.some((t) => t.id === track)) throw new Error(`There is no track "${track}"; the tracks are ${project.tracks.map((t) => `"${t.id}"`).join(', ')}.`);
		return track;
	}
	const assets = videoAssetMap(project);
	const transcribed = (t: VideoProject['tracks'][number]) => t.clips.some((c) => c.type === 'media' && assets.get(c.asset)?.transcript?.length);
	return (project.tracks.find((t) => t.kind === 'audio' && transcribed(t)) ?? project.tracks.find(transcribed))?.id ?? null;
}

/**
 * The words the timeline plays on one track, in order: each transcribed media clip's words whose
 * middle falls inside the stretch of source it plays, moved to timeline time through its in point
 * and speed and clamped to the clip.
 */
export function videoTimelineTranscript(project: VideoProject, options: { track?: string } = {}): VideoTimelineWord[] {
	const id = videoTranscriptTrack(project, options.track);
	if (!id) return [];
	const track = project.tracks.find((t) => t.id === id)!;
	const assets = videoAssetMap(project);
	const out: VideoTimelineWord[] = [];
	for (const clip of sortedVideoClips(track)) {
		if (clip.type !== 'media') continue;
		const words = assets.get(clip.asset)?.transcript;
		if (!words?.length) continue;
		const speed = videoClipSpeed(clip);
		const from = clip.in ?? 0;
		const to = from + clip.duration * speed;
		const toTimeline = (s: number) => Math.min(videoClipEnd(clip), Math.max(clip.start, clip.start + (s - from) / speed));
		words.forEach((w, index) => {
			const mid = (w.start + w.end) / 2;
			if (mid < from || mid >= to) return;
			out.push({ word: w.word, start: toTimeline(w.start), end: toTimeline(w.end), clip: clip.id, track: track.id, index });
		});
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Finding things to cut
// ---------------------------------------------------------------------------------------------

/** A stretch of the timeline (ms) and the words in it. */
export interface VideoTranscriptRange {
	from: number;
	to: number;
	text: string;
}

/** A word as compared: lower case, without surrounding punctuation. */
export const normalizeVideoWord = (word: string): string => word.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');

const rangeOf = (words: readonly VideoTimelineWord[], i: number, n: number): VideoTranscriptRange => ({ from: words[i].start, to: words[i + n - 1].end, text: words.slice(i, i + n).map((w) => w.word).join(' ') });

/** Every place a phrase is said (case and punctuation ignored), as timeline ranges. */
export function findVideoTranscriptText(words: readonly VideoTimelineWord[], query: string): VideoTranscriptRange[] {
	const q = query.split(/\s+/).map(normalizeVideoWord).filter(Boolean);
	if (!q.length) throw new Error('Search for at least one word.');
	const norm = words.map((w) => normalizeVideoWord(w.word));
	const out: VideoTranscriptRange[] = [];
	for (let i = 0; i + q.length <= norm.length; i++) if (q.every((x, k) => norm[i + k] === x)) out.push(rangeOf(words, i, q.length));
	return out;
}

/** Filler words and phrases removed by default. "like" and "so" are left out: too often meant. */
export const VIDEO_DEFAULT_FILLERS = ['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'hmm', 'mm', 'you know', 'i mean'] as const;

/** Fillers in the transcript, longest phrase first ("you know" before "you"), as timeline ranges. */
export function findVideoFillers(words: readonly VideoTimelineWord[], fillers: readonly string[] = VIDEO_DEFAULT_FILLERS): VideoTranscriptRange[] {
	const phrases = fillers
		.map((f) => f.split(/\s+/).map(normalizeVideoWord).filter(Boolean))
		.filter((p) => p.length)
		.sort((a, b) => b.length - a.length);
	const norm = words.map((w) => normalizeVideoWord(w.word));
	const out: VideoTranscriptRange[] = [];
	for (let i = 0; i < norm.length; ) {
		const hit = phrases.find((p) => i + p.length <= norm.length && p.every((x, k) => norm[i + k] === x));
		if (hit) {
			out.push(rangeOf(words, i, hit.length));
			i += hit.length;
		} else i++;
	}
	return out;
}

export interface VideoPauseOptions {
	/** Shortest gap between words that counts as a pause (ms, default 700). */
	min?: number;
	/** Silence to keep next to each word so speech does not sound clipped (ms, default 150). */
	keep?: number;
	/** Frame rate to snap the cut inward to (default: none). */
	fps?: number;
}

/** Gaps between consecutive words on the same clip longer than `min`, less `keep` either side, as timeline ranges. */
export function findVideoTranscriptPauses(words: readonly VideoTimelineWord[], options: VideoPauseOptions = {}): VideoTranscriptRange[] {
	const min = options.min ?? 700;
	const keep = options.keep ?? 150;
	const out: VideoTranscriptRange[] = [];
	for (let i = 1; i < words.length; i++) {
		const a = words[i - 1];
		const b = words[i];
		if (a.clip !== b.clip || b.start - a.end < min) continue;
		let from = a.end + keep;
		let to = b.start - keep;
		if (options.fps) {
			// Snap inward, so the cut never eats into the kept silence.
			const f = 1000 / options.fps;
			from = snapToVideoFrame(Math.ceil(from / f - 1e-9) * f, options.fps);
			to = snapToVideoFrame(Math.floor(to / f + 1e-9) * f, options.fps);
		}
		if (to - from > VIDEO_TIME_EPSILON) out.push({ from, to, text: `(pause after "${a.word}")` });
	}
	return out;
}

/** Ranges sorted and merged where they touch or overlap. */
export function mergeVideoRanges(ranges: readonly { from: number; to: number }[]): { from: number; to: number }[] {
	const sorted = ranges.filter((r) => r.to - r.from > VIDEO_TIME_EPSILON).map((r) => ({ from: r.from, to: r.to })).sort((a, b) => a.from - b.from);
	const out: { from: number; to: number }[] = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (last && r.from <= last.to + VIDEO_TIME_EPSILON) last.to = Math.max(last.to, r.to);
		else out.push(r);
	}
	return out;
}

/**
 * The edits that cut ranges out of the timeline and close them up: one `extract_range` per merged
 * range, last first, so earlier ranges keep their times. Apply them together as one undo step.
 */
export function videoRemoveRangesEdits(ranges: readonly { from: number; to: number }[], tracks?: string[]): VideoEdit[] {
	return mergeVideoRanges(ranges)
		.reverse()
		.map((r) => ({ op: 'extract_range' as const, from: r.from, to: r.to, ...(tracks ? { tracks } : {}) }));
}

/** The timeline stretch from word `a` to word `b` (either order), for deleting a selection of words. */
export function videoWordsRange(words: readonly VideoTimelineWord[], a: number, b: number): { from: number; to: number } {
	const [i, j] = a <= b ? [a, b] : [b, a];
	return { from: words[i].start, to: words[j].end };
}

/** The edit that attaches a transcript file's text to an asset (see `parseVideoTranscript`). Throws a readable error for text it cannot read. */
export function videoTranscriptEdit(assetId: string, text: string): VideoEdit {
	return { op: 'update_asset', asset: assetId, set: { transcript: parseVideoTranscript(text).words } };
}

/** The word playing at a timeline time, as its index in `words`, or -1. */
export function videoWordAt(words: readonly VideoTimelineWord[], time: number): number {
	let lo = 0;
	let hi = words.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (words[mid].end <= time) lo = mid + 1;
		else if (words[mid].start > time) hi = mid - 1;
		else return mid;
	}
	return -1;
}
