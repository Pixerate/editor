import {
	createCanvasCaptureToolProvider,
	type CanvasCaptureToolProviderOptions,
	type CanvasNode
} from '@pixerate/editor/canvas';
import type { AgentToolProvider } from '@pixerate/editor/tools';

export type CreateCanvasCaptureOptions<TNode extends CanvasNode = CanvasNode> = CanvasCaptureToolProviderOptions<TNode>;

/**
 * The `capture_view` agent tool for a Svelte Flow canvas: screenshots of the viewport, all
 * content, the selection, nodes by id or a rect in canvas units. Pass the root element as a
 * getter (it is usually bound after the component mounts) and register the result with
 * `useAgentToolProvider`.
 *
 * ```svelte
 * <script>
 *   const flow = useSvelteFlow();
 *   let pane = $state<HTMLElement>();
 *   const capture = createCanvasCapture({ element: () => pane, getViewport: flow.getViewport, getNodes: flow.getNodes, namespace: 'canvas' });
 *   useAgentToolProvider(registry, capture);
 * </script>
 * <div bind:this={pane}><SvelteFlow ... /></div>
 * ```
 */
export function createCanvasCapture<TNode extends CanvasNode = CanvasNode>(
	options: CreateCanvasCaptureOptions<TNode>
): AgentToolProvider {
	return createCanvasCaptureToolProvider(options);
}
