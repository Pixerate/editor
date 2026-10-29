/**
 * Font services that serve CSS (Google Fonts, Bunny Fonts, a self-hosted css2-compatible proxy):
 * a provider that loads a family by adding the service's stylesheet and waiting for the face,
 * and an adapter for the Google Fonts catalog and stylesheet URLs.
 */

import { findFont, type FontProvider, type FontSummary } from './registry.js';
import { FONT_WEIGHTS, type FontCategory, type FontStyle, type FontWeight } from './types.js';
import { nearestFontWeight, normalizeFontWeight } from './weight.js';

/** The parts of `document.fonts` the stylesheet provider uses. */
export interface StylesheetFontSetLike {
	load(font: string): Promise<readonly unknown[]>;
}

export interface StylesheetFontProviderOptions {
	id?: string;
	/** The service's families; called once, on first use. */
	listFonts: () => FontSummary[] | Promise<FontSummary[]>;
	/** The stylesheet URL that declares one face. */
	stylesheetUrl: (family: string, weight: FontWeight, style: FontStyle) => string;
	/**
	 * Adds a stylesheet and resolves when it has loaded (default: a `<link rel="stylesheet">` in
	 * `document.head`). Inject a fake in tests: nothing then hits the network.
	 */
	addStylesheet?: (url: string) => Promise<void>;
	/** Where faces are waited for (default `document.fonts`). */
	fontFaceSet?: StylesheetFontSetLike;
}

function linkStylesheet(url: string): Promise<void> {
	const doc = (globalThis as { document?: Document }).document;
	if (!doc?.head) return Promise.reject(new Error('No document to add a stylesheet to.'));
	return new Promise((resolve, reject) => {
		const link = doc.createElement('link');
		link.rel = 'stylesheet';
		link.href = url;
		link.onload = () => resolve();
		link.onerror = () => {
			link.remove();
			reject(new Error(`Stylesheet failed to load: ${url}`));
		};
		doc.head.appendChild(link);
	});
}

const quoteFamily = (family: string) => `"${family.replace(/["\\]/g, '\\$&')}"`;

/**
 * Fonts from a service that serves CSS. `loadFont` asks for the nearest weight and style the
 * family offers, adds that face's stylesheet once, then resolves `true` when the browser has the face (`document.fonts.load` matched it), `false` when the family
 * is not listed, the stylesheet fails or no face matches. Loads are cached per face; failures can
 * be retried.
 */
export function createStylesheetFontProvider(options: StylesheetFontProviderOptions): FontProvider & {
	loaded(family: string, weight?: FontWeight, style?: FontStyle): boolean;
} {
	let catalog: Promise<FontSummary[]> | null = null;
	const fonts = (): Promise<FontSummary[]> => {
		catalog ??= Promise.resolve()
			.then(options.listFonts)
			.catch((error) => {
				catalog = null; // allow a retry
				throw error;
			});
		return catalog;
	};
	const addStylesheet = options.addStylesheet ?? linkStylesheet;
	const fontSet = (): StylesheetFontSetLike | undefined => options.fontFaceSet ?? (globalThis as { document?: { fonts?: StylesheetFontSetLike } }).document?.fonts;
	const sheets = new Map<string, Promise<void>>();
	const faces = new Map<string, Promise<boolean>>();
	const done = new Set<string>();
	const key = (family: string, weight?: FontWeight, style?: FontStyle) => `${family.toLowerCase()}|${normalizeFontWeight(weight)}|${style ?? 'normal'}`;

	const sheet = (url: string): Promise<void> => {
		let pending = sheets.get(url);
		if (!pending) {
			pending = addStylesheet(url).catch((error) => {
				sheets.delete(url);
				throw error;
			});
			sheets.set(url, pending);
		}
		return pending;
	};

	return {
		id: options.id ?? 'stylesheet',
		listFonts: async () => (await fonts()).map((f) => ({ ...f })),
		hasFont: async (family) => !!findFont(await fonts(), family),
		loaded: (family, weight, style) => done.has(key(family, weight, style)),
		async loadFont(family, weight, style) {
			const k = key(family, weight, style);
			const cached = faces.get(k);
			if (cached) return cached;
			const promise = (async () => {
				const listed = findFont(await fonts(), family);
				const set = fontSet();
				if (!listed || !set) return false;
				// Ask for a face the family has: services reject the others outright.
				const wanted = normalizeFontWeight(weight);
				const w = listed.isVariable || !listed.weights.length ? wanted : nearestFontWeight(wanted, listed.weights);
				const st: FontStyle = !listed.styles.length || listed.styles.includes(style ?? 'normal') ? (style ?? 'normal') : 'normal';
				await sheet(options.stylesheetUrl(listed.family, w, st));
				const matched = await set.load(`${st === 'normal' ? '' : `${st} `}${w} 1em ${quoteFamily(listed.family)}`);
				if (!matched.length) throw new Error('No face matched.');
				done.add(k);
				return true;
			})().catch(() => {
				faces.delete(k);
				return false;
			});
			faces.set(k, promise);
			return promise;
		}
	};
}

/** One family in the Google Fonts metadata (`https://fonts.google.com/metadata/fonts`), as far as this module reads it. */
export interface GoogleFontsFamilyMetadata {
	family: string;
	/** `Sans Serif`, `Serif`, `Display`, `Handwriting` or `Monospace`. */
	category?: string;
	/** Further classes, e.g. `Display`, `Handwriting`, `Monospace`, `Symbols`. */
	classifications?: readonly string[];
	/** Stroke class, e.g. `Sans Serif`, `Serif`, `Slab Serif`. */
	stroke?: string | null;
	/** Faces by weight, `i` for italic: `{ "400": …, "700i": … }`. */
	fonts?: Record<string, unknown>;
	axes?: ReadonlyArray<{ tag: string; min: number; max: number }>;
	/** Rank, 1 = most popular. */
	popularity?: number;
	subsets?: readonly string[];
}

const GOOGLE_CATEGORIES: Readonly<Record<string, FontCategory>> = {
	'sans serif': 'sans-serif',
	serif: 'serif',
	display: 'display',
	handwriting: 'handwriting',
	monospace: 'monospace'
};

const tagOf = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '-');

/**
 * The families in a Google Fonts metadata response (the object, its `familyMetadataList`, or the
 * raw text with its `)]}'` prefix), most popular first. A family classified as display,
 * handwriting or monospace takes that category even when Google files it under sans serif or
 * serif (Anton is a sans serif classified as display); its classes, stroke and axes become
 * `tags` (`display`, `slab-serif`, `variable-wdth`…).
 */
export function googleFontsCatalog(metadata: unknown): FontSummary[] {
	let data = metadata;
	if (typeof data === 'string') data = JSON.parse(data.replace(/^\)\]\}'\s*/, ''));
	const list: unknown = Array.isArray(data) ? data : (data as { familyMetadataList?: unknown } | null)?.familyMetadataList;
	if (!Array.isArray(list)) throw new Error('Not Google Fonts metadata: expected familyMetadataList.');
	const families = (list as GoogleFontsFamilyMetadata[]).filter((f) => typeof f?.family === 'string' && f.family);
	return families
		.map((f, index) => ({ f, index }))
		.sort((a, b) => (a.f.popularity ?? Infinity) - (b.f.popularity ?? Infinity) || a.index - b.index)
		.map(({ f }) => {
			const classes = (f.classifications ?? []).map(tagOf);
			const filed = GOOGLE_CATEGORIES[(f.category ?? '').toLowerCase()] ?? 'sans-serif';
			const category = (['monospace', 'handwriting', 'display'] as const).find((c) => classes.includes(c)) ?? filed;
			const weights = new Set<number>();
			const styles = new Set<FontStyle>();
			for (const face of Object.keys(f.fonts ?? {})) {
				const m = /^(\d{3})(i?)$/.exec(face);
				if (!m) continue;
				weights.add(normalizeFontWeight(Number(m[1]) as FontWeight));
				styles.add(m[2] ? 'italic' : 'normal');
			}
			const wght = f.axes?.find((a) => a.tag === 'wght');
			if (wght) for (const w of FONT_WEIGHTS) if (w >= wght.min && w <= wght.max) weights.add(w);
			if (!weights.size) weights.add(400);
			if (!styles.size) styles.add('normal');
			const tags = [...new Set([...(f.category ? [tagOf(f.category)] : []), ...classes, ...(f.stroke ? [tagOf(f.stroke)] : []), ...(f.axes ?? []).map((a) => `variable-${a.tag.toLowerCase()}`)])];
			return {
				family: f.family,
				category,
				weights: [...weights].sort((a, b) => a - b) as FontWeight[],
				styles: [...styles],
				...(wght ? { isVariable: true } : {}),
				source: 'web' as const,
				...(tags.length ? { tags } : {})
			};
		});
}

/** The Google Fonts css2 URL for one face, e.g. `…/css2?family=Space+Grotesk:ital,wght@0,700&display=swap`. */
export function googleFontsStylesheetUrl(family: string, weight: FontWeight = 400, style: FontStyle = 'normal', options: { baseUrl?: string; display?: string } = {}): string {
	const base = options.baseUrl ?? 'https://fonts.googleapis.com/css2';
	const name = encodeURIComponent(family.trim()).replace(/%20/g, '+');
	return `${base}?family=${name}:ital,wght@${style === 'normal' ? 0 : 1},${normalizeFontWeight(weight)}&display=${options.display ?? 'swap'}`;
}

export interface GoogleFontsProviderOptions extends Omit<StylesheetFontProviderOptions, 'listFonts' | 'stylesheetUrl'> {
	/**
	 * The Google Fonts metadata, or the catalog already built from it. fonts.google.com does not
	 * allow cross-origin reads, so a browser host fetches it through its own server.
	 */
	catalog: () => Promise<unknown>;
	/** css2-compatible stylesheet endpoint (default `https://fonts.googleapis.com/css2`). */
	baseUrl?: string;
}

/** Google Fonts (or a css2-compatible mirror): its catalog, loaded face by face through its stylesheets. */
export function createGoogleFontsProvider(options: GoogleFontsProviderOptions) {
	const { catalog, baseUrl, ...rest } = options;
	return createStylesheetFontProvider({
		id: 'google-fonts',
		...rest,
		listFonts: async () => {
			const data = await catalog();
			const built = Array.isArray(data) && data.every((f) => typeof f?.family === 'string' && typeof f?.category === 'string' && Array.isArray(f?.weights));
			return built ? (data as FontSummary[]) : googleFontsCatalog(data);
		},
		stylesheetUrl: (family, weight, style) => googleFontsStylesheetUrl(family, weight, style, { baseUrl })
	});
}
