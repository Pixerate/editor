/**
 * Helpers for providers and editors: value validation, catalog search, pixel buffers, masking,
 * and a provider slot editors hold.
 */

import { validateJsonSchema, type SchemaValidationError } from '../tools/schema.js';
import { EffectControlError, NoEffectsProviderError } from './errors.js';
import type {
	EffectDescription,
	EffectImageSource,
	EffectPixels,
	EffectProvider,
	EffectSearchOptions,
	EffectSummary,
	EffectValues
} from './types.js';

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Problems with `values` against an effect's control schema (unknown controls, types, ranges). Partial values are fine. */
export function effectValueErrors(description: Pick<EffectDescription, 'controls'>, values: unknown): SchemaValidationError[] {
	if (values === undefined) return [];
	return validateJsonSchema(values, { ...description.controls, required: [] });
}

/**
 * `values` over the effect's defaults, validated against its control schema. Throws
 * `EffectControlError` naming every bad control. Providers call this in `render`; editors call
 * it before saving values.
 */
export function resolveEffectValues(description: Pick<EffectDescription, 'id' | 'controls' | 'defaults'>, values?: EffectValues): Record<string, EffectValues[string]> {
	const errors = effectValueErrors(description, values);
	if (errors.length) throw new EffectControlError(description.id, errors);
	return { ...description.defaults, ...(values ?? {}) };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const matchesFilters = (e: EffectSummary, o: EffectSearchOptions) =>
	(!o.kind || e.kind === o.kind) && (!o.category || e.category === o.category) && (!o.use || e.uses.includes(o.use));

/**
 * Filters a catalog and ranks it against `query` (every word must appear in the id, name,
 * category, tags or description; name matches rank first). An empty query keeps catalog order.
 * Providers can implement `list` and `search` with it.
 */
export function searchEffectSummaries<T extends EffectSummary>(catalog: readonly T[], query = '', options: EffectSearchOptions = {}): T[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const scored: { e: T; score: number; i: number }[] = [];
	catalog.forEach((e, i) => {
		if (!matchesFilters(e, options)) return;
		const name = e.name.toLowerCase();
		const hay = [e.id, e.name, e.category, ...(e.tags ?? []), e.description ?? ''].join(' ').toLowerCase();
		let score = 0;
		for (const w of words) {
			if (!hay.includes(w)) return;
			score += name.startsWith(w) ? 3 : name.includes(w) ? 2 : 1;
		}
		scored.push({ e, score, i });
	});
	scored.sort((a, b) => b.score - a.score || a.i - b.i);
	const out = scored.map((s) => s.e);
	return options.limit !== undefined ? out.slice(0, Math.max(0, options.limit)) : out;
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

/** A transparent picture, with float samples when `float` is set. */
export function createEffectPixels(width: number, height: number, float = false): EffectPixels {
	const n = Math.max(0, width * height * 4);
	return { width, height, data: new Uint8ClampedArray(n), ...(float ? { float: new Float32Array(n) } : {}) };
}

/** True for an `EffectPixels` (rather than a host image object). */
export function isEffectPixels(source: EffectImageSource | unknown): source is EffectPixels {
	return (
		!!source &&
		typeof source === 'object' &&
		(source as EffectPixels).data instanceof Uint8ClampedArray &&
		typeof (source as EffectPixels).width === 'number' &&
		typeof (source as EffectPixels).height === 'number'
	);
}

/** sRGB-encoded 0–1 to linear light. */
export const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
/** Linear light to sRGB-encoded (clamped below at 0; may exceed 1). */
export const linearToSrgb = (v: number) => (v > 0 ? (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) : 0);

/** Fills `pixels.data` from `pixels.float` (linear float to clamped 8-bit sRGB). */
export function encodeEffectFloat(pixels: EffectPixels): EffectPixels {
	const f = pixels.float;
	if (!f) return pixels;
	const d = pixels.data;
	for (let i = 0; i < d.length; i += 4) {
		d[i] = Math.round(linearToSrgb(f[i]) * 255);
		d[i + 1] = Math.round(linearToSrgb(f[i + 1]) * 255);
		d[i + 2] = Math.round(linearToSrgb(f[i + 2]) * 255);
		d[i + 3] = Math.round(Math.min(1, Math.max(0, f[i + 3])) * 255);
	}
	return pixels;
}

/**
 * Blends an effect `result` back over its `source` by `mask` coverage (alpha channel), in place
 * on `result`: where the mask is 0 the source shows, where it is 255 the result. Without a
 * source (generators), the result's alpha is multiplied by coverage. Editors use it when the
 * provider does not `supportsMask`. All three must have the same size.
 */
export function applyEffectMask(result: EffectPixels, mask: EffectPixels, source?: EffectPixels): EffectPixels {
	const { data } = result;
	const m = mask.data;
	for (let i = 0; i < data.length; i += 4) {
		const k = m[i + 3] / 255;
		if (k >= 1) continue;
		if (source) {
			for (let c = 0; c < 4; c++) data[i + c] = source.data[i + c] + (data[i + c] - source.data[i + c]) * k;
			if (result.float && source.float) {
				for (let c = 0; c < 4; c++) result.float[i + c] = source.float[i + c] + (result.float[i + c] - source.float[i + c]) * k;
			}
		} else {
			data[i + 3] = data[i + 3] * k;
			if (result.float) result.float[i + 3] *= k;
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// The slot an editor keeps
// ---------------------------------------------------------------------------

/**
 * Holds an editor's effects provider. Controllers expose it as `effectsProvider`,
 * `setEffectsProvider(provider | null)` and `useEffects(provider)`; listeners hear every change.
 */
export class EffectsSlot {
	private current: EffectProvider | null = null;
	private readonly listeners = new Set<(provider: EffectProvider | null) => void>();

	get provider(): EffectProvider | null {
		return this.current;
	}

	set(provider: EffectProvider | null): void {
		if (provider === this.current) return;
		this.current = provider;
		for (const l of [...this.listeners]) l(provider);
	}

	/** Sets `provider` and returns a function that clears it again (if it is still the one set). */
	use(provider: EffectProvider): () => void {
		this.set(provider);
		return () => {
			if (this.current === provider) this.set(null);
		};
	}

	/** The provider, or a `NoEffectsProviderError`. */
	require(): EffectProvider {
		if (!this.current) throw new NoEffectsProviderError();
		return this.current;
	}

	subscribe(listener: (provider: EffectProvider | null) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
