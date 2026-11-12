/**
 * The shared brand profile: a `brand.json` beside a style skill's `SKILL.md` that every editor
 * domain reads. It holds colour roles, an ordered palette, fonts and a logo. Domains derive
 * their own profile from it (`StyleDomain.themeFromBrand`), so a brand-only skill gives every
 * editor a branded starting point; a domain profile (`chart.json`, ...) refines it.
 *
 * Roles are looked up through fallback names, so one profile also accepts Office theme slot
 * names (`accent1`, `dk1`, `lt1`, ...) and common synonyms. Dependency-free.
 */
import type { JsonSchema } from './schema.js';

/** A brand's `brand.json`, after `$token` references are resolved. */
export interface BrandProfile {
	/** Display name of the brand. */
	name?: string;
	/** Colours by role or slot name: `primary`, `text`, `background`, `accent1`, `dk1`, ... */
	colors?: Record<string, string>;
	/** Ordered colours for series, categories and swatches. Default: the role colours in role order. */
	palette?: string[];
	/** Font families (CSS family names). */
	fonts?: { heading?: string; body?: string; mono?: string };
	/** The logo as SVG markup, with its width / height ratio. Place it; never redraw it. */
	logo?: { svg?: string; aspect?: number };
	/** Shared checks to run in every domain that can be checked against the brand. */
	checks?: unknown[];
}

/** The brand colour roles, each with the names it is looked up by, in order. */
export const BRAND_COLOR_ROLES = {
	primary: ['primary', 'brand', 'accent1', 'accent'],
	secondary: ['secondary', 'accent2'],
	accent: ['accent', 'tertiary', 'accent3', 'accent2'],
	background: ['background', 'bg', 'lt1', 'surface'],
	surface: ['surface', 'lt2', 'background', 'lt1'],
	text: ['text', 'foreground', 'fg', 'dk1'],
	mutedText: ['mutedText', 'muted', 'secondaryText', 'dk2'],
	border: ['border', 'line', 'outline', 'dk2'],
	positive: ['positive', 'success', 'good'],
	negative: ['negative', 'error', 'danger', 'bad'],
	link: ['link', 'hlink']
} as const satisfies Record<string, readonly string[]>;

export type BrandColorRole = keyof typeof BRAND_COLOR_ROLES;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The colour a brand gives `role`, through its fallback names, or `undefined`. */
export function brandColor(brand: BrandProfile | undefined, role: BrandColorRole): string | undefined {
	const colors = brand?.colors;
	if (!isPlainObject(colors)) return undefined;
	for (const name of BRAND_COLOR_ROLES[role]) {
		const value = Object.hasOwn(colors, name) ? colors[name] : undefined;
		if (typeof value === 'string' && value) return value;
	}
	return undefined;
}

/** Every role the brand gives a colour, by role name. */
export function brandColors(brand: BrandProfile | undefined): Partial<Record<BrandColorRole, string>> {
	const out: Partial<Record<BrandColorRole, string>> = {};
	for (const role of Object.keys(BRAND_COLOR_ROLES) as BrandColorRole[]) {
		const value = brandColor(brand, role);
		if (value) out[role] = value;
	}
	return out;
}

const SERIES_SLOTS = ['primary', 'secondary', 'accent', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];

/**
 * The brand's ordered palette: `palette` when it has one, else the series colours it names
 * (`primary`, `secondary`, `accent`, then `accent1`…`accent6`), without repeats.
 */
export function brandPalette(brand: BrandProfile | undefined): string[] {
	if (Array.isArray(brand?.palette) && brand.palette.length) return brand.palette.filter((c): c is string => typeof c === 'string' && !!c);
	const colors = brand?.colors;
	if (!isPlainObject(colors)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	const add = (value: unknown) => {
		if (typeof value !== 'string' || !value) return;
		const key = value.trim().toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push(value);
	};
	add(brandColor(brand, 'primary'));
	add(brandColor(brand, 'secondary'));
	add(brandColor(brand, 'accent'));
	for (const slot of SERIES_SLOTS) add(Object.hasOwn(colors, slot) ? colors[slot] : undefined);
	return out;
}

/** The font families the brand names (heading, body, mono), without repeats. */
export function brandFonts(brand: BrandProfile | undefined): string[] {
	const fonts = brand?.fonts;
	if (!isPlainObject(fonts)) return [];
	return [...new Set([fonts.heading, fonts.body, fonts.mono].filter((f): f is string => typeof f === 'string' && !!f))];
}

const COLOR = { type: 'string', minLength: 1, description: 'A CSS colour (hex, rgb() or a name), or a { "$token": ... } reference.' } as const;

/** JSON Schema of `brand.json` (its `checks` list is validated against the shared checks). */
export const BRAND_PROFILE_SCHEMA: JsonSchema & { type: 'object' } = {
	type: 'object',
	properties: {
		name: { type: 'string', minLength: 1, description: 'Display name of the brand.' },
		colors: {
			type: 'object',
			additionalProperties: COLOR,
			description: `Colours by role or slot name. Roles and the names each is looked up by: ${Object.entries(BRAND_COLOR_ROLES)
				.map(([role, names]) => `${role} (${names.join(', ')})`)
				.join('; ')}.`
		},
		palette: { type: 'array', items: COLOR, minItems: 1, description: 'Ordered colours for series, categories and swatches. Default: primary, secondary, accent, then accent1–accent6.' },
		fonts: {
			type: 'object',
			properties: {
				heading: { type: 'string', minLength: 1, description: 'CSS font family for headings and titles.' },
				body: { type: 'string', minLength: 1, description: 'CSS font family for body text and labels.' },
				mono: { type: 'string', minLength: 1, description: 'CSS font family for code and figures.' }
			},
			additionalProperties: false,
			description: 'Font families.'
		},
		logo: {
			type: 'object',
			properties: {
				svg: { type: 'string', minLength: 1, description: 'The logo as one <svg> element.' },
				aspect: { type: 'number', exclusiveMinimum: 0, description: 'Width divided by height.' }
			},
			additionalProperties: false,
			description: 'The logo. Agents place it as given and never redraw it.'
		}
	},
	additionalProperties: false
};
