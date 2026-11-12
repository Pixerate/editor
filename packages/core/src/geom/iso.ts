/**
 * Isometric ("2.5D") projection (#799): 3D grid coordinates (i, j, k) drawn flat, as boxes with
 * three visible faces, for blocks, stacks and architecture-style pictures. Pure geometry with no
 * renderer: the vector editor turns boxes into editable paths and the diagram export into SVG.
 *
 * `i` runs down and to the right, `j` down and to the left, `k` up. A box shows its top (`k1`),
 * its right face (`i = i1`) and its left face (`j = j1`).
 */
import type { Box, Vec2 } from './types';

export interface IsoOptions {
	/** Angle of the i and j axes above the horizontal, degrees (default 30: true isometric). */
	angle?: number;
	/** Document units per grid unit (default 20). */
	scale?: number;
	/** Where (0, 0, 0) lands (default { x: 0, y: 0 }). */
	origin?: Vec2;
}

/** A box in grid units: each axis from low to high (`k0` may equal `k1` for a flat tile). */
export interface IsoBox {
	i0: number;
	i1: number;
	j0: number;
	j1: number;
	k0: number;
	k1: number;
}

/** A box drawn: its faces as point lists and path data, the eight corners and the outline. */
export interface IsoBoxFaces {
	top: Vec2[];
	/** The face at `i = i1` (empty for a flat tile). */
	right: Vec2[];
	/** The face at `j = j1` (empty for a flat tile). */
	left: Vec2[];
	/** SVG path data per face (`""` for a missing face). */
	d: { top: string; right: string; left: string };
	/** The six-sided silhouette, clockwise on screen: an obstacle for label placement. */
	outline: Vec2[];
	/** Axis-aligned bounds of the outline. */
	bounds: Box;
}

export interface IsoProjector {
	readonly angle: number;
	readonly scale: number;
	readonly origin: Vec2;
	/** Grid point (i, j, k) on the page. */
	point(i: number, j: number, k?: number): Vec2;
	/** The eight corners of `b`, k0 then k1, each (i0 j0), (i1 j0), (i1 j1), (i0 j1). */
	corners(b: IsoBox): Vec2[];
	/** The visible faces of `b`. */
	box(b: IsoBox): IsoBoxFaces;
	/** Grid lines on the visible faces at whole multiples of `step` (so a partial block lines up with whole ones). */
	gridLines(b: IsoBox, step?: number): { top: [Vec2, Vec2][]; right: [Vec2, Vec2][]; left: [Vec2, Vec2][] };
}

/** Problems with a box, or `[]`. */
export function isoBoxProblems(b: unknown): string[] {
	if (typeof b !== 'object' || b === null) return ['a box is { i0, i1, j0, j1, k0, k1 }'];
	const v = b as Record<string, unknown>;
	const out: string[] = [];
	for (const key of ['i0', 'i1', 'j0', 'j1', 'k0', 'k1']) if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) out.push(`${key} must be a number`);
	if (out.length) return out;
	const n = v as unknown as IsoBox;
	if (!(n.i0 < n.i1) || !(n.j0 < n.j1) || !(n.k0 <= n.k1)) out.push('each axis must run from low to high (i0 < i1, j0 < j1, k0 <= k1)');
	return out;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
const pathOf = (pts: readonly Vec2[]) => (pts.length ? `M${pts.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join(' L')} Z` : '');

/** An isometric projector. Throws for an angle outside 1–89 degrees or a scale that is not positive. */
export function isoProjector(options: IsoOptions = {}): IsoProjector {
	const angle = options.angle ?? 30;
	const scale = options.scale ?? 20;
	const origin = { x: options.origin?.x ?? 0, y: options.origin?.y ?? 0 };
	if (!(angle >= 1 && angle <= 89)) throw new Error(`The isometric angle must be from 1 to 89 degrees, not ${angle}.`);
	if (!(scale > 0) || !Number.isFinite(scale)) throw new Error(`The isometric scale must be a positive number of document units per grid unit, not ${scale}.`);
	const cos = Math.cos((angle * Math.PI) / 180) * scale;
	const sin = Math.sin((angle * Math.PI) / 180) * scale;
	const point = (i: number, j: number, k = 0): Vec2 => ({ x: origin.x + (i - j) * cos, y: origin.y + (i + j) * sin - k * scale });
	const corners = (b: IsoBox) => [b.k0, b.k1].flatMap((k) => [point(b.i0, b.j0, k), point(b.i1, b.j0, k), point(b.i1, b.j1, k), point(b.i0, b.j1, k)]);
	const box = (b: IsoBox): IsoBoxFaces => {
		const flat = b.k0 === b.k1;
		const top = [point(b.i0, b.j0, b.k1), point(b.i1, b.j0, b.k1), point(b.i1, b.j1, b.k1), point(b.i0, b.j1, b.k1)];
		const right = flat ? [] : [point(b.i1, b.j0, b.k1), point(b.i1, b.j1, b.k1), point(b.i1, b.j1, b.k0), point(b.i1, b.j0, b.k0)];
		const left = flat ? [] : [point(b.i0, b.j1, b.k1), point(b.i1, b.j1, b.k1), point(b.i1, b.j1, b.k0), point(b.i0, b.j1, b.k0)];
		const outline = flat ? top : [point(b.i0, b.j0, b.k1), point(b.i1, b.j0, b.k1), point(b.i1, b.j0, b.k0), point(b.i1, b.j1, b.k0), point(b.i0, b.j1, b.k0), point(b.i0, b.j1, b.k1)];
		const xs = outline.map((p) => p.x);
		const ys = outline.map((p) => p.y);
		const minX = Math.min(...xs);
		const minY = Math.min(...ys);
		return { top, right, left, d: { top: pathOf(top), right: pathOf(right), left: pathOf(left) }, outline, bounds: { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY } };
	};
	const gridLines = (b: IsoBox, step = 1) => {
		if (!(step > 0)) throw new Error(`The grid step must be a positive number of grid units, not ${step}.`);
		/** Whole multiples of `step` strictly inside (lo, hi). */
		const inside = (lo: number, hi: number) => {
			const out: number[] = [];
			for (let n = Math.floor(lo / step) + 1; n * step < hi - 1e-9; n++) if (n * step > lo + 1e-9) out.push(n * step);
			return out;
		};
		const top: [Vec2, Vec2][] = [...inside(b.i0, b.i1).map((i) => [point(i, b.j0, b.k1), point(i, b.j1, b.k1)] as [Vec2, Vec2]), ...inside(b.j0, b.j1).map((j) => [point(b.i0, j, b.k1), point(b.i1, j, b.k1)] as [Vec2, Vec2])];
		const flat = b.k0 === b.k1;
		const right: [Vec2, Vec2][] = flat ? [] : [...inside(b.j0, b.j1).map((j) => [point(b.i1, j, b.k0), point(b.i1, j, b.k1)] as [Vec2, Vec2]), ...inside(b.k0, b.k1).map((k) => [point(b.i1, b.j0, k), point(b.i1, b.j1, k)] as [Vec2, Vec2])];
		const left: [Vec2, Vec2][] = flat ? [] : [...inside(b.i0, b.i1).map((i) => [point(i, b.j1, b.k0), point(i, b.j1, b.k1)] as [Vec2, Vec2]), ...inside(b.k0, b.k1).map((k) => [point(b.i0, b.j1, k), point(b.i1, b.j1, k)] as [Vec2, Vec2])];
		return { top, right, left };
	};
	return { angle, scale, origin, point, corners, box, gridLines };
}

/** Whether `a` lies wholly behind `b` along some axis (so it is drawn first where they overlap). */
const behind = (a: IsoBox, b: IsoBox) => a.i1 <= b.i0 || a.j1 <= b.j0 || a.k1 <= b.k0;
const boundsOverlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const depth = (b: IsoBox) => b.i0 + b.i1 + b.j0 + b.j1 + b.k0 + b.k1;

/**
 * The order to draw `boxes` in, back to front, as indices into `boxes`. Where two outlines
 * overlap, the box wholly behind the other along an axis comes first; otherwise the farther one
 * (smaller i + j + k) does, then input order. A cycle is broken at the farthest box.
 */
export function isoOrder(boxes: readonly IsoBox[], projector: IsoProjector = isoProjector()): number[] {
	const bounds = boxes.map((b) => projector.box(b).bounds);
	const n = boxes.length;
	const after: number[][] = Array.from({ length: n }, () => []);
	const blockers = new Array<number>(n).fill(0);
	for (let a = 0; a < n; a++)
		for (let b = 0; b < n; b++) {
			if (a === b || !boundsOverlap(bounds[a], bounds[b])) continue;
			if (behind(boxes[a], boxes[b]) && !behind(boxes[b], boxes[a])) {
				after[a].push(b);
				blockers[b]++;
			}
		}
	const done = new Array<boolean>(n).fill(false);
	const order: number[] = [];
	const better = (x: number, y: number) => depth(boxes[x]) < depth(boxes[y]) || (depth(boxes[x]) === depth(boxes[y]) && x < y);
	while (order.length < n) {
		let pick = -1;
		for (let i = 0; i < n; i++) if (!done[i] && blockers[i] === 0 && (pick < 0 || better(i, pick))) pick = i;
		// A cycle: break it at the farthest box left.
		if (pick < 0) for (let i = 0; i < n; i++) if (!done[i] && (pick < 0 || better(i, pick))) pick = i;
		done[pick] = true;
		order.push(pick);
		for (const b of after[pick]) blockers[b]--;
	}
	return order;
}

/** `hex` (#rgb or #rrggbb) moved `amount` (0–1) towards black; other colours come back unchanged. */
export function isoShade(hex: string, amount: number): string {
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return hex;
	const full = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
	const channel = (k: number) => Math.round(parseInt(full.slice(k, k + 2), 16) * (1 - amount));
	return `#${[0, 2, 4].map((k) => channel(k).toString(16).padStart(2, '0')).join('')}`;
}

/** The three face colours of one fill: the top as given, the left 15 % darker, the right 30 %. */
export function isoFaceColors(fill: string): { top: string; left: string; right: string } {
	return { top: fill, left: isoShade(fill, 0.15), right: isoShade(fill, 0.3) };
}
