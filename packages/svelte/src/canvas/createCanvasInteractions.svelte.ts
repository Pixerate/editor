import type { ColorMode } from '@xyflow/svelte';
import { isEventFromTextInput } from './createCanvasClipboard.svelte.js';
import type { CanvasInteractionPresetConfig } from './types.js';

export interface CreateCanvasInteractionsOptions {
	targetElement?: HTMLElement | Window;
	onPanModeChange?: (active: boolean) => void;
	onTrackpadDetected?: () => void;
}

/**
 * Headless Svelte 5 rune managing canvas pan interactions (spacebar panning, trackpad pinch detection).
 */
export function createCanvasInteractions(options: CreateCanvasInteractionsOptions = {}) {
	let isSpacebarPanning = $state.raw(false);
	let trackpadDetected = $state.raw(false);
	let toggledPanMode = false;

	function handleKeyDown(event: KeyboardEvent) {
		if (event.key === ' ' || event.code === 'Space') {
			if (isSpacebarPanning || isEventFromTextInput(event)) return;
			isSpacebarPanning = true;
			toggledPanMode = true;
			options.onPanModeChange?.(true);

			if (typeof document !== 'undefined') {
				document.body.classList.add('cursor-grab');
			}
		}
	}

	function handleKeyUp(event: KeyboardEvent) {
		if (event.key === ' ' || event.code === 'Space') {
			if (!isSpacebarPanning && !toggledPanMode) return;
			isSpacebarPanning = false;
			toggledPanMode = false;
			options.onPanModeChange?.(false);

			if (typeof document !== 'undefined') {
				document.body.classList.remove('cursor-grab');
			}
		}
	}

	function handleWheel(event: WheelEvent) {
		if (event.ctrlKey && !trackpadDetected) {
			trackpadDetected = true;
			options.onTrackpadDetected?.();
		}
	}

	function attachListeners(target?: HTMLElement | Window): () => void {
		const el = target ?? options.targetElement ?? (typeof window !== 'undefined' ? window : null);
		if (!el) return () => {};

		el.addEventListener('keydown', handleKeyDown as EventListener);
		el.addEventListener('keyup', handleKeyUp as EventListener);
		el.addEventListener('wheel', handleWheel as EventListener, { passive: true });

		return () => {
			el.removeEventListener('keydown', handleKeyDown as EventListener);
			el.removeEventListener('keyup', handleKeyUp as EventListener);
			el.removeEventListener('wheel', handleWheel as EventListener);
			if (typeof document !== 'undefined') {
				document.body.classList.remove('cursor-grab');
			}
		};
	}

	return {
		get isSpacebarPanning() {
			return isSpacebarPanning;
		},
		get trackpadDetected() {
			return trackpadDetected;
		},
		attachListeners,
		destroy: attachListeners()
	};
}

/**
 * Default interaction configuration presets for SvelteFlow.
 */
export const defaultSvelteFlowPreset: CanvasInteractionPresetConfig = {
	snapGrid: [25, 25],
	panOnDrag: [0, 1, 2, 3, 4],
	panOnScroll: false,
	selectionOnDrag: false,
	colorMode: 'system' as ColorMode,
	multiSelectionKey: ['Shift', 'Meta']
};

/**
 * Miro-compatible interaction preset (middle/right drag to pan, left drag to select).
 */
export const miroCompatiblePreset: CanvasInteractionPresetConfig = {
	...defaultSvelteFlowPreset,
	panOnDrag: [1, 2],
	selectionOnDrag: true
};

/**
 * Helper to ensure panels restore pointer events after selection rectangle releases.
 */
export function restorePanelPointerEvents(panelSelector = '.svelte-flow__panel'): void {
	if (typeof document === 'undefined') return;
	const panels = document.querySelectorAll(panelSelector);
	panels.forEach((panel) => {
		(panel as HTMLElement).style.pointerEvents = 'auto';
	});
}

/**
 * Action / helper to isolate canvas gestures (wheel, pointerdown) on floating overlays,
 * HUDs, toolbars, or modal dialogs sitting above a zoomable/pannable canvas, preventing wheel events
 * from bubbling to XYFlow or canvas viewport zoom/pan handlers.
 */
export function isolateCanvasGestures(
	node: HTMLElement,
	options: { wheel?: boolean; pointer?: boolean } = {}
) {
	const { wheel = true, pointer = false } = options;

	function handleWheel(e: WheelEvent) {
		e.stopPropagation();
	}

	function handlePointerDown(e: Event) {
		e.stopPropagation();
	}

	if (wheel) {
		node.addEventListener('wheel', handleWheel, { passive: false });
	}
	if (pointer) {
		node.addEventListener('pointerdown', handlePointerDown);
	}

	return {
		destroy() {
			if (wheel) {
				node.removeEventListener('wheel', handleWheel);
			}
			if (pointer) {
				node.removeEventListener('pointerdown', handlePointerDown);
			}
		}
	};
}

