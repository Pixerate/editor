import { describe, it, expect } from 'vitest';
import {
	ToolRegistry,
	PresenceStore,
	createAgentPlayback,
	createInstantPresenceClock,
	createPlaybackToolProvider,
	createMcpServer,
	derivePlaybackSteps,
	playbackRefsFromArgs,
	playbackRefsFromResult,
	type AgentTool,
	type AgentToolProvider,
	type PlaybackRect,
	type PlaybackSurface
} from '../src/tools';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';

const RECTS: Record<string, PlaybackRect> = {
	'node:a': { x: 0, y: 0, width: 100, height: 40 },
	'node:b': { x: 200, y: 100, width: 100, height: 40 },
	'node:new': { x: 400, y: 0, width: 100, height: 40 }
};

function fakeSurface(extra: Partial<PlaybackSurface> = {}): PlaybackSurface & { presence: PresenceStore; gestures: string[] } {
	const gestures: string[] = [];
	return {
		presence: new PresenceStore(),
		defaultKind: 'node',
		locate: (ref) => RECTS[`${ref.kind}:${ref.id}`] ?? null,
		bounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
		beginGesture: (key) => gestures.push(`begin ${key}`),
		endGesture: () => gestures.push('end'),
		gestures,
		...extra
	};
}

const tool = (name: string, extra: Partial<AgentTool> = {}): AgentTool => ({
	name,
	title: name,
	description: name,
	inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, label: { type: 'string' } }, additionalProperties: false },
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	handler: ({ ids }) => ({ moved: ids ?? [] }),
	...extra
});

function setup(tools: AgentTool[], options: Parameters<typeof createAgentPlayback>[0] = {}) {
	const registry = new ToolRegistry();
	const provider: AgentToolProvider = { id: 'canvas', tools };
	registry.register(provider);
	const clock = createInstantPresenceClock();
	const playback = createAgentPlayback({ clock, ...options });
	playback.install(registry);
	return { registry, playback, clock };
}

describe('ToolRegistry middleware', () => {
	it('wraps calls in order and can be removed', async () => {
		const registry = new ToolRegistry();
		registry.register({ id: 'p', tools: [tool('echo', { handler: () => 'ok' })] });
		const seen: string[] = [];
		const off = registry.use(async (call, next) => {
			seen.push(`outer ${call.name}`);
			return next();
		});
		registry.use(async (call, next) => {
			seen.push(`inner ${call.provider.id}`);
			return next();
		});
		await registry.callTool('p__echo');
		expect(seen).toEqual(['outer p__echo', 'inner p']);
		off();
		seen.length = 0;
		await registry.callTool('p__echo');
		expect(seen).toEqual(['inner p']);
	});

	it('turns a middleware throw into an isError result', async () => {
		const registry = new ToolRegistry();
		registry.register({ id: 'p', tools: [tool('echo')] });
		registry.use(async () => {
			throw new Error('nope');
		});
		const result = await registry.callTool('p__echo');
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: 'text', text: 'nope' });
	});

	it('passes the actor to handlers', async () => {
		const registry = new ToolRegistry();
		let actor: unknown;
		registry.register({ id: 'p', tools: [tool('echo', { handler: (_a, ctx) => void (actor = ctx.actor) })] });
		await registry.callTool('p__echo', {}, { actor: { id: 'x', name: 'X' } });
		expect(actor).toEqual({ id: 'x', name: 'X' });
	});

	it('keeps plan and playback out of tools/list', () => {
		const registry = new ToolRegistry();
		registry.register({ id: 'p', tools: [tool('echo', { plan: () => [], playback: false })] });
		const def = registry.listTools().tools[0]!;
		expect('plan' in def).toBe(false);
		expect('playback' in def).toBe(false);
	});
});

describe('playback refs', () => {
	it('reads ids from arguments by convention', () => {
		expect(playbackRefsFromArgs({ id: 'a', ids: ['b', 'a'], layerId: 'L', clipIds: ['c'], range: 'B2:C3', params: { nodeId: 'n' } }, 'node')).toEqual([
			{ kind: 'node', id: 'a' },
			{ kind: 'node', id: 'b' },
			{ kind: 'layer', id: 'L' },
			{ kind: 'clip', id: 'c' },
			{ kind: 'cell', id: 'B2:C3' },
			{ kind: 'node', id: 'n' }
		]);
	});

	it('reads what a result created', () => {
		expect(playbackRefsFromResult({ created: { nodes: [{ id: 'n1' }], edges: [{ id: 'e1' }] } })).toEqual([
			{ kind: 'node', id: 'n1' },
			{ kind: 'edge', id: 'e1' }
		]);
		expect(playbackRefsFromResult({ ok: true, result: { id: 'shape-1' } }, 'vector')).toEqual([{ kind: 'vector', id: 'shape-1' }]);
	});

	it('derives a visit, a press and a commit', () => {
		expect(derivePlaybackSteps({ ids: ['a'] }).map((s) => s.type)).toEqual(['target', 'press', 'release', 'commit']);
		expect(derivePlaybackSteps({})).toEqual([{ type: 'commit' }]);
	});
});

describe('AgentPlayback', () => {
	it('runs instantly with the same result when no surface is attached', async () => {
		const { registry, playback } = setup([tool('align')]);
		const steps = playback.record();
		const result = await registry.callTool('canvas__align', { ids: ['a'] });
		expect(result.structuredContent).toEqual({ moved: ['a'] });
		expect(steps).toEqual([]);
	});

	it('visits the ids in the arguments, commits once, and points at nothing new', async () => {
		const { registry, playback } = setup([tool('align')], { linger: 0 });
		const surface = fakeSurface();
		playback.attach('canvas', surface);
		const steps = playback.record();
		let calls = 0;
		const result = await registry.callTool('canvas__align', { ids: ['a', 'b'] });
		calls++;
		expect(result.structuredContent).toEqual({ moved: ['a', 'b'] });
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'target', 'press', 'release', 'commit']);
		expect(steps.every((r) => r.surface === 'canvas' && r.tool === 'canvas__align' && r.actor === 'agent')).toBe(true);
		expect(surface.gestures).toEqual(['begin agent:agent:1', 'end']);
		// The cursor ended on the last target.
		const actor = surface.presence.get('agent');
		expect(actor).toMatchObject({ x: 250, y: 120, pressed: false });
		expect(calls).toBe(1);
	});

	it('lands a staged change part by part as the cursor reaches each stage', async () => {
		const log: string[] = [];
		const add = tool('add_many', {
			plan: () => [
				{ type: 'commit' },
				{ type: 'move', to: { x: 10, y: 10 } },
				{ type: 'stage' },
				{ type: 'move', to: { x: 20, y: 20 } },
				{ type: 'stage' }
			],
			handler: async (_args, context) => {
				for (const part of ['first', 'second', 'third']) {
					await context.stage?.();
					log.push(`add ${part}`);
				}
				return { added: 3 };
			}
		});
		const { registry, playback } = setup([add]);
		const surface = fakeSurface();
		playback.attach('canvas', surface);
		const steps = playback.record();
		const original = surface.presence.set.bind(surface.presence);
		surface.presence.set = (patch) => {
			if ((patch.x === 10 || patch.x === 20) && log.at(-1) !== `move ${patch.x}` && !log.includes(`move ${patch.x}`)) log.push(`move ${patch.x}`);
			return original(patch);
		};
		const result = await registry.callTool('canvas__add_many', {});
		expect(result.structuredContent).toEqual({ added: 3 });
		expect(steps.map((r) => r.step.type)).toEqual(['commit', 'move', 'stage', 'move', 'stage']);
		// Each part lands after the cursor reached its stage; the last (unplanned) one at the end.
		expect(log).toEqual(['move 10', 'add first', 'move 20', 'add second', 'add third']);
	});

	it('acts out steps the handler learns mid-call before its change lands', async () => {
		const log: string[] = [];
		const trace = tool('trace', {
			plan: () => [{ type: 'move', to: { x: 5, y: 5 } }],
			handler: async (_args, context) => {
				log.push('found outline');
				await context.perform?.([
					{ type: 'move', to: { x: 10, y: 10 } },
					{ type: 'press', gesture: 'path' },
					{ type: 'drag', to: { x: 30, y: 10 } },
					{ type: 'commit' },
					{ type: 'release' }
				]);
				log.push('selected');
				return 'ok';
			}
		});
		const { registry, playback } = setup([trace]);
		const surface = fakeSurface();
		playback.attach('canvas', surface);
		const steps = playback.record();
		const seen: string[] = [];
		surface.presence.subscribe((state) => {
			const a = state.actors[0];
			if (a?.pressed) seen.push(`${a.gesture ?? 'box'} ${a.x}`);
		});
		const result = await registry.callTool('canvas__trace', {});
		expect(result.isError).toBeFalsy();
		expect(log).toEqual(['found outline', 'selected']);
		// The plan's move, its commit (the handler), then the handler's own steps (commit skipped).
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'commit', 'move', 'press', 'drag', 'release']);
		expect(seen.at(-1)).toBe('path 30');
		expect(surface.presence.getState().actors[0]?.gesture).toBeUndefined();
	});

	it('gives handlers no perform without playback', async () => {
		const seen: boolean[] = [];
		const registry = new ToolRegistry();
		registry.register({ id: 'canvas', tools: [tool('trace', { handler: (_a, context) => (seen.push(typeof context.perform === 'function'), 'ok') })] });
		await registry.callTool('canvas__trace', {});
		expect(seen).toEqual([false]);
	});

	it('runs a staged handler straight through without playback', async () => {
		const seen: boolean[] = [];
		const registry = new ToolRegistry();
		registry.register({
			id: 'canvas',
			tools: [
				tool('add_many', {
					plan: () => [{ type: 'commit' }, { type: 'stage' }],
					handler: async (_args, context) => {
						seen.push(typeof context.stage === 'function');
						await context.stage?.();
						return 'ok';
					}
				})
			]
		});
		const result = await registry.callTool('canvas__add_many', {});
		expect(result.isError).toBeFalsy();
		expect(seen).toEqual([false]);
	});

	it('reports a staged handler failure after its steps', async () => {
		const add = tool('add_many', {
			plan: () => [{ type: 'commit' }, { type: 'stage' }, { type: 'stage' }],
			handler: async (_args, context) => {
				await context.stage?.();
				throw new Error('second part failed');
			}
		});
		const { registry, playback } = setup([add]);
		playback.attach('canvas', fakeSurface());
		const result = await registry.callTool('canvas__add_many', {});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: 'text', text: 'second part failed' });
	});

	it('plays a plan and points at what the result created', async () => {
		const add = tool('add', {
			plan: (args) => [{ type: 'move', to: { x: 450, y: 20 } }, { type: 'press' }, { type: 'release' }, { type: 'type', text: String(args.label) }],
			handler: () => ({ created: { nodes: [{ id: 'new' }] } })
		});
		const { registry, playback } = setup([add]);
		const surface = fakeSurface();
		playback.attach('canvas', surface);
		const steps = playback.record();
		await registry.callTool('canvas__add', { label: 'Ship' });
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'press', 'release', 'type', 'commit', 'focus']);
		expect(steps.at(-1)!.step).toEqual({ type: 'focus', rect: RECTS['node:new'] });
	});

	it('falls back to the arguments when a plan throws', async () => {
		const { registry, playback } = setup([tool('align', { plan: () => { throw new Error('bad plan'); } })]);
		playback.attach('canvas', fakeSurface());
		const steps = playback.record();
		const result = await registry.callTool('canvas__align', { ids: ['a'] });
		expect(result.isError).toBeFalsy();
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'commit']);
	});

	it('returns the same error and shows it on the cursor', async () => {
		const failing = tool('align', { handler: () => { throw new Error('Unknown node "zz". Call get_editor_state for ids.'); } });
		const { registry, playback } = setup([failing], { linger: 0 });
		const surface = fakeSurface();
		playback.attach('canvas', surface);
		const result = await registry.callTool('canvas__align', { ids: ['a'] });
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({ type: 'text', text: 'Unknown node "zz". Call get_editor_state for ids.' });
		expect(surface.presence.get('agent')?.message).toContain('✗ Unknown node');
		expect(surface.gestures).toEqual(['begin agent:agent:1', 'end']);
	});

	it('shows only changes by default: reads are not played', async () => {
		const read = tool('inspect', { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
		const { registry, playback } = setup([read, tool('align')]);
		expect(playback.reads).toBe('skip');
		playback.attach('canvas', fakeSurface());
		const steps = playback.record();
		await registry.callTool('canvas__inspect', { ids: ['a'] });
		expect(steps).toEqual([]);
		await registry.callTool('canvas__align', { ids: ['a'] });
		expect(steps.length).toBeGreaterThan(0);
	});

	it('glances at reads without pressing or opening an undo step when reads is glance', async () => {
		const read = tool('inspect', { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
		const { registry, playback } = setup([read], { reads: 'glance' });
		const surface = fakeSurface();
		playback.attach('canvas', surface);
		const steps = playback.record();
		await registry.callTool('canvas__inspect', { ids: ['a'] });
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'commit']);
		expect(surface.gestures).toEqual([]);

		playback.reads = 'skip';
		steps.length = 0;
		await registry.callTool('canvas__inspect', { ids: ['a'] });
		expect(steps).toEqual([]);
	});

	it('skips tools that play themselves and tools with playback: false', async () => {
		const { registry, playback } = setup([tool('self', { playback: 'self' }), tool('never', { playback: false })]);
		playback.attach('canvas', fakeSurface());
		const steps = playback.record();
		await registry.callTool('canvas__self', { ids: ['a'] });
		await registry.callTool('canvas__never', { ids: ['a'] });
		expect(steps).toEqual([]);
	});

	it('plays instantly at speed Infinity and on a hidden surface without reveal', async () => {
		const { registry, playback } = setup([tool('align')]);
		const surface = fakeSurface({ visible: () => false });
		playback.attach('canvas', surface);
		const steps = playback.record();
		await registry.callTool('canvas__align', { ids: ['a'] });
		expect(steps).toEqual([]);
	});

	it('reveals a hidden surface before playing', async () => {
		const { registry, playback } = setup([tool('align')]);
		let shown = false;
		playback.attach('canvas', fakeSurface({ visible: () => shown, reveal: () => void (shown = true) }));
		const steps = playback.record();
		await registry.callTool('canvas__align', { ids: ['a'] });
		expect(shown).toBe(true);
		expect(steps.length).toBeGreaterThan(0);
	});

	it('takes real time on the clock and none at Infinity', async () => {
		const { registry, playback, clock } = setup([tool('align')], { linger: 0 });
		playback.attach('canvas', fakeSurface());
		await registry.callTool('canvas__align', { ids: ['a', 'b'] });
		const natural = clock.elapsed();
		expect(natural).toBeGreaterThan(300);
		playback.speed = 2;
		const before = clock.elapsed();
		await registry.callTool('canvas__align', { ids: ['a', 'b'] });
		expect(clock.elapsed() - before).toBeLessThan(natural);
		playback.speed = Infinity;
		const t = clock.elapsed();
		await registry.callTool('canvas__align', { ids: ['a', 'b'] });
		expect(clock.elapsed()).toBe(t);
	});

	it('gives each actor its own cursor and plays one actor in call order', async () => {
		const order: string[] = [];
		const { registry, playback } = setup([tool('align', { handler: ({ ids }) => void order.push(ids[0]) })], { linger: 0 });
		const surface = fakeSurface();
		playback.attach('canvas', surface);
		await Promise.all([
			registry.callTool('canvas__align', { ids: ['a'] }, { actor: { id: 'one', name: 'One' } }),
			registry.callTool('canvas__align', { ids: ['b'] }, { actor: { id: 'one', name: 'One' } }),
			registry.callTool('canvas__align', { ids: ['a'] }, { actor: { id: 'two', name: 'Two' } })
		]);
		expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('a'));
		expect(surface.presence.getState().actors.map((a) => a.name).sort()).toEqual(['One', 'Two']);
		expect(new Set(surface.presence.getState().actors.map((a) => a.color)).size).toBe(2);
	});

	it('moves the cursor between surfaces through the viewport', async () => {
		const registry = new ToolRegistry();
		registry.register({ id: 'left', tools: [tool('align')] });
		registry.register({ id: 'right', tools: [tool('align')] });
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(registry);
		const left = fakeSurface({ toViewport: (p) => p, fromViewport: (p) => p });
		const right = fakeSurface({ toViewport: (p) => ({ x: p.x + 1000, y: p.y }), fromViewport: (p) => ({ x: p.x - 1000, y: p.y }) });
		playback.attach('left', left);
		playback.attach('right', right);
		await registry.callTool('left__align', { ids: ['b'] });
		expect(left.presence.get('agent')).toBeTruthy();
		const steps = playback.record();
		await registry.callTool('right__align', { ids: ['a'] });
		expect(left.presence.get('agent')).toBeUndefined();
		expect(right.presence.get('agent')).toMatchObject({ x: 50, y: 20 });
		expect(steps[0]!.surface).toBe('right');
	});

	it('hides the cursor after linger', async () => {
		const { registry, playback, clock } = setup([tool('align')], { linger: 1000 });
		const surface = fakeSurface();
		playback.attach('canvas', surface);
		await registry.callTool('canvas__align', { ids: ['a'] });
		await clock.wait(0);
		await Promise.resolve();
		expect(surface.presence.get('agent')).toBeUndefined();
	});

	it('shows say() in the bubble and reports active', async () => {
		let during = false;
		const { registry, playback } = setup([tool('align', { handler: () => void (during = playback.active) })], { linger: 0 });
		const surface = fakeSurface();
		playback.attach('canvas', surface);
		await registry.callTool('canvas__align', { ids: ['a'] });
		expect(during).toBe(true);
		expect(playback.active).toBe(false);
		expect(playback.say('Lining them up.')).toBe('canvas');
		expect(surface.presence.get('agent')?.message).toBe('Lining them up.');
		expect(playback.say('Nobody here.', { actor: { id: 'other' } })).toBeNull();
	});

	it('finishes when a plan or a surface gives NaN coordinates', async () => {
		const bad = tool('bad', {
			plan: () => [{ type: 'move', to: { x: NaN, y: 5 } }, { type: 'type', text: 'x', ms: NaN }, { type: 'target', ref: { kind: 'node', id: 'nan' } }, { type: 'drag', to: { x: Infinity, y: 0 } }]
		});
		const { registry, playback } = setup([bad], { linger: 0 });
		const surface = fakeSurface({ locate: () => ({ x: NaN, y: 0, width: 10, height: 10 }) });
		playback.attach('canvas', surface);
		const result = await registry.callTool('canvas__bad', {});
		expect(result.isError).toBeFalsy();
		const a = surface.presence.get('agent')!;
		expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
	});

	it('detaching a surface makes later calls instant', async () => {
		const { registry, playback } = setup([tool('align')]);
		const detach = playback.attach('canvas', fakeSurface());
		detach();
		const steps = playback.record();
		await registry.callTool('canvas__align', { ids: ['a'] });
		expect(steps).toEqual([]);
	});
});

describe('playback of commands', () => {
	function commands() {
		const registry = new CommandRegistry();
		const moved: string[][] = [];
		registry.register([
			{
				id: 'canvas.alignLeft',
				label: 'Align left',
				params: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
				run: (_c, p: { ids: string[] }) => void moved.push(p.ids)
			},
			{
				id: 'canvas.addNote',
				label: 'Add note',
				params: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, additionalProperties: false },
				plan: (_c, p: { x: number; y: number }) => [{ type: 'move', to: { x: p.x, y: p.y } }, { type: 'press' }, { type: 'release' }],
				run: () => ({ id: 'new' })
			},
			{ id: 'canvas.count', label: 'Count', readOnly: true, run: () => 2 }
		]);
		const tools = new ToolRegistry();
		tools.register(createCommandToolProvider(registry, { id: 'commands' }));
		const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
		playback.install(tools);
		const surface = fakeSurface();
		playback.attach('canvas', surface);
		return { tools, playback, surface, moved };
	}

	it('plays run_command on the surface named by the command id, from its params', async () => {
		const { tools, playback, moved } = commands();
		const steps = playback.record();
		const result = await tools.callTool('commands__run_command', { id: 'canvas.alignLeft', params: { ids: ['a', 'b'] } });
		expect(result.isError).toBeFalsy();
		expect(moved).toEqual([['a', 'b']]);
		expect(steps.map((r) => `${r.surface}:${r.step.type}`)).toEqual(['canvas:target', 'canvas:target', 'canvas:press', 'canvas:release', 'canvas:commit']);
	});

	it("uses a command's own plan and points at its result", async () => {
		const { tools, playback } = commands();
		const steps = playback.record();
		await tools.callTool('commands__run_command', { id: 'canvas.addNote', params: { x: 450, y: 20 } });
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'press', 'release', 'commit', 'focus']);
	});

	it('treats read-only commands as reads', async () => {
		const { tools, playback, surface } = commands();
		const steps = playback.record();
		await tools.callTool('commands__run_command', { id: 'canvas.count' });
		expect(steps).toEqual([]);
		expect(surface.gestures).toEqual([]);
	});

	it('plays run_commands step plans then runs the batch once', async () => {
		const { tools, playback, moved } = commands();
		const steps = playback.record();
		await tools.callTool('commands__run_commands', {
			steps: [
				{ id: 'canvas.alignLeft', params: { ids: ['a'] } },
				{ id: 'canvas.addNote', params: { x: 1, y: 2 } },
				{ id: 'canvas.alignLeft', params: { ids: ['$1.id'] } }
			]
		});
		expect(moved).toEqual([['a'], ['new']]);
		expect(steps.filter((r) => r.step.type === 'commit')).toHaveLength(1);
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'move', 'press', 'release', 'commit']);
	});
});

describe('createMcpServer actor', () => {
	it("names the actor after the client's clientInfo", async () => {
		const registry = new ToolRegistry();
		let actor: unknown;
		registry.register({ id: 'p', tools: [tool('echo', { handler: (_a, ctx) => void (actor = ctx.actor) })] });
		const server = createMcpServer(registry, { name: 'test', version: '1' });
		await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', title: 'Claude Code' } } });
		await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'p__echo', arguments: {} } });
		expect(actor).toEqual({ id: 'mcp:claude-code', name: 'Claude Code' });
	});
});

describe('createPlaybackToolProvider (playback__say)', () => {
	function sayRegistry() {
		const { registry, playback } = setup([tool('align')], { linger: 0 });
		registry.register(createPlaybackToolProvider(playback));
		const surface = fakeSurface();
		playback.attach('canvas', surface);
		return { registry, playback, surface };
	}

	it('is complete for a model: strict schema, title, all four hints, described arguments', () => {
		const { registry } = sayRegistry();
		const say = registry.listTools().tools.find((t) => t.name === 'playback__say')!;
		expect(say.title).toBeTruthy();
		expect(say.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
		expect(say.inputSchema).toMatchObject({ required: ['text'], additionalProperties: false });
		expect((say.inputSchema.properties as any).text.description).toBeTruthy();
	});

	it("shows the note in the calling actor's bubble and returns the surface", async () => {
		const { registry, playback, surface } = sayRegistry();
		const steps = playback.record();
		await registry.callTool('canvas__align', { ids: ['a'] }, { actor: { id: 'claude', name: 'Claude' } });
		const result = await registry.callTool('playback__say', { text: 'Lining up the cards.' }, { actor: { id: 'claude', name: 'Claude' } });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({ shown: true, surface: 'canvas' });
		expect(surface.presence.get('claude')?.message).toBe('Lining up the cards.');
		// The note is not played itself.
		expect(steps.every((r) => r.tool !== 'say')).toBe(true);
	});

	it('shows nothing, without failing, when the agent has no cursor on screen', async () => {
		const { registry, surface } = sayRegistry();
		const result = await registry.callTool('playback__say', { text: 'Starting.' });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({ shown: false, surface: null });
		expect(surface.presence.getState().actors).toEqual([]);
	});

	it('rejects missing, empty, overlong and unknown arguments with a useful error', async () => {
		const { registry } = sayRegistry();
		for (const args of [{}, { text: '' }, { text: 'x'.repeat(201) }, { text: 'Hi', ms: 500 }]) {
			const result = await registry.callTool('playback__say', args);
			expect(result.isError, JSON.stringify(args)).toBe(true);
		}
		const blank = await registry.callTool('playback__say', { text: '   ' });
		expect(blank.isError).toBe(true);
		expect((blank.content[0] as { text: string }).text).toMatch(/text is empty/);
	});
});
