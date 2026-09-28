import type { CanvasInteractionPresetConfig } from './types.js';

export interface CanvasSelectionOptions {
	/**
	 * Whether spacebar panning is currently active (suspends marquee selection).
	 */
	isSpacebarPanning?: boolean;
	/**
	 * Selection mode: 'partial' (default) selects nodes intersected by selection box,
	 * 'full' requires nodes to be fully enclosed.
	 */
	selectionMode?: 'partial' | 'full';
	/**
	 * Additional keys that trigger multi-selection (default: ['Shift', 'Meta']).
	 */
	multiSelectionKey?: string[];
}

/**
 * Generates an interaction preset configured for left-click marquee drag-selection
 * while preserving middle-mouse and spacebar panning.
 */
export function getMarqueeSelectionPreset(
	options: CanvasSelectionOptions = {}
): CanvasInteractionPresetConfig {
	const isSpacebarPanning = options.isSpacebarPanning ?? false;

	return {
		snapGrid: [25, 25],
		panOnDrag: isSpacebarPanning ? [0, 1, 2] : [1, 2],
		panOnScroll: false,
		selectionOnDrag: !isSpacebarPanning,
		colorMode: 'system' as any,
		multiSelectionKey: options.multiSelectionKey ?? ['Shift', 'Meta'],
		selectionMode: (options.selectionMode ?? 'partial') as any
	};
}

/**
 * Keyboard listener helper to deselect nodes on Escape.
 */
export function handleDeselectOnEscape(
	event: KeyboardEvent,
	onDeselect: () => void
): boolean {
	if (event.key === 'Escape' || event.code === 'Escape') {
		onDeselect();
		return true;
	}
	return false;
}
