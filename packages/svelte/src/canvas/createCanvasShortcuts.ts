import { isEventFromTextInput } from './createCanvasClipboard.svelte.js';
import type { CanvasNode, CanvasShortcutsOptions } from './types.js';

/**
 * Attaches keyboard shortcut handlers for canvas interaction.
 * Automatically ignores shortcuts when the user is typing into text inputs, textareas, or rich editors.
 *
 * @returns A cleanup function to remove event listeners.
 */
export function createCanvasShortcuts<TNode extends CanvasNode = CanvasNode>(
	options: CanvasShortcutsOptions<TNode>
): () => void {
	const target = options.targetElement ?? (typeof window !== 'undefined' ? window : null);
	if (!target) return () => {};

	function handleKeyDown(event: Event) {
		const keyboardEvent = event as KeyboardEvent;
		if (isEventFromTextInput(keyboardEvent)) {
			return;
		}

		const isMod = keyboardEvent.metaKey || keyboardEvent.ctrlKey;
		const isShift = keyboardEvent.shiftKey;
		const key = keyboardEvent.key;

		const selectedNodes = options.getSelectedNodes ? options.getSelectedNodes() : [];

		if (key === 'Backspace' || key === 'Delete') {
			if (options.onDelete && selectedNodes.length > 0) {
				keyboardEvent.preventDefault();
				options.onDelete(selectedNodes);
			}
			return;
		}

		if (isMod) {
			const lowerKey = key.toLowerCase();

			if (lowerKey === 'c' && !isShift) {
				if (options.onCopy) {
					// We let the native copy event fire or call onCopy
					options.onCopy();
				}
			} else if (lowerKey === 'x' && !isShift) {
				if (options.onCut) {
					options.onCut();
				}
			} else if (lowerKey === 'd' && !isShift) {
				if (options.onDuplicate && selectedNodes.length > 0) {
					keyboardEvent.preventDefault();
					options.onDuplicate(selectedNodes);
				}
			} else if (lowerKey === 'a' && !isShift) {
				if (options.onSelectAll) {
					keyboardEvent.preventDefault();
					options.onSelectAll();
				}
			} else if (lowerKey === 'g') {
				if (isShift) {
					if (options.onUngroup && selectedNodes.length > 0) {
						keyboardEvent.preventDefault();
						options.onUngroup(selectedNodes);
					}
				} else {
					if (options.onGroup && selectedNodes.length > 0) {
						keyboardEvent.preventDefault();
						options.onGroup(selectedNodes);
					}
				}
			} else if (key === '=' || key === '+') {
				if (options.onZoomIn) {
					keyboardEvent.preventDefault();
					options.onZoomIn();
				}
			} else if (key === '-') {
				if (options.onZoomOut) {
					keyboardEvent.preventDefault();
					options.onZoomOut();
				}
			} else if (key === '0') {
				if (options.onFitView) {
					keyboardEvent.preventDefault();
					options.onFitView();
				}
			} else if (lowerKey === 'f') {
				if (options.onSearch) {
					keyboardEvent.preventDefault();
					options.onSearch();
				}
			}
		}
	}

	target.addEventListener('keydown', handleKeyDown as EventListener);

	return () => {
		target.removeEventListener('keydown', handleKeyDown as EventListener);
	};
}
