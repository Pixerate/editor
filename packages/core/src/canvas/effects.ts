/**
 * Provider effects on the canvas (see `@pixerate/editor/effects`): effect fills and overlays on
 * shape nodes (`data.shape.effect`), and transition effects into Scenes (`CanvasScene.transition`).
 *
 * The canvas has no single controller, so `createCanvasEffectsController` works like the other
 * canvas controllers: it reads and writes nodes through `getNodes` / `setNodes`, and records each
 * change as one undoable command on an optional `history`. The framework bindings draw the
 * effects (an animated canvas inside the node) and play scene transitions.
 */

import { EffectsSlot, resolveEffectValues } from '../effects/helpers.js';
import { EffectUnsupportedError } from '../effects/errors.js';
import type { EffectDescription, EffectProvider, EffectUse, EffectValue } from '../effects/types.js';
import type { Command } from '../history/types.js';
import type { CanvasSceneTransition, CanvasScenesStore } from './scenes.js';
import { isShapeDescription, type CanvasShapeEffect, type ShapeDescription } from './shapeGeometry.js';
import type { CanvasNode } from './types.js';

/** The uses each place takes. */
export const CANVAS_EFFECT_PLACES = {
	/** Paints a shape's inside. */
	fill: ['generator', 'interactive'],
	/** Draws over a node's box. */
	overlay: ['overlay', 'title', 'interactive', 'generator'],
	transition: ['transition']
} as const satisfies Record<string, readonly EffectUse[]>;

export type CanvasEffectPlace = keyof typeof CANVAS_EFFECT_PLACES;

/** The shape effect of a node, if it has one. */
export function canvasNodeEffect(node: CanvasNode): CanvasShapeEffect | undefined {
	const shape = (node.data as { shape?: unknown } | undefined)?.shape;
	return isShapeDescription(shape) ? (shape as ShapeDescription).effect : undefined;
}

export interface CanvasEffectsControllerOptions<TNode extends CanvasNode = CanvasNode> {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	/** When set, every change is one undoable command. */
	history?: { execute(command: Command): void };
	/** The Scenes store, for transitions between scenes. */
	scenes?: CanvasScenesStore;
	/** An effects provider (optional; set or change it later with `setEffectsProvider`). */
	effects?: EffectProvider | null;
}

/** Headless effects for a canvas (see the module comment). */
export function createCanvasEffectsController<TNode extends CanvasNode = CanvasNode>(options: CanvasEffectsControllerOptions<TNode>) {
	const slot = new EffectsSlot();
	if (options.effects) slot.set(options.effects);

	const describe = async (effect: string, place: CanvasEffectPlace): Promise<EffectDescription> => {
		const d = await slot.require().describe(effect);
		const allowed: readonly EffectUse[] = CANVAS_EFFECT_PLACES[place];
		if (d.kind === 'motion' || !d.uses.some((u) => allowed.includes(u))) {
			const where = place === 'transition' ? 'a scene transition' : place === 'fill' ? 'a fill' : 'an overlay';
			throw new EffectUnsupportedError(`"${d.id}" (${d.name}) is a ${d.uses.join(' / ')} effect and cannot be ${where}, which takes ${allowed.join(' or ')} effects; search_effects with use "${allowed[0]}" lists ones that fit.`, d.id);
		}
		return d;
	};

	const shapeNode = (id: string): { node: TNode; shape: ShapeDescription } => {
		const node = options.getNodes().find((n) => n.id === id);
		if (!node) throw new Error(`There is no node "${id}"; the nodes are ${options.getNodes().map((n) => `"${n.id}"`).slice(0, 20).join(', ') || 'none'}.`);
		const shape = (node.data as { shape?: unknown } | undefined)?.shape;
		if (!isShapeDescription(shape)) throw new Error(`Node "${id}" is not a shape; effects draw on shape nodes (data.shape).`);
		return { node, shape };
	};

	const commit = (label: string, next: TNode[]) => {
		const before = options.getNodes();
		if (options.history) options.history.execute({ name: label, execute: () => options.setNodes(next), undo: () => options.setNodes(before), redo: () => options.setNodes(next) } as Command);
		else options.setNodes(next);
	};

	const withEffect = (id: string, effect: CanvasShapeEffect | undefined): TNode[] =>
		options.getNodes().map((n) => {
			if (n.id !== id) return n;
			const shape = { ...((n.data as { shape: ShapeDescription }).shape) };
			if (effect) shape.effect = effect;
			else delete shape.effect;
			return { ...n, data: { ...(n.data as object), shape } } as TNode;
		});

	const mergeValues = (d: EffectDescription, was: Record<string, unknown>, values: Record<string, EffectValue | null>) => {
		const base = { ...(was as Record<string, EffectValue>) };
		const given: Record<string, EffectValue> = {};
		for (const [k, v] of Object.entries(values)) {
			if (v !== null) given[k] = v;
			else if (k in d.controls.properties) base[k] = d.defaults[k];
			else throw new Error(`"${k}" is not a control of "${d.id}"; its controls are ${Object.keys(d.controls.properties).join(', ')}.`);
		}
		return { ...base, ...resolveEffectValues({ ...d, defaults: base }, given) };
	};

	return {
		/** The provider slot. */
		effects: slot,
		get effectsProvider(): EffectProvider | null {
			return slot.provider;
		},
		/** Registers (or with `null` removes) the effects provider. */
		setEffectsProvider(provider: EffectProvider | null) {
			slot.set(provider);
		},
		/** Registers `provider` and returns a function that removes it again. */
		useEffects(provider: EffectProvider) {
			return slot.use(provider);
		},
		/** The shape nodes that carry effects (or one node's). */
		list(nodeId?: string): { nodeId: string; effect: CanvasShapeEffect }[] {
			return options
				.getNodes()
				.filter((n) => !nodeId || n.id === nodeId)
				.map((n) => ({ nodeId: n.id, effect: canvasNodeEffect(n) }))
				.filter((e): e is { nodeId: string; effect: CanvasShapeEffect } => !!e.effect);
		},
		/**
		 * Draws a provider effect on a shape node: `fill` paints its inside (generators), `overlay`
		 * draws over its box (overlays, titles, interactive effects). Replaces any effect it had. One
		 * undoable step. Returns the effect.
		 */
		async applyNodeEffect(nodeId: string, effect: string, opts: { mode?: 'fill' | 'overlay'; values?: Record<string, EffectValue>; opacity?: number } = {}): Promise<CanvasShapeEffect> {
			shapeNode(nodeId);
			const mode = opts.mode ?? 'fill';
			const d = await describe(effect, mode);
			if (opts.opacity !== undefined && !(opts.opacity >= 0 && opts.opacity <= 1)) throw new Error('opacity must be from 0 to 1.');
			const next: CanvasShapeEffect = { effect: d.id, provider: slot.require().id, name: d.name, values: resolveEffectValues(d, opts.values) as CanvasShapeEffect['values'], mode, ...(opts.opacity !== undefined && opts.opacity !== 1 ? { opacity: opts.opacity } : {}) };
			commit(`Add effect ${d.name}`, withEffect(nodeId, next));
			return next;
		},
		/** Changes a node's effect: `values` merged (`null` resets), `mode`, `opacity`, `playing`. One undoable step. */
		async updateNodeEffect(nodeId: string, changes: { values?: Record<string, EffectValue | null>; mode?: 'fill' | 'overlay'; opacity?: number; playing?: boolean }): Promise<CanvasShapeEffect> {
			const { shape } = shapeNode(nodeId);
			const was = shape.effect;
			if (!was) throw new Error(`Node "${nodeId}" has no effect; add one with apply_effect.`);
			const next: CanvasShapeEffect = { ...was };
			if (changes.values || changes.mode) {
				const d = await describe(was.effect, changes.mode ?? was.mode);
				if (changes.values) next.values = mergeValues(d, was.values, changes.values) as CanvasShapeEffect['values'];
				if (changes.mode) next.mode = changes.mode;
			} else slot.require();
			if (changes.opacity !== undefined) {
				if (!(changes.opacity >= 0 && changes.opacity <= 1)) throw new Error('opacity must be from 0 to 1.');
				if (changes.opacity === 1) delete next.opacity;
				else next.opacity = changes.opacity;
			}
			if (changes.playing !== undefined) {
				if (changes.playing) delete next.playing;
				else next.playing = false;
			}
			commit(`Change effect ${was.name ?? was.effect}`, withEffect(nodeId, next));
			return next;
		},
		/** Removes a node's effect (works without a provider). One undoable step. */
		removeNodeEffect(nodeId: string): CanvasShapeEffect {
			const { shape } = shapeNode(nodeId);
			if (!shape.effect) throw new Error(`Node "${nodeId}" has no effect.`);
			commit(`Remove effect ${shape.effect.name ?? shape.effect.effect}`, withEffect(nodeId, undefined));
			return shape.effect;
		},
		/** The scenes, in order (empty without a Scenes store). */
		scenes() {
			return options.scenes?.getState().scenes ?? [];
		},
		/** The transition into a scene, if it has one. */
		sceneTransition(sceneId: string): CanvasSceneTransition | undefined {
			return options.scenes?.getScene(sceneId)?.transition;
		},
		/**
		 * Sets (or with `effect` null removes) the provider transition played when the canvas moves to
		 * a scene. Returns the transition.
		 */
		async setSceneTransition(sceneId: string, effect: string | null, opts: { values?: Record<string, EffectValue>; duration?: number } = {}): Promise<CanvasSceneTransition | null> {
			const scenes = options.scenes;
			if (!scenes) throw new Error('This canvas has no Scenes store.');
			if (!scenes.getScene(sceneId)) throw new Error(`There is no scene "${sceneId}"; the scenes are ${scenes.getState().scenes.map((s) => `"${s.id}"`).join(', ') || 'none'}.`);
			if (effect === null) {
				scenes.update(sceneId, { transition: undefined });
				return null;
			}
			const d = await describe(effect, 'transition');
			const duration = opts.duration ?? d.duration ?? 600;
			if (!(duration > 0)) throw new Error('duration must be a number of ms above 0.');
			const transition: CanvasSceneTransition = { effect: d.id, provider: slot.require().id, name: d.name, values: resolveEffectValues(d, opts.values) as CanvasSceneTransition['values'], duration };
			scenes.update(sceneId, { transition });
			return transition;
		}
	};
}

export type CanvasEffectsController<TNode extends CanvasNode = CanvasNode> = ReturnType<typeof createCanvasEffectsController<TNode>>;
