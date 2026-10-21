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
