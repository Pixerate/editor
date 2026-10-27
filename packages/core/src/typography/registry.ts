/**
 * Pluggable font providers: the interface hosts implement (system fonts, a web font service, a
 * design system's own families), filtering, and a combinator that merges several providers.
 */

import type { FontCategory, FontSource, FontStyle, FontWeight } from './types.js';
import { normalizeFontWeight } from './weight.js';

export type FontPlatform = 'macos' | 'windows' | 'ios' | 'android' | 'linux';

export interface FontSummary {
	family: string;
	category: FontCategory;
	weights: FontWeight[];
	styles: FontStyle[];
	/** A variable font: any weight between the lowest and highest in `weights` works. */
	isVariable?: boolean;
	source: FontSource;
	/** Platforms that ship it, for system fonts. */
	platforms?: FontPlatform[];
}

export interface FontProvider {
	readonly id: string;
	/** Every font the provider offers. */
	listFonts(): Promise<FontSummary[]>;
	/** Whether the provider offers (system) or has loaded (web) the family. */
	hasFont(family: string): boolean | Promise<boolean>;
	/** Makes a face usable for rendering; resolves `true` when it is ready, `false` when it cannot be loaded. */
	loadFont?(family: string, weight?: FontWeight, style?: FontStyle): Promise<boolean>;
}

export interface FontFilter {
	category?: FontCategory;
	source?: FontSource;
	/** Keep fonts that offer this weight (variable fonts: within their range). */
	weight?: FontWeight;
	style?: FontStyle;
	/** Case-insensitive substring of the family name. */
	query?: string;
	isVariable?: boolean;
}

/** Whether a font offers a weight (variable fonts offer every weight in their range). */
export function fontHasWeight(font: FontSummary, weight: FontWeight): boolean {
	const w = normalizeFontWeight(weight);
	const ws = font.weights.map((x) => normalizeFontWeight(x));
	if (font.isVariable && ws.length) return w >= Math.min(...ws) && w <= Math.max(...ws);
	return ws.includes(w);
}

/**
 * Filters fonts. With a `query`, families that start with it come first, then the rest that
 * contain it; otherwise the order is kept.
 */
export function filterFonts(fonts: readonly FontSummary[], filter: FontFilter = {}): FontSummary[] {
	const q = filter.query?.trim().toLowerCase() ?? '';
	const kept = fonts.filter(
		(f) =>
			(!filter.category || f.category === filter.category) &&
			(!filter.source || f.source === filter.source) &&
			(filter.weight === undefined || fontHasWeight(f, filter.weight)) &&
			(!filter.style || f.styles.includes(filter.style)) &&
			(filter.isVariable === undefined || !!f.isVariable === filter.isVariable) &&
			(!q || f.family.toLowerCase().includes(q))
	);
	if (!q) return kept;
	const starts = kept.filter((f) => f.family.toLowerCase().startsWith(q));
	return [...starts, ...kept.filter((f) => !f.family.toLowerCase().startsWith(q))];
}

/** Finds a family by name, case-insensitively. */
export function findFont(fonts: readonly FontSummary[], family: string): FontSummary | undefined {
	const lower = family.trim().toLowerCase();
	return fonts.find((f) => f.family.toLowerCase() === lower);
}

/**
 * One provider over several: fonts are merged by family (case-insensitive; the first provider
 * that lists a family wins), `hasFont` asks each in turn, and `loadFont` uses the first
 * provider that lists the family and can load.
 */
export function combineFontProviders(providers: readonly FontProvider[], options: { id?: string } = {}): FontProvider {
	const owner = async (family: string): Promise<FontProvider | undefined> => {
		for (const p of providers) if (await p.hasFont(family)) return p;
		for (const p of providers) if (findFont(await p.listFonts(), family)) return p;
		return undefined;
	};
	return {
		id: options.id ?? 'fonts',
		async listFonts() {
			const seen = new Set<string>();
			const out: FontSummary[] = [];
			for (const p of providers) {
				for (const f of await p.listFonts()) {
					const key = f.family.toLowerCase();
					if (seen.has(key)) continue;
					seen.add(key);
					out.push(f);
				}
			}
			return out;
		},
		async hasFont(family) {
			for (const p of providers) if (await p.hasFont(family)) return true;
			return false;
		},
		async loadFont(family, weight, style) {
			for (const p of providers) {
				if (!p.loadFont) continue;
				if (findFont(await p.listFonts(), family)) return p.loadFont(family, weight, style);
			}
			return !!(await owner(family));
		}
	};
}

export interface EnsureFontsResult {
	loaded: string[];
	failed: string[];
}

/**
 * Loads every face a set of specs needs before rendering (for example before rasterising a title
 * preview, so the first frame does not use a fallback font). Duplicates are loaded once.
 */
export async function ensureFontsLoaded(
	provider: FontProvider,
	specs: ReadonlyArray<{ family: string; weight?: FontWeight; style?: FontStyle }>
): Promise<EnsureFontsResult> {
	const result: EnsureFontsResult = { loaded: [], failed: [] };
	const seen = new Set<string>();
	await Promise.all(
		specs.map(async (s) => {
			const key = `${s.family.toLowerCase()}|${normalizeFontWeight(s.weight)}|${s.style ?? 'normal'}`;
			if (seen.has(key)) return;
			seen.add(key);
			const ok = provider.loadFont ? await provider.loadFont(s.family, s.weight, s.style).catch(() => false) : await provider.hasFont(s.family);
			(ok ? result.loaded : result.failed).push(s.family);
		})
	);
	return result;
}
