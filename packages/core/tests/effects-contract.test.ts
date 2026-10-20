import { describe, expect, it, vi } from 'vitest';
import {
	EffectControlError,
	EffectsSlot,
	NoEffectsProviderError,
	UnknownEffectError,
	applyEffectMask,
	checkEffectProvider,
	createEffectPixels,
	createFakeEffectProvider,
	isEffectError,
	resolveEffectValues,
	searchEffectSummaries,
	type EffectPixels,
	type EffectProvider
} from '../src/effects';

const solid = (w: number, h: number, rgba: [number, number, number, number]): EffectPixels => {
	const p = createEffectPixels(w, h);
	for (let i = 0; i < p.data.length; i += 4) p.data.set(rgba, i);
	return p;
};

describe('effects contract: fake provider', () => {
	const provider = createFakeEffectProvider();

	it('conforms to the contract', async () => {
		expect(await checkEffectProvider(provider)).toEqual([]);
	});

	it('lists and searches with filters', async () => {
		const all = await provider.list();
		expect(all.map((e) => e.id)).toEqual(['fake.invert', 'fake.tint', 'fake.gradient', 'fake.bar', 'fake.crossfade', 'fake.fade-in']);
		expect((await provider.search('', { use: 'transition' })).map((e) => e.id)).toEqual(['fake.crossfade']);
		expect((await provider.search('tint')).map((e) => e.id)).toEqual(['fake.tint']);
		expect((await provider.search('colour', { use: 'filter' })).map((e) => e.id)).toEqual(['fake.invert', 'fake.tint']);
		expect(await provider.list({ use: 'generator', limit: 5 })).toHaveLength(1);
		expect(await provider.search('nothing matches this')).toEqual([]);
	});

	it('describes effects with strict, described control schemas', async () => {
		const d = await provider.describe('fake.tint');
		expect(d.controls.additionalProperties).toBe(false);
		expect(Object.keys(d.controls.properties)).toEqual(['color', 'amount']);
		expect(d.defaults).toEqual({ color: '#ff8800', amount: 0.5 });
		expect(d.inputs.map((i) => i.name)).toEqual(['source']);
		// describe returns a copy: editing it does not change the provider.
		(d.defaults as Record<string, unknown>).amount = 9;
		expect((await provider.describe('fake.tint')).defaults.amount).toBe(0.5);
	});

	it('throws typed errors for unknown ids', async () => {
		expect(() => provider.describe('nope')).toThrow(UnknownEffectError);
		try {
			provider.describe('nope');
		} catch (e) {
			expect(isEffectError(e) && e.code).toBe('unknown_effect');
			expect((e as Error).message).toMatch(/search_effects/);
		}
	});

	it('validates values against the control schema on render', async () => {
		const r = await provider.createRenderer('fake.tint', { width: 2, height: 2 });
		const source = solid(2, 2, [0, 0, 0, 255]);
		await expect(r.render({ time: 0, inputs: { source }, values: { amount: 2 } })).rejects.toBeInstanceOf(EffectControlError);
		await expect(r.render({ time: 0, inputs: { source }, values: { colour: '#ffffff' } })).rejects.toThrow(/colour/);
		await expect(r.render({ time: 0, inputs: { source }, values: { color: 'red' } })).rejects.toThrow(/color/);
		const out = await r.render({ time: 0, inputs: { source }, values: { color: '#ffffff', amount: 1 } });
		expect([...out.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
	});

	it('renders filters, generators, titles and transitions deterministically', async () => {
		const inv = await provider.createRenderer('fake.invert', { width: 1, height: 1 });
		expect([...(await inv.render({ time: 0, inputs: { source: solid(1, 1, [10, 20, 30, 200]) } })).data]).toEqual([245, 235, 225, 200]);

		const grad = await provider.createRenderer('fake.gradient', { width: 1, height: 4 });
		const g = (await grad.render({ time: 0, values: { from: '#000000', to: '#ffffff', angle: 90 } })).data;
		expect(g[0]).toBeLessThan(g[4]);
		expect(g[4]).toBeLessThan(g[12]);

		const bar = await provider.createRenderer('fake.bar', { width: 10, height: 10 });
		expect((await bar.render({ time: 0 })).data.some((v) => v !== 0)).toBe(false);
		const shown = await bar.render({ time: 2000 });
		expect(shown.data[(7 * 10 + 0) * 4 + 3]).toBe(255);
		expect(shown.data[(1 * 10 + 0) * 4 + 3]).toBe(0);

		const x = await provider.createRenderer('fake.crossfade', { width: 1, height: 1 });
		const inputs = { from: solid(1, 1, [0, 0, 0, 255]), to: solid(1, 1, [200, 200, 200, 255]) };
		expect((await x.render({ time: 0, inputs, progress: 0.5, values: { curve: 'linear' } })).data[0]).toBe(100);
		expect((await x.render({ time: 1000, inputs })).data[0]).toBe(200);
	});

	it('returns linear float pixels for deep renderers', async () => {
		const r = await provider.createRenderer('fake.invert', { width: 1, height: 1, depth: 32 });
		const out = await r.render({ time: 0, inputs: { source: solid(1, 1, [0, 0, 0, 255]) } });
		expect(out.float).toBeInstanceOf(Float32Array);
		expect(out.float![0]).toBeCloseTo(1);
		expect(out.float![3]).toBeCloseTo(1);
		const shallow = createFakeEffectProvider({ capabilities: { supportsFloat: false } });
		const r8 = await shallow.createRenderer('fake.invert', { width: 1, height: 1, depth: 32 });
		expect((await r8.render({ time: 0, inputs: { source: solid(1, 1, [0, 0, 0, 255]) } })).float).toBeUndefined();
	});

	it('applies masks to filters', async () => {
		const r = await provider.createRenderer('fake.invert', { width: 2, height: 1 });
		const mask = createEffectPixels(2, 1);
		mask.data[3] = 255;
		const out = await r.render({ time: 0, inputs: { source: solid(2, 1, [0, 0, 0, 255]) }, mask });
		expect([...out.data]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]);
	});

	it('refuses wrong inputs, sizes, motion renders and use after dispose', async () => {
		const r = await provider.createRenderer('fake.invert', { width: 2, height: 2 });
		await expect(r.render({ time: 0 })).rejects.toThrow(/needs an input named "source"/);
		await expect(r.render({ time: 0, inputs: { source: solid(1, 1, [0, 0, 0, 0]) } })).rejects.toThrow(/1×1/);
		await expect(r.render({ time: -1, inputs: { source: solid(2, 2, [0, 0, 0, 0]) } })).rejects.toThrow(/time/);
		r.dispose();
		await expect(r.render({ time: 0 })).rejects.toMatchObject({ code: 'disposed' });
		expect(() => provider.createRenderer('fake.fade-in', { width: 1, height: 1 })).toThrow(/applyVectorEffect/);
		expect(() => provider.createRenderer('fake.invert', { width: 0, height: 1 })).toThrow(/size/);
	});

	it('applies vector motion to SVG targets', async () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect id="a"/><rect id="b"/></svg>';
		const m = await provider.applyVectorEffect!('fake.fade-in', svg, { ms: 300, stagger: 100 });
		expect(m.svg).toBe(svg);
		expect(m.animate).toEqual([
			{ id: 'a', delay: 0, ms: 300, attrs: { opacity: [0, 1] } },
			{ id: 'b', delay: 100, ms: 300, attrs: { opacity: [0, 1] } }
		]);
		expect(m.duration).toBe(400);
		const one = await provider.applyVectorEffect!('fake.fade-in', { svg, nodeIds: ['b'] });
		expect(one.animate!.map((a) => a.id)).toEqual(['b']);
		expect(() => provider.applyVectorEffect!('fake.tint', svg)).toThrow(/not a vector/);
		expect(() => provider.applyVectorEffect!('fake.fade-in', svg, { ms: -1 })).toThrow(EffectControlError);
	});

	it('reports render calls', async () => {
		const onRender = vi.fn();
		const p = createFakeEffectProvider({ onRender });
		const r = await p.createRenderer('fake.gradient', { width: 1, height: 1 });
		await r.render({ time: 5 });
		expect(onRender).toHaveBeenCalledWith('fake.gradient', { time: 5 });
	});
});

describe('effects contract: helpers', () => {
	it('resolveEffectValues merges defaults and names every bad control', async () => {
		const d = await createFakeEffectProvider().describe('fake.gradient');
		expect(resolveEffectValues(d, { angle: 0 })).toEqual({ from: '#1e3a8a', to: '#f472b6', angle: 0, spin: 0 });
		try {
			resolveEffectValues(d, { angle: 400, nope: 1 });
			throw new Error('should fail');
		} catch (e) {
			expect(e).toBeInstanceOf(EffectControlError);
			expect((e as EffectControlError).details.map((x) => x.path).sort()).toEqual(['/angle', '/nope']);
		}
	});

	it('searchEffectSummaries ranks name matches first and keeps order otherwise', () => {
		const base = { kind: 'shader' as const, uses: ['filter' as const], transparent: false, loop: false };
		const catalog = [
			{ ...base, id: 'a', name: 'Alpha', category: 'glow', description: 'a soft glow' },
			{ ...base, id: 'b', name: 'Glow', category: 'light' }
		];
		expect(searchEffectSummaries(catalog, 'glow').map((e) => e.id)).toEqual(['b', 'a']);
		expect(searchEffectSummaries(catalog, '', { category: 'glow' }).map((e) => e.id)).toEqual(['a']);
	});

	it('applyEffectMask blends filters with their source and fades generators', () => {
		const result = solid(2, 1, [200, 200, 200, 255]);
		const source = solid(2, 1, [0, 0, 0, 255]);
		const mask = createEffectPixels(2, 1);
		mask.data[3] = 255;
		mask.data[7] = 128;
		applyEffectMask(result, mask, source);
		expect([...result.data]).toEqual([200, 200, 200, 255, 100, 100, 100, 255]);
		const gen = solid(1, 1, [9, 9, 9, 255]);
		applyEffectMask(gen, createEffectPixels(1, 1));
		expect(gen.data[3]).toBe(0);
	});

	it('EffectsSlot sets, clears and notifies', () => {
		const slot = new EffectsSlot();
		const seen: (EffectProvider | null)[] = [];
		slot.subscribe((p) => seen.push(p));
		expect(() => slot.require()).toThrow(NoEffectsProviderError);
		const p = createFakeEffectProvider();
		const release = slot.use(p);
		expect(slot.require()).toBe(p);
		slot.set(p);
		release();
		expect(slot.provider).toBeNull();
		expect(seen).toEqual([p, null]);
	});
});

describe('effects contract: conformance check catches broken providers', () => {
	it('accepts unsupported from vector renderers and from the vector probe', async () => {
		const good = createFakeEffectProvider();
		const { EffectUnsupportedError } = await import('../src/effects');
		const d = { ...(await good.describe('fake.fade-in')), id: 'v', kind: 'vector' as const };
		const p: EffectProvider = {
			...good,
			list: () => [d],
			search: () => [d],
			describe: (id) => (id === 'v' ? d : good.describe(id)),
			createRenderer: (id, o) => {
				if (id === 'v') throw new EffectUnsupportedError('Needs rasterizeSvg in a Worker.', id);
				return good.createRenderer(id, o);
			},
			applyVectorEffect: (id, target, values) => {
				if (values && '__not_a_control__' in values) return good.applyVectorEffect!('fake.fade-in', target, values);
				throw new EffectUnsupportedError('Needs a path element.', id);
			}
		};
		expect(await checkEffectProvider(p)).toEqual([]);
	});

	it('reports loose schemas, missing descriptions, bad defaults and untyped errors', async () => {
		const good = createFakeEffectProvider();
		const broken: EffectProvider = {
			...good,
			id: 'broken',
			capabilities: { ...good.capabilities, supportsVector: false },
			list: () => [{ id: 'x', name: 'X', kind: 'shader', category: 'c', uses: ['generator'], transparent: false, loop: false }],
			search: () => [],
			describe: (id) => {
				if (id !== 'x') throw new Error('nope');
				return {
					id: 'x',
					name: 'X',
					kind: 'shader',
					category: 'c',
					uses: ['generator'],
					transparent: false,
					loop: false,
					controls: { type: 'object', properties: { size: { type: 'number', maximum: 1 } } } as never,
					defaults: { size: 5 },
					presets: [],
					inputs: []
				};
			},
			createRenderer: (id) => {
				if (id !== 'x') throw new Error('nope');
				return {
					effectId: 'x',
					width: 1,
					height: 1,
					depth: 8,
					render: async () => createEffectPixels(1, 1),
					dispose: () => {}
				};
			}
		};
		const messages = (await checkEffectProvider(broken)).map((i) => i.message);
		expect(messages).toEqual(
			expect.arrayContaining([
				'search("") returned 0 effects, list() 1',
				expect.stringMatching(/describe of an unknown id failed with untyped Error/),
				'controls must set additionalProperties: false',
				'control "size" has no description',
				expect.stringMatching(/^default \/size:/),
				'render returned 1×1, not 8×8',
				'render with an unknown control did not fail (expected invalid_values)',
				'render after dispose did not fail (expected disposed)'
			])
		);
	});
});
