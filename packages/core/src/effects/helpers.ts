/**
 * Helpers for providers and editors: value validation, catalog search, pixel buffers, masking,
 * and a provider slot editors hold.
 */

import { validateJsonSchema, type SchemaValidationError } from '../tools/schema.js';
import { EffectControlError, EffectUnsupportedError, NoEffectsProviderError } from './errors.js';
import type {
	CameraKeyframe,
	CameraMoveSample,
	CameraMoveSampleRequest,
	CameraView,
	EffectDescription,
	EffectImageSource,
	EffectPixels,
	EffectProvider,
	EffectSearchOptions,
	EffectSummary,
	EffectUse,
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

/**
 * Whether an editor offering `uses` should offer `e` (in a picker or an `effect` enum). Motion
 * and camera effects draw no picture of their own, so they are offered only where `uses` names
 * them (`motion`, `camera`); with no `uses`, every other effect is.
 */
export function effectOffered(e: Pick<EffectSummary, 'kind' | 'uses'>, uses?: readonly EffectUse[]): boolean {
	if (!uses) return e.kind !== 'motion' && e.kind !== 'camera';
	if (e.kind === 'motion' && !uses.includes('motion')) return false;
	if (e.kind === 'camera' && !uses.includes('camera')) return false;
	return e.uses.some((u) => uses.includes(u));
}

/** A tag as tags are compared: trimmed, lower case, spaces and underscores as single hyphens (`"Game Boy"` → `game-boy`). */
export function normaliseEffectTag(tag: string): string {
	return tag.trim().toLowerCase().replace(/[\s_-]+/g, '-');
}

/** True when the effect carries every one of `tags` (compared with `normaliseEffectTag`). */
export function hasEffectTags(e: Pick<EffectSummary, 'tags'>, tags: readonly string[] | undefined): boolean {
	if (!tags?.length) return true;
	const own = new Set((e.tags ?? []).map(normaliseEffectTag));
	return tags.every((t) => own.has(normaliseEffectTag(t)));
}

/** The tags of `effects` with how many carry each, the most used first (ties alphabetical). */
export function countEffectTags(effects: readonly Pick<EffectSummary, 'tags'>[]): { tag: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const e of effects) for (const tag of new Set((e.tags ?? []).map(normaliseEffectTag))) if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
	return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

const matchesFilters = (e: EffectSummary, o: EffectSearchOptions) =>
	(!o.kind || e.kind === o.kind) && (!o.category || e.category === o.category) && (!o.use || e.uses.includes(o.use)) && hasEffectTags(e, o.tags);

/**
 * Filters a catalog (kind, category, use and every tag) and ranks it against `query` (every word
 * must appear in the id, name, category, tags or description; name matches rank first). An empty query keeps catalog order.
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

// ---------------------------------------------------------------------------
// Camera moves
// ---------------------------------------------------------------------------

/** How far before a cut the "just before" key is taken (a fraction of the move). */
const BEFORE_CUT = 1e-6;

/** True for a `CameraView` with a positive zoom and finite numbers throughout. */
export function isCameraView(view: unknown): view is CameraView {
	if (!view || typeof view !== 'object') return false;
	const v = view as Record<string, unknown>;
	if (!(typeof v.zoom === 'number' && v.zoom > 0 && Number.isFinite(v.zoom))) return false;
	if (!Number.isFinite(v.scrollX) || !Number.isFinite(v.scrollY)) return false;
	return ['tilt', 'turn', 'roll', 'perspective', 'blur', 'blurAngle'].every((k) => v[k] === undefined || Number.isFinite(v[k]));
}

/**
 * Keys `view` (u 0–1 → view) at `fps` across `ms`, with the two keys of a cut at `cut` (0–1).
 * Providers can implement `sampleCameraMove` with it; `sampleEffectCameraMove` falls back to it.
 */
export function sampleCameraViews(view: (u: number) => CameraView, options: { ms: number; fps: number; cut?: number }): CameraMoveSample {
	const { ms, fps, cut } = options;
	if (!(Number.isFinite(ms) && ms >= 0)) throw new EffectUnsupportedError(`ms must be a finite number of ms ≥ 0, got ${ms}.`);
	if (!(Number.isFinite(fps) && fps > 0)) throw new EffectUnsupportedError(`fps must be a number > 0, got ${fps}.`);
	if (cut !== undefined && !(cut >= 0 && cut <= 1)) throw new EffectUnsupportedError(`cut must be 0–1, got ${cut}.`);
	// A move with no length (a cut) is its first view, then its last at the same time.
	if (ms === 0) return { keys: [{ t: 0, view: view(0) }, { t: 0, view: view(1) }], ...(cut !== undefined ? { cut: 0 } : {}) };
	const step = 1000 / fps;
	const cutMs = cut === undefined ? undefined : cut * ms;
	const keys: CameraKeyframe[] = [];
	const frames = Math.ceil(ms / step - 1e-9);
	for (let i = 0; i <= frames; i++) {
		const t = Math.min(ms, i * step);
		if (cutMs !== undefined && (keys.length ? keys[keys.length - 1].t : -1) < cutMs && t >= cutMs) {
			keys.push({ t: cutMs, view: view(Math.max(0, cut! - BEFORE_CUT)) }, { t: cutMs, view: view(cut!) });
			if (t === cutMs) continue;
		}
		keys.push({ t, view: view(t / ms) });
	}
	return { keys, ...(cutMs !== undefined ? { cut: cutMs } : {}) };
}

/**
 * A camera move as keyframes: the provider's own `sampleCameraMove` when it has one, else its
 * `cameraView` keyed per frame (with the move's `cut` from `describe`). Throws
 * `EffectUnsupportedError` when the provider has no camera support.
 */
export async function sampleEffectCameraMove(provider: EffectProvider, id: string, request: CameraMoveSampleRequest): Promise<CameraMoveSample> {
	if (!provider.capabilities.supportsCamera || !provider.cameraView) throw new EffectUnsupportedError(`${provider.name} has no camera moves (capabilities.supportsCamera is not set).`, id);
	if (provider.sampleCameraMove) return provider.sampleCameraMove(id, request);
	const d = await provider.describe(id);
	if (d.kind !== 'camera' || !d.camera) throw new EffectUnsupportedError(`"${id}" is a ${d.kind} effect, not a camera move.`, id);
	const { from, to, ms, stage, values } = request;
	return sampleCameraViews((u) => provider.cameraView!(id, { from, to, u, ms, stage }, values), { ms, fps: request.fps, cut: d.camera.cut });
}
