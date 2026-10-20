/**
 * Agent tools for provider effects on the canvas: the shared effect tools on shape nodes
 * (`apply_effect` fills a shape with a generator or lays an overlay over it), plus
 * `set_canvas_effect_mode`, `list_scene_transitions` and `set_scene_transition`.
 */

import { createEffectToolProvider, type AppliedEffectInfo, type EffectChangeResult } from '../effects/tools.js';
import type { EffectValue } from '../effects/types.js';
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { CanvasEffectsController } from './effects.js';
import type { CanvasShapeEffect } from './shapeGeometry.js';

export interface CanvasEffectsToolProviderOptions {
	/** Provider id (unique per registry). Default `canvas-effects`. */
	id?: string;
	/** Always prefix tool names with `<namespace>__`. */
	namespace?: string;
	/** The canvas cannot be edited: write tools are hidden. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
	/** Lets the tool list follow changes (e.g. the host's node store subscribe). */
	subscribe?: (notify: () => void) => () => void;
}

const info = (e: CanvasShapeEffect): AppliedEffectInfo => ({
	id: 'effect',
	effect: e.effect,
	...(e.name ? { name: e.name } : {}),
	...(e.provider ? { provider: e.provider } : {}),
	role: e.mode === 'fill' ? 'fill' : 'overlay',
	enabled: e.playing !== false,
	opacity: e.opacity ?? 1,
	values: { ...e.values }
});

/** The effect tools for a canvas (see the module comment). */
export function createCanvasEffectsToolProvider(controller: CanvasEffectsController, options: CanvasEffectsToolProviderOptions = {}): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const ro = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		return ro ? (typeof ro === 'string' ? ro : 'The canvas is read-only.') : null;
	};
	const result = (nodeId: string, effect?: CanvasShapeEffect): EffectChangeResult => {
		const now = controller.list(nodeId)[0]?.effect;
		return { target: nodeId, effect: info((effect ?? now)!), effects: now ? [info(now)] : [] };
	};
	const once = (instance: string) => {
		if (instance !== 'effect') throw new Error('A shape node has one effect, "effect".');
	};
	return createEffectToolProvider({
		id: options.id ?? 'canvas-effects',
		namespace: options.namespace,
		target: { noun: 'node', id: 'A shape node id on the canvas (a node with data.shape).' },
		applyUses: ['generator', 'overlay', 'title', 'interactive'],
		applyDetails:
			'Generators fill the shape (clipped to its outline); overlays, titles and interactive effects draw over the node\'s box (set_canvas_effect_mode switches). A node has one effect: this replaces it. enabled false holds the first frame; opacity mixes it. index does not apply.',
		provider: () => controller.effectsProvider,
		readOnlyReason,
		list: (target) => controller.list(target).map((e) => ({ target: e.nodeId, effects: [info(e.effect)] })),
		apply: async (target, effect, args) => {
			if (args.index !== undefined) throw new Error('index does not apply: a shape node has one effect.');
			const provider = controller.effectsProvider;
			const d = provider ? await provider.describe(effect) : null;
			const mode = d && !d.uses.includes('generator') ? 'overlay' : 'fill';
			const applied = await controller.applyNodeEffect(target, effect, { mode, values: args.values as Record<string, EffectValue> | undefined, opacity: args.opacity });
			if (args.enabled === false) await controller.updateNodeEffect(target, { playing: false });
			return result(target, args.enabled === false ? { ...applied, playing: false } : applied);
		},
		update: async (target, instance, changes) => {
			once(instance);
			if (changes.index !== undefined) throw new Error('index does not apply: a shape node has one effect.');
			const e = await controller.updateNodeEffect(target, { values: changes.values as Record<string, EffectValue | null> | undefined, opacity: changes.opacity, playing: changes.enabled });
			return result(target, e);
		},
		remove: async (target, instance) => {
			once(instance);
			const was = controller.removeNodeEffect(target);
			return { target, effect: info(was), effects: [] };
		},
		subscribe: options.subscribe ? (notify) => options.subscribe!(notify) : (notify) => controller.effects.subscribe(() => notify()),
		extraTools: (ctx): AgentTool[] => [
			{
				name: 'set_canvas_effect_mode',
				title: "Set a node effect's mode",
				description: 'Switches a shape node\'s effect between fill (paints the inside, clipped to the outline) and overlay (draws over the node\'s box). One undoable step. Returns the effect.',
				inputSchema: {
					type: 'object',
					properties: {
						node: { type: 'string', minLength: 1, description: 'A shape node id from list_applied_effects.' },
						mode: { type: 'string', enum: ['fill', 'overlay'], description: 'fill or overlay.' }
					},
					required: ['node', 'mode'],
					additionalProperties: false
				},
				annotations: { title: "Set a node effect's mode", ...ctx.annotations.writeIdempotent },
				handler: async (args) => {
					ctx.requireProvider();
					return { node: args.node, effect: info(await controller.updateNodeEffect(args.node, { mode: args.mode })) };
				}
			},
			{
				name: 'list_scene_transitions',
				title: 'List scene transitions',
				description: 'Lists the canvas Scenes in order with the transition effect played when moving to each (or null). Works without a provider.',
				inputSchema: { type: 'object', properties: {}, additionalProperties: false },
				annotations: { title: 'List scene transitions', ...ctx.annotations.read },
				handler: () => ({ scenes: controller.scenes().map((s) => ({ id: s.id, name: s.name, transition: s.transition ?? null })) })
			},
			{
				name: 'set_scene_transition',
				title: 'Set a scene transition',
				description:
					'Sets the provider transition effect (search_effects with use transition) played when the canvas moves to a scene: the view before and after are captured and the effect blends between them. effect null removes it. Returns the transition.',
				inputSchema: {
					type: 'object',
					properties: {
						scene: { type: 'string', minLength: 1, description: 'A scene id from list_scene_transitions.' },
						effect: { anyOf: [ctx.effectIdSchema(['transition']), { type: 'null' }], description: 'A transition effect id from search_effects, or null to remove the transition.' },
						values: ctx.valuesSchema("Control values over the effect's defaults"),
						duration: { type: 'number', exclusiveMinimum: 0, description: "Length in ms (default: the effect's own, else 600)." }
					},
					required: ['scene', 'effect'],
					additionalProperties: false
				},
				annotations: { title: 'Set a scene transition', ...ctx.annotations.writeIdempotent },
				handler: async (args) => {
					if (args.effect !== null) ctx.requireProvider();
					return { scene: args.scene, transition: await controller.setSceneTransition(args.scene, args.effect, { values: args.values, duration: args.duration }) };
				}
			}
		]
	});
}
