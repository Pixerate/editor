import { describe, it, expect } from 'vitest';
import {
	BRAND_COLOR_ROLES,
	SHARED_STYLE_CHECKS,
	ToolRegistry,
	brandColor,
	brandColors,
	brandFonts,
	brandPalette,
	createStyleResolver,
	createStyleToolProvider,
	memoryStyleStore,
	renderStyle,
	styleChecksOf,
	type StyleDomain,
	type StyleSurface
} from '../src/tools';
import { ChartController, chartStyleDomain, chartStyleFromBrand, createChartStyleToolProvider } from '../src/chart';
import { TokenStore, tokensStyleDomain, tokensStyleSurface } from '../src/tokens';

const skill = (name: string, extra = '') => `---\nname: ${name}\ndescription: ${name} house style.\n${extra}---\n\nUse the brand.\n`;

const ACME = {
	name: 'Acme',
	colors: { primary: '#0b5fff', secondary: '#ff6a00', accent: '#12a150', text: '#111111', background: '#ffffff', border: '#d0d0d0' },
	fonts: { heading: 'Inter', body: 'Source Serif' }
};

/** A domain with a surface and nothing else, standing in for any future editor. */
const surfaceDomain: StyleDomain<StyleSurface> = {
	id: 'demo',
	title: 'Demo',
	description: 'A domain with only a surface.',
	profileSchema: { type: 'object', properties: { palette: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
	checks: [],
	surface: (state) => state
};

/** A domain with neither a surface nor a brand theme. */
const plainDomain: StyleDomain<unknown> = {
	id: 'plain',
	title: 'Plain',
	description: 'A domain that cannot be checked against the brand.',
	profileSchema: { type: 'object', properties: {}, additionalProperties: false },
	checks: []
};

describe('brand roles', () => {
	it('looks roles up through their fallback names, including Office theme slots', () => {
		const office = { colors: { accent1: '#4472c4', accent2: '#ed7d31', dk1: '#000000', lt1: '#ffffff', dk2: '#44546a', hlink: '#0563c1' } };
		expect(brandColor(office, 'primary')).toBe('#4472c4');
		expect(brandColor(office, 'secondary')).toBe('#ed7d31');
		expect(brandColor(office, 'text')).toBe('#000000');
		expect(brandColor(office, 'background')).toBe('#ffffff');
		expect(brandColor(office, 'mutedText')).toBe('#44546a');
		expect(brandColor(office, 'link')).toBe('#0563c1');
		expect(brandColor(office, 'positive')).toBeUndefined();
		expect(brandColor(undefined, 'primary')).toBeUndefined();
		// A role's own name wins over its fallbacks.
		expect(brandColor({ colors: { accent1: '#111111', primary: '#222222' } }, 'primary')).toBe('#222222');
		expect(Object.keys(brandColors(ACME))).toEqual(['primary', 'secondary', 'accent', 'background', 'surface', 'text', 'border']);
		expect(Object.keys(BRAND_COLOR_ROLES)).toContain('negative');
	});

	it('ignores names inherited from Object.prototype', () => {
		expect(brandColor({ colors: {} }, 'text')).toBeUndefined();
		expect(brandPalette({ colors: {} })).toEqual([]);
	});

	it('derives the palette from the series roles and slots, without repeats, unless the brand lists one', () => {
		expect(brandPalette(ACME)).toEqual(['#0b5fff', '#ff6a00', '#12a150']);
		expect(brandPalette({ colors: { accent1: '#4472c4', accent2: '#ed7d31', accent3: '#a5a5a5' } })).toEqual(['#4472c4', '#ed7d31', '#a5a5a5']);
		expect(brandPalette({ ...ACME, palette: ['#000000', '#ffffff'] })).toEqual(['#000000', '#ffffff']);
		expect(brandFonts(ACME)).toEqual(['Inter', 'Source Serif']);
		expect(brandFonts({ fonts: { heading: 'Inter', body: 'Inter' } })).toEqual(['Inter']);
	});

	it('gives charts a palette and theme from the brand', () => {
		expect(chartStyleFromBrand(ACME)).toEqual({
			palette: ['#0b5fff', '#ff6a00', '#12a150'],
			theme: { background: '#ffffff', surface: '#ffffff', text: '#111111', grid: '#d0d0d0', axis: '#d0d0d0', fontFamily: 'Source Serif' }
		});
		expect(chartStyleFromBrand({})).toEqual({});
	});
});

describe('brand.json in the resolver', () => {
	const resolver = (files: Record<string, string>, more: Parameters<typeof createStyleResolver>[0]['layers'] = []) =>
		createStyleResolver({ layers: [{ id: 'org', store: memoryStyleStore(files) }, ...more], domains: [chartStyleDomain, tokensStyleDomain, surfaceDomain, plainDomain] });

	it('always offers the brand domain, with its schema and the shared checks', () => {
		const styles = resolver({});
		expect(styles.domains.map((d) => d.id)).toEqual(['chart', 'tokens', 'demo', 'plain', 'brand']);
		expect(styleChecksOf(styles.domains.find((d) => d.id === 'brand')!).map((c) => c.id)).toEqual(SHARED_STYLE_CHECKS.map((c) => c.id));
		// A domain with a surface gets the shared checks after its own; chart keeps its own versions.
		expect(styleChecksOf(chartStyleDomain).map((c) => c.id)).toEqual(['palette-only', 'distinguishable', 'min-contrast', 'allowed-type', 'fonts-allowed']);
		expect(styleChecksOf(plainDomain)).toEqual([]);
	});

	it('gives every domain the brand, and derives a chart profile from a brand-only skill', async () => {
		const styles = resolver({ 'acme/SKILL.md': skill('acme'), 'acme/brand.json': JSON.stringify(ACME) });
		const chart = await styles.resolve('chart');
		expect(chart.brand).toEqual(ACME);
		expect(chart.profile).toEqual(chartStyleFromBrand(ACME));
		expect(chart.sources).toMatchObject({ palette: 'org (brand)', 'theme.text': 'org (brand)', 'theme.fontFamily': 'org (brand)' });
		const tokens = await styles.resolve('tokens');
		expect(tokens.brand).toEqual(ACME);
		expect(tokens.profile).toEqual({});
		expect((await styles.resolve('brand')).profile).toEqual(ACME);
		expect(renderStyle(chart)).toContain('Brand (brand.json; place the logo as given, never redraw it)');
	});

	it('lets a domain profile refine what the brand derives, field by field', async () => {
		const styles = resolver({
			'acme/SKILL.md': skill('acme'),
			'acme/brand.json': JSON.stringify(ACME),
			'acme/chart.json': JSON.stringify({ palette: ['#000000'], theme: { text: '#222222' } })
		});
		const chart = await styles.resolve('chart');
		expect(chart.profile.palette).toEqual(['#000000']);
		expect(chart.profile.theme).toMatchObject({ text: '#222222', background: '#ffffff' });
		expect(chart.sources).toMatchObject({ palette: 'org', 'theme.text': 'org', 'theme.background': 'org (brand)' });
	});

	it('merges brands across layers, so a later layer can change one colour', async () => {
		const user = memoryStyleStore({ 'mine/SKILL.md': skill('mine'), 'mine/brand.json': JSON.stringify({ colors: { secondary: '#e4002b' } }) });
		const styles = resolver({ 'acme/SKILL.md': skill('acme'), 'acme/brand.json': JSON.stringify(ACME) }, [{ id: 'user', store: user }]);
		const chart = await styles.resolve('chart');
		expect(chart.brand?.colors).toMatchObject({ primary: '#0b5fff', secondary: '#e4002b' });
		expect(chart.profile.palette).toEqual(['#0b5fff', '#e4002b', '#12a150']);
		expect(chart.sources.palette).toBe('user (brand)');
	});

	it('applies a brand only to the domains its skill names', async () => {
		const styles = resolver({ 'acme/SKILL.md': skill('acme', 'domains: [chart]\n'), 'acme/brand.json': JSON.stringify(ACME) });
		expect((await styles.resolve('chart')).brand).toEqual(ACME);
		expect((await styles.resolve('tokens')).brand).toBeUndefined();
		expect((await styles.list())[0].issues).toEqual([]);
	});

	it('leaves out an invalid brand.json, saying why', async () => {
		const styles = resolver({ 'acme/SKILL.md': skill('acme'), 'acme/brand.json': JSON.stringify({ colors: { primary: 12 }, checks: [{ id: 'min-contrast', ratio: 40 }] }) });
		const chart = await styles.resolve('chart');
		expect(chart.brand).toBeUndefined();
		expect(chart.issues[0].message).toMatch(/^brand\.json is left out: \/colors\/primary: .* checks\[0\] \(min-contrast\)\/ratio: Must be <= 21\./);
	});

	it('runs the brand checks in every domain with a surface, and skips them where there is none', async () => {
		const styles = resolver({
			'acme/SKILL.md': skill('acme'),
			'acme/brand.json': JSON.stringify({ ...ACME, checks: ['palette-only', 'fonts-allowed', 'min-contrast'] })
		});
		const surface: StyleSurface = {
			colors: [
				{ color: '#0b5fff', label: 'Box A' },
				{ color: '#0c60ff', label: 'Box B (near)' },
				{ color: '#9933cc', label: 'Box C', target: 'c' },
				{ color: '#777777', label: 'Grey rule' },
				{ color: '#bbbbbb', label: 'Caption', use: 'text', background: '#ffffff', fontSize: 12, target: 'caption' }
			],
			fonts: [
				{ family: '"Source Serif", serif', label: 'Body' },
				{ family: 'system-ui', label: 'UI' },
				{ family: 'Comic Sans MS', label: 'Title', target: 'title' }
			]
		};
		const report = await styles.check('demo', surface);
		expect(report.ran).toEqual(['palette-only', 'fonts-allowed', 'min-contrast']);
		expect(report.findings.map((f) => [f.check, f.target, f.layer])).toEqual([
			['palette-only', 'c', 'org'],
			['fonts-allowed', 'title', 'org'],
			['min-contrast', 'caption', 'org']
		]);
		expect(report.findings[0].message).toBe('Box C uses #9933cc, which is not a house colour; the nearest is #0b5fff. Change it to #0b5fff or another palette colour.');
		expect(report.findings[2].message).toMatch(/#bbbbbb on #ffffff has a contrast ratio of 1\.\d\d; it needs 4\.5/);

		const plain = await styles.check('plain', {});
		expect(plain.ran).toEqual([]);
		expect(plain.skipped[0]).toEqual({ check: 'palette-only', reason: 'The brand asks for "palette-only", but plain cannot be checked against the brand yet.' });
	});

	it("runs a domain's own check in place of the shared one, and the domain profile's options win", async () => {
		const styles = resolver({
			'acme/SKILL.md': skill('acme'),
			'acme/brand.json': JSON.stringify({ ...ACME, checks: ['palette-only'] }),
			'acme/chart.json': JSON.stringify({ checks: [{ id: 'distinguishable' }] })
		});
		const controller = new ChartController();
		controller.setType('bar');
		controller.setData({ categories: ['a'], series: [{ id: 's', name: 'S', values: [1], color: '#9933cc' }] });
		const report = await styles.check('chart', controller.getSpec());
		expect(report.ran).toEqual(['distinguishable', 'palette-only']);
		expect(report.findings.find((f) => f.check === 'palette-only')?.target).toEqual({ kind: 'series', seriesId: 's' });
	});

	it('offers token colours to the shared checks, per mode', () => {
		const store = new TokenStore();
		store.transact('seed', () => {
			const c = store.createCollection('Brand', ['Light', 'Dark']);
			const v = store.createVariable({ collectionId: c.id, name: 'brand/primary', type: 'color', value: '#0b5fff' });
			store.setValue(v.id, '#99bbff', c.modes[1].id);
			store.createVariable({ collectionId: c.id, name: 'space/1', type: 'number', value: 4 });
		});
		const surface = tokensStyleSurface(store.getState());
		expect(surface.colors?.map((c) => [c.label, c.color])).toEqual([
			['brand/primary (Light)', '#0b5fff'],
			['brand/primary (Dark)', '#99bbff']
		]);
	});
});

describe('shared checks', () => {
	const run = (id: string, surface: StyleSurface, profile: Record<string, unknown> = {}, options: Record<string, unknown> = {}, brand = ACME) =>
		SHARED_STYLE_CHECKS.find((c) => c.id === id)!.run(surface, profile, options, { brand });

	it('palette-only: allows neutrals unless told not to, and a tolerance', () => {
		const surface = { colors: [{ color: '#808080', label: 'Grey' }, { color: '#0d61ff', label: 'Near' }] };
		expect(run('palette-only', surface)).toEqual([]);
		expect(run('palette-only', surface, {}, { allowNeutrals: false, tolerance: 0 }).map((f) => f.message)).toEqual([
			expect.stringMatching(/^Grey uses #808080/),
			expect.stringMatching(/^Near uses #0d61ff/)
		]);
		expect(() => run('palette-only', surface, {}, {}, {} as typeof ACME)).toThrow(/nor the brand has a palette/);
		// The profile's palette replaces the brand's.
		expect(run('palette-only', { colors: [{ color: '#ff00ff', label: 'X' }] }, { palette: ['#ff00ff'] }, {}, {} as typeof ACME)).toEqual([]);
	});

	it('min-contrast: needs less for large text', () => {
		const text = (fontSize: number, bold = false) => ({ colors: [{ color: '#767676', label: 'T', use: 'text' as const, background: '#ffffff', fontSize, bold }] });
		expect(run('min-contrast', text(12))).toEqual([]); // 4.54
		expect(run('min-contrast', text(12), {}, { ratio: 7 })).toHaveLength(1);
		expect(run('min-contrast', text(24), {}, { ratio: 7, largeRatio: 4.5 })).toEqual([]);
		expect(run('min-contrast', text(19, true), {}, { ratio: 7, largeRatio: 4.5 })).toEqual([]);
	});

	it('distinguishable: compares series colours only', () => {
		const surface = {
			colors: [
				{ color: '#0b5fff', label: 'A', use: 'series' as const },
				{ color: '#0c60ff', label: 'B', use: 'series' as const, target: 'b' },
				{ color: '#0b5fff', label: 'Fill' }
			]
		};
		const findings = run('distinguishable', surface);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ severity: 'warning', target: 'b' });
	});

	it('fonts-allowed: takes the option, then the profile, then the brand', () => {
		const surface = { fonts: [{ family: 'Inter', label: 'Heading' }] };
		expect(run('fonts-allowed', surface)).toEqual([]);
		expect(run('fonts-allowed', surface, { fonts: ['Roboto'] })).toHaveLength(1);
		expect(run('fonts-allowed', surface, { fonts: ['Roboto'] }, { fonts: ['inter'] })).toEqual([]);
		expect(() => run('fonts-allowed', surface, {}, {}, {} as typeof ACME)).toThrow(/names any fonts/);
	});
});

describe('agent path', () => {
	it('get_style returns the brand, and check_chart_style runs the brand checks', async () => {
		const store = memoryStyleStore({ 'acme/SKILL.md': skill('acme'), 'acme/brand.json': JSON.stringify({ ...ACME, checks: ['palette-only'] }) });
		const styles = createStyleResolver({ layers: [{ id: 'org', store }], domains: [chartStyleDomain] });
		const controller = new ChartController();
		controller.setType('bar');
		controller.setData({ categories: ['a'], series: [{ id: 's', name: 'S', values: [1], color: '#9933cc' }] });
		const registry = new ToolRegistry();
		registry.register(createStyleToolProvider(styles));
		registry.register(createChartStyleToolProvider(controller, styles));

		const style = await registry.callTool('get_style', { domain: 'chart' });
		expect(style.structuredContent).toMatchObject({ brand: ACME, profile: { palette: ['#0b5fff', '#ff6a00', '#12a150'] }, sources: { palette: 'org (brand)' } });
		const brand = await registry.callTool('get_style', { domain: 'brand' });
		expect(brand.structuredContent).toMatchObject({ domain: 'brand', profile: { name: 'Acme' } });
		const schema = await registry.callTool('get_style_schema', { domain: 'brand' });
		expect(JSON.stringify(schema.structuredContent)).toContain('fonts-allowed');

		const check = await registry.callTool('check_chart_style', {});
		expect(check.isError).toBeFalsy();
		expect(check.structuredContent).toMatchObject({ ok: false, ran: ['palette-only'], findings: [{ check: 'palette-only', target: { kind: 'series', seriesId: 's' } }] });
	});
});
