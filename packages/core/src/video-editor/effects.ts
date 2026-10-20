/**
 * Provider effects in the video editor (see `@pixerate/editor/effects`): the per-frame cache of
 * rendered effect pictures the preview and frame-exact exports draw from, and helpers to find the
 * effects a project uses.
 *
 * Effects render asynchronously. The canvas drawing (`drawVideoFrame`) is synchronous, so it asks
 * the engine for a picture by key: a cached one is drawn at once, and a missing one is requested
 * and the layer drawn without its effects meanwhile (the frame counts as incomplete). When the
 * render lands, subscribers redraw. `renderVideoFrameExact` repeats this until every effect of the
 * frame is in, which is what exports use.
 */

import { EffectsSlot, createEffectPixels, effectValueErrors } from '../effects/helpers.js';
import { EffectControlError, EffectUnsupportedError } from '../effects/errors.js';
import { EffectRendererPool } from '../effects/pool.js';
import { validateJsonSchema, type SchemaValidationError } from '../tools/schema.js';
import type { EffectDescription, EffectPixels, EffectProvider, EffectRenderRequest, EffectUse, EffectValue } from '../effects/types.js';
import { isVideoKeyframes } from './keyframes.js';
import type { VideoLayer, VideoLayerEffect } from './evaluate.js';
import { allVideoTracks } from './timeline.js';
import type { VideoClip, VideoEffectRef, VideoEffectValues, VideoProject } from './types.js';

/** Where a project uses a provider effect. */
export interface VideoEffectUse {
	/** The clip it is on (for a transition: the clip it leads into). */
	clip: string;
	/** `clip`: in the clip's effect stack (`instance` is its id); `transition`: an effect transition; `generator`: an effect clip. */
	kind: 'clip' | 'transition' | 'generator';
	instance?: string;
	effect: string;
	name?: string;
	provider?: string;
	enabled: boolean;
}

/** Every provider effect in a project, sequences included, in track and clip order. */
export function videoProjectEffects(project: VideoProject): VideoEffectUse[] {
	const out: VideoEffectUse[] = [];
	for (const { track } of allVideoTracks(project)) for (const clip of track.clips) out.push(...videoClipEffectUses(clip));
	return out;
}

const refFields = (r: VideoEffectRef) => ({ effect: r.effect, ...(r.name ? { name: r.name } : {}), ...(r.provider ? { provider: r.provider } : {}) });

/** The provider effects of one clip: its effect clip picture, its transition and its effect stack. */
export function videoClipEffectUses(clip: VideoClip): VideoEffectUse[] {
	const out: VideoEffectUse[] = [];
	if (clip.type === 'effect') out.push({ clip: clip.id, kind: 'generator', ...refFields(clip), enabled: true });
	if (clip.transition?.type === 'effect' && clip.transition.effect) out.push({ clip: clip.id, kind: 'transition', ...refFields(clip.transition.effect), enabled: true });
	for (const e of clip.effects ?? []) out.push({ clip: clip.id, kind: 'clip', instance: e.id, ...refFields(e), enabled: e.enabled !== false });
	return out;
}

/** True when drawing the layers needs an effects provider. */
export const videoLayersUseEffects = (layers: readonly VideoLayer[]): boolean =>
	layers.some((l) => !!(l.effects?.length || l.generator || l.transitionEffect || (l.layers && videoLayersUseEffects(l.layers))));

/** The start of the frame `time` falls in (ms), on the project's frame grid. Effects render once per frame. */
export const videoEffectFrameTime = (time: number, fps: number): number => (Math.floor((time * fps) / 1000 + 1e-6) * 1000) / fps;

// ---------------------------------------------------------------------------
// Jobs and keys
// ---------------------------------------------------------------------------

/** What to render for one layer. */
export type VideoEffectJob =
	/** A clip's effect stack over its unprocessed picture. */
	| { kind: 'stack'; input: EffectPixels; effects: readonly VideoLayerEffect[] }
	/** An effect clip: the generator at `time`, then the clip's effect stack. */
	| { kind: 'generator'; width: number; height: number; effect: string; values: Record<string, EffectValue>; time: number; effects: readonly VideoLayerEffect[] }
	/** An effect transition between two whole-frame pictures. */
	| { kind: 'transition'; effect: string; values: Record<string, EffectValue>; progress: number; time: number; from: EffectPixels; to: EffectPixels };

const PLACEMENT = new Set(['opacity', 'rect', 'rotation', 'blend', 'wipe', 'iris', 'grade', 'track']);
const round = (_k: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

/**
 * The cache key of a layer's processed picture at a canvas size: everything that changes the
 * picture before placement (its content, the moment of source, the effects and their values),
 * not where it is placed. A transition's key covers both of its pictures, placement included.
 */
export function videoEffectLayerKey(layer: VideoLayer, width: number, height: number): string {
	const content = layer.transitionEffect
		? layer
		: Object.fromEntries(Object.entries(layer).filter(([k]) => !PLACEMENT.has(k)));
	return `${width}x${height}:${JSON.stringify(content, round)}`;
}

// ---------------------------------------------------------------------------
// Pixel mixing
// ---------------------------------------------------------------------------

/** `a` mixed towards `b` by `k` (0–1), as a new picture. */
export function mixEffectPixels(a: EffectPixels, b: EffectPixels, k: number): EffectPixels {
	if (k >= 1) return b;
	const out = createEffectPixels(a.width, a.height);
	for (let i = 0; i < out.data.length; i++) out.data[i] = a.data[i] + (b.data[i] - a.data[i]) * k;
	return out;
}

/** `top` laid over `base` (straight alpha, source-over) at `opacity`, as a new picture. */
export function overEffectPixels(base: EffectPixels, top: EffectPixels, opacity = 1): EffectPixels {
	const out = createEffectPixels(base.width, base.height);
	const o = out.data;
	const b = base.data;
	const t = top.data;
	for (let i = 0; i < o.length; i += 4) {
		const ta = (t[i + 3] / 255) * opacity;
		const ba = b[i + 3] / 255;
		const a = ta + ba * (1 - ta);
		o[i + 3] = Math.round(a * 255);
		if (a <= 0) continue;
		for (let c = 0; c < 3; c++) o[i + c] = (t[i + c] * ta + b[i + c] * ba * (1 - ta)) / a;
	}
	return out;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface VideoEffectsEngineOptions {
	/** The provider slot to follow (a controller passes its own). Default: a new one. */
	slot?: EffectsSlot;
	/** Rendered pictures kept (default 120, a few seconds of one layer). */
	maxEntries?: number;
	/** Live renderers kept (default 4): GPU providers hold a graphics context each (see `EffectRendererPool`). */
	maxRenderers?: number;
	/**
	 * Turns rendered pixels into something `drawImage` takes. Default: an `OffscreenCanvas` (or a
	 * `<canvas>`) holding them; `null` where neither exists.
	 */
	toImage?: (pixels: EffectPixels) => CanvasImageSource | null;
}

interface Entry {
	pixels: EffectPixels;
	image?: CanvasImageSource | null;
}

function defaultToImage(p: EffectPixels): CanvasImageSource | null {
	const data = new Uint8ClampedArray(p.data);
	if (typeof ImageData === 'undefined') return null;
	const image = new ImageData(data, p.width, p.height);
	if (typeof OffscreenCanvas !== 'undefined') {
		const c = new OffscreenCanvas(p.width, p.height);
		c.getContext('2d')?.putImageData(image, 0, 0);
		return c;
	}
	if (typeof document !== 'undefined') {
		const c = document.createElement('canvas');
		c.width = p.width;
		c.height = p.height;
		c.getContext('2d')?.putImageData(image, 0, 0);
		return c;
	}
	return null;
}

/**
 * Renders and caches provider effect pictures for one editor. It follows the editor's provider
 * slot: with no provider it renders nothing (`available` is false), and a new provider clears the
 * cache and disposes the old renderers.
 */
export class VideoEffectsEngine {
	readonly slot: EffectsSlot;
	private readonly cache = new Map<string, Entry>();
	private readonly pending = new Map<string, Promise<void>>();
	private readonly failures = new Map<string, Error>();
	private readonly pool: EffectRendererPool;
	private readonly descriptions = new Map<string, Promise<EffectDescription>>();
	private readonly listeners = new Set<() => void>();
	private readonly maxEntries: number;
	private readonly toImage: (pixels: EffectPixels) => CanvasImageSource | null;
	private generation = 0;
	private readonly detach: () => void;

	constructor(options: VideoEffectsEngineOptions = {}) {
		this.slot = options.slot ?? new EffectsSlot();
		this.maxEntries = options.maxEntries ?? 120;
		this.toImage = options.toImage ?? defaultToImage;
		this.pool = new EffectRendererPool({ maxRenderers: options.maxRenderers });
		this.detach = this.slot.subscribe(() => {
			this.reset();
			this.notify();
		});
	}

	get provider(): EffectProvider | null {
		return this.slot.provider;
	}

	/** True when a provider is registered, so effects can be drawn. */
	get available(): boolean {
		return !!this.slot.provider;
	}

	/** The drawable picture for `key`, or `undefined` when it is not rendered (yet). */
	get(key: string): CanvasImageSource | null | undefined {
		const e = this.cache.get(key);
		if (!e) return undefined;
		this.cache.delete(key);
		this.cache.set(key, e);
		if (e.image === undefined) e.image = this.toImage(e.pixels);
		return e.image;
	}

	/** The rendered pixels for `key`. */
	pixels(key: string): EffectPixels | undefined {
		return this.cache.get(key)?.pixels;
	}

	/** Why the render for `key` failed, if it did (it is not retried until the cache is cleared). */
	failure(key: string): Error | undefined {
		return this.failures.get(key);
	}

	/** Every failure so far, newest last. */
	failuresList(): { key: string; error: Error }[] {
		return [...this.failures].map(([key, error]) => ({ key, error }));
	}

	/** Whether `key` is being rendered. */
	isPending(key: string): boolean {
		return this.pending.has(key);
	}

	/**
	 * Starts rendering `job` into `key` unless it is cached, pending or failed. Returns true while
	 * the picture is on its way (so the frame is waiting for it).
	 */
	request(key: string, job: VideoEffectJob): boolean {
		if (this.cache.has(key)) return false;
		if (this.pending.has(key)) return true;
		if (this.failures.has(key) || !this.slot.provider) return false;
		const generation = this.generation;
		const run = this.run(job)
			.then((pixels) => {
				if (generation !== this.generation) return;
				this.cache.set(key, { pixels });
				while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
			})
			.catch((error: unknown) => {
				if (generation !== this.generation) return;
				this.failures.set(key, error instanceof Error ? error : new Error(String(error)));
			})
			.finally(() => {
				if (this.pending.get(key) === run) this.pending.delete(key);
				if (generation === this.generation) this.notify();
			});
		this.pending.set(key, run);
		return true;
	}

	/** Resolves when nothing is being rendered. */
	async idle(): Promise<void> {
		while (this.pending.size) await Promise.all([...this.pending.values()]);
	}

	/** Renders a job now, without the cache. Rejects with the provider's error. */
	async run(job: VideoEffectJob): Promise<EffectPixels> {
		const provider = this.slot.require();
		if (job.kind === 'transition') {
			const out = await this.render(provider, job.effect, job.from.width, job.from.height, { time: job.time, progress: job.progress, values: job.values, inputs: { from: job.from, to: job.to } });
			return out;
		}
		let cur: EffectPixels;
		if (job.kind === 'generator') cur = await this.render(provider, job.effect, job.width, job.height, { time: job.time, values: job.values });
		else cur = job.input;
		return this.stack(provider, cur, job.effects);
	}

	private async stack(provider: EffectProvider, input: EffectPixels, effects: readonly VideoLayerEffect[]): Promise<EffectPixels> {
		let cur = input;
		for (const e of effects) {
			const d = await this.describe(provider, e.effect);
			// A filter changes its input; anything else (an overlay) is drawn over it.
			if (d.inputs.some((i) => i.name === 'source')) {
				const out = await this.render(provider, e.effect, cur.width, cur.height, { time: e.time, values: e.values, inputs: { source: cur } });
				cur = mixEffectPixels(cur, out, e.opacity);
			} else {
				const out = await this.render(provider, e.effect, cur.width, cur.height, { time: e.time, values: e.values });
				cur = overEffectPixels(cur, out, e.opacity);
			}
		}
		return cur;
	}

	/** The provider's description of an effect, fetched once. */
	describe(provider: EffectProvider, id: string): Promise<EffectDescription> {
		let d = this.descriptions.get(id);
		if (!d) {
			d = Promise.resolve().then(() => provider.describe(id));
			d.catch(() => this.descriptions.delete(id));
			this.descriptions.set(id, d);
		}
		return d;
	}

	/** Renders through the pool: a few live renderers, one render at a time on each. */
	private render(provider: EffectProvider, id: string, width: number, height: number, request: EffectRenderRequest): Promise<EffectPixels> {
		return this.pool.render(provider, id, { width, height }, request);
	}

	/** Forgets every picture and failure and disposes the renderers (e.g. after the provider changes). */
	reset(): void {
		this.generation++;
		this.cache.clear();
		this.pending.clear();
		this.failures.clear();
		this.descriptions.clear();
		this.pool.clear();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify() {
		for (const l of [...this.listeners]) l();
	}

	destroy(): void {
		this.reset();
		this.detach();
		this.listeners.clear();
	}
}

// ---------------------------------------------------------------------------
// Checking values against a provider
// ---------------------------------------------------------------------------

/** Which uses each place accepts. */
export const VIDEO_EFFECT_PLACES = {
	/** A clip's effect stack: filters change the picture, overlays draw over it. */
	clip: ['filter', 'overlay'],
	transition: ['transition'],
	/** An effect clip's picture. */
	generator: ['generator', 'title', 'overlay']
} as const satisfies Record<string, readonly EffectUse[]>;

export type VideoEffectPlace = keyof typeof VIDEO_EFFECT_PLACES;

/** Refuses an effect that cannot go in `place`, with what to use instead. */
export function checkVideoEffectPlace(d: EffectDescription, place: VideoEffectPlace): void {
	const allowed: readonly EffectUse[] = VIDEO_EFFECT_PLACES[place];
	if (d.kind === 'motion' || !d.uses.some((u) => allowed.includes(u))) {
		const where = place === 'clip' ? 'on a clip' : place === 'transition' ? 'as a transition' : 'as an effect clip';
		const instead = d.uses.includes('transition') ? 'set_video_effect_transition' : d.uses.some((u) => (VIDEO_EFFECT_PLACES.generator as readonly string[]).includes(u)) ? 'add_video_effect_clip' : d.uses.some((u) => u === 'filter') ? 'apply_effect' : null;
		throw new EffectUnsupportedError(
			`"${d.id}" (${d.name}) is a ${d.uses.join(' / ')} effect and cannot be used ${where}, which takes ${allowed.join(' or ')} effects${instead ? `; use ${instead} instead` : ''}. search_effects with use "${allowed[0]}" lists ones that fit.`,
			d.id
		);
	}
}

/**
 * Checks values (plain, or keyframes for numeric controls when `keyframes`) against an effect's
 * controls and returns them over `base` (default the effect's defaults). Throws
 * `EffectControlError` naming every bad control.
 */
export function checkVideoEffectValues(d: EffectDescription, values: VideoEffectValues | undefined, options: { base?: VideoEffectValues; keyframes?: boolean } = {}): VideoEffectValues {
	const plain: Record<string, EffectValue> = {};
	const errors: SchemaValidationError[] = [];
	for (const [k, v] of Object.entries(values ?? {})) {
		if (!isVideoKeyframes(v)) {
			plain[k] = v;
			continue;
		}
		const schema = d.controls.properties[k];
		const type = schema?.type;
		if (!options.keyframes) errors.push({ path: `/${k}`, message: 'cannot be keyframed here; give a plain value.' });
		else if (!schema) errors.push({ path: `/${k}`, message: `is not a control of "${d.id}"; its controls are ${Object.keys(d.controls.properties).join(', ') || 'none'}.` });
		else if (type !== 'number' && type !== 'integer') errors.push({ path: `/${k}`, message: 'only number controls can be keyframed.' });
		else for (const [i, key] of v.keys.entries()) for (const e of validateJsonSchema(key.v, schema)) errors.push({ path: `/${k}/keys/${i}/v`, message: e.message });
	}
	for (const e of effectValueErrors(d, plain)) {
		const name = e.path.split('/')[1];
		const about = name && d.controls.properties[name]?.description;
		errors.push(about ? { path: e.path, message: `${e.message} (${about})` } : e);
	}
	if (errors.length) throw new EffectControlError(d.id, errors);
	return { ...(options.base ?? d.defaults), ...(values ?? {}) };
}
