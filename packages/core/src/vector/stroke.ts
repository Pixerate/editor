/**
 * Stroke options of vector paths: alignment (centre, inside, outside) and arrowheads at the
 * ends of open paths. Everything here works on a path's Bézier outline in one space (the
 * node's own, or the document's), so the canvases, hit-testing, SVG export and Outline Stroke
 * share it.
 *
 * Ported from ArtCraft (MIT OR Apache-2.0, see THIRD_PARTY_NOTICES.md):
 * - figcraft `crates/pathops/src/lib.rs` — `stroke_outline_of`: an inside stroke is a stroke of
 *   twice the width intersected with the fill, an outside one twice the width minus the fill,
 *   and only closed shapes have an inside (open paths stroke centred).
 * - vectorcraft `crates/effects/src/stroke/arrow.rs` — arrowhead shapes, sizes and insets (where
 *   the stroke stops under each head), `tip` vs `extend` alignment and trimming the stroke by
 *   arc length under the head.
 */
import type { Point } from '../canvas/types.js';
import {
	contoursToPath,
	distanceToBezierPath,
	pathToContours,
	pointInBezierPath,
	segmentLength,
	segmentTangent,
	trimSegments,
	type BezierContour,
	type BezierPath,
	type BezierSegment
} from '../canvas/pathops/bezier.js';
import { pathBoolean, type PathOperandInput } from '../canvas/pathops/boolean.js';
import { outlineStroke } from '../canvas/pathops/stroke.js';
import type { VectorArrowhead, VectorStrokeAlign, VectorStyle, VectorWidthPoint, Vec2 } from './types.js';
import { nearestStrokePosition, variableStrokeOutline } from './varstroke.js';
import { isUniformWidthProfile, sanitizeWidthProfile, widthProfileAt, widthProfileMaxScale } from './width.js';

/** Handle length that makes a cubic approximate a quarter circle. */
const KAPPA = 0.5522847498307936;
/** Where the notch of the (notched) arrow sits, as a fraction of the head's length. */
const NOTCH = 0.7;

/** One arrowhead: a filled outline (nonzero) painted with the stroke's paint. */
export interface VectorArrowheadShape {
	end: 'start' | 'end';
	kind: VectorArrowhead;
	tip: Vec2;
	/** Unit direction the head points in. */
	dir: Vec2;
	/** Distance from the tip back to where the stroke ends under the head. */
	inset: number;
	path: BezierPath;
}

/** What the stroke of a path draws. */
export interface VectorStrokeParts {
	/** Where the stroke sits (`center` for open shapes, whatever the style says). */
	align: VectorStrokeAlign;
	/** The line the stroke follows: the outline, shortened under `tip`-aligned heads. */
	line: BezierPath;
	/** The stroke width to draw `line` with: twice the style's width for inside / outside (half is clipped away). */
	drawWidth: number;
	heads: VectorArrowheadShape[];
}

/** True when the path has subpaths and all of them are closed (only such shapes have an inside). */
export function isClosedBezierShape(path: BezierPath): boolean {
	const contours = pathToContours(path).filter((c) => c.segments.length > 0);
	return contours.length > 0 && contours.every((c) => c.closed);
}

/** The alignment a stroke is drawn with: the style's, or `center` for open shapes. */
export function effectiveStrokeAlign(style: Pick<VectorStyle, 'strokeAlign'>, closedShape: boolean): VectorStrokeAlign {
	const a = style.strokeAlign ?? 'center';
	return closedShape ? a : 'center';
}

/** The style's width profile, sanitised, or null when the stroke is uniform. */
export function strokeWidthProfileOf(style: Pick<VectorStyle, 'strokeWidthProfile'>): VectorWidthPoint[] | null {
	if (!style.strokeWidthProfile?.length) return null;
	const p = sanitizeWidthProfile(style.strokeWidthProfile);
	return isUniformWidthProfile(p) ? null : p;
}

/** True when the style asks for more than a plain centred stroke (an alignment, arrowheads or a width profile). */
export function hasStrokeExtras(style: VectorStyle): boolean {
	return (style.strokeAlign ?? 'center') !== 'center' || !!style.startArrow || !!style.endArrow || !!strokeWidthProfileOf(style);
}

/**
 * The area of the stroke along `parts.line` before alignment clipping: SVG's stroke for a
 * uniform width, the variable-width outline (`variableStrokeOutline`) for a profiled one.
 */
export function vectorStrokeLineArea(parts: Pick<VectorStrokeParts, 'line' | 'drawWidth'>, style: VectorStyle, tolerance?: number): BezierPath {
	const profile = strokeWidthProfileOf(style);
	const dash = style.strokeDasharray?.length ? { dash: style.strokeDasharray } : {};
	const join = style.strokeLinejoin ?? 'miter';
	const cap = style.strokeLinecap ?? 'butt';
	if (profile) return variableStrokeOutline(parts.line, { width: parts.drawWidth, profile, join, cap, ...dash, ...(tolerance ? { tolerance } : {}) });
	return outlineStroke(parts.line, { width: parts.drawWidth, join, cap, ...dash, ...(tolerance ? { tolerance } : {}) });
}

const capExtent = (style: VectorStyle, width: number) => (style.strokeLinecap === 'round' || style.strokeLinecap === 'square' ? width / 2 : 0);

/** The weight of a head: the stroke width times its scale (at least 0.25). A head is 4 weights long and wide. */
export function arrowheadWeight(style: VectorStyle, end: 'start' | 'end'): number {
	const scale = end === 'start' ? style.startArrowScale : style.endArrowScale;
	const s = typeof scale === 'number' && scale > 0 && Number.isFinite(scale) ? scale : 1;
	return Math.max(0.25, (style.strokeWidth ?? 1) * s);
}

/** Distance from the tip where the stroke ends, for a stroke whose cap reaches `cap` past its end. */
export function arrowheadInset(kind: VectorArrowhead, hw: number, cap: number): number {
	const l = 4 * hw;
	const solid = (back: number) => Math.max(back / 2, cap);
	switch (kind) {
		case 'triangle':
		case 'circle':
		case 'square':
			return solid(l);
		case 'arrow':
			return solid(NOTCH * l);
		case 'bar':
			return solid(0.75 * hw);
		case 'open':
			// The inner corner of the chevron: arm / sin(half angle).
			return Math.max((hw * Math.sqrt(l * l + (l * l) / 4)) / (l / 2), cap);
	}
}

const v = (x: number, y: number): Vec2 => ({ x, y });
const plus = (a: Vec2, b: Vec2, k = 1): Vec2 => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const unit = (a: Vec2): Vec2 => {
	const l = Math.hypot(a.x, a.y);
	return l > 0 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
};

function polygon(pts: Vec2[]): BezierPath {
	return [{ type: 'M', x: pts[0].x, y: pts[0].y }, ...pts.slice(1).map((p) => ({ type: 'L' as const, x: p.x, y: p.y })), { type: 'Z' }];
}

function circle(c: Vec2, r: number): BezierPath {
	const k = r * KAPPA;
	const { x, y } = c;
	return [
		{ type: 'M', x: x + r, y },
		{ type: 'C', x1: x + r, y1: y + k, x2: x + k, y2: y + r, x, y: y + r },
		{ type: 'C', x1: x - k, y1: y + r, x2: x - r, y2: y + k, x: x - r, y },
		{ type: 'C', x1: x - r, y1: y - k, x2: x - k, y2: y - r, x, y: y - r },
		{ type: 'C', x1: x + k, y1: y - r, x2: x + r, y2: y - k, x: x + r, y },
		{ type: 'Z' }
	];
}

/** The outline of a `kind` head of weight `hw` with its tip at `tip`, pointing along unit `dir`. */
export function arrowheadPath(kind: VectorArrowhead, tip: Vec2, dir: Vec2, hw: number): BezierPath {
	const n = v(-dir.y, dir.x);
	const l = 4 * hw;
	const half = l / 2;
	const base = plus(tip, dir, -l);
	switch (kind) {
		case 'triangle':
			return polygon([tip, plus(base, n, half), plus(base, n, -half)]);
		case 'arrow':
			return polygon([tip, plus(base, n, half), plus(tip, dir, -NOTCH * l), plus(base, n, -half)]);
		case 'open': {
			// Arms `hw` thick from the tip to the base corners, cut square at their ends.
			const t = hw;
			const a = plus(base, n, half);
			const b = plus(base, n, -half);
			const ua = unit(plus(a, tip, -1));
			const ub = unit(plus(b, tip, -1));
			const na = v(-ua.y, ua.x);
			const nb = v(ub.y, -ub.x);
			const inner = plus(tip, dir, -(t * Math.hypot(a.x - tip.x, a.y - tip.y)) / half);
			return polygon([tip, a, plus(a, na, t), inner, plus(b, nb, t), b]);
		}
		case 'circle':
			return circle(plus(tip, dir, -half), half);
		case 'square':
			return polygon([plus(tip, n, half), plus(base, n, half), plus(base, n, -half), plus(tip, n, -half)]);
		case 'bar': {
			const t = 0.75 * hw;
			return polygon([plus(tip, n, half), plus(plus(tip, n, half), dir, -t), plus(plus(tip, n, -half), dir, -t), plus(tip, n, -half)]);
		}
	}
}

const toVec = (p: Point): Vec2 => ({ x: p[0], y: p[1] });
const segLen = (s: BezierSegment) => segmentLength(s);

/** The end point of a contour and the unit direction pointing out of it there. */
function endOf(segs: readonly BezierSegment[], atStart: boolean): { p: Vec2; out: Vec2 } {
	const long = (s: BezierSegment) => segLen(s) > 1e-9;
	if (atStart) {
		const s = segs.find(long) ?? segs[0];
		const t = segmentTangent(s, 0);
		return { p: toVec(segs[0][0]), out: v(-t[0], -t[1]) };
	}
	const s = [...segs].reverse().find(long) ?? segs[segs.length - 1];
	const t = segmentTangent(s, 1);
	const last = segs[segs.length - 1];
	return { p: toVec(last[last.length - 1]), out: v(t[0], t[1]) };
}

/** The point `dist` along the contour from its start (or back from its end), if it is that long. */
function pointAlong(segs: readonly BezierSegment[], fromStart: boolean, dist: number): Vec2 | null {
	const order = fromStart ? segs : [...segs].reverse();
	let acc = 0;
	for (const s of order) {
		const l = segLen(s);
		if (acc + l >= dist) {
			const want = fromStart ? dist - acc : l - (dist - acc);
			const pts = trimSegments([s], 0, want);
			const p = pts.length ? pts[0][pts[0].length - 1] : s[0];
			return toVec(p);
		}
		acc += l;
	}
	return null;
}

/**
 * The stroke of `path` as `style` draws it: its alignment, the line it follows (shortened under
 * `tip`-aligned heads) and its arrowheads. Heads go on the start of the first subpath and the
 * end of the last one, when those are open.
 */
export function vectorStrokeParts(path: BezierPath, style: VectorStyle): VectorStrokeParts {
	const width = style.strokeWidth ?? 1;
	const contours = pathToContours(path).filter((c) => c.segments.length > 0);
	const closedShape = contours.length > 0 && contours.every((c) => c.closed);
	const align = effectiveStrokeAlign(style, closedShape);
	const drawWidth = align === 'center' ? width : width * 2;
	const heads: VectorArrowheadShape[] = [];
	if (!contours.length || (!style.startArrow && !style.endArrow)) return { align, line: path, drawWidth, heads };
	const first = contours[0];
	const last = contours[contours.length - 1];
	const cap = capExtent(style, width);
	const tipMode = style.arrowAlign === 'tip';
	const trims = contours.map(() => [0, 0]);
	const place = (end: 'start' | 'end', contour: BezierContour, ci: number) => {
		const kind = end === 'start' ? style.startArrow : style.endArrow;
		if (!kind || contour.closed) return;
		const hw = arrowheadWeight(style, end);
		const inset = arrowheadInset(kind, hw, cap);
		const atStart = end === 'start';
		const { p, out } = endOf(contour.segments, atStart);
		let tip: Vec2;
		let dir: Vec2;
		if (tipMode) {
			// Point along the chord from where the stroke now ends to the end point.
			const q = pointAlong(contour.segments, atStart, inset);
			const d = q ? v(p.x - q.x, p.y - q.y) : null;
			dir = d && Math.hypot(d.x, d.y) > 1e-9 ? unit(d) : out;
			tip = p;
			trims[ci][atStart ? 0 : 1] = inset;
		} else {
			tip = plus(p, out, inset);
			dir = out;
		}
		heads.push({ end, kind, tip, dir, inset, path: arrowheadPath(kind, tip, dir, hw) });
	};
	place('start', first, 0);
	place('end', last, contours.length - 1);
	if (!tipMode || !heads.length) return { align, line: path, drawWidth, heads };
	const trimmed: BezierContour[] = contours.map((c, i) => {
		const [s0, s1] = trims[i];
		if (!s0 && !s1) return c;
		const lengths = c.segments.map(segLen);
		const total = lengths.reduce((a, b) => a + b, 0);
		return { closed: false, segments: total - s1 > s0 ? trimSegments(c.segments, s0, total - s1, lengths) : [] };
	});
	return { align, line: contoursToPath(trimmed), drawWidth, heads };
}

/**
 * The area the stroke paints, as one filled path: the outlined stroke (joins, caps and dashes
 * as SVG) clipped by the alignment (against the fill, read with the style's `fillRule`), plus
 * the arrowheads.
 */
export function vectorStrokeOutlinePath(path: BezierPath, style: VectorStyle): BezierPath {
	const parts = vectorStrokeParts(path, style);
	const stroke = vectorStrokeLineArea(parts, style);
	const fill: PathOperandInput = { path, fillRule: style.fillRule ?? 'nonzero' };
	let area = stroke;
	if (parts.align === 'inside') area = pathBoolean('intersection', [stroke, fill]).path;
	else if (parts.align === 'outside') area = pathBoolean('difference', [stroke, fill]).path;
	if (!parts.heads.length) return area;
	return pathBoolean('union', [area, ...parts.heads.map((h) => h.path)]).path;
}

/**
 * Whether point `p` hits the stroke of `path` (`tolerance` added on every side): within half
 * the width of the outline for a centred stroke, within the whole width on the inside or the
 * outside of the fill for an aligned one, or on an arrowhead.
 */
export function hitTestVectorStroke(path: BezierPath, p: Vec2, style: VectorStyle, tolerance = 0): boolean {
	const parts = vectorStrokeParts(path, style);
	const point: Point = [p.x, p.y];
	const width = style.strokeWidth ?? 1;
	for (const h of parts.heads) {
		if (pointInBezierPath(h.path, point) || (tolerance > 0 && distanceToBezierPath(h.path, point) <= tolerance)) return true;
	}
	if (!parts.line.length) return false;
	const profile = strokeWidthProfileOf(style);
	let d: number;
	let reach = width / 2;
	if (profile) {
		// The side width at the nearest point of the centre line (twice it when aligned).
		const near = nearestStrokePosition(parts.line, point);
		if (!near) return false;
		d = near.distance;
		const w = widthProfileAt(profile, near.t);
		reach = (width / 2) * (near.side === 'left' ? w.left : w.right);
		if (parts.align !== 'center') reach *= 2;
		const atEnd = near.t <= 1e-9 || near.t >= 1 - 1e-9;
		if (atEnd && (style.strokeLinecap === 'round' || style.strokeLinecap === 'square') && d > reach) {
			// Past an open end the cap reaches as far as the width there.
			reach = Math.max(reach, ((width / 2) * (w.left + w.right)) / 2);
		}
	} else {
		d = distanceToBezierPath(parts.line, point);
		if (parts.align !== 'center') reach = width;
	}
	if (parts.align === 'center') return d <= reach + tolerance;
	if (d > reach + tolerance) return false;
	if (d <= tolerance) return true;
	const inside = pointInBezierPath(path, point, style.fillRule ?? 'nonzero');
	return parts.align === 'inside' ? inside : !inside;
}

/** How far the stroke can reach past the outline (for padding bounds and masks). */
export function vectorStrokeReach(style: VectorStyle): number {
	const width = (style.strokeWidth ?? 1) * widthProfileMaxScale(strokeWidthProfileOf(style));
	const align = style.strokeAlign ?? 'center';
	let reach = align === 'center' ? width / 2 : align === 'outside' ? width : 0;
	if (style.strokeLinejoin !== 'round' && style.strokeLinejoin !== 'bevel') reach *= 4;
	for (const end of ['start', 'end'] as const) {
		if (end === 'start' ? style.startArrow : style.endArrow) reach = Math.max(reach, 8 * arrowheadWeight(style, end) + width);
	}
	return reach;
}
