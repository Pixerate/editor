// Agent playback for the canvas edit tools (`createEditorMcpToolProvider`): the planner already
// knows where a new node goes and where a layout moves nodes, so the cursor heads for the place
// the change lands before it exists. Pure: the same snapshot and call give the same steps.
import { createNodeLookup, getNodeRect, type NodeRectOptions } from '../canvas/arrange.js';
import type { CanvasEdge, CanvasNode, Rect } from '../canvas/types.js';
import { unionRects, type PlaybackStep } from '../tools/playback.js';
import { planAgentCommand, toolCallToAgentCommand, validateAgentCommand, type planToolCall } from './planner.js';
import type { AgentStep, EditorSnapshot } from './types.js';

const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const labelOf = (data: Record<string, unknown> | undefined): string | null => {
	const label = data?.label ?? data?.title ?? data?.text;
	return typeof label === 'string' && label.trim() ? label : null;
};

/**
 * Turns the planner's model steps into cursor steps (flow coordinates), against the nodes as they
 * are before the call. Steps after `commit` play once the change is on the canvas.
 */
export function planCanvasPlaybackSteps<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdge = CanvasEdge>(
	steps: readonly AgentStep<TNode, TEdge>[],
	nodes: readonly TNode[],
	rectOptions?: NodeRectOptions
): PlaybackStep[] {
	const placed = new Map<string, CanvasNode>(createNodeLookup(nodes as TNode[]));
	const rectOf = (id: string) => {
		const node = placed.get(id);
		return node ? getNodeRect(node, placed, rectOptions) : null;
	};
	const before: PlaybackStep[] = [];
	const after: PlaybackStep[] = [];
	const click = (rect: Rect | null): PlaybackStep[] =>
		rect ? [{ type: 'move', to: centre(rect) }, { type: 'focus', rect }, { type: 'press' }, { type: 'release' }] : [];

	for (const step of steps) {
		switch (step.type) {
			case 'step:canvas_add_node': {
				placed.set(step.node.id, step.node);
				const rect = rectOf(step.node.id)!;
				const label = labelOf(step.node.data);
				before.push(...click(rect), ...(label ? [{ type: 'type' as const, text: label }] : []));
				break;
			}
			case 'step:canvas_add_edge': {
				const a = rectOf(step.edge.source);
				const b = rectOf(step.edge.target);
				if (!a || !b) break;
				const label = typeof step.edge.label === 'string' ? step.edge.label : labelOf(step.edge.data as Record<string, unknown> | undefined);
				before.push(
					{ type: 'move', to: { x: a.x + a.width, y: a.y + a.height / 2 } },
					{ type: 'press' },
					{ type: 'drag', to: { x: b.x, y: b.y + b.height / 2 } },
					{ type: 'release' },
					...(label ? [{ type: 'type' as const, text: label }] : [])
				);
				break;
			}
			case 'step:canvas_update_node': {
				const rect = rectOf(step.id);
				const label = labelOf(step.data as Record<string, unknown>);
				before.push(...click(rect), ...(rect && label ? [{ type: 'type' as const, text: label }] : []));
				break;
			}
			case 'step:canvas_remove_nodes':
				for (const id of step.nodeIds.slice(0, 8)) before.push(...click(rectOf(id)));
				break;
			case 'step:canvas_select':
				for (const id of step.nodeIds.slice(0, 8)) before.push(...click(rectOf(id)));
				break;
			case 'step:canvas_highlight':
				for (const id of step.nodeIds.slice(0, 8)) {
					const rect = rectOf(id);
					if (rect) before.push({ type: 'move', to: centre(rect) }, { type: 'focus', rect });
				}
				break;
			case 'step:canvas_move_nodes': {
				const moved = Object.entries(step.positions);
				for (const [id, position] of moved) {
					const node = placed.get(id);
					if (node) placed.set(id, { ...node, position });
				}
				const rect = unionRects(moved.map(([id]) => rectOf(id)));
				if (rect) after.push({ type: 'move', to: centre(rect) }, { type: 'focus', rect }, { type: 'wait', ms: 450 });
				break;
			}
			default:
				break;
		}
	}
	if (!before.length && !after.length) return [];
	return [...before, { type: 'commit' }, ...after];
}

/**
 * The cursor steps for one canvas edit tool call (`canvas_add_node`, `edit_canvas`, ...), or `null`
 * when the call is invalid (the handler then reports the error) or is not a canvas edit.
 */
export function planCanvasToolPlayback<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdge = CanvasEdge>(
	name: string,
	args: Record<string, any>,
	snapshot: EditorSnapshot<TNode, TEdge>,
	plannerOptions?: Parameters<typeof planToolCall>[3],
	rectOptions?: NodeRectOptions
): PlaybackStep[] | null {
	const command = toolCallToAgentCommand<TNode, TEdge>(name, args);
	if (!command || !command.type.startsWith('canvas:') || validateAgentCommand(command, snapshot)) return null;
	const steps = planAgentCommand(command, snapshot, plannerOptions);
	const planned = planCanvasPlaybackSteps(steps, snapshot.canvas?.nodes ?? [], rectOptions);
	return planned.length ? planned : null;
}
