import { useMemo, useRef, type RefObject } from 'react';
import { createCanvasPlaybackLocator, type CanvasEdge, type CanvasNode, type NodeRectOptions } from '@pixerate/editor/canvas';
import type { AgentPlayback, PlaybackPoint, PresenceStore } from '@pixerate/editor/tools';
import { usePlaybackSurface } from '../playback/usePlaybackSurface.js';

export interface UseCanvasPlaybackSurfaceOptions<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdge = CanvasEdge> {
	/** The flow's nodes and edges now (e.g. React Flow's `getNodes` / `getEdges`). */
	getNodes: () => readonly TNode[];
	getEdges?: () => readonly TEdge[];
	/** The flow viewport (`useViewport()`). Cursors are placed in flow coordinates through it. */
	viewport: { x: number; y: number; zoom: number };
	/** The element the flow fills (and the `<PresenceLayer>` sits in); for bounds and screen mapping. */
	container: RefObject<HTMLElement | null>;
	/** Node size resolution (match the canvas' own). */
	rectOptions?: NodeRectOptions;
	/** Bring the canvas on screen (switch to its tab) before the agent acts. */
	reveal?: () => void | Promise<void>;
	/** Whether the canvas is on screen (default: the container has a size and the page is visible). */
	visible?: () => boolean;
}

/**
 * Attaches the node canvas as an agent playback surface under `id` (the canvas tool provider's id)
 * and returns its cursors. Draw them with `<PresenceLayer presence={presence} viewport={viewport} />`
 * inside `container`. Node and edge ids in tool calls are found from the flow's own geometry.
 */
export function useCanvasPlaybackSurface<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdge = CanvasEdge>(
	playback: AgentPlayback | null | undefined,
	id: string | null | undefined,
	options: UseCanvasPlaybackSurfaceOptions<TNode, TEdge>
): PresenceStore {
	const latest = useRef(options);
	latest.current = options;
	const locate = useMemo(
		() =>
			createCanvasPlaybackLocator<TNode, TEdge>({
				getNodes: () => latest.current.getNodes(),
				getEdges: () => latest.current.getEdges?.() ?? [],
				get rectOptions() {
					return latest.current.rectOptions;
				}
			}),
		[]
	);
	const box = () => latest.current.container.current?.getBoundingClientRect() ?? null;
	return usePlaybackSurface(playback, id, {
		defaultKind: 'node',
		locate,
		bounds: () => {
			const r = box();
			const { x, y, zoom } = latest.current.viewport;
			return r && r.width > 0 ? { x: -x / zoom, y: -y / zoom, width: r.width / zoom, height: r.height / zoom } : null;
		},
		visible: () => {
			if (latest.current.visible) return latest.current.visible();
			const r = box();
			const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
			return !!r && r.width > 0 && r.height > 0 && !hidden;
		},
		toViewport: (p: PlaybackPoint) => {
			const r = box();
			const { x, y, zoom } = latest.current.viewport;
			return { x: (r?.left ?? 0) + p.x * zoom + x, y: (r?.top ?? 0) + p.y * zoom + y };
		},
		fromViewport: (p: PlaybackPoint) => {
			const r = box();
			const { x, y, zoom } = latest.current.viewport;
			return { x: (p.x - (r?.left ?? 0) - x) / zoom, y: (p.y - (r?.top ?? 0) - y) / zoom };
		},
		reveal: () => latest.current.reveal?.()
	});
}
