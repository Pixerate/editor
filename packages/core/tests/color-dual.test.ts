import { describe, it, expect } from 'vitest';
import {
	isDualColor,
	parseDualColor,
	normalizeDualColor,
	resolveColor,
	formatDualColor,
	isSameInBothSchemes,
	setDualColorSide,
	deriveDualColor,
	checkDualColorContrast,
	dualColorsToCss,
	DEFAULT_SCHEME_SURFACES,
	dualPickerView,
	parseColor,
	rgbToOklab,
	oklabToOklch,
	contrastRatio
} from '../src/color';

describe('Dual Colours (@pixerate/editor/color)', () => {
	describe('isDualColor', () => {
		it('identifies DualColor objects', () => {
			expect(isDualColor({ light: '#fff', dark: '#000' })).toBe(true);
			expect(isDualColor('#fff')).toBe(false);
			expect(isDualColor(null)).toBe(false);
			expect(isDualColor({ light: '#fff' })).toBe(false);
		});
	});

	describe('parseDualColor and normalizeDualColor', () => {
		it('parses CSS light-dark() with commas in color functions', () => {
			const parsed = parseDualColor('light-dark(rgb(0, 0, 0), #fff)');
			expect(parsed).toEqual({ light: 'rgb(0, 0, 0)', dark: '#fff' });

			const norm = normalizeDualColor('light-dark(rgb(0, 0, 0), #fff)');
			expect(norm).toEqual({ light: '#000000', dark: '#ffffff' });
		});

		it('parses plain colour as equal in both schemes', () => {
			const norm = normalizeDualColor('#ff0000');
			expect(norm).toEqual({ light: '#ff0000', dark: '#ff0000' });
		});

		it('returns null for invalid inputs', () => {
			expect(parseDualColor('light-dark(#fff)')).toBeNull();
			expect(parseDualColor('light-dark(#fff, nope)')).toBeNull();
			expect(parseDualColor('light-dark(#fff, light-dark(#111, #222))')).toBeNull();
			expect(parseDualColor('')).toBeNull();
			expect(parseDualColor(123)).toBeNull();
		});
	});

	describe('resolveColor', () => {
		it('resolves color for both schemes and for plain input', () => {
			const dual = 'light-dark(#112233, #aabbcc)';
			expect(resolveColor(dual, 'light')).toBe('#112233');
			expect(resolveColor(dual, 'dark')).toBe('#aabbcc');

			expect(resolveColor('#123456', 'light')).toBe('#123456');
			expect(resolveColor('#123456', 'dark')).toBe('#123456');
		});
	});

	describe('formatDualColor and isSameInBothSchemes', () => {
		it('collapses equal halves', () => {
			expect(formatDualColor({ light: '#ffffff', dark: '#ffffff' })).toBe('#ffffff');
			expect(isSameInBothSchemes({ light: '#ffffff', dark: '#ffffff' })).toBe(true);
		});

		it('formats distinct halves as light-dark()', () => {
			expect(formatDualColor({ light: '#111111', dark: '#eeeeee' })).toBe(
				'light-dark(#111111, #eeeeee)'
			);
			expect(isSameInBothSchemes({ light: '#111111', dark: '#eeeeee' })).toBe(false);
		});
	});

	describe('setDualColorSide', () => {
		it('modifies one scheme side of a dual colour', () => {
			const base = { light: '#111111', dark: '#222222' };
			const updated = setDualColorSide(base, 'dark', '#ffffff');
			expect(updated).toEqual({ light: '#111111', dark: '#ffffff' });
		});

		it('expands plain colour before modifying side', () => {
			const updated = setDualColorSide('#ff0000', 'dark', '#0000ff');
			expect(updated).toEqual({ light: '#ff0000', dark: '#0000ff' });
		});
	});

	describe('deriveDualColor', () => {
		it('derives a dark half lighter than the light half with matching hue without surfaces', () => {
			const derived = deriveDualColor('#1d4ed8');
			expect(derived.light).toBe('#1d4ed8');

			const lightLch = oklabToOklch(rgbToOklab(parseColor(derived.light)!));
			const darkLch = oklabToOklch(rgbToOklab(parseColor(derived.dark)!));

			expect(darkLch.l).toBeGreaterThan(lightLch.l);
			// Hue matches within 1 degree
			const hueDiff = Math.abs(lightLch.h - darkLch.h);
			expect(Math.min(hueDiff, 360 - hueDiff)).toBeLessThanOrEqual(1);
		});

		it('derives a dark half with matching contrast against target surface', () => {
			const derived = deriveDualColor('#1d4ed8', {
				from: 'light',
				surfaces: DEFAULT_SCHEME_SURFACES
			});

			const lightRatio = contrastRatio(
				parseColor(derived.light)!,
				parseColor(DEFAULT_SCHEME_SURFACES.light)!
			);
			const darkRatio = contrastRatio(
				parseColor(derived.dark)!,
				parseColor(DEFAULT_SCHEME_SURFACES.dark)!
			);

			expect(Math.abs(darkRatio - lightRatio)).toBeLessThanOrEqual(0.3);
		});
	});

	describe('checkDualColorContrast', () => {
		it('reports issues only in the failing scheme', () => {
			// In light mode: #111 on #fff passes AA.
			// In dark mode: #111 on #0b0b0f fails AA.
			const res = checkDualColorContrast('#111111', DEFAULT_SCHEME_SURFACES);
			expect(res.light.level).not.toBe('fail');
			expect(res.dark.level).toBe('fail');
			expect(res.issues.length).toBe(1);
			expect(res.issues[0]).toContain('In dark mode');
		});
	});

	describe('dualColorsToCss', () => {
		const colors = {
			bg: { light: '#ffffff', dark: '#0b0b0f' },
			accent: { light: '#1d4ed8', dark: '#60a5fa' }
		};

		it('formats light-dark strategy', () => {
			const css = dualColorsToCss(colors, { strategy: 'light-dark', selector: ':root' });
			expect(css).toBe(
				[
					':root {',
					'  color-scheme: light dark;',
					'  --accent: light-dark(#1d4ed8, #60a5fa);',
					'  --bg: light-dark(#ffffff, #0b0b0f);',
					'}'
				].join('\n')
			);
		});

		it('formats media strategy', () => {
			const css = dualColorsToCss(colors, { strategy: 'media', selector: ':root' });
			expect(css).toBe(
				[
					':root {',
					'  --accent: #1d4ed8;',
					'  --bg: #ffffff;',
					'}',
					'',
					'@media (prefers-color-scheme: dark) {',
					'  :root {',
					'    --accent: #60a5fa;',
					'    --bg: #0b0b0f;',
					'  }',
					'}'
				].join('\n')
			);
		});

		it('formats class strategy', () => {
			const css = dualColorsToCss(colors, { strategy: 'class', selector: ':root', darkSelector: '.dark' });
			expect(css).toBe(
				[
					':root {',
					'  --accent: #1d4ed8;',
					'  --bg: #ffffff;',
					'}',
					'',
					'.dark {',
					'  --accent: #60a5fa;',
					'  --bg: #0b0b0f;',
					'}'
				].join('\n')
			);
		});
	});

	describe('dualPickerView', () => {
		it('returns active colour, other colour and linked status', () => {
			const viewLight = dualPickerView('light-dark(#112233, #aabbcc)', 'light');
			expect(viewLight).toEqual({ color: '#112233', linked: false, other: '#aabbcc' });

			const viewDark = dualPickerView('light-dark(#112233, #aabbcc)', 'dark');
			expect(viewDark).toEqual({ color: '#aabbcc', linked: false, other: '#112233' });

			const viewPlain = dualPickerView('#ff0000', 'light');
			expect(viewPlain).toEqual({ color: '#ff0000', linked: true, other: '#ff0000' });
		});
	});
});

describe('dual colour helpers fail usefully', () => {
	it('deriveDualColor throws on an unreadable colour or surfaces', () => {
		expect(() => deriveDualColor('nope')).toThrow(/"nope" is not a colour/);
		expect(() => deriveDualColor('#1d4ed8', { surfaces: { light: '#fff', dark: 'mud' } })).toThrow(/surfaces/);
	});

	it('checkDualColorContrast throws instead of assuming black and white', () => {
		expect(() => checkDualColorContrast('nope', '#ffffff')).toThrow(/foreground "nope"/);
		expect(() => checkDualColorContrast('#000000', { light: '#fff', dark: 'x' })).toThrow(/background/);
	});

	it('dualColorsToCss rejects variable names and selectors that would break the CSS', () => {
		expect(() => dualColorsToCss({ 'x: red; } body { color: red': '#fff' })).toThrow(/not a CSS variable name/);
		expect(() => dualColorsToCss({ '--brand': '#fff' })).toThrow(/without the leading "--"/);
		expect(() => dualColorsToCss({ brand: 'mud' })).toThrow(/"brand" has "mud"/);
		expect(() => dualColorsToCss({ brand: '#fff' }, { selector: ':root } body {' })).toThrow(/selector/);
		expect(() => dualColorsToCss({ brand: '#fff' }, { strategy: 'class', darkSelector: '' })).toThrow(/darkSelector/);
	});
});
