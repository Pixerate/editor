import { describe, expect, it } from 'vitest';
import { CommandRegistry, createCommandToolProvider } from '../src/commands';
import { PresenceStore, ToolRegistry, createAgentPlayback, createInstantPresenceClock } from '../src/tools';
import { VectorEditorController, createVectorCommands, createVectorPlaybackLocator, rectSubpath, type VectorPathNode } from '../src/vector';

const square = (id: string, x: number, y: number, size = 100): VectorPathNode => ({ id, type: 'path', name: id, subpaths: [rectSubpath({ x, y, width: size, height: size })], fill: '#808080', stroke: null });

function setup() {
	const controller = new VectorEditorController({ document: { width: 600, height: 400, nodes: [square('sun', 400, 40, 80), square('hill', 0, 250, 300)] } });
	const commands = new CommandRegistry();
	commands.register(createVectorCommands(controller));
	const registry = new ToolRegistry();
	registry.register(createCommandToolProvider(commands, { id: 'commands' }));
	const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
	playback.install(registry);
	const presence = new PresenceStore();
	playback.attach('vector', { presence, defaultKind: 'vector', locate: createVectorPlaybackLocator(controller), bounds: () => ({ x: 0, y: 0, width: 600, height: 400 }) });
	const run = (id: string, params: Record<string, unknown>) => registry.callTool('commands__run_command', { id, params });
	return { controller, registry, playback, presence, run };
}

describe('createVectorPlaybackLocator', () => {
	it('finds nodes in document units and gives lines a box', () => {
		const { controller } = setup();
		const locate = createVectorPlaybackLocator(controller);
		expect(locate({ kind: 'vector', id: 'sun' })).toEqual({ x: 400, y: 40, width: 80, height: 80 });
		expect(locate({ kind: 'vector', id: 'nope' })).toBeNull();
		expect(locate({ kind: 'node', id: 'sun' })).toBeNull();
		const line = controller.addShape({ kind: 'line', x: 10, y: 10, width: 100, height: 0 });
		expect(locate({ kind: 'vector', id: line })!.height).toBe(4);
	});
});

describe('vector commands through playback', () => {
	it('drags a shape out corner to corner, then rings the new node', async () => {
		const { run, playback, presence, controller } = setup();
		const steps = playback.record();
		const result = await run('vector.addShape', { kind: 'star', x: 360, y: 40, width: 26, height: 26, points: 5 });
		expect(result.isError).toBeFalsy();
		const id = (result.structuredContent as { result: { id: string } }).result.id;
		expect(controller.getNode(id)).toBeTruthy();
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'press', 'drag', 'release', 'commit', 'focus']);
		expect(steps[0]!.step).toEqual({ type: 'move', to: { x: 360, y: 40 } });
		expect(steps[2]!.step).toEqual({ type: 'drag', to: { x: 386, y: 66 } });
		expect(steps.every((r) => r.surface === 'vector')).toBe(true);
		expect(presence.get('agent')).toMatchObject({ x: 386, y: 66 });
	});

	it('visits the nodes a style edit names', async () => {
		const { run, playback } = setup();
		const steps = playback.record();
		await run('vector.setStyle', { ids: ['hill'], fill: '#14532d' });
		expect(steps.map((r) => r.step.type)).toEqual(['target', 'press', 'release', 'commit']);
		expect(steps[0]!.step).toEqual({ type: 'target', ref: { kind: 'item', id: 'hill' } });
	});

	it('traces a path through its anchors', async () => {
		const { run, playback } = setup();
		const steps = playback.record();
		await run('vector.addPath', { d: 'M440 470 C520 400 640 400 720 470' });
		expect(steps.map((r) => r.step.type)).toEqual(['move', 'press', 'drag', 'release', 'commit', 'focus']);
		expect(steps[0]!.step).toEqual({ type: 'move', to: { x: 440, y: 470 } });
		expect(steps[2]!.step).toMatchObject({ type: 'drag', to: { x: 720, y: 470 } });
	});

	it('clicks text in and types it', async () => {
		const { run, playback } = setup();
		const steps = playback.record();
		await run('vector.addText', { text: 'Night\nsky', x: 80, y: 215 });
		expect(steps.slice(0, 4).map((r) => r.step)).toEqual([
			{ type: 'move', to: { x: 80, y: 215 } },
			{ type: 'press' },
			{ type: 'release' },
			{ type: 'type', text: 'Night sky' }
		]);
	});

	it('drags across the styled range of a text', async () => {
		const { run, playback, controller } = setup();
		const id = controller.addText({ text: 'Starry night', x: 80, y: 215 });
		const steps = playback.record();
		await run('vector.setTextStyle', { id, start: 7, end: 12, fill: '#16a34a' });
		const types = steps.map((r) => r.step.type);
		expect(types.slice(0, 5)).toEqual(['focus', 'move', 'press', 'drag', 'release']);
		const from = (steps[1]!.step as { to: { x: number } }).to.x;
		const to = (steps[3]!.step as { to: { x: number } }).to.x;
		expect(to).toBeGreaterThan(from);
	});

	it('clicks where a symbol is placed (the artboard centre by default)', async () => {
		const { run, playback, controller } = setup();
		const made = await run('vector.makeSymbol', { ids: ['sun'] });
		expect(made.isError).toBeFalsy();
		const sid = (made.structuredContent as { result: { symbolId: string } }).result.symbolId;
		expect(controller.getState().document.symbols?.some((s) => s.id === sid)).toBe(true);
		const steps = playback.record();
		await run('vector.placeSymbol', { symbolId: sid });
		expect(steps[0]!.step).toEqual({ type: 'move', to: { x: 300, y: 200 } });
	});

	it('returns the same result and error with or without playback', async () => {
		const a = setup();
		const b = setup();
		b.playback.speed = Infinity;
		const args = { kind: 'rect', x: 1, y: 2, width: 3, height: 4 };
		const plain = (r: unknown) => JSON.stringify(r).replace(/vn-[a-z0-9]+/g, 'vn');
		expect(plain(await a.run('vector.addShape', args))).toEqual(plain(await b.run('vector.addShape', args)));
		const bad = { ids: ['ghost'], fill: '#000' };
		const ea = await a.run('vector.setStyle', bad);
		expect(ea.isError).toBe(true);
		expect(ea).toEqual(await b.run('vector.setStyle', bad));
	});

	it('every planned vector command plays on the vector surface', () => {
		const controller = new VectorEditorController();
		const specs = createVectorCommands(controller, { prefix: 'art.' });
		expect(specs.every((s) => s.playbackSurface === 'vector')).toBe(true);
		const planned = specs.filter((s) => s.plan).map((s) => s.id);
		expect(planned).toEqual(expect.arrayContaining(['art.addShape', 'art.addPath', 'art.addText', 'art.placeSymbol', 'art.setTextStyle', 'art.setMeshPoint', 'art.halftoneImage']));
	});
});
