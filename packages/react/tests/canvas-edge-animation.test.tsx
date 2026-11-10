import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import React, { act, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToolRegistry } from '@pixerate/editor/tools';
import { AnimatedEdge, EdgeAnimation, createCanvasEdgeAnimationToolProvider, getCanvasEdgePath, type CanvasEdge } from '../src/canvas';

let container: HTMLDivElement;
let root: any;
let reduceMotion = false;
const listeners = new Set<() => void>();

beforeAll(() => {
	(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
	const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.com/editor' });
	globalThis.document = dom.window.document as any;
	globalThis.window = dom.window as any;
	(globalThis as any).Node = dom.window.Node;
	(globalThis as any).HTMLElement = dom.window.HTMLElement;
	(window as any).matchMedia = (media: string) => ({
		media,
		get matches() {
			return reduceMotion;
		},
		addEventListener: (_: string, fn: () => void) => listeners.add(fn),
		removeEventListener: (_: string, fn: () => void) => listeners.delete(fn)
	});
});

beforeEach(() => {
	reduceMotion = false;
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const edgeProps = { id: 'e1', sourceX: 0, sourceY: 0, targetX: 200, targetY: 0, sourcePosition: 'right', targetPosition: 'left' } as const;
const draw = (node: React.ReactNode) => act(() => root.render(<svg>{node}</svg>));

describe('<AnimatedEdge>', () => {
	it('draws the edge path React Flow draws, with travelling dots', () => {
		draw(<AnimatedEdge {...edgeProps} data={{ animation: { kind: 'dots', count: 3, color: '#0ff' } }} markerEnd="url(#arrow)" label="calls" />);
		const line = container.querySelector('path.react-flow__edge-path')!;
		expect(line.getAttribute('d')).toBe(getCanvasEdgePath({ ...edgeProps }).path);
		expect(line.getAttribute('marker-end')).toBe('url(#arrow)');
		const group = container.querySelector('[data-edge-animation="dots"]')!;
		expect(group.getAttribute('data-moving')).toBe('true');
		const motions = container.querySelectorAll('circle animateMotion');
		expect(motions).toHaveLength(3);
		expect(motions[1].getAttribute('calcMode')).toBe('linear');
		expect(motions[1].getAttribute('keyPoints')).toBe('0;1');
		expect(motions[0].querySelector('mpath')!.getAttribute('href')).toBe('#pixerate-edge-path-e1');
		expect(container.querySelector('circle')!.getAttribute('fill')).toBe('#0ff');
		expect(container.querySelector('.react-flow__edge-text')!.textContent).toBe('calls');
	});

	it('follows data.pathType and is a plain edge without an animation', () => {
		draw(<AnimatedEdge {...edgeProps} targetY={100} data={{ pathType: 'smoothstep' }} />);
		expect(container.querySelector('path.react-flow__edge-path')!.getAttribute('d')).toBe(getCanvasEdgePath({ ...edgeProps, targetY: 100, type: 'smoothstep' }).path);
		expect(container.querySelector('.pixerate-edge-animation')).toBeNull();
	});

	it('dims the track and glows a beam, coloured like the edge', () => {
		draw(<AnimatedEdge {...edgeProps} data={{ animation: { kind: 'beam' } }} style={{ stroke: '#f0f' }} />);
		const line = container.querySelector('path.react-flow__edge-path') as SVGPathElement;
		expect(line.style.strokeOpacity).toBe('0.35');
		expect(container.querySelector('filter')!.getAttribute('filterUnits')).toBe('userSpaceOnUse');
		const beam = container.querySelector('.pixerate-edge-animation > path')!;
		expect(beam.getAttribute('stroke')).toBe('#f0f');
		expect(beam.querySelector('animate')!.getAttribute('attributeName')).toBe('stroke-dashoffset');
	});

	it('ignores an invalid animation instead of throwing', () => {
		draw(<AnimatedEdge {...edgeProps} data={{ animation: { kind: 'sparkles' } as any }} />);
		expect(container.querySelector('path.react-flow__edge-path')).not.toBeNull();
		expect(container.querySelector('.pixerate-edge-animation')).toBeNull();
	});
});

describe('<EdgeAnimation>', () => {
	it('holds the first frame with reduced motion', () => {
		reduceMotion = true;
		draw(<EdgeAnimation id="e" path="M0 0 L100 0" animation={{ kind: 'dots', count: 2 }} />);
		expect(container.querySelector('[data-moving="false"]')).not.toBeNull();
		expect(container.querySelector('animateMotion')).toBeNull();
		expect([...container.querySelectorAll('circle')].map((c) => c.getAttribute('cx'))).toEqual(['0', '50']);
	});

	it('starts moving when reduced motion is turned off', () => {
		reduceMotion = true;
		draw(<EdgeAnimation id="e" path="M0 0 L100 0" animation={{ kind: 'dash' }} />);
		expect(container.querySelector('animate')).toBeNull();
		reduceMotion = false;
		act(() => listeners.forEach((fn) => fn()));
		expect(container.querySelector('animate')!.getAttribute('values')).toBe('0;-14');
	});
});

describe('edge animation tools with React state', () => {
	it('animates the edges an <AnimatedEdge> draws', async () => {
		let registry!: ToolRegistry;
		function Host() {
			const [edges, setEdges] = useState<CanvasEdge[]>([{ id: 'e1', source: 'a', target: 'b' }]);
			const live = React.useRef(edges);
			live.current = edges;
			const provider = useMemo(() => createCanvasEdgeAnimationToolProvider({ getEdges: () => live.current, setEdges }, { namespace: '' }), []);
			registry ??= (() => {
				const r = new ToolRegistry();
				r.register(provider);
				return r;
			})();
			return <svg>{edges.map((e) => <AnimatedEdge key={e.id} {...edgeProps} id={e.id} data={e.data} />)}</svg>;
		}
		act(() => root.render(<Host />));
		expect(container.querySelector('.pixerate-edge-animation')).toBeNull();
		let res: any;
		await act(async () => {
			res = await registry.callTool('set_edge_animation', { edges: ['e1'], animation: { kind: 'pulse' } });
		});
		expect(res.isError).toBeFalsy();
		expect(container.querySelector('[data-edge-animation="pulse"]')).not.toBeNull();
		const bad = await registry.callTool('set_edge_animation', { edges: ['zz'], animation: { kind: 'pulse' } });
		expect(bad.isError).toBe(true);
	});
});
