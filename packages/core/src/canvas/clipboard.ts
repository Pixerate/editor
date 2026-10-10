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
 * Validates that an object conforms to minimal CanvasNode shape:
 * a string `id` and a `position` whose `x` / `y` are finite numbers.
 */
export function isValidCanvasNode(obj: unknown): obj is CanvasNode {
	if (typeof obj !== 'object' || obj === null) return false;
	const candidate = obj as { id?: unknown; position?: unknown };
	if (typeof candidate.id !== 'string') return false;
	const position = candidate.position as { x?: unknown; y?: unknown } | null | undefined;
	return (
		typeof position === 'object' &&
		position !== null &&
		typeof position.x === 'number' &&
		Number.isFinite(position.x) &&
		typeof position.y === 'number' &&
		Number.isFinite(position.y)
	);
}

/**
 * Validates that an object conforms to minimal CanvasEdge shape (string `id`, `source`, `target`).
 */
export function isValidCanvasEdge(obj: unknown): obj is CanvasEdge {
	if (typeof obj !== 'object' || obj === null) return false;
	const candidate = obj as { id?: unknown; source?: unknown; target?: unknown };
	return (
		typeof candidate.id === 'string' &&
		typeof candidate.source === 'string' &&
		typeof candidate.target === 'string'
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
			// Untrusted input: drop malformed edges instead of crashing downstream consumers.
			const edges = Array.isArray(parsed.edges)
				? (parsed.edges as unknown[]).filter(isValidCanvasEdge)
				: undefined;
			return { ...parsed, edges } as CanvasClipboardPayload<TNode, TEdge>;
		}
	} catch {
		// Not JSON or invalid payload
	}
	return null;
}

/**
 * Generates unique new IDs for pasted nodes and updates edge references accordingly.
 *
 * - Nodes without a valid id / finite numeric position are skipped.
 * - `parentId` (and legacy `parentNode`) references to other pasted nodes are remapped to
 *   the new IDs; such children keep their parent-relative position (no extra offset).
 *   References to parents outside the pasted set are left unchanged.
 * - Edges are kept only when both endpoints were pasted; a non-array `edges` is ignored.
 */
export function remapPastedNodes<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(
	nodes: TNode[],
	edges: TEdge[] | null | undefined = [],
	offset: XYPosition = { x: 30, y: 30 },
	idGenerator: () => string = () => `node-${Math.random().toString(36).substring(2, 9)}`
): { nodes: TNode[]; edges: TEdge[] } {
	const validNodes = (Array.isArray(nodes) ? nodes : []).filter(isValidCanvasNode) as TNode[];
	const validEdges = (Array.isArray(edges) ? edges : []).filter(isValidCanvasEdge) as TEdge[];

	const dx = Number.isFinite(offset?.x) ? offset.x : 0;
	const dy = Number.isFinite(offset?.y) ? offset.y : 0;

	const idMap = new Map<string, string>();
	for (const node of validNodes) {
		idMap.set(node.id, idGenerator());
	}

	const newNodes = validNodes.map((node) => {
		const next: CanvasNode = {
			...node,
			id: idMap.get(node.id)!,
			position: {
				x: node.position.x + dx,
				y: node.position.y + dy
			},
			selected: true
		};

		let parentRemapped = false;
		for (const key of ['parentId', 'parentNode'] as const) {
			const parent = (node as CanvasNode)[key];
			if (typeof parent === 'string' && idMap.has(parent)) {
				next[key] = idMap.get(parent)!;
				parentRemapped = true;
			}
		}
		if (parentRemapped) {
			// Position is relative to the (also pasted, also offset) parent.
			next.position = { x: node.position.x, y: node.position.y };
		}

		return next as TNode;
	});

	const newEdges = validEdges
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
