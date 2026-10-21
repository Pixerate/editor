import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { ToolRegistry, PresenceStore, createAgentPlayback, createInstantPresenceClock } from '@pixerate/editor/tools';
import { createEditorMcpToolProvider, type AgentStep } from '@pixerate/editor/agent';
import type { CanvasNode } from '@pixerate/editor/canvas';
import { PresenceLayer } from '../src';
import CanvasPlaybackProbe from './fixtures/CanvasPlaybackProbe.svelte';

let cleanups: (() => void)[] = [];
afterEach(() => {
	cleanups.forEach((fn) => fn());
	cleanups = [];
});

function render(component: any, props: Record<string, any>) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const instance = mount(component, { target, props });
	flushSync();
	cleanups.push(() => {
		unmount(instance);
		target.remove();
	});
	return { target, destroy: () => unmount(instance) };
}

describe('PresenceLayer (Svelte)', () => {
	it('draws each actor at its viewport position with its note and focus ring', () => {
		const presence = new PresenceStore();
		const { target } = render(PresenceLayer, { presence, viewport: { x: 10, y: 20, zoom: 2 } });
		expect(target.querySelector('.pixerate-presence')).toBeNull();
		presence.set({ id: 'a', name: 'Agent', color: '#7c3aed', x: 5, y: 5, message: 'Aligning', focus: { x: 0, y: 0, width: 10, height: 10 } });
		flushSync();
		const layer = target.querySelector('.pixerate-presence')!;
		expect((layer.querySelector('[data-actor="a"]') as HTMLElement).style.transform).toBe('translate(20px, 30px)');
		expect(layer.querySelector('[data-actor-message="a"]')!.textContent).toBe('Aligning');
		const ring = layer.querySelector('[data-actor-focus="a"]') as HTMLElement;
		expect([ring.style.left, ring.style.width]).toEqual(['6px', '28px']);
	});
});

describe('createCanvasPlaybackSurface', () => {
	it('plays canvas tool calls on the flow, maps through the viewport and detaches on destroy', async () => {
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		let nodes: CanvasNode[] = [{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' }, width: 100, height: 40 }];
		const provider = createEditorMcpToolProvider({
			id: 'canvas',
			surfaces: { canvas: true, prompt: false },
			getSnapshot: () => ({ canvas: { nodes, edges: [] } }),
			applySteps: (steps: AgentStep[]) => {
				for (const s of steps) if (s.type === 'step:canvas_select') nodes = nodes.map((n) => ({ ...n, selected: s.nodeIds.includes(n.id) }));
			}
		});
		const { target, destroy } = render(CanvasPlaybackProbe, { playback, registry, provider, getNodes: () => nodes });
		expect(playback.surface('canvas')).toBeTruthy();
		const steps = playback.record();
		const result = await registry.callTool('canvas__canvas_select', { nodeIds: ['a'] });
		flushSync();
		expect(result.isError).toBeFalsy();
		expect(nodes[0]!.selected).toBe(true);
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'focus', 'press', 'release', 'commit']);
		expect((target.querySelector('[data-actor="agent"]') as HTMLElement).style.transform).toBe('translate(150px, 40px)');
		destroy();
		cleanups = [];
		target.remove();
		expect(playback.surface('canvas')).toBeUndefined();
	});
});

describe('VectorCanvas playback (Svelte)', () => {
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
		const { target } = render(VectorCanvas, { controller, fitOnMount: false, playback });
		const surface = playback.surface('vector')!;
		expect(surface).toBeTruthy();
		// jsdom has no layout: report the canvas as visible.
		(surface as { visible?: () => boolean }).visible = () => true;
		const steps = playback.record();
		const result = await registry.callTool('commands__run_command', { id: 'vector.addShape', params: { kind: 'rect', x: 50, y: 40, width: 20, height: 10 } });
		flushSync();
		expect(result.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'press', 'drag', 'release', 'commit', 'focus']);
		const v = controller.getState().viewport;
		const cursor = target.querySelector('[data-vector-presence] [data-actor="agent"]') as HTMLElement;
		expect(cursor.style.transform).toBe(`translate(${70 * v.zoom + v.x}px, ${50 * v.zoom + v.y}px)`);
	});

	it('draws nothing and attaches nothing without a playback', async () => {
		const { VectorCanvas } = await import('../src/vector');
		const { VectorEditorController } = await import('@pixerate/editor/vector');
		const { target } = render(VectorCanvas, { controller: new VectorEditorController(), fitOnMount: false });
		expect(target.querySelector('[data-vector-presence]')).toBeNull();
	});
});

describe('ImageEditor playback (Svelte)', () => {
	it('opens the panel a tool belongs to and plays on the image surface', async () => {
		HTMLCanvasElement.prototype.getContext = (() => null) as any;
		const { ImageEditor, createReactiveImageEditor } = await import('../src/image-editor');
		const { createImageEditorToolProvider } = await import('@pixerate/editor/image-editor');
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		const registry = new ToolRegistry();
		playback.install(registry);
		const fake = { width: 40, height: 30, naturalWidth: 40, naturalHeight: 30 } as unknown as HTMLImageElement;
		const editor = createReactiveImageEditor({ image: fake });
		registry.register(createImageEditorToolProvider(editor.controller, { id: 'image', namespace: 'image' }));
		const { target, destroy } = render(ImageEditor, { editor, playback });
		const surface = playback.surface('image')!;
		expect(surface).toBeTruthy();
		(surface as { visible?: () => boolean }).visible = () => true;
		expect(target.querySelector('[data-control-id="contrast"]')).toBeNull();
		const steps = playback.record();
		const result = await registry.callTool('image__set_adjustments', { values: { contrast: 20 } });
		flushSync();
		expect(result.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['open', 'target', 'commit']);
		expect(target.querySelector('[data-image-tab="adjust"]')!.className).toContain('bg-indigo-600');
		expect(target.querySelector('[data-control-id="contrast"]')).toBeTruthy();
		destroy();
		cleanups = [];
		target.remove();
		expect(playback.surface('image')).toBeUndefined();
	});
});
