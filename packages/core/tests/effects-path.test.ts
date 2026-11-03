import { describe, expect, it } from 'vitest';
import { checkEffectProvider, createFakeEffectProvider, effectValueErrors, pathControlsOf, type EffectDescription, type EffectProvider } from '../src/effects';

describe('path controls', () => {
	const provider = createFakeEffectProvider();

	it('names the controls that take a path, and the summary says it accepts one', async () => {
		const trail = await provider.describe('fake.trail');
		expect(pathControlsOf(trail)).toEqual(['path']);
		expect(trail.accepts).toEqual(['path']);
		expect(pathControlsOf(await provider.describe('fake.gradient'))).toEqual([]);
		// Every value form a path control takes passes validation.
		for (const path of ['', 'M0 0 L10 10', [0, 0, 10, 10, 20, 0]]) expect(effectValueErrors(trail, { path })).toEqual([]);
		expect(effectValueErrors(trail, { path: 5 }).length).toBeGreaterThan(0);
	});

	it('draws the trail along points in frame pixels, used as given', async () => {
		const r = provider.createRenderer('fake.trail', { width: 40, height: 20 });
		const out = await (await r).render({ time: 0, values: { path: [4, 4, 36, 4], width: 2 } });
		const alpha = (x: number, y: number) => out.data[(y * 40 + x) * 4 + 3];
		expect(alpha(20, 4)).toBe(255);
		expect(alpha(20, 15)).toBe(0);
	});

	it('writes words as path data, and refuses fonts it lacks', async () => {
		expect(provider.pathFromText!('ab')).toMatch(/^M0 10 L3 0 L6 10 M10 10/);
		expect(() => provider.pathFromText!('ab', { font: 'serif' })).toThrow(/no font "serif"/);
		expect(() => provider.pathFromText!('  ')).toThrow(/no words/);
	});

	it('the fake provider passes conformance, and a path control without accepts is caught', async () => {
		expect(await checkEffectProvider(provider)).toEqual([]);
		const broken: EffectProvider = {
			...provider,
			describe: async (id: string) => {
				const d = await provider.describe(id);
				return (id === 'fake.trail' ? { ...d, accepts: undefined } : d) as EffectDescription;
			},
		};
		const issues = await checkEffectProvider(broken);
		expect(issues.some((i) => i.effectId === 'fake.trail' && /take a path, but accepts does not list "path"/.test(i.message))).toBe(true);
	});
});
