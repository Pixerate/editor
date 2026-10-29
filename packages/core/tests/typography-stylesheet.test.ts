import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { createGoogleFontsProvider, createStylesheetFontProvider, createTypographyToolProvider, filterFonts, googleFontsCatalog, googleFontsStylesheetUrl, type FontSummary } from '../src/typography';

const METADATA = {
	familyMetadataList: [
		{
			family: 'Space Grotesk',
			category: 'Sans Serif',
			classifications: [],
			stroke: 'Sans Serif',
			popularity: 29,
			fonts: { '300': {}, '400': {}, '700': {} },
			axes: [{ tag: 'wght', min: 300, max: 700 }]
		},
		{
			family: 'Anton',
			category: 'Sans Serif',
			classifications: ['Display'],
			stroke: 'Sans Serif',
			popularity: 24,
			fonts: { '400': {} },
			axes: []
		},
		{
			family: 'Roboto Slab',
			category: 'Serif',
			classifications: [],
			stroke: 'Slab Serif',
			popularity: 10,
			fonts: { '400': {}, '400i': {}, '700': {} }
		},
		{
			family: 'Space Mono',
			category: 'Monospace',
			popularity: 90,
			fonts: { '400': {}, '700': {} }
		}
	]
};

describe('googleFontsCatalog', () => {
	it('lists the most popular first, with categories, faces and tags', () => {
		const fonts = googleFontsCatalog(METADATA);
		expect(fonts.map((f) => f.family)).toEqual(['Roboto Slab', 'Anton', 'Space Grotesk', 'Space Mono']);
		const anton = fonts.find((f) => f.family === 'Anton')!;
		// Filed under sans serif, but classified display.
		expect(anton).toMatchObject({
			category: 'display',
			weights: [400],
			styles: ['normal'],
			source: 'web',
			tags: ['sans-serif', 'display']
		});
		const grotesk = fonts.find((f) => f.family === 'Space Grotesk')!;
		expect(grotesk.isVariable).toBe(true);
		expect(grotesk.weights).toEqual([300, 400, 500, 600, 700]);
		expect(grotesk.tags).toContain('variable-wght');
		const slab = fonts.find((f) => f.family === 'Roboto Slab')!;
		expect(slab).toMatchObject({
			category: 'serif',
			styles: ['normal', 'italic']
		});
		expect(slab.tags).toContain('slab-serif');
		expect(fonts.find((f) => f.family === 'Space Mono')!.category).toBe('monospace');
	});

	it('reads the raw response with its prefix, or a bare list', () => {
		expect(googleFontsCatalog(`)]}'\n${JSON.stringify(METADATA)}`)).toHaveLength(4);
		expect(googleFontsCatalog(METADATA.familyMetadataList)).toHaveLength(4);
		expect(() => googleFontsCatalog({ nope: true })).toThrow(/familyMetadataList/);
	});

	it('filters by tag', () => {
		const fonts = googleFontsCatalog(METADATA);
		expect(filterFonts(fonts, { tags: ['Slab Serif'] }).map((f) => f.family)).toEqual(['Roboto Slab']);
		expect(filterFonts(fonts, { tags: ['sans-serif', 'display'] }).map((f) => f.family)).toEqual(['Anton']);
	});
});

describe('googleFontsStylesheetUrl', () => {
	it('names one face', () => {
		expect(googleFontsStylesheetUrl('Space Grotesk', 700)).toBe('https://fonts.googleapis.com/css2?family=Space+Grotesk:ital,wght@0,700&display=swap');
		expect(
			googleFontsStylesheetUrl('Roboto Slab', 'normal', 'italic', {
				baseUrl: 'https://mirror.test/css2',
				display: 'block'
			})
		).toBe('https://mirror.test/css2?family=Roboto+Slab:ital,wght@1,400&display=block');
	});
});

function fakes(options: { failSheet?: boolean; noMatch?: boolean } = {}) {
	const sheets: string[] = [];
	const loads: string[] = [];
	return {
		sheets,
		loads,
		addStylesheet: vi.fn(async (url: string) => {
			sheets.push(url);
			if (options.failSheet) throw new Error('404');
		}),
		fontFaceSet: {
			load: vi.fn(async (font: string, text?: string) => (loads.push(`${font} / ${text}`), options.noMatch ? [] : [{}]))
		}
	};
}

const FONTS: FontSummary[] = [
	{
		family: 'Anton',
		category: 'display',
		weights: [400],
		styles: ['normal'],
		source: 'web'
	},
	{
		family: 'Space Grotesk',
		category: 'sans-serif',
		weights: [300, 700],
		styles: ['normal'],
		isVariable: true,
		source: 'web'
	}
];

describe('createStylesheetFontProvider', () => {
	const url = (family: string, weight: unknown, style: unknown) => `https://fonts.test/${family}/${weight}/${style}`;

	it('lists its catalog once and adds each face stylesheet once', async () => {
		const f = fakes();
		const listFonts = vi.fn(async () => FONTS);
		const p = createStylesheetFontProvider({
			listFonts,
			stylesheetUrl: url,
			...f
		});
		expect(await p.hasFont('anton')).toBe(true);
		expect(await p.loadFont!('anton', 700)).toBe(true);
		expect(await p.loadFont!('Anton', 'bold')).toBe(true);
		expect(listFonts).toHaveBeenCalledTimes(1);
		// Anton has only 400: it asks for that face, not one the service would reject.
		expect(f.sheets).toEqual(['https://fonts.test/Anton/400/normal']);
		// With sample text, so the Latin subset (not just the one holding a space) is fetched.
		expect(f.loads).toEqual(['400 1em "Anton" / AaBbZz09']);
		expect(p.loaded('Anton', 700)).toBe(true);
	});

	it('keeps variable weights and falls back to a style the family has', async () => {
		const f = fakes();
		const p = createStylesheetFontProvider({
			listFonts: () => FONTS,
			stylesheetUrl: url,
			...f
		});
		expect(await p.loadFont!('Space Grotesk', 500, 'italic')).toBe(true);
		expect(f.sheets).toEqual(['https://fonts.test/Space Grotesk/500/normal']);
	});

	it('reports unknown families, failed stylesheets and unmatched faces, and retries', async () => {
		const failing = fakes({ failSheet: true });
		const p = createStylesheetFontProvider({
			listFonts: () => FONTS,
			stylesheetUrl: url,
			...failing
		});
		expect(await p.loadFont!('Missing')).toBe(false);
		expect(await p.loadFont!('Anton')).toBe(false);
		expect(await p.loadFont!('Anton')).toBe(false);
		expect(failing.addStylesheet).toHaveBeenCalledTimes(2);
		const unmatched = createStylesheetFontProvider({
			listFonts: () => FONTS,
			stylesheetUrl: url,
			...fakes({ noMatch: true })
		});
		expect(await unmatched.loadFont!('Anton')).toBe(false);
		expect(unmatched.loaded('Anton')).toBe(false);
	});

	it('retries a catalog that failed', async () => {
		const listFonts = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(FONTS);
		const p = createStylesheetFontProvider({
			listFonts,
			stylesheetUrl: url,
			...fakes()
		});
		await expect(p.listFonts()).rejects.toThrow('offline');
		expect((await p.listFonts()).map((f) => f.family)).toEqual(['Anton', 'Space Grotesk']);
	});
});

describe('createGoogleFontsProvider', () => {
	it('builds the catalog from metadata and loads through css2', async () => {
		const f = fakes();
		const p = createGoogleFontsProvider({
			catalog: async () => METADATA,
			...f
		});
		expect(p.id).toBe('google-fonts');
		expect((await p.listFonts()).map((x) => x.family)).toContain('Anton');
		expect(await p.loadFont!('Space Mono', 700)).toBe(true);
		expect(f.sheets).toEqual(['https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,700&display=swap']);
	});

	it('takes a catalog that is already built', async () => {
		const p = createGoogleFontsProvider({
			catalog: async () => FONTS,
			...fakes()
		});
		expect(await p.listFonts()).toEqual(FONTS);
	});

	it('lets list_fonts narrow by tags and report them', async () => {
		const r = new ToolRegistry();
		r.register(
			createTypographyToolProvider({
				provider: createGoogleFontsProvider({
					catalog: async () => METADATA,
					...fakes()
				})
			})
		);
		const all = (await r.callTool('list_fonts', { source: 'web' })).structuredContent as any;
		expect(all.tags).toContainEqual({ tag: 'sans-serif', count: 2 });
		const display = (await r.callTool('list_fonts', { tags: ['display'] })).structuredContent as any;
		expect(display.fonts.map((x: any) => x.family)).toEqual(['Anton']);
		const loaded = (await r.callTool('load_font', { family: 'anton' })).structuredContent as any;
		expect(loaded).toMatchObject({ family: 'Anton', loaded: true });
	});
});
