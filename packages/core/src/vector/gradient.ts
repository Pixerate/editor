/**
 * Vector gradients: sampling (stop midpoints, smoothness, sRGB / linear-light / Oklab
 * interpolation), geometry (a three-point frame: start, end and the secondary-axis "width"
 * point, in the shape's bounding box or its own space; focal point and radius), spread modes and
 * DOM-free SVG paint servers for every style.
 *
 * Linear and radial gradients become `<linearGradient>` / `<radialGradient>` in
 * `userSpaceOnUse` with a `gradientTransform` (so fill, stroke parts and effect copies share one
 * frame, and a box with no height still paints). Midpoints, smoothness and non-sRGB
 * interpolation are not native to SVG: they export as extra stops (`expandVectorGradientStops`)
 * close to the true curve. Reflected gradients are a linear gradient with mirrored stops (or
 * `spreadMethod="reflect"`). Conic and diamond gradients have no SVG element: they become a
 * `<pattern>` in user space whose tiles each carry a linear gradient — 4 exact quadrants for a
 * diamond (t = |u| + |v| is linear in each), thin wedges for a conic gradient.
 *
 * Ported (re-expressed in TypeScript) from the ArtCraft apps (MIT OR Apache-2.0, see
 * THIRD_PARTY_NOTICES.md): vectorcraft `crates/color/src/gradient.rs` (`Gradient::sample_with`
 * midpoint mapping, `expanded_stops`, `reverse`, `span`, stop editing helpers and
 * `GradientGeom::param_at` / `set_focal`), photocraft `crates/compose/src/gradient_fill.rs`
 * (`midpoint_remap`, the Linear / Radial / Angle / Reflected / Diamond styles of `gradient_t`),
 * photocraft `crates/io/src/gradient_bake.rs` (`eval`: smoothness as a Catmull-Rom blend and the
 * interpolation spaces), effectcraft `crates/render/src/shapes.rs` (`GradientRamp::t`, the focal
 * ray), figcraft `crates/color/src/lib.rs` (`GradientKind` angular / diamond and the three-handle
 * unit-box frame) and vectorcraft `crates/svg/src/import/spread.rs` (`expand`: spread modes as
 * repeated stop periods).
 */
import { hexToRgba, normalizeTokenColor, rgbaToHex } from '../tokens/color.js';
import { rgbToOklab, oklabToRgb } from '../animation/color.js';
import { angleToSvgLinearCoords, type SvgGradientDef, type SvgGradientStop } from '../canvas/gradient.js';
import type {
	Vec2,
	VectorBounds,
	VectorGradient,
	VectorGradientInterpolation,
	VectorGradientSpread,
	VectorGradientStop,
	VectorGradientType,
	VectorGradientUnits,
	VectorMatrix,
	VectorPaint
} from './types.js';
import { VECTOR_GRADIENT_INTERPOLATIONS, VECTOR_GRADIENT_SPREADS, VECTOR_GRADIENT_TYPES, VECTOR_STROKE_GRADIENT_MODES } from './types.js';


// ---------------------------------------------------------------------------
// Small maths
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const IDENTITY: VectorMatrix = [1, 0, 0, 1, 0, 0];
/** `a` then `b`. */
const mul = (a: VectorMatrix, b: VectorMatrix): VectorMatrix => [
	b[0] * a[0] + b[2] * a[1],
	b[1] * a[0] + b[3] * a[1],
	b[0] * a[2] + b[2] * a[3],
	b[1] * a[2] + b[3] * a[3],
	b[0] * a[4] + b[2] * a[5] + b[4],
	b[1] * a[4] + b[3] * a[5] + b[5]
];
const apply = (m: VectorMatrix, p: Vec2): Vec2 => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
const invert = (m: VectorMatrix): VectorMatrix | null => {
	const [a, b, c, d, e, f] = m;
	const det = a * d - b * c;
	if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
const isIdentity = (m: VectorMatrix) => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
/** 90° clockwise on screen (y down): the secondary axis of a frame. */
const perp = (v: Vec2): Vec2 => ({ x: -v.y, y: v.x });
const finitePoint = (p: unknown): p is Vec2 => !!p && typeof p === 'object' && Number.isFinite((p as Vec2).x) && Number.isFinite((p as Vec2).y);

const fmt = (n: number, digits = 4) => {
	const k = 10 ** digits;
	const v = Math.round(n * k) / k;
	return Object.is(v, -0) ? '0' : String(v);
};
const fmtMatrix = (m: VectorMatrix) => `matrix(${m.map((n) => fmt(n, 6)).join(' ')})`;

/** True when `paint` is a gradient (any style). */
export function isVectorGradient(paint: VectorPaint | undefined): paint is VectorGradient {
	return !!paint && typeof paint === 'object' && VECTOR_GRADIENT_TYPES.includes((paint as VectorGradient).type) && Array.isArray((paint as VectorGradient).stops);
}

// ---------------------------------------------------------------------------
// Colours and interpolation spaces
// ---------------------------------------------------------------------------

/** Straight-alpha sRGB channels, 0–1. */
export type VectorRgba = [number, number, number, number];

/** A CSS colour as 0–1 channels (hex, `rgb()`, `transparent`, `black`, `white`), or null. */
export function parseVectorColor(color: string): VectorRgba | null {
	const hex = normalizeTokenColor(color);
	if (hex === null) return null;
	const c = hexToRgba(hex)!;
	return [c.r, c.g, c.b, c.a];
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => {
	const v = clamp(c, 0, 1);
	return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

function intoSpace(space: VectorGradientInterpolation, [r, g, b]: readonly number[]): [number, number, number] {
	if (space === 'linear') return [toLinear(r), toLinear(g), toLinear(b)];
	if (space === 'oklab') {
		const c = rgbToOklab(r, g, b);
		return [c.l, c.a, c.b];
	}
	return [r, g, b];
}

function outOfSpace(space: VectorGradientInterpolation, [x, y, z]: readonly number[]): [number, number, number] {
	if (space === 'linear') return [toGamma(x), toGamma(y), toGamma(z)];
	if (space === 'oklab') {
		const c = oklabToRgb({ l: x, a: y, b: z, alpha: 1 });
		return [c.r, c.g, c.b];
	}
	return [clamp(x, 0, 1), clamp(y, 0, 1), clamp(z, 0, 1)];
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

/** Least and most a midpoint can be (the stop editors clamp further, to 0.05–0.95). */
const MID_MIN = 0.01;
const MID_MAX = 0.99;
/** Fewest stops a gradient keeps when one is removed. */
export const VECTOR_GRADIENT_MIN_STOPS = 2;

/**
 * Where relative position `u` of a segment lands once its midpoint is `m` (0.5 = unchanged): the
 * colour is half-way at `m`, linear on either side (photocraft `midpoint_remap`).
 */
export function gradientMidpointRemap(u: number, m: number): number {
	const mid = clamp(m, MID_MIN, MID_MAX);
	if (Math.abs(mid - 0.5) < 1e-6) return u;
	return u <= mid ? (0.5 * u) / mid : 0.5 + (0.5 * (u - mid)) / (1 - mid);
}

const hasMidpoint = (s: VectorGradientStop) => s.midpoint !== undefined && Number.isFinite(s.midpoint) && Math.abs(s.midpoint - 0.5) > 1e-3;

/** The stops sorted by offset (stable), offsets clamped to 0–1, unreadable offsets dropped. */
export function sortedVectorGradientStops(g: Pick<VectorGradient, 'stops'>): VectorGradientStop[] {
	return (g.stops ?? [])
		.filter((s) => s && Number.isFinite(s.offset) && typeof s.color === 'string')
		.map((s, i) => ({ s: { ...s, offset: clamp(s.offset, 0, 1) }, i }))
		.sort((a, b) => a.s.offset - b.s.offset || a.i - b.i)
		.map((e) => e.s);
}

/** Does the gradient need extra stops to look the same in SVG (midpoints, smoothness or a non-sRGB space)? */
export function vectorGradientNeedsExpansion(g: VectorGradient): boolean {
	return (g.interpolation ?? 'srgb') !== 'srgb' || (g.smoothness ?? 0) > 0 || (g.stops ?? []).some(hasMidpoint);
}

interface RampPoint {
	t: number;
	/** Colour channels in the interpolation space. */
	v: [number, number, number];
	/** Colour alpha × opacity. */
	a: number;
	mid: number;
}

/** A gradient's colour ramp, prepared for sampling. */
export interface VectorGradientRamp {
	/** Straight-alpha sRGB at `t` (clamped to 0–1). */
	sample(t: number): VectorRgba;
}

/**
 * The colour ramp of a gradient (midpoints, smoothness and interpolation space applied), or null
 * when a stop colour is not one `parseVectorColor` reads.
 */
export function vectorGradientRamp(g: Pick<VectorGradient, 'stops' | 'interpolation' | 'smoothness'>): VectorGradientRamp | null {
	const space = g.interpolation && VECTOR_GRADIENT_INTERPOLATIONS.includes(g.interpolation) ? g.interpolation : 'srgb';
	const smooth = clamp(Number.isFinite(g.smoothness) ? (g.smoothness as number) : 0, 0, 1);
	const pts: RampPoint[] = [];
	for (const s of sortedVectorGradientStops(g)) {
		const c = parseVectorColor(s.color);
		if (!c) return null;
		pts.push({ t: s.offset, v: intoSpace(space, c), a: c[3] * clamp(s.opacity ?? 1, 0, 1), mid: s.midpoint ?? 0.5 });
	}
	return {
		sample(t: number): VectorRgba {
			const n = pts.length;
			if (!n) return [0, 0, 0, 0];
			const first = pts[0];
			const last = pts[n - 1];
			const at = (p: RampPoint): VectorRgba => [...outOfSpace(space, p.v), p.a] as VectorRgba;
			if (!(t > first.t) || n < 2) return at(first);
			if (t >= last.t) return at(last);
			let i = 0;
			while (i + 2 < n && !(t >= pts[i].t && t <= pts[i + 1].t)) i++;
			const p0 = pts[i];
			const p1 = pts[i + 1];
			const h = Math.max(p1.t - p0.t, 1e-6);
			const u = gradientMidpointRemap((t - p0.t) / h, p0.mid);
			const alpha = p0.a + (p1.a - p0.a) * u;
			if (smooth <= 0) return [...outOfSpace(space, [0, 1, 2].map((c) => p0.v[c] + (p1.v[c] - p0.v[c]) * u)), alpha] as VectorRgba;
			// Catmull-Rom tangents per unit t; the ends use half the chord slope (gradient_bake `eval`).
			const tangent = (k: number) => {
				const [a, b] = k === 0 ? [0, 1] : k === n - 1 ? [n - 2, n - 1] : [k - 1, k + 1];
				const d = Math.max(pts[b].t - pts[a].t, 1e-6);
				const half = k === 0 || k === n - 1 ? 0.5 : 1;
				return [0, 1, 2].map((c) => ((pts[b].v[c] - pts[a].v[c]) / d) * half);
			};
			const m0 = tangent(i);
			const m1 = tangent(i + 1);
			const u2 = u * u;
			const u3 = u2 * u;
			const h00 = 2 * u3 - 3 * u2 + 1;
			const h10 = u3 - 2 * u2 + u;
			const h01 = -2 * u3 + 3 * u2;
			const h11 = u3 - u2;
			const v = [0, 1, 2].map((c) => {
				const linear = p0.v[c] + (p1.v[c] - p0.v[c]) * u;
				const spline = h00 * p0.v[c] + h10 * h * m0[c] + h01 * p1.v[c] + h11 * h * m1[c];
				const value = linear + (spline - linear) * smooth;
				// Smoothness bends the ramp without inventing colours outside the segment.
				return clamp(value, Math.min(p0.v[c], p1.v[c]), Math.max(p0.v[c], p1.v[c]));
			});
			return [...outOfSpace(space, v), alpha] as VectorRgba;
		}
	};
}

/** What the gradient paints at `t` (0–1 along its stops): `#rrggbb` and opacity. */
export function sampleVectorGradient(g: VectorGradient, t: number): { color: string; opacity: number } {
	const ramp = vectorGradientRamp(g);
	if (ramp) {
		const [r, gg, b, a] = ramp.sample(t);
		return { color: rgbaToHex(r, gg, b), opacity: a };
	}
	// Unreadable colours: the nearest stop at or before `t`.
	const stops = sortedVectorGradientStops(g);
	const s = [...stops].reverse().find((x) => x.offset <= t) ?? stops[0];
	return s ? { color: s.color, opacity: s.opacity ?? 1 } : { color: '#000000', opacity: 0 };
}

const stopOf = (offset: number, c: VectorRgba): VectorGradientStop => {
	const color = rgbaToHex(c[0], c[1], c[2]);
	const opacity = Math.round(c[3] * 1e4) / 1e4;
	return opacity < 1 ? { offset, color, opacity } : { offset, color };
};

const maxDiff = (a: VectorRgba, b: VectorRgba) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]));
const lerpRgba = (a: VectorRgba, b: VectorRgba, u: number): VectorRgba => [0, 1, 2, 3].map((c) => a[c] + (b[c] - a[c]) * u) as VectorRgba;

/**
 * Plain stops (no midpoints) that SVG's sRGB interpolation turns into the gradient's colours:
 * the stops as they are when nothing needs expanding; one extra stop per off-centre midpoint for
 * sRGB without smoothness (exact: the midpoint makes each half linear); otherwise stops placed
 * adaptively until linear interpolation between them is within `tolerance` (0–1 per channel,
 * default half a level) of the true curve everywhere they were checked.
 */
export function expandVectorGradientStops(g: VectorGradient, options: { tolerance?: number } = {}): VectorGradientStop[] {
	const stops = sortedVectorGradientStops(g);
	const plain = () => stops.map(({ offset, color, opacity }) => (opacity !== undefined && opacity !== 1 ? { offset, color, opacity } : { offset, color }));
	if (!vectorGradientNeedsExpansion(g)) return plain();
	const ramp = vectorGradientRamp(g);
	if (!ramp || stops.length < 2) return plain();
	const tol = options.tolerance ?? 0.5 / 255;
	const sRgbOnly = (g.interpolation ?? 'srgb') === 'srgb' && !((g.smoothness ?? 0) > 0);
	const own = (s: VectorGradientStop): VectorRgba => {
		const c = parseVectorColor(s.color)!;
		return [c[0], c[1], c[2], c[3] * clamp(s.opacity ?? 1, 0, 1)];
	};
	const out: VectorGradientStop[] = [];
	const push = (offset: number, c: VectorRgba) => out.push(stopOf(offset, c));
	for (let i = 0; i < stops.length; i++) {
		const a = stops[i];
		const b = stops[i + 1];
		push(a.offset, own(a));
		if (!b || b.offset - a.offset < 1e-9) continue;
		const knots = [a.offset];
		if (hasMidpoint(a)) knots.push(a.offset + (b.offset - a.offset) * clamp(a.midpoint!, MID_MIN, MID_MAX));
		knots.push(b.offset);
		// Samples just inside the segment (the ramp at its ends is the neighbouring segment's).
		const inside = (t: number) => ramp.sample(clamp(t, a.offset + 1e-9, b.offset - 1e-9));
		for (let k = 0; k + 1 < knots.length; k++) {
			const t0 = knots[k];
			const t1 = knots[k + 1];
			if (k > 0) push(t0, inside(t0));
			if (sRgbOnly) continue;
			const refine = (x0: number, c0: VectorRgba, x1: number, c1: VectorRgba, depth: number) => {
				const xm = (x0 + x1) / 2;
				const cm = inside(xm);
				// Checked near the ends too: gamma curves bend hardest next to a black channel.
				const ok = depth >= 8 || [0.03, 0.1, 0.25, 0.5, 0.75, 0.9, 0.97].every((f) => maxDiff(inside(x0 + (x1 - x0) * f), lerpRgba(c0, c1, f)) <= tol);
				if (ok) return;
				refine(x0, c0, xm, cm, depth + 1);
				push(xm, cm);
				refine(xm, cm, x1, c1, depth + 1);
			};
			refine(t0, inside(t0), t1, inside(t1), 0);
		}
	}
	return out;
}

/** Linear interpolation between plain stops (what SVG draws from them), straight alpha. */
export function samplePlainStops(stops: readonly VectorGradientStop[], t: number): VectorRgba {
	const parsed = stops.map((s) => {
		const c = parseVectorColor(s.color) ?? [0, 0, 0, 1];
		return { t: s.offset, c: [c[0], c[1], c[2], c[3] * (s.opacity ?? 1)] as VectorRgba };
	});
	if (!parsed.length) return [0, 0, 0, 0];
	if (t <= parsed[0].t) return parsed[0].c;
	for (let i = 0; i + 1 < parsed.length; i++) {
		const a = parsed[i];
		const b = parsed[i + 1];
		if (t <= b.t) return b.t - a.t < 1e-12 ? b.c : lerpRgba(a.c, b.c, (t - a.t) / (b.t - a.t));
	}
	return parsed[parsed.length - 1].c;
}

/** The gradient with its stops reversed, each midpoint measured from the other side (vectorcraft `reverse`). */
export function reverseVectorGradient<T extends Pick<VectorGradient, 'stops'>>(g: T): T {
	const stops = sortedVectorGradientStops(g).reverse();
	const next = stops.map((s, i) => {
		const following = stops[i + 1];
		const mid = following ? 1 - (following.midpoint ?? 0.5) : 0.5;
		const { midpoint: _m, ...rest } = s;
		return { ...rest, offset: 1 - s.offset, ...(Math.abs(mid - 0.5) > 1e-6 ? { midpoint: mid } : {}) };
	});
	return { ...g, stops: next };
}

/** Stops with `stop` placed by offset (after any at the same offset); returns its index. */
function placeStop(stops: VectorGradientStop[], stop: VectorGradientStop): number {
	let i = stops.findIndex((o) => o.offset > stop.offset);
	if (i < 0) i = stops.length;
	stops.splice(i, 0, stop);
	return i;
}

/** A stop added at `offset` painting what the gradient paints there; returns the stops and its index. */
export function insertVectorGradientStop(g: VectorGradient, offset: number): { stops: VectorGradientStop[]; index: number } {
	const at = clamp(offset, 0, 1);
	const { color, opacity } = sampleVectorGradient(g, at);
	const stops = sortedVectorGradientStops(g);
	const index = placeStop(stops, opacity < 1 ? { offset: at, color, opacity } : { offset: at, color });
	return { stops, index };
}

/** Stop `index` moved to `offset` (re-sorted); returns the stops and its new index. */
export function moveVectorGradientStop(stops: readonly VectorGradientStop[], index: number, offset: number): { stops: VectorGradientStop[]; index: number } {
	const next = stops.map((s) => ({ ...s }));
	if (index < 0 || index >= next.length) return { stops: next, index };
	const [s] = next.splice(index, 1);
	return { stops: next, index: placeStop(next, { ...s, offset: clamp(offset, 0, 1) }) };
}

/** The stops without stop `index`, or null when that would leave fewer than two. */
export function removeVectorGradientStop(stops: readonly VectorGradientStop[], index: number): VectorGradientStop[] | null {
	if (stops.length <= VECTOR_GRADIENT_MIN_STOPS || index < 0 || index >= stops.length) return null;
	return stops.filter((_, i) => i !== index);
}

/** Where (0–1 along the gradient) the midpoint after stop `index` sits, or null for the last stop. */
export function vectorGradientMidpointPosition(stops: readonly VectorGradientStop[], index: number): number | null {
	const a = stops[index];
	const b = stops[index + 1];
	if (!a || !b) return null;
	return a.offset + (b.offset - a.offset) * (a.midpoint ?? 0.5);
}

/** The midpoint of stop `index` that puts it at position `pos` (clamped to 0.05–0.95), or null. */
export function vectorGradientMidpointFromPosition(stops: readonly VectorGradientStop[], index: number, pos: number): number | null {
	const a = stops[index];
	const b = stops[index + 1];
	if (!a || !b) return null;
	const span = Math.max(b.offset - a.offset, 1e-6);
	return clamp((pos - a.offset) / span, 0.05, 0.95);
}

/**
 * The part of the gradient from `from` to `to` (0–1, either order) as plain stops over 0–1
 * (vectorcraft `span`): the colours at both ends plus the expanded stops between them.
 */
export function spanVectorGradientStops(g: VectorGradient, from: number, to: number, expanded = expandVectorGradientStops(g)): VectorGradientStop[] {
	if (to < from) {
		const s = spanVectorGradientStops(g, to, from, expanded);
		return s.map((x) => ({ ...x, offset: 1 - x.offset })).reverse();
	}
	const d = to - from;
	const at = (offset: number, t: number) => stopOf(offset, samplePlainStops(expanded, t));
	const out = [at(0, from)];
	if (d > 1e-9) for (const s of expanded) if (s.offset > from && s.offset < to) out.push({ ...s, offset: (s.offset - from) / d });
	out.push(at(1, to));
	return out;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A gradient's frame points, in its units (see `VectorGradient`). */
export interface VectorGradientPoints {
	start: Vec2;
	end: Vec2;
	width: Vec2;
	focal: Vec2 | null;
	focalRadius: number;
	units: VectorGradientUnits;
}

/** Whether the gradient carries its own points (rather than the angle / centre shorthand). */
export const hasExplicitGradientGeometry = (g: VectorGradient) => finitePoint(g.start) && finitePoint(g.end);

/** The shorthand of a gradient as points in its bounding box. */
function shorthandPoints(g: VectorGradient): { start: Vec2; end: Vec2; width: Vec2 } {
	if (g.type === 'linear' || g.type === 'reflected') {
		const c = angleToSvgLinearCoords(Number.isFinite(g.angle) ? (g.angle as number) : 180);
		const start = g.type === 'linear' ? { x: c.x1, y: c.y1 } : { x: 0.5, y: 0.5 };
		const end = { x: c.x2, y: c.y2 };
		return { start, end, width: add(start, perp(sub(end, start))) };
	}
	const start = { x: Number.isFinite(g.cx) ? (g.cx as number) : 0.5, y: Number.isFinite(g.cy) ? (g.cy as number) : 0.5 };
	const r = Number.isFinite(g.r) ? (g.r as number) : 0.5;
	if (g.type === 'radial') return { start, end: { x: start.x + r, y: start.y }, width: { x: start.x, y: start.y + r } };
	const a = ((Number.isFinite(g.angle) ? (g.angle as number) : 90) * Math.PI) / 180;
	const dir = { x: Math.sin(a), y: -Math.cos(a) };
	return { start, end: add(start, scale(dir, r)), width: add(start, scale(perp(dir), r)) };
}

/** The gradient's frame points in its units, the shorthand resolved (it is always in the box). */
export function vectorGradientPoints(g: VectorGradient): VectorGradientPoints {
	const explicit = hasExplicitGradientGeometry(g);
	const base = explicit ? null : shorthandPoints(g);
	const start = explicit ? { x: g.start!.x, y: g.start!.y } : base!.start;
	const end = explicit ? { x: g.end!.x, y: g.end!.y } : base!.end;
	const width = explicit ? (finitePoint(g.width) ? { x: g.width.x, y: g.width.y } : add(start, perp(sub(end, start)))) : base!.width;
	return {
		start,
		end,
		width,
		focal: g.type === 'radial' && finitePoint(g.focal) ? { x: g.focal.x, y: g.focal.y } : null,
		focalRadius: g.type === 'radial' ? clamp(Number.isFinite(g.focalRadius) ? (g.focalRadius as number) : 0, 0, 0.99) : 0,
		units: explicit && g.units === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox'
	};
}

/**
 * The unit box → `bounds` matrix of `objectBoundingBox` gradients. A side with no extent (a
 * horizontal or vertical line) takes the other side's, centred, so the gradient still paints
 * (SVG paints nothing there).
 */
export function vectorBoxMatrix(bounds: VectorBounds | null | undefined): VectorMatrix {
	if (!bounds) return IDENTITY;
	let { x, y, width: w, height: h } = bounds;
	const fallback = Math.max(w, h, 1e-9) > 1e-9 ? Math.max(w, h) : 1;
	if (!(w > 1e-9)) {
		x -= fallback / 2 - w / 2;
		w = fallback;
	}
	if (!(h > 1e-9)) {
		y -= fallback / 2 - h / 2;
		h = fallback;
	}
	return [w, 0, 0, h, x, y];
}

/** The matrix of frame points: unit frame (u along start → end, v along start → width) → their space. */
const framePointsMatrix = (p: Pick<VectorGradientPoints, 'start' | 'end' | 'width'>): VectorMatrix => [p.end.x - p.start.x, p.end.y - p.start.y, p.width.x - p.start.x, p.width.y - p.start.y, p.start.x, p.start.y];

/** The gradient's units → node space (the box matrix for `objectBoundingBox`, else the identity). */
export function vectorGradientUnitsMatrix(g: VectorGradient, bounds: VectorBounds | null | undefined): VectorMatrix {
	return vectorGradientPoints(g).units === 'objectBoundingBox' ? vectorBoxMatrix(bounds) : IDENTITY;
}

/** The gradient's unit frame → node space: u = 1 at the end, v = 1 at the width point. */
export function vectorGradientMatrix(g: VectorGradient, bounds: VectorBounds | null | undefined): VectorMatrix {
	return mul(framePointsMatrix(vectorGradientPoints(g)), vectorGradientUnitsMatrix(g, bounds));
}

/** Most a focal point reaches towards the edge of the circle (vectorcraft `FOCAL_MAX`). */
const FOCAL_MAX = 0.99;

/** The focal point in the unit frame, pulled inside the circle (or null). */
function unitFocal(g: VectorGradient): { f: Vec2; fr: number } | null {
	const p = vectorGradientPoints(g);
	if (!p.focal && !(p.focalRadius > 0)) return null;
	const inv = invert(framePointsMatrix(p));
	if (!inv) return null;
	let f = p.focal ? apply(inv, p.focal) : { x: 0, y: 0 };
	const reach = FOCAL_MAX * (1 - p.focalRadius);
	const r = Math.hypot(f.x, f.y);
	if (r > reach) f = scale(f, reach / r);
	return { f, fr: p.focalRadius };
}

/**
 * t of a radial gradient at unit-frame point `q` with the focal circle centred on `f` with radius
 * `fr` and the end circle the unit circle (SVG's two-point conical gradient). With `fr = 0` this
 * is the focal ray: t is the distance from the focal point to `q` over the distance from it to
 * the circle along the same ray (effectcraft `GradientRamp::t`, vectorcraft `param_at`).
 */
export function vectorGradientFocalParam(q: Vec2, f: Vec2 = { x: 0, y: 0 }, fr = 0): number {
	const d = sub(q, f);
	const dr = 1 - fr;
	const a = dot(f, f) - dr * dr;
	const b = dot(d, f) - fr * dr;
	const c = dot(d, d) - fr * fr;
	if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? 0 : -c / (2 * b);
	return (-b - Math.sqrt(Math.max(0, b * b - a * c))) / a;
}

/**
 * The raw gradient parameter (before the spread) of a style at unit-frame point `q`: linear `u`,
 * reflected `|u|`, diamond `|u| + |v|`, conic the turn from the u axis towards the v axis (0–1),
 * radial the distance through the focal circle (photocraft `gradient_t`).
 */
export function vectorGradientParam(type: VectorGradientType, q: Vec2, focal?: { f: Vec2; fr: number } | null): number {
	switch (type) {
		case 'linear':
			return q.x;
		case 'reflected':
			return Math.abs(q.x);
		case 'diamond':
			return Math.abs(q.x) + Math.abs(q.y);
		case 'conic': {
			const turn = Math.atan2(q.y, q.x) / (2 * Math.PI);
			return turn - Math.floor(turn);
		}
		case 'radial':
			return focal ? vectorGradientFocalParam(q, focal.f, focal.fr) : Math.hypot(q.x, q.y);
	}
}

/** `t` folded into 0–1 by a spread mode. */
export function applyVectorGradientSpread(t: number, spread: VectorGradientSpread = 'pad'): number {
	if (!Number.isFinite(t)) return 0;
	if (spread === 'repeat') return t - Math.floor(t);
	if (spread === 'reflect') {
		const m = ((t % 2) + 2) % 2;
		return m <= 1 ? m : 2 - m;
	}
	return clamp(t, 0, 1);
}

/** The gradient's t (spread applied) at node-space point `p` of a shape with box `bounds`. */
export function vectorGradientTAt(g: VectorGradient, bounds: VectorBounds | null | undefined, p: Vec2): number {
	const inv = invert(vectorGradientMatrix(g, bounds));
	if (!inv) return 0;
	const raw = vectorGradientParam(g.type, apply(inv, p), g.type === 'radial' ? unitFocal(g) : null);
	return g.type === 'conic' ? raw : applyVectorGradientSpread(raw, g.spread ?? 'pad');
}

/** What the gradient paints at node-space point `p` (straight-alpha sRGB, 0–1). */
export function sampleVectorGradientAt(g: VectorGradient, bounds: VectorBounds | null | undefined, p: Vec2): VectorRgba {
	const t = vectorGradientTAt(g, bounds, p);
	const ramp = vectorGradientRamp(g);
	return ramp ? ramp.sample(t) : samplePlainStops(sortedVectorGradientStops(g), t);
}

/** The main axis length over the secondary's: |width − start| / |end − start| (signed by side). */
export function vectorGradientAspect(g: VectorGradient): number {
	const p = vectorGradientPoints(g);
	const u = sub(p.end, p.start);
	const l2 = dot(u, u);
	return l2 > 1e-18 ? dot(sub(p.width, p.start), perp(u)) / l2 : 1;
}

/** The gradient with explicit points (in its units) replacing the shorthand. */
export function explicitVectorGradient(g: VectorGradient): VectorGradient {
	const p = vectorGradientPoints(g);
	const { angle: _a, cx: _cx, cy: _cy, r: _r, ...rest } = g;
	return {
		...rest,
		start: p.start,
		end: p.end,
		width: p.width,
		...(p.focal ? { focal: p.focal } : {}),
		units: p.units
	};
}

/**
 * The gradient in the node's own space (`userSpaceOnUse`), painting what it paints on a shape
 * with box `bounds` (vectorcraft `GradientPaint::pin`): its points mapped through the box.
 */
export function pinVectorGradient(g: VectorGradient, bounds: VectorBounds | null | undefined): VectorGradient {
	const e = explicitVectorGradient(g);
	if (e.units === 'userSpaceOnUse') return e;
	const m = vectorBoxMatrix(bounds);
	return { ...e, start: apply(m, e.start!), end: apply(m, e.end!), width: apply(m, e.width!), ...(e.focal ? { focal: apply(m, e.focal) } : {}), units: 'userSpaceOnUse' };
}

/**
 * The gradient after the node's geometry is mapped by `m`: a `userSpaceOnUse` gradient's points
 * are mapped too (any affine map keeps every style's t, since t is measured in the frame the
 * three points span); a box gradient follows the box and is unchanged.
 */
export function transformVectorGradient(g: VectorGradient, m: VectorMatrix): VectorGradient {
	if (!hasExplicitGradientGeometry(g) || g.units !== 'userSpaceOnUse' || isIdentity(m)) return g;
	const p = vectorGradientPoints(g);
	return { ...g, start: apply(m, p.start), end: apply(m, p.end), width: apply(m, p.width), ...(p.focal ? { focal: apply(m, p.focal) } : {}) };
}

/**
 * A gradient after its node's geometry goes through a non-affine map `f` (Free Distort, an
 * envelope): handles in the node's own space (`userSpaceOnUse`) are mapped point by point, which
 * keeps the gradient's frame where the shape went; bounding-box gradients are left alone, as they
 * already follow the shape's new bounds.
 */
export function mapVectorGradient(g: VectorGradient, f: (p: Vec2) => Vec2): VectorGradient {
	if (!hasExplicitGradientGeometry(g) || g.units !== 'userSpaceOnUse') return g;
	const p = vectorGradientPoints(g);
	return { ...g, start: f(p.start), end: f(p.end), width: f(p.width), ...(p.focal ? { focal: f(p.focal) } : {}) };
}

/** A paint after its node's geometry goes through a non-affine map `f` (see `mapVectorGradient`). */
export function mapVectorPaint<T extends VectorPaint | undefined>(paint: T, f: (p: Vec2) => Vec2): T {
	return (isVectorGradient(paint) ? mapVectorGradient(paint, f) : paint) as T;
}

/** A paint after its node's geometry is mapped by `m` (colours unchanged). */
export function transformVectorPaint<T extends VectorPaint | undefined>(paint: T, m: VectorMatrix): T {
	return (isVectorGradient(paint) ? transformVectorGradient(paint, m) : paint) as T;
}

// ---------------------------------------------------------------------------
// Handles (on-canvas editing)
// ---------------------------------------------------------------------------

/**
 * An on-canvas handle of a gradient: `start` (a radial, conic or diamond gradient's centre),
 * `end` (a linear or reflected gradient's end), `radius` (the end of the others), `aspect` (the
 * secondary axis' end) and `focal` (radial).
 */
export type VectorGradientHandle = 'start' | 'end' | 'radius' | 'aspect' | 'focal';

/** Whether the style has a centre with a radius (rather than a start and an end). */
export const isCentredVectorGradient = (type: VectorGradientType) => type === 'radial' || type === 'conic' || type === 'diamond';

/** The handles of a gradient in the space `toWorld` maps the node's space to (the document, the screen). */
export function vectorGradientHandles(
	g: VectorGradient,
	bounds: VectorBounds | null | undefined,
	toWorld: VectorMatrix = IDENTITY
): { start: Vec2; end: Vec2; aspect: Vec2 | null; focal: Vec2 | null } {
	const p = vectorGradientPoints(g);
	const m = mul(vectorGradientUnitsMatrix(g, bounds), toWorld);
	const f = g.type === 'radial' ? unitFocal(g) : null;
	const frame = mul(framePointsMatrix(p), m);
	return {
		start: apply(m, p.start),
		end: apply(m, p.end),
		aspect: isCentredVectorGradient(g.type) ? apply(m, p.width) : null,
		focal: g.type === 'radial' ? apply(frame, f?.f ?? { x: 0, y: 0 }) : null
	};
}

/** Keeps the width point (and focal point) where they were relative to the main axis when it moves. */
function withMainAxis(p: VectorGradientPoints, start: Vec2, end: Vec2): Pick<VectorGradientPoints, 'start' | 'end' | 'width' | 'focal'> {
	const before = invert(framePointsMatrix(p));
	const u = sub(p.end, p.start);
	const l2 = dot(u, u);
	const w = sub(p.width, p.start);
	const rel = l2 > 1e-18 ? { a: dot(w, u) / l2, b: dot(w, perp(u)) / l2 } : { a: 0, b: 1 };
	const u2 = sub(end, start);
	const width = add(start, add(scale(u2, rel.a), scale(perp(u2), rel.b)));
	const next = { start, end, width };
	const focal = p.focal && before ? apply(framePointsMatrix(next), apply(before, p.focal)) : p.focal;
	return { ...next, focal };
}

/**
 * The gradient (pinned to the node's space) with a handle dragged to node-space point `to`.
 * `start` moves the whole gradient by `to − from`; `end` / `radius` move the end, the secondary
 * axis and focal point following; `aspect` sets the secondary axis' length square to the main
 * one; `focal` sets the focal point (pulled inside the circle; null centres it).
 */
export function moveVectorGradientHandle(
	g: VectorGradient,
	bounds: VectorBounds | null | undefined,
	handle: VectorGradientHandle,
	to: Vec2,
	from: Vec2 = to
): VectorGradient {
	const pinned = pinVectorGradient(g, bounds);
	const p = vectorGradientPoints(pinned);
	const set = (q: Partial<Pick<VectorGradient, 'start' | 'end' | 'width' | 'focal'>>) => {
		const next = { ...pinned, ...q };
		if (next.focal === null || next.focal === undefined) delete next.focal;
		return next;
	};
	switch (handle) {
		case 'start': {
			const d = sub(to, from);
			return set({ start: add(p.start, d), end: add(p.end, d), width: add(p.width, d), focal: p.focal ? add(p.focal, d) : null });
		}
		case 'end':
		case 'radius': {
			if (Math.hypot(to.x - p.start.x, to.y - p.start.y) < 1e-6) return pinned;
			const n = withMainAxis(p, p.start, to);
			return set({ end: n.end, width: n.width, focal: n.focal });
		}
		case 'aspect': {
			const u = sub(p.end, p.start);
			const l2 = dot(u, u);
			if (l2 < 1e-18) return pinned;
			let aspect = dot(sub(to, p.start), perp(u)) / l2;
			if (Math.abs(aspect) < 0.01) aspect = aspect < 0 ? -0.01 : 0.01;
			const before = invert(framePointsMatrix(p));
			const width = add(p.start, scale(perp(u), aspect));
			const focal = p.focal && before ? apply(framePointsMatrix({ start: p.start, end: p.end, width }), apply(before, p.focal)) : null;
			return set({ width, focal });
		}
		case 'focal': {
			const frame = framePointsMatrix(p);
			const inv = invert(frame);
			if (!inv) return pinned;
			let q = apply(inv, to);
			const r = Math.hypot(q.x, q.y);
			if (r < 1e-6) return set({ focal: null });
			const reach = FOCAL_MAX * (1 - p.focalRadius);
			if (r > reach) q = scale(q, reach / r);
			return set({ focal: apply(frame, q) });
		}
	}
}

/** The gradient set to run from `start` to `end` (node space), its secondary axis square to it with its aspect kept. */
export function setVectorGradientVector(g: VectorGradient, bounds: VectorBounds | null | undefined, start: Vec2, end: Vec2): VectorGradient {
	const pinned = pinVectorGradient(g, bounds);
	const p = vectorGradientPoints(pinned);
	const aspect = Math.abs(vectorGradientAspect(pinned)) > 1e-6 ? vectorGradientAspect(pinned) : 1;
	const u = sub(end, start);
	const width = add(start, scale(perp(u), aspect));
	const before = invert(framePointsMatrix(p));
	const focal = p.focal && before ? apply(framePointsMatrix({ start, end, width }), apply(before, p.focal)) : null;
	const next: VectorGradient = { ...pinned, start, end, width };
	if (focal) next.focal = focal;
	else delete next.focal;
	return next;
}

// ---------------------------------------------------------------------------
// Spread as stop periods
// ---------------------------------------------------------------------------

/** Most periods a spread is expanded to (vectorcraft `MAX_PERIODS`). */
export const VECTOR_GRADIENT_MAX_PERIODS = 64;

/** The stops of one period, from 0 to 1: the end colours held out to the ends (vectorcraft `whole_period`). */
function wholePeriod(stops: readonly VectorGradientStop[]): VectorGradientStop[] {
	const out = stops.map((s) => ({ ...s }));
	if (out.length && out[0].offset > 0) out.unshift({ ...out[0], offset: 0 });
	const last = out[out.length - 1];
	if (last && last.offset < 1) out.push({ ...last, offset: 1 });
	return out;
}

/**
 * Stops repeating the gradient's plain stops over periods `lo` … `hi` (integers, at most
 * `VECTOR_GRADIENT_MAX_PERIODS`), period `k` mirrored when `mirrored(k)`; offsets over 0–1 span
 * the whole range (vectorcraft `spread::expand`, which emulates `reflect` and `repeat` this way).
 */
export function periodicVectorGradientStops(stops: readonly VectorGradientStop[], lo: number, hi: number, mirrored: (k: number) => boolean): VectorGradientStop[] {
	const period = wholePeriod(stops);
	const back = reverseVectorGradient({ stops: period }).stops;
	const n = Math.max(1, hi - lo);
	const out: VectorGradientStop[] = [];
	for (let j = 0; j < n; j++) {
		const one = mirrored(lo + j) ? back : period;
		for (const s of one) out.push({ ...s, offset: (j + s.offset) / n });
	}
	return out;
}

/**
 * A linear or reflected gradient's spread as stop periods over `area` (node space), for
 * renderers (and combinations) without the spread mode: vectorcraft's SVG import emulates
 * `reflect` and `repeat` this way. Returns where the periods start and end and their stops, or
 * null when a linear gradient pads (nothing to repeat). Reflected gradients always get at least
 * the period either side of the start (the one before it mirrored). `from` / `to` are the
 * periods' ends along the frame's u axis (`matrix` maps the frame to node space).
 */
export function expandVectorGradientSpread(
	g: VectorGradient,
	bounds: VectorBounds | null | undefined,
	area: VectorBounds
): { start: Vec2; end: Vec2; from: number; to: number; matrix: VectorMatrix; stops: VectorGradientStop[]; capped: boolean } | null {
	const m = vectorGradientMatrix(g, bounds);
	const inv = invert(m);
	const spread = g.spread ?? 'pad';
	const reflected = g.type === 'reflected';
	if (!inv || (!reflected && spread === 'pad')) return null;
	const odd = (k: number) => ((k % 2) + 2) % 2 === 1;
	const stops = expandVectorGradientStops(g);
	const along = (a: number, b: number, mirrored: (k: number) => boolean, capped = false) => ({
		start: apply(m, { x: a, y: 0 }),
		end: apply(m, { x: b, y: 0 }),
		from: a,
		to: b,
		matrix: m,
		stops: periodicVectorGradientStops(stops, a, b, mirrored),
		capped
	});
	if (reflected && spread === 'pad') return along(-1, 1, (k) => k < 0);
	const us = boxCorners(area).map((c) => apply(inv, c).x);
	let lo = Math.floor(Math.min(...us));
	let hi = Math.ceil(Math.max(...us));
	if (reflected) {
		lo = Math.min(lo, -1);
		hi = Math.max(hi, 1);
	}
	hi = Math.max(hi, lo + 1);
	if (!reflected && lo >= 0 && hi <= 1) return null;
	const capped = hi - lo > VECTOR_GRADIENT_MAX_PERIODS;
	if (capped) {
		lo = Math.max(lo, -VECTOR_GRADIENT_MAX_PERIODS / 2);
		hi = lo + VECTOR_GRADIENT_MAX_PERIODS;
	}
	// Period k covers u in [k, k + 1]. A reflected gradient runs |u|: before the start, periods run backwards.
	const mirrored = reflected
		? (k: number) => {
				const j = k >= 0 ? k : -k - 1;
				const own = spread === 'reflect' && odd(j);
				return k < 0 ? !own : own;
			}
		: (k: number) => spread === 'reflect' && odd(k);
	return along(lo, hi, mirrored, capped);
}

const boxCorners = (b: VectorBounds): Vec2[] => [
	{ x: b.x, y: b.y },
	{ x: b.x + b.width, y: b.y },
	{ x: b.x + b.width, y: b.y + b.height },
	{ x: b.x, y: b.y + b.height }
];

// ---------------------------------------------------------------------------
// SVG paint servers
// ---------------------------------------------------------------------------

/**
 * A `<pattern>` paint server in user space: draw `gradients` (inside it or in `<defs>`) and then
 * each tile (`d` filled with `fill`) in order, all in the painted element's user space (the
 * `viewBox` in `attrs` matches the tile, so keep it). Conic and diamond gradients, and gradients along
 * or across a stroke, take this form.
 */
export interface VectorSvgPatternDef {
	id: string;
	type: 'pattern';
	/** `x`, `y`, `width`, `height`, `patternUnits="userSpaceOnUse"` and the matching `viewBox`. */
	attrs: Record<string, string | number>;
	gradients: SvgGradientDef[];
	tiles: { d: string; fill: string }[];
}

/** A paint server for `fill` / `stroke`: a gradient element or a pattern of gradient tiles. */
export type VectorPaintDef = SvgGradientDef | VectorSvgPatternDef;

export interface VectorGradientSvgOptions {
	/** The shape's box in its own space (for `objectBoundingBox` gradients). */
	bounds?: VectorBounds | null;
	/** The area the paint must cover (pattern tiles, spread periods); default `bounds` padded by 1. */
	area?: VectorBounds | null;
	/** Wedges of a conic gradient (default 72: 5° each). */
	wedges?: number;
	precision?: number;
}

const toSvgStops = (stops: readonly VectorGradientStop[]): SvgGradientStop[] =>
	stops.map((s) => ({ offset: `${fmt(s.offset * 100, 3)}%`, stopColor: s.color, ...(s.opacity !== undefined && s.opacity !== 1 ? { stopOpacity: Math.round(s.opacity * 1e4) / 1e4 } : {}) }));

const polygonD = (pts: readonly Vec2[], precision: number) => `M${pts.map((p) => `${fmt(p.x, precision)} ${fmt(p.y, precision)}`).join('L')}Z`;

const padBounds = (b: VectorBounds, pad: number): VectorBounds => ({ x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad });

/** The area a gradient on a shape with box `bounds` paints (the box padded by 1). */
export const vectorGradientArea = (bounds: VectorBounds | null | undefined): VectorBounds => padBounds(bounds ?? { x: 0, y: 0, width: 1, height: 1 }, 1);

/** The `gradientTransform` attribute of matrix `m` (none for the identity). */
const transformAttr = (m: VectorMatrix): Record<string, string> => (isIdentity(m) ? {} : { gradientTransform: fmtMatrix(m) });

/** Smallest stretch of a matrix (the least singular value). */
function minScale(m: VectorMatrix): number {
	const [a, b, c, d] = m;
	const p = a * a + b * b;
	const q = c * c + d * d;
	const r = a * c + b * d;
	return Math.sqrt(Math.max(0, (p + q - Math.sqrt((p - q) ** 2 + 4 * r * r)) / 2));
}

/**
 * A user-space pattern tile over `area`. Without a `viewBox` SVG puts the content's origin at the
 * tile's corner; the matching `viewBox` keeps the content in the painted element's user space.
 */
export function patternAttrs(area: VectorBounds): Record<string, string> {
	const [x, y, w, h] = [area.x, area.y, Math.max(area.width, 1e-3), Math.max(area.height, 1e-3)].map((n) => fmt(n, 3));
	return { patternUnits: 'userSpaceOnUse', x, y, width: w, height: h, viewBox: `${x} ${y} ${w} ${h}` };
}

/** A pattern def over `area` with the given tiles. */
function patternDef(id: string, area: VectorBounds, gradients: SvgGradientDef[], tiles: { d: string; fill: string }[]): VectorSvgPatternDef {
	return {
		id,
		type: 'pattern',
		attrs: patternAttrs(area),
		gradients,
		tiles
	};
}

/**
 * The SVG paint servers of a gradient on a shape: the first def's id is `id` (reference it as
 * `url(#id)`), any others are what it uses. All are in the user space of the element painted
 * (the node's own space).
 */
export function vectorGradientSvgDefs(g: VectorGradient, id: string, options: VectorGradientSvgOptions = {}): VectorPaintDef[] {
	const precision = options.precision ?? 3;
	const bounds = options.bounds ?? null;
	const area = options.area ?? vectorGradientArea(bounds);
	const spread = g.spread && VECTOR_GRADIENT_SPREADS.includes(g.spread) ? g.spread : 'pad';
	const stops = expandVectorGradientStops(g);
	const p = vectorGradientPoints(g);
	const unitsM = vectorGradientUnitsMatrix(g, bounds);
	const frameM = mul(framePointsMatrix(p), unitsM);
	const spreadAttr = (s: VectorGradientSpread): Record<string, string> => (s === 'pad' ? {} : { spreadMethod: s });
	const base = { gradientUnits: 'userSpaceOnUse' };

	switch (g.type) {
		case 'linear':
		case 'reflected': {
			if (g.type === 'reflected' && spread !== 'reflect') {
				// Pad: mirrored stops over [2·start − end, end]; repeat: periods over the area, the ones before the start mirrored.
				const ex = expandVectorGradientSpread(g, bounds, area);
				const [a, b] = ex ? [ex.from, ex.to] : [-1, 1];
				const st = ex?.stops ?? periodicVectorGradientStops(stops, -1, 1, (k) => k < 0);
				return [{ id, type: 'linear', attrs: { ...base, x1: a, y1: 0, x2: b, y2: 0, gradientTransform: fmtMatrix(frameM) }, stops: toSvgStops(st) }];
			}
			const u = sub(p.end, p.start);
			const w = sub(p.width, p.start);
			const square = Math.abs(dot(u, w)) <= 1e-9 * Math.max(dot(u, u), dot(w, w), 1e-18);
			// A skewed frame (a userSpaceOnUse gradient sheared with its shape) needs the frame as the transform.
			const coords: Record<string, string | number> = square ? { x1: fmt(p.start.x, 6), y1: fmt(p.start.y, 6), x2: fmt(p.end.x, 6), y2: fmt(p.end.y, 6), ...transformAttr(unitsM) } : { x1: 0, y1: 0, x2: 1, y2: 0, gradientTransform: fmtMatrix(frameM) };
			return [{ id, type: 'linear', attrs: { ...base, ...coords, ...spreadAttr(spread) }, stops: toSvgStops(stops) }];
		}
		case 'radial': {
			const f = unitFocal(g);
			const attrs: Record<string, string | number> = { ...base, cx: 0, cy: 0, r: 1, gradientTransform: fmtMatrix(frameM), ...spreadAttr(spread) };
			if (f && (Math.abs(f.f.x) > 1e-9 || Math.abs(f.f.y) > 1e-9)) {
				attrs.fx = fmt(f.f.x, 6);
				attrs.fy = fmt(f.f.y, 6);
			}
			if (f && f.fr > 0) attrs.fr = fmt(f.fr, 6);
			return [{ id, type: 'radial', attrs, stops: toSvgStops(stops) }];
		}
		case 'diamond': {
			const inv = invert(frameM);
			if (!inv) return [patternDef(id, area, [], [{ d: polygonD(boxCorners(area), precision), fill: stops[stops.length - 1]?.color ?? 'none' }])];
			const reach = 2 * Math.max(...boxCorners(area).map((c) => {
				const q = apply(inv, c);
				return Math.abs(q.x) + Math.abs(q.y);
			})) + 1;
			// Each quadrant overlaps its neighbours by about 0.75 units, hiding anti-aliasing seams.
			const delta = Math.min(0.05 * reach, 0.75 / Math.max(minScale(frameM), 1e-9));
			const gradients: SvgGradientDef[] = [];
			const tiles: { d: string; fill: string }[] = [];
			[[1, 1], [-1, 1], [-1, -1], [1, -1]].forEach(([sx, sy], k) => {
				const gid = `${id}-q${k}`;
				gradients.push({ id: gid, type: 'linear', attrs: { ...base, x1: 0, y1: 0, x2: sx / 2, y2: sy / 2, gradientTransform: fmtMatrix(frameM), ...spreadAttr(spread) }, stops: toSvgStops(stops) });
				const quad = [{ x: -delta * sx, y: -delta * sy }, { x: reach * sx, y: -delta * sy }, { x: -delta * sx, y: reach * sy }].map((q) => apply(frameM, q));
				tiles.push({ d: polygonD(quad, precision), fill: `url(#${gid})` });
			});
			return [patternDef(id, area, gradients, tiles)];
		}
		case 'conic':
			return [conicPattern(id, frameM, stops, area, options.wedges ?? 72, precision)];
	}
}

/**
 * A conic gradient as thin wedges round the centre, each with a linear gradient across it
 * (along the tangent at its middle angle, exact on the unit circle of the frame: elsewhere a
 * point takes a colour from within its wedge). Stops inside a wedge keep sharp transitions.
 */
function conicPattern(id: string, frameM: VectorMatrix, stops: readonly VectorGradientStop[], area: VectorBounds, wedges: number, precision: number): VectorSvgPatternDef {
	const inv = invert(frameM);
	const n = Math.max(8, Math.min(720, Math.round(wedges)));
	const half = Math.PI / n;
	if (!inv || !stops.length) return patternDef(id, area, [], [{ d: polygonD(boxCorners(area), precision), fill: stops[0]?.color ?? 'none' }]);
	const reach = (Math.max(...boxCorners(area).map((c) => Math.hypot(apply(inv, c).x, apply(inv, c).y))) + 1) / Math.cos(half);
	const overlap = Math.min(half, 0.002);
	const gradients: SvgGradientDef[] = [];
	const tiles: { d: string; fill: string }[] = [];
	for (let k = 0; k < n; k++) {
		const a0 = (2 * Math.PI * k) / n;
		const a1 = (2 * Math.PI * (k + 1)) / n;
		const mid = (a0 + a1) / 2;
		const tau = { x: -Math.sin(mid), y: Math.cos(mid) };
		const s = Math.sin(half);
		const at = (angle: number) => (Math.sin(angle - mid) / s + 1) / 2;
		const t0 = k / n;
		const t1 = (k + 1) / n;
		const own: VectorGradientStop[] = [stopOf(0, samplePlainStops(stops, t0))];
		for (const st of stops) if (st.offset > t0 && st.offset < t1) own.push({ ...st, offset: at(st.offset * 2 * Math.PI) });
		own.push(stopOf(1, samplePlainStops(stops, t1)));
		const gid = `${id}-w${k}`;
		gradients.push({
			id: gid,
			type: 'linear',
			attrs: { gradientUnits: 'userSpaceOnUse', x1: fmt(-s * tau.x, 6), y1: fmt(-s * tau.y, 6), x2: fmt(s * tau.x, 6), y2: fmt(s * tau.y, 6), gradientTransform: fmtMatrix(frameM) },
			stops: toSvgStops(own)
		});
		const from = a0 - (k === 0 ? 0 : overlap);
		const pts = [{ x: 0, y: 0 }, { x: reach * Math.cos(from), y: reach * Math.sin(from) }, { x: reach * Math.cos(a1), y: reach * Math.sin(a1) }].map((q) => apply(frameM, q));
		tiles.push({ d: polygonD(pts, precision), fill: `url(#${gid})` });
	}
	return patternDef(id, area, gradients, tiles);
}

// ---------------------------------------------------------------------------
// Evaluating paint servers (tests, previews)
// ---------------------------------------------------------------------------

const num = (v: string | number | undefined, fallback = 0) => {
	if (v === undefined) return fallback;
	const n = typeof v === 'number' ? v : parseFloat(v);
	return Number.isFinite(n) ? n : fallback;
};

const parseMatrixAttr = (v: string | number | undefined): VectorMatrix => {
	const m = typeof v === 'string' ? /^matrix\(([^)]*)\)$/.exec(v.trim()) : null;
	if (!m) return IDENTITY;
	const n = m[1].split(/[\s,]+/).map(Number);
	return n.length === 6 && n.every(Number.isFinite) ? (n as unknown as VectorMatrix) : IDENTITY;
};

const plainOf = (stops: readonly SvgGradientStop[]): VectorGradientStop[] =>
	stops.map((s) => ({ offset: parseFloat(s.offset) / (s.offset.endsWith('%') ? 100 : 1), color: s.stopColor, ...(s.stopOpacity !== undefined ? { opacity: s.stopOpacity } : {}) }));

/** Point `p` inside a polygon tile (`M x y L … Z`), even-odd. */
function inTile(d: string, p: Vec2): boolean {
	const n = d.match(/-?[\d.]+(?:e-?\d+)?/gi)?.map(Number) ?? [];
	let inside = false;
	for (let i = 0, j = n.length - 2; i + 1 < n.length; j = i, i += 2) {
		const [xi, yi, xj, yj] = [n[i], n[i + 1], n[j], n[j + 1]];
		if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/**
 * What a `userSpaceOnUse` paint server from `vectorGradientSvgDefs` paints at point `p` (straight
 * alpha, 0–1) the way an SVG renderer would: a gradient's stops interpolated in sRGB, a pattern's
 * topmost tile containing `p`. Null for a point no tile covers.
 */
export function sampleVectorPaintDefAt(defs: readonly VectorPaintDef[], id: string, p: Vec2): VectorRgba | null {
	const all = new Map<string, VectorPaintDef>();
	for (const d of defs) {
		all.set(d.id, d);
		if (d.type === 'pattern') for (const gd of d.gradients) all.set(gd.id, gd);
	}
	const paint = (ref: string, q: Vec2): VectorRgba | null => {
		const url = /^url\(#(.+)\)$/.exec(ref);
		if (!url) return parseVectorColor(ref);
		const def = all.get(url[1]);
		if (!def) return null;
		if (def.type === 'pattern') {
			for (let i = def.tiles.length - 1; i >= 0; i--) if (inTile(def.tiles[i].d, q)) return paint(def.tiles[i].fill, q);
			return null;
		}
		const inv = invert(parseMatrixAttr(def.attrs.gradientTransform)) ?? IDENTITY;
		const local = apply(inv, q);
		const spread = (def.attrs.spreadMethod as VectorGradientSpread | undefined) ?? 'pad';
		let t: number;
		if (def.type === 'radial') {
			const r = num(def.attrs.r, 0.5);
			const c = { x: num(def.attrs.cx), y: num(def.attrs.cy) };
			const f = { x: num(def.attrs.fx, c.x), y: num(def.attrs.fy, c.y) };
			const u = { x: (local.x - c.x) / r, y: (local.y - c.y) / r };
			t = vectorGradientFocalParam(u, { x: (f.x - c.x) / r, y: (f.y - c.y) / r }, num(def.attrs.fr) / r);
		} else {
			const a = { x: num(def.attrs.x1), y: num(def.attrs.y1) };
			const b = { x: num(def.attrs.x2, 1), y: num(def.attrs.y2) };
			const v = sub(b, a);
			const l2 = dot(v, v);
			t = l2 > 1e-18 ? dot(sub(local, a), v) / l2 : 0;
		}
		return samplePlainStops(plainOf(def.stops), applyVectorGradientSpread(t, spread));
	};
	return paint(`url(#${id})`, p);
}

// ---------------------------------------------------------------------------
// Sanitizing (agents, import)
// ---------------------------------------------------------------------------

const readPoint = (v: unknown): Vec2 | undefined => (finitePoint(v) ? { x: v.x, y: v.y } : undefined);

/**
 * A gradient from untrusted input (agent commands, SVG data attributes), or null when it is not
 * one: unknown fields dropped, numbers clamped, at least one stop.
 */
export function sanitizeVectorGradient(input: unknown): VectorGradient | null {
	if (!input || typeof input !== 'object') return null;
	const r = input as Record<string, unknown>;
	if (!VECTOR_GRADIENT_TYPES.includes(r.type as VectorGradientType) || !Array.isArray(r.stops)) return null;
	const stops: VectorGradientStop[] = [];
	for (const s of r.stops as unknown[]) {
		if (!s || typeof s !== 'object') continue;
		const x = s as Record<string, unknown>;
		if (typeof x.color !== 'string' || typeof x.offset !== 'number' || !Number.isFinite(x.offset)) continue;
		const stop: VectorGradientStop = { offset: clamp(x.offset, 0, 1), color: x.color.slice(0, 100) };
		if (typeof x.opacity === 'number' && Number.isFinite(x.opacity) && x.opacity !== 1) stop.opacity = clamp(x.opacity, 0, 1);
		if (typeof x.midpoint === 'number' && Number.isFinite(x.midpoint) && Math.abs(x.midpoint - 0.5) > 1e-6) stop.midpoint = clamp(x.midpoint, 0.05, 0.95);
		stops.push(stop);
	}
	if (!stops.length) return null;
	const g: VectorGradient = { type: r.type as VectorGradientType, stops };
	for (const k of ['angle', 'cx', 'cy', 'r'] as const) if (typeof r[k] === 'number' && Number.isFinite(r[k])) g[k] = r[k] as number;
	const start = readPoint(r.start);
	const end = readPoint(r.end);
	if (start && end) {
		g.start = start;
		g.end = end;
		const width = readPoint(r.width);
		if (width) g.width = width;
		if (r.units === 'userSpaceOnUse' || r.units === 'objectBoundingBox') g.units = r.units;
	}
	const focal = readPoint(r.focal);
	if (focal && g.type === 'radial') g.focal = focal;
	if (typeof r.focalRadius === 'number' && r.focalRadius > 0 && g.type === 'radial') g.focalRadius = clamp(r.focalRadius, 0, 0.99);
	if (VECTOR_GRADIENT_SPREADS.includes(r.spread as VectorGradientSpread) && r.spread !== 'pad') g.spread = r.spread as VectorGradientSpread;
	if (VECTOR_GRADIENT_INTERPOLATIONS.includes(r.interpolation as VectorGradientInterpolation) && r.interpolation !== 'srgb') g.interpolation = r.interpolation as VectorGradientInterpolation;
	if (typeof r.smoothness === 'number' && r.smoothness > 0) g.smoothness = clamp(r.smoothness, 0, 1);
	if (VECTOR_STROKE_GRADIENT_MODES.includes(r.strokeMode as never) && r.strokeMode !== 'within') g.strokeMode = r.strokeMode as VectorGradient['strokeMode'];
	return g;
}

/**
 * A gradient changed to style `type`, keeping its stops, colour settings and placement: explicit
 * points stay where they are (a linear end becomes a radius), shorthand is redone for the style.
 */
export function convertVectorGradient(g: VectorGradient, type: VectorGradientType): VectorGradient {
	if (g.type === type) return g;
	const next: VectorGradient = { ...g, type };
	if (type !== 'radial') {
		delete next.focal;
		delete next.focalRadius;
	}
	if (!hasExplicitGradientGeometry(g)) {
		// Shorthand fields mean different things per style: drop the ones the new style reads differently.
		if (isCentredVectorGradient(type) !== isCentredVectorGradient(g.type)) {
			delete next.angle;
			delete next.cx;
			delete next.cy;
			delete next.r;
		}
	}
	return next;
}

/** A default gradient for a paint that was a colour (or nothing): the colour fading to white. */
export function defaultVectorGradient(type: VectorGradientType = 'linear', from?: VectorPaint): VectorGradient {
	if (isVectorGradient(from)) return convertVectorGradient(from, type);
	const colour = typeof from === 'string' && parseVectorColor(from) ? from : '#000000';
	return { type, stops: [{ offset: 0, color: colour }, { offset: 1, color: '#ffffff' }] };
}

/**
 * Changes to a gradient (`vector.setGradient`, the gradient editor): any gradient field, plus
 * `aspect` (the secondary axis' length over the main one, square to it) and `reverse`. `focal` or
 * `width` set to null removes them.
 */
export interface VectorGradientPatch extends Partial<Omit<VectorGradient, 'focal' | 'width'>> {
	focal?: Vec2 | null;
	width?: Vec2 | null;
	aspect?: number;
	reverse?: boolean;
}

/** `g` with `patch` applied (a style change converts it first), or null when the result is not a gradient. */
export function applyVectorGradientPatch(g: VectorGradient, patch: VectorGradientPatch): VectorGradient | null {
	const { aspect, reverse, type, ...fields } = patch;
	let next: VectorGradient = type && type !== g.type ? convertVectorGradient(g, type) : { ...g };
	const record = next as unknown as Record<string, unknown>;
	for (const [k, v] of Object.entries(fields)) {
		if (v === undefined) continue;
		if (v === null) delete record[k];
		else record[k] = v;
	}
	// Explicit points replace the shorthand (and the other way round).
	if ((fields.start || fields.end) && !hasExplicitGradientGeometry(next)) {
		const p = vectorGradientPoints({ ...g, start: undefined, end: undefined });
		next.start = next.start ?? p.start;
		next.end = next.end ?? p.end;
	}
	if (aspect !== undefined && Number.isFinite(aspect)) {
		const e = explicitVectorGradient(next);
		const u = sub(e.end!, e.start!);
		const a = Math.abs(aspect) < 0.01 ? (aspect < 0 ? -0.01 : 0.01) : aspect;
		next = { ...e, width: add(e.start!, scale(perp(u), a)) };
	}
	if (reverse) next = reverseVectorGradient(next);
	const clean = sanitizeVectorGradient(next);
	if (!clean) return null;
	clean.stops = sortedVectorGradientStops(clean);
	return clean;
}
