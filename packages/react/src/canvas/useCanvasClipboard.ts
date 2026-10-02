import { useCallback } from 'react';
import {
	isEventFromTextInput,
	isValidUrl,
	parseCanvasClipboardData,
	remapPastedNodes,
	serializeCanvasNodes,
	type CanvasEdge,
	type CanvasNode,
	type XYPosition
} from '@pixerate/editor/canvas';

export interface UseCanvasClipboardOptions<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	onPasteNodes?: (nodes: TNode[], edges?: TEdge[]) => void | Promise<void>;
	onPasteUrl?: (url: string, position?: XYPosition) => void;
	onPasteText?: (text: string, position?: XYPosition) => void;
	screenToFlowPosition?: (position: XYPosition) => XYPosition;
}

/**
 * React hook managing canvas clipboard copy and paste operations.
 */
export function useCanvasClipboard<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(options: UseCanvasClipboardOptions<TNode, TEdge> = {}) {
	const copySelectedNodes = useCallback(
		(
			selectedNodes: TNode[],
			connectedEdges?: TEdge[],
			event?: ClipboardEvent | React.ClipboardEvent
		): boolean => {
			const native = (event && 'nativeEvent' in event) ? (event as any).nativeEvent : event;
			if (native && isEventFromTextInput(native)) {
				return false;
			}

			if (selectedNodes.length === 0) return false;

			const serialized = serializeCanvasNodes(selectedNodes, connectedEdges);

			const clipboardData = (event as any)?.clipboardData || (native as any)?.clipboardData;
			if (clipboardData) {
				clipboardData.setData('application/json', serialized);
				clipboardData.setData('text/plain', serialized);
				(event as any)?.preventDefault?.();
			} else if (typeof navigator !== 'undefined' && navigator.clipboard) {
				navigator.clipboard.writeText(serialized).catch(() => {});
			}

			return true;
		},
		[]
	);

	const handlePasteEvent = useCallback(
		async (event: ClipboardEvent | React.ClipboardEvent): Promise<boolean> => {
			const native = ('nativeEvent' in event) ? (event as any).nativeEvent : event;
			if (isEventFromTextInput(native)) {
				return false;
			}

			const clipboardData = (native as any)?.clipboardData || (event as any)?.clipboardData;
			if (!clipboardData) return false;

			const prevent = () => {
				(event as any)?.preventDefault?.();
				(native as any)?.preventDefault?.();
			};

			// Priority 1: application/json canvas payload
			const jsonText = clipboardData.getData('application/json');
			if (jsonText) {
				const parsed = parseCanvasClipboardData<TNode, TEdge>(jsonText);
				if (parsed && parsed.nodes.length > 0) {
					prevent();
					const remapped = remapPastedNodes(parsed.nodes, parsed.edges);
					await options.onPasteNodes?.(remapped.nodes, remapped.edges);
					return true;
				}
			}

			// Priority 2: text/plain
			const text = clipboardData.getData('text/plain')?.trim();
			if (text) {
				const parsed = parseCanvasClipboardData<TNode, TEdge>(text);
				if (parsed && parsed.nodes.length > 0) {
					prevent();
					const remapped = remapPastedNodes(parsed.nodes, parsed.edges);
					await options.onPasteNodes?.(remapped.nodes, remapped.edges);
					return true;
				}

				if (isValidUrl(text)) {
					prevent();
					options.onPasteUrl?.(text);
					return true;
				}

				if (options.onPasteText) {
					prevent();
					options.onPasteText(text);
					return true;
				}
			}

			return false;
		},
		[options]
	);

	return {
		copySelectedNodes,
		handlePasteEvent
	};
}
