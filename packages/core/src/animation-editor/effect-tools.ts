/**
 * Agent tools for provider effects in the animation editor: the shared effect tools on artwork
 * nodes (`apply_effect` applies a motion effect, made into commands) and `add_vector_effect`
 * for vector effects that bring their own picture, and the camera move tools (`list_camera_moves`,
 * `set_shot_camera_move`, `clear_shot_camera_move`).
 */

import { effectTemplateTools } from '../effects/template-tools.js';
import { animationShotLayerTools } from './layer-tools.js';
import { animationCameraMoveTools } from './camera-tools.js';
import { withAnimationPlayback } from './playback.js';
import { createEffectToolProvider, type AppliedEffectInfo, type EffectChangeResult } from '../effects/tools.js';
import type { EffectValue } from '../effects/types.js';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { AnimationEditorController, MotionEffectResult } from './controller.js';
import type { AppliedMotionEffect } from './effects.js';

export interface AnimationEffectsToolProviderOptions {
	/** Provider id (unique per registry). Default `animation-effects`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** The scene cannot be edited: write tools are hidden. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
	/**
	 * The agent playback surface its calls are acted out on (default `animation`, where `AnimationEditor` attaches).
	 * Set it when one registry holds several editors of this kind, each attached under its own surface id.
	 */
	playbackSurface?: string;
}

const info = (e: AppliedMotionEffect): AppliedEffectInfo =>
	({ id: e.instance, effect: e.effect, ...(e.name ? { name: e.name } : {}), ...(e.provider ? { provider: e.provider } : {}), role: e.kind === 'vector' ? 'vector picture' : 'motion', enabled: true, values: e.values, targets: e.targets, shots: e.shots }) as AppliedEffectInfo;

/** The effect tools for an animation editor (see the module comment). */
export function createAnimationEffectsToolProvider(controller: AnimationEditorController, options: AnimationEffectsToolProviderOptions = {}): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const ro = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (ro) return typeof ro === 'string' ? ro : 'The animation is read-only.';
		return controller.readOnlyReason();
	};
	const done = (r: MotionEffectResult, target: string): EffectChangeResult => {
		if (!r.ok) throw new Error(r.error);
		return { target, effect: info(r.effect), effects: controller.appliedEffects().filter((e) => e.targets.includes(target)).map(info), ...(r.notes.length ? { notes: r.notes } : {}) };
	};
	return withAnimationPlayback(createEffectToolProvider({
		id: options.id ?? 'animation-effects',
		namespace: options.namespace,
		title: 'Animation effects',
		description: 'Provider motion effects on nodes of the animation artwork.',
		skill: 'pixerate-animation-editor',
		target: { noun: 'node', id: 'A node id of the artwork from get_animation (a group animates as one).' },
		applyUses: ['motion'],
		applyDetails:
			'The provider animates the node and its changes become ordinary commands (enter, fade, move, pulse…), in a new shot after the last one, tagged with the effect so it can be changed or removed as a whole. They preview, play and export to Flair like any command. Vector effects with their own picture go through add_vector_effect. index, enabled and opacity do not apply here.',
		provider: () => controller.effectsProvider,
		readOnlyReason,
		list: (target) => {
			const all = controller.appliedEffects();
			if (target) return [{ target, effects: all.filter((e) => e.targets.includes(target)).map(info) }];
			const byTarget = new Map<string, AppliedEffectInfo[]>();
			for (const e of all) {
				const key = e.targets[0] ?? e.instance;
				byTarget.set(key, [...(byTarget.get(key) ?? []), info(e)]);
			}
			return [...byTarget].map(([t, effects]) => ({ target: t, effects }));
		},
		apply: async (target, effect, args) => {
			if (args.index !== undefined || args.opacity !== undefined || args.enabled === false) throw new Error('index, opacity and enabled do not apply to motion effects; the effect becomes commands in a new shot.');
			return done(await controller.applyMotionEffect(effect, [target], { values: args.values as Record<string, EffectValue> | undefined }), target);
		},
		update: async (target, instance, changes) => {
			const extra = (['enabled', 'opacity', 'index'] as const).filter((k) => changes[k] !== undefined);
			if (extra.length) throw new Error(`A motion effect only takes values; ${extra.join(', ')} do not apply (move or delete its commands with edit_animation).`);
			return done(await controller.updateMotionEffect(instance, (changes.values ?? {}) as Record<string, EffectValue | null>), target);
		},
		remove: async (target, instance) => done(controller.removeMotionEffect(instance), target),
		subscribe: (notify) => controller.subscribe(() => notify()),
		extraTools: (ctx): AgentTool[] => [
			...animationCameraMoveTools(controller, ctx),
			...animationShotLayerTools(controller, ctx),
			...effectTemplateTools(
				{
					provider: () => controller.effectsProvider,
					fillDetails:
						'mode replace (default) makes a new scene from the template\'s shots, the size of its stage; mode append adds its shots after the current ones, scaled to the artwork. Each shot keeps its framing and camera moves, its layers and its transition; its title and caption become overlay word layers. Returns { template, mode, shots (new shot ids), layers (new layer ids), openSlots, notes }. Check the result with render_animation_frame.',
					fillOptions: { mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default): a new scene from the template; append: its shots after the current ones.' } },
					fill: async (template, values, options) => {
						const r = await controller.fillTemplate(template, values, { name: options.name as string | undefined, mode: options.mode as 'replace' | 'append' | undefined });
						if (!r.ok) throw new Error(r.error);
						const { ok: _ok, ...rest } = r;
						return rest;
					}
				},
				ctx
			),
			{
				name: 'add_vector_effect',
				title: 'Add a vector effect',
				description:
					'Adds a provider vector effect that brings its own picture (search_effects with kind vector: lower thirds, loaders, stickers): its SVG becomes an artwork group, fitted into box (default the whole artwork), and its motion becomes shots after the last one. For an effect that draws along a path (search_effects accepts ["path"]: a signature, a route), pass path: { node } to run it along a path node (its outline with every transform applied; the picture then lands on the node at scale 1 unless box is given) or { text } for words the provider writes. Use it instead of follow or draw-on when the effect itself should trace the path. The path is copied when added; add it again after reshaping the node. Change it with update_effect (target and effect: the returned instance) or remove it with remove_effect. One undo step. Returns the instance, the group id and any notes on what could not be carried over.',
				inputSchema: {
					type: 'object',
					properties: {
						effect: { type: 'string', minLength: 1, description: 'A vector effect id from search_effects (kind vector).' },
						values: ctx.valuesSchema("Control values over the effect's defaults"),
						box: {
							type: 'object',
							properties: {
								x: { type: 'number', description: 'Left edge, artwork units.' },
								y: { type: 'number', description: 'Top edge, artwork units.' },
								width: { type: 'number', exclusiveMinimum: 0, description: 'Width, artwork units.' },
								height: { type: 'number', exclusiveMinimum: 0, description: 'Height, artwork units.' }
							},
							required: ['x', 'y', 'width', 'height'],
							additionalProperties: false,
							description: 'Where the picture goes in the artwork, fitted keeping its proportions (default the whole artwork; with path { node }, on the node at scale 1).'
						},
						path: {
							type: 'object',
							description: 'The path the effect draws along (only for effects with a path control): { node } or { text }.',
							properties: {
								node: { type: 'string', minLength: 1, description: 'A path node id (find_animation_elements).' },
								text: { type: 'string', minLength: 1, description: 'Words the provider writes as a single-stroke path.' },
								font: { type: 'string', minLength: 1, description: 'With text: a single-stroke font the provider offers (default its first).' },
								align: { type: 'string', enum: ['start', 'middle', 'end'], description: 'With text: where the line sits (default start).' }
							},
							oneOf: [{ required: ['node'] }, { required: ['text'] }],
							additionalProperties: false
						},
						control: { type: 'string', minLength: 1, description: 'Which path control takes the path (default the effect\'s only one; describe_effect pathControls lists them).' }
					},
					required: ['effect'],
					additionalProperties: false
				},
				annotations: { title: 'Add a vector effect', ...ctx.annotations.write },
				handler: async (args) => {
					ctx.requireProvider();
					const path = args.path ? (args.path.node !== undefined ? { node: args.path.node } : { text: args.path.text, font: args.path.font, align: args.path.align }) : undefined;
					if (args.path && args.path.node !== undefined && args.path.text !== undefined) throw new Error('Pass path as { node } or { text }, not both.');
					const r = await controller.addVectorEffect(args.effect, { values: args.values, box: args.box, path, control: args.control });
					if (!r.ok) throw new Error(r.error);
					return { instance: r.effect.instance, group: r.effect.group, effect: info(r.effect), ...(r.notes.length ? { notes: r.notes } : {}) };
				}
			}
		]
	}), options.playbackSurface);
}
