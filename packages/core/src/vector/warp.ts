/**
 * Warp geometry for envelope distortion: preset warp styles and editable Bézier meshes, both
 * forward maps from a source box (the bounds of the paths an envelope bends) to the node's space.
 * The maths is shared with the image editor's Free Transform and lives in `src/geom/warp.ts`;
 * these are its vector-named exports, plus the envelope-from-outline helpers.
 *
 * The Coons patch of `vectorMeshFromOutline` is our own.
 */
import {
	clampMeshCount,
	evenKnots,
	fitWarpMesh,
	lerpVec2,
	warpMeshColumns,
	warpMeshRows
} from '../geom/warp.js';
import type { Vec2, VectorSubpath, VectorWarpMesh } from './types.js';

export {
	WARP_STYLES as VECTOR_WARP_STYLES,
	WARP_STYLE_LABELS as VECTOR_WARP_STYLE_LABELS,
	warpPresetGrid as vectorWarpPresetGrid,
	warpPresetMesh as vectorWarpPresetMesh,
	warpMeshColumns as vectorMeshColumns,
	warpMeshRows as vectorMeshRows,
	isValidWarpMesh as isValidVectorMesh,
	fitWarpMesh as fitVectorMesh,
	identityWarpMesh as vectorIdentityMesh,
	evalWarpMesh as evalVectorMesh,
	splitWarpMeshU as splitVectorMeshU,
	splitWarpMeshV as splitVectorMeshV,
	removeWarpMeshSplitU as removeVectorMeshSplitU,
	removeWarpMeshSplitV as removeVectorMeshSplitV,
	mapWarpMeshPoints as mapVectorMeshPoints,
	resizeWarpMesh as resizeVectorMesh,
	warpMeshControlBounds as vectorMeshControlBounds,
	warpMeshParamAt as vectorMeshParamAt,
	dragWarpMeshPoint as dragVectorMeshPoint,
	pullWarpMesh as pullVectorMesh,
	warpMeshEditPoints as vectorMeshEditPoints,
	warpMeshGridCurves as vectorMeshGridCurves
} from '../geom/warp.js';

/** A preset warp's settings (bend and distortions in percent, −100…100). */
export type { WarpPreset as VectorWarpPreset } from '../geom/warp.js';

// ---------------------------------------------------------------------------
// Envelope from an outline (Make with Top Object)
// ---------------------------------------------------------------------------

/** Points along a polyline by fraction of its length. */
function polylineAt(pts: readonly Vec2[]): (u: number) => Vec2 {
	const acc = [0];
	for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
	const total = acc[acc.length - 1];
	return (u) => {
		if (!(total > 0)) return pts[0];
		const L = Math.min(1, Math.max(0, u)) * total;
		let i = 1;
		while (i < acc.length - 1 && acc[i] < L) i++;
		const seg = acc[i] - acc[i - 1];
		return lerpVec2(pts[i - 1], pts[i], seg > 0 ? (L - acc[i - 1]) / seg : 0);
	};
}

function sampleSubpath(sp: VectorSubpath, per = 24): Vec2[] {
	const n = sp.anchors.length;
	const out: Vec2[] = [];
	for (let i = 0; i < n; i++) {
		const a = sp.anchors[i];
		const b = sp.anchors[(i + 1) % n];
		const c = [{ x: a.x, y: a.y }, a.out ?? a, b.in ?? b, { x: b.x, y: b.y }];
		for (let k = 0; k < per; k++) {
			const t = k / per;
			const ab = lerpVec2(c[0], c[1], t);
			const bc = lerpVec2(c[1], c[2], t);
			const cd = lerpVec2(c[2], c[3], t);
			out.push(lerpVec2(lerpVec2(ab, bc, t), lerpVec2(bc, cd, t), t));
		}
	}
	return out;
}

/**
 * A mesh whose border follows a closed outline (Illustrator's Make with Top Object): the outline is
 * cut into four sides at the points nearest its bounding box's corners, and the interior is the
 * Coons patch of those sides, fitted with `columns × rows` patches. Null for an open or degenerate
 * outline.
 */
export function vectorMeshFromOutline(sp: VectorSubpath, columns = 4, rows = 4): VectorWarpMesh | null {
	if (!sp.closed || sp.anchors.length < 2) return null;
	let ring = sampleSubpath(sp);
	const xs = ring.map((p) => p.x);
	const ys = ring.map((p) => p.y);
	const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
	if (!(box.x1 - box.x0 > 1e-9 && box.y1 - box.y0 > 1e-9)) return null;
	const nearest = (c: Vec2) => {
		let best = 0;
		for (let i = 1; i < ring.length; i++) if (Math.hypot(ring[i].x - c.x, ring[i].y - c.y) < Math.hypot(ring[best].x - c.x, ring[best].y - c.y)) best = i;
		return best;
	};
	const cornersOf = () =>
		[
			{ x: box.x0, y: box.y0 },
			{ x: box.x1, y: box.y0 },
			{ x: box.x1, y: box.y1 },
			{ x: box.x0, y: box.y1 }
		].map(nearest);
	let c = cornersOf();
	const n = ring.length;
	const fwd = (from: number, to: number) => (to - from + n) % n;
	// Clockwise on screen: top-left, top-right, bottom-right, bottom-left in walking order.
	if (!(fwd(c[0], c[1]) < fwd(c[0], c[2]) && fwd(c[0], c[2]) < fwd(c[0], c[3]))) {
		ring = ring.slice().reverse();
		c = cornersOf();
		if (!(fwd(c[0], c[1]) < fwd(c[0], c[2]) && fwd(c[0], c[2]) < fwd(c[0], c[3]))) return null;
	}
	if (new Set(c).size < 4) return null;
	const walk = (from: number, to: number) => {
		const out: Vec2[] = [];
		for (let i = from; ; i = (i + 1) % n) {
			out.push(ring[i]);
			if (i === to) break;
		}
		return out;
	};
	// The ring runs clockwise, so the bottom (bottom-right → bottom-left) and left (bottom-left →
	// top-left) walks are reversed to run left to right and top to bottom.
	const top = polylineAt(walk(c[0], c[1]));
	const right = polylineAt(walk(c[1], c[2]));
	const bottomLR = polylineAt(walk(c[2], c[3]).reverse());
	const leftTB = polylineAt(walk(c[3], c[0]).reverse());
	const p00 = top(0);
	const p10 = top(1);
	const p01 = bottomLR(0);
	const p11 = bottomLR(1);
	const coons = (s: number, t: number): Vec2 => {
		const T = top(s);
		const B = bottomLR(s);
		const L = leftTB(t);
		const R = right(t);
		return {
			x: (1 - t) * T.x + t * B.x + (1 - s) * L.x + s * R.x - ((1 - s) * (1 - t) * p00.x + s * (1 - t) * p10.x + (1 - s) * t * p01.x + s * t * p11.x),
			y: (1 - t) * T.y + t * B.y + (1 - s) * L.y + s * R.y - ((1 - s) * (1 - t) * p00.y + s * (1 - t) * p10.y + (1 - s) * t * p01.y + s * t * p11.y)
		};
	};
	return fitWarpMesh(coons, evenKnots(clampMeshCount(columns)), evenKnots(clampMeshCount(rows)));
}

/** The mesh's border as one closed subpath (clockwise from the top-left corner): what Release gives back as the envelope's shape. */
export function vectorMeshOutline(m: VectorWarpMesh): VectorSubpath {
	const nx = warpMeshColumns(m);
	const ny = warpMeshRows(m);
	const pt = (i: number, j: number) => m.points[j * nx + i];
	// The border as a chain of cubics, each [p0, p1, p2, p3].
	const runs: Vec2[][] = [];
	for (let i = 0; i + 3 < nx; i += 3) runs.push([pt(i, 0), pt(i + 1, 0), pt(i + 2, 0), pt(i + 3, 0)]);
	for (let j = 0; j + 3 < ny; j += 3) runs.push([pt(nx - 1, j), pt(nx - 1, j + 1), pt(nx - 1, j + 2), pt(nx - 1, j + 3)]);
	for (let i = nx - 1; i - 3 >= 0; i -= 3) runs.push([pt(i, ny - 1), pt(i - 1, ny - 1), pt(i - 2, ny - 1), pt(i - 3, ny - 1)]);
	for (let j = ny - 1; j - 3 >= 0; j -= 3) runs.push([pt(0, j), pt(0, j - 1), pt(0, j - 2), pt(0, j - 3)]);
	const anchors = runs.map((r, k) => {
		const prev = runs[(k + runs.length - 1) % runs.length];
		return { x: r[0].x, y: r[0].y, in: { ...prev[2] }, out: { ...r[1] } };
	});
	return { closed: true, anchors };
}
