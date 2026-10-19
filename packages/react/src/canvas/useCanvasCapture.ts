import { useMemo, useRef, type RefObject } from 'react';
import {
	canvasNodeCaptureRect,
	createCanvasCaptureToolProvider,
	type CanvasCaptureToolProviderOptions,
	type CanvasNode
} from '@pixerate/editor/canvas';
import { rasterizeElement, type AgentToolProvider } from '@pixerate/editor/tools';

export interface UseCanvasCaptureOptions<TNode extends CanvasNode = CanvasNode>
	extends Omit<CanvasCaptureToolProviderOptions<TNode>, 'element'> {
	/** The flow's root element (`.react-flow`): a ref, the element, or a getter. */
	element: RefObject<HTMLElement | null> | HTMLElement | null | undefined | (() => HTMLElement | null | undefined);
}

/**
 * The `capture_view` agent tool for a React Flow canvas: screenshots of the viewport, all
 * content, the selection, nodes by id or a rect in canvas units. Register the result with
 * `useAgentToolProvider`. The provider stays the same object across renders (it reads the
 * latest options on each call) and changes only with `id` / `namespace`.
 *
 * ```tsx
 * const flow = useReactFlow();
 * const capture = useCanvasCapture({ element: paneRef, getViewport: flow.getViewport, getNodes: flow.getNodes, namespace: 'canvas' });
 * useAgentToolProvider(registry, capture);
 * ```
 */
export function useCanvasCapture<TNode extends CanvasNode = CanvasNode>(options: UseCanvasCaptureOptions<TNode>): AgentToolProvider {
	const optionsRef = useRef(options);
	optionsRef.current = options;
	return useMemo(() => {
		const latest = () => optionsRef.current;
		return createCanvasCaptureToolProvider<TNode>({
			...options,
			element: () => {
				const el = latest().element;
				if (typeof el === 'function') return el();
				if (el && 'current' in el) return el.current;
				return el;
			},
			getViewport: () => latest().getViewport(),
			getNodes: () => latest().getNodes(),
			getNodeRect: (node, nodes) => (latest().getNodeRect ?? canvasNodeCaptureRect)(node, nodes),
			rasterize: (element, raster) => (latest().rasterize ?? rasterizeElement)(element, raster)
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [options.id, options.namespace]);
}
