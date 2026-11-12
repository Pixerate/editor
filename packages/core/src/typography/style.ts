/**
 * House style for typography (#779): the `typography.json` profile (the weights and sizes of
 * the house type scale, line-height and tracking ranges, and the fonts allowed), its checks,
 * and `check_typography_style` / `fix_typography_style` over a font picker.
 *
 * The domain works on a font selection (`{ family, weight, style, size, lineHeight,
 * letterSpacing }`, what `get_font_selection` returns). Findings target a field with the
 * value to set when the fix is certain (`{ field: "size", value: 16 }`).
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { StyleSurface } from '../tools/style-surface.js';
import { brandFonts } from '../tools/brand.js';
import type { FontPickerModel, FontPickerState } from './picker.js';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;

/** What the typography house-style checks read: one font selection. */
export type TypographyStyleState = Pick<FontPickerState['value'], 'family' | 'size' | 'lineHeight' | 'letterSpacing'> & { weight: number; style?: string };

/** The `typography.json` profile, after `$token` references are resolved. */
export interface TypographyStyleProfile {
	/** Font weights allowed (100–900). */
	weights?: number[];
	/** Font sizes allowed, in px: the house type scale. */
	sizes?: number[];
	/** Unitless line-height range. */
	lineHeight?: { min?: number; max?: number };
	/** Tracking range, in em. */
	letterSpacing?: { min?: number; max?: number };
	/** Fonts allowed (for fonts-allowed). Default: the brand fonts. */
	fonts?: string[];
}

/** A finding's target: a field of the selection, and the value to set when the fix is certain. */
export interface TypographyStyleTarget {
	field: 'family' | 'weight' | 'size' | 'lineHeight' | 'letterSpacing';
	value?: number | string;
}

const profileOf = (p: Readonly<Record<string, unknown>>) => p as TypographyStyleProfile;
const nearest = (value: number, allowed: readonly number[]) => allowed.reduce((best, a) => (Math.abs(a - value) < Math.abs(best - value) ? a : best), allowed[0]);

const weights: StyleCheck<TypographyStyleState> = {
	id: 'weights',
	description: 'The weight is one of the house weights ("weights", e.g. [400, 600]).',
	run(state, profile) {
		const allowed = profileOf(profile).weights;
		if (!allowed?.length) throw new Error('the profile has no "weights".');
		if (allowed.includes(state.weight)) return [];
		const want = nearest(state.weight, allowed);
		return [{ severity: 'warning' as const, message: `Weight ${state.weight} is not a house weight (${allowed.join(', ')}); use ${want}.`, target: { field: 'weight', value: want } satisfies TypographyStyleTarget }];
	}
};

const sizes: StyleCheck<TypographyStyleState> = {
	id: 'sizes',
	description: 'The size is a step of the house type scale ("sizes", in px).',
	run(state, profile) {
		const allowed = profileOf(profile).sizes;
		if (!allowed?.length) throw new Error('the profile has no "sizes".');
		if (allowed.some((s) => Math.abs(s - state.size) < 0.01)) return [];
		const want = nearest(state.size, allowed);
		return [{ severity: 'warning' as const, message: `${state.size}px is off the house type scale (${allowed.join(', ')}); use ${want}px.`, target: { field: 'size', value: want } satisfies TypographyStyleTarget }];
	}
};

/** A check that a number stays in a `{ min, max }` range of the profile. */
function range(id: string, field: 'lineHeight' | 'letterSpacing', what: string, unit: string): StyleCheck<TypographyStyleState> {
	return {
		id,
		description: `The ${what} stays within the house range ("${field}": { min, max }, ${unit}).`,
		run(state, profile) {
			const r = profileOf(profile)[field];
			if (!r || (r.min === undefined && r.max === undefined)) throw new Error(`the profile has no "${field}" range.`);
			const v = state[field];
			const want = r.min !== undefined && v < r.min ? r.min : r.max !== undefined && v > r.max ? r.max : undefined;
			if (want === undefined) return [];
			const out: Finding[] = [{ severity: 'warning' as const, message: `A ${what} of ${v} is ${v < want ? 'below' : 'above'} the house range (${r.min ?? '…'}–${r.max ?? '…'}); use ${want}.`, target: { field, value: want } satisfies TypographyStyleTarget }];
			return out;
		}
	};
}

/** The selection's font, for the shared fonts-allowed check. */
export const typographyStyleSurface = (state: TypographyStyleState): StyleSurface => ({
	fonts: state.family ? [{ family: state.family, label: 'The selected font', target: { field: 'family' } satisfies TypographyStyleTarget }] : []
});

/** The typography house-style domain: register it with `createStyleResolver({ domains })`. */
export const typographyStyleDomain: StyleDomain<TypographyStyleState> = {
	id: 'typography',
	title: 'Typography',
	description: 'The house type: the fonts allowed, the weights and the sizes of the type scale, and the line-height and tracking ranges.',
	profileSchema: {
		type: 'object',
		properties: {
			weights: { type: 'array', items: { type: 'integer', minimum: 100, maximum: 900 }, minItems: 1, description: 'Font weights allowed, e.g. [400, 600].' },
			sizes: { type: 'array', items: { type: 'number', exclusiveMinimum: 0 }, minItems: 1, description: 'Font sizes allowed, in px: the house type scale, e.g. [12, 14, 16, 20, 25, 31].' },
			lineHeight: {
				type: 'object',
				properties: { min: { type: 'number', minimum: 0.5, maximum: 4, description: 'Least unitless line-height.' }, max: { type: 'number', minimum: 0.5, maximum: 4, description: 'Greatest unitless line-height.' } },
				additionalProperties: false,
				description: 'Unitless line-height range, e.g. { "min": 1.3, "max": 1.7 }.'
			},
			letterSpacing: {
				type: 'object',
				properties: { min: { type: 'number', minimum: -0.5, maximum: 1, description: 'Least tracking, in em.' }, max: { type: 'number', minimum: -0.5, maximum: 1, description: 'Greatest tracking, in em.' } },
				additionalProperties: false,
				description: 'Tracking range, in em.'
			},
			fonts: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Fonts allowed (for fonts-allowed). Default: the brand fonts.' }
		},
		additionalProperties: false
	},
	checks: [weights, sizes, range('line-height', 'lineHeight', 'line-height', 'unitless'), range('letter-spacing', 'letterSpacing', 'tracking', 'em')],
	surface: typographyStyleSurface,
	themeFromBrand: (brand) => {
		const fonts = brandFonts(brand);
		return fonts.length ? { fonts } : {};
	},
	example: {
		weights: [400, 600, 700],
		sizes: [12, 14, 16, 20, 25, 31, 39],
		lineHeight: { min: 1.3, max: 1.7 },
		letterSpacing: { min: -0.02, max: 0.05 },
		checks: ['weights', 'sizes', 'line-height', 'letter-spacing', 'fonts-allowed']
	}
};

export interface TypographyStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `typography-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work: skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
	/** As for `createTypographyToolProvider`: a reason hides `fix_typography_style`. */
	readOnly?: () => string | false;
}

/**
 * `check_typography_style` and, while the picker is editable, `fix_typography_style` (snaps the
 * selection to the house weight, size, line-height and tracking, and to an allowed font the
 * picker offers, in one change).
 */
export function createTypographyStyleToolProvider(model: FontPickerModel, styles: StyleResolver, options: TypographyStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'typography')) throw new Error('The style resolver has no "typography" domain; add typographyStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
	const run = () => styles.check('typography', model.getState().value as TypographyStyleState, scope);

	/** The first allowed font the picker offers, for a fonts-allowed finding. */
	const allowedFamily = (profile: Readonly<Record<string, unknown>>, brandFamilies: string[]): string | undefined => {
		const allowed = (profileOf(profile).fonts ?? brandFamilies).map((f) => f.toLowerCase());
		return model.getState().fonts.find((f) => allowed.includes(f.family.toLowerCase()))?.family;
	};

	const check: AgentTool = {
		name: 'check_typography_style',
		title: 'Check typography house style',
		description:
			'Checks the font picker\'s selection against the house style (see get_style with domain "typography"): weights, sizes (the type scale), line-height, letter-spacing, and the brand\'s fonts-allowed. Returns findings with a severity, a sentence saying how to fix it, a target { field, value? } (the value to set when certain) and the layer that asked; the checks that ran and those skipped. fix_typography_style applies the certain fixes at once.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check typography house style', ...READ },
		handler: async () => {
			const { style, ...report } = await run();
			return {
				...report,
				ok: report.findings.length === 0,
				...(style.skills.length ? {} : { note: 'No house style applies to typography.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_typography_style',
		title: 'Fix typography house style',
		description:
			'Snaps the font selection to the house style in one change: the nearest house weight and type-scale size, line-height and tracking into their ranges, and an allowed font the picker offers when the font is not allowed. Returns how many fields it fixed, the new selection and the findings left. Run check_typography_style after.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Fix typography house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const reason = options.readOnly?.();
			if (reason) throw new Error(`The font picker is read-only: ${reason}`);
			const { findings, style } = await run();
			const patch: Record<string, unknown> = {};
			const left: StyleFinding[] = [];
			for (const f of findings) {
				const t = f.target as TypographyStyleTarget | undefined;
				if (t?.field === 'family' && t.value === undefined) {
					const family = allowedFamily(style.profile, brandFonts(style.brand));
					if (family) patch.family = family;
					else left.push(f);
				} else if (t && t.value !== undefined) patch[t.field] = t.value;
				else left.push(f);
			}
			if (Object.keys(patch).length) model.setValue(patch);
			return { fixed: Object.keys(patch).length, selection: model.getState().value, left };
		}
	};

	return {
		id: options.id ?? 'typography-style',
		namespace: options.namespace,
		title: 'Typography house style',
		description: 'Check the font selection against the house style and snap it to the house type.',
		skill: 'pixerate-typography',
		tools: () => (options.readOnly?.() ? [check] : [check, fix])
	};
}
