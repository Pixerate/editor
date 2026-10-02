import type {
	CanvasClipboardPayload,
	CanvasEdge,
	CanvasNode,
	XYPosition
} from './types.js';

/**
 * Checks if an event originated from a text input, textarea, contenteditable element, or rich editor.
 */
export function isEventFromTextInput(event: Event | { target: EventTarget | null }): boolean {
	const target = (event as any).target as HTMLElement | null;
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

/**
 * Serializes nodes and optional edges into clipboard JSON payload.
 */
export function serializeCanvasNodes<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(nodes: TNode[], edges?: TEdge[]): string {
	const payload: CanvasClipboardPayload<TNode, TEdge> = {
		version: 1,
		nodes,
		edges
	};
	return JSON.stringify(payload);
}

/**
 * Parses raw JSON string into a CanvasClipboardPayload if valid.
 */
export function parseCanvasClipboardData<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(raw: string): CanvasClipboardPayload<TNode, TEdge> | null {
	try {
		const parsed = JSON.parse(raw);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			Array.isArray(parsed.nodes) &&
			parsed.nodes.length > 0 &&
			parsed.nodes.every(isValidCanvasNode)
		) {
			return parsed as CanvasClipboardPayload<TNode, TEdge>;
		}
	} catch {
		// Not JSON or invalid payload
	}
	return null;
}

/**
 * Generates unique new IDs for pasted nodes and updates edge references accordingly.
 */
export function remapPastedNodes<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(
	nodes: TNode[],
	edges: TEdge[] = [],
	offset: XYPosition = { x: 30, y: 30 },
	idGenerator: () => string = () => `node-${Math.random().toString(36).substring(2, 9)}`
): { nodes: TNode[]; edges: TEdge[] } {
	const idMap = new Map<string, string>();

	const newNodes = nodes.map((node) => {
		const newId = idGenerator();
		idMap.set(node.id, newId);
		return {
			...node,
			id: newId,
			position: {
				x: node.position.x + offset.x,
				y: node.position.y + offset.y
			},
			selected: true
		};
	});

	const newEdges = edges
		.filter((e) => idMap.has(e.source) && idMap.has(e.target))
		.map((edge) => ({
			...edge,
			id: `edge-${Math.random().toString(36).substring(2, 9)}`,
			source: idMap.get(edge.source)!,
			target: idMap.get(edge.target)!,
			selected: false
		}));

	return { nodes: newNodes, edges: newEdges };
}

/**
 * Repositions nodes so their bounding box origin matches the given target position.
 */
export function repositionNodesTo<TNode extends CanvasNode = CanvasNode>(
	nodes: TNode[],
	targetOrigin: XYPosition
): TNode[] {
	if (nodes.length === 0) return [];
	const minX = Math.min(...nodes.map((n) => n.position.x));
	const minY = Math.min(...nodes.map((n) => n.position.y));
	const deltaX = targetOrigin.x - minX;
	const deltaY = targetOrigin.y - minY;

	return nodes.map((n) => ({
		...n,
		position: {
			x: n.position.x + deltaX,
			y: n.position.y + deltaY
		}
	}));
}
