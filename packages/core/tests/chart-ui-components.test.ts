// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHART_UI_RENDER_VERSIONS, uiComponents, type ChartUiComponent } from '../src/chart';
import { validateJsonSchema, type JsonSchema } from '../src/tools/schema';

const descriptorSchema = JSON.parse(readFileSync(join(__dirname, 'fixtures/ui-descriptor.schema.json'), 'utf8')) as JsonSchema;

const byId = (id: string): ChartUiComponent => uiComponents().find((c) => c.id === id)!;

const parseSvg = (svg: string): SVGSVGElement => {
	const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
	expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
	expect(doc.documentElement.tagName).toBe('svg');
	return doc.documentElement as unknown as SVGSVGElement;
};

const colorsIn = (svg: string) => new Set([...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]!.toLowerCase()));

describe('uiComponents', () => {
	it('lists the sparkline and the bar chart as data visuals', () => {
		const list = uiComponents();
		expect(list.map((c) => c.id)).toEqual(['sparkline', 'bar-chart']);
		for (const c of list) {
			expect(c.descriptor.implements).toBe(c.id);
			expect(c.descriptor.group).toBe('data-visual');
			expect(c.descriptor.platforms).toEqual(['html-page']);
			expect(c.title).toBeTruthy();
			expect(c.description).toBeTruthy();
		}
	});

	it('gives descriptors that validate against the @pixerate/schemas UiDescriptor JSON Schema', () => {
		for (const c of uiComponents()) {
			// A registry stores the descriptor as JSON, so it must survive a round trip unchanged.
			const json = JSON.parse(JSON.stringify(c.descriptor));
			expect(json).toEqual(c.descriptor);
			expect(validateJsonSchema(json, descriptorSchema)).toEqual([]);
		}
		expect(validateJsonSchema({ implements: '', platforms: [] }, descriptorSchema)).not.toEqual([]);
	});

	it('has well-formed contracts: props schemas the example satisfies, a11y, motion and sizing', () => {
		for (const c of uiComponents()) {
			const contract = c.descriptor.contract!;
			expect(contract.props).toMatchObject({ type: 'object', additionalProperties: false });
			expect(validateJsonSchema(c.descriptor.example, contract.props as JsonSchema)).toEqual([]);
			expect(contract.a11y).toEqual({ role: 'img', keyboard: {}, labelFrom: 'content' });
			expect(contract.motion).toBe(false);
			expect(contract.sizing?.minWidth).toBeGreaterThan(0);
			expect(contract.colorRoles!.length).toBeGreaterThan(0);
			// Every role is documented and has a default in both themes.
			expect(Object.keys(c.colorRoleUse).sort()).toEqual([...contract.colorRoles!].sort());
			for (const mode of ['light', 'dark'] as const) expect(Object.keys(c.defaultColors[mode]).sort()).toEqual([...contract.colorRoles!].sort());
		}
		expect(byId('sparkline').descriptor.contract!.props).toMatchObject({ required: ['values'] });
		expect(byId('bar-chart').descriptor.contract!.props).toMatchObject({ required: ['categories', 'series'] });
	});

	it.each(['sparkline', 'bar-chart'])('renders the %s example as valid, labelled SVG in light and dark', (id) => {
		const c = byId(id);
		const size = id === 'sparkline' ? { width: 120, height: 24 } : { width: 480, height: 300 };
		const light = c.render(c.descriptor.example, { ...size, theme: 'light' });
		const dark = c.render(c.descriptor.example, { ...size, theme: 'dark' });
		for (const svg of [light, dark]) {
			const el = parseSvg(svg);
			expect(el.getAttribute('role')).toBe('img');
			expect(el.getAttribute('width')).toBe(String(size.width));
			expect(el.getAttribute('aria-label')).toBeTruthy();
			expect(el.querySelector('desc')?.textContent).toMatch(/chart/);
			expect(el.querySelectorAll('path, rect').length).toBeGreaterThan(0);
		}
		expect(light).not.toBe(dark);
		for (const color of Object.values(c.defaultColors.dark)) expect(colorsIn(dark).has(color.toLowerCase())).toBe(true);
	});

	it('draws the bar chart with the role colours it is given', () => {
		const c = byId('bar-chart');
		const colors = { surface: '#101010', ink: '#fafafa', 'ink-muted': '#a1a1aa', border: '#27272a', accent: '#ff00aa' };
		const svg = c.render(c.descriptor.example, { width: 480, height: 300, theme: 'dark', colors });
		const used = colorsIn(svg);
		for (const color of Object.values(colors)) expect(used.has(color)).toBe(true);
		// The first series takes the accent; the default dark accent is gone.
		expect(used.has(c.defaultColors.dark.accent!.toLowerCase())).toBe(false);
		const el = parseSvg(svg);
		expect(el.querySelector('rect[fill="#101010"]')).not.toBeNull();
		expect([...el.querySelectorAll('text')].some((t) => t.getAttribute('fill') === '#fafafa' && t.textContent === 'Quarterly revenue')).toBe(true);
	});

	it('draws the sparkline line in the accent role, takes CSS variables, and ignores roles it does not use', () => {
		const c = byId('sparkline');
		const svg = c.render({ values: [1, 3, 2, 5] }, { width: 100, height: 20, colors: { accent: 'var(--accent, #123456)', danger: '#ff0000' } });
		const path = parseSvg(svg).querySelector('path')!;
		expect(path.getAttribute('stroke')).toBe('var(--accent, #123456)');
		expect(svg).not.toContain('#ff0000');
		// Without a label, the accessible name is a description built from the data.
		expect(parseSvg(svg).getAttribute('aria-label')).toMatch(/line chart/i);
	});

	it('writes the unit after values and hides the legend for one series', () => {
		const c = byId('bar-chart');
		const one = c.render({ categories: ['A', 'B'], series: [{ name: 'Only', values: [10, 20] }], unit: '%' }, { width: 320, height: 200 });
		expect(one).toMatch(/>\d+%</);
		expect(one).not.toContain('>Only<');
		const two = c.render(c.descriptor.example, { width: 480, height: 300 });
		expect(two).toContain('>2025<');
		expect(two).toContain('>2026<');
	});

	it('refuses bad data and sizes with errors that say what to fix', () => {
		const bar = byId('bar-chart');
		const spark = byId('sparkline');
		expect(() => spark.render({ values: [] }, { width: 100, height: 20 })).toThrow(/sparkline: invalid data: \/values/);
		expect(() => spark.render({ values: [1, 'x'] }, { width: 100, height: 20 })).toThrow(/invalid data/);
		expect(() => spark.render({ values: [1], extra: true }, { width: 100, height: 20 })).toThrow(/invalid data/);
		expect(() => bar.render({ categories: ['A'], series: [{ name: 'S', values: [1, 2] }] }, { width: 300, height: 200 })).toThrow(/series "S" has 2 values for 1 categories/);
		expect(() => bar.render(bar.descriptor.example, { width: 0, height: 200 })).toThrow(/width must be a number of CSS px from 1 to 4096/);
		expect(() => bar.render(bar.descriptor.example, { width: 300, height: 200, theme: 'sepia' as never })).toThrow(/theme must be "light" or "dark"/);
	});

	it('has stable content hashes that change with the render version', async () => {
		const first = uiComponents().map((c) => c.descriptor.contentHash);
		expect(first.every((h) => /^h1-[0-9a-f]{16}$/.test(h!))).toBe(true);
		expect(new Set(first).size).toBe(2);
		// Pinned: a change to a type's contract, example or drawing must change its hash. When it
		// does on purpose, update these (and bump CHART_UI_RENDER_VERSIONS if only the drawing moved).
		expect(Object.fromEntries(uiComponents().map((c) => [c.id, c.descriptor.contentHash]))).toMatchInlineSnapshot(`
			{
			  "bar-chart": "h1-bc3ada602d46f641",
			  "sparkline": "h1-30ef47f4426f81fe",
			}
		`);
		expect(CHART_UI_RENDER_VERSIONS).toEqual({ sparkline: 1, 'bar-chart': 1 });
		// A fresh module (a new run) computes the same hashes.
		const { vi } = await import('vitest');
		vi.resetModules();
		const fresh = await import('../src/chart/ui-components');
		expect(fresh.uiComponents().map((c) => c.descriptor.contentHash)).toEqual(first);
	});

	it('hands out copies, so a caller cannot change the shared descriptors', () => {
		const a = uiComponents()[0]!;
		a.descriptor.contract!.colorRoles!.push('danger');
		(a.descriptor.example as Record<string, unknown>).values = [];
		const b = uiComponents()[0]!;
		expect(b.descriptor.contract!.colorRoles).toEqual(['accent']);
		expect((b.descriptor.example as { values: number[] }).values.length).toBe(10);
	});
});
