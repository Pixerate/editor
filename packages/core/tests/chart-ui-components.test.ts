// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHART_UI_RENDER_VERSIONS, uiComponents, type ChartUiComponent } from '../src/chart';
import { createLinkFocus } from '../src/interaction/linkFocus';
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
	it('lists the chart types and the data visuals', () => {
		const list = uiComponents();
		expect(list.map((c) => c.id)).toEqual(['sparkline', 'bar-chart', 'line-chart', 'donut-chart', 'lineage', 'braid', 'weave']);
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
			if (c.interaction) {
				// Interactive visuals: a focus state and event, the keyboard walk, and motion.
				expect(contract.a11y).toMatchObject({ role: 'img', labelFrom: 'content', reducedMotionAt: 1 });
				expect(Object.keys(contract.a11y!.keyboard)).toEqual(['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End', 'Escape']);
				expect(contract.state).toEqual([expect.objectContaining({ name: 'focus', event: 'focus' })]);
				expect(contract.events!.map((e) => e.name)).toEqual(['focus']);
				expect(contract.motion).toBe(true);
			} else {
				expect(contract.a11y).toEqual({ role: 'img', keyboard: {}, labelFrom: 'content' });
				expect(contract.motion).toBe(false);
			}
			expect(contract.sizing?.minWidth).toBeGreaterThan(0);
			expect(contract.colorRoles!.length).toBeGreaterThan(0);
			// Every role is documented and has a default in both themes.
			expect(Object.keys(c.colorRoleUse).sort()).toEqual([...contract.colorRoles!].sort());
			for (const mode of ['light', 'dark'] as const) expect(Object.keys(c.defaultColors[mode]).sort()).toEqual([...contract.colorRoles!].sort());
		}
		expect(byId('sparkline').descriptor.contract!.props).toMatchObject({ required: ['values'] });
		expect(byId('bar-chart').descriptor.contract!.props).toMatchObject({ required: ['categories', 'series'] });
	});

	const SIZES: Record<string, { width: number; height: number }> = { sparkline: { width: 120, height: 24 }, 'bar-chart': { width: 480, height: 300 }, 'line-chart': { width: 480, height: 300 }, 'donut-chart': { width: 360, height: 260 }, lineage: { width: 560, height: 220 }, braid: { width: 560, height: 200 }, weave: { width: 560, height: 280 } };

	it.each(['sparkline', 'bar-chart', 'line-chart', 'donut-chart', 'lineage', 'braid', 'weave'])('renders the %s example as valid, labelled SVG in light and dark', (id) => {
		const c = byId(id);
		const size = SIZES[id]!;
		const light = c.render(c.descriptor.example, { ...size, theme: 'light' });
		const dark = c.render(c.descriptor.example, { ...size, theme: 'dark' });
		for (const svg of [light, dark]) {
			const el = parseSvg(svg);
			expect(el.getAttribute('role')).toBe('img');
			expect(el.getAttribute('width')).toBe(String(size.width));
			expect(el.getAttribute('aria-label')).toBeTruthy();
			expect(el.querySelector('desc')?.textContent).toMatch(/chart|Lineage|Braid|items and/);
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
		expect(new Set(first).size).toBe(7);
		// Pinned: a change to a type's contract, example or drawing must change its hash. When it
		// does on purpose, update these (and bump CHART_UI_RENDER_VERSIONS if only the drawing moved).
		expect(Object.fromEntries(uiComponents().map((c) => [c.id, c.descriptor.contentHash]))).toMatchInlineSnapshot(`
			{
			  "bar-chart": "h1-bc3ada602d46f641",
			  "braid": "h1-a1fef74af5e165b4",
			  "donut-chart": "h1-de9b95e9a3a4d386",
			  "line-chart": "h1-996e92fc381f9c29",
			  "lineage": "h1-80fbdcdee156c4aa",
			  "sparkline": "h1-30ef47f4426f81fe",
			  "weave": "h1-6a819cc804a71672",
			}
		`);
		expect(CHART_UI_RENDER_VERSIONS).toEqual({ sparkline: 1, 'bar-chart': 1, 'line-chart': 1, 'donut-chart': 1, lineage: 1, braid: 1, weave: 1 });
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

describe('data visuals with motion and linked focus', () => {
	const visuals = ['lineage', 'braid', 'weave'] as const;
	const SIZE = { lineage: { width: 560, height: 220 }, braid: { width: 560, height: 200 }, weave: { width: 560, height: 280 } } as const;

	it.each(visuals)('%s draws on: hidden at p = 0, partly drawn midway, whole at p = 1 (the default)', (id) => {
		const c = byId(id);
		const size = SIZE[id];
		const rest = c.render(c.descriptor.example, size);
		expect(c.render(c.descriptor.example, { ...size, progress: 1 })).toBe(rest);
		expect(rest).not.toContain('stroke-dasharray');
		const start = parseSvg(c.render(c.descriptor.example, { ...size, progress: 0 }));
		const strokes = [...start.querySelectorAll('path')];
		expect(strokes.length).toBeGreaterThan(0);
		expect(strokes.every((path) => path.getAttribute('visibility') === 'hidden')).toBe(true);
		const mid = c.render(c.descriptor.example, { ...size, progress: 0.5 });
		expect(mid).toContain('stroke-dasharray');
		expect(mid).not.toBe(rest);
		// Frame-pure: the same progress draws the same picture.
		expect(c.render(c.descriptor.example, { ...size, progress: 0.5 })).toBe(mid);
	});

	it.each(visuals)('%s gives linked-focus options that drive a model, and lights the focused marks', (id) => {
		const c = byId(id);
		const options = c.interaction!(c.descriptor.example);
		const model = createLinkFocus({ ...options, dim: 0.2 });
		expect(model.order.length).toBeGreaterThan(1);
		const key = model.order[1]!;
		model.focus(key);
		const svg = parseSvg(c.render(c.descriptor.example, { ...SIZE[id], focus: key, dim: 0.2 }));
		const focused = [...svg.querySelectorAll('[data-link-focus]')];
		// Every mark tagged with the focused key alone is at full strength; some others are dimmed.
		// (A braid's back runs are drawn at 0.6 whether lit or not.)
		for (const mark of focused.filter((m) => m.getAttribute('data-link-focus') === key)) expect([null, '0.6']).toContain(mark.getAttribute('opacity'));
		expect(focused.some((m) => m.getAttribute('opacity') === '0.2' || m.getAttribute('opacity') === '0.12')).toBe(true);
		expect(model.describe()).toMatch(/of \d+/);
	});

	it('lights an item, its tags and only their links in the weave', () => {
		const c = byId('weave');
		const svg = parseSvg(c.render(c.descriptor.example, { width: 560, height: 280, focus: 'item-0' }));
		const lit = [...svg.querySelectorAll('[data-link-focus]')].filter((m) => m.getAttribute('opacity') === null).map((m) => m.getAttribute('data-link-focus'));
		// Atlas has Design (tag-0) and Research (tag-1).
		expect(lit.sort()).toEqual(['item-0', 'item-0 tag-0', 'item-0 tag-1', 'tag-0', 'tag-1'].sort());
	});

	it('refuses focus keys, progress and data it cannot draw', () => {
		const weave = byId('weave');
		const braid = byId('braid');
		expect(() => weave.render(weave.descriptor.example, { width: 560, height: 280, focus: 'nope' })).toThrow(/weave: focus "nope" is not one of its keys \(item-0/);
		expect(() => weave.render(weave.descriptor.example, { width: 560, height: 280, progress: 2 })).toThrow(/progress must be a number from 0 to 1/);
		expect(() => weave.render(weave.descriptor.example, { width: 560, height: 280, dim: -1 })).toThrow(/dim must be a number from 0 to 1/);
		const many = { items: [{ label: 'X', tags: Array.from({ length: 25 }, (_, i) => `t${i}`.padEnd(2, 'x')) }] };
		expect(() => weave.render(many, { width: 560, height: 280 })).toThrow(/invalid data|25 different tags/);
		expect(() => braid.render({ strands: [{ name: 'One' }] }, { width: 400, height: 200 })).toThrow(/braid: invalid data/);
		expect(() => braid.interaction!({ strands: [] })).toThrow(/braid: invalid data/);
	});

	it('weights braid strands by value and labels every strand', () => {
		const c = byId('braid');
		const svg = parseSvg(c.render({ strands: [{ name: 'Heavy', value: 10 }, { name: 'Light', value: 1 }], root: 'Root' }, { width: 480, height: 180 }));
		const widths = (key: string) => new Set([...svg.querySelectorAll(`path[data-link-focus="${key}"]`)].map((p) => Number(p.getAttribute('stroke-width'))));
		expect([...widths('strand-0')][0]).toBeGreaterThan([...widths('strand-1')][0]!);
		expect([...svg.querySelectorAll('text')].map((t) => t.textContent)).toEqual(expect.arrayContaining(['Heavy', 'Light', 'Root']));
	});

	it('fits lineage labels to their columns and wraps long ones', () => {
		const c = byId('lineage');
		const items = Array.from({ length: 12 }, (_, i) => ({ label: `Department number ${i + 1}` }));
		const svg = parseSvg(c.render({ root: 'Company', items }, { width: 600, height: 240 }));
		const sizes = new Set([...svg.querySelectorAll('text[font-size]')].slice(1).map((t) => Number(t.getAttribute('font-size'))));
		expect(sizes.size).toBe(1);
		expect([...sizes][0]).toBeLessThanOrEqual(14);
		expect(svg.querySelectorAll('tspan').length).toBeGreaterThan(12);
	});
});
