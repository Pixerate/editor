/**
 * Connectors for data visuals (#811): rounded orthogonal elbows between two points, and fans of
 * nested elbows from one root to a row of targets that never cross. Pure geometry with exact
 * lengths (straight runs plus quarter circles), so a picture can draw a connector on with
 * `stroke-dasharray` or hand its `d` to pathops (`toBezierPath`, `trimSegments`). It ports to
 * Swift line for line (`PixerateGeometry/Connectors.swift`).
 */
import type { Vec2 } from './types';

/** Which way an elbow leaves its start: `vertical` runs up or down first, `horizontal` across. */
export type ElbowAxis = 'vertical' | 'horizontal';

/** One piece of a connector: a straight run or a quarter circle, with its length. */
export type ConnectorSegment =
	| { kind: 'line'; from: Vec2; to: Vec2; length: number }
	| {
			kind: 'arc';
			from: Vec2;
			to: Vec2;
			center: Vec2;
			radius: number;
			/** SVG sweep flag: 1 turns clockwise on screen (y down). */
			sweep: 0 | 1;
			length: number;
	  };

/** A drawn connector: its pieces, SVG path data and exact length. */
export interface Connector {
	segments: ConnectorSegment[];
	/** Path data with `M`, `L` and `A` commands, numbers to 3 decimals. */
	d: string;
	/** Exact length of the pieces (quarter circles are πr/2). */
	length: number;
}

export interface Elbow extends Connector {
	/** Where the middle run sits: a y for a vertical elbow, an x for a horizontal one. */
	level: number;
}

export interface ElbowOptions {
	/** Where the middle run sits (default halfway between the ends on the elbow's axis). */
	level?: number;
	/** Corner radius in px (default 8). Each corner shrinks to fit the runs beside it. */
	radius?: number;
	/** Which way it leaves `from` (default `vertical`). */
	axis?: ElbowAxis;
}

function fmt(v: number): string {
	const rounded = Math.round(v * 1000) / 1000;
	return Object.is(rounded, -0) ? '0' : String(rounded);
}

function dist(a: Vec2, b: Vec2): number {
	return Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
}

/**
 * A polyline with its right-angle corners rounded to quarter circles of up to `radius`. A corner
 * takes at most the whole of an end run and half of a run it shares with another corner; other
 * corners (not at right angles) stay sharp. Repeated and collinear points are dropped.
 */
export function roundedPolyline(input: readonly Vec2[], radius = 8): Connector {
	const pts: Vec2[] = [];
	for (const p of input) {
		const last = pts[pts.length - 1];
		if (!last || last.x !== p.x || last.y !== p.y) pts.push({ x: p.x, y: p.y });
	}
	// Drop middle points on a straight run that keeps its direction.
	for (let i = 1; i < pts.length - 1; ) {
		const a = pts[i - 1], b = pts[i], c = pts[i + 1];
		const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
		const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
		if (cross === 0 && dot > 0) pts.splice(i, 1);
		else i++;
	}
	const segments: ConnectorSegment[] = [];
	if (pts.length === 0) return { segments, d: '', length: 0 };
	let d = `M${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
	let length = 0;
	let cur = pts[0];
	const line = (to: Vec2) => {
		const l = dist(cur, to);
		if (l === 0) return;
		segments.push({ kind: 'line', from: cur, to, length: l });
		d += `L${fmt(to.x)} ${fmt(to.y)}`;
		length += l;
		cur = to;
	};
	const last = pts.length - 1;
	for (let i = 1; i < last; i++) {
		const p = pts[i], a = pts[i - 1], c = pts[i + 1];
		const la = dist(a, p), lb = dist(p, c);
		const ux = (p.x - a.x) / la, uy = (p.y - a.y) / la;
		const vx = (c.x - p.x) / lb, vy = (c.y - p.y) / lb;
		const right = ux * vx + uy * vy === 0;
		const r = right ? Math.min(radius, i - 1 === 0 ? la : la / 2, i + 1 === last ? lb : lb / 2) : 0;
		if (!(r > 0)) {
			line(p);
			continue;
		}
		const entry = { x: p.x - ux * r, y: p.y - uy * r };
		const exit = { x: p.x + vx * r, y: p.y + vy * r };
		line(entry);
		const sweep: 0 | 1 = ux * vy - uy * vx > 0 ? 1 : 0;
		const arcLength = (Math.PI * r) / 2;
		segments.push({ kind: 'arc', from: cur, to: exit, center: { x: entry.x + vx * r, y: entry.y + vy * r }, radius: r, sweep, length: arcLength });
		d += `A${fmt(r)} ${fmt(r)} 0 0 ${sweep} ${fmt(exit.x)} ${fmt(exit.y)}`;
		length += arcLength;
		cur = exit;
	}
	line(pts[last]);
	return { segments, d, length };
}

/**
 * One rounded orthogonal connector from `from` to `to`: along the axis to `level`, across, then
 * along the axis again. With both ends in line it is a straight run.
 */
export function elbow(from: Vec2, to: Vec2, options: ElbowOptions = {}): Elbow {
	const axis = options.axis ?? 'vertical';
	const level = options.level ?? (axis === 'vertical' ? (from.y + to.y) / 2 : (from.x + to.x) / 2);
	const corners: Vec2[] =
		axis === 'vertical'
			? [{ x: from.x, y: level }, { x: to.x, y: level }]
			: [{ x: level, y: from.y }, { x: level, y: to.y }];
	return { ...roundedPolyline([from, ...corners, to], options.radius ?? 8), level };
}

export interface FanOptions {
	/** Space between the elbows' starts, spread evenly about the root (default 0: one start). */
	gap?: number;
	/** Distance between the turn levels of nested elbows (default 12). Shrinks to fit. */
	step?: number;
	/** Corner radius (default 8), at most half the step so nested corners keep clear. */
	radius?: number;
	/** Distance from the root to the highest turn (default 16), at most half the way to the nearest target. */
	lead?: number;
	/** `vertical` (default) when the targets sit above or below the root, `horizontal` when beside it. */
	axis?: ElbowAxis;
}

export interface Fan {
	/** One elbow per target, in the targets' order. */
	elbows: Elbow[];
	/** Each elbow's turn level, in the targets' order. */
	levels: number[];
	/** Each elbow's start, in the targets' order. */
	starts: Vec2[];
	/** The step and radius used after fitting. */
	step: number;
	radius: number;
}

/**
 * Nested elbows from one root to a row of targets. On each side of the root the outermost target
 * turns nearest the root and the next ones turn a `step` further each, so no two elbows cross.
 * With a `gap`, each elbow starts at its own point beside the root, in the targets' order; the
 * guarantee then needs consecutive targets at least `gap` apart.
 */
export function fanElbows(root: Vec2, targets: readonly Vec2[], options: FanOptions = {}): Fan {
	const axis = options.axis ?? 'vertical';
	const gap = options.gap ?? 0;
	const main = (v: Vec2) => (axis === 'vertical' ? v.y : v.x);
	const across = (v: Vec2) => (axis === 'vertical' ? v.x : v.y);
	const n = targets.length;
	const order = targets.map((_, i) => i).sort((a, b) => across(targets[a]) - across(targets[b]) || a - b);
	const startAt: number[] = new Array(n);
	const offset: number[] = new Array(n);
	for (let k = 0; k < n; k++) {
		startAt[k] = across(root) + (k - (n - 1) / 2) * gap;
		offset[k] = across(targets[order[k]]) - startAt[k];
	}
	const rank: number[] = new Array(n).fill(0);
	let left = 0;
	for (let k = 0; k < n; k++) if (offset[k] < 0) rank[k] = left++;
	let right = 0;
	for (let k = n - 1; k >= 0; k--) if (offset[k] > 0) rank[k] = right++;
	let sum = 0;
	let available = Infinity;
	for (const t of targets) {
		sum += main(t) - main(root);
		available = Math.min(available, Math.abs(main(t) - main(root)));
	}
	const dir = sum < 0 ? -1 : 1;
	if (n === 0) available = 0;
	const lead = Math.min(options.lead ?? 16, available / 2);
	const deepest = Math.max(left, right) - 1;
	const step = deepest > 0 ? Math.min(options.step ?? 12, (available - lead) / (deepest + 1)) : (options.step ?? 12);
	const radius = Math.min(options.radius ?? 8, step / 2);
	const elbows: Elbow[] = new Array(n);
	const levels: number[] = new Array(n);
	const starts: Vec2[] = new Array(n);
	for (let k = 0; k < n; k++) {
		const i = order[k];
		const level = main(root) + dir * (lead + rank[k] * step);
		const start = axis === 'vertical' ? { x: startAt[k], y: root.y } : { x: root.x, y: startAt[k] };
		elbows[i] = elbow(start, targets[i], { level, radius, axis });
		levels[i] = level;
		starts[i] = start;
	}
	return { elbows, levels, starts, step, radius };
}
