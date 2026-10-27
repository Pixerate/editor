import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
	createCanvasExplosionStateController,
	type CanvasExplosionState,
	type CanvasExplosionStateController,
	type CanvasExplosionStateOptions
} from '@pixerate/editor/canvas';

export type { CanvasExplosionState, CanvasExplosionStateOptions };

export interface CanvasExplosionStateHandle extends CanvasExplosionState {
	/** The framework-free controller underneath (for `canvasExplosionToolTarget` and agent tools). */
	readonly controller: CanvasExplosionStateController;
}

/**
 * Headless, declarative explosion state as a React hook: which node is exploded (`activeId`),
 * which is still collapsing (`collapsingId`, so its children can play a collapse animation
 * before unmounting), and the collapse timer. It never touches a graph: derive the canvas from
 * it with `useMemo` and `computeCanvasExplosionLayout` / `calculateDirectionalDisplacement`.
 * The same API and lifecycle as the Svelte `createCanvasExplosionState`.
 *
 * `collapseDurationMs` and `initialActiveId` are read once; the callbacks always call the latest
 * props. A running collapse ends (and its timer is cleared) on unmount.
 */
export function useCanvasExplosionState(options: CanvasExplosionStateOptions = {}): CanvasExplosionStateHandle {
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const controllerRef = useRef<CanvasExplosionStateController | null>(null);
	if (controllerRef.current === null) {
		controllerRef.current = createCanvasExplosionStateController({
			collapseDurationMs: options.collapseDurationMs,
			initialActiveId: options.initialActiveId,
			onExplode: (id) => optionsRef.current.onExplode?.(id),
			onCollapse: (id) => optionsRef.current.onCollapse?.(id)
		});
	}
	const controller = controllerRef.current;

	// On unmount, end any running collapse (clears its timer). Not destroy(): StrictMode runs this
	// cleanup and then mounts again with the same controller, which must keep working.
	useEffect(() => () => controller.finishCollapse(), [controller]);

	const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

	return useMemo<CanvasExplosionStateHandle>(
		() => ({
			controller,
			activeId: snapshot.activeId,
			collapsingId: snapshot.collapsingId,
			isExplodingOrCollapsing: snapshot.activeId !== null || snapshot.collapsingId !== null,
			isExploded: (nodeId) => snapshot.activeId === nodeId,
			isCollapsing: (nodeId) => snapshot.collapsingId === nodeId,
			shouldRenderChildren: (nodeId) => snapshot.activeId === nodeId || snapshot.collapsingId === nodeId,
			explode: (nodeId) => controller.explode(nodeId),
			collapse: (nodeId) => controller.collapse(nodeId),
			toggle: (nodeId) => controller.toggle(nodeId),
			finishCollapse: () => controller.finishCollapse(),
			destroy: () => controller.destroy()
		}),
		[controller, snapshot]
	);
}
