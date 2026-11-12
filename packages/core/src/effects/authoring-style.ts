/**
 * House style for effect authoring (#779): the `effect-authoring.json` profile (the source
 * languages allowed, a timing rule, the presets every effect ships with, and the colours colour
 * controls may use), its checks, and `check_effect_authoring_style` /
 * `fix_effect_authoring_style`.
 *
 * Findings target the timeline (`{ timing: { duration?, loop? } }`, the house timing), the source
 * (`{ source: language }`), a preset (`{ preset: name }`) or a control (`{ control: name }`).
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { StyleSurface, StyleSurfaceColor } from '../tools/style-surface.js';
import { brandPalette } from '../tools/brand.js';
import type { EffectAuthoringState } from './authoring.js';
import type { EffectAuthoringToolHost } from './authoring-tools.js';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;

/** The source languages an authored effect may be written in. */
const LANGUAGES = ['pixel', 'glsl', 'svg'] as const;

/** The `effect-authoring.json` profile, after `$token` references are resolved. */
export interface EffectAuthoringStyleProfile {
	/** Source languages allowed (pixel, glsl, svg). Effects with no editable source pass. */
	languages?: (typeof LANGUAGES)[number][];
	/** Longest timeline, in ms. */
	maxDuration?: number;
	/** Whether effects loop. */
	loop?: boolean;
	/** Presets every effect ships with, by name ("Subtle", "Strong"). */
	presets?: string[];
	/** Colours colour controls may use (for palette-only). Default: the brand's. */
	palette?: string[];
}

/** A finding's target. */
export type EffectAuthoringStyleTarget = { timing: { duration?: number; loop?: boolean } } | { source: string } | { preset: string } | { control: string };

const profileOf = (p: Readonly<Record<string, unknown>>) => p as EffectAuthoringStyleProfile;
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

const languages: StyleCheck<EffectAuthoringState> = {
	id: 'languages',
	description: 'The effect\'s source is in a house language ("languages": pixel, glsl, svg). Effects with no editable source pass.',
	run(state, profile) {
		const allowed = profileOf(profile).languages;
		if (!allowed?.length) throw new Error('the profile has no "languages".');
		if (!state.sourceLanguage || allowed.includes(state.sourceLanguage)) return [];
		return [{ severity: 'error' as const, message: `"${state.name}" is written in ${state.sourceLanguage}; the house languages are ${allowed.join(', ')}. Rewrite it in ${allowed[0]}, starting from a template.`, target: { source: state.sourceLanguage } satisfies EffectAuthoringStyleTarget }];
	}
};

const timing: StyleCheck<EffectAuthoringState> = {
	id: 'timing',
	description: 'The timeline is at most "maxDuration" ms and loops as "loop" says.',
	run(state, profile) {
		const { maxDuration, loop } = profileOf(profile);
		if (maxDuration === undefined && loop === undefined) throw new Error('the profile has no "maxDuration" or "loop".');
		const out: Finding[] = [];
		if (maxDuration !== undefined && state.duration > maxDuration) out.push({ severity: 'warning' as const, message: `The timeline is ${state.duration} ms; the house limit is ${maxDuration} ms.`, target: { timing: { duration: maxDuration } } satisfies EffectAuthoringStyleTarget });
		if (loop !== undefined && state.loop !== loop) out.push({ severity: 'info' as const, message: `The effect ${state.loop ? 'loops' : 'plays once'}; house effects ${loop ? 'loop' : 'play once'}.`, target: { timing: { loop } } satisfies EffectAuthoringStyleTarget });
		return out;
	}
};

const presets: StyleCheck<EffectAuthoringState> = {
	id: 'presets',
	description: 'The effect ships every house preset ("presets", by name; case does not matter).',
	run(state, profile) {
		const want = profileOf(profile).presets;
		if (!want?.length) throw new Error('the profile has no "presets".');
		const have = new Set(state.description.presets.map((p) => p.name.toLowerCase()));
		return want
			.filter((name) => !have.has(name.toLowerCase()))
			.map((name) => ({ severity: 'info' as const, message: `The effect has no "${name}" preset. Set its values, then save it with effect_authoring_save_preset.`, target: { preset: name } satisfies EffectAuthoringStyleTarget }));
	}
};

/** The colours colour controls hold at the playhead, for the shared checks. */
export function effectAuthoringStyleSurface(state: EffectAuthoringState): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	for (const [name, schema] of Object.entries(state.description.controls.properties)) {
		const v = state.values[name];
		if (typeof v !== 'string' || !HEX.test(v)) continue;
		const title = typeof schema.title === 'string' ? schema.title : name;
		colors.push({ color: v, label: `Control ${title}`, target: { control: name } satisfies EffectAuthoringStyleTarget, use: 'fill' });
	}
	return { colors };
}

/** The effect authoring house-style domain: register it with `createStyleResolver({ domains })`. */
export const effectAuthoringStyleDomain: StyleDomain<EffectAuthoringState> = {
	id: 'effect-authoring',
	title: 'Authored effects',
	description: 'How effects are authored: the source languages allowed, timeline length and looping, the presets every effect ships, and the colours colour controls may use.',
	profileSchema: {
		type: 'object',
		properties: {
			languages: { type: 'array', items: { type: 'string', enum: [...LANGUAGES] }, minItems: 1, description: 'Source languages allowed; effects with no editable source pass.' },
			maxDuration: { type: 'number', exclusiveMinimum: 0, description: 'Longest timeline, ms.' },
			loop: { type: 'boolean', description: 'Whether effects loop.' },
			presets: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Presets every effect ships with, by name.' },
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Colours colour controls may use (for palette-only). Default: the brand palette and roles.' }
		},
		additionalProperties: false
	},
	checks: [languages, timing, presets],
	surface: effectAuthoringStyleSurface,
	themeFromBrand: (brand) => {
		const palette = brandPalette(brand);
		return palette.length ? { palette } : {};
	},
	example: {
		languages: ['pixel'],
		maxDuration: 4000,
		loop: true,
		presets: ['Subtle', 'Strong'],
		checks: ['languages', 'timing', 'presets', 'palette-only']
	}
};

export interface EffectAuthoringStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `effect-authoring-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work: skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
	/** The effect cannot be changed: `fix_effect_authoring_style` is hidden (a string is the reason). */
	readOnly?: boolean | string | (() => boolean | string);
}

const NO_SESSION = 'No effect is open for authoring. Open one first (open_effect_authoring in the paint editor, or the host\'s own way).';

/**
 * `check_effect_authoring_style` and, while editable, `fix_effect_authoring_style` (sets the house
 * timing as one undo step) for the session a host has open.
 */
export function createEffectAuthoringStyleToolProvider(host: Pick<EffectAuthoringToolHost, 'session' | 'noSession' | 'subscribe'>, styles: StyleResolver, options: EffectAuthoringStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'effect-authoring')) throw new Error('The style resolver has no "effect-authoring" domain; add effectAuthoringStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (!r) return null;
		return typeof r === 'string' ? r : 'This effect is read-only.';
	};
	const session = () => {
		const s = host.session();
		if (!s) throw new Error(host.noSession ?? NO_SESSION);
		return s;
	};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
	const run = () => styles.check('effect-authoring', session().getState(), scope);

	const check: AgentTool = {
		name: 'check_effect_authoring_style',
		title: 'Check the open effect against the house style',
		description:
			'Checks the effect open for authoring against the house style (see get_style with domain "effect-authoring"): languages (its source language), timing (duration and loop), presets (the ones every effect ships), and the brand\'s palette-only on colour controls at the playhead. Returns findings with a severity, a sentence saying how to fix it, a target ({ timing: { duration?, loop? } } with the house timing, { source: language }, { preset: name } or { control: name }) and the layer that asked; the checks that ran and those skipped. fix_effect_authoring_style sets the house timing.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check the open effect against the house style', ...READ },
		handler: async () => {
			const { style, ...report } = await run();
			return {
				...report,
				ok: report.findings.length === 0,
				...(style.skills.length ? {} : { note: 'No house style applies to authored effects.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_effect_authoring_style',
		title: 'Fix the open effect\'s house style',
		description:
			'Sets the house timing (duration within the limit, looping as the house says) on the open effect as one undo step. Presets, colours and the source language are left for you (effect_authoring_save_preset, effect_authoring_set_values, a rewrite). Returns { timing: what it set, duration and loop now, left: findings it did not fix }. Run check_effect_authoring_style after.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Fix the open effect\'s house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			const s = session();
			const { findings } = await run();
			const set: { duration?: number; loop?: boolean } = {};
			const left: StyleFinding[] = [];
			for (const f of findings) {
				const t = f.target as EffectAuthoringStyleTarget | undefined;
				if (t && 'timing' in t) Object.assign(set, t.timing);
				else left.push(f);
			}
			if (Object.keys(set).length) {
				const result = s.setTiming(set);
				if (!result.ok) throw new Error(result.message);
			}
			const now = s.getState();
			return { timing: set, duration: now.duration, loop: now.loop, left };
		}
	};

	return {
		id: options.id ?? 'effect-authoring-style',
		namespace: options.namespace,
		title: 'Effect authoring house style',
		description: 'Check the effect open for authoring against the house style and set the house timing.',
		skill: 'pixerate-effect-authoring',
		tools: () => (readOnlyReason() ? [check] : [check, fix]),
		...(host.subscribe ? { subscribe: host.subscribe } : {})
	};
}
