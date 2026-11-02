/**
 * Checking shot layers and transitions against an effects provider before they are saved, and
 * describing them for tools and panels. A layer's effect must be one a layer can show (a
 * generator, filter, overlay or title), take the subject it is given (or need none), and have
 * values and a preset that fit; a transition's effect must have the use `transition`. A preset's
 * values are written out, so the scene plays the same without the provider's presets.
 */

import { EffectUnsupportedError, NoEffectsProviderError } from '../effects/errors.js';
import { resolveEffectValues } from '../effects/helpers.js';
import { effectLayerInput, effectLayerOffered } from '../effects/templates.js';
import { EFFECT_TRANSITION_MS, type EffectDescription, type EffectProvider, type EffectValue } from '../effects/types.js';
import { compileMotionScene } from './compile.js';
import { motionIssue, type MotionIssue } from './issues.js';
import { motionLayerSpans } from './layers.js';
import type { MotionScene, MotionShotLayer, MotionShotTransition } from './types.js';

/** A layer as tools and panels report it: its fields, its shot and when it shows (ms). */
export interface MotionShotLayerInfo extends MotionShotLayer {
	shot: string;
	/** Its place in the shot (0 = bottom). */
	index: number;
	role: NonNullable<MotionShotLayer['role']>;
	start: number;
	end: number;
}

/** A shot's layers and transition. */
export interface MotionShotLayersInfo {
	shot: string;
	layers: MotionShotLayerInfo[];
	/** Its transition with when it plays, or null (the first shot never has one). */
	transition: (MotionShotTransition & { start: number; end: number }) | null;
}

/** Every shot's layers and transition (or one shot's). */
export function motionShotLayersInfo(scene: MotionScene, shot?: string): MotionShotLayersInfo[] {
	const spans = motionLayerSpans(scene);
	const timings = compileMotionScene(scene).shots;
	return scene.shots
		.filter((s) => shot === undefined || s.id === shot)
		.map((s) => {
			const timing = timings.find((t) => t.id === s.id)!;
			return {
				shot: s.id,
				layers: spans.filter((sp) => sp.shot === s.id).map((sp) => ({ ...sp.layer, shot: s.id, index: sp.index, role: sp.role, start: sp.start, end: sp.end })),
				transition: s.transition && timing.transitionEnd !== undefined ? { ...s.transition, start: timing.start, end: timing.transitionEnd } : null
			};
		});
}

/** The shot holding a layer, and its index there. */
export function findMotionShotLayer(scene: MotionScene, id: string): { shot: number; index: number } | null {
	for (let shot = 0; shot < scene.shots.length; shot++) {
		const index = (scene.shots[shot].layers ?? []).findIndex((l) => l.id === id);
		if (index >= 0) return { shot, index };
	}
	return null;
}

/** Every layer id in the scene. */
export const motionLayerIds = (scene: MotionScene): string[] => scene.shots.flatMap((s) => (s.layers ?? []).map((l) => l.id));

/** A free layer id: `layer1`, `layer2`… */
export function freshMotionLayerId(scene: MotionScene, base = 'layer'): string {
	const used = new Set(motionLayerIds(scene));
	for (let i = 1; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

const kindHint = (d: EffectDescription): string => {
	if (d.uses.includes('transition')) return 'it is a transition: set it between shots with set_shot_transition';
	if (d.kind === 'camera') return 'it is a camera move: set it with set_shot_camera_move';
	if (d.kind === 'motion') return 'it animates artwork nodes: apply it with apply_effect';
	return `its uses are ${d.uses.join(', ')}`;
};

/** A preset's values over `values` (a preset's values are written out). Throws naming the presets for an unknown one. */
function withPreset(d: EffectDescription, preset: string | undefined, values: Record<string, EffectValue> | undefined): Record<string, EffectValue> | undefined {
	if (preset === undefined) return values;
	const p = d.presets.find((x) => x.name === preset);
	if (!p) throw new EffectUnsupportedError(`"${d.id}" has no preset "${preset}"; ${d.presets.length ? `its presets are ${d.presets.map((x) => `"${x.name}"`).join(', ')}` : 'it has no presets'}.`, d.id);
	return { ...(p.values as Record<string, EffectValue>), ...(values ?? {}) };
}

/**
 * Checks a layer against the provider and returns it as it is saved (with the effect's provider
 * and name, a preset's values written out). Throws a sentence saying what to do for an effect
 * that cannot be a layer, a subject it cannot take (or a picture it needs and lacks), and values
 * or a preset that do not fit. A bare subject (no `effect`) needs no provider.
 */
export async function resolveMotionShotLayer(provider: EffectProvider | null, layer: MotionShotLayer): Promise<MotionShotLayer> {
	if (!layer.effect) {
		if (!layer.subject) throw new Error('A layer needs an "effect", a "subject" or both.');
		if (layer.preset !== undefined || layer.values !== undefined) throw new Error('A bare subject has no controls; leave out "preset" and "values", or give an "effect".');
		const { provider: _p, name: _n, ...rest } = layer;
		return rest;
	}
	if (!provider) throw new NoEffectsProviderError();
	const d = await provider.describe(layer.effect);
	if (!effectLayerOffered(d)) throw new EffectUnsupportedError(`"${d.id}" (${d.name}) cannot be a layer; ${kindHint(d)}. A layer's effect is a generator, filter, overlay or title (search_effects with use "generator", "filter", "overlay" or "title").`, d.id);
	const input = effectLayerInput(d);
	if (layer.subject && !input) throw new EffectUnsupportedError(`"${d.id}" (${d.name}) draws its own picture and takes no subject; leave "subject" out, or pick a filter to change the subject.`, d.id);
	if (!layer.subject && input && d.inputs.find((i) => i.name === input)?.required) throw new EffectUnsupportedError(`"${d.id}" (${d.name}) changes a picture; give a "subject": { "image": url }, { "svg": markup }, { "text": words } or { "slot": name }.`, d.id);
	const values = withPreset(d, layer.preset, layer.values);
	resolveEffectValues(d, values);
	const out: MotionShotLayer = { ...layer, provider: provider.id, name: d.name };
	if (values && Object.keys(values).length) out.values = values;
	else delete out.values;
	return out;
}

/** Checks a transition against the provider and returns it as it is saved (its length written out). */
export async function resolveMotionShotTransition(provider: EffectProvider | null, transition: MotionShotTransition): Promise<MotionShotTransition> {
	if (!provider) throw new NoEffectsProviderError();
	const d = await provider.describe(transition.effect);
	if (!d.uses.includes('transition') || d.kind === 'camera') throw new EffectUnsupportedError(`"${d.id}" (${d.name}) is not a transition (${kindHint(d)}); search_effects with use "transition" lists them.`, d.id);
	if (transition.ms !== undefined && !(transition.ms > 0 && transition.ms <= 60000)) throw new Error(`A transition's "ms" is from 1 to 60000; got ${transition.ms}.`);
	const values = withPreset(d, transition.preset, transition.values);
	resolveEffectValues(d, values);
	const out: MotionShotTransition = { ...transition, ms: transition.ms ?? EFFECT_TRANSITION_MS, provider: provider.id, name: d.name };
	if (values && Object.keys(values).length) out.values = values;
	else delete out.values;
	return out;
}

/**
 * Problems with the scene's shot layers and transitions against a provider: effects it does not
 * have or that do not fit (errors), empty slots (warnings), and, without a provider, notes that
 * effect layers are not drawn and transitions crossfade.
 */
export async function checkMotionShotLayers(scene: MotionScene, provider: EffectProvider | null | undefined): Promise<MotionIssue[]> {
	const issues: MotionIssue[] = [];
	if (scene.shots[0]?.transition) issues.push(motionIssue('transition-first-shot', `Shot "${scene.shots[0].id}" is the first shot, so its transition does not play; move it to a later shot or clear it.`, { shot: scene.shots[0].id }));
	for (const shot of scene.shots)
		for (const layer of shot.layers ?? [])
			if (layer.subject && 'slot' in layer.subject) issues.push(motionIssue('layer-slot-empty', `Layer "${layer.id}" shows slot "${layer.subject.slot}", which is empty; set its "subject" to a picture with update_shot_layer.`, { shot: shot.id, ids: [layer.id] }));
	const effectLayers = scene.shots.flatMap((s) => (s.layers ?? []).filter((l) => l.effect).map((l) => ({ shot: s.id, layer: l })));
	const transitions = scene.shots.slice(1).filter((s) => s.transition);
	if (!provider) {
		if (effectLayers.length) issues.push(motionIssue('layer-not-drawn', `Layers ${effectLayers.map((e) => `"${e.layer.id}"`).join(', ')} name provider effects, but no effects provider is set, so they are left out of frames; set a provider to draw them.`, { ids: effectLayers.map((e) => e.layer.id) }));
		if (transitions.length) issues.push(motionIssue('transition-not-played', `Shots ${transitions.map((s) => `"${s.id}"`).join(', ')} name transitions, but no effects provider is set, so they crossfade; set a provider to play them.`));
		return issues;
	}
	for (const { shot, layer } of effectLayers) {
		try {
			await resolveMotionShotLayer(provider, layer);
		} catch (error) {
			const code = (error as { code?: string }).code === 'invalid_values' || /preset/.test((error as Error).message) ? 'layer-effect-values' : 'layer-effect-unknown';
			issues.push(motionIssue(code, `Layer "${layer.id}": ${(error as Error).message}`, { shot, ids: [layer.id] }));
		}
	}
	for (const shot of transitions) {
		try {
			await resolveMotionShotTransition(provider, shot.transition!);
		} catch (error) {
			issues.push(motionIssue((error as { code?: string }).code === 'invalid_values' ? 'layer-effect-values' : 'transition-unknown', (error as Error).message, { shot: shot.id }));
		}
	}
	return issues;
}
