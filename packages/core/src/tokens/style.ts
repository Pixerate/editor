/**
 * House style and design tokens: `createTokenStyleSource` resolves `$token` references in any
 * domain's profile, and the `tokens.json` profile checks the token set itself (required
 * variables and modes, naming, contrast pairs) through `check_tokens_style`.
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleResolver, StyleTokenSource } from '../tools/style.js';
import { parseColor } from '../color/parse.js';
import { contrastRatio } from '../color/contrast.js';
import { findTokenMode, findTokenVariable, getTokenCollection, getTokenVariable, resolveToken } from './model.js';
import type { TokenState } from './types.js';
import type { TokenStore } from './store.js';

/** The variable a reference names: an id, else a name (`brand/primary`). */
function findVariable(state: TokenState, ref: string) {
	return getTokenVariable(state, ref) ?? findTokenVariable(state, ref);
}

/** Resolves house-style `$token` references against a token store (pass it as `tokens` to `createStyleResolver`). */
export function createTokenStyleSource(store: TokenStore): StyleTokenSource {
	return {
		resolve({ token, mode }) {
			const state = store.getState();
			const variable = findVariable(state, token);
			if (!variable) return { ok: false, message: `there is no design token "${token}".` };
			let modes: Record<string, string> | undefined;
			if (mode !== undefined) {
				const collection = getTokenCollection(state, variable.collectionId)!;
				const found = findTokenMode(collection, mode);
				if (!found) return { ok: false, message: `"${collection.name}" has no mode "${mode}"; its modes are ${collection.modes.map((m) => `"${m.name}"`).join(', ')}.` };
				modes = { [collection.id]: found.id };
			}
			const resolved = resolveToken(state, variable.id, modes);
			return resolved.ok ? { ok: true, value: resolved.value } : { ok: false, message: `"${token}" does not resolve: ${resolved.message}` };
		},
		subscribe: (listener) => store.subscribe(() => listener())
	};
}

/** A `tokens.json` house-style profile. */
export interface TokensStyleProfile {
	/** Variable names that must exist. */
	required?: string[];
	/** Regular expression every variable name must match. */
	namePattern?: string;
	/** Mode names every collection must have. */
	modes?: string[];
	/** Colour pairs that must reach a contrast ratio in every mode. */
	contrastPairs?: { fg: string; bg: string; ratio?: number }[];
}

const profileOf = (profile: Readonly<Record<string, unknown>>) => profile as TokensStyleProfile;

const requiredVariables: StyleCheck<TokenState> = {
	id: 'required-variables',
	description: 'Every variable named in the profile\'s "required" list exists.',
	run(state, profile) {
		const required = profileOf(profile).required;
		if (!required?.length) throw new Error('the profile has no "required" list.');
		return required
			.filter((name) => !findVariable(state, name))
			.map((name) => ({ severity: 'error' as const, message: `The token set has no variable "${name}"; add it (house style requires it).`, target: { variable: name } }));
	}
};

const namePattern: StyleCheck<TokenState> = {
	id: 'name-pattern',
	description: 'Every variable name matches the profile\'s "namePattern" regular expression.',
	run(state, profile) {
		const pattern = profileOf(profile).namePattern;
		if (!pattern) throw new Error('the profile has no "namePattern".');
		let re: RegExp;
		try {
			re = new RegExp(pattern);
		} catch {
			throw new Error(`"namePattern" ${pattern} is not a valid regular expression.`);
		}
		return state.variables
			.filter((v) => !re.test(v.name))
			.map((v) => ({ severity: 'warning' as const, message: `Variable "${v.name}" does not match the naming pattern ${pattern}; rename it.`, target: { variableId: v.id } }));
	}
};

const requiredModes: StyleCheck<TokenState> = {
	id: 'required-modes',
	description: 'Every collection has the modes named in the profile\'s "modes" list (e.g. Light and Dark).',
	run(state, profile) {
		const modes = profileOf(profile).modes;
		if (!modes?.length) throw new Error('the profile has no "modes" list.');
		return state.collections.flatMap((c) =>
			modes
				.filter((m) => !findTokenMode(c, m))
				.map((m) => ({ severity: 'error' as const, message: `Collection "${c.name}" has no "${m}" mode; add it.`, target: { collectionId: c.id } }))
		);
	}
};

const contrastPairs: StyleCheck<TokenState> = {
	id: 'contrast-pairs',
	description: 'Each foreground / background pair in "contrastPairs" reaches its contrast ratio (default 4.5) in every mode of the foreground\'s collection.',
	run(state, profile) {
		const pairs = profileOf(profile).contrastPairs;
		if (!pairs?.length) throw new Error('the profile has no "contrastPairs".');
		const findings = [];
		for (const { fg, bg, ratio = 4.5 } of pairs) {
			const f = findVariable(state, fg);
			const b = findVariable(state, bg);
			if (!f || !b) {
				findings.push({ severity: 'error' as const, message: `Contrast pair ${fg} on ${bg} names a variable the token set lacks (${!f ? fg : bg}).`, target: { variable: !f ? fg : bg } });
				continue;
			}
			const collection = getTokenCollection(state, f.collectionId)!;
			for (const mode of collection.modes) {
				const modes = { [collection.id]: mode.id, [b.collectionId]: findTokenMode(getTokenCollection(state, b.collectionId)!, mode.name)?.id ?? mode.id };
				const fv = resolveToken(state, f.id, modes);
				const bv = resolveToken(state, b.id, modes);
				const fc = fv.ok && typeof fv.value === 'string' ? parseColor(fv.value) : null;
				const bc = bv.ok && typeof bv.value === 'string' ? parseColor(bv.value) : null;
				if (!fc || !bc) continue;
				const r = contrastRatio(fc, bc);
				if (r < ratio) {
					findings.push({
						severity: 'error' as const,
						message: `${f.name} on ${b.name} has contrast ${Math.round(r * 100) / 100}:1 in ${mode.name}; want at least ${ratio}:1, so darken or lighten one of them in that mode.`,
						target: { variableId: f.id, modeId: mode.id }
					});
				}
			}
		}
		return findings;
	}
};

/** The design-token house-style domain: register it with `createStyleResolver({ domains })`. */
export const tokensStyleDomain: StyleDomain<TokenState> = {
	id: 'tokens',
	title: 'Design tokens',
	description: 'Rules for the token set itself: variables that must exist, a naming pattern, required modes and colour pairs that must reach a contrast ratio.',
	profileSchema: {
		type: 'object',
		properties: {
			required: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Variable names that must exist, e.g. "brand/primary".' },
			namePattern: { type: 'string', minLength: 1, description: 'Regular expression every variable name must match, e.g. "^[a-z0-9-]+(/[a-z0-9-]+)*$".' },
			modes: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Mode names every collection must have, e.g. ["Light", "Dark"].' },
			contrastPairs: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						fg: { type: 'string', minLength: 1, description: 'Foreground variable name or id.' },
						bg: { type: 'string', minLength: 1, description: 'Background variable name or id.' },
						ratio: { type: 'number', minimum: 1, maximum: 21, description: 'Smallest contrast ratio (default 4.5, WCAG AA for text).' }
					},
					required: ['fg', 'bg'],
					additionalProperties: false
				},
				description: 'Colour pairs checked in every mode.'
			}
		},
		additionalProperties: false
	},
	checks: [requiredVariables, namePattern, requiredModes, contrastPairs]
};

export interface TokensStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `tokens-style`. */
	id?: string;
	/** Tool-name prefix; defaults to `tokens`. */
	namespace?: string;
}

/** `check_tokens_style`: runs the design-token house-style checks against a token store. */
export function createTokensStyleToolProvider(store: TokenStore, styles: StyleResolver, options: TokensStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'tokens')) throw new Error('The style resolver has no "tokens" domain; add tokensStyleDomain to its domains.');
	const check: AgentTool = {
		name: 'check_tokens_style',
		title: 'Check token house style',
		description:
			'Checks the design-token set against the house style (see get_style with domain "tokens"): runs the checks its profile turns on (required-variables, name-pattern, required-modes, contrast-pairs). Returns findings with a severity, a sentence saying how to fix it, a target (variable id or name, mode id, collection id) and the layer that asked for it; plus the checks that ran and the ones skipped with the reason. Fix findings with get_tokens_document / load_tokens_document, then check again.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check token house style', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const { style, ...report } = await styles.check('tokens', store.getState());
			return {
				...report,
				ok: report.findings.length === 0,
				...(style.skills.length ? {} : { note: 'No house style applies to design tokens.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};
	return {
		id: options.id ?? 'tokens-style',
		namespace: options.namespace ?? 'tokens',
		title: 'Token house style',
		description: 'Check the design-token set against the house style.',
		skill: 'pixerate-tokens',
		tools: [check]
	};
}
