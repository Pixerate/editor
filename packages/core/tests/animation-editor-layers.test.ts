import { describe, expect, it, vi } from 'vitest';
import {
	AnimationEditorController,
	checkMotionShotLayers,
	compileMotionScene,
	createAnimationEffectsToolProvider,
	motionFrameToSvg,
	motionLayersAt,
	motionLayerSpans,
	motionSceneShapeProblems,
	motionTransitionAt,
	MotionLayersEngine,
	parseMotionScene,
	type MotionLayerHost,
	type MotionScene
} from '../src/animation-editor';
import { createEffectPixels, createFakeEffectProvider, EffectsSlot, type EffectRenderRequest } from '../src/effects';
import { rectSubpath, type VectorDocument } from '../src/vector';
import { ToolRegistry } from '../src/tools';

const ARTWORK: VectorDocument = {
	width: 400,
	height: 200,
	background: '#ffffff',
	nodes: [{ id: 'box', type: 'path', fill: '#ef4444', subpaths: [rectSubpath({ x: 20, y: 20, width: 100, height: 50 })] }]
};
const scene = (shots: MotionScene['shots']): MotionScene => ({ version: 1, name: 'layers', artwork: ARTWORK, shots });
const threeShots = (): MotionScene =>
	scene([
		{ id: 'one', run: [], hold: 1000, layers: [{ id: 'sky', effect: 'fake.gradient', role: 'background', until: { shots: 2 } }, { id: 'pic', subject: { image: 'data:image/png;base64,AAAA' }, rect: { x: 0, y: 0, width: 100, height: 50 }, fade: 200 }] },
		{ id: 'two', run: [], hold: 1000, transition: { effect: 'fake.crossfade', ms: 400 }, layers: [{ id: 'words', subject: { text: 'Hello' }, role: 'overlay', from: 100 }] },
		{ id: 'three', run: [], hold: 1000 }
	]);

/** A host that needs no browser: every picture is a flat colour, every encoding names its size. */
const fakeHost = (): MotionLayerHost & { rasterized: string[] } => {
	const rasterized: string[] = [];
	return {
		rasterized,
		async rasterize(svg, width, height) {
			rasterized.push(svg);
			const p = createEffectPixels(width, height);
			p.data.fill(200);
			return p;
		},
		encode: (p) => `data:image/png;base64,${p.width}x${p.height}-${p.data[0]}`,
		loadImage: async (url) => `data:image/png;base64,loaded-${url.length}`
	};
};

describe('shot layer timing', () => {
	it('spans layers from their shot to the next, or as from / until say', () => {
		const s = threeShots();
		const spans = motionLayerSpans(s).map((x) => [x.layer.id, x.role, x.start, x.end]);
		const shots = compileMotionScene(s).shots;
		expect(shots.map((x) => [x.start, x.end])).toEqual([
			[0, 1000],
			[1000, 2400],
			[2400, 3400]
		]);
		expect(spans).toEqual([
			['sky', 'background', 0, 2400],
			['pic', 'subject', 0, 1000],
			['words', 'overlay', 1100, 2400]
		]);
	});

	it('fades layers in and out and drops them when they end', () => {
		const s = threeShots();
		const at = (t: number) => motionLayersAt(s, t).map((a) => [a.layer.id, Math.round(a.opacity * 100) / 100, Math.round(a.time)]);
		expect(at(100)).toEqual([
			['sky', 1, 100],
			['pic', 0.5, 100]
		]);
		expect(at(900)).toEqual([
			['sky', 1, 900],
			['pic', 0.5, 900]
		]);
		expect(at(1500)).toEqual([
			['sky', 1, 1500],
			['words', 1, 400]
		]);
		expect(at(3000)).toEqual([]);
	});

	it('times a transition into a shot, cutting the camera when it has no move in', () => {
		const s = scene([
			{ id: 'one', camera: { x: 0, y: 0, width: 200, height: 100 }, run: [], hold: 500 },
			{ id: 'two', camera: { x: 200, y: 100, width: 200, height: 100 }, run: [], hold: 500, transition: { effect: 'fake.crossfade', ms: 400 } }
		]);
		const two = compileMotionScene(s).shots[1];
		expect(two).toMatchObject({ start: 500, commandsStart: 500, transition: 'fake.crossfade', transitionEnd: 900, end: 1400 });
		expect(motionTransitionAt(s, 700)).toMatchObject({ shot: 'two', progress: 0.5 });
		expect(motionTransitionAt(s, 900)).toBeNull();
		// A transition on the first shot never plays.
		const first = scene([{ id: 'one', run: [], hold: 500, transition: { effect: 'fake.crossfade' } }]);
		expect(compileMotionScene(first).shots[0].transition).toBeUndefined();
	});
});

describe('shot layer shapes', () => {
	it('lists every problem with layers and transitions', () => {
		const bad = { ...threeShots(), shots: [{ id: 'one', run: [], layers: [{ id: 'a', subject: { video: 'v.mp4' } }, { id: 'a', effect: 'x', rect: { x: 0, y: 0, width: 0, height: 1 }, until: { shots: 0 }, opacity: 2, extra: 1 }, {}], transition: { effect: 'x', ms: 0 } }] };
		const problems = motionSceneShapeProblems(bad);
		expect(problems).toEqual(
			expect.arrayContaining([
				expect.stringContaining('an animation layer cannot play a video'),
				expect.stringContaining('"rect" must be { x, y, width, height }'),
				expect.stringContaining('"until" must be ms ≥ 0'),
				expect.stringContaining('"opacity" must be a number from 0 to 1'),
				expect.stringContaining('"extra"'),
				expect.stringContaining('needs an "effect", a "subject" or both'),
				expect.stringContaining('transition: "ms" must be a number from 1 to 60000'),
				'Layer id "a" is used twice; layer ids are unique in the scene.'
			])
		);
		expect(() => parseMotionScene(threeShots())).not.toThrow();
	});
});

describe('frames with layers', () => {
	it('draws bare subjects, and leaves effect layers out without pictures', () => {
		const svg = motionFrameToSvg(threeShots(), 1500, { pretty: false });
		expect(svg).not.toContain('data-layer="sky"');
		expect(svg).toContain('>Hello</text>');
		// The background colour, then the artwork, then the overlay words.
		expect(svg.indexOf('fill="#ffffff"')).toBeLessThan(svg.indexOf('fill="#ef4444"'));
		expect(svg.indexOf('fill="#ef4444"')).toBeLessThan(svg.indexOf('>Hello</text>'));
		const early = motionFrameToSvg(threeShots(), 100, { pretty: false });
		expect(early).toContain('<image href="data:image/png;base64,AAAA" x="0" y="0" width="100" height="50" preserveAspectRatio="xMidYMid meet" opacity="0.5"/>');
	});

	it('leaves scenes without layers drawn exactly as before', () => {
		const plain = scene([{ id: 'one', run: [], hold: 500 }]);
		expect(motionFrameToSvg(plain, 0, { pretty: false })).toBe(motionFrameToSvg({ ...plain }, 0, { pretty: false }));
		expect(motionFrameToSvg(plain, 0, { pretty: false })).toContain('<rect width="400" height="200" fill="#ffffff"/>');
	});

	it('crossfades into a transition shot until its picture is rendered', () => {
		const svg = motionFrameToSvg(threeShots(), 1200, { pretty: false });
		expect(svg).toContain('data-transition-from=""');
		expect(svg).toMatch(/<g opacity="0.5" data-transition-to="">/);
	});

	it('renders effect layers and transitions through the engine and draws them exactly', async () => {
		const renders: [string, EffectRenderRequest][] = [];
		const provider = createFakeEffectProvider({ onRender: (id, r) => renders.push([id, r]) });
		const host = fakeHost();
		const c = new AnimationEditorController({ scene: threeShots(), effects: provider, layerHost: host });
		const quick = c.toSvg(500, { pretty: false });
		expect(quick).not.toContain('data-layer="sky"');
		const exact = await c.toSvgExact(500, { pretty: false });
		expect(exact).toContain('<image href="data:image/png;base64,400x200-');
		expect(exact).toContain('data-layer="sky"');
		expect(renders.find(([id]) => id === 'fake.gradient')![1].time).toBeCloseTo(500, 0);

		const mid = await c.toSvgExact(1200, { pretty: false });
		expect(mid).toContain('data-transition="fake.crossfade"');
		const [, request] = renders.find(([id]) => id === 'fake.crossfade')!;
		expect(Object.keys(request.inputs!)).toEqual(['from', 'to']);
		expect(request.progress).toBeCloseTo(0.5, 1);
		// The frames it blends were drawn without the transition, with their layers.
		expect(host.rasterized.some((s) => s.includes('data-layer="sky"'))).toBe(true);
		expect(host.rasterized.every((s) => !s.includes('data-transition'))).toBe(true);
	});

	it('feeds a filter layer its subject and remembers failures', async () => {
		const renders: [string, EffectRenderRequest][] = [];
		const engine = new MotionLayersEngine({ slot: new EffectsSlot(), host: fakeHost() });
		engine.slot.set(createFakeEffectProvider({ onRender: (id, r) => renders.push([id, r]) }));
		const s = scene([{ id: 'one', run: [], hold: 500, layers: [{ id: 'tinted', effect: 'fake.tint', subject: { image: 'https://example.com/a.png' } }, { id: 'broken', effect: 'fake.tint', subject: { svg: '<svg/>' }, values: { amount: 7 } }] }]);
		const box = { x: 0, y: 0, width: 400, height: 200 };
		for (const a of motionLayersAt(s, 100)) engine.layer(s, a, box);
		await engine.idle();
		expect(renders[0][1].inputs!.source).toMatchObject({ width: 400, height: 200 });
		expect(engine.failuresList()).toEqual([expect.objectContaining({ layer: 'broken', error: expect.objectContaining({ code: 'invalid_values' }) })]);
		const notified = vi.fn();
		engine.subscribe(notified);
		engine.slot.set(null);
		expect(notified).toHaveBeenCalled();
		expect(engine.failuresList()).toEqual([]);
	});
});

describe('shot layer edits', () => {
	const setup = (provider: ReturnType<typeof createFakeEffectProvider> | null = createFakeEffectProvider()) =>
		new AnimationEditorController({ scene: scene([{ id: 'one', run: [], hold: 500 }, { id: 'two', run: [], hold: 500 }]), effects: provider, layerHost: null });

	it('adds, changes, restacks and removes layers, one undo step each', async () => {
		const c = setup();
		const added = await c.addShotLayer('one', { effect: 'fake.gradient', preset: 'Sunset' });
		expect(added).toMatchObject({ ok: true, layer: { id: 'layer1', effect: 'fake.gradient', provider: 'fake', name: 'Gradient', values: { from: '#f97316', to: '#7c3aed' }, role: 'background', start: 0, end: 500 } });
		await c.addShotLayer('one', { subject: { text: 'Hi' }, role: 'overlay' });
		const tinted = await c.addShotLayer('one', { effect: 'fake.tint', subject: { slot: 'photo' } }, { index: 0 });
		expect(tinted.ok && tinted.notes[0]).toContain('slot "photo"');
		expect(c.shotLayers('one')[0].layers.map((l) => l.id)).toEqual(['layer3', 'layer1', 'layer2']);
		await c.moveShotLayer('layer3', 2);
		expect(c.shotLayers('one')[0].layers.map((l) => l.id)).toEqual(['layer1', 'layer2', 'layer3']);
		const changed = await c.updateShotLayer('layer1', { values: { angle: 45 }, opacity: 0.5, preset: null });
		expect(changed.ok && changed.layer).toMatchObject({ values: { angle: 45 }, opacity: 0.5 });
		await c.removeShotLayer('layer2');
		expect(c.shotLayers('one')[0].layers.map((l) => l.id)).toEqual(['layer1', 'layer3']);
		c.undo();
		expect(c.shotLayers('one')[0].layers.map((l) => l.id)).toEqual(['layer1', 'layer2', 'layer3']);
	});

	it('refuses layers that do not fit, saying what to do, and changes nothing', async () => {
		const c = setup();
		const before = c.getState().scene;
		const err = async (p: Promise<{ ok: boolean; error?: string }>) => {
			const r = await p;
			expect(r.ok).toBe(false);
			return r.error!;
		};
		expect(await err(c.addShotLayer('one', { effect: 'fake.crossfade' }))).toContain('it is a transition: set it between shots with set_shot_transition');
		expect(await err(c.addShotLayer('one', { effect: 'fake.fade-in' }))).toContain('apply it with apply_effect');
		expect(await err(c.addShotLayer('one', { effect: 'fake.tint' }))).toContain('changes a picture; give a "subject"');
		expect(await err(c.addShotLayer('one', { effect: 'fake.gradient', subject: { text: 'x' } }))).toContain('draws its own picture and takes no subject');
		expect(await err(c.addShotLayer('one', { effect: 'fake.gradient', preset: 'Dawn' }))).toContain('its presets are "Sunset"');
		expect(await err(c.addShotLayer('one', { effect: 'fake.gradient', values: { angle: 999 } }))).toMatch(/angle/);
		expect(await err(c.addShotLayer('nope', { effect: 'fake.gradient' }))).toBe('There is no shot "nope"; the shots are "one", "two".');
		expect(await err(c.addShotLayer('one', { effect: 'fake.gradient' }, { index: 3 }))).toContain('"index" must be a whole number from 0 to 0');
		expect(await err(c.updateShotLayer('ghost', { opacity: 1 }))).toContain('There is no layer "ghost"');
		expect(await err(setup(null).addShotLayer('one', { effect: 'fake.gradient' }))).toMatch(/No effects provider/);
		expect(c.getState().scene).toBe(before);
		// A bare subject needs no provider.
		expect((await setup(null).addShotLayer('one', { subject: { image: 'a.png' } })).ok).toBe(true);
	});

	it('sets and clears a transition, writing out its length', async () => {
		const c = setup();
		const r = await c.setShotTransition('two', { effect: 'fake.crossfade' });
		expect(r).toMatchObject({ ok: true, transition: { effect: 'fake.crossfade', ms: 800, provider: 'fake', name: 'Crossfade', start: 500, end: 1300 } });
		expect(r.ok && r.notes[0]).toContain('camera cuts');
		expect((await c.setShotTransition('one', { effect: 'fake.crossfade' })) as { error: string }).toMatchObject({ error: expect.stringContaining('is the first shot, so there is no shot before it') });
		expect((await c.setShotTransition('two', { effect: 'fake.gradient' })) as { error: string }).toMatchObject({ error: expect.stringContaining('is not a transition') });
		expect(c.clearShotTransition('two')).toMatchObject({ ok: true, transition: null });
		expect(c.clearShotTransition('two')).toMatchObject({ ok: false, error: 'Shot "two" has no transition to clear.' });
	});

	it('checks layers and transitions against the provider', async () => {
		const s = scene([
			{ id: 'one', run: [], transition: { effect: 'fake.crossfade' }, layers: [{ id: 'a', effect: 'fake.nope' }, { id: 'b', effect: 'fake.gradient', values: { angle: 999 } }, { id: 'c', subject: { slot: 'logo' } }] },
			{ id: 'two', run: [], transition: { effect: 'fake.tint' } }
		]);
		const codes = (await checkMotionShotLayers(s, createFakeEffectProvider())).map((i) => i.code);
		expect(codes).toEqual(['transition-first-shot', 'layer-slot-empty', 'layer-effect-unknown', 'layer-effect-values', 'transition-unknown']);
		expect((await checkMotionShotLayers(s, null)).map((i) => i.code)).toEqual(['transition-first-shot', 'layer-slot-empty', 'layer-not-drawn', 'transition-not-played']);
	});
});

describe('shot layer tools', () => {
	const setup = (readOnly = false) => {
		const c = new AnimationEditorController({ scene: scene([{ id: 'one', run: [], hold: 500 }, { id: 'two', run: [], hold: 500 }]), effects: createFakeEffectProvider(), layerHost: null });
		const registry = new ToolRegistry();
		registry.register(createAnimationEffectsToolProvider(c, { namespace: '', readOnly }));
		return { c, registry };
	};
	const data = (r: { structuredContent?: unknown }) => r.structuredContent as any;
	const error = (r: { isError?: boolean; content: { type: string; text?: string }[] }) => (expect(r.isError).toBe(true), r.content.map((x) => x.text).join(' '));

	it('adds, lists, changes, restacks and removes layers as a model would', async () => {
		const { registry } = setup();
		const added = data(await registry.callTool('add_shot_layer', { shot: 'one', effect: 'fake.gradient', values: { angle: 30 } }));
		expect(added).toMatchObject({ shot: 'one', layer: { id: 'layer1', role: 'background', values: { angle: 30 }, start: 0, end: 500 }, transition: null });
		data(await registry.callTool('add_shot_layer', { shot: 'one', subject: { text: 'Launch' }, role: 'overlay', rect: { x: 10, y: 10, width: 200, height: 40 }, from: 100, fade: 50 }));
		expect(data(await registry.callTool('list_shot_layers', {})).shots.map((s: any) => [s.shot, s.layers.map((l: any) => l.id)])).toEqual([
			['one', ['layer1', 'layer2']],
			['two', []]
		]);
		const updated = data(await registry.callTool('update_shot_layer', { layer: 'layer1', until: { shots: 2 }, clear: ['values'] }));
		expect(updated.layer).toMatchObject({ id: 'layer1', end: 1000 });
		expect(updated.layer.values).toBeUndefined();
		expect(data(await registry.callTool('move_shot_layer', { layer: 'layer2', index: 0 })).layers.map((l: any) => l.id)).toEqual(['layer2', 'layer1']);
		expect(data(await registry.callTool('remove_shot_layer', { layer: 'layer2' })).layers.map((l: any) => l.id)).toEqual(['layer1']);
	});

	it('sets and clears transitions', async () => {
		const { registry } = setup();
		expect(data(await registry.callTool('set_shot_transition', { shot: 'two', effect: 'fake.crossfade', ms: 300 })).transition).toMatchObject({ effect: 'fake.crossfade', ms: 300, start: 500, end: 800 });
		expect(data(await registry.callTool('clear_shot_transition', { shot: 'two' })).transition).toBeNull();
	});

	it('refuses bad arguments with what to do instead', async () => {
		const { registry } = setup();
		expect(error(await registry.callTool('add_shot_layer', { shot: 'one' }))).toContain('Give an "effect"');
		expect(error(await registry.callTool('add_shot_layer', { shot: 'one', effect: 'fake.crossfade' }))).toMatch(/fake\.crossfade|set_shot_transition/);
		expect(error(await registry.callTool('add_shot_layer', { shot: 'one', subject: { video: 'v.mp4' } }))).toMatch(/subject/);
		expect(error(await registry.callTool('add_shot_layer', { shot: 'one', effect: 'fake.gradient', opacity: 3 }))).toMatch(/opacity/);
		expect(error(await registry.callTool('add_shot_layer', { shot: 'one', effect: 'fake.gradient', colour: 'red' }))).toMatch(/colour/);
		expect(error(await registry.callTool('update_shot_layer', { layer: 'nope', opacity: 1 }))).toContain('There is no layer "nope"');
		expect(error(await registry.callTool('update_shot_layer', { layer: 'nope' }))).toContain('Give at least one field');
		expect(error(await registry.callTool('set_shot_transition', { shot: 'one', effect: 'fake.crossfade' }))).toContain('first shot');
		expect(error(await registry.callTool('set_shot_transition', { shot: 'two', effect: 'fake.gradient' }))).toMatch(/fake\.gradient|not a transition/);
		expect(error(await registry.callTool('clear_shot_transition', { shot: 'two' }))).toContain('has no transition to clear');
	});

	it('hides write tools on a read-only surface but keeps the list', () => {
		const names = setup(true)
			.registry.listTools()
			.tools.map((t) => t.name);
		expect(names).toContain('list_shot_layers');
		expect(names).not.toContain('add_shot_layer');
		expect(names).not.toContain('set_shot_transition');
	});
});
