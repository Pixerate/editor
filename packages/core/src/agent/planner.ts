import { ensureLayout, getLayoutedNodes, placeBeside } from '../canvas/layout.js';
import type { CanvasEdge, CanvasNode, Rect } from '../canvas/types.js';
import type { AgentCommand, AgentStep, EditorSnapshot } from './types.js';

/**
 * Plans a sequence of atomic execution steps from a high-level agent command.
 */
export function planAgentCommand<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(
	command: AgentCommand<TNode, TEdge>,
	snapshot: EditorSnapshot<TNode, TEdge>,
	options: {
		defaultNodeSize?: { width: number; height: number };
		idGenerator?: () => string;
	} = {}
): AgentStep<TNode, TEdge>[] {
	const defaultNodeSize = options.defaultNodeSize ?? { width: 200, height: 60 };
	const idGen = options.idGenerator ?? (() => `node-${Math.random().toString(36).substring(2, 9)}`);
	const edgeIdGen = () => `edge-${Math.random().toString(36).substring(2, 9)}`;

	const nodes = snapshot.canvas?.nodes ?? [];
	const edges = snapshot.canvas?.edges ?? [];

	switch (command.type) {
		case 'canvas:add_node': {
			let pos = command.node.position;

			if (!pos) {
				if (command.nearNodeId) {
					// Use collision-aware directional placement
					const rects: Record<string, Rect> = {};
					for (const n of nodes) {
						rects[n.id] = {
							x: n.position.x,
							y: n.position.y,
							width: n.measured?.width ?? (n as any).width ?? defaultNodeSize.width,
							height: n.measured?.height ?? (n as any).height ?? defaultNodeSize.height
						};
					}
					pos = placeBeside(
						rects,
						defaultNodeSize,
						command.side ?? 'right',
						command.nearNodeId
					);
				} else if (nodes.length > 0) {
					// Default beside the last node
					const lastNode = nodes[nodes.length - 1];
					const rects: Record<string, Rect> = {};
					for (const n of nodes) {
						rects[n.id] = {
							x: n.position.x,
							y: n.position.y,
							width: n.measured?.width ?? (n as any).width ?? defaultNodeSize.width,
							height: n.measured?.height ?? (n as any).height ?? defaultNodeSize.height
						};
					}
					pos = placeBeside(rects, defaultNodeSize, 'right', lastNode.id);
				} else {
					pos = { x: 100, y: 100 };
				}
			}

			const fullNode: TNode = {
				...command.node,
				id: command.node.id || idGen(),
				position: pos
			} as TNode;

			const steps: AgentStep<TNode, TEdge>[] = [
				{
					type: 'step:canvas_add_node',
					node: fullNode
				}
			];

			// If attached to nearNode, optionally automatically connect
			if (command.nearNodeId) {
				steps.push({
					type: 'step:canvas_add_edge',
					edge: {
						id: edgeIdGen(),
						source: command.nearNodeId,
						target: fullNode.id
					} as TEdge
				});
			}

			return steps;
		}

		case 'canvas:remove_nodes': {
			return [
				{
					type: 'step:canvas_remove_nodes',
					nodeIds: command.nodeIds
				}
			];
		}

		case 'canvas:connect': {
			return [
				{
					type: 'step:canvas_add_edge',
					edge: {
						id: edgeIdGen(),
						source: command.source,
						target: command.target,
						label: command.label
					} as TEdge
				}
			];
		}

		case 'canvas:update_node': {
			return [
				{
					type: 'step:canvas_update_node',
					id: command.id,
					data: command.data
				}
			];
		}

		case 'canvas:layout': {
			const dir = command.direction ?? 'LR';
			let layouted: TNode[];

			if (command.incremental) {
				const stored: Record<string, { x: number; y: number }> = {};
				for (const n of nodes) {
					if (n.position && (n.position.x !== 0 || n.position.y !== 0)) {
						stored[n.id] = { ...n.position };
					}
				}
				layouted = ensureLayout(nodes, edges, {
					direction: dir,
					storedPositions: stored
				});
			} else {
				layouted = getLayoutedNodes(nodes, edges, undefined, { direction: dir });
			}

			const positions: Record<string, { x: number; y: number }> = {};
			for (const node of layouted) {
				positions[node.id] = { ...node.position };
			}

			return [
				{
					type: 'step:canvas_move_nodes',
					positions
				}
			];
		}

		case 'canvas:select': {
			return [
				{
					type: 'step:canvas_select',
					nodeIds: command.nodeIds
				}
			];
		}

		case 'canvas:highlight': {
			return [
				{
					type: 'step:canvas_highlight',
					nodeIds: command.nodeIds,
					color: command.color ?? '#3b82f6',
					durationMs: command.durationMs ?? 2000
				}
			];
		}

		case 'prompt:insert_text': {
			return [
				{
					type: 'step:prompt_insert',
					text: command.text,
					at: command.at
				}
			];
		}

		case 'prompt:replace_range': {
			return [
				{
					type: 'step:prompt_replace',
					from: command.from,
					to: command.to,
					text: command.text
				}
			];
		}

		case 'prompt:set_variable': {
			return [
				{
					type: 'step:prompt_set_variable',
					name: command.name,
					value: command.value
				}
			];
		}

		case 'prompt:select': {
			return [
				{
					type: 'step:prompt_select',
					from: command.from,
					to: command.to
				}
			];
		}

		default: {
			return [];
		}
	}
}
