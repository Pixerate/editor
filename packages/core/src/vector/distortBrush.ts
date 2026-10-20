/**
 * Distortion brushes, after CorelDRAW's Smudge, Twirl, Attract, Repel and Roughen tools (concept
 * only): a round brush that bends the outlines under it. Each dab is a point map with a smooth
 * falloff (full strength at the centre, none at the rim); a stroke's dabs are composed into one
 * map applied to the paths as they were when the stroke began, so dragging back and forth does
 * not pile up anchors. Smooth maps re-fit the curves (`mapBezierPath`); Roughen breaks the parts
 * of the outline under the brush into short straight segments and pushes their points in and out.
 */
import { pathToContours, closeContour, flattenChain, contoursToPath, bezierPathBounds, type BezierPath, type BezierSegment } from '../canvas/pathops/bezier.js';
import type { Point } from '../canvas/types.js';
import { mapBezierPath } from './pathMap.js';
import type { Vec2 } from './types.js';

export type VectorDistortBrushMode = 'smudge' | 'twirl' | 'attract' | 'repel' | 'roughen';
export const VECTOR_DISTORT_BRUSH_MODES: readonly VectorDistortBrushMode[] = ['smudge', 'twirl', 'attract', 'repel', 'roughen'];

/** One dab of a distortion brush (document units). */
export interface VectorDistortDab {
	x: number;
	y: number;
	/** Brush radius. */
	radius: number;
	/** 0–1. */
	strength: number;
	/** Smudge: how far the brush moved since the last dab. */
	dx?: number;
	dy?: number;
	/** Twirl: degrees turned at full strength per dab (positive clockwise on screen, default 15). */
	angle?: number;
	/** Roughen: seed of the spikes (default 1). */
	seed?: number;
}

/** The brush's weight at distance `d` from its centre: 1 at the centre, 0 at and beyond `r`, smooth. */
export function vectorDistortFalloff(d: number, r: number): number {
	if (!(r > 0) || d >= r) return 0;
	const u = d / r;
	const k = 1 - u * u;
	return k * k;
}

/** The point map of one smooth dab (smudge, twirl, attract, repel). */
export function vectorDistortDabMap(mode: Exclude<VectorDistortBrushMode, 'roughen'>, dab: VectorDistortDab): (p: Vec2) => Vec2 {
	const s = Math.min(1, Math.max(0, dab.strength));
	return (p) => {
		const dx = p.x - dab.x;
		const dy = p.y - dab.y;
		const f = vectorDistortFalloff(Math.hypot(dx, dy), dab.radius) * s;
		if (f <= 0) return p;
		switch (mode) {
			case 'smudge':
				return { x: p.x + (dab.dx ?? 0) * f, y: p.y + (dab.dy ?? 0) * f };
			case 'twirl': {
				const a = (((dab.angle ?? 15) * Math.PI) / 180) * f;
				const c = Math.cos(a);
				const sn = Math.sin(a);
				return { x: dab.x + dx * c - dy * sn, y: dab.y + dx * sn + dy * c };
			}
			case 'attract':
				return { x: p.x - dx * f * 0.5, y: p.y - dy * f * 0.5 };
			case 'repel':
				return { x: p.x + dx * f * 0.5, y: p.y + dy * f * 0.5 };
		}
	};
}

/** A deterministic hash of a point to −1…1. */
function noise(x: number, y: number, seed: number): number {
	let h = Math.imul(Math.round(x * 16) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(y * 16) ^ 0xc2b2ae35, 0x27d4eb2f) ^ Math.imul(seed | 0, 0x165667b1);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12;
	return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** Whether a dab can reach a path's bounds. */
const reaches = (b: { minX: number; minY: number; maxX: number; maxY: number }, dab: VectorDistortDab) => dab.x + dab.radius >= b.minX && dab.x - dab.radius <= b.maxX && dab.y + dab.radius >= b.minY && dab.y - dab.radius <= b.maxY;

/** Roughen: the contours the dabs reach broken into short segments, their points pushed in and out under the brush. */
function roughen(path: BezierPath, dabs: readonly VectorDistortDab[]): BezierPath {
	const step = Math.max(0.5, Math.min(...dabs.map((d) => d.radius)) / 6);
	const contours = pathToContours(path).map((c) => {
		const b = bezierPathBounds(contoursToPath([c]));
		if (!b || !dabs.some((d) => reaches(b, d))) return c;
		// Resample the contour into points about `step` apart.
		const ring = flattenChain(closeContour(c, c.closed), Math.min(0.25, step / 8));
		const pts: Point[] = [];
		for (let i = 0; i < ring.length; i++) {
			const a = ring[i];
			const nxt = ring[i + 1] ?? (c.closed ? ring[0] : null);
			pts.push(a);
			if (!nxt) continue;
			const n = Math.floor(Math.hypot(nxt[0] - a[0], nxt[1] - a[1]) / step);
			for (let k = 1; k < n; k++) pts.push([a[0] + ((nxt[0] - a[0]) * k) / n, a[1] + ((nxt[1] - a[1]) * k) / n]);
		}
		// Push each point along its normal by a spike under the brush.
		const out = pts.map((p, i) => {
			const prev = pts[i - 1] ?? (c.closed ? pts[pts.length - 1] : p);
			const next = pts[i + 1] ?? (c.closed ? pts[0] : p);
			const tx = next[0] - prev[0];
			const ty = next[1] - prev[1];
			const tl = Math.hypot(tx, ty) || 1;
			let off = 0;
			for (const dab of dabs) {
				const f = vectorDistortFalloff(Math.hypot(p[0] - dab.x, p[1] - dab.y), dab.radius) * Math.min(1, Math.max(0, dab.strength));
				if (f > 0) off += noise(p[0], p[1], dab.seed ?? 1) * f * dab.radius * 0.25 * (i % 2 ? 1 : -1);
			}
			return [p[0] - (ty / tl) * off, p[1] + (tx / tl) * off] as Point;
		});
		const segments: BezierSegment[] = [];
		for (let i = 0; i + 1 < out.length; i++) segments.push([out[i], out[i + 1]]);
		if (c.closed && out.length > 1) segments.push([out[out.length - 1], out[0]]);
		return { segments, closed: c.closed };
	});
	return contoursToPath(contours);
}

/**
 * A path distorted by a stroke of dabs (document space). Smooth modes compose the dabs into one
 * point map and re-fit the curves; roughen breaks what the brush reaches into spikes. Paths the
 * stroke never reaches come back unchanged (the same object).
 */
export function distortVectorPath(path: BezierPath, mode: VectorDistortBrushMode, dabs: readonly VectorDistortDab[]): BezierPath {
	const b0 = bezierPathBounds(path);
	const live = dabs.filter((d) => d.radius > 0 && d.strength > 0);
	if (!b0 || !live.length) return path;
	if (mode === 'roughen') {
		const reaching = live.filter((d) => reaches(b0, d));
		return reaching.length ? roughen(path, reaching) : path;
	}
	// Earlier dabs move points (a smudge drags them along): later dabs may reach that far out.
	let grow = 0;
	const reaching: VectorDistortDab[] = [];
	for (const d of live) {
		const b = { minX: b0.minX - grow, minY: b0.minY - grow, maxX: b0.maxX + grow, maxY: b0.maxY + grow };
		if (reaches(b, d)) {
			reaching.push(d);
			grow += Math.hypot(d.dx ?? 0, d.dy ?? 0) + d.radius * 0.5;
		}
	}
	if (!reaching.length) return path;
	const maps = reaching.map((d) => vectorDistortDabMap(mode, d));
	return mapBezierPath(path, (p) => maps.reduce((q, m) => m(q), p), 0.05);
}
