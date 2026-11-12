import { describe, it, expect } from 'vitest';
import { STYLE_AGENT_INSTRUCTIONS, ToolRegistry, createStyleResolver, createStyleToolProvider, memoryStyleStore, styleDefaults, styleSwatches } from '../src/tools';
import { ChartController, chartStyleDomain, createChartStyleToolProvider } from '../src/chart';
import { tokensStyleDomain } from '../src/tokens';

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}.\n---\n\nUse it.\n`;
const BRAND = { colors: { primary: '#0b5fff', secondary: '#ff6a00', text: '#111111', background: '#ffffff' }, fonts: { heading: 'Inter', body: 'Source Serif' } };

const setup = (files: Record<string, string>, readOnly?: boolean | string) => {
	const styles = createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore(files) }], domains: [chartStyleDomain, tokensStyleDomain] });
	const controller = new ChartController();
	controller.setType('bar');
	controller.setData({ categories: ['a', 'b'], series: [{ id: 's', name: 'S', values: [1, 2] }] });
	const registry = new ToolRegistry();
	registry.register(createStyleToolProvider(styles));
	registry.register(createChartStyleToolProvider(controller, styles, readOnly !== undefined ? { readOnly } : {}));
	return { styles, controller, registry };
};

describe('styleSwatches', () => {
	it('lists the profile palette, then the brand palette and roles, without repeats; and the fonts', async () => {
		const { styles } = setup({ 'acme/SKILL.md': skill('acme'), 'acme/brand.json': JSON.stringify(BRAND), 'acme/chart.json': JSON.stringify({ palette: ['#12a150', '#0B5FFF'] }) });
		const swatches = styleSwatches(await styles.resolve('chart'));
		expect(swatches.colors).toEqual([
			{ color: '#12a150', label: 'palette 1' },
			{ color: '#0B5FFF', label: 'palette 2' },
			{ color: '#ff6a00', label: 'brand 2' },
			{ color: '#ffffff', label: 'background' },
			{ color: '#111111', label: 'text' }
		]);
		expect(swatches.fonts).toEqual(['Inter', 'Source Serif']);
		expect(styleSwatches({ profile: {} })).toEqual({ colors: [], fonts: [] });
	});

	it('get_style returns the same swatches the pickers show', async () => {
		const { registry, styles } = setup({ 'acme/SKILL.md': skill('acme'), 'acme/brand.json': JSON.stringify(BRAND) });
		const style = await registry.callTool('get_style', { domain: 'chart' });
		expect((style.structuredContent as any).swatches).toEqual(styleSwatches(await styles.resolve('chart')));
	});
});

describe('defaults', () => {
	it('gives each domain its starting patch, or nothing', async () => {
		const { styles } = setup({ 'acme/SKILL.md': skill('acme'), 'acme/chart.json': JSON.stringify({ palette: ['#000000'], defaults: { dataLabels: true } }) });
		expect(styleDefaults(chartStyleDomain, await styles.resolve('chart'))).toEqual({ dataLabels: true, palette: ['#000000'] });
		expect(styleDefaults(tokensStyleDomain, await styles.resolve('tokens'))).toEqual({});
		expect(styleDefaults(chartStyleDomain, { profile: {} })).toEqual({});
	});

	it('apply_chart_style applies the palette and defaults as one undo step', async () => {
		const { registry, controller } = setup({ 'acme/SKILL.md': skill('acme'), 'acme/brand.json': JSON.stringify(BRAND), 'acme/chart.json': JSON.stringify({ defaults: { dataLabels: true } }) });
		const before = controller.getSpec();
		const result = await registry.callTool('apply_chart_style', {});
		expect(result.isError).toBeFalsy();
		expect((result.structuredContent as any).applied).toEqual({ dataLabels: true, palette: ['#0b5fff', '#ff6a00'] });
		expect(controller.getSpec()).toMatchObject({ dataLabels: true, palette: ['#0b5fff', '#ff6a00'] });
		controller.undo();
		expect(controller.getSpec()).toEqual(before);
	});

	it('apply_chart_style refuses without a style, with nothing to apply, or on a read-only chart', async () => {
		const none = await setup({}).registry.callTool('apply_chart_style', {});
		expect(none.isError).toBe(true);
		expect((none.content[0] as any).text).toMatch(/No house style applies to charts/);
		const prose = await setup({ 'acme/SKILL.md': skill('acme') }).registry.callTool('apply_chart_style', {});
		expect((prose.content[0] as any).text).toMatch(/sets no chart palette or defaults/);
		const locked = setup({ 'acme/SKILL.md': skill('acme'), 'acme/brand.json': JSON.stringify(BRAND) }, 'The report is signed off.');
		// Read-only: the write tool is hidden, as the chart's own write tools are.
		const ro = await locked.registry.callTool('apply_chart_style', {});
		expect(ro.isError).toBe(true);
		expect(locked.registry.listTools().tools.map((t) => t.name)).toContain('chart__check_chart_style');
		expect(locked.registry.listTools().tools.map((t) => t.name)).not.toContain('chart__apply_chart_style');
		expect((await locked.registry.callTool('check_chart_style', {})).isError).toBeFalsy();
		expect((await setup({ 'acme/SKILL.md': skill('acme') }).registry.callTool('apply_chart_style', { force: true })).isError).toBe(true);
	});
});

describe('STYLE_AGENT_INSTRUCTIONS', () => {
	it('is domain-neutral and names the tools it relies on', () => {
		expect(STYLE_AGENT_INSTRUCTIONS).toContain('get_style');
		expect(STYLE_AGENT_INSTRUCTIONS).toContain('check_<domain>_style');
		// Hosts append their own conventions: no editor, vendor or brand words here.
		expect(STYLE_AGENT_INSTRUCTIONS).not.toMatch(/\b(chart|spreadsheet|vector|canvas|diagram|slides?|report|acme|pixerate|figma|office|powerpoint|excel)\b/i);
	});
});
