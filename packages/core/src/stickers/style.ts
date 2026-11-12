/**
 * House style for stickers (#779): the `stickers.json` profile (the sticker libraries and
 * collections allowed, licence and AI-art rules, tags the house avoids, and the colours stickers
 * may be tinted), its checks, and `check_sticker_style`.
 *
 * The domain checks stickers before they are placed (or ones already placed, by ref). Findings
 * target a sticker by ref (`{ ref }`); the result also gives the `find_stickers` filters that
 * keep a search inside the house style.
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { StyleSurface, StyleSurfaceColor } from '../tools/style-surface.js';
import { brandPalette } from '../tools/brand.js';
import { parseStickerRef, stickerRefOf } from './helpers';
import { describeStickerRef } from './tools';
import type { StickerDescription, StickerProvider, StickerRef } from './types';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;

/** One sticker the checks read: its ref, what the library says about it, and any tint. */
export interface StickerStyleItem {
	ref: StickerRef;
	description: Pick<StickerDescription, 'name' | 'category' | 'licence'> & Partial<Pick<StickerDescription, 'tags' | 'collection' | 'aiGenerated' | 'tintable'>>;
	/** #rrggbb it is (or will be) tinted to. */
	color?: string;
}

/** What the sticker house-style checks read. */
export interface StickerStyleState {
	stickers: readonly StickerStyleItem[];
}

/** The `stickers.json` profile, after `$token` references are resolved. */
export interface StickerStyleProfile {
	/** Sticker libraries allowed: the provider part of a ref (`acme-brand` in `acme-brand:fox`). */
	libraries?: string[];
	/** Collections allowed (`find_stickers` lists them). */
	collections?: string[];
	/** Only stickers whose licence allows commercial use. */
	commercialOnly?: boolean;
	/** false: no stickers whose art an AI model made. */
	allowAiGenerated?: boolean;
	/** Tags the house avoids. */
	bannedTags?: string[];
	/** Colours tintable stickers may be tinted (for palette-only). Default: the brand's. */
	palette?: string[];
}

/** A finding's target: the sticker, by ref. */
export interface StickerStyleTarget {
	ref: StickerRef;
}

const profileOf = (p: Readonly<Record<string, unknown>>) => p as StickerStyleProfile;
const quote = (list: readonly string[]) => list.map((x) => `"${x}"`).join(', ');
const label = (s: StickerStyleItem) => `Sticker ${s.ref} ("${s.description.name}")`;

const libraries: StyleCheck<StickerStyleState> = {
	id: 'libraries',
	description: 'Stickers come from a house library ("libraries": the provider part of a ref).',
	run(state, profile) {
		const allowed = profileOf(profile).libraries;
		if (!allowed?.length) throw new Error('the profile has no "libraries".');
		return state.stickers
			.filter((s) => !allowed.includes(parseStickerRef(s.ref).provider))
			.map((s) => ({ severity: 'warning' as const, message: `${label(s)} is from "${parseStickerRef(s.ref).provider}"; the house libraries are ${quote(allowed)}. Pick one from those with find_stickers.`, target: { ref: s.ref } satisfies StickerStyleTarget }));
	}
};

const collections: StyleCheck<StickerStyleState> = {
	id: 'collections',
	description: 'Stickers belong to a house collection ("collections").',
	run(state, profile) {
		const allowed = profileOf(profile).collections;
		if (!allowed?.length) throw new Error('the profile has no "collections".');
		return state.stickers
			.filter((s) => !s.description.collection || !allowed.includes(s.description.collection))
			.map((s) => ({ severity: 'warning' as const, message: `${label(s)} is ${s.description.collection ? `in the "${s.description.collection}" collection` : 'in no collection'}; the house collections are ${quote(allowed)}.`, target: { ref: s.ref } satisfies StickerStyleTarget }));
	}
};

const commercial: StyleCheck<StickerStyleState> = {
	id: 'commercial',
	description: 'Every sticker\'s licence allows commercial use ("commercialOnly": true).',
	run(state, profile) {
		if (profileOf(profile).commercialOnly !== true) throw new Error('the profile does not set "commercialOnly": true.');
		return state.stickers
			.filter((s) => !s.description.licence.commercial)
			.map((s) => ({ severity: 'error' as const, message: `${label(s)} is licensed ${s.description.licence.name}, which does not allow commercial use. Pick another (find_stickers with commercial: true).`, target: { ref: s.ref } satisfies StickerStyleTarget }));
	}
};

const aiArt: StyleCheck<StickerStyleState> = {
	id: 'ai-art',
	description: 'No sticker\'s art was made by an AI model ("allowAiGenerated": false). Stickers whose library does not say are let through.',
	run(state, profile) {
		if (profileOf(profile).allowAiGenerated !== false) throw new Error('the profile does not set "allowAiGenerated": false.');
		return state.stickers
			.filter((s) => s.description.aiGenerated === true)
			.map((s) => ({ severity: 'error' as const, message: `${label(s)} is AI-generated art, which the house style does not use. Pick another.`, target: { ref: s.ref } satisfies StickerStyleTarget }));
	}
};

const bannedTags: StyleCheck<StickerStyleState> = {
	id: 'banned-tags',
	description: 'No sticker carries a tag the house avoids ("bannedTags"; the category counts as a tag).',
	run(state, profile) {
		const banned = (profileOf(profile).bannedTags ?? []).map((t) => t.toLowerCase());
		if (!banned.length) throw new Error('the profile has no "bannedTags".');
		const out: Finding[] = [];
		for (const s of state.stickers) {
			const hit = [...(s.description.tags ?? []), s.description.category].map((t) => t.toLowerCase()).filter((t) => banned.includes(t));
			if (hit.length) out.push({ severity: 'warning' as const, message: `${label(s)} is tagged ${quote([...new Set(hit)])}, which the house style avoids.`, target: { ref: s.ref } satisfies StickerStyleTarget });
		}
		return out;
	}
};

/** The tints stickers carry, for the shared checks. */
export function stickerStyleSurface(state: StickerStyleState): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	for (const s of state.stickers) if (s.color) colors.push({ color: s.color, label: `${label(s)} tint`, target: { ref: s.ref } satisfies StickerStyleTarget, use: 'fill' });
	return { colors };
}

/** The sticker house-style domain: register it with `createStyleResolver({ domains })`. */
export const stickerStyleDomain: StyleDomain<StickerStyleState> = {
	id: 'stickers',
	title: 'Stickers',
	description: 'Which stickers the house uses: the libraries and collections allowed, licence and AI-art rules, tags it avoids, and the colours stickers may be tinted.',
	profileSchema: {
		type: 'object',
		properties: {
			libraries: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Sticker libraries allowed: the provider part of a ref ("editor", "acme-brand").' },
			collections: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Collection ids allowed (find_stickers lists them).' },
			commercialOnly: { type: 'boolean', description: 'true: only stickers whose licence allows commercial use.' },
			allowAiGenerated: { type: 'boolean', description: 'false: no stickers whose art an AI model made.' },
			bannedTags: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Tags (and categories) the house avoids.' },
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Colours tintable stickers may be tinted (for palette-only). Default: the brand palette and roles.' }
		},
		additionalProperties: false
	},
	checks: [libraries, collections, commercial, aiArt, bannedTags],
	surface: stickerStyleSurface,
	themeFromBrand: (brand) => {
		const palette = brandPalette(brand);
		return palette.length ? { palette } : {};
	},
	example: {
		libraries: ['editor'],
		commercialOnly: true,
		allowAiGenerated: false,
		checks: ['libraries', 'commercial', 'ai-art', 'palette-only']
	}
};

export interface StickerStyleToolProviderOptions {
	/** The sticker library, read on every call (an editor's `StickersSlot`). */
	provider: () => StickerProvider;
	/** Provider id (unique per registry). Default `sticker-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work: skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
}

/**
 * `check_sticker_style`: checks stickers by ref before they are placed, and gives the
 * `find_stickers` filters that keep a search inside the house style. Read-only.
 */
export function createStickerStyleToolProvider(styles: StyleResolver, options: StickerStyleToolProviderOptions): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'stickers')) throw new Error('The style resolver has no "stickers" domain; add stickerStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

	const check: AgentTool = {
		name: 'check_sticker_style',
		title: 'Check stickers against the house style',
		description:
			'Checks stickers by ref (from find_stickers) against the house style before placing them, or ones already placed (see get_style with domain "stickers"): libraries, collections, commercial (licence), ai-art, banned-tags, and the brand\'s palette-only on tints. Returns findings with a severity, a sentence saying how to fix it, a target { ref } and the layer that asked; the checks that ran and those skipped; and filters: the find_stickers arguments (commercial, collection) that keep a search inside the house style. An unknown ref is refused with the closest refs. Changes nothing.',
		inputSchema: {
			type: 'object',
			properties: {
				stickers: {
					type: 'array',
					minItems: 1,
					maxItems: 100,
					items: {
						type: 'object',
						properties: {
							ref: { type: 'string', minLength: 1, description: 'Sticker ref provider:id from find_stickers (e.g. editor:star).' },
							color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Tint #rrggbb it is or will be placed with (default: none, its own colours).' }
						},
						required: ['ref'],
						additionalProperties: false
					},
					description: 'The stickers to check, up to 100.'
				}
			},
			required: ['stickers'],
			additionalProperties: false
		},
		annotations: { title: 'Check stickers against the house style', ...READ },
		handler: async ({ stickers }) => {
			const p = options.provider();
			const items: StickerStyleItem[] = [];
			for (const s of stickers as { ref: string; color?: string }[]) {
				const d = await describeStickerRef(p, s.ref);
				items.push({ ref: stickerRefOf(p, d.id), description: d, ...(s.color ? { color: s.color.toLowerCase() } : {}) });
			}
			const { style, ...report } = await styles.check('stickers', { stickers: items }, scope);
			const profile = style.profile as StickerStyleProfile;
			const filters = { ...(profile.commercialOnly ? { commercial: true } : {}), ...(profile.collections?.length === 1 ? { collection: profile.collections[0] } : {}) };
			return {
				...report,
				ok: report.findings.length === 0,
				filters,
				...(style.skills.length ? {} : { note: 'No house style applies to stickers.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	return {
		id: options.id ?? 'sticker-style',
		namespace: options.namespace,
		title: 'Sticker house style',
		description: 'Check stickers against the house style before placing them.',
		skill: 'pixerate-stickers',
		tools: [check]
	};
}
