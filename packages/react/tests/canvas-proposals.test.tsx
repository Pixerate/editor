import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HistoryManager } from '@pixerate/editor/history';
import { ToolRegistry } from '@pixerate/editor/tools';
import {
	createCanvasProposalToolProvider,
	useCanvasChangeFeed,
	useCanvasProposals,
	type CanvasChange,
	type CanvasEdge,
	type CanvasNode,
	type CanvasProposalsHandle
} from '../src/canvas';

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.com/editor' });
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).HTMLElement = dom.window.HTMLElement;
});

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

const start: CanvasNode[] = [{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } }];

function mountCanvas(history: HistoryManager, heard: CanvasChange[]) {
	const out: { handle?: CanvasProposalsHandle; nodes?: CanvasNode[]; setNodes?: (n: CanvasNode[]) => void } = {};
	function Probe() {
		const [nodes, setNodes] = useState<CanvasNode[]>(start);
		const [edges, setEdges] = useState<CanvasEdge[]>([]);
		out.handle = useCanvasProposals({ nodes, edges, setNodes, setEdges, history, origin: 'agent:pixie' });
		useCanvasChangeFeed({ nodes, edges, history, onChange: (c) => heard.push(c) });
		out.nodes = nodes;
		out.setNodes = setNodes;
		return <div data-count={out.handle.view.nodes.length} />;
	}
	return { out, Probe };
}

describe('useCanvasProposals', () => {
	it('draws ghosts, accepts as one agent-made undo step, and reports it in the change feed', async () => {
		const history = new HistoryManager();
		const heard: CanvasChange[] = [];
		const { out, Probe } = mountCanvas(history, heard);
		await act(async () => root.render(<StrictMode><Probe /></StrictMode>));

		let proposalId = '';
		await act(async () => {
			proposalId = out.handle!.propose({ title: 'Caption', nodes: [{ id: 'b', nearNodeId: 'a' }] }).id;
		});
		expect(out.handle!.proposals.map((p) => p.id)).toEqual([proposalId]);
		expect(out.handle!.view.nodes.map((n) => n.id)).toEqual(['a', 'b']);
		expect(out.nodes).toHaveLength(1);
		expect(heard).toHaveLength(0);

		await act(async () => {
			out.handle!.accept(proposalId);
		});
		expect(out.nodes!.map((n) => n.id)).toEqual(['a', 'b']);
		expect(out.handle!.proposals).toEqual([]);
		expect(history.getEntries()).toEqual([expect.objectContaining({ label: 'Caption', origin: 'agent:pixie' })]);
		expect(heard).toHaveLength(1);
		expect(heard[0]).toMatchObject({ origin: 'agent:pixie' });
		expect(heard[0]!.addedNodes.map((n) => n.id)).toEqual(['b']);

		await act(async () => {
			history.undo();
		});
		expect(out.nodes!.map((n) => n.id)).toEqual(['a']);
		expect(heard[1]).toMatchObject({ origin: 'user' });
	});

	it('reports the user\'s own edits as the user\'s', async () => {
		const history = new HistoryManager();
		const heard: CanvasChange[] = [];
		const { out, Probe } = mountCanvas(history, heard);
		await act(async () => root.render(<Probe />));
		await act(async () => out.setNodes!([{ ...start[0]!, position: { x: 40, y: 0 } }]));
		expect(heard).toHaveLength(1);
		expect(heard[0]).toMatchObject({ origin: 'user' });
		expect(heard[0]!.changedNodes[0]!.fields).toEqual(['position']);
	});

	it('serves the proposal tools for agents', async () => {
		const history = new HistoryManager();
		const { out, Probe } = mountCanvas(history, []);
		await act(async () => root.render(<Probe />));
		const registry = new ToolRegistry();
		registry.register(createCanvasProposalToolProvider(out.handle!.store, { namespace: 'canvas' }));
		let id = '';
		await act(async () => {
			const res = await registry.callTool('canvas__propose_nodes', { title: 'X', nodes: [{ nearNodeId: 'a' }] }, { actor: { id: 'pixie' } });
			id = (res.structuredContent as any).proposalId;
		});
		expect(container.querySelector('[data-count]')!.getAttribute('data-count')).toBe('2');
		await act(async () => {
			await registry.callTool('canvas__accept_proposal', { proposalId: id });
		});
		expect(out.nodes).toHaveLength(2);
		expect(history.getEntries()[0]!.origin).toBe('agent:pixie');
	});
});
