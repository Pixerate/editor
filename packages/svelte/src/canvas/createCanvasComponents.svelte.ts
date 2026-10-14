import { untrack } from 'svelte';
import {
	createCanvasComponentsController,
	type CanvasComponentsControllerOptions
} from '@pixerate/editor/canvas';
import type { CanvasNode } from './types.js';

// SvelteFlow's `Node` allows `class` values (arrays / objects) that core's structural
// `CanvasNode` does not, so the core controller is typed loosely and re-typed here.
type CoreOptions = CanvasComponentsControllerOptions<any>;

export interface CreateCanvasComponentsOptions<TNode extends CanvasNode = CanvasNode>
	extends Omit<CoreOptions, 'getNodes' | 'setNodes' | 'onReveal'> {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	/** Called by `goToMainComponent` with the main (e.g. to pan the viewport to it). */
	onReveal?: (node: TNode) => void;
	/**
	 * Sync instances with their mains whenever the nodes `getNodes` reads change (default
	 * `true`; needs `getNodes` to read reactive state). Otherwise call `sync()` after edits.
	 */
	autoSync?: boolean;
}

/**
 * Headless Svelte 5 rune for Figma-style components and instances on a SvelteFlow canvas.
 * After node changes it records edits inside instances as overrides and rebuilds the
 * instances of edited main components (keeping overrides). Its actions (`createComponent`,
 * `createInstance`, `combineAsVariants`, `detachInstance`, `resetOverrides`, `pushOverrides`,
 * `swapInstance`, `setInstanceProperties`, `restoreMainComponent`, …) are undoable steps with a
 * `history`, and each has a `can…` check returning `true` or the reason it can't run. Call
 * `destroy()` to stop the automatic sync.
 */
export function createCanvasComponents<TNode extends CanvasNode = CanvasNode>(options: CreateCanvasComponentsOptions<TNode>) {
	const controller = createCanvasComponentsController<any>(options as CoreOptions);
	let stop: (() => void) | undefined;
	if (options.autoSync !== false) {
		stop = $effect.root(() => {
			$effect(() => {
				options.getNodes();
				untrack(() => controller.sync());
			});
		});
	}
	return {
		...controller,
		/** Stops the automatic sync. */
		destroy() {
			stop?.();
			stop = undefined;
		}
	};
}

export type CanvasComponents = ReturnType<typeof createCanvasComponents>;
