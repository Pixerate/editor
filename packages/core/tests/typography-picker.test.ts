import { describe, it, expect, vi } from 'vitest';
import { FontPickerModel, createFontPicker, createCatalogFontProvider, offeredWeights, type FontProvider, type FontSummary } from '../src/typography';
import { effectControlField, effectParameterFields, effectFontFamilies, isEffectFontControl } from '../src/effects';

const FONTS: FontSummary[] = [
	{ family: 'Inter', category: 'sans-serif', weights: [200, 800], styles: ['normal', 'italic'], isVariable: true, source: 'web' },
	{ family: 'Lora', category: 'serif', weights: [400, 700], styles: ['normal'], source: 'custom' },
	{ family: 'Menlo', category: 'monospace', weights: [400, 700], styles: ['normal', 'italic'], source: 'system' },
	{ family: 'Literata', category: 'serif', weights: [300, 400], styles: ['normal'], source: 'web' }
];

describe('FontPickerModel', () => {
	it('starts from the value or the first font', () => {
		const m = new FontPickerModel({ fonts: FONTS });
		expect(m.value).toEqual({ family: 'Inter', weight: 400, style: 'normal', size: 16, lineHeight: 1.5, letterSpacing: 0, category: 'sans-serif' });
		expect(new FontPickerModel({ fonts: FONTS, value: { family: 'lora', weight: 'bold' } }).value).toMatchObject({ family: 'Lora', weight: 700, category: 'serif' });
		expect(new FontPickerModel().value.family).toBe('system-ui');
	});

	it('filters by category and query, and keeps state identity until a change', () => {
		const m = createFontPicker({ fonts: FONTS });
		const s0 = m.getState();
		expect(m.getState()).toBe(s0);
		m.setCategory('serif');
		expect(m.getState().results.map((f) => f.family)).toEqual(['Lora', 'Literata']);
		m.setQuery('lit');
		expect(m.getState().results.map((f) => f.family)).toEqual(['Literata']);
		m.setCategory('all');
		m.setQuery('n');
		expect(m.getState().results.map((f) => f.family)).toEqual(['Inter', 'Menlo']);
		expect(() => m.setCategory('gothic' as never)).toThrow(/Unknown category/);
	});

	it('selects families, snapping weight and style, and records recents', () => {
		const onChange = vi.fn();
		const m = new FontPickerModel({ fonts: FONTS, value: { family: 'Inter', weight: 600, style: 'italic' }, onChange, maxRecent: 2, loadOnSelect: false });
		m.selectFamily('Lora');
		expect(m.value).toMatchObject({ family: 'Lora', weight: 700, style: 'normal', category: 'serif' });
		expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ family: 'Lora' }));
		m.selectFamily('Menlo');
		m.selectFamily('Literata');
		expect(m.getState().recent.map((f) => f.family)).toEqual(['Literata', 'Menlo']);
		expect(m.value.weight).toBe(400);
		expect(() => m.selectFamily('Comic Sans')).toThrow(/not available/);
	});

	it('weights, styles and metrics are validated and clamped', () => {
		const m = new FontPickerModel({ fonts: FONTS, value: { family: 'Inter' } });
		expect(m.availableWeights).toEqual([200, 300, 400, 500, 600, 700, 800]);
		m.setWeight(900);
		expect(m.value.weight).toBe(800);
		m.setStyle('italic');
		expect(m.value.style).toBe('italic');
		expect(() => m.setStyle('slanted' as never)).toThrow();
		m.setSize(0);
		expect(m.value.size).toBe(1);
		m.setSize(Number.NaN);
		expect(m.value.size).toBe(1);
		m.setLineHeight(9);
		expect(m.value.lineHeight).toBe(4);
		m.setLetterSpacing(-2);
		expect(m.value.letterSpacing).toBe(-0.5);
		expect(m.css).toEqual({ fontFamily: expect.stringMatching(/^Inter, system-ui/), fontWeight: '800', fontStyle: 'italic', fontSize: '1px', lineHeight: '4', letterSpacing: '-0.5em' });
		expect(offeredWeights(undefined)).toHaveLength(9);
	});

	it('setValue is silent and skips no-op updates', () => {
		const onChange = vi.fn();
		const listener = vi.fn();
		const m = new FontPickerModel({ fonts: FONTS, onChange });
		m.subscribe(listener);
		m.setValue({ family: 'Menlo', size: 13 });
		expect(m.value).toMatchObject({ family: 'Menlo', size: 13, category: 'monospace' });
		expect(onChange).not.toHaveBeenCalled();
		expect(listener).toHaveBeenCalledTimes(1);
		m.setValue({ family: 'Menlo', size: 13 });
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('navigates the listbox with keys', () => {
		const m = new FontPickerModel({ fonts: FONTS, loadOnSelect: false });
		expect(m.handleKey('ArrowDown')).toBe(true);
		expect(m.getState().highlighted).toBe(0);
		m.handleKey('ArrowUp');
		expect(m.getState().highlighted).toBe(3);
		m.handleKey('Home');
		m.handleKey('ArrowDown');
		expect(m.handleKey('Enter')).toBe(true);
		expect(m.value.family).toBe('Lora');
		m.setQuery('zzz');
		expect(m.handleKey('ArrowDown')).toBe(true);
		expect(m.getState().highlighted).toBe(-1);
		expect(m.handleKey('Enter')).toBe(false);
		expect(m.handleKey('Escape')).toBe(true);
		expect(m.getState().query).toBe('');
		expect(m.handleKey('Escape')).toBe(false);
		expect(m.handleKey('x')).toBe(false);
	});

	it('refreshes from a provider and tracks load status', async () => {
		let resolveLoad!: (ok: boolean) => void;
		const provider: FontProvider = {
			id: 'p',
			listFonts: async () => FONTS,
			hasFont: () => true,
			loadFont: vi.fn(() => new Promise<boolean>((r) => (resolveLoad = r)))
		};
		const m = new FontPickerModel({ provider, value: { family: 'menlo' } });
		await m.refresh();
		expect(m.getState().fonts).toHaveLength(4);
		expect(m.value).toMatchObject({ family: 'Menlo', category: 'monospace' });
		m.selectFamily('Inter');
		expect(m.getState().loadStatus.inter).toBe('loading');
		resolveLoad(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(m.getState().loadStatus.inter).toBe('loaded');
		expect(await m.loadFamily('Inter')).toBe(true);
		expect(provider.loadFont).toHaveBeenCalledTimes(1);
	});

	it('keeps fonts and reports errors when refresh fails', async () => {
		const m = new FontPickerModel({ fonts: FONTS, provider: { id: 'x', listFonts: () => Promise.reject(new Error('offline')), hasFont: () => false } });
		await m.refresh();
		expect(m.getState().error).toBe('offline');
		expect(m.getState().loading).toBe(false);
		expect(m.getState().fonts).toHaveLength(4);
	});

	it('stops notifying after destroy', async () => {
		const m = new FontPickerModel({ provider: createCatalogFontProvider(FONTS) });
		const listener = vi.fn();
		m.subscribe(listener);
		m.destroy();
		await m.refresh();
		m.setQuery('a');
		expect(listener).not.toHaveBeenCalled();
	});
});

describe('effect font controls', () => {
	const description = {
		controls: {
			type: 'object' as const,
			properties: {
				text: { type: 'string' as const, default: 'Title' },
				font: { type: 'string' as const, format: 'font', title: 'Font', default: 'Georgia' },
				subtitleFont: { type: 'string' as const, 'x-pixerate-control': 'font' },
				size: { type: 'number' as const, minimum: 8, maximum: 200, default: 48 }
			}
		},
		defaults: { text: 'Title', font: 'Georgia', size: 48 }
	};

	it('turns font controls into a font choice', () => {
		expect(isEffectFontControl(description.controls.properties.font)).toBe(true);
		expect(isEffectFontControl(description.controls.properties.text)).toBe(false);
		const fields = effectParameterFields(description as never);
		const font = fields.find((f) => f.id === 'font')!;
		expect(font).toMatchObject({ type: 'choice', default: 'Georgia', control: 'select', label: 'Font' });
		expect((font as any).options.some((o: any) => o.value === 'Menlo' && o.description === 'monospace')).toBe(true);
		expect(fields.find((f) => f.id === 'text')!.type).toBe('text');
	});

	it('uses host fonts and keeps an unlisted current family', () => {
		const field = effectControlField('font', { type: 'string', format: 'font', default: 'Brand Sans' }, undefined, { fonts: FONTS }) as any;
		expect(field.options.map((o: any) => o.value)).toEqual(['Brand Sans', 'Inter', 'Lora', 'Menlo', 'Literata']);
		expect(field.default).toBe('Brand Sans');
		const noDefault = effectControlField('font', { type: 'string', format: 'font' }, undefined, { fonts: FONTS }) as any;
		expect(noDefault.default).toBe('Inter');
	});

	it('lists the families to load before a preview', () => {
		expect(effectFontFamilies(description as never)).toEqual(['Georgia']);
		expect(effectFontFamilies(description as never, { font: 'Menlo', subtitleFont: 'Lora' })).toEqual(['Menlo', 'Lora']);
	});
});
