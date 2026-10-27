import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
	createTypographyToolProvider,
	createFontPickerToolProvider,
	createCatalogFontProvider,
	createWebFontProvider,
	FontPickerModel,
	type FontProvider,
	type FontSummary
} from '../src/typography';

const FONTS: FontSummary[] = [
	{ family: 'Inter', category: 'sans-serif', weights: [100, 900], styles: ['normal', 'italic'], isVariable: true, source: 'web' },
	{ family: 'Lora', category: 'serif', weights: [400, 700], styles: ['normal'], source: 'custom' },
	{ family: 'Menlo', category: 'monospace', weights: [400, 700], styles: ['normal', 'italic'], source: 'system' }
];

function registry(provider?: FontProvider) {
	const r = new ToolRegistry();
	r.register(createTypographyToolProvider({ provider: provider ?? createCatalogFontProvider(FONTS) }));
	return r;
}

const call = async (r: ToolRegistry, name: string, args: Record<string, unknown>) => {
	const res = await r.callTool(name, args);
	return { res, data: res.structuredContent as any, text: (res.content?.[0] as any)?.text as string };
};

describe('createTypographyToolProvider', () => {
	it('exposes every tool with titles, annotations and described arguments', () => {
		const tools = registry().listTools().tools;
		expect(tools.map((t) => t.name).sort()).toEqual(
			[
				'typography__audit_text_readability',
				'typography__check_typography_accessibility',
				'typography__compute_fluid_type_size',
				'typography__generate_type_hierarchy',
				'typography__list_fonts',
				'typography__load_font',
				'typography__resolve_font_stack',
				'typography__segment_text',
				'typography__suggest_type_scale'
			].sort()
		);
		for (const t of tools) {
			expect(t.title).toBeTruthy();
			expect(t.annotations?.title).toBe(t.title);
			for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) expect(typeof t.annotations?.[hint]).toBe('boolean');
			expect(t.inputSchema.additionalProperties).toBe(false);
			for (const [k, p] of Object.entries(t.inputSchema.properties ?? {})) expect((p as any).description, `${t.name}.${k}`).toBeTruthy();
		}
	});

	it('hides load_font when the provider cannot load', () => {
		const r = registry({ id: 'x', listFonts: async () => FONTS, hasFont: () => true });
		expect(r.listTools().tools.some((t) => t.name.endsWith('load_font'))).toBe(false);
	});

	it('defaults to the system catalog', async () => {
		const r = new ToolRegistry();
		r.register(createTypographyToolProvider());
		const { data } = await call(r, 'list_fonts', { category: 'monospace', limit: 3 });
		expect(data.fonts).toHaveLength(3);
		expect(data.total).toBeGreaterThan(3);
		expect(data.truncated).toBe(true);
	});

	it('list_fonts filters and validates', async () => {
		const r = registry();
		expect((await call(r, 'list_fonts', {})).data.fonts.map((f: any) => f.family)).toEqual(['Inter', 'Lora', 'Menlo']);
		expect((await call(r, 'list_fonts', { weight: 300 })).data.fonts.map((f: any) => f.family)).toEqual(['Inter']);
		expect((await call(r, 'list_fonts', { style: 'italic', source: 'system' })).data.fonts.map((f: any) => f.family)).toEqual(['Menlo']);
		expect((await call(r, 'list_fonts', { query: 'lo' })).data.fonts.map((f: any) => f.family)).toEqual(['Lora', 'Menlo']);
		const bad = await call(r, 'list_fonts', { category: 'gothic' });
		expect(bad.res.isError).toBe(true);
		expect((await call(r, 'list_fonts', { weight: 450 })).res.isError).toBe(true);
	});

	it('resolve_font_stack builds a fallback and says whether the font is offered', async () => {
		const r = registry();
		const { data } = await call(r, 'resolve_font_stack', { family: 'Lora' });
		expect(data.category).toBe('serif');
		expect(data.available).toBe(true);
		expect(data.stack.endsWith('serif')).toBe(true);
		expect(data.families[0]).toBe('Lora');
		const unknown = await call(r, 'resolve_font_stack', { family: 'Fira Code' });
		expect(unknown.data).toMatchObject({ category: 'monospace', available: false });
		const err = await call(r, 'resolve_font_stack', { family: ' , ' });
		expect(err.res.isError).toBe(true);
		expect(err.text).toMatch(/at least one font/);
	});

	it('suggest_type_scale and generate_type_hierarchy', async () => {
		const r = registry();
		const scale = await call(r, 'suggest_type_scale', { baseSize: 18, ratio: 1.5, steps: [0, 1, 2] });
		expect(scale.data.steps.map((s: any) => s.size)).toEqual([18, 27, 40.5]);
		expect((await call(r, 'suggest_type_scale', {})).data.steps).toHaveLength(8);
		expect((await call(r, 'suggest_type_scale', { ratio: 'tiny' })).res.isError).toBe(true);
		expect((await call(r, 'suggest_type_scale', { ratio: 1 })).res.isError).toBe(true);

		const h = await call(r, 'generate_type_hierarchy', { ratio: 'golden-ratio', prefix: 'type' });
		expect(h.data.ratioName).toBe('golden-ratio');
		expect(h.data.steps.body.size).toBe(16);
		expect(h.data.css).toContain('--type-h1-size');
		expect((await call(r, 'generate_type_hierarchy', { prefix: 'Bad Prefix' })).res.isError).toBe(true);
	});

	it('compute_fluid_type_size returns clamp and samples', async () => {
		const r = registry();
		const { data } = await call(r, 'compute_fluid_type_size', { minSize: 16, maxSize: 24, minViewport: 400, maxViewport: 1200 });
		expect(data.clampCss).toBe('clamp(1rem, 1vw + 0.75rem, 1.5rem)');
		expect(data.samples).toEqual([
			{ viewport: 400, size: 16 },
			{ viewport: 800, size: 20 },
			{ viewport: 1200, size: 24 }
		]);
		const bad = await call(r, 'compute_fluid_type_size', { minSize: 16, maxSize: 24, minViewport: 1200, maxViewport: 400 });
		expect(bad.res.isError).toBe(true);
		expect(bad.text).toMatch(/maxViewport/);
		expect((await call(r, 'compute_fluid_type_size', { minSize: 16 })).res.isError).toBe(true);
	});

	it('audit_text_readability audits and requires fontSize with width', async () => {
		const r = registry();
		const { data } = await call(r, 'audit_text_readability', { text: 'A short paragraph of text.', width: 900, fontSize: 16, lineHeight: 1.3 });
		expect(data.lineLength).toMatchObject({ source: 'width', status: 'too-long' });
		expect(data.lineSpacing.meetsRecommended).toBe(false);
		expect(data.issues.length).toBeGreaterThan(0);
		const err = await call(r, 'audit_text_readability', { text: 'x', width: 500 });
		expect(err.res.isError).toBe(true);
		expect(err.text).toMatch(/needs fontSize/);
	});

	it('check_typography_accessibility decides large text itself', async () => {
		const r = registry();
		const small = await call(r, 'check_typography_accessibility', { foreground: '#949494', background: 'white', fontSize: 16 });
		expect(small.data).toMatchObject({ large: false, passesAA: false });
		expect(small.data.suggestion).toMatch(/^#[0-9a-f]{6}$/);
		const boldLarge = await call(r, 'check_typography_accessibility', { foreground: '#949494', background: 'white', fontSize: 19, fontWeight: 'bold' });
		expect(boldLarge.data).toMatchObject({ large: true, passesAA: true });
		const bad = await call(r, 'check_typography_accessibility', { foreground: 'blurple', background: 'white', fontSize: 16 });
		expect(bad.res.isError).toBe(true);
		expect(bad.text).toMatch(/not a colour/);
	});

	it('segment_text splits and validates options per granularity', async () => {
		const r = registry();
		const { data } = await call(r, 'segment_text', { text: 'Hi there, you!', granularity: 'word', wordsOnly: true });
		expect(data.count).toBe(3);
		expect(data.segments.map((s: any) => [s.text, s.start, s.end])).toEqual([
			['Hi', 0, 2],
			['there', 3, 8],
			['you', 10, 13]
		]);
		const lines = await call(r, 'segment_text', { text: 'one two three four', granularity: 'line', maxCharacters: 8 });
		expect(lines.data.segments.map((s: any) => s.text)).toEqual(['one two ', 'three ', 'four']);
		expect((await call(r, 'segment_text', { text: 'x', granularity: 'grapheme', wordsOnly: true })).res.isError).toBe(true);
		expect((await call(r, 'segment_text', { text: 'x', granularity: 'word', maxCharacters: 3 })).res.isError).toBe(true);
		expect((await call(r, 'segment_text', { text: 'x', granularity: 'paragraph' })).res.isError).toBe(true);
	});

	it('load_font loads through the provider without the network', async () => {
		const createFontFace = vi.fn(() => ({ load: () => Promise.resolve() }));
		const web = createWebFontProvider({ fonts: [{ family: 'Brand', category: 'serif', sources: [{ url: 'https://example.test/brand.woff2' }] }], createFontFace, fontFaceSet: { add() {} } });
		const r = registry(web);
		const { data } = await call(r, 'load_font', { family: 'brand', weight: 'bold' });
		expect(data).toEqual({ family: 'Brand', weight: 700, style: 'normal', loaded: true });
		expect(createFontFace).toHaveBeenCalledTimes(1);
		const missing = await call(r, 'load_font', { family: 'Nope' });
		expect(missing.res.isError).toBe(true);
		expect(missing.text).toMatch(/list_fonts/);
	});
});

describe('createFontPickerToolProvider', () => {
	function setup(readOnly?: () => string | false) {
		const onChange = vi.fn();
		const model = new FontPickerModel({ fonts: FONTS, value: { family: 'Lora', size: 18 }, onChange, loadOnSelect: false });
		const r = new ToolRegistry();
		r.register(createFontPickerToolProvider(model, { readOnly }));
		return { model, r, onChange };
	}

	it('exposes described tools', () => {
		const { r } = setup();
		const tools = r.listTools().tools;
		expect(tools.map((t) => t.name).sort()).toEqual(['fontpicker__get_font_selection', 'fontpicker__list_picker_fonts', 'fontpicker__set_font_selection']);
		for (const t of tools) {
			expect(t.annotations?.title).toBe(t.title);
			for (const [k, p] of Object.entries(t.inputSchema.properties ?? {})) expect((p as any).description, `${t.name}.${k}`).toBeTruthy();
		}
	});

	it('reads, lists and changes the selection in one step', async () => {
		const { r, model, onChange } = setup();
		const got = await call(r, 'get_font_selection', {});
		expect(got.data.value).toMatchObject({ family: 'Lora', size: 18, weight: 400 });
		expect(got.data.availableWeights).toEqual([400, 700]);
		expect(got.data.css.fontFamily.startsWith('Lora,')).toBe(true);

		const set = await call(r, 'set_font_selection', { family: 'inter', weight: 300, style: 'italic', size: 20, lineHeight: 1.4, letterSpacing: -0.01 });
		expect(set.data.value).toEqual({ family: 'Inter', weight: 300, style: 'italic', size: 20, lineHeight: 1.4, letterSpacing: -0.01, category: 'sans-serif' });
		expect(model.value.family).toBe('Inter');
		expect(onChange).toHaveBeenCalled();

		const listed = await call(r, 'list_picker_fonts', { category: 'serif' });
		expect(listed.data.fonts.map((f: any) => f.family)).toEqual(['Lora']);
		expect(listed.data.recent).toEqual(['Inter']);
	});

	it('snaps weights and refuses bad input without changing anything', async () => {
		const { r, model } = setup();
		expect((await call(r, 'set_font_selection', { weight: 900 })).data.value.weight).toBe(700);
		const before = model.getState();
		const unknown = await call(r, 'set_font_selection', { family: 'Comic', size: 30 });
		expect(unknown.res.isError).toBe(true);
		expect(unknown.text).toMatch(/list_fonts/);
		const noItalic = await call(r, 'set_font_selection', { style: 'italic', size: 30 });
		expect(noItalic.res.isError).toBe(true);
		expect(noItalic.text).toMatch(/no italic style/);
		expect((await call(r, 'set_font_selection', {})).res.isError).toBe(true);
		expect((await call(r, 'set_font_selection', { size: 5000 })).res.isError).toBe(true);
		expect(model.getState()).toBe(before);
	});

	it('refuses writes while read-only but still reads', async () => {
		const { r } = setup(() => 'the document is locked');
		expect((await call(r, 'get_font_selection', {})).res.isError).toBeFalsy();
		const res = await call(r, 'set_font_selection', { size: 20 });
		expect(res.res.isError).toBe(true);
		expect(res.text).toMatch(/read-only: the document is locked/);
	});
});
