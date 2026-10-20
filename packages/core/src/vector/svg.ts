/**
 * SVG export and import for vector documents. Import is DOM-free (works in Node and
 * workers): it reads `<svg>`, `<g>`, `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`,
 * `<polyline>`, `<polygon>`, linear / radial gradients, presentation attributes, `style`
 * declarations, `transform`s, `clip-path` and `mask` references (each becomes a mask group, the
 * clip or mask its first child). Text, images, foreign filters and `<use>` are skipped.
 *
 * Live corners export as their cut outline plus `data-vector-d` (the sharp path) and
 * `data-vector-corners` (the radii), so the editor's own SVG imports with editable corners.
 * Inside / outside strokes, which SVG cannot express, export (after vectorcraft
 * `crates/svg/src/lib.rs`, MIT OR Apache-2.0) as a `<g data-vector-path>` holding the fill, a
 * stroke of twice the width clipped to the shape (inside) or masked by it (outside), and the
 * arrowheads as filled outlines; import merges such a group back into one path. A variable-width
 * stroke exports as its filled outline (`data-vector-part="stroke-outline"`) with the profile
 * and line style kept in `data-vector-width-profile` / `data-vector-stroke-*` attributes.
 *
 * A mask group exports as a `<g data-vector-mask>` (the settings as JSON) carrying the group's
 * transform, opacity, blend mode and filter, around a `<g data-vector-part="masked">` with the
 * contents and `clip-path` / `mask`, so the group's appearance applies to the masked result. A
 * clip's `<clipPath>` holds the mask's outlines; for import, the mask itself is kept in a hidden
 * `<g data-vector-part="mask-source">`. An opacity mask's `<mask>` holds the mask as drawn.
 */
import { bezierPathToSvg } from '../canvas/pathops/bezier.js';
import { bezierPathBounds, transformBezierPath } from '../canvas/pathops/bezier.js';
import { invertMatrix } from '../geom/affine.js';
import { isVectorFrame, sanitizeVectorFrame, sanitizeVectorResizing, vectorFrameRectPath, type VectorFrameGroup } from './frames.js';
import type { VectorConnector, VectorLens, VectorResizing } from './types.js';
import { sanitizeVectorConnector } from './connectors.js';
import { isVectorLens, resolveVectorLenses, sanitizeVectorLens, vectorLensDrawn } from './lens.js';
import { sanitizeVectorSymmetry, transformVectorSymmetry } from './symmetry.js';
import { isVectorShadedPaint, sanitizeVectorShadedPaint, vectorShadedSvgDefs } from './shading.js';

/** `v` rounded to a whole number when within 1e-9 of one. */
const tidy = (v: number) => (Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) + 0 : v);

/** JSON from an attribute, or null when it does not parse. */
const parseJson = (text: string | undefined): unknown => {
	if (text === undefined) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};
import { hasStrokeExtras, strokeWidthProfileOf, vectorStrokeLineArea, vectorStrokeOutlinePath, vectorStrokeParts, vectorStrokeReach } from './stroke.js';
import { sanitizeWidthProfile } from './width.js';
import { expandVectorAppearance, hasOwnVectorAppearance, sanitizeVectorEffects, transformVectorEffects, vectorAppearanceNodes, vectorInstanceDrawn } from './appearance.js';
import { resolveVectorSymbols } from './symbols.js';
import { isVectorMaskGroup, sanitizeVectorMask, vectorMaskRenderData } from './mask.js';
import { sanitizeVectorTextFields, vectorTextGeometryNode, vectorTextPaths, vectorTextSpans, vectorTextSpanSvg } from './text.js';
import { activeVectorFilters, sanitizeVectorFilters, vectorFilterMarkup, vectorFilterSvg, type VectorRenderFilter } from './filters.js';
import {
	needsVectorPaintLayers,
	vectorFills,
	vectorStrokes,
	sanitizeVectorFills,
	sanitizeVectorStrokes,
	vectorBlendModeCss,
	vectorBlendModeFromCss,
	vectorPaintLayerNodes,
	vectorStrokeStackReach,
	normalizeVectorPaintStacks,
	withVectorFills,
	withVectorStrokes,
	hasVectorPaintStacks,
	vectorStrokeSettings
} from './paintLayers.js';
import { angleToSvgLinearCoords, type SvgGradientDef } from '../canvas/gradient.js';
import { bezierPathBounds as pathBounds } from '../canvas/pathops/bezier.js';
import { isVectorGradient, sanitizeVectorGradient, vectorGradientSvgDefs, type VectorPaintDef } from './gradient.js';
import { vectorStrokeGradientDefs } from './gradientStroke.js';
import { formatNumber } from '../canvas/shapeGeometry.js';
import {
	bezierToSubpaths,
	decomposeRigid,
	ellipseSubpath,
	hasPaint,
	IDENTITY_MATRIX,
	isIdentityMatrix,
	lineSubpath,
	multiplyMatrices,
	rectSubpath,
	rotateMatrix,
	scaleMatrix,
	subpathsToBezier,
	transformVectorNode,
	translateMatrix,
	vectorPathData,
	unionBounds,
	vectorNodeBounds,
	type AffineMatrix
} from './geometry.js';
import {
	VECTOR_ARROWHEADS,
	VECTOR_CORNER_KINDS,
	type VectorArrowhead,
	type VectorBlend,
	type VectorBooleanOperation,
	type VectorCornerKind,
	type VectorDocument,
	type VectorFilter,
	type VectorFillRule,
	type VectorGradient,
	type VectorGradientStop,
	type VectorGroupNode,
	type VectorEffect,
	type VectorLineCap,
	type VectorLineJoin,
	type VectorWidthPoint,
	type VectorNode,
	type VectorPaint,
	type VectorBounds,
	type VectorPathNode,
	type VectorPaintLayer,
	type VectorStrokeAlign,
	type VectorSubpath,
	type VectorSymbol,
	type VectorInstanceNode,
	type VectorTextNode
} from './types.js';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface VectorSvgExportOptions {
	/** Decimal places for coordinates (default 3). */
	precision?: number;
	/** Draw `document.background` as a full-size rect (default true). */
	background?: boolean;
	/** Include hidden nodes with `display="none"` instead of leaving them out (default false). */
	includeHidden?: boolean;
	/** Prefix for gradient ids (default `vg-`), to keep ids unique when several SVGs share a page. */
	idPrefix?: string;
	/** Indent nested elements (default true). */
	pretty?: boolean;
	/**
	 * How strokes with an inside / outside alignment or arrowheads are written: `clip` (default)
	 * as a double-width stroke clipped or masked by the shape plus filled heads, `outline` as
	 * one filled path of the area the stroke paints.
	 */
	strokes?: 'clip' | 'outline';
	/**
	 * Groups to write round nodes, by node id, outermost first: to move a node from outside it
	 * or clip it (the animation editor's reveals and its Flair export use this).
	 */
	wrap?: Readonly<Record<string, readonly VectorSvgWrapper[]>>;
	/**
	 * How text is written: `text` (default) as SVG `<text>` placed character by character, or
	 * `outlines` as its glyph outlines (needs an outline shaper; otherwise text stays text). Text with
	 * path effects is always written as outlines when it has them. Either way the text is kept for
	 * import.
	 */
	text?: 'text' | 'outlines';
}

/** A group written round a node (see `VectorSvgExportOptions.wrap`). */
export interface VectorSvgWrapper {
	id?: string;
	/** An SVG `transform` attribute. */
	transform?: string;
	/**
	 * Clips the group through a rect (`x`, `y`, `width`, `height`) or circle (`cx`, `cy`, `r`) in
	 * the units of the group's own box (`clipPathUnits="objectBoundingBox"`: 0–1 across it).
	 */
	clip?: { id: string; shape: 'rect' | 'circle'; shapeId?: string; attrs: Readonly<Record<string, number>> };
}

/** `data-vector-corners`: the live corners of subpaths as `subpath.index:radius[:kind]`, space separated. */
export function vectorCornersAttribute(subpaths: readonly VectorSubpath[], precision = 3): string {
	const out: string[] = [];
	subpaths.forEach((sp, s) =>
		sp.anchors.forEach((a, i) => {
			if (!a.corner || !(a.corner.radius > 0)) return;
			out.push(`${s}.${i}:${formatNumber(a.corner.radius, precision)}${a.corner.kind && a.corner.kind !== 'round' ? `:${a.corner.kind}` : ''}`);
		})
	);
	return out.join(' ');
}

/** Puts `data-vector-corners` back on subpaths (malformed entries are ignored). */
export function applyVectorCornersAttribute(subpaths: VectorSubpath[], value: string): VectorSubpath[] {
	for (const item of value.trim().split(/\s+/)) {
		const m = /^(\d+)\.(\d+):([\d.eE+-]+)(?::([a-z]+))?$/.exec(item);
		if (!m) continue;
		const a = subpaths[+m[1]]?.anchors[+m[2]];
		const radius = parseFloat(m[3]);
		if (!a || !(radius > 0)) continue;
		const kind = VECTOR_CORNER_KINDS.includes(m[4] as VectorCornerKind) ? (m[4] as VectorCornerKind) : undefined;
		a.corner = { radius, ...(kind && kind !== 'round' ? { kind } : {}) };
	}
	return subpaths;
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Where a paint goes: what `vectorPaintToSvg` needs to place a gradient on a shape. */
export interface VectorPaintSvgOptions {
	/** The path painted (its box places `objectBoundingBox` gradients; strokes need its geometry). */
	node?: VectorPathNode;
	/** `stroke` lays `along` / `across` gradients on the stroke and covers its reach (default `fill`). */
	role?: 'fill' | 'stroke';
	precision?: number;
}

/** The box of a path's drawn outline in its own space (null when it has no points). */
export function vectorPathLocalBounds(node: VectorPathNode): VectorBounds | null {
	const b = pathBounds(subpathsToBezier(node.subpaths));
	return b ? { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY } : null;
}

/** Paint defs are recomputed only when the node (or the id / role asked for) changes. */
const paintCache = new WeakMap<object, Map<string, VectorPaintDef[]>>();

/**
 * A paint as an SVG attribute value plus the paint servers it needs (`url(#id)` refers to the
 * first). Gradients sit in the painted element's user space (the node's own space).
 */
export function vectorPaintToSvg(paint: VectorPaint | undefined, gradientId: string, options: VectorPaintSvgOptions = {}): { value: string; defs: VectorPaintDef[] } {
	if (!hasPaint(paint)) return { value: 'none', defs: [] };
	if (typeof paint === 'string') return { value: paint, defs: [] };
	if (isVectorShadedPaint(paint)) {
		// Meshes and freeform gradients: a pattern of flat tiles over the shape (cached per paint and box).
		const node = options.node;
		const bounds = node ? vectorPathLocalBounds(node) : null;
		const reach = node && options.role === 'stroke' ? vectorStrokeReach(node) + 1 : 1;
		const area = bounds ? { x: bounds.x - reach, y: bounds.y - reach, width: bounds.width + 2 * reach, height: bounds.height + 2 * reach } : null;
		const key = `${gradientId}|${options.role ?? 'fill'}|${options.precision ?? 3}|${area ? [area.x, area.y, area.width, area.height].join(',') : ''}`;
		let byKey = paintCache.get(paint);
		const hit = byKey?.get(key);
		if (hit) return { value: `url(#${gradientId})`, defs: hit };
		const defs = vectorShadedSvgDefs(paint, gradientId, { bounds, area, precision: options.precision ?? 3 });
		if (!byKey) paintCache.set(paint, (byKey = new Map()));
		byKey.set(key, defs);
		return { value: `url(#${gradientId})`, defs };
	}
	if (!isVectorGradient(paint)) return { value: 'none', defs: [] };
	const role = options.role ?? 'fill';
	const precision = options.precision ?? 3;
	const key = `${gradientId}|${role}|${precision}`;
	const owner: object = options.node ?? paint;
	const cached = paintCache.get(owner)?.get(key);
	if (cached && (!options.node || (role === 'fill' ? options.node.fill : options.node.stroke) === paint)) return { value: `url(#${gradientId})`, defs: cached };
	const node = options.node;
	const bounds = node ? vectorPathLocalBounds(node) : null;
	const reach = node && role === 'stroke' ? vectorStrokeReach(node) + 1 : 1;
	const area = bounds ? { x: bounds.x - reach, y: bounds.y - reach, width: bounds.width + 2 * reach, height: bounds.height + 2 * reach } : null;
	const defs =
		node && role === 'stroke' && (paint.strokeMode === 'along' || paint.strokeMode === 'across')
			? vectorStrokeGradientDefs(paint, gradientId, node, { bounds, area, precision })
			: vectorGradientSvgDefs(paint, gradientId, { bounds, area, precision });
	let byKey = paintCache.get(owner);
	if (!byKey) paintCache.set(owner, (byKey = new Map()));
	byKey.set(key, defs);
	return { value: `url(#${gradientId})`, defs };
}

/** The parts of an aligned or arrowed stroke (see `VectorRenderPath.strokeParts`). */
export interface VectorRenderStrokeParts {
	align: VectorStrokeAlign;
	/** The line the stroke follows (shortened under `tip`-aligned heads). */
	d: string;
	/** Width to draw it with: twice the stroke width when aligned, half of it being clipped away. */
	width: number;
	/**
	 * A variable-width stroke: the area to fill with `stroke` (nonzero) instead of stroking `d`,
	 * clipped or masked like the stroke would be.
	 */
	outline?: string;
	/**
	 * Inside: a `<clipPath id>` holding the shape (`d`, `clip-rule` = `fillRule`). Outside: a
	 * `<mask id>` in user space over `bounds`, white with the shape (`d`) in black.
	 */
	clip: { kind: 'clip' | 'mask'; id: string; bounds: VectorBounds } | null;
	/** Arrowhead outlines (fill with `stroke`, nonzero). */
	heads: string[];
}

/** Stroke parts are recomputed only when the node (or the id / precision asked for) changes. */
const partsCache = new WeakMap<VectorPathNode, { clipId: string; precision: number; parts: VectorRenderStrokeParts | undefined }>();

/** The stroke parts of a path whose stroke needs more than one element, in its own space (undefined otherwise). */
export function vectorStrokeSvgParts(node: VectorPathNode, clipId: string, precision = 3): VectorRenderStrokeParts | undefined {
	if (!hasPaint(node.stroke) || !hasStrokeExtras(node)) return undefined;
	const hit = partsCache.get(node);
	if (hit && hit.clipId === clipId && hit.precision === precision) return hit.parts;
	const parts = computeStrokeSvgParts(node, clipId, precision);
	partsCache.set(node, { clipId, precision, parts });
	return parts;
}

function computeStrokeSvgParts(node: VectorPathNode, clipId: string, precision: number): VectorRenderStrokeParts | undefined {
	const path = subpathsToBezier(node.subpaths);
	const parts = vectorStrokeParts(path, node);
	const profiled = !!strokeWidthProfileOf(node);
	if (parts.align === 'center' && !parts.heads.length && !profiled) return undefined;
	let clip: VectorRenderStrokeParts['clip'] = null;
	if (parts.align !== 'center') {
		const b = bezierPathBounds(path);
		const pad = vectorStrokeReach(node) + 1;
		const bounds = b ? { x: round2(b.minX - pad), y: round2(b.minY - pad), width: round2(b.maxX - b.minX + 2 * pad), height: round2(b.maxY - b.minY + 2 * pad) } : { x: 0, y: 0, width: 0, height: 0 };
		clip = { kind: parts.align === 'inside' ? 'clip' : 'mask', id: clipId, bounds };
	}
	return {
		align: parts.align,
		d: bezierPathToSvg(parts.line, { precision }),
		width: parts.drawWidth,
		...(profiled && (node.strokeWidth ?? 1) > 0 ? { outline: bezierPathToSvg(vectorStrokeLineArea(parts, node), { precision }) } : {}),
		clip,
		heads: parts.heads.map((h) => bezierPathToSvg(h.path, { precision }))
	};
}

/**
 * The box a node draws over in its own space (its `transform` not applied): its geometry as drawn
 * (effects applied), padded by how far its strokes reach. Null when it draws nothing.
 */
export function vectorNodeLocalPaintBounds(node: VectorNode): VectorBounds | null {
	const drawn = expandVectorAppearance(node);
	const reach = (n: VectorNode): number => (n.type === 'path' ? vectorStrokeStackReach(n) : n.type === 'text' || n.type === 'instance' ? reach(expandVectorAppearance(n)) : Math.max(0, ...n.children.map(reach)));
	let b: VectorBounds | null;
	if (drawn.type === 'path') b = vectorPathLocalBounds(drawn);
	else b = unionBounds(drawn.children.filter((c) => c.visible !== false).map((c) => vectorNodeBounds(c, IDENTITY_MATRIX)));
	if (!b) return null;
	const pad = reach(drawn);
	return { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
}

const filterCache = new WeakMap<VectorNode, { id: string; filter: VectorRenderFilter | null }>();

/** A node's filter (`node.filters`) as render data with id `id`, or null when none draws. Cached per node. */
export function vectorNodeFilterSvg(node: VectorNode, id: string): VectorRenderFilter | null {
	if (!node.filters?.length) return null;
	const hit = filterCache.get(node);
	if (hit && hit.id === id) return hit.filter;
	const active = activeVectorFilters(node);
	const filter = active.length ? vectorFilterSvg(active, id, vectorNodeLocalPaintBounds(node)) : null;
	filterCache.set(node, { id, filter });
	return filter;
}

/** A width profile as a data attribute: `t,left,right` points separated by `;`. */
export function widthProfileToAttribute(points: readonly VectorWidthPoint[], precision = 4): string {
	return points.map((p) => [p.t, p.left, p.right].map((n) => formatNumber(n, precision)).join(',')).join(';');
}

/** Reads `widthProfileToAttribute` output (invalid points are dropped). */
export function widthProfileFromAttribute(value: string | undefined): VectorWidthPoint[] {
	if (!value) return [];
	return sanitizeWidthProfile(
		value.split(';').map((part) => {
			const [t, left, right] = part.split(',').map((n) => parseFloat(n));
			return { t, left, right: Number.isFinite(right) ? right : left };
		})
	);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function gradientMarkup(def: SvgGradientDef, extra = ''): string {
	const tag = def.type === 'radial' ? 'radialGradient' : 'linearGradient';
	const attrs = Object.entries(def.attrs)
		.map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
		.join('');
	const stops = def.stops
		.map((s) => `<stop offset="${s.offset}" stop-color="${escapeAttr(s.stopColor)}"${s.stopOpacity !== undefined ? ` stop-opacity="${s.stopOpacity}"` : ''}/>`)
		.join('');
	return `<${tag} id="${escapeAttr(def.id)}"${attrs}${extra}>${stops}</${tag}>`;
}

/**
 * A paint server's markup. The first def of a gradient carries `data-vector-gradient` (the
 * gradient as JSON, in the node's space) so import restores what SVG cannot say: midpoints,
 * interpolation, smoothness, conic / reflected / diamond styles and stroke modes.
 */
function paintDefMarkup(def: VectorPaintDef, gradient?: VectorGradient): string {
	const extra = gradient ? ` data-vector-gradient="${escapeAttr(JSON.stringify(gradient))}"` : '';
	if (def.type !== 'pattern') return gradientMarkup(def, extra);
	const attrs = Object.entries(def.attrs)
		.map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
		.join('');
	const inner = def.gradients.map((g) => gradientMarkup(g)).join('') + def.tiles.map((t) => `<path d="${t.d}" fill="${escapeAttr(t.fill)}"/>`).join('');
	return `<pattern id="${escapeAttr(def.id)}"${attrs}${extra}>${inner}</pattern>`;
}

/** Markup of a paint's defs (the gradient's data attribute on the first). */
const paintMarkup = (paint: VectorPaint | undefined, defs: readonly VectorPaintDef[]) => defs.map((d, i) => paintDefMarkup(d, i === 0 && isVectorGradient(paint) ? paint : undefined));

/**
 * `data-vector-blend` (a blend group's options as JSON, its spine in the group's space) back to
 * a blend, the spine carried by `m` (import bakes group transforms into the children).
 */
function blendFromAttribute(value: string | undefined, m: AffineMatrix): VectorBlend | null {
	if (!value) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(value);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const out: VectorBlend = {};
	if (r.spacing === 'steps' || r.spacing === 'distance' || r.spacing === 'smoothColor') out.spacing = r.spacing;
	if (typeof r.steps === 'number' && Number.isFinite(r.steps)) out.steps = Math.min(1000, Math.max(1, Math.round(r.steps)));
	if (typeof r.distance === 'number' && r.distance > 0) out.distance = r.distance;
	if (typeof r.orientToSpine === 'boolean') out.orientToSpine = r.orientToSpine;
	if (typeof r.linear === 'boolean') out.linear = r.linear;
	if (r.starts && typeof r.starts === 'object') {
		const starts = Object.fromEntries(Object.entries(r.starts as Record<string, unknown>).filter((e): e is [string, number] => Number.isInteger(e[1]) && (e[1] as number) >= 0));
		if (Object.keys(starts).length) out.starts = starts;
	}
	const spine = r.spine as VectorSubpath | null | undefined;
	if (spine && Array.isArray(spine.anchors) && spine.anchors.every((a) => a && Number.isFinite(a.x) && Number.isFinite(a.y))) {
		const sp: VectorSubpath = { closed: !!spine.closed, anchors: spine.anchors.map((a) => ({ x: a.x, y: a.y, ...(a.in ? { in: { x: a.in.x, y: a.in.y } } : {}), ...(a.out ? { out: { x: a.out.x, y: a.out.y } } : {}) })) };
		out.spine = m === IDENTITY_MATRIX ? sp : transformVectorNode<VectorPathNode>({ id: '', type: 'path', subpaths: [sp] }, m).subpaths[0];
	}
	return out;
}

/** Serializes a vector document as a standalone SVG string. */
export function vectorDocumentToSvg(doc: VectorDocument, options: VectorSvgExportOptions = {}): string {
	// Instances draw their symbol's art: resolve it when the caller's document has not.
	doc = resolveVectorLenses(resolveVectorSymbols(doc));
	const precision = options.precision ?? 3;
	const prefix = options.idPrefix ?? 'vg-';
	const pretty = options.pretty !== false;
	const defs: string[] = [];
	const lines: string[] = [];
	const num = (n: number) => formatNumber(n, precision);
	const indent = (depth: number) => (pretty ? '  '.repeat(depth) : '');

	const common = (node: VectorNode) => {
		let out = ` id="${escapeAttr(node.id)}"`;
		if (node.transform) out += ` transform="matrix(${node.transform.map((n) => formatNumber(n, 6)).join(' ')})"`;
		if (node.opacity !== undefined && node.opacity < 1) out += ` opacity="${num(node.opacity)}"`;
		if (node.visible === false) out += ` display="none"`;
		if (node.blendStep) out += ` data-vector-blend-step=""`;
		if (node.type === 'group' && node.blend) out += ` data-vector-blend="${escapeAttr(JSON.stringify(node.blend))}"`;
		if (node.booleanOperation) out += ` data-vector-boolean-operation="${node.booleanOperation}"`;
		if (node.resizing) out += ` data-vector-resizing="${escapeAttr(JSON.stringify(node.resizing))}"`;
		if (node.type === 'path' && isVectorShadedPaint(node.fill)) out += ` data-vector-shading="${escapeAttr(JSON.stringify(node.fill))}"`;
		if (node.type === 'path' && node.connector) out += ` data-vector-connector="${escapeAttr(JSON.stringify(node.connector))}"`;
		if (node.type === 'path' && node.lens) out += ` data-vector-lens="${escapeAttr(JSON.stringify(node.lens))}"`;
		const blend = vectorBlendModeCss(node.blendMode);
		if (blend) out += ` style="mix-blend-mode:${blend}"`;
		if (node.filters?.length) {
			// The filter as drawn, carrying the filter stack (JSON) for import.
			const filter = vectorNodeFilterSvg(node, `${prefix}filter-${node.id}`);
			const data = ` data-vector-filters="${escapeAttr(JSON.stringify(node.filters))}"`;
			if (filter) {
				defs.push(vectorFilterMarkup(filter, data));
				out += ` filter="url(#${escapeAttr(filter.id)})"`;
			} else out += data;
		}
		return out;
	};

	/** Opacity and blend mode of one paint layer, as attributes. */
	const layerAttrs = (layer: { opacity?: number; blendMode?: VectorPaintLayer['blendMode'] }) => {
		let out = '';
		if (layer.opacity !== undefined && layer.opacity < 1) out += ` opacity="${num(layer.opacity)}"`;
		const blend = vectorBlendModeCss(layer.blendMode);
		if (blend) out += ` style="mix-blend-mode:${blend}"`;
		return out;
	};

	/**
	 * The elements of a stroke drawn in parts (aligned, arrowed or profiled): the stroke (or its
	 * outline) clipped or masked by the shape, then the heads. `d` is the shape's path data.
	 */
	const strokePartLines = (node: VectorPathNode, parts: VectorRenderStrokeParts, strokeValue: string, d: string, lineAttrs: (width: number) => string, depth: number): string[] => {
		const out: string[] = [];
		if (options.strokes === 'outline') {
			const area = bezierPathToSvg(vectorStrokeOutlinePath(subpathsToBezier(node.subpaths), node), { precision });
			out.push(`${indent(depth)}<path data-vector-part="stroke-outline" d="${area}" fill="${escapeAttr(strokeValue)}"/>`);
			return out;
		}
		let clip = '';
		if (parts.clip) {
			const rule = node.fillRule === 'evenodd' ? 'evenodd' : 'nonzero';
			const id = escapeAttr(parts.clip.id);
			if (parts.clip.kind === 'clip') {
				defs.push(`<clipPath id="${id}"><path d="${d}" clip-rule="${rule}"/></clipPath>`);
				clip = ` clip-path="url(#${id})"`;
			} else {
				const b = parts.clip.bounds;
				const box = `x="${num(b.x)}" y="${num(b.y)}" width="${num(b.width)}" height="${num(b.height)}"`;
				defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse" ${box}><rect ${box} fill="#fff"/><path d="${d}" fill="#000" fill-rule="${rule}"/></mask>`);
				clip = ` mask="url(#${id})"`;
			}
		}
		if (parts.outline !== undefined) out.push(`${indent(depth)}<path data-vector-part="stroke-outline" d="${parts.outline}" fill="${escapeAttr(strokeValue)}"${clip}/>`);
		else out.push(`${indent(depth)}<path data-vector-part="stroke" d="${parts.d}" fill="none"${lineAttrs(parts.width)}${clip}/>`);
		for (const h of parts.heads) out.push(`${indent(depth)}<path data-vector-part="head" d="${h}" fill="${escapeAttr(strokeValue)}"/>`);
		return out;
	};

	/** SVG line attributes of a (layer) node's stroke. */
	const lineAttrsOf = (node: VectorPathNode, strokeValue: string) => (width: number) => {
		let out = ` stroke="${escapeAttr(strokeValue)}" stroke-width="${num(width)}"`;
		if (node.strokeLinecap && node.strokeLinecap !== 'butt') out += ` stroke-linecap="${node.strokeLinecap}"`;
		if (node.strokeLinejoin && node.strokeLinejoin !== 'miter') out += ` stroke-linejoin="${node.strokeLinejoin}"`;
		if (node.strokeDasharray?.length) out += ` stroke-dasharray="${node.strokeDasharray.map(num).join(' ')}"`;
		return out;
	};

	/** `data-vector-d` / `data-vector-corners` of a path with live corners ('' without). */
	const liveCorners = (node: VectorPathNode) => {
		const corners = vectorCornersAttribute(node.subpaths, precision);
		return corners ? ` data-vector-d="${bezierPathToSvg(subpathsToBezier(node.subpaths, { corners: false }), { precision })}" data-vector-corners="${corners}"` : '';
	};

	/**
	 * A path painted through its stacks: a `<g data-vector-path>` carrying the stacks (JSON, for
	 * import), holding each drawn layer bottom to top. The first part is a fill part with the
	 * geometry (unpainted when no fill is drawn).
	 */
	const emitStacked = (node: VectorPathNode, depth: number) => {
		const d = vectorPathData(node, precision);
		const rule = node.fillRule === 'evenodd' ? ` fill-rule="evenodd"` : '';
		let data = ` data-vector-path="" data-vector-fills="${escapeAttr(JSON.stringify(vectorFills(node)))}" data-vector-strokes="${escapeAttr(JSON.stringify(vectorStrokes(node)))}"`;
		if (node.fillRule === 'evenodd') data += ` data-vector-fill-rule="evenodd"`;
		lines.push(`${indent(depth)}<g${common(node)}${data}>`);
		const layers = vectorPaintLayerNodes(node).filter((l) => l.drawn);
		let geometry = liveCorners(node);
		if (!layers.some((l) => l.kind === 'fill')) {
			lines.push(`${indent(depth + 1)}<path data-vector-part="fill" d="${d}" fill="none"${rule}${geometry}/>`);
			geometry = '';
		}
		for (const l of layers) {
			const id = `${prefix}${l.kind}-${node.id}-${l.index}`;
			const paint = vectorPaintToSvg(l.layer.paint, id, { node: l.node, precision, ...(l.kind === 'stroke' ? { role: 'stroke' as const } : {}) });
			defs.push(...paintMarkup(l.layer.paint, paint.defs));
			const attrs = ` data-vector-layer="${l.index}"${layerAttrs(l.layer)}`;
			if (l.kind === 'fill') {
				lines.push(`${indent(depth + 1)}<path data-vector-part="fill"${attrs} d="${d}" fill="${escapeAttr(paint.value)}"${rule}${geometry}/>`);
				geometry = '';
				continue;
			}
			const lineAttrs = lineAttrsOf(l.node, paint.value);
			const parts = vectorStrokeSvgParts(l.node, `${prefix}clip-${node.id}-${l.index}`, precision);
			if (!parts) {
				lines.push(`${indent(depth + 1)}<path data-vector-part="stroke"${attrs} d="${d}" fill="none"${lineAttrs(l.node.strokeWidth ?? 1)}/>`);
				continue;
			}
			lines.push(`${indent(depth + 1)}<g data-vector-part="stroke-layer"${attrs}>`);
			lines.push(...strokePartLines(l.node, parts, paint.value, d, lineAttrs, depth + 2));
			lines.push(`${indent(depth + 1)}</g>`);
		}
		lines.push(`${indent(depth)}</g>`);
	};

	const emit = (node: VectorNode, depth: number) => {
		if (node.visible === false && !options.includeHidden) return;
		const wrappers = options.wrap?.[node.id] ?? [];
		wrappers.forEach((w, i) => {
			let attrs = w.id !== undefined ? ` id="${escapeAttr(w.id)}"` : '';
			if (w.transform) attrs += ` transform="${escapeAttr(w.transform)}"`;
			if (w.clip) {
				const shape = Object.entries(w.clip.attrs).map(([k, v]) => ` ${k}="${formatNumber(v, 4)}"`).join('');
				defs.push(`<clipPath id="${escapeAttr(w.clip.id)}" clipPathUnits="objectBoundingBox"><${w.clip.shape}${w.clip.shapeId !== undefined ? ` id="${escapeAttr(w.clip.shapeId)}"` : ''}${shape}/></clipPath>`);
				attrs += ` clip-path="url(#${escapeAttr(w.clip.id)})"`;
			}
			lines.push(`${indent(depth + i)}<g${attrs}>`);
		});
		emitNode(node, depth + wrappers.length);
		for (let i = wrappers.length - 1; i >= 0; i--) lines.push(`${indent(depth + i)}</g>`);
	};

	/** The lines `fn` emits, taken out of the document (for markup that goes into `defs`). */
	const capture = (fn: () => void): string => {
		const at = lines.length;
		fn();
		return lines.splice(at).map((l) => l.trim()).join('');
	};

	/**
	 * A mask group: its appearance on the outer `<g data-vector-mask>`, the contents in an inner
	 * `<g data-vector-part="masked">` that references the `<clipPath>` or `<mask>`. Effects of the
	 * group act on the contents, exported as a live group `<id>~content` around them.
	 */
	const emitMaskGroup = (node: VectorGroupNode & { mask: NonNullable<VectorGroupNode['mask']> }, depth: number) => {
		const [source, ...contents] = node.children;
		const body: VectorNode[] = node.effects?.length && contents.length ? [{ id: `${node.id}~content`, type: 'group', effects: node.effects, children: contents }] : contents;
		const settings = { type: node.mask.type, ...(node.mask.invert ? { invert: true } : {}) };
		lines.push(`${indent(depth)}<g${common(node)} data-vector-mask="${escapeAttr(JSON.stringify(settings))}">`);
		const mask = vectorMaskRenderData(node, `${prefix}mask-${node.id}`, `${prefix}mask-filter-${node.id}`, precision);
		let ref = '';
		if (mask && mask.type !== 'clip') {
			const b = mask.bounds!;
			const box = `x="${num(b.x)}" y="${num(b.y)}" width="${num(b.width)}" height="${num(b.height)}"`;
			if (mask.invertFilter) defs.push(vectorFilterMarkup(mask.invertFilter));
			const inner = capture(() => emitNode(source, depth + 1));
			const drawn = mask.filter ? `<g data-vector-part="mask-invert" filter="${escapeAttr(mask.filter)}">${inner}</g>` : inner;
			defs.push(`<mask id="${escapeAttr(mask.id)}" data-vector-part="mask-source" maskUnits="userSpaceOnUse" ${box}${mask.type === 'alpha' ? ' mask-type="alpha"' : ''}>${drawn}</mask>`);
			ref = ` mask="url(#${escapeAttr(mask.id)})"`;
		} else {
			// The mask itself, hidden, for import (a clip's paint is not drawn; a mask turned off is hidden).
			lines.push(`${indent(depth + 1)}<g data-vector-part="mask-source" display="none">`);
			emitNode(source, depth + 2);
			lines.push(`${indent(depth + 1)}</g>`);
			if (mask?.clip) {
				defs.push(`<clipPath id="${escapeAttr(mask.id)}">${mask.clip.map((c) => `<path d="${c.d}" clip-rule="${c.clipRule}"/>`).join('')}</clipPath>`);
				ref = ` clip-path="url(#${escapeAttr(mask.id)})"`;
			}
		}
		lines.push(`${indent(depth + 1)}<g data-vector-part="masked"${ref}>`);
		for (const child of body) emit(child, depth + 2);
		lines.push(`${indent(depth + 1)}</g>`);
		lines.push(`${indent(depth)}</g>`);
	};

	/**
	 * A text node as SVG text: a `<g data-vector-text>` carrying the text and its stacks (JSON, for
	 * import), holding one `<text>` per drawn paint layer with a `<tspan>` per styled fragment, every
	 * character placed by our layout.
	 */
	const emitTextElement = (node: VectorTextNode, depth: number, attrs: string) => {
		const geometry = vectorTextGeometryNode(node);
		const fields = { text: node.text, font: node.font, ...(node.runs?.length ? { runs: node.runs } : {}), ...(node.paragraph ? { paragraph: node.paragraph } : {}), frame: node.frame, ...(node.effects?.length ? { effects: node.effects } : {}) };
		let data = ` data-vector-text="${escapeAttr(JSON.stringify(fields))}"`;
		if (hasVectorPaintStacks(node)) data += ` data-vector-fills="${escapeAttr(JSON.stringify(vectorFills(node)))}" data-vector-strokes="${escapeAttr(JSON.stringify(vectorStrokes(node)))}"`;
		else {
			data += ` data-vector-fill="${escapeAttr(JSON.stringify(node.fill ?? null))}" data-vector-stroke="${escapeAttr(JSON.stringify(node.stroke ?? null))}"`;
			const settings = vectorStrokeSettings(node);
			if (Object.keys(settings).length) data += ` data-vector-stroke-settings="${escapeAttr(JSON.stringify(settings))}"`;
		}
		lines.push(`${indent(depth)}<g${attrs}${data}>`);
		const nodes = vectorPaintLayerNodes(geometry).filter((l) => l.drawn);
		const topFill = nodes.filter((l) => l.kind === 'fill').at(-1);
		const spans = vectorTextSpans(node).map((sp, i) => {
			if (sp.fill === undefined) return vectorTextSpanSvg(sp);
			const paint = vectorPaintToSvg(sp.fill, `${prefix}run-${node.id}-${i}`, { node: geometry, precision });
			defs.push(...paintMarkup(sp.fill, paint.defs));
			return vectorTextSpanSvg(sp, paint.value);
		});
		const tspans = (runFills: boolean) =>
			spans
				.map((sp) => {
					let a = ` x="${sp.x}" y="${sp.y}"`;
					if (sp.rotate) a += ` rotate="${sp.rotate}"`;
					a += ` font-family="${escapeAttr(sp.fontFamily)}" font-size="${num(sp.fontSize)}"`;
					if (sp.fontWeight !== 400) a += ` font-weight="${sp.fontWeight}"`;
					if (sp.fontStyle) a += ` font-style="italic"`;
					if (sp.textDecoration) a += ` text-decoration="${sp.textDecoration}"`;
					if (runFills && sp.fill) a += ` fill="${escapeAttr(sp.fill)}"`;
					return `<tspan${a}>${escapeText(sp.text)}</tspan>`;
				})
				.join('');
		const layers = nodes.length ? nodes : [];
		if (!topFill && spans.some((sp) => sp.fill)) lines.push(`${indent(depth + 1)}<text data-vector-part="fill" fill="none" xml:space="preserve">${tspans(true)}</text>`);
		for (const l of layers) {
			const id = `${prefix}${l.kind}-${node.id}-${l.index}`;
			const paint = vectorPaintToSvg(l.layer.paint, id, { node: l.node, precision, ...(l.kind === 'stroke' ? { role: 'stroke' as const } : {}) });
			defs.push(...paintMarkup(l.layer.paint, paint.defs));
			const attrs = ` data-vector-part="${l.kind}" data-vector-layer="${l.index}"${layerAttrs(l.layer)}`;
			const paintAttrs = l.kind === 'fill' ? ` fill="${escapeAttr(paint.value)}"` : ` fill="none"${lineAttrsOf(l.node, paint.value)(l.node.strokeWidth ?? 1)}`;
			lines.push(`${indent(depth + 1)}<text${attrs}${paintAttrs} xml:space="preserve">${tspans(l === topFill)}</text>`);
		}
		if (!layers.length && !spans.some((sp) => sp.fill)) lines.push(`${indent(depth + 1)}<text data-vector-part="fill" fill="none" xml:space="preserve">${tspans(false)}</text>`);
		lines.push(`${indent(depth)}</g>`);
	};

	/**
	 * Text: as SVG text, or (with glyph outlines, when it has path effects or `text: 'outlines'`)
	 * as its outlines with the text kept hidden for import, like other live art.
	 */
	const emitText = (node: VectorTextNode, depth: number) => {
		const outlines = vectorTextPaths(node).outlines;
		const effects = !!node.effects?.some((e) => e.enabled !== false);
		if (!outlines || (!effects && options.text !== 'outlines')) {
			emitTextElement(node, depth, common(node));
			return;
		}
		lines.push(`${indent(depth)}<g${common(node)} data-vector-live="${escapeAttr(JSON.stringify({ kind: 'text', ...(node.effects?.length ? { effects: node.effects } : {}) }))}">`);
		lines.push(`${indent(depth + 1)}<g data-vector-part="appearance">`);
		for (const shape of vectorAppearanceNodes(node)) emit(shape, depth + 2);
		lines.push(`${indent(depth + 1)}</g>`);
		lines.push(`${indent(depth + 1)}<g data-vector-part="source" display="none">`);
		const { effects: _e, transform: _t, opacity: _o, visible: _v, booleanOperation: _b, blendStep: _s, blendMode: _bm, filters: _f, ...source } = node;
		emitTextElement({ ...source, id: `${node.id}~src` }, depth + 2, ` id="${escapeAttr(`${node.id}~src`)}"`);
		lines.push(`${indent(depth + 1)}</g>`);
		lines.push(`${indent(depth)}</g>`);
	};

	/** Symbols referenced by `<use>`: written once into `defs` as `<symbol>`. */
	const symbolIds = new Map<string, string>();
	const symbolRef = (symbolId: string): string | null => {
		const hit = symbolIds.get(symbolId);
		if (hit) return hit;
		const sym = doc.symbols?.find((x) => x.id === symbolId);
		if (!sym) return null;
		const id = `${prefix}symbol-${symbolId}`;
		symbolIds.set(symbolId, id);
		const inner = capture(() => sym.nodes.forEach((n) => emit(n, 2)));
		defs.push(`<symbol id="${escapeAttr(id)}" data-vector-symbol="${escapeAttr(JSON.stringify({ id: sym.id, name: sym.name }))}" overflow="visible">${inner}</symbol>`);
		return id;
	};

	/**
	 * An instance: a `<use>` of its symbol through its transform when that draws it exactly, else
	 * its drawn art (overrides, unscaled strokes, effects or filters, which would be placed in the
	 * symbol's space) in a `<g data-vector-instance>` that keeps what import needs.
	 */
	const emitInstance = (node: VectorInstanceNode, depth: number) => {
		const data = { symbolId: node.symbolId, ...(node.scaleStrokes === false ? { scaleStrokes: false } : {}), ...(node.overrides ? { overrides: node.overrides } : {}) };
		const exact = !node.overrides && node.scaleStrokes !== false && !node.effects?.length && !node.filters?.length;
		const ref = symbolRef(node.symbolId);
		if (exact && ref) {
			lines.push(`${indent(depth)}<use${common(node)} href="#${escapeAttr(ref)}" data-vector-instance="${escapeAttr(JSON.stringify(data))}"/>`);
			return;
		}
		const full = { ...data, ...(node.transform ? { transform: node.transform } : {}), ...(node.effects?.length ? { effects: node.effects } : {}) };
		lines.push(`${indent(depth)}<g data-vector-instance="${escapeAttr(JSON.stringify(full))}">`);
		emitNode(vectorInstanceDrawn(node), depth + 1);
		lines.push(`${indent(depth)}</g>`);
	};

	/**
	 * A frame: a `<g data-vector-frame>` (the frame as JSON, with the group's effects, which the
	 * export does not draw) holding its fill (`data-vector-part="frame-fill"`) and its children in a
	 * `<g data-vector-part="frame-contents">` clipped to the frame's rectangle.
	 */
	const emitFrame = (node: VectorFrameGroup, depth: number) => {
		const f = node.frame;
		const data = { ...f, ...(node.effects?.length ? { effects: node.effects } : {}) };
		lines.push(`${indent(depth)}<g${common(node)} data-vector-frame="${escapeAttr(JSON.stringify(data))}">`);
		const rect = vectorFrameRectPath(f);
		if (f.fill !== undefined && f.fill !== null && f.fill !== 'none') {
			lines.push(`${indent(depth + 1)}<g data-vector-part="frame-fill">`);
			emitNode({ id: `${node.id}~frame-fill`, type: 'path', fill: f.fill, stroke: null, subpaths: rect }, depth + 2);
			lines.push(`${indent(depth + 1)}</g>`);
		}
		let ref = '';
		if (f.clip !== false) {
			const id = `${prefix}frame-${node.id}`;
			defs.push(`<clipPath id="${escapeAttr(id)}"><rect x="${num(f.x)}" y="${num(f.y)}" width="${num(f.width)}" height="${num(f.height)}"/></clipPath>`);
			ref = ` clip-path="url(#${escapeAttr(id)})"`;
		}
		lines.push(`${indent(depth + 1)}<g data-vector-part="frame-contents"${ref}>`);
		for (const child of node.children) emit(child, depth + 2);
		lines.push(`${indent(depth + 1)}</g>`);
		lines.push(`${indent(depth)}</g>`);
	};

	const emitNode = (node: VectorNode, depth: number) => {
		if (isVectorFrame(node)) {
			emitFrame(node, depth);
			return;
		}
		if (isVectorMaskGroup(node)) {
			emitMaskGroup(node, depth);
			return;
		}
		if (node.type === 'instance') {
			emitInstance(node, depth);
			return;
		}
		if (node.type === 'text') {
			emitText(node, depth);
			return;
		}
		if (hasOwnVectorAppearance(node)) {
			// Live: what it draws, then the editable source (hidden) for import.
			const live = {
				kind: node.type,
				...(node.effects?.length ? { effects: node.effects } : {}),
				...(node.type === 'group' && node.liveBoolean ? { liveBoolean: node.liveBoolean } : {}),
				...(node.type === 'group' && node.symmetry ? { symmetry: node.symmetry } : {})
			};
			lines.push(`${indent(depth)}<g${common(node)} data-vector-live="${escapeAttr(JSON.stringify(live))}">`);
			lines.push(`${indent(depth + 1)}<g data-vector-part="appearance">`);
			// A lens draws its changed backdrop clipped by its outline (its shapes are only its own outline).
			for (const shape of isVectorLens(node) ? vectorLensDrawn(node).children : vectorAppearanceNodes(node)) emit(shape, depth + 2);
			lines.push(`${indent(depth + 1)}</g>`);
			lines.push(`${indent(depth + 1)}<g data-vector-part="source" display="none">`);
			if (node.type === 'path') {
				const { effects: _e, transform: _t, opacity: _o, visible: _v, booleanOperation: _b, blendStep: _s, blendMode: _bm, filters: _f, lens: _l, lensView: _lv, ...source } = node;
				emit({ ...source, id: `${node.id}~src` }, depth + 2);
			} else for (const child of node.children) emit(child, depth + 2);
			lines.push(`${indent(depth + 1)}</g>`);
			lines.push(`${indent(depth)}</g>`);
			return;
		}
		if (node.type === 'group') {
			lines.push(`${indent(depth)}<g${common(node)}>`);
			for (const child of node.children) emit(child, depth + 1);
			lines.push(`${indent(depth)}</g>`);
			return;
		}
		if (needsVectorPaintLayers(node)) {
			emitStacked(node, depth);
			return;
		}
		const fill = vectorPaintToSvg(node.fill, `${prefix}fill-${node.id}`, { node, precision });
		const stroke = vectorPaintToSvg(node.stroke, `${prefix}stroke-${node.id}`, { node, role: 'stroke', precision });
		defs.push(...paintMarkup(node.fill, fill.defs), ...paintMarkup(node.stroke, stroke.defs));
		const d = vectorPathData(node, precision);
		const live = liveCorners(node);
		const fillAttrs = ` fill="${escapeAttr(fill.value)}"${node.fillRule === 'evenodd' ? ` fill-rule="evenodd"` : ''}`;
		const lineAttrs = lineAttrsOf(node, stroke.value);
		const parts = stroke.value !== 'none' ? vectorStrokeSvgParts(node, `${prefix}clip-${node.id}`, precision) : undefined;
		if (!parts) {
			lines.push(`${indent(depth)}<path${common(node)} d="${d}"${fillAttrs}${stroke.value !== 'none' ? lineAttrs(node.strokeWidth ?? 1) : ''}${live}/>`);
			return;
		}
		// The stroke options SVG has no attribute for, kept for import.
		let data = ` data-vector-path="" data-vector-stroke-width="${num(node.strokeWidth ?? 1)}"`;
		if (parts.align !== 'center') data += ` data-vector-stroke-align="${parts.align}"`;
		if (node.startArrow) data += ` data-vector-start-arrow="${node.startArrow}"`;
		if (node.endArrow) data += ` data-vector-end-arrow="${node.endArrow}"`;
		if (node.arrowAlign && node.arrowAlign !== 'extend') data += ` data-vector-arrow-align="${node.arrowAlign}"`;
		if (node.startArrowScale !== undefined && node.startArrowScale !== 1) data += ` data-vector-start-arrow-scale="${num(node.startArrowScale)}"`;
		if (node.endArrowScale !== undefined && node.endArrowScale !== 1) data += ` data-vector-end-arrow-scale="${num(node.endArrowScale)}"`;
		const profile = strokeWidthProfileOf(node);
		if (profile) {
			// Drawn as a filled outline: keep the line style the outline was built with.
			data += ` data-vector-width-profile="${widthProfileToAttribute(profile)}"`;
			if (node.strokeLinecap && node.strokeLinecap !== 'butt') data += ` data-vector-stroke-linecap="${node.strokeLinecap}"`;
			if (node.strokeLinejoin && node.strokeLinejoin !== 'miter') data += ` data-vector-stroke-linejoin="${node.strokeLinejoin}"`;
			if (node.strokeDasharray?.length) data += ` data-vector-stroke-dasharray="${node.strokeDasharray.map(num).join(' ')}"`;
		}
		lines.push(`${indent(depth)}<g${common(node)}${data}>`);
		lines.push(`${indent(depth + 1)}<path data-vector-part="fill" d="${d}"${fillAttrs}${live}/>`);
		lines.push(...strokePartLines(node, parts, stroke.value, d, lineAttrs, depth + 1));
		lines.push(`${indent(depth)}</g>`);
	};

	for (const node of doc.nodes) emit(node, 1);
	// Symbols no instance uses still go into `defs`, so they come back on import.
	for (const sym of doc.symbols ?? []) symbolRef(sym.id);
	const w = num(doc.width);
	const h = num(doc.height);
	const nl = pretty ? '\n' : '';
	const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
	if (defs.length) out.push(`${indent(1)}<defs>${defs.join('')}</defs>`);
	if (doc.background && options.background !== false && hasPaint(doc.background)) {
		out.push(`${indent(1)}<rect width="${w}" height="${h}" fill="${escapeAttr(doc.background)}"/>`);
	}
	out.push(...lines, '</svg>');
	return out.join(nl);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const BOOLEAN_OPERATIONS: readonly VectorBooleanOperation[] = ['union', 'subtract', 'intersect', 'exclude'];

export interface VectorSvgImportOptions {
	/** Makes ids for elements without a usable `id` (default `node-1`, `node-2`, …). */
	createId?: () => string;
	/**
	 * Merge neighbouring shapes with the same outline into one path with stacked fills and strokes,
	 * as design tools export several paints on one layer (default false: an SVG may hold identical
	 * shapes on purpose). Shapes merge only when the paint order stays the same (no stroke under a
	 * later fill) and they share opacity, visibility, filters and blend mode.
	 */
	mergeStackedShapes?: boolean;
}

interface Element {
	name: string;
	attrs: Record<string, string>;
	children: Element[];
	/** Character data of text content elements (`text`, `tspan`, `textPath`), in order with their children. */
	content?: Array<string | Element>;
}

const TEXT_CONTENT = new Set(['text', 'tspan', 'textPath']);

/** A tiny non-validating XML reader: elements and attributes only. */
function parseXml(source: string): Element | null {
	const text = source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<\?[\s\S]*?\?>/g, '')
		.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
		.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, '');
	const root: Element = { name: '#root', attrs: {}, children: [] };
	const stack: Element[] = [root];
	const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
	const attr = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
	let m: RegExpExecArray | null;
	let last = 0;
	while ((m = tag.exec(text))) {
		const [, closing, rawName, rawAttrs, selfClosing] = m;
		// Character data between tags belongs to the open text element, if any.
		const top = stack[stack.length - 1];
		if (m.index > last && TEXT_CONTENT.has(top.name)) (top.content ??= []).push(decodeEntities(text.slice(last, m.index)));
		last = tag.lastIndex;
		const name = rawName.replace(/^svg:/, '');
		if (closing) {
			for (let i = stack.length - 1; i > 0; i--) {
				if (stack[i].name === name) {
					stack.length = i;
					break;
				}
			}
			continue;
		}
		const attrs: Record<string, string> = {};
		let a: RegExpExecArray | null;
		attr.lastIndex = 0;
		while ((a = attr.exec(rawAttrs))) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
		const el: Element = { name, attrs, children: [] };
		stack[stack.length - 1].children.push(el);
		if (TEXT_CONTENT.has(top.name)) (top.content ??= []).push(el);
		if (!selfClosing) stack.push(el);
	}
	const find = (el: Element): Element | null => {
		if (el.name === 'svg') return el;
		for (const c of el.children) {
			const f = find(c);
			if (f) return f;
		}
		return null;
	};
	return find(root);
}

function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

const numberList = (s: string | undefined): number[] =>
	(s ?? '')
		.trim()
		.split(/[\s,]+|(?=-)(?<![eE])/)
		.filter(Boolean)
		.map(Number)
		.filter((n) => Number.isFinite(n));

const length = (s: string | undefined, fallback = 0): number => {
	if (s === undefined) return fallback;
	const n = parseFloat(s);
	return Number.isFinite(n) ? n : fallback;
};

/** Parses an SVG `transform` attribute into one matrix. */
export function parseSvgTransform(value: string | undefined): AffineMatrix {
	let m: AffineMatrix = IDENTITY_MATRIX;
	if (!value) return m;
	const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
	let t: RegExpExecArray | null;
	while ((t = re.exec(value))) {
		const n = numberList(t[2]);
		let step: AffineMatrix = IDENTITY_MATRIX;
		switch (t[1]) {
			case 'matrix':
				if (n.length >= 6) step = [n[0], n[1], n[2], n[3], n[4], n[5]];
				break;
			case 'translate':
				step = translateMatrix(n[0] ?? 0, n[1] ?? 0);
				break;
			case 'scale':
				step = scaleMatrix(n[0] ?? 1, n[1] ?? n[0] ?? 1);
				break;
			case 'rotate':
				step = rotateMatrix(n[0] ?? 0, { x: n[1] ?? 0, y: n[2] ?? 0 });
				break;
			case 'skewX':
				step = [1, 0, Math.tan(((n[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
				break;
			case 'skewY':
				step = [1, Math.tan(((n[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
				break;
		}
		// SVG lists apply right to left: `translate(…) rotate(…)` rotates first.
		m = multiplyMatrices(step, m);
	}
	return m;
}

interface InheritedStyle {
	fill: string;
	stroke: string;
	strokeWidth: string;
	strokeLinecap?: string;
	strokeLinejoin?: string;
	strokeDasharray?: string;
	fillRule?: string;
	fillOpacity?: string;
	strokeOpacity?: string;
	/** Not inherited: the element's own `mix-blend-mode` (reset for each element). */
	mixBlendMode?: string;
	/** Not inherited: the element's own `filter` (reset for each element). */
	filter?: string;
}

const STYLE_KEYS: Record<string, keyof InheritedStyle> = {
	fill: 'fill',
	stroke: 'stroke',
	'stroke-width': 'strokeWidth',
	'stroke-linecap': 'strokeLinecap',
	'stroke-linejoin': 'strokeLinejoin',
	'stroke-dasharray': 'strokeDasharray',
	'fill-rule': 'fillRule',
	'fill-opacity': 'fillOpacity',
	'stroke-opacity': 'strokeOpacity',
	'mix-blend-mode': 'mixBlendMode',
	filter: 'filter'
};

function readStyle(el: Element, parent: InheritedStyle): InheritedStyle {
	const { mixBlendMode: _m, filter: _f, ...inherited } = parent;
	const out: InheritedStyle = { ...inherited };
	for (const [attr, key] of Object.entries(STYLE_KEYS)) if (el.attrs[attr] !== undefined) out[key] = el.attrs[attr].trim();
	for (const decl of (el.attrs.style ?? '').split(';')) {
		const i = decl.indexOf(':');
		if (i < 0) continue;
		const key = STYLE_KEYS[decl.slice(0, i).trim()];
		if (key) out[key] = decl.slice(i + 1).replace(/!important/, '').trim();
	}
	return out;
}

function readStops(el: Element): VectorGradientStop[] {
	return el.children
		.filter((c) => c.name === 'stop')
		.map((c) => {
			const style = Object.fromEntries(
				(c.attrs.style ?? '')
					.split(';')
					.map((d) => d.split(':').map((s) => s.trim()))
					.filter((d) => d.length === 2)
			);
			const raw = c.attrs.offset ?? '0';
			const offset = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
			const opacity = style['stop-opacity'] ?? c.attrs['stop-opacity'];
			return {
				offset: Number.isFinite(offset) ? Math.max(0, Math.min(1, offset)) : 0,
				color: style['stop-color'] ?? c.attrs['stop-color'] ?? '#000',
				...(opacity !== undefined ? { opacity: parseFloat(opacity) } : {})
			};
		});
}

const fraction = (s: string | undefined, fallback: number) => {
	if (s === undefined) return fallback;
	const n = parseFloat(s);
	if (!Number.isFinite(n)) return fallback;
	return s.trim().endsWith('%') ? n / 100 : n;
};

const PAINT_SERVERS = new Set(['linearGradient', 'radialGradient', 'pattern']);

function collectGradients(el: Element, raw: Map<string, Element>) {
	if (PAINT_SERVERS.has(el.name) && el.attrs.id) raw.set(el.attrs.id, el);
	for (const c of el.children) collectGradients(c, raw);
}

/** Every `<clipPath>` and `<mask>` with an id. */
function collectMasks(el: Element, raw: Map<string, Element>) {
	if ((el.name === 'clipPath' || el.name === 'mask') && el.attrs.id) raw.set(el.attrs.id, el);
	for (const c of el.children) collectMasks(c, raw);
}

/** An attribute, or the same property in the element's `style`. */
function attrOrStyle(el: Element, name: string): string | undefined {
	for (const decl of (el.attrs.style ?? '').split(';')) {
		const i = decl.indexOf(':');
		if (i >= 0 && decl.slice(0, i).trim() === name) return decl.slice(i + 1).replace(/!important/, '').trim();
	}
	return el.attrs[name];
}

/** The id an `url(#id)` reference names, or null. */
function urlId(value: string | undefined): string | null {
	return /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec((value ?? '').trim())?.[1] ?? null;
}

/** A `<clipPath>`'s content with each `clip-rule` read as the `fill-rule` import knows. */
function clipRulesAsFillRules(el: Element): Element {
	const attrs = { ...el.attrs };
	const rule = attrOrStyle(el, 'clip-rule');
	if (rule) attrs['fill-rule'] = rule;
	return { ...el, attrs, children: el.children.map(clipRulesAsFillRules) };
}

function collectFilters(el: Element, raw: Map<string, Element>) {
	if (el.name === 'filter' && el.attrs.id) raw.set(el.attrs.id, el);
	for (const c of el.children) collectFilters(c, raw);
}

/**
 * A `<filter>` as vector filters: our own export's `data-vector-filters`, or the simple filters
 * other tools write — `feDropShadow`, or a lone `feGaussianBlur` of the source (a layer blur).
 * Anything else is skipped (empty list).
 */
function filtersFromElement(el: Element): VectorFilter[] {
	const own = el.attrs['data-vector-filters'];
	if (own !== undefined) {
		try {
			return sanitizeVectorFilters(JSON.parse(own));
		} catch {
			return [];
		}
	}
	const prims = el.children.filter((c) => c.name.startsWith('fe'));
	const out: unknown[] = [];
	for (const p of prims) {
		const std = numberList(p.attrs.stdDeviation)[0] ?? 0;
		if (p.name === 'feDropShadow') {
			const style = Object.fromEntries(
				(p.attrs.style ?? '')
					.split(';')
					.map((d) => d.split(':').map((x) => x.trim()))
					.filter((d) => d.length === 2)
			);
			const opacity = parseFloat(style['flood-opacity'] ?? p.attrs['flood-opacity'] ?? '1');
			out.push({
				type: 'dropShadow',
				params: {
					color: style['flood-color'] ?? p.attrs['flood-color'] ?? '#000000',
					opacity: Number.isFinite(opacity) ? opacity : 1,
					offsetX: length(p.attrs.dx, 2),
					offsetY: length(p.attrs.dy, 2),
					blur: std * 2,
					spread: 0
				}
			});
		} else if (p.name === 'feGaussianBlur' && prims.length === 1 && (p.attrs.in === undefined || p.attrs.in === 'SourceGraphic')) {
			out.push({ type: 'layerBlur', params: { radius: std * 2 } });
		} else return [];
	}
	return sanitizeVectorFilters(out);
}

/** The gradient a `data-vector-gradient` attribute (our own export) holds, or null. */
function gradientFromAttribute(value: string | undefined): VectorGradient | null {
	if (!value) return null;
	try {
		return sanitizeVectorGradient(JSON.parse(value));
	} catch {
		return null;
	}
}

/**
 * A `<linearGradient>` / `<radialGradient>` (attributes and stops inherited through `href`) as a
 * vector gradient: `gradientUnits`, `gradientTransform`, `spreadMethod`, `fx`, `fy` and `fr` read.
 * Box gradients that match the angle / centre shorthand keep it.
 */
function resolveGradient(id: string, raw: Map<string, Element>): VectorGradient | null {
	const first = raw.get(id);
	if (!first) return null;
	const own = gradientFromAttribute(first.attrs['data-vector-gradient']);
	if (own) return own;
	if (first.name === 'pattern') return null;
	// The href chain: attributes and stops come from the nearest element that has them.
	const chain: Element[] = [];
	for (let el: Element | undefined = first; el && !chain.includes(el) && chain.length < 32; ) {
		chain.push(el);
		const href: string | undefined = el.attrs.href ?? el.attrs['xlink:href'];
		el = href?.startsWith('#') ? raw.get(href.slice(1)) : undefined;
	}
	const attr = (name: string) => chain.find((el) => el.attrs[name] !== undefined)?.attrs[name];
	const stops = chain.map(readStops).find((s) => s.length) ?? [];
	if (!stops.length) return null;
	const user = attr('gradientUnits') === 'userSpaceOnUse';
	const t = parseSvgTransform(attr('gradientTransform'));
	const plain = t === IDENTITY_MATRIX || (t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && t[4] === 0 && t[5] === 0);
	const at = (name: string, fallback: number) => (user ? length(attr(name), fallback) : fraction(attr(name), fallback));
	const spreadAttr = attr('spreadMethod');
	const spread = spreadAttr === 'reflect' || spreadAttr === 'repeat' ? { spread: spreadAttr as 'reflect' | 'repeat' } : {};
	const map = (p: { x: number; y: number }) => applySvgMatrix(t, p);
	if (first.name === 'radialGradient') {
		const cx = at('cx', user ? 0 : 0.5);
		const cy = at('cy', user ? 0 : 0.5);
		const r = at('r', user ? 0 : 0.5);
		const fx = attr('fx') !== undefined ? at('fx', cx) : cx;
		const fy = attr('fy') !== undefined ? at('fy', cy) : cy;
		const fr = attr('fr') !== undefined ? at('fr', 0) : 0;
		const focal = Math.abs(fx - cx) > 1e-9 || Math.abs(fy - cy) > 1e-9;
		if (!user && plain && !focal && !(fr > 0)) return { type: 'radial', cx, cy, r, stops, ...spread };
		const g: VectorGradient = {
			type: 'radial',
			stops,
			start: map({ x: cx, y: cy }),
			end: map({ x: cx + r, y: cy }),
			width: map({ x: cx, y: cy + r }),
			units: user ? 'userSpaceOnUse' : 'objectBoundingBox',
			...spread
		};
		if (focal) g.focal = map({ x: fx, y: fy });
		if (fr > 0 && r > 0) g.focalRadius = Math.min(0.99, fr / r);
		return g;
	}
	const x1 = at('x1', 0);
	const y1 = at('y1', 0);
	const x2 = attr('x2') !== undefined ? at('x2', 1) : user ? 0 : 1;
	const y2 = at('y2', 0);
	if (!user && plain) {
		// CSS angle: 0° points up, clockwise. Keep the shorthand when it paints the same.
		const angle = Math.round(((Math.atan2(x2 - x1, -(y2 - y1)) * 180) / Math.PI + 360) % 360);
		const c = angleToSvgLinearCoords(angle);
		const len = Math.hypot(x2 - x1, y2 - y1);
		const d = len > 0 ? { x: (x2 - x1) / len, y: (y2 - y1) / len } : { x: 0, y: 1 };
		const along = (x: number, y: number) => x * d.x + y * d.y;
		const same =
			len > 0 &&
			Math.abs((c.x2 - c.x1) * d.y - (c.y2 - c.y1) * d.x) < 1e-3 &&
			Math.abs(along(c.x1, c.y1) - along(x1, y1)) < 1e-3 &&
			Math.abs(along(c.x2, c.y2) - along(x2, y2)) < 1e-3;
		if (same) return { type: 'linear', angle, stops, ...spread };
	}
	const start = { x: x1, y: y1 };
	const end = { x: x2, y: y2 };
	return {
		type: 'linear',
		stops,
		start: map(start),
		end: map(end),
		width: map({ x: x1 - (y2 - y1), y: y1 + (x2 - x1) }),
		units: user ? 'userSpaceOnUse' : 'objectBoundingBox',
		...spread
	};
}

const applySvgMatrix = (m: AffineMatrix, p: { x: number; y: number }) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/** Parses SVG markup into a vector document. Throws when there is no `<svg>` element. */
export function parseVectorSvg(svg: string, options: VectorSvgImportOptions = {}): VectorDocument {
	const root = parseXml(svg);
	if (!root) throw new Error('The markup has no <svg> element.');
	let counter = 0;
	const usedIds = new Set<string>();
	const createId = options.createId ?? (() => `node-${++counter}`);
	const idFor = (el: Element) => {
		const id = el.attrs.id;
		if (id && !usedIds.has(id)) {
			usedIds.add(id);
			return id;
		}
		let next = createId();
		while (usedIds.has(next)) next = createId();
		usedIds.add(next);
		return next;
	};

	const rawGradients = new Map<string, Element>();
	collectGradients(root, rawGradients);
	const rawFilters = new Map<string, Element>();
	collectFilters(root, rawFilters);
	const rawMasks = new Map<string, Element>();
	collectMasks(root, rawMasks);
	/** Masks being read (a mask that refers back to itself is ignored there). */
	const resolving = new Set<string>();
	const filtersOf = (value: string | undefined): VectorFilter[] => {
		const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec((value ?? '').trim());
		const el = url ? rawFilters.get(url[1]) : undefined;
		return el ? filtersFromElement(el) : [];
	};
	const paint = (value: string): VectorPaint => {
		const v = value.trim();
		const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(v);
		if (url) return resolveGradient(url[1], rawGradients) ?? null;
		if (v === 'none' || v === '') return null;
		return v;
	};

	const viewBox = numberList(root.attrs.viewBox);
	const width = viewBox.length === 4 ? viewBox[2] : length(root.attrs.width, 300);
	const height = viewBox.length === 4 ? viewBox[3] : length(root.attrs.height, 150);
	const rootMatrix: AffineMatrix = viewBox.length === 4 ? translateMatrix(-viewBox[0], -viewBox[1]) : IDENTITY_MATRIX;

	const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'style', 'title', 'desc', 'metadata', 'pattern', 'marker', 'filter', 'image', 'linearGradient', 'radialGradient', 'script', 'foreignObject']);

	const shapeOf = (el: Element): VectorSubpath[] | null => {
		const a = el.attrs;
		switch (el.name) {
			case 'path': {
				// Our own export: the sharp path and its live corners.
				if (a['data-vector-d'] && a['data-vector-corners']) {
					const sharp = bezierToSubpaths(a['data-vector-d']);
					if (sharp.length) return applyVectorCornersAttribute(sharp, a['data-vector-corners']);
				}
				return a.d ? bezierToSubpaths(a.d) : null;
			}
			case 'rect': {
				const w = length(a.width);
				const h = length(a.height);
				if (w <= 0 || h <= 0) return null;
				const r = length(a.rx ?? a.ry, 0);
				return [rectSubpath({ x: length(a.x), y: length(a.y), width: w, height: h }, r)];
			}
			case 'circle': {
				const r = length(a.r);
				if (r <= 0) return null;
				const cx = length(a.cx);
				const cy = length(a.cy);
				return [ellipseSubpath({ x: cx - r, y: cy - r, width: 2 * r, height: 2 * r })];
			}
			case 'ellipse': {
				const rx = length(a.rx);
				const ry = length(a.ry);
				if (rx <= 0 || ry <= 0) return null;
				return [ellipseSubpath({ x: length(a.cx) - rx, y: length(a.cy) - ry, width: 2 * rx, height: 2 * ry })];
			}
			case 'line':
				return [lineSubpath({ x: length(a.x1), y: length(a.y1) }, { x: length(a.x2), y: length(a.y2) })];
			case 'polyline':
			case 'polygon': {
				const n = numberList(a.points);
				if (n.length < 4) return null;
				const anchors = [];
				for (let i = 0; i + 1 < n.length; i += 2) anchors.push({ x: n[i], y: n[i + 1] });
				return [{ anchors, closed: el.name === 'polygon' }];
			}
		}
		return null;
	};

	const strokeStyle = (s: InheritedStyle): Partial<VectorPathNode> => ({
		...(s.strokeWidth ? { strokeWidth: length(s.strokeWidth, 1) } : {}),
		...(s.strokeLinecap ? { strokeLinecap: s.strokeLinecap as VectorLineCap } : {}),
		...(s.strokeLinejoin ? { strokeLinejoin: s.strokeLinejoin as VectorLineJoin } : {}),
		...(s.strokeDasharray && s.strokeDasharray !== 'none' ? { strokeDasharray: numberList(s.strokeDasharray) } : {}),
		...(s.fillRule === 'evenodd' ? { fillRule: 'evenodd' as VectorFillRule } : {})
	});

	/** A node mapped by `m` (scale and skew baked in, stroke width scaled). */
	const placed = (node: VectorPathNode, m: AffineMatrix): VectorPathNode => {
		if (m === IDENTITY_MATRIX) return node;
		const next = transformVectorNode(node, m);
		const strokeScale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
		if (strokeScale > 0 && Math.abs(strokeScale - 1) > 1e-9) {
			if (hasPaint(next.stroke)) next.strokeWidth = (next.strokeWidth ?? 1) * strokeScale;
			if (Array.isArray(next.strokes)) next.strokes = next.strokes.map((l) => ((l.kind ?? 'paint') === 'paint' ? { ...l, strokeWidth: (l.strokeWidth ?? 1) * strokeScale } : l));
		}
		return normalizeVectorPaintStacks(next, 'stack');
	};

	/** Paint with an element's `fill-opacity` / `stroke-opacity`: a one-layer stack when it is below 1. */
	const withOpacities = (node: VectorPathNode, s: InheritedStyle): VectorPathNode => {
		let out = node;
		const fo = s.fillOpacity !== undefined ? fraction(s.fillOpacity, 1) : 1;
		const so = s.strokeOpacity !== undefined ? fraction(s.strokeOpacity, 1) : 1;
		if (fo < 1 && hasPaint(out.fill)) out = withVectorFills(out, [{ paint: out.fill!, opacity: Math.max(0, fo) }]);
		if (so < 1 && hasPaint(out.stroke)) out = withVectorStrokes(out, vectorStrokes(out).map((l) => ({ ...l, opacity: Math.max(0, so) })));
		return out;
	};

	/**
	 * A `<g data-vector-path data-vector-fills>` from our own export (a path painted through its
	 * stacks) as the path it came from: the geometry of its first fill part, the stacks from JSON.
	 */
	const stackedPath = (g: Element, _style: InheritedStyle, m: AffineMatrix, meta: Partial<VectorPathNode>): VectorPathNode | null => {
		const fillEl = g.children.find((c) => c.name === 'path' && c.attrs['data-vector-part'] === 'fill');
		const subpaths = fillEl ? shapeOf(fillEl) : null;
		if (!subpaths?.length) return null;
		const parse = (v: string | undefined) => {
			try {
				return v ? JSON.parse(v) : [];
			} catch {
				return [];
			}
		};
		let node: VectorPathNode = { id: idFor(g), type: 'path', ...meta, subpaths, fill: null, stroke: null };
		if (g.attrs['data-vector-fill-rule'] === 'evenodd') node.fillRule = 'evenodd';
		node = withVectorFills(node, sanitizeVectorFills(parse(g.attrs['data-vector-fills'])));
		node = withVectorStrokes(node, sanitizeVectorStrokes(parse(g.attrs['data-vector-strokes'])));
		return placed(node, m);
	};

	/**
	 * Neighbouring paths with the same outline merged into one with stacked paints (see
	 * `mergeStackedShapes`).
	 */
	const mergeStacked = (nodes: VectorNode[]): VectorNode[] => {
		const out: VectorNode[] = [];
		const key = (n: VectorPathNode) =>
			JSON.stringify([n.subpaths, n.transform ?? null, n.opacity ?? 1, n.visible !== false, n.filters ?? null, n.blendMode ?? 'normal', n.fillRule ?? 'nonzero', n.booleanOperation ?? null]);
		for (const n of nodes) {
			const prev = out[out.length - 1];
			if (prev?.type === 'path' && n.type === 'path' && key(prev) === key(n)) {
				const fills = vectorFills(n);
				const strokesBefore = vectorStrokes(prev);
				// A later fill would land under an earlier stroke: keep them apart.
				if (!(fills.length && strokesBefore.length)) {
					let merged = withVectorFills(prev, [...vectorFills(prev), ...fills]);
					merged = withVectorStrokes(merged, [...strokesBefore, ...vectorStrokes(n)]);
					out[out.length - 1] = merged;
					continue;
				}
			}
			out.push(n);
		}
		return out;
	};

	/**
	 * A `<g data-vector-path>` from our own export (an aligned or arrowed stroke drawn in parts)
	 * as the one path it came from: the fill part's outline and fill, the stroke part's paint and
	 * line style, and the options the group's data attributes keep.
	 */
	const mergedPath = (g: Element, style: InheritedStyle, m: AffineMatrix, meta: Partial<VectorPathNode>): VectorPathNode | null => {
		const part = (name: string) => g.children.find((c) => c.name === 'path' && c.attrs['data-vector-part'] === name);
		const fillEl = part('fill');
		const subpaths = fillEl ? shapeOf(fillEl) : null;
		if (!fillEl || !subpaths?.length) return null;
		const a = g.attrs;
		const fs = readStyle(fillEl, style);
		const strokeEl = part('stroke');
		const outlineEl = part('stroke-outline');
		const ss = strokeEl ? readStyle(strokeEl, style) : null;
		const width = length(a['data-vector-stroke-width'], ss ? length(ss.strokeWidth, 1) : 1);
		const arrow = (v: string | undefined) => (VECTOR_ARROWHEADS.includes(v as VectorArrowhead) ? (v as VectorArrowhead) : undefined);
		const scale = (v: string | undefined) => {
			const n = v === undefined ? NaN : parseFloat(v);
			return n > 0 ? n : undefined;
		};
		const align = a['data-vector-stroke-align'];
		const profile = widthProfileFromAttribute(a['data-vector-width-profile']);
		const kept = (key: string, values: readonly string[]) => (values.includes(a[key]) ? a[key] : undefined);
		const keptCap = kept('data-vector-stroke-linecap', ['round', 'square']) as VectorLineCap | undefined;
		const keptJoin = kept('data-vector-stroke-linejoin', ['round', 'bevel']) as VectorLineJoin | undefined;
		const keptDash = a['data-vector-stroke-dasharray'] ? numberList(a['data-vector-stroke-dasharray']) : undefined;
		const node: VectorPathNode = {
			id: idFor(g),
			type: 'path',
			...meta,
			subpaths,
			fill: paint(fs.fill),
			stroke: ss ? paint(ss.stroke) : outlineEl ? paint(readStyle(outlineEl, style).fill) : null,
			...(ss ? strokeStyle(ss) : {}),
			...(fs.fillRule === 'evenodd' ? { fillRule: 'evenodd' as VectorFillRule } : {}),
			strokeWidth: width,
			...(align === 'inside' || align === 'outside' ? { strokeAlign: align } : {}),
			...(arrow(a['data-vector-start-arrow']) ? { startArrow: arrow(a['data-vector-start-arrow']) } : {}),
			...(arrow(a['data-vector-end-arrow']) ? { endArrow: arrow(a['data-vector-end-arrow']) } : {}),
			...(a['data-vector-arrow-align'] === 'tip' ? { arrowAlign: 'tip' as const } : {}),
			...(scale(a['data-vector-start-arrow-scale']) ? { startArrowScale: scale(a['data-vector-start-arrow-scale']) } : {}),
			...(scale(a['data-vector-end-arrow-scale']) ? { endArrowScale: scale(a['data-vector-end-arrow-scale']) } : {}),
			...(profile.length ? { strokeWidthProfile: profile } : {}),
			...(keptCap ? { strokeLinecap: keptCap } : {}),
			...(keptJoin ? { strokeLinejoin: keptJoin } : {}),
			...(keptDash?.length ? { strokeDasharray: keptDash } : {})
		};
		return placed(node, m);
	};

	/**
	 * A `<g data-vector-live>` from our own export (path effects or a live boolean) as the node it
	 * came from: its hidden source part with the effects put back (their offsets carried through
	 * what import bakes into the geometry). The drawn appearance part is regenerated.
	 */
	const liveNode = (g: Element, style: InheritedStyle, m: AffineMatrix, meta: Pick<VectorNode, 'name' | 'opacity' | 'visible' | 'booleanOperation' | 'blendMode' | 'filters'>): VectorNode | null => {
		let raw: Record<string, unknown> = {};
		try {
			raw = JSON.parse(g.attrs['data-vector-live']) ?? {};
		} catch {
			raw = {};
		}
		const sourceEl = g.children.find((c) => c.name === 'g' && c.attrs['data-vector-part'] === 'source');
		if (!sourceEl) return null;
		const inner = visit(sourceEl, style, m);
		const effects = sanitizeVectorEffects(raw.effects);
		const liveBoolean = BOOLEAN_OPERATIONS.includes(raw.liveBoolean as VectorBooleanOperation) ? (raw.liveBoolean as VectorBooleanOperation) : null;
		const id = idFor(g);
		if (raw.kind === 'text') {
			const text = inner.find((n): n is VectorTextNode => n.type === 'text');
			if (!text) return null;
			const { residual } = decomposeRigid(m);
			const { visible: _v, ...rest } = text;
			return { ...rest, id, ...meta, ...(effects.length ? { effects: transformVectorEffects(effects, residual) } : {}) };
		}
		if (raw.kind === 'path') {
			const path = inner.find((n): n is VectorPathNode => n.type === 'path');
			if (!path) return null;
			const { residual } = decomposeRigid(m);
			const { visible: _v, ...rest } = path;
			return { ...rest, id, ...meta, ...(effects.length ? { effects: transformVectorEffects(effects, residual) } : {}) };
		}
		if (!inner.length) return null;
		const group: VectorGroupNode = { id, type: 'group', ...meta, children: inner };
		if (effects.length) group.effects = transformVectorEffects(effects, m);
		if (liveBoolean) group.liveBoolean = liveBoolean;
		const symmetry = sanitizeVectorSymmetry(raw.symmetry);
		if (symmetry) group.symmetry = transformVectorSymmetry(symmetry, m);
		const blend = blendFromAttribute(g.attrs['data-vector-blend'], m);
		if (blend) group.blend = blend;
		return group;
	};

	const json = (v: string | undefined): unknown => {
		try {
			return v === undefined ? undefined : JSON.parse(v);
		} catch {
			return undefined;
		}
	};

	/** A `<g data-vector-text>` from our own export as the text node it came from. */
	const ownText = (g: Element, m: AffineMatrix, meta: Partial<VectorTextNode>): VectorTextNode | null => {
		const raw = json(g.attrs['data-vector-text']) as Record<string, unknown> | undefined;
		if (!raw || typeof raw !== 'object') return null;
		let fields: ReturnType<typeof sanitizeVectorTextFields>;
		try {
			fields = sanitizeVectorTextFields(raw);
		} catch {
			return null;
		}
		const effects = sanitizeVectorEffects(raw.effects);
		let node: VectorTextNode = { id: idFor(g), type: 'text', ...meta, ...fields, ...(effects.length ? { effects } : {}) };
		if (g.attrs['data-vector-fills'] !== undefined) {
			node = withVectorFills({ ...node, fill: null, stroke: null }, sanitizeVectorFills(json(g.attrs['data-vector-fills']) ?? []));
			node = withVectorStrokes(node, sanitizeVectorStrokes(json(g.attrs['data-vector-strokes']) ?? []));
		} else {
			const fill = json(g.attrs['data-vector-fill']);
			const stroke = json(g.attrs['data-vector-stroke']);
			node.fill = fill == null ? null : (sanitizeVectorFills([{ paint: fill }])[0]?.paint ?? null);
			node.stroke = stroke == null ? null : (sanitizeVectorFills([{ paint: stroke }])[0]?.paint ?? null);
			const settings = json(g.attrs['data-vector-stroke-settings']);
			if (settings && typeof settings === 'object') {
				const strokes = sanitizeVectorStrokes([{ paint: node.stroke ?? '#000', ...(settings as object) }]);
				if (strokes[0]) {
					const { paint: _p, ...rest } = strokes[0];
					node = { ...node, ...rest };
				}
			}
		}
		return m === IDENTITY_MATRIX ? node : normalizeVectorPaintStacks(transformVectorNode(node, m), 'stack');
	};

	/**
	 * A foreign `<text>` as point text: its characters (tspans that start a new line at their own
	 * `x` become line breaks), font, anchor and paint. Per-character positions, `textPath` and
	 * `textLength` are not kept.
	 */
	const foreignText = (el: Element, style: InheritedStyle, m: AffineMatrix, meta: Partial<VectorTextNode>): VectorTextNode | null => {
		let text = '';
		let first = true;
		const walk = (e: Element) => {
			for (const part of e.content ?? []) {
				if (typeof part === 'string') text += part.replace(/\s+/g, ' ');
				else if (part.name === 'tspan' || part.name === 'textPath') {
					if (!first && part.attrs.x !== undefined && (part.attrs.dy !== undefined || part.attrs.y !== undefined)) text += '\n';
					walk(part);
				}
				first = false;
			}
		};
		walk(el);
		text = text.replace(/^ +| +$/gm, '');
		if (!text.trim()) return null;
		const font = (name: string) => attrOrStyle(el, name) ?? el.children.map((c) => attrOrStyle(c, name)).find((v) => v !== undefined);
		const size = length(font('font-size'), 16);
		const weightRaw = font('font-weight');
		const weight = weightRaw === 'bold' ? 700 : weightRaw === 'normal' || !weightRaw ? 400 : Math.round(length(weightRaw, 400));
		const family = (font('font-family') ?? 'sans-serif').split(',')[0].trim().replace(/^["']|["']$/g, '') || 'sans-serif';
		const anchor = attrOrStyle(el, 'text-anchor');
		const first0 = (v: string | undefined) => numberList(v)[0] ?? 0;
		const tspan = el.children.find((c) => c.name === 'tspan');
		const x = el.attrs.x !== undefined ? first0(el.attrs.x) : first0(tspan?.attrs.x);
		const y = el.attrs.y !== undefined ? first0(el.attrs.y) : first0(tspan?.attrs.y);
		const fillValue = attrOrStyle(el, 'fill') ?? style.fill;
		let node: VectorTextNode = {
			id: idFor(el),
			type: 'text',
			...meta,
			text,
			font: { fontFamily: family, fontWeight: Math.max(1, Math.min(1000, weight)), fontSize: size > 0 ? size : 16, ...(font('font-style') === 'italic' ? { italic: true } : {}) },
			...(anchor === 'middle' ? { paragraph: { align: 'center' as const } } : anchor === 'end' ? { paragraph: { align: 'right' as const } } : {}),
			frame: { kind: 'point', x, y },
			fill: paint(fillValue ?? '#000'),
			stroke: paint(s0(style.stroke)),
			...(style.strokeWidth ? { strokeWidth: length(style.strokeWidth, 1) } : {})
		};
		if (m !== IDENTITY_MATRIX) node = transformVectorNode(node, m);
		return node;
	};
	const s0 = (v: string | undefined) => v ?? 'none';

	// Symbols: our `<symbol data-vector-symbol>`, or any element a `<use>` refers to.
	const byId = new Map<string, Element>();
	const index = (el: Element) => {
		if (el.attrs.id && !byId.has(el.attrs.id)) byId.set(el.attrs.id, el);
		el.children.forEach(index);
	};
	index(root);
	const symbols: VectorSymbol[] = [];
	const symbolOfElement = new Map<Element, string | null>();
	const usedSymbolIds = new Set<string>();
	const symbolFor = (el: Element): string | null => {
		if (symbolOfElement.has(el)) return symbolOfElement.get(el)!;
		symbolOfElement.set(el, null); // a symbol that uses itself draws nothing
		const own = json(el.attrs['data-vector-symbol']) as { id?: string; name?: string } | undefined;
		let id = typeof own?.id === 'string' && own.id ? own.id : (el.attrs.id ?? createId());
		while (usedSymbolIds.has(id)) id = `${id}-${usedSymbolIds.size}`;
		usedSymbolIds.add(id);
		const style = readStyle(el, rootStyle);
		// A `<symbol>` holds its art; any other element referred to is the art itself.
		const nodes = el.name === 'symbol' ? visit(el, style, IDENTITY_MATRIX) : visitOne({ ...el, attrs: { ...el.attrs, transform: '' } }, rootStyle, parseSvgTransform(el.attrs.transform));
		symbols.push({ id, name: typeof own?.name === 'string' && own.name ? own.name : (el.attrs.id ?? 'Symbol'), nodes });
		symbolOfElement.set(el, id);
		return id;
	};
	/** A `<use>` as an instance of the symbol it refers to, placed by its transform and `x` / `y`. */
	const useInstance = (el: Element, m: AffineMatrix, meta: Partial<VectorInstanceNode>): VectorInstanceNode | null => {
		const href = (el.attrs.href ?? el.attrs['xlink:href'] ?? '').trim();
		const target = href.startsWith('#') ? byId.get(href.slice(1)) : undefined;
		if (!target) return null;
		const symbolId = symbolFor(target);
		if (!symbolId) return null;
		const own = json(el.attrs['data-vector-instance']) as { scaleStrokes?: boolean; overrides?: VectorInstanceNode['overrides'] } | undefined;
		const place = multiplyMatrices(translateMatrix(length(el.attrs.x), length(el.attrs.y)), m);
		const node: VectorInstanceNode = { id: idFor(el), type: 'instance', ...meta, symbolId, ...(own?.scaleStrokes === false ? { scaleStrokes: false } : {}), ...(own?.overrides ? { overrides: own.overrides } : {}) };
		return isIdentityMatrix(place) ? node : { ...node, transform: place };
	};
	/** A `<g data-vector-instance>` (an instance written as its drawn art) as the instance it came from. */
	const ownInstance = (g: Element, m: AffineMatrix, meta: Partial<VectorInstanceNode>): VectorInstanceNode | null => {
		const raw = json(g.attrs['data-vector-instance']) as { symbolId?: string; transform?: number[]; scaleStrokes?: boolean; overrides?: VectorInstanceNode['overrides']; effects?: unknown } | undefined;
		if (!raw || typeof raw.symbolId !== 'string') return null;
		const sym = [...byId.values()].find((e) => e.name === 'symbol' && (json(e.attrs['data-vector-symbol']) as { id?: string } | undefined)?.id === raw.symbolId);
		const symbolId = sym ? symbolFor(sym) : raw.symbolId;
		if (!symbolId) return null;
		const t = Array.isArray(raw.transform) && raw.transform.length === 6 && raw.transform.every(Number.isFinite) ? (raw.transform as unknown as AffineMatrix) : IDENTITY_MATRIX;
		const place = multiplyMatrices(t, m);
		const drawn = g.children.find((c) => c.name === 'g');
		const effects = sanitizeVectorEffects(raw.effects);
		const node: VectorInstanceNode = {
			id: drawn?.attrs.id ?? idFor(g),
			type: 'instance',
			...meta,
			symbolId,
			...(raw.scaleStrokes === false ? { scaleStrokes: false } : {}),
			...(raw.overrides ? { overrides: raw.overrides } : {}),
			...(effects.length ? { effects } : {})
		};
		if (drawn) {
			// The drawn group carries the instance's own opacity, blend mode and filters.
			const ds = readStyle(drawn, rootStyle);
			const op = drawn.attrs.opacity !== undefined ? parseFloat(drawn.attrs.opacity) : undefined;
			if (op !== undefined && Number.isFinite(op) && op < 1) node.opacity = op;
			const blend = vectorBlendModeFromCss(ds.mixBlendMode);
			if (blend && blend !== 'normal') node.blendMode = blend;
			const filters = filtersOf(ds.filter);
			if (filters.length) node.filters = filters;
			if (drawn.attrs.display === 'none') node.visible = false;
			usedIds.add(node.id);
		}
		return isIdentityMatrix(place) ? node : { ...node, transform: place };
	};

	const visit = (el: Element, style: InheritedStyle, matrix: AffineMatrix): VectorNode[] => {
		const out: VectorNode[] = [];
		for (const child of el.children) {
			if (SKIP.has(child.name)) continue;
			const nodes = visitOne(child, style, matrix);
			out.push(...(nodes.length ? masked(child, nodes, multiplyMatrices(parseSvgTransform(child.attrs.transform), matrix)) : nodes));
		}
		return options.mergeStackedShapes ? mergeStacked(out) : out;
	};

	/** The base style mask and clip content inherits (the document's, not the referencing element's). */
	let rootStyle: InheritedStyle = { fill: '#000', stroke: 'none', strokeWidth: '' };

	/** Maps a unit box onto the bounds of `nodes` (`objectBoundingBox` units), or null without bounds. */
	const bboxMatrix = (nodes: readonly VectorNode[]): AffineMatrix | null => {
		const b = unionBounds(nodes.map((n) => vectorNodeBounds(n)));
		return b && b.width > 0 && b.height > 0 ? [b.width, 0, 0, b.height, b.x, b.y] : null;
	};

	/** The nodes a `<clipPath>` or `<mask>` holds as one mask node (several are grouped), or null. */
	const maskNode = (el: Element, m: AffineMatrix, nodes: readonly VectorNode[], units: string | undefined): VectorNode | null => {
		const id = el.attrs.id;
		if (!id || resolving.has(id)) return null;
		let space = m;
		if (units === 'objectBoundingBox') {
			const box = bboxMatrix(nodes);
			if (!box) return null;
			space = box;
		}
		resolving.add(id);
		const isClip = el.name === 'clipPath';
		const content = isClip ? clipRulesAsFillRules(el) : el;
		const inner = visit(content, readStyle(content, rootStyle), multiplyMatrices(parseSvgTransform(el.attrs.transform), space));
		resolving.delete(id);
		// A clip's paint is not drawn: imported clips are unpainted outlines.
		const strip = (n: VectorNode): VectorNode => (n.type !== 'group' ? withVectorStrokes(withVectorFills({ ...n, fill: null, stroke: null }, []), []) : { ...n, children: n.children.map(strip) });
		const list = isClip ? inner.map(strip) : inner;
		if (!list.length) return null;
		return list.length === 1 ? list[0] : { id: idFor({ name: 'g', attrs: {}, children: [] }), type: 'group', name: isClip ? 'Clip' : 'Mask', children: list };
	};

	/**
	 * Nodes made from an element that has `clip-path` and / or `mask`: wrapped in a mask group (the
	 * clip or mask first), the clip inside the mask as SVG applies them. References to unknown or
	 * unusable masks are dropped.
	 */
	const masked = (el: Element, nodes: VectorNode[], m: AffineMatrix): VectorNode[] => {
		let out = nodes;
		const clipEl = rawMasks.get(urlId(attrOrStyle(el, 'clip-path')) ?? '');
		if (clipEl?.name === 'clipPath') {
			const source = maskNode(clipEl, m, out, clipEl.attrs.clipPathUnits);
			if (source) out = [{ id: idFor({ name: 'g', attrs: {}, children: [] }), type: 'group', name: 'Clip Group', mask: { type: 'clip' }, children: [source, ...out] }];
		}
		const maskEl = rawMasks.get(urlId(attrOrStyle(el, 'mask')) ?? '');
		if (maskEl?.name === 'mask') {
			const source = maskNode(maskEl, m, out, maskEl.attrs.maskContentUnits);
			const type = attrOrStyle(maskEl, 'mask-type') === 'alpha' ? 'alpha' : 'luminance';
			if (source) out = [{ id: idFor({ name: 'g', attrs: {}, children: [] }), type: 'group', name: 'Opacity Mask', mask: { type }, children: [source, ...out] }];
		}
		return out;
	};

	/**
	 * A `<g data-vector-mask>` from our own export as the mask group it came from: the mask from its
	 * hidden source part or its `<mask>`, the contents from the masked part (a `<id>~content` live
	 * group there gives back the group's effects).
	 */
	const maskGroup = (g: Element, style: InheritedStyle, m: AffineMatrix, meta: Partial<VectorGroupNode>): VectorNode | null => {
		let raw: unknown = null;
		try {
			raw = JSON.parse(g.attrs['data-vector-mask']);
		} catch {
			raw = null;
		}
		const mask = sanitizeVectorMask(raw);
		const part = (name: string) => g.children.find((c) => c.name === 'g' && c.attrs['data-vector-part'] === name);
		const maskedEl = part('masked');
		if (!mask || !maskedEl) return null;
		const id = idFor(g);
		let sourceEl = part('mask-source');
		if (!sourceEl) {
			const el = rawMasks.get(urlId(maskedEl.attrs.mask) ?? '');
			const invert = el?.children.find((c) => c.name === 'g' && c.attrs['data-vector-part'] === 'mask-invert');
			sourceEl = invert ?? el;
		}
		const source = sourceEl ? visit(sourceEl, style, m)[0] : undefined;
		let contents = visit(maskedEl, style, m);
		let effects: VectorEffect[] | undefined;
		const wrapper = contents.length === 1 && contents[0].type === 'group' && contents[0].id === `${id}~content` ? contents[0] : null;
		if (wrapper?.type === 'group') {
			effects = wrapper.effects ?? undefined;
			contents = wrapper.children;
		}
		if (!source) return contents.length ? { id, type: 'group', ...meta, children: contents } : null;
		return { id, type: 'group', ...meta, mask, ...(effects?.length ? { effects } : {}), children: [source, ...contents] };
	};

	/**
	 * A `<g data-vector-frame>` from our own export as its frame: the contents from the
	 * `frame-contents` part (the fill part is regenerated), the frame's rotation kept as the group's
	 * transform and the rest of `m` mapped into its rectangle.
	 */
	const frameGroup = (g: Element, style: InheritedStyle, m: AffineMatrix, meta: Partial<VectorGroupNode>): VectorNode | null => {
		const raw = parseJson(g.attrs['data-vector-frame']);
		const frame = sanitizeVectorFrame(raw);
		const contentsEl = g.children.find((c) => c.name === 'g' && c.attrs['data-vector-part'] === 'frame-contents');
		const children = contentsEl ? visit(contentsEl, style, m) : [];
		const id = idFor(g);
		if (!frame) return children.length ? { id, type: 'group', ...meta, children } : null;
		const { rigid, residual } = decomposeRigid(m);
		const r = bezierPathBounds(transformBezierPath(subpathsToBezier(vectorFrameRectPath(frame)), residual))!;
		const back = invertMatrix(rigid);
		const effects = sanitizeVectorEffects((raw as { effects?: unknown } | null)?.effects);
		return {
			id,
			type: 'group',
			...meta,
			...(isIdentityMatrix(rigid) ? {} : { transform: rigid }),
			// Whole numbers stay whole (the rotation split leaves float noise).
			frame: { ...frame, x: tidy(r.minX), y: tidy(r.minY), width: tidy(r.maxX - r.minX), height: tidy(r.maxY - r.minY) },
			...(effects.length ? { effects: transformVectorEffects(effects, residual) } : {}),
			children: isIdentityMatrix(rigid) ? children : children.map((c) => transformVectorNode(c, back))
		};
	};

	const visitOne = (child: Element, style: InheritedStyle, matrix: AffineMatrix): VectorNode[] => {
		const out: VectorNode[] = [];
		const m = multiplyMatrices(parseSvgTransform(child.attrs.transform), matrix);
		const s = readStyle(child, style);
		const opacity = child.attrs.opacity !== undefined ? parseFloat(child.attrs.opacity) : undefined;
		const hidden = child.attrs.display === 'none' || child.attrs.visibility === 'hidden';
		const blendMode = vectorBlendModeFromCss(s.mixBlendMode);
		const filters = filtersOf(s.filter);
		const meta = {
			...(child.attrs['inkscape:label'] || child.attrs['data-name'] ? { name: child.attrs['inkscape:label'] ?? child.attrs['data-name'] } : {}),
			...(opacity !== undefined && Number.isFinite(opacity) && opacity < 1 ? { opacity } : {}),
			...(hidden ? { visible: false } : {}),
			...(blendMode && blendMode !== 'normal' ? { blendMode } : {}),
			...(filters.length ? { filters } : {})
		};
		// A blend's in-betweens are regenerated from its keys.
		if (child.attrs['data-vector-blend-step'] !== undefined) return out;
		const operation = child.attrs['data-vector-boolean-operation'];
		if (BOOLEAN_OPERATIONS.includes(operation as VectorBooleanOperation)) (meta as { booleanOperation?: VectorBooleanOperation }).booleanOperation = operation as VectorBooleanOperation;
		const resizing = child.attrs['data-vector-resizing'] !== undefined ? sanitizeVectorResizing(parseJson(child.attrs['data-vector-resizing'])) : null;
		if (resizing) (meta as { resizing?: VectorResizing }).resizing = resizing;
		const connector = child.attrs['data-vector-connector'] !== undefined ? sanitizeVectorConnector(parseJson(child.attrs['data-vector-connector'])) : null;
		if (connector) (meta as { connector?: VectorConnector }).connector = connector;
		const lens = child.attrs['data-vector-lens'] !== undefined ? sanitizeVectorLens(parseJson(child.attrs['data-vector-lens'])) : null;
		if (lens) (meta as { lens?: VectorLens }).lens = lens;
		if (child.name === 'g' && child.attrs['data-vector-frame'] !== undefined) {
			const node = frameGroup(child, s, m, meta);
			if (node) out.push(node);
			return out;
		}
		if (child.name === 'g' && child.attrs['data-vector-mask'] !== undefined) {
			const node = maskGroup(child, s, m, meta);
			if (node) out.push(node);
			return out;
		}
		if (child.name === 'g' && child.attrs['data-vector-live'] !== undefined) {
			const node = liveNode(child, s, m, meta);
			if (node) out.push(node);
			return out;
		}
		if (child.name === 'use') {
			const node = useInstance(child, m, meta);
			if (node) out.push(node);
			return out;
		}
		if (child.name === 'g' && child.attrs['data-vector-instance'] !== undefined) {
			const node = ownInstance(child, m, meta);
			if (node) out.push(node);
			return out;
		}
		if (child.name === 'g' && child.attrs['data-vector-text'] !== undefined) {
			const node = ownText(child, m, meta);
			if (node) out.push(node);
			return out;
		}
		if (child.name === 'text') {
			const node = foreignText(child, s, m, meta);
			if (node) out.push(node);
			return out;
		}
		if (child.name === 'g' && child.attrs['data-vector-path'] !== undefined && child.attrs['data-vector-fills'] !== undefined) {
			const node = stackedPath(child, s, m, meta);
			if (node) out.push(node);
			return out;
		}
		if (child.name === 'g' && child.attrs['data-vector-path'] !== undefined) {
			const node = mergedPath(child, s, m, meta);
			if (node) out.push(node);
			return out;
		}
		if (child.name === 'g' || child.name === 'svg' || child.name === 'a' || child.name === 'switch') {
			const children = visit(child, s, m);
			if (!children.length) return out;
			const group: VectorGroupNode = { id: idFor(child), type: 'group', ...meta, children };
			const blend = child.name === 'g' ? blendFromAttribute(child.attrs['data-vector-blend'], m) : null;
			if (blend) group.blend = blend;
			out.push(group);
			return out;
		}
		const subpaths = shapeOf(child);
		if (!subpaths || !subpaths.length) return out;
		const node = placed(
			withOpacities(
				{
					id: idFor(child),
					type: 'path',
					...meta,
					subpaths,
					fill: child.name === 'line' ? null : (sanitizeVectorShadedPaint(parseJson(child.attrs['data-vector-shading'])) ?? paint(s.fill)),
					stroke: paint(s.stroke),
					...strokeStyle(s)
				},
				s
			),
			m
		);
		out.push(node);
		return out;
	};

	rootStyle = readStyle(root, rootStyle);
	// Our own symbols come back whether or not an instance uses them.
	const walkAll = (el: Element) => {
		if (el.name === 'symbol' && el.attrs['data-vector-symbol'] !== undefined) symbolFor(el);
		el.children.forEach(walkAll);
	};
	walkAll(root);
	const nodes = visit(root, rootStyle, rootMatrix);
	return resolveVectorSymbols({ width, height, nodes, ...(symbols.length ? { symbols } : {}) });
}
