import { describe, it, expect } from 'vitest';
import {
	arrowGesture,
	bracketGesture,
	checkGesture,
	circleGesture,
	createCanvasDrawController,
	crossGesture,
	gestureEdgePoint,
	gestureUnion,
	strikeGesture,
	underlineGesture,
	type CanvasNode,
	type GesturePoint,
	type GestureRect
} from '../src/canvas';
import { CommandRegistry, createCommandToolProvider, createDrawCommands } from '../src/commands';
import { PresenceStore, ToolRegistry, createAgentPlayback, createInstantPresenceClock } from '../src/tools';
import { HistoryManager } from '../src/history';

const card: GestureRect = { x: 100, y: 80, width: 160, height: 40 };
const inside = (p: GesturePoint, r: GestureRect) => p[0] > r.x && p[0] < r.x + r.width && p[1] > r.y && p[1] < r.y + r.height;
const extent = (points: GesturePoint[]) => ({
	minX: Math.min(...points.map((p) => p[0])),
	maxX: Math.max(...points.map((p) => p[0])),
	minY: Math.min(...points.map((p) => p[1])),
	maxY: Math.max(...points.map((p) => p[1]))
});
/** Total angle the path turns through around a centre (radians, signed). */
function winding(points: GesturePoint[], [cx, cy]: GesturePoint) {
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		let d = Math.atan2(points[i][1] - cy, points[i][0] - cx) - Math.atan2(points[i - 1][1] - cy, points[i - 1][0] - cx);
		if (d > Math.PI) d -= 2 * Math.PI;
		if (d < -Math.PI) d += 2 * Math.PI;
		total += d;
	}
	return total;
}
const distance = (a: GesturePoint, b: GesturePoint) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('gesture geometry', () => {
	it('is stable for a seed and varies between seeds', () => {
		expect(circleGesture(card, 7)).toEqual(circleGesture(card, 7));
		expect(circleGesture(card, 7).points).not.toEqual(circleGesture(card, 8).points);
		expect(arrowGesture([0, 0], card, 3)).toEqual(arrowGesture([0, 0], card, 3));
	});

	it('circles the rect once and a little more, never cutting into it, with ends that do not meet', () => {
		for (const seed of [1, 2, 3, 42, 999]) {
			for (const rect of [card, { x: 0, y: 0, width: 20, height: 300 }, { x: -50, y: 10, width: 8, height: 8 }]) {
				const { points, pressure } = circleGesture(rect, seed);
				expect(points.every((p) => !inside(p, rect))).toBe(true);
				// The corners are inside the loop: it goes round the centre more than once.
				expect(Math.abs(winding(points, [rect.x + rect.width / 2, rect.y + rect.height / 2]))).toBeGreaterThan(2 * Math.PI);
				expect(distance(points[0], points.at(-1)!)).toBeGreaterThan(0.5);
				expect(pressure).toHaveLength(5);
				expect(pressure.every((v) => v >= 0 && v <= 1)).toBe(true);
			}
		}
	});

	it('pads the circle by `padding`', () => {
		const tight = extent(circleGesture(card, 5, { padding: 0 }).points);
		const loose = extent(circleGesture(card, 5, { padding: 30 }).points);
		expect(loose.maxX - loose.minX).toBeGreaterThan(tight.maxX - tight.minX + 50);
	});

	it('underlines just below the bottom edge, about as long as the rect', () => {
		for (const seed of [1, 2, 3]) {
			for (const wave of [false, true]) {
				const { points } = underlineGesture(card, seed, { wave });
				const e = extent(points);
				expect(e.minY).toBeGreaterThan(card.y + card.height);
				expect(e.minY).toBeLessThan(card.y + card.height + 20);
				const length = e.maxX - e.minX;
				expect(length).toBeGreaterThan(card.width * 0.9);
				expect(length).toBeLessThan(card.width * 1.15);
			}
		}
		const straight = extent(underlineGesture(card, 1).points);
		const wavy = extent(underlineGesture(card, 1, { wave: true }).points);
		expect(wavy.maxY - wavy.minY).toBeGreaterThan(straight.maxY - straight.minY);
		expect(extent(underlineGesture(card, 1, { offset: 30 }).points).minY).toBeGreaterThan(card.y + card.height + 30);
	});

	it('starts and ends an arrow at the nearest edges, `gap` clear of them, with a head at the tip', () => {
		const swatch: GestureRect = { x: -200, y: 300, width: 40, height: 40 };
		for (const seed of [1, 2, 3]) {
			const { points } = arrowGesture(swatch, card, seed);
			const tip = gestureEdgePoint(card, [-180, 320], 6);
			const start = gestureEdgePoint(swatch, [180, 100], 6);
			expect(points[0]).toEqual([Math.round(start[0] * 100) / 100, Math.round(start[1] * 100) / 100]);
			// The tip is visited twice (once per barb), on the card's edge plus the gap.
			const atTip = points.filter((p) => distance(p, tip) < 0.02);
			expect(atTip.length).toBeGreaterThanOrEqual(2);
			expect(points.every((p) => !inside(p, card) && !inside(p, swatch))).toBe(true);
			// The barbs reach back from the tip.
			expect(Math.max(...points.map((p) => distance(p, tip)))).toBeGreaterThan(8);
		}
		// Point ends are used as they are; curve 0 keeps the shaft straight.
		const straight = arrowGesture([0, 0], [200, 0], 4, { curve: 0 });
		expect(straight.points[0]).toEqual([0, 0]);
		expect(straight.points.some((p) => p[0] === 200 && p[1] === 0)).toBe(true);
		const shaft = straight.points.filter((p) => p[0] < 150);
		expect(Math.max(...shaft.map((p) => Math.abs(p[1])))).toBeLessThan(3);
		const bent = arrowGesture([0, 0], [200, 0], 4, { curve: 0.8 });
		expect(Math.max(...bent.points.map((p) => Math.abs(p[1])))).toBeGreaterThan(50);
		expect(() => arrowGesture(card, card, 1)).toThrow(/too close/);
	});

	it('spans the rect with a bracket on the chosen side, outside it', () => {
		for (const shape of ['curly', 'square'] as const) {
			for (const seed of [1, 2]) {
				const left = extent(bracketGesture(card, 'left', seed, { shape }).points);
				expect(left.maxX).toBeLessThanOrEqual(card.x - 8 + 0.01);
				expect(left.minY).toBeLessThanOrEqual(card.y + 0.01);
				expect(left.maxY).toBeGreaterThanOrEqual(card.y + card.height - 0.01);
				expect(left.minX).toBeGreaterThan(card.x - 8 - 25);

				const right = extent(bracketGesture(card, 'right', seed, { shape }).points);
				expect(right.minX).toBeGreaterThanOrEqual(card.x + card.width + 8 - 0.01);
				const top = extent(bracketGesture(card, 'top', seed, { shape }).points);
				expect(top.maxY).toBeLessThanOrEqual(card.y - 8 + 0.01);
				expect(top.minX).toBeLessThanOrEqual(card.x + 0.01);
				expect(top.maxX).toBeGreaterThanOrEqual(card.x + card.width - 0.01);
				const bottom = extent(bracketGesture(card, 'bottom', seed, { shape }).points);
				expect(bottom.minY).toBeGreaterThanOrEqual(card.y + card.height + 8 - 0.01);
			}
		}
		// A curly brace points out furthest in the middle.
		const { points } = bracketGesture(card, 'left', 1, { depth: 16 });
		const furthest = points.reduce((a, b) => (b[0] < a[0] ? b : a));
		expect(Math.abs(furthest[1] - (card.y + card.height / 2))).toBeLessThan(card.height * 0.1);
	});

	it('strikes through the middle and crosses corner to corner', () => {
		const strike = extent(strikeGesture(card, 1).points);
		expect(strike.minX).toBeLessThan(card.x);
		expect(strike.maxX).toBeGreaterThan(card.x + card.width);
		expect(strike.minY).toBeGreaterThan(card.y + card.height * 0.25);
		expect(strike.maxY).toBeLessThan(card.y + card.height * 0.75);

		const { points } = crossGesture(card, 1);
		const corners: GesturePoint[] = [
			[card.x, card.y],
			[card.x + card.width, card.y],
			[card.x, card.y + card.height],
			[card.x + card.width, card.y + card.height]
		];
		for (const corner of corners) expect(Math.min(...points.map((p) => distance(p, corner)))).toBeLessThan(card.width * 0.08);
		// Starts top left and ends bottom left.
		expect(distance(points[0], corners[0])).toBeLessThan(card.width * 0.08);
		expect(distance(points.at(-1)!, corners[2])).toBeLessThan(card.width * 0.08);
	});

	it('puts a tick in the middle of a rect or on a point', () => {
		const tick = extent(checkGesture(card, 1).points);
		expect((tick.minX + tick.maxX) / 2).toBeCloseTo(card.x + card.width / 2, -1);
		expect(tick.maxY - tick.minY).toBeGreaterThan(card.height * 0.5);
		expect(tick.maxY - tick.minY).toBeLessThan(card.height);
		const atPoint = extent(checkGesture([500, 500], 1, { size: 40 }).points);
		expect(atPoint.maxY - atPoint.minY).toBeGreaterThan(30);
		expect(atPoint.minX).toBeGreaterThan(470);
		expect(atPoint.maxX).toBeLessThan(530);
	});

	it('unions rects', () => {
		expect(gestureUnion([card, { x: 0, y: 200, width: 10, height: 10 }])).toEqual({ x: 0, y: 80, width: 260, height: 130 });
		expect(() => gestureUnion([])).toThrow(/at least one/);
	});
});

function setup(options: { readOnly?: boolean } = {}) {
	let nodes: CanvasNode[] = [
		{ id: 'card', position: { x: 100, y: 80 }, width: 160, height: 40, data: {} },
		{ id: 'swatch', position: { x: -200, y: 300 }, width: 40, height: 40, data: {} }
	];
	const history = new HistoryManager({ maxDepth: 50 });
	let n = 0;
	const draw = createCanvasDrawController({
		getNodes: () => nodes,
		setNodes: (next) => {
			nodes = next;
		},
		history,
		generateNodeId: () => `n${++n}`
	});
	const commands = new CommandRegistry();
	commands.register(createDrawCommands(draw, options.readOnly ? { readOnlyReason: () => 'The canvas is read-only.' } : {}));
	const registry = new ToolRegistry();
	registry.register(createCommandToolProvider(commands));
	const run = (id: string, params: unknown) => registry.callTool('run_command', { id, params });
	return { draw, history, nodes: () => nodes, commands, registry, run };
}

const strokes = (nodes: CanvasNode[]) => nodes.filter((n) => n.type === 'shape');

describe('gesture commands', () => {
	it('circles a node by id as one stroke node, in one undo step, and returns its id, bounds and seed', async () => {
		const { run, nodes, history } = setup();
		const result = await run('canvas.circle', { around: [{ nodeId: 'card' }] });
		expect(result.isError).toBeUndefined();
		const out = (result.structuredContent as any).result;
		expect(out.id).toBe('n1');
		expect(out.seed).toEqual(expect.any(Number));
		expect(out.bounds.x).toBeLessThan(card.x);
		expect(out.bounds.y).toBeLessThan(card.y);
		expect(out.bounds.x + out.bounds.width).toBeGreaterThan(card.x + card.width);
		expect(out.bounds.y + out.bounds.height).toBeGreaterThan(card.y + card.height);
		expect(strokes(nodes())).toHaveLength(1);
		expect((strokes(nodes())[0].data as any).shape).toMatchObject({ kind: 'path', stroke: '#3b82f6', fill: 'none' });
		history.undo();
		expect(strokes(nodes())).toHaveLength(0);
	});

	it('draws the same mark for the same request, and another for another seed', async () => {
		const a = setup();
		const b = setup();
		const params = { from: { nodeId: 'swatch' }, to: { nodeId: 'card' } };
		const first = (await a.run('canvas.arrow', params)).structuredContent as any;
		const second = (await b.run('canvas.arrow', params)).structuredContent as any;
		expect(first.result.seed).toBe(second.result.seed);
		expect((strokes(a.nodes())[0].data as any).shape.d).toBe((strokes(b.nodes())[0].data as any).shape.d);
		await b.run('canvas.arrow', { ...params, seed: first.result.seed + 1 });
		expect((strokes(b.nodes())[1].data as any).shape.d).not.toBe((strokes(b.nodes())[0].data as any).shape.d);
		const seeded = (await a.run('canvas.arrow', { ...params, seed: 12 })).structuredContent as any;
		expect(seeded.result.seed).toBe(12);
	});

	it('runs every gesture on boxes, points and nodes', async () => {
		const { run, nodes } = setup();
		const box = { x: 0, y: 0, width: 80, height: 20 };
		const calls: Array<[string, unknown]> = [
			['canvas.circle', { around: [box, { nodeId: 'card' }], padding: 4 }],
			['canvas.underline', { under: box, wave: true, offset: 2 }],
			['canvas.arrow', { from: [0, 300], to: box, curve: -0.3, gap: 2 }],
			['canvas.bracket', { around: [{ nodeId: 'card' }], side: 'right', shape: 'square', depth: 10 }],
			['canvas.strike', { over: { nodeId: 'card' } }],
			['canvas.cross', { over: box, tool: 'highlighter' }],
			['canvas.check', { at: [400, 400], size: 24, color: '#16a34a', width: 4, opacity: 0.8 }]
		];
		for (const [id, params] of calls) {
			const result = await run(id, params);
			expect(result.isError, `${id}: ${JSON.stringify(result.structuredContent)}`).toBeUndefined();
		}
		expect(strokes(nodes())).toHaveLength(calls.length);
		expect((strokes(nodes())[5].data as any).shape).toMatchObject({ stroke: '#facc15', strokeWidth: 24, opacity: 0.35 });
		expect((strokes(nodes())[6].data as any).shape).toMatchObject({ stroke: '#16a34a', strokeWidth: 4, opacity: 0.8 });
	});

	it('gives a brushed gesture an uneven hand pressure', async () => {
		const { run } = setup();
		const result = await run('canvas.underline', { under: card, brush: 'marker' });
		expect(result.isError).toBeUndefined();
		const brush = (result.structuredContent as any).result.brush;
		expect(brush.brush).toBe('marker');
		expect(brush.pressure).toHaveLength(5);
		expect(new Set(brush.pressure).size).toBeGreaterThan(1);
	});

	it('refuses bad input before changing anything, saying how to fix it', async () => {
		const { run, nodes } = setup();
		const message = async (id: string, params: unknown) => {
			const result = await run(id, params);
			expect(result.isError).toBe(true);
			return (result.structuredContent as any).error.message as string;
		};
		expect(await message('canvas.circle', { around: [{ nodeId: 'nope' }] })).toMatch(/Unknown node "nope" in around\[0\]: use an id from get_editor_state/);
		expect(await message('canvas.underline', { under: [10, 10] })).toMatch(/under/);
		expect(await message('canvas.bracket', { around: [card] })).toMatch(/side/);
		expect(await message('canvas.bracket', { around: [card], side: 'middle' })).toMatch(/left/);
		expect(await message('canvas.arrow', { from: { nodeId: 'card' }, to: { nodeId: 'card' } })).toMatch(/too close/);
		expect(await message('canvas.circle', { around: [] })).toMatch(/at least 1/);
		expect(await message('canvas.check', { at: card, brush: 'watercolor-round' })).toMatch(/not a dry brush/);
		expect(await message('canvas.circle', { around: [card], extra: 1 })).toMatch(/extra/);
		expect(strokes(nodes())).toHaveLength(0);
	});

	it('takes boxes only when the target cannot look up nodes', async () => {
		const { draw } = setup();
		const commands = new CommandRegistry();
		commands.register(createDrawCommands({ drawStroke: draw.drawStroke, listBrushes: draw.listBrushes }));
		const registry = new ToolRegistry();
		registry.register(createCommandToolProvider(commands));
		const refused = await registry.callTool('run_command', { id: 'canvas.circle', params: { around: [{ nodeId: 'card' }] } });
		expect((refused.structuredContent as any).error.message).toMatch(/cannot look up nodes: pass around\[0\] as a box/);
		const ok = await registry.callTool('run_command', { id: 'canvas.circle', params: { around: [card] } });
		expect(ok.isError).toBeUndefined();
	});

	it('refuses every gesture on a read-only canvas, with the reason', async () => {
		const { commands, run } = setup({ readOnly: true });
		for (const id of ['canvas.circle', 'canvas.underline', 'canvas.arrow', 'canvas.bracket', 'canvas.strike', 'canvas.cross', 'canvas.check']) {
			expect(commands.list().find((c) => c.id === id)).toMatchObject({ enabled: false, disabledReason: 'The canvas is read-only.' });
		}
		const result = await run('canvas.check', { at: [0, 0] });
		expect((result.structuredContent as any).error.message).toMatch(/read-only/);
	});
});

describe('gesture playback', () => {
	it('traces each generated path with the button down', async () => {
		const { registry, commands } = setup();
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		playback.attach('canvas', { presence: new PresenceStore(), bounds: () => ({ x: 0, y: 0, width: 1000, height: 600 }) });
		const record = playback.record();
		const params = { around: [{ nodeId: 'card' }], seed: 9 };
		const result = await registry.callTool('run_command', { id: 'canvas.circle', params });
		expect(result.isError).toBeUndefined();
		const played = record.filter((r) => r.surface === 'canvas').map((r) => r.step);
		const types = played.map((s) => s.type).filter((t) => t !== 'focus' && t !== 'wait' && t !== 'say');
		expect(types.slice(0, 2)).toEqual(['move', 'press']);
		expect(types.slice(-2)).toEqual(['release', 'commit']);
		const [first] = circleGesture(card, 9).points;
		expect(played.find((s) => s.type === 'move')).toEqual({ type: 'move', to: { x: first[0], y: first[1] } });
		expect(played.filter((s) => s.type === 'drag')).toHaveLength(31);
		// Every gesture plans a trace; a bad target plans nothing (the run reports the error).
		for (const spec of commands.list().filter((c) => /^canvas\.(circle|underline|arrow|bracket|strike|cross|check)$/.test(c.id))) {
			expect(commands.get(spec.id)!.plan).toBeTypeOf('function');
		}
		const arrowPlan = commands.get('canvas.arrow')!.plan!(undefined, { from: [0, 0], to: { nodeId: 'card' } } as never) as any[];
		expect(arrowPlan[0]).toEqual({ type: 'move', to: { x: 0, y: 0 } });
		expect(arrowPlan.at(-1)).toEqual({ type: 'commit' });
		expect(commands.get('canvas.arrow')!.plan!(undefined, { from: [0, 0], to: { nodeId: 'nope' } } as never)).toBeNull();
	});
});

describe('createCommandToolProvider tools option', () => {
	function direct(readOnly = false) {
		const env = setup({ readOnly });
		const registry = new ToolRegistry();
		registry.register(
			createCommandToolProvider(env.commands, {
				id: 'draw',
				tools: (id) => id.startsWith('canvas.') && id !== 'canvas.drawFreehand',
				toolName: (id) => id.replace(/^canvas\./, '')
			})
		);
		return { ...env, registry };
	}

	it('lists chosen commands as tools with their params as the input schema', () => {
		const { registry, commands } = direct();
		const tools = registry.listTools().tools;
		const names = tools.map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining(['draw__list_commands', 'draw__run_command', 'draw__run_commands', 'draw__circle', 'draw__arrow', 'draw__check', 'draw__listBrushes'])
		);
		expect(names).not.toContain('draw__drawFreehand');
		const circle = tools.find((t) => t.name === 'draw__circle')!;
		expect(circle.inputSchema).toEqual(commands.get('canvas.circle')!.params);
		expect(circle.title).toBe('Circle Around');
		expect(circle.description).toMatch(/^Circles boxes or nodes/);
		expect(circle.annotations).toEqual({ title: 'Circle Around', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
		expect(tools.find((t) => t.name === 'draw__listBrushes')!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
	});

	it('names tools from the id by default', () => {
		const env = setup();
		const registry = new ToolRegistry();
		registry.register(createCommandToolProvider(env.commands, { namespace: '', tools: ['canvas.circle'] }));
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['list_commands', 'run_command', 'run_commands', 'canvas_circle']);
	});

	it('runs the command, validates arguments and refuses with the reason', async () => {
		const { registry, nodes } = direct();
		const ok = await registry.callTool('draw__circle', { around: [{ nodeId: 'card' }] });
		expect(ok.isError).toBeUndefined();
		expect(ok.structuredContent).toMatchObject({ id: 'n1', seed: expect.any(Number) });
		const bad = await registry.callTool('draw__circle', { around: [{ nodeId: 'card' }], extra: true });
		expect(bad.isError).toBe(true);
		const unknown = await registry.callTool('draw__circle', { around: [{ nodeId: 'nope' }] });
		expect(unknown.isError).toBe(true);
		expect((unknown.structuredContent as any).error.message).toMatch(/Unknown node "nope"/);
		expect(strokes(nodes())).toHaveLength(1);

		const locked = direct(true);
		const refused = await locked.registry.callTool('draw__check', { at: [0, 0] });
		expect(refused.isError).toBe(true);
		expect((refused.structuredContent as any).error).toMatchObject({ code: 'disabled', message: 'The canvas is read-only.' });
		const brushes = await locked.registry.callTool('draw__listBrushes', {});
		expect(brushes.isError).toBeUndefined();
	});

	it('plays the command\'s own plan', async () => {
		const { registry } = direct();
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		playback.attach('canvas', { presence: new PresenceStore(), bounds: () => ({ x: 0, y: 0, width: 1000, height: 600 }) });
		const record = playback.record();
		await registry.callTool('draw__underline', { under: card, seed: 3 });
		const played = record.filter((r) => r.surface === 'canvas').map((r) => r.step.type);
		expect(played).toContain('press');
		expect(played.filter((t) => t === 'drag').length).toBeGreaterThan(5);
		expect(played.at(-1)).toBe('commit');
	});
});
