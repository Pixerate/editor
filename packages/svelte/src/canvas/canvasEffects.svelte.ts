import { getContext, setContext, untrack } from "svelte";
import {
	createCanvasEffectsController,
	createCanvasEffectsToolProvider,
	type CanvasEffectsController,
	type CanvasEffectsControllerOptions,
	type CanvasEffectsToolProviderOptions,
	type CanvasNode,
} from "@pixerate/editor/canvas";
import type { EffectProvider } from "@pixerate/editor/effects";
import type { ToolRegistry } from "@pixerate/editor/tools";

const KEY = Symbol("pixerate-canvas-effects");

/**
 * Gives the shape nodes below the calling component an effects provider (see
 * `@pixerate/editor/effects`), so their `shape.effect` is drawn. Call during initialisation; pass
 * a getter to follow a changing provider. Without one effects are kept and not drawn.
 */
export function setCanvasEffectsProvider(provider: EffectProvider | null | undefined | (() => EffectProvider | null | undefined)): void {
	setContext(KEY, typeof provider === "function" ? provider : () => provider);
}

/** The effects provider set by an ancestor with `setCanvasEffectsProvider`, or `null`. */
export function getCanvasEffectsProvider(): EffectProvider | null {
	const get = getContext<(() => EffectProvider | null | undefined) | undefined>(KEY);
	return get?.() ?? null;
}

/**
 * A canvas effects controller (apply, change and remove node effects, scene transitions) for the
 * calling component, with `effects` (a getter follows changes) registered while given.
 */
export function createCanvasEffects<TNode extends CanvasNode = CanvasNode>(
	options: Omit<CanvasEffectsControllerOptions<TNode>, "effects"> & { effects?: EffectProvider | null | (() => EffectProvider | null | undefined) },
): CanvasEffectsController<TNode> {
	const controller = createCanvasEffectsController<TNode>({ getNodes: options.getNodes, setNodes: options.setNodes, history: options.history, scenes: options.scenes });
	$effect(() => {
		const p = typeof options.effects === "function" ? options.effects() : options.effects;
		if (!p) return;
		return untrack(() => controller.useEffects(p));
	});
	return controller;
}

/** Registers the canvas effect tools for the lifetime of the calling component. */
export function useCanvasEffectsTools(
	registry: ToolRegistry | null | undefined | (() => ToolRegistry | null | undefined),
	controller: CanvasEffectsController,
	options: CanvasEffectsToolProviderOptions = {},
): void {
	$effect(() => {
		const target = typeof registry === "function" ? registry() : registry;
		if (!target) return;
		return target.register(createCanvasEffectsToolProvider(controller, options));
	});
}
