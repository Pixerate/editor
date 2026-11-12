/**
 * Style surfaces and the shared house-style checks.
 *
 * A domain that implements `StyleDomain.surface(state)` lists what its state draws with: the
 * colours (with how each is used and, for text, what it sits on) and the fonts, each with a
 * target in the shape the domain's write tools take. The shared checks below then run in that
 * domain against its profile and the brand, with no domain-specific code. A domain's own check
 * with the same id wins. Dependency-free.
 */
import { contrastRatio } from '../color/contrast.js';
import { oklabToOklch, rgbToOklab } from '../color/convert.js';
import { parseColor } from '../color/parse.js';
import { brandColors, brandFonts, brandPalette, type BrandProfile } from './brand.js';
import type { StyleCheck } from './style.js';

/** One colour a domain's state draws with. */
export interface StyleSurfaceColor {
	/** The colour as stored (any CSS colour). */
	color: string;
	/** What uses it, for messages: `Series "Revenue"`, `Heading 2`, `Shape "Logo"`. */
	label: string;
	/** What to edit, in the shape the domain's write tools take. */
	target?: unknown;
	/**
	 * How it is used. `series` colours must tell apart from each other; `text` colours are
	 * checked for contrast against `background`. Default `fill`.
	 */
	use?: 'fill' | 'stroke' | 'text' | 'background' | 'series';
	/** For `text`: the colour it sits on. */
	background?: string;
	/** For `text`: size in px (large text, 24 px or 18.66 px bold, needs less contrast). */
	fontSize?: number;
	bold?: boolean;
}

/** One font family a domain's state uses. */
export interface StyleSurfaceFont {
	/** The CSS family (or stack; its first family is what is checked). */
	family: string;
	label: string;
	target?: unknown;
}

/** What a domain's state draws with, for the shared checks. */
export interface StyleSurface {
	colors?: StyleSurfaceColor[];
	fonts?: StyleSurfaceFont[];
}

/** Context the resolver hands every check besides the merged profile. */
export interface StyleCheckContext {
	/** The merged brand profile that applies, if any. */
	brand?: BrandProfile;
}

type Lab = { l: number; a: number; b: number };

const toLab = (color: string): Lab | undefined => {
	const rgba = parseColor(color);
	return rgba ? rgbToOklab(rgba) : undefined;
};

/** OKLab distance × 100 (about 1 is a just-noticeable difference). */
const distance = (x: Lab, y: Lab) => Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b) * 100;

const strings = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.length && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;

/** The colours a profile allows: its `palette`, else the brand's, plus every brand role colour. */
function allowedColors(profile: Readonly<Record<string, unknown>>, brand: BrandProfile | undefined): string[] {
	const palette = strings(profile.palette) ?? brandPalette(brand);
	return [...palette, ...Object.values(brandColors(brand))];
}

const firstFamily = (family: string) =>
	family
		.split(',')[0]
		.trim()
		.replace(/^(['"])(.*)\1$/, '$2')
		.toLowerCase();

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong', 'inherit', 'initial', 'unset']);

const paletteOnly: StyleCheck<StyleSurface> = {
	id: 'palette-only',
	description:
		'Every colour comes from the house palette or a brand colour role (within a small tolerance). Neutrals (greys, black, white) are allowed unless allowNeutrals is false.',
	optionsSchema: {
		type: 'object',
		properties: {
			tolerance: { type: 'number', minimum: 0, maximum: 20, description: 'How far a colour may be from a palette colour, in OKLab distance × 100 (1 is barely visible). Default 2.' },
			allowNeutrals: { type: 'boolean', description: 'Allow greys, black and white that are not in the palette. Default true.' }
		},
		additionalProperties: false
	},
	run(surface, profile, options, context) {
		const allowed = allowedColors(profile, context?.brand)
			.map((c) => ({ c, lab: toLab(c) }))
			.filter((x): x is { c: string; lab: Lab } => !!x.lab);
		if (!allowed.length) throw new Error('neither the profile nor the brand has a palette.');
		const tolerance = typeof options.tolerance === 'number' ? options.tolerance : 2;
		const allowNeutrals = options.allowNeutrals !== false;
		const out = [];
		for (const item of surface.colors ?? []) {
			const rgba = parseColor(item.color);
			if (!rgba || rgba.a === 0) continue;
			if (allowNeutrals && oklabToOklch(rgbToOklab(rgba)).c < 0.02) continue;
			const lab = rgbToOklab(rgba);
			const nearest = allowed.map((a) => ({ ...a, d: distance(lab, a.lab) })).sort((x, y) => x.d - y.d)[0];
			if (nearest.d <= tolerance) continue;
			out.push({
				severity: 'error' as const,
				message: `${item.label} uses ${item.color}, which is not a house colour; the nearest is ${nearest.c}. Change it to ${nearest.c} or another palette colour.`,
				...(item.target !== undefined ? { target: item.target } : {})
			});
		}
		return out;
	}
};

const minContrast: StyleCheck<StyleSurface> = {
	id: 'min-contrast',
	description: 'Text has at least the WCAG contrast ratio against what it sits on (default 4.5, or 3 for large text: 24 px, or 18.66 px bold).',
	optionsSchema: {
		type: 'object',
		properties: {
			ratio: { type: 'number', minimum: 1, maximum: 21, description: 'Minimum ratio for body text. Default 4.5 (WCAG AA).' },
			largeRatio: { type: 'number', minimum: 1, maximum: 21, description: 'Minimum ratio for large text. Default 3.' }
		},
		additionalProperties: false
	},
	run(surface, _profile, options) {
		const ratio = typeof options.ratio === 'number' ? options.ratio : 4.5;
		const largeRatio = typeof options.largeRatio === 'number' ? options.largeRatio : 3;
		const out = [];
		for (const item of surface.colors ?? []) {
			if (item.use !== 'text' || !item.background) continue;
			const fg = parseColor(item.color);
			const bg = parseColor(item.background);
			if (!fg || !bg) continue;
			const large = (item.fontSize ?? 0) >= 24 || (!!item.bold && (item.fontSize ?? 0) >= 18.66);
			const needed = large ? largeRatio : ratio;
			const got = contrastRatio(fg, bg);
			if (got + 1e-9 >= needed) continue;
			out.push({
				severity: 'error' as const,
				message: `${item.label}: ${item.color} on ${item.background} has a contrast ratio of ${got.toFixed(2)}; it needs ${needed}. Use a darker or lighter house colour.`,
				...(item.target !== undefined ? { target: item.target } : {})
			});
		}
		return out;
	}
};

const distinguishable: StyleCheck<StyleSurface> = {
	id: 'distinguishable',
	description: 'Series and category colours are far enough apart to tell apart.',
	optionsSchema: {
		type: 'object',
		properties: { minDistance: { type: 'number', minimum: 1, maximum: 50, description: 'Least OKLab distance × 100 between two series colours. Default 10.' } },
		additionalProperties: false
	},
	run(surface, _profile, options) {
		const min = typeof options.minDistance === 'number' ? options.minDistance : 10;
		const series = (surface.colors ?? []).filter((c) => c.use === 'series').map((c) => ({ ...c, lab: toLab(c.color) }));
		const out = [];
		for (let i = 0; i < series.length; i++) {
			for (let j = i + 1; j < series.length; j++) {
				const a = series[i];
				const b = series[j];
				if (!a.lab || !b.lab) continue;
				const d = distance(a.lab, b.lab);
				if (d >= min) continue;
				out.push({
					severity: 'warning' as const,
					message: `${a.label} (${a.color}) and ${b.label} (${b.color}) are hard to tell apart (distance ${d.toFixed(1)}, needs ${min}). Give ${b.label} another palette colour.`,
					...(b.target !== undefined ? { target: b.target } : {})
				});
			}
		}
		return out;
	}
};

const fontsAllowed: StyleCheck<StyleSurface> = {
	id: 'fonts-allowed',
	description: "Every font is one the house style names: the check's fonts option, else the profile's fonts list, else the brand's heading, body and mono fonts. Generic families (sans-serif, system-ui, ...) are allowed.",
	optionsSchema: {
		type: 'object',
		properties: { fonts: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Allowed font families (case-insensitive). Default: the profile\'s fonts, else the brand\'s.' } },
		additionalProperties: false
	},
	run(surface, profile, options, context) {
		const allowed = strings(options.fonts) ?? strings(profile.fonts) ?? brandFonts(context?.brand);
		if (!allowed.length) throw new Error('neither the check, the profile nor the brand names any fonts.');
		const names = new Set(allowed.map(firstFamily));
		const out = [];
		for (const font of surface.fonts ?? []) {
			const first = firstFamily(font.family);
			if (!first || names.has(first) || GENERIC_FAMILIES.has(first)) continue;
			out.push({
				severity: 'error' as const,
				message: `${font.label} uses the font "${font.family}"; the house fonts are ${allowed.map((f) => `"${f}"`).join(', ')}. Change it to one of those.`,
				...(font.target !== undefined ? { target: font.target } : {})
			});
		}
		return out;
	}
};

/**
 * The checks every domain with a `surface` gets: `palette-only`, `min-contrast`,
 * `distinguishable` and `fonts-allowed`. A domain check with the same id replaces one.
 */
export const SHARED_STYLE_CHECKS: readonly StyleCheck<StyleSurface>[] = [paletteOnly, minContrast, distinguishable, fontsAllowed];
