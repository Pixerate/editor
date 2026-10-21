// Agent playback on the node canvas (see `tools/playback.ts`): where nodes and edges are, in flow
// coordinates, so the agent's cursor can find them. The React and Svelte surfaces add the viewport.
import type { PlaybackRect, PlaybackRef } from '../tools/playback.js';
import { createNodeLookup, getNodeRect, type NodeRectOptions } from './arrange.js';
import type { CanvasEdge, CanvasNode } from './types.js';

export interface CanvasPlaybackLocatorOptions<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdge = CanvasEdge> {
	getNodes: () => readonly TNode[];
	getEdges?: () => readonly TEdge[];
	/** Size resolution for unmeasured nodes. */
	rectOptions?: NodeRectOptions;
}

/**
 * Finds `{ kind: 'node', id }` (the node's absolute rectangle) and `{ kind: 'edge', id }` (a small
 * box at the middle of the line between its nodes' centres) in flow coordinates.
 */
export function createCanvasPlaybackLocator<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdge = CanvasEdge>(
	options: CanvasPlaybackLocatorOptions<TNode, TEdge>
): (ref: PlaybackRef) => PlaybackRect | null {
	return (ref) => {
		const nodes = options.getNodes() as TNode[];
		const lookup = createNodeLookup(nodes);
		const rectOf = (id: string) => {
			const node = lookup.get(id);
			return node ? getNodeRect(node, lookup, options.rectOptions) : null;
		};
		if (ref.kind === 'node' || ref.kind === 'item') return rectOf(ref.id);
		if (ref.kind === 'edge') {
			const edge = options.getEdges?.().find((e) => e.id === ref.id);
			const a = edge && rectOf(edge.source);
			const b = edge && rectOf(edge.target);
			if (!a || !b) return null;
			const x = (a.x + a.width / 2 + b.x + b.width / 2) / 2;
			const y = (a.y + a.height / 2 + b.y + b.height / 2) / 2;
			return { x: x - 12, y: y - 12, width: 24, height: 24 };
		}
		return null;
	};
}
