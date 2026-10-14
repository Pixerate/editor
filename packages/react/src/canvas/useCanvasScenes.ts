import { useMemo, useRef, useSyncExternalStore } from 'react';
import {
	CanvasScenesStore,
	fitViewportToNodes,
	type CanvasNode,
	type CanvasScene,
	type CanvasScenesOptions,
	type CanvasViewport,
	type FitViewportOptions
} from '@pixerate/editor/canvas';

export interface UseCanvasScenesOptions extends CanvasScenesOptions {
	/** Reads the live viewport, used by `capture` / `recapture` (e.g. `useReactFlow().getViewport`). */
	getViewport?: () => CanvasViewport;
	/** Moves the canvas to a scene (e.g. `useReactFlow().setViewport`). */
	setViewport?: (viewport: CanvasViewport, options?: { duration?: number }) => void;
	/** Transition duration passed to `setViewport` when showing a scene (default 300ms). */
	duration?: number;
	/** Use an existing store (e.g. one shared with non-React code) instead of creating one. */
	store?: CanvasScenesStore;
}

/**
 * React hook for Freeform-style Scenes: named saved viewports with show next / previous,
 * reorder, rename and JSON persistence. Backed by the framework-agnostic
 * `CanvasScenesStore` through `useSyncExternalStore`.
 */
export function useCanvasScenes(options: UseCanvasScenesOptions = {}) {
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const storeRef = useRef<CanvasScenesStore | null>(null);
	if (!storeRef.current) storeRef.current = options.store ?? new CanvasScenesStore(options);
	const store = storeRef.current;

	const state = useSyncExternalStore(
		(listener) => store.subscribe(listener),
		() => store.getState(),
		() => store.getState()
	);

	const actions = useMemo(() => {
		const show = (scene: CanvasScene | undefined) => {
			if (scene) {
				optionsRef.current.setViewport?.(scene.viewport, { duration: optionsRef.current.duration ?? 300 });
			}
			return scene;
		};
		return {
			store,
			/** Saves the current viewport (or `viewport`) as a new scene. */
			capture(name?: string, extra: { viewport?: CanvasViewport; nodeIds?: string[]; index?: number } = {}) {
				const viewport = extra.viewport ?? optionsRef.current.getViewport?.();
				if (!viewport) throw new Error('[useCanvasScenes] capture() needs a viewport or a getViewport option.');
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
				const viewport = fitViewportToNodes(nodes, size, ids, fit);
				return viewport ? store.add({ viewport, name, nodeIds: ids }) : undefined;
			},
			/** Replaces a scene's viewport with the live one. */
			recapture(id: string) {
				const viewport = optionsRef.current.getViewport?.();
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
	}, [store]);

	return {
		...actions,
		scenes: state.scenes,
		currentId: state.currentId,
		currentIndex: state.currentIndex,
		current: state.currentIndex === -1 ? null : state.scenes[state.currentIndex]
	};
}

export type CanvasScenes = ReturnType<typeof useCanvasScenes>;
