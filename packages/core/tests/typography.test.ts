import { describe, it, expect, vi } from 'vitest';
import {
	MODULAR_SCALE_RATIOS,
	getScaleRatio,
	resolveScaleRatio,
	computeTypeScale,
	generateTypeHierarchy,
	typeHierarchyToCss,
	computeFluidSize,
	recommendedLineHeight,
	recommendedLetterSpacing,
	normalizeFontWeight,
	nearestFontWeight,
	isFontWeight,
	parseFontFamily,
	formatFontFamily,
	quoteFontFamily,
	resolveFontFallback,
	guessFontCategory,
	FONT_STACKS,
	segmentText,
	countGraphemes,
	auditTextReadability,
	estimateCharactersPerLine,
	isLargeText,
	checkTypographyAccessibility,
	SYSTEM_FONT_CATALOG,
	filterFonts,
	findFont,
	fontHasWeight,
	combineFontProviders,
	ensureFontsLoaded,
	createCatalogFontProvider,
	createSystemFontProvider,
	createWebFontProvider,
	fontFaceCss,
	webFontSummary,
	type FontSummary,
	type WebFontDefinition
} from '../src/typography';
import { suggestAccessibleForeground, parseColor, contrastRatio } from '../src/color';

describe('weights', () => {
	it('normalizes keywords and numbers', () => {
		expect(normalizeFontWeight(undefined)).toBe(400);
		expect(normalizeFontWeight('normal')).toBe(400);
		expect(normalizeFontWeight('bold')).toBe(700);
		expect(normalizeFontWeight(650)).toBe(700);
		expect(normalizeFontWeight(20)).toBe(100);
		expect(normalizeFontWeight(5000)).toBe(900);
		expect(isFontWeight(300)).toBe(true);
		expect(isFontWeight(350)).toBe(false);
	});

	it('follows CSS font matching for the nearest weight', () => {
		expect(nearestFontWeight(400, [300, 500, 700])).toBe(500);
		expect(nearestFontWeight(400, [300, 700])).toBe(300);
		expect(nearestFontWeight(500, [400, 700])).toBe(400);
		expect(nearestFontWeight(300, [400, 700])).toBe(400);
		expect(nearestFontWeight(600, [400, 800])).toBe(800);
		expect(nearestFontWeight(800, [400, 600])).toBe(600);
		expect(nearestFontWeight('bold', [])).toBe(700);
	});
});

describe('modular scales', () => {
	it('looks up named ratios and validates custom ones', () => {
		expect(getScaleRatio('golden-ratio')).toBe(1.618);
		expect(resolveScaleRatio(1.3)).toBe(1.3);
		expect(() => resolveScaleRatio(1)).toThrow(/above 1/);
		expect(() => getScaleRatio('nope' as never)).toThrow(/Unknown scale ratio/);
		expect(Object.keys(MODULAR_SCALE_RATIOS)).toHaveLength(8);
	});

	it('computes steps from base and ratio', () => {
		const steps = computeTypeScale(16, 'major-third', [-1, 0, 1, 2]);
		expect(steps.map((s) => s.size)).toEqual([12.8, 16, 20, 25]);
		expect(steps[1]).toMatchObject({ name: 'step-0', step: 0, lineHeight: 1.5, letterSpacing: 0 });
		expect(() => computeTypeScale(16, 1.25, [0.5])).toThrow(/integer/);
		expect(() => computeTypeScale(0, 1.25)).toThrow(/Base size/);
	});

	it('recommends tighter leading and tracking for bigger type', () => {
		expect(recommendedLineHeight(12)).toBe(1.5);
		expect(recommendedLineHeight(40)).toBeLessThan(1.5);
		expect(recommendedLineHeight(96)).toBe(1.1);
		expect(recommendedLetterSpacing(12)).toBeGreaterThan(0);
		expect(recommendedLetterSpacing(72)).toBeLessThan(0);
	});

	it('generates a named hierarchy and its CSS', () => {
		const h = generateTypeHierarchy({ baseSize: 16, ratio: 'perfect-fourth' });
		expect(Object.keys(h.steps)).toEqual(['caption', 'body-sm', 'body', 'h4', 'h3', 'h2', 'h1', 'display']);
		expect(h.ratioName).toBe('perfect-fourth');
		expect(h.steps.body.size).toBe(16);
		expect(h.steps.h1.size).toBeCloseTo(16 * 1.333 ** 4, 1);
		expect(h.steps.display.size).toBeGreaterThan(h.steps.h1.size);
		const css = typeHierarchyToCss(h, { prefix: 'type' });
		expect(css).toContain('--type-body-size: 1rem;');
		expect(css).toContain('--type-h1-line-height:');
		expect(css.startsWith(':root {')).toBe(true);
	});

	it('computes fluid sizes as clamp()', () => {
		const f = computeFluidSize({ minSize: 16, maxSize: 24, minViewport: 400, maxViewport: 1200 });
		expect(f.clampCss).toBe('clamp(1rem, 1vw + 0.75rem, 1.5rem)');
		expect(f.evaluateAt(200)).toBe(16);
		expect(f.evaluateAt(800)).toBe(20);
		expect(f.evaluateAt(2000)).toBe(24);
		expect(() => computeFluidSize({ minSize: 16, maxSize: 24, minViewport: 800, maxViewport: 400 })).toThrow(/larger than minViewport/);
		// Shrinking type keeps clamp bounds ordered.
		const down = computeFluidSize({ minSize: 24, maxSize: 16, minViewport: 400, maxViewport: 1200 });
		expect(down.clampCss.startsWith('clamp(1rem,')).toBe(true);
		expect(down.evaluateAt(400)).toBe(24);
	});
});

describe('font stacks', () => {
	it('parses quoted, escaped and unquoted families', () => {
		expect(parseFontFamily(`"Segoe UI", Roboto , 'Helvetica Neue',  Open   Sans, sans-serif`)).toEqual(['Segoe UI', 'Roboto', 'Helvetica Neue', 'Open Sans', 'sans-serif']);
		expect(parseFontFamily(`"A, B", C`)).toEqual(['A, B', 'C']);
		expect(parseFontFamily(`"Say \\"Hi\\""`)).toEqual(['Say "Hi"']);
		expect(parseFontFamily('')).toEqual([]);
	});

	it('quotes only when needed and drops duplicates', () => {
		expect(quoteFontFamily('serif')).toBe('serif');
		expect(quoteFontFamily('-apple-system')).toBe('-apple-system');
		expect(quoteFontFamily('Segoe UI')).toBe('"Segoe UI"');
		expect(quoteFontFamily('Font"X')).toBe('"Font\\"X"');
		expect(formatFontFamily(['Inter', 'inter', 'Arial'])).toBe('Inter, Arial');
	});

	it('resolves a fallback stack for the category', () => {
		expect(resolveFontFallback('Inter')).toBe(`Inter, ${FONT_STACKS['system-ui']}`);
		expect(resolveFontFallback('Georgia').endsWith('serif')).toBe(true);
		expect(resolveFontFallback('JetBrains Mono').endsWith('monospace')).toBe(true);
		expect(resolveFontFallback('Lora', 'serif')).toMatch(/^Lora, Charter/);
		// A complete stack is kept as is.
		expect(resolveFontFallback('"My Font", serif')).toBe('"My Font", serif');
		// Families already in the fallback appear once.
		expect(parseFontFamily(resolveFontFallback('Roboto')).filter((f) => f === 'Roboto')).toHaveLength(1);
		expect(() => resolveFontFallback('  ')).toThrow(/at least one/);
	});

	it('guesses categories from the catalog or the name', () => {
		expect(guessFontCategory('Menlo')).toBe('monospace');
		expect(guessFontCategory('Fira Code')).toBe('monospace');
		expect(guessFontCategory('Source Serif Pro')).toBe('serif');
		expect(guessFontCategory('Source Sans Pro')).toBe('sans-serif');
		expect(guessFontCategory('Dancing Script')).toBe('handwriting');
	});
});

describe('segmentText', () => {
	it('splits graphemes with UTF-16 offsets, keeping emoji whole', () => {
		const text = 'a👍🏽é';
		const segs = segmentText(text, 'grapheme');
		expect(segs.map((s) => s.text)).toEqual(['a', '👍🏽', 'é']);
		for (const s of segs) expect(text.slice(s.start, s.end)).toBe(s.text);
		expect(countGraphemes(text)).toBe(3);
	});

	it('splits words, optionally dropping spaces and punctuation', () => {
		const all = segmentText('Hello, big world!', 'word');
		expect(all.map((s) => s.text).join('')).toBe('Hello, big world!');
		const words = segmentText('Hello, big world!', 'word', { wordsOnly: true });
		expect(words.map((s) => s.text)).toEqual(['Hello', 'big', 'world']);
		expect(words.map((s) => s.index)).toEqual([0, 1, 2]);
		expect(words[2]).toMatchObject({ start: 11, end: 16, isWordLike: true });
	});

	it('splits sentences', () => {
		expect(segmentText('One. Two? Three!', 'sentence').map((s) => s.text.trim())).toEqual(['One.', 'Two?', 'Three!']);
	});

	it('splits lines on breaks and wraps at word boundaries', () => {
		const text = 'first line\r\nsecond';
		expect(segmentText(text, 'line').map((s) => [s.text, s.start, s.end])).toEqual([
			['first line', 0, 10],
			['second', 12, 18]
		]);
		const wrapped = segmentText('the quick brown fox', 'line', { maxCharacters: 10 });
		expect(wrapped.map((s) => s.text)).toEqual(['the quick ', 'brown fox']);
		for (const s of wrapped) expect('the quick brown fox'.slice(s.start, s.end)).toBe(s.text);
		expect(segmentText('supercalifragilistic word', 'line', { maxCharacters: 5 }).map((s) => s.text)).toEqual(['supercalifragilistic ', 'word']);
		expect(() => segmentText('x', 'line', { maxCharacters: 0 })).toThrow(/positive integer/);
		expect(() => segmentText('x', 'paragraph' as never)).toThrow(/Unknown granularity/);
	});

	it('falls back without Intl.Segmenter', () => {
		const original = (Intl as any).Segmenter;
		(Intl as any).Segmenter = undefined;
		try {
			expect(segmentText('ab', 'grapheme').map((s) => s.text)).toEqual(['a', 'b']);
			expect(segmentText("Don't stop", 'word', { wordsOnly: true }).map((s) => s.text)).toEqual(["Don't", 'stop']);
		} finally {
			(Intl as any).Segmenter = original;
		}
	});
});

describe('auditTextReadability', () => {
	const para = (chars: number) => 'word '.repeat(Math.ceil(chars / 5)).slice(0, chars).trim();

	it('measures the text\'s own lines', () => {
		const ok = auditTextReadability([para(60), para(62), para(58)].join('\n'), { lineHeight: 1.5 });
		expect(ok.lineLength).toMatchObject({ status: 'optimal', source: 'lines' });
		expect(ok.lineSpacing).toMatchObject({ ratio: 1.5, assumed: false, meetsRecommended: true });
		expect(ok.issues).toEqual([]);

		const long = auditTextReadability([para(110), para(120)].join('\n'), { lineHeight: 1.6 });
		expect(long.lineLength.status).toBe('too-long');
		expect(long.issues[0]).toMatch(/66ch/);
	});

	it('estimates the measure from width and size', () => {
		expect(estimateCharactersPerLine(640, { size: 16 })).toBe(80);
		expect(estimateCharactersPerLine(600, { size: 10, category: 'monospace' })).toBe(100);
		const r = auditTextReadability('Some text here.', { width: 300, size: 16, lineHeight: 1.5 });
		expect(r.lineLength.source).toBe('width');
		expect(r.lineLength.characters).toBe(37);
		expect(r.lineLength.status).toBe('too-short');
		expect(() => estimateCharactersPerLine(0, { size: 16 })).toThrow();
	});

	it('flags tight leading, capitals, tiny and tight type', () => {
		const text = 'THIS IS A LONG SHOUTED PARAGRAPH OF BODY TEXT THAT GOES ON\nAND ON FOR SEVERAL LINES WITHOUT ANY LOWER CASE';
		const r = auditTextReadability(text, { size: 11, letterSpacing: -0.08 });
		expect(r.allCaps).toBe(true);
		expect(r.lineSpacing).toMatchObject({ ratio: 1.2, assumed: true, meetsRecommended: false });
		expect(r.issues.some((i) => /capitals/.test(i))).toBe(true);
		expect(r.issues.some((i) => /below 12px/.test(i))).toBe(true);
		expect(r.issues.some((i) => /very tight/.test(i))).toBe(true);
		expect(r.issues.some((i) => /WCAG 1.4.8/.test(i))).toBe(true);
	});

	it('counts words and reading time', () => {
		const r = auditTextReadability('word '.repeat(476));
		expect(r.wordCount).toBe(476);
		expect(r.estimatedReadingTimeSeconds).toBe(120);
		expect(auditTextReadability('').lineLength.characters).toBe(0);
	});
});

describe('typography accessibility', () => {
	it('decides large text from size and weight', () => {
		expect(isLargeText({ size: 24 })).toBe(true);
		expect(isLargeText({ size: 23 })).toBe(false);
		expect(isLargeText({ size: 18.67, weight: 'bold' })).toBe(true);
		expect(isLargeText({ size: 18.66, weight: 700 })).toBe(true);
		expect(isLargeText({ size: 18.67, weight: 600 })).toBe(false);
	});

	it('uses the large-text threshold automatically', () => {
		// #767676 on white is about 4.54:1; #949494 about 3.03:1.
		const small = checkTypographyAccessibility({ font: { size: 16 }, foreground: '#949494', background: '#fff' });
		expect(small).toMatchObject({ large: false, passesAA: false, required: { AA: 4.5, AAA: 7 } });
		expect(small.suggestion).toMatch(/^#/);
		expect(contrastRatio(parseColor(small.suggestion!)!, parseColor('#fff')!)).toBeGreaterThanOrEqual(4.5);
		const big = checkTypographyAccessibility({ font: { size: 32 }, foreground: '#949494', background: '#fff' });
		expect(big).toMatchObject({ large: true, passesAA: true, level: 'AA', required: { AA: 3, AAA: 4.5 } });
		expect(big.suggestion).toBeUndefined();
		expect(big.largeTextMinSize).toBe(24);
		expect(checkTypographyAccessibility({ font: { size: 16, weight: 'bold' }, foreground: '#000', background: '#fff' }).largeTextMinSize).toBe(18.67);
	});

	it('flags tiny and thin type and rejects bad input', () => {
		const r = checkTypographyAccessibility({ font: { size: 10, weight: 200 }, foreground: '#000', background: '#fff' });
		expect(r.passesAAA).toBe(true);
		expect(r.issues).toHaveLength(2);
		expect(() => checkTypographyAccessibility({ font: { size: 16 }, foreground: 'nope', background: '#fff' })).toThrow(/not a colour/);
		expect(() => checkTypographyAccessibility({ font: { size: 0 }, foreground: '#000', background: '#fff' })).toThrow(/positive/);
	});

	it('shares the colour module suggestion', () => {
		const s = suggestAccessibleForeground(parseColor('#aaaaaa')!, parseColor('#ffffff')!);
		expect(contrastRatio(parseColor(s!)!, parseColor('#ffffff')!)).toBeGreaterThanOrEqual(4.5);
	});
});

describe('font providers', () => {
	const fonts: FontSummary[] = [
		{ family: 'Inter', category: 'sans-serif', weights: [100, 900], styles: ['normal', 'italic'], isVariable: true, source: 'custom' },
		{ family: 'Lora', category: 'serif', weights: [400, 700], styles: ['normal'], source: 'custom' },
		{ family: 'Interstate', category: 'sans-serif', weights: [400], styles: ['normal'], source: 'web' }
	];

	it('filters and finds fonts', () => {
		expect(filterFonts(fonts, { category: 'serif' }).map((f) => f.family)).toEqual(['Lora']);
		expect(filterFonts(fonts, { weight: 300 }).map((f) => f.family)).toEqual(['Inter']);
		expect(filterFonts(fonts, { style: 'italic' }).map((f) => f.family)).toEqual(['Inter']);
		expect(filterFonts(fonts, { source: 'web' }).map((f) => f.family)).toEqual(['Interstate']);
		expect(filterFonts(fonts, { query: 'a' }).map((f) => f.family)).toEqual(['Lora', 'Interstate']);
		expect(filterFonts(fonts, { query: 'inter' }).map((f) => f.family)).toEqual(['Inter', 'Interstate']);
		expect(findFont(fonts, ' lora ')?.family).toBe('Lora');
		expect(fontHasWeight(fonts[0]!, 'bold')).toBe(true);
		expect(fontHasWeight(fonts[1]!, 500)).toBe(false);
	});

	it('ships a metadata catalog with no files', () => {
		expect(SYSTEM_FONT_CATALOG.length).toBeGreaterThan(40);
		const families = SYSTEM_FONT_CATALOG.map((f) => f.family.toLowerCase());
		expect(new Set(families).size).toBe(families.length);
		for (const f of SYSTEM_FONT_CATALOG) {
			expect(f.source).toBe('system');
			expect(f.weights.length).toBeGreaterThan(0);
			expect(f.platforms?.length).toBeGreaterThan(0);
		}
	});

	it('system provider offers the catalog, by platform', async () => {
		const linux = createSystemFontProvider({ platform: 'linux' });
		const list = await linux.listFonts();
		expect(list.some((f) => f.family === 'DejaVu Sans')).toBe(true);
		expect(list.some((f) => f.family === 'Segoe UI')).toBe(false);
		expect(await linux.hasFont('dejavu sans')).toBe(true);
		expect(await linux.loadFont!('Nope')).toBe(false);
	});

	it('system provider uses queryLocalFonts only when given, and falls back when it fails', async () => {
		const query = vi.fn(async () => [
			{ family: 'Menlo', style: 'Regular' },
			{ family: 'Menlo', style: 'Bold Italic' },
			{ family: 'Fancy Script', style: 'Light' }
		]);
		const p = createSystemFontProvider({ queryLocalFonts: query });
		const list = await p.listFonts();
		await p.hasFont('Menlo');
		expect(query).toHaveBeenCalledTimes(1);
		expect(list.find((f) => f.family === 'Menlo')).toMatchObject({ category: 'monospace', weights: [400, 700], styles: ['normal', 'italic'] });
		expect(list.find((f) => f.family === 'Fancy Script')).toMatchObject({ category: 'handwriting', weights: [300] });
		expect(await p.hasFont('Arial')).toBe(false);

		const denied = createSystemFontProvider({ queryLocalFonts: async () => Promise.reject(new Error('denied')) });
		expect((await denied.listFonts()).length).toBe(SYSTEM_FONT_CATALOG.length);
	});

	it('catalog provider and combinator merge by family, first wins', async () => {
		const a = createCatalogFontProvider(fonts, { id: 'a' });
		const b = createCatalogFontProvider([{ family: 'lora', category: 'display', weights: [400], styles: ['normal'], source: 'web' }, { family: 'Menlo', category: 'monospace', weights: [400], styles: ['normal'], source: 'system' }], { id: 'b' });
		const both = combineFontProviders([a, b]);
		const list = await both.listFonts();
		expect(list.map((f) => f.family)).toEqual(['Inter', 'Lora', 'Interstate', 'Menlo']);
		expect(list.find((f) => f.family === 'Lora')?.category).toBe('serif');
		expect(await both.hasFont('menlo')).toBe(true);
		expect(await both.hasFont('Comic')).toBe(false);
		expect(await both.loadFont!('Menlo')).toBe(true);
		expect(await both.loadFont!('Comic')).toBe(false);
	});
});

describe('web font provider (no network)', () => {
	const def: WebFontDefinition = {
		family: 'Brand Sans',
		category: 'sans-serif',
		sources: [
			{ url: 'https://example.test/brand-var.woff2', weight: [300, 800], format: 'woff2' },
			{ url: 'https://example.test/brand-italic.woff2', weight: 400, style: 'italic', format: 'woff2', unicodeRange: 'U+0000-00FF' }
		]
	};

	function fakes(fail = false) {
		const created: Array<{ family: string; source: string; descriptors: any }> = [];
		const added: unknown[] = [];
		const createFontFace = vi.fn((family: string, source: string, descriptors: any) => {
			const face = { family, source, descriptors, load: vi.fn(() => (fail ? Promise.reject(new Error('404')) : Promise.resolve(face))) };
			created.push(face);
			return face;
		});
		return { created, added, createFontFace, fontFaceSet: { add: (f: unknown) => added.push(f) } };
	}

	it('summarises and writes @font-face rules', () => {
		expect(webFontSummary(def)).toEqual({ family: 'Brand Sans', category: 'sans-serif', weights: [300, 400, 800], styles: ['normal', 'italic'], source: 'web', isVariable: true });
		const css = fontFaceCss(def);
		expect(css).toContain('font-weight: 300 800;');
		expect(css).toContain('src: url("https://example.test/brand-var.woff2") format("woff2");');
		expect(css).toContain('unicode-range: U+0000-00FF;');
		expect(css).toContain('font-display: swap;');
	});

	it('loads the best-matching face once and adds it to the font set', async () => {
		const f = fakes();
		const p = createWebFontProvider({ fonts: [def], ...f });
		expect(await p.loadFont!('brand sans', 600)).toBe(true);
		expect(await p.loadFont!('Brand Sans', 600)).toBe(true);
		expect(f.createFontFace).toHaveBeenCalledTimes(1);
		expect(f.created[0]!.source).toContain('brand-var.woff2');
		expect(f.created[0]!.descriptors).toMatchObject({ weight: '300 800', style: 'normal' });
		expect(f.added).toHaveLength(1);
		expect(p.loaded('Brand Sans', 600)).toBe(true);

		expect(await p.loadFont!('Brand Sans', 400, 'italic')).toBe(true);
		expect(f.created[1]!.source).toContain('brand-italic.woff2');
		expect(await p.loadFont!('Unknown')).toBe(false);
	});

	it('reports failures and allows a retry', async () => {
		const f = fakes(true);
		const p = createWebFontProvider({ fonts: [def], ...f });
		expect(await p.loadFont!('Brand Sans')).toBe(false);
		expect(await p.loadFont!('Brand Sans')).toBe(false);
		expect(f.createFontFace).toHaveBeenCalledTimes(2);
		expect(f.added).toHaveLength(0);
	});

	it('returns false without a FontFace implementation', async () => {
		const p = createWebFontProvider({ fonts: [def], createFontFace: undefined, fontFaceSet: { add() {} } });
		if (typeof (globalThis as any).FontFace === 'undefined') expect(await p.loadFont!('Brand Sans')).toBe(false);
	});

	it('ensureFontsLoaded loads each face once and reports failures', async () => {
		const f = fakes();
		const p = createWebFontProvider({ fonts: [def], ...f });
		const r = await ensureFontsLoaded(p, [{ family: 'Brand Sans', weight: 700 }, { family: 'Brand Sans', weight: 'bold' }, { family: 'Missing' }]);
		expect(r).toEqual({ loaded: ['Brand Sans'], failed: ['Missing'] });
		expect(f.createFontFace).toHaveBeenCalledTimes(1);
	});
});
