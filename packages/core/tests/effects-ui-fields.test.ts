import { describe, it, expect } from 'vitest';
import { effectControlField, effectFieldValue, effectParameterFields, effectValueErrors } from '../src/effects';
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

describe('effect colour controls written as anyOf', () => {
	it('become colour fields with a hex default', () => {
		expect(effectControlField('uColorA', anyOfColour('#ff6b6b'), undefined)).toEqual({ id: 'uColorA', label: 'Colour A', type: 'color', alpha: false, default: '#ff6b6b' });
		expect(effectControlField('ink', anyOfColour('#ebedf5', 3, true), undefined)).toMatchObject({ type: 'color', default: '#ebedf5' });
	});

	it('convert a channel default to hex, with alpha for four channels', () => {
		expect(effectControlField('c', anyOfColour([1, 0.5, 0]), undefined)).toMatchObject({ type: 'color', alpha: false, default: '#ff8000' });
		expect(effectControlField('c', anyOfColour([0, 0, 1, 0.5], 4), undefined)).toMatchObject({ type: 'color', alpha: true, default: '#0000ff80' });
		expect(effectControlField('c', { ...anyOfColour(undefined), default: undefined }, [0, 1, 0])).toMatchObject({ default: '#00ff00' });
	});

	it('are left out when the default is not a colour the field can show', () => {
		expect(effectControlField('c', anyOfColour('currentColor', 3, true), undefined)).toBeNull();
		expect(effectControlField('c', anyOfColour('rgb(1, 2, 3)'), undefined)).toBeNull();
		expect(effectControlField('c', anyOfColour(undefined), undefined)).toBeNull();
	});

	it('leave other anyOf controls out', () => {
		const numberOrList: JsonSchema = { anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }], default: 1 };
		expect(effectControlField('n', numberOrList, undefined)).toBeNull();
	});

	it('keep their place among the other controls', () => {
		const controls: JsonSchema = {
			type: 'object',
			properties: { uColorA: anyOfColour('#ff6b6b'), uSpeed: { type: 'number', title: 'Speed', minimum: 0, maximum: 2, default: 0.3 }, uColorB: anyOfColour([1, 1, 1]) }
		};
		const fields = effectParameterFields({ controls, defaults: { uColorA: '#ff6b6b', uSpeed: 0.3, uColorB: '#ffffff' } } as never);
		expect(fields.map((f) => [f.id, f.type])).toEqual([
			['uColorA', 'color'],
			['uSpeed', 'number'],
			['uColorB', 'color']
		]);
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
	});

	it('falls back to the default for values a colour field cannot show', () => {
		expect(effectFieldValue(field, 'currentColor')).toBe('#ff6b6b');
		expect(effectFieldValue(field, undefined)).toBe('#ff6b6b');
		expect(effectFieldValue(field, [2])).toBe('#ff6b6b');
	});

	it('leaves other fields as before', () => {
		const text = effectControlField('t', { type: 'string', default: 'hi' }, undefined)!;
		expect(effectFieldValue(text, 'there')).toBe('there');
		expect(effectFieldValue(text, undefined)).toBe('hi');
	});
});
