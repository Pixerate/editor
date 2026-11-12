/**
 * House style for brushes (#779): the `brushes.json` profile (the brushes and media allowed, a
 * licence rule for image sources, and the colours brushes may suggest), its checks, and
 * `check_brush_style`.
 *
 * The checks read brushes from a brush library: by default the user's saved brushes (built-ins
 * are the package's own), or any brushes by id before painting with them. Findings target a
 * brush (`{ brush: id }`, with `colour` for one of its colours) or an image source
 * (`{ source: id }`).
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { StyleSurface, StyleSurfaceColor } from '../tools/style-surface.js';
import { brandPalette } from '../tools/brand.js';
import { brushColourHex } from './colour';
import { closest, type BrushLibrary } from './library';
import { brushSourceIds, type BrushSource } from './sources';
import { BRUSH_MEDIA, type Brush, type BrushMedium } from './types';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;

/** What the brush house-style checks read. */
export interface BrushStyleState {
	/** The brushes to check, with whether each is built in. */
	brushes: readonly { brush: Brush; builtin: boolean }[];
	/** The library's image sources (only those the brushes use are checked). */
	sources: readonly Pick<BrushSource, 'id' | 'name' | 'licence' | 'origin'>[];
}

/** The `brushes.json` profile, after `$token` references are resolved. */
export interface BrushStyleProfile {
	/** Brush ids allowed (built-in or saved). */
	brushes?: string[];
	/** Media mark brushes may lay (paint, ink, dry, spray). Tool brushes (erasers, blenders) always pass. */
	media?: BrushMedium[];
	/** Every image source a brush uses records its licence. */
	requireSourceLicence?: boolean;
	/** Colours brushes may suggest (for palette-only). Default: the brand's. */
	palette?: string[];
}

/** A finding's target. */
export type BrushStyleTarget = { brush: string; colour?: 'default' | number } | { source: string };

const profileOf = (p: Readonly<Record<string, unknown>>) => p as BrushStyleProfile;
const label = (b: Brush) => `Brush ${b.id} ("${b.name}")`;

const brushes: StyleCheck<BrushStyleState> = {
	id: 'brushes',
	description: 'Brushes are house brushes ("brushes": ids, built-in or saved).',
	run(state, profile) {
		const allowed = profileOf(profile).brushes;
		if (!allowed?.length) throw new Error('the profile has no "brushes".');
		return state.brushes
			.filter(({ brush }) => !allowed.includes(brush.id))
			.map(({ brush }) => ({ severity: 'warning' as const, message: `${label(brush)} is not a house brush; the house brushes are ${allowed.join(', ')}.`, target: { brush: brush.id } satisfies BrushStyleTarget }));
	}
};

const media: StyleCheck<BrushStyleState> = {
	id: 'media',
	description: 'Mark brushes lay a house medium ("media": paint, ink, dry, spray). Tool brushes pass.',
	run(state, profile) {
		const allowed = profileOf(profile).media;
		if (!allowed?.length) throw new Error('the profile has no "media".');
		return state.brushes
			.filter(({ brush }) => brush.kind === 'mark' && brush.medium !== undefined && !allowed.includes(brush.medium))
			.map(({ brush }) => ({ severity: 'warning' as const, message: `${label(brush)} lays ${brush.medium}; the house media are ${allowed.join(', ')}.`, target: { brush: brush.id } satisfies BrushStyleTarget }));
	}
};

const sourceLicences: StyleCheck<BrushStyleState> = {
	id: 'source-licences',
	description: 'Every image source a brush lays or textures with records its licence ("requireSourceLicence": true).',
	run(state, profile) {
		if (profileOf(profile).requireSourceLicence !== true) throw new Error('the profile does not set "requireSourceLicence": true.');
		const used = new Map<string, string[]>();
		for (const { brush } of state.brushes) for (const id of brushSourceIds(brush)) used.set(id, [...(used.get(id) ?? []), brush.id]);
		const out: Finding[] = [];
		for (const s of state.sources) {
			const by = used.get(s.id);
			if (!by || s.licence?.trim()) continue;
			out.push({ severity: 'warning' as const, message: `Image source ${s.id} ("${s.name}"${s.origin ? `, from ${s.origin}` : ''}) used by ${by.join(', ')} records no licence. Re-add it with add_brush_source and its licence, or replace it.`, target: { source: s.id } satisfies BrushStyleTarget });
		}
		return out;
	}
};

/** The colours brushes suggest (their default and palette), for the shared checks. */
export function brushStyleSurface(state: BrushStyleState): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	for (const { brush } of state.brushes) {
		const def = brushColourHex(brush.colour?.default, 'light');
		if (def) colors.push({ color: def, label: `${label(brush)} default colour`, target: { brush: brush.id, colour: 'default' } satisfies BrushStyleTarget, use: 'fill' });
		(brush.colour?.palette ?? []).forEach((c, i) => {
			const hex = brushColourHex(c, 'light');
			if (hex) colors.push({ color: hex, label: `${label(brush)} palette colour ${i + 1}`, target: { brush: brush.id, colour: i } satisfies BrushStyleTarget, use: 'fill' });
		});
	}
	return { colors };
}

/** The brush house-style domain: register it with `createStyleResolver({ domains })`. */
export const brushStyleDomain: StyleDomain<BrushStyleState> = {
	id: 'brushes',
	title: 'Brushes',
	description: 'Which brushes the house uses: the brushes and media allowed, a licence rule for image sources, and the colours brushes may suggest.',
	profileSchema: {
		type: 'object',
		properties: {
			brushes: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Brush ids allowed, built-in or saved (list_brush_presets lists them).' },
			media: { type: 'array', items: { type: 'string', enum: [...BRUSH_MEDIA] }, minItems: 1, description: 'Media mark brushes may lay; tool brushes always pass.' },
			requireSourceLicence: { type: 'boolean', description: 'true: every image source a brush uses records its licence.' },
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Colours brushes may suggest (for palette-only). Default: the brand palette and roles.' }
		},
		additionalProperties: false
	},
	checks: [brushes, media, sourceLicences],
	surface: brushStyleSurface,
	themeFromBrand: (brand) => {
		const palette = brandPalette(brand);
		return palette.length ? { palette } : {};
	},
	example: {
		media: ['paint', 'dry'],
		requireSourceLicence: true,
		checks: ['media', 'source-licences', 'palette-only']
	}
};

/** The brush house-style checks' state from a library: the user's saved brushes, or `ids` (built-ins included). */
export async function brushStyleState(library: Pick<BrushLibrary, 'list' | 'get' | 'listSources'>, ids?: readonly string[]): Promise<BrushStyleState> {
	let entries: { brush: Brush; builtin: boolean }[];
	if (ids) {
		entries = [];
		const missing: string[] = [];
		for (const id of ids) {
			const e = await library.get(id);
			if (e) entries.push(e);
			else missing.push(id);
		}
		if (missing.length) {
			const known = (await library.list()).map((e) => e.brush.id);
			throw new Error(`No brush ${missing.map((m) => `"${m}"`).join(', ')}. ${missing.map((m) => closest(m, known)).filter(Boolean).join(' ')} list_brush_presets lists them.`.replace(/\s+/g, ' ').trim());
		}
	} else entries = await library.list({ source: 'user' });
	const sources = (await library.listSources()).map(({ id, name, licence, origin }) => ({ id, name, ...(licence ? { licence } : {}), ...(origin ? { origin } : {}) }));
	return { brushes: entries, sources };
}

export interface BrushStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `brush-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work: skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
}

/** `check_brush_style`: checks the user's saved brushes, or brushes by id, against the house style. Read-only. */
export function createBrushStyleToolProvider(library: Pick<BrushLibrary, 'list' | 'get' | 'listSources'>, styles: StyleResolver, options: BrushStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'brushes')) throw new Error('The style resolver has no "brushes" domain; add brushStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

	const check: AgentTool = {
		name: 'check_brush_style',
		title: 'Check brushes against the house style',
		description:
			'Checks brushes against the house style (see get_style with domain "brushes"): brushes (ids allowed), media, source-licences (image sources a brush uses), and the brand\'s palette-only on the colours brushes suggest. By default it checks the user\'s saved brushes; pass ids to check any brushes, built-ins included, before painting with them. Returns findings with a severity, a sentence saying how to fix it, a target ({ brush, colour? } or { source }) and the layer that asked; the checks that ran and those skipped; and checked: the brush ids it read. An unknown id is refused with the closest ids. Changes nothing; fix a saved brush with update_brush.',
		inputSchema: {
			type: 'object',
			properties: { ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, description: 'A brush id from list_brush_presets.' }, description: 'Brushes to check, built-ins included (default: the user\'s saved brushes).' } },
			additionalProperties: false
		},
		annotations: { title: 'Check brushes against the house style', ...READ },
		handler: async ({ ids }) => {
			const state = await brushStyleState(library, ids as string[] | undefined);
			const { style, ...report } = await styles.check('brushes', state, scope);
			return {
				...report,
				ok: report.findings.length === 0,
				checked: state.brushes.map((e) => e.brush.id),
				...(style.skills.length ? {} : { note: 'No house style applies to brushes.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	return {
		id: options.id ?? 'brush-style',
		namespace: options.namespace,
		title: 'Brush house style',
		description: 'Check brushes against the house style.',
		skill: 'pixerate-brushes',
		tools: [check]
	};
}
