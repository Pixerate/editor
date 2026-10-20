/**
 * Agent tools for provider effects in the video editor: the shared effect tools
 * (`search_effects`, `describe_effect`, `list_applied_effects`, `apply_effect`, `update_effect`,
 * `remove_effect`) on clips, plus `add_video_effect_clip`, `set_video_effect_transition` and
 * `set_video_effect_keyframes`.
 */

import { createEffectToolProvider, type AppliedEffectInfo, type EffectChangeResult, type EffectTargetEffects } from '../effects/tools.js';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { EffectValue } from '../effects/types.js';
import type { VideoEditorController, VideoEffectEditResult } from './controller.js';
import { isVideoKeyframes, VIDEO_EASE_NAMES, type VideoKey } from './keyframes.js';
import { VIDEO_PLACEMENT_MODES, type VideoClip, type VideoEffectValues } from './types.js';
import { findVideoClip } from './timeline.js';

export interface VideoEffectsToolProviderOptions {
	/** Provider id (unique per registry). Default `video-effects`. */
	id?: string;
	/** Always prefix tool names with `<namespace>__`. */
	namespace?: string;
	/** The project cannot be edited: write tools are hidden. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
}

/** A clip's effects as the tools report them: its effect clip picture, its effect transition, then its stack. */
export function videoClipAppliedEffects(clip: VideoClip): AppliedEffectInfo[] {
	const out: AppliedEffectInfo[] = [];
	const ref = (r: { effect: string; name?: string; provider?: string }) => ({ effect: r.effect, ...(r.name ? { name: r.name } : {}), ...(r.provider ? { provider: r.provider } : {}) });
	if (clip.type === 'effect') out.push({ id: 'generator', ...ref(clip), role: 'effect clip', enabled: true, values: clip.values ?? {} });
	if (clip.transition?.type === 'effect' && clip.transition.effect) out.push({ id: 'transition', ...ref(clip.transition.effect), role: 'transition', enabled: true, values: { ...(clip.transition.effect.values ?? {}) }, duration: clip.transition.duration } as AppliedEffectInfo);
	(clip.effects ?? []).forEach((e, index) => out.push({ id: e.id, ...ref(e), role: 'clip effect', enabled: e.enabled !== false, ...(e.opacity !== undefined ? { opacity: e.opacity } : {}), values: e.values ?? {}, index }));
	return out;
}

const MS = (what: string) => ({ type: 'number', minimum: 0, description: `${what}, in milliseconds.` }) as const;
const KEYS = {
	type: 'array',
	minItems: 1,
	items: {
		type: 'object',
		properties: {
			t: { type: 'number', description: 'Clip-relative time in ms (0 = the clip\'s start).' },
			v: { type: 'number', description: 'The control\'s value at t, within its range from describe_effect.' },
			ease: { anyOf: [{ type: 'string', enum: [...VIDEO_EASE_NAMES] }, { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 }], description: 'How the value moves to the next key: linear (default), hold, ease-in, ease-out, ease-in-out, or CSS cubic-bezier [x1, y1, x2, y2].' }
		},
		required: ['t', 'v'],
		additionalProperties: false
	},
	description: 'Keys in any order (sorted for you), one per time.'
} as const;

/** The effect tools for a video editor (see the module comment). */
export function createVideoEffectsToolProvider(controller: VideoEditorController, options: VideoEffectsToolProviderOptions = {}): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const ro = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (ro) return typeof ro === 'string' ? ro : 'The video project is read-only.';
		return controller.readOnlyReason();
	};
	const clipOf = (id: string): VideoClip => {
		const at = findVideoClip(controller.getProject(), id);
		if (!at) {
			const ids = controller.getProject().tracks.flatMap((t) => t.clips.map((c) => c.id));
			throw new Error(`There is no clip "${id}"; the clips are ${ids.map((c) => `"${c}"`).join(', ') || 'none'} (get_video_project lists them).`);
		}
		return at.clip;
	};
	const result = (r: VideoEffectEditResult, target: string, instance?: string, extra: Record<string, unknown> = {}): EffectChangeResult => {
		if (!r.ok) throw new Error(r.error);
		const effects = videoClipAppliedEffects(clipOf(target));
		const effect = effects.find((e) => e.id === (instance ?? r.effect?.id)) ?? (r.effect ? { id: r.effect.id, effect: r.effect.effect, role: 'clip effect', enabled: r.effect.enabled !== false, values: r.effect.values ?? {} } : effects[0]);
		return { target, effect: effect!, effects, ...extra };
	};

	return createEffectToolProvider({
		id: options.id ?? 'video-effects',
		namespace: options.namespace,
		target: { noun: 'clip', id: 'A clip id from get_video_project (e.g. "c1").' },
		applyUses: ['filter', 'overlay'],
		applyDetails:
			'Filters change the clip\'s picture and overlays draw over it, in stack order, on the picture as it comes from the source, before the clip\'s grade, placement, opacity and blend; numbers may be keyframed (clip-relative ms). Transitions go through set_video_effect_transition and generators or titles through add_video_effect_clip. The preview renders them frame by frame; the ffmpeg export then needs rendered frames (see export_video_ffmpeg).',
		provider: () => controller.effectsProvider,
		readOnlyReason,
		list: (target) => {
			const clips: VideoClip[] = target ? [clipOf(target)] : controller.getProject().tracks.flatMap((t) => t.clips);
			return clips
				.map((c): EffectTargetEffects => ({ target: c.id, ...(c.name ? { name: c.name } : {}), effects: videoClipAppliedEffects(c) }))
				.filter((t) => target || t.effects.length);
		},
		apply: async (target, effect, args) => {
			clipOf(target);
			return result(await controller.applyClipEffect(target, effect, { values: args.values as VideoEffectValues | undefined, index: args.index, enabled: args.enabled, opacity: args.opacity }), target);
		},
		update: async (target, instance, changes) => {
			clipOf(target);
			if (instance === 'generator' || instance === 'transition') {
				const extra = (['enabled', 'opacity', 'index'] as const).filter((k) => changes[k] !== undefined);
				if (extra.length) throw new Error(`An ${instance === 'generator' ? 'effect clip' : 'effect transition'} only takes values; change its ${extra.join(', ')} with update_video_clip${instance === 'transition' ? ' or set_video_effect_transition' : ''}.`);
				const values = Object.fromEntries(Object.entries(changes.values ?? {}).filter(([, v]) => v !== null)) as VideoEffectValues;
				return result(await controller.updateEffectValues(target, instance, values), target, instance);
			}
			return result(await controller.updateClipEffect(target, instance, changes as Parameters<VideoEditorController['updateClipEffect']>[2]), target, instance);
		},
		remove: async (target, instance) => {
			const clip = clipOf(target);
			const was = videoClipAppliedEffects(clip).find((e) => e.id === instance);
			if (!was) throw new Error(`Clip "${target}" has no effect "${instance}"; its effects are ${videoClipAppliedEffects(clip).map((e) => `"${e.id}"`).join(', ') || 'none'}.`);
			if (instance === 'generator') throw new Error(`"${target}" is an effect clip: its effect is the clip itself. Delete the clip with delete_video_clips.`);
			if (instance === 'transition') {
				const r = controller.apply({ op: 'set_transition', clip: target, transition: null }, 'Remove transition');
				if (!r.ok) throw new Error(r.error);
				return { target, effect: was, effects: videoClipAppliedEffects(clipOf(target)) };
			}
			const r = controller.removeClipEffect(target, instance);
			if (!r.ok) throw new Error(r.error);
			return { target, effect: was, effects: videoClipAppliedEffects(clipOf(target)) };
		},
		subscribe: (notify) => controller.subscribe(() => notify()),
		extraTools: (ctx): AgentTool[] => [
			{
				name: 'add_video_effect_clip',
				title: 'Add an effect clip',
				description:
					'Adds a clip drawn by a provider generator, title or overlay effect (search_effects with use generator, title or overlay), filling the frame like a colour clip; transparent effects show the tracks beneath. It can be moved, trimmed, faded, graded and given clip effects like any clip. One undo step. Returns the new clip id and its effect. The ffmpeg export then needs rendered frames.',
				inputSchema: {
					type: 'object',
					properties: {
						track: { type: 'string', minLength: 1, description: 'A video track id from get_video_project (e.g. "v1"); earlier tracks draw on top.' },
						effect: ctx.effectIdSchema(['generator', 'title', 'overlay']),
						start: MS('Where it starts on the timeline (default: the end of the track)'),
						duration: { type: 'number', exclusiveMinimum: 0, description: 'Length in ms (default: the effect\'s own length, else 5000).' },
						values: ctx.valuesSchema('Control values over the effect\'s defaults', true),
						name: { type: 'string', minLength: 1, description: 'A label for the clip (default: the effect\'s name).' },
						mode: { type: 'string', enum: [...VIDEO_PLACEMENT_MODES], description: 'What to do with clips already there: refuse (default), overwrite or insert.' }
					},
					required: ['track', 'effect'],
					additionalProperties: false
				},
				annotations: { title: 'Add an effect clip', ...ctx.annotations.write },
				handler: async (args) => {
					ctx.requireProvider();
					const r = await controller.addEffectClip(args.track, args.effect, { start: args.start, duration: args.duration, values: args.values, name: args.name, mode: args.mode });
					if (!r.ok) throw new Error(r.error);
					return { clip: r.clip, track: args.track, effects: videoClipAppliedEffects(clipOf(r.clip)) };
				}
			},
			{
				name: 'set_video_effect_transition',
				title: 'Set an effect transition',
				description:
					'Sets a provider transition effect (search_effects with use transition) into a clip from the clip that ends where it starts on the same track, centred on the cut; like a crossfade it needs half its length in media past the cut on both sides. Replaces any transition there. One undo step. Returns the clip\'s effects. Remove it with remove_effect (effect "transition") or set_video_transition null.',
				inputSchema: {
					type: 'object',
					properties: {
						clip: { type: 'string', minLength: 1, description: 'The incoming clip (the one after the cut), from get_video_project.' },
						effect: ctx.effectIdSchema(['transition']),
						duration: { type: 'number', exclusiveMinimum: 0, description: 'Length in ms, centred on the cut (default: the effect\'s own length, else 1000).' },
						values: ctx.valuesSchema('Control values over the effect\'s defaults (plain values; transitions cannot be keyframed)')
					},
					required: ['clip', 'effect'],
					additionalProperties: false
				},
				annotations: { title: 'Set an effect transition', ...ctx.annotations.writeIdempotent },
				handler: async (args) => {
					ctx.requireProvider();
					const r = await controller.setEffectTransition(args.clip, args.effect, { duration: args.duration, values: args.values as Record<string, EffectValue> | undefined });
					if (!r.ok) throw new Error(r.error);
					return { clip: args.clip, transition: clipOf(args.clip).transition, effects: videoClipAppliedEffects(clipOf(args.clip)) };
				}
			},
			{
				name: 'set_video_effect_keyframes',
				title: 'Keyframe an effect control',
				description:
					'Animates one number control of a clip effect or an effect clip with keys at clip-relative times (ms), or with keys null stops animating it, keeping its value at the clip\'s start. Values are checked against the control\'s range from describe_effect. One undo step. Returns the effect.',
				inputSchema: {
					type: 'object',
					properties: {
						clip: { type: 'string', minLength: 1, description: 'A clip id from list_applied_effects.' },
						effect: { type: 'string', minLength: 1, description: 'The effect\'s id on the clip ("fx1", or "generator" for an effect clip\'s own effect).' },
						control: { type: 'string', minLength: 1, description: 'A number control name from describe_effect.' },
						keys: { anyOf: [KEYS, { type: 'null' }], description: 'The keys, or null to stop animating the control.' }
					},
					required: ['clip', 'effect', 'control', 'keys'],
					additionalProperties: false
				},
				annotations: { title: 'Keyframe an effect control', ...ctx.annotations.writeIdempotent },
				handler: async (args) => {
					ctx.requireProvider();
					const keys = args.keys as VideoKey[] | null;
					let r: VideoEffectEditResult;
					if (args.effect === 'generator') {
						const clip = clipOf(args.clip);
						if (clip.type !== 'effect') throw new Error(`Clip "${args.clip}" is not an effect clip; give the id of one of its effects (list_applied_effects).`);
						const was = clip.values?.[args.control];
						const plain = keys === null ? (isVideoKeyframes(was) ? was.keys[0]?.v : was) : { keys: [...keys].sort((a, b) => a.t - b.t) };
						if (plain === undefined) throw new Error(`"${args.control}" has no value to keep; give keys instead.`);
						r = await controller.updateEffectValues(args.clip, 'generator', { [args.control]: plain } as VideoEffectValues);
					} else r = await controller.setClipEffectKeyframes(args.clip, args.effect, args.control, keys);
					if (!r.ok) throw new Error(r.error);
					return { clip: args.clip, effect: videoClipAppliedEffects(clipOf(args.clip)).find((e) => e.id === args.effect) };
				}
			}
		]
	});
}
