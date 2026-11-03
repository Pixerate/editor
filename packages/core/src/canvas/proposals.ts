/**
 * Canvas proposals: nodes and edges an agent suggests, shown as ghosts until the user (or an
 * agent) accepts them as one undo step or rejects them. Nothing is added to the canvas, its
 * document or its history until a proposal is accepted, so a rejected suggestion leaves no trace.
 */

import type { Command } from '../history/types.js';
import { placeBeside, placeInView } from './layout.js';
import type { CanvasEdgeLike } from './editorDocument.js';
import type { CanvasEdge, CanvasNode, Rect, Side, XYPosition } from './types.js';

/** A node of a proposal as an agent describes it. */
export interface CanvasProposalNodeInput {
	/** Id of the new node (generated when absent). Must not be in use. */
	id?: string;
	type?: string;
	data?: Record<string, any>;
	/** Where to put it; without one it goes beside `nearNodeId`, or in free space in view. */
	position?: XYPosition;
	width?: number;
	height?: number;
	/** A node on the canvas, or earlier in the same proposal, to place it beside and connect from. */
	nearNodeId?: string;
	/** Which side of `nearNodeId` (default `right`). */
	side?: Side | 'top' | 'bottom';
}

/** An edge of a proposal: between new nodes, or between a new node and one on the canvas. */
export interface CanvasProposalEdgeInput {
	id?: string;
	source: string;
	target: string;
	label?: string;
}

export interface CanvasProposalInput {
	/** What the suggestion is, in a few words. Also the undo step's name once accepted. */
	title: string;
	/** Why it fits what the user is doing, in a sentence. */
	rationale?: string;
	/** Who suggests it (`agent:<id>`); defaults to the store's `origin`. */
	origin?: string;
	nodes?: readonly CanvasProposalNodeInput[];
	edges?: readonly CanvasProposalEdgeInput[];
}

export interface CanvasProposal<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	id: string;
	title: string;
	rationale?: string;
	origin: string;
	/** Milliseconds since the epoch (the store's `now`). */
	createdAt: number;
	nodes: TNode[];
	edges: TEdge[];
	/** Ids of nodes already on the canvas that the proposal connects to or was placed beside. */
	anchors: string[];
}

export interface CanvasProposalsState<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	proposals: readonly CanvasProposal<TNode, TEdge>[];
}

/** What accepting a proposal added. */
export interface CanvasProposalAcceptResult {
	proposalId: string;
	nodeIds: string[];
	edgeIds: string[];
	/** The name of the undo step it became. */
	historyLabel: string;
}

export interface CanvasProposalsOptions<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	getNodes: () => readonly TNode[];
	getEdges: () => readonly TEdge[];
	setNodes: (nodes: TNode[]) => void;
	setEdges: (edges: TEdge[]) => void;
	/** The canvas's undo history: an accepted proposal is one step there, made by its origin. */
	history?: { execute(command: Command): void };
	/** Origin of proposals that name none (default `agent:anonymous`). */
	origin?: string;
	/** Why the canvas cannot be changed (a sentence), or `false`. Proposing still works; accepting does not. */
	readOnly?: () => string | false;
	/** Size of a new node without a `width` / `height` (default 200 × 60). */
	defaultNodeSize?: { width: number; height: number };
	/** The visible part of the canvas: unanchored nodes go in free space there. */
	visibleRect?: () => Rect | null | undefined;
	/** Type of new nodes that name none. */
	defaultNodeType?: string;
	idGenerator?: (kind: 'proposal' | 'node' | 'edge') => string;
	now?: () => number;
}

export interface CanvasProposals<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	getState(): CanvasProposalsState<TNode, TEdge>;
	subscribe(listener: (state: CanvasProposalsState<TNode, TEdge>) => void): () => void;
	/** Plans and stages a proposal. Throws (changing nothing) when it refers to unknown nodes or reuses ids. */
	propose(input: CanvasProposalInput): CanvasProposal<TNode, TEdge>;
	/** Adds the proposal to the canvas as one undo step and drops it. */
	accept(id: string): CanvasProposalAcceptResult;
	/** Drops the proposal without changing the canvas. */
	reject(id: string): CanvasProposal<TNode, TEdge>;
	/** Drops every proposal (or those of one origin). Returns the ids dropped. */
	clear(origin?: string): string[];
	get(id: string): CanvasProposal<TNode, TEdge> | undefined;
	/** Canvas node ids the proposal needs that are no longer there (it cannot be accepted until re-proposed). */
	missing(id: string): string[];
	/** The canvas with every proposal drawn in as ghosts (not draggable, selectable or deletable). */
	withGhosts(nodes: readonly TNode[], edges: readonly TEdge[]): { nodes: TNode[]; edges: TEdge[] };
}

/** Class name of ghost nodes and edges (`withGhosts`), for styling. */
export const CANVAS_PROPOSAL_CLASS = 'pixerate-proposal';

const toSide = (side: CanvasProposalNodeInput['side']): Side =>
	side === 'top' ? 'above' : side === 'bottom' ? 'below' : (side ?? 'right');

const randomId = (kind: string) => `${kind}-${Math.random().toString(36).slice(2, 9)}`;

const joinClass = (a: unknown, b: string) => (typeof a === 'string' && a ? `${a} ${b}` : b);

/** A store of agent-suggested canvas additions (see the module comment). */
export function createCanvasProposals<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	options: CanvasProposalsOptions<TNode, TEdge>
): CanvasProposals<TNode, TEdge> {
	const size = options.defaultNodeSize ?? { width: 200, height: 60 };
	const makeId = options.idGenerator ?? randomId;
	const now = options.now ?? Date.now;
	let state: CanvasProposalsState<TNode, TEdge> = { proposals: [] };
	const listeners = new Set<(state: CanvasProposalsState<TNode, TEdge>) => void>();

	const set = (proposals: CanvasProposal<TNode, TEdge>[]) => {
		state = { proposals };
		listeners.forEach((l) => l(state));
	};

	const find = (id: string): CanvasProposal<TNode, TEdge> => {
		const proposal = state.proposals.find((p) => p.id === id);
		if (!proposal) {
			const ids = state.proposals.map((p) => p.id);
			throw new Error(`No proposal "${id}". ${ids.length ? `Pending proposals: ${ids.join(', ')}.` : 'There are no pending proposals.'} Call list_proposals for ids.`);
		}
		return proposal;
	};

	const rectOf = (node: CanvasNode): Rect => ({
		x: node.position.x,
		y: node.position.y,
		width: node.measured?.width ?? node.width ?? size.width,
		height: node.measured?.height ?? node.height ?? size.height
	});

	const missing = (proposal: CanvasProposal<TNode, TEdge>): string[] => {
		const present = new Set(options.getNodes().map((n) => n.id));
		return proposal.anchors.filter((id) => !present.has(id));
	};

	const propose = (input: CanvasProposalInput): CanvasProposal<TNode, TEdge> => {
		const title = typeof input.title === 'string' ? input.title.trim() : '';
		if (!title) throw new Error('A proposal needs a title: what it adds, in a few words.');
		const nodesIn = input.nodes ?? [];
		const edgesIn = input.edges ?? [];
		if (!nodesIn.length && !edgesIn.length) throw new Error('A proposal needs at least one node or edge.');

		const canvasNodes = options.getNodes();
		const canvasIds = new Set(canvasNodes.map((n) => n.id));
		const taken = new Set([...canvasIds, ...options.getEdges().map((e) => e.id)]);
		for (const p of state.proposals) {
			p.nodes.forEach((n) => taken.add(n.id));
			p.edges.forEach((e) => taken.add(e.id));
		}
		// Placement avoids the canvas and the ghosts already pending.
		const rects: Record<string, Rect> = {};
		for (const n of canvasNodes) rects[n.id] = rectOf(n);
		for (const p of state.proposals) for (const n of p.nodes) rects[n.id] = rectOf(n);

		const fresh = (kind: 'node' | 'edge', wanted?: string): string => {
			if (wanted !== undefined) {
				if (typeof wanted !== 'string' || !wanted) throw new Error(`A ${kind} id must be a non-empty string.`);
				if (taken.has(wanted)) throw new Error(`Id "${wanted}" is already in use on the canvas or in a pending proposal. Pick another or leave it out.`);
				taken.add(wanted);
				return wanted;
			}
			let id = makeId(kind);
			while (taken.has(id)) id = makeId(kind);
			taken.add(id);
			return id;
		};

		const nodes: TNode[] = [];
		const edges: TEdge[] = [];
		const anchors = new Set<string>();
		const ownIds = new Set<string>();
		const known = (id: string) => canvasIds.has(id) || ownIds.has(id);

		nodesIn.forEach((input, i) => {
			if (input.nearNodeId !== undefined && !known(input.nearNodeId)) {
				throw new Error(`nodes[${i}].nearNodeId "${input.nearNodeId}" is not on the canvas or earlier in this proposal. Use an id from the canvas state.`);
			}
			const id = fresh('node', input.id);
			const nodeSize = { width: input.width ?? size.width, height: input.height ?? size.height };
			let position = input.position;
			if (position && (!Number.isFinite(position.x) || !Number.isFinite(position.y))) {
				throw new Error(`nodes[${i}].position needs finite x and y.`);
			}
			if (!position) {
				const view = options.visibleRect?.();
				if (input.nearNodeId) position = placeBeside(rects, nodeSize, toSide(input.side), input.nearNodeId);
				else if (view) position = placeInView(rects, nodeSize, view);
				else if (canvasNodes.length || nodes.length) {
					const last = nodes[nodes.length - 1] ?? canvasNodes[canvasNodes.length - 1]!;
					position = placeBeside(rects, nodeSize, 'right', last.id);
				} else position = { x: 100, y: 100 };
			}
			const type = input.type ?? options.defaultNodeType;
			const node = {
				id,
				position,
				data: { ...(input.data ?? {}) },
				...(type !== undefined ? { type } : {}),
				...(input.width !== undefined ? { width: input.width } : {}),
				...(input.height !== undefined ? { height: input.height } : {})
			} as unknown as TNode;
			nodes.push(node);
			ownIds.add(id);
			rects[id] = { ...position, ...nodeSize };
			if (input.nearNodeId) {
				if (canvasIds.has(input.nearNodeId)) anchors.add(input.nearNodeId);
				edges.push({ id: fresh('edge'), source: input.nearNodeId, target: id } as TEdge);
			}
		});

		edgesIn.forEach((input, i) => {
			for (const end of ['source', 'target'] as const) {
				if (typeof input[end] !== 'string' || !known(input[end])) {
					throw new Error(`edges[${i}].${end} "${String(input[end])}" is not on the canvas or in this proposal.`);
				}
			}
			if (input.source === input.target) throw new Error(`edges[${i}] connects "${input.source}" to itself.`);
			const id = fresh('edge', input.id);
			edges.push({ id, source: input.source, target: input.target, ...(input.label ? { label: input.label } : {}) } as TEdge);
			for (const end of [input.source, input.target]) if (canvasIds.has(end)) anchors.add(end);
		});

		const proposal: CanvasProposal<TNode, TEdge> = {
			id: makeId('proposal'),
			title,
			...(input.rationale ? { rationale: input.rationale } : {}),
			origin: input.origin ?? options.origin ?? 'agent:anonymous',
			createdAt: now(),
			nodes,
			edges,
			anchors: [...anchors]
		};
		while (state.proposals.some((p) => p.id === proposal.id)) proposal.id = makeId('proposal');
		set([...state.proposals, proposal]);
		return proposal;
	};

	const accept = (id: string): CanvasProposalAcceptResult => {
		const proposal = find(id);
		const reason = options.readOnly?.();
		if (reason) throw new Error(reason);
		const gone = missing(proposal);
		if (gone.length) {
			throw new Error(`Proposal "${id}" connects to ${gone.map((g) => `"${g}"`).join(', ')}, which ${gone.length > 1 ? 'are' : 'is'} no longer on the canvas. Reject it and propose again.`);
		}
		const nodeIds = proposal.nodes.map((n) => n.id);
		const edgeIds = proposal.edges.map((e) => e.id);
		const clash = options.getNodes().find((n) => nodeIds.includes(n.id)) ?? options.getEdges().find((e) => edgeIds.includes(e.id));
		if (clash) throw new Error(`Id "${clash.id}" was taken on the canvas after proposal "${id}" was made. Reject it and propose again.`);

		const nodeSet = new Set(nodeIds);
		const edgeSet = new Set(edgeIds);
		const add = () => {
			options.setNodes([...options.getNodes().filter((n) => !nodeSet.has(n.id)), ...proposal.nodes.map((n) => ({ ...n }))]);
			options.setEdges([...options.getEdges().filter((e) => !edgeSet.has(e.id)), ...proposal.edges.map((e) => ({ ...e }))]);
		};
		// Undo takes back only what the proposal added, keeping later changes to other nodes.
		const remove = () => {
			options.setNodes(options.getNodes().filter((n) => !nodeSet.has(n.id)));
			options.setEdges(options.getEdges().filter((e) => !edgeSet.has(e.id)));
		};
		set(state.proposals.filter((p) => p.id !== id));
		if (options.history) options.history.execute({ name: proposal.title, origin: proposal.origin, execute: add, undo: remove });
		else add();
		return { proposalId: id, nodeIds, edgeIds, historyLabel: proposal.title };
	};

	const reject = (id: string) => {
		const proposal = find(id);
		set(state.proposals.filter((p) => p.id !== id));
		return proposal;
	};

	const clear = (origin?: string) => {
		const dropped = state.proposals.filter((p) => origin === undefined || p.origin === origin).map((p) => p.id);
		if (dropped.length) set(state.proposals.filter((p) => !dropped.includes(p.id)));
		return dropped;
	};

	const withGhosts = (nodes: readonly TNode[], edges: readonly TEdge[]) => {
		if (!state.proposals.length) return { nodes: [...nodes], edges: [...edges] };
		const present = new Set(nodes.map((n) => n.id));
		const ghostNodes: TNode[] = [];
		const ghostEdges: TEdge[] = [];
		for (const p of state.proposals) {
			const meta = { id: p.id, title: p.title };
			for (const n of p.nodes) {
				if (present.has(n.id)) continue;
				present.add(n.id);
				ghostNodes.push({
					...n,
					// Flow libraries hide a node until it is measured, and only nodes in the host's state get
					// measured: give the ghost the size it was placed with.
					measured: n.measured ?? { width: n.width ?? size.width, height: n.height ?? size.height },
					draggable: false,
					selectable: false,
					connectable: false,
					deletable: false,
					className: joinClass(n.className, CANVAS_PROPOSAL_CLASS),
					data: { ...n.data, proposal: meta }
				});
			}
		}
		for (const p of state.proposals) {
			for (const e of p.edges) {
				if (!present.has(e.source) || !present.has(e.target)) continue;
				ghostEdges.push({ ...e, selectable: false, deletable: false, animated: true, className: joinClass((e as { className?: unknown }).className, CANVAS_PROPOSAL_CLASS) } as TEdge);
			}
		}
		return { nodes: [...nodes, ...ghostNodes], edges: [...edges, ...ghostEdges] };
	};

	return {
		getState: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		propose,
		accept,
		reject,
		clear,
		get: (id) => state.proposals.find((p) => p.id === id),
		missing: (id) => missing(find(id)),
		withGhosts
	};
}
