/**
 * Live symmetry groups: children drawn with their mirrored or rotated copies.
 *
 * The mirror modes and axes follow photocraft's `crates/paint/src/symmetry.rs` (MIT OR Apache-2.0,
 * © ArtCraft Team and contributors; see THIRD_PARTY_NOTICES.md): `vertical`, `horizontal`,
 * `diagonal` and `dual` (both axes and the point reflection between them) about a centre, turned
 * by a rotation, and the axes clipped to a box for display (`segments`). Radial symmetry (turns,
 * optionally mirrored: the dihedral group) is ours. The copies are not stored: they are part of
 * the group's appearance, rebuilt whenever a child changes, like CorelDRAW's live symmetry.
 */

import type { AffineMatrix } from '../geom/types.js';
import { multiplyMatrices } from '../geom/affine.js';
import type { VectorBounds, VectorGroupNode, VectorNode, VectorSymmetry, VectorSymmetryMode, Vec2 } from './types.js';
import { VECTOR_SYMMETRY_MODES } from './types.js';
import { transformVectorNode } from './geometry.js';

/** A symmetry group (with `symmetry` set, and not a blend, live boolean, mask group or frame). */
export type VectorSymmetryGroup = VectorGroupNode & { symmetry: VectorSymmetry };

/** Whether the node is a live symmetry group. */
export function isVectorSymmetryGroup(node: VectorNode | null | undefined): node is VectorSymmetryGroup {
	return node?.type === 'group' && !!node.symmetry && !node.blend && !node.liveBoolean && !node.mask && !node.frame;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const exact = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
const around = (c: Vec2, m: AffineMatrix): AffineMatrix => multiplyMatrices(multiplyMatrices([1, 0, 0, 1, -c.x, -c.y], m), [1, 0, 0, 1, c.x, c.y]);
/** The reflection across the line through `c` at `deg` degrees (clockwise, y down). */
const reflect = (c: Vec2, deg: number): AffineMatrix => {
	const a = 2 * rad(deg);
	return around(c, [exact(Math.cos(a)), exact(Math.sin(a)), exact(Math.sin(a)), exact(-Math.cos(a)), 0, 0]);
};
const turn = (c: Vec2, deg: number): AffineMatrix => around(c, [exact(Math.cos(rad(deg))), exact(Math.sin(rad(deg))), exact(-Math.sin(rad(deg))), exact(Math.cos(rad(deg))), 0, 0]);

/** The directions (degrees) of the mirror axes of a mode before rotation (photocraft `directions`). */
const AXIS: Record<Exclude<VectorSymmetryMode, 'radial'>, number[]> = { horizontal: [0], vertical: [90], diagonal: [45], dual: [90, 0] };

/** The copies a symmetry makes, as matrices in the group's space (the identity, the original, not included). */
export function vectorSymmetryMatrices(s: VectorSymmetry): AffineMatrix[] {
	const c = s.center;
	const r = s.rotation ?? 0;
	if (s.mode === 'radial') {
		const n = Math.min(64, Math.max(2, Math.round(s.copies ?? 6)));
		const out: AffineMatrix[] = [];
		for (let k = 1; k < n; k++) out.push(turn(c, (360 * k) / n));
		// Kaleidoscope: the reflections across the n axes through the centre.
		if (s.mirror) for (let k = 0; k < n; k++) out.push(reflect(c, r + (180 * k) / n));
		return out;
	}
	const axes = AXIS[s.mode].map((a) => reflect(c, a + r));
	// Dual: both mirrors and the half turn between them.
	return s.mode === 'dual' ? [...axes, turn(c, 180)] : axes;
}

/** A node with its ids (and its children's) made unique for copy `k`. */
function renamed<T extends VectorNode>(node: T, k: number): T {
	const id = `${node.id}~sym${k}`;
	if (node.type === 'group') return { ...node, id, children: node.children.map((c) => renamed(c, k)) } as T;
	return { ...node, id } as T;
}

const drawnCache = new WeakMap<VectorSymmetryGroup, VectorGroupNode>();

/**
 * The symmetry group as a plain group: its children, then each copy of them (ids `<id>~sym<k>`),
 * the copies locked. Same id, transform and appearance. Cached per node.
 */
export function vectorSymmetryDrawn(node: VectorSymmetryGroup): VectorGroupNode {
	let hit = drawnCache.get(node);
	if (hit) return hit;
	const { symmetry, ...group } = node;
	const copies = vectorSymmetryMatrices(symmetry).flatMap((m, k) => node.children.map((c) => ({ ...renamed(transformVectorNode(c, m), k + 1), locked: true })));
	hit = { ...group, children: [...node.children, ...copies] };
	drawnCache.set(node, hit);
	return hit;
}

/**
 * The symmetry's axes for display: each mirror line (or each spoke of a radial symmetry) clipped
 * to `box` (photocraft `segments`), in the group's space.
 */
export function vectorSymmetryAxes(s: VectorSymmetry, box: VectorBounds): [Vec2, Vec2][] {
	const r = s.rotation ?? 0;
	const dirs = s.mode === 'radial' ? Array.from({ length: Math.min(64, Math.max(2, Math.round(s.copies ?? 6))) }, (_, k) => r - 90 + (360 * k) / Math.min(64, Math.max(2, Math.round(s.copies ?? 6)))) : AXIS[s.mode].map((a) => a + r);
	const out: [Vec2, Vec2][] = [];
	for (const deg of dirs) {
		const d = { x: Math.cos(rad(deg)), y: Math.sin(rad(deg)) };
		let lo = s.mode === 'radial' ? 0 : -Infinity;
		let hi = Infinity;
		let inside = true;
		for (const [o, dv, min, max] of [
			[s.center.x, d.x, box.x, box.x + box.width],
			[s.center.y, d.y, box.y, box.y + box.height]
		] as const) {
			if (Math.abs(dv) < 1e-12) {
				if (o < min || o > max) inside = false;
			} else {
				const a = (min - o) / dv;
				const b = (max - o) / dv;
				lo = Math.max(lo, Math.min(a, b));
				hi = Math.min(hi, Math.max(a, b));
			}
		}
		if (inside && Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) out.push([{ x: s.center.x + lo * d.x, y: s.center.y + lo * d.y }, { x: s.center.x + hi * d.x, y: s.center.y + hi * d.y }]);
	}
	return out;
}

/** Reads symmetry settings from untrusted data (JSON, agent input, SVG import), or null. */
export function sanitizeVectorSymmetry(value: unknown): VectorSymmetry | null {
	if (!value || typeof value !== 'object') return null;
	const r = value as Record<string, unknown>;
	if (!VECTOR_SYMMETRY_MODES.includes(r.mode as VectorSymmetryMode)) return null;
	const c = r.center as Vec2 | undefined;
	if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
	const out: VectorSymmetry = { mode: r.mode as VectorSymmetryMode, center: { x: c.x, y: c.y } };
	if (typeof r.rotation === 'number' && Number.isFinite(r.rotation) && r.rotation % 360 !== 0) out.rotation = ((r.rotation % 360) + 360) % 360;
	if (out.mode === 'radial') {
		if (typeof r.copies === 'number' && Number.isFinite(r.copies)) out.copies = Math.min(64, Math.max(2, Math.round(r.copies)));
		if (r.mirror === true) out.mirror = true;
	}
	return out;
}

/** Labels for the symmetry pickers. */
export const VECTOR_SYMMETRY_MODE_LABELS: Readonly<Record<VectorSymmetryMode, string>> = {
	vertical: 'Mirror left / right',
	horizontal: 'Mirror top / bottom',
	dual: 'Four quarters',
	diagonal: 'Mirror diagonally',
	radial: 'Radial'
};

/** The symmetry settings carried through a map baked into the group (its centre moves; its axes turn with a rotation, flip with a mirror). */
export function transformVectorSymmetry(s: VectorSymmetry, m: AffineMatrix): VectorSymmetry {
	const center = { x: m[0] * s.center.x + m[2] * s.center.y + m[4], y: m[1] * s.center.x + m[3] * s.center.y + m[5] };
	const det = m[0] * m[3] - m[1] * m[2];
	const angle = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
	const rotation = det < 0 ? -(s.rotation ?? 0) + 2 * angle : (s.rotation ?? 0) + angle;
	const norm = ((rotation % 360) + 360) % 360;
	return { ...s, center, ...(Math.abs(norm) > 1e-9 && Math.abs(norm - 360) > 1e-9 ? { rotation: norm } : { rotation: undefined }) };
}
