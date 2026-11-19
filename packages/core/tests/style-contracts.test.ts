import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STYLE_SCENARIOS, runStyleScenario, styleContracts } from '../src/tools';

describe('the style contracts', () => {
	it('are current in @pixerate/conformance', async () => {
		const dir = new URL('../../conformance/domains/style/', import.meta.url);
		const contracts = await styleContracts();
		expect(readdirSync(dir).sort()).toEqual(Object.keys(contracts).sort());
		for (const [file, value] of Object.entries(contracts)) {
			expect(JSON.parse(readFileSync(new URL(file, dir), 'utf8')), file).toEqual(JSON.parse(JSON.stringify(value)));
		}
	});

	it('cover the resolver: two layers, locks, state, extends, tokens, frontmatter and errors', async () => {
		const results = await Promise.all(STYLE_SCENARIOS.map(runStyleScenario));
		const issues = JSON.stringify(results);
		for (const phrase of ['is locked by the org layer', 'cannot switch it off', 'goes round in a circle', 'which no layer holds', 'is not a design token here', '(brand)', '(from base)', 'frontmatter line', 'is not a valid skill name', 'has no file', 'There is no house-style skill']) {
			expect(issues, phrase).toContain(phrase);
		}
		// Merged across two layers, with the field each set.
		const sources = (results[0][2].structuredContent as any).sources;
		expect(sources).toMatchObject({ headingCase: 'user', terms: 'org', properNouns: 'user' });
	});
});
