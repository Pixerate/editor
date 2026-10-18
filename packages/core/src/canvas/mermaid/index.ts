/**
 * Mermaid diagrams on the canvas: lays out a `MermaidDocument` (dagre, nested groups,
 * stored `%% @pixerate` positions blended with auto-layout for new nodes), projects it
 * onto canvas nodes and edges, maps canvas drags back to `moveNodes` edits, and streams
 * diagrams that are still being written. Ported from Ursula.
 */
import type { EditOp, MermaidDocument, Point } from '../../diagram/types.js';
import { ensureDiagramLayout, type DiagramLayout, type DiagramLayoutOptions } from './layout.js';
import { mermaidFlowEdges, mermaidFlowNodes, type MermaidFlowEdge, type MermaidFlowNode } from './toFlow.js';

export * from './layout.js';
export * from './toFlow.js';
export * from './view.js';
export * from './stream.js';
export * from './scene.js';
export * from './drag.js';
export * from './families/index.js';

export interface MermaidCanvasOptions extends DiagramLayoutOptions {
	/** Nodes can be dragged, connected and selected (default false). */
	editable?: boolean;
	/** A layout to draw instead of computing one (e.g. a tween frame). */
	layout?: DiagramLayout;
}

export interface MermaidCanvas {
	nodes: MermaidFlowNode[];
	edges: MermaidFlowEdge[];
	/** Absolute positions and sizes of every node and group. */
	layout: DiagramLayout;
}

/**
 * Lays out a Mermaid document and returns canvas nodes (groups first, child positions
 * relative to their parent as React Flow / Svelte Flow expect) and edges.
 */
export function mermaidToCanvas(doc: MermaidDocument, options: MermaidCanvasOptions = {}): MermaidCanvas {
	const layout = options.layout ?? ensureDiagramLayout(doc.graph, doc.meta, { family: doc.family, ...options });
	return {
		nodes: mermaidFlowNodes(doc.graph, layout, { editable: options.editable }),
		edges: mermaidFlowEdges(doc.graph, { editable: options.editable }),
		layout
	};
}

export interface MermaidMovesOptions {
	/**
	 * Positions already stored in the document (`doc.meta.layout`). Nodes that are laid out
	 * automatically and not yet stored are pinned where they are, so moving one node does
	 * not shift the others (new nodes are blended in around stored ones).
	 */
	stored?: Readonly<Record<string, Point>>;
}

/**
 * The `moveNodes` edit for canvas nodes that were dragged: converts their positions
 * (relative to their parent) back to absolute coordinates. Returns `null` when nothing
 * moved by at least half a pixel.
 */
export function mermaidMovesFromCanvas(
	layout: DiagramLayout,
	moved: ReadonlyArray<{ id: string; position: { x: number; y: number }; parentId?: string }>,
	all: ReadonlyArray<{ id: string; position: { x: number; y: number }; parentId?: string }> = moved,
	options: MermaidMovesOptions = {}
): Extract<EditOp, { type: 'moveNodes' }> | null {
	// The moved nodes win over their stale copies in `all`.
	const byId = new Map([...all, ...moved].map((n) => [n.id, n]));
	const absolute = (id: string, seen = new Set<string>()): Point => {
		const node = byId.get(id);
		if (!node) return layout.positions[id] ?? [0, 0];
		if (!node.parentId || seen.has(id)) return [node.position.x, node.position.y];
		seen.add(id);
		const [px, py] = absolute(node.parentId, seen);
		return [px + node.position.x, py + node.position.y];
	};
	const moves = moved
		.map((n) => ({ id: n.id, position: absolute(n.id) }))
		.filter(({ id, position: [x, y] }) => {
			const before = layout.positions[id];
			return !before || Math.abs(before[0] - x) >= 0.5 || Math.abs(before[1] - y) >= 0.5;
		});
	// A dragged group carries its contents, so store their new absolute positions too.
	const movedIds = new Set(moves.map((m) => m.id));
	for (const n of all) {
		if (movedIds.has(n.id)) continue;
		let parent = n.parentId;
		while (parent && !movedIds.has(parent)) parent = byId.get(parent)?.parentId;
		if (parent) moves.push({ id: n.id, position: absolute(n.id) });
	}
	if (!moves.length) return null;
	if (options.stored) {
		const taken = new Set(moves.map((m) => m.id));
		for (const [id, position] of Object.entries(layout.positions)) {
			if (!taken.has(id) && !options.stored[id]) moves.push({ id, position });
		}
	}
	return { type: 'moveNodes', moves };
}
export * from './shapes.js';
export * from './export.js';
