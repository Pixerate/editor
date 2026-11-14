/**
 * The page kit's runtime (#814): bundled by `scripts/build-page-kit.mjs` into one minified IIFE
 * (`PAGE_KIT`) that sets `window.pixerateKit` in a sandboxed, model-written page. Everything here
 * is re-exported from core, not re-implemented; the only page-specific code is the SVG helper,
 * the theme reader, resize redraws, canvas text measuring and the motion contract.
 *
 * Not imported by any entry: `@pixerate/editor/page-kit` exports the built bundle as a string.
 */
import { contrastRatio } from '../color/contrast.js';
import { formatHex } from '../color/format.js';
import { ink } from '../color/ink.js';
import { mixColors } from '../color/mix.js';
import { parseColor } from '../color/parse.js';
import { bezierPathLength, bezierPathPointAtLength, bezierPathToSvg, closeContour, contoursToPath, pathToContours, segmentLength, trimSegments } from '../canvas/pathops/bezier.js';
import { formatPlainChartNumber } from '../chart/number-text.js';
import { linearMap, niceScale, niceStep } from '../chart/scale.js';
import { elbow, fanElbows, roundedPolyline } from '../geom/connectors.js';
import { helix, splitByDepth } from '../geom/helix.js';
import { isoFaceColors, isoOrder, isoProjector } from '../geom/iso.js';
import { labelHull, placeLabels } from '../geom/labels.js';
import { estimatedMeasure, fitText, staggerRows, type MeasureText } from '../typography/fit.js';

/** The kit's own version, bumped when its exports or the page contract change. */
export const KIT_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The point and angle (radians) at a length along SVG path data, or null for an empty path. */
function pointAtLength(d: string, length: number): { x: number; y: number; angle: number } | null {
	const at = bezierPathPointAtLength(d, length);
	return at ? { x: at.point[0], y: at.point[1], angle: at.angle } : null;
}

/** The part of SVG path data between two lengths from its start, as path data. */
function trimPath(d: string, from: number, to: number): string {
	const out: { segments: [number, number][][]; closed: boolean }[] = [];
	let at = 0;
	for (const contour of pathToContours(d)) {
		const segs = closeContour(contour);
		const lens = segs.map((s) => segmentLength(s));
		const total = lens.reduce((a, b) => a + b, 0);
		if (at + total > from && at < to) {
			const pieces = trimSegments(segs, from - at, to - at, lens);
			if (pieces.length) out.push({ segments: pieces as [number, number][][], closed: false });
		}
		at += total;
	}
	return bezierPathToSvg(contoursToPath(out));
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** Contrast ratio (1–21) between two CSS colours, or null when either can't be read. */
function contrast(a: string, b: string): number | null {
	const x = parseColor(a);
	const y = parseColor(b);
	return x && y ? contrastRatio(x, y) : null;
}

/** `n` colours from `from` to `to`, mixed in OKLab, as hex. */
function ramp(from: string, to: string, n: number): string[] {
	const count = Math.max(1, Math.floor(n));
	const out: string[] = [];
	for (let i = 0; i < count; i++) out.push(mixColors(from, to, count === 1 ? 0 : i / (count - 1)) ?? from);
	return out;
}

/** A CSS colour as `#rrggbb` (or `#rrggbbaa`), or null. */
function hex(color: string): string | null {
	const c = parseColor(color);
	return c ? formatHex(c) : null;
}

// ---------------------------------------------------------------------------
// The page: SVG, theme, resize, text, motion
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number | boolean | null | undefined>;

/**
 * Creates an SVG element with attributes (null, undefined and false are left out; `text` sets the
 * text content) and appends it to `parent` when given.
 */
function svg(tag: string, attrs: Attrs = {}, parent?: Element | null): SVGElement {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === null || value === undefined || value === false) continue;
		if (key === 'text') el.textContent = String(value);
		else el.setAttribute(key, value === true ? '' : String(value));
	}
	if (parent) parent.appendChild(el);
	return el;
}

/** Removes every child of an element. */
function clear(el: Element): Element {
	while (el.firstChild) el.removeChild(el.firstChild);
	return el;
}

/**
 * Calls `draw(width, height)` now and whenever the element's size changes (once per animation
 * frame at most). Returns a function that stops it.
 */
function onResize(el: Element, draw: (width: number, height: number) => void): () => void {
	let frame = 0;
	const run = () => {
		frame = 0;
		const box = el.getBoundingClientRect();
		draw(box.width, box.height);
	};
	run();
	if (typeof ResizeObserver === 'undefined') {
		const listener = () => {
			if (!frame) frame = requestAnimationFrame(run);
		};
		window.addEventListener('resize', listener);
		return () => window.removeEventListener('resize', listener);
	}
	const observer = new ResizeObserver(() => {
		if (!frame) frame = requestAnimationFrame(run);
	});
	observer.observe(el);
	return () => observer.disconnect();
}

/** The host's theme: `dark` or `light`, and the CSS custom properties the host set on `<html>`. */
const theme = {
	/** `dark` when the host says so (`data-theme`), else from `prefers-color-scheme`. */
	mode(): 'light' | 'dark' {
		const set = document.documentElement.getAttribute('data-theme');
		if (set === 'dark' || set === 'light') return set;
		return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	},
	/** A CSS custom property's value (e.g. `--sui-ink`), or `fallback` when it isn't set. */
	token(name: string, fallback = ''): string {
		const v = getComputedStyle(document.documentElement).getPropertyValue(name.startsWith('--') ? name : `--${name}`).trim();
		return v || fallback;
	},
	/**
	 * Calls `redraw(mode)` when the host changes the theme (the `pixerate:theme` event from the
	 * frame bridge) or the system scheme changes. Returns a function that stops it.
	 */
	onChange(redraw: (mode: 'light' | 'dark') => void): () => void {
		const fire = () => redraw(theme.mode());
		window.addEventListener('pixerate:theme', fire);
		const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
		query?.addEventListener?.('change', fire);
		return () => {
			window.removeEventListener('pixerate:theme', fire);
			query?.removeEventListener?.('change', fire);
		};
	}
};

/**
 * A `MeasureText` that measures with a canvas in the page's own fonts: `font` is a CSS font
 * without its size (e.g. `600 Inter, sans-serif`). Falls back to `estimatedMeasure` without a
 * 2-D canvas.
 */
function canvasMeasure(font = 'sans-serif'): MeasureText {
	const ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext?.('2d') : null;
	if (!ctx) return estimatedMeasure();
	return (word, size, spacing) => {
		ctx.font = `${size}px ${font}`;
		const count = Array.from(word).length;
		return ctx.measureText(word).width + Math.max(0, count - 1) * spacing;
	};
}

/** The page motion contract: `window[name] = { duration, seek(p), play() }`. */
export interface PageMotion {
	duration: number;
	/** Draws progress `p` (0–1); depends on `p` alone, and `p = 1` is the picture at rest. */
	seek(p: number): void;
	/** Plays from the start (or shows the rest state under reduced motion or when hidden). */
	play(): void;
	/** Stops playing, leaving the last frame drawn. */
	stop(): void;
	/** The progress last drawn (1 at rest). */
	readonly progress: number;
	/** It is playing. */
	readonly playing: boolean;
}

function reducedMotion(): boolean {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Registers the page's motion: `draw(p)` must be frame-pure (the picture at `p` depends on `p`
 * alone, `p = 1` at rest). Sets `window[name]` (default `pageMotion`, which the frame bridge
 * looks for) and draws the rest state, or, when the page defines it again on a redraw, the frame
 * last shown. With `autoplay`, plays once when the page is visible and motion isn't reduced;
 * otherwise it waits for the host's `replay`.
 */
function defineMotion(draw: (p: number) => void, options: { duration?: number; name?: string; autoplay?: boolean } = {}): PageMotion {
	const duration = Math.max(0, options.duration ?? 1200);
	const name = options.name ?? 'pageMotion';
	const slot = window as unknown as Record<string, unknown>;
	// A page that redraws (on resize or a theme change) defines its motion again: keep the frame
	// the host last showed, and stop the old motion playing.
	const previous = slot[name] as Partial<PageMotion> | undefined;
	const start = previous && typeof previous.progress === 'number' ? previous.progress : 1;
	const resume = previous?.playing === true;
	previous?.stop?.();
	let frame = 0;
	let progress = start;
	const show = (p: number) => {
		progress = p;
		draw(p);
	};
	const stop = () => {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
	};
	const seek = (p: number) => {
		stop();
		show(Math.min(1, Math.max(0, Number.isFinite(p) ? p : 1)));
	};
	/** Plays from `from` (0 for a replay) to the end. */
	const run = (from: number) => {
		stop();
		if (duration === 0 || reducedMotion() || document.visibilityState === 'hidden') {
			show(1);
			return;
		}
		const begin = performance.now() - from * duration;
		const tick = (now: number) => {
			const p = Math.min(1, (now - begin) / duration);
			show(p);
			frame = p < 1 ? requestAnimationFrame(tick) : 0;
		};
		show(from);
		frame = requestAnimationFrame(tick);
	};
	const play = () => run(0);
	const motion: PageMotion = {
		duration,
		seek,
		play,
		stop,
		get progress() {
			return progress;
		},
		get playing() {
			return frame !== 0;
		}
	};
	slot[name] = motion;
	if (resume) run(start);
	else {
		show(start);
		if (options.autoplay && !previous) play();
	}
	return motion;
}

/** Eases for motion, each taking and returning 0–1. */
const ease = {
	linear: (t: number) => t,
	inOut: (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
	out: (t: number) => 1 - (1 - t) ** 3,
	in: (t: number) => t * t * t
};

/**
 * Where a piece of motion is at overall progress `p`, for a piece that runs from `start` to
 * `end` (both 0–1): 0 before it, 1 after it, eased in between.
 */
function phase(p: number, start: number, end: number, curve: (t: number) => number = ease.inOut): number {
	if (p <= start) return 0;
	if (p >= end || end <= start) return 1;
	return curve((p - start) / (end - start));
}

// ---------------------------------------------------------------------------
// The kit
// ---------------------------------------------------------------------------

export const kit = {
	version: KIT_VERSION,
	// Geometry
	placeLabels,
	labelHull,
	isoProjector,
	isoOrder,
	isoFaceColors,
	elbow,
	fanElbows,
	roundedPolyline,
	helix,
	splitByDepth,
	// Paths
	pathLength: bezierPathLength,
	pointAtLength,
	trimPath,
	// Text
	fitText,
	staggerRows,
	estimatedMeasure,
	canvasMeasure,
	// Colour
	contrast,
	ink,
	mix: mixColors,
	ramp,
	hex,
	// Scales and numbers
	niceScale,
	niceStep,
	linearMap,
	formatNumber: formatPlainChartNumber,
	// The page
	svg,
	clear,
	onResize,
	theme,
	defineMotion,
	ease,
	phase
};

(globalThis as unknown as { pixerateKit: typeof kit }).pixerateKit = kit;
