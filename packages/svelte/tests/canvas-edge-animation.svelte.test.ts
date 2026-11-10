import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { ToolRegistry } from '@pixerate/editor/tools';
import { AnimatedEdge, EdgeAnimation, createCanvasEdgeAnimationToolProvider, getCanvasEdgePath, type CanvasEdge } from '../src/canvas';

let cleanups: (() => void)[] = [];
let reduceMotion = false;
const listeners = new Set<() => void>();
beforeEach(() => {
	reduceMotion = false;
	(window as any).matchMedia = (media: string) => ({
		media,
		get matches() {
			return reduceMotion;
		},
		addEventListener: (_: string, fn: () => void) => listeners.add(fn),
		removeEventListener: (_: string, fn: () => void) => listeners.delete(fn)
	});
});
afterEach(() => {
	cleanups.forEach((fn) => fn());
	cleanups = [];
});

function render(component: any, props: Record<string, any>) {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	document.body.appendChild(svg);
	const instance = mount(component, { target: svg, props });
	flushSync();
	cleanups.push(() => {
		unmount(instance);
		svg.remove();
	});
	return { svg, instance };
}

const edgeProps = { id: 'e1', sourceX: 0, sourceY: 0, targetX: 200, targetY: 0, sourcePosition: 'right', targetPosition: 'left' } as const;

describe('<AnimatedEdge> (Svelte)', () => {
	it('draws the Svelte Flow path with travelling dots', () => {
		const { svg } = render(AnimatedEdge, { ...edgeProps, data: { animation: { kind: 'dots', count: 3, color: '#0ff' } }, markerEnd: 'url(#arrow)', label: 'calls' });
		const line = svg.querySelector('path.svelte-flow__edge-path')!;
		expect(line.getAttribute('d')).toBe(getCanvasEdgePath({ ...edgeProps }).path);
		expect(line.getAttribute('marker-end')).toBe('url(#arrow)');
		expect(line.namespaceURI).toBe('http://www.w3.org/2000/svg');
		expect(svg.querySelector('[data-edge-animation="dots"]')!.getAttribute('data-moving')).toBe('true');
		const motions = svg.querySelectorAll('circle animateMotion');
		expect(motions).toHaveLength(3);
		expect(motions[0].getAttribute('calcMode')).toBe('linear');
		expect(motions[0].querySelector('mpath')!.getAttribute('href')).toBe('#pixerate-edge-path-e1');
		expect(svg.querySelector('circle')!.getAttribute('fill')).toBe('#0ff');
		expect(svg.querySelector('.svelte-flow__edge-text')!.textContent).toBe('calls');
	});

	it('follows data.pathType and is a plain edge without an animation', () => {
		const { svg } = render(AnimatedEdge, { ...edgeProps, targetY: 100, data: { pathType: 'step' } });
		expect(svg.querySelector('path.svelte-flow__edge-path')!.getAttribute('d')).toBe(getCanvasEdgePath({ ...edgeProps, targetY: 100, type: 'step' }).path);
		expect(svg.querySelector('.pixerate-edge-animation')).toBeNull();
	});

	it('dims the track and glows a beam in the edge stroke colour', () => {
		const { svg } = render(AnimatedEdge, { ...edgeProps, data: { animation: { kind: 'beam' } }, style: 'stroke: #f0f' });
		expect(svg.querySelector('path.svelte-flow__edge-path')!.getAttribute('style')).toContain('stroke-opacity: 0.35');
		expect(svg.querySelector('filter')!.getAttribute('filterUnits')).toBe('userSpaceOnUse');
		const beam = svg.querySelector('.pixerate-edge-animation > path')!;
		expect(beam.getAttribute('stroke')).toBe('#f0f');
		expect(beam.querySelector('animate')!.getAttribute('attributeName')).toBe('stroke-dashoffset');
	});
});

describe('<EdgeAnimation> (Svelte)', () => {
	it('holds the first frame with reduced motion and moves when it is turned off', () => {
		reduceMotion = true;
		const { svg } = render(EdgeAnimation, { id: 'e', path: 'M0 0 L100 0', animation: { kind: 'dots', count: 2 } });
		expect(svg.querySelector('animateMotion')).toBeNull();
		expect([...svg.querySelectorAll('circle')].map((c) => c.getAttribute('cx'))).toEqual(['0', '50']);
		reduceMotion = false;
		listeners.forEach((fn) => fn());
		flushSync();
		expect(svg.querySelectorAll('animateMotion')).toHaveLength(2);
	});
});

describe('edge animation tools (Svelte)', () => {
	it('writes edge.data.animation through a Svelte-style setter', async () => {
		let edges: CanvasEdge[] = [{ id: 'e1', source: 'a', target: 'b' }];
		const registry = new ToolRegistry();
		registry.register(createCanvasEdgeAnimationToolProvider({ getEdges: () => edges, setEdges: (update) => (edges = update(edges)) }, { namespace: '' }));
		const res = await registry.callTool('set_edge_animation', { edges: ['e1'], animation: { kind: 'dash', direction: 'reverse' } });
		expect(res.isError).toBeFalsy();
		const { svg } = render(AnimatedEdge, { ...edgeProps, data: edges[0].data });
		expect(svg.querySelector('[data-edge-animation="dash"] animate')!.getAttribute('values')).toBe('0;14');
	});
});
