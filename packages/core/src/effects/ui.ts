/**
 * Framework-free helpers for effects UIs (the React and Svelte effects browser and parameter
 * panel): control schemas as parameter fields, preview thumbnails from a provider's renderer,
 * and labels.
 */

import type { JsonSchema } from '../tools/schema.js';
import type { ParameterField, ParameterValue } from '../parameters/types.js';
import { createEffectPixels } from './helpers.js';
import { SYSTEM_FONT_CATALOG } from '../typography/catalog.js';
import type { FontSummary } from '../typography/registry.js';
import type { EffectDescription, EffectPixels, EffectProvider, EffectSummary, EffectUse, EffectValue } from './types.js';

/** Names for the uses, for filters and badges. */
export const EFFECT_USE_LABELS: Readonly<Record<EffectUse, string>> = {
	filter: 'Filter',
	transition: 'Transition',
	generator: 'Generator',
	overlay: 'Overlay',
	title: 'Title',
	motion: 'Motion',
	interactive: 'Interactive',
	camera: 'Camera'
};

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;
const typeOf = (s: JsonSchema) => (Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type);

/** A colour as `#rrggbb` (or `#rrggbbaa`): hex strings as they are, `[r, g, b(, a)]` channels from 0 to 1 converted. */
function hexColour(value: unknown): string | undefined {
	if (typeof value === 'string') return HEX.test(value) ? value : undefined;
	if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4) || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
	return `#${value.map((n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Options for turning effect controls into fields. */
export interface EffectFieldOptions {
	/** Families offered by font controls (default: the system font catalog). */
	fonts?: readonly FontSummary[];
}

/**
 * Whether a control picks a font family: a string schema with `format: "font"` or
 * `"x-pixerate-control": "font"`.
 */
export function isEffectFontControl(schema: JsonSchema): boolean {
	return typeOf(schema) === 'string' && (schema.format === 'font' || schema['x-pixerate-control'] === 'font');
}

/**
 * One control as a parameter field: numbers and integers (sliders when bounded), switches,
 * choices (`enum`), font families (`format: "font"`, a choice of `options.fonts`), colours
 * (strings whose default is `#rrggbb`), vectors (2–4 numbers) and text.
 * `null` for a control no field can edit (objects, long lists).
 */
/** The JSON Schema type a value has (`undefined` for none). */
function jsonTypeOf(value: unknown): string | undefined {
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'string' || typeof value === 'boolean') return typeof value;
	if (typeof value === 'number') return 'number';
	return undefined;
}

export function effectControlField(name: string, schema: JsonSchema, fallback: EffectValue | undefined, options: EffectFieldOptions = {}): ParameterField | null {
	const base = { id: name, ...(schema.title ? { label: schema.title } : {}), ...(schema.description ? { description: schema.description } : {}) };
	const def = (schema.default ?? fallback) as EffectValue | undefined;
	// A control that takes several shapes (`anyOf`: a colour as channels or a CSS string) is edited
	// as the shape its default has.
	const type = typeOf(schema) ?? typeOf(schema.anyOf?.find((s) => typeOf(s) === jsonTypeOf(def)) ?? {});
	if (Array.isArray(schema.enum) && schema.enum.length) {
		const options = schema.enum.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
		return { ...base, type: 'choice', options, default: (typeof def === 'string' || typeof def === 'number' ? def : options[0]) as string | number, control: options.length <= 4 ? 'segmented' : 'select' };
	}
	if (type === 'number' || type === 'integer') {
		const min = schema.minimum ?? schema.exclusiveMinimum;
		const max = schema.maximum ?? schema.exclusiveMaximum;
		return { ...base, type: type === 'integer' ? 'int' : 'number', default: typeof def === 'number' ? def : (min ?? 0), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(schema.multipleOf ? { step: schema.multipleOf } : {}) };
	}
	if (type === 'boolean') return { ...base, type: 'boolean', default: def === true };
	if (isEffectFontControl(schema)) {
		const fonts = options.fonts ?? SYSTEM_FONT_CATALOG;
		const opts: Array<{ value: string; label: string; description: string }> = fonts.map((f) => ({ value: f.family, label: f.family, description: f.category }));
		const current = typeof def === 'string' && def ? def : (opts[0]?.value ?? 'sans-serif');
		if (!opts.some((o) => o.value.toLowerCase() === current.toLowerCase())) opts.unshift({ value: current, label: current, description: 'current' });
		return { ...base, type: 'choice', options: opts, default: opts.find((o) => o.value.toLowerCase() === current.toLowerCase())!.value, control: 'select' };
	}
	if (type === 'string') {
		if (typeof def === 'string' && HEX.test(def)) return { ...base, type: 'color', alpha: def.length === 9, default: def };
		return { ...base, type: 'text', default: typeof def === 'string' ? def : '', ...(schema.maxLength ? { maxLength: schema.maxLength } : {}) };
	}
	if (type === 'array' && Array.isArray(def) && def.length >= 2 && def.length <= 4 && def.every((n) => typeof n === 'number')) {
		const items = (schema.items ?? schema.anyOf?.find((s) => typeOf(s) === 'array')?.items ?? {}) as JsonSchema;
		return { ...base, type: 'vector', size: def.length as 2 | 3 | 4, default: [...def], ...(items.minimum !== undefined ? { min: items.minimum } : {}), ...(items.maximum !== undefined ? { max: items.maximum } : {}) };
	}
	return null;
}

/** An effect's controls as parameter fields, in schema order (controls no field can edit are left out). */
export function effectParameterFields(description: Pick<EffectDescription, 'controls' | 'defaults'>, options: EffectFieldOptions = {}): ParameterField[] {
	return Object.entries(description.controls.properties)
		.map(([name, schema]) => effectControlField(name, schema, description.defaults[name], options))
		.filter((f): f is ParameterField => !!f);
}

/**
 * The font families an effect's font controls use with these values (falling back to defaults),
 * to load with `ensureFontsLoaded` before rendering a title preview.
 */
export function effectFontFamilies(description: Pick<EffectDescription, 'controls' | 'defaults'>, values: Readonly<Record<string, unknown>> = {}): string[] {
	const out: string[] = [];
	for (const [name, schema] of Object.entries(description.controls.properties)) {
		if (!isEffectFontControl(schema)) continue;
		const v = values[name] ?? description.defaults[name] ?? schema.default;
		if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
	}
	return out;
}

/**
 * A saved value as a field shows it (`ParameterValue`), or the field's default. Colour fields show
 * channel arrays as hex, and the default for values they can't show (`"currentColor"`, `rgb(…)`).
 */
export const effectFieldValue = (field: ParameterField, value: unknown): ParameterValue => {
	if (field.type === 'color') return hexColour(value) ?? field.default;
	return value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value)) ? field.default : (value as ParameterValue);
};

/**
 * A colourful, deterministic picture for previews of filters and transitions (`variant` 0 and 1
 * differ, for a transition's two sides).
 */
export function effectSamplePicture(width: number, height: number, variant = 0): EffectPixels {
	const p = createEffectPixels(width, height);
	for (let y = 0, i = 0; y < height; y++) {
		for (let x = 0; x < width; x++, i += 4) {
			const u = x / Math.max(1, width - 1);
			const v = y / Math.max(1, height - 1);
			const check = (Math.floor(u * 4) + Math.floor(v * 4)) % 2;
			if (variant === 0) p.data.set([Math.round(40 + 200 * u), Math.round(80 + 120 * v), Math.round(200 - 120 * u) + check * 30, 255], i);
			else p.data.set([Math.round(230 - 60 * v), Math.round(190 - 100 * u), 60 + check * 40, 255], i);
		}
	}
	return p;
}

/**
 * Sample pictures for an effect's image inputs (`effectSamplePicture`; a transition's `to` gets
 * the second variant), so previews of filters and transitions have something to change.
 */
export function effectSampleInputs(description: Pick<EffectDescription, 'inputs'>, size: { width: number; height: number }): Record<string, EffectPixels> {
	const inputs: Record<string, EffectPixels> = {};
	for (const input of description.inputs) if (input.kind === 'image') inputs[input.name] = effectSamplePicture(size.width, size.height, input.name === 'to' ? 1 : 0);
	return inputs;
}

/**
 * A small preview of an effect from the provider's own renderer: filters run on a sample picture,
 * transitions go half way between two, generators and overlays draw at `time` (default half
 * their length, or 1 s). Thumbnails render one at a time (each renderer is disposed before the
 * next is made) and are kept per provider. Rejects like the provider does (motion effects have
 * no pixels).
 */
export function renderEffectThumbnail(provider: EffectProvider, effect: EffectSummary | EffectDescription, size: { width: number; height: number } = { width: 96, height: 54 }): Promise<EffectPixels> {
	let cache = thumbnails.get(provider);
	if (!cache) thumbnails.set(provider, (cache = new Map()));
	const key = `${effect.id}@${size.width}x${size.height}`;
	let out = cache.get(key);
	if (!out) {
		// One at a time: a browser full of previews would otherwise open a graphics context each.
		out = thumbnailQueue.then(() => renderThumbnail(provider, effect, size));
		thumbnailQueue = out.catch(() => undefined);
		out.catch(() => cache!.delete(key));
		cache.set(key, out);
	}
	return out;
}

const thumbnails = new WeakMap<EffectProvider, Map<string, Promise<EffectPixels>>>();
let thumbnailQueue: Promise<unknown> = Promise.resolve();

async function renderThumbnail(provider: EffectProvider, effect: EffectSummary | EffectDescription, size: { width: number; height: number }): Promise<EffectPixels> {
	const d = 'inputs' in effect ? effect : await provider.describe(effect.id);
	const renderer = await provider.createRenderer(d.id, size);
	try {
		const time = d.duration ? d.duration / 2 : 1000;
		const inputs = effectSampleInputs(d, size);
		return await renderer.render({ time, inputs, ...(d.uses.includes('transition') ? { progress: 0.5 } : {}) });
	} finally {
		renderer.dispose();
	}
}

/** Effects grouped by category, categories in first-seen order. */
export function groupEffectsByCategory<T extends EffectSummary>(effects: readonly T[]): { category: string; effects: T[] }[] {
	const groups = new Map<string, T[]>();
	for (const e of effects) {
		const g = groups.get(e.category);
		if (g) g.push(e);
		else groups.set(e.category, [e]);
	}
	return [...groups].map(([category, list]) => ({ category, effects: list }));
}
