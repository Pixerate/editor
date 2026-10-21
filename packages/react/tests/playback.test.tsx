// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import React, { act, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolRegistry, PresenceStore, createAgentPlayback, createInstantPresenceClock, type AgentPlayback, type AgentToolProvider } from '@pixerate/editor/tools';
import { createEditorMcpToolProvider, type AgentStep } from '@pixerate/editor/agent';
import type { CanvasNode } from '@pixerate/editor/canvas';
import { AgentPlaybackProvider, PresenceLayer, useAgentToolProvider, usePlaybackSurface } from '../src';
import { useCanvasPlaybackSurface } from '../src/canvas';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function mount(ui: React.ReactElement) {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const root = createRoot(host);
	act(() => root.render(ui));
	return { host, root, unmount: () => act(() => root.unmount()) };
}

describe('PresenceLayer', () => {
	it('draws each actor at its viewport position with its note and focus ring', () => {
		const presence = new PresenceStore();
		const { host, unmount } = mount(<PresenceLayer presence={presence} viewport={{ x: 10, y: 20, zoom: 2 }} />);
		expect(host.querySelector('[data-testid="presence-layer"]')).toBeNull();
		act(() => presence.set({ id: 'a', name: 'Agent', color: '#7c3aed', x: 5, y: 5, message: 'Aligning', focus: { x: 0, y: 0, width: 10, height: 10 } }));
		const layer = host.querySelector('.pixerate-presence')!;
		expect(layer).toBeTruthy();
		expect((layer.querySelector('[data-actor="a"]') as HTMLElement).style.transform).toBe('translate(20px, 30px)');
		expect(layer.querySelector('[data-actor-message="a"]')!.textContent).toBe('Aligning');
		const ring = layer.querySelector('[data-actor-focus="a"]') as HTMLElement;
		expect([ring.style.left, ring.style.width]).toEqual(['6px', '28px']);
		unmount();
	});
});

describe('usePlaybackSurface', () => {
	it('attaches from context while mounted and detaches on unmount', async () => {
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		const provider: AgentToolProvider = {
			id: 'board',
			tools: [{ name: 'poke', description: 'poke', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, handler: ({ id }) => ({ poked: id }) }]
		};
		let presence!: PresenceStore;
		const Surface = () => {
			presence = usePlaybackSurface(undefined, 'board', { locate: (ref) => (ref.id === 'x' ? { x: 0, y: 0, width: 10, height: 10 } : null) });
			useAgentToolProvider(registry, provider, { playback });
			return null;
		};
		const { unmount } = mount(
			<AgentPlaybackProvider playback={playback}>
				<Surface />
			</AgentPlaybackProvider>
		);
		expect(playback.surface('board')).toBeTruthy();
		const steps = playback.record();
		await act(() => registry.callTool('board__poke', { id: 'x' }));
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'commit']);
		expect(presence.get('agent')).toMatchObject({ x: 5, y: 5 });
		unmount();
		expect(playback.surface('board')).toBeUndefined();
	});
});

describe('useCanvasPlaybackSurface', () => {
	it('plays canvas tool calls on the flow and maps the cursor through the viewport', async () => {
		const playback: AgentPlayback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		let nodes: CanvasNode[] = [{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' }, width: 100, height: 40 }];
		const Board = () => {
			const container = useRef<HTMLDivElement>(null);
			const viewport = { x: 50, y: 0, zoom: 2 };
			const presence = useCanvasPlaybackSurface(playback, 'canvas', { getNodes: () => nodes, viewport, container, visible: () => true });
			const provider = useMemo(
				() =>
					createEditorMcpToolProvider({
						id: 'canvas',
						surfaces: { canvas: true, prompt: false },
						getSnapshot: () => ({ canvas: { nodes, edges: [] } }),
						applySteps: (steps: AgentStep[]) => {
							for (const s of steps) if (s.type === 'step:canvas_select') nodes = nodes.map((n) => ({ ...n, selected: s.nodeIds.includes(n.id) }));
						}
					}),
				[]
			);
			useAgentToolProvider(registry, provider, { playback });
			return (
				<div ref={container} style={{ position: 'relative' }}>
					<PresenceLayer presence={presence} viewport={viewport} />
				</div>
			);
		};
		const { host, unmount } = mount(<Board />);
		const steps = playback.record();
		const result = await act(() => registry.callTool('canvas__canvas_select', { nodeIds: ['a'] }));
		expect(result.isError).toBeFalsy();
		expect(nodes[0]!.selected).toBe(true);
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'focus', 'press', 'release', 'commit']);
		expect((host.querySelector('[data-actor="agent"]') as HTMLElement).style.transform).toBe('translate(150px, 40px)');
		unmount();
	});
});

describe('VectorCanvas playback', () => {
	it('plays vector commands with the cursor in document units through the viewport', async () => {
		const { VectorCanvas } = await import('../src/vector');
		const { VectorEditorController, createVectorCommands } = await import('@pixerate/editor/vector');
		const { CommandRegistry, createCommandToolProvider } = await import('@pixerate/editor/commands');
		const controller = new VectorEditorController({ document: { width: 400, height: 300, nodes: [] } });
		controller.setViewport({ x: 10, y: 20, zoom: 2 });
		const commands = new CommandRegistry();
		commands.register(createVectorCommands(controller));
		const registry = new ToolRegistry();
		registry.register(createCommandToolProvider(commands, { id: 'commands' }));
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		const { host, unmount } = mount(
			<AgentPlaybackProvider playback={playback}>
				<VectorCanvas controller={controller} fitOnMount={false} />
			</AgentPlaybackProvider>
		);
		expect(playback.surface('vector')).toBeTruthy();
		// jsdom has no layout: report the canvas as visible.
		const surface = playback.surface('vector')!;
		(surface as { visible?: () => boolean }).visible = () => true;
		const steps = playback.record();
		const result = await act(() => registry.callTool('commands__run_command', { id: 'vector.addShape', params: { kind: 'rect', x: 50, y: 40, width: 20, height: 10 } }));
		expect(result.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'press', 'drag', 'release', 'commit', 'focus']);
		const v = controller.getState().viewport;
		const cursor = host.querySelector('[data-vector-presence] [data-actor="agent"]') as HTMLElement;
		expect(cursor.style.transform).toBe(`translate(${70 * v.zoom + v.x}px, ${50 * v.zoom + v.y}px)`);
		unmount();
		expect(playback.surface('vector')).toBeUndefined();
	});

	it('draws nothing and attaches nothing without a playback', async () => {
		const { VectorCanvas } = await import('../src/vector');
		const { VectorEditorController } = await import('@pixerate/editor/vector');
		const { host, unmount } = mount(<VectorCanvas controller={new VectorEditorController()} fitOnMount={false} />);
		expect(host.querySelector('[data-vector-presence]')).toBeNull();
		unmount();
	});
});
