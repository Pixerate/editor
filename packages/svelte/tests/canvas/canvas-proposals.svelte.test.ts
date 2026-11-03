import { describe, it, expect } from 'vitest';
import { flushSync } from 'svelte';
import { HistoryManager } from '@pixerate/editor/history';
import { ToolRegistry } from '@pixerate/editor/tools';
import {
	createCanvasChangeWatcher,
	createCanvasProposalState,
	createCanvasProposalToolProvider,
	type CanvasChange,
	type CanvasEdge,
	type CanvasNode
} from '../../src/canvas';

function canvas() {
	let nodes = $state.raw<CanvasNode[]>([{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } }]);
	let edges = $state.raw<CanvasEdge[]>([]);
	return {
		getNodes: () => nodes,
		getEdges: () => edges,
		setNodes: (next: CanvasNode[]) => (nodes = next),
		setEdges: (next: CanvasEdge[]) => (edges = next)
	};
}

describe('createCanvasProposalState (Svelte)', () => {
	it('shows ghosts in view and accepts as one undo step', () => {
		const c = canvas();
		const history = new HistoryManager();
		const cleanup = $effect.root(() => {
			const state = createCanvasProposalState({ ...c, history, origin: 'agent:pixie' });
			const p = state.propose({ title: 'Caption', nodes: [{ id: 'b', nearNodeId: 'a' }] });
			flushSync();
			expect(state.proposals.map((x) => x.id)).toEqual([p.id]);
			expect(state.view.nodes.map((n) => n.id)).toEqual(['a', 'b']);
			expect(c.getNodes()).toHaveLength(1);
			state.accept(p.id);
			flushSync();
			expect(state.proposals).toEqual([]);
			expect(c.getNodes().map((n) => n.id)).toEqual(['a', 'b']);
			expect(state.view.nodes).toHaveLength(2);
			expect(history.getEntries()[0]).toMatchObject({ label: 'Caption', origin: 'agent:pixie' });
		});
		cleanup();
	});

	it('serves the proposal tools for agents', async () => {
		const c = canvas();
		let state!: ReturnType<typeof createCanvasProposalState>;
		const cleanup = $effect.root(() => {
			state = createCanvasProposalState(c);
		});
		const registry = new ToolRegistry();
		registry.register(createCanvasProposalToolProvider(state.store, { namespace: 'canvas' }));
		const res = await registry.callTool('canvas__propose_nodes', { title: 'X', nodes: [{ nearNodeId: 'a' }] }, { actor: { id: 'pixie' } });
		expect((res.structuredContent as any).origin).toBe('agent:pixie');
		flushSync();
		expect(state.view.nodes).toHaveLength(2);
		cleanup();
	});
});

describe('createCanvasChangeWatcher (Svelte)', () => {
	it('reports changes with their origin as the canvas state changes', () => {
		const c = canvas();
		const history = new HistoryManager();
		const heard: CanvasChange[] = [];
		let watcher!: ReturnType<typeof createCanvasChangeWatcher>;
		const cleanup = $effect.root(() => {
			watcher = createCanvasChangeWatcher({ getNodes: c.getNodes, getEdges: c.getEdges, history, onChange: (change) => heard.push(change) });
		});
		flushSync();
		const before = c.getNodes();
		const after = [...before, { id: 'z', position: { x: 9, y: 9 }, data: {} }];
		history.execute({ name: 'Add', origin: 'agent:pixie', execute: () => c.setNodes(after), undo: () => c.setNodes(before) });
		flushSync();
		expect(heard).toHaveLength(1);
		expect(heard[0]).toMatchObject({ origin: 'agent:pixie' });
		expect(heard[0]!.addedNodes.map((n) => n.id)).toEqual(['z']);
		expect(watcher.last?.seq).toBe(1);
		c.setNodes([{ ...after[0]!, data: { label: 'B' } }, after[1]!]);
		flushSync();
		expect(heard[1]).toMatchObject({ origin: 'user' });
		expect(heard[1]!.changedNodes[0]!.fields).toEqual(['data']);
		cleanup();
		c.setNodes([]);
		flushSync();
		expect(heard).toHaveLength(2);
	});
});
