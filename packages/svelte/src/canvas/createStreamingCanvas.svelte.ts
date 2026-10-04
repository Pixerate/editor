import {
	StreamingLayoutManager,
	type CanvasEdge,
	type CanvasNode,
	type IncrementalLayoutOptions,
	type XYPosition
} from '@pixerate/editor/canvas';

export interface CreateStreamingCanvasOptions<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	throttleMs?: number;
	glideDurationMs?: number;
	connectedOnly?: boolean;
	clock?: any;
	layoutOptions?: IncrementalLayoutOptions;
	onPositionsChange?: (positions: Map<string, XYPosition>) => void;
}

/**
 * Svelte 5 rune managing throttled graph streaming and fluid node glide animations.
 */
export function createStreamingCanvas<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(options: CreateStreamingCanvasOptions<TNode, TEdge> = {}) {
	let positions = $state<Map<string, XYPosition>>(new Map());

	const manager = new StreamingLayoutManager<TNode, TEdge>({
		throttleMs: options.throttleMs,
		glideDurationMs: options.glideDurationMs,
		connectedOnly: options.connectedOnly,
		clock: options.clock,
		layoutOptions: options.layoutOptions,
		onLayoutUpdated: (updated) => {
			positions = updated;
			options.onPositionsChange?.(updated);
		}
	});

	return {
		get positions() {
			return positions;
		},
		pushStreamUpdate(nodes: TNode[], edges: TEdge[], currentPositions: Map<string, XYPosition>) {
			manager.pushStreamUpdate(nodes, edges, currentPositions);
		},
		flush(nodes: TNode[], edges: TEdge[], currentPositions: Map<string, XYPosition>) {
			manager.flush(nodes, edges, currentPositions);
		},
		destroy() {
			manager.destroy();
		}
	};
}
