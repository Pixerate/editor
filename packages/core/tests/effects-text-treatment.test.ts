import { describe, expect, it } from 'vitest';
import {
	BUILT_IN_TEXT_TREATMENT_CHECK_MS,
	TEXT_TREATMENT_STAGES,
	builtInTextTreatmentPlan,
	checkEffectProvider,
	checkTextTreatmentRequest,
	createFakeEffectProvider,
	effectOffered,
	planTextTreatment,
	textTreatmentIdFor,
	textTreatmentPlanProblems,
	type EffectProvider,
	type TextTreatmentPlanRequest,
	type TextTreatmentTarget
} from '../src/effects';

const WRAPPED: TextTreatmentTarget = {
	lines: [
		{ x: 40, y: 0, width: 120, height: 20 },
		{ x: 0, y: 24, width: 64.5, height: 20 }
	],
	caret: { x: 64.5, y: 24, height: 20 },
	label: 'Claude'
};

const plan = (stage: TextTreatmentPlanRequest['stage'], time: number, extra: Partial<TextTreatmentPlanRequest> = {}) =>
	builtInTextTreatmentPlan({ stage, time, target: WRAPPED, ...extra });

describe('the built-in text treatment (the editors’ own look)', () => {
	it('draws a 2 px caret with a name tag above its line, looping', () => {
		const p = plan('caret', 5000);
		expect(p.done).toBe(false);
		expect(p.layers.map((l) => [l.kind, l.source, l.z])).toEqual([
			['rect', 'caret', 'above'],
			['tag', 'tag', 'above']
		]);
		const [caret, tag] = p.layers;
		expect(caret).toMatchObject({ x: 63.5, y: 24, width: 2, height: 20, opacity: 1 });
		expect(caret.color).toEqual([0x8b / 255, 0x5c / 255, 0xf6 / 255, 1]);
		expect(tag).toMatchObject({ text: 'Claude', x: 63.5, y: 24 - 16.5, height: 16.5, size: 11, padX: 5, radius: 3, textColor: [1, 1, 1, 1] });
	});

	it('leaves the tag out without a label, and the caret out without a caret', () => {
		expect(builtInTextTreatmentPlan({ stage: 'caret', time: 0, target: { caret: WRAPPED.caret } }).layers.map((l) => l.source)).toEqual(['caret']);
		expect(builtInTextTreatmentPlan({ stage: 'caret', time: 0, target: {} }).layers).toEqual([]);
	});

	it('tints a selection at 28% behind the text at once, with the caret, and holds it', () => {
		const p = plan('selecting', 0);
		expect(p.done).toBe(true);
		expect(p.duration).toBe(0);
		const fills = p.layers.filter((l) => l.source === 'selection');
		expect(fills.map((l) => [l.x, l.y, l.width, l.height, l.z])).toEqual([
			[40, 0, 120, 20, 'behind'],
			[0, 24, 64.5, 20, 'behind']
		]);
		expect(fills[0].color[3]).toBe(0.28);
		expect(p.layers.some((l) => l.source === 'caret')).toBe(true);
	});

	it('tints what landed at 18% until the host clears it', () => {
		const p = plan('landed', 60_000);
		expect(p.done).toBe(false);
		expect(p.layers.every((l) => l.source === 'changed' && l.color[3] === 0.18)).toBe(true);
	});

	it('sweeps a soft band across the lines in reading order while checking, then is done', () => {
		const early = plan('checking', 60);
		const mid = plan('checking', BUILT_IN_TEXT_TREATMENT_CHECK_MS / 2);
		const late = plan('checking', BUILT_IN_TEXT_TREATMENT_CHECK_MS - 30);
		// Early, the band is near the start of the first line; late, near the end of the last.
		expect(early.layers.every((l) => l.y === 0)).toBe(true);
		expect(late.layers.every((l) => l.y === 24)).toBe(true);
		expect(mid.layers.length).toBeGreaterThan(0);
		for (const l of mid.layers) expect(l.gradient?.stops.map((s) => s.color[3])).toEqual([0, 0.22, 0]);
		const done = plan('checking', BUILT_IN_TEXT_TREATMENT_CHECK_MS);
		expect(done).toMatchObject({ done: true, layers: [] });
	});

	it('fades the lines in and out instead of sweeping with Reduce Motion', () => {
		const p = plan('checking', BUILT_IN_TEXT_TREATMENT_CHECK_MS / 2, { reduceMotion: true });
		expect(p.reduced).toBe(true);
		expect(p.layers.map((l) => [l.width, l.opacity, l.gradient])).toEqual([
			[120, 1, undefined],
			[64.5, 1, undefined]
		]);
		expect(plan('checking', 0, { reduceMotion: true }).layers).toEqual([]);
	});

	it('takes the agent’s colour and refuses other values', () => {
		expect(builtInTextTreatmentPlan({ stage: 'caret', time: 0, target: WRAPPED }, { color: '#ff0000' }).layers[0].color).toEqual([1, 0, 0, 1]);
		expect(() => builtInTextTreatmentPlan({ stage: 'caret', time: 0, target: WRAPPED }, { color: 'red' })).toThrow(/must be a colour "#rrggbb"/);
		expect(() => builtInTextTreatmentPlan({ stage: 'caret', time: 0, target: WRAPPED }, { glow: 1 })).toThrow(/only "color"/);
	});

	it('has well formed plans for every stage', () => {
		for (const stage of TEXT_TREATMENT_STAGES) {
			for (const reduceMotion of [false, true]) {
				for (const time of [0, 100, 479, 480, 9000]) {
					const request = { stage, time, target: WRAPPED, reduceMotion };
					expect(textTreatmentPlanProblems(builtInTextTreatmentPlan(request), request)).toEqual([]);
				}
			}
		}
	});
});

describe('checkTextTreatmentRequest', () => {
	const ok: TextTreatmentPlanRequest = { stage: 'caret', time: 0, target: WRAPPED };
	it.each([
		[{ ...ok, stage: 'wiggle' }, /no stage "wiggle"; a text treatment's stages are caret, checking, selecting, typing, landed/],
		[{ ...ok, time: -1 }, /The time is ms into the stage, 0 or more; it was -1/],
		[{ ...ok, time: Number.NaN }, /it was NaN/],
		[{ ...ok, target: { lines: 'a' } }, /lines are a list of rectangles/],
		[{ ...ok, target: { lines: [{ x: 0, y: 0, width: -2, height: 3 }] } }, /Line 0 of the target is \{ x, y, width, height \}/],
		[{ ...ok, target: { caret: { x: 0, y: 0 } } }, /caret is \{ x, y, height \}/],
		[{ ...ok, target: { label: 3 } }, /label is a string/],
		[{ ...ok, target: { color: 'red' } }, /color is a colour: "#rrggbb", or channels 0 to 1/]
	])('refuses %j with a sentence', (request, message) => {
		expect(() => checkTextTreatmentRequest(request as TextTreatmentPlanRequest)).toThrow(message);
	});
});

describe('text treatments from a provider', () => {
	const fake = createFakeEffectProvider({ textTreatments: true });

	it('conform (the fake provider passes checkEffectProvider)', async () => {
		expect(await checkEffectProvider(fake, { render: false })).toEqual([]);
	});

	it('are offered only where the text-treatment use is asked for', async () => {
		const list = await fake.list();
		const treatments = list.filter((e) => e.kind === 'text-treatment');
		expect(treatments.map((e) => e.id)).toEqual(['fake.soft', 'fake.underline']);
		expect(treatments.some((e) => effectOffered(e))).toBe(false);
		expect(treatments.every((e) => effectOffered(e, ['text-treatment']))).toBe(true);
		expect(list.filter((e) => e.kind !== 'text-treatment').some((e) => effectOffered(e, ['text-treatment']))).toBe(false);
	});

	it('refuse unknown ids, other kinds, renderers and bad values with typed errors', async () => {
		const request: TextTreatmentPlanRequest = { stage: 'caret', time: 0, target: WRAPPED };
		expect(() => fake.textTreatmentPlan!('nope', request)).toThrow(expect.objectContaining({ code: 'unknown_effect' }));
		expect(() => fake.textTreatmentPlan!('fake.invert', request)).toThrow(/not a text treatment; the text treatments are "fake.soft", "fake.underline"/);
		expect(() => fake.textTreatmentPlan!('fake.soft', request, { color: 4 })).toThrow(expect.objectContaining({ code: 'invalid_values' }));
		await expect(async () => fake.createRenderer('fake.soft', { width: 4, height: 4 })).rejects.toThrow(/Use textTreatmentPlan/);
	});

	it('pick the agent’s treatment, the provider’s default, or the built-in one', () => {
		const request: TextTreatmentPlanRequest = { stage: 'checking', time: 100, target: WRAPPED };
		expect(textTreatmentIdFor(fake)).toBe('fake.soft');
		expect(textTreatmentIdFor(fake, { id: 'fake.underline' })).toBe('fake.underline');
		expect(textTreatmentIdFor(null, { id: 'fake.underline' })).toBeUndefined();
		expect(textTreatmentIdFor(createFakeEffectProvider())).toBeUndefined();
		expect(planTextTreatment(fake, request, { id: 'fake.underline' }).layers.every((l) => l.source === 'underline')).toBe(true);
		expect(planTextTreatment(fake, request)).toEqual(builtInTextTreatmentPlan(request));
		// Without a provider the built-in treatment reads only the colour.
		expect(planTextTreatment(null, request, { values: { color: '#00ff00', sweep: 2 } })).toEqual(builtInTextTreatmentPlan(request, { color: '#00ff00' }));
	});

	it('flag a provider that breaks the contract', async () => {
		const broken: EffectProvider = {
			...fake,
			capabilities: { ...fake.capabilities, defaultTextTreatment: 'fake.invert' },
			textTreatmentPlan: (id, request, values) => ({ ...fake.textTreatmentPlan!(id, request, values), done: request.stage === 'caret' })
		};
		const messages = (await checkEffectProvider(broken, { render: false })).map((i) => i.message);
		expect(messages).toContain('capabilities.defaultTextTreatment "fake.invert" is not a text treatment in the catalog');
		expect(messages).toContain('textTreatmentPlan caret at 120000 ms: the caret stage loops until the host moves on, so it is never done');
		const missing: EffectProvider = { ...fake, textTreatmentPlan: undefined };
		expect((await checkEffectProvider(missing, { render: false })).map((i) => i.message)).toContain('supportsTextTreatments is set but textTreatmentPlan is missing');
	});
});
