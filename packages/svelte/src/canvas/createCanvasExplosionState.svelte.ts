import {
	createCanvasExplosionStateController,
	type CanvasExplosionState,
	type CanvasExplosionStateController,
	type CanvasExplosionStateOptions,
	type CanvasExplosionStateSnapshot
} from '@pixerate/editor/canvas';

export type { CanvasExplosionState, CanvasExplosionStateOptions };

export interface CanvasExplosionStateRune extends CanvasExplosionState {
	/** The framework-free controller underneath (for `canvasExplosionToolTarget` and agent tools). */
	readonly controller: CanvasExplosionStateController;
}

/**
 * Headless, declarative explosion state as a Svelte 5 rune: which node is exploded
 * (`activeId`), which is still collapsing (`collapsingId`, so its children can play a collapse
 * animation before unmounting), and the collapse timer. It never touches a graph: derive the
 * canvas from it with `$derived` and `computeCanvasExplosionLayout` /
 * `calculateDirectionalDisplacement`.
 *
 * Created during component initialisation it cleans up its timer when the component unmounts;
 * created elsewhere, call `destroy()` yourself.
 */
export function createCanvasExplosionState(options: CanvasExplosionStateOptions = {}): CanvasExplosionStateRune {
	const controller = createCanvasExplosionStateController(options);
	let snapshot = $state<CanvasExplosionStateSnapshot>(controller.getSnapshot());
	controller.subscribe(() => {
		snapshot = controller.getSnapshot();
	});

	try {
		$effect(() => () => controller.destroy());
	} catch {
		// Not inside a component or effect: the caller owns destroy().
	}

	return {
		controller,
		get activeId() {
			return snapshot.activeId;
		},
		get collapsingId() {
			return snapshot.collapsingId;
		},
		get isExplodingOrCollapsing() {
			return snapshot.activeId !== null || snapshot.collapsingId !== null;
		},
		isExploded: (nodeId) => snapshot.activeId === nodeId,
		isCollapsing: (nodeId) => snapshot.collapsingId === nodeId,
		shouldRenderChildren: (nodeId) => snapshot.activeId === nodeId || snapshot.collapsingId === nodeId,
		explode: (nodeId) => controller.explode(nodeId),
		collapse: (nodeId) => controller.collapse(nodeId),
		toggle: (nodeId) => controller.toggle(nodeId),
		finishCollapse: () => controller.finishCollapse(),
		destroy: () => controller.destroy()
	};
}
