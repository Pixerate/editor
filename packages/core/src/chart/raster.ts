// Paint resolution before drawing to a canvas follows Ursula's src/react/export.ts `inlineSvgPaint`,
// and the longest-side bound its `canvasSnapshot`.
import { chartToSvg } from './svg.js';
import type { ChartSpec, ChartTheme } from './types.js';

/** Longest side, in pixels, of a rasterized chart unless `maxSize` says otherwise. */
export const CHART_RASTER_MAX_SIZE = 1024;

export interface ChartPaintScope {
	/**
	 * Element whose CSS variables, `color` and `font-family` stand in for `var(--x)`,
	 * `currentColor` and `inherit` (default: the document's root element). Pass the chart's
	 * container when its theme is scoped (e.g. a `.dark` wrapper).
	 */
	scope?: Element | null;
	/** Looks up a custom property (`--name`) instead of `getComputedStyle(scope)`. Return '' when unset. */
	lookup?: (name: string) => string;
}

export interface RasterizeChartOptions extends ChartPaintScope {
	/** Size of the chart in CSS pixels (the SVG's own size). */
	width: number;
	height: number;
	/** Pixels per CSS pixel (default 2), reduced so the longest side stays within `maxSize`. */
	scale?: number;
	/** Longest side of the image in pixels (default 1024). */
	maxSize?: number;
	/** Fill behind the chart (default white; `transparent` keeps the alpha channel). */
	background?: string;
	/** Document to create the canvas and image in (default: the global one). */
	document?: Document;
}

export interface ChartRasterImage {
	/** Base64 PNG, without the `data:` prefix. */
	data: string;
	mimeType: 'image/png';
	/** Size of the image in pixels. */
	width: number;
	height: number;
}

/** Pixel size of the image for a chart of `width` × `height` CSS pixels: `scale` × the size, longest side ≤ `maxSize`. */
export function chartRasterSize(width: number, height: number, scale = 2, maxSize = CHART_RASTER_MAX_SIZE): { width: number; height: number; scale: number } {
	if (!(width > 0) || !(height > 0)) throw new Error(`A chart image needs a positive width and height; got ${width} × ${height}.`);
	const factor = Math.min(scale > 0 ? scale : 1, maxSize / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)), scale: factor };
}

/** Index just past the `)` closing the parenthesis opened at `open`, or -1. */
function closingParen(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === '(') depth++;
		else if (text[i] === ')' && --depth === 0) return i + 1;
	}
	return -1;
}

/** Replaces every `var(--name, fallback)` in a CSS value; unset variables without a fallback become ''. */
function substituteVars(value: string, lookup: (name: string) => string, depth = 0): string {
	let out = '';
	let i = 0;
	for (let at = value.indexOf('var(', i); at !== -1; at = value.indexOf('var(', i)) {
		const end = closingParen(value, at + 3);
		if (end === -1) break;
		const inner = value.slice(at + 4, end - 1);
		let comma = -1;
		for (let j = 0, d = 0; j < inner.length; j++) {
			if (inner[j] === '(') d++;
			else if (inner[j] === ')') d--;
			else if (inner[j] === ',' && d === 0) {
				comma = j;
				break;
			}
		}
		const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
		const fallback = comma === -1 ? '' : inner.slice(comma + 1).trim();
		const found = lookup(name).trim();
		const resolved = found || fallback;
		out += value.slice(i, at) + (depth < 8 && resolved.includes('var(') ? substituteVars(resolved, lookup, depth + 1) : resolved);
		i = end;
	}
	return out + value.slice(i);
}

const PAINT_ATTRIBUTE = /(\s)([\w:-]+)="([^"]*)"/g;

/**
 * Makes a chart SVG drawable on its own (as an `<img>` or on a canvas, where the page's CSS
 * does not apply): `var(--x, fallback)` becomes the variable's value on `scope` (or the
 * fallback), `currentColor` the scope's colour and `font-family="inherit"` its font. An
 * attribute left empty is dropped, so the renderer's default applies instead of an invalid
 * paint. Text content is left alone.
 */
export function resolveChartSvgPaints(svg: string, options: ChartPaintScope = {}): string {
	const doc = (globalThis as { document?: Document }).document;
	const scope = options.scope ?? doc?.documentElement ?? null;
	const view = scope?.ownerDocument?.defaultView ?? (globalThis as { getComputedStyle?: Window['getComputedStyle'] });
	let computed: CSSStyleDeclaration | null | undefined;
	const style = () => {
		if (computed === undefined) computed = scope && typeof view?.getComputedStyle === 'function' ? view.getComputedStyle(scope) : null;
		return computed;
	};
	const lookup = options.lookup ?? ((name: string) => style()?.getPropertyValue(name) ?? '');
	return svg.replace(PAINT_ATTRIBUTE, (match, space: string, name: string, raw: string) => {
		let value = raw;
		if (value.includes('var(')) value = substituteVars(value.replace(/&quot;/g, '"'), lookup).replace(/"/g, '&quot;');
		if (/currentcolor/i.test(value)) value = value.replace(/currentcolor/gi, style()?.color || '#000000');
		if (name === 'font-family' && /^(inherit|unset|initial)$/i.test(value.trim())) value = (style()?.fontFamily || 'sans-serif').replace(/"/g, "'");
		if (value === raw) return match;
		return value.trim() ? `${space}${name}="${value}"` : '';
	});
}

const NO_DOM =
	'Rasterizing a chart needs a browser DOM (document, Image and a 2D canvas). Outside a browser, render SVG with chartToSvg (or render_chart with format "svg") and convert it with an SVG renderer, or pass your own rasterize option to createChartToolProvider.';

/** Draws an SVG document onto a canvas and returns the PNG as a data URL. */
async function svgToPngDataUrl(svg: string, options: RasterizeChartOptions): Promise<{ url: string; width: number; height: number }> {
	const doc = options.document ?? (globalThis as { document?: Document }).document;
	const ImageCtor = (doc?.defaultView as (Window & typeof globalThis) | null | undefined)?.Image ?? (globalThis as { Image?: typeof Image }).Image;
	if (!doc || typeof doc.createElement !== 'function' || !ImageCtor) throw new Error(NO_DOM);
	const size = chartRasterSize(options.width, options.height, options.scale, options.maxSize);
	const canvas = doc.createElement('canvas');
	canvas.width = size.width;
	canvas.height = size.height;
	let context: CanvasRenderingContext2D | null = null;
	try {
		context = canvas.getContext('2d');
	} catch {
		context = null;
	}
	if (!context) throw new Error(NO_DOM);

	const drawable = resolveChartSvgPaints(svg, options);
	const image = new ImageCtor();
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () => reject(new Error('The chart SVG could not be loaded as an image; check that it is a complete <svg> document with the SVG namespace.'));
		image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(drawable)}`;
	});
	const background = options.background ?? '#ffffff';
	if (background !== 'transparent') {
		context.fillStyle = background;
		context.fillRect(0, 0, size.width, size.height);
	}
	context.drawImage(image, 0, 0, size.width, size.height);
	const url = canvas.toDataURL('image/png');
	if (!url.startsWith('data:image/png')) throw new Error('This canvas cannot export PNG (toDataURL returned no image).');
	return { url, width: size.width, height: size.height };
}

/**
 * Turns a chart SVG (from `chartToSvg`, `chartSceneToSvg` or a live chart's `<svg>`) into a
 * PNG in the browser: resolves CSS-variable paints first (see `resolveChartSvgPaints`, without
 * which they draw black), draws it through an `Image` onto a canvas at `scale` (longest side
 * ≤ `maxSize`, default 1024) over `background`, and returns base64 data. Throws a message
 * saying what to do instead when there is no DOM or canvas.
 */
export async function rasterizeChartSvg(svg: string, options: RasterizeChartOptions): Promise<ChartRasterImage> {
	const { url, width, height } = await svgToPngDataUrl(svg, options);
	return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/png', width, height };
}

/**
 * A `rasterize` function for `createChartToolProvider` (so `render_chart { format: "png" }`
 * works), or `undefined` when there is no DOM to draw with. The React and Svelte
 * `useChartToolProvider` pass one by default.
 */
export function createChartRasterizer(
	options: Omit<RasterizeChartOptions, 'width' | 'height'> = {}
): ((svg: string, size: { width: number; height: number }) => Promise<ChartRasterImage>) | undefined {
	const doc = options.document ?? (globalThis as { document?: Document }).document;
	if (!doc || typeof doc.createElement !== 'function') return undefined;
	return (svg, size) => rasterizeChartSvg(svg, { ...options, ...size });
}

export interface DownloadChartPngOptions extends Omit<RasterizeChartOptions, 'width' | 'height'> {
	/** Chart size in CSS pixels (default 800 × 450). */
	width?: number;
	height?: number;
	/** File name (default: the chart title, else `chart`, plus `.png`). */
	filename?: string;
	/** Colours and type (default: the light default theme, with concrete colours). */
	theme?: Partial<ChartTheme>;
}

/** A file name for a chart: its title in lower case with dashes, else `chart`, plus the extension. */
export function chartFileName(spec: Pick<ChartSpec, 'title'>, extension: string): string {
	const base = (spec.title ?? '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return `${base || 'chart'}.${extension}`;
}

/** Renders a chart to PNG (see `rasterizeChartSvg`) and saves it through a download link. Returns the image and the file name. */
export async function downloadChartPng(spec: ChartSpec, options: DownloadChartPngOptions = {}): Promise<ChartRasterImage & { filename: string }> {
	const { width = 800, height = 450, filename = chartFileName(spec, 'png'), theme, ...raster } = options;
	const svg = chartToSvg(spec, { width, height, theme });
	const { url, width: w, height: h } = await svgToPngDataUrl(svg, { ...raster, width, height });
	const doc = (raster.document ?? (globalThis as { document?: Document }).document)!;
	const link = doc.createElement('a');
	link.href = url;
	link.download = filename;
	link.style.display = 'none';
	doc.body?.appendChild(link);
	link.click();
	link.remove();
	return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/png', width: w, height: h, filename };
}
