import { describe, it, expect } from 'vitest';
import {
	ToolRegistry,
	PresenceStore,
	createAgentPlayback,
	createInstantPresenceClock,
	createEditorMcpToolProvider,
	planCanvasPlaybackSteps,
	planCanvasToolPlayback,
	type AgentStep,
	type EditorSnapshot
} from '../src/agent';
import { createCanvasPlaybackLocator, type CanvasEdge, type CanvasNode } from '../src/canvas';

const node = (id: string, x: number, y: number, label = id, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, position: { x, y }, data: { label }, width: 100, height: 40, ...extra });

function board() {
	let nodes: CanvasNode[] = [node('brief', 0, 0, 'Brief'), node('review', 300, 120, 'Review'), node('frame', 600, 0, 'Frame'), node('inner', 10, 10, 'Inner', { parentId: 'frame' })];
	let edges: CanvasEdge[] = [{ id: 'e1', source: 'brief', target: 'review' }];
	const snapshot = (): EditorSnapshot => ({ canvas: { nodes, edges } });
	const applied: AgentStep[][] = [];
	const provider = createEditorMcpToolProvider({
		id: 'canvas',
		surfaces: { canvas: true, prompt: false },
		getSnapshot: snapshot,
		applySteps: (steps) => {
			applied.push(steps);
			for (const step of steps) {
				if (step.type === 'step:canvas_add_node') nodes = [...nodes, step.node];
				if (step.type === 'step:canvas_add_edge') edges = [...edges, step.edge];
				if (step.type === 'step:canvas_move_nodes') nodes = nodes.map((n) => (step.positions[n.id] ? { ...n, position: step.positions[n.id]! } : n));
			}
		}
	});
	const registry = new ToolRegistry();
	registry.register(provider);
	const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
	playback.install(registry);
	const presence = new PresenceStore();
	const locate = createCanvasPlaybackLocator({ getNodes: () => nodes, getEdges: () => edges });
	playback.attach('canvas', { presence, locate, defaultKind: 'node', bounds: () => ({ x: 0, y: 0, width: 1000, height: 600 }) });
	return { registry, playback, presence, applied, snapshot, get nodes() { return nodes; } };
}

describe('createCanvasPlaybackLocator', () => {
	it('finds nodes (absolute, inside frames) and edges in flow coordinates', () => {
		const { snapshot } = board();
		const { nodes, edges } = snapshot().canvas!;
		const locate = createCanvasPlaybackLocator({ getNodes: () => nodes, getEdges: () => edges });
		expect(locate({ kind: 'node', id: 'brief' })).toEqual({ x: 0, y: 0, width: 100, height: 40 });
		expect(locate({ kind: 'node', id: 'inner' })).toEqual({ x: 610, y: 10, width: 100, height: 40 });
		expect(locate({ kind: 'edge', id: 'e1' })).toEqual({ x: 188, y: 68, width: 24, height: 24 });
		expect(locate({ kind: 'node', id: 'nope' })).toBeNull();
		expect(locate({ kind: 'layer', id: 'brief' })).toBeNull();
	});
});

describe('planCanvasToolPlayback', () => {
	it('clicks where a new node will land and types its label, before it exists', () => {
		const { snapshot } = board();
		const steps = planCanvasToolPlayback('canvas_add_node', { node: { id: 'qa', data: { label: 'QA' }, position: { x: 500, y: 300 }, width: 100, height: 40 } }, snapshot())!;
		expect(steps.map((s) => s.type)).toEqual(['move', 'focus', 'press', 'release', 'type', 'commit']);
		expect(steps[0]).toEqual({ type: 'move', to: { x: 550, y: 320 } });
		expect(steps[4]).toEqual({ type: 'type', text: 'QA' });
	});

	it('drags an edge from the source to the target', () => {
		const { snapshot } = board();
		const steps = planCanvasToolPlayback('canvas_connect', { source: 'review', target: 'brief', label: 'redo' }, snapshot())!;
		expect(steps.map((s) => s.type)).toEqual(['move', 'press', 'drag', 'release', 'type', 'commit']);
		expect(steps[0]).toEqual({ type: 'move', to: { x: 400, y: 140 } });
		expect(steps[2]).toEqual({ type: 'drag', to: { x: 0, y: 20 } });
	});

	it('points at the moved nodes after a layout commits', () => {
		const { snapshot } = board();
		const steps = planCanvasToolPlayback('canvas_layout', { direction: 'LR', incremental: false }, snapshot())!;
		expect(steps[0]).toEqual({ type: 'commit' });
		expect(steps.slice(1).map((s) => s.type)).toEqual(['move', 'focus', 'wait']);
	});

	it('returns null for invalid or non-canvas calls so the handler reports the error', () => {
		const { snapshot } = board();
		expect(planCanvasToolPlayback('canvas_connect', { source: 'brief', target: 'ghost' }, snapshot())).toBeNull();
		expect(planCanvasToolPlayback('prompt_insert_text', { text: 'hi' }, snapshot())).toBeNull();
	});

	it('is pure: same input, same steps, snapshot untouched', () => {
		const { snapshot } = board();
		const snap = snapshot();
		const copy = JSON.parse(JSON.stringify(snap));
		const args = { nodeIds: ['brief', 'review'] };
		expect(planCanvasToolPlayback('canvas_remove_nodes', args, snap)).toEqual(planCanvasToolPlayback('canvas_remove_nodes', args, snap));
		expect(snap).toEqual(copy);
	});

	it('maps model steps without a snapshot match to nothing', () => {
		expect(planCanvasPlaybackSteps([{ type: 'step:canvas_select', nodeIds: ['ghost'] }], [])).toEqual([]);
	});
});

describe('canvas tools through playback', () => {
	it('plays canvas_add_node and returns the same result as without playback', async () => {
		const played = board();
		const steps = played.playback.record();
		const result = await played.registry.callTool('canvas__canvas_add_node', { node: { id: 'qa', data: { label: 'QA' } }, nearNodeId: 'review' });
		expect(result.isError).toBeFalsy();
		// Placing the node beside Review also connects it: click, type, then drag the edge in.
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'focus', 'press', 'release', 'type', 'move', 'press', 'drag', 'release', 'commit', 'focus']);

		const plain = board();
		plain.playback.speed = Infinity;
		const same = await plain.registry.callTool('canvas__canvas_add_node', { node: { id: 'qa', data: { label: 'QA' } }, nearNodeId: 'review' });
		const withoutIds = (r: typeof result) => JSON.stringify(r).replace(/edge-[a-z0-9]+/g, 'edge');
		expect(withoutIds(same)).toEqual(withoutIds(result));
		expect(played.nodes.find((n) => n.id === 'qa')!.position).toEqual(plain.nodes.find((n) => n.id === 'qa')!.position);
	});

	it('clicks where the new node then appears', async () => {
		const played = board();
		const planned = planCanvasToolPlayback('canvas_add_node', { node: { id: 'qa', data: { label: 'QA' } } }, played.snapshot())!;
		await played.registry.callTool('canvas__canvas_add_node', { node: { id: 'qa', data: { label: 'QA' } } });
		const qa = createCanvasPlaybackLocator({ getNodes: () => played.nodes })({ kind: 'node', id: 'qa' })!;
		const centre = { x: qa.x + qa.width / 2, y: qa.y + qa.height / 2 };
		expect(planned[0]).toEqual({ type: 'move', to: centre });
		expect(played.presence.get('agent')).toMatchObject(centre);
	});

	it('returns a validation error unchanged without moving the cursor', async () => {
		const { registry, playback } = board();
		const steps = playback.record();
		const result = await registry.callTool('canvas__canvas_connect', { source: 'brief', target: 'ghost' });
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toMatch(/ghost/);
		expect(steps).toEqual([]);
	});

	it('glances at nothing for get_editor_state (a read with no targets)', async () => {
		const { registry, playback } = board();
		const steps = playback.record();
		await registry.callTool('canvas__get_editor_state', {});
		expect(steps).toEqual([]);
	});
});

describe('canvas playback conformance', () => {
	it('every canvas write tool has a plan, so none plays silently', () => {
		const provider = createEditorMcpToolProvider({ id: 'canvas', getSnapshot: () => ({ canvas: { nodes: [], edges: [] } }), applySteps: () => {} });
		const tools = typeof provider.tools === 'function' ? provider.tools() : provider.tools;
		const writes = tools.filter((t) => !t.annotations?.readOnlyHint && t.name.startsWith('canvas_'));
		expect(writes.length).toBeGreaterThan(5);
		expect(writes.filter((t) => typeof t.plan !== 'function').map((t) => t.name)).toEqual([]);
	});
});
