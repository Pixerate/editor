/**
 * House style for effect parameters (#779): the `parameters.json` profile (values the house
 * fixes, ranges for numeric parameters, the presets allowed, and the colours colour parameters
 * may use), its checks, and `check_parameters_style` / `fix_parameters_style`.
 *
 * Findings target a parameter by id with the house value when the fix is certain
 * (`{ parameter, value }`), or the preset (`{ preset }`).
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleFinding, StyleResolver } from '../tools/style.js';
import type { StyleSurface, StyleSurfaceColor } from '../tools/style-surface.js';
import { brandPalette } from '../tools/brand.js';
import type { ParametersController, ParametersState } from './controller.js';
import type { ParameterValue } from './types.js';

type Finding = Omit<StyleFinding, 'check' | 'layer'>;

/** The `parameters.json` profile, after `$token` references are resolved. */
export interface ParametersStyleProfile {
	/** Values the house fixes, by parameter id (e.g. { "grain": 0.2 }). */
	values?: Record<string, ParameterValue>;
	/** Ranges for numeric parameters, by id. */
	ranges?: Record<string, { min?: number; max?: number }>;
	/** Presets allowed: when the values match a preset, it must be one of these. */
	presets?: string[];
	/** Colours colour parameters may use (for palette-only). Default: the brand's. */
	palette?: string[];
}

/** A finding's target. */
export type ParametersStyleTarget = { parameter: string; value?: ParameterValue } | { preset: string };

const profileOf = (p: Readonly<Record<string, unknown>>) => p as ParametersStyleProfile;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const houseValues: StyleCheck<ParametersState> = {
	id: 'house-values',
	description: 'Parameters the house fixes have the house value ("values", by parameter id). Parameters the effect does not have are ignored.',
	run(state, profile) {
		const values = profileOf(profile).values;
		if (!values || !Object.keys(values).length) throw new Error('the profile has no "values".');
		const out: Finding[] = [];
		for (const [id, want] of Object.entries(values)) {
			if (!(id in state.values) || same(state.values[id], want)) continue;
			const field = state.fields.find((f) => f.id === id);
			out.push({ severity: 'warning' as const, message: `${field?.label ?? id} is ${JSON.stringify(state.values[id])}; the house value is ${JSON.stringify(want)}.`, target: { parameter: id, value: want } satisfies ParametersStyleTarget });
		}
		return out;
	}
};

const ranges: StyleCheck<ParametersState> = {
	id: 'ranges',
	description: 'Numeric parameters stay within the house ranges ("ranges": { id: { min, max } }).',
	run(state, profile) {
		const r = profileOf(profile).ranges;
		if (!r || !Object.keys(r).length) throw new Error('the profile has no "ranges".');
		const out: Finding[] = [];
		for (const [id, { min, max }] of Object.entries(r)) {
			const v = state.values[id];
			if (typeof v !== 'number') continue;
			const want = min !== undefined && v < min ? min : max !== undefined && v > max ? max : undefined;
			if (want === undefined) continue;
			const field = state.fields.find((f) => f.id === id);
			out.push({ severity: 'warning' as const, message: `${field?.label ?? id} is ${v}; the house range is ${min ?? '…'} to ${max ?? '…'}. Use ${want}.`, target: { parameter: id, value: want } satisfies ParametersStyleTarget });
		}
		return out;
	}
};

const presets: StyleCheck<ParametersState> = {
	id: 'presets',
	description: 'When the values match a preset, it is a house preset ("presets").',
	run(state, profile) {
		const allowed = profileOf(profile).presets;
		if (!allowed?.length) throw new Error('the profile has no "presets".');
		if (!state.activePreset || allowed.includes(state.activePreset)) return [];
		return [{ severity: 'info' as const, message: `The values match the "${state.activePreset}" preset; the house presets are ${allowed.map((p) => `"${p}"`).join(', ')}.`, target: { preset: allowed[0] } satisfies ParametersStyleTarget }];
	}
};

/** The colours colour parameters hold, for the shared checks. */
export function parametersStyleSurface(state: ParametersState): StyleSurface {
	const colors: StyleSurfaceColor[] = [];
	for (const f of state.fields) {
		const v = state.values[f.id];
		if (f.type !== 'color' || typeof v !== 'string' || !state.visible[f.id]) continue;
		colors.push({ color: v, label: f.label ?? f.id, target: { parameter: f.id } satisfies ParametersStyleTarget, use: 'fill' });
	}
	return { colors };
}

/** The parameters house-style domain: register it with `createStyleResolver({ domains })`. */
export const parametersStyleDomain: StyleDomain<ParametersState> = {
	id: 'parameters',
	title: 'Parameters',
	description: 'House settings for effects: values the house fixes, ranges for numeric parameters, the presets allowed, and the colours colour parameters may use.',
	profileSchema: {
		type: 'object',
		properties: {
			values: { type: 'object', additionalProperties: { description: 'The house value: a number, boolean, string or number list.' }, description: 'Values the house fixes, by parameter id.' },
			ranges: {
				type: 'object',
				additionalProperties: {
					type: 'object',
					properties: { min: { type: 'number', description: 'Least value.' }, max: { type: 'number', description: 'Greatest value.' } },
					additionalProperties: false
				},
				description: 'Ranges for numeric parameters, by id.'
			},
			presets: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, description: 'Presets allowed.' },
			palette: { type: 'array', items: { type: 'string', minLength: 1, description: 'A CSS colour, or a { "$token": ... } reference.' }, description: 'Colours colour parameters may use (for palette-only). Default: the brand palette and roles.' }
		},
		additionalProperties: false
	},
	checks: [houseValues, ranges, presets],
	surface: parametersStyleSurface,
	themeFromBrand: (brand) => {
		const palette = brandPalette(brand);
		return palette.length ? { palette } : {};
	},
	example: {
		values: { grain: 0.2 },
		ranges: { intensity: { min: 0, max: 0.6 } },
		checks: ['house-values', 'ranges', 'palette-only']
	}
};

export interface ParametersStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `parameters-style`. */
	id?: string;
	/** Tool-name prefix; defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Where the tools work: skills scoped elsewhere do not apply. Set by the host. */
	scope?: string;
	/** The parameters cannot be changed: `fix_parameters_style` is hidden (a string is the reason). */
	readOnly?: boolean | string | (() => boolean | string);
}

/**
 * `check_parameters_style` and, while editable, `fix_parameters_style` (sets the house values
 * and clamps ranges as one undo step).
 */
export function createParametersStyleToolProvider(controller: ParametersController, styles: StyleResolver, options: ParametersStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'parameters')) throw new Error('The style resolver has no "parameters" domain; add parametersStyleDomain to its domains.');
	const scope = options.scope !== undefined ? { scope: options.scope } : {};
	const readOnlyReason = (): string | null => {
		const r = typeof options.readOnly === 'function' ? options.readOnly() : options.readOnly;
		if (!r) return null;
		return typeof r === 'string' ? r : 'These parameters are read-only.';
	};
	const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
	const run = () => styles.check('parameters', controller.getState(), scope);

	const check: AgentTool = {
		name: 'check_parameters_style',
		title: 'Check parameters house style',
		description:
			'Checks the effect parameters against the house style (see get_style with domain "parameters"): house-values, ranges, presets, and the brand\'s palette-only on colour parameters. Returns findings with a severity, a sentence saying how to fix it, a target ({ parameter, value? } with the house value when certain, or { preset }) and the layer that asked; the checks that ran and those skipped. fix_parameters_style applies the certain fixes at once.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check parameters house style', ...READ },
		handler: async () => {
			const { style, ...report } = await run();
			return {
				...report,
				ok: report.findings.length === 0,
				...(style.skills.length ? {} : { note: 'No house style applies to parameters.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};

	const fix: AgentTool = {
		name: 'fix_parameters_style',
		title: 'Fix parameters house style',
		description:
			'Sets every parameter with a certain house value (house values, ranges clamped) as one undo step; read-only parameters are left. Returns the values it set, the rejected ones with their error, and the findings left (presets and colours). Run check_parameters_style after.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Fix parameters house style', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const reason = readOnlyReason();
			if (reason) throw new Error(reason);
			const { findings } = await run();
			const patch: Record<string, ParameterValue> = {};
			const left: StyleFinding[] = [];
			for (const f of findings) {
				const t = f.target as ParametersStyleTarget | undefined;
				const field = t && 'parameter' in t ? controller.getField(t.parameter) : undefined;
				if (t && 'parameter' in t && t.value !== undefined && field && !field.readOnly) patch[t.parameter] = t.value;
				else left.push(f);
			}
			const result = Object.keys(patch).length ? controller.setValues(patch) : undefined;
			return { set: patch, ...(result && !result.ok ? { rejected: result } : {}), left };
		}
	};

	return {
		id: options.id ?? 'parameters-style',
		namespace: options.namespace,
		title: 'Parameters house style',
		description: 'Check effect parameters against the house style and set the house values.',
		skill: 'pixerate-parameters',
		tools: () => (readOnlyReason() ? [check] : [check, fix])
	};
}
