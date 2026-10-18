import { motionStageSvg, type MotionOverlayOptions } from './onion.js';
import type { Clock } from '../animation/clock.js';
import type { AnimationLoopMode } from '../animation/evaluate.js';
import { AnimationPlayer } from '../animation/player.js';
import { HistoryManager } from '../history/HistoryManager.js';
import type { Command } from '../history/types.js';
import type { VectorDocument } from '../vector/types.js';
import { checkMotionScene } from './check.js';
import { compileMotionScene, motionShotAt, type MotionShotTiming } from './compile.js';
import { applyMotionEdits, createMotionScene, type MotionEdit, type MotionEditResult } from './edit.js';
import { motionFrameAt, motionFrameToSvg, type MotionFrame, type MotionFrameOptions, type MotionSvgOptions } from './evaluate.js';
import { toFlairEffectDocument, toFlairSvgMotion, toFlairVectorEffect, type FlairEffectOptions, type FlairExportOptions } from './flair.js';
import type { MotionIssue } from './issues.js';
import { parseMotionScene } from './parse.js';
import type { MotionScene } from './types.js';

export interface AnimationEditorOptions {
	/** The scene to open (default: an empty one over a blank 800 × 450 artwork). */
	scene?: MotionScene;
	/** Shared undo history (default: a new one). */
	history?: HistoryManager;
	/** Time source for playback (default: requestAnimationFrame). Pass a `ManualClock` to step frames. */
	clock?: Clock;
	readOnly?: boolean;
	/** Called after every change to the scene (not on playback or selection). */
	onChange?: (scene: MotionScene) => void;
}

/** What is selected on the timeline: a shot, and optionally one of its commands. */
export interface AnimationEditorSelection {
	shot: string;
	command?: number;
}

/** A snapshot of the editor. The same object is returned until something changes. */
export interface AnimationEditorState {
	scene: MotionScene;
	/** Total length (ms). */
	duration: number;
	/** Each shot's timing. */
	shots: readonly MotionShotTiming[];
	/** The scene's problems (see `checkMotionScene`). */
	issues: readonly MotionIssue[];
	/** Playhead (ms). */
	time: number;
	playing: boolean;
	loop: AnimationLoopMode;
	/** Id of the shot under the playhead. */
	currentShot: string | null;
	selection: AnimationEditorSelection | null;
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

const BLANK: VectorDocument = { width: 800, height: 450, background: '#ffffff', nodes: [] };

/**
 * Headless editor for a vector animation (a `MotionScene`): undoable, all-or-nothing edits,
 * playback on an injectable clock, a timeline selection and frames at any time. UI-agnostic:
 * React and Svelte bind it with `useAnimationEditor` / `createAnimationEditor`, and agents
 * drive it through `createAnimationEditorToolProvider`. `getState()` returns the same object
 * until something changes, so it works with `useSyncExternalStore` and Svelte runes.
 */
export class AnimationEditorController {
	readonly history: HistoryManager;
	readonly player: AnimationPlayer;
	private scene: MotionScene;
	private issues: MotionIssue[];
	private selection: AnimationEditorSelection | null = null;
	private readOnly: boolean;
	private error: string | null = null;
	private revision = 0;
	private applying = false;
	private readonly onChange?: (scene: MotionScene) => void;
	private readonly listeners = new Set<(state: AnimationEditorState) => void>();
	private readonly unsubscribers: (() => void)[] = [];
	private state!: AnimationEditorState;

	constructor(options: AnimationEditorOptions = {}) {
		this.history = options.history ?? new HistoryManager();
		this.scene = options.scene ? parseMotionScene(options.scene) : createMotionScene(BLANK);
		this.issues = checkMotionScene(this.scene);
		this.readOnly = options.readOnly ?? false;
		this.onChange = options.onChange;
		this.player = new AnimationPlayer({ clock: options.clock, duration: () => compileMotionScene(this.scene).duration, loop: this.scene.loop ?? 'none' });
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

	/**
	 * Pauses and stops listening to the player and history. Subscribing again reconnects, so a
	 * controller survives React StrictMode's unmount / remount.
	 */
	destroy(): void {
		this.player.pause();
		this.unsubscribers.splice(0).forEach((u) => u());
	}

	getState = (): AnimationEditorState => this.state;

	subscribe = (listener: (state: AnimationEditorState) => void): (() => void) => {
		this.connect();
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** The current scene (immutable; edit through the controller). */
	getScene(): MotionScene {
		return this.scene;
	}

	private computeState(): AnimationEditorState {
		const timeline = compileMotionScene(this.scene);
		const p = this.player.getState();
		const h = this.history.getState();
		return {
			scene: this.scene,
			duration: timeline.duration,
			shots: timeline.shots,
			issues: this.issues,
			time: p.time,
			playing: p.playing,
			loop: p.loop,
			currentShot: motionShotAt(timeline, p.time)?.id ?? null,
			selection: this.selection,
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
				console.error('[AnimationEditorController] Error in state listener:', error);
			}
		});
	}

	private setScene(scene: MotionScene) {
		this.applying = true;
		try {
			this.scene = scene;
			this.issues = checkMotionScene(scene);
			if (this.selection) {
				const shot = scene.shots.find((s) => s.id === this.selection!.shot);
				if (!shot) this.selection = null;
				else if (this.selection.command !== undefined && this.selection.command >= shot.run.length) this.selection = { shot: shot.id };
			}
			this.player.setLoop(scene.loop ?? 'none');
			this.player.setDuration(() => compileMotionScene(this.scene).duration);
		} finally {
			this.applying = false;
		}
		this.notify();
		this.onChange?.(scene);
	}

	private commit(label: string, next: MotionScene) {
		const before = this.scene;
		this.error = null;
		if (next === before) {
			this.notify();
			return;
		}
		const command: Command = {
			name: label,
			tag: 'animation-editor',
			execute: () => this.setScene(next),
			undo: () => this.setScene(before),
			redo: () => this.setScene(next)
		};
		this.history.execute(command);
	}

	private refuse(message: string): MotionEditResult {
		this.error = message;
		this.notify();
		return { ok: false, error: message };
	}

	/** Why edits are refused now, or `null` when they are allowed. */
	readOnlyReason(): string | null {
		return this.readOnly ? 'The animation is read-only.' : null;
	}

	/**
	 * Applies edits as one undo step, all or nothing (see `applyMotionEdits`). With
	 * `dryRun` it reports what would happen and changes nothing.
	 */
	apply(edits: MotionEdit | readonly MotionEdit[], label = 'Edit animation', options: { dryRun?: boolean } = {}): MotionEditResult {
		const reason = this.readOnlyReason();
		if (reason) return this.refuse(reason);
		const result = applyMotionEdits(this.scene, edits);
		if (!result.ok) return options.dryRun ? result : this.refuse(result.error);
		if (!options.dryRun) this.commit(label, result.scene);
		return result;
	}

	/** Replaces the artwork (e.g. from a vector editor's `onChange`), as one undo step. */
	setArtwork(artwork: VectorDocument, label = 'Change artwork'): MotionEditResult {
		return this.apply({ op: 'set_artwork', artwork }, label);
	}

	/** Opens a scene (JSON or object). `clearHistory` drops the undo stack (opening a file); otherwise it is one undo step. */
	load(scene: MotionScene | string, options: { clearHistory?: boolean } = {}): MotionEditResult {
		let parsed: MotionScene;
		try {
			parsed = parseMotionScene(scene);
		} catch (error) {
			return this.refuse((error as Error).message);
		}
		if (options.clearHistory) {
			this.history.clear();
			this.error = null;
			this.selection = null;
			this.setScene(parsed);
			this.player.seek(0);
			return { ok: true, scene: parsed, issues: this.issues, hints: [] };
		}
		return this.apply({ op: 'replace_scene', scene: parsed }, 'Replace animation');
	}

	setReadOnly(readOnly: boolean): void {
		if (this.readOnly === readOnly) return;
		this.readOnly = readOnly;
		this.notify();
	}

	/** Selects a shot (and optionally a command in it); `null` clears. Unknown shots clear. */
	select(selection: AnimationEditorSelection | null): void {
		const shot = selection && this.scene.shots.find((s) => s.id === selection.shot);
		const next = shot ? { shot: shot.id, ...(selection!.command !== undefined && selection!.command < shot.run.length ? { command: selection!.command } : {}) } : null;
		if (JSON.stringify(next) === JSON.stringify(this.selection)) return;
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

	/** Moves the playhead to the start or end of a shot. Returns false for an unknown shot. */
	seekShot(id: string, at: 'start' | 'end' = 'start'): boolean {
		const shot = compileMotionScene(this.scene).shots.find((s) => s.id === id);
		if (!shot) return false;
		this.player.seek(at === 'start' ? shot.start : shot.end);
		return true;
	}

	undo(): boolean {
		return this.history.undo();
	}

	redo(): boolean {
		return this.history.redo();
	}

	/** The scene at `time` (default: the playhead). */
	frame(time = this.player.currentTime, options: MotionFrameOptions = {}): MotionFrame {
		return motionFrameAt(this.scene, time, options);
	}

	/** The scene at `time` (default: the playhead) as SVG. */
	toSvg(time = this.player.currentTime, options: MotionSvgOptions & MotionOverlayOptions = {}): string {
		return motionStageSvg(this.scene, time, options);
	}

	/** The scene as a Flair `SvgMotion`. */
	toFlairMotion(options: FlairExportOptions = {}) {
		return toFlairSvgMotion(this.scene, options);
	}

	/** The scene as a Flair catalog vector effect. */
	toFlairEffect(options: FlairEffectOptions = {}) {
		return toFlairVectorEffect(this.scene, options);
	}

	/** The scene as a Flair `EffectDocument`. */
	toFlairDocument(options: FlairExportOptions = {}) {
		return toFlairEffectDocument(this.scene, options);
	}
}
