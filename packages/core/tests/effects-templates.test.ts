import { describe, expect, it } from 'vitest';
import {
	checkEffectProvider,
	checkEffectSequence,
	checkTemplateValues,
	createFakeEffectProvider,
	effectLayerInput,
	effectLayerRole,
	effectSequenceEffects,
	isEffectError,
	searchTemplateSummaries,
	templateDefaultValues,
	templateSlotSummary,
	templateValuesSchema,
	UnknownTemplateError,
	type EffectProvider,
	type EffectTemplateResult,
	type EffectTemplateSlot
} from '../src/effects';
import { validateJsonSchema } from '../src/tools/schema';

const provider = createFakeEffectProvider({ templates: true });
const okResult = (r: EffectTemplateResult) => {
	if (!r.ok) throw new Error(r.errors.join(' '));
	return r;
};

describe('effects contract: templates on the fake provider', () => {
	it('conforms to the contract, templates included', async () => {
		expect(provider.capabilities.supportsTemplates).toBe(true);
		expect(await checkEffectProvider(provider)).toEqual([]);
	});

	it('has no template methods without the option', () => {
		const plain = createFakeEffectProvider();
		expect(plain.capabilities.supportsTemplates).toBeUndefined();
		expect(plain.listTemplates).toBeUndefined();
	});

	it('lists and searches templates', async () => {
		expect((await provider.listTemplates!()).map((t) => t.id)).toEqual(['fake.title-sequence', 'fake.picture-reveal']);
		expect((await provider.listTemplates!({ query: 'reveal' })).map((t) => t.id)).toEqual(['fake.picture-reveal']);
		expect((await provider.listTemplates!({ tags: ['Intro'] })).map((t) => t.id)).toEqual(['fake.title-sequence']);
		expect(await provider.listTemplates!({ limit: 1 })).toHaveLength(1);
	});

	it('describes slots shaped for a form, without subject defaults', async () => {
		const d = await provider.describeTemplate!('fake.picture-reveal');
		expect(d.slots.map((s) => [s.name, s.type])).toEqual([
			['picture', 'image'],
			['logo', 'image'],
			['caption', 'text'],
			['holdMs', 'number']
		]);
		expect(d.slots[0]).toMatchObject({ hasDefault: true });
		expect(d.slots[0]).not.toHaveProperty('default');
		expect(d.slots[1]).toMatchObject({ hasDefault: false });
	});

	it('throws UnknownTemplateError for unknown ids', async () => {
		expect(() => provider.describeTemplate!('nope')).toThrow(UnknownTemplateError);
		try {
			await provider.instantiateTemplate!('nope');
		} catch (e) {
			expect(isEffectError(e) && e.code).toBe('unknown_template');
			expect((e as Error).message).toContain('list_templates');
		}
	});

	it('fills a template with its defaults, typed values and subject slots', async () => {
		const r = okResult(await provider.instantiateTemplate!('fake.title-sequence', { title: 'Launch day', accent: '#ff0000', holdMs: 1500 }));
		expect(r.sequence.shots[0]).toMatchObject({ hold: 1500, title: 'Launch day' });
		expect(r.sequence.shots[0].layers[0].values).toEqual({ from: '#ff0000' });
		expect(r.sequence.shots[1]).toMatchObject({ caption: 'See you soon', transition: { effect: 'fake.crossfade', ms: 600 } });
		expect(r.openSlots).toEqual([]);
		expect(effectSequenceEffects(r.sequence)).toEqual(['fake.gradient', 'fake.bar', 'fake.crossfade']);

		const reveal = okResult(await provider.instantiateTemplate!('fake.picture-reveal', { picture: 'https://example.com/p.png' }, { name: 'my-reveal' }));
		expect(reveal.sequence.name).toBe('my-reveal');
		expect(reveal.sequence.shots[0].layers[0].subject).toEqual({ image: 'https://example.com/p.png' });
		expect(reveal.sequence.shots[1].layers[1].subject).toEqual({ slot: 'logo' });
		expect(reveal.openSlots).toEqual(['logo']);

		const svg = okResult(await provider.instantiateTemplate!('fake.picture-reveal', { picture: '<svg xmlns="http://www.w3.org/2000/svg"/>', logo: { slot: 'brand' } }));
		expect(svg.sequence.shots[0].layers[0].subject).toEqual({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
		expect(svg.openSlots).toEqual(['brand']);
	});

	it('refuses every bad value at once, with sentences, and never in part', async () => {
		const r = await provider.instantiateTemplate!('fake.title-sequence', { titel: 'x', accent: 'red', holdMs: 20, title: 'x'.repeat(41) });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.errors).toHaveLength(4);
		expect(r.errors[0]).toMatch(/There is no slot "titel"; the slots are title \(text\)/);
		expect(r.errors.join(' ')).toContain('Slot "accent" takes a colour written #RRGGBB');
		expect(r.errors.join(' ')).toContain('Slot "holdMs" takes a whole number from 500 to 10000; 20 is out of range.');
		expect(r.errors.join(' ')).toContain('takes up to 40 characters');
		const name = await provider.instantiateTemplate!('fake.title-sequence', {}, { name: 'Not A Name' });
		expect(name.ok).toBe(false);
	});
});

describe('template helpers', () => {
	const slots: EffectTemplateSlot[] = [
		{ name: 'headline', type: 'text', label: 'Headline', default: 'Hi', maxLength: 10 },
		{ name: 'tint', type: 'color', label: 'Tint', default: '#112233' },
		{ name: 'count', type: 'number', label: 'Count', default: 3, min: 1, max: 9, integer: true },
		{ name: 'photo', type: 'image', label: 'Photo', hasDefault: false }
	];

	it('builds a strict values schema the validator enforces', () => {
		const schema = templateValuesSchema(slots);
		expect(schema.additionalProperties).toBe(false);
		expect(validateJsonSchema({ headline: 'Short', tint: '#aabbcc', count: 2, photo: 'https://x/y.png' }, schema)).toEqual([]);
		expect(validateJsonSchema({ photo: { image: 'a.png' } }, schema)).toEqual([]);
		expect(validateJsonSchema({ photo: { svg: '<svg/>' } }, schema)).toEqual([]);
		expect(validateJsonSchema({ photo: { slot: 'p' } }, schema)).toEqual([]);
		expect(validateJsonSchema({ count: 2.5 }, schema).length).toBeGreaterThan(0);
		expect(validateJsonSchema({ tint: 'red' }, schema).length).toBeGreaterThan(0);
		expect(validateJsonSchema({ extra: 1 }, schema).length).toBeGreaterThan(0);
		for (const p of Object.values(schema.properties!)) expect(typeof (p as { description?: string }).description).toBe('string');
	});

	it('checks values with sentences naming what each slot takes', () => {
		expect(checkTemplateValues(slots, { headline: 'ok', count: 4 })).toEqual([]);
		expect(checkTemplateValues(slots, 'nope')).toEqual(['Values are an object of slot names to values; the slots are headline (text), tint (color), count (number), photo (image).']);
		expect(checkTemplateValues(slots, { count: 2.5 })).toEqual(['Slot "count" takes a whole number from 1 to 9; 2.5 is not whole.']);
		expect(checkTemplateValues(slots, { photo: { video: 'v.mp4' } })).toEqual(['Slot "photo" takes { "image": … } or { "svg": … }, not { "video": … }.']);
		expect(checkTemplateValues(slots, { photo: 3 })[0]).toContain('(or { "slot": "photo" } to leave it for the host)');
	});

	it('gives default values and one-line summaries', () => {
		expect(templateDefaultValues(slots)).toEqual({ headline: 'Hi', tint: '#112233', count: 3 });
		expect(templateSlotSummary(slots[3])).toBe('photo (image): Photo; takes a picture: a URL, a data: URL or <svg> markup; the host fills it when none is given.');
	});

	it('searches template summaries by words and tags', () => {
		const list = [
			{ id: 'a', name: 'Product reveal', description: 'x', tags: ['promo'], shots: 1 },
			{ id: 'b', name: 'Stat', description: 'a product number', shots: 1 }
		];
		expect(searchTemplateSummaries(list, { query: 'product' }).map((t) => t.id)).toEqual(['a', 'b']);
		expect(searchTemplateSummaries(list, { tags: ['promo'] }).map((t) => t.id)).toEqual(['a']);
	});

	it('finds the input a layer subject feeds and a layer role', async () => {
		expect(effectLayerInput(await provider.describe('fake.tint'))).toBe('source');
		expect(effectLayerInput(await provider.describe('fake.gradient'))).toBeUndefined();
		expect(effectLayerInput(await provider.describe('fake.crossfade'))).toBeUndefined();
		expect(effectLayerRole({})).toBe('background');
		expect(effectLayerRole({ rect: { x: 0, y: 0, width: 1, height: 1 } })).toBe('subject');
		expect(effectLayerRole({ role: 'overlay' })).toBe('overlay');
	});

	it('checks a sequence against a catalog', async () => {
		const catalog = await provider.list();
		const problems = checkEffectSequence(
			{
				name: 's',
				stage: { width: 100, height: 100 },
				shots: [
					{ hold: 100, layers: [{ effect: 'fake.crossfade' }, {}], transition: { effect: 'fake.crossfade' } },
					{ hold: 100, layers: [{ effect: 'nope', opacity: 2, until: { shots: 0 } }], transition: { effect: 'fake.tint' } }
				]
			},
			catalog
		);
		expect(problems).toEqual([
			'shot 1, layer 1: "fake.crossfade" (shader, transition) cannot be a layer; a layer\'s effect is a generator, filter, overlay or title.',
			'shot 1, layer 2 has neither an effect nor a subject.',
			'shot 1 has a transition, but there is no shot before it.',
			'shot 2, layer 1: the provider has no effect "nope".',
			'shot 2, layer 1: until is ms ≥ 0 or { shots: n } with n ≥ 1.',
			'shot 2, layer 1: opacity is 0–1.',
			'shot 2: "fake.tint" is not a transition (its uses are filter).'
		]);
		expect(checkEffectSequence({ name: 's', stage: { width: 1, height: 1 }, shots: [] })).toEqual(['The sequence needs at least one shot.']);
	});
});

describe('conformance catches broken template providers', () => {
	const good = createFakeEffectProvider({ templates: true });

	it('flags a missing method and an unflagged one', async () => {
		const { listTemplates: _l, ...rest } = good;
		expect((await checkEffectProvider(rest as EffectProvider)).map((i) => i.message)).toContain('supportsTemplates is set but listTemplates is missing');
		const unflagged = { ...good, capabilities: { ...good.capabilities, supportsTemplates: false } };
		expect((await checkEffectProvider(unflagged)).map((i) => i.message)).toContain('template methods are present but capabilities.supportsTemplates is not set');
	});

	it('flags templates naming unknown effects, untyped errors and partial refusals', async () => {
		const broken: EffectProvider = {
			...good,
			describeTemplate: async (id) => {
				if (id === '__no_such_template__') throw new Error('nope');
				return good.describeTemplate!(id);
			},
			instantiateTemplate: async (id, values, options) => {
				const r = await good.instantiateTemplate!(id, values, options);
				if (!r.ok) return { ok: false, errors: [r.errors[0]] };
				return { ...r, sequence: { ...r.sequence, shots: r.sequence.shots.map((s) => ({ ...s, layers: [{ effect: 'fake.missing' }] })) } };
			}
		};
		const messages = (await checkEffectProvider(broken)).map((i) => `${i.templateId ?? ''} ${i.message}`.trim());
		expect(messages).toContain('describeTemplate of an unknown id failed with untyped Error: nope (expected unknown_template)');
		expect(messages).toContain('fake.title-sequence with the defaults, shot 1, layer 1: the provider has no effect "fake.missing".');
		expect(messages).toContain('fake.title-sequence instantiateTemplate should refuse every bad value at once (an unknown slot and a wrong type gave one error)');
	});
});
