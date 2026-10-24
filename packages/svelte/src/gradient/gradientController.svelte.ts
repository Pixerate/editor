import {
	GradientController,
	type GradientControllerOptions,
	type GradientState
} from '@pixerate/editor/gradient';

export interface SvelteGradient {
	readonly controller: GradientController;
	/** The controller's state (reactive). */
	readonly state: GradientState;
	/** Stops listening to the controller. */
	destroy(): void;
}

/**
 * Svelte 5 rune: subscribes to a `GradientController` (or creates one from options)
 * and exposes its state reactively.
 */
export function createGradientController(
	controllerOrOptions?: GradientController | GradientControllerOptions
): SvelteGradient {
	const controller =
		controllerOrOptions instanceof GradientController
			? controllerOrOptions
			: new GradientController(controllerOrOptions);

	let state = $state.raw(controller.state);
	const unsubscribe = controller.subscribe((next) => {
		state = next;
	});

	return {
		controller,
		get state() {
			return state;
		},
		destroy: unsubscribe
	};
}
