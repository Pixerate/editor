/**
 * Pencil helpers: lazy-mouse smoothing (a pulled string between the pointer and the pen) and
 * ink-to-shape recognition (a hand-drawn stroke that is a line, rectangle, ellipse or polygon).
 *
 * Portions ported from (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md):
 * - photocraft-main/crates/paint/src/dynamics.rs (`Smoother`: pulled-string mode, `string`,
 *   `finish` with catch-up on stroke end)
 * - wordcraft-main/crates/engine/src/cmd/ink_shape.rs (`recognise`, `ellipse_rms`,
 *   `snap_square`, `corners`, `turning`, `rdp`, `upright`)
 */
import type { Point } from '../canvas/types.js';

// ---------------------------------------------------------------------------
// Lazy mouse
// ---------------------------------------------------------------------------

/**
 * Pulled-string smoothing: the pen stays put until the pointer is more than `length` away,
 * then follows it at that distance, so small wobbles never reach the stroke. Feed pointer
 * positions to `push`; it returns the pen positions to draw through (possibly none).
 */
export class LazyMouse {
	private pos: Point | null = null;
	private last: Point | null = null;

	/** `length` is the string length in the units of the points (0 turns smoothing off). */
	constructor(readonly length: number) {}

	push(p: Point): Point[] {
		this.last = p;
		if (!(this.length > 0)) return [p];
		const pos = this.pos;
		if (!pos) {
			this.pos = p;
			return [p];
		}
		const dx = p[0] - pos[0];
		const dy = p[1] - pos[1];
		const d = Math.hypot(dx, dy);
		if (d <= this.length) return [];
		const k = (d - this.length) / d;
		const next: Point = [pos[0] + dx * k, pos[1] + dy * k];
		this.pos = next;
		return [next];
	}

	/** The string from the pen to the pointer while they are apart, else null. */
	string(): [Point, Point] | null {
		const { pos, last } = this;
		if (!(this.length > 0) || !pos || !last || (pos[0] === last[0] && pos[1] === last[1])) return null;
		return [pos, last];
	}

	/** End of stroke: the pen catches up with the pointer (the point to add, if it lagged). */
	finish(): Point[] {
		const { pos, last } = this;
		if (!(this.length > 0) || !pos || !last || (pos[0] === last[0] && pos[1] === last[1])) return [];
		this.pos = last;
		return [last];
	}
}

// ---------------------------------------------------------------------------
// Ink to shape
// ---------------------------------------------------------------------------

/** A shape recognised in a stroke, in the stroke's coordinates. */
export type VectorInkShape =
	| { kind: 'line'; a: Point; b: Point }
	| { kind: 'rect'; x: number; y: number; width: number; height: number }
	| { kind: 'ellipse'; x: number; y: number; width: number; height: number }
	| { kind: 'polygon'; points: Point[] };

export interface RecognizeInkOptions {
	/** Strokes whose longer side is smaller than this stay ink (default 6). */
	minSize?: number;
}

/** Most corners a recognised polygon may have. */
export const VECTOR_INK_MAX_CORNERS = 8;
const MAX_POINTS = 100_000;

/** "line", "square", "rectangle", "circle", "ellipse", "triangle" or "polygon". */
export function vectorInkShapeName(shape: VectorInkShape): string {
	switch (shape.kind) {
		case 'line':
			return 'line';
		case 'rect':
			return shape.width === shape.height ? 'square' : 'rectangle';
		case 'ellipse':
			return shape.width === shape.height ? 'circle' : 'ellipse';
		case 'polygon':
			return shape.points.length === 3 ? 'triangle' : 'polygon';
	}
}

const dist = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function bbox(pts: readonly Point[]): [number, number, number, number] {
	if (!pts.length) return [0, 0, 0, 0];
	let [x0, y0] = pts[0];
	let [x1, y1] = pts[0];
	for (const [x, y] of pts) {
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x);
		y1 = Math.max(y1, y);
	}
	return [x0, y0, x1 - x0, y1 - y0];
}

function segDistance(a: Point, b: Point, p: Point): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
	return dist([a[0] + t * dx, a[1] + t * dy], p);
}

function polygonDistance(c: readonly Point[], p: Point): number {
	let best = Infinity;
	for (let i = 0; i < c.length; i++) best = Math.min(best, segDistance(c[i], c[(i + 1) % c.length], p));
	return best;
}

/** RMS of each point's normalised radius minus one on the ellipse inscribed in the box (0 on it). */
function ellipseRms(p: readonly Point[], x0: number, y0: number, w: number, h: number): number {
	const rx = w / 2;
	const ry = h / 2;
	if (rx <= 0 || ry <= 0 || !p.length) return Infinity;
	const cx = x0 + rx;
	const cy = y0 + ry;
	let sum = 0;
	for (const [x, y] of p) sum += (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) ** 2;
	return Math.sqrt(sum / p.length);
}

/** A box drawn nearly square made square (same centre). */
function snapSquare(x: number, y: number, w: number, h: number): [number, number, number, number] {
	if (Math.abs(w - h) <= 0.12 * Math.max(w, h)) {
		const s = (w + h) / 2;
		return [x + (w - s) / 2, y + (h - s) / 2, s, s];
	}
	return [x, y, w, h];
}

/** How far the path turns at `b` coming from `a` towards `c`, in degrees (0 = straight on). */
function turning(a: Point, b: Point, c: Point): number {
	const u = [b[0] - a[0], b[1] - a[1]];
	const v = [c[0] - b[0], c[1] - b[1]];
	const lu = Math.hypot(u[0], u[1]);
	const lv = Math.hypot(v[0], v[1]);
	if (lu <= 0 || lv <= 0) return 0;
	return (Math.acos(Math.min(1, Math.max(-1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)))) * 180) / Math.PI;
}

/** Ramer–Douglas–Peucker reduction of an open polyline (iterative), keeping both ends. */
function rdp(p: readonly Point[], eps: number): Point[] {
	const n = p.length;
	if (n < 3) return p.slice();
	const keep = new Array<boolean>(n).fill(false);
	keep[0] = keep[n - 1] = true;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		let far = a;
		let farD = 0;
		for (let i = a + 1; i < b; i++) {
			const d = segDistance(p[a], p[b], p[i]);
			if (d > farD) {
				farD = d;
				far = i;
			}
		}
		if (farD > eps) {
			keep[far] = true;
			stack.push([a, far], [far, b]);
		}
	}
	return p.filter((_, i) => keep[i]);
}

/** Corners of the closed path through `p`: RDP split at the point farthest from the start, then flat and crowded corners merged away. */
function corners(p: readonly Point[], diag: number): Point[] {
	const eps = 0.05 * diag;
	const start = p[0];
	let far = 0;
	let farD = 0;
	p.forEach((q, i) => {
		const d = dist(start, q);
		if (d > farD) {
			farD = d;
			far = i;
		}
	});
	const a = p.slice(0, far);
	const b = p.slice(far);
	const ring = rdp([...a, ...b.slice(0, 1)], eps);
	const back = rdp([...b, start], eps);
	// The halves share the far point and the start.
	ring.pop();
	back.pop();
	ring.push(...back);
	while (ring.length > 3) {
		const n = ring.length;
		const turn = (i: number) => turning(ring[(i + n - 1) % n], ring[i], ring[(i + 1) % n]);
		let flat = 0;
		let flatT = Infinity;
		for (let i = 0; i < n; i++) {
			const t = turn(i);
			if (t < flatT) {
				flatT = t;
				flat = i;
			}
		}
		let short = -1;
		for (let j = 0; j < n; j++) {
			if (dist(ring[j], ring[(j + 1) % n]) < 0.1 * diag) {
				short = j;
				break;
			}
		}
		if (flatT < 30) ring.splice(flat, 1);
		else if (short >= 0) {
			// Of the two crowded corners keep the sharper.
			const k = turn(short) < turn((short + 1) % n) ? short : (short + 1) % n;
			ring.splice(k, 1);
		} else break;
	}
	return ring;
}

/** A quadrilateral whose sides run (nearly) across and down, alternately. */
function upright(c: readonly Point[]): boolean {
	const n = c.length;
	const dirs = c.map((a, i) => {
		const b = c[(i + 1) % n];
		const deg = ((((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) % 180) + 180) % 180;
		if (deg <= 15 || deg >= 165) return 'across';
		if (deg >= 75 && deg <= 105) return 'down';
		return null;
	});
	return dirs.every((d) => d !== null) && dirs.every((d, i) => d !== dirs[(i + 1) % n]);
}

/**
 * The shape a hand-drawn stroke draws, if it is one: an open stroke is a line when it stays
 * close to the chord between its ends; a closed one is an ellipse when its points sit on the
 * ellipse inscribed in their bounds, else a polygon of 3–8 corners when that polygon stays
 * close to every point (an upright four-cornered one is a rectangle). Nearly square boxes
 * become squares and circles. Anything else (scribbles, curves, letters) is null.
 */
export function recognizeInkShape(points: readonly Point[], options: RecognizeInkOptions = {}): VectorInkShape | null {
	const minSize = options.minSize ?? 6;
	const p: Point[] = [];
	for (const q of points.slice(0, MAX_POINTS)) {
		if (!Number.isFinite(q[0]) || !Number.isFinite(q[1]) || Math.abs(q[0]) >= 1e9 || Math.abs(q[1]) >= 1e9) continue;
		const last = p[p.length - 1];
		if (!last || last[0] !== q[0] || last[1] !== q[1]) p.push([q[0], q[1]]);
	}
	if (p.length < 2) return null;
	const first = p[0];
	const last = p[p.length - 1];
	const [x0, y0, w, h] = bbox(p);
	const size = Math.max(w, h);
	const diag = Math.hypot(w, h);
	if (size < minSize) return null;
	let length = 0;
	for (let i = 1; i < p.length; i++) length += dist(p[i - 1], p[i]);
	const gap = dist(first, last);
	// A line: the stroke barely leaves the chord between its ends and doesn't double back.
	if (gap > 0.85 * length && gap >= minSize) {
		const off = Math.max(...p.map((q) => segDistance(first, last, q)));
		if (off <= Math.max(0.06 * gap, (1.5 * minSize) / 6)) return { kind: 'line', a: first, b: last };
	}
	// Other shapes are closed: the stroke ends near where it began and goes around.
	if (gap > 0.2 * size || length < 2 * size) return null;
	const rms = ellipseRms(p, x0, y0, w, h);
	const roundish = w > 0.2 * size && h > 0.2 * size;
	const ellipse = (): VectorInkShape => {
		const [x, y, sw, sh] = snapSquare(x0, y0, w, h);
		return { kind: 'ellipse', x, y, width: sw, height: sh };
	};
	if (roundish && rms < 0.06) return ellipse();
	const c = corners(p, diag);
	const fits = c.length >= 3 && p.every((q) => polygonDistance(c, q) <= 0.08 * diag);
	if (fits && c.length === 4 && upright(c)) {
		const [bx, by, bw, bh] = bbox(c);
		const [x, y, sw, sh] = snapSquare(bx, by, bw, bh);
		return { kind: 'rect', x, y, width: sw, height: sh };
	}
	if (fits && c.length <= VECTOR_INK_MAX_CORNERS) return { kind: 'polygon', points: c };
	// A wobbly round stroke is still an ellipse.
	return roundish && rms < 0.1 ? ellipse() : null;
}
