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
 * Elements matching `exclude` are left out, canvases become images, and
 * same-origin images and form values are copied in.
 */
export function cloneElementWithStyles(element: Element, exclude: readonly string[] = []): HTMLElement {
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
			const url = imageSnapshot(el as HTMLCanvasElement, doc);
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

	const clone = cloneElementWithStyles(element, options.exclude);
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
