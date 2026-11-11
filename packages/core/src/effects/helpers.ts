/**
 * Helpers for providers and editors: value validation, catalog search, pixel buffers, masking,
 * and a provider slot editors hold.
 */

import { validateJsonSchema, type JsonSchema, type SchemaValidationError } from '../tools/schema.js';
import { EffectControlError, EffectError, EffectUnsupportedError, NoEffectsProviderError, UnknownEffectError } from './errors.js';
import type {
	CameraKeyframe,
	CameraMoveRole,
	CameraMoveSpec,
	CameraMoveSample,
	CameraMoveSampleRequest,
	CameraStage,
	CameraView,
	EffectDescription,
	EffectImageSource,
	EffectPaintHint,
	EffectPixels,
	EffectProvider,
	EffectProviderCapabilities,
	EffectSearchOptions,
	EffectSummary,
	EffectUse,
	EffectValue,
	EffectValues,
	TimingBlend,
	TimingFrame,
	TimingSample,
	TimingSampleRequest
} from './types.js';
import { EFFECT_PAINT_MAPS, EFFECT_PAINT_MAX_COLORS, EFFECT_PAINT_REPEATS, EFFECT_PATH_FORMAT, TIMING_BLENDS, TIMING_DEFAULT_FPS, TIMING_MAX_FPS, TIMING_MAX_FRAMES } from './types.js';

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

/** Kinds that draw no picture of their own, each offered only where its use (the same name) is. */
const PIXELLESS_KINDS = ['motion', 'camera', 'timing'] as const;

/**
 * Whether an editor offering `uses` should offer `e` (in a picker or an `effect` enum). Motion,
 * camera and timing effects draw no picture of their own, so they are offered only where `uses`
 * names them (`motion`, `camera`, `timing`); with no `uses`, every other effect is.
 */
export function effectOffered(e: Pick<EffectSummary, 'kind' | 'uses'>, uses?: readonly EffectUse[]): boolean {
	const pixelless = (PIXELLESS_KINDS as readonly string[]).includes(e.kind);
	if (!uses) return !pixelless;
	if (pixelless && !uses.includes(e.kind as EffectUse)) return false;
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
	(!o.kind || e.kind === o.kind) &&
	(!o.category || e.category === o.category) &&
	(!o.use || e.uses.includes(o.use)) &&
	hasEffectTags(e, o.tags) &&
	(!o.accepts?.length || o.accepts.every((a) => e.accepts?.includes(a)));

/**
 * The controls of an effect that draw along a path given at run time: those whose schema (or one
 * of its `anyOf` / `oneOf` choices) has `format: 'svg-path'`. See `EFFECT_PATH_FORMAT` for the
 * values they take.
 */
export function pathControlsOf(d: Pick<EffectDescription, 'controls'>): string[] {
	const isPath = (s: JsonSchema | undefined): boolean => !!s && (s.format === EFFECT_PATH_FORMAT || [...(s.anyOf ?? []), ...(s.oneOf ?? [])].some((x) => isPath(x as JsonSchema)));
	return Object.entries(d.controls?.properties ?? {})
		.filter(([, s]) => isPath(s as JsonSchema))
		.map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Paint hints
// ---------------------------------------------------------------------------

/**
 * Whether effect paint should offer `e`: always, unless the provider declares `paintHints`, when
 * only effects with a `paint` hint suit paint. Effect layers, fills and the paper don't ask this.
 */
export function effectSuitsPaint(e: Pick<EffectSummary, 'paint'>, capabilities?: Pick<EffectProviderCapabilities, 'paintHints'> | null): boolean {
	return !capabilities?.paintHints || !!e.paint;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Problems with the shape of a paint hint (not checked against controls), each a sentence fragment. */
export function effectPaintHintShapeProblems(raw: unknown): string[] {
	if (!isPlainObject(raw)) return ['paint must be an object { map, colors?, values?, live?, repeat?, size? }'];
	const out: string[] = [];
	const known = new Set(['map', 'colors', 'values', 'live', 'repeat', 'size']);
	for (const k of Object.keys(raw)) if (!known.has(k)) out.push(`paint.${k} is not a paint hint field (map, colors, values, live, repeat, size)`);
	if (!(EFFECT_PAINT_MAPS as readonly unknown[]).includes(raw.map)) out.push(`paint.map must be ${EFFECT_PAINT_MAPS.map((m) => `"${m}"`).join(', ')}`);
	if (raw.colors !== undefined) {
		const c = raw.colors;
		if (!Array.isArray(c) || !c.every((k) => typeof k === 'string' && k)) out.push('paint.colors must be a list of colour control names');
		else if (c.length > EFFECT_PAINT_MAX_COLORS) out.push(`paint.colors names ${c.length} controls; at most ${EFFECT_PAINT_MAX_COLORS} (the main colour, then the second)`);
		else if (new Set(c).size !== c.length) out.push('paint.colors names a control twice');
	}
	if (raw.values !== undefined && !isPlainObject(raw.values)) out.push('paint.values must be an object of control values');
	if (raw.live !== undefined && typeof raw.live !== 'boolean') out.push('paint.live must be true or false');
	if (raw.repeat !== undefined && !(EFFECT_PAINT_REPEATS as readonly unknown[]).includes(raw.repeat)) out.push(`paint.repeat must be ${EFFECT_PAINT_REPEATS.map((m) => `"${m}"`).join(', ')}`);
	if (raw.size !== undefined && !(typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size > 0)) out.push('paint.size must be a brush width in px above 0');
	return out;
}

/**
 * Problems with an effect's paint hint against its own controls: shape, colour controls that
 * exist and take `#rrggbb`, values its controls accept, and a path control for `map: "path"`.
 * Empty when it has no hint. `checkEffectProvider` reports these.
 */
export function effectPaintHintProblems(d: Pick<EffectDescription, 'controls' | 'paint'>): string[] {
	if (d.paint === undefined) return [];
	const shape = effectPaintHintShapeProblems(d.paint);
	if (shape.length) return shape;
	const hint = d.paint as EffectPaintHint;
	const out: string[] = [];
	const controls = d.controls?.properties ?? {};
	for (const c of hint.colors ?? []) {
		if (!(c in controls)) out.push(`paint.colors names "${c}", which is not a control`);
		else if (effectValueErrors(d, { [c]: '#000000' }).length) out.push(`paint.colors names "${c}", which does not take a "#rrggbb" colour`);
	}
	for (const e of effectValueErrors(d, hint.values)) out.push(`paint.values ${e.path}: ${e.message}`);
	if (hint.map === 'path' && !pathControlsOf(d).length) out.push('paint.map is "path", but no control takes a path (format "svg-path"); use "stroke" or "canvas"');
	return out;
}

/** A paint hint as saved (an authored effect's document), or a thrown `Error` saying what is wrong. */
export function readEffectPaintHint(raw: unknown): EffectPaintHint {
	const problems = effectPaintHintShapeProblems(raw);
	if (problems.length) throw new Error(`${problems.join('; ')}.`);
	const r = raw as Record<string, unknown>;
	return {
		map: r.map as EffectPaintHint['map'],
		...(r.colors ? { colors: [...(r.colors as string[])] } : {}),
		...(r.values ? { values: { ...(r.values as EffectValues) } } : {}),
		...(r.live !== undefined ? { live: r.live as boolean } : {}),
		...(r.repeat !== undefined ? { repeat: r.repeat as EffectPaintHint['repeat'] } : {}),
		...(r.size !== undefined ? { size: r.size as number } : {})
	};
}

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

/**
 * The image input an editor feeds a layer, node or sticker to when it applies `d` to it:
 * `source` (a filter's picture) when the effect has it, else its first required image input,
 * else its first image input; `null` when it takes no picture.
 */
export function layerImageInput(d: Pick<EffectDescription, 'inputs'>): string | null {
	const images = d.inputs.filter((i) => i.kind === 'image');
	return (images.find((i) => i.name === 'source') ?? images.find((i) => i.required) ?? images[0])?.name ?? null;
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

/** The field a shot names a move of `role` in: `in` for a transition, `during` for a hold. */
export const cameraMoveField = (role: CameraMoveRole): 'in' | 'during' => (role === 'transition' ? 'in' : 'during');

/** The camera moves of `role` in a catalog, in its order. */
export function cameraMovesFor<T extends Pick<EffectSummary, 'kind' | 'camera'>>(catalog: readonly T[], role: CameraMoveRole): T[] {
	return catalog.filter((e) => e.kind === 'camera' && e.camera?.role === role);
}

/** The ids of a catalog's camera moves of `role` as a sentence's list: `"a", "b"` (or `none`). */
export function cameraMoveIdList(catalog: readonly Pick<EffectSummary, 'id' | 'kind' | 'camera'>[], role: CameraMoveRole): string {
	const ids = cameraMovesFor(catalog, role).map((e) => JSON.stringify(e.id));
	return ids.length ? ids.join(', ') : 'none (the provider has no camera moves of that role)';
}

/** A camera move spec as its parts (`"id"` → `{ move: "id" }`); undefined when it is neither form. */
export function cameraMoveParts(spec: unknown): Exclude<CameraMoveSpec, string> | undefined {
	if (typeof spec === 'string') return spec ? { move: spec } : undefined;
	if (spec && typeof spec === 'object' && !Array.isArray(spec) && typeof (spec as { move?: unknown }).move === 'string') return spec as Exclude<CameraMoveSpec, string>;
	return undefined;
}

/** Longest `ms` a transition move takes (ms). */
export const CAMERA_MOVE_MAX_MS = 60000;

/**
 * A camera move spec checked against a provider for a role, with its preset's values written out
 * into `values`, so a document plays it without asking the provider for the preset again.
 * Throws an error that says what to do: an unknown id or a move of the other role names the
 * moves the role takes, an unknown preset names the presets, and bad values name the controls.
 */
export async function resolveCameraMoveSpec(provider: EffectProvider, spec: CameraMoveSpec, role: CameraMoveRole): Promise<{ spec: Exclude<CameraMoveSpec, string>; description: EffectDescription }> {
	const field = cameraMoveField(role);
	if (!provider.capabilities.supportsCamera || !provider.cameraView) throw new EffectUnsupportedError(`${provider.name} has no camera moves (capabilities.supportsCamera is not set), so camera "${field}" cannot be set.`);
	const parts = cameraMoveParts(spec);
	const catalog = await provider.list({ kind: 'camera' });
	if (!parts) throw new EffectUnsupportedError(`Camera "${field}" is a camera move's id, or { move, ms?, preset?, values? }; it takes one of ${cameraMoveIdList(catalog, role)}.`);
	let description: EffectDescription;
	try {
		description = await provider.describe(parts.move);
	} catch (error) {
		if (error instanceof UnknownEffectError || (error as { code?: string }).code === 'unknown_effect')
			throw new EffectError('unknown_effect', `There is no camera move "${parts.move}"; camera "${field}" takes one of ${cameraMoveIdList(catalog, role)}.`, parts.move);
		throw error;
	}
	if (description.kind !== 'camera' || !description.camera) throw new EffectUnsupportedError(`"${parts.move}" is a ${description.kind} effect, not a camera move; camera "${field}" takes one of ${cameraMoveIdList(catalog, role)}.`, parts.move);
	if (description.camera.role !== role) {
		const other = cameraMoveField(description.camera.role);
		throw new EffectUnsupportedError(
			`"${parts.move}" moves the camera ${description.camera.role === 'hold' ? 'while a shot holds' : 'into a shot'}, so it goes in camera "${other}", not "${field}"; camera "${field}" takes one of ${cameraMoveIdList(catalog, role)}.`,
			parts.move
		);
	}
	if (parts.ms !== undefined) {
		if (role === 'hold') throw new EffectUnsupportedError(`A move while the shot holds plays across the shot's hold; set the hold's length instead of "ms".`, parts.move);
		if (!(typeof parts.ms === 'number' && Number.isFinite(parts.ms) && parts.ms >= 0 && parts.ms <= CAMERA_MOVE_MAX_MS))
			throw new EffectUnsupportedError(`Camera "in" ms is how long the move takes, 0 to ${CAMERA_MOVE_MAX_MS} (default ${description.camera.durationMs} for "${parts.move}").`, parts.move);
	}
	let presetValues: EffectValues = {};
	if (parts.preset !== undefined) {
		const preset = description.presets.find((p) => p.name === parts.preset);
		if (!preset) throw new EffectUnsupportedError(`"${parts.move}" has no preset ${JSON.stringify(parts.preset)}; its presets are ${description.presets.length ? description.presets.map((p) => JSON.stringify(p.name)).join(', ') : 'none'}.`, parts.move);
		presetValues = preset.values;
	}
	const values: Record<string, EffectValue> = { ...presetValues, ...(parts.values ?? {}) };
	resolveEffectValues(description, values);
	return {
		spec: { move: description.id, ...(parts.ms !== undefined ? { ms: parts.ms } : {}), ...(parts.preset !== undefined ? { preset: parts.preset } : {}), ...(Object.keys(values).length ? { values } : {}) },
		description
	};
}

/** A box of the scene, in its units. */
export interface CameraBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The view that shows `box` on `stage`: the box's centre in the middle, at the zoom that fits it
 * whole (as SVG's `xMidYMid meet`).
 */
export function cameraViewOfBox(box: CameraBox, stage: CameraStage): CameraView {
	const zoom = Math.min(stage.width / box.width, stage.height / box.height);
	return { zoom, scrollX: stage.width / (2 * zoom) - (box.x + box.width / 2), scrollY: stage.height / (2 * zoom) - (box.y + box.height / 2) };
}

/** The box of the scene a view shows on `stage` (its tilt, turn, roll and blur aside). */
export function cameraBoxOfView(view: CameraView, stage: CameraStage): CameraBox {
	const width = stage.width / view.zoom;
	const height = stage.height / view.zoom;
	return { x: -view.scrollX, y: -view.scrollY, width, height };
}

// ---------------------------------------------------------------------------
// Timing effects
// ---------------------------------------------------------------------------

/** Throws `EffectUnsupportedError` unless `footageMs` is a footage length a timing effect takes (a number of ms > 0). */
export function checkTimingFootage(footageMs: number, id?: string): void {
	if (typeof footageMs !== 'number' || !Number.isFinite(footageMs) || footageMs <= 0) {
		throw new EffectUnsupportedError(`The footage's length is a number of ms above 0; it was ${String(footageMs)}.`, id);
	}
}

/**
 * Checks a timing request (footage, time and fps), throwing `EffectUnsupportedError` with a
 * sentence naming the valid range, and gives its fps (default `TIMING_DEFAULT_FPS`).
 */
export function checkTimingRequest(request: TimingSampleRequest, id?: string): number {
	if (!request || typeof request !== 'object') throw new EffectUnsupportedError('A timing request is { time, footage, fps? }: ms into the retimed clip, the footage\'s length in ms, and its frame rate.', id);
	checkTimingFootage(request.footage, id);
	const fps = request.fps ?? TIMING_DEFAULT_FPS;
	if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0 || fps > TIMING_MAX_FPS) {
		throw new EffectUnsupportedError(`The footage's frame rate is above 0 and at most ${TIMING_MAX_FPS} frames per second; it was ${String(fps)}.`, id);
	}
	if (typeof request.time !== 'number' || !Number.isFinite(request.time)) throw new EffectUnsupportedError(`The time is a number of ms into the retimed clip; it was ${String(request.time)}.`, id);
	return fps;
}

/** Index of the footage's last frame at `fps`. */
const lastFrameOf = (footageMs: number, fps: number) => Math.max(0, Math.ceil((footageMs * fps) / 1000 - 1e-9) - 1);

/**
 * Raw footage frames (any times, any positive weights) as a `TimingSample`: each time held within
 * the footage and moved to the start of its frame, frames on the same footage frame merged, at
 * most `TIMING_MAX_FRAMES` (evenly spaced), weights scaled to add up to 1, earliest first. Frames
 * with a time or weight that is not a finite number, or a weight ≤ 0, are dropped; with none left,
 * the sample is the frame at `request.time`. Providers can build `timingSample` on it.
 */
export function normaliseTimingSample(raw: readonly TimingFrame[], request: TimingSampleRequest, blend: TimingBlend = 'average'): TimingSample {
	const fps = request.fps ?? TIMING_DEFAULT_FPS;
	const frameMs = 1000 / fps;
	const last = lastFrameOf(request.footage, fps);
	const frameOf = (t: number) => Math.min(last, Math.max(0, Math.floor(t / frameMs + 1e-6)));
	const weights = new Map<number, number>();
	for (const f of raw) {
		if (!Number.isFinite(f.time) || !Number.isFinite(f.weight) || f.weight <= 0) continue;
		const i = frameOf(f.time);
		weights.set(i, (weights.get(i) ?? 0) + f.weight);
	}
	if (!weights.size) weights.set(Number.isFinite(request.time) ? frameOf(request.time) : 0, 1);
	let frames = [...weights.entries()].sort((a, b) => a[0] - b[0]);
	if (frames.length > TIMING_MAX_FRAMES) {
		const stride = frames.length / TIMING_MAX_FRAMES;
		frames = Array.from({ length: TIMING_MAX_FRAMES }, (_, k) => frames[Math.floor(k * stride)]);
	}
	const total = frames.reduce((sum, [, w]) => sum + w, 0);
	return { frames: frames.map(([i, w]) => ({ time: (i * 1000) / fps, weight: w / total })), blend };
}

/**
 * What is wrong with `sample` as the answer to `request` (see `TimingSample`), as sentences; empty
 * when it keeps every rule. `checkEffectProvider` uses it; hosts can check a provider's samples
 * with it.
 */
export function timingSampleProblems(sample: unknown, request: TimingSampleRequest): string[] {
	if (!sample || typeof sample !== 'object') return ['the sample is not an object { frames, blend }'];
	const { frames, blend } = sample as Partial<TimingSample>;
	const problems: string[] = [];
	if (!TIMING_BLENDS.includes(blend as TimingBlend)) problems.push(`blend "${String(blend)}" is not one of ${TIMING_BLENDS.join(', ')}`);
	if (!Array.isArray(frames) || !frames.length) return [...problems, 'frames must be a list of at least one { time, weight }'];
	if (frames.length > TIMING_MAX_FRAMES) problems.push(`it has ${frames.length} frames; at most ${TIMING_MAX_FRAMES} are allowed`);
	const fps = request.fps ?? TIMING_DEFAULT_FPS;
	const last = lastFrameOf(request.footage, fps);
	let total = 0;
	let previous = -Infinity;
	for (const f of frames as readonly TimingFrame[]) {
		if (!f || !Number.isFinite(f.time) || !Number.isFinite(f.weight)) {
			problems.push(`frame ${JSON.stringify(f)} needs a finite time and weight`);
			continue;
		}
		const index = (f.time * fps) / 1000;
		if (Math.abs(index - Math.round(index)) > 1e-6) problems.push(`frame time ${f.time} is not the start of a frame at ${fps} fps (index × ${+(1000 / fps).toFixed(6)} ms)`);
		else if (Math.round(index) < 0 || Math.round(index) > last) problems.push(`frame time ${f.time} is outside the footage (frames 0 to ${last}, the last at ${+((last * 1000) / fps).toFixed(6)} ms)`);
		if (f.time <= previous) problems.push(`frame times must be distinct and earliest first; ${f.time} follows ${previous}`);
		previous = f.time;
		if (!(f.weight > 0)) problems.push(`frame at ${f.time} has weight ${f.weight}; weights are > 0`);
		total += f.weight;
	}
	if (Math.abs(total - 1) > 1e-6) problems.push(`weights add up to ${total}, not 1`);
	return problems;
}

/**
 * Blends footage frames by weight as a timing sample says (see `TimingBlend`): the reference for
 * hosts that blend in their own pipeline, and a ready blend for `EffectPixels`. Reads and writes
 * 8-bit `data` (straight alpha, rounded); `float` is not used. Writes into `out` when given (the
 * frames' size), else a new picture. Throws `EffectUnsupportedError` for no frames or frames of
 * different sizes.
 */
export function blendTimingFrames(frames: readonly { pixels: EffectPixels; weight: number }[], blend: TimingBlend, out?: EffectPixels): EffectPixels {
	if (!frames.length) throw new EffectUnsupportedError('There are no frames to blend; a timing sample has at least one.');
	const { width, height } = frames[0].pixels;
	for (const f of frames) {
		if (f.pixels.width !== width || f.pixels.height !== height) throw new EffectUnsupportedError(`A ${f.pixels.width}×${f.pixels.height} frame cannot be blended with ${width}×${height} frames.`);
	}
	const target = out ?? createEffectPixels(width, height);
	if (target.width !== width || target.height !== height) throw new EffectUnsupportedError(`The output is ${target.width}×${target.height}; the frames are ${width}×${height}.`);
	const o = target.data;
	if (frames.length === 1) {
		o.set(frames[0].pixels.data);
		return target;
	}
	const s = new Float64Array(o.length);
	if (blend === 'lighten') {
		const heaviest = Math.max(...frames.map((f) => f.weight));
		for (const f of frames) {
			const k = heaviest > 0 ? f.weight / heaviest : 1;
			const p = f.pixels.data;
			for (let i = 0; i < s.length; i += 4) {
				const a = (p[i + 3] / 255) * k;
				for (let c = 0; c < 3; c++) if (p[i + c] * a > s[i + c]) s[i + c] = p[i + c] * a;
				if (a > s[i + 3]) s[i + 3] = a;
			}
		}
		for (let i = 0; i < s.length; i += 4) {
			// Colour stays as it was dimmed (a faded trail is darker), not divided back up by its alpha.
			for (let c = 0; c < 3; c++) o[i + c] = Math.round(s[i + c]);
			o[i + 3] = Math.round(s[i + 3] * 255);
		}
		return target;
	}
	let total = 0;
	for (const f of frames) {
		total += f.weight;
		const p = f.pixels.data;
		for (let i = 0; i < s.length; i += 4) {
			const a = p[i + 3] * f.weight;
			for (let c = 0; c < 3; c++) s[i + c] += p[i + c] * a;
			s[i + 3] += a;
		}
	}
	for (let i = 0; i < s.length; i += 4) {
		const a = s[i + 3];
		for (let c = 0; c < 3; c++) o[i + c] = a > 0 ? Math.round(s[i + c] / a) : 0;
		o[i + 3] = total > 0 ? Math.round(a / total) : 0;
	}
	return target;
}
