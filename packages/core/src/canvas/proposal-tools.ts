/**
 * Agent tools for canvas proposals: `propose_nodes`, `list_proposals`, `accept_proposal` and
 * `reject_proposal`. An agent suggests additions as ghosts the user can take or leave, instead of
 * editing the canvas outright. They drive a {@link CanvasProposals} store.
 */

import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { CanvasProposal, CanvasProposals } from './proposals.js';
import type { CanvasEdgeLike } from './editorDocument.js';
import type { CanvasEdge, CanvasNode } from './types.js';

export interface CanvasProposalToolProviderOptions {
	/** Provider id (unique per registry). Default `canvas-proposals`. */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Accepting is not allowed: `accept_proposal` refuses with this reason (a sentence). */
	readOnly?: boolean | string | (() => boolean | string);
	/** Origin of proposals from calls that name no actor (default `agent:anonymous`). */
	fallbackOrigin?: string;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const labelOf = (node: CanvasNode): string | undefined => {
	const label = node.data?.label ?? node.data?.name ?? node.data?.title;
	return typeof label === 'string' && label !== '' ? label : undefined;
};

const proposalIdArg = {
	type: 'object',
	properties: {
		proposalId: { type: 'string', minLength: 1, description: 'Id of a pending proposal, from propose_nodes or list_proposals.' }
	},
	required: ['proposalId'],
	additionalProperties: false
} as const;

/** The proposal tools for a canvas (see the module comment). */
export function createCanvasProposalToolProvider<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	proposals: CanvasProposals<TNode, TEdge>,
	options: CanvasProposalToolProviderOptions = {}
): AgentToolProvider {
	const readOnlyReason = (): string | null => {
		const ro = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		return ro ? (typeof ro === 'string' ? ro : 'The canvas is read-only: proposals can be made and rejected but not accepted.') : null;
	};
	const describe = (p: CanvasProposal<TNode, TEdge>) => ({
		id: p.id,
		title: p.title,
		...(p.rationale ? { rationale: p.rationale } : {}),
		origin: p.origin,
		nodes: p.nodes.map((n) => ({ id: n.id, ...(labelOf(n) ? { label: labelOf(n) } : {}), position: n.position })),
		edges: p.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
		anchors: p.anchors,
		missing: proposals.missing(p.id),
		createdAt: new Date(p.createdAt).toISOString()
	});

	const proposeTool: AgentTool = {
		name: 'propose_nodes',
		title: 'Propose nodes',
		description:
			'Suggests nodes and edges to add to the canvas without adding them: they appear as ghosts that the user accepts or dismisses, so use it for contributions the user did not ask for. A node with nearNodeId is placed beside that node and connected from it; others go in free space. Returns the proposal id, the planned node ids and positions, the edge ids and the canvas nodes it builds on (anchors). Follow with accept_proposal only when the user asked for it; otherwise leave the choice to them.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', minLength: 1, description: 'What the suggestion adds, in a few words, e.g. "Caption for the hero image". Becomes the undo step name when accepted.' },
				rationale: { type: 'string', description: 'Why it fits what the user is doing, in one sentence. Shown to the user beside the ghost.' },
				nodes: {
					type: 'array',
					description: 'Nodes to suggest, in order; a later node may sit beside an earlier one. Default none.',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', description: 'Id for the new node (default generated). Must not be in use.' },
							type: { type: 'string', description: 'Node type as the canvas renders it (default the canvas default).' },
							data: { type: 'object', description: 'Node data, e.g. { "label": "Caption" }. Default {}.' },
							position: {
								type: 'object',
								description: 'Top-left corner in canvas coordinates (pixels). Default: placed beside nearNodeId or in free space in view.',
								properties: { x: { type: 'number', description: 'Canvas x in pixels.' }, y: { type: 'number', description: 'Canvas y in pixels.' } },
								required: ['x', 'y'],
								additionalProperties: false
							},
							width: { type: 'number', exclusiveMinimum: 0, description: 'Width in pixels, for placement (default 200).' },
							height: { type: 'number', exclusiveMinimum: 0, description: 'Height in pixels, for placement (default 60).' },
							nearNodeId: { type: 'string', description: 'Id of a canvas node, or an earlier node of this proposal, to place it beside and connect from.' },
							side: { type: 'string', enum: ['right', 'below', 'left', 'above', 'top', 'bottom'], description: 'Side of nearNodeId to place it on (default right).' }
						},
						additionalProperties: false
					}
				},
				edges: {
					type: 'array',
					description: 'Extra edges, between nodes of this proposal or canvas nodes. Default none.',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', description: 'Id for the edge (default generated).' },
							source: { type: 'string', description: 'Id of the source node (canvas or this proposal).' },
							target: { type: 'string', description: 'Id of the target node (canvas or this proposal).' },
							label: { type: 'string', description: 'Edge label. Default none.' }
						},
						required: ['source', 'target'],
						additionalProperties: false
					}
				}
			},
			required: ['title'],
			additionalProperties: false
		},
		annotations: { title: 'Propose nodes', ...WRITE },
		handler: (args, context) => {
			const origin = context.actor?.id ? `agent:${context.actor.id}` : options.fallbackOrigin;
			const proposal = proposals.propose({ title: args.title, rationale: args.rationale, nodes: args.nodes, edges: args.edges, ...(origin ? { origin } : {}) });
			const { id: _id, missing: _missing, createdAt: _createdAt, ...rest } = describe(proposal);
			return { proposalId: proposal.id, ...rest };
		}
	};

	const listTool: AgentTool = {
		name: 'list_proposals',
		title: 'List proposals',
		description:
			'Lists the pending proposals (suggested nodes and edges not yet on the canvas): id, title, rationale, who proposed it, its nodes and edges, the canvas nodes it builds on, any of those since removed (missing: it can no longer be accepted), and whether accepting is allowed. Call before accept_proposal or reject_proposal.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'List proposals', ...READ },
		handler: () => ({ proposals: proposals.getState().proposals.map(describe), readOnly: readOnlyReason() })
	};

	const acceptTool: AgentTool = {
		name: 'accept_proposal',
		title: 'Accept a proposal',
		description:
			'Adds a pending proposal to the canvas as one undo step, recorded as made by whoever proposed it, and drops it from the pending list. Refuses, changing nothing, when the canvas is read-only or a node the proposal builds on was removed. Returns the added node and edge ids and the undo step name.',
		inputSchema: proposalIdArg,
		annotations: { title: 'Accept a proposal', ...WRITE },
		handler: (args) => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			return proposals.accept(args.proposalId);
		}
	};

	const rejectTool: AgentTool = {
		name: 'reject_proposal',
		title: 'Reject a proposal',
		description:
			'Dismisses a pending proposal: its ghosts disappear and the canvas and its history are unchanged. Use it to withdraw a suggestion that no longer fits. Returns the dismissed proposal id and title.',
		inputSchema: proposalIdArg,
		annotations: { title: 'Reject a proposal', ...WRITE },
		handler: (args) => {
			const proposal = proposals.reject(args.proposalId);
			return { proposalId: proposal.id, title: proposal.title, rejected: true };
		}
	};

	return {
		id: options.id ?? 'canvas-proposals',
		...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
		title: 'Canvas proposals',
		description: 'Suggest canvas additions as ghosts the user accepts or dismisses, and accept or reject pending suggestions.',
		skill: 'pixerate-canvas',
		tools: [proposeTool, listTool, acceptTool, rejectTool]
	};
}
