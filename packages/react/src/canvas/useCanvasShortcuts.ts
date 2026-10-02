import { useEffect } from 'react';
import { isEventFromTextInput, type CanvasNode } from '@pixerate/editor/canvas';

export interface UseCanvasShortcutsOptions<TNode extends CanvasNode = CanvasNode> {
	targetElement?: HTMLElement | Window | null;
	enabled?: boolean;
	onCopy?: (selectedNodes: TNode[]) => void;
	onCut?: (selectedNodes: TNode[]) => void;
	onPaste?: (event: ClipboardEvent) => void;
	onDelete?: (selectedNodes: TNode[]) => void;
	onDuplicate?: (selectedNodes: TNode[]) => void;
	onSelectAll?: () => void;
	onGroup?: (selectedNodes: TNode[]) => void;
	onUngroup?: (selectedNodes: TNode[]) => void;
	onZoomIn?: () => void;
	onZoomOut?: () => void;
	onFitView?: () => void;
	getSelectedNodes?: () => TNode[];
}

/**
 * React hook registering canvas keyboard shortcuts while rigorously guarding against
 * hijacking typing inside text inputs, textareas, and rich-text ProseMirror elements.
 */
export function useCanvasShortcuts<TNode extends CanvasNode = CanvasNode>(
	options: UseCanvasShortcutsOptions<TNode> = {}
) {
	const {
		targetElement,
		enabled = true,
		onCopy,
		onCut,
		onPaste,
		onDelete,
		onDuplicate,
		onSelectAll,
		onGroup,
		onUngroup,
		onZoomIn,
		onZoomOut,
		onFitView,
		getSelectedNodes
	} = options;

	useEffect(() => {
		if (!enabled) return;

		const target = targetElement ?? (typeof window !== 'undefined' ? window : null);
		if (!target) return;

		function handleKeyDown(event: Event) {
			const keyboardEvent = event as KeyboardEvent;
			if (isEventFromTextInput(keyboardEvent)) {
				return;
			}

			const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
			const isMod = isMac ? keyboardEvent.metaKey : keyboardEvent.ctrlKey;
			const key = keyboardEvent.key.toLowerCase();
			const selectedNodes = getSelectedNodes ? getSelectedNodes() : [];

			// Delete / Backspace
			if ((keyboardEvent.key === 'Backspace' || keyboardEvent.key === 'Delete') && !isMod) {
				if (selectedNodes.length > 0 && onDelete) {
					keyboardEvent.preventDefault();
					onDelete(selectedNodes);
				}
				return;
			}

			// Duplicate: Mod+D
			if (isMod && key === 'd') {
				if (selectedNodes.length > 0 && onDuplicate) {
					keyboardEvent.preventDefault();
					onDuplicate(selectedNodes);
				}
				return;
			}

			// Select All: Mod+A
			if (isMod && key === 'a' && onSelectAll) {
				keyboardEvent.preventDefault();
				onSelectAll();
				return;
			}

			// Group: Mod+G
			if (isMod && key === 'g' && !keyboardEvent.shiftKey && onGroup) {
				if (selectedNodes.length > 0) {
					keyboardEvent.preventDefault();
					onGroup(selectedNodes);
				}
				return;
			}

			// Ungroup: Mod+Shift+G
			if (isMod && key === 'g' && keyboardEvent.shiftKey && onUngroup) {
				if (selectedNodes.length > 0) {
					keyboardEvent.preventDefault();
					onUngroup(selectedNodes);
				}
				return;
			}

			// Zoom In: Mod + Plus/Equal
			if (isMod && (key === '+' || key === '=') && onZoomIn) {
				keyboardEvent.preventDefault();
				onZoomIn();
				return;
			}

			// Zoom Out: Mod + Minus
			if (isMod && key === '-' && onZoomOut) {
				keyboardEvent.preventDefault();
				onZoomOut();
				return;
			}

			// Fit View: Mod + 0 or Shift + 1
			if (isMod && key === '0' && onFitView) {
				keyboardEvent.preventDefault();
				onFitView();
				return;
			}
		}

		target.addEventListener('keydown', handleKeyDown as EventListener);
		return () => {
			target.removeEventListener('keydown', handleKeyDown as EventListener);
		};
	}, [
		targetElement,
		enabled,
		onCopy,
		onCut,
		onPaste,
		onDelete,
		onDuplicate,
		onSelectAll,
		onGroup,
		onUngroup,
		onZoomIn,
		onZoomOut,
		onFitView,
		getSelectedNodes
	]);
}
