import { describe, expect, it, vi } from 'vitest';
import { createEffectPixels, createFakeEffectProvider, type EffectPixels } from '../src/effects';
import {
	VideoEditorController,
	VideoEffectsEngine,
	drawVideoFrame,
	parseVideoProject,
	renderVideoFrameExact,
	toVideoFfmpeg,
	videoEffectFrameTime,
	videoFrameAt,
	videoProjectEffects,
	videoProjectSvg,
	type VideoProject
} from '../src/video-editor';

const project = (): VideoProject =>
	parseVideoProject({
		version: 1,
		width: 4,
		height: 2,
		fps: 10,
		assets: [{ id: 'red', kind: 'image', src: 'red.png', width: 4, height: 2 }],
		tracks: [
			{
				id: 'v1',
				kind: 'video',
				clips: [
					{ id: 'a', type: 'color', color: '#000000', start: 0, duration: 1000 },
					{ id: 'b', type: 'color', color: '#ffffff', start: 1000, duration: 1000 }
				]
			}
		]
	});

/** A recording 2D context whose getImageData returns `fill` everywhere. */
function recorder(fill: [number, number, number, number]) {
	const calls: { op: string; args: unknown[]; alpha?: number }[] = [];
	const state: any = { globalAlpha: 1, measureText: () => ({ width: 0 }) };
	state.getImageData = (_x: number, _y: number, w: number, h: number) => {
		const data = new Uint8ClampedArray(w * h * 4);
		for (let i = 0; i < data.length; i += 4) data.set(fill, i);
		return { width: w, height: h, data };
	};
	const ctx = new Proxy(state, {
		get: (t, k: string) => (k in t ? t[k] : (...args: unknown[]) => calls.push({ op: k, args, alpha: t.globalAlpha })),
		set: (t, k, v) => ((t[k] = v), true)
	});
	return { ctx, calls };
}

const imageOf = (p: EffectPixels) => ({ pixels: p }) as unknown as CanvasImageSource;
const engineWith = (provider = createFakeEffectProvider()) => {
	const engine = new VideoEffectsEngine({ toImage: imageOf });
	engine.slot.set(provider);
	return engine;
};

describe('video effects: the project model', () => {
	it('parses and round-trips clip effects, effect clips and effect transitions without a provider', () => {
		const p = parseVideoProject({
			...project(),
			tracks: [
				{
					id: 'v1',
					kind: 'video',
					clips: [
						{ id: 'a', type: 'color', color: '#000', start: 0, duration: 1000, effects: [{ id: 'fx1', effect: 'fake.tint', name: 'Tint', values: { amount: { keys: [{ t: 0, v: 0 }, { t: 1000, v: 1 }] }, color: '#ff0000' } }] },
						{ id: 'g', type: 'effect', effect: 'fake.gradient', name: 'Gradient', values: { angle: 45 }, start: 1000, duration: 1000, transition: { type: 'effect', duration: 400, effect: { effect: 'fake.crossfade', values: { curve: 'linear' } } } }
					]
				}
			]
		});
		const again = parseVideoProject(JSON.parse(JSON.stringify(p)));
		expect(again).toEqual(p);
		expect(videoProjectEffects(p).map((u) => [u.clip, u.kind, u.effect])).toEqual([
			['a', 'clip', 'fake.tint'],
			['g', 'generator', 'fake.gradient'],
			['g', 'transition', 'fake.crossfade']
		]);
		// Saved without a provider, loaded without one: still there.
		const c = new VideoEditorController({ project: p });
		expect(c.getState().effectsProvider).toBeNull();
		expect(parseVideoProject(JSON.parse(JSON.stringify(c.getProject())))).toEqual(p);
	});

	it('refuses malformed effect data with paths', () => {
		const bad = (clip: Record<string, unknown>) => () => parseVideoProject({ ...project(), tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'a', type: 'color', color: '#000', start: 0, duration: 1000, ...clip }] }] });
		expect(bad({ effects: [{ id: 'x', effect: 'e' }, { id: 'x', effect: 'e' }] })).toThrow(/repeats "x"/);
		expect(bad({ effects: [{ id: 'x', effect: 'e', values: { a: { b: 1 } } }] })).toThrow(/effects\[0\]\.values\.a/);
		expect(bad({ transition: { type: 'effect', duration: 100 } })).toThrow(/effect is required/);
		expect(bad({ transition: { type: 'crossfade', duration: 100, effect: { effect: 'x' } } })).toThrow(/only for transitions of type "effect"/);
		expect(bad({ transition: { type: 'effect', duration: 100, effect: { effect: 'x', values: { a: { keys: [{ t: 0, v: 1 }] } } } } })).toThrow(/transition\.effect\.values\.a/);
	});

	it('evaluates effects at clip time, generators and transitions', () => {
		const p = parseVideoProject({
			...project(),
			tracks: [
				{
					id: 'v1',
					kind: 'video',
					clips: [
						{ id: 'a', type: 'color', color: '#000', start: 0, duration: 1000, effects: [{ id: 'fx1', effect: 'fake.tint', values: { amount: { keys: [{ t: 0, v: 0 }, { t: 1000, v: 1 }] } } }, { id: 'off', effect: 'fake.invert', enabled: false }] },
						{ id: 'g', type: 'effect', effect: 'fake.gradient', values: { angle: 45 }, start: 1000, duration: 1000, transition: { type: 'effect', duration: 400, effect: { effect: 'fake.crossfade' } } }
					]
				}
			]
		});
		const at500 = videoFrameAt(p, 500).layers;
		expect(at500).toHaveLength(1);
		expect(at500[0].effects).toEqual([{ id: 'fx1', effect: 'fake.tint', opacity: 1, values: { amount: 0.5 }, time: 500 }]);
		const across = videoFrameAt(p, 1100).layers;
		expect(across).toHaveLength(1);
		const t = across[0].transitionEffect!;
		expect(t.from?.clip).toBe('a');
		expect(t.progress).toBeCloseTo(0.75);
		expect(t.time).toBeCloseTo(300);
		expect(across[0].generator).toEqual({ effect: 'fake.gradient', values: { angle: 45 }, time: 100 });
		// SVG has no effects: a crossfade and a labelled box.
		const svg = videoProjectSvg(p, 1100);
		expect(svg).toContain('Effect: fake.gradient');
		expect(svg).toContain('opacity="0.75"');
	});

	it('snaps effect times to the frame grid', () => {
		expect(videoEffectFrameTime(149, 10)).toBe(100);
		expect(videoEffectFrameTime(200, 10)).toBe(200);
	});
});

describe('video effects: without a provider the editor behaves as before', () => {
	it('edits, draws and exports projects without effects exactly as before', () => {
		const plain = new VideoEditorController({ project: project() });
		const withSlot = new VideoEditorController({ project: project() });
		withSlot.setEffectsProvider(null);
		for (const c of [plain, withSlot]) c.apply({ op: 'set_transition', clip: 'b', transition: { type: 'crossfade', duration: 200 } });
		expect(withSlot.getProject()).toEqual(plain.getProject());
		expect(withSlot.toFfmpeg().command).toBe(plain.toFfmpeg().command);
		const a = recorder([0, 0, 0, 0]);
		const b = recorder([0, 0, 0, 0]);
		drawVideoFrame(a.ctx, plain.frame(1000), () => null, 1, {});
		drawVideoFrame(b.ctx, withSlot.frame(1000), () => null, 1, { effects: withSlot.effectsEngine });
		expect(b.calls).toEqual(a.calls);
	});

	it('refuses to add effects, with the reason', async () => {
		const c = new VideoEditorController({ project: project() });
		const r = await c.applyClipEffect('a', 'fake.tint');
		expect(r).toEqual({ ok: false, error: expect.stringMatching(/No effects provider is registered/) });
		expect(c.getState().error).toMatch(/setEffectsProvider/);
		expect(c.history.getState().canUndo).toBe(false);
	});

	it('draws effect clips as placeholders and effect transitions as crossfades', () => {
		const c = new VideoEditorController({ project: project() });
		c.apply({ op: 'add_clip', track: 'v1', clip: { type: 'effect', effect: 'fake.gradient', name: 'Gradient', start: 2000, duration: 1000 } });
		const main = recorder([0, 0, 0, 0]);
		drawVideoFrame(main.ctx, c.frame(2500), () => null, 1, { effects: c.effectsEngine });
		expect(main.calls.find((x) => x.op === 'fillText')?.args[0]).toBe('Effect: Gradient');
	});
});

describe('video effects: controller edits with a provider', () => {
	const editor = () => new VideoEditorController({ project: project(), effects: createFakeEffectProvider() });

	it('applies a clip effect with checked values as one undo step', async () => {
		const c = editor();
		const r = await c.applyClipEffect('a', 'fake.tint', { values: { amount: 0.25 } });
		expect(r.ok && r.effect).toEqual({ id: 'fx1', effect: 'fake.tint', provider: 'fake', name: 'Tint', values: { color: '#ff8800', amount: 0.25 } });
		expect(c.getProject().tracks[0].clips[0].effects).toHaveLength(1);
		expect(c.history.getState().undoName).toBe('Add effect Tint');
		c.undo();
		expect(c.getProject().tracks[0].clips[0].effects).toBeUndefined();
	});

	it('refuses bad values, unknown ids and effects that do not fit, changing nothing', async () => {
		const c = editor();
		expect(await c.applyClipEffect('a', 'fake.tint', { values: { amount: 3 } })).toMatchObject({ ok: false, error: expect.stringMatching(/\/amount.*(at most|maximum|<=)/) });
		expect(await c.applyClipEffect('a', 'fake.tint', { values: { colour: '#fff' } })).toMatchObject({ ok: false, error: expect.stringMatching(/colour/) });
		expect(await c.applyClipEffect('a', 'nope')).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown effect "nope"/) });
		expect(await c.applyClipEffect('a', 'fake.crossfade')).toMatchObject({ ok: false, error: expect.stringMatching(/set_video_effect_transition/) });
		expect(await c.applyClipEffect('a', 'fake.gradient')).toMatchObject({ ok: false, error: expect.stringMatching(/add_video_effect_clip/) });
		expect(await c.applyClipEffect('zz', 'fake.tint')).toMatchObject({ ok: false, error: expect.stringMatching(/no clip "zz"/) });
		expect(c.history.getState().canUndo).toBe(false);
	});

	it('updates, reorders, keyframes and removes clip effects', async () => {
		const c = editor();
		await c.applyClipEffect('a', 'fake.tint');
		await c.applyClipEffect('a', 'fake.invert');
		const u = await c.updateClipEffect('a', 'fx2', { values: { amount: 0.5 }, index: 0, enabled: false });
		expect(u.ok && u.effect).toMatchObject({ id: 'fx2', enabled: false, values: { amount: 0.5 } });
		expect(c.getProject().tracks[0].clips[0].effects!.map((e) => e.id)).toEqual(['fx2', 'fx1']);
		const k = await c.setClipEffectKeyframes('a', 'fx1', 'amount', [{ t: 500, v: 1 }, { t: 0, v: 0 }]);
		expect(k.ok && k.effect?.values?.amount).toEqual({ keys: [{ t: 0, v: 0 }, { t: 500, v: 1 }] });
		expect(await c.setClipEffectKeyframes('a', 'fx1', 'color', [{ t: 0, v: 1 }])).toMatchObject({ ok: false, error: expect.stringMatching(/only number controls/) });
		const reset = await c.updateClipEffect('a', 'fx1', { values: { amount: null } });
		expect(reset.ok && reset.effect?.values?.amount).toBe(0.5);
		const removed = c.removeClipEffect('a', 'fx2');
		expect(removed.ok && removed.effect?.id).toBe('fx2');
		expect(c.removeClipEffect('a', 'fx9')).toMatchObject({ ok: false, error: expect.stringMatching(/no effect "fx9"/) });
	});

	it('sets effect transitions and adds effect clips', async () => {
		const c = editor();
		const t = await c.setEffectTransition('b', 'fake.crossfade', { values: { curve: 'linear' } });
		expect(t.ok).toBe(true);
		expect(c.getProject().tracks[0].clips[1].transition).toEqual({ type: 'effect', duration: 1000, effect: { effect: 'fake.crossfade', provider: 'fake', name: 'Crossfade', values: { curve: 'linear' } } });
		const g = await c.addEffectClip('v1', 'fake.bar', { start: 2000 });
		expect(g).toMatchObject({ ok: true, clip: 'c1' });
		expect(c.getProject().tracks[0].clips[2]).toMatchObject({ type: 'effect', effect: 'fake.bar', duration: 2000, name: 'Lower-third bar' });
		const v = await c.updateEffectValues('c1', 'generator', { color: '#00ff00' });
		expect(v.ok).toBe(true);
		expect((c.getProject().tracks[0].clips[2] as { values: Record<string, unknown> }).values.color).toBe('#00ff00');
		expect(await c.updateEffectValues('b', 'transition', { curve: 'wobbly' })).toMatchObject({ ok: false });
		expect(await c.addEffectClip('v1', 'fake.tint')).toMatchObject({ ok: false, error: expect.stringMatching(/apply_effect/) });
	});

	it('read-only editors refuse effect edits', async () => {
		const c = new VideoEditorController({ project: project(), effects: createFakeEffectProvider(), readOnly: true });
		expect(await c.applyClipEffect('a', 'fake.tint')).toMatchObject({ ok: false, error: expect.stringMatching(/read-only/) });
	});

	it('notifies when the provider changes and useEffects clears it', () => {
		const c = new VideoEditorController({ project: project() });
		const seen: unknown[] = [];
		c.subscribe((s) => seen.push(s.effectsProvider?.id ?? null));
		const release = c.useEffects(createFakeEffectProvider());
		release();
		expect(seen).toEqual(['fake', null]);
	});
});

describe('video effects: rendering', () => {
	it('runs stacks, generators and transitions on the provider', async () => {
		const engine = engineWith();
		const input = createEffectPixels(1, 1);
		input.data.set([0, 0, 0, 255]);
		const stack = await engine.run({ kind: 'stack', input, effects: [{ id: 'fx1', effect: 'fake.invert', opacity: 0.5, values: {}, time: 0 }] });
		expect([...stack.data]).toEqual([128, 128, 128, 255]);
		const over = await engine.run({ kind: 'stack', input, effects: [{ id: 'b', effect: 'fake.bar', opacity: 1, values: { height: 0.5 }, time: 5000 }] });
		expect(over.data[3]).toBe(255);
		const gen = await engine.run({ kind: 'generator', width: 2, height: 1, effect: 'fake.gradient', values: { from: '#000000', to: '#ffffff', angle: 0 }, time: 0, effects: [] });
		expect(gen.data[0]).toBeLessThan(gen.data[4]);
		const white = createEffectPixels(1, 1);
		white.data.set([200, 200, 200, 255]);
		const x = await engine.run({ kind: 'transition', effect: 'fake.crossfade', values: { curve: 'linear' }, progress: 0.5, time: 500, from: input, to: white });
		expect(x.data[0]).toBe(100);
	});

	it('caches per key, renders once, and resets when the provider changes', async () => {
		const onRender = vi.fn();
		const engine = engineWith(createFakeEffectProvider({ onRender }));
		const job = { kind: 'generator' as const, width: 1, height: 1, effect: 'fake.gradient', values: {}, time: 0, effects: [] };
		expect(engine.request('k', job)).toBe(true);
		expect(engine.request('k', job)).toBe(true);
		await engine.idle();
		expect(engine.request('k', job)).toBe(false);
		expect(onRender).toHaveBeenCalledTimes(1);
		expect(engine.get('k')).toMatchObject({ pixels: { width: 1 } });
		engine.slot.set(createFakeEffectProvider());
		expect(engine.get('k')).toBeUndefined();
		engine.slot.set(null);
		expect(engine.request('k', job)).toBe(false);
	});

	it('records failures instead of retrying', async () => {
		const engine = engineWith();
		engine.request('bad', { kind: 'generator', width: 1, height: 1, effect: 'fake.gradient', values: { angle: 999 }, time: 0, effects: [] });
		await engine.idle();
		expect(engine.failure('bad')?.message).toMatch(/angle/);
		expect(engine.request('bad', { kind: 'generator', width: 1, height: 1, effect: 'fake.gradient', values: {}, time: 0, effects: [] })).toBe(false);
	});

	it('draws a clip without its effect while it renders, then with it', async () => {
		const c = new VideoEditorController({ project: project(), effects: createFakeEffectProvider() });
		await c.applyClipEffect('a', 'fake.invert');
		const engine = new VideoEffectsEngine({ slot: c.effects, toImage: imageOf });
		const scratch = recorder([0, 0, 0, 255]);
		const scratchCanvas = { id: 'scratch' } as unknown as CanvasImageSource;
		const draw = () => {
			const main = recorder([0, 0, 0, 0]);
			const waiting = vi.fn();
			drawVideoFrame(main.ctx, c.frame(500), () => null, 1, { effects: engine, scratch: () => ({ canvas: scratchCanvas, ctx: scratch.ctx }), onEffectWaiting: waiting });
			return { main, waiting };
		};
		const first = draw();
		expect(first.waiting).toHaveBeenCalled();
		expect(first.main.calls.some((x) => x.op === 'drawImage')).toBe(false);
		await engine.idle();
		const second = draw();
		expect(second.waiting).not.toHaveBeenCalled();
		const drawn = second.main.calls.find((x) => x.op === 'drawImage')!;
		expect((drawn.args[0] as { pixels: EffectPixels }).pixels.data.slice(0, 4)).toEqual(new Uint8ClampedArray([255, 255, 255, 255]));
	});

	it('renders frame-exact frames with effect transitions for export', async () => {
		const c = new VideoEditorController({ project: project(), effects: createFakeEffectProvider() });
		await c.setEffectTransition('b', 'fake.crossfade', { duration: 400, values: { curve: 'linear' } });
		const engine = new VideoEffectsEngine({ slot: c.effects, toImage: imageOf });
		const fills: Record<number, [number, number, number, number]> = { 1001: [0, 0, 0, 255], 1002: [255, 255, 255, 255] };
		const scratches = new Map<number, ReturnType<typeof recorder>>();
		const scratch = (_w: number, _h: number, slot: number) => {
			if (!scratches.has(slot)) scratches.set(slot, recorder(fills[slot] ?? [0, 0, 0, 0]));
			return { canvas: { slot } as unknown as CanvasImageSource, ctx: scratches.get(slot)!.ctx };
		};
		const main = recorder([0, 0, 0, 0]);
		const out = await renderVideoFrameExact(main.ctx, c.getProject(), 1050, () => null, { effects: engine, scratch });
		expect(out.complete).toBe(true);
		expect(out.frame.time).toBe(1000);
		const drawn = main.calls.filter((x) => x.op === 'drawImage').pop()!;
		expect((drawn.args[0] as { pixels: EffectPixels }).pixels.data[0]).toBe(128);
	});
});

describe('video effects: ffmpeg export', () => {
	it('refuses projects with provider effects, naming them and the way out', async () => {
		const c = new VideoEditorController({ project: project(), effects: createFakeEffectProvider() });
		await c.applyClipEffect('a', 'fake.tint');
		expect(() => c.toFfmpeg()).toThrow(/an effect on "a" \(Tint\).*renderVideoFrameExact.*frames/);
		await c.updateClipEffect('a', 'fx1', { enabled: false });
		expect(() => c.toFfmpeg()).not.toThrow();
	});

	it('takes rendered frames for the picture and still mixes the sound', async () => {
		const c = new VideoEditorController({ project: project(), effects: createFakeEffectProvider() });
		await c.addEffectClip('v1', 'fake.gradient', { start: 0, duration: 1000, mode: 'overwrite' });
		const png = c.toFfmpeg({ frames: { input: 'frames/%06d.png' } });
		expect(png.args.slice(0, 5)).toEqual(['-y', '-framerate', '10', '-i', 'frames/%06d.png']);
		expect(png.filterComplex).toBe('[0:v]scale=4:2,format=yuv420p,trim=duration=2[vout]');
		const raw = c.toFfmpeg({ frames: { input: 'pipe:0', format: 'rawvideo' } });
		expect(raw.args).toEqual(expect.arrayContaining(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '4x2', 'pipe:0']));
	});
});
