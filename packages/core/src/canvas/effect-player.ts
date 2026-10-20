/**
 * Plays provider effects on a canvas element, for the framework bindings: a node's effect drawn
 * frame by frame (`runCanvasNodeEffect`), and a scene transition between two pictures
 * (`playCanvasSceneTransition`). Renders go through an `EffectRendererPool`, so a page full of
 * effects stays within the browser's WebGL context limit.
 */

import { EffectRendererPool } from '../effects/pool.js';
import type { EffectPixels, EffectProvider } from '../effects/types.js';
import type { CanvasSceneTransition } from './scenes.js';
import type { CanvasShapeEffect } from './shapeGeometry.js';
import { CAPTURE_OVERLAY_SELECTORS, rasterizeElement } from '../tools/dom-capture.js';

/** Where frames are drawn: a `<canvas>` (or anything with a 2D context of that shape). */
export interface CanvasEffectTarget {
	width: number;
	height: number;
	getContext(id: '2d'): { putImageData(image: ImageData, x: number, y: number): void } | null;
}

export interface CanvasEffectClock {
	now(): number;
	frame(callback: () => void): () => void;
}

const defaultClock: CanvasEffectClock = {
	now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
	frame: (cb) => {
		if (typeof requestAnimationFrame === 'undefined') {
			const t = setTimeout(cb, 16);
			return () => clearTimeout(t);
		}
		const id = requestAnimationFrame(cb);
		return () => cancelAnimationFrame(id);
	}
};

/** One pool for the canvas effects of a page. */
export const canvasEffectsPool = new EffectRendererPool({ maxRenderers: 6 });

function draw(target: CanvasEffectTarget, p: EffectPixels) {
	const ctx = target.getContext('2d');
	if (!ctx || typeof ImageData === 'undefined') return;
	ctx.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
}

/**
 * Draws a node's effect into `target` (sized to the node in device pixels): one frame for a still
 * effect or when `playing` is false, else a frame per animation frame (one render in flight at a
 * time) until `stop`. `onError` hears a failed render, after which drawing stops.
 */
export function runCanvasNodeEffect(options: { provider: EffectProvider; effect: CanvasShapeEffect; target: CanvasEffectTarget; animate?: boolean; clock?: CanvasEffectClock; pool?: EffectRendererPool; onError?: (error: unknown) => void }): { stop(): void } {
	const { provider, effect, target } = options;
	const clock = options.clock ?? defaultClock;
	const pool = options.pool ?? canvasEffectsPool;
	const size = { width: Math.max(1, Math.round(target.width)), height: Math.max(1, Math.round(target.height)) };
	const start = clock.now();
	let stopped = false;
	let cancel = () => {};
	const tick = () => {
		if (stopped) return;
		const time = options.animate === false || effect.playing === false ? 0 : clock.now() - start;
		pool.render(provider, effect.effect, size, { time, values: effect.values }).then(
			(p) => {
				if (stopped) return;
				draw(target, p);
				if (options.animate !== false && effect.playing !== false) cancel = clock.frame(tick);
			},
			(e: unknown) => {
				if (!stopped) options.onError?.(e);
			}
		);
	};
	tick();
	return {
		stop() {
			stopped = true;
			cancel();
		}
	};
}

/** Plays a scene transition from `from` to `to` (same size as `target`), resolving when it ends. */
export async function playCanvasSceneTransition(options: { provider: EffectProvider; transition: CanvasSceneTransition; from: EffectPixels; to: EffectPixels; target: CanvasEffectTarget; clock?: CanvasEffectClock; pool?: EffectRendererPool }): Promise<void> {
	const { provider, transition, from, to, target } = options;
	const clock = options.clock ?? defaultClock;
	const pool = options.pool ?? canvasEffectsPool;
	const duration = transition.duration ?? 600;
	const size = { width: from.width, height: from.height };
	const start = clock.now();
	for (;;) {
		const time = Math.min(duration, clock.now() - start);
		const p = await pool.render(provider, transition.effect, size, { time, progress: time / duration, values: transition.values, inputs: { from, to } });
		draw(target, p);
		if (time >= duration) return;
		await new Promise<void>((resolve) => clock.frame(resolve));
	}
}

/**
 * The pixels of a DOM element as it looks now (the canvas view, for a scene transition), at
 * `width × height` device pixels. Browser only; overlays marked `data-capture="overlay"` are left out.
 */
export async function captureCanvasView(element: HTMLElement, size: { width: number; height: number }): Promise<EffectPixels> {
	const url = await rasterizeElement(element, { pixelWidth: size.width, pixelHeight: size.height, exclude: CAPTURE_OVERLAY_SELECTORS });
	const doc = element.ownerDocument;
	const image = new (doc.defaultView as Window & typeof globalThis).Image();
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () => reject(new Error('The canvas view could not be captured.'));
		image.src = url;
	});
	const canvas = doc.createElement('canvas');
	canvas.width = size.width;
	canvas.height = size.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('The canvas view could not be captured (no 2D canvas).');
	ctx.drawImage(image, 0, 0, size.width, size.height);
	const data = ctx.getImageData(0, 0, size.width, size.height).data;
	return { width: size.width, height: size.height, data };
}

/**
 * Moves a canvas view to a scene through its transition: captures the view, `jump`s there (no
 * animated move), waits for the view to draw, captures it again and plays the transition on an
 * overlay canvas laid over `element` (removed afterwards). Falls back to just jumping when
 * anything is missing or fails.
 */
export async function transitionCanvasView(options: { provider: EffectProvider; transition: CanvasSceneTransition; element: HTMLElement; jump: () => void; scale?: number; clock?: CanvasEffectClock }): Promise<void> {
	const { element } = options;
	const clock = options.clock ?? defaultClock;
	const scale = options.scale ?? Math.min(1, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
	const size = { width: Math.max(1, Math.round(element.clientWidth * scale)), height: Math.max(1, Math.round(element.clientHeight * scale)) };
	let from: EffectPixels;
	try {
		from = await captureCanvasView(element, size);
	} catch {
		options.jump();
		return;
	}
	const overlay = element.ownerDocument.createElement('canvas');
	overlay.width = size.width;
	overlay.height = size.height;
	overlay.setAttribute('data-capture', 'overlay');
	overlay.setAttribute('data-canvas-transition', options.transition.effect);
	Object.assign(overlay.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '1000' });
	overlay.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(from.data), size.width, size.height), 0, 0);
	if (getComputedStyle(element).position === 'static') element.style.position = 'relative';
	element.appendChild(overlay);
	try {
		options.jump();
		await new Promise<void>((r) => clock.frame(() => clock.frame(r)));
		const to = await captureCanvasView(element, size);
		await playCanvasSceneTransition({ provider: options.provider, transition: options.transition, from, to, target: overlay, clock });
	} catch {
		// The jump has happened; the transition is only decoration.
	} finally {
		overlay.remove();
	}
}
