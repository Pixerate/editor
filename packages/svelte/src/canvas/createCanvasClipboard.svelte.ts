import { tick } from 'svelte';
import type { XYPosition } from '@xyflow/svelte';
import type { CanvasNode, CanvasEdge, CanvasClipboardPayload } from './types.js';

/**
 * Checks if an event originated from a text input, textarea, contenteditable element, or rich editor.
 */
export function isEventFromTextInput(event: Event | { target: EventTarget | null }): boolean {
	const target = event.target as HTMLElement | null;
	if (!target) return false;
	if (
		target.tagName === 'INPUT' ||
		target.tagName === 'TEXTAREA' ||
		target.tagName === 'SELECT' ||
		target.isContentEditable ||
		target.closest?.('[contenteditable="true"]') ||
		target.closest?.('.ProseMirror')
	) {
		return true;
	}
	return false;
}

/**
 * Validates that an object conforms to minimal CanvasNode shape.
 */
export function isValidCanvasNode(obj: unknown): obj is CanvasNode {
	return (
		typeof obj === 'object' &&
		obj !== null &&
		'id' in obj &&
		typeof (obj as any).id === 'string' &&
		'position' in obj &&
		typeof (obj as any).position === 'object' &&
		(obj as any).position !== null &&
		'x' in (obj as any).position &&
		'y' in (obj as any).position
	);
}

/**
 * Checks if a string is a valid HTTP/HTTPS URL.
 */
export function isValidUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

export interface CreateCanvasClipboardOptions<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	onPasteNodes?: (nodes: TNode[], edges?: TEdge[]) => void | Promise<void>;
	onPasteUrl?: (url: string, position?: XYPosition) => void;
	onPasteText?: (text: string, position?: XYPosition) => void;
	onPasteImage?: (blob: File) => void | Promise<void>;
	screenToFlowPosition?: (position: XYPosition) => XYPosition;
}

/**
 * Headless Svelte 5 rune managing canvas copy, cut, and paste interactions.
 */
export function createCanvasClipboard<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(options: CreateCanvasClipboardOptions<TNode, TEdge> = {}) {
	function copySelectedNodes(
		selectedNodes: TNode[],
		connectedEdges?: TEdge[],
		event?: ClipboardEvent
	): boolean {
		if (event && isEventFromTextInput(event)) {
			return false;
		}

		if (selectedNodes.length === 0) return false;

		const payload: CanvasClipboardPayload<TNode, TEdge> = {
			version: 1,
			nodes: selectedNodes,
			edges: connectedEdges
		};

		const serialized = JSON.stringify(payload);

		if (event?.clipboardData) {
			event.clipboardData.setData('application/json', serialized);
			event.clipboardData.setData('text/plain', serialized);
			event.preventDefault();
		} else if (typeof navigator !== 'undefined' && navigator.clipboard) {
			navigator.clipboard.writeText(serialized).catch(() => {});
		}

		return true;
	}

	function cutSelectedNodes(
		selectedNodes: TNode[],
		connectedEdges?: TEdge[],
		onRemove?: (nodes: TNode[]) => void,
		event?: ClipboardEvent
	): boolean {
		if (event && isEventFromTextInput(event)) {
			return false;
		}

		const copied = copySelectedNodes(selectedNodes, connectedEdges, event);
		if (copied && onRemove) {
			onRemove(selectedNodes);
		}
		return copied;
	}

	async function handlePasteEvent(event: ClipboardEvent): Promise<boolean> {
		if (isEventFromTextInput(event)) {
			return false;
		}

		const clipboardData = event.clipboardData;
		if (!clipboardData) return false;

		// 1. Check for files (images)
		const files = clipboardData.files;
		if (files && files.length > 0) {
			const imageFile = Array.from(files).find((f) => f.type.startsWith('image/'));
			if (imageFile && options.onPasteImage) {
				event.preventDefault();
				await options.onPasteImage(imageFile);
				return true;
			}
		}

		// 2. Check for serialized nodes (application/json or json in text/plain)
		const rawJson =
			clipboardData.getData('application/json') || clipboardData.getData('text/plain');

		if (rawJson) {
			try {
				const parsed = JSON.parse(rawJson);
				let rawNodes: TNode[] | undefined;
				let rawEdges: TEdge[] | undefined;

				if (Array.isArray(parsed) && parsed.every(isValidCanvasNode)) {
					rawNodes = parsed as TNode[];
				} else if (
					typeof parsed === 'object' &&
					parsed !== null &&
					Array.isArray((parsed as any).nodes) &&
					(parsed as any).nodes.every(isValidCanvasNode)
				) {
					rawNodes = (parsed as any).nodes;
					rawEdges = (parsed as any).edges;
				}

				if (rawNodes && rawNodes.length > 0) {
					event.preventDefault();

					// Create ID mapping for cloned nodes
					const idMap = new Map<string, string>();
					const newNodes: TNode[] = rawNodes.map((node) => {
						const newId = crypto.randomUUID();
						idMap.set(node.id, newId);
						return {
							...node,
							id: newId,
							selected: true,
							position: {
								x: node.position.x + 40,
								y: node.position.y + 40
							}
						};
					});

					// Clone edges mapping them to the newly generated node IDs
					const newEdges: TEdge[] | undefined = rawEdges?.map((edge) => ({
						...edge,
						id: crypto.randomUUID(),
						source: idMap.get(edge.source) ?? edge.source,
						target: idMap.get(edge.target) ?? edge.target
					}));

					if (options.onPasteNodes) {
						await options.onPasteNodes(newNodes, newEdges);
						await tick();
					}
					return true;
				}
			} catch {
				// Not JSON, fall through to text/URL processing
			}
		}

		// 3. Check for URLs or plain text
		const text = clipboardData.getData('text/plain')?.trim();
		if (text) {
			if (isValidUrl(text) && options.onPasteUrl) {
				event.preventDefault();
				options.onPasteUrl(text);
				return true;
			} else if (options.onPasteText) {
				event.preventDefault();
				options.onPasteText(text);
				return true;
			}
		}

		return false;
	}

	return {
		copySelectedNodes,
		cutSelectedNodes,
		handlePasteEvent
	};
}
