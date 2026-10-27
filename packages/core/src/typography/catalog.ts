/**
 * Font catalogs and the built-in providers: a metadata catalog of common system fonts (no font
 * files), a system provider that can use the Local Font Access API when the host opts in, and a
 * web font provider that loads faces through the CSS Font Loading API. Browser APIs are injectable
 * so headless hosts and tests never touch the network.
 */

import type { FontCategory, FontStyle, FontWeight } from './types.js';
import { findFont, type FontPlatform, type FontProvider, type FontSummary } from './registry.js';
import { nearestFontWeight, normalizeFontWeight } from './weight.js';

const ALL: FontPlatform[] = ['macos', 'windows', 'ios', 'android', 'linux'];
const R: FontWeight[] = [400, 700];
const NI: FontStyle[] = ['normal', 'italic'];
const N: FontStyle[] = ['normal'];
const sys = (family: string, category: FontCategory, platforms: FontPlatform[], weights: FontWeight[] = R, styles: FontStyle[] = NI, isVariable?: boolean): FontSummary => ({
	family,
	category,
	weights,
	styles,
	source: 'system',
	platforms,
	...(isVariable ? { isVariable } : {})
});

/** Metadata for widely installed system fonts. No font files are bundled. */
export const SYSTEM_FONT_CATALOG: readonly FontSummary[] = [
	// Sans-serif
	sys('Arial', 'sans-serif', ['macos', 'windows', 'ios']),
	sys('Helvetica', 'sans-serif', ['macos', 'ios'], [300, 400, 700]),
	sys('Helvetica Neue', 'sans-serif', ['macos', 'ios'], [100, 200, 300, 400, 500, 700]),
	sys('Segoe UI', 'sans-serif', ['windows'], [300, 400, 600, 700, 900]),
	sys('Roboto', 'sans-serif', ['android'], [100, 300, 400, 500, 700, 900]),
	sys('Verdana', 'sans-serif', ['macos', 'windows']),
	sys('Tahoma', 'sans-serif', ['macos', 'windows'], R, N),
	sys('Trebuchet MS', 'sans-serif', ['macos', 'windows']),
	sys('Calibri', 'sans-serif', ['windows'], [300, 400, 700]),
	sys('Candara', 'sans-serif', ['windows'], [300, 400, 700]),
	sys('Optima', 'sans-serif', ['macos'], [400, 700, 800]),
	sys('Gill Sans', 'sans-serif', ['macos'], [300, 400, 600]),
	sys('Avenir', 'sans-serif', ['macos', 'ios'], [300, 400, 500, 800, 900]),
	sys('Avenir Next', 'sans-serif', ['macos', 'ios'], [200, 400, 500, 600, 700, 800]),
	sys('Futura', 'sans-serif', ['macos', 'ios'], [400, 500, 700]),
	sys('Century Gothic', 'sans-serif', ['windows']),
	sys('Noto Sans', 'sans-serif', ['android', 'linux'], [100, 200, 300, 400, 500, 600, 700, 800, 900], NI, true),
	sys('DejaVu Sans', 'sans-serif', ['linux'], [200, 400, 700]),
	sys('Liberation Sans', 'sans-serif', ['linux']),
	sys('Ubuntu', 'sans-serif', ['linux'], [300, 400, 500, 700]),
	sys('Cantarell', 'sans-serif', ['linux'], [100, 200, 300, 400, 500, 600, 700, 800], N, true),
	// Serif
	sys('Georgia', 'serif', ['macos', 'windows', 'ios']),
	sys('Times New Roman', 'serif', ['macos', 'windows', 'ios']),
	sys('Times', 'serif', ['macos', 'ios']),
	sys('Cambria', 'serif', ['windows']),
	sys('Constantia', 'serif', ['windows']),
	sys('Sitka Text', 'serif', ['windows'], [400, 600, 700], NI, true),
	sys('Charter', 'serif', ['macos', 'ios'], [400, 700, 900]),
	sys('Iowan Old Style', 'serif', ['macos', 'ios'], [400, 700, 900]),
	sys('Palatino', 'serif', ['macos']),
	sys('Palatino Linotype', 'serif', ['windows']),
	sys('Baskerville', 'serif', ['macos', 'ios'], [400, 600, 700]),
	sys('Hoefler Text', 'serif', ['macos'], [400, 900]),
	sys('Garamond', 'serif', ['windows']),
	sys('Book Antiqua', 'serif', ['windows']),
	sys('Noto Serif', 'serif', ['android', 'linux'], [100, 200, 300, 400, 500, 600, 700, 800, 900], NI, true),
	sys('DejaVu Serif', 'serif', ['linux']),
	sys('Liberation Serif', 'serif', ['linux']),
	// Monospace
	sys('Menlo', 'monospace', ['macos']),
	sys('Monaco', 'monospace', ['macos'], [400], N),
	sys('SF Mono', 'monospace', ['macos'], [300, 400, 500, 600, 700, 800]),
	sys('Consolas', 'monospace', ['windows']),
	sys('Cascadia Code', 'monospace', ['windows'], [200, 300, 400, 500, 600, 700], NI, true),
	sys('Cascadia Mono', 'monospace', ['windows'], [200, 300, 400, 500, 600, 700], NI, true),
	sys('Courier New', 'monospace', ['macos', 'windows', 'ios']),
	sys('Lucida Console', 'monospace', ['windows'], [400], N),
	sys('DejaVu Sans Mono', 'monospace', ['linux']),
	sys('Liberation Mono', 'monospace', ['linux']),
	sys('Ubuntu Mono', 'monospace', ['linux']),
	sys('Droid Sans Mono', 'monospace', ['android'], [400], N),
	// Display
	sys('Impact', 'display', ['macos', 'windows'], [400], N),
	sys('Copperplate', 'display', ['macos'], [300, 400, 700], N),
	sys('Rockwell', 'display', ['macos', 'windows']),
	sys('Didot', 'display', ['macos', 'ios'], [400, 700]),
	sys('Bodoni 72', 'display', ['macos', 'ios'], [400, 700]),
	sys('Arial Black', 'display', ['macos', 'windows'], [900], N),
	// Handwriting
	sys('Comic Sans MS', 'handwriting', ['macos', 'windows']),
	sys('Segoe Print', 'handwriting', ['windows'], R, N),
	sys('Segoe Script', 'handwriting', ['windows'], R, N),
	sys('Bradley Hand', 'handwriting', ['macos', 'ios'], [700], N),
	sys('Brush Script MT', 'handwriting', ['macos', 'windows'], [400], ['italic']),
	sys('Snell Roundhand', 'handwriting', ['macos', 'ios'], [400, 700, 900], N),
	sys('Noteworthy', 'handwriting', ['macos', 'ios'], [300, 700], N)
];

/** Platforms the catalog covers. */
export const FONT_PLATFORMS: readonly FontPlatform[] = ALL;

/** The catalog category of a family, or a guess from its name (`Mono`, `Code`, `Serif`, `Script`…). */
export function guessFontCategory(family: string): FontCategory {
	const known = findFont(SYSTEM_FONT_CATALOG, family);
	if (known) return known.category;
	const lower = family.toLowerCase();
	if (lower === 'monospace' || lower === 'ui-monospace' || /\bmono|code|courier|consol/.test(lower)) return 'monospace';
	if (lower === 'cursive' || /script|hand|brush|marker/.test(lower)) return 'handwriting';
	if (lower === 'fantasy' || /display|poster/.test(lower)) return 'display';
	if (/sans/.test(lower)) return 'sans-serif';
	if (lower === 'serif' || lower === 'ui-serif' || /serif|times|garamond|georgia|baskerville|caslon|bodoni|didot/.test(lower)) return 'serif';
	return 'sans-serif';
}

/** An in-memory provider over a fixed list (a design system's families, a test fixture). */
export function createCatalogFontProvider(fonts: readonly FontSummary[], options: { id?: string } = {}): FontProvider {
	const list = [...fonts];
	return {
		id: options.id ?? 'catalog',
		listFonts: async () => list.map((f) => ({ ...f })),
		hasFont: (family) => !!findFont(list, family),
		loadFont: async (family) => !!findFont(list, family)
	};
}

/** The Local Font Access API's entries (`queryLocalFonts()`), as far as this module reads them. */
export interface LocalFontDataLike {
	family: string;
	style?: string;
	fullName?: string;
}

export interface SystemFontProviderOptions {
	id?: string;
	/** Catalog to offer (default {@link SYSTEM_FONT_CATALOG}). */
	catalog?: readonly FontSummary[];
	/** Offer only fonts that ship on this platform. */
	platform?: FontPlatform;
	/**
	 * Lists the fonts actually installed (the Local Font Access API, which asks the user for
	 * permission). Not called unless given: pass `() => window.queryLocalFonts()` to opt in.
	 */
	queryLocalFonts?: () => Promise<readonly LocalFontDataLike[]>;
}

function weightFromStyleName(style = ''): FontWeight {
	const s = style.toLowerCase();
	if (/thin|hairline/.test(s)) return 100;
	if (/extra ?light|ultra ?light/.test(s)) return 200;
	if (/light/.test(s)) return 300;
	if (/medium/.test(s)) return 500;
	if (/semi ?bold|demi ?bold/.test(s)) return 600;
	if (/extra ?bold|ultra ?bold/.test(s)) return 800;
	if (/black|heavy/.test(s)) return 900;
	if (/bold/.test(s)) return 700;
	return 400;
}

/**
 * System fonts. Without `queryLocalFonts` it offers the catalog (filtered by `platform`): what is
 * commonly installed, not what this machine has. With it, it offers what the machine reports,
 * categorised from the catalog or by name.
 *
 * `hasFont` never uses `document.fonts.check()`: it answers `true` for families that are not
 * installed at all (see GOTCHAS "[core/typography] `document.fonts.check()` …").
 */
export function createSystemFontProvider(options: SystemFontProviderOptions = {}): FontProvider {
	const catalog = (options.catalog ?? SYSTEM_FONT_CATALOG).filter((f) => !options.platform || !f.platforms || f.platforms.includes(options.platform));
	let local: Promise<FontSummary[] | null> | null = null;
	const localFonts = (): Promise<FontSummary[] | null> => {
		if (!options.queryLocalFonts) return Promise.resolve(null);
		local ??= options
			.queryLocalFonts()
			.then((entries) => {
				const byFamily = new Map<string, FontSummary>();
				for (const e of entries) {
					const key = e.family.toLowerCase();
					const known = findFont(SYSTEM_FONT_CATALOG, e.family);
					const entry = byFamily.get(key) ?? { family: known?.family ?? e.family, category: known?.category ?? guessFontCategory(e.family), weights: [], styles: [], source: 'system' as const };
					const w = weightFromStyleName(e.style);
					if (!entry.weights.includes(w)) entry.weights.push(w);
					const st: FontStyle = /italic/i.test(e.style ?? '') ? 'italic' : /oblique/i.test(e.style ?? '') ? 'oblique' : 'normal';
					if (!entry.styles.includes(st)) entry.styles.push(st);
					byFamily.set(key, entry);
				}
				for (const f of byFamily.values()) f.weights.sort((a, b) => normalizeFontWeight(a) - normalizeFontWeight(b));
				return [...byFamily.values()];
			})
			.catch(() => null); // permission denied or unsupported: fall back to the catalog
		return local;
	};
	return {
		id: options.id ?? 'system',
		async listFonts() {
			return ((await localFonts()) ?? catalog).map((f) => ({ ...f }));
		},
		async hasFont(family) {
			return !!findFont((await localFonts()) ?? catalog, family);
		},
		async loadFont(family) {
			// Installed fonts need no loading.
			return !!findFont((await localFonts()) ?? catalog, family);
		}
	};
}

/** One file of a web font family. */
export interface WebFontSource {
	/** URL of the font file (woff2 preferred). */
	url: string;
	/** Weight, or a `[min, max]` range for a variable font (default 400). */
	weight?: FontWeight | [number, number];
	/** Default `normal`. */
	style?: FontStyle;
	/** CSS `format()` hint, e.g. `woff2`. */
	format?: string;
	/** CSS `unicode-range` descriptor. */
	unicodeRange?: string;
}

export interface WebFontDefinition {
	family: string;
	category: FontCategory;
	sources: readonly WebFontSource[];
	/** CSS `font-display` (default `swap`). */
	display?: 'auto' | 'block' | 'swap' | 'fallback' | 'optional';
}

/** The parts of the CSS Font Loading API (`FontFace`, `document.fonts`) the web provider uses. */
export interface FontFaceLike {
	load(): Promise<unknown>;
}
export interface FontFaceSetLike {
	add(face: any): unknown;
}
export type CreateFontFace = (family: string, source: string, descriptors: { weight: string; style: string; display: string; unicodeRange?: string }) => FontFaceLike;

export interface WebFontProviderOptions {
	id?: string;
	fonts: readonly WebFontDefinition[];
	/** Where loaded faces are added (default `document.fonts` when there is a document). */
	fontFaceSet?: FontFaceSetLike;
	/** Builds a face (default `new FontFace(...)` when the runtime has it). Inject a fake in tests: nothing then hits the network. */
	createFontFace?: CreateFontFace;
}

const weightRange = (w: WebFontSource['weight']): [number, number] => (Array.isArray(w) ? [w[0], w[1]] : [normalizeFontWeight(w), normalizeFontWeight(w)]);

const cssWeight = (w: WebFontSource['weight']): string => {
	const [lo, hi] = weightRange(w);
	return lo === hi ? String(lo) : `${lo} ${hi}`;
};

/** `@font-face` rules for a definition, for server rendering or a stylesheet. */
export function fontFaceCss(def: WebFontDefinition): string {
	return def.sources
		.map((s) =>
			[
				'@font-face {',
				`  font-family: "${def.family.replace(/"/g, '\\"')}";`,
				`  src: url("${s.url.replace(/"/g, '%22')}")${s.format ? ` format("${s.format}")` : ''};`,
				`  font-weight: ${cssWeight(s.weight)};`,
				`  font-style: ${s.style ?? 'normal'};`,
				`  font-display: ${def.display ?? 'swap'};`,
				...(s.unicodeRange ? [`  unicode-range: ${s.unicodeRange};`] : []),
				'}'
			].join('\n')
		)
		.join('\n');
}

/** The summary a definition lists as. */
export function webFontSummary(def: WebFontDefinition): FontSummary {
	const weights = new Set<number>();
	let isVariable = false;
	for (const s of def.sources) {
		const [lo, hi] = weightRange(s.weight);
		if (lo !== hi) isVariable = true;
		weights.add(lo);
		weights.add(hi);
	}
	const styles = [...new Set(def.sources.map((s) => s.style ?? 'normal'))];
	return { family: def.family, category: def.category, weights: [...weights].sort((a, b) => a - b) as FontWeight[], styles, source: 'web', ...(isVariable ? { isVariable } : {}) };
}

/**
 * Web fonts loaded on demand through the CSS Font Loading API. `loadFont` picks the source that
 * best matches the weight and style, adds the face to the font set and resolves when it is ready
 * (`false` if it fails or there is no `FontFace` in this runtime). Loads are cached per face.
 */
export function createWebFontProvider(options: WebFontProviderOptions): FontProvider & { loaded(family: string, weight?: FontWeight, style?: FontStyle): boolean } {
	const defs = [...options.fonts];
	const cache = new Map<string, Promise<boolean>>();
	const done = new Set<string>();
	const g = globalThis as unknown as { FontFace?: new (family: string, source: string, descriptors?: object) => FontFaceLike; document?: { fonts?: FontFaceSetLike } };
	const createFace: CreateFontFace | undefined = options.createFontFace ?? (g.FontFace ? (family, source, descriptors) => new g.FontFace!(family, source, descriptors) : undefined);
	const set = (): FontFaceSetLike | undefined => options.fontFaceSet ?? g.document?.fonts;
	const def = (family: string) => defs.find((d) => d.family.toLowerCase() === family.trim().toLowerCase());
	const key = (family: string, weight?: FontWeight, style?: FontStyle) => `${family.toLowerCase()}|${normalizeFontWeight(weight)}|${style ?? 'normal'}`;

	function pickSource(d: WebFontDefinition, weight: FontWeight | undefined, style: FontStyle | undefined): WebFontSource | undefined {
		const wanted = normalizeFontWeight(weight);
		const st = style ?? 'normal';
		const sameStyle = d.sources.filter((s) => (s.style ?? 'normal') === st);
		const pool = sameStyle.length ? sameStyle : d.sources;
		const inRange = pool.find((s) => {
			const [lo, hi] = weightRange(s.weight);
			return wanted >= lo && wanted <= hi;
		});
		if (inRange) return inRange;
		const best = nearestFontWeight(wanted, pool.map((s) => weightRange(s.weight)[0] as FontWeight));
		return pool.find((s) => weightRange(s.weight)[0] === best);
	}

	return {
		id: options.id ?? 'web',
		listFonts: async () => defs.map(webFontSummary),
		hasFont: (family) => !!def(family),
		loaded: (family, weight, style) => done.has(key(family, weight, style)),
		loadFont(family, weight, style) {
			const k = key(family, weight, style);
			const cached = cache.get(k);
			if (cached) return cached;
			const d = def(family);
			const source = d && pickSource(d, weight, style);
			if (!d || !source || !createFace) return Promise.resolve(false);
			const face = createFace(d.family, `url("${source.url.replace(/"/g, '%22')}")${source.format ? ` format("${source.format}")` : ''}`, {
				weight: cssWeight(source.weight),
				style: source.style ?? 'normal',
				display: d.display ?? 'swap',
				...(source.unicodeRange ? { unicodeRange: source.unicodeRange } : {})
			});
			const promise = face
				.load()
				.then(() => {
					set()?.add(face);
					done.add(k);
					return true;
				})
				.catch(() => {
					cache.delete(k); // allow a retry
					return false;
				});
			cache.set(k, promise);
			return promise;
		}
	};
}
