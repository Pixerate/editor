import { describe, expect, it } from 'vitest';
import { createEffectPixels, createFakeEffectProvider } from '../src/effects';
import { HistoryManager } from '../src/history';
import { ToolRegistry } from '../src/tools';
import {
	CanvasScenesStore,
	createCanvasEffectsController,
	createCanvasEffectsToolProvider,
	parseCanvasScenes,
	playCanvasSceneTransition,
	runCanvasNodeEffect,
	type CanvasNode
} from '../src/canvas';

const nodes = (): CanvasNode[] => [
	{ id: 'a', position: { x: 0, y: 0 }, data: { shape: { kind: 'rect', fill: '#ff0000' } } },
	{ id: 'note', position: { x: 100, y: 0 }, data: { label: 'Not a shape' } }
];

function setup(effects: ReturnType<typeof createFakeEffectProvider> | null = createFakeEffectProvider()) {
	let state = nodes();
	const history = new HistoryManager();
	const scenes = new CanvasScenesStore({ initialScenes: [{ id: 's1', name: 'One', viewport: { x: 0, y: 0, zoom: 1 } }, { id: 's2', name: 'Two', viewport: { x: -400, y: 0, zoom: 1 } }] });
	const c = createCanvasEffectsController({ getNodes: () => state, setNodes: (n) => (state = n), history, scenes, effects });
	return { c, history, scenes, get: () => state };
}
const shapeOf = (n: CanvasNode) => (n.data as { shape: { effect?: unknown } }).shape;

describe('canvas effects: nodes', () => {
	it('fills and overlays shape nodes as undoable steps', async () => {
		const { c, history, get } = setup();
		const e = await c.applyNodeEffect('a', 'fake.gradient', { values: { angle: 0 } });
		expect(e).toMatchObject({ effect: 'fake.gradient', mode: 'fill', provider: 'fake', name: 'Gradient', values: { angle: 0, spin: 0 } });
		expect(shapeOf(get()[0]).effect).toEqual(e);
		const u = await c.updateNodeEffect('a', { values: { angle: null, spin: 90 }, opacity: 0.5, playing: false });
		expect(u).toMatchObject({ values: { angle: 90, spin: 90 }, opacity: 0.5, playing: false });
		await c.applyNodeEffect('a', 'fake.bar', { mode: 'overlay' });
		expect(c.list()).toEqual([{ nodeId: 'a', effect: expect.objectContaining({ effect: 'fake.bar', mode: 'overlay' }) }]);
		history.undo();
		expect(c.list()[0].effect.effect).toBe('fake.gradient');
		c.removeNodeEffect('a');
		expect(shapeOf(get()[0]).effect).toBeUndefined();
	});

	it('refuses wrong places, non-shapes and bad values', async () => {
		const { c } = setup();
		await expect(c.applyNodeEffect('a', 'fake.crossfade')).rejects.toThrow(/cannot be a fill/);
		await expect(c.applyNodeEffect('a', 'fake.tint', { mode: 'overlay' })).rejects.toThrow(/cannot be an overlay/);
		await expect(c.applyNodeEffect('note', 'fake.gradient')).rejects.toThrow(/not a shape/);
		await expect(c.applyNodeEffect('zz', 'fake.gradient')).rejects.toThrow(/no node "zz"/);
		await expect(c.applyNodeEffect('a', 'fake.gradient', { values: { angle: 999 } })).rejects.toThrow(/angle/);
		expect(c.list()).toEqual([]);
	});

	it('works as before without a provider and keeps saved effects', async () => {
		const { c, get } = setup(null);
		await expect(c.applyNodeEffect('a', 'fake.gradient')).rejects.toThrow(/No effects provider/);
		expect(get()).toEqual(nodes());
	});
});

describe('canvas effects: scene transitions', () => {
	it('sets, keeps through save and load, and removes transitions', async () => {
		const { c, scenes } = setup();
		const t = await c.setSceneTransition('s2', 'fake.crossfade', { values: { curve: 'linear' }, duration: 400 });
		expect(t).toEqual({ effect: 'fake.crossfade', provider: 'fake', name: 'Crossfade', values: { curve: 'linear' }, duration: 400 });
		expect(parseCanvasScenes(JSON.parse(scenes.serialize()))[1].transition).toEqual(t);
		await expect(c.setSceneTransition('s2', 'fake.gradient')).rejects.toThrow(/cannot be a scene transition/);
		await expect(c.setSceneTransition('zz', 'fake.crossfade')).rejects.toThrow(/no scene "zz"/);
		await c.setSceneTransition('s2', null);
		expect(scenes.getScene('s2')?.transition).toBeUndefined();
	});
});

describe('canvas effects: player', () => {
	const target = () => {
		const drawn: ImageData[] = [];
		(globalThis as any).ImageData ??= class {
			constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
		};
		return { drawn, t: { width: 2, height: 1, getContext: () => ({ putImageData: (img: ImageData) => drawn.push(img) }) } };
	};
	const clock = () => {
		let now = 0;
		return { now: () => now, frame: (cb: () => void) => { const t = setTimeout(() => ((now += 100), cb()), 0); return () => clearTimeout(t); } };
	};

	it('draws a still frame, or frames until stopped', async () => {
		const { drawn, t } = target();
		const run = runCanvasNodeEffect({ provider: createFakeEffectProvider(), effect: { effect: 'fake.gradient', mode: 'fill', values: {} }, target: t, clock: clock() });
		await new Promise((r) => setTimeout(r, 20));
		run.stop();
		expect(drawn.length).toBeGreaterThan(1);
		const held = target();
		runCanvasNodeEffect({ provider: createFakeEffectProvider(), effect: { effect: 'fake.gradient', mode: 'fill', values: {}, playing: false }, target: held.t, clock: clock() });
		await new Promise((r) => setTimeout(r, 20));
		expect(held.drawn).toHaveLength(1);
	});

	it('plays a transition from one picture to the other', async () => {
		const { drawn, t } = target();
		const from = createEffectPixels(2, 1);
		from.data.set([0, 0, 0, 255, 0, 0, 0, 255]);
		const to = createEffectPixels(2, 1);
		to.data.set([200, 200, 200, 255, 200, 200, 200, 255]);
		await playCanvasSceneTransition({ provider: createFakeEffectProvider(), transition: { effect: 'fake.crossfade', values: { curve: 'linear' }, duration: 300 }, from, to, target: t, clock: clock() });
		expect(drawn[0].data[0]).toBe(0);
		expect(drawn.at(-1)!.data[0]).toBe(200);
	});
});

describe('canvas effect tools', () => {
	it('applies, switches mode, updates, removes, and sets scene transitions', async () => {
		const { c } = setup();
		const registry = new ToolRegistry();
		registry.register(createCanvasEffectsToolProvider(c));
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['search_effects', 'describe_effect', 'list_applied_effects', 'apply_effect', 'update_effect', 'remove_effect', 'set_canvas_effect_mode', 'list_scene_transitions', 'set_scene_transition']);
		const a = await registry.callTool('apply_effect', { target: 'a', effect: 'fake.bar' });
		expect((a.structuredContent as any).effect).toMatchObject({ id: 'effect', role: 'overlay' });
		const m = await registry.callTool('set_canvas_effect_mode', { node: 'a', mode: 'fill' });
		expect(m.isError).toBe(true);
		expect((m.content[0] as { text: string }).text).toMatch(/cannot be a fill/);
		const u = await registry.callTool('update_effect', { target: 'a', effect: 'effect', values: { height: 0.3 }, opacity: 0.4 });
		expect((u.structuredContent as any).effect).toMatchObject({ opacity: 0.4, values: { height: 0.3 } });
		const s = await registry.callTool('set_scene_transition', { scene: 's2', effect: 'fake.crossfade', duration: 500 });
		expect((s.structuredContent as any).transition).toMatchObject({ effect: 'fake.crossfade', duration: 500 });
		const list = (await registry.callTool('list_scene_transitions', {})).structuredContent as any;
		expect(list.scenes.map((x: any) => x.transition?.effect ?? null)).toEqual([null, 'fake.crossfade']);
		expect((await registry.callTool('remove_effect', { target: 'a', effect: 'effect' })).isError).toBeFalsy();
		const none = new ToolRegistry();
		none.register(createCanvasEffectsToolProvider(setup(null).c));
		expect((await none.callTool('list_scene_transitions', {})).isError).toBeFalsy();
		expect((await none.callTool('apply_effect', { target: 'a', effect: 'fake.bar' })).isError).toBe(true);
	});
});
