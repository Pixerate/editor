/**
 * The effects authoring contract: types for editing effects (GLSL or SVG source, control values,
 * keyframes, presets, timeline and playback). Implementations may be headless sessions like Flair's
 * `EffectEditor` or the generic authoring session provided by this package.
 */

import type { AnimationEasing } from '../animation/easing.js';
import type {
	EffectDescription,
	EffectKind,
	EffectPreset,
	EffectRenderer,
	EffectRendererOptions,
	EffectValue,
	EffectValues,
	MaybePromise
} from './types.js';

/** A document saved earlier by `exportDocument` and reopened with `{ document }`. */
export interface EffectAuthoringDocument {
	version: 1;
	providerId: string;
	effectId: string;
	name: string;
	values: EffectValues;
	tracks: Readonly<Record<string, readonly EffectKeyframe[]>>;
	presets: readonly EffectPreset[];
	duration: number;
	loop: boolean;
}

/** What to open: a catalog effect (optionally with a preset applied), or a document saved earlier by `exportDocument`. */
export type EffectAuthoringSource =
	| { effectId: string; preset?: string }
	| { document: EffectAuthoringDocument | unknown };

/** The language of an editable source, or null when the effect has no source to edit. */
export type EffectSourceLanguage = 'glsl' | 'svg' | null;

/** One keyframe of an animated control. */
export interface EffectKeyframe {
	/** Ms from the start of the effect. */
	time: number;
	/** The value at this keyframe. */
	value: EffectValue;
	/** Easing into the next keyframe (default `linear`). */
	easing?: AnimationEasing;
}

/** A problem with the effect, e.g. a compile error. `line` is 1-based in `source` when known. */
export interface EffectAuthoringIssue {
	message: string;
	line?: number;
	severity: 'error' | 'warning';
}

/** The observable state of an effect authoring session. */
export interface EffectAuthoringState {
	/** Stable id of the provider that owns this effect. */
	providerId: string;
	/** The id the effect was opened from, or null for a document with no catalog id. */
	effectId: string | null;
	/** Display name of the effect. */
	name: string;
	/** How the effect is drawn. */
	kind: EffectKind;
	/** The current controls, defaults and presets. They change when the source changes. */
	description: EffectDescription;
	/** Editable source, or null (see `sourceLanguage`). */
	source: string | null;
	/** Language of `source`, or null when source editing is not supported. */
	sourceLanguage: EffectSourceLanguage;
	/** Every control's value at the playhead (keyframes applied). */
	values: EffectValues;
	/** Keyframes per control. A control with no entry is not animated. */
	tracks: Readonly<Record<string, readonly EffectKeyframe[]>>;
	/** Diagnostic issues, compile errors and warnings. */
	issues: readonly EffectAuthoringIssue[];
	/** Whether the source compiled: true, false, or null when that is not known yet (no preview has compiled it). */
	compiled: boolean | null;
	/**
	 * Why `createPreview` could not make a pixel preview (for example a vector effect whose provider
	 * only draws it as SVG), or null when it could or has not been asked yet. Optional for sessions
	 * that never fail to preview.
	 */
	previewError?: string | null;
	/** Current playhead position (ms). */
	time: number;
	/** Length of one play (ms). */
	duration: number;
	/** Whether playback loops. */
	loop: boolean;
	/** Whether playback is currently active. */
	playing: boolean;
	/** Whether an undo action is available. */
	canUndo: boolean;
	/** Whether a redo action is available. */
	canRedo: boolean;
}

/** The result of a session mutation: either successful, or refused with a reason message. */
export type EffectAuthoringResult<T = Record<never, never>> =
	| ({ ok: true } & T)
	| { ok: false; message: string };

/**
 * A live editing session for an effect: controls values, keyframes, presets, source editing,
 * playback timeline and undo/redo history.
 */
export interface EffectAuthoringSession {
	/**
	 * The current state. Returns the same object reference until something changes, suitable
	 * for React's `useSyncExternalStore` or Svelte store subscriptions.
	 */
	getState(): EffectAuthoringState;
	/** Called after every change. Returns a function that unsubscribes. */
	subscribe(listener: (state: EffectAuthoringState) => void): () => void;

	/** Replaces the source. Refused when `sourceLanguage` is null. */
	setSource?(
		source: string
	): MaybePromise<EffectAuthoringResult<{ issues: readonly EffectAuthoringIssue[] }>>;

	/**
	 * Sets a control at the playhead: updates the value if the control is not animated,
	 * else creates/updates a keyframe at `time`. Calls with the same `gesture` key merge into one undo step.
	 */
	setValue(
		name: string,
		value: EffectValue,
		options?: { gesture?: string | null }
	): EffectAuthoringResult;

	/** Sets several controls as one undo step, all or nothing: one bad value refuses the lot. */
	setValues(
		values: EffectValues,
		options?: { gesture?: string | null }
	): EffectAuthoringResult;

	/** Puts controls back to their defaults (default: all controls). */
	resetValues(names?: readonly string[]): EffectAuthoringResult;

	/** Applies a named preset's values. */
	applyPreset(name: string): EffectAuthoringResult;

	/** Saves the current values as a preset, or replaces an existing preset with the same name. */
	savePreset(name: string): EffectAuthoringResult;

	/** Adds or replaces a keyframe. `value` defaults to the control's value at that time. */
	setKeyframe(
		name: string,
		time: number,
		value?: EffectValue,
		easing?: AnimationEasing
	): EffectAuthoringResult;

	/** Removes a keyframe from a control at the given time. */
	removeKeyframe(name: string, time: number): EffectAuthoringResult;

	/** Removes every keyframe of a control. The value it has at the playhead becomes its static value. */
	clearTrack(name: string): EffectAuthoringResult;

	/** Configures timeline duration and loop behavior. */
	setTiming(timing: { duration?: number; loop?: boolean }): EffectAuthoringResult;

	/** Starts playback. */
	play(): void;

	/** Pauses playback. */
	pause(): void;

	/** Moves the playhead (clamped to 0..duration). */
	seek(time: number): void;

	/** Reverts the last edit. Returns true if state changed. */
	undo(): boolean;

	/** Redoes the last undone edit. Returns true if state changed. */
	redo(): boolean;

	/**
	 * Creates a renderer that draws this session's current effect (source and values as they are at each
	 * `render` call). `render({ time })` draws the effect at `time` with the keyframed values for
	 * that time unless `values` is given. A compile failure shows in `issues` and `compiled`.
	 */
	createPreview(options: EffectRendererOptions): MaybePromise<EffectRenderer>;

	/** Exports the document as plain JSON, to save and reopen with `{ document }`. */
	exportDocument(): EffectAuthoringDocument;

	/** Disposes the session, stops playback, cleans up listeners and disposes created previews. */
	dispose(): void;
}
