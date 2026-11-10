import { describe, it, expect } from 'vitest';
import {
	CANVAS_EDGE_ANIMATION_KINDS,
	createCanvasEdgeAnimationToolProvider,
	getCanvasEdgeAnimation,
	getCanvasEdgeAnimationRender,
	getCanvasEdgePath,
	measureSvgPath,
	normalizeCanvasEdgeAnimation,
	resolveCanvasEdgeAnimation,
	sampleCanvasEdgeAnimation,
	setCanvasEdgeAnimation,
	type CanvasEdge
} from '../src/canvas';
import { HistoryManager } from '../src/history';
import { createToolRegistry } from '../src/tools';

const text = (res: { content: unknown[] }) => (res.content[0] as any).text as string;

describe('getCanvasEdgePath (matches xyflow)', () => {
	const base = { sourceX: 0, sourceY: 0, targetX: 200, targetY: 100, sourcePosition: 'right', targetPosition: 'left' } as const;

	it('draws the bézier xyflow draws', () => {
		// Expected strings recorded from @xyflow/system getBezierPath / getSmoothStepPath with the same inputs.
		expect(getCanvasEdgePath(base)).toEqual({ path: 'M0,0 C100,0 100,100 200,100', labelX: 100, labelY: 50 });
		expect(getCanvasEdgePath({ ...base, targetX: -200 }).path).toBe('M0,0 C88.38834764831844,0 -288.3883476483185,100 -200,100');
	});

	it('draws straight, simple bézier, step and smooth step paths', () => {
		expect(getCanvasEdgePath({ ...base, type: 'straight' })).toEqual({ path: 'M 0,0L 200,100', labelX: 100, labelY: 50 });
		expect(getCanvasEdgePath({ ...base, type: 'simplebezier' }).path).toBe('M0,0 C100,0 100,100 200,100');
		expect(getCanvasEdgePath({ ...base, type: 'step' }).path).toBe('M0 0L20 0L 100,0Q 100,0 100,0L 100,100Q 100,100 100,100L180 100L200 100');
		expect(getCanvasEdgePath({ ...base, type: 'smoothstep' }).path).toBe('M0 0L20 0L 95,0Q 100,0 100,5L 100,95Q 100,100 105,100L180 100L200 100');
	});

	it('defaults to bottom → top handles', () => {
		expect(getCanvasEdgePath({ sourceX: 0, sourceY: 0, targetX: 0, targetY: 100 }).path).toBe('M0,0 C0,50 0,50 0,100');
	});
});

describe('measureSvgPath', () => {
	it('measures lines, curves and relative commands', () => {
		expect(measureSvgPath('M0 0 L30 40').length).toBeCloseTo(50);
		expect(measureSvgPath('M0 0 h10 v10 H0 Z').length).toBeCloseTo(40);
		const arc = measureSvgPath('M0,0 C0,55.23 44.77,100 100,100'); // quarter circle, r = 100
		expect(arc.length).toBeCloseTo((Math.PI * 100) / 2, 0);
		expect(measureSvgPath('M0 0 Q 50 50 100 0').length).toBeGreaterThan(100);
	});

	it('finds points and directions along the path', () => {
		const m = measureSvgPath('M0 0 L100 0 L100 100');
		expect(m.pointAt(50)).toEqual({ x: 50, y: 0, angle: 0 });
		const down = m.pointAt(150);
		expect(down.x).toBeCloseTo(100);
		expect(down.y).toBeCloseTo(50);
		expect(down.angle).toBeCloseTo(Math.PI / 2);
		expect(m.pointAt(-10)).toMatchObject({ x: 0, y: 0 });
		expect(m.pointAt(1000)).toMatchObject({ x: 100, y: 100 });
		expect(m.bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 });
	});

	it('copes with empty paths', () => {
		expect(measureSvgPath('').length).toBe(0);
		expect(measureSvgPath('').pointAt(5)).toEqual({ x: 0, y: 0, angle: 0 });
	});
});

describe('edge animation model', () => {
	it('checks fields and says what is wrong', () => {
		expect(normalizeCanvasEdgeAnimation({ kind: 'dots', count: 4, extra: 1 })).toEqual({ kind: 'dots', count: 4 });
		expect(() => normalizeCanvasEdgeAnimation({ kind: 'sparkles' })).toThrow(/Unknown edge animation kind "sparkles".*dots, dash, beam, pulse/);
		expect(() => normalizeCanvasEdgeAnimation({ kind: 'dots', count: 2.5 })).toThrow(/"count" must be a whole number from 1 to 50/);
		expect(() => normalizeCanvasEdgeAnimation({ kind: 'dots', speed: -1 })).toThrow(/"speed".*canvas units per second/);
		expect(() => normalizeCanvasEdgeAnimation({ kind: 'beam', direction: 'up' })).toThrow(/forward, reverse, alternate/);
		expect(() => normalizeCanvasEdgeAnimation({ kind: 'beam', color: 'red; background: url(x)' })).toThrow(/CSS colour/);
		expect(() => normalizeCanvasEdgeAnimation(null)).toThrow(/"kind"/);
	});

	it('reads, sets and removes an edge animation without touching other data', () => {
		const edge: CanvasEdge = { id: 'e', source: 'a', target: 'b', data: { weight: 2 } };
		const animated = setCanvasEdgeAnimation(edge, { kind: 'beam', color: '#f00' });
		expect(animated.data).toEqual({ weight: 2, animation: { kind: 'beam', color: '#f00' } });
		expect(getCanvasEdgeAnimation(animated)).toEqual({ kind: 'beam', color: '#f00' });
		expect(setCanvasEdgeAnimation(animated, null).data).toEqual({ weight: 2 });
		expect(getCanvasEdgeAnimation({ data: { animation: { kind: 'nope' } } })).toBeNull();
		expect(getCanvasEdgeAnimation(edge)).toBeNull();
	});

	it('fills in defaults per kind', () => {
		for (const info of CANVAS_EDGE_ANIMATION_KINDS) {
			const resolved = resolveCanvasEdgeAnimation({ kind: info.kind });
			expect(resolved).toMatchObject({ ...info.defaults, kind: info.kind, paused: false });
		}
		expect(resolveCanvasEdgeAnimation({ kind: 'dots', speed: 10 }).speed).toBe(10);
	});
});

describe('getCanvasEdgeAnimationRender', () => {
	const path = 'M0 0 L200 0';

	it('spaces dots along the path and staggers them', () => {
		const r = getCanvasEdgeAnimationRender({ kind: 'dots', count: 4, speed: 100, color: '#0ff' }, { path, id: 'e1' });
		expect(r.length).toBe(200);
		expect(r.moving).toBe(true);
		expect(r.glowFilter).toBeUndefined();
		const dots = r.elements.filter((e) => e.type === 'dot') as any[];
		expect(dots).toHaveLength(4);
		expect(dots.map((d) => d.at.x)).toEqual([0, 50, 100, 150]);
		expect(dots.map((d) => d.motion.begin)).toEqual([-0, -0.5, -1, -1.5]);
		expect(dots[0]).toMatchObject({ r: 3, fill: '#0ff', motion: { dur: 2, keyPoints: '0;1', keyTimes: '0;1' } });
	});

	it('reverses and alternates dots', () => {
		const rev = getCanvasEdgeAnimationRender({ kind: 'dots', count: 1, direction: 'reverse' }, { path, id: 'e' }).elements[0] as any;
		expect(rev.motion.keyPoints).toBe('1;0');
		expect(rev.at.x).toBe(200);
		const alt = getCanvasEdgeAnimationRender({ kind: 'dots', count: 1, speed: 100, direction: 'alternate' }, { path, id: 'e' }).elements[0] as any;
		expect(alt.motion).toMatchObject({ keyPoints: '0;1;0', keyTimes: '0;0.5;1', dur: 4 });
	});

	it('marches dashes by one pattern per cycle', () => {
		const r = getCanvasEdgeAnimationRender({ kind: 'dash', length: 10, gap: 10, speed: 20 }, { path, id: 'e' });
		expect(r.trackOpacity).toBe(0);
		expect(r.elements[0]).toMatchObject({ type: 'stroke', strokeDasharray: '10 10', animate: [{ attributeName: 'stroke-dashoffset', values: '0;-20', dur: 1 }] });
		const reverse = getCanvasEdgeAnimationRender({ kind: 'dash', length: 10, gap: 10, direction: 'reverse' }, { path, id: 'e' });
		expect((reverse.elements[0] as any).animate[0].values).toBe('0;20');
	});

	it('shoots a glowing beam from before the start to past the end', () => {
		const r = getCanvasEdgeAnimationRender({ kind: 'beam', length: 40, speed: 240 }, { path, id: 'edge one', stroke: '#abc' });
		expect(r.glowFilter).toMatchObject({ id: 'pixerate-edge-glow-edge_one', stdDeviation: 2 });
		expect(r.glowFilter!.height).toBeGreaterThan(0);
		expect(r.elements[0]).toMatchObject({ stroke: '#abc', strokeDasharray: '40 200', filter: 'url(#pixerate-edge-glow-edge_one)', animate: [{ values: '40;-200', dur: 1 }] });
	});

	it('pulses opacity and width', () => {
		const r = getCanvasEdgeAnimationRender({ kind: 'pulse', size: 2, duration: 1000 }, { path, id: 'e' });
		expect((r.elements[0] as any).animate).toEqual([
			{ attributeName: 'stroke-opacity', values: '0.2;1;0.2', dur: 1, begin: 0 },
			{ attributeName: 'stroke-width', values: '2;3.5;2', dur: 1, begin: 0 }
		]);
	});

	it('holds still when paused, with reduced motion, or on an empty path', () => {
		expect(getCanvasEdgeAnimationRender({ kind: 'dots', paused: true }, { path, id: 'e' }).moving).toBe(false);
		expect(getCanvasEdgeAnimationRender({ kind: 'dots' }, { path, id: 'e', reducedMotion: true }).moving).toBe(false);
		expect(getCanvasEdgeAnimationRender({ kind: 'dots' }, { path: 'M0 0', id: 'e' }).moving).toBe(false);
	});
});

describe('sampleCanvasEdgeAnimation', () => {
	const path = 'M0 0 L200 0';

	it('moves dots with time', () => {
		const a = { kind: 'dots', count: 2, speed: 100 } as const;
		expect(sampleCanvasEdgeAnimation(a, path, 0).dots.map((d) => d.x)).toEqual([0, 100]);
		expect(sampleCanvasEdgeAnimation(a, path, 500).dots.map((d) => d.x)).toEqual([50, 150]);
		expect(sampleCanvasEdgeAnimation({ ...a, paused: true }, path, 500).dots.map((d) => d.x)).toEqual([0, 100]);
		expect(sampleCanvasEdgeAnimation({ ...a, direction: 'reverse' }, path, 500).dots.map((d) => d.x)).toEqual([150, 50]);
	});

	it('follows the beam along the path and off the end', () => {
		const a = { kind: 'beam', length: 40, speed: 240 } as const; // period 240: one cycle a second
		expect(sampleCanvasEdgeAnimation(a, path, 0).segments).toEqual([]);
		expect(sampleCanvasEdgeAnimation(a, path, 500).segments).toEqual([[80, 120]]);
		expect(sampleCanvasEdgeAnimation(a, path, 999).segments.every(([, to]) => to <= 200)).toBe(true);
	});

	it('holds a paused beam in the middle of the edge, as it is drawn', () => {
		const frame = sampleCanvasEdgeAnimation({ kind: 'beam', length: 40, paused: true }, path, 1234);
		expect(frame.segments).toEqual([[80, 120]]);
		const still = getCanvasEdgeAnimationRender({ kind: 'beam', length: 40 }, { path, id: 'e', reducedMotion: true }).elements[0] as any;
		expect(still.strokeDashoffset).toBe(-80);
	});

	it('marches dash segments and pulses', () => {
		const dash = sampleCanvasEdgeAnimation({ kind: 'dash', length: 10, gap: 10, speed: 20 }, 'M0 0 L40 0', 250);
		expect(dash.segments).toEqual([[5, 15], [25, 35]]); // a quarter cycle on: every dash 5 units further along
		const pulse = sampleCanvasEdgeAnimation({ kind: 'pulse', duration: 1000, size: 2 }, path, 500);
		expect(pulse.opacity).toBeCloseTo(1);
		expect(pulse.strokeWidth).toBeCloseTo(3.5);
		expect(pulse.segments).toEqual([[0, 200]]);
	});
});

describe('edge animation tools', () => {
	const setup = (readOnly?: string) => {
		let edges: CanvasEdge[] = [
			{ id: 'e1', source: 'a', target: 'b', label: 'calls' },
			{ id: 'e2', source: 'b', target: 'c' }
		];
		const history = new HistoryManager();
		const registry = createToolRegistry();
		registry.register(
			createCanvasEdgeAnimationToolProvider({ getEdges: () => edges, setEdges: (update) => (edges = update(edges)), history }, { namespace: 'canvas', readOnly })
		);
		return { registry, history, edges: () => edges };
	};

	it('lists edges and the kinds', async () => {
		const { registry } = setup();
		const out = (await registry.callTool('canvas__list_edge_animations', {})).structuredContent as any;
		expect(out.edges).toEqual([
			{ id: 'e1', source: 'a', target: 'b', label: 'calls', animation: null },
			{ id: 'e2', source: 'b', target: 'c', animation: null }
		]);
		expect(out.kinds.map((k: any) => k.kind)).toEqual(['dots', 'dash', 'beam', 'pulse']);
		expect(out.readOnly).toBeNull();
	});

	it('animates several edges in one undo step and returns what will play', async () => {
		const { registry, history, edges } = setup();
		const res = await registry.callTool('canvas__set_edge_animation', { edges: ['e1', 'e2'], animation: { kind: 'dots', count: 5, color: '#22d3ee' } });
		expect(res.isError).toBeFalsy();
		const out = res.structuredContent as any;
		expect(out.edges).toEqual(['e1', 'e2']);
		expect(out.animation).toEqual({ kind: 'dots', count: 5, color: '#22d3ee' });
		expect(out.resolved).toMatchObject({ kind: 'dots', count: 5, speed: 80, size: 3, direction: 'forward' });
		expect(edges().map((e) => e.data?.animation?.kind)).toEqual(['dots', 'dots']);
		history.undo();
		expect(edges().map((e) => e.data?.animation)).toEqual([undefined, undefined]);
		history.redo();
		expect(edges()[1].data?.animation).toEqual({ kind: 'dots', count: 5, color: '#22d3ee' });
	});

	it('clears animations and reports edges that had none', async () => {
		const { registry, history, edges } = setup();
		await registry.callTool('canvas__set_edge_animation', { edges: ['e1'], animation: { kind: 'beam' } });
		const out = (await registry.callTool('canvas__clear_edge_animation', { edges: ['e1', 'e2'] })).structuredContent as any;
		expect(out).toEqual({ cleared: ['e1'], unchanged: ['e2'] });
		expect(edges()[0].data?.animation).toBeUndefined();
		history.undo();
		expect(edges()[0].data?.animation).toEqual({ kind: 'beam' });
	});

	it('refuses bad input before changing anything', async () => {
		const { registry, edges } = setup();
		const unknown = await registry.callTool('canvas__set_edge_animation', { edges: ['e1', 'nope'], animation: { kind: 'dots' } });
		expect(unknown.isError).toBe(true);
		expect(text(unknown)).toMatch(/No edge "nope" on the canvas.*list_edge_animations/);
		expect(edges()[0].data).toBeUndefined();
		const badKind = await registry.callTool('canvas__set_edge_animation', { edges: ['e1'], animation: { kind: 'sparkles' } });
		expect(badKind.isError).toBe(true);
		const extra = await registry.callTool('canvas__set_edge_animation', { edges: ['e1'], animation: { kind: 'dots', wobble: 1 } });
		expect(extra.isError).toBe(true);
		const empty = await registry.callTool('canvas__clear_edge_animation', { edges: [] });
		expect(empty.isError).toBe(true);
	});

	it('hides write tools when read-only and says why', async () => {
		const { registry } = setup('This canvas is locked.');
		const names = registry.listTools().tools.map((t) => t.name);
		expect(names).toContain('canvas__list_edge_animations');
		expect(names).not.toContain('canvas__set_edge_animation');
		const out = (await registry.callTool('canvas__list_edge_animations', {})).structuredContent as any;
		expect(out.readOnly).toBe('This canvas is locked.');
	});
});
