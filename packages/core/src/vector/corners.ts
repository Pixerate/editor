/**
 * Live corners: a radius stored on an anchor, drawn as a round, inverted or chamfered cut when
 * the path is turned into curves. The stored anchors never change; `expandVectorCorners` is the
 * one place the cut geometry is made, and `subpathsToBezier` calls it, so rendering,
 * hit-testing, bounds, booleans, stroke outlines and SVG export all see the same shape.
 *
 * Ported from ArtCraft (MIT OR Apache-2.0, see THIRD_PARTY_NOTICES.md):
 * - figcraft `crates/doc/src/vector.rs` — `VectorNetwork::rounded` / `corner` and `trim`: each
 *   side is trimmed by arc length (the radius clamped so a cut takes at most half of each
 *   side) and the round cut is a cubic with handles `4/3 · tan(φ/4) · ρ` along the sides'
 *   directions at the cut, φ the turn between them and ρ the radius of the circle through
 *   both ends. That is exact at any angle and works where a curve meets a corner.
 * - vectorcraft `crates/geom/src/corners.rs` — `path_corners`, `Corner` (setback, max radius,
 *   bisector and radius change for the drag widget) and `cut_corners` (inverted round and
 *   chamfer kinds, trimming curved sides between cuts, a closed subpath whose first corner is
 *   cut starting where that cut ends).
 */
import type { Point } from '../canvas/types.js';
import { segmentDerivative, segmentLength, segmentParamAtLength, segmentPoint, subSegment } from '../canvas/pathops/bezier.js';
import type { VectorAnchor, VectorCornerKind, VectorSubpath, Vec2 } from './types.js';

const EPS = 1e-9;
/** Sides closer than this to straight on (or folded back), as the sine of their angle, make no corner. */
const MIN_SINE = 1e-6;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const len = (a: Vec2) => Math.hypot(a.x, a.y);
const pt = (p: Vec2): Point => [p.x, p.y];
const vec = (p: Point): Vec2 => ({ x: p[0], y: p[1] });
const onAnchor = (a: VectorAnchor, h: Vec2 | null | undefined) => !h || (Math.abs(h.x - a.x) < EPS && Math.abs(h.y - a.y) < EPS);

/** A side of a corner: the segment from the corner's anchor to a neighbour, as a cubic leaving the corner. */
class Side {
	readonly curve: Point[];
	readonly straight: boolean;
	readonly length: number;
	constructor(a: VectorAnchor, h1: Vec2 | null | undefined, h2: Vec2 | null | undefined, b: VectorAnchor) {
		this.straight = onAnchor(a, h1) && onAnchor(b, h2);
		this.curve = this.straight ? [pt(a), pt(b)] : [pt(a), pt(h1 ?? a), pt(h2 ?? b), pt(b)];
		this.length = this.straight ? Math.hypot(b.x - a.x, b.y - a.y) : segmentLength(this.curve);
	}

	/** Unit direction the side leaves the corner in (towards its first control point off the corner). */
	direction(): Vec2 | null {
		const p0 = vec(this.curve[0]);
		for (const q of this.curve.slice(1)) {
			const d = sub(vec(q), p0);
			const l = len(d);
			if (l > EPS) return mul(d, 1 / l);
		}
		return null;
	}

	/** The point `s` along the side from the corner: its parameter, position and the direction the side runs on in there. */
	at(s: number, u: Vec2): { t: number; p: Vec2; dir: Vec2 } {
		if (this.straight) {
			const t = this.length > EPS ? Math.min(1, Math.max(0, s / this.length)) : 0;
			return { t, p: add(vec(this.curve[0]), mul(u, s)), dir: u };
		}
		const t = segmentParamAtLength(this.curve, s, this.length);
		const d = vec(segmentDerivative(this.curve, t));
		const l = len(d);
		return { t, p: vec(segmentPoint(this.curve, t)), dir: l > EPS ? mul(d, 1 / l) : u };
	}
}

/**
 * A corner a live radius can cut: an anchor that is not smooth, where two sides (straight or
 * curved) meet at an angle. Positions are in the path node's own space.
 */
export interface VectorCornerInfo {
	subpath: number;
	index: number;
	/** Where the sides meet. */
	at: Vec2;
	/** Unit directions the sides leave the corner in: towards the previous anchor, then the next one. */
	u: Vec2;
	v: Vec2;
	/** The sides' lengths (along curves), in the same order. */
	lu: number;
	lv: number;
	/** Cosine and sine of the angle between the sides. */
	cos: number;
	sin: number;
	/** The angle between the sides in degrees (90 at a rectangle's corners). */
	angle: number;
	/** The largest radius that fits: its cut then reaches halfway along the shorter side. */
	maxRadius: number;
}

interface CornerData extends VectorCornerInfo {
	sideU: Side;
	sideV: Side;
}

function cornerOf(sp: VectorSubpath, s: number, i: number): CornerData | null {
	const n = sp.anchors.length;
	if (n < 2 || (!sp.closed && (i === 0 || i === n - 1))) return null;
	if (n === 2 && sp.closed) return null;
	const a = sp.anchors[i];
	if (a.type === 'smooth' || a.type === 'symmetric') return null;
	const prev = sp.anchors[(i - 1 + n) % n];
	const next = sp.anchors[(i + 1) % n];
	const sideU = new Side(a, a.in, prev.out, prev);
	const sideV = new Side(a, a.out, next.in, next);
	const u = sideU.direction();
	const v = sideV.direction();
	if (!u || !v) return null;
	const lu = sideU.length;
	const lv = sideV.length;
	if (!(lu > EPS && lv > EPS) || !Number.isFinite(lu) || !Number.isFinite(lv)) return null;
	const cos = Math.max(-1, Math.min(1, dot(u, v)));
	const sin = Math.abs(cross(u, v));
	if (sin <= MIN_SINE) return null;
	return { subpath: s, index: i, at: { x: a.x, y: a.y }, u, v, lu, lv, cos, sin, angle: (Math.atan2(sin, cos) * 180) / Math.PI, maxRadius: ((Math.min(lu, lv) / 2) * sin) / (1 + cos), sideU, sideV };
}

const strip = ({ sideU: _u, sideV: _v, ...info }: CornerData): VectorCornerInfo => info;

/** The corner at anchor `index` of a subpath, or null when the anchor makes none (an open end, smooth, or straight on). */
export function vectorCornerAt(sp: VectorSubpath, index: number, subpath = 0): VectorCornerInfo | null {
	const c = cornerOf(sp, subpath, index);
	return c ? strip(c) : null;
}

/** Every corner of the subpaths that a live radius can cut, in anchor order. */
export function vectorCorners(subpaths: readonly VectorSubpath[]): VectorCornerInfo[] {
	const out: VectorCornerInfo[] = [];
	subpaths.forEach((sp, s) => {
		for (let i = 0; i < sp.anchors.length; i++) {
			const c = cornerOf(sp, s, i);
			if (c) out.push(strip(c));
		}
	});
	return out;
}

/** How far from the corner a round cut of radius `r` meets each side: r / tan(angle / 2). */
export const cornerSetback = (c: Pick<VectorCornerInfo, 'cos' | 'sin'>, r: number) => (r * (1 + c.cos)) / c.sin;

/** `radius` clamped to what the corner can draw (0 for negative or non-finite radii). */
export const fitCornerRadius = (c: Pick<VectorCornerInfo, 'maxRadius'>, radius: number) => (Number.isFinite(radius) ? Math.min(Math.max(0, radius), c.maxRadius) : 0);

/** The point `k` along the corner's bisector, measured in (u + v): a round cut of radius r is centred at k = r / sin. */
export const cornerBisectorPoint = (c: VectorCornerInfo, k: number): Vec2 => add(c.at, mul(add(c.u, c.v), k));

/** How much the radius grows when the round cut's centre moves by `d` (its part along the bisector, in radius units). */
export const cornerRadiusChange = (c: VectorCornerInfo, d: Vec2) => (dot(d, add(c.u, c.v)) * c.sin) / (2 + 2 * c.cos);

/** Handle length per unit radius of a cubic arc spanning the angle whose cosine is `cos`: 4/3 · tan(angle / 4). */
function arcHandle(cos: number): number {
	const c = Math.max(-1, Math.min(1, cos));
	const sinHalf = Math.sqrt(Math.max(0, (1 - c) / 2));
	const cosHalf = Math.sqrt(Math.max(0, (1 + c) / 2));
	return ((4 / 3) * sinHalf) / (1 + cosHalf);
}

/** The unit direction square to unit `a`, on `b`'s side. */
function squareTo(a: Vec2, b: Vec2): Vec2 {
	const w = sub(b, mul(a, dot(a, b)));
	const l = len(w);
	return l > EPS ? mul(w, 1 / l) : { x: 0, y: 0 };
}

interface Cut {
	/** Parameters along each side (from the corner) where the cut meets it. */
	tu: number;
	tv: number;
	start: Vec2;
	/** Handles of the cut's own segment (absent for a chamfer). */
	out: Vec2 | null;
	in: Vec2 | null;
	end: Vec2;
	/** Anchors between `start` and `end` (a smoothed corner's arc ends), with their handles. */
	inner?: VectorAnchor[];
}

/**
 * A smoothed round corner between straight sides (the squircle of figma-squircle and figcraft's
 * `corner_profile`, generalised from 90° to any angle): along each side it starts `(1 + s)` times
 * the round setback from the corner, eases in with a cubic whose second handle is where the arc's
 * tangent meets the side, follows a circular arc over `(1 − s)` of the turn, and eases out the same
 * way. Smoothing shrinks first when the cut would not fit halfway along the shorter side.
 */
function smoothCut(c: CornerData, radius: number, smoothing: number): Cut | null {
	const turn = Math.PI - Math.acos(Math.max(-1, Math.min(1, c.cos)));
	const t = cornerSetback(c, radius);
	const room = Math.min(c.lu, c.lv) / 2;
	let s = Math.max(0, Math.min(1, smoothing));
	if ((1 + s) * t > room) s = Math.max(0, Math.min(s, room / t - 1));
	const beta = (turn * s) / 2;
	if (!(beta > 1e-6) || !(t > EPS)) return null;
	const p = Math.min((1 + s) * t, room);
	const qa = radius * Math.tan(beta / 2);
	const q = t - qa;
	const side = (u: Vec2, v: Vec2) => {
		const n = squareTo(u, v);
		const e = add(c.at, mul(u, p));
		const c1 = add(c.at, mul(u, (p + 2 * q) / 3));
		const qp = add(c.at, mul(u, q));
		const a = add(sub(qp, mul(u, qa * Math.cos(beta))), mul(n, qa * Math.sin(beta)));
		return { e, c1, q: qp, a };
	};
	const U = side(c.u, c.v);
	const V = side(c.v, c.u);
	// The arc between the two ends, its handles along the tangents (away from the sides' crossings).
	const sweep = turn * (1 - s);
	const h = radius * (4 / 3) * Math.tan(sweep / 4);
	const tanU = sub(U.a, U.q);
	const tanV = sub(V.a, V.q);
	const lu = len(tanU) || 1;
	const lv = len(tanV) || 1;
	const arcOut = add(U.a, mul(tanU, h / lu));
	const arcIn = add(V.a, mul(tanV, h / lv));
	const tu = c.sideU.at(p, c.u).t;
	const tv = c.sideV.at(p, c.v).t;
	return {
		tu,
		tv,
		start: U.e,
		out: U.c1,
		inner: [
			{ x: U.a.x, y: U.a.y, in: U.q, out: arcOut },
			{ x: V.a.x, y: V.a.y, in: arcIn, out: V.q }
		],
		in: V.c1,
		end: V.e
	};
}

function cutCorner(c: CornerData, radius: number, kind: VectorCornerKind, smoothing = 0): Cut | null {
	// figcraft `corner`: trim each side by arc length, at most half of it.
	const s = Math.min(cornerSetback(c, radius), Math.min(c.lu, c.lv) / 2);
	if (!(s > EPS)) return null;
	const a = c.sideU.at(s, c.u);
	const b = c.sideV.at(s, c.v);
	if (kind === 'chamfer') return { tu: a.t, tv: b.t, start: a.p, out: null, in: null, end: b.p };
	if (kind === 'inverted') {
		// vectorcraft `cut`: an arc centred on the corner through both ends, spanning the corner's angle.
		const h = s * arcHandle(dot(a.dir, b.dir));
		return { tu: a.t, tv: b.t, start: a.p, out: add(a.p, mul(squareTo(a.dir, b.dir), h)), in: add(b.p, mul(squareTo(b.dir, a.dir), h)), end: b.p };
	}
	if (smoothing > 0 && c.sideU.straight && c.sideV.straight) {
		const smooth = smoothCut(c, radius, smoothing);
		if (smooth) return smooth;
	}
	// Round: d1, d2 point back towards the corner at the cut's ends; φ is the turn between them
	// and ρ the radius of the circle through both ends.
	const d1 = mul(a.dir, -1);
	const d2 = mul(b.dir, -1);
	const turn = Math.acos(Math.max(-1, Math.min(1, -dot(d1, d2))));
	const chord = len(sub(b.p, a.p));
	const k = turn < 1e-9 ? chord / 3 : (((4 / 3) * Math.tan(turn / 4) * chord) / (2 * Math.sin(turn / 2)));
	if (!Number.isFinite(k)) return null;
	return { tu: a.t, tv: b.t, start: a.p, out: add(a.p, mul(d1, k)), in: add(b.p, mul(d2, k)), end: b.p };
}

const radiusOf = (a: VectorAnchor) => {
	const r = a.corner?.radius;
	return typeof r === 'number' && r > 0 && Number.isFinite(r) ? r : 0;
};

/** True when any anchor of the subpaths has a live corner radius. */
export function hasVectorCorners(subpaths: readonly VectorSubpath[]): boolean {
	return subpaths.some((sp) => sp.anchors.some((a) => radiusOf(a) > 0));
}

/** One subpath with its corners cut; `sources[i]` is the stored anchor each output anchor comes from. */
export function expandVectorCornersOf(sp: VectorSubpath, subpath = 0): { subpath: VectorSubpath; sources: number[] } {
	const n = sp.anchors.length;
	const cuts: (Cut | null)[] = sp.anchors.map((a, i) => {
		const r = radiusOf(a);
		if (!r) return null;
		const c = cornerOf(sp, subpath, i);
		if (!c) return null;
		const fitted = fitCornerRadius(c, r);
		return fitted > EPS ? cutCorner(c, fitted, a.corner?.kind ?? 'round', a.corner?.smoothing ?? 0) : null;
	});
	if (!cuts.some(Boolean)) return { subpath: { closed: sp.closed, anchors: sp.anchors.map(plain) }, sources: sp.anchors.map((_, i) => i) };
	// Each segment from anchor j trimmed to what the cuts at its ends leave: its handles, or
	// undefined when it is untouched (null handles: a straight segment).
	const trimmed: ({ out: Vec2 | null; in: Vec2 | null } | undefined)[] = sp.anchors.map((a, j) => {
		const k = (j + 1) % n;
		if (k === 0 && !sp.closed) return undefined;
		const b = sp.anchors[k];
		const from = cuts[j];
		const to = cuts[k];
		if (!from && !to) return undefined;
		if (onAnchor(a, a.out) && onAnchor(b, b.in)) return { out: null, in: null };
		const s0 = from ? from.tv : 0;
		const s1 = to ? 1 - to.tu : 1;
		const seg: Point[] = [pt(a), pt(a.out ?? a), pt(b.in ?? b), pt(b)];
		const part = subSegment(seg, s0, Math.max(s0, s1));
		return { out: vec(part[1]), in: vec(part[2]) };
	});
	const anchors: VectorAnchor[] = [];
	const sources: number[] = [];
	let closing: VectorAnchor | null = null;
	const handleIn = (i: number, a: VectorAnchor) => {
		const t = trimmed[(i - 1 + n) % n];
		return t ? t.in : (a.in ?? null);
	};
	const handleOut = (i: number, a: VectorAnchor) => {
		const t = trimmed[i];
		return t ? t.out : (a.out ?? null);
	};
	sp.anchors.forEach((a, i) => {
		const c = cuts[i];
		if (!c) {
			anchors.push(withHandles({ x: a.x, y: a.y, ...(a.type ? { type: a.type } : {}) }, handleIn(i, a), handleOut(i, a)));
			sources.push(i);
			return;
		}
		const start = withHandles({ x: c.start.x, y: c.start.y }, handleIn(i, a), c.out);
		const end = withHandles({ x: c.end.x, y: c.end.y }, c.in, handleOut(i, a));
		if (i === 0 && sp.closed) closing = start;
		else {
			anchors.push(start);
			sources.push(i);
		}
		for (const inner of c.inner ?? []) {
			anchors.push({ ...inner });
			sources.push(i);
		}
		anchors.push(end);
		sources.push(i);
	});
	if (closing) {
		anchors.push(closing);
		sources.push(0);
	}
	return { subpath: { closed: sp.closed, anchors }, sources };
}

function withHandles(a: VectorAnchor, hin: Vec2 | null, hout: Vec2 | null): VectorAnchor {
	if (hin && !onAnchor(a, hin)) a.in = { x: hin.x, y: hin.y };
	if (hout && !onAnchor(a, hout)) a.out = { x: hout.x, y: hout.y };
	return a;
}

function plain(a: VectorAnchor): VectorAnchor {
	if (!('corner' in a)) return a;
	const { corner: _c, ...rest } = a;
	return rest;
}

/**
 * The subpaths with every live corner cut (round, inverted or chamfer), each radius no larger
 * than fits. A cut corner becomes two anchors and curved sides are trimmed to what the cuts
 * leave of them. Subpaths without corners come back unchanged.
 */
export function expandVectorCorners(subpaths: readonly VectorSubpath[]): VectorSubpath[] {
	if (!hasVectorCorners(subpaths)) return subpaths as VectorSubpath[];
	return subpaths.map((sp, s) => (sp.anchors.some((a) => radiusOf(a) > 0) ? expandVectorCornersOf(sp, s).subpath : sp));
}

/**
 * Sets (or clears, with radius 0) the live corner of anchors. `kind` keeps each anchor's own
 * kind when omitted. Anchors that make no corner keep the radius too, so it applies once they do.
 */
export function setAnchorCorner(a: VectorAnchor, radius: number, kind?: VectorCornerKind, smoothing?: number): VectorAnchor {
	const { corner, ...rest } = a;
	const r = Number.isFinite(radius) ? Math.max(0, radius) : 0;
	const k = kind ?? corner?.kind;
	const s = Math.max(0, Math.min(1, smoothing ?? corner?.smoothing ?? 0));
	if (r <= 0 && !kind) return rest;
	return { ...rest, corner: { radius: r, ...(k && k !== 'round' ? { kind: k } : {}), ...(s > 0 ? { smoothing: s } : {}) } };
}

/** The next corner kind (Alt-clicking a corner widget cycles round → inverted → chamfer). */
export function nextVectorCornerKind(kind: VectorCornerKind | undefined): VectorCornerKind {
	return kind === 'inverted' ? 'chamfer' : kind === 'chamfer' ? 'round' : 'inverted';
}

/** Every anchor of a subpath given the same live corner (radius 0 clears them). */
export function setSubpathCorners(sp: VectorSubpath, radius: number, kind?: VectorCornerKind, smoothing?: number): VectorSubpath {
	return { closed: sp.closed, anchors: sp.anchors.map((a) => setAnchorCorner(a, radius, kind, smoothing)) };
}
