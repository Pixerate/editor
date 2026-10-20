// Portions ported from vectorcraft-main/crates/doc/src/blend.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
/**
 * Live blend groups: a group whose `blend` is set keeps its key shapes as children and
 * regenerates the in-betweens (`blendStep` children, locked) whenever a key or the options
 * change. Steps follow the straight lines between the keys' centres, or a replaced spine.
 *
 * - **Spacing** (`vectorBlendStepCount`): a number of steps per pair of keys, a fixed distance
 *   along the spine, or smooth colour — one step per two levels of the largest colour channel
 *   difference, by distance when the colours match.
 * - **Spine**: with a replaced spine the keys sit along it, spread evenly by arc length; each
 *   step is moved by how far the spine bends away from the chord between its keys, so a step
 *   lands on the spine and the keys stay where they are. Orient to spine also turns the steps
 *   by how much the spine's direction differs from the keys' (keys keep their orientation);
 *   without a replaced spine the steps run straight and keep their orientation.
 */
import type { Point } from '../canvas/types.js';
import { hexToRgba } from '../tokens/color.js';
import { segmentPoint, segmentTangent } from '../canvas/pathops/bezier.js';
import { createVectorMorph, type VectorMorph } from './blend.js';
import {
	collectPathNodes,
	IDENTITY_MATRIX,
	rotateMatrix,
	subpathSegment,
	subpathSegmentCount,
	transformVectorNode,
	translateMatrix,
	multiplyMatrices,
	nodeMatrix,
	vectorNodeBounds,
	type AffineMatrix
} from './geometry.js';
import type { VectorBlend, VectorBlendOptions, VectorGroupNode, VectorNode, VectorPaint, VectorPathNode, VectorSubpath } from './types.js';

export const DEFAULT_VECTOR_BLEND_STEPS = 5;
export const DEFAULT_VECTOR_BLEND_DISTANCE = 20;
/** Most steps between two keys. */
export const VECTOR_BLEND_MAX_STEPS = 1000;
/** Most steps smooth colour makes between two keys. */
export const VECTOR_BLEND_MAX_SMOOTH_STEPS = 256;

/** Whether a node is a live blend group. */
export function isVectorBlendGroup(node: VectorNode | null | undefined): node is VectorGroupNode & { blend: VectorBlend } {
	return !!node && node.type === 'group' && !!node.blend;
}

/** The keys of a blend group (its children that are not generated steps), in stacking order. */
export function vectorBlendKeys(group: VectorGroupNode): VectorNode[] {
	return group.children.filter((c) => !c.blendStep);
}

/** The full options of a blend, defaults filled in. */
export function resolveVectorBlendOptions(options: VectorBlendOptions | null | undefined): Required<VectorBlendOptions> {
	return {
		spacing: options?.spacing ?? 'steps',
		steps: options?.steps ?? DEFAULT_VECTOR_BLEND_STEPS,
		distance: options?.distance ?? DEFAULT_VECTOR_BLEND_DISTANCE,
		orientToSpine: options?.orientToSpine ?? false,
		linear: options?.linear ?? false
	};
}

// ---------------------------------------------------------------------------
// Step counts
// ---------------------------------------------------------------------------

function paintColors(p: VectorPaint | undefined): string[] {
	if (typeof p === 'string') return [p];
	if (p && typeof p === 'object') {
		if (p.type === 'mesh') return p.colors;
		if (p.type === 'freeform') return p.points.map((q) => q.color);
		return p.stops.map((s) => s.color);
	}
	return [];
}

/** Largest channel difference (0–1) between the colours of two shapes' fills and strokes. */
export function vectorBlendColorDistance(a: VectorNode, b: VectorNode): number {
	const pa = collectPathNodes(a)[0];
	const pb = collectPathNodes(b)[0];
	if (!pa || !pb) return 0;
	let d = 0;
	for (const key of ['fill', 'stroke'] as const) {
		const ca = paintColors(pa[key]);
		const cb = paintColors(pb[key]);
		ca.forEach((c, i) => {
			const other = cb[i] ?? cb[0];
			if (other === undefined) return;
			const x = hexToRgba(c);
			const y = hexToRgba(other);
			if (!x || !y) return;
			d = Math.max(d, Math.abs(x.r - y.r), Math.abs(x.g - y.g), Math.abs(x.b - y.b), Math.abs(x.a - y.a));
		});
	}
	return d;
}

const centreOf = (n: VectorNode): Point => {
	const b = vectorNodeBounds(n);
	return b ? [b.x + b.width / 2, b.y + b.height / 2] : [0, 0];
};

/** Number of in-betweens between two keys `length` apart along the spine. */
export function vectorBlendStepCount(a: VectorNode, b: VectorNode, options: VectorBlendOptions | null | undefined, length: number): number {
	const o = resolveVectorBlendOptions(options);
	if (o.spacing === 'distance') {
		const d = Math.max(0.01, o.distance);
		return Math.min(VECTOR_BLEND_MAX_STEPS, Math.max(0, Math.round(length / d) - 1));
	}
	if (o.spacing === 'smoothColor') {
		const cd = vectorBlendColorDistance(a, b);
		if (cd > 1 / 255) return Math.min(VECTOR_BLEND_MAX_SMOOTH_STEPS, Math.max(1, Math.ceil((cd * 255) / 2)));
		// Same colours: base the count on how far the shapes are apart.
		const ba = vectorNodeBounds(a);
		const bb = vectorNodeBounds(b);
		const dist =
			ba && bb
				? Math.max(Math.abs(ba.x - bb.x), Math.abs(ba.y - bb.y), Math.abs(ba.x + ba.width - bb.x - bb.width), Math.abs(ba.y + ba.height - bb.y - bb.height))
				: length;
		return Math.min(VECTOR_BLEND_MAX_SMOOTH_STEPS, Math.max(1, Math.ceil(dist / 2)));
	}
	return Math.min(VECTOR_BLEND_MAX_STEPS, Math.max(1, Math.round(Number.isFinite(o.steps) ? o.steps : DEFAULT_VECTOR_BLEND_STEPS)));
}

// ---------------------------------------------------------------------------
// Spine
// ---------------------------------------------------------------------------

/** A subpath flattened to a polyline with cumulative arc lengths and tangent angles. */
export interface VectorBlendRail {
	pts: Point[];
	cum: number[];
	angles: number[];
	total: number;
	closed: boolean;
}

/** Flattens a spine subpath (32 samples per curve). Null with fewer than two distinct points. */
export function vectorBlendRail(sp: VectorSubpath): VectorBlendRail | null {
	const pts: Point[] = [];
	const angles: number[] = [];
	const push = (p: Point, tangent: Point) => {
		const last = pts[pts.length - 1];
		if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 1e-9) return;
		pts.push(p);
		angles.push(Math.atan2(tangent[1], tangent[0]));
	};
	const count = subpathSegmentCount(sp);
	for (let i = 0; i < count; i++) {
		const seg = subpathSegment(sp, i);
		const samples = seg.length === 2 ? 1 : 32;
		if (i === 0) push(seg[0], segmentTangent(seg, 0));
		for (let k = 1; k <= samples; k++) push(segmentPoint(seg, k / samples), segmentTangent(seg, k / samples));
	}
	if (pts.length < 2) return null;
	const cum = [0];
	for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
	return { pts, cum, angles, total: cum[cum.length - 1], closed: sp.closed };
}

/** Point and direction (radians) at arc length `s` (clamped; a closed rail wraps). */
export function vectorBlendRailAt(rail: VectorBlendRail, s: number): { point: Point; angle: number } {
	let len = Number.isFinite(s) ? s : 0;
	if (rail.closed && rail.total > 0) len = ((len % rail.total) + rail.total) % rail.total;
	len = Math.min(rail.total, Math.max(0, len));
	let lo = 0;
	let hi = rail.cum.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (rail.cum[mid] <= len) lo = mid;
		else hi = mid;
	}
	const span = rail.cum[hi] - rail.cum[lo];
	const u = span > 1e-12 ? (len - rail.cum[lo]) / span : 0;
	const a = rail.pts[lo];
	const b = rail.pts[hi];
	return { point: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

/**
 * The spine of a blend in the group's space and where along it each key sits: the replaced
 * spine (keys spread evenly by arc length) or the straight lines between the keys' centres.
 */
export function vectorBlendSpine(group: VectorGroupNode): { spine: VectorSubpath; rail: VectorBlendRail; stops: number[]; replaced: boolean } | null {
	const keys = vectorBlendKeys(group);
	if (keys.length < 2) return null;
	const stored = group.blend?.spine;
	if (stored && stored.anchors.length >= 2) {
		const rail = vectorBlendRail(stored);
		if (rail) {
			const end = rail.closed ? rail.total * (1 - 1 / keys.length) : rail.total;
			return { spine: stored, rail, stops: keys.map((_, i) => (end * i) / (keys.length - 1)), replaced: true };
		}
	}
	const centres = keys.map(centreOf);
	const spine: VectorSubpath = { closed: false, anchors: centres.map((c) => ({ x: c[0], y: c[1] })) };
	const stops = [0];
	for (let i = 1; i < centres.length; i++) stops.push(stops[i - 1] + Math.hypot(centres[i][0] - centres[i - 1][0], centres[i][1] - centres[i - 1][1]));
	const rail = vectorBlendRail(spine) ?? { pts: centres, cum: stops, angles: centres.map(() => 0), total: stops[stops.length - 1], closed: false };
	return { spine, rail, stops, replaced: false };
}

/** Where key `i` of a blend with spine `spine` should sit: its stop on the spine. */
export function vectorBlendKeyTargets(group: VectorGroupNode): Point[] {
	const s = vectorBlendSpine(group);
	return s ? s.stops.map((stop) => vectorBlendRailAt(s.rail, stop).point) : [];
}

// ---------------------------------------------------------------------------
// Generating steps
// ---------------------------------------------------------------------------

const morphCache = new WeakMap<VectorNode, WeakMap<VectorNode, Map<string, VectorMorph>>>();

function morphFor(a: VectorNode, b: VectorNode, blend: VectorBlend): VectorMorph {
	const starts = [blend.starts?.[a.id] ?? null, blend.starts?.[b.id] ?? null] as const;
	const key = JSON.stringify([!!blend.linear, starts]);
	let inner = morphCache.get(a);
	if (!inner) morphCache.set(a, (inner = new WeakMap()));
	let byKey = inner.get(b);
	if (!byKey) inner.set(b, (byKey = new Map()));
	let morph = byKey.get(key);
	if (!morph) byKey.set(key, (morph = createVectorMorph(a, b, { linear: blend.linear, starts })));
	return morph;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A step marked as generated: locked, flagged, ids derived from `id`. */
function asStep(node: VectorNode, id: string): VectorNode {
	const rename = (n: VectorNode, nid: string): VectorNode =>
		n.type === 'group' ? { ...n, id: nid, children: n.children.map((c, i) => rename(c, `${nid}.${i}`)) } : { ...n, id: nid };
	return { ...rename(node, id), blendStep: true, locked: true };
}

/**
 * A blend group's children with fresh steps: each key followed by the in-betweens to the next,
 * bottom to top. Groups with fewer than two keys keep just their keys.
 */
export function generateVectorBlendChildren(group: VectorGroupNode): VectorNode[] {
	const keys = vectorBlendKeys(group);
	const blend = group.blend;
	if (!blend || keys.length < 2) return keys;
	const spine = vectorBlendSpine(group);
	if (!spine) return keys;
	const out: VectorNode[] = [];
	let counter = 0;
	keys.forEach((a, i) => {
		out.push(a);
		const b = keys[i + 1];
		if (!b) return;
		const s0 = spine.stops[i];
		const s1 = spine.stops[i + 1];
		const n = vectorBlendStepCount(a, b, blend, Math.abs(s1 - s0));
		const morph = morphFor(a, b, blend);
		const p0 = vectorBlendRailAt(spine.rail, s0);
		const p1 = vectorBlendRailAt(spine.rail, s1);
		for (let j = 1; j <= n; j++) {
			const t = j / (n + 1);
			let step = morph.at(t);
			if (spine.replaced) {
				const p = vectorBlendRailAt(spine.rail, s0 + (s1 - s0) * t);
				const dx = p.point[0] - (p0.point[0] + (p1.point[0] - p0.point[0]) * t);
				const dy = p.point[1] - (p0.point[1] + (p1.point[1] - p0.point[1]) * t);
				let m: AffineMatrix = Math.hypot(dx, dy) > 1e-9 ? translateMatrix(dx, dy) : IDENTITY_MATRIX;
				if (blend.orientToSpine) {
					const turn = wrapAngle(p.angle - (p0.angle + wrapAngle(p1.angle - p0.angle) * t));
					if (Math.abs(turn) > 1e-9) {
						const c = centreOf(step);
						const origin = { x: c[0] + m[4], y: c[1] + m[5] };
						m = multiplyMatrices(m, rotateMatrix((turn * 180) / Math.PI, origin));
					}
				}
				if (m !== IDENTITY_MATRIX) step = transformVectorNode(step, m);
			}
			out.push(asStep(step, `${group.id}~${++counter}`));
		}
	});
	return out;
}

const childrenCache = new WeakMap<VectorNode, { sig: string; keys: VectorNode[]; children: VectorNode[] }>();

const sameList = (a: readonly VectorNode[], b: readonly VectorNode[]) => a.length === b.length && a.every((n, i) => n === b[i]);

function blendChildren(group: VectorGroupNode): VectorNode[] {
	const keys = vectorBlendKeys(group);
	const sig = `${group.id}|${JSON.stringify(group.blend)}`;
	const cached = keys[0] ? childrenCache.get(keys[0]) : undefined;
	let children: VectorNode[];
	if (cached && cached.sig === sig && sameList(cached.keys, keys)) children = cached.children;
	else {
		children = generateVectorBlendChildren(group);
		if (keys[0]) childrenCache.set(keys[0], { sig, keys, children });
	}
	return sameList(children, group.children) ? group.children : children;
}

/**
 * Nodes with every blend group's steps brought up to date (nested blends first). Returns the
 * same array when nothing changed; steps are cached per set of keys, so calling this after
 * every edit is cheap.
 */
export function refreshVectorBlends(nodes: readonly VectorNode[]): VectorNode[] {
	let changed = false;
	const out = nodes.map((n) => {
		if (n.type !== 'group') return n;
		const inner = refreshVectorBlends(n.children);
		let next: VectorGroupNode = inner === n.children ? n : { ...n, children: inner };
		if (next.blend) {
			const children = blendChildren(next);
			if (children !== next.children) next = { ...next, children };
		}
		if (next !== n) changed = true;
		return next;
	});
	return changed ? out : (nodes as VectorNode[]);
}

/** A step or key with the generated flags dropped and fresh ids. */
function plain(node: VectorNode, newId: () => string): VectorNode {
	const { blendStep: _s, locked: _l, ...rest } = node;
	const renamed = { ...rest, id: newId() } as VectorNode;
	if (renamed.type === 'group') renamed.children = renamed.children.map((c) => plain(c, newId));
	return renamed;
}

/** Expand: the blend as a plain group of its keys and steps (steps get fresh ids). */
export function expandVectorBlend(group: VectorGroupNode, newId: () => string): VectorGroupNode {
	const { blend: _b, ...rest } = group;
	return { ...rest, children: group.children.map((c) => (c.blendStep ? plain(c, newId) : c)) };
}

/**
 * Release: the blend's keys in the group's parent space (the group's transform and opacity
 * applied), followed by the replaced spine as an unpainted path when there is one.
 */
export function releaseVectorBlend(group: VectorGroupNode, newId: () => string): VectorNode[] {
	const m = nodeMatrix(group);
	const opacity = group.opacity;
	const keys = vectorBlendKeys(group)
		.map((c) => (group.transform ? transformVectorNode(c, m) : c))
		.map((c) => (opacity !== undefined && opacity < 1 ? { ...c, opacity: (c.opacity ?? 1) * opacity } : c));
	const spine = group.blend?.spine;
	if (!spine || spine.anchors.length < 2) return keys;
	const path: VectorPathNode = { id: newId(), type: 'path', name: 'Spine', fill: null, stroke: null, subpaths: [{ closed: spine.closed, anchors: spine.anchors.map((a) => ({ ...a })) }] };
	return [...keys, group.transform ? transformVectorNode(path, m) : path];
}
