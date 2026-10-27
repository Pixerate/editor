/**
 * Agent tools for canvas node explosion: `list_explodable_nodes`, `explode_node` and
 * `collapse_node`. They drive a {@link CanvasExplosionToolTarget}, which a host adapts from the
 * declarative state (`canvasExplosionToolTarget`) or from an imperative explosion coordinator
 * (`createCanvasExplosion` / `useCanvasExplosion`, whose `explodeNode` needs the host's children).
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { CanvasExplosionState } from './explosionState.js';
import type { CanvasNode } from './types.js';

/** What the explosion tools drive. */
export interface CanvasExplosionToolTarget<TNode extends CanvasNode = CanvasNode> {
	/** The nodes on the canvas (exploded children included or not; they are only listed when explodable). */
	getNodes: () => readonly TNode[];
	/** Ids of the exploded nodes. */
	exploded: () => readonly string[];
	/** Ids of nodes whose collapse is still animating. Default none. */
	collapsing?: () => readonly string[];
	/** `true` when the node can explode, otherwise false or the reason it cannot. Default: every node. */
	canExplode?: (node: TNode) => boolean | string;
	/** Explodes a node. Return false (or throw) to refuse. */
	explode: (nodeId: string) => void | boolean | Promise<void | boolean>;
	/** Collapses an exploded node. Return false (or throw) to refuse. */
	collapse: (nodeId: string) => void | boolean | Promise<void | boolean>;
	/** Several nodes can be exploded at once. Default false: exploding one collapses the other. */
	multiple?: boolean;
}

/** Adapts the declarative explosion state (`createCanvasExplosionState`, `useCanvasExplosionState`) for the tools. */
export function canvasExplosionToolTarget<TNode extends CanvasNode = CanvasNode>(
	state: CanvasExplosionState,
	options: { getNodes: () => readonly TNode[]; canExplode?: (node: TNode) => boolean | string }
): CanvasExplosionToolTarget<TNode> {
	return {
		getNodes: options.getNodes,
		canExplode: options.canExplode,
		exploded: () => (state.activeId ? [state.activeId] : []),
		collapsing: () => (state.collapsingId ? [state.collapsingId] : []),
		explode: (id) => {
			state.explode(id);
		},
		collapse: (id) => state.collapse(id)
	};
}

export interface CanvasExplosionToolProviderOptions {
	/** Provider id (unique per registry). Default `canvas-explosion`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Exploding is not allowed: `explode_node` and `collapse_node` are hidden. A string is the reason. */
	readOnly?: boolean | string | (() => boolean | string);
	/** Lets the tool list follow changes (e.g. the state's `subscribe`). */
	subscribe?: (notify: () => void) => () => void;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const labelOf = (node: CanvasNode): string | undefined => {
	const label = node.data?.label ?? node.data?.name;
	return typeof label === 'string' && label !== '' ? label : undefined;
};

/** The explosion tools for a canvas (see the module comment). */
export function createCanvasExplosionToolProvider<TNode extends CanvasNode = CanvasNode>(
	target: CanvasExplosionToolTarget<TNode>,
	options: CanvasExplosionToolProviderOptions = {}
): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const ro = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		return ro ? (typeof ro === 'string' ? ro : 'Exploding nodes is disabled on this canvas.') : null;
	};
	const reasonNotExplodable = (node: TNode): string | null => {
		const ok = target.canExplode ? target.canExplode(node) : true;
		if (ok === true) return null;
		return typeof ok === 'string' && ok ? ok : `Node "${node.id}" has nothing to explode into.`;
	};
	const state = () => ({ exploded: [...target.exploded()], collapsing: [...(target.collapsing?.() ?? [])] });
	const findNode = (id: string): TNode => {
		const node = target.getNodes().find((n) => n.id === id);
		if (!node) throw new Error(`No node "${id}" on the canvas. Call list_explodable_nodes for node ids.`);
		return node;
	};
	const refuseIfReadOnly = () => {
		const reason = readOnlyReason();
		if (reason) throw new Error(reason);
	};

	const listTool: AgentTool = {
		name: 'list_explodable_nodes',
		title: 'List explodable nodes',
		description:
			'Lists the canvas nodes that can explode into child nodes (id, label, exploded, collapsing), plus the ids currently exploded and collapsing, and whether exploding is read-only. Call before explode_node or collapse_node.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'List explodable nodes', ...READ },
		handler: () => {
			const { exploded, collapsing } = state();
			const nodes = target
				.getNodes()
				.filter((n) => exploded.includes(n.id) || reasonNotExplodable(n) === null)
				.map((n) => ({
					id: n.id,
					...(labelOf(n) ? { label: labelOf(n) } : {}),
					exploded: exploded.includes(n.id),
					collapsing: collapsing.includes(n.id)
				}));
			return { nodes, exploded, collapsing, multiple: target.multiple === true, readOnly: readOnlyReason() };
		}
	};

	const explodeTool: AgentTool = {
		name: 'explode_node',
		title: 'Explode a node',
		description:
			'Expands a node into its child nodes (subtasks, steps, details), moving surrounding nodes to make room. Unless several can be open at once, the node exploded before collapses. Exploding an exploded node changes nothing. Returns the node, the ids now exploded, and the ids that collapsed.',
		inputSchema: {
			type: 'object',
			properties: {
				node: { type: 'string', minLength: 1, description: 'Id of the node to explode, from list_explodable_nodes.' }
			},
			required: ['node'],
			additionalProperties: false
		},
		annotations: { title: 'Explode a node', ...WRITE_IDEMPOTENT },
		handler: async (args) => {
			refuseIfReadOnly();
			const node = findNode(args.node);
			const before = state().exploded;
			if (before.includes(node.id)) return { node: node.id, changed: false, exploded: before, collapsed: [] };
			const reason = reasonNotExplodable(node);
			if (reason) throw new Error(reason);
			if ((await target.explode(node.id)) === false) {
				throw new Error(`Node "${node.id}" could not explode (the canvas refused, e.g. an animation is running). Try again or call list_explodable_nodes.`);
			}
			const after = state().exploded;
			return { node: node.id, changed: true, exploded: after, collapsed: before.filter((id) => !after.includes(id)) };
		}
	};

	const collapseTool: AgentTool = {
		name: 'collapse_node',
		title: 'Collapse a node',
		description:
			'Collapses an exploded node: its child nodes are removed (after the collapse animation) and moved nodes return to where they were. Returns the node and the ids still exploded.',
		inputSchema: {
			type: 'object',
			properties: {
				node: { type: 'string', minLength: 1, description: 'Id of an exploded node, from list_explodable_nodes (exploded: true).' }
			},
			required: ['node'],
			additionalProperties: false
		},
		annotations: { title: 'Collapse a node', ...WRITE_IDEMPOTENT },
		handler: async (args) => {
			refuseIfReadOnly();
			const before = state().exploded;
			if (!before.includes(args.node)) {
				findNode(args.node);
				throw new Error(
					`Node "${args.node}" is not exploded${before.length ? ` (exploded: ${before.join(', ')})` : ' (nothing is exploded)'}. Call list_explodable_nodes.`
				);
			}
			if ((await target.collapse(args.node)) === false) {
				throw new Error(`Node "${args.node}" could not collapse (the canvas refused). Try again or call list_explodable_nodes.`);
			}
			return { node: args.node, exploded: state().exploded, collapsing: state().collapsing };
		}
	};

	return {
		id: options.id ?? 'canvas-explosion',
		namespace: options.namespace,
		title: 'Canvas explosion',
		description: 'Explode canvas nodes into their child nodes and collapse them again.',
		skill: 'pixerate-canvas',
		tools: () => (readOnlyReason() ? [listTool] : [listTool, explodeTool, collapseTool]),
		subscribe: options.subscribe
	};
}
