import type { Clock } from '../animation/clock.js';
import type { AnimationLoopMode } from '../animation/evaluate.js';
import { AnimationPlayer } from '../animation/player.js';
import { HistoryManager } from '../history/HistoryManager.js';
import type { Command } from '../history/types.js';
import { VideoAudioPeaksCache, type VideoAudioPeaksLoader } from './audio.js';
import { checkVideoProject, type VideoIssue } from './check.js';
import { applyVideoEdits, type VideoEdit, type VideoEditResult } from './edit.js';
import { videoFrameAt, type VideoFrame } from './evaluate.js';
import { toVideoEdl, toVideoFfmpeg, toVideoLoudnessMeasure, type VideoEdlOptions, type VideoFfmpegExport, type VideoFfmpegOptions } from './export.js';
import { createVideoProject, parseVideoProject } from './parse.js';
import { videoProjectSvg, type VideoSvgOptions } from './render.js';
import { snapToVideoFrame, snapVideoTime, videoClipEnd, videoClipsAt, videoProjectDuration, videoSnapPoints, findVideoClip } from './timeline.js';
import type { VideoProject } from './types.js';

export interface VideoEditorOptions {
	/** The project to open (default: an empty 1920 × 1080, 30 fps project with tracks v1 and a1). */
	project?: VideoProject;
	/** Shared undo history (default: a new one). */
	history?: HistoryManager;
	/** Time source for playback (default: requestAnimationFrame). Pass a `ManualClock` to step frames. */
	clock?: Clock;
	readOnly?: boolean;
	/** Called after every change to the project (not on playback or selection). */
	onChange?: (project: VideoProject) => void;
	/**
	 * Where sound levels for waveforms and `get_video_audio_levels` come from: a shared cache, or a
	 * loader for one (default: fetch and decode each asset's `src` with Web Audio, in a browser).
	 */
	audioPeaks?: VideoAudioPeaksCache | VideoAudioPeaksLoader;
}

/** A snapshot of the editor. The same object is returned until something changes. */
export interface VideoEditorState {
	project: VideoProject;
	/** Total length (ms): the end of the last clip. */
	duration: number;
	/** Playhead (ms). */
	time: number;
	playing: boolean;
	loop: AnimationLoopMode;
	/** Selected clip ids, in the order they were selected. */
	selection: readonly string[];
	/** Clips under the playhead, top track first. */
	current: readonly string[];
	/** The project's problems (see `checkVideoProject`). */
	issues: readonly VideoIssue[];
	readOnly: boolean;
	/** Why the last edit was refused, if it was. */
	error: string | null;
	canUndo: boolean;
	canRedo: boolean;
	undoLabel: string;
	redoLabel: string;
	/** Bumped on every change. */
	revision: number;
}

/**
 * Headless non-linear video editor: a `VideoProject` of assets and tracks of clips, edited with
 * undoable, all-or-nothing edits (insert, ripple, trim, split, move, transitions), played on an
 * injectable clock, with a clip selection, snapping and frames at any time. UI-agnostic: React and
 * Svelte bind it with `useVideoEditor` / `createVideoEditor`, `VideoPreviewEngine` plays it in a
 * browser and agents drive it through `createVideoEditorToolProvider`. `getState()` returns the same
 * object until something changes, so it works with `useSyncExternalStore` and Svelte runes.
 */
export class VideoEditorController {
	readonly history: HistoryManager;
	readonly player: AnimationPlayer;
	/** Sound levels per asset, loaded on demand for waveforms and agents. */
	readonly audioPeaks: VideoAudioPeaksCache;
	private project: VideoProject;
	private issues: VideoIssue[];
	private selection: string[] = [];
	private readOnly: boolean;
	private error: string | null = null;
	private revision = 0;
	private applying = false;
	private readonly onChange?: (project: VideoProject) => void;
	private readonly listeners = new Set<(state: VideoEditorState) => void>();
	private readonly unsubscribers: (() => void)[] = [];
	private state!: VideoEditorState;

	constructor(options: VideoEditorOptions = {}) {
		this.history = options.history ?? new HistoryManager();
		this.audioPeaks = options.audioPeaks instanceof VideoAudioPeaksCache ? options.audioPeaks : new VideoAudioPeaksCache(options.audioPeaks);
		this.project = options.project ? parseVideoProject(options.project) : createVideoProject();
		this.issues = checkVideoProject(this.project);
		this.readOnly = options.readOnly ?? false;
		this.onChange = options.onChange;
		this.player = new AnimationPlayer({ clock: options.clock, duration: () => videoProjectDuration(this.project), loop: 'none' });
		this.state = this.computeState();
		this.connect();
	}

	private connect() {
		if (this.unsubscribers.length) return;
		this.unsubscribers.push(
			this.player.subscribe(() => this.notify()),
			this.history.subscribe(() => {
				if (!this.applying) this.notify();
			})
		);
	}

	/** Pauses and stops listening to the player and history. Subscribing again reconnects (React StrictMode). */
	destroy(): void {
		this.player.pause();
		this.unsubscribers.splice(0).forEach((u) => u());
	}

	getState = (): VideoEditorState => this.state;

	subscribe = (listener: (state: VideoEditorState) => void): (() => void) => {
		this.connect();
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** The current project (immutable; edit through the controller). */
	getProject(): VideoProject {
		return this.project;
	}

	private computeState(): VideoEditorState {
		const p = this.player.getState();
		const h = this.history.getState();
		return {
			project: this.project,
			duration: videoProjectDuration(this.project),
			time: p.time,
			playing: p.playing,
			loop: p.loop,
			selection: this.selection,
			current: videoClipsAt(this.project, p.time).map((c) => c.clip.id),
			issues: this.issues,
			readOnly: this.readOnly,
			error: this.error,
			canUndo: h.canUndo,
			canRedo: h.canRedo,
			undoLabel: h.undoName,
			redoLabel: h.redoName,
			revision: this.revision
		};
	}

	private notify() {
		this.revision++;
		this.state = this.computeState();
		const state = this.state;
		this.listeners.forEach((listener) => {
			try {
				listener(state);
			} catch (error) {
				console.error('[VideoEditorController] Error in state listener:', error);
			}
		});
	}

	private setProject(project: VideoProject) {
		this.applying = true;
		try {
			this.project = project;
			this.issues = checkVideoProject(project);
			const ids = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
			if (this.selection.some((id) => !ids.has(id))) this.selection = this.selection.filter((id) => ids.has(id));
			this.player.setDuration(() => videoProjectDuration(this.project));
		} finally {
			this.applying = false;
		}
		this.notify();
		this.onChange?.(project);
	}

	private commit(label: string, next: VideoProject) {
		const before = this.project;
		this.error = null;
		if (next === before) {
			this.notify();
			return;
		}
		const command: Command = {
			name: label,
			tag: 'video-editor',
			execute: () => this.setProject(next),
			undo: () => this.setProject(before),
			redo: () => this.setProject(next)
		};
		this.history.execute(command);
	}

	private refuse(message: string): VideoEditResult {
		this.error = message;
		this.notify();
		return { ok: false, error: message };
	}

	/** Why edits are refused now, or `null` when they are allowed. */
	readOnlyReason(): string | null {
		return this.readOnly ? 'The video project is read-only.' : null;
	}

	/**
	 * Applies edits as one undo step, all or nothing (see `applyVideoEdits`). With `dryRun` it
	 * reports what would happen and changes nothing.
	 */
	apply(edits: VideoEdit | readonly VideoEdit[], label = 'Edit video', options: { dryRun?: boolean } = {}): VideoEditResult {
		const reason = this.readOnlyReason();
		if (reason) return this.refuse(reason);
		const result = applyVideoEdits(this.project, edits);
		if (!result.ok) return options.dryRun ? result : this.refuse(result.error);
		if (!options.dryRun) this.commit(label, result.project);
		return result;
	}

	/** Opens a project (JSON or object). `clearHistory` drops the undo stack (opening a file); otherwise it is one undo step. */
	load(project: VideoProject | string, options: { clearHistory?: boolean } = {}): VideoEditResult {
		let parsed: VideoProject;
		try {
			parsed = parseVideoProject(project);
		} catch (error) {
			return this.refuse((error as Error).message);
		}
		if (options.clearHistory) {
			this.history.clear();
			this.error = null;
			this.selection = [];
			this.setProject(parsed);
			this.player.seek(0);
			return { ok: true, project: parsed, issues: this.issues, outcomes: [{ op: 'replace_project' }] };
		}
		return this.apply({ op: 'replace_project', project: parsed }, 'Replace project');
	}

	setReadOnly(readOnly: boolean): void {
		if (this.readOnly === readOnly) return;
		this.readOnly = readOnly;
		this.notify();
	}

	/** Selects clips (unknown ids are dropped). `add` toggles them into the current selection. */
	select(clips: readonly string[] | null, options: { add?: boolean } = {}): void {
		const known = clips?.filter((id) => findVideoClip(this.project, id)) ?? [];
		let next: string[];
		if (options.add) {
			next = [...this.selection];
			for (const id of known) next = next.includes(id) ? next.filter((x) => x !== id) : [...next, id];
		} else next = [...new Set(known)];
		if (next.length === this.selection.length && next.every((id, i) => id === this.selection[i])) return;
		this.selection = next;
		this.notify();
	}

	play(): void {
		this.player.play();
	}

	pause(): void {
		this.player.pause();
	}

	toggle(): void {
		this.player.toggle();
	}

	/** Moves the playhead (ms). */
	seek(time: number): void {
		this.player.seek(time);
	}

	/** Moves the playhead by whole frames (negative steps back), pausing. */
	step(frames: number): void {
		this.player.pause();
		const fps = this.project.fps;
		this.player.seek(Math.max(0, snapToVideoFrame(this.player.currentTime, fps) + (frames * 1000) / fps));
	}

	setLoop(loop: AnimationLoopMode): void {
		this.player.setLoop(loop);
	}

	undo(): boolean {
		return this.history.undo();
	}

	redo(): boolean {
		return this.history.redo();
	}

	/**
	 * `time` moved to the nearest clip edge, marker or the playhead within `threshold` ms (default:
	 * 8 frames), else to the nearest frame. Clips in `exclude` (the ones being dragged) are ignored.
	 */
	snap(time: number, options: { exclude?: Iterable<string>; threshold?: number; playhead?: boolean } = {}): { time: number; snapped: number | null } {
		const threshold = options.threshold ?? (8 * 1000) / this.project.fps;
		const points = videoSnapPoints(this.project, { exclude: options.exclude, playhead: options.playhead === false ? undefined : this.player.currentTime });
		const hit = snapVideoTime(time, points, threshold);
		return hit.snapped !== null ? hit : { time: Math.max(0, snapToVideoFrame(time, this.project.fps)), snapped: null };
	}

	/** Splits the selected clips (or every clip) under the playhead there, as one undo step. */
	splitAtPlayhead(): VideoEditResult {
		const t = snapToVideoFrame(this.player.currentTime, this.project.fps);
		const under = videoClipsAt(this.project, t).filter(({ clip }) => t > clip.start && t < videoClipEnd(clip));
		const chosen = this.selection.length ? under.filter(({ clip }) => this.selection.includes(clip.id)) : under;
		if (!chosen.length) return this.refuse('No clip is under the playhead to split.');
		return this.apply(chosen.map(({ clip }) => ({ op: 'split_clip' as const, clip: clip.id, at: t })), 'Split');
	}

	/** Deletes the selected clips; `ripple` closes the gaps they leave. */
	deleteSelection(options: { ripple?: boolean } = {}): VideoEditResult {
		if (!this.selection.length) return this.refuse('Select clips to delete first.');
		return this.apply({ op: 'delete_clips', clips: [...this.selection], ripple: options.ripple }, options.ripple ? 'Ripple delete' : 'Delete clips');
	}

	/** What plays at `time` (default: the playhead). */
	frame(time = this.player.currentTime): VideoFrame {
		return videoFrameAt(this.project, time);
	}

	/** The frame at `time` (default: the playhead) as SVG. */
	toSvg(time = this.player.currentTime, options: VideoSvgOptions = {}): string {
		return videoProjectSvg(this.project, time, options);
	}

	/** The project as an ffmpeg command. */
	toFfmpeg(options: VideoFfmpegOptions = {}): VideoFfmpegExport {
		return toVideoFfmpeg(this.project, options);
	}

	/** The ffmpeg command that measures the mix's loudness (see `toVideoLoudnessMeasure`). */
	toLoudnessMeasure(options: Pick<VideoFfmpegOptions, 'resolve' | 'loudness'> = {}): VideoFfmpegExport {
		return toVideoLoudnessMeasure(this.project, options);
	}

	/** One track as a CMX 3600 EDL. */
	toEdl(options: VideoEdlOptions = {}): string {
		return toVideoEdl(this.project, options);
	}
}
