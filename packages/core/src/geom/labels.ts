/**
 * Label placement around obstacles (#792): put labels near their anchors without covering marks,
 * other labels or other anchors. Pure geometry: callers measure text and pass sizes, so the same
 * steps run in every editor and port line for line (the Swift chart uses `PixerateCore`'s copy).
 *
 * Each label tries spots on its preferred sides, stepping outwards from `distance` to `reach`,
 * one line first and then its `wrapped` size. The most constrained labels go first; a spot that
 * clashes is used only when no clear one exists, and labels left clashing go first in up to
 * `passes` more rounds. The same input always gives the same result.
 */
import type { Box, Vec2 } from './types';

/** Where a label sits relative to its anchor. `center` puts it on the anchor (edge labels). */
export type LabelSide = 'above' | 'below' | 'left' | 'right' | 'above-right' | 'above-left' | 'below-right' | 'below-left' | 'center';

/** Every side, in the default order of preference after the caller's. */
export const LABEL_SIDES: readonly LabelSide[] = ['above', 'right', 'below', 'left', 'above-right', 'below-right', 'above-left', 'below-left', 'center'];

export interface LabelRequest {
	/** The point the label belongs to. */
	anchor: Vec2;
	width: number;
	height: number;
	/** The label's size wrapped to two lines, tried after the one-line size. */
	wrapped?: { width: number; height: number };
	/** Sides to try, best first (default: the options' `prefer`). */
	prefer?: readonly LabelSide[];
}

/** Something labels must not cover. `label` ties it to one label, which may cover it. */
export type LabelObstacle = ({ box: Box } | { point: Vec2 } | { segment: readonly [Vec2, Vec2] } | { polygon: readonly Vec2[] }) & {
	/** Index of the label this obstacle belongs to (that label may cover it). */
	label?: number;
	/** Grows the obstacle by this much on every side (default 0). */
	pad?: number;
};

export interface PlaceLabelsOptions {
	obstacles?: readonly LabelObstacle[];
	/** Labels stay inside this box when they fit. */
	bounds?: Box;
	/** Space kept between labels (default 2). */
	gap?: number;
	/** Sides to try, best first (default above, right, below, left, then the corners). */
	prefer?: readonly LabelSide[];
	/** First distance from the anchor (default 4, or 12 with `leader`). */
	distance?: number;
	/** Farthest distance tried (default `distance` + 48). */
	reach?: number;
	/** Distance between tries (default 6). */
	step?: number;
	/** Return a leader line from each anchor to its label's nearest edge when they are apart. */
	leader?: boolean;
	/** Extra rounds for labels that still clash (default 4). */
	passes?: number;
}

export interface PlacedLabel extends Box {
	side: LabelSide;
	/** It took its two-line size. */
	wrapped: boolean;
	/** From the anchor to the label's nearest edge, when `leader` is on and they are more than 2 apart. */
	leader: readonly [Vec2, Vec2] | null;
	/** How many obstacles or labels it covers (0 when it found a clear spot). */
	clashes: number;
	ok: boolean;
}

interface Candidate extends Box {
	side: LabelSide;
	wrapped: boolean;
	cost: number;
}

const DIAGONAL = Math.SQRT1_2;

/** The box for a label of size `w` × `h` on `side` of `a` at distance `d`. */
function boxOn(side: LabelSide, a: Vec2, w: number, h: number, d: number): Box {
	switch (side) {
		case 'above':
			return { x: a.x - w / 2, y: a.y - d - h, width: w, height: h };
		case 'below':
			return { x: a.x - w / 2, y: a.y + d, width: w, height: h };
		case 'left':
			return { x: a.x - d - w, y: a.y - h / 2, width: w, height: h };
		case 'right':
			return { x: a.x + d, y: a.y - h / 2, width: w, height: h };
		case 'above-right':
			return { x: a.x + d * DIAGONAL, y: a.y - d * DIAGONAL - h, width: w, height: h };
		case 'above-left':
			return { x: a.x - d * DIAGONAL - w, y: a.y - d * DIAGONAL - h, width: w, height: h };
		case 'below-right':
			return { x: a.x + d * DIAGONAL, y: a.y + d * DIAGONAL, width: w, height: h };
		case 'below-left':
			return { x: a.x - d * DIAGONAL - w, y: a.y + d * DIAGONAL, width: w, height: h };
		default:
			return { x: a.x - w / 2, y: a.y - h / 2, width: w, height: h };
	}
}

const boxesOverlap = (a: Box, b: Box, gap: number) => a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
const inBox = (p: Vec2, b: Box, pad: number) => p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad;

/** Whether segments pq and rs cross (touching counts). */
function segmentsCross(p: Vec2, q: Vec2, r: Vec2, s: Vec2): boolean {
	const cross = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
	const d1 = cross(r, s, p);
	const d2 = cross(r, s, q);
	const d3 = cross(p, q, r);
	const d4 = cross(p, q, s);
	if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
	const on = (a: Vec2, b: Vec2, c: Vec2, d: number) => d === 0 && Math.min(a.x, b.x) <= c.x && c.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= c.y && c.y <= Math.max(a.y, b.y);
	return on(r, s, p, d1) || on(r, s, q, d2) || on(p, q, r, d3) || on(p, q, s, d4);
}

const corners = (b: Box): Vec2[] => [
	{ x: b.x, y: b.y },
	{ x: b.x + b.width, y: b.y },
	{ x: b.x + b.width, y: b.y + b.height },
	{ x: b.x, y: b.y + b.height }
];

function segmentHitsBox(p: Vec2, q: Vec2, b: Box): boolean {
	if (inBox(p, b, 0) || inBox(q, b, 0)) return true;
	const c = corners(b);
	for (let i = 0; i < 4; i++) if (segmentsCross(p, q, c[i], c[(i + 1) % 4])) return true;
	return false;
}

function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i];
		const b = poly[j];
		if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
	}
	return inside;
}

function polygonHitsBox(poly: readonly Vec2[], b: Box): boolean {
	if (poly.some((p) => inBox(p, b, 0))) return true;
	if (corners(b).some((c) => pointInPolygon(c, poly))) return true;
	for (let i = 0; i < poly.length; i++) if (segmentHitsBox(poly[i], poly[(i + 1) % poly.length], b)) return true;
	return false;
}

const grow = (b: Box, pad: number): Box => ({ x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad });

/** Whether `obstacle` covers any of `box`. */
function hits(obstacle: LabelObstacle, box: Box): boolean {
	const pad = obstacle.pad ?? 0;
	if ('box' in obstacle) return boxesOverlap(grow(obstacle.box, pad), box, 0);
	if ('point' in obstacle) return inBox(obstacle.point, box, pad);
	const b = grow(box, pad);
	if ('segment' in obstacle) return segmentHitsBox(obstacle.segment[0], obstacle.segment[1], b);
	return obstacle.polygon.length > 2 && polygonHitsBox(obstacle.polygon, b);
}

/** The convex hull of `points`, clockwise on screen (y down), for polygon obstacles. */
export function labelHull(points: readonly Vec2[]): Vec2[] {
	const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
	if (pts.length < 3) return pts;
	const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const lower: Vec2[] = [];
	for (const p of pts) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
		lower.push(p);
	}
	const upper: Vec2[] = [];
	for (let i = pts.length - 1; i >= 0; i--) {
		const p = pts[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
		upper.push(p);
	}
	return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Labels placed near their anchors and clear of the obstacles and each other, in input order. */
export function placeLabels(labels: readonly LabelRequest[], options: PlaceLabelsOptions = {}): PlacedLabel[] {
	const obstacles = options.obstacles ?? [];
	const gap = options.gap ?? 2;
	const distance = options.distance ?? (options.leader ? 12 : 4);
	const reach = Math.max(distance, options.reach ?? distance + 48);
	const step = Math.max(1, options.step ?? 6);
	const passes = Math.max(0, Math.floor(options.passes ?? 4));
	const bounds = options.bounds;
	labels.forEach((l, i) => {
		if (!l || !Number.isFinite(l.anchor?.x) || !Number.isFinite(l.anchor?.y)) throw new Error(`placeLabels: label ${i} needs an anchor { x, y }.`);
		if (!(l.width >= 0) || !(l.height >= 0)) throw new Error(`placeLabels: label ${i} needs a width and height of at least 0.`);
	});

	// Other labels' anchors are obstacles too: a label must not hide another's point.
	const anchorObstacles: LabelObstacle[] = labels.map((l, i) => ({ point: l.anchor, label: i, pad: 1 }));

	const candidates: Candidate[][] = labels.map((l) => {
		const prefer = l.prefer ?? options.prefer ?? LABEL_SIDES.slice(0, 8);
		const sizes = [{ width: l.width, height: l.height, wrapped: false }, ...(l.wrapped ? [{ ...l.wrapped, wrapped: true }] : [])];
		const out: Candidate[] = [];
		prefer.forEach((side, s) => {
			for (const size of sizes) {
				const steps = side === 'center' ? [0] : [];
				if (side !== 'center') for (let d = distance; d <= reach + 1e-9; d += step) steps.push(d);
				for (const d of steps) {
					let box = boxOn(side, l.anchor, size.width, size.height, d);
					let clamped = false;
					if (bounds && size.width <= bounds.width && size.height <= bounds.height) {
						const x = Math.max(bounds.x, Math.min(bounds.x + bounds.width - size.width, box.x));
						const y = Math.max(bounds.y, Math.min(bounds.y + bounds.height - size.height, box.y));
						clamped = x !== box.x || y !== box.y;
						box = { x, y, width: size.width, height: size.height };
					}
					out.push({ ...box, side, wrapped: size.wrapped, cost: s * 10 + ((d - distance) / step) * 2 + (size.wrapped ? 3 : 0) + (clamped ? 5 : 0) });
				}
			}
		});
		return out;
	});

	/** How many obstacles (not tied to label `i`) `box` covers, its own anchor included unless centred. */
	const obstacleClashes = (i: number, box: Box, side: LabelSide) => {
		let n = 0;
		for (const o of obstacles) if (o.label !== i && hits(o, box)) n++;
		for (const o of anchorObstacles) if ((o.label !== i || side !== 'center') && hits(o, box)) n++;
		return n;
	};

	// The most constrained labels (fewest clear spots) go first; ties keep input order.
	const clear = candidates.map((list, i) => list.filter((c) => obstacleClashes(i, c, c.side) === 0).length);
	const baseOrder = labels.map((_, i) => i).sort((a, b) => clear[a] - clear[b] || a - b);

	const run = (order: readonly number[]) => {
		const placed: (PlacedLabel & { cost: number })[] = new Array(labels.length);
		const boxes: Box[] = [];
		for (const i of order) {
			let best: { c: Candidate; clashes: number; score: number } | undefined;
			for (const c of candidates[i]) {
				let clashes = obstacleClashes(i, c, c.side);
				for (const b of boxes) if (boxesOverlap(b, c, gap)) clashes++;
				const score = clashes * 100 + c.cost;
				if (!best || score < best.score) best = { c, clashes, score };
				if (clashes === 0 && c.cost === 0) break;
			}
			const l = labels[i];
			const c = best?.c ?? { ...boxOn('center', l.anchor, l.width, l.height, 0), side: 'center' as const, wrapped: false, cost: 0 };
			const clashes = best?.clashes ?? 0;
			boxes.push(c);
			let leader: readonly [Vec2, Vec2] | null = null;
			if (options.leader) {
				const ex = Math.max(c.x, Math.min(c.x + c.width, l.anchor.x));
				const ey = Math.max(c.y, Math.min(c.y + c.height, l.anchor.y));
				if (Math.hypot(ex - l.anchor.x, ey - l.anchor.y) > 2) leader = [{ x: l.anchor.x, y: l.anchor.y }, { x: ex, y: ey }];
			}
			placed[i] = { x: c.x, y: c.y, width: c.width, height: c.height, side: c.side, wrapped: c.wrapped, leader, clashes, ok: clashes === 0, cost: c.cost };
		}
		return placed;
	};

	let best = run(baseOrder);
	const total = (r: { clashes: number; cost: number }[]) => r.reduce((n, p) => n + p.clashes, 0);
	const totalCost = (r: { cost: number }[]) => r.reduce((n, p) => n + p.cost, 0);
	for (let pass = 0; pass < passes && total(best) > 0; pass++) {
		const failed = baseOrder.filter((i) => !best[i].ok);
		const order = [...failed, ...baseOrder.filter((i) => best[i].ok)];
		const next = run(order);
		if (total(next) < total(best) || (total(next) === total(best) && totalCost(next) < totalCost(best))) best = next;
		else break;
	}
	return best.map(({ cost: _cost, ...p }) => p);
}
