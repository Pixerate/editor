import type { AgentTool, AgentToolProvider, McpToolResult } from './registry.js';
import type { JsonSchema } from './schema.js';

/** A rectangle in a surface's own units (canvas units, image pixels, CSS pixels). */
export interface CaptureRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * What to capture: what is on screen (`viewport`), everything (`content`), the
 * selection, the bounds of some items by id (the surface's `items.region`,
 * e.g. `nodes`), or an explicit `rect`.
 */
export type CaptureRegion = 'viewport' | 'content' | 'selection' | 'rect' | (string & {});

export type CaptureFormat = 'png' | 'jpeg';

/** What a surface is asked to draw. */
export interface CaptureRenderRequest {
	/** Region name the agent asked for. */
	region: CaptureRegion;
	/** The area to draw, in surface units. */
	rect: CaptureRect;
	/** Output size in pixels. */
	width: number;
	height: number;
	/** Output pixels per surface unit (`width / rect.width`). */
	scale: number;
	format: CaptureFormat;
	/** JPEG quality, 0-1. */
	quality: number;
	/** Draw selection boxes, presence cursors and other transient overlays too. */
	includeOverlays: boolean;
	signal?: AbortSignal;
}

/** A rendered image: base64 data with its MIME type, or a `data:` URL. */
export type CapturedImage = { data: string; mimeType: string } | string;

/**
 * Something an agent can take a screenshot of. Bounds are in the surface's
 * own units; `render` draws a rectangle of it at a given pixel size.
 */
export interface CaptureSurface {
	/** Name of the coordinate space, used in the tool description and results (e.g. `canvas units`). */
	units: string;
	/** What is on screen now. Omit when the surface has no viewport. */
	viewport?: () => CaptureRect | null;
	/** Bounds of everything, or `null` when the surface is empty. */
	content: () => CaptureRect | null;
	/** Bounds of the selection (`null` when nothing is selected) and the selected ids. */
	selection?: () => { rect: CaptureRect | null; ids?: string[] };
	/** Capture by item ids, e.g. canvas nodes. */
	items?: {
		/** Region name, e.g. `nodes`. */
		region: string;
		/** Singular noun for messages, e.g. `node`. */
		noun: string;
		/** Where the ids come from, for error messages (e.g. `get_editor_state`). */
		source?: string;
		/** Bounds of the found items and the ids that were not found. */
		bounds: (ids: string[]) => { rect: CaptureRect | null; missing: string[] };
	};
	/** Describes the overlays `includeOverlays` adds; omit when the surface has none. */
	overlays?: string;
	/** Largest output pixels per surface unit (default 2). */
	maxScale?: number;
	render: (request: CaptureRenderRequest) => CapturedImage | Promise<CapturedImage>;
}

export interface CaptureToolOptions {
	/** Tool name (default `capture_view`). */
	name?: string;
	/** Tool title (default `Capture a screenshot`). */
	title?: string;
	/** What is being captured, for the description (default `the view`). */
	subject?: string;
	/** Longest output side when the agent passes no `maxEdge` (default 1024). */
	defaultMaxEdge?: number;
	/** Margin around `content`, `selection` and item regions when the agent passes no `padding` (default 16 units). */
	defaultPadding?: number;
}

export interface CaptureToolProviderOptions extends CaptureToolOptions {
	/** Provider id (unique per registry, default `capture`). */
	id?: string;
	/** Tool-name prefix (`<namespace>__<name>`); defaults to the provider id, `''` for bare names. */
	namespace?: string;
	/** Toolset title (default "Screen capture"), description and skill (see `AgentToolProvider`). */
	title?: string;
	description?: string;
	skill?: string;
}

/** Bounds of the capture: union of rects, `null` for none. */
export function unionCaptureRects(rects: readonly (CaptureRect | null | undefined)[]): CaptureRect | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const r of rects) {
		if (!r) continue;
		minX = Math.min(minX, r.x);
		minY = Math.min(minY, r.y);
		maxX = Math.max(maxX, r.x + r.width);
		maxY = Math.max(maxY, r.y + r.height);
	}
	return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Output pixel size for `rect`: the longest side at most `maxEdge`, never more
 * than `maxScale` pixels per unit, at least 1 × 1.
 */
export function captureOutputSize(rect: CaptureRect, maxEdge: number, maxScale = 2): { width: number; height: number; scale: number } {
	const longest = Math.max(rect.width, rect.height);
	const scale = Math.min(maxScale, maxEdge / longest);
	return {
		width: Math.max(1, Math.round(rect.width * scale)),
		height: Math.max(1, Math.round(rect.height * scale)),
		scale
	};
}

/** Splits a `data:` URL or plain base64 into base64 data and MIME type. */
export function toCapturedImageData(image: CapturedImage, fallbackMimeType: string): { data: string; mimeType: string } {
	if (typeof image !== 'string') return image;
	if (!image.startsWith('data:')) return { data: image, mimeType: fallbackMimeType };
	const match = /^data:([^;,]*)(?:;[^,]*)?,(.*)$/s.exec(image);
	if (!match?.[1] || !match[2]) throw new Error('The surface returned an empty image; rendering may not be available in this environment.');
	return { data: match[2], mimeType: match[1] };
}

const round = (n: number) => Math.round(n * 100) / 100;
const roundRect = (r: CaptureRect): CaptureRect => ({ x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) });
const pad = (r: CaptureRect, p: number): CaptureRect => ({ x: r.x - p, y: r.y - p, width: r.width + 2 * p, height: r.height + 2 * p });

function regionsOf(surface: CaptureSurface): string[] {
	return [
		...(surface.viewport ? ['viewport'] : []),
		'content',
		...(surface.selection ? ['selection'] : []),
		...(surface.items ? [surface.items.region] : []),
		'rect'
	];
}

/** JSON Schema of the capture tool's arguments for a surface (only the options it supports). */
export function captureInputSchema(surface: CaptureSurface, options: CaptureToolOptions = {}): JsonSchema & { type: 'object' } {
	const regions = regionsOf(surface);
	const units = surface.units;
	const properties: Record<string, JsonSchema> = {
		region: {
			type: 'string',
			enum: regions,
			description:
				`What to capture (default ${regions[0]}): ` +
				[
					surface.viewport ? '"viewport" is what is on screen now' : '',
					'"content" is everything',
					surface.selection ? '"selection" is the selected items' : '',
					surface.items ? `"${surface.items.region}" is the ${surface.items.noun}s in "ids"` : '',
					`"rect" is the area in "rect"`
				]
					.filter(Boolean)
					.join(', ') +
				'.'
		},
		...(surface.items
			? {
					ids: {
						type: 'array',
						items: { type: 'string' },
						minItems: 1,
						description: `With region "${surface.items.region}": ids of the ${surface.items.noun}s to frame${surface.items.source ? ` (from ${surface.items.source})` : ''}.`
					}
				}
			: {}),
		rect: {
			type: 'object',
			properties: {
				x: { type: 'number', description: `Left edge in ${units}.` },
				y: { type: 'number', description: `Top edge in ${units}.` },
				width: { type: 'number', exclusiveMinimum: 0, description: `Width in ${units}.` },
				height: { type: 'number', exclusiveMinimum: 0, description: `Height in ${units}.` }
			},
			required: ['x', 'y', 'width', 'height'],
			additionalProperties: false,
			description: `With region "rect": the area to capture, in ${units}.`
		},
		padding: {
			type: 'number',
			minimum: 0,
			description: `Margin around content, selection${surface.items ? ` and ${surface.items.region}` : ''} regions, in ${units} (default ${options.defaultPadding ?? 16}).`
		},
		maxEdge: {
			type: 'integer',
			minimum: 64,
			maximum: 4096,
			description: `Longest side of the image in pixels (default ${options.defaultMaxEdge ?? 1024}). Small regions are not enlarged beyond ${surface.maxScale ?? 2} pixels per unit.`
		},
		format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png; jpeg is smaller for photos).' },
		quality: { type: 'number', minimum: 0.1, maximum: 1, description: 'JPEG quality from 0.1 to 1 (default 0.85). Ignored for png.' },
		...(surface.overlays
			? { includeOverlays: { type: 'boolean', description: `Also draw ${surface.overlays} (default false).` } }
			: {})
	};
	return { type: 'object', properties, additionalProperties: false };
}

/**
 * Works out the rectangle and pixel size for a capture call, checking the
 * arguments against the surface. Throws an error that says how to fix the call.
 */
export function resolveCaptureRequest(
	surface: CaptureSurface,
	args: Record<string, any>,
	options: CaptureToolOptions = {}
): Omit<CaptureRenderRequest, 'signal'> & { ids?: string[] } {
	const regions = regionsOf(surface);
	const region: string = args.region ?? regions[0];
	if (!regions.includes(region)) throw new Error(`Unknown region "${region}". Use one of: ${regions.join(', ')}.`);
	if (args.rect !== undefined && region !== 'rect') throw new Error(`"rect" only applies with region "rect"; drop it or set region to "rect".`);
	if (args.ids !== undefined && region !== surface.items?.region) {
		throw new Error(`"ids" only applies with region "${surface.items?.region ?? 'items'}"; drop it or change the region.`);
	}
	const padding = typeof args.padding === 'number' ? args.padding : (options.defaultPadding ?? 16);
	let rect: CaptureRect | null;
	let ids: string[] | undefined;
	if (region === 'viewport') {
		rect = surface.viewport!();
		if (!rect) throw new Error('The view is not on screen (not mounted or zero size). Use region "content" instead.');
	} else if (region === 'content') {
		const content = surface.content();
		if (!content) throw new Error('There is nothing to capture: the surface is empty.');
		rect = pad(content, padding);
	} else if (region === 'selection') {
		const selection = surface.selection!();
		if (!selection.rect) throw new Error('Nothing is selected. Select something first, or use region "content".');
		rect = pad(selection.rect, padding);
		ids = selection.ids;
	} else if (region === 'rect') {
		if (!args.rect) throw new Error(`Region "rect" needs "rect": {"x", "y", "width", "height"} in ${surface.units}.`);
		rect = { x: args.rect.x, y: args.rect.y, width: args.rect.width, height: args.rect.height };
	} else {
		const items = surface.items!;
		const wanted = Array.isArray(args.ids) ? (args.ids as string[]) : [];
		if (!wanted.length) throw new Error(`Region "${items.region}" needs "ids": the ${items.noun} ids to frame.`);
		const found = items.bounds(wanted);
		if (found.missing.length) {
			throw new Error(
				`Unknown ${items.noun} id(s): ${found.missing.join(', ')}.${items.source ? ` Read the current ids with ${items.source}.` : ''}`
			);
		}
		if (!found.rect) throw new Error(`The ${items.noun}s ${wanted.join(', ')} have no size yet; try again once they are drawn.`);
		rect = pad(found.rect, padding);
		ids = wanted;
	}
	if (!(rect.width > 0) || !(rect.height > 0)) {
		throw new Error(`The ${region} region is empty (${rect.width} × ${rect.height} ${surface.units}); capture a larger area.`);
	}
	const maxEdge = typeof args.maxEdge === 'number' ? args.maxEdge : (options.defaultMaxEdge ?? 1024);
	const size = captureOutputSize(rect, maxEdge, surface.maxScale ?? 2);
	return {
		region,
		rect,
		...size,
		format: args.format === 'jpeg' ? 'jpeg' : 'png',
		quality: typeof args.quality === 'number' ? args.quality : 0.85,
		includeOverlays: !!surface.overlays && args.includeOverlays === true,
		...(ids ? { ids } : {})
	};
}

/**
 * The `capture_view` agent tool for a surface: renders a region as an image
 * the model can look at. The result has the image and a text block, and
 * `structuredContent` with the captured `rect` (surface units), the pixel
 * size and `scale`, so a point in the image maps back with
 * `x = rect.x + px / scale`.
 */
export function createCaptureTool(surface: CaptureSurface, options: CaptureToolOptions = {}): AgentTool {
	const title = options.title ?? 'Capture a screenshot';
	const subject = options.subject ?? 'the view';
	return {
		name: options.name ?? 'capture_view',
		title,
		description:
			`Takes a screenshot of ${subject} so you can check how it looks, without changing anything. ` +
			`Captures the ${regionsOf(surface).join(', ')} region and returns the image plus the captured rect (in ${surface.units}) and the pixel scale, ` +
			'so a point (px, py) in the image is at (rect.x + px / scale, rect.y + py / scale).' +
			(surface.overlays ? ` Transient overlays (${surface.overlays}) are left out unless includeOverlays is true.` : ''),
		inputSchema: captureInputSchema(surface, options),
		annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async (args, context): Promise<McpToolResult> => {
			const { ids, ...request } = resolveCaptureRequest(surface, args, options);
			const mimeType = request.format === 'jpeg' ? 'image/jpeg' : 'image/png';
			const image = toCapturedImageData(await surface.render({ ...request, signal: context.signal }), mimeType);
			const rect = roundRect(request.rect);
			const meta = {
				region: request.region,
				rect,
				units: surface.units,
				width: request.width,
				height: request.height,
				scale: round(request.scale),
				mimeType: image.mimeType,
				...(ids ? { ids } : {})
			};
			return {
				content: [
					{ type: 'image', data: image.data, mimeType: image.mimeType },
					{
						type: 'text',
						text: `Captured ${request.region} at ${request.width}×${request.height} px: x ${rect.x}, y ${rect.y}, ${rect.width}×${rect.height} ${surface.units} (${meta.scale} px per unit).`
					}
				],
				structuredContent: meta
			};
		}
	};
}

/** A provider with just the `capture_view` tool for a surface. */
export function createCaptureToolProvider(surface: CaptureSurface, options: CaptureToolProviderOptions = {}): AgentToolProvider {
	return {
		id: options.id ?? 'capture',
		namespace: options.namespace,
		title: options.title ?? 'Screen capture',
		description: options.description ?? `A screenshot of ${options.subject ?? 'the editor'}, to check what text cannot tell you: overlap, legibility, balance.`,
		...(options.skill ? { skill: options.skill } : {}),
		tools: [createCaptureTool(surface, options)]
	};
}
