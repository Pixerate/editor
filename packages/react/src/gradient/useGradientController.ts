import { useRef, useSyncExternalStore } from 'react';
import {
	GradientController,
	type GradientControllerOptions,
	type GradientState
} from '@pixerate/editor/gradient';

/**
 * Creates and owns a GradientController instance for the component's lifetime,
 * preserving it across re-renders.
 */
export function useGradientController(
	options?: GradientControllerOptions | (() => GradientControllerOptions)
): GradientController {
	const ref = useRef<GradientController | null>(null);
	if (!ref.current) {
		const resolvedOptions = typeof options === 'function' ? options() : options;
		ref.current = new GradientController(resolvedOptions);
	}
	return ref.current;
}

/**
 * Subscribes to a GradientController's state and re-renders when it changes.
 */
export function useGradientState(controller: GradientController): GradientState {
	return useSyncExternalStore(
		(onStoreChange) => controller.subscribe(onStoreChange),
		() => controller.state,
		() => controller.state
	);
}
