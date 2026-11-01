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
import { VideoLutCache, type VideoLutLoader } from './lut.js';
import { createVideoProject, parseVideoProject } from './parse.js';
import { VideoPreviewPixels } from './scopes.js';
import type { VideoPreviewScale } from './proxy.js';
import type { VideoFrameCache } from './frame-cache.js';
import { videoProjectSvg, type VideoSvgOptions } from './render.js';
import { snapToVideoFrame, snapVideoTime, videoClipEnd, videoClipsAt, videoProjectDuration, videoSnapPoints, findVideoClip } from './timeline.js';
import type { VideoCameraFraming, VideoClip, VideoClipCamera, VideoClipEffect, VideoEffectValues, VideoPlacementMode, VideoProject } from './types.js';
import { cameraMoveField, EffectsSlot, resolveCameraMoveSpec } from '../effects/helpers.js';
import { bakeVideoClipCamera, videoCameraBase, type VideoCameraBake } from './camera.js';
import { isEffectError } from '../effects/errors.js';
import type { CameraMoveRole, CameraMoveSpec, EffectDescription, EffectProvider, EffectSummary, EffectValue } from '../effects/types.js';
import { checkVideoEffectPlace, checkVideoEffectValues, VideoEffectsEngine, type VideoEffectPlace } from './effects.js';
import { isVideoKeyframes, VIDEO_TRANSFORM_PROPERTIES, videoKeysOf, type VideoAnimatable, type VideoKey } from './keyframes.js';
import { planVideoEdits, type VideoEditPlan, type VideoEditPlanInput } from './plan.js';

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
	/** Where grades' LUT files (`.cube`) come from: a shared cache, or a loader (default: `fetch` each `src`). */
	luts?: VideoLutCache | VideoLutLoader;
	/** How large a picture the preview plays (default `auto`: a proxy as large as the canvas shows, if the asset has one). */
	previewScale?: VideoPreviewScale;
	/**
	 * Decoded source frames with prefetch for the preview (see `VideoFrameCache`): scrubbing and
	 * stepping then show cached frames at once. Host-side and optional (default none).
	 */
	frameCache?: VideoFrameCache;
	/**
	 * An effects provider (see `@pixerate/editor/effects`) for clip effects, effect transitions and
	 * effect clips. Optional: without one the editor behaves as before, and projects that use
	 * effects keep them, drawn as placeholders. Set or change it later with `setEffectsProvider`.
	 */
	effects?: EffectProvider | null;
}

/** What `applyClipEffect` and the other effect edits return: the edit result plus what they made or changed. */
/** What setting or clearing a clip's camera move did: its camera now, the keys baked per property, any cuts and when each move plays (clip ms). */
export type VideoCameraMoveResult =
	| { ok: true; clip: string; camera: VideoClipCamera | null; keys: Record<'x' | 'y' | 'scale' | 'rotation', number>; cuts: number[]; windows: VideoCameraBake['windows']; notes: string[] }
	| { ok: false; error: string };

export type VideoEffectEditResult = (VideoEditResult & { ok: true; clip: string; effect?: VideoClipEffect }) | { ok: false; error: string };

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
	/** How large a picture the preview plays: `auto`, `full` or a fraction that picks a proxy. */
	previewScale: VideoPreviewScale;
	/** The registered effects provider, or `null` (effects are then drawn as placeholders and cannot be added). */
	effectsProvider: EffectProvider | null;
	/** Proposed edit plans waiting for review, oldest first (see `proposePlan`). Not part of the project or its undo history. */
	plans: readonly VideoEditPlan[];
	/** Bumped on every change. */
	revision: number;
}

/** What `applyPlan` returns: the edit result, the plan applied and whether the project had changed since it was made. */
export type VideoPlanApplyResult = (VideoEditResult & { ok: true; plan: VideoEditPlan; stale: boolean }) | { ok: false; error: string };

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
	/** The pixels the preview last drew, for scopes and `get_video_scopes` (a `VideoPreviewEngine` fills it). */
	readonly previewPixels = new VideoPreviewPixels();
	/** Grades' LUTs, loaded on demand for the preview, SVG frames and agents. */
	readonly luts: VideoLutCache;
	/** The host's frame cache, if it gave one (the preview fills and reads it). */
	readonly frameCache: VideoFrameCache | null;
	/** The effects provider slot (see `setEffectsProvider`). */
	readonly effects: EffectsSlot;
	/** Rendered effect pictures for the preview and frame-exact exports. */
	readonly effectsEngine: VideoEffectsEngine;
	private project: VideoProject;
	private issues: VideoIssue[];
	private selection: string[] = [];
	private readOnly: boolean;
	private previewScale: VideoPreviewScale;
	private error: string | null = null;
	private revision = 0;
	private applying = false;
	private readonly onChange?: (project: VideoProject) => void;
	private readonly listeners = new Set<(state: VideoEditorState) => void>();
	private readonly unsubscribers: (() => void)[] = [];
	private state!: VideoEditorState;
	private plans: VideoEditPlan[] = [];
	/** The project each open plan was worked out against. */
	private readonly planBasis = new Map<string, VideoProject>();
	private planCount = 0;

	constructor(options: VideoEditorOptions = {}) {
		this.history = options.history ?? new HistoryManager();
		this.audioPeaks = options.audioPeaks instanceof VideoAudioPeaksCache ? options.audioPeaks : new VideoAudioPeaksCache(options.audioPeaks);
		this.luts = options.luts instanceof VideoLutCache ? options.luts : new VideoLutCache(options.luts);
		this.frameCache = options.frameCache ?? null;
		this.effects = new EffectsSlot();
		if (options.effects) this.effects.set(options.effects);
		this.effectsEngine = new VideoEffectsEngine({ slot: this.effects });
		this.project = options.project ? parseVideoProject(options.project) : createVideoProject();
		this.issues = checkVideoProject(this.project);
		this.readOnly = options.readOnly ?? false;
		this.previewScale = checkPreviewScale(options.previewScale ?? 'auto');
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
			}),
			this.effects.subscribe(() => this.notify())
		);
	}

	/** Pauses and stops listening to the player and history. Subscribing again reconnects (React StrictMode). */
	destroy(): void {
		this.player.pause();
		this.effectsEngine.reset();
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
			previewScale: this.previewScale,
			effectsProvider: this.effects.provider,
			plans: this.plans,
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

	private commit(label: string, next: VideoProject, merge?: string) {
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
		if (merge) this.history.executeMerged(command, { key: merge });
		else this.history.execute(command);
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
	 * reports what would happen and changes nothing. Edits with the same `merge` key in a row
	 * (a slider drag) fold into one undo step.
	 */
	apply(edits: VideoEdit | readonly VideoEdit[], label = 'Edit video', options: { dryRun?: boolean; merge?: string } = {}): VideoEditResult {
		const reason = this.readOnlyReason();
		if (reason) return this.refuse(reason);
		const result = applyVideoEdits(this.project, edits);
		if (!result.ok) return options.dryRun ? result : this.refuse(result.error);
		if (!options.dryRun) this.commit(label, result.project, options.merge);
		return result;
	}

	// -----------------------------------------------------------------------------------------
	// Edit plans: propose, review, apply or discard
	// -----------------------------------------------------------------------------------------

	/** Most plans kept open at once; proposing another drops the oldest. */
	static readonly MAX_PLANS = 20;

	/**
	 * Works out a batch of edits without applying it and keeps it for review (see `VideoEditPlan`):
	 * the result says what it would do. Allowed while read-only (nothing changes); applying is not.
	 * A plan with the id of an open one replaces it.
	 */
	proposePlan(input: VideoEditPlanInput): { ok: true; plan: VideoEditPlan } | { ok: false; error: string } {
		const ids = new Set(this.plans.map((p) => p.id));
		let id = input.id;
		let count = this.planCount;
		if (id === undefined) {
			do id = `plan${++count}`;
			while (ids.has(id));
		}
		const result = planVideoEdits(this.project, { ...input, id });
		if (!result.ok) return result;
		this.planCount = count;
		const kept = this.plans.filter((p) => p.id !== id);
		while (kept.length >= VideoEditorController.MAX_PLANS) this.planBasis.delete(kept.shift()!.id);
		this.plans = [...kept, result.plan];
		this.planBasis.set(id, this.project);
		this.notify();
		return { ok: true, plan: result.plan };
	}

	/** An open plan, or `undefined`. */
	getPlan(id: string): VideoEditPlan | undefined {
		return this.plans.find((p) => p.id === id);
	}

	/** Whether the project changed since a plan was made (its summary may then be out of date). */
	isPlanStale(id: string): boolean {
		const basis = this.planBasis.get(id);
		return !!basis && basis !== this.project;
	}

	/** The project as an open plan would leave it, worked out against the current project; `null` when it no longer applies. */
	planPreview(id: string): VideoProject | null {
		const plan = this.getPlan(id);
		if (!plan) return null;
		const result = applyVideoEdits(this.project, plan.edits);
		return result.ok ? result.project : null;
	}

	/**
	 * Applies an open plan as one undo step labelled with its title and closes it. If the project
	 * changed since it was made, its edits are checked again against the project as it is now and
	 * refused (the plan stays open) when they no longer apply.
	 */
	applyPlan(id: string): VideoPlanApplyResult {
		const plan = this.getPlan(id);
		if (!plan) return this.refused(`There is no open plan "${id}"; the open plans are ${this.plans.map((p) => `"${p.id}"`).join(', ') || 'none'}.`);
		const reason = this.readOnlyReason();
		if (reason) return this.refused(reason);
		const stale = this.isPlanStale(id);
		const result = applyVideoEdits(this.project, plan.edits);
		if (!result.ok) return this.refused(stale ? `The project changed since plan "${id}" was made and it no longer applies (${result.error}); discard it and make a new plan.` : result.error);
		this.dropPlan(id);
		this.commit(plan.title, result.project);
		return { ...result, plan, stale };
	}

	/** Closes an open plan without applying it. False when there is no such plan. */
	discardPlan(id: string): boolean {
		if (!this.getPlan(id)) return false;
		this.dropPlan(id);
		this.notify();
		return true;
	}

	/** Closes every open plan. */
	discardPlans(): void {
		if (!this.plans.length) return;
		this.plans = [];
		this.planBasis.clear();
		this.notify();
	}

	private dropPlan(id: string) {
		this.plans = this.plans.filter((p) => p.id !== id);
		this.planBasis.delete(id);
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

	/**
	 * Sets how large a picture the preview plays: `full` (the originals), a fraction such as 0.5
	 * (the smallest proxy at least that large, else the original) or `auto` (as large as the canvas
	 * shows). A view setting, not part of the project: no undo step.
	 */
	setPreviewScale(scale: VideoPreviewScale): void {
		const next = checkPreviewScale(scale);
		if (next === this.previewScale) return;
		this.previewScale = next;
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


	// -----------------------------------------------------------------------------------------
	// Effects
	// -----------------------------------------------------------------------------------------

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

	/** The provider's description of an effect, checked for `place` (rejects without a provider or for an unknown id). */
	async describeEffect(effect: string, place?: VideoEffectPlace): Promise<EffectDescription> {
		const d = await this.effects.require().describe(effect);
		if (place) checkVideoEffectPlace(d, place);
		return d;
	}

	private refused(message: string): { ok: false; error: string } {
		return this.refuse(message) as { ok: false; error: string };
	}

	private async effectEdit(run: () => Promise<{ edit: VideoEdit; label: string; clip: string; effect?: () => VideoClipEffect | undefined }>, merge?: string): Promise<VideoEffectEditResult> {
		const reason = this.readOnlyReason();
		if (reason) return this.refused(reason);
		let plan;
		try {
			plan = await run();
		} catch (error) {
			if (isEffectError(error) || error instanceof Error) return this.refused((error as Error).message);
			throw error;
		}
		const result = this.apply(plan.edit, plan.label, { merge });
		if (!result.ok) return result;
		return { ...result, clip: plan.clip, ...(plan.effect ? { effect: plan.effect() } : {}) };
	}

	private clipOrThrow(id: string): VideoClip {
		const at = findVideoClip(this.project, id);
		if (!at) throw new Error(`There is no clip "${id}"; list_applied_effects or get_video_project lists the clips.`);
		return at.clip;
	}

	/**
	 * Adds a filter or overlay effect to a clip's effect stack (at `index`, default the end: applied
	 * last), with `values` over the effect's defaults (numbers may be keyframes). One undo step.
	 * Returns the effect with its new id.
	 */
	applyClipEffect(clip: string, effect: string, options: { values?: VideoEffectValues; index?: number; enabled?: boolean; opacity?: VideoAnimatable } = {}): Promise<VideoEffectEditResult> {
		return this.effectEdit(async () => {
			const current = this.clipOrThrow(clip);
			const d = await this.describeEffect(effect, 'clip');
			const values = checkVideoEffectValues(d, options.values, { keyframes: true });
			const stack = [...(current.effects ?? [])];
			const taken = new Set(stack.map((e) => e.id));
			let n = 1;
			while (taken.has(`fx${n}`)) n++;
			const added: VideoClipEffect = { id: `fx${n}`, effect: d.id, provider: this.effects.require().id, name: d.name, values };
			if (options.enabled === false) added.enabled = false;
			if (options.opacity !== undefined) added.opacity = options.opacity;
			const index = options.index ?? stack.length;
			if (!(Number.isInteger(index) && index >= 0 && index <= stack.length)) throw new Error(`"index" must be a whole number from 0 to ${stack.length}.`);
			stack.splice(index, 0, added);
			return { edit: { op: 'update_clip', clip, set: { effects: stack } }, label: `Add effect ${d.name}`, clip, effect: () => added };
		});
	}

	/**
	 * Changes an effect on a clip: `values` (merged over its current ones; numbers may be
	 * keyframes, `null` resets a control to its default), `enabled`, `opacity` or its place in the
	 * stack (`index`). Values are checked against the provider's controls. One undo step.
	 */
	updateClipEffect(clip: string, instance: string, changes: { values?: Record<string, EffectValue | { keys: VideoKey[] } | null>; enabled?: boolean; opacity?: VideoAnimatable; index?: number }, options: { merge?: string } = {}): Promise<VideoEffectEditResult> {
		return this.effectEdit(async () => {
			const current = this.clipOrThrow(clip);
			const stack = [...(current.effects ?? [])];
			const i = stack.findIndex((e) => e.id === instance);
			if (i < 0) throw new Error(`Clip "${clip}" has no effect "${instance}"; its effects are ${stack.map((e) => `"${e.id}" (${e.name ?? e.effect})`).join(', ') || 'none'}.`);
			const was = stack[i];
			const next: VideoClipEffect = { ...was };
			if (changes.values) {
				const d = await this.describeEffect(was.effect);
				const reset = Object.keys(changes.values).filter((k) => changes.values![k] === null);
				const given = Object.fromEntries(Object.entries(changes.values).filter(([, v]) => v !== null)) as VideoEffectValues;
				const base = { ...(was.values ?? {}) };
				for (const k of reset) {
					if (!(k in d.controls.properties)) throw new Error(`"${k}" is not a control of "${d.id}"; its controls are ${Object.keys(d.controls.properties).join(', ')}.`);
					base[k] = d.defaults[k];
				}
				next.values = checkVideoEffectValues(d, given, { base, keyframes: true });
			}
			if (changes.enabled !== undefined) {
				if (changes.enabled) delete next.enabled;
				else next.enabled = false;
			}
			if (changes.opacity !== undefined) next.opacity = changes.opacity;
			stack.splice(i, 1);
			const index = changes.index ?? i;
			if (!(Number.isInteger(index) && index >= 0 && index <= stack.length)) throw new Error(`"index" must be a whole number from 0 to ${stack.length}.`);
			stack.splice(index, 0, next);
			return { edit: { op: 'update_clip', clip, set: { effects: stack } }, label: `Change effect ${was.name ?? was.effect}`, clip, effect: () => next };
		}, options.merge);
	}

	/** The provider's camera moves for a role (`transition` into a clip, `hold` while it plays), or all of them. Empty without camera support. */
	async cameraMoves(role?: CameraMoveRole): Promise<EffectSummary[]> {
		const provider = this.effects.provider;
		if (!provider?.capabilities.supportsCamera || !provider.cameraView) return [];
		return (await provider.list({ kind: 'camera' })).filter((e) => e.kind === 'camera' && e.camera && (!role || e.camera.role === role));
	}

	private cameraClip(id: string): VideoClip {
		const at = findVideoClip(this.project, id);
		if (!at) {
			const ids = this.project.tracks.flatMap((t) => t.clips.map((c) => c.id));
			throw new Error(`There is no clip "${id}"; the clips are ${ids.map((c) => `"${c}"`).join(', ') || 'none'} (get_video_project lists them).`);
		}
		if (at.track.kind === 'audio') throw new Error(`Clip "${id}" is on audio track "${at.track.id}" and has no picture for a camera to move over.`);
		if (at.clip.type === 'adjustment') throw new Error(`Clip "${id}" is an adjustment clip, which has no picture of its own for a camera to move over.`);
		return at.clip;
	}

	private async cameraEdit(clipId: string, camera: VideoClipCamera | null, label: string, merge?: string): Promise<VideoCameraMoveResult> {
		const clip = this.cameraClip(clipId);
		const base = videoCameraBase(clip);
		if (!camera) {
			// Nothing left to play: the transform goes back to what it was.
			const restored = Object.keys(base).length ? { transform: base } : {};
			const r = this.apply({ op: 'update_clip', clip: clipId, set: restored, remove: ['camera', ...(Object.keys(base).length ? [] : ['transform'])] }, label, { merge });
			if (!r.ok) return r;
			return { ok: true, clip: clipId, camera: null, keys: { x: 0, y: 0, scale: 0, rotation: 0 }, cuts: [], windows: {}, notes: [] };
		}
		const bake = await bakeVideoClipCamera(clip, camera, this.project, this.effects.require());
		const r = this.apply({ op: 'update_clip', clip: clipId, set: { camera, transform: bake.transform } }, label, { merge });
		if (!r.ok) return r;
		const keys = Object.fromEntries(VIDEO_TRANSFORM_PROPERTIES.map((p) => [p, videoKeysOf(bake.transform[p]).length])) as Record<'x' | 'y' | 'scale' | 'rotation', number>;
		return { ok: true, clip: clipId, camera, keys, cuts: bake.cuts, windows: bake.windows, notes: bake.notes };
	}

	/**
	 * Sets the camera move a clip plays into (`transition`: from `from` to `framing` from the
	 * clip's start) or while it holds (`hold`: across the rest of the clip at `framing`), and bakes
	 * the clip's moves into its x, y, scale and rotation keys at the project's frame rate, keeping a
	 * cut's two keys. The move is checked first (role, preset, values; a preset's values and a move
	 * in's length are written out). A clip whose transform is keyed by hand is refused. One undo step.
	 */
	async setClipCameraMove(clip: string, role: CameraMoveRole, spec: CameraMoveSpec, options: { from?: VideoCameraFraming | null; framing?: VideoCameraFraming | null; merge?: string } = {}): Promise<VideoCameraMoveResult> {
		const reason = this.readOnlyReason();
		if (reason) return this.refused(reason);
		try {
			const current = this.cameraClip(clip);
			const { spec: parts, description } = await resolveCameraMoveSpec(this.effects.require(), spec, role);
			const move = role === 'transition' && parts.ms === undefined ? { ...parts, ms: description.camera!.durationMs } : parts;
			const simple = move.ms === undefined && move.preset === undefined && move.values === undefined;
			const camera: VideoClipCamera = { ...(current.camera ?? { base: videoCameraBase(current) }), [cameraMoveField(role)]: simple ? move.move : move };
			for (const key of ['from', 'framing'] as const) {
				if (options[key] === null) delete camera[key];
				else if (options[key] !== undefined) camera[key] = options[key]!;
			}
			if (camera.from && !camera.in) throw new Error('"from" is where a move in starts; set a transition move too, or leave "from" out.');
			return await this.cameraEdit(clip, camera, `${role === 'hold' ? 'Hold move' : 'Camera move'} ${description.name}`, options.merge);
		} catch (error) {
			if (isEffectError(error) || error instanceof Error) return this.refused((error as Error).message);
			throw error;
		}
	}

	/**
	 * Removes a clip's camera move for a role and bakes what is left (which needs the provider);
	 * with no move left the transform goes back to what it was before the moves. One undo step.
	 */
	async clearClipCameraMove(clip: string, role: CameraMoveRole): Promise<VideoCameraMoveResult> {
		const reason = this.readOnlyReason();
		if (reason) return this.refused(reason);
		try {
			const current = this.cameraClip(clip);
			const field = cameraMoveField(role);
			const other = field === 'in' ? 'during' : 'in';
			if (current.camera?.[field] === undefined)
				throw new Error(`Clip "${clip}" has no camera "${field}" move to clear${current.camera?.[other] !== undefined ? `; it has a "${other}" move (role ${role === 'hold' ? 'transition' : 'hold'})` : ''}.`);
			const camera: VideoClipCamera = { ...current.camera };
			delete camera[field];
			if (field === 'in') delete camera.from;
			const left = camera.in !== undefined || camera.during !== undefined;
			return await this.cameraEdit(clip, left ? camera : null, role === 'hold' ? 'Clear hold move' : 'Clear camera move');
		} catch (error) {
			if (isEffectError(error) || error instanceof Error) return this.refused((error as Error).message);
			throw error;
		}
	}

	/** Removes an effect from a clip's stack (works without a provider, so placeholders can be cleared). One undo step. */
	removeClipEffect(clip: string, instance: string): VideoEffectEditResult {
		const reason = this.readOnlyReason();
		if (reason) return this.refused(reason);
		const at = findVideoClip(this.project, clip);
		if (!at) return this.refused(`There is no clip "${clip}".`);
		const stack = at.clip.effects ?? [];
		const was = stack.find((e) => e.id === instance);
		if (!was) return this.refused(`Clip "${clip}" has no effect "${instance}"; its effects are ${stack.map((e) => `"${e.id}"`).join(', ') || 'none'}.`);
		const rest = stack.filter((e) => e !== was);
		const result = rest.length ? this.apply({ op: 'update_clip', clip, set: { effects: rest } }, `Remove effect ${was.name ?? was.effect}`) : this.apply({ op: 'update_clip', clip, remove: ['effects'] }, `Remove effect ${was.name ?? was.effect}`);
		return result.ok ? { ...result, clip, effect: was } : result;
	}

	/**
	 * Sets a provider transition into `clip` from the clip that ends where it starts (centred on the
	 * cut, `duration` ms, default the effect's own length or 1000). One undo step.
	 */
	setEffectTransition(clip: string, effect: string, options: { duration?: number; values?: Record<string, EffectValue> } = {}): Promise<VideoEffectEditResult> {
		return this.effectEdit(async () => {
			this.clipOrThrow(clip);
			const d = await this.describeEffect(effect, 'transition');
			const values = checkVideoEffectValues(d, options.values) as Record<string, EffectValue>;
			const duration = options.duration ?? d.duration ?? 1000;
			return { edit: { op: 'set_transition', clip, transition: { type: 'effect', duration, effect: { effect: d.id, provider: this.effects.require().id, name: d.name, values } } }, label: `Transition ${d.name}`, clip };
		});
	}

	/**
	 * Adds an effect clip: a generator, title or overlay effect drawn over the whole frame for
	 * `duration` ms (default the effect's own length, else 5 s) at `start` (default the end of the
	 * track). One undo step. Returns the new clip's id.
	 */
	addEffectClip(track: string, effect: string, options: { start?: number; duration?: number; values?: VideoEffectValues; name?: string; mode?: VideoPlacementMode; ripple?: boolean; id?: string } = {}): Promise<VideoEffectEditResult> {
		return this.effectEdit(async () => {
			const d = await this.describeEffect(effect, 'generator');
			const values = checkVideoEffectValues(d, options.values, { keyframes: true });
			const duration = options.duration ?? d.duration ?? 5000;
			const label = `Add ${d.name}`;
			const clipId = options.id ?? '';
			return {
				edit: { op: 'add_clip', track, mode: options.mode, ripple: options.ripple, clip: { type: 'effect', ...(options.id ? { id: options.id } : {}), effect: d.id, provider: this.effects.require().id, name: options.name ?? d.name, values, start: options.start, duration } },
				label,
				clip: clipId
			};
		}).then((r) => (r.ok && !r.clip ? { ...r, clip: r.outcomes[0]?.clip ?? '' } : r));
	}

	/**
	 * Changes the values of an effect clip's picture (`target` its id) or of the effect transition
	 * into a clip, merged over the current ones and checked against the provider's controls.
	 * Transition values cannot be keyframed. One undo step.
	 */
	updateEffectValues(clip: string, part: 'generator' | 'transition', values: VideoEffectValues, options: { merge?: string } = {}): Promise<VideoEffectEditResult> {
		return this.effectEdit(async () => {
			const current = this.clipOrThrow(clip);
			if (part === 'generator') {
				if (current.type !== 'effect') throw new Error(`Clip "${clip}" is not an effect clip.`);
				const d = await this.describeEffect(current.effect);
				return { edit: { op: 'update_clip', clip, set: { values: checkVideoEffectValues(d, values, { base: current.values ?? {}, keyframes: true }) } }, label: `Change ${current.name ?? d.name}`, clip };
			}
			const t = current.transition;
			if (t?.type !== 'effect' || !t.effect) throw new Error(`Clip "${clip}" has no effect transition.`);
			const d = await this.describeEffect(t.effect.effect);
			const merged = checkVideoEffectValues(d, values, { base: t.effect.values ?? {} });
			return { edit: { op: 'set_transition', clip, transition: { ...t, effect: { ...t.effect, values: merged } } }, label: `Change transition ${d.name}`, clip };
		}, options.merge);
	}

	/** Keys for one numeric control of a clip effect (clip-relative ms), or `null` to stop animating it (keeping its value at the clip's start). */
	setClipEffectKeyframes(clip: string, instance: string, control: string, keys: VideoKey[] | null): Promise<VideoEffectEditResult> {
		const current = findVideoClip(this.project, clip)?.clip;
		const was = current?.effects?.find((e) => e.id === instance);
		const value = was?.values?.[control];
		const plain = keys === null ? (isVideoKeyframes(value) ? value.keys[0]?.v : value) : { keys: [...keys].sort((a, b) => a.t - b.t) };
		return this.updateClipEffect(clip, instance, { values: { [control]: (plain ?? null) as EffectValue | { keys: VideoKey[] } | null } });
	}

	/** What plays at `time` (default: the playhead). */
	frame(time = this.player.currentTime): VideoFrame {
		return videoFrameAt(this.project, time);
	}

	/** The frame at `time` (default: the playhead) as SVG. */
	toSvg(time = this.player.currentTime, options: VideoSvgOptions = {}): string {
		return videoProjectSvg(this.project, time, { lutFor: (src) => this.luts.peek(src), ...options });
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

function checkPreviewScale(scale: VideoPreviewScale): VideoPreviewScale {
	if (scale === 'auto' || scale === 'full') return scale;
	if (typeof scale !== 'number' || !(scale > 0 && scale <= 1)) throw new Error(`A preview scale is "auto", "full" or a fraction above 0 up to 1 (0.5 is half size), not ${JSON.stringify(scale)}.`);
	return scale === 1 ? 'full' : scale;
}
