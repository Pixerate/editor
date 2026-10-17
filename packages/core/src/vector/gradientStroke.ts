/**
 * Gradients laid along or across a stroke (`strokeMode: 'along' | 'across'`), as a `<pattern>`
 * paint server of slices, so the canvases and exported SVG draw them with plain SVG.
 *
 * Each subpath is flattened and cut into slices, one per flattened segment, reaching past
 * everything the stroke paints there (its joins, caps and arrowheads). Gentle turns share a rib on
 * the bisector, so neighbouring slices meet where both give the same colour; a sharp corner gets
 * square ribs and a patch under them in the corner's colour, and the open ends get a patch in the
 * end colour (caps and heads). Along: a slice's linear gradient runs from its start to its end
 * with the part of the gradient between their positions (by length, 0–1 per subpath), padded
 * beyond; across: from the stroke's left edge to its right edge (the visible band of an inside or
 * outside stroke; a width profile's sides at the slice's middle). The pattern paints only where the
 * stroke does, so no clipping is needed. Each slice overlaps the next a little to hide
 * anti-aliasing seams.
 *
 * After vectorcraft `crates/effects/src/stroke/gradient.rs` (ribs on the bisectors of gentle
 * turns, a fan round sharp corners: here one patch), ArtCraft, MIT OR Apache-2.0 — see
 * THIRD_PARTY_NOTICES.md.
 */
import type { SvgGradientDef } from '../canvas/gradient.js';
import { closeContour, flattenChain, pathToContours } from '../canvas/pathops/bezier.js';
import type { Point } from '../canvas/types.js';
import { subpathsToBezier } from './geometry.js';
import { strokeWidthProfileOf, vectorStrokeReach } from './stroke.js';
import { widthProfileAt } from './width.js';
import {
	expandVectorGradientStops,
	patternAttrs,
	spanVectorGradientStops,
	vectorGradientArea,
	type VectorPaintDef,
	type VectorSvgPatternDef
} from './gradient.js';
import type { Vec2, VectorBounds, VectorGradient, VectorGradientStop, VectorPathNode } from './types.js';

/** Largest stretch of a rib on a turn's bisector (1 / cos of half the turn, about 74°) before the corner gets a patch. */
const SHARP = 1.25;
/** Flattening tolerance (node units). */
const TOLERANCE = 0.2;
/** How far each slice reaches into the next (node units). */
const OVERLAP = 0.5;

const fmt = (n: number, digits = 3) => {
	const k = 10 ** digits;
	const v = Math.round(n * k) / k;
	return Object.is(v, -0) ? '0' : String(v);
};
const toSvgStops = (stops: readonly VectorGradientStop[]) =>
	stops.map((s) => ({ offset: `${fmt(s.offset * 100)}%`, stopColor: s.color, ...(s.opacity !== undefined && s.opacity !== 1 ? { stopOpacity: Math.round(s.opacity * 1e4) / 1e4 } : {}) }));
const polygonD = (pts: readonly Vec2[], precision: number) => `M${pts.map((p) => `${fmt(p.x, precision)} ${fmt(p.y, precision)}`).join('L')}Z`;
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
/** Left of direction `d` looking along it on screen (y down). */
const left = (d: Vec2): Vec2 => ({ x: d.y, y: -d.x });
const unit = (v: Vec2): Vec2 => {
	const l = Math.hypot(v.x, v.y);
	return l > 1e-12 ? { x: v.x / l, y: v.y / l } : { x: 1, y: 0 };
};

/** A cross-section of the strip: from `l` (left of the path) through the path to `r`. */
interface Rib {
	l: Vec2;
	r: Vec2;
}

/** The flattened subpaths of a path (node space): points, whether closed, and their lengths. */
function flattenedSubpaths(node: VectorPathNode): { pts: Vec2[]; closed: boolean }[] {
	const out: { pts: Vec2[]; closed: boolean }[] = [];
	for (const contour of pathToContours(subpathsToBezier(node.subpaths))) {
		const segs = closeContour(contour);
		if (!segs.length) continue;
		const ring: Point[] = flattenChain(segs, TOLERANCE);
		const pts = ring.map(([x, y]) => ({ x, y })).filter((p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 1e-9);
		if (contour.closed && pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-9) pts.pop();
		if (pts.length >= 2) out.push({ pts, closed: contour.closed && pts.length > 2 });
	}
	return out;
}

/** Shoelace area (positive: clockwise on screen, y down). */
const signedArea = (pts: readonly Vec2[]) => {
	let a = 0;
	for (let i = 0; i < pts.length; i++) {
		const p = pts[i];
		const q = pts[(i + 1) % pts.length];
		a += p.x * q.y - q.x * p.y;
	}
	return a / 2;
};

/**
 * The paint server of a gradient along or across the stroke of `node` (in its own space): a
 * pattern whose first def id is `id`. `area` defaults to the path's box padded by the stroke's
 * reach.
 */
export function vectorStrokeGradientDefs(g: VectorGradient, id: string, node: VectorPathNode, options: { bounds?: VectorBounds | null; area?: VectorBounds | null; precision?: number } = {}): VectorPaintDef[] {
	const precision = options.precision ?? 3;
	const mode = g.strokeMode === 'across' ? 'across' : 'along';
	const expanded = expandVectorGradientStops(g);
	const reach = vectorStrokeReach(node) + 1;
	const area = options.area ?? vectorGradientArea(options.bounds && { x: options.bounds.x - reach, y: options.bounds.y - reach, width: options.bounds.width + 2 * reach, height: options.bounds.height + 2 * reach });
	const width = node.strokeWidth ?? 1;
	const align = node.strokeAlign ?? 'center';
	const profile = strokeWidthProfileOf(node);
	const gradients: SvgGradientDef[] = [];
	const patches: { d: string; fill: string }[] = [];
	const slices: { d: string; fill: string }[] = [];
	const colourAt = (t: number) => {
		const s = spanVectorGradientStops(g, t, t, expanded)[0];
		return s;
	};
	let counter = 0;
	const solid = (pts: Vec2[], t: number) => {
		const s = colourAt(t);
		const gid = `${id}-p${counter++}`;
		// A one-stop gradient keeps the stop's opacity (a fill colour would need fill-opacity).
		gradients.push({ id: gid, type: 'linear', attrs: { gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 1, y2: 0 }, stops: toSvgStops([{ ...s, offset: 0 }]) });
		patches.push({ d: polygonD(pts, precision), fill: `url(#${gid})` });
	};
	const disc = (c: Vec2, r: number) => Array.from({ length: 16 }, (_, k) => add(c, scale({ x: Math.cos((k * Math.PI) / 8), y: Math.sin((k * Math.PI) / 8) }, r)));

	for (const { pts, closed } of flattenedSubpaths(node)) {
		const n = pts.length;
		const segCount = closed ? n : n - 1;
		const dirs: Vec2[] = [];
		const lengths: number[] = [0];
		for (let i = 0; i < segCount; i++) {
			const a = pts[i];
			const b = pts[(i + 1) % n];
			dirs.push(unit(sub(b, a)));
			lengths.push(lengths[i] + Math.hypot(b.x - a.x, b.y - a.y));
		}
		const total = lengths[segCount];
		if (!(total > 1e-9)) continue;
		const tAt = (i: number) => lengths[i] / total;
		// Inside / outside strokes show one side: the right of a clockwise outline is its inside.
		const clockwise = closed && signedArea(pts) > 0;
		const visibleLeft = align === 'center' || !closed ? null : align === 'inside' ? !clockwise : clockwise;

		// Ribs at each vertex: `before` ends the slice arriving, `after` starts the one leaving.
		const ribs: { before: Rib; after: Rib }[] = [];
		for (let i = 0; i < n; i++) {
			const p = pts[i];
			const din = i > 0 || closed ? dirs[(i - 1 + segCount) % segCount] : null;
			const dout = i < segCount ? dirs[i] : null;
			const square = (d: Vec2): Rib => ({ l: add(p, scale(left(d), reach)), r: sub(p, scale(left(d), reach)) });
			if (!din || !dout) {
				const rib = square((din ?? dout)!);
				ribs.push({ before: rib, after: rib });
				continue;
			}
			const nin = left(din);
			const nout = left(dout);
			const den = 1 + nin.x * nout.x + nin.y * nout.y;
			const stretch = den > 1e-12 ? Math.sqrt(2 / den) : Infinity;
			if (stretch <= SHARP) {
				const m = scale(add(nin, nout), reach / den);
				const rib = { l: add(p, m), r: sub(p, m) };
				ribs.push({ before: rib, after: rib });
			} else {
				ribs.push({ before: square(din), after: square(dout) });
				solid(disc(p, reach * 1.5), tAt(i));
			}
		}
		if (!closed) {
			// Caps and arrowheads beyond the ends paint the end colours.
			const d0 = dirs[0];
			const d1 = dirs[segCount - 1];
			const a = pts[0];
			const b = pts[n - 1];
			const cap = (p: Vec2, d: Vec2) => [add(p, scale(left(d), reach)), add(add(p, scale(d, reach)), scale(left(d), reach)), sub(add(p, scale(d, reach)), scale(left(d), reach)), sub(p, scale(left(d), reach))];
			solid(cap(a, scale(d0, -1)), 0);
			solid(cap(b, d1), 1);
		}
		for (let i = 0; i < segCount; i++) {
			const j = (i + 1) % n;
			const a = pts[i];
			const b = pts[j];
			const d = dirs[i];
			const from = ribs[i].after;
			const to = ribs[j].before;
			const ext = scale(d, OVERLAP);
			const quad = [from.l, add(to.l, ext), add(to.r, ext), from.r];
			const gid = `${id}-s${counter++}`;
			const t0 = tAt(i);
			const t1 = closed && i === segCount - 1 ? 1 : tAt(i + 1);
			if (mode === 'along') {
				gradients.push({
					id: gid,
					type: 'linear',
					attrs: { gradientUnits: 'userSpaceOnUse', x1: fmt(a.x, 4), y1: fmt(a.y, 4), x2: fmt(b.x, 4), y2: fmt(b.y, 4) },
					stops: toSvgStops(spanVectorGradientStops(g, t0, t1, expanded))
				});
			} else {
				const mid = scale(add(a, b), 0.5);
				const side = widthProfileAt(profile, (t0 + t1) / 2);
				const nrm = left(d);
				const reachL = visibleLeft === null ? (width / 2) * side.left : visibleLeft ? width * side.left : 0;
				const reachR = visibleLeft === null ? (width / 2) * side.right : visibleLeft ? 0 : width * side.right;
				const p0 = add(mid, scale(nrm, reachL));
				const p1 = sub(mid, scale(nrm, reachR));
				gradients.push({
					id: gid,
					type: 'linear',
					attrs: { gradientUnits: 'userSpaceOnUse', x1: fmt(p0.x, 4), y1: fmt(p0.y, 4), x2: fmt(p1.x, 4), y2: fmt(p1.y, 4) },
					stops: toSvgStops(expanded)
				});
			}
			slices.push({ d: polygonD(quad, precision), fill: `url(#${gid})` });
		}
	}
	const def: VectorSvgPatternDef = {
		id,
		type: 'pattern',
		attrs: patternAttrs(area),
		gradients,
		tiles: [...patches, ...slices]
	};
	return [def];
}
