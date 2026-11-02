/**
 * Shot layers and transitions (see `MotionShotLayer`, `MotionShotTransition`): when each layer
 * shows, how it is drawn into a frame's SVG, and `MotionLayersEngine`, which renders provider
 * effect layers and transitions to pictures.
 *
 * Frames stay SVG and stay a pure function of time: a layer's pixels go into the frame as an
 * `<image>` (`background` layers under the artwork, `subject` and `overlay` layers over it), taken
 * from the engine's cache. A picture that is not rendered yet is left out and the engine renders it
 * in the background, then tells the editor to draw again; `idle()` waits for every picture asked
 * for, so `AnimationEditorController.toSvgExact` draws exact frames.
 *
 * A transition replaces the frame for its length with the provider's blend of the last frame of the
 * shot before (`from`) and the live frame of its own shot (`to`). Both are drawn as SVG and turned
 * into pixels by the host (`MotionLayerHost.rasterize`). Until it is rendered (or with no provider
 * or host) the two frames crossfade.
 */

import { EffectRendererPool } from '../effects/pool.js';
import { EffectsSlot, resolveEffectValues } from '../effects/helpers.js';
import { effectLayerInput, effectLayerRole } from '../effects/templates.js';
import type { EffectDescription, EffectLayerRole, EffectPixels, EffectProvider, EffectValue } from '../effects/types.js';
import { compileMotionScene } from './compile.js';
import type { MotionLayerSubject, MotionRect, MotionScene, MotionShotLayer } from './types.js';

/** When a layer shows. */
export interface MotionLayerSpan {
	layer: MotionShotLayer;
	shot: string;
	shotIndex: number;
	/** Its place in its shot's `layers`. */
	index: number;
	role: EffectLayerRole;
	start: number;
	end: number;
}

/** A layer showing at a moment. */
export interface MotionActiveLayer extends MotionLayerSpan {
	/** Ms since the layer started: the time its effect is drawn at. */
	time: number;
	/** Its opacity now, with its fade. */
	opacity: number;
}

/** A transition at a moment. */
export interface MotionActiveTransition {
	/** The shot it plays into. */
	shot: string;
	shotIndex: number;
	effect: string;
	start: number;
	end: number;
	/** 0 → 1 through it. */
	progress: number;
}

const spanCache = new WeakMap<MotionScene, MotionLayerSpan[]>();

/** Every layer of the scene with when it shows, in drawing order (shot by shot, bottom to top). Pure and cached per scene. */
export function motionLayerSpans(scene: MotionScene): MotionLayerSpan[] {
	const hit = spanCache.get(scene);
	if (hit) return hit;
	const timeline = compileMotionScene(scene);
	const shots = timeline.shots;
	const total = timeline.duration;
	const at = (shotIndex: number, t: MotionShotLayer['from'], fallback: number): number => {
		if (t === undefined) return fallback;
		if (typeof t === 'number') return shots[shotIndex].start + t;
		return shots[shotIndex + t.shots]?.start ?? total;
	};
	const out: MotionLayerSpan[] = [];
	scene.shots.forEach((shot, shotIndex) => {
		(shot.layers ?? []).forEach((layer, index) => {
			const start = at(shotIndex, layer.from, shots[shotIndex].start);
			const end = Math.max(start, at(shotIndex, layer.until ?? { shots: 1 }, total));
			out.push({ layer, shot: shot.id, shotIndex, index, role: effectLayerRole(layer), start, end });
		});
	});
	spanCache.set(scene, out);
	return out;
}

/** The layers showing at `time`, in drawing order, with their effect time and faded opacity. */
export function motionLayersAt(scene: MotionScene, time: number): MotionActiveLayer[] {
	if (!scene.shots.some((s) => s.layers?.length)) return [];
	const total = compileMotionScene(scene).duration;
	const out: MotionActiveLayer[] = [];
	for (const span of motionLayerSpans(scene)) {
		// A layer that runs to the end of the scene still shows on its last frame.
		if (time < span.start || time > span.end || (time === span.end && span.end < total)) continue;
		const fade = span.layer.fade ?? 0;
		const k = fade > 0 ? Math.min(1, (time - span.start) / fade, (span.end - time) / fade) : 1;
		const opacity = Math.max(0, Math.min(1, (span.layer.opacity ?? 1) * k));
		if (opacity <= 0) continue;
		out.push({ ...span, time: time - span.start, opacity });
	}
	return out;
}

/** The transition playing at `time`, if any. */
export function motionTransitionAt(scene: MotionScene, time: number): MotionActiveTransition | null {
	if (!scene.shots.some((s) => s.transition)) return null;
	for (const s of compileMotionScene(scene).shots) {
		if (s.transition && s.transitionEnd !== undefined && time >= s.start && time < s.transitionEnd)
			return { shot: s.id, shotIndex: s.index, effect: s.transition, start: s.start, end: s.transitionEnd, progress: (time - s.start) / (s.transitionEnd - s.start) };
	}
	return null;
}

/** True when the scene has shot layers or transitions, so frames need `MotionLayerPictures`. */
export const motionSceneHasLayers = (scene: MotionScene): boolean => scene.shots.some((s) => s.layers?.length || s.transition);

// ---------------------------------------------------------------------------
// Drawing into SVG
// ---------------------------------------------------------------------------

/** Where frames get layer pictures from (`MotionLayersEngine`). Each returns an image URL, or undefined while it is not ready. */
export interface MotionLayerPictures {
	/** The picture of an effect layer at its time (the size of its box). */
	layer(scene: MotionScene, active: MotionActiveLayer, box: MotionRect): string | undefined;
	/** A subject picture as a URL usable inside an SVG image (a `data:` URL). */
	subject(subject: Extract<MotionLayerSubject, { image: string }>): string | undefined;
	/** The whole frame during a transition. */
	transition(scene: MotionScene, time: number, active: MotionActiveTransition): string | undefined;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (v: number) => String(Math.round(v * 1000) / 1000);
const box = (b: MotionRect) => `x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}"`;

/** An SVG string as a `data:` URL. */
export const svgDataUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** A bare subject drawn into `b`: a picture, SVG or words. */
function subjectSvg(subject: MotionLayerSubject, b: MotionRect, opacity: number, pictures: MotionLayerPictures | undefined): string {
	const o = opacity < 1 ? ` opacity="${n(opacity)}"` : '';
	if ('image' in subject) {
		const href = pictures?.subject(subject) ?? subject.image;
		return `<image href="${esc(href)}" ${box(b)} preserveAspectRatio="xMidYMid meet"${o}/>`;
	}
	if ('svg' in subject) {
		const href = subject.svg.trimStart().startsWith('<') ? svgDataUrl(subject.svg) : subject.svg;
		return `<image href="${esc(href)}" ${box(b)} preserveAspectRatio="xMidYMid meet"${o}/>`;
	}
	if ('text' in subject) {
		const size = Math.max(1, Math.min(b.height * 0.6, (b.width / Math.max(1, subject.text.length)) * 1.6));
		return `<text x="${n(b.x + b.width / 2)}" y="${n(b.y + b.height / 2)}" text-anchor="middle" dominant-baseline="central" font-family="${esc(subject.font ?? 'system-ui, sans-serif')}" font-weight="${esc(String(subject.weight ?? 700))}" font-size="${n(size)}" fill="#ffffff"${o}>${esc(subject.text)}</text>`;
	}
	return '';
}

/** One layer's SVG: its effect's picture, or its bare subject. Nothing while the picture renders (or for an empty slot). */
function layerSvg(scene: MotionScene, active: MotionActiveLayer, camera: MotionRect, pictures: MotionLayerPictures | undefined): string {
	const b = active.layer.rect ?? camera;
	if (!active.layer.effect) return active.layer.subject ? subjectSvg(active.layer.subject, b, active.opacity, pictures) : '';
	const href = pictures?.layer(scene, active, b);
	if (!href) return '';
	return `<image href="${esc(href)}" ${box(b)} preserveAspectRatio="none" data-layer="${esc(active.layer.id)}"${active.opacity < 1 ? ` opacity="${n(active.opacity)}"` : ''}/>`;
}

/**
 * Adds a frame's layers to its SVG (made with the artwork's background left out): the background
 * colour, then `background` layers, the artwork, then `subject` and `overlay` layers. Layers with
 * no `rect` fill the camera's view.
 */
export function withMotionShotLayers(svg: string, scene: MotionScene, time: number, camera: MotionRect, pictures: MotionLayerPictures | undefined, background: boolean): string {
	const active = motionLayersAt(scene, time);
	const open = svg.indexOf('>') + 1;
	let body = svg.slice(open, svg.lastIndexOf('</svg>'));
	const defs = /^\s*<defs>[\s\S]*?<\/defs>/.exec(body)?.[0] ?? '';
	body = body.slice(defs.length);
	const bg = background && scene.artwork.background ? `<rect width="${n(scene.artwork.width)}" height="${n(scene.artwork.height)}" fill="${esc(scene.artwork.background)}"/>` : '';
	const draw = (roles: readonly EffectLayerRole[]) =>
		active
			.filter((a) => roles.includes(a.role))
			.map((a) => layerSvg(scene, a, camera, pictures))
			.join('');
	return `${svg.slice(0, open)}${defs}${bg}${draw(['background'])}${body}${draw(['subject'])}${draw(['overlay'])}</svg>`;
}

/**
 * A frame during a transition: the provider's picture filling the view, or until it is ready a
 * crossfade of the last frame of the shot before (`from`, a whole frame SVG, nested with its own
 * framing) and this frame.
 */
export function motionTransitionSvg(svg: string, from: string, active: MotionActiveTransition, camera: MotionRect, picture: string | undefined): string {
	const open = svg.indexOf('>') + 1;
	if (picture) return `${svg.slice(0, open)}<image href="${esc(picture)}" ${box(camera)} preserveAspectRatio="none" data-transition="${esc(active.effect)}"/></svg>`;
	const inner = svg.slice(open, svg.lastIndexOf('</svg>'));
	const fromView = /viewBox="([^"]*)"/.exec(from)?.[1] ?? '';
	const fromInner = from.slice(from.indexOf('>') + 1, from.lastIndexOf('</svg>'));
	return `${svg.slice(0, open)}<svg ${box(camera)} viewBox="${fromView}" preserveAspectRatio="none" data-transition-from="">${fromInner}</svg><g opacity="${n(active.progress)}" data-transition-to="">${inner}</g></svg>`;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * What the engine needs from its host to make pictures: a browser host is
 * `browserMotionLayerHost()`. Outside a browser, give one that rasterizes SVG (e.g. resvg).
 */
export interface MotionLayerHost {
	/** Draws a standalone SVG into pixels of this size (straight alpha). */
	rasterize(svg: string, width: number, height: number): Promise<EffectPixels>;
	/** Pixels as an image URL for an SVG `<image>` (a `data:` URL). */
	encode(pixels: EffectPixels): Promise<string> | string;
	/** A picture URL as a `data:` URL, so it draws inside a rasterized SVG (where outside URLs do not load). */
	loadImage(url: string): Promise<string>;
}

export interface MotionLayersEngineOptions {
	slot?: EffectsSlot;
	host?: MotionLayerHost | null;
	/** Pixels per artwork unit of layer pictures (default 1); the longest side is at most `maxSize`. */
	scale?: number;
	/** Longest side of a layer or transition picture (default 1280). */
	maxSize?: number;
	/** Effect time is rounded to this many frames a second, so frames share pictures (default 30). */
	fps?: number;
	/** Pictures kept (default 160). */
	maxEntries?: number;
	maxRenderers?: number;
	/** Draws a frame of a scene as SVG (the controller gives `motionFrameToSvg` with its options). */
	frameSvg?: (scene: MotionScene, time: number) => string;
}

/** What a frame would draw (or wait for): failures say why a layer stays empty. */
export interface MotionLayerFailure {
	key: string;
	layer?: string;
	transition?: string;
	error: Error;
}

const sceneIds = new WeakMap<MotionScene, number>();
let nextSceneId = 1;
const sceneId = (scene: MotionScene) => {
	let id = sceneIds.get(scene);
	if (!id) sceneIds.set(scene, (id = nextSceneId++));
	return id;
};

/**
 * Renders and caches shot layer and transition pictures for one editor. Follows the editor's
 * provider slot: a new provider clears the cache. Without a provider (or a host) it makes no
 * pictures, and frames draw bare subjects and crossfades only.
 */
export class MotionLayersEngine implements MotionLayerPictures {
	readonly slot: EffectsSlot;
	host: MotionLayerHost | null;
	frameSvg: ((scene: MotionScene, time: number) => string) | undefined;
	private readonly cache = new Map<string, string>();
	private readonly pending = new Map<string, Promise<void>>();
	private readonly failures = new Map<string, MotionLayerFailure>();
	private readonly descriptions = new Map<string, Promise<EffectDescription>>();
	private readonly listeners = new Set<() => void>();
	private readonly pool: EffectRendererPool;
	private readonly options: Required<Pick<MotionLayersEngineOptions, 'scale' | 'maxSize' | 'fps' | 'maxEntries'>>;
	private generation = 0;
	private readonly detach: () => void;

	constructor(options: MotionLayersEngineOptions = {}) {
		this.slot = options.slot ?? new EffectsSlot();
		this.host = options.host ?? null;
		this.frameSvg = options.frameSvg;
		this.options = { scale: options.scale ?? 1, maxSize: options.maxSize ?? 1280, fps: options.fps ?? 30, maxEntries: options.maxEntries ?? 160 };
		this.pool = new EffectRendererPool({ maxRenderers: options.maxRenderers });
		this.detach = this.slot.subscribe(() => {
			this.reset();
			this.notify();
		});
	}

	get provider(): EffectProvider | null {
		return this.slot.provider;
	}

	/** Called when a picture is ready (draw the frame again). */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Why pictures failed, newest last. */
	failuresList(): MotionLayerFailure[] {
		return [...this.failures.values()];
	}

	/** True while any picture is being made. */
	get busy(): boolean {
		return this.pending.size > 0;
	}

	/** Resolves once every picture asked for so far is made (or failed). */
	async idle(): Promise<void> {
		while (this.pending.size) await Promise.all([...this.pending.values()]);
	}

	/** Forgets every picture and failure (a new provider, or the host changed). */
	reset(): void {
		this.generation++;
		this.cache.clear();
		this.pending.clear();
		this.failures.clear();
		this.descriptions.clear();
		this.pool.clear();
	}

	dispose(): void {
		this.detach();
		this.reset();
		this.listeners.clear();
	}

	/** Goes up each time pictures come in or are cleared, so a view that caches frames knows to draw again. */
	revision = 0;

	private notify() {
		this.revision++;
		this.listeners.forEach((l) => l());
	}

	private size(b: MotionRect): { width: number; height: number } {
		const k = Math.min(this.options.scale, this.options.maxSize / Math.max(b.width, b.height));
		return { width: Math.max(1, Math.round(b.width * k)), height: Math.max(1, Math.round(b.height * k)) };
	}

	private snap(t: number): number {
		const step = 1000 / this.options.fps;
		return Math.round(Math.round(t / step) * step * 1000) / 1000;
	}

	private get(key: string): string | undefined {
		const v = this.cache.get(key);
		if (v === undefined) return undefined;
		this.cache.delete(key);
		this.cache.set(key, v);
		return v;
	}

	private request(key: string, info: Omit<MotionLayerFailure, 'key' | 'error'>, work: () => Promise<string>): void {
		if (this.cache.has(key) || this.pending.has(key) || this.failures.has(key)) return;
		const generation = this.generation;
		const run = work()
			.then((url) => {
				if (generation !== this.generation) return;
				this.cache.set(key, url);
				while (this.cache.size > this.options.maxEntries) this.cache.delete(this.cache.keys().next().value!);
			})
			.catch((error: unknown) => {
				if (generation !== this.generation) return;
				this.failures.set(key, { key, ...info, error: error instanceof Error ? error : new Error(String(error)) });
			})
			.finally(() => {
				if (generation !== this.generation) return;
				this.pending.delete(key);
				this.notify();
			});
		this.pending.set(key, run);
	}

	describe(id: string): Promise<EffectDescription> {
		const provider = this.slot.require();
		let d = this.descriptions.get(id);
		if (!d) {
			d = Promise.resolve(provider.describe(id));
			this.descriptions.set(id, d);
			d.catch(() => this.descriptions.delete(id));
		}
		return d;
	}

	subject(subject: { image: string }): string | undefined {
		if (subject.image.startsWith('data:')) return subject.image;
		const host = this.host;
		if (!host) return undefined;
		const key = `img:${subject.image}`;
		this.request(key, {}, () => host.loadImage(subject.image));
		return this.get(key);
	}

	/** The pixels a layer's subject feeds its effect, at `size`. */
	private async subjectPixels(subject: MotionLayerSubject, size: { width: number; height: number }): Promise<EffectPixels> {
		const host = this.host!;
		const b = { x: 0, y: 0, ...size };
		let s = subject;
		if ('image' in s && !s.image.startsWith('data:')) s = { image: await host.loadImage(s.image) };
		return host.rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">${subjectSvg(s, b, 1, undefined)}</svg>`, size.width, size.height);
	}

	layer(scene: MotionScene, active: MotionActiveLayer, b: MotionRect): string | undefined {
		const provider = this.slot.provider;
		const host = this.host;
		const layer = active.layer;
		if (!provider || !host || !layer.effect) return undefined;
		if (layer.subject && 'slot' in layer.subject) return undefined;
		const size = this.size(b);
		const time = this.snap(active.time);
		const key = `layer:${provider.id}:${layer.effect}:${JSON.stringify(layer.values ?? {})}:${JSON.stringify(layer.subject ?? null)}:${size.width}x${size.height}@${time}`;
		const effect = layer.effect;
		this.request(key, { layer: layer.id }, async () => {
			const d = await this.describe(effect);
			const values = resolveEffectValues(d, layer.values as Record<string, EffectValue> | undefined);
			const input = effectLayerInput(d);
			const inputs = layer.subject && input ? { [input]: await this.subjectPixels(layer.subject, size) } : undefined;
			const pixels = await this.pool.render(provider, effect, size, { time, values, ...(inputs ? { inputs } : {}) });
			return host.encode(pixels);
		});
		return this.get(key);
	}

	transition(scene: MotionScene, time: number, active: MotionActiveTransition): string | undefined {
		const provider = this.slot.provider;
		const host = this.host;
		const frameSvg = this.frameSvg;
		if (!provider || !host || !frameSvg) return undefined;
		const shot = scene.shots[active.shotIndex];
		const t = shot.transition!;
		const size = this.size({ x: 0, y: 0, width: scene.artwork.width, height: scene.artwork.height });
		// The frame is snapped so neighbouring moments share a picture; `from` is the last frame before the shot.
		const at = Math.min(active.end - 0.001, this.snap(time));
		const progress = (at - active.start) / (active.end - active.start);
		const key = `transition:${sceneId(scene)}:${provider.id}:${t.effect}:${JSON.stringify(t.values ?? {})}:${size.width}x${size.height}@${at}`;
		const fromKey = `from:${sceneId(scene)}:${active.shot}:${size.width}x${size.height}`;
		this.request(key, { transition: active.shot }, async () => {
			const d = await this.describe(t.effect);
			const values = resolveEffectValues(d, t.values as Record<string, EffectValue> | undefined);
			// The pictures inside frames are made first, so the rasterized frames include them.
			frameSvg(scene, Math.max(0, active.start - 0.001));
			frameSvg(scene, at);
			await this.idleExcept(key);
			const fromSvg = frameSvg(scene, Math.max(0, active.start - 0.001));
			const toSvg = frameSvg(scene, at);
			let from = this.fromPixels.get(fromKey);
			if (!from) {
				from = host.rasterize(fromSvg, size.width, size.height);
				this.fromPixels.set(fromKey, from);
				if (this.fromPixels.size > 8) this.fromPixels.delete(this.fromPixels.keys().next().value!);
			}
			const to = await host.rasterize(toSvg, size.width, size.height);
			const pixels = await this.pool.render(provider, t.effect, size, { time: at - active.start, progress, values, inputs: { from: await from, to } });
			return host.encode(pixels);
		});
		return this.get(key);
	}

	private readonly fromPixels = new Map<string, Promise<EffectPixels>>();

	private async idleExcept(key: string): Promise<void> {
		for (;;) {
			const others = [...this.pending].filter(([k]) => k !== key && !k.startsWith('transition:')).map(([, p]) => p);
			if (!others.length) return;
			await Promise.all(others);
		}
	}
}

// ---------------------------------------------------------------------------
// Browser host
// ---------------------------------------------------------------------------

/** A host that draws with the browser's canvas and image decoding, or null outside a browser. */
export function browserMotionLayerHost(doc: Document | undefined = (globalThis as { document?: Document }).document): MotionLayerHost | null {
	const view = doc?.defaultView as (Window & typeof globalThis) | null | undefined;
	if (!doc || !view?.Image || typeof doc.createElement !== 'function') return null;
	const canvas = (width: number, height: number) => {
		const c = doc.createElement('canvas');
		c.width = width;
		c.height = height;
		const ctx = c.getContext('2d');
		if (!ctx) throw new Error('This browser cannot draw layer pictures (no 2D canvas).');
		return { c, ctx };
	};
	const load = (src: string, cors: boolean) =>
		new Promise<HTMLImageElement>((resolve, reject) => {
			const image = new view.Image();
			if (cors) image.crossOrigin = 'anonymous';
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error(`The picture ${src.startsWith('data:') ? '(a data: URL)' : `"${src}"`} could not be loaded; check the URL and that its server allows cross-origin use.`));
			image.src = src;
		});
	return {
		async rasterize(svg, width, height) {
			const image = await load(svgDataUrl(svg), false);
			const { ctx } = canvas(width, height);
			ctx.drawImage(image, 0, 0, width, height);
			const data = ctx.getImageData(0, 0, width, height);
			return { width, height, data: data.data };
		},
		encode(pixels) {
			const { c, ctx } = canvas(pixels.width, pixels.height);
			const image = ctx.createImageData(pixels.width, pixels.height);
			image.data.set(pixels.data);
			ctx.putImageData(image, 0, 0);
			return c.toDataURL('image/png');
		},
		async loadImage(url) {
			if (url.startsWith('data:')) return url;
			const image = await load(url, true);
			const { c, ctx } = canvas(image.naturalWidth || 1, image.naturalHeight || 1);
			ctx.drawImage(image, 0, 0);
			return c.toDataURL('image/png');
		}
	};
}

/** Whether a scene's layer would draw nothing because its subject slot is empty. */
export const motionLayerSlot = (layer: MotionShotLayer): string | undefined => (layer.subject && 'slot' in layer.subject ? layer.subject.slot : undefined);
