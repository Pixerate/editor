import { describe, expect, it } from 'vitest';
import {
	EffectControlError,
	EffectUnsupportedError,
	TIMING_MAX_FRAMES,
	UnknownEffectError,
	blendTimingFrames,
	checkEffectProvider,
	createEffectPixels,
	createFakeEffectProvider,
	effectOffered,
	normaliseTimingSample,
	timingSampleProblems,
	type EffectDescription,
	type EffectPixels,
	type EffectProvider,
	type TimingSampleRequest
} from '../src/effects';
import { ToolRegistry, baseToolName } from '../src/tools';
import { VideoEditorController, createVideoEffectsToolProvider, parseVideoProject } from '../src/video-editor';

/** One frame of 30 fps footage (ms). */
const F = 1000 / 30;
const at = (time: number, footage = 3000, fps?: number): TimingSampleRequest => ({ time, footage, ...(fps ? { fps } : {}) });
const close = (sample: { frames: readonly { time: number; weight: number }[] }) => sample.frames.map((f) => [+f.time.toFixed(3), +f.weight.toFixed(4)]);

describe('timing effects: a provider without timing support', () => {
	const provider = createFakeEffectProvider();

	it('conforms, lists no timing effects and has no timing methods', async () => {
		expect(await checkEffectProvider(provider)).toEqual([]);
		expect(provider.capabilities.supportsTiming).toBeUndefined();
		expect(provider.timingLength).toBeUndefined();
		expect(provider.timingSample).toBeUndefined();
		expect(await provider.list({ kind: 'timing' })).toEqual([]);
	});
});

describe('timing effects: a provider with timing support', () => {
	const provider = createFakeEffectProvider({ timing: true, camera: true });

	it('conforms to the contract', async () => {
		expect(provider.capabilities.supportsTiming).toBe(true);
		expect(await checkEffectProvider(provider)).toEqual([]);
	});

	it('lists timing effects by kind and use, with no duration and no inputs', async () => {
		const timing = await provider.list({ kind: 'timing' });
		expect(timing.map((e) => [e.id, e.uses, e.duration])).toEqual([
			['fake.speed', ['timing'], undefined],
			['fake.freeze', ['timing'], undefined],
			['fake.echo', ['timing'], undefined]
		]);
		expect((await provider.search('', { use: 'timing' })).map((e) => e.id)).toEqual(['fake.speed', 'fake.freeze', 'fake.echo']);
		// Pixel uses never find a timing effect.
		expect((await provider.search('', { use: 'filter' })).map((e) => e.id)).toEqual(['fake.invert', 'fake.tint']);
		expect((await provider.describe('fake.echo')).inputs).toEqual([]);
	});

	it('timingLength stretches, holds or keeps the footage', () => {
		expect(provider.timingLength!('fake.speed', 3000)).toBe(6000);
		expect(provider.timingLength!('fake.speed', 3000, { speed: 2 })).toBe(1500);
		expect(provider.timingLength!('fake.freeze', 3000, { hold: 500 })).toBe(3500);
		expect(provider.timingLength!('fake.echo', 3000)).toBe(3000);
	});

	it('a slowed frame blends the two footage frames either side by nearness', () => {
		expect(close(provider.timingSample!('fake.speed', at(100)))).toEqual([
			[33.333, 0.5],
			[66.667, 0.5]
		]);
		// On a frame, only that frame (the zero-weight neighbour is dropped).
		expect(provider.timingSample!('fake.speed', at(0))).toEqual({ frames: [{ time: 0, weight: 1 }], blend: 'average' });
		// Without blending, the frame it lands in.
		expect(close(provider.timingSample!('fake.speed', at(100), { smooth: false }))).toEqual([[33.333, 1]]);
	});

	it('a sped-up frame averages the frames it passes over', () => {
		expect(close(provider.timingSample!('fake.speed', at(100), { speed: 2 }))).toEqual([
			[200, 0.5],
			[233.333, 0.5]
		]);
	});

	it('frames are held within the footage and snapped to frame starts at its fps', () => {
		const last = provider.timingSample!('fake.speed', at(99999));
		expect(close(last)).toEqual([[2966.667, 1]]);
		expect(provider.timingSample!('fake.speed', at(-500))).toEqual({ frames: [{ time: 0, weight: 1 }], blend: 'average' });
		// 24 fps footage: frames every 41.667 ms; 1 s of it has frames 0–23.
		const s = provider.timingSample!('fake.speed', at(5000, 1000, 24), { smooth: false });
		expect(close(s)).toEqual([[958.333, 1]]);
		for (const f of provider.timingSample!('fake.speed', at(130, 1000, 24)).frames) expect(((f.time * 24) / 1000) % 1).toBeCloseTo(0, 9);
	});

	it('a freeze holds its frame, then plays on from where it stopped', () => {
		expect(close(provider.timingSample!('fake.freeze', at(1400)))).toEqual([[1400, 1]]);
		expect(close(provider.timingSample!('fake.freeze', at(2000)))).toEqual([[1500, 1]]);
		expect(close(provider.timingSample!('fake.freeze', at(2600)))).toEqual([[1600, 1]]);
	});

	it('an echo weights earlier frames less, earliest first, adding up to 1', () => {
		const s = provider.timingSample!('fake.echo', at(1000));
		expect(s.blend).toBe('average');
		expect(close(s)).toEqual([
			[700, 0.0667],
			[800, 0.1333],
			[900, 0.2667],
			[1000, 0.5333]
		]);
		expect(s.frames.reduce((sum, f) => sum + f.weight, 0)).toBeCloseTo(1, 12);
		expect(provider.timingSample!('fake.echo', at(1000), { lighten: true }).blend).toBe('lighten');
		// Echoes from before the footage are left out.
		expect(close(provider.timingSample!('fake.echo', at(50)))).toEqual([[33.333, 1]]);
	});

	it('is synchronous and pure', () => {
		expect(provider.timingSample!('fake.echo', at(1234))).toEqual(provider.timingSample!('fake.echo', at(1234)));
		expect(provider.timingSample!('fake.echo', at(1234))).not.toBeInstanceOf(Promise);
	});

	it('fails with typed errors whose sentences name what is valid', () => {
		expect(() => provider.timingSample!('nope', at(0))).toThrow(UnknownEffectError);
		expect(() => provider.timingLength!('nope', 1000)).toThrow(UnknownEffectError);
		expect(() => provider.timingSample!('fake.speed', at(0), { speed: 20 })).toThrow(EffectControlError);
		expect(() => provider.timingLength!('fake.tint', 1000)).toThrow(/"fake.tint" is a shader effect, not a timing effect; the timing effects are "fake.speed", "fake.freeze", "fake.echo"/);
		expect(() => provider.timingSample!('fake.glide', at(0))).toThrow(/is a camera effect, not a timing effect/);
		expect(() => provider.timingLength!('fake.speed', 0)).toThrow(/footage's length is a number of ms above 0; it was 0/);
		expect(() => provider.timingSample!('fake.speed', at(0, 1000, 500))).toThrow(/frame rate is above 0 and at most 240 frames per second; it was 500/);
		expect(() => provider.timingSample!('fake.speed', at(Number.NaN))).toThrow(EffectUnsupportedError);
	});

	it('createRenderer refuses a timing effect with a sentence', () => {
		expect(() => provider.createRenderer('fake.speed', { width: 8, height: 8 })).toThrow(/retimes video footage and draws no pixels of its own\. Use timingSample/);
	});
});

describe('timing effects: helpers', () => {
	it('normaliseTimingSample snaps, holds, merges, sorts and scales to 1', () => {
		const s = normaliseTimingSample(
			[
				{ time: 70, weight: 1 },
				{ time: 40, weight: 1 },
				{ time: 35, weight: 2 },
				{ time: -10, weight: 1 },
				{ time: 5000, weight: 1 },
				{ time: 100, weight: 0 },
				{ time: Number.NaN, weight: 1 }
			],
			at(0, 1000)
		);
		expect(close(s)).toEqual([
			[0, 0.1667],
			[33.333, 0.5],
			[66.667, 0.1667],
			[966.667, 0.1667]
		]);
		expect(s.blend).toBe('average');
		expect(timingSampleProblems(s, at(0, 1000))).toEqual([]);
	});

	it('normaliseTimingSample falls back to the frame at the time, and spaces long exposures evenly', () => {
		expect(normaliseTimingSample([], at(100, 1000)).frames).toEqual([{ time: 3 * F, weight: 1 }]);
		const long = normaliseTimingSample(
			Array.from({ length: 300 }, (_, i) => ({ time: i * F, weight: 1 })),
			at(0, 10000),
			'lighten'
		);
		expect(long.frames).toHaveLength(TIMING_MAX_FRAMES);
		expect(long.frames[0].time).toBe(0);
		expect(long.blend).toBe('lighten');
		expect(timingSampleProblems(long, at(0, 10000))).toEqual([]);
	});

	it('timingSampleProblems names every broken rule', () => {
		const request = at(0, 1000);
		expect(timingSampleProblems(null, request)).toEqual(['the sample is not an object { frames, blend }']);
		expect(timingSampleProblems({ frames: [], blend: 'average' }, request)).toEqual(['frames must be a list of at least one { time, weight }']);
		expect(
			timingSampleProblems(
				{
					blend: 'screen',
					frames: [
						{ time: 50, weight: 0.5 },
						{ time: 2000, weight: 0.5 },
						{ time: 0, weight: 0.5 }
					]
				},
				request
			)
		).toEqual([
			'blend "screen" is not one of average, lighten',
			'frame time 50 is not the start of a frame at 30 fps (index × 33.333333 ms)',
			'frame time 2000 is outside the footage (frames 0 to 29, the last at 966.666667 ms)',
			'frame times must be distinct and earliest first; 0 follows 2000',
			'weights add up to 1.5, not 1'
		]);
		const many = { blend: 'average', frames: Array.from({ length: 129 }, (_, i) => ({ time: i * F, weight: 1 / 129 })) };
		expect(timingSampleProblems(many, at(0, 10000))).toEqual([`it has 129 frames; at most ${TIMING_MAX_FRAMES} are allowed`]);
	});

	it('effectOffered offers timing effects only where the timing use is asked for', () => {
		const timing = { kind: 'timing' as const, uses: ['timing' as const] };
		expect(effectOffered(timing)).toBe(false);
		expect(effectOffered(timing, ['filter', 'overlay'])).toBe(false);
		expect(effectOffered(timing, ['camera'])).toBe(false);
		expect(effectOffered(timing, ['timing'])).toBe(true);
		expect(effectOffered({ kind: 'shader', uses: ['filter'] }, ['timing'])).toBe(false);
	});
});

describe('timing effects: blendTimingFrames', () => {
	const px = (...rgba: number[]): EffectPixels => {
		const p = createEffectPixels(rgba.length / 4, 1);
		p.data.set(rgba);
		return p;
	};

	it('average is a weighted mean in premultiplied alpha, so transparency does not darken', () => {
		const out = blendTimingFrames(
			[
				{ pixels: px(255, 0, 0, 255), weight: 0.5 },
				{ pixels: px(0, 0, 0, 0), weight: 0.5 }
			],
			'average'
		);
		expect([...out.data]).toEqual([255, 0, 0, 128]);
		const mix = blendTimingFrames(
			[
				{ pixels: px(255, 0, 0, 255), weight: 0.75 },
				{ pixels: px(0, 0, 255, 255), weight: 0.25 }
			],
			'average'
		);
		expect([...mix.data]).toEqual([191, 0, 64, 255]);
	});

	it('lighten keeps each channel\'s brightest, each frame scaled by its weight against the heaviest', () => {
		const out = blendTimingFrames(
			[
				{ pixels: px(200, 0, 0, 255), weight: 0.6 },
				{ pixels: px(0, 100, 0, 255), weight: 0.3 }
			],
			'lighten'
		);
		expect([...out.data]).toEqual([200, 50, 0, 255]);
	});

	it('a single frame is shown as it is, and the result can go into a given picture', () => {
		const target = createEffectPixels(1, 1);
		const out = blendTimingFrames([{ pixels: px(10, 20, 30, 40), weight: 1 }], 'lighten', target);
		expect(out).toBe(target);
		expect([...out.data]).toEqual([10, 20, 30, 40]);
	});

	it('refuses no frames and frames of different sizes', () => {
		expect(() => blendTimingFrames([], 'average')).toThrow(/no frames to blend/);
		expect(() => blendTimingFrames([{ pixels: px(0, 0, 0, 0), weight: 1 }, { pixels: px(0, 0, 0, 0, 0, 0, 0, 0), weight: 1 }], 'average')).toThrow(/A 2×1 frame cannot be blended with 1×1 frames/);
		expect(() => blendTimingFrames([{ pixels: px(0, 0, 0, 0), weight: 1 }], 'average', createEffectPixels(2, 2))).toThrow(/The output is 2×2/);
	});
});

describe('timing effects: the conformance check catches broken providers', () => {
	const good = createFakeEffectProvider({ timing: true });
	const messages = async (p: EffectProvider) => (await checkEffectProvider(p)).map((i) => `${i.effectId ?? ''}: ${i.message}`);

	it('timing effects listed without supportsTiming, and supportsTiming without its methods', async () => {
		const { timingSample: _s, ...rest } = good;
		expect(await messages({ ...good, capabilities: { ...good.capabilities, supportsTiming: false } })).toContain(': the catalog lists timing effects but capabilities.supportsTiming is not set');
		expect(await messages(rest as EffectProvider)).toContain(': supportsTiming is set but timingSample is missing');
	});

	it('a timing effect with a pixel use, a duration or inputs', async () => {
		const edit = (change: (d: EffectDescription) => EffectDescription): EffectProvider => {
			const fix = (d: EffectDescription) => (d.id === 'fake.echo' ? change(d) : d);
			return {
				...good,
				list: async (o) => (await Promise.all((await good.list(o)).map((e) => good.describe(e.id)))).map(fix),
				search: async (q, o) => (await Promise.all((await good.search(q, o)).map((e) => good.describe(e.id)))).map(fix),
				describe: async (id) => fix(await good.describe(id))
			};
		};
		expect(await messages(edit((d) => ({ ...d, uses: ['overlay'] })))).toContain('fake.echo: a timing effect must have exactly the use "timing"');
		expect(await messages(edit((d) => ({ ...d, duration: 1000 })))).toContain('fake.echo: a timing effect has no duration: its length depends on its footage (timingLength)');
		expect(await messages(edit((d) => ({ ...d, inputs: [{ name: 'source', kind: 'image', description: 'Footage.', required: true }] })))).toContain('fake.echo: a timing effect takes no inputs: the host decodes its footage');
		expect(await messages(edit((d) => ({ ...d, kind: 'shader', uses: ['timing'] })))).toContain('fake.echo: only timing effects may have the use "timing"');
	});

	it('samples that are not normalised, impure, or async', async () => {
		const raw: EffectProvider = { ...good, timingSample: (id, r, v) => (id === 'fake.echo' ? { blend: 'average', frames: [{ time: r.time, weight: 2 }] } : good.timingSample!(id, r, v)) };
		expect(await messages(raw)).toEqual(expect.arrayContaining([expect.stringMatching(/^fake\.echo: timingSample at 750 ms of 3000 ms footage: frame time 750 is not the start of a frame/), expect.stringMatching(/weights add up to 2, not 1$/)]));

		let calls = 0;
		const impure: EffectProvider = { ...good, timingSample: (id, r, v) => ({ ...good.timingSample!(id, r, v), blend: calls++ % 2 ? 'lighten' : 'average' }) };
		expect(await messages(impure)).toContain('fake.speed: timingSample is not pure: two calls at 0 ms gave different samples');

		const asynchronous: EffectProvider = { ...good, timingLength: ((id: string, ms: number) => Promise.resolve(good.timingLength!(id, ms))) as never };
		expect(await messages(asynchronous)).toContain('fake.speed: timingLength must be synchronous; it returned a Promise');

		const zero: EffectProvider = { ...good, timingLength: () => 0 };
		expect(await messages(zero)).toContain('fake.speed: timingLength for 3000 ms of footage is 0; it must be a number of ms > 0');
	});

	it('refusals that are missing or untyped', async () => {
		const loose: EffectProvider = { ...good, timingSample: (id, r) => good.timingSample!(id, r) };
		expect(await messages(loose)).toContain('fake.speed: timingSample with an unknown control did not fail (expected invalid_values)');

		const anyKind: EffectProvider = { ...good, timingLength: (id, ms, v) => (id === 'fake.invert' ? ms : good.timingLength!(id, ms, v)) };
		expect(await messages(anyKind)).toContain('fake.invert: timingLength of a shader effect did not fail (expected unsupported)');

		const untyped: EffectProvider = {
			...good,
			timingSample: (id, r, v) => {
				if (id === '__no_such_effect__') throw new Error('nope');
				if (r.fps === 0) return { blend: 'average', frames: [{ time: 0, weight: 1 }] };
				return good.timingSample!(id, r, v);
			}
		};
		expect(await messages(untyped)).toEqual(
			expect.arrayContaining([': timingSample of an unknown id failed with untyped Error: nope (expected unknown_effect)', 'fake.speed: timingSample at 0 fps did not fail (expected unsupported)'])
		);
	});
});

describe('timing effects: agent tools', () => {
	const setup = () => {
		const controller = new VideoEditorController({
			project: parseVideoProject({ version: 1, width: 4, height: 2, fps: 10, assets: [], tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'a', type: 'color', color: '#000000', start: 0, duration: 1000 }] }] }),
			effects: createFakeEffectProvider({ timing: true })
		});
		const registry = new ToolRegistry();
		registry.register(createVideoEffectsToolProvider(controller));
		const tool = (name: string) => registry.listTools().tools.find((t) => baseToolName(t.name) === name)!;
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const r = await registry.callTool(tool(name).name, args);
			if (r.isError) throw new Error((r.content[0] as { text: string }).text);
			return r.structuredContent as any;
		};
		return { tool, call };
	};

	it('search_effects finds timing effects by kind and use', async () => {
		const { call, tool } = setup();
		const schema = (tool('search_effects').inputSchema as any).properties;
		expect(schema.kind.enum).toContain('timing');
		expect(schema.use.enum).toContain('timing');
		expect((await call('search_effects', { kind: 'timing' })).effects.map((e: any) => [e.id, e.kind, e.duration])).toEqual([
			['fake.speed', 'timing', undefined],
			['fake.freeze', 'timing', undefined],
			['fake.echo', 'timing', undefined]
		]);
		expect((await call('search_effects', { use: 'timing' })).total).toBe(3);
	});

	it('describe_effect says a timing effect does not apply as a clip effect, and apply_effect never offers one', async () => {
		const { call, tool } = setup();
		expect(await call('describe_effect', { effect: 'fake.speed' })).toMatchObject({ kind: 'timing', uses: ['timing'], appliesHere: false });
		await new Promise((r) => setTimeout(r, 0));
		const ids: string[] = (tool('apply_effect').inputSchema as any).properties.effect.enum;
		expect(ids).toContain('fake.tint');
		expect(ids.some((id) => id.startsWith('fake.speed') || id === 'fake.freeze' || id === 'fake.echo')).toBe(false);
	});
});
