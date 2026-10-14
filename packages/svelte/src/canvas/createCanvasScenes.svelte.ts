import {
	CanvasScenesStore,
	fitViewportToNodes,
	type CanvasScene,
	type CanvasScenesOptions,
	type CanvasScenesState,
	type CanvasViewport,
	type FitViewportOptions
} from '@pixerate/editor/canvas';
import type { CanvasNode } from './types.js';

export interface CreateCanvasScenesOptions extends CanvasScenesOptions {
	/** Reads the live viewport, used by `capture` / `recapture` (e.g. `useSvelteFlow().getViewport`). */
	getViewport?: () => CanvasViewport;
	/** Moves the canvas to a scene (e.g. `useSvelteFlow().setViewport`). */
	setViewport?: (viewport: CanvasViewport, options?: { duration?: number }) => void;
	/** Transition duration passed to `setViewport` when showing a scene (default 300ms). */
	duration?: number;
}

/**
 * Headless Svelte 5 rune for Freeform-style Scenes: named saved viewports with
 * show next / previous, reorder, rename and JSON persistence. Wraps the framework-agnostic
 * `CanvasScenesStore` from `@pixerate/editor/canvas`.
 */
export function createCanvasScenes(options: CreateCanvasScenesOptions = {}) {
	const store = new CanvasScenesStore(options);
	let state = $state.raw<CanvasScenesState>(store.getState());
	store.subscribe((next) => {
		state = next;
	});

	const show = (scene: CanvasScene | undefined) => {
		if (scene) options.setViewport?.(scene.viewport, { duration: options.duration ?? 300 });
		return scene;
	};

	return {
		store,
		get scenes() {
			return state.scenes;
		},
		get currentId() {
			return state.currentId;
		},
		get currentIndex() {
			return state.currentIndex;
		},
		get current() {
			return state.currentIndex === -1 ? null : state.scenes[state.currentIndex];
		},
		/** Saves the current viewport (or `viewport`) as a new scene. */
		capture(name?: string, extra: { viewport?: CanvasViewport; nodeIds?: string[]; index?: number } = {}) {
			const viewport = extra.viewport ?? options.getViewport?.();
			if (!viewport) throw new Error('[createCanvasScenes] capture() needs a viewport or a getViewport option.');
			return store.add({ viewport, name, nodeIds: extra.nodeIds }, extra.index);
		},
		/** Saves a scene framing the given nodes in a container of `size`. */
		captureNodes(
			nodes: CanvasNode[],
			ids: string[],
			size: { width: number; height: number },
			name?: string,
			fit?: FitViewportOptions
		) {
			const viewport = fitViewportToNodes(nodes as any[], size, ids, fit);
			return viewport ? store.add({ viewport, name, nodeIds: ids }) : undefined;
		},
		/** Replaces a scene's viewport with the live one. */
		recapture(id: string) {
			const viewport = options.getViewport?.();
			return viewport ? store.update(id, { viewport }) : undefined;
		},
		update: (id: string, patch: Partial<Omit<CanvasScene, 'id'>>) => store.update(id, patch),
		rename: (id: string, name: string) => store.rename(id, name),
		move: (id: string, toIndex: number) => store.move(id, toIndex),
		reorder: (ids: string[]) => store.reorder(ids),
		remove: (id: string) => store.remove(id),
		clear: () => store.clear(),
		goTo: (id: string) => show(store.goTo(id)),
		next: () => show(store.next()),
		previous: () => show(store.previous()),
		toJSON: () => store.toJSON(),
		serialize: () => store.serialize(),
		load: (input: string | unknown) => store.load(input)
	};
}

export type CanvasScenes = ReturnType<typeof createCanvasScenes>;
