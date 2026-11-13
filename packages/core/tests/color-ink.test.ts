import { describe, it, expect } from 'vitest';
import { contrast, ink, inkSide } from '../src/color';
import { chartContrastRatio, chartTextOn, parseChartColor } from '../src/chart/color';
import { conditionalFormatContrastColor } from '../src/spreadsheet/conditional-format/render';
import { SHARED_STYLE_CHECKS } from '../src/tools';

/** The helpers as they were before #797, to prove the move kept their results. */
const oldChartTextOn = (fill: string, fallback: string, dark = '#0f172a', light = '#ffffff') => {
	if (!parseChartColor(fill)) return fallback;
	const d = chartContrastRatio(fill, dark)!;
	const l = chartContrastRatio(fill, light)!;
	return d >= l ? dark : light;
};
const oldConditional = (fill: string) => {
	let hex = fill.trim().replace(/^#/, '');
	if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	return 0.299 * r + 0.587 * g + 0.114 * b > 0.55 ? '#1f2328' : '#ffffff';
};

/** Every 17th step of each channel, plus some other syntaxes. */
const samples = (() => {
	const out: string[] = [];
	for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) out.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
	return [...out, '#abc', '#80808080', 'rgb(10, 200, 30)', 'rgba(250,250,250,0.2)', 'rgb(50% 50% 50%)', 'red', 'var(--x)', '', 'not a colour'];
})();

describe('contrast and ink', () => {
	it('contrast is the WCAG ratio for any colour the module reads, or null', () => {
		expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 6);
		expect(contrast('#ffffff', '#ffffff')).toBe(1);
		expect(contrast({ r: 0, g: 0, b: 0, a: 1 }, 'white')).toBeCloseTo(21, 6);
		expect(contrast({ light: '#000000', dark: '#ffffff' }, '#ffffff', { scheme: 'dark' })).toBe(1);
		expect(contrast('var(--x)', '#fff')).toBeNull();
	});

	it('ink picks the ink that reads, dark on a tie, or by a brightness threshold', () => {
		expect(ink('#0b5fff')).toBe('#ffffff');
		expect(ink('#ffeb3b')).toBe('#111111');
		expect(ink('#ffeb3b', { dark: '#1a1a1a', light: '#fafafa' })).toBe('#1a1a1a');
		expect(ink('#777777', { dark: '#777777', light: '#777777' })).toBe('#777777');
		expect(inkSide('#808080', { threshold: 0.5, luminance: 'bt601' })).toBe('dark');
		expect(inkSide('#808080', { threshold: 0.5 })).toBe('light'); // WCAG luminance of mid grey is about 0.22
		expect(ink('#000', { light: { light: '#eeeeee', dark: '#ffffff' } })).toBe('#eeeeee');
		expect(ink('var(--x)')).toBeUndefined();
		expect(ink('#000', { light: 'nope' })).toBeUndefined();
	});

	it('chartTextOn and conditionalFormatContrastColor give the same results as before', () => {
		for (const fill of samples) {
			expect(chartTextOn(fill, 'fallback'), fill).toBe(oldChartTextOn(fill, 'fallback'));
			expect(chartTextOn(fill, 'fallback', '#222', 'ivory'), fill).toBe(oldChartTextOn(fill, 'fallback', '#222', 'ivory'));
			expect(conditionalFormatContrastColor(fill), fill).toBe(oldConditional(fill));
		}
		// An unreadable ink loses to a readable one, as before.
		expect(chartTextOn('#000', 'f', 'var(--d)', '#fff')).toBe(oldChartTextOn('#000', 'f', 'var(--d)', '#fff'));
		expect(chartTextOn('#fff', 'f', '#000', 'var(--l)')).toBe(oldChartTextOn('#fff', 'f', '#000', 'var(--l)'));
	});
});

describe('min-contrast suggestions', () => {
	const check = SHARED_STYLE_CHECKS.find((c) => c.id === 'min-contrast')!;
	const run = (color: string, background: string, brand?: Record<string, unknown>) => check.run({ colors: [{ color, background, label: 'Title', use: 'text', target: { node: 't' } }] }, {}, {}, brand ? { brand: brand as never } : {});

	it('suggests the ink that reads when it passes', () => {
		const [f] = run('#777777', '#ffffff');
		expect(f).toMatchObject({ target: { node: 't' }, suggestion: { color: '#111111', ratio: 18.88 } });
		expect(f.message).toBe('Title: #777777 on #ffffff has a contrast ratio of 4.48; it needs 4.5. Use #111111 (contrast 18.88), or another house colour that passes.');
		expect(run('#334155', '#1e293b')[0].suggestion).toEqual({ color: '#ffffff', ratio: 14.63 });
	});

	it('uses the brand text and background colours as the inks, and suggests nothing that fails', () => {
		expect(run('#999999', '#ffffff', { colors: { text: '#1a1a2e', background: '#fdfdfd' } })[0].suggestion?.color).toBe('#1a1a2e');
		const none = run('#8a8a8a', '#808080', { colors: { text: '#666666', background: '#999999' } })[0];
		expect(none.suggestion).toBeUndefined();
		expect(none.message.endsWith('Use a darker or lighter house colour.')).toBe(true);
	});
});

import { ToolRegistry } from '../src/tools';
import { createColorToolProvider } from '../src/color';

describe('pick_text_color', () => {
	const registry = new ToolRegistry();
	registry.register(createColorToolProvider({ namespace: '' } as never));
	const call = (args: Record<string, unknown>) => registry.callTool('pick_text_color', args);

	it('picks the ink that reads and says whether it passes', async () => {
		expect((await call({ fill: '#0b5fff' })).structuredContent).toEqual({ color: '#ffffff', side: 'light', ratio: 5.13, passesAA: true });
		expect((await call({ fill: 'gold', dark: '#222222' })).structuredContent).toMatchObject({ color: '#222222', side: 'dark', passesAA: true });
		expect((await call({ fill: '#808080', dark: '#666666', light: '#999999' })).structuredContent).toMatchObject({ passesAA: false });
		expect((await call({ fill: '#808080', dark: '#555555', light: '#aaaaaa', large: true })).structuredContent).toMatchObject({ passesAA: false });
	});

	it('refuses colours it cannot read', async () => {
		const bad = await call({ fill: 'var(--x)' });
		expect(bad.isError).toBe(true);
		expect((await call({ fill: '#fff', dark: 'nope' })).isError).toBe(true);
		expect((await call({})).isError).toBe(true);
	});
});
