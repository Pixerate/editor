import { describe, it, expect } from 'vitest';
import { effectControlField, effectFieldValue, effectValueErrors } from '../src/effects';
import type { JsonSchema } from '../src/tools';

/** A colour control as Flair writes it: channels from 0 to 1, a CSS colour string, or optionally `currentColor`. */
const anyOfColour = (def: unknown, channels = 3, currentColor = false): JsonSchema => ({
	title: 'Colour A',
	anyOf: [
		{ type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, minItems: channels, maxItems: channels },
		{ type: 'string', pattern: '^\\s*#?(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})\\s*$' },
		...(currentColor ? [{ const: 'currentColor' }] : [])
	],
	default: def as never
});

describe('Flair colour controls written as anyOf', () => {
	it('are colour fields when the default is hex, with alpha for #rrggbbaa', () => {
		expect(effectControlField('ink', anyOfColour('#ebedf5', 3, true), undefined)).toEqual({ id: 'ink', label: 'Colour A', type: 'color', alpha: false, default: '#ebedf5' });
		expect(effectControlField('glow', anyOfColour('#00ff0080', 4), undefined)).toMatchObject({ type: 'color', alpha: true, default: '#00ff0080' });
	});

	it('write values the schema accepts', () => {
		const controls: JsonSchema = { type: 'object', properties: { uColorA: anyOfColour('#ff6b6b') } };
		const field = effectControlField('uColorA', controls.properties!.uColorA, undefined)!;
		expect(effectValueErrors({ controls } as never, { uColorA: field.default })).toEqual([]);
		expect(effectValueErrors({ controls } as never, { uColorA: '#123456' })).toEqual([]);
	});
});

describe('effectFieldValue for colour fields', () => {
	const field = effectControlField('c', anyOfColour('#ff6b6b', 3, true), undefined)!;

	it('shows hex as it is and channels as hex', () => {
		expect(effectFieldValue(field, '#00ff00')).toBe('#00ff00');
		expect(effectFieldValue(field, [0, 0, 1])).toBe('#0000ff');
		expect(effectFieldValue(field, [1, 0.5, 0, 0.5])).toBe('#ff800080');
	});

	it('falls back to the default for values a colour well cannot show', () => {
		expect(effectFieldValue(field, 'currentColor')).toBe('#ff6b6b');
		expect(effectFieldValue(field, 'rgb(1, 2, 3)')).toBe('#ff6b6b');
		expect(effectFieldValue(field, undefined)).toBe('#ff6b6b');
		expect(effectFieldValue(field, [2])).toBe('#ff6b6b');
	});

	it('leaves other fields as before', () => {
		const text = effectControlField('t', { type: 'string', default: 'hi' }, undefined)!;
		expect(effectFieldValue(text, 'there')).toBe('there');
		expect(effectFieldValue(text, undefined)).toBe('hi');
		const vector = effectControlField('v', anyOfColour(undefined), [1, 0, 0.5])!;
		expect(effectFieldValue(vector, [0, 1, 0])).toEqual([0, 1, 0]);
	});
});
