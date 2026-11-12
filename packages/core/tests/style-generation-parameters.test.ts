import { describe, it, expect } from 'vitest';
import { ToolRegistry, createStyleResolver, memoryStyleStore } from '../src/tools';
import { createGenerationStyleToolProvider, generationStyleDomain } from '../src/generation';
import { ParametersController, createParametersStyleToolProvider, parametersStyleDomain, parametersStyleSurface } from '../src/parameters';

const skill = (domain: string) => `---\nname: house\ndescription: House style.\ndomains: [${domain}]\n---\n\nKeep it plain.\n`;
const resolver = (domain: string, profile: Record<string, unknown>, brand?: Record<string, unknown>) =>
	createStyleResolver({
		layers: [{ id: 'org', store: memoryStyleStore({ 'house/SKILL.md': skill(domain), [`house/${domain}.json`]: JSON.stringify(profile), ...(brand ? { 'house/brand.json': JSON.stringify(brand) } : {}) }) }],
		domains: [generationStyleDomain, parametersStyleDomain]
	});

const PROFILE = {
	models: ['image-standard', 'image-fast'],
	aspectRatios: ['1:1', '16:9'],
	maxCount: 2,
	promptSuffix: 'flat vector illustration',
	negativeTerms: ['text', 'watermark'],
	bannedTerms: ['photorealistic'],
	checks: ['models', 'aspect-ratios', 'limits', 'prompt-suffix', 'negative-terms', 'banned-terms']
};

describe('generation house style', () => {
	it('checks a request before anything is spent', async () => {
		const styles = resolver('generation', PROFILE);
		const report = await styles.check('generation', { model: 'image-ultra', prompt: 'A photorealistic fox.', aspectRatio: '4:5', count: 6, negativePrompt: 'blurry' });
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([
			['models', { field: 'model', value: 'image-standard' }],
			['aspect-ratios', { field: 'aspectRatio', value: '1:1' }],
			['limits', { field: 'count', value: 2 }],
			['prompt-suffix', { field: 'prompt', value: 'A photorealistic fox, flat vector illustration' }],
			['negative-terms', { field: 'negativePrompt', value: 'blurry, text, watermark' }],
			['banned-terms', { field: 'prompt' }]
		]);
		// A request that names no model gets the house default as a suggestion, not a warning.
		const bare = await styles.check('generation', { prompt: 'A fox, flat vector illustration', negativePrompt: 'text, watermark' });
		expect(bare.findings.map((f) => [f.check, f.severity])).toEqual([
			['models', 'info'],
			['aspect-ratios', 'info']
		]);
	});

	it('apply_generation_style returns the request in the house style without generating', async () => {
		const registry = new ToolRegistry();
		registry.register(createGenerationStyleToolProvider(resolver('generation', PROFILE), { namespace: '' }));
		const result = await registry.callTool('apply_generation_style', { request: { prompt: 'A photorealistic fox', count: 6, seed: 7 } });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			request: { prompt: 'A photorealistic fox, flat vector illustration', count: 2, seed: 7, model: 'image-standard', aspectRatio: '1:1', negativePrompt: 'text, watermark' },
			changed: ['model', 'aspectRatio', 'count', 'prompt', 'negativePrompt'],
			left: [expect.objectContaining({ check: 'banned-terms' })]
		});
		const tools = registry.listTools().tools;
		expect(tools.map((t) => [t.name, t.annotations?.readOnlyHint])).toEqual([
			['check_generation_style', true],
			['apply_generation_style', true]
		]);
		expect((await registry.callTool('check_generation_style', {})).isError).toBe(true);
	});
});

describe('parameters house style', () => {
	const params = () =>
		new ParametersController({
			schema: {
				fields: [
					{ id: 'grain', type: 'number', min: 0, max: 1, default: 0.5 },
					{ id: 'intensity', type: 'number', min: 0, max: 1, default: 0.9 },
					{ id: 'tint', type: 'color', default: '#9933cc', label: 'Tint' },
					{ id: 'locked', type: 'number', min: 0, max: 1, default: 1, readOnly: true }
				]
			}
		} as any);

	it('house-values and ranges; colour parameters are the surface for the brand checks', async () => {
		const c = params();
		const styles = resolver('parameters', { values: { grain: 0.2, missing: 3 }, ranges: { intensity: { max: 0.6 } }, checks: ['house-values', 'ranges', 'palette-only'] }, { colors: { primary: '#0b5fff' } });
		const report = await styles.check('parameters', c.getState());
		expect(report.findings.map((f) => [f.check, f.target])).toEqual([
			['house-values', { parameter: 'grain', value: 0.2 }],
			['ranges', { parameter: 'intensity', value: 0.6 }],
			['palette-only', { parameter: 'tint' }]
		]);
		expect(parametersStyleSurface(c.getState()).colors).toEqual([{ color: '#9933cc', label: 'Tint', target: { parameter: 'tint' }, use: 'fill' }]);
	});

	it('check and fix through the tools, one undo step; read-only parameters are left', async () => {
		const c = params();
		let readOnly: string | false = false;
		const styles = resolver('parameters', { values: { grain: 0.2, locked: 0 }, ranges: { intensity: { max: 0.6 } }, checks: ['house-values', 'ranges'] });
		const registry = new ToolRegistry();
		registry.register(createParametersStyleToolProvider(c, styles, { namespace: '', readOnly: () => readOnly }));
		const fix = await registry.callTool('fix_parameters_style', {});
		expect(fix.structuredContent).toMatchObject({ set: { grain: 0.2, intensity: 0.6 }, left: [expect.objectContaining({ target: { parameter: 'locked', value: 0 } })] });
		expect(c.getValues()).toMatchObject({ grain: 0.2, intensity: 0.6 });
		c.undo();
		expect(c.getValues()).toMatchObject({ grain: 0.5, intensity: 0.9 });
		readOnly = 'locked';
		expect(registry.listTools().tools.map((t) => t.name)).toEqual(['check_parameters_style']);
	});
});
