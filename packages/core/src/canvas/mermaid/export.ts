// Thumbnails and PNG export follow Ursula's MermaidThumbnail and src/react/export.ts
// (`downloadCanvasPng`, a longest-side bound on snapshots), drawn from the layout as standalone
// SVG instead of capturing the DOM, so they work without the canvas mounted.
import { isoFaceColors, isoOrder, isoProjector, type IsoBox } from '../../geom/iso.js';
import { placeLabels, type LabelObstacle } from '../../geom/labels.js';
import type { DiagramGraph, MermaidDocument } from '../../diagram/types.js';
import { ensureDiagramLayout, type DiagramLayout, type DiagramLayoutOptions } from './layout.js';
import { mermaidEdgeMarker, mermaidLabelLines, mermaidNodeMembers, mermaidShapePaths } from './shapes.js';
import { mermaidEdgeDash, resolveMermaidStyles } from './toFlow.js';
import { DIAGRAM_SVG_LIGHT_THEME } from './theme.js';
import { DIAGRAM_SCENE_LIGHT_THEME, diagramMarksToSvg, familySceneFromLayout, type DiagramSceneTheme } from './scene.js';

export { DIAGRAM_SVG_DARK_THEME, DIAGRAM_SVG_LIGHT_THEME, type DiagramSvgTheme } from './theme.js';

export interface DiagramSvgOptions extends DiagramLayoutOptions {
	/** A layout to draw instead of computing one (e.g. the canvas' current layout). */
	layout?: DiagramLayout;
	/** Colours; the scene colours (`palette`, `grid`…) are used by families drawn as scenes. */
	theme?: Partial<DiagramSceneTheme>;
	/** Room around the diagram in px (default 16). */
	padding?: number;
	/**
	 * Fit inside this box (a thumbnail): the SVG's `width` / `height` shrink to fit, keeping the
	 * aspect ratio; the drawing is not enlarged. Default: natural size.
	 */
	maxWidth?: number;
	maxHeight?: number;
	/** Accessible name (`<title>`); default the diagram's title or family. */
	title?: string;
	/** Leave out the background rectangle (transparent). */
	transparent?: boolean;
	/**
	 * `isometric` draws the laid-out diagram in 2.5D (#799): nodes as blocks, groups as floor
	 * tiles under them and edges along the floor, back to front. Families without node
	 * positions (sequence, Gantt, pie, ...) are drawn flat. Default `flat`.
	 */
	projection?: 'flat' | 'isometric';
}

/** How tall an isometric node block is, and its group tile, in layout px. */
const ISO_NODE_HEIGHT = 18;
const ISO_TILE_HEIGHT = 4;

export interface DiagramSvg {
	svg: string;
	/** The SVG's `width` / `height` attributes (after fitting). */
	width: number;
	height: number;
	/** Natural size of the drawing (before fitting), in px. */
	naturalWidth: number;
	naturalHeight: number;
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => String(Math.round(v * 100) / 100);

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Where the segment from the box's centre towards `to` leaves the box. */
function exitPoint(box: Box, to: { x: number; y: number }): { x: number; y: number } {
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const dx = to.x - cx;
	const dy = to.y - cy;
	if (dx === 0 && dy === 0) return { x: cx, y: cy };
	const sx = dx === 0 ? Infinity : box.width / 2 / Math.abs(dx);
	const sy = dy === 0 ? Infinity : box.height / 2 / Math.abs(dy);
	const t = Math.min(sx, sy);
	return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * Draws a Mermaid diagram as a standalone SVG. Flowchart, state, class and ER diagrams: groups,
 * nodes in their Mermaid shapes with `style` / `classDef` colours, labels, class members and
 * ER attributes, and edges with labels, line patterns and arrow heads. Families with their own
 * picture (pie, Gantt, sequence, XY, radar…) are drawn from their scene (`mermaidToScene`).
 * Uses stored `%% @pixerate` positions (auto-layout for the rest), so it matches the canvas.
 * Pure: no DOM.
 */
export function mermaidToSvg(doc: MermaidDocument, options: DiagramSvgOptions = {}): DiagramSvg {
	const theme = { ...DIAGRAM_SVG_LIGHT_THEME, ...options.theme };
	const pad = options.padding ?? 16;
	const graph: DiagramGraph = doc.graph;
	const layout = options.layout ?? ensureDiagramLayout(graph, doc.meta, { family: doc.family, ...options });
	const boxOf = (id: string): Box | null => {
		const p = layout.positions[id];
		if (!p) return null;
		const s = layout.sizes[id] ?? { width: 160, height: 56 };
		return { x: p[0], y: p[1], width: s.width, height: s.height };
	};
	if (options.projection === 'isometric' && Object.keys(layout.positions).length) return isometricDiagramSvg(doc, graph, layout, theme, options);
	const scene = doc.tier === 'editable' ? familySceneFromLayout(doc.family, graph, layout, { theme: { ...DIAGRAM_SCENE_LIGHT_THEME, ...theme } }) : null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	if (scene && scene.marks.length) {
		minX = scene.x;
		minY = scene.y;
		maxX = scene.x + scene.width;
		maxY = scene.y + scene.height;
	} else for (const id of Object.keys(layout.positions)) {
		const b = boxOf(id)!;
		minX = Math.min(minX, b.x);
		minY = Math.min(minY, b.y);
		maxX = Math.max(maxX, b.x + b.width);
		maxY = Math.max(maxY, b.y + b.height);
	}
	if (minX === Infinity) minX = minY = maxX = maxY = 0;
	const naturalWidth = Math.max(1, Math.ceil(maxX - minX + pad * 2));
	const naturalHeight = Math.max(1, Math.ceil(maxY - minY + pad * 2));
	const fit = Math.min(1, (options.maxWidth ?? Infinity) / naturalWidth, (options.maxHeight ?? Infinity) / naturalHeight);
	const width = Math.max(1, Math.round(naturalWidth * fit));
	const height = Math.max(1, Math.round(naturalHeight * fit));
	const ox = pad - minX;
	const oy = pad - minY;
	const fs = theme.fontSize;
	const title = options.title ?? graph.title ?? `${doc.family} diagram`;
	const out: string[] = [];
	out.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${naturalWidth} ${naturalHeight}" role="img" aria-label="${esc(title)}" font-family="${esc(theme.fontFamily)}" font-size="${fs}">`,
		`<title>${esc(title)}</title>`,
		'<defs>',
		`<marker id="pd-arrow-closed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="${esc(theme.edge)}"/></marker>`,
		`<marker id="pd-arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10" fill="none" stroke="${esc(theme.edge)}" stroke-width="1.5"/></marker>`,
		'</defs>'
	);
	if (!options.transparent) out.push(`<rect width="${naturalWidth}" height="${naturalHeight}" fill="${esc(theme.background)}"/>`);
	out.push(`<g transform="translate(${n(ox)} ${n(oy)})">`);
	if (scene) {
		out.push(diagramMarksToSvg(scene.marks, { ...DIAGRAM_SCENE_LIGHT_THEME, ...theme }), '</g></svg>');
		return { svg: out.join(''), width, height, naturalWidth, naturalHeight };
	}

	// Groups, outermost first.
	const depth = (id: string) => {
		let d = 0;
		let cur = graph.groups.find((g) => g.id === id)?.parentId;
		while (cur && d < 50) {
			d++;
			cur = graph.groups.find((g) => g.id === cur)?.parentId;
		}
		return d;
	};
	for (const g of [...graph.groups].sort((a, b) => depth(a.id) - depth(b.id))) {
		const b = boxOf(g.id);
		if (!b) continue;
		const st = resolveMermaidStyles(g.classes, g.styles, graph.classDefs);
		out.push(
			`<g data-group="${esc(g.id)}"><rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.width)}" height="${n(b.height)}" rx="8" fill="${esc(st.fill ?? theme.groupFill)}" stroke="${esc(st.stroke ?? theme.groupStroke)}" stroke-dasharray="4 3"/>`,
			`<text x="${n(b.x + 10)}" y="${n(b.y + 18)}" fill="${esc(st.color ?? theme.groupText)}" font-size="${fs - 1}" font-weight="600">${esc(mermaidLabelLines(g.label).join(' '))}</text></g>`
		);
	}

	// Edges under nodes; their labels sit on the edge unless a node or another label is there.
	const drawn: { e: (typeof graph.edges)[number]; p: { x: number; y: number }; q: { x: number; y: number }; text?: string; w: number }[] = [];
	for (const e of graph.edges) {
		const a = boxOf(e.source);
		const b = boxOf(e.target);
		if (!a || !b || e.pattern === 'invisible') continue;
		const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
		const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
		const text = e.label ? mermaidLabelLines(e.label).join(' ') : undefined;
		drawn.push({ e, p: exitPoint(a, cb), q: exitPoint(b, ca), ...(text ? { text } : {}), w: text ? text.length * fs * 0.55 + 10 : 0 });
	}
	const labelled = drawn.filter((d) => d.text);
	const nodeBoxes: LabelObstacle[] = [];
	for (const node of graph.nodes) {
		const b = boxOf(node.id);
		if (b) nodeBoxes.push({ box: b, pad: 2 });
	}
	const spots = placeLabels(
		labelled.map((d) => ({ anchor: { x: (d.p.x + d.q.x) / 2, y: (d.p.y + d.q.y) / 2 }, width: d.w, height: fs * 1.5 })),
		{ obstacles: nodeBoxes, prefer: ['center', 'above', 'below', 'right', 'left'], distance: 4, reach: 40 }
	);
	for (const d of drawn) {
		const { e, p, q } = d;
		const st = resolveMermaidStyles(e.classes, e.styles, graph.classDefs);
		const end = mermaidEdgeMarker(e.arrowEnd);
		const start = mermaidEdgeMarker(e.arrowStart);
		const marker = (m: string | null) => (m === 'arrow' ? 'url(#pd-arrow-open)' : m ? 'url(#pd-arrow-closed)' : '');
		const dash = mermaidEdgeDash(e.pattern);
		out.push(
			`<line data-edge="${esc(e.id)}" x1="${n(p.x)}" y1="${n(p.y)}" x2="${n(q.x)}" y2="${n(q.y)}" stroke="${esc(st.stroke ?? theme.edge)}" stroke-width="${e.pattern === 'thick' ? 3 : 1.5}"${dash ? ` stroke-dasharray="${dash}"` : ''}${end ? ` marker-end="${marker(end)}"` : ''}${start ? ` marker-start="${marker(start)}"` : ''}/>`
		);
		if (d.text) {
			const spot = spots[labelled.indexOf(d)];
			out.push(
				`<rect x="${n(spot.x)}" y="${n(spot.y)}" width="${n(spot.width)}" height="${n(spot.height)}" rx="3" fill="${esc(theme.edgeLabelBackground)}"/>`,
				`<text x="${n(spot.x + spot.width / 2)}" y="${n(spot.y + spot.height / 2)}" text-anchor="middle" dominant-baseline="central" fill="${esc(st.color ?? theme.text)}" font-size="${fs - 1}">${esc(d.text)}</text>`
			);
		}
	}

	// Nodes.
	for (const node of graph.nodes) {
		const b = boxOf(node.id);
		if (!b) continue;
		const st = resolveMermaidStyles(node.classes, node.styles, graph.classDefs);
		const fill = st.fill ?? theme.nodeFill;
		const stroke = st.stroke ?? theme.nodeStroke;
		const color = st.color ?? theme.text;
		const strokeWidth = st['stroke-width']?.replace('px', '') ?? '1.25';
		const paint = (kind: string) =>
			kind === 'shape'
				? `fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${esc(strokeWidth)}"`
				: kind === 'line'
					? `fill="none" stroke="${esc(stroke)}" stroke-width="${esc(strokeWidth)}"`
					: kind === 'filled'
						? `fill="${esc(stroke)}" stroke="${esc(stroke)}"`
						: 'fill="none" stroke="none"';
		out.push(`<g data-node="${esc(node.id)}" transform="translate(${n(b.x)} ${n(b.y)})">`);
		for (const path of mermaidShapePaths(node.shape, b.width, b.height)) out.push(`<path d="${path.d}" ${paint(path.paint)}/>`);
		const lines = mermaidLabelLines(node.label).filter((l, i, all) => l || all.length === 1);
		const members = mermaidNodeMembers(node.data);
		const lh = fs * 1.3;
		if (members.length) {
			lines.forEach((line, i) => out.push(`<text x="${n(b.width / 2)}" y="${n(14 + lh * i)}" text-anchor="middle" dominant-baseline="central" fill="${esc(color)}" font-weight="600">${esc(line)}</text>`));
			const top = 14 + lh * lines.length - lh / 2 + 4;
			out.push(`<line x1="0" y1="${n(top)}" x2="${n(b.width)}" y2="${n(top)}" stroke="${esc(stroke)}" stroke-width="1"/>`);
			members.forEach((m, i) => out.push(`<text x="8" y="${n(top + 4 + lh * (i + 0.5))}" dominant-baseline="central" fill="${esc(color)}" font-size="${fs - 1}">${esc(m)}</text>`));
		} else {
			const first = b.height / 2 - ((lines.length - 1) * lh) / 2;
			lines.forEach((line, i) => out.push(`<text x="${n(b.width / 2)}" y="${n(first + lh * i)}" text-anchor="middle" dominant-baseline="central" fill="${esc(color)}">${esc(line)}</text>`));
		}
		out.push('</g>');
	}
	out.push('</g></svg>');
	return { svg: out.join(''), width, height, naturalWidth, naturalHeight };
}

/** `mermaidToSvg` with `projection: 'isometric'`: blocks on a floor, back to front. */
function isometricDiagramSvg(doc: MermaidDocument, graph: DiagramGraph, layout: DiagramLayout, theme: typeof DIAGRAM_SVG_LIGHT_THEME, options: DiagramSvgOptions): DiagramSvg {
	const pad = options.padding ?? 16;
	const fs = theme.fontSize;
	const iso = isoProjector({ scale: 1 });
	const sizeOf = (id: string) => layout.sizes[id] ?? { width: 160, height: 56 };
	// Grid i, j are layout x, y: a node's box becomes a block standing on its group's tile.
	const blockOf = (id: string, k0: number, k1: number): IsoBox | null => {
		const p = layout.positions[id];
		if (!p) return null;
		const s = sizeOf(id);
		return { i0: p[0], i1: p[0] + s.width, j0: p[1], j1: p[1] + s.height, k0, k1 };
	};
	const tiles = graph.groups.map((g) => ({ g, box: blockOf(g.id, 0, ISO_TILE_HEIGHT) })).filter((t): t is { g: (typeof graph.groups)[number]; box: IsoBox } => !!t.box);
	const blocks = graph.nodes.map((node) => ({ node, box: blockOf(node.id, ISO_TILE_HEIGHT, ISO_TILE_HEIGHT + ISO_NODE_HEIGHT) })).filter((b): b is { node: (typeof graph.nodes)[number]; box: IsoBox } => !!b.box);
	const centreOf = (id: string) => {
		const p = layout.positions[id];
		const s = sizeOf(id);
		return p ? iso.point(p[0] + s.width / 2, p[1] + s.height / 2, ISO_TILE_HEIGHT) : null;
	};
	const edges = graph.edges.flatMap((e) => {
		const a = centreOf(e.source);
		const b = centreOf(e.target);
		return a && b && e.pattern !== 'invisible' ? [{ e, a, b }] : [];
	});
	const edgeLabels = edges.flatMap(({ e, a, b }) => {
		if (!e.label) return [];
		const text = mermaidLabelLines(e.label).join(' ');
		const w = text.length * fs * 0.55 + 10;
		const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
		return [{ text, box: { x: mid.x - w / 2, y: mid.y - fs * 0.75, width: w, height: fs * 1.5 }, color: resolveMermaidStyles(e.classes, e.styles, graph.classDefs).color }];
	});
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const grow = (b: Box) => {
		minX = Math.min(minX, b.x);
		minY = Math.min(minY, b.y);
		maxX = Math.max(maxX, b.x + b.width);
		maxY = Math.max(maxY, b.y + b.height);
	};
	for (const t of [...tiles, ...blocks]) grow(iso.box(t.box).bounds);
	for (const l of edgeLabels) grow(l.box);
	if (minX === Infinity) minX = minY = maxX = maxY = 0;
	const naturalWidth = Math.max(1, Math.ceil(maxX - minX + pad * 2));
	const naturalHeight = Math.max(1, Math.ceil(maxY - minY + pad * 2));
	const fit = Math.min(1, (options.maxWidth ?? Infinity) / naturalWidth, (options.maxHeight ?? Infinity) / naturalHeight);
	const width = Math.max(1, Math.round(naturalWidth * fit));
	const height = Math.max(1, Math.round(naturalHeight * fit));
	const title = options.title ?? graph.title ?? `${doc.family} diagram`;
	const out: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${naturalWidth} ${naturalHeight}" role="img" aria-label="${esc(title)}" font-family="${esc(theme.fontFamily)}" font-size="${fs}">`,
		`<title>${esc(title)}</title>`
	];
	if (!options.transparent) out.push(`<rect width="${naturalWidth}" height="${naturalHeight}" fill="${esc(theme.background)}"/>`);
	out.push(`<g transform="translate(${n(pad - minX)} ${n(pad - minY)})">`);
	const solid = (fill: string, stroke: string) => ({ ...isoFaceColors(fill), stroke });
	const drawBox = (attr: string, box: IsoBox, paint: { top: string; left: string; right: string; stroke: string }) => {
		const f = iso.box(box);
		out.push(`<g ${attr}>`);
		if (f.d.left) out.push(`<path d="${f.d.left}" fill="${esc(paint.left)}" stroke="${esc(paint.stroke)}" stroke-width="1" stroke-linejoin="round"/>`);
		if (f.d.right) out.push(`<path d="${f.d.right}" fill="${esc(paint.right)}" stroke="${esc(paint.stroke)}" stroke-width="1" stroke-linejoin="round"/>`);
		out.push(`<path d="${f.d.top}" fill="${esc(paint.top)}" stroke="${esc(paint.stroke)}" stroke-width="1" stroke-linejoin="round"/>`);
	};
	// Group tiles, back to front, with their names on the floor.
	for (const idx of isoOrder(tiles.map((t) => t.box), iso)) {
		const { g, box } = tiles[idx];
		const st = resolveMermaidStyles(g.classes, g.styles, graph.classDefs);
		drawBox(`data-group="${esc(g.id)}"`, box, solid(st.fill ?? theme.groupFill, st.stroke ?? theme.groupStroke));
		const at = iso.point(box.i0 + 10, box.j0 + 14, box.k1);
		out.push(`<text x="${n(at.x)}" y="${n(at.y)}" fill="${esc(st.color ?? theme.groupText)}" font-size="${fs - 1}" font-weight="600">${esc(mermaidLabelLines(g.label).join(' '))}</text></g>`);
	}
	// Edges along the floor, under the blocks.
	for (const { e, a, b } of edges) {
		const st = resolveMermaidStyles(e.classes, e.styles, graph.classDefs);
		const dash = mermaidEdgeDash(e.pattern);
		out.push(`<line data-edge="${esc(e.id)}" x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${esc(st.stroke ?? theme.edge)}" stroke-width="${e.pattern === 'thick' ? 3 : 1.5}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
	}
	// Blocks, back to front, each labelled on its top face.
	for (const idx of isoOrder(blocks.map((b) => b.box), iso)) {
		const { node, box } = blocks[idx];
		const st = resolveMermaidStyles(node.classes, node.styles, graph.classDefs);
		drawBox(`data-node="${esc(node.id)}"`, box, solid(st.fill ?? theme.nodeFill, st.stroke ?? theme.nodeStroke));
		const top = iso.point((box.i0 + box.i1) / 2, (box.j0 + box.j1) / 2, box.k1);
		const lines = mermaidLabelLines(node.label).filter((l, i, all) => l || all.length === 1);
		const lh = fs * 1.3;
		lines.forEach((line, i) => out.push(`<text x="${n(top.x)}" y="${n(top.y - ((lines.length - 1) * lh) / 2 + lh * i)}" text-anchor="middle" dominant-baseline="central" fill="${esc(st.color ?? theme.text)}">${esc(line)}</text>`));
		out.push('</g>');
	}
	for (const l of edgeLabels) {
		out.push(
			`<rect x="${n(l.box.x)}" y="${n(l.box.y)}" width="${n(l.box.width)}" height="${n(l.box.height)}" rx="3" fill="${esc(theme.edgeLabelBackground)}"/>`,
			`<text x="${n(l.box.x + l.box.width / 2)}" y="${n(l.box.y + l.box.height / 2)}" text-anchor="middle" dominant-baseline="central" fill="${esc(l.color ?? theme.text)}" font-size="${fs - 1}">${esc(l.text)}</text>`
		);
	}
	out.push('</g></svg>');
	return { svg: out.join(''), width, height, naturalWidth, naturalHeight };
}

/** A small preview of a diagram: `mermaidToSvg` fitted inside `maxWidth` × `maxHeight` (default 240 × 160). */
export function mermaidThumbnailSvg(doc: MermaidDocument, options: DiagramSvgOptions = {}): DiagramSvg {
	return mermaidToSvg(doc, { maxWidth: 240, maxHeight: 160, padding: 8, ...options });
}

/** Longest side, in pixels, of a rasterized diagram unless `maxSize` says otherwise. */
export const DIAGRAM_RASTER_MAX_SIZE = 2048;

export interface RasterizeSvgOptions {
	/** Size of the SVG in CSS pixels. */
	width: number;
	height: number;
	/** Pixels per CSS pixel (default 2), reduced so the longest side stays within `maxSize`. */
	scale?: number;
	/** Longest side of the image in pixels (default 2048). */
	maxSize?: number;
	/** Fill behind the drawing (default white; `transparent` keeps the alpha channel). */
	background?: string;
	/** Document to create the canvas and image in (default: the global one). */
	document?: Document;
}

export interface RasterImage {
	/** Base64 PNG, without the `data:` prefix. */
	data: string;
	mimeType: 'image/png';
	width: number;
	height: number;
}

/** Pixel size of the image for an SVG of `width` × `height`: `scale` × the size, longest side ≤ `maxSize`. */
export function rasterSize(width: number, height: number, scale = 2, maxSize = DIAGRAM_RASTER_MAX_SIZE): { width: number; height: number; scale: number } {
	if (!(width > 0) || !(height > 0)) throw new Error(`An image needs a positive width and height; got ${width} × ${height}.`);
	const factor = Math.min(scale > 0 ? scale : 1, maxSize / Math.max(width, height));
	return { width: Math.max(1, Math.round(width * factor)), height: Math.max(1, Math.round(height * factor)), scale: factor };
}

const NO_DOM =
	'Rasterizing needs a browser DOM (document, Image and a 2D canvas). Outside a browser, use the SVG (mermaidToSvg, or render_diagram with format "svg") with an SVG renderer.';

/**
 * Turns a standalone SVG (e.g. `mermaidToSvg(...).svg`) into a PNG in the browser: draws it
 * through an `Image` onto a canvas at `scale` (longest side ≤ `maxSize`) over `background`.
 * The SVG must use concrete colours (CSS variables do not apply inside an image). Throws a
 * sentence saying what to do instead when there is no DOM.
 */
export async function rasterizeSvg(svg: string, options: RasterizeSvgOptions): Promise<RasterImage> {
	const doc = options.document ?? (globalThis as { document?: Document }).document;
	const ImageCtor = (doc?.defaultView as (Window & typeof globalThis) | null | undefined)?.Image ?? (globalThis as { Image?: typeof Image }).Image;
	if (!doc || typeof doc.createElement !== 'function' || !ImageCtor) throw new Error(NO_DOM);
	const size = rasterSize(options.width, options.height, options.scale, options.maxSize);
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
	const image = new ImageCtor();
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () => reject(new Error('The SVG could not be loaded as an image; check that it is a complete <svg> document with the SVG namespace.'));
		image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	});
	const background = options.background ?? '#ffffff';
	if (background !== 'transparent') {
		context.fillStyle = background;
		context.fillRect(0, 0, size.width, size.height);
	}
	context.drawImage(image, 0, 0, size.width, size.height);
	const url = canvas.toDataURL('image/png');
	if (!url.startsWith('data:image/png')) throw new Error('This canvas cannot export PNG (toDataURL returned no image).');
	return { data: url.slice(url.indexOf(',') + 1), mimeType: 'image/png', width: size.width, height: size.height };
}

/** A file name for a diagram: its title in lower case with dashes, else its family, plus the extension. */
export function diagramFileName(doc: Pick<MermaidDocument, 'family' | 'graph'>, extension: string): string {
	const base = (doc.graph.title ?? '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return `${base || `${doc.family}-diagram`}.${extension}`;
}

export interface DownloadDiagramPngOptions extends DiagramSvgOptions, Omit<RasterizeSvgOptions, 'width' | 'height'> {
	/** File name (default: the diagram title, else `<family>-diagram`, plus `.png`). */
	filename?: string;
}

/** Renders a diagram to PNG and saves it through a download link. Returns the image and file name. */
export async function downloadDiagramPng(doc: MermaidDocument, options: DownloadDiagramPngOptions = {}): Promise<RasterImage & { filename: string }> {
	const drawn = mermaidToSvg(doc, options);
	const background = options.background ?? (options.transparent ? 'transparent' : (options.theme?.background ?? DIAGRAM_SVG_LIGHT_THEME.background));
	const image = await rasterizeSvg(drawn.svg, { ...options, width: drawn.width, height: drawn.height, background });
	const filename = options.filename ?? diagramFileName(doc, 'png');
	const page = options.document ?? document;
	const link = page.createElement('a');
	link.href = `data:image/png;base64,${image.data}`;
	link.download = filename;
	page.body.appendChild(link);
	link.click();
	link.remove();
	return { ...image, filename };
}
