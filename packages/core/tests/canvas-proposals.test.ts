import { describe, it, expect } from 'vitest';
import {
	CANVAS_PROPOSAL_CLASS,
	createCanvasChangeFeed,
	createCanvasProposalToolProvider,
	createCanvasProposals,
	type CanvasEdge,
	type CanvasNode
} from '../src/canvas';
import { HistoryManager } from '../src/history';
import { createOriginMiddleware, createToolRegistry } from '../src/tools';

function setup(options: { readOnly?: string } = {}) {
	const canvas = {
		nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } }] as CanvasNode[],
		edges: [] as CanvasEdge[]
	};
	const history = new HistoryManager();
	let n = 0;
	const proposals = createCanvasProposals({
		getNodes: () => canvas.nodes,
		getEdges: () => canvas.edges,
		setNodes: (nodes) => (canvas.nodes = nodes),
		setEdges: (edges) => (canvas.edges = edges),
		history,
		readOnly: () => options.readOnly ?? false,
		idGenerator: (kind) => `${kind}-${++n}`,
		now: () => 0
	});
	return { canvas, history, proposals };
}

describe('createCanvasProposals', () => {
	it('stages a proposal without touching the canvas or history', () => {
		const { canvas, history, proposals } = setup();
		const p = proposals.propose({ title: 'Caption', nodes: [{ data: { label: 'Cap' }, nearNodeId: 'a', side: 'bottom' }], origin: 'agent:pixie' });
		expect(p.nodes).toHaveLength(1);
		expect(p.nodes[0]!.position.y).toBeGreaterThan(0);
		expect(p.edges).toEqual([{ id: 'edge-2', source: 'a', target: 'node-1' }]);
		expect(p.anchors).toEqual(['a']);
		expect(canvas.nodes).toHaveLength(1);
		expect(history.getEntries()).toHaveLength(0);
		expect(proposals.getState().proposals).toEqual([p]);
	});

	it('accepts as one undo step with the proposer as origin, and undo removes only its additions', () => {
		const { canvas, history, proposals } = setup();
		const p = proposals.propose({ title: 'Two cards', origin: 'agent:pixie', nodes: [{ id: 'b', nearNodeId: 'a' }, { id: 'c', nearNodeId: 'b' }] });
		const result = proposals.accept(p.id);
		expect(result).toEqual({ proposalId: p.id, nodeIds: ['b', 'c'], edgeIds: p.edges.map((e) => e.id), historyLabel: 'Two cards' });
		expect(canvas.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
		expect(history.getEntries()).toEqual([expect.objectContaining({ label: 'Two cards', origin: 'agent:pixie' })]);
		expect(proposals.getState().proposals).toHaveLength(0);
		// A later user edit to another node survives undoing the proposal.
		canvas.nodes = canvas.nodes.map((node) => (node.id === 'a' ? { ...node, data: { label: 'A2' } } : node));
		history.undo();
		expect(canvas.nodes).toEqual([{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'A2' } }]);
		expect(canvas.edges).toEqual([]);
		history.redo();
		expect(canvas.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
	});

	it('rejects without changing anything', () => {
		const { canvas, history, proposals } = setup();
		const p = proposals.propose({ title: 'X', nodes: [{}] });
		expect(proposals.reject(p.id).id).toBe(p.id);
		expect(proposals.getState().proposals).toEqual([]);
		expect(canvas.nodes).toHaveLength(1);
		expect(history.getEntries()).toHaveLength(0);
	});

	it('refuses bad input and changes nothing', () => {
		const { proposals } = setup();
		expect(() => proposals.propose({ title: '', nodes: [{}] })).toThrow(/needs a title/);
		expect(() => proposals.propose({ title: 'X' })).toThrow(/at least one node or edge/);
		expect(() => proposals.propose({ title: 'X', nodes: [{ nearNodeId: 'zz' }] })).toThrow(/"zz" is not on the canvas/);
		expect(() => proposals.propose({ title: 'X', nodes: [{ id: 'a' }] })).toThrow(/"a" is already in use/);
		expect(() => proposals.propose({ title: 'X', edges: [{ source: 'a', target: 'q' }] })).toThrow(/edges\[0\]\.target "q"/);
		expect(() => proposals.propose({ title: 'X', edges: [{ source: 'a', target: 'a' }] })).toThrow(/to itself/);
		expect(proposals.getState().proposals).toEqual([]);
		expect(() => proposals.accept('nope')).toThrow(/No proposal "nope"\. There are no pending proposals/);
	});

	it('keeps ids unique across pending proposals and avoids their ghosts when placing', () => {
		const { proposals } = setup();
		const first = proposals.propose({ title: 'One', nodes: [{ id: 'b', nearNodeId: 'a' }] });
		expect(() => proposals.propose({ title: 'Two', nodes: [{ id: 'b' }] })).toThrow(/already in use/);
		const second = proposals.propose({ title: 'Two', nodes: [{ nearNodeId: 'a' }] });
		expect(second.nodes[0]!.position).not.toEqual(first.nodes[0]!.position);
	});

	it('will not accept once an anchor is gone, or on a read-only canvas', () => {
		const { canvas, proposals } = setup();
		const p = proposals.propose({ title: 'X', nodes: [{ nearNodeId: 'a' }] });
		canvas.nodes = [];
		expect(proposals.missing(p.id)).toEqual(['a']);
		expect(() => proposals.accept(p.id)).toThrow(/"a", which is no longer on the canvas/);
		expect(proposals.get(p.id)).toBeDefined();
		const ro = setup({ readOnly: 'Locked.' });
		const q = ro.proposals.propose({ title: 'Y', nodes: [{}] });
		expect(() => ro.proposals.accept(q.id)).toThrow('Locked.');
	});

	it('draws ghosts that cannot be dragged, selected or deleted', () => {
		const { canvas, proposals } = setup();
		const p = proposals.propose({ title: 'G', nodes: [{ id: 'g', nearNodeId: 'a' }] });
		const view = proposals.withGhosts(canvas.nodes, canvas.edges);
		const ghost = view.nodes.find((n) => n.id === 'g')!;
		expect(ghost).toMatchObject({ draggable: false, selectable: false, deletable: false, className: CANVAS_PROPOSAL_CLASS, data: { proposal: { id: p.id, title: 'G' } } });
		// Flow libraries hide unmeasured nodes; ghosts never reach the host state that measures them.
		expect(ghost.measured).toEqual({ width: 200, height: 60 });
		expect(p.nodes[0]!.measured).toBeUndefined();
		expect(view.edges).toHaveLength(1);
		expect(canvas.nodes).toHaveLength(1);
		proposals.clear();
		expect(proposals.withGhosts(canvas.nodes, canvas.edges).nodes).toHaveLength(1);
	});

	it('clears only one origin when asked', () => {
		const { proposals } = setup();
		proposals.propose({ title: 'A', nodes: [{}], origin: 'agent:a' });
		const b = proposals.propose({ title: 'B', nodes: [{}], origin: 'agent:b' });
		expect(proposals.clear('agent:a')).toHaveLength(1);
		expect(proposals.getState().proposals.map((p) => p.id)).toEqual([b.id]);
	});
});

describe('createCanvasChangeFeed', () => {
	it('reports additions with the origin of the history step behind them', () => {
		const { canvas, history, proposals } = setup();
		const feed = createCanvasChangeFeed({ getNodes: () => canvas.nodes, getEdges: () => canvas.edges, history, now: () => 5 });
		const p = proposals.propose({ title: 'B', origin: 'agent:pixie', nodes: [{ id: 'b', nearNodeId: 'a' }] });
		proposals.accept(p.id);
		const change = feed.check()!;
		expect(change).toMatchObject({ seq: 1, origin: 'agent:pixie', inGesture: false, at: 5 });
		expect(change.addedNodes.map((n) => n.id)).toEqual(['b']);
		expect(change.addedEdges).toHaveLength(1);
		expect(change.commit?.kind).toBe('execute');
		expect(feed.check()).toBeNull();
		history.undo();
		const undone = feed.check()!;
		expect(undone.origin).toBe('user');
		expect(undone.removedNodes.map((n) => n.id)).toEqual(['b']);
		expect(undone.commit?.kind).toBe('undo');
	});

	it('treats edits outside the history as the user\'s, and reports fields, selection and gestures', () => {
		const { canvas } = setup();
		const feed = createCanvasChangeFeed({ getNodes: () => canvas.nodes, getEdges: () => canvas.edges });
		const heard: number[] = [];
		feed.subscribe((c) => heard.push(c.seq));
		canvas.nodes = [{ ...canvas.nodes[0]!, position: { x: 5, y: 0 }, dragging: true, selected: true }];
		const drag = feed.check()!;
		expect(drag.origin).toBe('user');
		expect(drag.changedNodes[0]!.fields).toEqual(['position']);
		expect(drag.selection).toEqual({ before: [], after: ['a'] });
		expect(drag.inGesture).toBe(true);
		// Only runtime fields changed: no edit, no selection change, nothing to report.
		canvas.nodes = [{ ...canvas.nodes[0]!, measured: { width: 10 } }];
		expect(feed.check()).toBeNull();
		expect(heard).toEqual([1]);
	});

	it('reports the end of a gesture even when the drop changes nothing else', () => {
		const { canvas } = setup();
		const feed = createCanvasChangeFeed({ getNodes: () => canvas.nodes, getEdges: () => canvas.edges });
		canvas.nodes = [{ ...canvas.nodes[0]!, position: { x: 40, y: 0 }, dragging: true }];
		expect(feed.check()).toMatchObject({ inGesture: true });
		expect(feed.check()?.gestureEnded).toBeUndefined();
		// The drop only clears the runtime flag: still reported, once, with nothing else in it.
		canvas.nodes = [{ ...canvas.nodes[0]!, dragging: false }];
		expect(feed.check()).toMatchObject({ inGesture: false, gestureEnded: true, changedNodes: [], addedNodes: [], removedNodes: [] });
		canvas.nodes = [{ ...canvas.nodes[0]!, measured: { width: 10 } }];
		expect(feed.check()).toBeNull();
		// A drop that also moves the node reports the move and the end together.
		canvas.nodes = [{ ...canvas.nodes[0]!, resizing: true, width: 50 }];
		expect(feed.check()).toMatchObject({ inGesture: true });
		canvas.nodes = [{ ...canvas.nodes[0]!, resizing: false, width: 60 }];
		const end = feed.check()!;
		expect(end).toMatchObject({ inGesture: false, gestureEnded: true });
		expect(end.changedNodes[0]!.fields).toEqual(['width']);
		// A plain edit afterwards is not a gesture end.
		canvas.nodes = [{ ...canvas.nodes[0]!, data: { label: 'x' } }];
		expect(feed.check()?.gestureEnded).toBeUndefined();
	});

	it('carries a gesture in progress across reset, so its end is still reported', () => {
		const { canvas } = setup();
		canvas.nodes = [{ ...canvas.nodes[0]!, dragging: true }];
		const feed = createCanvasChangeFeed({ getNodes: () => canvas.nodes, getEdges: () => canvas.edges });
		canvas.nodes = [{ ...canvas.nodes[0]!, dragging: false }];
		expect(feed.check()).toMatchObject({ gestureEnded: true });
		canvas.nodes = [{ ...canvas.nodes[0]!, dragging: true }];
		feed.reset();
		canvas.nodes = [{ ...canvas.nodes[0]!, dragging: false }];
		expect(feed.check()).toMatchObject({ gestureEnded: true });
		canvas.nodes = [{ ...canvas.nodes[0]!, dragging: true }];
		expect(feed.check()).toBeNull();
	});

	it('takes commits it is told about with noteCommit', () => {
		const { canvas, history } = setup();
		const feed = createCanvasChangeFeed({ getNodes: () => canvas.nodes, getEdges: () => canvas.edges });
		history.onCommit(feed.noteCommit);
		const before = canvas.nodes;
		history.execute({ name: 'Add', origin: 'agent:pixie', execute: () => (canvas.nodes = [...before, { id: 'n', position: { x: 0, y: 0 }, data: {} }]), undo: () => (canvas.nodes = before) });
		expect(feed.check()?.origin).toBe('agent:pixie');
	});

	it('checks on its subscribe source, resets, and stops after dispose', () => {
		const { canvas } = setup();
		let fire = () => {};
		const feed = createCanvasChangeFeed({
			getNodes: () => canvas.nodes,
			getEdges: () => canvas.edges,
			subscribe: (l) => {
				fire = l;
				return () => (fire = () => {});
			}
		});
		const heard: string[][] = [];
		feed.subscribe((c) => heard.push(c.addedNodes.map((n) => n.id)));
		canvas.nodes = [...canvas.nodes, { id: 'z', position: { x: 0, y: 0 }, data: {} }];
		fire();
		canvas.nodes = [];
		feed.reset();
		expect(feed.check()).toBeNull();
		feed.dispose();
		canvas.nodes = [{ id: 'y', position: { x: 0, y: 0 }, data: {} }];
		fire();
		expect(heard).toEqual([['z']]);
	});
});

describe('canvas proposal tools', () => {
	const make = (readOnly?: string) => {
		const s = setup();
		const registry = createToolRegistry();
		registry.register(createCanvasProposalToolProvider(s.proposals, { namespace: 'canvas', readOnly }));
		return { ...s, registry };
	};

	it('proposes, lists, accepts and rejects through the registry', async () => {
		const { registry, canvas, history } = make();
		const proposed = await registry.callTool('canvas__propose_nodes', { title: 'Caption', rationale: 'Images get captions.', nodes: [{ data: { label: 'Cap' }, nearNodeId: 'a' }] }, { actor: { id: 'pixie' } });
		expect(proposed.isError).toBeFalsy();
		const out = proposed.structuredContent as any;
		expect(out).toMatchObject({ title: 'Caption', origin: 'agent:pixie', anchors: ['a'] });
		expect(out.nodes[0]).toMatchObject({ label: 'Cap' });

		const listed = (await registry.callTool('canvas__list_proposals', {})).structuredContent as any;
		expect(listed.proposals[0]).toMatchObject({ id: out.proposalId, missing: [], rationale: 'Images get captions.' });
		expect(listed.readOnly).toBeNull();

		const accepted = (await registry.callTool('canvas__accept_proposal', { proposalId: out.proposalId })).structuredContent as any;
		expect(accepted.nodeIds).toEqual([out.nodes[0].id]);
		expect(canvas.nodes).toHaveLength(2);
		expect(history.getEntries()[0]!.origin).toBe('agent:pixie');

		const second = (await registry.callTool('canvas__propose_nodes', { title: 'More', nodes: [{}] })).structuredContent as any;
		expect(second.origin).toBe('agent:anonymous');
		const rejected = (await registry.callTool('canvas__reject_proposal', { proposalId: second.proposalId })).structuredContent as any;
		expect(rejected).toEqual({ proposalId: second.proposalId, title: 'More', rejected: true });
	});

	it('returns useful errors for bad arguments and unknown ids', async () => {
		const { registry } = make();
		const missingTitle = await registry.callTool('canvas__propose_nodes', { nodes: [{}] });
		expect(missingTitle.isError).toBe(true);
		const extra = await registry.callTool('canvas__propose_nodes', { title: 'X', nodes: [{ colour: 'red' }] });
		expect(extra.isError).toBe(true);
		const unknown = await registry.callTool('canvas__accept_proposal', { proposalId: 'p-9' });
		expect(unknown.isError).toBe(true);
		expect((unknown.content[0] as any).text).toMatch(/No proposal "p-9".*list_proposals/);
		const anchor = await registry.callTool('canvas__propose_nodes', { title: 'X', nodes: [{ nearNodeId: 'ghost' }] });
		expect((anchor.content[0] as any).text).toMatch(/"ghost" is not on the canvas/);
	});

	it('refuses to accept on a read-only canvas but still proposes and lists', async () => {
		const { registry, canvas } = make('This canvas is locked.');
		const p = (await registry.callTool('canvas__propose_nodes', { title: 'X', nodes: [{}] })).structuredContent as any;
		const listed = (await registry.callTool('canvas__list_proposals', {})).structuredContent as any;
		expect(listed.readOnly).toBe('This canvas is locked.');
		const res = await registry.callTool('canvas__accept_proposal', { proposalId: p.proposalId });
		expect(res.isError).toBe(true);
		expect((res.content[0] as any).text).toContain('This canvas is locked.');
		expect(canvas.nodes).toHaveLength(1);
	});
});

describe('createOriginMiddleware', () => {
	it('stamps write tool calls with the calling agent and leaves reads alone', async () => {
		const history = new HistoryManager();
		const registry = createToolRegistry();
		const seen: string[] = [];
		registry.register({
			id: 't',
			tools: [
				{ name: 'write', description: 'Writes.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: () => history.execute({ name: 'W', execute: () => {}, undo: () => {} }) },
				{ name: 'read', description: 'Reads.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: () => seen.push(history.getOrigin()) }
			]
		});
		registry.use(createOriginMiddleware({ histories: history }));
		await registry.callTool('t__write', {}, { actor: { id: 'pixie' } });
		await registry.callTool('t__write', {});
		await registry.callTool('t__read', {}, { actor: { id: 'pixie' } });
		expect(history.getEntries().map((e) => e.origin)).toEqual(['agent:pixie', 'agent:anonymous']);
		expect(seen).toEqual(['user']);
		expect(history.getOrigin()).toBe('user');
	});

	it('picks histories per call and skips calls it has none for', async () => {
		const a = new HistoryManager();
		const registry = createToolRegistry();
		registry.register({ id: 'x', tools: [{ name: 'w', description: 'W.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: () => a.execute({ name: 'W', execute: () => {}, undo: () => {} }) }] });
		registry.register({ id: 'y', tools: [{ name: 'w', description: 'W.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: () => a.execute({ name: 'W', execute: () => {}, undo: () => {} }) }] });
		registry.use(createOriginMiddleware({ histories: (call) => (call.provider.id === 'x' ? [a] : undefined), fallbackOrigin: 'agent:mcp' }));
		await registry.callTool('x__w', {});
		await registry.callTool('y__w', {});
		expect(a.getEntries().map((e) => e.origin)).toEqual(['agent:mcp', 'user']);
	});
});
