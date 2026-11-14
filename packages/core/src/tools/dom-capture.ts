import type { CaptureFormat, CaptureRect, CaptureSurface, CapturedImage } from './capture.js';
import { EXPORT_EXCLUDED_SELECTORS } from './definitions.js';

export interface RasterizeElementOptions {
	/** CSS size of the drawn box (default: the element's client size). */
	width?: number;
	height?: number;
	/** Output size in pixels (default: the CSS size). */
	pixelWidth?: number;
	pixelHeight?: number;
	format?: CaptureFormat;
	/** JPEG quality, 0-1 (default 0.85). */
	quality?: number;
	/** Fill behind the element (default: its computed background, else white for JPEG and transparent for PNG). */
	background?: string;
	/** Selectors of elements (and their subtrees) to leave out. */
	exclude?: readonly string[];
	/** Adjusts the styled clone before it is drawn (e.g. moves a viewport transform). */
	prepare?: (clone: HTMLElement) => void;
	/**
	 * Output pixels per CSS pixel, for canvases with a capture source (`registerCaptureSource`),
	 * which draw again at this scale instead of being stretched (default: pixelWidth / width).
	 */
	sourceScale?: number;
}

// ---------------------------------------------------------------------------
// Capture sources: canvases that draw themselves for a capture (#809)
// ---------------------------------------------------------------------------

/** What a capture source gives: the picture (a data URL or a canvas), or that it cannot draw. */
export type CaptureSourceResult = string | HTMLCanvasElement | { lost: true; reason?: string };

/** Draws a canvas's picture for a capture at `scale` output pixels per CSS pixel. */
export type CaptureSource = (request: { scale: number }) => CaptureSourceResult;

const captureSources = new WeakMap<HTMLCanvasElement, CaptureSource>();

/**
 * Lets a canvas draw itself for captures: a WebGL renderer draws again at the capture's scale
 * (so a 2× capture is sharp, not stretched) and reports a lost context instead of a blank
 * picture. Returns a function that removes it. `renderChart3d` registers its canvas.
 */
export function registerCaptureSource(canvas: HTMLCanvasElement, source: CaptureSource): () => void {
	captureSources.set(canvas, source);
	return () => {
		if (captureSources.get(canvas) === source) captureSources.delete(canvas);
	};
}

/** A canvas in the picture lost its WebGL context, so it can't be captured until it is restored. */
export class CaptureContextLostError extends Error {
	readonly element: HTMLCanvasElement;
	constructor(element: HTMLCanvasElement, reason?: string) {
		const name = element.getAttribute('aria-label') || element.id || element.getAttribute('data-testid') || 'a canvas';
		super(`The picture can't be captured: ${name} lost its WebGL context${reason ? ` (${reason})` : ''}. Draw it again once the context is restored, then capture.`);
		this.name = 'CaptureContextLostError';
		this.element = element;
	}
}

/** Whether a canvas holds a WebGL context that is lost (a 2-D canvas never is). */
function webglContextLost(canvas: HTMLCanvasElement): boolean {
	for (const type of ['webgl2', 'webgl'] as const) {
		try {
			const gl = canvas.getContext(type) as WebGLRenderingContext | null;
			if (gl) return typeof gl.isContextLost === 'function' && gl.isContextLost();
		} catch {
			// Asking for another kind of context than the canvas has throws in some browsers.
		}
	}
	return false;
}

/** A canvas's picture for a capture at `scale`: its capture source's, else its pixels as they are. */
function canvasSnapshot(canvas: HTMLCanvasElement, scale: number): string | null {
	const source = captureSources.get(canvas);
	if (source) {
		const result = source({ scale });
		if (typeof result === 'string') return result;
		if ('lost' in result) throw new CaptureContextLostError(canvas, result.reason);
		return result.toDataURL('image/png');
	}
	if (webglContextLost(canvas)) throw new CaptureContextLostError(canvas);
	try {
		return canvas.toDataURL('image/png');
	} catch {
		return null;
	}
}

const NO_DOM =
	'Capturing needs a browser DOM (document, Image, XMLSerializer and a 2D canvas); it is not available in this environment.';

const SKIPPED_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'STYLE']);

function styleText(style: CSSStyleDeclaration): string {
	let text = '';
	for (let i = 0; i < style.length; i++) {
		const name = style[i];
		const priority = style.getPropertyPriority(name);
		text += `${name}:${style.getPropertyValue(name)}${priority ? ` !${priority}` : ''};`;
	}
	return text;
}

function imageSnapshot(source: HTMLCanvasElement | HTMLImageElement, doc: Document): string | null {
	try {
		if (source.tagName === 'CANVAS') return (source as HTMLCanvasElement).toDataURL('image/png');
		const img = source as HTMLImageElement;
		if (!img.complete || !img.naturalWidth || img.src.startsWith('data:')) return null;
		const canvas = doc.createElement('canvas');
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const context = canvas.getContext('2d');
		if (!context) return null;
		context.drawImage(img, 0, 0);
		return canvas.toDataURL('image/png');
	} catch {
		// Cross-origin pixels taint the canvas; the image is drawn blank instead.
		return null;
	}
}

/**
 * Deep-clones `element` with every computed style inlined, so the copy looks
 * the same outside the page's stylesheets (inside an SVG `<foreignObject>`).
 * Elements matching `exclude` are left out, canvases become images (a canvas with a capture
 * source draws again at `options.scale`; a lost WebGL context throws `CaptureContextLostError`),
 * and same-origin images and form values are copied in.
 */
export function cloneElementWithStyles(element: Element, exclude: readonly string[] = [], options: { scale?: number } = {}): HTMLElement {
	const doc = element.ownerDocument;
	const view = doc.defaultView;
	if (!view) throw new Error(NO_DOM);
	const selector = exclude.join(',');
	const copy = (source: Node): Node | null => {
		if (source.nodeType === 3) return source.cloneNode(false);
		if (source.nodeType !== 1) return null;
		const el = source as Element;
		if (SKIPPED_TAGS.has(el.tagName.toUpperCase()) || (selector && el.matches(selector))) return null;
		let clone: Element;
		if (el.tagName === 'CANVAS') {
			clone = doc.createElement('img');
			const url = canvasSnapshot(el as HTMLCanvasElement, options.scale ?? 1);
			if (url) clone.setAttribute('src', url);
		} else {
			clone = el.cloneNode(false) as Element;
			if (el.tagName === 'IMG') {
				const url = imageSnapshot(el as HTMLImageElement, doc);
				if (url) clone.setAttribute('src', url);
				clone.removeAttribute('srcset');
			}
		}
		clone.setAttribute('style', styleText(view.getComputedStyle(el)));
		if (el.tagName === 'INPUT') {
			const input = el as HTMLInputElement;
			clone.setAttribute('value', input.value);
			if (input.checked) clone.setAttribute('checked', '');
			else clone.removeAttribute('checked');
		} else if (el.tagName === 'TEXTAREA') {
			clone.textContent = (el as HTMLTextAreaElement).value;
			return clone;
		} else if (el.tagName === 'SELECT') {
			// Options are copied below; mark the chosen one.
			const value = (el as HTMLSelectElement).value;
			for (const child of Array.from(el.childNodes)) {
				const option = copy(child);
				if (option && (option as Element).tagName === 'OPTION' && (option as HTMLOptionElement).value === value) {
					(option as Element).setAttribute('selected', '');
				}
				if (option) clone.appendChild(option);
			}
			return clone;
		}
		for (const child of Array.from(el.childNodes)) {
			const next = copy(child);
			if (next) clone.appendChild(next);
		}
		return clone;
	};
	const root = copy(element);
	if (!root) throw new Error('The element to capture is excluded by the exclude selectors.');
	return root as HTMLElement;
}

/** Wraps a styled clone in a standalone SVG of `width` × `height` CSS pixels. */
export function elementToSvg(clone: Element, width: number, height: number): string {
	const doc = clone.ownerDocument;
	const Serializer = (doc.defaultView as (Window & typeof globalThis) | null)?.XMLSerializer ?? (globalThis as { XMLSerializer?: typeof XMLSerializer }).XMLSerializer;
	if (!Serializer) throw new Error(NO_DOM);
	clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
	const xml = new Serializer().serializeToString(clone);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
		`<foreignObject x="0" y="0" width="100%" height="100%">${xml}</foreignObject></svg>`
	);
}

/**
 * Draws a DOM element into an image in the browser: its styled clone goes
 * into an SVG `<foreignObject>`, which is drawn onto a canvas. Web fonts that
 * are not installed locally fall back, pseudo-elements (`::before`) are not
 * drawn, and cross-origin images come out blank. Returns a `data:` URL.
 */
export async function rasterizeElement(element: HTMLElement, options: RasterizeElementOptions = {}): Promise<string> {
	const doc = element.ownerDocument;
	const view = doc?.defaultView as (Window & typeof globalThis) | null;
	if (!view?.Image) throw new Error(NO_DOM);
	const width = Math.max(1, Math.round(options.width ?? element.clientWidth));
	const height = Math.max(1, Math.round(options.height ?? element.clientHeight));
	const pixelWidth = Math.max(1, Math.round(options.pixelWidth ?? width));
	const pixelHeight = Math.max(1, Math.round(options.pixelHeight ?? height));
	const format = options.format ?? 'png';

	const clone = cloneElementWithStyles(element, options.exclude, { scale: options.sourceScale ?? pixelWidth / width });
	const background = options.background ?? view.getComputedStyle(element).backgroundColor;
	clone.style.width = `${width}px`;
	clone.style.height = `${height}px`;
	clone.style.margin = '0';
	clone.style.position = 'relative';
	clone.style.left = '0';
	clone.style.top = '0';
	clone.style.transform = 'none';
	clone.style.overflow = 'hidden';
	options.prepare?.(clone);
	const svg = elementToSvg(clone, width, height);

	const canvas = doc.createElement('canvas');
	canvas.width = pixelWidth;
	canvas.height = pixelHeight;
	let context: CanvasRenderingContext2D | null = null;
	try {
		context = canvas.getContext('2d');
	} catch {
		context = null;
	}
	if (!context) throw new Error(NO_DOM);
	const image = new view.Image();
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () => reject(new Error('The captured view could not be drawn as an image.'));
		image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	});
	const transparent = !background || background === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(background);
	if (!transparent || format === 'jpeg') {
		context.fillStyle = transparent ? '#ffffff' : background;
		context.fillRect(0, 0, pixelWidth, pixelHeight);
	}
	context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
	try {
		return canvas.toDataURL(format === 'jpeg' ? 'image/jpeg' : 'image/png', options.quality ?? 0.85);
	} catch {
		throw new Error('The browser refused to export the captured view (the canvas is tainted by cross-origin content).');
	}
}

export interface ElementCaptureSurfaceOptions {
	/** The element to capture, or a getter (re-read on every call). */
	element: HTMLElement | null | undefined | (() => HTMLElement | null | undefined);
	/** Selectors left out of every capture (default none). */
	exclude?: readonly string[];
	/** Selectors of transient overlays, left out unless `includeOverlays` (default `CAPTURE_OVERLAY_SELECTORS`). */
	overlaySelectors?: readonly string[];
	/** Fill behind the element (default its computed background). */
	background?: string;
	/** Swaps the drawing step (tests, or a library such as html-to-image). */
	rasterize?: (element: HTMLElement, options: RasterizeElementOptions) => Promise<CapturedImage>;
}

/** Overlays left out of captures by default: agent cursors and presence tags. */
export const CAPTURE_OVERLAY_SELECTORS: readonly string[] = [...EXPORT_EXCLUDED_SELECTORS, '[data-capture="overlay"]'];

/** Elements marked `data-capture="exclude"` are never captured. */
export const CAPTURE_EXCLUDE_SELECTOR = '[data-capture="exclude"]';

/**
 * A capture surface for any DOM element (a rich-text editor, a spreadsheet, a
 * panel): units are CSS pixels from the element's top-left corner; `viewport`
 * is its visible box and `content` its full scrollable area.
 */
export function createElementCaptureSurface(options: ElementCaptureSurfaceOptions): CaptureSurface {
	const getElement = () => (typeof options.element === 'function' ? options.element() : options.element) ?? null;
	const require = () => {
		const el = getElement();
		if (!el || !el.isConnected) throw new Error('The view is not mounted, so there is nothing to capture.');
		return el;
	};
	const visible = (): CaptureRect | null => {
		const el = getElement();
		if (!el || !el.clientWidth || !el.clientHeight) return null;
		return { x: el.scrollLeft, y: el.scrollTop, width: el.clientWidth, height: el.clientHeight };
	};
	const overlays = options.overlaySelectors ?? CAPTURE_OVERLAY_SELECTORS;
	return {
		units: 'CSS pixels',
		viewport: visible,
		content: () => {
			const el = getElement();
			if (!el || !el.scrollWidth || !el.scrollHeight) return null;
			return { x: 0, y: 0, width: el.scrollWidth, height: el.scrollHeight };
		},
		overlays: 'agent cursors and presence tags',
		maxScale: 2,
		render: (request) => {
			const el = require();
			const exclude = [CAPTURE_EXCLUDE_SELECTOR, ...(options.exclude ?? []), ...(request.includeOverlays ? [] : overlays)];
			const rasterize = options.rasterize ?? rasterizeElement;
			return rasterize(el, {
				width: request.rect.width,
				height: request.rect.height,
				pixelWidth: request.width,
				pixelHeight: request.height,
				format: request.format,
				quality: request.quality,
				background: options.background,
				exclude,
				sourceScale: request.width / Math.max(1, request.rect.width),
				// Scrolling does not survive cloning: shift the content so the rect's corner is at the top left.
				prepare: (clone) => {
					const shift = `translate(${-request.rect.x}px, ${-request.rect.y}px)`;
					const inner = clone.ownerDocument.createElement('div');
					inner.setAttribute('style', `transform:${shift};transform-origin:0 0;width:${el.scrollWidth}px;height:${el.scrollHeight}px`);
					while (clone.firstChild) inner.appendChild(clone.firstChild);
					clone.appendChild(inner);
				}
			});
		}
	};
}

// ---------------------------------------------------------------------------
// One picture from layered canvases, SVG and HTML (#809)
// ---------------------------------------------------------------------------

export interface CompositeCaptureOptions {
	/** Output pixels per CSS pixel (default 1). Canvases with a capture source draw again at it. */
	scale?: number;
	/** Largest output side in pixels; lowers the scale to fit (default none). */
	maxSide?: number;
	/** Fill behind the picture (default the element's computed background; JPEG gets white when it is clear). */
	background?: string;
	format?: CaptureFormat;
	/** JPEG quality, 0–1 (default 0.85). */
	quality?: number;
	/** Selectors of elements to leave out, besides `[data-capture="exclude"]` and the overlays. */
	exclude?: readonly string[];
	/** Keep agent cursors and other overlays (default false). */
	includeOverlays?: boolean;
	/** Return a Blob instead of a data URL (default `dataUrl`). */
	output?: 'dataUrl' | 'blob';
}

export interface CompositeCapture {
	/** A `data:` URL, or a Blob with `output: 'blob'`. */
	image: string | Blob;
	mimeType: string;
	/** Output size in pixels. */
	width: number;
	height: number;
	/** The scale used, after `maxSide`. */
	scale: number;
}

/** The picture container in a document: the first element marked `data-picture` (the page contract). */
export function findPicture(root: ParentNode = globalThis.document): HTMLElement | null {
	return (root?.querySelector?.('[data-picture]') as HTMLElement | null) ?? null;
}

/**
 * One image of what a person sees in `root`: its canvases (WebGL included), SVG and HTML labels,
 * in their order and with their opacity, as the page draws them. Canvases that registered a
 * capture source (`registerCaptureSource`, e.g. `renderChart3d`) draw again at the output scale,
 * so 2× is sharp; one that lost its WebGL context rejects with `CaptureContextLostError` rather
 * than a blank picture. Browser only; Node tooling runs it in a headless browser.
 */
export async function compositeCapture(root: HTMLElement, options: CompositeCaptureOptions = {}): Promise<CompositeCapture> {
	const width = Math.max(1, Math.round(root.clientWidth || root.getBoundingClientRect().width));
	const height = Math.max(1, Math.round(root.clientHeight || root.getBoundingClientRect().height));
	let scale = options.scale ?? 1;
	if (!(scale > 0) || !Number.isFinite(scale)) throw new Error(`scale must be a positive number (got ${String(options.scale)}).`);
	if (options.maxSide !== undefined) {
		if (!(options.maxSide >= 1)) throw new Error(`maxSide must be at least 1 pixel (got ${String(options.maxSide)}).`);
		scale = Math.min(scale, options.maxSide / Math.max(width, height));
	}
	const pixelWidth = Math.max(1, Math.round(width * scale));
	const pixelHeight = Math.max(1, Math.round(height * scale));
	const format = options.format ?? 'png';
	const exclude = [CAPTURE_EXCLUDE_SELECTOR, ...(options.exclude ?? []), ...(options.includeOverlays ? [] : CAPTURE_OVERLAY_SELECTORS)];
	const url = await rasterizeElement(root, { width, height, pixelWidth, pixelHeight, format, quality: options.quality, background: options.background, exclude, sourceScale: scale });
	const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
	if (options.output !== 'blob') return { image: url, mimeType, width: pixelWidth, height: pixelHeight, scale };
	const base64 = url.slice(url.indexOf(',') + 1);
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	return { image: new Blob([bytes], { type: mimeType }), mimeType, width: pixelWidth, height: pixelHeight, scale };
}
