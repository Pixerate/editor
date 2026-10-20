/**
 * Lottie (Bodymovin JSON, v5) export and import for vector documents, keeping path effects live.
 *
 * After effectcraft's `crates/lottie/src/shapes.rs` (`export_items` / `import_items`: shape items
 * `gr`, `rc`, `el`, `sr`, `sh`, `fl`, `st`, `gf`, `gs`, `tm`, `rp`, `rd`, `op`, `pb`, `tw`, `zz`, `mm`,
 * `tr`; stroke fields, dashes, flat gradient stops) and `anim.rs` (keyframed values and their
 * bezier easing) (MIT OR Apache-2.0, © ArtCraft Team and contributors; see THIRD_PARTY_NOTICES.md).
 *
 * Our path effects map onto Lottie's shape modifiers one to one (trim, round corners, pucker &
 * bloat, twist, zig zag, offset, merge, repeater), so they stay live both ways; wiggle and envelope
 * effects, masks, frames, text and instances export as their drawn shapes, filters are left out,
 * and `notes` lists everything that was approximated. Import reads one frame of the animation.
 */

import type { AffineMatrix } from '../geom/types.js';
import { applyMatrix, matrixRotation, multiplyMatrices, rotateMatrix, scaleMatrix, translateMatrix } from '../geom/affine.js';
import { bezierPathBounds, type BezierPath } from '../canvas/pathops/bezier.js';
import { expandVectorAppearance, sanitizeVectorEffects, vectorAppearanceShapes } from './appearance.js';
import { bezierToSubpaths, ellipseSubpath, nodeMatrix, rectSubpath, subpathsToBezier, transformVectorNode, vectorStrokeOutline } from './geometry.js';
import { expandVectorGradientStops, isVectorGradient, parseVectorColor, vectorGradientHandles } from './gradient.js';
import { vectorFills, vectorStrokes } from './paintLayers.js';
import { isVectorShadedPaint } from './shading.js';
import { hasStrokeExtras } from './stroke.js';
import { isVectorMaskGroup } from './mask.js';
import { isVectorFrame, vectorFrameDrawn } from './frames.js';
import { isVectorSymmetryGroup } from './symmetry.js';
import { vectorPathLocalBounds } from './svg.js';
import type {
	VectorBlendMode,
	VectorDocument,
	VectorEffect,
	VectorGradient,
	VectorGroupNode,
	VectorNode,
	VectorPaint,
	VectorPaintLayer,
	VectorPathNode,
	VectorStrokeLayer,
	VectorSubpath,
	Vec2
} from './types.js';

type Json = Record<string, unknown>;

/** A Lottie animation as plain JSON. */
export type VectorLottie = Json & { v: string; fr: number; ip: number; op: number; w: number; h: number; layers: Json[] };

const round = (v: number) => Math.round(v * 1e4) / 1e4;
const st = (k: unknown) => ({ a: 0, k });
const BLEND: Record<string, number> = {
	normal: 0,
	multiply: 1,
	screen: 2,
	overlay: 3,
	darken: 4,
	lighten: 5,
	'color-dodge': 6,
	'color-burn': 7,
	'hard-light': 8,
	'soft-light': 9,
	difference: 10,
	exclusion: 11,
	hue: 12,
	saturation: 13,
	color: 14,
	luminosity: 15,
	'linear-dodge': 16
};
const BLEND_BACK = Object.fromEntries(Object.entries(BLEND).map(([k, v]) => [v, k])) as Record<number, VectorBlendMode>;
const JOIN: Record<string, number> = { miter: 1, round: 2, bevel: 3 };
const CAP: Record<string, number> = { butt: 1, round: 2, square: 3 };
const MERGE = ['merge', 'add', 'subtract', 'intersect', 'exclude'] as const;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Options of `vectorDocumentToLottie`. */
export interface VectorLottieExportOptions {
	/** Frames per second (default 30). */
	fps?: number;
	/** Length in frames (default 1: a still). */
	frames?: number;
	/** The animation's name (default "Vector"). */
	name?: string;
}

/** What `vectorDocumentToLottie` returns: the animation and what was approximated. */
export interface VectorLottieExport {
	lottie: VectorLottie;
	notes: string[];
}

const label = (n: VectorNode) => n.name ?? n.id;

function shapeOf(sp: VectorSubpath, m?: AffineMatrix): Json {
	const map = (p: Vec2) => (m ? applyMatrix(m, p) : p);
	const v: number[][] = [];
	const i: number[][] = [];
	const o: number[][] = [];
	for (const a of sp.anchors) {
		const p = map(a);
		const pin = a.in ? map(a.in) : p;
		const pout = a.out ? map(a.out) : p;
		v.push([round(p.x), round(p.y)]);
		i.push([round(pin.x - p.x), round(pin.y - p.y)]);
		o.push([round(pout.x - p.x), round(pout.y - p.y)]);
	}
	return { c: sp.closed, v, i, o };
}

function colorOf(css: string): number[] {
	const c = parseVectorColor(css) ?? [0, 0, 0, 1];
	return [round(c[0]), round(c[1]), round(c[2]), 1];
}

/** The fill / stroke items of one paint layer, or null (with a note) when it cannot be exported. */
function paintItem(kind: 'fill' | 'stroke', layer: VectorPaintLayer | VectorStrokeLayer, node: VectorPathNode, notes: string[]): Json | null {
	if (layer.visible === false) return null;
	const paint = layer.paint;
	if (paint === null || paint === undefined || paint === 'none') return null;
	let alpha = 1;
	const base: Json = {};
	if (kind === 'stroke') {
		const s = layer as VectorStrokeLayer;
		const width = s.strokeWidth ?? node.strokeWidth ?? 1;
		base.w = st(round(width));
		base.lc = CAP[s.strokeLinecap ?? node.strokeLinecap ?? 'butt'];
		base.lj = JOIN[s.strokeLinejoin ?? node.strokeLinejoin ?? 'miter'];
		base.ml = 4;
		const dash = s.strokeDasharray ?? node.strokeDasharray;
		if (dash?.length) base.d = dash.map((v, k) => ({ n: k % 2 === 0 ? 'd' : 'g', nm: k % 2 === 0 ? 'dash' : 'gap', v: st(round(v)) }));
	}
	const blend = layer.blendMode && layer.blendMode !== 'normal' ? BLEND[layer.blendMode] : undefined;
	if (layer.blendMode && layer.blendMode !== 'normal' && blend === undefined) notes.push(`${label(node)}: blend mode ${layer.blendMode} has no Lottie equivalent (normal used).`);
	const extra = blend !== undefined ? { bm: blend } : {};
	if (typeof paint === 'string') {
		const c = parseVectorColor(paint);
		if (!c) return null;
		alpha = c[3];
		return { ty: kind === 'fill' ? 'fl' : 'st', ...base, c: st(colorOf(paint)), o: st(round(100 * alpha * (layer.opacity ?? 1))), ...(kind === 'fill' && node.fillRule === 'evenodd' ? { r: 2 } : { r: 1 }), ...extra };
	}
	if (isVectorShadedPaint(paint)) {
		notes.push(`${label(node)}: mesh and freeform gradients have no Lottie equivalent (their first colour used).`);
		const first = paint.type === 'mesh' ? paint.colors[0] : paint.points[0]?.color;
		return first ? { ty: kind === 'fill' ? 'fl' : 'st', ...base, c: st(colorOf(first)), o: st(round(100 * (layer.opacity ?? 1))), r: 1, ...extra } : null;
	}
	if (!isVectorGradient(paint)) return null;
	const g = paint as VectorGradient;
	if (g.type === 'conic' || g.type === 'diamond' || g.type === 'reflected') notes.push(`${label(node)}: a ${g.type} gradient has no Lottie equivalent (${g.type === 'conic' || g.type === 'diamond' ? 'radial' : 'linear'} used).`);
	if (kind === 'stroke' && g.strokeMode && g.strokeMode !== 'within') notes.push(`${label(node)}: gradients along or across a stroke have no Lottie equivalent (painted within).`);
	const bounds = vectorPathLocalBounds(node);
	const h = vectorGradientHandles(g, bounds);
	const radial = g.type === 'radial' || g.type === 'conic' || g.type === 'diamond';
	const stops = expandVectorGradientStops(g);
	const flat: number[] = [];
	for (const s of stops) flat.push(round(s.offset), ...colorOf(s.color).slice(0, 3));
	if (stops.some((s) => (s.opacity ?? 1) < 1)) for (const s of stops) flat.push(round(s.offset), round(s.opacity ?? 1));
	const out: Json = {
		ty: kind === 'fill' ? 'gf' : 'gs',
		...base,
		o: st(round(100 * (layer.opacity ?? 1))),
		s: st([round(h.start.x), round(h.start.y)]),
		e: st([round(h.end.x), round(h.end.y)]),
		t: radial ? 2 : 1,
		g: { p: stops.length, k: st(flat) },
		...(kind === 'fill' ? { r: node.fillRule === 'evenodd' ? 2 : 1 } : {}),
		...extra
	};
	if (radial && h.focal) {
		const r = Math.hypot(h.end.x - h.start.x, h.end.y - h.start.y) || 1;
		const d = { x: h.focal.x - h.start.x, y: h.focal.y - h.start.y };
		out.h = st(round((100 * Math.hypot(d.x, d.y)) / r));
		out.a = st(round(((Math.atan2(d.y, d.x) - Math.atan2(h.end.y - h.start.y, h.end.x - h.start.x)) * 180) / Math.PI));
	}
	return out;
}

/** A path effect as a Lottie shape modifier (in the node's own space, `c` its box centre), or null when Lottie has none. */
function effectItem(e: VectorEffect, c: Vec2, node: VectorNode, notes: string[]): Json | null {
	const hd = e.enabled === false ? { hd: true } : {};
	const p = e.params as Record<string, unknown>;
	const n = (k: string) => Number(p[k] ?? 0);
	const v = (k: string) => (p[k] as Vec2 | undefined) ?? { x: 0, y: 0 };
	switch (e.type) {
		case 'trim':
			return { ty: 'tm', nm: 'Trim Paths', s: st(n('start')), e: st(n('end')), o: st(n('offset')), m: p.mode === 'individual' ? 2 : 1, ...hd };
		case 'roundCorners':
			return { ty: 'rd', nm: 'Round Corners', r: st(n('radius')), ...hd };
		case 'puckerBloat':
			return { ty: 'pb', nm: 'Pucker & Bloat', a: st(n('amount')), ...hd };
		case 'twist':
			return { ty: 'tw', nm: 'Twist', a: st(n('angle')), c: st([round(c.x + v('center').x), round(c.y + v('center').y)]), ...hd };
		case 'zigzag':
			return { ty: 'zz', nm: 'Zig Zag', s: st(n('size')), r: st(n('ridges')), pt: st(p.smooth ? 2 : 1), ...hd };
		case 'offset':
			if (n('copies') > 1) notes.push(`${label(node)}: Offset Paths copies are not part of Lottie (one exported).`);
			return { ty: 'op', nm: 'Offset Paths', a: st(n('amount')), lj: JOIN[String(p.join ?? 'miter')] ?? 1, ml: st(n('miterLimit') || 4), ...hd };
		case 'merge':
			return { ty: 'mm', nm: 'Merge Paths', mm: MERGE.indexOf((p.mode as (typeof MERGE)[number]) ?? 'merge') + 1 || 1, ...hd };
		case 'repeater': {
			const anchor = v('anchor');
			const pos = v('position');
			const scale = v('scale');
			return {
				ty: 'rp',
				nm: 'Repeater',
				c: st(n('copies')),
				o: st(n('offset')),
				m: p.composite === 'above' ? 1 : 2,
				tr: { ty: 'tr', a: st([round(c.x + anchor.x), round(c.y + anchor.y)]), p: st([round(pos.x), round(pos.y)]), s: st([round(scale.x), round(scale.y)]), r: st(n('rotation')), so: st(n('startOpacity')), eo: st(n('endOpacity')) },
				...hd
			};
		}
		default:
			return null;
	}
}

/** The transform item of a group: its node's rigid placement and opacity. */
function transformItem(m: AffineMatrix, opacity: number): Json {
	return { ty: 'tr', a: st([0, 0]), p: st([round(m[4]), round(m[5])]), s: st([100, 100]), r: st(round(matrixRotation(m))), o: st(round(opacity * 100)) };
}

const boxCentre = (path: BezierPath): Vec2 => {
	const b = bezierPathBounds(path);
	return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 };
};

/** A path node as shape items: its subpaths, its effects, its strokes and fills (top first). */
function pathItems(node: VectorPathNode, notes: string[]): Json[] {
	const items: Json[] = node.subpaths.filter((sp) => sp.anchors.length).map((sp, k) => ({ ty: 'sh', nm: `Path ${k + 1}`, ks: st(shapeOf(sp)) }));
	const c = boxCentre(subpathsToBezier(node.subpaths));
	const effects = (node.effects ?? []).map((e) => effectItem(e, c, node, notes)).filter((e): e is Json => !!e);
	// Repeaters copy what is painted, so they go after the paint; the other modifiers before it.
	const repeaters = effects.filter((e) => e.ty === 'rp');
	items.push(...effects.filter((e) => e.ty !== 'rp'));
	if (repeaters.length && effects.indexOf(repeaters[0]) < effects.length - 1) notes.push(`${label(node)}: effects after a repeater act before it in Lottie.`);
	const fills = vectorFills(node);
	const strokes = vectorStrokes(node);
	const out: Json[] = [];
	for (const s of [...strokes].reverse()) {
		if (hasStrokeExtras({ ...node, ...s })) continue;
		const it = paintItem('stroke', s, node, notes);
		if (it) out.push(it);
	}
	for (const f of [...fills].reverse()) {
		const it = paintItem('fill', f, node, notes);
		if (it) out.push(it);
	}
	return [...items, ...out, ...repeaters];
}

/** A node as one Lottie group (or null when it draws nothing). */
function nodeGroup(node: VectorNode, notes: string[]): Json | null {
	if (node.visible === false) return null;
	if (node.filters?.length) notes.push(`${label(node)}: filters (shadows, glows, blurs) are not part of Lottie (left out).`);
	const m = nodeMatrix(node);
	let items: Json[] = [];
	const live = (node.effects ?? []).some((e) => e.enabled !== false && (e.type === 'wiggle' || e.type === 'envelope' || e.type === 'contour'));
	if (node.type === 'text' || node.type === 'instance' || live || isVectorMaskGroup(node) || isVectorFrame(node) || isVectorSymmetryGroup(node)) {
		// Drawn shapes: text as glyph outlines, instances as their art, masks clipped, frames as clip groups.
		if (live) notes.push(`${label(node)}: wiggle, envelope and contour effects have no Lottie equivalent (exported as drawn).`);
		if (isVectorMaskGroup(node) && node.mask?.type !== 'clip') notes.push(`${label(node)}: opacity masks are not exported (the contents are drawn whole).`);
		const drawn = isVectorFrame(node) ? vectorFrameDrawn(node) : node;
		const shapes = isVectorMaskGroup(drawn) && drawn.mask?.type === 'clip' ? vectorAppearanceShapes({ ...drawn, transform: undefined }) : null;
		if (shapes) {
			// The clipped result: each shape in its source's style, top first.
			for (const s of [...shapes].reverse()) {
				const source = { ...s.source, subpaths: bezierToSubpaths(s.path), effects: null, opacity: s.opacity } as VectorPathNode;
				items.push({ ty: 'gr', nm: source.name ?? 'Shape', it: [...pathItems(source, notes), transformItem([1, 0, 0, 1, 0, 0], s.opacity)], np: 0 });
			}
		} else {
			const expanded = expandVectorAppearance({ ...node, transform: undefined } as VectorNode);
			const g = nodeGroup(expanded, notes);
			if (g) items = (g.it as Json[]).filter((it) => it.ty !== 'tr');
			if (node.type === 'text' && !items.length) notes.push(`${label(node)}: text without glyph outlines (load fonts) is left out.`);
		}
	} else if (node.type === 'path') {
		items = pathItems(node, notes);
		// Stroke alignment, arrowheads and width profiles: the stroke exported as its filled outline.
		for (const s of [...vectorStrokes(node)].reverse()) {
			if (!hasStrokeExtras({ ...node, ...s }) || s.visible === false) continue;
			const asNode = { ...node, ...s, stroke: s.paint, fills: undefined, strokes: undefined } as VectorPathNode;
			const outline = vectorStrokeOutline(asNode);
			const fill = paintItem('fill', { paint: s.paint, opacity: s.opacity, blendMode: s.blendMode }, { ...node, fillRule: 'nonzero' }, notes);
			if (outline.length && fill) items.unshift({ ty: 'gr', nm: 'Stroke', it: [...bezierToSubpaths(outline).map((sp) => ({ ty: 'sh', ks: st(shapeOf(sp)) })), fill, transformItem([1, 0, 0, 1, 0, 0], 1)], np: 0 });
		}
	} else {
		const g = node as VectorGroupNode;
		for (const child of [...g.children].reverse()) {
			const it = nodeGroup(child, notes);
			if (it) items.push(it);
		}
		if (g.liveBoolean) {
			// Merge Paths over the operands' paths, painted in the bottom operand's style.
			notes.push(`${label(node)}: a live boolean exports as Merge Paths in its bottom operand's style.`);
			const strip = (list: Json[]): Json[] => list.flatMap((it) => (it.ty === 'gr' ? [{ ...it, it: strip(it.it as Json[]) }] : ['sh', 'tr'].includes(String(it.ty)) ? [it] : []));
			items = strip(items);
			const op = MERGE.indexOf(g.liveBoolean === 'subtract' ? 'subtract' : g.liveBoolean === 'intersect' ? 'intersect' : g.liveBoolean === 'exclude' ? 'exclude' : 'add') + 1;
			items.push({ ty: 'mm', nm: 'Merge Paths', mm: op });
			const bottom = g.children.find((c) => c.type === 'path') as VectorPathNode | undefined;
			if (bottom) items.push(...pathItems({ ...bottom, subpaths: [], effects: null }, notes));
		}
		const c = boxCentre(g.children.flatMap((ch) => (ch.type === 'path' ? subpathsToBezier(ch.subpaths) : [])));
		for (const e of g.effects ?? []) {
			const it = effectItem(e, c, node, notes);
			if (it) items.push(it);
		}
	}
	if (!items.length) return null;
	const bm = node.blendMode && node.blendMode !== 'normal' ? BLEND[node.blendMode] : undefined;
	return { ty: 'gr', nm: label(node), it: [...items, transformItem(m, node.opacity ?? 1)], np: items.length, ...(bm !== undefined ? { bm } : {}) };
}

/**
 * The document (or `nodes` of it) as a Lottie animation: one shape layer whose groups mirror the
 * nodes (top first), path effects as live shape modifiers and gradients as gradient fills, on a
 * background layer when the document has one.
 */
export function vectorDocumentToLottie(doc: VectorDocument, options: VectorLottieExportOptions & { nodes?: readonly VectorNode[] } = {}): VectorLottieExport {
	const notes: string[] = [];
	const fps = options.fps ?? 30;
	const op = Math.max(1, Math.round(options.frames ?? 1));
	const shapes: Json[] = [];
	for (const n of [...(options.nodes ?? doc.nodes)].reverse()) {
		const g = nodeGroup(n, notes);
		if (g) shapes.push(g);
	}
	const ks = { o: st(100), r: st(0), p: st([0, 0, 0]), a: st([0, 0, 0]), s: st([100, 100, 100]) };
	const layers: Json[] = [{ ddd: 0, ind: 1, ty: 4, nm: options.name ?? 'Vector', sr: 1, ks, ao: 0, shapes, ip: 0, op, st: 0, bm: 0 }];
	// The page background, when the whole document is exported.
	if (!options.nodes && doc.background && parseVectorColor(doc.background)) {
		layers.push({ ddd: 0, ind: 2, ty: 4, nm: 'Background', sr: 1, ks, ao: 0, shapes: [{ ty: 'rc', s: st([doc.width, doc.height]), p: st([doc.width / 2, doc.height / 2]), r: st(0) }, { ty: 'fl', c: st(colorOf(doc.background)), o: st(100), r: 1 }], ip: 0, op, st: 0, bm: 0 });
	}
	return { lottie: { v: '5.7.4', fr: fps, ip: 0, op, w: doc.width, h: doc.height, nm: options.name ?? 'Vector', ddd: 0, assets: [], layers }, notes: [...new Set(notes)] };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** A cubic-bezier ease's progress at `x` (0–1) with control points (x1, y1), (x2, y2). */
function ease(x1: number, y1: number, x2: number, y2: number, x: number): number {
	const bez = (a: number, b: number, t: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 40; i++) {
		const mid = (lo + hi) / 2;
		if (bez(x1, x2, mid) < x) lo = mid;
		else hi = mid;
	}
	return bez(y1, y2, (lo + hi) / 2);
}

const nums = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number) : typeof v === 'number' ? [v] : []);

/** A Lottie property's value at `frame` (keyframes eased; held keys held). */
export function lottieValueAt(prop: unknown, frame: number): number[] {
	if (!prop || typeof prop !== 'object') return nums(prop);
	const p = prop as Json;
	const k = p.k;
	const keyed = (p.a === 1 || (Array.isArray(k) && k.length > 0 && typeof k[0] === 'object' && k[0] !== null && 't' in (k[0] as Json))) && Array.isArray(k);
	if (!keyed) return nums(k);
	const keys = k as Json[];
	if (!keys.length) return [];
	const start = (i: number): number[] => nums(keys[i].s ?? (i > 0 ? keys[i - 1].e : undefined));
	if (frame <= Number(keys[0].t)) return start(0);
	for (let i = 0; i < keys.length - 1; i++) {
		const a = keys[i];
		const b = keys[i + 1];
		const t0 = Number(a.t);
		const t1 = Number(b.t);
		if (frame >= t1) continue;
		const from = start(i);
		if (a.h === 1) return from;
		const to = b.s !== undefined ? nums(b.s) : nums(a.e);
		const x = t1 > t0 ? (frame - t0) / (t1 - t0) : 1;
		const o = a.o as Json | undefined;
		const iq = a.i as Json | undefined;
		const y = o && iq ? ease(nums(o.x)[0] ?? 0, nums(o.y)[0] ?? 0, nums(iq.x)[0] ?? 1, nums(iq.y)[0] ?? 1, x) : x;
		return from.map((v, d) => v + ((to[d] ?? v) - v) * y);
	}
	const last = keys[keys.length - 1];
	return last.s !== undefined ? nums(last.s) : nums(keys[keys.length - 2]?.e);
}

/** A Lottie path value at `frame` as a subpath. */
function subpathOf(prop: unknown, frame: number): VectorSubpath | null {
	const p = prop as Json | undefined;
	if (!p) return null;
	let k = p.k as unknown;
	if (Array.isArray(k) && k.length && typeof k[0] === 'object' && k[0] !== null && 't' in (k[0] as Json)) {
		// Keyframed paths: the key in force (shapes are not interpolated here).
		const keys = k as Json[];
		let pick = keys[0];
		for (const key of keys) if (Number(key.t) <= frame) pick = key;
		k = Array.isArray(pick.s) ? (pick.s as unknown[])[0] : pick.s;
	}
	const s = k as Json;
	if (!s || !Array.isArray(s.v)) return null;
	const v = (s.v as unknown[]).map(nums);
	const i = (Array.isArray(s.i) ? (s.i as unknown[]) : []).map(nums);
	const o = (Array.isArray(s.o) ? (s.o as unknown[]) : []).map(nums);
	const anchors = v.map(([x, y], k) => {
		const [ix, iy] = i[k] ?? [0, 0];
		const [ox, oy] = o[k] ?? [0, 0];
		return { x, y, ...(ix || iy ? { in: { x: x + ix, y: y + iy } } : {}), ...(ox || oy ? { out: { x: x + ox, y: y + oy } } : {}) };
	});
	return anchors.length ? { closed: !!s.c, anchors } : null;
}

/** A Lottie colour (0–1, or 0–255 in old files) as CSS. */
function cssColor(c: number[]): string {
	const k = c.slice(0, 3).some((v) => v > 1) ? 255 : 1;
	const hex = (v: number) =>
		Math.round(Math.min(1, Math.max(0, v / k)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${hex(c[0] ?? 0)}${hex(c[1] ?? 0)}${hex(c[2] ?? 0)}`;
}

/** A shape geometry item at `frame` as subpaths. */
function geometryOf(it: Json, frame: number, notes: string[]): VectorSubpath[] {
	switch (it.ty) {
		case 'sh': {
			const sp = subpathOf(it.ks, frame);
			return sp ? [sp] : [];
		}
		case 'rc': {
			const [w, h] = lottieValueAt(it.s, frame);
			const [x, y] = lottieValueAt(it.p, frame);
			const r = lottieValueAt(it.r, frame)[0] ?? 0;
			return [rectSubpath({ x: x - w / 2, y: y - h / 2, width: w, height: h }, Math.min(r, w / 2, h / 2))];
		}
		case 'el': {
			const [w, h] = lottieValueAt(it.s, frame);
			const [x, y] = lottieValueAt(it.p, frame);
			return [ellipseSubpath({ x: x - w / 2, y: y - h / 2, width: w, height: h })];
		}
		case 'sr': {
			const n = Math.max(3, Math.round(lottieValueAt(it.pt, frame)[0] ?? 5));
			const [cx, cy] = lottieValueAt(it.p, frame);
			const rot = ((lottieValueAt(it.r, frame)[0] ?? 0) * Math.PI) / 180;
			const or = lottieValueAt(it.or, frame)[0] ?? 50;
			const ir = lottieValueAt(it.ir, frame)[0] ?? or / 2;
			const star = Number(it.sy ?? 1) !== 2;
			if ((lottieValueAt(it.os, frame)[0] ?? 0) || (lottieValueAt(it.is, frame)[0] ?? 0)) notes.push('Star and polygon roundness is not imported (sharp points used).');
			const pts: Vec2[] = [];
			const count = star ? n * 2 : n;
			for (let k = 0; k < count; k++) {
				const r = star && k % 2 === 1 ? ir : or;
				const a = rot - Math.PI / 2 + (k * 2 * Math.PI) / count;
				pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
			}
			return [{ closed: true, anchors: pts }];
		}
		default:
			return [];
	}
}

/** A shape transform (`tr`) or layer transform (`ks`) at `frame` as a matrix (and its opacity 0–1). */
function transformOf(t: Json | undefined, frame: number, notes: string[]): { m: AffineMatrix; opacity: number } {
	if (!t) return { m: [1, 0, 0, 1, 0, 0], opacity: 1 };
	const [ax = 0, ay = 0] = lottieValueAt(t.a, frame);
	const pv = t.p as Json | undefined;
	const [px = 0, py = 0] = pv && pv.s === true ? [lottieValueAt(pv.x, frame)[0] ?? 0, lottieValueAt(pv.y, frame)[0] ?? 0] : lottieValueAt(t.p, frame);
	const sv = lottieValueAt(t.s, frame);
	const [sx = 100, sy = 100] = sv.length ? sv : [100, 100];
	const r = lottieValueAt(t.r ?? t.rz, frame)[0] ?? 0;
	const o = lottieValueAt(t.o, frame)[0];
	if (lottieValueAt(t.sk, frame)[0]) notes.push('Skew is not imported.');
	let m: AffineMatrix = translateMatrix(-ax, -ay);
	m = multiplyMatrices(m, scaleMatrix(sx / 100, sy / 100));
	m = multiplyMatrices(m, rotateMatrix(r));
	m = multiplyMatrices(m, translateMatrix(px, py));
	return { m, opacity: o === undefined ? 1 : Math.min(1, Math.max(0, o / 100)) };
}

/** A gradient item at `frame` as our gradient (in user space). */
function gradientOf(it: Json, frame: number): VectorGradient | null {
	const g = it.g as Json | undefined;
	if (!g) return null;
	const n = Number(g.p ?? 2);
	const flat = lottieValueAt(g.k, frame);
	const stops = [];
	for (let k = 0; k < n && k * 4 + 3 < flat.length; k++) stops.push({ offset: Math.min(1, Math.max(0, flat[k * 4])), color: cssColor([flat[k * 4 + 1], flat[k * 4 + 2], flat[k * 4 + 3]]) });
	const alphas = flat.slice(n * 4);
	if (alphas.length >= 4) {
		for (const s of stops) {
			// The alpha at the colour stop's offset, between the alpha stops round it.
			let a = alphas[1];
			for (let k = 0; k + 3 < alphas.length; k += 2) if (alphas[k] <= s.offset && alphas[k + 2] >= s.offset) a = alphas[k + 1] + ((alphas[k + 3] - alphas[k + 1]) * (s.offset - alphas[k])) / Math.max(1e-9, alphas[k + 2] - alphas[k]);
			if (a < 1) (s as { opacity?: number }).opacity = Math.max(0, a);
		}
	}
	if (stops.length < 1) return null;
	const [sx, sy] = lottieValueAt(it.s, frame);
	const [ex, ey] = lottieValueAt(it.e, frame);
	const radial = Number(it.t ?? 1) === 2;
	const out: VectorGradient = { type: radial ? 'radial' : 'linear', stops, units: 'userSpaceOnUse', start: { x: sx, y: sy }, end: { x: ex, y: ey } };
	const h = lottieValueAt(it.h, frame)[0] ?? 0;
	if (radial && h) {
		const a = ((lottieValueAt(it.a, frame)[0] ?? 0) * Math.PI) / 180 + Math.atan2(ey - sy, ex - sx);
		const r = (Math.hypot(ex - sx, ey - sy) * Math.max(-99, Math.min(99, h))) / 100;
		out.focal = { x: sx + Math.cos(a) * r, y: sy + Math.sin(a) * r };
	}
	return out;
}

/** A modifier item at `frame` as our effect (centre `c` of what it acts on), or null. */
function effectOf(it: Json, frame: number, c: Vec2, id: string): VectorEffect | null {
	const v = (k: string) => lottieValueAt(it[k], frame);
	const num = (k: string, d = 0) => v(k)[0] ?? d;
	let raw: { type: string; params: Record<string, unknown> } | null = null;
	switch (it.ty) {
		case 'tm':
			raw = { type: 'trim', params: { start: num('s'), end: num('e', 100), offset: num('o'), mode: Number(it.m) === 2 ? 'individual' : 'simultaneous' } };
			break;
		case 'rd':
			raw = { type: 'roundCorners', params: { radius: num('r') } };
			break;
		case 'pb':
			raw = { type: 'puckerBloat', params: { amount: num('a') } };
			break;
		case 'tw': {
			const [x = c.x, y = c.y] = v('c');
			raw = { type: 'twist', params: { angle: num('a'), center: { x: x - c.x, y: y - c.y } } };
			break;
		}
		case 'zz':
			raw = { type: 'zigzag', params: { size: num('s'), ridges: num('r'), smooth: num('pt', 1) === 2 } };
			break;
		case 'op':
			raw = { type: 'offset', params: { amount: num('a'), join: ['miter', 'round', 'bevel'][Number(it.lj ?? 1) - 1] ?? 'miter', miterLimit: num('ml', 4) || 4 } };
			break;
		case 'mm':
			raw = { type: 'merge', params: { mode: MERGE[Number(it.mm ?? 1) - 1] ?? 'merge' } };
			break;
		case 'rp': {
			const tr = (it.tr as Json) ?? {};
			const at = (k: string, d: number[]) => {
				const r = lottieValueAt(tr[k], frame);
				return r.length ? r : d;
			};
			const [ax, ay] = at('a', [c.x, c.y]);
			const [px, py] = at('p', [0, 0]);
			const [sx, sy] = at('s', [100, 100]);
			raw = {
				type: 'repeater',
				params: { copies: num('c', 1), offset: num('o'), position: { x: px, y: py }, anchor: { x: ax - c.x, y: ay - c.y }, rotation: at('r', [0])[0], scale: { x: sx, y: sy }, startOpacity: at('so', [100])[0], endOpacity: at('eo', [100])[0], composite: Number(it.m) === 1 ? 'above' : 'below' }
			};
			break;
		}
	}
	if (!raw) return null;
	const [e] = sanitizeVectorEffects([{ ...raw, id, ...(it.hd === true ? { enabled: false } : {}) }]);
	return e ?? null;
}

const PAINTS = new Set(['fl', 'st', 'gf', 'gs']);
const MODIFIERS = new Set(['tm', 'rd', 'pb', 'tw', 'zz', 'op', 'mm', 'rp']);
const GEOMETRY = new Set(['sh', 'rc', 'el', 'sr']);

interface ImportState {
	frame: number;
	notes: string[];
	next: () => string;
}

/** Applies paint items (top first) to a path node as its fill and stroke stacks. */
function painted(node: VectorPathNode, paints: readonly Json[], s: ImportState): VectorPathNode {
	const fills: VectorPaintLayer[] = [];
	const strokes: VectorStrokeLayer[] = [];
	let evenodd = false;
	for (const it of paints) {
		if (it.hd === true) continue;
		const o = (lottieValueAt(it.o, s.frame)[0] ?? 100) / 100;
		const bm = it.bm !== undefined ? BLEND_BACK[Number(it.bm)] : undefined;
		const paint: VectorPaint = it.ty === 'fl' || it.ty === 'st' ? cssColor(lottieValueAt(it.c, s.frame)) : gradientOf(it, s.frame);
		if (!paint) continue;
		const layer: VectorPaintLayer = { paint, ...(o < 1 ? { opacity: Math.max(0, o) } : {}), ...(bm && bm !== 'normal' ? { blendMode: bm } : {}) };
		if (it.ty === 'fl' || it.ty === 'gf') {
			if (Number(it.r) === 2) evenodd = true;
			fills.unshift(layer);
		} else {
			const dash = Array.isArray(it.d) ? (it.d as Json[]).filter((d) => d.n === 'd' || d.n === 'g').map((d) => lottieValueAt(d.v, s.frame)[0] ?? 0) : [];
			strokes.unshift({
				...layer,
				strokeWidth: lottieValueAt(it.w, s.frame)[0] ?? 1,
				strokeLinecap: (['butt', 'round', 'square'] as const)[Number(it.lc ?? 1) - 1] ?? 'butt',
				strokeLinejoin: (['miter', 'round', 'bevel'] as const)[Number(it.lj ?? 1) - 1] ?? 'miter',
				...(dash.length ? { strokeDasharray: dash } : {})
			});
		}
	}
	const top = <L extends VectorPaintLayer>(list: L[]) => list[list.length - 1];
	const fill = top(fills);
	const stroke = top(strokes);
	return {
		...node,
		...(evenodd ? { fillRule: 'evenodd' as const } : {}),
		fill: fill?.paint ?? null,
		stroke: stroke?.paint ?? null,
		...(stroke ? { strokeWidth: stroke.strokeWidth, strokeLinecap: stroke.strokeLinecap, strokeLinejoin: stroke.strokeLinejoin, ...(stroke.strokeDasharray ? { strokeDasharray: stroke.strokeDasharray } : {}) } : {}),
		...(fills.length > 1 || (fill && (fill.opacity !== undefined || fill.blendMode)) ? { fills } : {}),
		...(strokes.length > 1 || (stroke && (stroke.opacity !== undefined || stroke.blendMode)) ? { strokes } : {})
	};
}

/**
 * Shape items as nodes, bottom to top. Lottie lists items top first; paints and modifiers act on
 * every shape above them in their group (nested groups included), so the shapes between two paint
 * items share one compound path with the paints and modifiers after them.
 */
function itemsToNodes(items: readonly Json[], inherited: { paints: Json[]; modifiers: Json[] }, s: ImportState): VectorNode[] {
	const out: VectorNode[] = [];
	const after = (i: number) => {
		const rest = items.slice(i + 1).filter((it) => it.hd !== true);
		return { paints: [...rest.filter((it) => PAINTS.has(String(it.ty))), ...inherited.paints], modifiers: [...rest.filter((it) => MODIFIERS.has(String(it.ty))), ...inherited.modifiers] };
	};
	let run: VectorSubpath[] = [];
	let runEnd = -1;
	const flush = () => {
		if (!run.length) return;
		const scope = after(runEnd);
		const c = boxCentre(subpathsToBezier(run));
		const id = s.next();
		let node: VectorPathNode = { id, type: 'path', subpaths: run, fill: null, stroke: null };
		node = painted(node, scope.paints, s);
		const effects = scope.modifiers.map((it, k) => effectOf(it, s.frame, c, `fx${k + 1}`)).filter((e): e is VectorEffect => !!e);
		if (effects.length) node = { ...node, effects };
		if (!scope.paints.length) s.notes.push('Shapes without a fill or stroke after them are imported unpainted.');
		out.push(node);
		run = [];
	};
	items.forEach((it, i) => {
		if (it.hd === true) return;
		const ty = String(it.ty);
		if (GEOMETRY.has(ty)) {
			run.push(...geometryOf(it, s.frame, s.notes));
			runEnd = i;
		} else if (ty === 'gr') {
			flush();
			const list = Array.isArray(it.it) ? (it.it as Json[]) : [];
			const tr = list.find((x) => x.ty === 'tr');
			const { m, opacity } = transformOf(tr, s.frame, s.notes);
			const children = itemsToNodes(
				list.filter((x) => x.ty !== 'tr'),
				after(i),
				s
			);
			if (!children.length) return;
			let group: VectorGroupNode = { id: s.next(), type: 'group', ...(typeof it.nm === 'string' ? { name: it.nm } : {}), children };
			group = transformVectorNode(group, m);
			if (opacity < 1) group = { ...group, opacity };
			if (it.bm !== undefined && BLEND_BACK[Number(it.bm)] && BLEND_BACK[Number(it.bm)] !== 'normal') group = { ...group, blendMode: BLEND_BACK[Number(it.bm)] };
			out.push(group);
		} else if (PAINTS.has(ty) || MODIFIERS.has(ty)) flush();
		else if (ty !== 'tr') s.notes.push(`Shape item "${ty}" is not supported (skipped).`);
	});
	flush();
	// Lottie lists top first: ours are bottom first.
	return out.reverse();
}

/** Options of `parseVectorLottie`. */
export interface VectorLottieImportOptions {
	/** The frame to read (default the animation's in point). */
	frame?: number;
	/** Id prefix of the new nodes (default `lt`). */
	idPrefix?: string;
}

/** What `parseVectorLottie` returns: a document of the frame and what was approximated or skipped. */
export interface VectorLottieImport {
	document: VectorDocument;
	notes: string[];
}

/**
 * One frame of a Lottie animation as a vector document: shape layers (and solids) become groups
 * with their layer transform, parenting and opacity; precompositions are read recursively; shape
 * modifiers become live path effects. Image and text layers, mattes, masks other than additive,
 * expressions and effects are left out (see `notes`).
 */
export function parseVectorLottie(input: unknown, options: VectorLottieImportOptions = {}): VectorLottieImport {
	const json = (typeof input === 'string' ? JSON.parse(input) : input) as Json;
	if (!json || typeof json !== 'object' || !Array.isArray(json.layers)) throw new Error('Not a Lottie animation: it needs a layers array.');
	const notes: string[] = [];
	let n = 0;
	const prefix = options.idPrefix ?? 'lt';
	const s: ImportState = { frame: options.frame ?? Number(json.ip ?? 0), notes, next: () => `${prefix}${++n}` };
	const assets = new Map<string, Json>();
	for (const a of (Array.isArray(json.assets) ? json.assets : []) as Json[]) if (typeof a.id === 'string') assets.set(a.id, a);
	const layersToNodes = (layers: Json[], frame: number, depth: number): VectorNode[] => {
		const byIndex = new Map<number, Json>();
		for (const l of layers) if (l.ind !== undefined) byIndex.set(Number(l.ind), l);
		// A layer's transform, then its parents' (a parent loop stops where it repeats).
		const worldOf = (l: Json, seen = new Set<Json>()): AffineMatrix => {
			const own = transformOf(l.ks as Json, frame, notes).m;
			const parent = l.parent !== undefined ? byIndex.get(Number(l.parent)) : undefined;
			if (!parent || seen.has(parent)) return own;
			seen.add(l);
			return multiplyMatrices(own, worldOf(parent, seen));
		};
		const out: VectorNode[] = [];
		for (const l of layers) {
			const ty = Number(l.ty);
			if (l.hd === true || frame < Number(l.ip ?? -Infinity) || frame >= Number(l.op ?? Infinity)) continue;
			if (l.td === 1 || l.tt) notes.push(`Layer "${l.nm ?? ''}": track mattes are not imported.`);
			if (l.ef) notes.push(`Layer "${l.nm ?? ''}": layer effects are not imported.`);
			if (l.ks && JSON.stringify(l.ks).includes('"x":"')) notes.push('Expressions are not evaluated (their stored values are used).');
			let children: VectorNode[] = [];
			if (ty === 4) children = itemsToNodes(Array.isArray(l.shapes) ? (l.shapes as Json[]) : [], { paints: [], modifiers: [] }, s);
			else if (ty === 1) {
				const w = Number(l.sw ?? 0);
				const h = Number(l.sh ?? 0);
				const c = typeof l.sc === 'string' ? l.sc : '#000000';
				children = [{ id: s.next(), type: 'path', name: 'Solid', subpaths: [rectSubpath({ x: 0, y: 0, width: w, height: h })], fill: c, stroke: null }];
			} else if (ty === 0 && typeof l.refId === 'string' && depth < 16) {
				const asset = assets.get(l.refId);
				const local = frame - Number(l.st ?? 0);
				if (asset && Array.isArray(asset.layers)) children = layersToNodes(asset.layers as Json[], local, depth + 1);
			} else if (ty !== 3) {
				notes.push(`Layer "${l.nm ?? ''}" (type ${ty}) is not supported (skipped).`);
				continue;
			}
			if (!children.length) continue;
			const m = worldOf(l);
			const opacity = transformOf(l.ks as Json, frame, notes).opacity;
			let group: VectorGroupNode = { id: s.next(), type: 'group', ...(typeof l.nm === 'string' ? { name: l.nm } : {}), children };
			group = transformVectorNode(group, m);
			if (opacity < 1) group = { ...group, opacity };
			// Additive masks clip the layer.
			const masks = (Array.isArray(l.masksProperties) ? (l.masksProperties as Json[]) : []).filter((mk) => (mk.mode ?? 'a') === 'a' && !mk.inv);
			if (Array.isArray(l.masksProperties) && masks.length !== (l.masksProperties as Json[]).length) notes.push(`Layer "${l.nm ?? ''}": only additive masks are imported.`);
			if (masks.length) {
				const subpaths = masks.map((mk) => subpathOf(mk.pt, frame)).filter((x): x is VectorSubpath => !!x);
				const clip: VectorPathNode = transformVectorNode({ id: s.next(), type: 'path', name: 'Mask', subpaths, fill: '#000000', stroke: null }, m);
				const { transform: _t, opacity: _o, ...inner } = group;
				group = { id: s.next(), type: 'group', name: `${group.name ?? 'Layer'} mask`, mask: { type: 'clip' }, children: [clip, { ...inner, id: s.next() }], ...(group.opacity !== undefined ? { opacity: group.opacity } : {}) };
			}
			out.push(group);
		}
		return out.reverse();
	};
	const nodes = layersToNodes(json.layers as Json[], s.frame, 0);
	const width = Number(json.w ?? 512);
	const height = Number(json.h ?? 512);
	return { document: { width, height, nodes }, notes: [...new Set(notes)] };
}
