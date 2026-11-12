/**
 * House style for media generation (#779): the `generation.json` profile (the models allowed,
 * aspect ratios, qualities, a count and duration limit, a house look appended to every prompt,
 * negative terms every request carries, and terms prompts must not use), its checks, and
 * `check_generation_style` / `apply_generation_style`.
 *
 * The domain checks a request before anything is spent (the arguments `plan_generation` and
 * `generate` take). `apply_generation_style` returns the request in the house style, without
 * generating; pass it on to `estimate_generation` and `generate`.
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { GenerationRequest } from './capabilities.js';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;

/** The `generation.json` profile, after `$token` references are resolved. */
export interface GenerationStyleProfile {
	/** Model ids allowed (the first is the house default). */
	models?: string[];
	/** Aspect ratios allowed, e.g. ["1:1", "16:9"] (the first is the house default). */
	aspectRatios?: string[];
	/** Quality tiers allowed (the first is the house default). */
	qualities?: string[];
	/** Most outputs per request. */
	maxCount?: number;
	/** Longest video or audio, in seconds. */
	maxDuration?: number;
	/** The house look, appended to every prompt (e.g. "flat vector illustration, soft light"). */
	promptSuffix?: string;
	/** Terms every negative prompt carries (e.g. "text, watermark"). */
	negativeTerms?: string[];
	/** Terms a prompt must not use (brands, people, styles the house avoids). */
	bannedTerms?: string[];
}

/** A finding's target: the request field and, when the fix is certain, its house value. */
export interface GenerationStyleTarget {
	field: keyof GenerationRequest;
	value?: unknown;
}

const profileOf = (p: Readonly<Record<string, unknown>>) => p as GenerationStyleProfile;
const has = (text: string | undefined, term: string) => new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(text ?? '');

/** A check that a request field takes one of the profile's values (the first is the default). */
function oneOf(id: string, field: 'model' | 'aspectRatio' | 'quality', key: 'models' | 'aspectRatios' | 'qualities', what: string): StyleCheck<GenerationRequest> {
	return {
		id,
		description: `The request uses a house ${what} ("${key}"; the first is the house default, used when the request names none).`,
		run(request, profile) {
			const allowed = profileOf(profile)[key];
			if (!allowed?.length) throw new Error(`the profile has no "${key}".`);
			const have = request[field];
			if (typeof have === 'string' && allowed.includes(have)) return [];
			return [{ severity: have === undefined ? ('info' as const) : ('warning' as const), message: `${have === undefined ? `The request names no ${what}` : `The ${what} "${have}" is not a house ${what}`}; the house ${key} are ${allowed.join(', ')}. Use "${allowed[0]}".`, target: { field, value: allowed[0] } satisfies GenerationStyleTarget }];
		}
	};
}

const limits: StyleCheck<GenerationRequest> = {
	id: 'limits',
	description: 'The request stays within the house limits: at most "maxCount" outputs and "maxDuration" seconds.',
	run(request, profile) {
		const { maxCount, maxDuration } = profileOf(profile);
		if (maxCount === undefined && maxDuration === undefined) throw new Error('the profile has no "maxCount" or "maxDuration".');
		const out: Finding[] = [];
		if (maxCount !== undefined && (request.count ?? 1) > maxCount) out.push({ severity: 'warning' as const, message: `The request asks for ${request.count} outputs; the house limit is ${maxCount}.`, target: { field: 'count', value: maxCount } satisfies GenerationStyleTarget });
		if (maxDuration !== undefined && request.duration !== undefined && request.duration > maxDuration) out.push({ severity: 'warning' as const, message: `The request asks for ${request.duration} s; the house limit is ${maxDuration} s.`, target: { field: 'duration', value: maxDuration } satisfies GenerationStyleTarget });
		return out;
	}
};

const promptSuffix: StyleCheck<GenerationRequest> = {
	id: 'prompt-suffix',
	description: 'The prompt ends with the house look ("promptSuffix"), so every output shares it.',
	run(request, profile) {
		const suffix = profileOf(profile).promptSuffix?.trim();
		if (!suffix) throw new Error('the profile has no "promptSuffix".');
		const prompt = request.prompt?.trim() ?? '';
		if (prompt.toLowerCase().includes(suffix.toLowerCase())) return [];
		const value = prompt ? `${prompt.replace(/[.,;\s]+$/, '')}, ${suffix}` : suffix;
		return [{ severity: 'info' as const, message: `The prompt does not carry the house look "${suffix}"; append it.`, target: { field: 'prompt', value } satisfies GenerationStyleTarget }];
	}
};

const negativeTerms: StyleCheck<GenerationRequest> = {
	id: 'negative-terms',
	description: 'The negative prompt carries every house negative term ("negativeTerms").',
	run(request, profile) {
		const terms = profileOf(profile).negativeTerms;
		if (!terms?.length) throw new Error('the profile has no "negativeTerms".');
		const missing = terms.filter((t) => !has(request.negativePrompt, t));
		if (!missing.length) return [];
		const value = [request.negativePrompt?.trim().replace(/[.,;\s]+$/, ''), ...missing].filter(Boolean).join(', ');
		return [{ severity: 'info' as const, message: `The negative prompt is missing ${missing.map((t) => `"${t}"`).join(', ')}.`, target: { field: 'negativePrompt', value } satisfies GenerationStyleTarget }];
	}
};

const bannedTerms: StyleCheck<GenerationRequest> = {
	id: 'banned-terms',
	description: 'The prompt uses none of the terms the house avoids ("bannedTerms"). Rewording is left to you.',
	run(request, profile) {
		const terms = profileOf(profile).bannedTerms;
		if (!terms?.length) throw new Error('the profile has no "bannedTerms".');
		return terms
			.filter((t) => has(request.prompt, t))
			.map((t) => ({ severity: 'error' as const, message: `The prompt uses "${t}", which the house style avoids. Reword it before generating.`, target: { field: 'prompt' } satisfies GenerationStyleTarget }));
	}
};

/** The generation house-style domain: register it with `createStyleResolver({ domains })`. */
export const generationStyleDomain: StyleDomain<GenerationRequest> = {
	id: 'generation',
	title: 'Generation',
	description: 'What generated media may cost and look like: the models, aspect ratios and qualities allowed, count and duration limits, the house look appended to prompts, negative terms and banned terms.',
	profileSchema: {
		type: 'object',
		properties: {
			models: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Model ids allowed; the first is the house default.' },
			aspectRatios: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Aspect ratios allowed, e.g. ["1:1", "16:9"]; the first is the house default.' },
			qualities: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Quality tiers allowed; the first is the house default.' },
			maxCount: { type: 'integer', minimum: 1, description: 'Most outputs per request.' },
			maxDuration: { type: 'number', exclusiveMinimum: 0, description: 'Longest video or audio, seconds.' },
			promptSuffix: { type: 'string', minLength: 1, description: 'The house look, appended to every prompt.' },
			negativeTerms: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Terms every negative prompt carries.' },
			bannedTerms: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'Terms a prompt must not use.' }
		},
		additionalProperties: false
	},
	checks: [oneOf('models', 'model', 'models', 'model'), oneOf('aspect-ratios', 'aspectRatio', 'aspectRatios', 'aspect ratio'), oneOf('qualities', 'quality', 'qualities', 'quality'), limits, promptSuffix, negativeTerms, bannedTerms],
	// A request draws nothing itself: the brand's checks run on what it produces, in its editor.
	surface: () => ({}),
	example: {
		models: ['image-standard'],
		aspectRatios: ['1:1', '16:9'],
		maxCount: 4,
		promptSuffix: 'flat vector illustration, soft daylight, brand colours',
		negativeTerms: ['text', 'watermark'],
		bannedTerms: ['photorealistic'],
		checks: ['models', 'aspect-ratios', 'limits', 'prompt-suffix', 'negative-terms', 'banned-terms']
	}
};

export interface GenerationStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `generation-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work: skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
}

const REQUEST_SCHEMA = {
	type: 'object',
	description: 'The generation request, as plan_generation and generate take it (model, prompt, negativePrompt, aspectRatio, quality, count, duration, ...).',
	additionalProperties: true
} as const;

/**
 * `check_generation_style` and `apply_generation_style`: both read-only, so they work whatever
 * the host's budget; neither generates anything.
 */
export function createGenerationStyleToolProvider(styles: StyleResolver, options: GenerationStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'generation')) throw new Error('The style resolver has no "generation" domain; add generationStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
	const run = (request: GenerationRequest) => styles.check('generation', request, scope);

	const check: AgentTool = {
		name: 'check_generation_style',
		title: 'Check a generation request against the house style',
		description:
			'Checks a generation request before anything is spent (see get_style with domain "generation"): models, aspect-ratios, qualities, limits (count, duration), prompt-suffix (the house look), negative-terms and banned-terms. Returns findings with a severity, a sentence saying how to fix it and a target { field, value? } (the house value when certain); the checks that ran and those skipped. Generates nothing.',
		inputSchema: { type: 'object', properties: { request: REQUEST_SCHEMA }, required: ['request'], additionalProperties: false },
		annotations: { title: 'Check a generation request against the house style', ...READ },
		handler: async ({ request }) => {
			const { style, ...report } = await run(request as GenerationRequest);
			return {
				...report,
				ok: report.findings.length === 0,
				...(style.skills.length ? {} : { note: 'No house style applies to generation.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const apply: AgentTool = {
		name: 'apply_generation_style',
		title: 'Put a generation request in the house style',
		description:
			'Returns the request with every certain house-style fix applied: the house model, aspect ratio and quality where it named another or none, count and duration within the limits, the house look appended to the prompt, and the house negative terms. Generates nothing; pass the returned request to estimate_generation and generate. Returns { request, changed: field names, left: findings to fix yourself, such as banned terms }.',
		inputSchema: { type: 'object', properties: { request: REQUEST_SCHEMA }, required: ['request'], additionalProperties: false },
		annotations: { title: 'Put a generation request in the house style', ...READ },
		handler: async ({ request }) => {
			const next: Record<string, unknown> = { ...(request as GenerationRequest) };
			const { findings } = await run(request as GenerationRequest);
			const changed: string[] = [];
			const left: StyleFinding[] = [];
			for (const f of findings) {
				const t = f.target as GenerationStyleTarget | undefined;
				if (t?.value !== undefined) {
					next[t.field] = t.value;
					if (!changed.includes(t.field)) changed.push(t.field);
				} else left.push(f);
			}
			return { request: next, changed, left };
		}
	};

	return {
		id: options.id ?? 'generation-style',
		namespace: options.namespace,
		title: 'Generation house style',
		description: 'Check a generation request against the house style and put it in the house style before spending.',
		skill: 'pixerate-generation',
		tools: [check, apply]
	};
}
