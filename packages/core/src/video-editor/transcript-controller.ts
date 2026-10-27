import type { VideoEditorController } from './controller.js';
import type { VideoEditResult } from './edit.js';
import type { VideoEditPlan } from './plan.js';
import {
	detectVideoDisfluencies,
	mergeVideoRanges,
	videoRemoveRangesEdits,
	videoTimelineTranscript,
	videoTranscriptTrack,
	videoWordAt,
	videoWordsRange,
	type VideoDisfluency,
	type VideoDisfluencyKind,
	type VideoDisfluencyOptions,
	type VideoTimelineWord
} from './transcript.js';
import type { VideoProject } from './types.js';

/** A snapshot of a transcript editor. The same object is returned until something changes. */
export interface TranscriptVideoState {
	/** The track whose words are shown, or `null` when nothing is transcribed. */
	track: string | null;
	/** The words the timeline plays on that track, in order. */
	words: readonly VideoTimelineWord[];
	/** The words joined with single spaces: what `textOffset` and `timeAtOffset` count in. */
	text: string;
	/** Index of the word under the playhead, or -1. */
	current: number;
	/** Selected words, first and last index (inclusive), or `null`. */
	selection: readonly [number, number] | null;
	/** Fillers, pauses and stutters found in the words (see `detectVideoDisfluencies`). */
	disfluencies: readonly VideoDisfluency[];
	/** For each word index, the kinds of disfluency it is part of (absent when none). */
	flags: Readonly<Record<number, readonly VideoDisfluencyKind[]>>;
	/** Whether text edits may change the timeline (false while the project is read-only). */
	editable: boolean;
	/** Why the last action was refused, if it was. */
	error: string | null;
}

export interface TranscriptVideoOptions {
	/** Track whose words to follow (default: the first audio track with a transcribed clip, else the first video track with one). */
	track?: string;
	/** How disfluencies are found (see `detectVideoDisfluencies`). */
	disfluencies?: VideoDisfluencyOptions;
	/**
	 * Deleting words proposes a plan for review instead of cutting at once (default false). Cleanup
	 * (`planCleanup`) always proposes one.
	 */
	planFirst?: boolean;
}

/** What deleting or cleaning up did: the cut it applied, or the plan it proposed. */
export type TranscriptVideoResult = { ok: true; applied: VideoEditResult & { ok: true }; plan?: undefined } | { ok: true; plan: VideoEditPlan; applied?: undefined } | { ok: false; error: string };

/**
 * Edit video by its words: a transcript view model over a `VideoEditorController`. It keeps the
 * words the timeline plays (from the media's transcripts), the word under the playhead, a word
 * selection and the disfluencies found, and turns text actions into timeline edits both ways:
 * clicking a word seeks there, playing highlights the word, deleting words cuts that stretch out on
 * every sync-locked track, and cleanup proposes one plan for every filler, pause and stutter. Each
 * cut is one undo step. Framework bindings render it; agents use the same functions through tools.
 */
export class TranscriptVideoController {
	private readonly listeners = new Set<(state: TranscriptVideoState) => void>();
	private unsubscribe: (() => void) | null = null;
	private track: string | undefined;
	private selection: [number, number] | null = null;
	private error: string | null = null;
	private state: TranscriptVideoState;
	/** Words and disfluencies are worked out once per project. */
	private cache: { project: VideoProject; track: string | undefined; words: VideoTimelineWord[]; trackId: string | null; text: string; disfluencies: VideoDisfluency[]; flags: Record<number, VideoDisfluencyKind[]> } | null = null;

	constructor(
		readonly controller: VideoEditorController,
		private readonly options: TranscriptVideoOptions = {}
	) {
		this.track = options.track;
		this.state = this.compute();
		this.connect();
	}

	getState = (): TranscriptVideoState => this.state;

	private connect() {
		if (this.unsubscribe) return;
		this.unsubscribe = this.controller.subscribe(() => this.refresh());
		this.refresh();
	}

	/** Listens for changes. Subscribing after `destroy` follows the editor again (React StrictMode remounts). */
	subscribe = (listener: (state: TranscriptVideoState) => void): (() => void) => {
		this.connect();
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** Stops following the editor. */
	destroy(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.listeners.clear();
	}

	private words(project: VideoProject) {
		const c = this.cache;
		if (c && c.project === project && c.track === this.track) return c;
		let words: VideoTimelineWord[] = [];
		let trackId: string | null = null;
		try {
			trackId = videoTranscriptTrack(project, this.track);
			words = videoTimelineTranscript(project, { track: this.track });
		} catch {
			// A track that no longer exists shows nothing.
		}
		const disfluencies = detectVideoDisfluencies(words, { ...this.options.disfluencies, pauses: { fps: project.fps, ...this.options.disfluencies?.pauses } });
		const flags: Record<number, VideoDisfluencyKind[]> = {};
		for (const d of disfluencies)
			for (let i = d.words[0]; i <= d.words[1]; i++) {
				// A pause is marked on the word before it.
				if (d.kind === 'pause' && i !== d.words[0]) continue;
				const f = (flags[i] ??= []);
				if (!f.includes(d.kind)) f.push(d.kind);
			}
		this.cache = { project, track: this.track, words, trackId, text: words.map((w) => w.word).join(' '), disfluencies, flags };
		return this.cache;
	}

	private compute(): TranscriptVideoState {
		const editor = this.controller.getState();
		const c = this.words(editor.project);
		if (this.selection && (this.selection[0] >= c.words.length || this.selection[1] >= c.words.length)) this.selection = null;
		return { track: c.trackId, words: c.words, text: c.text, current: videoWordAt(c.words, editor.time), selection: this.selection, disfluencies: c.disfluencies, flags: c.flags, editable: !editor.readOnly, error: this.error };
	}

	private refresh() {
		const next = this.compute();
		const prev = this.state;
		if (next.words === prev.words && next.current === prev.current && next.selection === prev.selection && next.editable === prev.editable && next.error === prev.error && next.disfluencies === prev.disfluencies) return;
		this.state = next;
		this.listeners.forEach((l) => l(next));
	}

	/** Follows another track's words (`undefined`: the default track). */
	setTrack(track: string | undefined): void {
		this.track = track;
		this.selection = null;
		this.refresh();
	}

	/** Moves the playhead to the start of a word. */
	seekToWord(index: number): void {
		const w = this.state.words[index];
		if (w) this.controller.seek(w.start);
	}

	/** Selects words `a` to `b` (either order), or clears the selection with `null`. */
	select(a: number | null, b: number | null = a): void {
		const n = this.state.words.length;
		this.selection = a === null || b === null || a < 0 || b < 0 || a >= n || b >= n ? null : a <= b ? [a, b] : [b, a];
		this.error = null;
		this.refresh();
	}

	/** Index of the word playing at a timeline time, or -1. */
	wordAt(time: number): number {
		return videoWordAt(this.state.words, time);
	}

	/** Where word `index` begins in `text` (characters). */
	textOffset(index: number): number {
		let offset = 0;
		for (let i = 0; i < Math.min(index, this.state.words.length); i++) offset += this.state.words[i].word.length + 1;
		return offset;
	}

	/** The word a caret at `offset` characters into `text` is in (or just after), as an index; -1 when there are no words. */
	wordAtOffset(offset: number): number {
		const { words } = this.state;
		let at = 0;
		for (let i = 0; i < words.length; i++) {
			at += words[i].word.length;
			if (offset <= at) return i;
			at += 1;
		}
		return words.length - 1;
	}

	/** The timeline time a caret at `offset` characters into `text` stands for: the start of its word. */
	timeAtOffset(offset: number): number | null {
		const i = this.wordAtOffset(offset);
		return i < 0 ? null : this.state.words[i].start;
	}

	private fail(message: string): { ok: false; error: string } {
		this.error = message;
		this.refresh();
		return { ok: false, error: message };
	}

	/** Cuts ranges out (or proposes a plan to, with `plan`), as one undo step. */
	private cut(ranges: { from: number; to: number; text?: string; reason?: string }[], title: string, plan: boolean): TranscriptVideoResult {
		if (!ranges.length) return this.fail('There is nothing to cut.');
		const merged = mergeVideoRanges(ranges);
		const edits = videoRemoveRangesEdits(merged);
		if (plan) {
			const r = this.controller.proposePlan({ title, edits, ranges, source: 'transcript' });
			if (!r.ok) return this.fail(r.error);
			this.error = null;
			this.select(null);
			return { ok: true, plan: r.plan };
		}
		const r = this.controller.apply(edits, title);
		if (!r.ok) return this.fail(r.error);
		this.error = null;
		this.select(null);
		return { ok: true, applied: r };
	}

	/** Deletes the selected words, cutting their stretch out of the timeline (or proposing it with `planFirst`). */
	deleteSelection(options: { plan?: boolean } = {}): TranscriptVideoResult {
		const sel = this.state.selection;
		if (!sel) return this.fail('Select the words to delete first.');
		const { words } = this.state;
		const range = videoWordsRange(words, sel[0], sel[1]);
		const text = words.slice(sel[0], sel[1] + 1).map((w) => w.word).join(' ');
		return this.cut([{ ...range, text, reason: 'deleted' }], sel[0] === sel[1] ? `Delete "${text}"` : `Delete ${sel[1] - sel[0] + 1} words`, options.plan ?? this.options.planFirst ?? false);
	}

	/** Cuts one disfluency out at once (its index in `disfluencies`), as one undo step. */
	removeDisfluency(index: number): TranscriptVideoResult {
		const d = this.state.disfluencies[index];
		if (!d) return this.fail(`There is no disfluency ${index}; there are ${this.state.disfluencies.length}.`);
		return this.cut([{ from: d.from, to: d.to, text: d.text, reason: d.kind }], d.kind === 'pause' ? 'Tighten pause' : `Remove "${d.text}"`, false);
	}

	/** Proposes one plan that cuts every disfluency of the given kinds (default all), for review. */
	planCleanup(kinds?: readonly VideoDisfluencyKind[]): TranscriptVideoResult {
		const found = this.state.disfluencies.filter((d) => !kinds || kinds.includes(d.kind));
		if (!found.length) return this.fail(kinds ? `No ${kinds.join(', ')} found.` : 'No fillers, long pauses or repetitions found.');
		const counts = (['filler', 'pause', 'repetition'] as const).map((k) => [k, found.filter((d) => d.kind === k).length] as const).filter(([, n]) => n);
		const title = `Clean up ${counts.map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`).join(', ')}`;
		return this.cut(
			found.map((d) => ({ from: d.from, to: d.to, text: d.text, reason: d.kind })),
			title,
			true
		);
	}
}
