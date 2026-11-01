import { describe, expect, it } from 'vitest';
import {
	EffectControlError,
	EffectUnsupportedError,
	UnknownEffectError,
	checkEffectProvider,
	createFakeEffectProvider,
	effectOffered,
	isCameraView,
	sampleCameraViews,
	sampleEffectCameraMove,
	type CameraMoveContext,
	type CameraView,
	type EffectDescription,
	type EffectProvider
} from '../src/effects';
import { ToolRegistry, baseToolName } from '../src/tools';
import { VideoEditorController, createVideoEffectsToolProvider, parseVideoProject } from '../src/video-editor';

const stage = { width: 320, height: 180 };
const wide: CameraView = { zoom: 1, scrollX: 0, scrollY: 0 };
const close: CameraView = { zoom: 2, scrollX: -40, scrollY: -20 };
const ctx = (u: number, to = close, ms = 800): CameraMoveContext => ({ from: wide, to, u, ms, stage });

describe('camera moves: a provider without camera support', () => {
	const provider = createFakeEffectProvider();

	it('conforms, lists no camera moves and has no cameraView', async () => {
		expect(await checkEffectProvider(provider)).toEqual([]);
		expect(provider.capabilities.supportsCamera).toBeUndefined();
		expect(provider.cameraView).toBeUndefined();
		expect(await provider.list({ kind: 'camera' })).toEqual([]);
	});

	it('sampleEffectCameraMove refuses with the reason', async () => {
		await expect(sampleEffectCameraMove(provider, 'fake.glide', { from: wide, to: close, ms: 800, stage, fps: 10 })).rejects.toThrow(/has no camera moves \(capabilities.supportsCamera is not set\)/);
	});

	it('a provider written before camera moves (no supportsCamera at all) still conforms', async () => {
		const { supportsCamera: _gone, ...capabilities } = provider.capabilities;
		expect(await checkEffectProvider({ ...provider, capabilities })).toEqual([]);
	});
});

describe('camera moves: a provider with camera support', () => {
	const provider = createFakeEffectProvider({ camera: true });

	it('conforms to the contract', async () => {
		expect(provider.capabilities.supportsCamera).toBe(true);
		expect(await checkEffectProvider(provider)).toEqual([]);
	});

	it('lists camera moves by kind and use, with their role, length and cut', async () => {
		const moves = await provider.list({ kind: 'camera' });
		expect(moves.map((e) => [e.id, e.uses, e.camera])).toEqual([
			['fake.glide', ['camera'], { role: 'transition', durationMs: 800 }],
			['fake.whip', ['camera'], { role: 'transition', durationMs: 400, cut: 0.5 }],
			['fake.drift', ['camera'], { role: 'hold', durationMs: 4000 }]
		]);
		expect((await provider.search('', { use: 'camera' })).map((e) => e.id)).toEqual(['fake.glide', 'fake.whip', 'fake.drift']);
		// Pixel uses never find a camera move.
		expect((await provider.search('', { use: 'transition' })).map((e) => e.id)).toEqual(['fake.crossfade']);
		expect((await provider.describe('fake.whip')).camera).toEqual({ role: 'transition', durationMs: 400, cut: 0.5 });
	});

	it('cameraView runs from the first framing to the next, synchronously and purely', () => {
		const start = provider.cameraView!('fake.glide', ctx(0));
		const end = provider.cameraView!('fake.glide', ctx(1));
		expect(start).toEqual(wide);
		expect(end.zoom).toBeCloseTo(close.zoom);
		expect(end.scrollX).toBeCloseTo(close.scrollX);
		expect(end.scrollY).toBeCloseTo(close.scrollY);
		const mid = provider.cameraView!('fake.glide', ctx(0.5), { curve: 'linear' });
		expect(mid.zoom).toBeCloseTo(1.5);
		expect(provider.cameraView!('fake.glide', ctx(0.3))).toEqual(provider.cameraView!('fake.glide', ctx(0.3)));
		expect(isCameraView(mid)).toBe(true);
	});

	it('a whip blurs towards its cut and settles on the next framing', () => {
		const before = provider.cameraView!('fake.whip', ctx(0.49, close, 400));
		expect(before.blur).toBeGreaterThan(30);
		expect(before.blurAngle).toBeTypeOf('number');
		expect(provider.cameraView!('fake.whip', ctx(0.49, close, 400), { blur: 0 }).blur).toBeUndefined();
		const end = provider.cameraView!('fake.whip', ctx(1, close, 400));
		expect(end.blur).toBeUndefined();
		expect(end.zoom).toBe(2);
		expect(end.scrollX).toBeCloseTo(close.scrollX);
	});

	it('a hold moves within one framing', () => {
		const end = provider.cameraView!('fake.drift', { from: wide, to: wide, u: 1, ms: 4000, stage }, { scale: 1.5 });
		expect(end.zoom).toBeCloseTo(1.5);
		// Still centred on the framing's middle.
		expect(stage.width / (2 * end.zoom) - end.scrollX).toBeCloseTo(stage.width / 2);
	});

	it('cameraView fails with typed errors that say what to do', () => {
		expect(() => provider.cameraView!('nope', ctx(0))).toThrow(UnknownEffectError);
		expect(() => provider.cameraView!('fake.glide', ctx(0), { curve: 'bouncy' })).toThrow(EffectControlError);
		expect(() => provider.cameraView!('fake.tint', ctx(0))).toThrow(/is a shader effect, not a camera move/);
		expect(() => provider.cameraView!('fake.glide', ctx(1.5))).toThrow(/u must be 0–1/);
	});

	it('createRenderer refuses a camera move with a sentence', () => {
		expect(() => provider.createRenderer('fake.glide', { width: 8, height: 8 })).toThrow(EffectUnsupportedError);
		expect(() => provider.createRenderer('fake.glide', { width: 8, height: 8 })).toThrow(/moves a scene's camera and draws no pixels/);
	});

	it('sampleCameraMove keys every frame and keys both sides of a cut at one time', async () => {
		const glide = await provider.sampleCameraMove!('fake.glide', { from: wide, to: close, ms: 800, stage, fps: 10 });
		expect(glide.keys.map((k) => k.t)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800]);
		expect(glide.cut).toBeUndefined();
		expect(glide.keys[0].view).toEqual(provider.cameraView!('fake.glide', ctx(0)));

		const whip = await provider.sampleCameraMove!('fake.whip', { from: wide, to: close, ms: 400, stage, fps: 10 });
		expect(whip.cut).toBe(200);
		expect(whip.keys.map((k) => k.t)).toEqual([0, 100, 200, 200, 300, 400]);
		const [justBefore, after] = whip.keys.slice(2, 4).map((k) => k.view);
		expect(justBefore.zoom).toBe(1);
		expect(after.zoom).toBe(2);
	});

	it('sampleEffectCameraMove falls back to cameraView per frame', async () => {
		const { sampleCameraMove: _own, ...withoutSampling } = provider;
		const fallback = await sampleEffectCameraMove(withoutSampling as EffectProvider, 'fake.whip', { from: wide, to: close, ms: 400, stage, fps: 10 });
		expect(fallback).toEqual(await provider.sampleCameraMove!('fake.whip', { from: wide, to: close, ms: 400, stage, fps: 10 }));
		await expect(sampleEffectCameraMove(withoutSampling as EffectProvider, 'fake.tint', { from: wide, to: close, ms: 400, stage, fps: 10 })).rejects.toThrow(/not a camera move/);
	});
});

describe('camera moves: helpers', () => {
	it('sampleCameraViews keys a move with no length as its first and last view', () => {
		const sample = sampleCameraViews((u) => ({ zoom: 1 + u, scrollX: 0, scrollY: 0 }), { ms: 0, fps: 30 });
		expect(sample.keys).toEqual([
			{ t: 0, view: { zoom: 1, scrollX: 0, scrollY: 0 } },
			{ t: 0, view: { zoom: 2, scrollX: 0, scrollY: 0 } }
		]);
	});

	it('sampleCameraViews ends on the move\'s length when it is not a whole number of frames', () => {
		const sample = sampleCameraViews((u) => ({ zoom: 1 + u, scrollX: 0, scrollY: 0 }), { ms: 250, fps: 10 });
		expect(sample.keys.map((k) => k.t)).toEqual([0, 100, 200, 250]);
		expect(sample.keys[3].view.zoom).toBe(2);
	});

	it('sampleCameraViews refuses bad lengths, rates and cuts', () => {
		const view = () => wide;
		expect(() => sampleCameraViews(view, { ms: -1, fps: 10 })).toThrow(/ms must be/);
		expect(() => sampleCameraViews(view, { ms: 100, fps: 0 })).toThrow(/fps must be/);
		expect(() => sampleCameraViews(view, { ms: 100, fps: 10, cut: 2 })).toThrow(/cut must be 0–1/);
	});

	it('effectOffered offers camera moves only where the camera use is asked for', () => {
		const camera = { kind: 'camera' as const, uses: ['camera' as const] };
		const motion = { kind: 'motion' as const, uses: ['motion' as const] };
		const shader = { kind: 'shader' as const, uses: ['transition' as const] };
		expect(effectOffered(camera)).toBe(false);
		expect(effectOffered(motion)).toBe(false);
		expect(effectOffered(shader)).toBe(true);
		expect(effectOffered(camera, ['transition', 'filter'])).toBe(false);
		expect(effectOffered(camera, ['camera'])).toBe(true);
		expect(effectOffered(shader, ['camera'])).toBe(false);
	});

	it('isCameraView needs a positive zoom and finite numbers', () => {
		expect(isCameraView(wide)).toBe(true);
		expect(isCameraView({ zoom: 0, scrollX: 0, scrollY: 0 })).toBe(false);
		expect(isCameraView({ zoom: 1, scrollX: NaN, scrollY: 0 })).toBe(false);
		expect(isCameraView({ zoom: 1, scrollX: 0, scrollY: 0, tilt: Infinity })).toBe(false);
	});
});

describe('camera moves: the conformance check catches broken providers', () => {
	const good = createFakeEffectProvider({ camera: true });
	const messages = async (p: EffectProvider) => (await checkEffectProvider(p)).map((i) => `${i.effectId ?? ''}: ${i.message}`);

	it('camera moves listed without supportsCamera, and supportsCamera without cameraView', async () => {
		const { cameraView: _v, sampleCameraMove: _s, ...rest } = good;
		expect(await messages({ ...good, capabilities: { ...good.capabilities, supportsCamera: false } })).toContain(': the catalog lists camera effects but capabilities.supportsCamera is not set');
		expect(await messages(rest as EffectProvider)).toContain(': supportsCamera is set but cameraView is missing');
	});

	it('a camera move with a pixel use, no camera field, or a bad cut', async () => {
		const edit = (change: (d: EffectDescription) => EffectDescription): EffectProvider => {
			const fix = (d: EffectDescription) => (d.id === 'fake.whip' ? change(d) : d);
			return {
				...good,
				list: async (o) => (await Promise.all((await good.list(o)).map((e) => good.describe(e.id)))).map(fix),
				search: async (q, o) => (await Promise.all((await good.search(q, o)).map((e) => good.describe(e.id)))).map(fix),
				describe: async (id) => fix(await good.describe(id))
			};
		};
		expect(await messages(edit((d) => ({ ...d, uses: ['transition'] })))).toContain('fake.whip: a camera effect must have exactly the use "camera"');
		expect(await messages(edit(({ camera: _c, ...d }) => d))).toContain('fake.whip: a camera effect needs camera: { role, durationMs }');
		expect(await messages(edit((d) => ({ ...d, camera: { role: 'pan' as never, durationMs: 400, cut: 3 } })))).toEqual(
			expect.arrayContaining(['fake.whip: camera.role "pan" is not one of transition, hold', 'fake.whip: camera.cut must be 0–1 when present'])
		);
		expect(await messages(edit((d) => ({ ...d, duration: 900 })))).toContain('fake.whip: duration 900 differs from camera.durationMs 400');
	});

	it('a cameraView that is async, impure, or does not validate', async () => {
		let calls = 0;
		const impure: EffectProvider = { ...good, cameraView: (id, c, v) => ({ ...good.cameraView!(id, c, v), scrollX: calls++ }) };
		expect(await messages(impure)).toContain('fake.glide: cameraView is not pure: two calls at u 0 gave different views');

		const asynchronous: EffectProvider = { ...good, cameraView: ((id: string, c: CameraMoveContext) => Promise.resolve(good.cameraView!(id, c))) as never, sampleCameraMove: undefined };
		expect(await messages(asynchronous)).toContain('fake.glide: cameraView must be synchronous; it returned a Promise');

		const loose: EffectProvider = { ...good, cameraView: (id, c) => good.cameraView!(id, c) };
		expect(await messages(loose)).toContain('fake.glide: cameraView with an unknown control did not fail (expected invalid_values)');

		const untyped: EffectProvider = {
			...good,
			cameraView: (id, c, v) => {
				if (id === '__no_such_effect__') throw new Error('nope');
				return good.cameraView!(id, c, v);
			}
		};
		expect(await messages(untyped)).toContain(': cameraView of an unknown id failed with untyped Error: nope (expected unknown_effect)');
	});

	it('a renderer refused without a reason, and samples that disagree with cameraView', async () => {
		const silent: EffectProvider = {
			...good,
			createRenderer: (id, o) => {
				if (['fake.glide', 'fake.whip', 'fake.drift'].includes(id)) throw new EffectUnsupportedError('', id);
				return good.createRenderer(id, o);
			}
		};
		expect(await messages(silent)).toContain('fake.glide: createRenderer refused without saying why');

		const off: EffectProvider = { ...good, sampleCameraMove: async (id, r) => ({ keys: [{ t: 0, view: wide }, { t: r.ms, view: { zoom: 9, scrollX: 0, scrollY: 0 } }] }) };
		expect(await messages(off)).toEqual(expect.arrayContaining(['fake.glide: sampleCameraMove disagrees with cameraView at the start or end of the move', 'fake.whip: sampleCameraMove gave no cut for a move that cuts']));
	});
});

describe('camera moves: agent tools', () => {
	const setup = () => {
		const controller = new VideoEditorController({
			project: parseVideoProject({ version: 1, width: 4, height: 2, fps: 10, assets: [], tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'a', type: 'color', color: '#000000', start: 0, duration: 1000 }] }] }),
			effects: createFakeEffectProvider({ camera: true })
		});
		const registry = new ToolRegistry();
		registry.register(createVideoEffectsToolProvider(controller));
		const tool = (name: string) => registry.listTools().tools.find((t) => baseToolName(t.name) === name)!;
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const r = await registry.callTool(tool(name).name, args);
			if (r.isError) throw new Error((r.content[0] as { text: string }).text);
			return r.structuredContent as any;
		};
		return { registry, tool, call };
	};

	it('search_effects finds camera moves by kind and reports their role, length and cut', async () => {
		const { call, tool } = setup();
		expect((tool('search_effects').inputSchema as any).properties.kind.enum).toContain('camera');
		const out = await call('search_effects', { kind: 'camera' });
		expect(out.effects.map((e: any) => [e.id, e.camera])).toEqual([
			['fake.glide', { role: 'transition', durationMs: 800 }],
			['fake.whip', { role: 'transition', durationMs: 400, cut: 0.5 }],
			['fake.drift', { role: 'hold', durationMs: 4000 }]
		]);
	});

	it('describe_effect says a camera move does not apply in a pixel editor, and apply_effect never offers one', async () => {
		const { call, tool } = setup();
		const d = await call('describe_effect', { effect: 'fake.whip' });
		expect(d).toMatchObject({ kind: 'camera', camera: { role: 'transition', cut: 0.5 }, appliesHere: false });
		// Let the catalog land so the effect enum is listed.
		await new Promise((r) => setTimeout(r, 0));
		const ids: string[] = (tool('apply_effect').inputSchema as any).properties.effect.enum;
		expect(ids).toContain('fake.tint');
		expect(ids.some((id) => ['fake.glide', 'fake.whip', 'fake.drift'].includes(id))).toBe(false);
	});
});
