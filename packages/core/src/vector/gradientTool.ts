/**
 * The Gradient tool's on-canvas annotator: a bar from the start (or centre) handle to the end (or
 * radius) handle with the colour stops under it and midpoint diamonds above it, plus a radial,
 * conic or diamond gradient's extent outline, aspect handle and (radial) focal point. All in
 * screen pixels, for hit-testing and the overlay.
 *
 * After vectorcraft `crates/tools/src/xform/gradient.rs` (`Annotator`: stop chips below the bar,
 * midpoints above it, a stop dragged off the bar is removed, a click on the bar adds one), ArtCraft,
 * MIT OR Apache-2.0 — see THIRD_PARTY_NOTICES.md.
 */
import { vectorTargetPaint } from './paintLayers.js';
import { collectPathNodes, findVectorNode, vectorWorldMatrix, IDENTITY_MATRIX, multiplyMatrices, type AffineMatrix } from './geometry.js';
import { vectorPathLocalBounds } from './svg.js';
import {
	isCentredVectorGradient,
	isVectorGradient,
	sortedVectorGradientStops,
	vectorGradientHandles,
	vectorGradientMatrix,
	vectorGradientMidpointPosition,
	type VectorGradientHandle
} from './gradient.js';
import type { Vec2, VectorBounds, VectorDocument, VectorGradient, VectorGradientStop, VectorPathNode, VectorViewport } from './types.js';

/** Which paint of the selection the Gradient tool and the gradient editor work on. */
export type VectorGradientTarget = 'fill' | 'stroke';

/** A part of the annotator under the pointer. */
export type VectorGradientPart =
	| { kind: 'handle'; handle: VectorGradientHandle }
	| { kind: 'stop'; index: number }
	| { kind: 'midpoint'; index: number }
	/** The bar at `offset` (0–1): a click adds a stop there, a drag moves the gradient. */
	| { kind: 'bar'; offset: number };

/** Distance of the stop chips below the bar, the midpoint diamonds above it (screen pixels). */
export const VECTOR_GRADIENT_STOP_GAP = 12;
export const VECTOR_GRADIENT_MIDPOINT_GAP = 9;
/** How far off the bar a dragged stop goes before it is removed (screen pixels). */
export const VECTOR_GRADIENT_OFF_BAR = 24;
const STOP_HIT = 6;
const MIDPOINT_HIT = 5;
const HANDLE_HIT = 6;
const BAR_HIT = 5;

export interface VectorGradientAnnotator {
	nodeId: string;
	target: VectorGradientTarget;
	gradient: VectorGradient;
	/** The path's box in its own space. */
	bounds: VectorBounds | null;
	/** The path's own space → document. */
	world: AffineMatrix;
	/** Screen positions of the handles. */
	start: Vec2;
	end: Vec2;
	/** Radial, conic and diamond gradients. */
	aspect: Vec2 | null;
	/** Radial gradients. */
	focal: Vec2 | null;
	/** Unit normal to the bar towards the stop chips (screen). */
	normal: Vec2;
	/** Stops (sorted, as the gradient stores them) with their chips' screen positions. */
	stops: (VectorGradientStop & { index: number; x: number; y: number })[];
	/** The midpoint diamond after each stop but the last (screen). */
	midpoints: { index: number; x: number; y: number; midpoint: number }[];
	/** Screen path of the extent: an ellipse (radial, conic) or a rhombus (diamond). */
	extent: string | null;
}

const fmt = (n: number) => Math.round(n * 100) / 100;
const apply = (m: AffineMatrix, p: Vec2): Vec2 => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/** The path whose `target` paint the annotator shows: the first path of the selection with a gradient there. */
export function vectorGradientTargetPath(doc: VectorDocument, selection: readonly string[], target: VectorGradientTarget, layer: number | null = null): VectorPathNode | null {
	for (const id of selection) {
		const node = findVectorNode(doc.nodes, id);
		if (!node) continue;
		const path = collectPathNodes(node).find((p) => isVectorGradient(vectorTargetPaint(p, target, layer)));
		if (path) return path;
	}
	return null;
}

/** The annotator of the selection's gradient (`target` paint), in screen pixels, or null when it has none. */
export function getVectorGradientAnnotator(
	doc: VectorDocument,
	selection: readonly string[],
	viewport: VectorViewport,
	target: VectorGradientTarget,
	layer: number | null = null
): VectorGradientAnnotator | null {
	const path = vectorGradientTargetPath(doc, selection, target, layer);
	if (!path) return null;
	const gradient = vectorTargetPaint(path, target, layer) as VectorGradient;
	const world = vectorWorldMatrix(doc.nodes, path.id) ?? IDENTITY_MATRIX;
	const screen = multiplyMatrices(world, [viewport.zoom, 0, 0, viewport.zoom, viewport.x, viewport.y]);
	const bounds = vectorPathLocalBounds(path);
	const h = vectorGradientHandles(gradient, bounds, screen);
	const v = { x: h.end.x - h.start.x, y: h.end.y - h.start.y };
	const len = Math.hypot(v.x, v.y);
	const normal = len > 1e-9 ? { x: -v.y / len, y: v.x / len } : { x: 0, y: 1 };
	const at = (t: number, gap: number) => ({ x: h.start.x + v.x * t + normal.x * gap, y: h.start.y + v.y * t + normal.y * gap });
	const sorted = sortedVectorGradientStops(gradient);
	const stops = sorted.map((s, index) => ({ ...s, index, ...at(s.offset, VECTOR_GRADIENT_STOP_GAP) }));
	const midpoints = sorted.slice(0, -1).flatMap((s, index) => {
		const pos = vectorGradientMidpointPosition(sorted, index);
		return pos === null || sorted[index + 1].offset - s.offset < 1e-6 ? [] : [{ index, midpoint: s.midpoint ?? 0.5, ...at(pos, -VECTOR_GRADIENT_MIDPOINT_GAP) }];
	});
	let extent: string | null = null;
	if (isCentredVectorGradient(gradient.type)) {
		const frame = multiplyMatrices(vectorGradientMatrix(gradient, bounds), screen);
		const pts =
			gradient.type === 'diamond'
				? [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }]
				: Array.from({ length: 48 }, (_, k) => ({ x: Math.cos((k * Math.PI) / 24), y: Math.sin((k * Math.PI) / 24) }));
		extent = `M${pts.map((p) => apply(frame, p)).map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join('L')}Z`;
	}
	return { nodeId: path.id, target, gradient, bounds, world, start: h.start, end: h.end, aspect: h.aspect, focal: h.focal, normal, stops, midpoints, extent };
}

/** Where `p` lies relative to the bar: offset along it (0 at the start, 1 at the end) and distance towards the stop chips. */
export function vectorGradientBarPosition(a: Pick<VectorGradientAnnotator, 'start' | 'end' | 'normal'>, p: Vec2): { offset: number; across: number } {
	const v = { x: a.end.x - a.start.x, y: a.end.y - a.start.y };
	const l2 = v.x * v.x + v.y * v.y;
	const d = { x: p.x - a.start.x, y: p.y - a.start.y };
	if (l2 < 1e-12) return { offset: 0, across: Math.hypot(d.x, d.y) };
	return { offset: (d.x * v.x + d.y * v.y) / l2, across: d.x * a.normal.x + d.y * a.normal.y };
}

/** The annotator part under screen point `p`: stops, then midpoints, the handles and the bar. */
export function hitVectorGradientAnnotator(a: VectorGradientAnnotator, p: Vec2): VectorGradientPart | null {
	const near = (q: Vec2 | null, r: number) => !!q && Math.hypot(q.x - p.x, q.y - p.y) <= r;
	for (let i = a.stops.length - 1; i >= 0; i--) if (near(a.stops[i], STOP_HIT)) return { kind: 'stop', index: a.stops[i].index };
	for (const m of a.midpoints) if (near(m, MIDPOINT_HIT)) return { kind: 'midpoint', index: m.index };
	const centred = isCentredVectorGradient(a.gradient.type);
	if (near(a.end, HANDLE_HIT)) return { kind: 'handle', handle: centred ? 'radius' : 'end' };
	// The focal point sits on the centre until moved: grab it with Alt there (see the controller).
	if (a.focal && near(a.focal, HANDLE_HIT) && !near(a.start, 1)) return { kind: 'handle', handle: 'focal' };
	if (near(a.start, HANDLE_HIT)) return { kind: 'handle', handle: 'start' };
	if (near(a.aspect, HANDLE_HIT)) return { kind: 'handle', handle: 'aspect' };
	const { offset, across } = vectorGradientBarPosition(a, p);
	if (offset >= 0 && offset <= 1 && across >= -BAR_HIT && across <= VECTOR_GRADIENT_STOP_GAP + STOP_HIT) return { kind: 'bar', offset };
	return null;
}
