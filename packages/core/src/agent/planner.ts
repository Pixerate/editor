import { ensureLayout, getLayoutedNodes, placeBeside } from '../canvas/layout.js';
import type { CanvasEdge, CanvasNode, Rect, Side } from '../canvas/types.js';
import type { AgentCommand, AgentStep, EditorSnapshot } from './types.js';

/**
 * Normalizes a placement side from either the planner vocabulary (`right | below | left | above`)
 * or the MCP tool schema vocabulary (`top | right | bottom | left`). Unknown values fall back to `right`.
 */
export function normalizeSide(side: string | undefined | null): Side {
	switch (side) {
		case 'top':
		case 'above':
			return 'above';
		case 'bottom':
		case 'below':
			return 'below';
		case 'left':
			return 'left';
		case 'right':
		default:
			return 'right';
	}
}

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
			// Only anchor to (and connect from) a node that actually exists.
			const anchorId =
				command.nearNodeId && nodes.some((n) => n.id === command.nearNodeId)
					? command.nearNodeId
					: undefined;

			if (!pos) {
				const rects: Record<string, Rect> = {};
				for (const n of nodes) {
					rects[n.id] = {
						x: n.position.x,
						y: n.position.y,
						width: n.measured?.width ?? (n as any).width ?? defaultNodeSize.width,
						height: n.measured?.height ?? (n as any).height ?? defaultNodeSize.height
					};
				}

				if (anchorId) {
					// Use collision-aware directional placement
					pos = placeBeside(rects, defaultNodeSize, normalizeSide(command.side), anchorId);
				} else if (nodes.length > 0) {
					// Default beside the last node
					const lastNode = nodes[nodes.length - 1];
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
			if (anchorId) {
				steps.push({
					type: 'step:canvas_add_edge',
					edge: {
						id: edgeIdGen(),
						source: anchorId,
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

			// Matches the MCP tool schema: `incremental` defaults to true.
			if (command.incremental ?? true) {
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

		case 'choreography:say': {
			return [
				{
					type: 'step:say',
					text: command.text,
					atNodeId: command.atNodeId,
					position: command.position
				}
			];
		}

		case 'choreography:wait': {
			return [
				{
					type: 'step:wait',
					ms: command.ms
				}
			];
		}

		case 'tool:call': {
			return [
				{
					type: 'step:tool_call',
					name: command.name,
					arguments: command.arguments ?? {}
				}
			];
		}

		default: {
			return [];
		}
	}
}

const CANVAS_TOOL_OPERATIONS: Record<string, string> = {
	canvas_add_node: 'add_node',
	canvas_remove_nodes: 'remove_nodes',
	canvas_connect: 'connect',
	canvas_update_node: 'update_node',
	canvas_layout: 'layout',
	canvas_select: 'select',
	canvas_highlight: 'highlight'
};

const PROMPT_TOOL_OPERATIONS: Record<string, string> = {
	prompt_insert_text: 'insert_text',
	prompt_replace_range: 'replace_range',
	prompt_set_variable: 'set_variable',
	prompt_select: 'select'
};

/**
 * Converts an MCP tool call into a planner command. `edit_canvas` /
 * `edit_prompt` and the per-operation `canvas_*` / `prompt_*` tools (see
 * `tools/definitions.ts`) map to canvas/prompt commands using the MCP
 * schema's vocabulary; every other tool, including dynamic `ToolRegistry`
 * tools, becomes a `tool:call` command. Returns `null` when a static tool's
 * arguments are missing what the operation needs.
 */
export function toolCallToAgentCommand<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(name: string, args: Record<string, any> = {}): AgentCommand<TNode, TEdge> | null {
	const ids = (value: unknown): string[] | null =>
		Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null;
	const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

	const canvasOperation = name === 'edit_canvas' ? args.operation : CANVAS_TOOL_OPERATIONS[name];
	if (canvasOperation !== undefined) {
		switch (canvasOperation) {
			case 'add_node':
				return args.node && typeof args.node === 'object' && !Array.isArray(args.node)
					? {
							type: 'canvas:add_node',
							node: { ...args.node, data: args.node.data ?? {} },
							nearNodeId: args.nearNodeId,
							side: args.side
						}
					: null;
			case 'remove_nodes':
				return ids(args.nodeIds) ? { type: 'canvas:remove_nodes', nodeIds: args.nodeIds } : null;
			case 'connect':
				return typeof args.source === 'string' && typeof args.target === 'string'
					? { type: 'canvas:connect', source: args.source, target: args.target, label: args.label }
					: null;
			case 'update_node': {
				const id = args.node?.id ?? args.id;
				return typeof id === 'string'
					? { type: 'canvas:update_node', id, data: args.node?.data ?? args.data ?? {} }
					: null;
			}
			case 'layout':
				return { type: 'canvas:layout', direction: args.direction, incremental: args.incremental };
			case 'select':
				return ids(args.nodeIds) ? { type: 'canvas:select', nodeIds: args.nodeIds } : null;
			case 'highlight':
				return ids(args.nodeIds)
					? {
							type: 'canvas:highlight',
							nodeIds: args.nodeIds,
							...(typeof args.color === 'string' ? { color: args.color } : {}),
							...(num(args.durationMs) ? { durationMs: args.durationMs } : {})
						}
					: null;
			default:
				return null;
		}
	}

	const promptOperation = name === 'edit_prompt' ? args.operation : PROMPT_TOOL_OPERATIONS[name];
	if (promptOperation !== undefined) {
		switch (promptOperation) {
			case 'insert_text':
				return typeof args.text === 'string'
					? { type: 'prompt:insert_text', text: args.text, at: num(args.at) ? args.at : undefined }
					: null;
			case 'replace_range':
				return typeof args.text === 'string' && num(args.from) && num(args.to)
					? { type: 'prompt:replace_range', from: args.from, to: args.to, text: args.text }
					: null;
			case 'set_variable':
				return typeof args.name === 'string'
					? { type: 'prompt:set_variable', name: args.name, value: args.value }
					: null;
			case 'select':
				return num(args.from) && num(args.to) ? { type: 'prompt:select', from: args.from, to: args.to } : null;
			default:
				return null;
		}
	}

	return { type: 'tool:call', name, arguments: args };
}

/**
 * Checks a command against the snapshot before it is planned and returns a
 * message an agent can act on, or `null` when it is valid: node ids must
 * exist (and a new node's id must not), an edge needs two different existing
 * nodes, and prompt ranges must be ordered. Prompt positions are host-defined,
 * so their upper bound is left to the host's `applySteps`.
 * The planner itself stays lenient (it falls back instead of failing), so
 * tool providers call this first.
 */
export function validateAgentCommand<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(command: AgentCommand<TNode, TEdge>, snapshot: EditorSnapshot<TNode, TEdge>): string | null {
	const known = new Set((snapshot.canvas?.nodes ?? []).map((n) => n.id));
	const missing = (nodeIds: readonly string[]) => {
		const unknown = nodeIds.filter((id) => !known.has(id));
		return unknown.length
			? `Unknown node id${unknown.length > 1 ? 's' : ''}: ${unknown.map((id) => JSON.stringify(id)).join(', ')}. Call get_editor_state for the current ids.`
			: null;
	};
	const range = (from: number, to: number) => {
		if (from < 0 || to < 0) return 'Positions must be >= 0.';
		if (from > to) return `"from" (${from}) must not be after "to" (${to}).`;
		return null;
	};

	switch (command.type) {
		case 'canvas:add_node':
			if (command.node.id && known.has(command.node.id)) return `A node with id "${command.node.id}" already exists.`;
			return command.nearNodeId ? missing([command.nearNodeId]) : null;
		case 'canvas:remove_nodes':
		case 'canvas:highlight':
			return command.nodeIds.length ? missing(command.nodeIds) : 'Pass at least one node id.';
		case 'canvas:select':
			return missing(command.nodeIds);
		case 'canvas:connect':
			if (command.source === command.target) return 'An edge needs two different nodes.';
			return missing([command.source, command.target]);
		case 'canvas:update_node':
			return missing([command.id]);
		case 'prompt:insert_text':
			return command.at !== undefined ? range(command.at, command.at) : null;
		case 'prompt:replace_range':
		case 'prompt:select':
			return range(command.from, command.to);
		case 'choreography:say':
			return command.atNodeId ? missing([command.atNodeId]) : null;
		default:
			return null;
	}
}

/**
 * Plans the steps for an MCP tool call: static editor tools are planned like
 * the equivalent commands, any other tool becomes a `step:tool_call` to be
 * executed with `ToolRegistry.callTool`. Returns `[]` for invalid arguments.
 */
export function planToolCall<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(
	name: string,
	args: Record<string, any>,
	snapshot: EditorSnapshot<TNode, TEdge>,
	options?: Parameters<typeof planAgentCommand>[2]
): AgentStep<TNode, TEdge>[] {
	const command = toolCallToAgentCommand<TNode, TEdge>(name, args);
	return command ? planAgentCommand(command, snapshot, options) : [];
}
