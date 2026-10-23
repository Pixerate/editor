import { motionStageSvg, type MotionOverlayOptions } from './onion.js';
import type { Clock } from '../animation/clock.js';
import type { AnimationLoopMode } from '../animation/evaluate.js';
import { AnimationPlayer } from '../animation/player.js';
import { HistoryManager } from '../history/HistoryManager.js';
import type { Command } from '../history/types.js';
import type { VectorDocument } from '../vector/types.js';
import { checkMotionScene } from './check.js';
import { compileMotionScene, indexMotionNodes, motionShotAt, type MotionShotTiming } from './compile.js';
import { applyMotionEdits, createMotionScene, freshShotId, type MotionEdit, type MotionEditResult } from './edit.js';
import { motionFrameAt, motionFrameToSvg, type MotionFrame, type MotionFrameOptions, type MotionSvgOptions } from './evaluate.js';
import { toFlairEffectDocument, toFlairSvgMotion, toFlairVectorEffect, type FlairEffectOptions, type FlairExportOptions } from './flair.js';
import type { MotionIssue } from './issues.js';
import { parseMotionScene } from './parse.js';
import type { MotionEffectSource, MotionScene } from './types.js';
import { EffectsSlot, resolveEffectValues } from '../effects/helpers.js';
import { EffectUnsupportedError, isEffectError } from '../effects/errors.js';
import type { EffectDescription, EffectProvider, EffectValue } from '../effects/types.js';
import { motionClientToDocument, motionNodePose, motionTakeProblems, motionTakeShot, type MotionNodePose, type MotionTake, type MotionTakeOptions, type MotionTakeResult, type MotionTakeSample } from './record.js';
import { motionArtworkSvg, motionCommandsFromEffect, motionPartsFromVectorEffect, motionSceneEffects, nextMotionEffectInstance, withoutMotionEffect, type AppliedMotionEffect } from './effects.js';

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
	/**
	 * An effects provider (see `@pixerate/editor/effects`) for motion effects on nodes and vector
	 * effects with their own picture. Optional: without one the editor behaves as before, and
	 * scenes keep the commands effects made. Change it later with `setEffectsProvider`.
	 */
	effects?: EffectProvider | null;
}

/** What the effect edits return. */
export type MotionEffectResult = { ok: true; effect: AppliedMotionEffect; notes: string[] } | { ok: false; error: string };

/** What is selected on the timeline: a shot, and optionally one of its commands. */
export interface AnimationEditorSelection {
	shot: string;
	command?: number;
}

/** What a stage drag does to a node while recording: move it, scale it about its centre or turn it. */
export type MotionRecordGestureMode = 'move' | 'scale' | 'rotate';
export const MOTION_RECORD_GESTURE_MODES: readonly MotionRecordGestureMode[] = ['move', 'scale', 'rotate'];

/** A take being recorded (see `startRecording`). */
export interface AnimationEditorRecording {
	/** The id the take's shot will get. */
	shot: string;
	/** Where the shot will go among the shots. */
	at: number;
	/** When the take starts in the scene, ms. */
	start: number;
	/** How long it has run, ms. */
	elapsed: number;
	/** Samples recorded so far. */
	samples: number;
	/** The node a stage drag is changing now, and how. */
	gesture: { node: string; mode: MotionRecordGestureMode } | null;
}

/** What `stopRecording` and `recordTake` return. */
export type MotionRecordResult = ({ ok: true } & MotionTakeResult & { issues: readonly MotionIssue[] }) | { ok: false; error: string };

/** The longest take, ms. */
export const MOTION_MAX_TAKE_MS = 10 * 60_000;

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
	/** The registered effects provider, or `null`. */
	effectsProvider: EffectProvider | null;
	/** The take being recorded, or `null`. While recording, frames show the take so far. */
	recording: AnimationEditorRecording | null;
}

interface RecordingSession {
	options: MotionTakeOptions & { id: string; at: number };
	start: number;
	samples: MotionTakeSample[];
	gesture: { node: string; mode: MotionRecordGestureMode; from: { x: number; y: number }; pose: MotionNodePose } | null;
	preview: { count: number; scene: MotionScene } | null;
	restore: { loop: AnimationLoopMode };
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
	/** The effects provider slot (see `setEffectsProvider`). */
	readonly effects = new EffectsSlot();
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
	private recording: RecordingSession | null = null;

	constructor(options: AnimationEditorOptions = {}) {
		this.history = options.history ?? new HistoryManager();
		this.scene = options.scene ? parseMotionScene(options.scene) : createMotionScene(BLANK);
		this.issues = checkMotionScene(this.scene);
		this.readOnly = options.readOnly ?? false;
		this.onChange = options.onChange;
		if (options.effects) this.effects.set(options.effects);
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
			}),
			this.effects.subscribe(() => this.notify())
		);
	}

	/**
	 * Pauses and stops listening to the player and history. Subscribing again reconnects, so a
	 * controller survives React StrictMode's unmount / remount.
	 */
	destroy(): void {
		this.cancelRecording();
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
			revision: this.revision,
			effectsProvider: this.effects.provider,
			recording: this.recording
				? {
						shot: this.recording.options.id,
						at: this.recording.options.at,
						start: this.recording.start,
						elapsed: Math.max(0, p.time - this.recording.start),
						samples: this.recording.samples.length,
						gesture: this.recording.gesture ? { node: this.recording.gesture.node, mode: this.recording.gesture.mode } : null
					}
				: null
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

	private commit(label: string, next: MotionScene, merge?: string) {
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
		if (merge) this.history.executeMerged(command, { key: merge });
		else this.history.execute(command);
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
	apply(edits: MotionEdit | readonly MotionEdit[], label = 'Edit animation', options: { dryRun?: boolean; merge?: string } = {}): MotionEditResult {
		const reason = this.readOnlyReason() ?? (this.recording ? 'A take is being recorded; stop or cancel the recording first.' : null);
		if (reason) return this.refuse(reason);
		const result = applyMotionEdits(this.scene, edits);
		if (!result.ok) return options.dryRun ? result : this.refuse(result.error);
		if (!options.dryRun) this.commit(label, result.scene, options.merge);
		return result;
	}

	/** Replaces the artwork (e.g. from a vector editor's `onChange`), as one undo step. */
	setArtwork(artwork: VectorDocument, label = 'Change artwork'): MotionEditResult {
		return this.apply({ op: 'set_artwork', artwork }, label);
	}


	// ---------------------------------------------------------------------------------------
	// Effects
	// ---------------------------------------------------------------------------------------

	/** The registered effects provider, or `null`. */
	get effectsProvider(): EffectProvider | null {
		return this.effects.provider;
	}

	/** Registers (or with `null` removes) the effects provider. Not an edit: no undo step. */
	setEffectsProvider(provider: EffectProvider | null): void {
		this.effects.set(provider);
	}

	/** Registers `provider` and returns a function that removes it again (if it is still the one set). */
	useEffects(provider: EffectProvider): () => void {
		return this.effects.use(provider);
	}

	/** The provider effects applied in the scene. */
	appliedEffects(): AppliedMotionEffect[] {
		return motionSceneEffects(this.scene);
	}

	private async effectEdit(work: () => Promise<{ scene: MotionScene; label: string; instance: string; notes: string[] }>, merge?: string): Promise<MotionEffectResult> {
		const reason = this.readOnlyReason();
		if (reason) return this.refuse(reason) as { ok: false; error: string };
		let plan;
		try {
			plan = await work();
		} catch (error) {
			if (isEffectError(error) || error instanceof Error) return this.refuse((error as Error).message) as { ok: false; error: string };
			throw error;
		}
		const r = this.apply({ op: 'replace_scene', scene: plan.scene }, plan.label, { merge });
		if (!r.ok) return r;
		const effect = motionSceneEffects(this.scene).find((e) => e.instance === plan.instance);
		if (!effect) return this.refuse('The effect made no changes the scene can play.') as { ok: false; error: string };
		return { ok: true, effect, notes: plan.notes };
	}

	private async describeFor(effect: string, kinds: readonly ('motion' | 'vector')[]): Promise<EffectDescription> {
		const provider = this.effects.require();
		if (!provider.applyVectorEffect) throw new EffectUnsupportedError(`${provider.name} has no vector or motion effects.`);
		const d = await provider.describe(effect);
		if (!kinds.includes(d.kind as 'motion' | 'vector')) {
			const hint = d.kind === 'motion' ? 'apply it to nodes with apply_effect' : d.kind === 'vector' ? 'add it with add_vector_effect' : 'it draws pixels, which scenes cannot hold';
			throw new EffectUnsupportedError(`"${d.id}" (${d.name}) is a ${d.kind} effect: ${hint}.`, d.id);
		}
		return d;
	}

	private knownNodes(ids: readonly string[]): void {
		const all = new Set<string>();
		const walk = (nodes: MotionScene['artwork']['nodes']) => nodes.forEach((n) => (all.add(n.id), n.type === 'group' && walk(n.children)));
		walk(this.scene.artwork.nodes);
		const missing = ids.filter((id) => !all.has(id));
		if (missing.length) throw new Error(`The artwork has no node ${missing.map((m) => `"${m}"`).join(', ')}; get_animation lists the node ids.`);
		if (!ids.length) throw new Error('Give at least one node to animate.');
	}

	/**
	 * Applies a provider motion effect to artwork nodes: the provider animates them and the changes
	 * become commands, in a new shot (default) or added to the end of `shot`. One undo step.
	 * Returns the applied effect (its `instance` id changes or removes it).
	 */
	applyMotionEffect(effect: string, targets: readonly string[], options: { values?: Record<string, EffectValue>; shot?: string; instance?: string } = {}): Promise<MotionEffectResult> {
		return this.effectEdit(async () => {
			this.knownNodes(targets);
			const d = await this.describeFor(effect, ['motion']);
			const values = resolveEffectValues(d, options.values);
			const instance = options.instance ?? nextMotionEffectInstance(this.scene);
			const motion = await this.effects.require().applyVectorEffect!(d.id, { svg: motionArtworkSvg(this.scene.artwork), nodeIds: [...targets] }, values);
			const source: MotionEffectSource = { instance, effect: d.id, provider: this.effects.require().id, name: d.name, values };
			const { commands, notes } = motionCommandsFromEffect(this.scene.artwork, motion, source);
			if (!commands.length) throw new Error(`"${d.name}" made no changes the scene can play${notes.length ? `: ${notes.join(' ')}` : ''}.`);
			let shots = this.scene.shots;
			if (options.shot) {
				if (!shots.some((s) => s.id === options.shot)) throw new Error(`There is no shot "${options.shot}"; the shots are ${shots.map((s) => `"${s.id}"`).join(', ')}.`);
				shots = shots.map((s) => (s.id === options.shot ? { ...s, run: [...s.run, ...commands] } : s));
			} else shots = [...shots, { id: instance, label: d.name, run: commands }];
			return { scene: { ...this.scene, shots }, label: `Apply ${d.name}`, instance, notes };
		});
	}

	/**
	 * Adds a provider vector effect (one with its own picture: a lower third, a loader): its SVG as
	 * an artwork group (id: the instance) fitted into `box` (default the whole artwork), and its
	 * motion as shots after the last one. One undo step.
	 */
	addVectorEffect(effect: string, options: { values?: Record<string, EffectValue>; box?: { x: number; y: number; width: number; height: number }; instance?: string } = {}): Promise<MotionEffectResult> {
		return this.effectEdit(async () => {
			const d = await this.describeFor(effect, ['vector']);
			const values = resolveEffectValues(d, options.values);
			const instance = options.instance ?? nextMotionEffectInstance(this.scene);
			const motion = await this.effects.require().applyVectorEffect!(d.id, motionArtworkSvg(this.scene.artwork), values);
			const source: MotionEffectSource = { instance, effect: d.id, provider: this.effects.require().id, name: d.name, values };
			const { group, shots, notes } = motionPartsFromVectorEffect(this.scene.artwork, motion, source, options.box);
			return { scene: { ...this.scene, artwork: { ...this.scene.artwork, nodes: [...this.scene.artwork.nodes, group] }, shots: [...this.scene.shots, ...shots] }, label: `Add ${d.name}`, instance, notes };
		});
	}

	/**
	 * Makes an applied effect again with new `values` (merged over its own; `null` resets a
	 * control), in the same place. One undo step.
	 */
	updateMotionEffect(instance: string, values: Record<string, EffectValue | null>, options: { merge?: string } = {}): Promise<MotionEffectResult> {
		return this.effectEdit(async () => {
			const was = motionSceneEffects(this.scene).find((e) => e.instance === instance);
			if (!was) throw new Error(`There is no applied effect "${instance}"; list_applied_effects lists them.`);
			const d = await this.describeFor(was.effect, [was.kind]);
			const base = { ...was.values };
			const given: Record<string, EffectValue> = {};
			for (const [k, v] of Object.entries(values)) {
				if (v !== null) given[k] = v;
				else if (k in d.controls.properties) base[k] = d.defaults[k];
				else throw new Error(`"${k}" is not a control of "${d.id}"; its controls are ${Object.keys(d.controls.properties).join(', ')}.`);
			}
			const merged = { ...base, ...resolveEffectValues({ ...d, defaults: base }, given) };
			const { scene: bare, place } = withoutMotionEffect(this.scene, instance);
			const provider = this.effects.require();
			const source: MotionEffectSource = { instance, effect: d.id, provider: provider.id, name: d.name, values: merged };
			if (was.kind === 'vector') {
				const old = this.scene.artwork.nodes.find((n) => n.id === instance);
				const motion = await provider.applyVectorEffect!(d.id, motionArtworkSvg(bare.artwork), merged);
				const { group, shots, notes } = motionPartsFromVectorEffect(bare.artwork, motion, source);
				const index = this.scene.artwork.nodes.findIndex((n) => n.id === instance);
				const nodes = [...bare.artwork.nodes];
				nodes.splice(Math.max(0, index), 0, old?.transform ? { ...group, transform: old.transform } : group);
				const at = this.scene.shots.findIndex((s) => was.shots.includes(s.id));
				const kept = bare.shots;
				const nextShots = [...kept.slice(0, Math.max(0, at)), ...shots, ...kept.slice(Math.max(0, at))];
				return { scene: { ...bare, artwork: { ...bare.artwork, nodes }, shots: nextShots }, label: `Change ${d.name}`, instance, notes };
			}
			const motion = await provider.applyVectorEffect!(d.id, { svg: motionArtworkSvg(bare.artwork), nodeIds: was.targets }, merged);
			const { commands, notes } = motionCommandsFromEffect(bare.artwork, motion, source);
			let shots = bare.shots;
			if (place && shots.some((s) => s.id === place.shot)) shots = shots.map((s) => (s.id === place.shot ? { ...s, run: [...s.run.slice(0, place.index), ...commands, ...s.run.slice(place.index)] } : s));
			else {
				const at = this.scene.shots.findIndex((s) => s.id === place?.shot);
				shots = [...shots.slice(0, Math.max(0, at)), { id: instance, label: d.name, run: commands }, ...shots.slice(Math.max(0, at))];
			}
			return { scene: { ...bare, shots }, label: `Change ${d.name}`, instance, notes };
		}, options.merge);
	}

	/** Removes an applied effect: its commands, shots it alone filled and a vector effect's group. One undo step. Works without a provider. */
	removeMotionEffect(instance: string): MotionEffectResult {
		const was = motionSceneEffects(this.scene).find((e) => e.instance === instance);
		if (!was) return this.refuse(`There is no applied effect "${instance}"; list_applied_effects lists them.`) as { ok: false; error: string };
		const r = this.apply({ op: 'replace_scene', scene: withoutMotionEffect(this.scene, instance).scene }, `Remove ${was.name ?? was.effect}`);
		return r.ok ? { ok: true, effect: was, notes: [] } : r;
	}

	/** Opens a scene (JSON or object). `clearHistory` drops the undo stack (opening a file); otherwise it is one undo step. */
	load(scene: MotionScene | string, options: { clearHistory?: boolean } = {}): MotionEditResult {
		if (options.clearHistory) this.cancelRecording();
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
		if (readOnly) this.cancelRecording();
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

	/** Moves the playhead (ms). Ignored while recording: a take runs on from where it started. */
	seek(time: number): void {
		if (this.recording) return;
		this.player.seek(time);
	}

	/** Moves the playhead to the start or end of a shot. Returns false for an unknown shot. */
	seekShot(id: string, at: 'start' | 'end' = 'start'): boolean {
		const shot = compileMotionScene(this.scene).shots.find((s) => s.id === id);
		if (!shot || this.recording) return false;
		this.player.seek(at === 'start' ? shot.start : shot.end);
		return true;
	}

	undo(): boolean {
		return this.recording ? false : this.history.undo();
	}

	redo(): boolean {
		return this.recording ? false : this.history.redo();
	}

	/** The scene as shown: while recording, with the take so far as its shot. */
	viewScene(): MotionScene {
		const r = this.recording;
		if (!r) return this.scene;
		if (r.preview?.count === r.samples.length) return r.preview.scene;
		let scene = this.scene;
		if (r.samples.length) {
			try {
				const { shot, at } = motionTakeShot(this.scene, { samples: r.samples, length: Math.max(0, this.player.currentTime - r.start) }, r.options);
				scene = { ...this.scene, shots: [...this.scene.shots.slice(0, at), shot, ...this.scene.shots.slice(at)] };
			} catch {
				// Samples are checked as they come in; a take that still fails shows the scene as it was.
			}
		}
		r.preview = { count: r.samples.length, scene };
		return scene;
	}

	/** The scene at `time` (default: the playhead). */
	frame(time = this.player.currentTime, options: MotionFrameOptions = {}): MotionFrame {
		return motionFrameAt(this.viewScene(), time, options);
	}

	/** The scene at `time` (default: the playhead) as SVG. */
	toSvg(time = this.player.currentTime, options: MotionSvgOptions & MotionOverlayOptions = {}): string {
		return motionStageSvg(this.viewScene(), time, options);
	}

	// ---------------------------------------------------------------------------------------
	// Recording
	// ---------------------------------------------------------------------------------------

	/**
	 * Starts recording a take: the playhead goes to where the take's shot will start (default:
	 * the end of the scene) and plays on, and every `recordSample` (or stage gesture) is a value
	 * at that moment. Frames show the take so far. `stopRecording` turns it into one shot, one
	 * undo step. Edits, seeks and undo wait until the recording stops; `pause` pauses the take.
	 */
	startRecording(options: MotionTakeOptions = {}): { ok: true; recording: AnimationEditorRecording } | { ok: false; error: string } {
		const reason = this.readOnlyReason() ?? (this.recording ? 'A take is already being recorded.' : null);
		if (reason) return this.refuse(reason) as { ok: false; error: string };
		const at = options.at ?? this.scene.shots.length;
		if (!Number.isInteger(at) || at < 0 || at > this.scene.shots.length) return this.refuse(`"at" must be a whole number from 0 to ${this.scene.shots.length} (got ${at}).`) as { ok: false; error: string };
		const id = options.id ?? freshShotId(this.scene, 'take');
		if (this.scene.shots.some((s) => s.id === id)) return this.refuse(`Shot id "${id}" is already used; choose another (e.g. "${freshShotId(this.scene, id)}").`) as { ok: false; error: string };
		const timeline = compileMotionScene(this.scene);
		const start = at < timeline.shots.length ? timeline.shots[at].start : timeline.duration;
		this.error = null;
		this.recording = { options: { ...options, id, at }, start, samples: [], gesture: null, preview: null, restore: { loop: this.player.getState().loop } };
		this.player.pause();
		this.player.setPlaybackRate(1);
		this.player.setLoop('none');
		this.player.setDuration(start + MOTION_MAX_TAKE_MS);
		this.player.seek(start);
		this.player.play();
		return { ok: true, recording: this.state.recording! };
	}

	/**
	 * Records `values` for `node` at `t` (ms into the take; default now). Returns why a sample was
	 * refused (an unknown node, a value out of range), or null.
	 */
	recordSample(node: string, values: Omit<MotionTakeSample, 'node' | 't'>, t?: number): string | null {
		const r = this.recording;
		if (!r) return 'Nothing is being recorded; startRecording first.';
		const sample: MotionTakeSample = { ...values, node, t: Math.max(0, t ?? this.player.liveTime - r.start) };
		const problems = motionTakeProblems(this.scene, { samples: [sample] });
		if (problems.length) return problems.join(' ').replace('Sample 1', 'The sample');
		r.samples.push(sample);
		this.notify();
		return null;
	}

	/** Where `node` is and how it looks now (while recording: in the take so far), or at `time`. */
	pose(node: string, time = this.player.currentTime): MotionNodePose {
		return motionNodePose(this.viewScene(), node, time);
	}

	/** A point on a stage element (client pixels, e.g. a pointer event) in document units, through the camera now. */
	clientToDocument(box: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } {
		return motionClientToDocument(this.frame().camera, box, clientX, clientY);
	}

	/**
	 * Starts a stage drag while recording: from `point` (document units), `move` drags the node,
	 * `scale` scales it about its centre by how much nearer or farther the pointer is, and
	 * `rotate` turns it with the pointer. Returns false when not recording or `node` is unknown.
	 */
	beginRecordGesture(node: string, mode: MotionRecordGestureMode, point: { x: number; y: number }): boolean {
		const r = this.recording;
		if (!r || !indexMotionNodes(this.scene.artwork.nodes).has(node)) return false;
		const pose = this.pose(node);
		r.gesture = { node, mode, from: point, pose };
		this.recordGesture(pose, point);
		return true;
	}

	/** Records the drag's pose with the pointer at `point` (document units). */
	updateRecordGesture(point: { x: number; y: number }): void {
		const g = this.recording?.gesture;
		if (g) this.recordGesture(g.pose, point);
	}

	/** Ends the stage drag (the take keeps recording). */
	endRecordGesture(): void {
		const r = this.recording;
		if (!r?.gesture) return;
		r.gesture = null;
		this.notify();
	}

	private recordGesture(pose: MotionNodePose, point: { x: number; y: number }) {
		const g = this.recording!.gesture!;
		const c = { x: pose.x, y: pose.y };
		if (g.mode === 'move') {
			this.recordSample(g.node, { x: pose.x + point.x - g.from.x, y: pose.y + point.y - g.from.y });
		} else if (g.mode === 'scale') {
			const f = Math.hypot(point.x - c.x, point.y - c.y) / Math.max(1e-6, Math.hypot(g.from.x - c.x, g.from.y - c.y));
			this.recordSample(g.node, { scaleX: Math.max(0.01, pose.scaleX * f), scaleY: Math.max(0.01, pose.scaleY * f) });
		} else {
			const turn = (Math.atan2(point.y - c.y, point.x - c.x) - Math.atan2(g.from.y - c.y, g.from.x - c.x)) * (180 / Math.PI);
			// The shortest way round from the turn before, so a drag past ±180° keeps going.
			const was = this.recording!.samples.filter((s) => s.node === g.node && s.rotation !== undefined).at(-1)?.rotation ?? pose.rotation;
			let next = pose.rotation + turn;
			next += 360 * Math.round((was - next) / 360);
			this.recordSample(g.node, { rotation: next });
		}
	}

	private endRecording(): RecordingSession | null {
		const r = this.recording;
		if (!r) return null;
		this.player.pause();
		this.recording = null;
		this.player.setLoop(r.restore.loop);
		this.player.setDuration(() => compileMotionScene(this.scene).duration);
		return r;
	}

	/**
	 * Stops recording and adds the take as a shot (one undo step), selected, with the playhead at
	 * its start. Returns the shot, or why nothing was added (nothing recorded).
	 */
	stopRecording(): MotionRecordResult {
		const length = this.recording ? this.player.liveTime - this.recording.start : 0;
		const r = this.endRecording();
		if (!r) return this.refuse('Nothing is being recorded.') as { ok: false; error: string };
		if (!r.samples.length) {
			this.player.seek(r.start);
			return this.refuse('Nothing was recorded, so no shot was added: drag an element on the stage (or change its paint) while recording.') as { ok: false; error: string };
		}
		const result = this.recordTake({ samples: r.samples, length }, r.options);
		this.player.seek(r.start);
		return result;
	}

	/** Stops recording and throws the take away. */
	cancelRecording(): void {
		const r = this.endRecording();
		if (!r) return;
		this.player.seek(r.start);
		this.notify();
	}

	/**
	 * Adds a take given as samples (an agent's performance, or one recorded elsewhere) as a shot,
	 * one undo step, selected. With `dryRun` it returns the shot and changes nothing.
	 */
	recordTake(take: MotionTake, options: MotionTakeOptions & { dryRun?: boolean } = {}): MotionRecordResult {
		let made: MotionTakeResult;
		try {
			made = motionTakeShot(this.scene, take, options);
		} catch (error) {
			return options.dryRun ? { ok: false, error: (error as Error).message } : (this.refuse((error as Error).message) as { ok: false; error: string });
		}
		const result = this.apply({ op: 'insert_shots', shots: [made.shot], at: made.at }, 'Record take', { dryRun: options.dryRun });
		if (!result.ok) return result;
		if (!options.dryRun) this.select({ shot: made.shot.id });
		return { ok: true, ...made, issues: result.issues };
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
