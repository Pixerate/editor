/**
 * Lens objects, after CorelDRAW's Lens (concept only): a path with `lens` set shows what is drawn
 * below it changed, inside its outline. This is the extension point described in `mask.ts`: the
 * lens draws as a clip group (the mask model's `clip`) whose mask is its own outline and whose
 * contents are the backdrop changed by the lens, then its own fill and stroke on top. Bounds,
 * hit-testing and snapping use the lens's own shape (`vectorAppearanceShapes` is not changed).
 *
 * The backdrop (`lensView`) is everything drawn before the lens in the document, in the lens's
 * parent space. It is derived: `resolveVectorLenses` brings it up to date after every edit (the
 * controller's refresh, like connectors' routes and instances' art) and `stripVectorLensViews`
 * removes it from saved documents. Lenses change the backdrop as vectors (scaled or warped
 * paths, recoloured paints, outlines), so SVG, PDF and the canvas all draw them the same way.
 */
import { bezierPathBounds, transformBezierPath, type AffineMatrix, type BezierPath } from '../canvas/pathops/bezier.js';
import { invertMatrix, isIdentityMatrix } from '../geom/affine.js';
import { vectorChildAppearanceShapes, type VectorAppearanceShape } from './appearance.js';
import { parseVectorColor, type VectorRgba } from './gradient.js';
import { bezierToSubpaths, subpathsToBezier } from './geometry.js';
import { mapBezierPath } from './pathMap.js';
import { VECTOR_LENS_TYPES, type Vec2, type VectorDocument, type VectorGroupNode, type VectorLens, type VectorLensType, type VectorNode, type VectorPaint, type VectorPathNode } from './types.js';

/** A path whose `lens` is set. */
export type VectorLensNode = VectorPathNode & { lens: VectorLens };

/** Whether `node` is a lens. */
export function isVectorLens(node: VectorNode | null | undefined): node is VectorLensNode {
	return !!node && node.type === 'path' && !!node.lens && (VECTOR_LENS_TYPES as readonly string[]).includes(node.lens.type);
}

export const VECTOR_LENS_LABELS: Record<VectorLensType, string> = {
	transparency: 'Transparency',
	magnify: 'Magnify',
	fisheye: 'Fish Eye',
	brighten: 'Brighten',
	invert: 'Invert',
	tintedGrayscale: 'Tinted Grayscale',
	colorAdd: 'Color Add',
	colorLimit: 'Color Limit',
	heatMap: 'Heat Map',
	wireframe: 'Wireframe'
};

/** Each lens type's amount range, default amount and default colour (null: it uses none). */
export const VECTOR_LENS_SPECS: Record<VectorLensType, { min: number; max: number; amount: number; color: string | null; unit: string }> = {
	transparency: { min: 0, max: 100, amount: 50, color: null, unit: 'percent see-through' },
	magnify: { min: 1, max: 20, amount: 2, color: null, unit: 'times' },
	fisheye: { min: -100, max: 100, amount: 50, color: null, unit: 'percent, negative pinches' },
	brighten: { min: -100, max: 100, amount: 40, color: null, unit: 'percent, negative darkens' },
	invert: { min: 0, max: 100, amount: 100, color: null, unit: 'percent strength' },
	tintedGrayscale: { min: 0, max: 100, amount: 100, color: '#b45309', unit: 'percent strength' },
	colorAdd: { min: 0, max: 100, amount: 50, color: '#ff0000', unit: 'percent of the colour added' },
	colorLimit: { min: 0, max: 100, amount: 100, color: '#22c55e', unit: 'percent strength' },
	heatMap: { min: 0, max: 100, amount: 0, color: null, unit: 'percent the palette is turned' },
	wireframe: { min: 0, max: 100, amount: 100, color: '#0f172a', unit: 'percent outline opacity' }
};

/** Reads lens settings from untrusted data; null when invalid. Missing values take the type's defaults. */
export function sanitizeVectorLens(value: unknown): VectorLens | null {
	if (!value || typeof value !== 'object') return null;
	const r = value as Record<string, unknown>;
	if (typeof r.type !== 'string' || !(VECTOR_LENS_TYPES as readonly string[]).includes(r.type)) return null;
	const type = r.type as VectorLensType;
	const spec = VECTOR_LENS_SPECS[type];
	const amount = typeof r.amount === 'number' && Number.isFinite(r.amount) ? Math.min(spec.max, Math.max(spec.min, r.amount)) : spec.amount;
	const out: VectorLens = { type, amount };
	if (spec.color !== null) out.color = typeof r.color === 'string' && parseVectorColor(r.color) ? r.color : spec.color;
	return out;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const hex2 = (v: number) =>
	Math.round(Math.min(1, Math.max(0, v)) * 255)
		.toString(16)
		.padStart(2, '0');
const formatRgba = (c: VectorRgba) => (c[3] >= 1 ? `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}` : `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${Math.round(c[3] * 1000) / 1000})`);
const luma = (c: VectorRgba) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const mix = (a: VectorRgba, b: readonly number[], t: number): VectorRgba => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3]];

const HEAT: [number, string][] = [
	[0, '#1e1b4b'],
	[0.25, '#2563eb'],
	[0.5, '#22c55e'],
	[0.7, '#facc15'],
	[0.85, '#f97316'],
	[1, '#dc2626']
];
const heatAt = (t: number): number[] => {
	const u = ((t % 1) + 1) % 1;
	for (let i = 1; i < HEAT.length; i++) {
		if (u <= HEAT[i][0]) {
			const a = parseVectorColor(HEAT[i - 1][1])!;
			const b = parseVectorColor(HEAT[i][1])!;
			const k = (u - HEAT[i - 1][0]) / (HEAT[i][0] - HEAT[i - 1][0]);
			return [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * k);
		}
	}
	return parseVectorColor(HEAT[HEAT.length - 1][1])!.slice(0, 3);
};

/** How a colour lens changes one colour (0–1 channels), or null for lenses that do not recolour. */
export function vectorLensColorMap(lens: VectorLens): ((c: VectorRgba) => VectorRgba) | null {
	const tint = parseVectorColor(lens.color ?? '#000000') ?? [0, 0, 0, 1];
	const s = Math.min(1, Math.max(0, lens.amount / 100));
	switch (lens.type) {
		case 'brighten': {
			const a = Math.min(1, Math.max(-1, lens.amount / 100));
			return (c) => (a >= 0 ? mix(c, [1, 1, 1], a) : mix(c, [0, 0, 0], -a));
		}
		case 'invert':
			return (c) => mix(c, [1 - c[0], 1 - c[1], 1 - c[2]], s);
		case 'tintedGrayscale':
			return (c) => {
				// Dark to black, middle grey to the tint, light to white.
				const l = luma(c);
				const duo = l < 0.5 ? [tint[0] * 2 * l, tint[1] * 2 * l, tint[2] * 2 * l] : [0, 1, 2].map((k) => tint[k] + (1 - tint[k]) * (2 * l - 1));
				return mix(c, duo, s);
			};
		case 'colorAdd':
			return (c) => [Math.min(1, c[0] + tint[0] * s), Math.min(1, c[1] + tint[1] * s), Math.min(1, c[2] + tint[2] * s), c[3]];
		case 'colorLimit':
			return (c) => [c[0] * (1 - s + s * tint[0]), c[1] * (1 - s + s * tint[1]), c[2] * (1 - s + s * tint[2]), c[3]];
		case 'heatMap':
			return (c) => [...heatAt(luma(c) + lens.amount / 100), c[3]] as VectorRgba;
		default:
			return null;
	}
}

/** A paint with every colour in it (solid, gradient stops, mesh and freeform colours) passed through `f`. */
export function mapVectorPaintColors(paint: VectorPaint | undefined, f: (c: VectorRgba) => VectorRgba): VectorPaint | undefined {
	const one = (color: string) => {
		const c = parseVectorColor(color);
		return c ? formatRgba(f(c)) : color;
	};
	if (paint == null || paint === 'none') return paint;
	if (typeof paint === 'string') return one(paint);
	const p = paint as unknown as Record<string, unknown>;
	const out: Record<string, unknown> = { ...p };
	if (Array.isArray(p.stops)) out.stops = (p.stops as { color: string }[]).map((s) => ({ ...s, color: one(s.color) }));
	if (Array.isArray(p.colors)) out.colors = (p.colors as string[]).map(one);
	if (Array.isArray(p.points)) out.points = (p.points as { color?: unknown }[]).map((q) => (typeof q.color === 'string' ? { ...q, color: one(q.color) } : q));
	return out as unknown as VectorPaint;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const drawnCache = new WeakMap<VectorLensNode, VectorGroupNode>();

const STYLE_OFF = { effects: undefined, transform: undefined, opacity: undefined, blendMode: undefined, filters: undefined, lens: undefined, lensView: undefined, connector: undefined } as const;

/** A shape as a plain path node in its source's style. */
function shapePath(shape: VectorAppearanceShape, id: string, path: BezierPath, extra: Partial<VectorPathNode> = {}): VectorPathNode {
	const { id: _i, subpaths: _s, booleanOperation: _b, blendStep: _bs, locked: _l, visible: _v, ...style } = shape.source;
	return { ...style, ...STYLE_OFF, id, type: 'path', subpaths: bezierToSubpaths(path), ...(shape.opacity < 1 ? { opacity: shape.opacity } : {}), ...extra } as VectorPathNode;
}

/**
 * What a lens draws, in its own space (its `transform` and opacity are kept on the group): a clip
 * group with the lens outline as the mask and the changed backdrop as contents, then the lens's
 * own fill (see-through for a transparency lens, invisible but there for the others) and stroke.
 */
export function vectorLensDrawn(node: VectorLensNode): VectorGroupNode {
	const hit = drawnCache.get(node);
	if (hit) return hit;
	const { lens } = node;
	const own = subpathsToBezier(node.subpaths);
	const box = bezierPathBounds(own);
	const children: VectorNode[] = [];
	if (box && lens.type !== 'transparency') {
		const c: Vec2 = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
		const inv = node.transform && !isIdentityMatrix(node.transform) ? invertMatrix(node.transform) : null;
		// What can show through: magnify reaches only the middle 1/k of the lens.
		const k = lens.type === 'magnify' ? Math.max(1, lens.amount) : 1;
		const reach = { minX: c.x - (c.x - box.minX) / k, maxX: c.x + (box.maxX - c.x) / k, minY: c.y - (c.y - box.minY) / k, maxY: c.y + (box.maxY - c.y) / k };
		let map: ((p: BezierPath) => BezierPath) | null = null;
		if (lens.type === 'magnify') {
			const m: AffineMatrix = [k, 0, 0, k, c.x * (1 - k), c.y * (1 - k)];
			map = (p) => transformBezierPath(p, m);
		} else if (lens.type === 'fisheye') {
			const a = Math.min(100, Math.max(-100, lens.amount));
			const gamma = a >= 0 ? 1 / (1 + a / 25) : 1 - a / 25;
			const rx = Math.max(1e-9, (box.maxX - box.minX) / 2);
			const ry = Math.max(1e-9, (box.maxY - box.minY) / 2);
			const warp = (p: Vec2): Vec2 => {
				const dx = (p.x - c.x) / rx;
				const dy = (p.y - c.y) / ry;
				const u = Math.hypot(dx, dy);
				if (u >= 1 || u < 1e-12) return p;
				const f = u ** gamma / u;
				return { x: c.x + dx * f * rx, y: c.y + dy * f * ry };
			};
			map = (p) => mapBezierPath(p, warp, 0.25);
		}
		const recolour = vectorLensColorMap(lens);
		const wire = lens.type === 'wireframe' ? (lens.color ?? '#000000') : null;
		const contents: VectorPathNode[] = [];
		(node.lensView ?? []).forEach((below, i) => {
			for (const shape of vectorChildAppearanceShapes(below, i)) {
				const path = inv ? transformBezierPath(shape.path, inv) : shape.path;
				const b = bezierPathBounds(path);
				if (!b || b.maxX < reach.minX || b.minX > reach.maxX || b.maxY < reach.minY || b.minY > reach.maxY) continue;
				const id = `${node.id}~lens${contents.length}`;
				const changed = map ? map(path) : path;
				if (wire) {
					contents.push(shapePath(shape, id, changed, { fill: null, fills: undefined, stroke: wire, strokes: undefined, strokeWidth: 1, strokeAlign: undefined, strokeDasharray: undefined, strokeWidthProfile: undefined, opacity: Math.min(1, Math.max(0, lens.amount / 100)) }));
				} else if (recolour) {
					const fills = shape.source.fills?.map((l) => ({ ...l, paint: mapVectorPaintColors(l.paint, recolour) ?? null }));
					const strokes = shape.source.strokes?.map((l) => ({ ...l, paint: mapVectorPaintColors(l.paint, recolour) ?? null }));
					contents.push(shapePath(shape, id, changed, { fill: mapVectorPaintColors(shape.source.fill, recolour) ?? null, stroke: mapVectorPaintColors(shape.source.stroke, recolour) ?? null, ...(fills ? { fills } : {}), ...(strokes ? { strokes } : {}) } as Partial<VectorPathNode>));
				} else contents.push(shapePath(shape, id, changed));
			}
		});
		if (contents.length) {
			const outline: VectorPathNode = { id: `${node.id}~lens-clip`, type: 'path', subpaths: node.subpaths, fill: '#000000', stroke: null, ...(node.fillRule ? { fillRule: node.fillRule } : {}) };
			children.push({ id: `${node.id}~lens-view`, type: 'group', mask: { type: 'clip' }, children: [outline, ...contents] });
		}
	}
	// The lens's own fill: see-through for a transparency lens, otherwise there to be hit only.
	const { lens: _l, lensView: _v, transform: _t, opacity: _o, effects: _e, blendMode: _bm, filters: _f, ...style } = node;
	const fillOpacity = lens.type === 'transparency' ? 1 - Math.min(100, Math.max(0, lens.amount)) / 100 : 0;
	children.push({ ...style, id: `${node.id}~lens-fill`, stroke: null, strokes: undefined, opacity: fillOpacity });
	const stroked = (node.strokes?.length ?? 0) > 0 || (node.stroke != null && node.stroke !== 'none');
	if (stroked) children.push({ ...style, id: `${node.id}~lens-stroke`, fill: null, fills: undefined });
	const out: VectorGroupNode = {
		id: node.id,
		type: 'group',
		...(node.name !== undefined ? { name: node.name } : {}),
		...(node.transform ? { transform: node.transform } : {}),
		...(node.opacity !== undefined ? { opacity: node.opacity } : {}),
		...(node.blendMode ? { blendMode: node.blendMode } : {}),
		...(node.filters?.length ? { filters: node.filters } : {}),
		children
	};
	drawnCache.set(node, out);
	return out;
}

// ---------------------------------------------------------------------------
// Backdrops
// ---------------------------------------------------------------------------

const sameMatrix = (a: AffineMatrix | undefined, b: AffineMatrix | undefined) => (!a && !b) || (!!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < 1e-12));

/** Whether two backdrops draw the same (the same nodes, wrappers with the same matrix and contents). */
function sameView(a: readonly VectorNode[] | undefined, b: readonly VectorNode[]): boolean {
	if (!a || a.length !== b.length) return false;
	return a.every((n, i) => {
		const m = b[i];
		if (n === m) return true;
		return n.type === 'group' && m.type === 'group' && n.id === m.id && n.id.endsWith('~below') && sameMatrix(n.transform, m.transform) && sameView(n.children, m.children);
	});
}

/** Whether any node in the tree is a lens. */
function hasLens(nodes: readonly VectorNode[]): boolean {
	return nodes.some((n) => isVectorLens(n) || (n.type === 'group' && hasLens(n.children)));
}

/**
 * The document with every lens's `lensView` up to date: what is drawn before it, in its parent's
 * space (outer levels wrapped in a group with the inverse of the parents' transforms). Node
 * objects are kept where nothing changes, so the document is the same object when no backdrop
 * did. Lenses inside symbols are left alone.
 */
export function resolveVectorLenses(doc: VectorDocument): VectorDocument {
	if (!hasLens(doc.nodes)) return doc;
	let changed = false;
	const walk = (list: readonly VectorNode[], outer: VectorNode[], depth: number): VectorNode[] => {
		const below = outer.slice();
		const out = list.map((n) => {
			let next = n;
			if (isVectorLens(n)) {
				if (!sameView(n.lensView, below)) next = { ...n, lensView: below.slice() };
			} else if (n.type === 'group' && hasLens(n.children)) {
				// Inside the group, what is below is seen through the inverse of its transform.
				const m = n.transform && !isIdentityMatrix(n.transform) ? invertMatrix(n.transform) : null;
				const inner: VectorNode[] = below.length ? (m ? [{ id: `${n.id}:${depth}~below`, type: 'group', transform: m, children: below.slice() }] : below.slice()) : [];
				const children = walk(n.children, inner, depth + 1);
				if (children !== n.children) next = { ...n, children };
			}
			if (next !== n) changed = true;
			below.push(next);
			return next;
		});
		return out.some((n, i) => n !== list[i]) ? out : (list as VectorNode[]);
	};
	const nodes = walk(doc.nodes, [], 0);
	return changed ? { ...doc, nodes } : doc;
}

/** The document without lens backdrops (what is saved). */
export function stripVectorLensViews(doc: VectorDocument): VectorDocument {
	if (!hasLens(doc.nodes)) return doc;
	const strip = (list: VectorNode[]): VectorNode[] =>
		list.map((n) => {
			if (n.type === 'path' && n.lensView) {
				const { lensView: _v, ...rest } = n;
				return rest;
			}
			if (n.type === 'group') return { ...n, children: strip(n.children) };
			return n;
		});
	return { ...doc, nodes: strip(doc.nodes) };
}
