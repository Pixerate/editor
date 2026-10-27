import { CUBIC_BEZIER_PRESETS, evaluateEasing, type AnimationEasing } from '../animation/easing.js';
import { createEffectAuthoringSession, type GenericAuthoringOptions } from '../effects/authoring-session.js';
import type { EffectAuthoringDocument, EffectAuthoringSession, EffectKeyframe } from '../effects/authoring.js';
import type { EffectValue } from '../effects/types.js';
import type { VideoEditorController, VideoEffectEditResult } from './controller.js';
import { isVideoKeyframes, type VideoEase, type VideoKey, type VideoKeyframes } from './keyframes.js';
import { findVideoClip } from './timeline.js';
import type { VideoClip, VideoClipEffect } from './types.js';

/**
 * One keyframe model for clip effects and the effect authoring editor: a clip effect's values
 * (plain values, or `{ keys }` in clip ms) open as an `EffectAuthoringDocument` (values and
 * keyframe tracks in ms from the effect's start, which is the clip's start), are tuned and
 * keyframed in an `EffectAuthoringSession` / `<EffectAuthoringEditor>`, and are written back to the
 * clip as one undo step. Adjustment clips use this to tune the effects they apply to the pictures
 * beneath them.
 */

/** A video ease as an animation easing (they share CSS cubic-bezier semantics). */
export function videoEaseToAnimationEasing(ease: VideoEase | undefined): AnimationEasing {
	if (ease === undefined || ease === 'linear') return 'linear';
	if (Array.isArray(ease)) return { type: 'cubic-bezier', x1: ease[0], y1: ease[1], x2: ease[2], y2: ease[3] };
	return ease;
}

/**
 * An animation easing as a video ease, or `null` when video keyframes cannot hold it (springs,
 * elastics): those segments are sampled into several keys instead (see `videoEffectValuesFromDocument`).
 */
export function animationEasingToVideoEase(easing: AnimationEasing | undefined): VideoEase | null {
	if (easing === undefined || easing === 'linear') return 'linear';
	if (easing === 'hold' || easing === 'ease-in' || easing === 'ease-out' || easing === 'ease-in-out') return easing;
	if (typeof easing === 'string') {
		const p = CUBIC_BEZIER_PRESETS[easing];
		return p ? [p[0], p[1], p[2], p[3]] : null;
	}
	if (easing.type === 'cubic-bezier') return [easing.x1, easing.y1, easing.x2, easing.y2];
	return null;
}

/** Keys of a sampled segment: how many steps a spring or elastic segment becomes. */
const SAMPLES = 12;

/** A clip effect as an authoring document (values, keyframe tracks, the clip's length as the timeline). */
export function videoClipEffectDocument(clip: VideoClip, instance: string, providerId: string): EffectAuthoringDocument {
	const effect = (clip.effects ?? []).find((e) => e.id === instance);
	if (!effect) throw new Error(`Clip "${clip.id}" has no effect "${instance}"; its effects are ${(clip.effects ?? []).map((e) => `"${e.id}" (${e.name ?? e.effect})`).join(', ') || 'none'}.`);
	const values: Record<string, EffectValue> = {};
	const tracks: Record<string, EffectKeyframe[]> = {};
	for (const [control, v] of Object.entries(effect.values ?? {})) {
		if (isVideoKeyframes(v)) {
			values[control] = v.keys[0].v;
			tracks[control] = v.keys.map((k) => ({ time: k.t, value: k.v, ...(k.ease && k.ease !== 'linear' ? { easing: videoEaseToAnimationEasing(k.ease) } : {}) }));
		} else values[control] = v;
	}
	return { version: 1, providerId, effectId: effect.effect, name: effect.name ?? effect.effect, values, tracks, presets: [], duration: clip.duration, loop: false };
}

/**
 * An authoring document's values and tracks as clip effect values: numeric tracks become `{ keys }`
 * (springs and elastics sampled into several keys), other tracks keep their value at the start
 * (video keyframes are numbers only). `notes` says what was sampled or dropped.
 */
export function videoEffectValuesFromDocument(doc: Pick<EffectAuthoringDocument, 'values' | 'tracks'>): { values: Record<string, EffectValue | VideoKeyframes>; notes: string[] } {
	const values: Record<string, EffectValue | VideoKeyframes> = { ...doc.values };
	const notes: string[] = [];
	for (const [control, track] of Object.entries(doc.tracks ?? {})) {
		const kfs = [...track].sort((a, b) => a.time - b.time);
		if (!kfs.length) continue;
		if (!kfs.every((k) => typeof k.value === 'number')) {
			values[control] = kfs[0].value;
			notes.push(`"${control}" is keyframed with non-numeric values, which clip effects cannot animate; it keeps its first value.`);
			continue;
		}
		const keys: VideoKey[] = [];
		let sampled = false;
		kfs.forEach((k, i) => {
			const next = kfs[i + 1];
			const ease = animationEasingToVideoEase(k.easing);
			if (!next || ease) {
				keys.push({ t: k.time, v: k.value as number, ...(next && ease && ease !== 'linear' ? { ease } : {}) });
				return;
			}
			// A curve video keys cannot hold: linear steps through it.
			sampled = true;
			const a = k.value as number;
			const b = next.value as number;
			const span = next.time - k.time;
			for (let s = 0; s < SAMPLES; s++) keys.push({ t: Math.round((k.time + (span * s) / SAMPLES) * 1000) / 1000, v: a + (b - a) * evaluateEasing(k.easing, s / SAMPLES, span) });
		});
		values[control] = { keys: keys.filter((k, i) => i === 0 || k.t > keys[i - 1].t) };
		if (sampled) notes.push(`"${control}" uses a spring or elastic easing, sampled into ${SAMPLES} linear steps per segment.`);
	}
	return { values, notes };
}

/** An effect authoring session opened on a clip effect, and the way to write it back. */
export interface VideoClipEffectAuthoring {
	readonly clip: string;
	readonly instance: string;
	readonly session: EffectAuthoringSession;
	/** Writes the session's values and keyframes back to the clip effect as one undo step. */
	commit(): Promise<VideoEffectEditResult & { notes?: string[] }>;
	/** Closes the session without writing back. */
	dispose(): void;
}

/**
 * Opens a clip's effect (on any clip, adjustment clips included) in an `EffectAuthoringSession`
 * using the editor's effects provider, with the clip's length as the timeline and its keyframes as
 * tracks, so `<EffectAuthoringEditor>` can tune and keyframe it. Nothing changes on the clip until
 * `commit`. Rejects with a readable error for an unknown clip or effect, or without a provider.
 */
export async function openVideoClipEffectAuthoring(controller: VideoEditorController, clip: string, instance: string, options: Omit<GenericAuthoringOptions, 'provider'> = {}): Promise<VideoClipEffectAuthoring> {
	const provider = controller.effectsProvider;
	if (!provider) throw new Error('No effects provider is registered, so the effect cannot be opened for authoring; register one with setEffectsProvider.');
	const at = findVideoClip(controller.getProject(), clip);
	if (!at) throw new Error(`There is no clip "${clip}".`);
	const doc = videoClipEffectDocument(at.clip, instance, provider.id);
	const session = await createEffectAuthoringSession({ document: doc }, { ...options, provider });
	return {
		clip,
		instance,
		session,
		async commit() {
			const { values, notes } = videoEffectValuesFromDocument(session.exportDocument());
			const result = await controller.updateClipEffect(clip, instance, { values: values as Record<string, EffectValue | { keys: VideoKey[] }> });
			return result.ok && notes.length ? { ...result, notes } : result;
		},
		dispose: () => session.dispose()
	};
}

/** The effects of a clip a host can open for authoring (enabled or not). */
export const videoAuthorableEffects = (clip: VideoClip): readonly VideoClipEffect[] => clip.effects ?? [];
