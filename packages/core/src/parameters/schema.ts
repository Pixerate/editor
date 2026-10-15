import type {
	ChoiceParameterField,
	NumberParameterField,
	ParameterChoiceOption,
	ParameterCondition,
	ParameterConditionTest,
	ParameterError,
	ParameterField,
	ParameterGroup,
	ParameterSchema,
	ParameterSchemaItem,
	ParameterValue,
	ParameterValues,
	VectorParameterField
} from './types.js';
import type { JsonSchema } from '../tools/schema.js';

// ---------------------------------------------------------------------------
// Labels and colours
// ---------------------------------------------------------------------------

/** `flowSpeed`, `flow_speed` or `uFlowSpeed` → "Flow speed". */
export function humanizeParameterId(id: string): string {
	const words = id
		.replace(/^u(?=[A-Z])/, '')
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.trim()
		.toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The label shown for a field or group. */
export function parameterLabel(item: { id: string; label?: string }): string {
	return item.label ?? humanizeParameterId(item.id);
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Normalises a hex colour to lower-case `#rrggbb`, or `#rrggbbaa` when `alpha` is true
 * (opaque colours get `ff`). Accepts 3, 4, 6 and 8 digits with or without `#`; returns
 * `null` for anything else. Without `alpha`, a colour's alpha is dropped.
 */
export function normalizeHexColor(input: string, alpha = false): string | null {
	const m = HEX.exec(input.trim());
	if (!m) return null;
	let digits = m[1].toLowerCase();
	if (digits.length <= 4) digits = [...digits].map((c) => c + c).join('');
	const rgb = digits.slice(0, 6);
	const a = digits.length === 8 ? digits.slice(6) : 'ff';
	return alpha ? `#${rgb}${a}` : `#${rgb}`;
}

/** `#77c16a` → `[0.467, 0.757, 0.416]` (0–1 components; four with `alpha`). `null` if not a colour. */
export function hexToRgba01(hex: string, alpha = false): number[] | null {
	const n = normalizeHexColor(hex, true);
	if (!n) return null;
	const parts = [1, 3, 5, 7].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
	return alpha ? parts : parts.slice(0, 3);
}

/** `[0.467, 0.757, 0.416]` → `#77c16a`; a fourth component becomes alpha when `alpha` is true. Clamped to 0–1. */
export function rgba01ToHex(components: readonly number[], alpha = false): string {
	const byte = (c: number) =>
		Math.round(Math.min(1, Math.max(0, Number.isFinite(c) ? c : 0)) * 255)
			.toString(16)
			.padStart(2, '0');
	const rgb = [0, 1, 2].map((i) => byte(components[i] ?? 0)).join('');
	return alpha ? `#${rgb}${byte(components[3] ?? 1)}` : `#${rgb}`;
}

// ---------------------------------------------------------------------------
// Walking a schema
// ---------------------------------------------------------------------------

export const isParameterGroup = (item: ParameterSchemaItem): item is ParameterGroup => item.type === 'group';

/** Every field in schema order, groups flattened. */
export function getParameterFields(schema: ParameterSchema | readonly ParameterSchemaItem[]): ParameterField[] {
	const out: ParameterField[] = [];
	const walk = (items: readonly ParameterSchemaItem[]) => {
		for (const item of items) {
			if (isParameterGroup(item)) walk(item.fields);
			else out.push(item);
		}
	};
	walk(Array.isArray(schema) ? schema : (schema as ParameterSchema).fields);
	return out;
}

/** Every group in schema order (nested groups after their parent). */
export function getParameterGroups(schema: ParameterSchema): ParameterGroup[] {
	const out: ParameterGroup[] = [];
	const walk = (items: readonly ParameterSchemaItem[]) => {
		for (const item of items) {
			if (isParameterGroup(item)) {
				out.push(item);
				walk(item.fields);
			}
		}
	};
	walk(schema.fields);
	return out;
}

export class ParameterSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ParameterSchemaError';
	}
}

const FIELD_TYPES = new Set(['number', 'int', 'boolean', 'choice', 'color', 'vector', 'image', 'text']);

/**
 * Checks a schema's structure: unique ids, known types, choice options, vector sizes and
 * defaults that pass validation. Returns sentences; an empty array means the schema is fine.
 */
export function checkParameterSchema(schema: ParameterSchema): string[] {
	const problems: string[] = [];
	const ids = new Set<string>();
	const visit = (items: readonly ParameterSchemaItem[]) => {
		for (const item of items) {
			if (!item || typeof item.id !== 'string' || item.id === '') {
				problems.push('Every field and group needs an id.');
				continue;
			}
			if (ids.has(item.id)) problems.push(`The id "${item.id}" is used twice.`);
			ids.add(item.id);
			if (isParameterGroup(item)) {
				visit(item.fields ?? []);
				continue;
			}
			if (!FIELD_TYPES.has((item as ParameterField).type)) {
				problems.push(`Field "${item.id}" has an unknown type "${(item as { type: string }).type}".`);
				continue;
			}
			if (item.type === 'choice' && (!item.options || item.options.length === 0)) {
				problems.push(`Field "${item.id}" needs at least one option.`);
				continue;
			}
			if (item.type === 'vector') {
				const size = vectorSize(item);
				if (size < 2 || size > 4) {
					problems.push(`Field "${item.id}" must have 2 to 4 components.`);
					continue;
				}
			}
			const error = validateParameterValue(item, item.default);
			if (error) problems.push(`Field "${item.id}" has an invalid default: ${error.message}`);
		}
	};
	visit(schema.fields ?? []);
	const presetNames = new Set<string>();
	for (const preset of schema.presets ?? []) {
		if (presetNames.has(preset.name)) problems.push(`The preset name "${preset.name}" is used twice.`);
		presetNames.add(preset.name);
	}
	return problems;
}

/** The defaults of every field (colours normalised to lower-case hex, `int`s rounded). */
export function getParameterDefaults(schema: ParameterSchema): ParameterValues {
	const values: ParameterValues = {};
	for (const field of getParameterFields(schema)) {
		const result = coerceParameterValue(field, field.default);
		values[field.id] = result.ok ? result.value : cloneValue(field.default);
	}
	return values;
}

export const cloneValue = <T extends ParameterValue>(value: T): T => (Array.isArray(value) ? ([...value] as T) : value);

/** Value equality (vectors compare component-wise). */
export function parameterValuesEqual(a: ParameterValue | undefined, b: ParameterValue | undefined): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
	return false;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

const truthy = (v: ParameterValue | undefined) =>
	Array.isArray(v) ? v.some((c) => c !== 0) : v !== undefined && v !== false && v !== 0 && v !== '';

function testCondition(value: ParameterValue | undefined, test: ParameterConditionTest): boolean {
	if (Array.isArray(test)) return test.some((option) => parameterValuesEqual(value, option));
	if (typeof test !== 'object' || test === null) return parameterValuesEqual(value, test as ParameterValue);
	const t = test as Exclude<ParameterConditionTest, string | number | boolean | readonly unknown[]>;
	if (t.eq !== undefined && !parameterValuesEqual(value, t.eq)) return false;
	if (t.ne !== undefined && parameterValuesEqual(value, t.ne)) return false;
	if (t.in && !t.in.some((option) => parameterValuesEqual(value, option))) return false;
	if (t.notIn && t.notIn.some((option) => parameterValuesEqual(value, option))) return false;
	if (t.truthy !== undefined && truthy(value) !== t.truthy) return false;
	const n = typeof value === 'number' ? value : NaN;
	if (t.gt !== undefined && !(n > t.gt)) return false;
	if (t.gte !== undefined && !(n >= t.gte)) return false;
	if (t.lt !== undefined && !(n < t.lt)) return false;
	if (t.lte !== undefined && !(n <= t.lte)) return false;
	return true;
}

/** Whether a `showIf` condition holds for `values` (no condition: `true`). */
export function evaluateParameterCondition(condition: ParameterCondition | undefined, values: Readonly<ParameterValues>): boolean {
	if (!condition) return true;
	if (typeof condition === 'function') {
		try {
			return condition(values) !== false;
		} catch {
			return true;
		}
	}
	return Object.entries(condition).every(([id, test]) => testCondition(values[id], test));
}

/**
 * Field and group id → shown. An item is hidden when its own `showIf` fails or any
 * enclosing group is hidden.
 */
export function getParameterVisibility(schema: ParameterSchema, values: Readonly<ParameterValues>): Record<string, boolean> {
	const visible: Record<string, boolean> = {};
	const walk = (items: readonly ParameterSchemaItem[], parentVisible: boolean) => {
		for (const item of items) {
			const shown = parentVisible && evaluateParameterCondition(item.showIf, values);
			visible[item.id] = shown;
			if (isParameterGroup(item)) walk(item.fields, shown);
		}
	};
	walk(schema.fields, true);
	return visible;
}

// ---------------------------------------------------------------------------
// Field details
// ---------------------------------------------------------------------------

/** A choice field's options as objects. */
export function getChoiceOptions(field: ChoiceParameterField): ParameterChoiceOption[] {
	return field.options.map((o) => (typeof o === 'object' ? o : { value: o }));
}

/** An option's label (default: the value made readable). */
export const choiceOptionLabel = (option: ParameterChoiceOption): string =>
	option.label ?? (typeof option.value === 'string' ? humanizeParameterId(option.value) : String(option.value));

export function vectorSize(field: VectorParameterField): number {
	return field.size ?? (Array.isArray(field.default) ? field.default.length : 2);
}

const pick = (bound: number | readonly number[] | undefined, i: number) => (typeof bound === 'number' ? bound : bound?.[i]);

/** A vector component as a number field (its bounds, step, unit and label). */
export function vectorComponentField(field: VectorParameterField, index: number): NumberParameterField {
	const labels = field.labels ?? ['x', 'y', 'z', 'w'];
	return {
		id: `${field.id}.${index}`,
		type: 'number',
		label: labels[index] ?? String(index),
		default: field.default[index] ?? 0,
		min: pick(field.min, index),
		max: pick(field.max, index),
		step: field.step,
		unit: field.unit,
		decimals: field.decimals,
		control: 'input'
	};
}

/** The step a number field moves by: `step`, else 1 for `int`, else 1/100 of the range (0.01 without one). */
export function parameterStep(field: NumberParameterField): number {
	if (field.step !== undefined && field.step > 0) return field.type === 'int' ? Math.max(1, Math.round(field.step)) : field.step;
	if (field.type === 'int') return 1;
	if (field.min !== undefined && field.max !== undefined && field.max > field.min) return (field.max - field.min) / 100;
	return 0.01;
}

/** Decimal places to show: `decimals`, else enough for the step (at most 4). */
export function parameterDecimals(field: NumberParameterField): number {
	if (field.decimals !== undefined) return field.decimals;
	if (field.type === 'int') return 0;
	const step = parameterStep(field);
	for (let d = 0; d <= 4; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-9) return d;
	return 4;
}

/** Whether a number field renders a slider (`control`, else when it has both bounds). */
export const isSliderField = (field: NumberParameterField): boolean =>
	field.control ? field.control === 'slider' : field.min !== undefined && field.max !== undefined;

/** A number as shown for a field: fixed decimals, trailing zeros trimmed, plus the unit. */
export function formatParameterNumber(field: NumberParameterField, value: number): string {
	const fixed = (Number.isFinite(value) ? value : 0).toFixed(parameterDecimals(field));
	const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
	return `${trimmed === '-0' ? '0' : trimmed}${field.unit ?? ''}`;
}

/** Clamps into the field's bounds, rounds `int`s and snaps float noise (for UI inputs). */
export function clampParameterNumber(field: NumberParameterField, value: number): number {
	let v = Number.isFinite(value) ? value : field.default;
	if (field.min !== undefined) v = Math.max(field.min, v);
	if (field.max !== undefined) v = Math.min(field.max, v);
	if (field.type === 'int') return Math.round(v);
	return Math.round(v * 1e6) / 1e6;
}

/**
 * Parses what someone typed into a number box ("2.5", "2.5x", "-1e2") and clamps it into
 * the field's bounds. Returns `null` when it is not a number.
 */
export function parseParameterNumberInput(field: NumberParameterField, text: string): number | null {
	let t = text.trim();
	if (field.unit && t.endsWith(field.unit)) t = t.slice(0, -field.unit.length).trim();
	if (t === '') return null;
	const n = Number(t.replace(',', '.'));
	return Number.isFinite(n) ? clampParameterNumber(field, n) : null;
}

/** A value as short display text (numbers formatted, vectors comma-separated, booleans On/Off). */
export function formatParameterValue(field: ParameterField, value: ParameterValue | undefined): string {
	if (value === undefined) return '';
	switch (field.type) {
		case 'number':
		case 'int':
			return formatParameterNumber(field, value as number);
		case 'boolean':
			return value ? 'On' : 'Off';
		case 'choice': {
			const option = getChoiceOptions(field).find((o) => o.value === value);
			return option ? choiceOptionLabel(option) : String(value);
		}
		case 'vector':
			return (value as number[]).map((v, i) => formatParameterNumber(vectorComponentField(field, i), v)).join(', ');
		default:
			return String(value);
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const describe = (v: unknown) =>
	v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'string' ? `"${v.length > 40 ? `${v.slice(0, 40)}…` : v}"` : String(v);

function err(field: ParameterField, message: string, index?: number): ParameterError {
	return { id: field.id, path: index === undefined ? `/${field.id}` : `/${field.id}/${index}`, message };
}

function numberError(field: ParameterField, name: string, v: unknown, opts: { int: boolean; min?: number; max?: number }, index?: number): ParameterError | null {
	if (typeof v !== 'number' || !Number.isFinite(v)) return err(field, `${name} must be a number, not ${describe(v)}.`, index);
	if (opts.int && !Number.isInteger(v)) return err(field, `${name} must be a whole number.`, index);
	if (opts.min !== undefined && v < opts.min) return err(field, `${name} must be at least ${opts.min}.`, index);
	if (opts.max !== undefined && v > opts.max) return err(field, `${name} must be at most ${opts.max}.`, index);
	return null;
}

/**
 * Checks a value against a field. Returns `null` when it is valid, else one error whose
 * message is a sentence naming the field ("Speed must be at most 4.").
 */
export function validateParameterValue(field: ParameterField, value: unknown): ParameterError | null {
	const name = parameterLabel(field);
	switch (field.type) {
		case 'number':
		case 'int':
			return numberError(field, name, value, { int: field.type === 'int', min: field.min, max: field.max });
		case 'boolean':
			return typeof value === 'boolean' ? null : err(field, `${name} must be true or false.`);
		case 'choice': {
			const options = getChoiceOptions(field);
			if (options.some((o) => o.value === value)) return null;
			return err(field, `${name} must be one of ${options.map((o) => JSON.stringify(o.value)).join(', ')}, not ${describe(value)}.`);
		}
		case 'color': {
			const example = field.alpha ? '"#77c16aff"' : '"#77c16a"';
			if (typeof value !== 'string' || normalizeHexColor(value, !!field.alpha) === null) {
				return err(field, `${name} must be a hex colour like ${example}.`);
			}
			return null;
		}
		case 'vector': {
			const size = vectorSize(field);
			if (!Array.isArray(value) || value.length !== size) return err(field, `${name} must be a list of ${size} numbers.`);
			for (let i = 0; i < size; i++) {
				const component = `${name} ${(field.labels ?? ['x', 'y', 'z', 'w'])[i] ?? i}`;
				const e = numberError(field, component, value[i], { int: false, min: pick(field.min, i), max: pick(field.max, i) }, i);
				if (e) return e;
			}
			return null;
		}
		case 'image':
			return typeof value === 'string' ? null : err(field, `${name} must be an image URL (or "" for none).`);
		case 'text': {
			if (typeof value !== 'string') return err(field, `${name} must be text.`);
			if (field.minLength !== undefined && value.length < field.minLength) {
				return err(field, `${name} must be at least ${field.minLength} characters.`);
			}
			if (field.maxLength !== undefined && value.length > field.maxLength) {
				return err(field, `${name} must be at most ${field.maxLength} characters.`);
			}
			if (field.pattern !== undefined) {
				let regex: RegExp | null = null;
				try {
					regex = new RegExp(`^(?:${field.pattern})$`, 'u');
				} catch {
					// An invalid pattern in the schema is not the caller's fault.
				}
				if (regex && !regex.test(value)) return err(field, `${name} must match the pattern ${field.pattern}.`);
			}
			return null;
		}
		default:
			return err(field as ParameterField, `${name} has an unknown type.`);
	}
}

export type ParameterCoercion = { ok: true; value: ParameterValue } | { ok: false; error: ParameterError };

/**
 * Checks a value from outside (an agent's tool call, a URL, a form) and returns the value to
 * store. Coercion is narrow: `int`s are rounded, colours normalised to lower-case hex.
 */
export function coerceParameterValue(field: ParameterField, raw: unknown): ParameterCoercion {
	let value = raw;
	if (field.type === 'int' && typeof raw === 'number' && Number.isFinite(raw)) value = Math.round(raw);
	if (field.type === 'color' && typeof raw === 'string') value = normalizeHexColor(raw, !!field.alpha) ?? raw;
	if (field.type === 'vector' && Array.isArray(raw)) value = [...raw];
	const error = validateParameterValue(field, value);
	return error ? { ok: false, error } : { ok: true, value: value as ParameterValue };
}

/** Every error for `values` (missing values are reported too). */
export function validateParameterValues(schema: ParameterSchema, values: Readonly<Partial<ParameterValues>>): ParameterError[] {
	const errors: ParameterError[] = [];
	for (const field of getParameterFields(schema)) {
		const value = values[field.id];
		if (value === undefined) {
			errors.push(err(field, `${parameterLabel(field)} is missing.`));
			continue;
		}
		const error = validateParameterValue(field, value);
		if (error) errors.push(error);
	}
	return errors;
}

// ---------------------------------------------------------------------------
// JSON Schema (for agents)
// ---------------------------------------------------------------------------

/** One field as JSON Schema (for agent tool parameters). */
export function parameterFieldToJsonSchema(field: ParameterField): JsonSchema {
	const description = [parameterLabel(field), field.description].filter(Boolean).join(': ');
	const base: JsonSchema = { title: parameterLabel(field), description, default: field.default };
	switch (field.type) {
		case 'number':
		case 'int': {
			const unit = field.unit ? ` (${field.unit})` : '';
			return {
				...base,
				description: description + unit,
				type: field.type === 'int' ? 'integer' : 'number',
				...(field.min !== undefined ? { minimum: field.min } : {}),
				...(field.max !== undefined ? { maximum: field.max } : {})
			};
		}
		case 'boolean':
			return { ...base, type: 'boolean' };
		case 'choice': {
			const options = getChoiceOptions(field);
			return { ...base, enum: options.map((o) => o.value) };
		}
		case 'color':
			return {
				...base,
				type: 'string',
				description: `${description} (hex colour${field.alpha ? ' with alpha, #rrggbbaa' : ', #rrggbb'})`,
				pattern: field.alpha ? '^#?([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$' : '^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'
			};
		case 'vector': {
			const size = vectorSize(field);
			const items: JsonSchema = { type: 'number' };
			if (typeof field.min === 'number') items.minimum = field.min;
			if (typeof field.max === 'number') items.maximum = field.max;
			return { ...base, type: 'array', items, minItems: size, maxItems: size };
		}
		case 'image':
			return { ...base, type: 'string', description: `${description} (image URL, "" for none)` };
		case 'text':
			return {
				...base,
				type: 'string',
				...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
				...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})
			};
	}
}

/** The schema's values as one object JSON Schema (every property optional). */
export function parameterSchemaToJsonSchema(schema: ParameterSchema): JsonSchema & { type: 'object' } {
	const properties: Record<string, JsonSchema> = {};
	for (const field of getParameterFields(schema)) properties[field.id] = parameterFieldToJsonSchema(field);
	return { type: 'object', properties, additionalProperties: false };
}
