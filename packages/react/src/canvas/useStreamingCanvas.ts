import { useEffect, useRef, useCallback } from 'react';
import {
	StreamingLayoutManager,
	type CanvasEdge,
	type CanvasNode,
	type IncrementalLayoutOptions,
	type XYPosition
} from '@pixerate/editor/canvas';

export interface UseStreamingCanvasOptions<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	throttleMs?: number;
	glideDurationMs?: number;
	connectedOnly?: boolean;
	clock?: any;
	layoutOptions?: IncrementalLayoutOptions;
	onPositionsChange: (positions: Map<string, XYPosition>) => void;
}

/**
 * React hook that throttles rapid node/edge streaming additions (e.g. from LLM streams)
 * and glides nodes into position smoothly using physics/tweened trajectories without jarring jumps.
 */
export function useStreamingCanvas<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(options: UseStreamingCanvasOptions<TNode, TEdge>) {
	const managerRef = useRef<StreamingLayoutManager<TNode, TEdge> | null>(null);

	useEffect(() => {
		const manager = new StreamingLayoutManager<TNode, TEdge>({
			throttleMs: options.throttleMs,
			glideDurationMs: options.glideDurationMs,
			connectedOnly: options.connectedOnly,
			clock: options.clock,
			layoutOptions: options.layoutOptions,
			onLayoutUpdated: options.onPositionsChange
		});
		managerRef.current = manager;

		return () => {
			manager.destroy();
			managerRef.current = null;
		};
	}, [
		options.throttleMs,
		options.glideDurationMs,
		options.connectedOnly,
		options.clock,
		options.onPositionsChange
	]);

	const pushStreamUpdate = useCallback(
		(nodes: TNode[], edges: TEdge[], currentPositions: Map<string, XYPosition>) => {
			managerRef.current?.pushStreamUpdate(nodes, edges, currentPositions);
		},
		[]
	);

	const flush = useCallback(
		(nodes: TNode[], edges: TEdge[], currentPositions: Map<string, XYPosition>) => {
			managerRef.current?.flush(nodes, edges, currentPositions);
		},
		[]
	);

	return {
		pushStreamUpdate,
		flush
	};
}
