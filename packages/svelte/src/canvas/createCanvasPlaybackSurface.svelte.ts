import { createCanvasPlaybackLocator, type CanvasEdge, type CanvasNode, type NodeRectOptions } from '@pixerate/editor/canvas';
import type { AgentPlayback, PlaybackPoint, PresenceStore } from '@pixerate/editor/tools';
import { createPlaybackSurface } from '../playback/playback.svelte.js';

type MaybeGetter<T> = T | (() => T);

export interface CreateCanvasPlaybackSurfaceOptions<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdge = CanvasEdge> {
	/** The flow's nodes and edges now (e.g. the `bind:nodes` state). */
	getNodes: () => readonly TNode[];
	getEdges?: () => readonly TEdge[];
	/** The flow viewport now (Svelte Flow's `useSvelteFlow().getViewport`). */
	getViewport: () => { x: number; y: number; zoom: number };
	/** The element the flow fills (and the `<PresenceLayer>` sits in); for bounds and screen mapping. */
	container: () => HTMLElement | null | undefined;
	/** Node size resolution (match the canvas' own). */
	rectOptions?: NodeRectOptions;
	/** Bring the canvas on screen (switch to its tab) before the agent acts. */
	reveal?: () => void | Promise<void>;
	/** Whether the canvas is on screen (default: the container has a size and the page is visible). */
	visible?: () => boolean;
}

/**
 * Svelte 5 rune: attaches the node canvas as an agent playback surface under `id` (the canvas tool
 * provider's id) for the component's lifetime (call during init) and returns its cursors. Draw them
 * with `<PresenceLayer presence={presence} viewport={viewport} />` inside the container. Parity with
 * React's `useCanvasPlaybackSurface`.
 */
export function createCanvasPlaybackSurface<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdge = CanvasEdge>(
	playback: MaybeGetter<AgentPlayback | null | undefined>,
	id: MaybeGetter<string | null | undefined>,
	options: CreateCanvasPlaybackSurfaceOptions<TNode, TEdge>
): PresenceStore {
	const locate = createCanvasPlaybackLocator<TNode, TEdge>({
		getNodes: options.getNodes,
		getEdges: () => options.getEdges?.() ?? [],
		rectOptions: options.rectOptions
	});
	const box = () => options.container()?.getBoundingClientRect() ?? null;
	return createPlaybackSurface(playback, id, {
		defaultKind: 'node',
		locate,
		bounds: () => {
			const r = box();
			const { x, y, zoom } = options.getViewport();
			return r && r.width > 0 ? { x: -x / zoom, y: -y / zoom, width: r.width / zoom, height: r.height / zoom } : null;
		},
		visible: () => {
			if (options.visible) return options.visible();
			const r = box();
			const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
			return !!r && r.width > 0 && r.height > 0 && !hidden;
		},
		toViewport: (p: PlaybackPoint) => {
			const r = box();
			const { x, y, zoom } = options.getViewport();
			return { x: (r?.left ?? 0) + p.x * zoom + x, y: (r?.top ?? 0) + p.y * zoom + y };
		},
		fromViewport: (p: PlaybackPoint) => {
			const r = box();
			const { x, y, zoom } = options.getViewport();
			return { x: (p.x - (r?.left ?? 0) - x) / zoom, y: (p.y - (r?.top ?? 0) - y) / zoom };
		},
		reveal: () => options.reveal?.()
	});
}
