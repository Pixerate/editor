import { describe, expect, it } from 'vitest';
import { effectControlField, effectParameterFields } from '../src/effects';

describe('effect controls as parameter fields', () => {
	it('edits a control that takes several shapes as the shape of its default', () => {
		// A colour as sRGB channels or a CSS string, as Flair describes its colours.
		const colour = {
			title: 'Neon',
			description: 'A colour.',
			anyOf: [
				{ type: 'array', items: { type: 'number', minimum: 0, maximum: 1 }, minItems: 3, maxItems: 3 },
				{ type: 'string', pattern: '^#' }
			],
			default: '#ff2bd6'
		} as const;
		expect(effectControlField('uNeon', colour, undefined)).toMatchObject({ id: 'uNeon', label: 'Neon', type: 'color', default: '#ff2bd6' });
		expect(effectControlField('uNeon', { ...colour, default: undefined }, [1, 0, 0.5])).toMatchObject({ type: 'vector', size: 3, default: [1, 0, 0.5], min: 0, max: 1 });
		expect(effectControlField('odd', { anyOf: [{ type: 'object' }] }, undefined)).toBeNull();
	});

	it('keeps every control of a description in order', () => {
		const fields = effectParameterFields({
			controls: {
				type: 'object',
				additionalProperties: false,
				properties: {
					uBackground: { description: 'Background.', anyOf: [{ type: 'array' }, { type: 'string' }] },
					uRings: { type: 'number', minimum: 1, maximum: 10, description: 'Rings.' }
				}
			},
			defaults: { uBackground: '#09090b', uRings: 4 }
		});
		expect(fields.map((f) => [f.id, f.type])).toEqual([
			['uBackground', 'color'],
			['uRings', 'number']
		]);
	});
});
