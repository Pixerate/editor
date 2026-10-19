import {
	createCaptureToolProvider,
	unionCaptureRects,
	type CaptureRect,
	type CaptureSurface,
	type CaptureToolProviderOptions,
	type CapturedImage
} from '../tools/capture.js';
import {
	CAPTURE_EXCLUDE_SELECTOR,
	CAPTURE_OVERLAY_SELECTORS,
	rasterizeElement,
	type RasterizeElementOptions
} from '../tools/dom-capture.js';
import type { AgentToolProvider } from '../tools/registry.js';
import type { CanvasNode, Rect } from './types.js';

/** A flow viewport: screen = flow × zoom + (x, y). */
export interface CanvasCaptureViewport {
	x: number;
	y: number;
	zoom: number;
}

export interface CanvasCaptureSurfaceOptions<TNode extends CanvasNode = CanvasNode> {
	/** The flow's root element (`.react-flow` / `.svelte-flow`), or a getter (re-read on every call). */
	element: HTMLElement | null | undefined | (() => HTMLElement | null | undefined);
	/** The live viewport (e.g. `useReactFlow().getViewport` / `useSvelteFlow().getViewport`). */
	getViewport: () => CanvasCaptureViewport;
	/** The live nodes (e.g. `useReactFlow().getNodes`). */
	getNodes: () => readonly TNode[];
	/** Absolute bounds of a node in flow coordinates (default: its position plus its parents', and its measured size). */
	getNodeRect?: (node: TNode, nodes: readonly TNode[]) => Rect | null;
	/** Selector of the transformed viewport element inside `element`. */
	viewportSelector?: string;
	/** Never captured: panels, controls, minimap (default `CANVAS_CAPTURE_CHROME_SELECTORS`). */
	chromeSelectors?: readonly string[];
	/** Left out unless `includeOverlays` (default `CANVAS_CAPTURE_OVERLAY_SELECTORS`). */
	overlaySelectors?: readonly string[];
	/** Fill behind the canvas (default: the root element's computed background). */
	background?: string;
	/** Largest output pixels per canvas unit (default 2). */
	maxScale?: number;
	/** Swaps the drawing step (tests, or a library such as html-to-image). */
	rasterize?: (element: HTMLElement, options: RasterizeElementOptions) => Promise<CapturedImage>;
}

/** The transformed viewport inside React Flow and Svelte Flow. */
export const CANVAS_CAPTURE_VIEWPORT_SELECTOR = '.xyflow__viewport, .react-flow__viewport, .svelte-flow__viewport';

/** UI chrome that is never part of a canvas capture. */
export const CANVAS_CAPTURE_CHROME_SELECTORS: readonly string[] = [
	CAPTURE_EXCLUDE_SELECTOR,
	'.react-flow__panel',
	'.svelte-flow__panel',
	'.react-flow__minimap',
	'.svelte-flow__minimap',
	'.react-flow__controls',
	'.svelte-flow__controls',
	'.react-flow__attribution',
	'.svelte-flow__attribution'
];

/** Transient overlays: presence cursors, selection boxes and resize handles. */
export const CANVAS_CAPTURE_OVERLAY_SELECTORS: readonly string[] = [
	...CAPTURE_OVERLAY_SELECTORS,
	'.react-flow__nodesselection',
	'.svelte-flow__nodesselection',
	'.react-flow__selection',
	'.svelte-flow__selection',
	'.react-flow__resize-control',
	'.svelte-flow__resize-control'
];

const size = (node: CanvasNode) => ({
	width: node.measured?.width ?? node.width ?? 0,
	height: node.measured?.height ?? node.height ?? 0
});

/** A node's bounds in flow coordinates: its position plus every parent's, and its measured size. */
export function canvasNodeCaptureRect<TNode extends CanvasNode>(node: TNode, nodes: readonly TNode[]): Rect | null {
	if (node.hidden) return null;
	let x = node.position.x;
	let y = node.position.y;
	const seen = new Set([node.id]);
	let parentId = node.parentId ?? (node as { parentNode?: string }).parentNode;
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = nodes.find((n) => n.id === parentId);
		if (!parent) break;
		x += parent.position.x;
		y += parent.position.y;
		parentId = parent.parentId ?? (parent as { parentNode?: string }).parentNode;
	}
	const { width, height } = size(node);
	return { x, y, width, height };
}

/**
 * A capture surface for a React Flow / Svelte Flow canvas. Units are flow
 * coordinates (node positions). `viewport` draws the canvas as it is on
 * screen (with its background); other regions re-frame the nodes and edges
 * onto a plain background, wherever they are scrolled to. Panels, controls
 * and the minimap are never drawn; selection boxes and presence cursors only
 * with `includeOverlays`.
 */
export function createCanvasCaptureSurface<TNode extends CanvasNode = CanvasNode>(
	options: CanvasCaptureSurfaceOptions<TNode>
): CaptureSurface {
	const getElement = () => (typeof options.element === 'function' ? options.element() : options.element) ?? null;
	const nodeRect = (node: TNode, nodes: readonly TNode[]) => (options.getNodeRect ?? canvasNodeCaptureRect)(node, nodes);
	const rectsOf = (nodes: readonly TNode[], pick: (n: TNode) => boolean) =>
		nodes.filter(pick).map((n) => nodeRect(n, nodes)).filter((r): r is Rect => !!r && r.width > 0 && r.height > 0);
	const viewportSelector = options.viewportSelector ?? CANVAS_CAPTURE_VIEWPORT_SELECTOR;

	const viewport = (): CaptureRect | null => {
		const el = getElement();
		const vp = options.getViewport();
		if (!el || !el.clientWidth || !el.clientHeight || !(vp.zoom > 0)) return null;
		return { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, width: el.clientWidth / vp.zoom, height: el.clientHeight / vp.zoom };
	};

	return {
		units: 'canvas units',
		viewport,
		content: () => unionCaptureRects(rectsOf(options.getNodes(), () => true)),
		selection: () => {
			const nodes = options.getNodes();
			const selected = (n: TNode) => !!n.selected && !n.hidden;
			return { rect: unionCaptureRects(rectsOf(nodes, selected)), ids: nodes.filter(selected).map((n) => n.id) };
		},
		items: {
			region: 'nodes',
			noun: 'node',
			source: 'the canvas state',
			bounds: (ids) => {
				const nodes = options.getNodes();
				const missing = ids.filter((id) => !nodes.some((n) => n.id === id));
				return { rect: unionCaptureRects(rectsOf(nodes, (n) => ids.includes(n.id))), missing };
			}
		},
		overlays: 'selection boxes, resize handles and agent cursors',
		maxScale: options.maxScale ?? 2,
		render: (request) => {
			const el = getElement();
			if (!el || !el.isConnected) throw new Error('The canvas is not mounted, so there is nothing to capture.');
			const rasterize = options.rasterize ?? rasterizeElement;
			const exclude = [
				...(options.chromeSelectors ?? CANVAS_CAPTURE_CHROME_SELECTORS),
				...(request.includeOverlays ? [] : (options.overlaySelectors ?? CANVAS_CAPTURE_OVERLAY_SELECTORS))
			];
			const common = { pixelWidth: request.width, pixelHeight: request.height, format: request.format, quality: request.quality, background: options.background };
			if (request.region === 'viewport') {
				return rasterize(el, { ...common, width: el.clientWidth, height: el.clientHeight, exclude });
			}
			// Re-frame: draw only the viewport's subtree with a transform that puts the rect at the top left.
			const zoom = request.scale;
			return rasterize(el, {
				...common,
				width: request.width,
				height: request.height,
				exclude,
				prepare: (clone) => {
					const vpEl = clone.querySelector<HTMLElement>(viewportSelector);
					if (!vpEl) throw new Error(`The canvas has no viewport element (${viewportSelector}); pass viewportSelector.`);
					vpEl.style.transform = `translate(${-request.rect.x * zoom}px, ${-request.rect.y * zoom}px) scale(${zoom})`;
					vpEl.style.transformOrigin = '0 0';
					// Background patterns and screen-space layers follow the live viewport, not this frame.
					for (let node: HTMLElement | null = vpEl; node && node !== clone; node = node.parentElement) {
						for (const sibling of Array.from(node.parentElement?.children ?? [])) {
							if (sibling !== node) sibling.remove();
						}
					}
				}
			});
		}
	};
}

export interface CanvasCaptureToolProviderOptions<TNode extends CanvasNode = CanvasNode>
	extends CanvasCaptureSurfaceOptions<TNode>,
		CaptureToolProviderOptions {}

/**
 * `capture_view` for a React Flow / Svelte Flow canvas: a screenshot of the
 * viewport, all content, the selection, some nodes by id, or a rect in
 * canvas units. Default id `canvas-capture`.
 */
export function createCanvasCaptureToolProvider<TNode extends CanvasNode = CanvasNode>(
	options: CanvasCaptureToolProviderOptions<TNode>
): AgentToolProvider {
	return createCaptureToolProvider(createCanvasCaptureSurface(options), {
		subject: 'the canvas',
		...options,
		id: options.id ?? 'canvas-capture'
	});
}
