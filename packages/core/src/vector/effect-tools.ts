/**
 * Agent tools for provider effects in the vector editor: the shared effect tools, where
 * `apply_effect` adds a provider vector effect's picture (a lower third, a sticker, a loader) as
 * a group, `update_effect` draws it again with new values and `remove_effect` keeps its shapes as
 * a plain group. Motion is applied in the animation editor.
 */

import { createEffectToolProvider, type AppliedEffectInfo, type EffectChangeResult } from '../effects/tools.js';
import type { EffectValue } from '../effects/types.js';
import type { AgentToolProvider } from '../tools/registry.js';
import type { VectorEditorController } from './controller.js';
import type { VectorGroupNode } from './types.js';

export interface VectorEffectsToolProviderOptions {
	/** Provider id (unique per registry). Default `vector-effects`. */
	id?: string;
	/** Always prefix tool names with `<namespace>__`. */
	namespace?: string;
	/** The document cannot be edited: write tools are hidden. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
}

const info = (g: VectorGroupNode): AppliedEffectInfo => ({
	id: 'picture',
	effect: g.providerEffect!.effect,
	...(g.providerEffect!.name ? { name: g.providerEffect!.name } : {}),
	...(g.providerEffect!.provider ? { provider: g.providerEffect!.provider } : {}),
	role: 'vector picture',
	enabled: true,
	values: { ...g.providerEffect!.values }
});

/** The effect tools for a vector editor (see the module comment). */
export function createVectorEffectsToolProvider(controller: VectorEditorController, options: VectorEffectsToolProviderOptions = {}): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const ro = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		return ro ? (typeof ro === 'string' ? ro : 'The drawing is read-only.') : null;
	};
	const group = (id: string): VectorGroupNode => {
		const g = controller.vectorEffectGroups().find((n) => n.id === id);
		if (!g) throw new Error(`"${id}" is not a vector effect group; the groups are ${controller.vectorEffectGroups().map((n) => `"${n.id}"`).join(', ') || 'none'} (list_applied_effects).`);
		return g;
	};
	const result = (id: string, removed?: AppliedEffectInfo): EffectChangeResult => {
		const g = controller.getNode(id) as VectorGroupNode | undefined;
		const effects = g?.providerEffect ? [info(g)] : [];
		return { target: id, effect: removed ?? effects[0], effects };
	};
	return createEffectToolProvider({
		id: options.id ?? 'vector-effects',
		namespace: options.namespace,
		target: { noun: 'group', id: 'For apply_effect: "document" for the top level, or a group id to put the picture in. For update_effect and remove_effect: the effect group\'s id from list_applied_effects.' },
		applyUses: ['title', 'overlay', 'generator', 'interactive'],
		applyDetails:
			'Only vector effects (kind vector: lower thirds, stickers, loaders, badges) can be added: the effect\'s SVG at rest becomes a group of editable shapes, fitted into the middle half of the document and selected; move or scale it like any group. Its motion plays in the animation editor (add_vector_effect there). update_effect with effect "picture" draws it again with new values; remove_effect keeps the shapes as a plain group. index, enabled and opacity do not apply.',
		provider: () => controller.effectsProvider,
		readOnlyReason,
		list: (target) => {
			const groups = target ? [group(target)] : controller.vectorEffectGroups();
			return groups.map((g) => ({ target: g.id, ...(g.name ? { name: g.name } : {}), effects: [info(g)] }));
		},
		apply: async (target, effect, args) => {
			if (args.index !== undefined || args.opacity !== undefined || args.enabled === false) throw new Error('index, opacity and enabled do not apply to vector effects; set the group\'s opacity with the style commands.');
			if (target !== 'document') {
				const parent = controller.getNode(target);
				if (!parent || parent.type !== 'group') throw new Error(`"${target}" is not a group; pass "document" for the top level or a group id.`);
			}
			const id = await controller.addVectorEffect(effect, { values: args.values as Record<string, EffectValue> | undefined, ...(target !== 'document' ? { parentId: target } : {}) });
			return { ...result(id), group: id };
		},
		update: async (target, instance, changes) => {
			if (instance !== 'picture') throw new Error('A vector effect group has one effect, "picture".');
			const extra = (['enabled', 'opacity', 'index'] as const).filter((k) => changes[k] !== undefined);
			if (extra.length) throw new Error(`A vector effect only takes values; ${extra.join(', ')} do not apply.`);
			group(target);
			await controller.updateVectorEffect(target, (changes.values ?? {}) as Record<string, EffectValue | null>);
			return result(target);
		},
		remove: async (target, instance) => {
			if (instance !== 'picture') throw new Error('A vector effect group has one effect, "picture".');
			const was = info(group(target));
			controller.detachVectorEffect(target);
			return result(target, was);
		},
		subscribe: (notify) => controller.subscribe(() => notify())
	});
}
