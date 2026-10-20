import { videoFrameAt, videoLayersWithoutTransitionEffects, type VideoFrame, type VideoLayer, type VideoRect } from './evaluate.js';
import { videoGradeCssFilter, videoGradeSvgDefs, videoGradeSvgFilter } from './grade.js';
import { applyVideoLutToPixels, type VideoLut } from './lut.js';
import { formatVideoTimecode } from './timeline.js';
import type { VideoProject } from './types.js';
import { videoEffectFrameTime, videoEffectLayerKey, type VideoEffectJob, type VideoEffectsEngine } from './effects.js';
import type { EffectPixels } from '../effects/types.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => String(Math.round(v * 100) / 100);
const n4 = (v: number) => String(Math.round(v * 10000) / 10000);

/** Radius of an iris `progress` (0–1) open: from nothing to the frame's corners. */
export const videoIrisRadius = (frame: { width: number; height: number }, progress: number): number => progress * Math.hypot(frame.width / 2, frame.height / 2);

/** The part of a rect a wipe shows. */
export function videoWipeRect(rect: VideoRect, wipe: NonNullable<VideoLayer['wipe']>): VideoRect {
	const { direction, progress } = wipe;
	const w = rect.width * progress;
	const h = rect.height * progress;
	if (direction === 'right') return { ...rect, width: w };
	if (direction === 'left') return { ...rect, x: rect.x + rect.width - w, width: w };
	if (direction === 'down') return { ...rect, height: h };
	return { ...rect, y: rect.y + rect.height - h, height: h };
}

export interface VideoSvgOptions {
	/**
	 * The picture for a media layer: return an href (URL or data URL) to draw, or `null` for a
	 * labelled placeholder. Default: images use `src`, videos their `poster`, else a placeholder.
	 */
	imageFor?: (layer: VideoLayer, frame: VideoFrame) => string | null;
	/** Frame rate for the timecode on placeholders (default 30). */
	fps?: number;
	/** The loaded table of a grade's LUT `src`; drawn as an approximation (curves and a matrix). Without it LUTs are left out. */
	lutFor?: (src: string) => VideoLut | null | undefined;
}

/**
 * A frame as standalone SVG: images and posters as `<image>`, video without one as a labelled box.
 * Provider effects cannot be drawn in SVG: clips show without their effects, effect clips as a
 * labelled box and effect transitions as crossfades.
 * A compound clip is a `<g>` (isolated, so blends inside it mix only with its own layers) holding
 * its sequence's layers scaled into its rect, with its opacity, blend, grade filter and clips on it.
 */
export function videoFrameToSvg(frame: VideoFrame, options: VideoSvgOptions = {}, assets: VideoProject['assets'] = []): string {
	const defs: string[] = [];
	const posters = new Map(assets.map((a) => [a.id, a.poster]));
	const draw = (layers: readonly VideoLayer[], prefix: string): string =>
		videoLayersWithoutTransitionEffects(layers)
			.map((layer, index) => {
				const i = `${prefix}${index}`;
				const { rect } = layer;
				const attrs: string[] = [];
				const style: string[] = [];
				if (layer.opacity < 1) attrs.push(`opacity="${n(layer.opacity)}"`);
				if (layer.blend) style.push(`mix-blend-mode:${layer.blend === 'add' ? 'plus-lighter' : layer.blend}`);
				if (layer.layers) style.push('isolation:isolate');
				if (style.length) attrs.push(`style="${style.join(';')}"`);
				if (layer.grade) {
					defs.push(videoGradeSvgFilter(`g${i}`, layer.grade, layer.grade.lut ? options.lutFor?.(layer.grade.lut.src) : null));
					attrs.push(`filter="url(#g${i})"`);
				}
				if (layer.rotation) attrs.push(`transform="rotate(${n(layer.rotation)} ${n(rect.x + rect.width / 2)} ${n(rect.y + rect.height / 2)})"`);
				if (layer.wipe) {
					const r = videoWipeRect(rect, layer.wipe);
					defs.push(`<clipPath id="w${i}"><rect x="${n(r.x)}" y="${n(r.y)}" width="${n(r.width)}" height="${n(r.height)}"/></clipPath>`);
					attrs.push(`clip-path="url(#w${i})"`);
				}
				const box = `x="${n(rect.x)}" y="${n(rect.y)}" width="${n(rect.width)}" height="${n(rect.height)}"`;
				let inner = '';
				if (layer.layers) {
					// The sequence's frame is the project's size: scale it into the compound's rect.
					inner = `<g transform="translate(${n(rect.x)} ${n(rect.y)}) scale(${n4(rect.width / frame.width)} ${n4(rect.height / frame.height)})">${draw(layer.layers, `${i}-`)}</g>`;
				} else if (layer.type === 'color') inner = `<rect ${box} fill="${esc(layer.color ?? '#000000')}"/>`;
				else if (layer.type === 'text' && layer.text) {
					const t = layer.text;
					const lines = t.text.split('\n');
					const lh = t.fontSize * 1.2;
					const cx = rect.x + rect.width / 2;
					const cy = rect.y + rect.height / 2;
					const top = cy - (lh * (lines.length - 1)) / 2;
					if (t.background) {
						const w = Math.max(...lines.map((l) => l.length)) * t.fontSize * 0.6 + t.fontSize;
						const h = lh * lines.length + t.fontSize * 0.4;
						inner += `<rect x="${n(cx - w / 2)}" y="${n(cy - h / 2)}" width="${n(w)}" height="${n(h)}" fill="${esc(t.background)}"/>`;
					}
					inner += `<text x="${n(cx)}" text-anchor="middle" dominant-baseline="central" font-family="${esc(t.fontFamily)}" font-size="${n(t.fontSize)}" font-weight="${t.fontWeight}" fill="${esc(t.color)}">${lines.map((l, k) => `<tspan x="${n(cx)}" y="${n(top + k * lh)}">${esc(l)}</tspan>`).join('')}</text>`;
				} else {
					const href = options.imageFor ? options.imageFor(layer, frame) : layer.assetKind === 'image' ? (layer.src ?? null) : (posters.get(layer.asset ?? '') ?? null);
					if (href) inner = `<image href="${esc(href)}" ${box} preserveAspectRatio="none"/>`;
					else {
						const label = layer.generator ? `Effect: ${layer.generator.name ?? layer.generator.effect}` : `${layer.asset ?? layer.clip} · ${formatVideoTimecode(layer.sourceTime ?? 0, options.fps ?? 30)}`;
						const size = Math.max(10, Math.min(rect.height / 8, rect.width / Math.max(8, label.length * 0.6)));
						inner = `<rect ${box} fill="#334155" stroke="#94a3b8" stroke-width="2"/><text x="${n(rect.x + rect.width / 2)}" y="${n(rect.y + rect.height / 2)}" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="${n(size)}" fill="#e2e8f0">${esc(label)}</text>`;
					}
				}
				let item = attrs.length ? `<g ${attrs.join(' ')}>${inner}</g>` : inner;
				if (layer.iris) {
					// Outside the layer's own transform, so the circle stays on the frame's centre.
					defs.push(`<clipPath id="i${i}"><circle cx="${n(frame.width / 2)}" cy="${n(frame.height / 2)}" r="${n(videoIrisRadius(frame, layer.iris.progress))}"/></clipPath>`);
					item = `<g clip-path="url(#i${i})">${item}</g>`;
				}
				return item;
			})
			.join('');
	const body = draw(frame.layers, '');
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(frame.width)} ${n(frame.height)}" width="${n(frame.width)}" height="${n(frame.height)}">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}<rect width="100%" height="100%" fill="${esc(frame.background)}"/>${body}</svg>`;
}

/** The project at `time` as SVG. */
export function videoProjectSvg(project: VideoProject, time: number, options: VideoSvgOptions = {}): string {
	return videoFrameToSvg(videoFrameAt(project, time), { fps: project.fps, ...options }, project.assets);
}

/** Several moments in one labelled picture, `columns` a row, each frame scaled to `width` pixels. */
export function videoContactSheetSvg(project: VideoProject, times: readonly number[], options: VideoSvgOptions & { columns?: number; width?: number } = {}): string {
	const columns = options.columns ?? Math.ceil(Math.sqrt(times.length));
	const w = options.width ?? 320;
	const h = (w * project.height) / project.width;
	const label = 18;
	const gap = 8;
	const rows = Math.ceil(times.length / columns);
	const W = columns * w + (columns + 1) * gap;
	const H = rows * (h + label) + (rows + 1) * gap;
	const cells = times.map((t, i) => {
		const x = gap + (i % columns) * (w + gap);
		const y = gap + Math.floor(i / columns) * (h + label + gap);
		const svg = videoProjectSvg(project, t, options).replace(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/, `<svg x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"`).replace(/ width="[\d.]+" height="[\d.]+">/, '>');
		return `${svg}<text x="${n(x)}" y="${n(y + h + 14)}" font-family="sans-serif" font-size="12" fill="#0f172a">${(t / 1000).toFixed(2)} s · ${formatVideoTimecode(t, project.fps)}</text>`;
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(W)} ${n(H)}" width="${n(W)}" height="${n(H)}"><rect width="100%" height="100%" fill="#f8fafc"/>${cells.join('')}</svg>`;
}

/** The subset of `CanvasRenderingContext2D` `drawVideoFrame` uses (so tests and workers can pass their own). */
export type VideoCanvasContext = Pick<
	CanvasRenderingContext2D,
	'save' | 'restore' | 'fillRect' | 'drawImage' | 'translate' | 'rotate' | 'beginPath' | 'rect' | 'arc' | 'clip' | 'fillText' | 'measureText' | 'setTransform'
> & { globalAlpha: number; globalCompositeOperation: GlobalCompositeOperation; filter?: string; fillStyle: string | CanvasGradient | CanvasPattern; font: string; textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline; strokeStyle: string | CanvasGradient | CanvasPattern; lineWidth: number; strokeRect(x: number, y: number, w: number, h: number): void };

/**
 * An offscreen canvas `drawVideoFrame` draws on: a compound clip's layers before laying them on the
 * frame as one picture, or a LUT-graded layer before running its pixels through the LUT.
 */
export interface VideoScratchCanvas {
	canvas: CanvasImageSource;
	ctx: VideoCanvasContext & Pick<CanvasRenderingContext2D, 'getImageData' | 'putImageData' | 'clearRect'>;
}

export interface VideoDrawOptions {
	/** Puts an SVG filter (white balance) in the page, so the canvas's `filter: url(#id)` finds it. */
	defineSvgFilter?: (id: string, markup: string) => void;
	/** The loaded table of a grade's LUT `src`, or nothing while it loads (the layer is drawn without it). */
	lutFor?: (src: string) => VideoLut | null | undefined;
	/**
	 * An offscreen canvas of the given canvas-pixel size, for compound clips and LUT layers; `slot`
	 * numbers the ones in use at once (a compound inside a compound needs its own), so return the
	 * same canvas for the same slot and a different one for each slot. Without it LUTs are left out
	 * and a compound's layers are drawn straight onto the frame, without its opacity, blend and grade.
	 */
	scratch?: (width: number, height: number, slot: number) => VideoScratchCanvas | null;
	/**
	 * Provider effects (clip effects, effect clips, effect transitions) come from this engine's
	 * cache. A picture not rendered yet is requested and the layer drawn without its effects
	 * meanwhile (`onEffectWaiting` is called); without an engine or a provider, clips draw without
	 * their effects, effect clips as placeholders and effect transitions as crossfades. Needs
	 * `scratch` to read the pictures effects start from.
	 */
	effects?: VideoEffectsEngine | null;
	/** Called when the frame waits for an effect picture still rendering. */
	onEffectWaiting?: () => void;
}

/** What a draw found missing, so effect inputs are only sent when they are whole. */
interface DrawState {
	/** Media pictures that were not ready. */
	missing: number;
	/** Effect pictures still rendering. */
	waiting: number;
}

/** Draws one layer's picture (clip shapes, grade filter, rotation and content), without its opacity or blend. */
function paintVideoLayer(ctx: VideoCanvasContext, frame: VideoFrame, layer: VideoLayer, sourceFor: (layer: VideoLayer) => CanvasImageSource | null, options: VideoDrawOptions) {
	const { rect } = layer;
	if (layer.iris) {
		ctx.beginPath();
		ctx.arc(frame.width / 2, frame.height / 2, videoIrisRadius(frame, layer.iris.progress), 0, 2 * Math.PI);
		ctx.clip();
	}
	if (layer.grade) {
		const defs = videoGradeSvgDefs(layer.grade);
		if (options.defineSvgFilter) for (const d of defs) options.defineSvgFilter(d.id, d.markup);
		const css = videoGradeCssFilter(layer.grade);
		ctx.filter = options.defineSvgFilter ? css || 'none' : css.replace(/\s*url\([^)]*\)/g, '').trim() || 'none';
	}
	if (layer.rotation) {
		ctx.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
		ctx.rotate((layer.rotation * Math.PI) / 180);
		ctx.translate(-(rect.x + rect.width / 2), -(rect.y + rect.height / 2));
	}
	if (layer.wipe) {
		const r = videoWipeRect(rect, layer.wipe);
		ctx.beginPath();
		ctx.rect(r.x, r.y, r.width, r.height);
		ctx.clip();
	}
	if (layer.type === 'color') {
		ctx.fillStyle = layer.color ?? '#000000';
		ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
	} else if (layer.type === 'text' && layer.text) {
		const t = layer.text;
		const lines = t.text.split('\n');
		const lh = t.fontSize * 1.2;
		const cx = rect.x + rect.width / 2;
		const top = rect.y + rect.height / 2 - (lh * (lines.length - 1)) / 2;
		ctx.font = `${t.fontWeight} ${t.fontSize}px ${t.fontFamily}`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		if (t.background) {
			const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + t.fontSize;
			const h = lh * lines.length + t.fontSize * 0.4;
			ctx.fillStyle = t.background;
			ctx.fillRect(cx - w / 2, rect.y + rect.height / 2 - h / 2, w, h);
		}
		ctx.fillStyle = t.color;
		lines.forEach((l, k) => ctx.fillText(l, cx, top + k * lh));
	} else {
		const source = sourceFor(layer);
		if (source) ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
		else {
			ctx.fillStyle = '#334155';
			ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
			ctx.strokeStyle = '#94a3b8';
			ctx.lineWidth = 2;
			ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
			if (layer.generator) {
				const label = `Effect: ${layer.generator.name ?? layer.generator.effect}`;
				ctx.font = `600 ${Math.max(12, Math.min(rect.height / 10, rect.width / Math.max(8, label.length * 0.6)))}px sans-serif`;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillStyle = '#e2e8f0';
				ctx.fillText(label, rect.x + rect.width / 2, rect.y + rect.height / 2);
			}
		}
	}
}

/**
 * Draws a frame on a 2D canvas scaled by `scale` (canvas pixels per frame pixel). `sourceFor`
 * returns what to draw for a media layer (a `<video>` seeked to `layer.sourceTime`, an `<img>`,
 * an `ImageBitmap`…) or `null` for a placeholder box. Grades become the context's `filter`; white
 * balance there refers to an SVG filter, which `options.defineSvgFilter` is given to put in the page
 * (without it, white balance is left out of the canvas). A grade's LUT needs `options.lutFor` and
 * `options.scratch`: the layer is drawn on the scratch canvas, its pixels run through the LUT, and
 * the result is laid on the frame with the layer's opacity and blend. A compound clip's layers are
 * drawn on a scratch canvas of their own (transparent), which is then drawn like a picture.
 */
export function drawVideoFrame(ctx: VideoCanvasContext, frame: VideoFrame, sourceFor: (layer: VideoLayer) => CanvasImageSource | null, scale = 1, options: VideoDrawOptions = {}): void {
	ctx.save();
	ctx.setTransform(scale, 0, 0, scale, 0, 0);
	ctx.globalAlpha = 1;
	ctx.fillStyle = frame.background;
	ctx.fillRect(0, 0, frame.width, frame.height);
	const state: DrawState = { missing: 0, waiting: 0 };
	const counted = (layer: VideoLayer) => {
		const source = sourceFor(layer);
		if (!source && layer.type === 'media') state.missing++;
		return source;
	};
	drawVideoLayers(ctx, frame, frame.layers, counted, scale, options, 0, state);
	ctx.restore();
}

/** A layer without what is applied after its picture: placed at its rect with nothing else. */
const unplaced = (layer: VideoLayer): VideoLayer => {
	const { rotation: _r, wipe: _w, iris: _i, grade: _g, blend: _b, effects: _e, transitionEffect: _t, ...rest } = layer;
	return { ...rest, opacity: 1, rotation: 0 };
};

const readPixels = (s: VideoScratchCanvas, width: number, height: number): EffectPixels => {
	const img = s.ctx.getImageData(0, 0, width, height);
	return { width, height, data: img.data };
};

/** Clears a scratch canvas and readies it for drawing in frame pixels at `scale`, shifted by (dx, dy) canvas pixels. */
function begin(s: VideoScratchCanvas, width: number, height: number, scale: number, dx = 0, dy = 0) {
	const g = s.ctx;
	g.save();
	g.setTransform(1, 0, 0, 1, 0, 0);
	g.clearRect(0, 0, width, height);
	g.setTransform(scale, 0, 0, scale, dx, dy);
	g.globalAlpha = 1;
	g.globalCompositeOperation = 'source-over';
	return g;
}

/**
 * A layer's picture after its clip effects (or an effect clip's picture), the size it is placed at
 * on the canvas; `null` when there is none yet (the layer is then drawn without its effects).
 */
function effectPicture(frame: VideoFrame, layer: VideoLayer, source: (layer: VideoLayer) => CanvasImageSource | null, scale: number, options: VideoDrawOptions, depth: number, state: DrawState): CanvasImageSource | null {
	const engine = options.effects;
	if (!engine?.available) return null;
	const { rect } = layer;
	const w = Math.max(1, Math.round(rect.width * scale));
	const h = Math.max(1, Math.round(rect.height * scale));
	const key = videoEffectLayerKey(layer, w, h);
	const hit = engine.get(key);
	if (hit !== undefined || engine.failure(key)) return hit ?? null;
	let job: VideoEffectJob;
	if (layer.generator) job = { kind: 'generator', width: w, height: h, ...layer.generator, effects: layer.effects ?? [] };
	else {
		const s = options.scratch?.(w, h, 1000 + 4 * depth);
		if (!s) return null;
		const missing = state.missing;
		const g = begin(s, w, h, scale, -rect.x * scale, -rect.y * scale);
		const bare = unplaced(layer);
		paintVideoLayer(g, frame, bare, (l) => source(l === bare ? layer : l), options);
		g.restore();
		// Only whole pictures go to the provider: a frame still loading would be cached wrong.
		if (state.missing !== missing) return null;
		job = { kind: 'stack', input: readPixels(s, w, h), effects: layer.effects ?? [] };
	}
	if (engine.request(key, job)) {
		state.waiting++;
		options.onEffectWaiting?.();
	}
	return null;
}

/** Draws an effect transition's rendered picture over the frame; false when it is not there (yet). */
function drawEffectTransition(ctx: VideoCanvasContext, frame: VideoFrame, layer: VideoLayer, sourceFor: (layer: VideoLayer) => CanvasImageSource | null, scale: number, options: VideoDrawOptions, depth: number, state: DrawState): boolean {
	const engine = options.effects;
	const t = layer.transitionEffect!;
	if (!engine?.available) return false;
	const cw = Math.max(1, Math.round(frame.width * scale));
	const ch = Math.max(1, Math.round(frame.height * scale));
	const key = videoEffectLayerKey(layer, cw, ch);
	const hit = engine.get(key);
	if (hit) {
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = 'source-over';
		ctx.drawImage(hit, 0, 0, cw, ch);
		ctx.restore();
		return true;
	}
	if (hit === null || engine.failure(key) || engine.isPending(key)) {
		if (engine.isPending(key)) {
			state.waiting++;
			options.onEffectWaiting?.();
		}
		return false;
	}
	const a = options.scratch?.(cw, ch, 1000 + 4 * depth + 1);
	const b = options.scratch?.(cw, ch, 1000 + 4 * depth + 2);
	if (!a || !b) return false;
	const before = { ...state };
	const ga = begin(a, cw, ch, scale);
	drawVideoLayers(ga, frame, t.from ? [t.from] : [], sourceFor, scale, options, depth + 1, state);
	ga.restore();
	const { transitionEffect: _t, ...incoming } = layer;
	const gb = begin(b, cw, ch, scale);
	drawVideoLayers(gb, frame, [incoming], sourceFor, scale, options, depth + 1, state);
	gb.restore();
	if (state.missing !== before.missing || state.waiting !== before.waiting) return false;
	const job: VideoEffectJob = { kind: 'transition', effect: t.effect, values: t.values, progress: t.progress, time: t.time, from: readPixels(a, cw, ch), to: readPixels(b, cw, ch) };
	if (engine.request(key, job)) {
		state.waiting++;
		options.onEffectWaiting?.();
	}
	return false;
}

/** Draws layers back to front; `depth` is how many compounds they are inside (it picks the scratch slots). */
function drawVideoLayers(ctx: VideoCanvasContext, frame: VideoFrame, layers: readonly VideoLayer[], sourceFor: (layer: VideoLayer) => CanvasImageSource | null, scale: number, options: VideoDrawOptions, depth: number, state: DrawState): void {
	const cw = Math.max(1, Math.round(frame.width * scale));
	const ch = Math.max(1, Math.round(frame.height * scale));
	for (const original of layers) {
		let layer = original;
		if (layer.transitionEffect) {
			// Drawn by the provider, or as a crossfade until (or unless) it can be.
			if (!drawEffectTransition(ctx, frame, layer, sourceFor, scale, options, depth, state)) drawVideoLayers(ctx, frame, videoLayersWithoutTransitionEffects([layer]), sourceFor, scale, options, depth, state);
			continue;
		}
		let source = sourceFor;
		if (layer.layers) {
			const group = options.scratch?.(cw, ch, 2 * depth);
			if (!group) {
				drawVideoLayers(ctx, frame, layer.layers, sourceFor, scale, options, depth + 1, state);
				continue;
			}
			const g = group.ctx;
			g.save();
			g.setTransform(1, 0, 0, 1, 0, 0);
			g.clearRect(0, 0, cw, ch);
			g.setTransform(scale, 0, 0, scale, 0, 0);
			g.globalAlpha = 1;
			g.globalCompositeOperation = 'source-over';
			drawVideoLayers(g, frame, layer.layers, sourceFor, scale, options, depth + 1, state);
			g.restore();
			const self = layer;
			source = (l) => (l === self ? group.canvas : sourceFor(l));
		}
		if (layer.effects?.length || layer.generator) {
			const picture = effectPicture(frame, layer, source, scale, options, depth, state);
			if (picture) {
				// The processed picture is drawn like media, with the layer's placement, grade and blend.
				const { layers: _l, text: _t, color: _c, generator: _g, effects: _e, ...rest } = layer;
				const drawn: VideoLayer = { ...rest, type: 'media' };
				layer = drawn;
				source = (l) => (l === drawn ? picture : sourceFor(l));
			}
		}
		const setting = layer.grade?.lut;
		const lut = setting ? options.lutFor?.(setting.src) : null;
		const scratch = lut ? options.scratch?.(cw, ch, 2 * depth + 1) : null;
		ctx.save();
		ctx.setTransform(scale, 0, 0, scale, 0, 0);
		if (lut && scratch) {
			const s = scratch.ctx;
			s.save();
			s.setTransform(1, 0, 0, 1, 0, 0);
			s.clearRect(0, 0, cw, ch);
			s.setTransform(scale, 0, 0, scale, 0, 0);
			s.globalAlpha = 1;
			s.globalCompositeOperation = 'source-over';
			paintVideoLayer(s, frame, layer, source, options);
			s.restore();
			const img = s.getImageData(0, 0, cw, ch);
			applyVideoLutToPixels(lut, img.data, setting!.strength ?? 1);
			s.putImageData(img, 0, 0);
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.globalAlpha = layer.opacity;
			if (layer.blend && layer.blend !== 'normal') ctx.globalCompositeOperation = layer.blend === 'add' ? 'lighter' : layer.blend;
			ctx.drawImage(scratch.canvas, 0, 0, cw, ch);
		} else {
			ctx.globalAlpha = layer.opacity;
			if (layer.blend && layer.blend !== 'normal') ctx.globalCompositeOperation = layer.blend === 'add' ? 'lighter' : layer.blend;
			paintVideoLayer(ctx, frame, layer, source, options);
		}
		ctx.restore();
	}
}

export interface VideoExactFrameOptions extends VideoDrawOptions {
	/** Canvas pixels per frame pixel (default 1). */
	scale?: number;
	/** Most draws before giving up on effects still rendering (default 8; nested effects take one each). */
	maxPasses?: number;
}

export interface VideoExactFrame {
	/** The frame drawn (at the start of the frame `time` falls in). */
	frame: VideoFrame;
	/** False when a media picture was missing or an effect never arrived. */
	complete: boolean;
	/** Effect renders that failed for this frame (their layers were drawn without them). */
	failures: Error[];
}

/**
 * Draws the frame `time` falls in with every provider effect rendered: frame-exact, the same
 * drawing as the preview, for exports and agents. `sourceFor` must return ready pictures (decode
 * the media first: `videoFrameRequestsAt` lists what a frame needs). Draws, waits for the effect
 * pictures it asked for, and draws again until none is missing.
 */
export async function renderVideoFrameExact(
	ctx: VideoCanvasContext,
	project: VideoProject,
	time: number,
	sourceFor: (layer: VideoLayer) => CanvasImageSource | null,
	options: VideoExactFrameOptions = {}
): Promise<VideoExactFrame> {
	const frame = videoFrameAt(project, videoEffectFrameTime(time, project.fps));
	const engine = options.effects;
	const before = new Set(engine?.failuresList().map((f) => f.error) ?? []);
	let complete = false;
	for (let pass = 0; pass < (options.maxPasses ?? 8); pass++) {
		let waiting = 0;
		let missing = 0;
		drawVideoFrame(
			ctx,
			frame,
			(layer) => {
				if (layer.type === 'effect') return null;
				const s = sourceFor(layer);
				if (!s) missing++;
				return s;
			},
			options.scale ?? 1,
			{
				...options,
				onEffectWaiting: () => {
					waiting++;
					options.onEffectWaiting?.();
				}
			}
		);
		if (!waiting) {
			complete = missing === 0;
			break;
		}
		await engine!.idle();
	}
	const failures = (engine?.failuresList() ?? []).map((f) => f.error).filter((e) => !before.has(e));
	return { frame, complete: complete && !failures.length, failures };
}
