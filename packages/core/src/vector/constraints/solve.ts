// Portions ported from cadcraft/crates/constraints/src/lib.rs, residual.rs and dof.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * The constraint solver over a vector document: anchors, handles, segments and circles referenced
 * by constraints become a parameter vector (document space), each constraint becomes residual
 * equations, and the damped minimum-norm Gauss–Newton solver (`lm.ts`) drives them to zero per
 * connected component, moving geometry as little as possible and what was just edited least.
 *
 * Adapted from cadcraft's solver: its lines, circles and polyline vertices become our anchors,
 * segments (the line between two anchors, or the cubic with its handles for G1 / G2) and round
 * closed paths; its entity handles become anchor ids.
 */

import { applyMatrix, invertMatrix, multiplyMatrices, IDENTITY_MATRIX } from '../../geom/affine.js';
import type { AffineMatrix } from '../../geom/types.js';
import { MAX_ROWS, jacobian, maxAbs, nullSpace, qr, rankQr, solveLm, type ResidualFn } from './lm.js';
import { formatVectorValue, isValidVectorParameterName, VectorExprEnv, VectorExprError } from './expr.js';
import type { Vec2, VectorAnchor, VectorConstraint, VectorConstraintKind, VectorDocument, VectorGeomRef, VectorNode, VectorPathNode } from '../types.js';

/** Solver iterations. */
const MAX_ITER = 200;
/** Constraints tried one by one when locating a conflict. */
const MAX_CONFLICT_PROBES = 48;
/** Most constraints one document may hold. */
export const VECTOR_MAX_CONSTRAINTS = 2000;

export const VECTOR_DIMENSIONAL_KINDS: ReadonlySet<VectorConstraintKind> = new Set(['distance', 'angle', 'radius', 'diameter']);

export class VectorConstraintError extends Error {
	constructor(
		message: string,
		/** Constraints involved (conflicting or duplicated), when known. */
		readonly ids: string[] = []
	) {
		super(message);
	}
}

// ---------------------------------------------------------------------------
// Locating references
// ---------------------------------------------------------------------------

interface Located {
	node: VectorPathNode;
	/** Node space → document. */
	world: AffineMatrix;
}

function locateNodes(doc: VectorDocument): Map<string, Located> {
	const out = new Map<string, Located>();
	const visit = (list: readonly VectorNode[], parent: AffineMatrix) => {
		for (const n of list) {
			const m = n.transform ? multiplyMatrices(n.transform as AffineMatrix, parent) : parent;
			if (n.type === 'path') out.set(n.id, { node: n, world: m });
			else if (n.type === 'group') visit(n.children, m);
		}
	};
	visit(doc.nodes, IDENTITY_MATRIX);
	return out;
}

/** Subpath and index of the anchor with `id` in a path, or null. */
export function findVectorAnchorById(node: VectorPathNode, id: string): { subpath: number; index: number } | null {
	for (let s = 0; s < node.subpaths.length; s++) {
		const i = node.subpaths[s].anchors.findIndex((a) => a.id === id);
		if (i >= 0) return { subpath: s, index: i };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Model: parameters
// ---------------------------------------------------------------------------

type Part = 'anchor' | 'in' | 'out';

interface PointSlot {
	kind: 'point';
	nodeId: string;
	subpath: number;
	index: number;
	part: Part;
	off: number;
}

interface CircleSlot {
	kind: 'circle';
	nodeId: string;
	off: number;
	/** Centre and radius the path had (document space). */
	c0: Vec2;
	r0: number;
}

type Slot = PointSlot | CircleSlot;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Vec2) => Math.hypot(v.x, v.y);
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const unit = (v: Vec2): Vec2 => {
	const l = len(v);
	return l > 1e-12 ? { x: v.x / l, y: v.y / l } : v;
};
const wrap = (a: number) => {
	const r = ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
	return Number.isFinite(r) ? r : 0;
};

/** The round closed path's centre and radius (document space), or null when it is not round. */
export function vectorPathCircle(node: VectorPathNode, world: AffineMatrix = IDENTITY_MATRIX): { c: Vec2; r: number } | null {
	const sp = node.subpaths[0];
	if (!sp || !sp.closed || sp.anchors.length < 3) return null;
	const pts = sp.anchors.map((a) => applyMatrix(world, a));
	const c = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
	const ds = pts.map((p) => len(sub(p, c)));
	const r = ds.reduce((s, d) => s + d, 0) / ds.length;
	if (!(r > 1e-9) || ds.some((d) => Math.abs(d - r) > r * 0.05)) return null;
	// The middle of every segment too (a polygon's corners lie on a circle, its sides do not).
	const n = sp.anchors.length;
	for (let i = 0; i < n; i++) {
		const a = sp.anchors[i];
		const b = sp.anchors[(i + 1) % n];
		const p1 = a.out ?? a;
		const p2 = b.in ?? b;
		const mid = applyMatrix(world, { x: (a.x + 3 * p1.x + 3 * p2.x + b.x) / 8, y: (a.y + 3 * p1.y + 3 * p2.y + b.y) / 8 });
		if (Math.abs(len(sub(mid, c)) - r) > r * 0.05) return null;
	}
	return { c, r };
}

class Model {
	readonly x0: number[] = [];
	readonly slots = new Map<string, Slot>();
	constructor(readonly located: Map<string, Located>) {}

	private anchorOf(ref: VectorGeomRef): { loc: Located; subpath: number; index: number; a: VectorAnchor } | null {
		const loc = this.located.get(ref.nodeId);
		if (!loc || !ref.anchor) return null;
		const at = findVectorAnchorById(loc.node, ref.anchor);
		if (!at) return null;
		return { loc, ...at, a: loc.node.subpaths[at.subpath].anchors[at.index] };
	}

	/** The slot of a point of a path (anchor or handle), allocating it. */
	pointSlot(loc: Located, subpath: number, index: number, part: Part): PointSlot | null {
		const sp = loc.node.subpaths[subpath];
		const a = sp?.anchors[index];
		if (!a) return null;
		const key = `${loc.node.id}#${subpath}:${index}#${part}`;
		const hit = this.slots.get(key);
		if (hit) return hit as PointSlot;
		const p = part === 'anchor' ? a : (a[part] ?? a);
		const d = applyMatrix(loc.world, p);
		const slot: PointSlot = { kind: 'point', nodeId: loc.node.id, subpath, index, part, off: this.x0.length };
		this.x0.push(d.x, d.y);
		this.slots.set(key, slot);
		return slot;
	}

	circleSlot(nodeId: string): CircleSlot | null {
		const key = `${nodeId}#circle`;
		const hit = this.slots.get(key);
		if (hit) return hit as CircleSlot;
		const loc = this.located.get(nodeId);
		if (!loc) return null;
		const circle = vectorPathCircle(loc.node, loc.world);
		if (!circle) return null;
		const slot: CircleSlot = { kind: 'circle', nodeId, off: this.x0.length, c0: circle.c, r0: circle.r };
		this.x0.push(circle.c.x, circle.c.y, circle.r);
		this.slots.set(key, slot);
		return slot;
	}

	/** A point: an anchor, a handle, or a circle's centre. Returns its x index (y is next). */
	point(ref: VectorGeomRef): number | null {
		if (ref.circle) return this.circleSlot(ref.nodeId)?.off ?? null;
		if (ref.segment) return null;
		const at = this.anchorOf(ref);
		if (!at) return null;
		return this.pointSlot(at.loc, at.subpath, at.index, ref.handle ?? 'anchor')?.off ?? null;
	}

	/** A segment's end points (anchor and next anchor) as x indices. */
	line(ref: VectorGeomRef): [number, number] | null {
		if (!ref.segment) return null;
		const at = this.anchorOf(ref);
		if (!at) return null;
		const sp = at.loc.node.subpaths[at.subpath];
		const next = at.index + 1 < sp.anchors.length ? at.index + 1 : sp.closed ? 0 : -1;
		if (next < 0 || next === at.index) return null;
		const a = this.pointSlot(at.loc, at.subpath, at.index, 'anchor');
		const b = this.pointSlot(at.loc, at.subpath, next, 'anchor');
		return a && b ? [a.off, b.off] : null;
	}

	/** A circle's centre x index (y, then r follow). */
	circle(ref: VectorGeomRef): number | null {
		return ref.circle ? (this.circleSlot(ref.nodeId)?.off ?? null) : null;
	}

	/**
	 * The two cubic segments meeting at an anchor, as x indices of their control points (incoming:
	 * previous anchor, its out handle, this anchor's in handle, this anchor; outgoing: this anchor,
	 * its out handle, the next anchor's in handle, the next anchor). Null at an open end.
	 */
	joint(ref: VectorGeomRef): { inc: [number, number, number, number]; out: [number, number, number, number] } | null {
		const at = this.anchorOf(ref);
		if (!at || ref.segment || ref.handle) return null;
		const sp = at.loc.node.subpaths[at.subpath];
		const n = sp.anchors.length;
		const prev = at.index > 0 ? at.index - 1 : sp.closed ? n - 1 : -1;
		const next = at.index + 1 < n ? at.index + 1 : sp.closed ? 0 : -1;
		if (prev < 0 || next < 0 || n < 2) return null;
		const s = (i: number, p: Part) => this.pointSlot(at.loc, at.subpath, i, p)!.off;
		return { inc: [s(prev, 'anchor'), s(prev, 'out'), s(at.index, 'in'), s(at.index, 'anchor')], out: [s(at.index, 'anchor'), s(at.index, 'out'), s(next, 'in'), s(next, 'anchor')] };
	}

	/** Parameter indices a Fix of `ref` locks. */
	lockIndices(ref: VectorGeomRef): number[] {
		const c = this.circle(ref);
		if (c !== null) return [c, c + 1, c + 2];
		const l = this.line(ref);
		if (l) return [l[0], l[0] + 1, l[1], l[1] + 1];
		const p = this.point(ref);
		return p === null ? [] : [p, p + 1];
	}

	/** The document with every slot's parameters from `x` written back into the paths. */
	writeBack(doc: VectorDocument, x: readonly number[]): VectorDocument {
		const byNode = new Map<string, Slot[]>();
		for (const s of this.slots.values()) byNode.set(s.nodeId, [...(byNode.get(s.nodeId) ?? []), s]);
		const changed = new Map<string, VectorPathNode>();
		for (const [nodeId, slots] of byNode) {
			const loc = this.located.get(nodeId)!;
			const inv = invertMatrix(loc.world);
			const toLocal = (p: Vec2) => applyMatrix(inv, p);
			let subpaths = loc.node.subpaths;
			const circle = slots.find((s): s is CircleSlot => s.kind === 'circle');
			if (circle) {
				const c = { x: x[circle.off], y: x[circle.off + 1] };
				const k = x[circle.off + 2] / circle.r0;
				const map = (p: Vec2) => toLocal({ x: c.x + (applyMatrix(loc.world, p).x - circle.c0.x) * k, y: c.y + (applyMatrix(loc.world, p).y - circle.c0.y) * k });
				subpaths = subpaths.map((sp) => ({ ...sp, anchors: sp.anchors.map((a) => ({ ...a, ...map(a), ...(a.in ? { in: map(a.in) } : {}), ...(a.out ? { out: map(a.out) } : {}) })) }));
			}
			const points = slots.filter((s): s is PointSlot => s.kind === 'point');
			if (points.length) {
				subpaths = subpaths.map((sp, si) => {
					if (!points.some((p) => p.subpath === si)) return sp;
					return {
						...sp,
						anchors: sp.anchors.map((a, ai) => {
							const mine = points.filter((p) => p.subpath === si && p.index === ai);
							if (!mine.length) return a;
							const next: VectorAnchor = { ...a };
							const anchorSlot = mine.find((p) => p.part === 'anchor');
							if (anchorSlot) {
								const q = toLocal({ x: x[anchorSlot.off], y: x[anchorSlot.off + 1] });
								const dx = q.x - a.x;
								const dy = q.y - a.y;
								next.x = q.x;
								next.y = q.y;
								// Handles that are not parameters move with their anchor.
								if (a.in && !mine.some((p) => p.part === 'in')) next.in = { x: a.in.x + dx, y: a.in.y + dy };
								if (a.out && !mine.some((p) => p.part === 'out')) next.out = { x: a.out.x + dx, y: a.out.y + dy };
							}
							for (const part of ['in', 'out'] as const) {
								const h = mine.find((p) => p.part === part);
								if (!h) continue;
								const q = toLocal({ x: x[h.off], y: x[h.off + 1] });
								next[part] = Math.hypot(q.x - next.x, q.y - next.y) < 1e-9 ? null : q;
								if (!next[part]) delete next[part];
							}
							return next;
						})
					};
				});
			}
			if (subpaths !== loc.node.subpaths) changed.set(nodeId, { ...loc.node, subpaths });
		}
		if (!changed.size) return doc;
		const map = (list: VectorNode[]): VectorNode[] =>
			list.map((n) => {
				const c = changed.get(n.id);
				if (c) return c;
				if (n.type === 'group') {
					const children = map(n.children);
					return children.some((ch, i) => ch !== n.children[i]) ? { ...n, children } : n;
				}
				return n;
			});
		return { ...doc, nodes: map(doc.nodes) };
	}
}

// ---------------------------------------------------------------------------
// Residuals
// ---------------------------------------------------------------------------

interface Built {
	id: string;
	kind: VectorConstraintKind;
	refs: VectorGeomRef[];
	rows: number;
	/** Fix: parameters locked instead of rows. */
	locks: number[];
	eval(x: readonly number[], out: number[]): void;
	/** The current value of a dimensional constraint (degrees for angles). */
	measure?(x: readonly number[]): number;
}

const pt = (x: readonly number[], i: number): Vec2 => ({ x: x[i], y: x[i + 1] });

/** The point of a cubic's curvature: (2/3)·cross(P1 − P0, P2 − P1) / |P1 − P0|³ at its start. */
function startCurvature(p0: Vec2, p1: Vec2, p2: Vec2): number {
	const d = sub(p1, p0);
	const l = len(d);
	return l > 1e-9 ? ((2 / 3) * cross(d, sub(p2, p1))) / (l * l * l) : 0;
}

/**
 * Interprets a constraint against the model (allocating its parameters), deciding orientations from
 * the starting geometry. Throws a `VectorConstraintError` saying what references it needs.
 */
function interpret(c: VectorConstraint, m: Model, target: number): Built {
	const refs = c.refs;
	const n = refs.length;
	const need = (what: string): never => {
		throw new VectorConstraintError(`${c.kind} needs ${what}.`, [c.id]);
	};
	const x0 = m.x0;
	const P = (i: number) => (i < n ? m.point(refs[i]) : null);
	const L = (i: number) => (i < n ? m.line(refs[i]) : null);
	const C = (i: number) => (i < n ? m.circle(refs[i]) : null);
	const base = { id: c.id, kind: c.kind, refs, locks: [] as number[] };
	const rowsOf = (rows: number, f: (x: readonly number[], out: number[]) => void, measure?: (x: readonly number[]) => number): Built => ({ ...base, rows, eval: f, ...(measure ? { measure } : {}) });
	const lineDir = (x: readonly number[], l: [number, number]) => sub(pt(x, l[1]), pt(x, l[0]));
	switch (c.kind) {
		case 'fix': {
			if (!n) need('one or more references');
			const locks = refs.flatMap((r) => m.lockIndices(r));
			if (locks.length < refs.length * 2) need('anchors, segments or circles that exist');
			return { ...base, rows: 0, locks, eval: () => {} };
		}
		case 'coincident': {
			if (n !== 2) need('two references');
			const a = P(0);
			const b = P(1);
			if (a !== null && b !== null) return rowsOf(2, (x, out) => out.push(x[a] - x[b], x[a + 1] - x[b + 1]));
			for (const [pi, li] of [
				[0, 1],
				[1, 0]
			]) {
				const p = P(pi);
				const l = L(li);
				if (p !== null && l) return rowsOf(1, (x, out) => out.push(cross(unit(lineDir(x, l)), sub(pt(x, p), pt(x, l[0])))));
				const ci = C(li);
				if (p !== null && ci !== null && !refs[pi].circle) return rowsOf(1, (x, out) => out.push(len(sub(pt(x, p), pt(x, ci))) - x[ci + 2]));
			}
			return need('two points, a point and a segment, or a point and a circle');
		}
		case 'collinear': {
			const a = L(0);
			const b = L(1);
			if (n !== 2 || !a || !b) need('two segments');
			return rowsOf(2, (x, out) => {
				const d = unit(lineDir(x, a!));
				out.push(cross(d, sub(pt(x, b![0]), pt(x, a![0]))), cross(d, sub(pt(x, b![1]), pt(x, a![0]))));
			});
		}
		case 'concentric': {
			if (n !== 2) need('two circles, or a circle and a point');
			const a = C(0) ?? P(0);
			const b = C(1) ?? P(1);
			if (a === null || b === null || (C(0) === null && C(1) === null)) need('two circles, or a circle and a point');
			return rowsOf(2, (x, out) => out.push(x[a!] - x[b!], x[a! + 1] - x[b! + 1]));
		}
		case 'parallel':
		case 'perpendicular': {
			const a = L(0);
			const b = L(1);
			if (n !== 2 || !a || !b) need('two segments');
			// In length units (the second segment's), so the tolerance means the same as for points.
			return rowsOf(1, (x, out) => {
				const u = unit(lineDir(x, a!));
				const v = lineDir(x, b!);
				out.push(c.kind === 'parallel' ? cross(u, v) : dot(u, v));
			});
		}
		case 'horizontal':
		case 'vertical': {
			const axis = c.kind === 'horizontal' ? 1 : 0;
			const l = n === 1 ? L(0) : null;
			if (l) return rowsOf(1, (x, out) => out.push(x[l[1] + axis] - x[l[0] + axis]));
			const a = P(0);
			const b = P(1);
			if (n === 2 && a !== null && b !== null) return rowsOf(1, (x, out) => out.push(x[b + axis] - x[a + axis]));
			return need('a segment or two points');
		}
		case 'tangent': {
			if (n === 1) {
				const j = m.joint(refs[0]);
				if (!j) need('an anchor with a segment on each side, a segment and a circle, or two circles');
				// The handles point away from each other through the anchor (in the out handle's length).
				return rowsOf(1, (x, out) => out.push(cross(unit(sub(pt(x, j!.inc[3]), pt(x, j!.inc[2]))), sub(pt(x, j!.out[1]), pt(x, j!.out[0])))));
			}
			if (n !== 2) need('a segment and a circle, two circles, or one anchor');
			for (const [li, ci] of [
				[0, 1],
				[1, 0]
			]) {
				const l = L(li);
				const cc = C(ci);
				if (l && cc !== null) {
					const sign = Math.sign(cross(unit(lineDir(x0, l)), sub(pt(x0, cc), pt(x0, l[0])))) || 1;
					return rowsOf(1, (x, out) => out.push(sign * cross(unit(lineDir(x, l)), sub(pt(x, cc), pt(x, l[0]))) - x[cc + 2]));
				}
			}
			const a = C(0);
			const b = C(1);
			if (a !== null && b !== null) {
				const d0 = len(sub(pt(x0, a), pt(x0, b)));
				const inside = d0 < Math.max(x0[a + 2], x0[b + 2]);
				return rowsOf(1, (x, out) => out.push(len(sub(pt(x, a), pt(x, b))) - (inside ? Math.abs(x[a + 2] - x[b + 2]) : x[a + 2] + x[b + 2])));
			}
			return need('a segment and a circle, two circles, or one anchor');
		}
		case 'smooth': {
			const j = n === 1 ? m.joint(refs[0]) : null;
			if (!j) need('one anchor with a segment on each side');
			const scale = Math.max(1, len(sub(pt(x0, j!.inc[0]), pt(x0, j!.out[3]))));
			return rowsOf(2, (x, out) => {
				const [p0, p1, p2, p3] = j!.inc.map((i) => pt(x, i));
				const [q0, q1, q2] = j!.out.map((i) => pt(x, i));
				out.push(cross(unit(sub(p3, p2)), sub(q1, q0)));
				// Curvature where the incoming cubic ends (its reverse's start) and where the outgoing starts.
				const kin = -startCurvature(p3, p2, p1);
				const kout = startCurvature(q0, q1, q2);
				out.push((kin - kout) * scale);
				void p0;
			});
		}
		case 'symmetric': {
			const a = P(0);
			const b = P(1);
			const l = L(2);
			if (n !== 3 || a === null || b === null || !l) need('two points and a segment (the axis)');
			return rowsOf(2, (x, out) => {
				const d = unit(lineDir(x, l!));
				const p = pt(x, a!);
				const q = pt(x, b!);
				const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
				out.push(cross(d, sub(mid, pt(x, l![0]))), dot(d, sub(q, p)));
			});
		}
		case 'equal': {
			if (n !== 2) need('two segments or two circles');
			const la = L(0);
			const lb = L(1);
			if (la && lb) return rowsOf(1, (x, out) => out.push(len(lineDir(x, la)) - len(lineDir(x, lb))));
			const ca = C(0);
			const cb = C(1);
			if (ca !== null && cb !== null) return rowsOf(1, (x, out) => out.push(x[ca + 2] - x[cb + 2]));
			return need('two segments or two circles');
		}
		case 'distance': {
			const axis = c.axis ?? 'aligned';
			let a: number | null = null;
			let b: number | null = null;
			if (n === 1) {
				const l = L(0);
				if (l) [a, b] = l;
			} else if (n === 2) {
				a = P(0);
				b = P(1);
				const l = a === null ? L(0) : L(1);
				const p = a === null ? P(1) : P(0);
				if ((a === null || b === null) && l && p !== null && axis === 'aligned') {
					const sign = Math.sign(cross(unit(lineDir(x0, l)), sub(pt(x0, p), pt(x0, l[0])))) || 1;
					const f = (x: readonly number[]) => sign * cross(unit(lineDir(x, l)), sub(pt(x, p), pt(x, l[0])));
					return rowsOf(1, (x, out) => out.push(f(x) - target), f);
				}
			}
			if (a === null || b === null) need('a segment, two points, or a point and a segment');
			if (axis === 'aligned') {
				const f = (x: readonly number[]) => len(sub(pt(x, b!), pt(x, a!)));
				return rowsOf(1, (x, out) => out.push(f(x) - target), f);
			}
			const k = axis === 'horizontal' ? 0 : 1;
			const sign = Math.sign(x0[b! + k] - x0[a! + k]) || 1;
			const f = (x: readonly number[]) => sign * (x[b! + k] - x[a! + k]);
			return rowsOf(1, (x, out) => out.push(f(x) - target), f);
		}
		case 'angle': {
			const a = L(0);
			const b = L(1);
			if (n !== 2 || !a || !b) need('two segments');
			const ang = (x: readonly number[]) => {
				const u = lineDir(x, a!);
				const v = lineDir(x, b!);
				return Math.atan2(cross(u, v), dot(u, v));
			};
			const sign = Math.sign(ang(x0)) || 1;
			const rad = (target * Math.PI) / 180;
			// Radians times the segments' size: an arc length, like the other rows.
			const size = Math.max(1, (len(lineDir(x0, a!)) + len(lineDir(x0, b!))) / 2);
			return rowsOf(
				1,
				(x, out) => out.push(wrap(ang(x) - sign * rad) * size),
				(x) => (Math.abs(ang(x)) * 180) / Math.PI
			);
		}
		case 'radius':
		case 'diameter': {
			const cc = n === 1 ? C(0) : null;
			if (cc === null) need('one circle (a round closed path)');
			const k = c.kind === 'radius' ? 1 : 2;
			if (!(target > 0)) throw new VectorConstraintError(`${c.kind} must be positive, got ${target}.`, [c.id]);
			const f = (x: readonly number[]) => k * x[cc! + 2];
			return rowsOf(1, (x, out) => out.push(f(x) - target), f);
		}
	}
	return need('a known kind');
}

// ---------------------------------------------------------------------------
// Parameters and values
// ---------------------------------------------------------------------------

/** The expression environment: the document's parameters and named dimensional constraints. */
export function vectorConstraintEnv(doc: VectorDocument): VectorExprEnv {
	const env = new VectorExprEnv();
	for (const p of doc.parameters ?? []) env.set(p.name, p.value);
	for (const c of doc.constraints ?? []) if (c.name && c.value !== undefined && VECTOR_DIMENSIONAL_KINDS.has(c.kind)) env.set(c.name, c.value);
	return env;
}

/** The value of a dimensional constraint (degrees for angles). */
export function vectorConstraintValue(env: VectorExprEnv, c: VectorConstraint): number {
	if (c.value === undefined || c.value === '') throw new VectorConstraintError(`${c.kind} needs a value.`, [c.id]);
	try {
		return c.name && env.has(c.name) ? env.value(c.name) : env.eval(c.value);
	} catch (e) {
		throw new VectorConstraintError(`${c.name ?? c.kind}: ${e instanceof Error ? e.message : String(e)}`, [c.id]);
	}
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

class Comp {
	constructor(
		readonly model: Model,
		readonly built: Built[],
		readonly weights: number[],
		readonly tol: number
	) {}

	free(skip: number | null = null): number[] {
		const locked = new Set<number>();
		this.built.forEach((b, i) => {
			if (i !== skip) for (const j of b.locks) locked.add(j);
		});
		return this.model.x0.map((_, i) => i).filter((i) => !locked.has(i));
	}

	rows(skip: number | null = null): number {
		return this.built.reduce((s, b, i) => s + (i === skip ? 0 : b.rows), 0);
	}

	evalFn(skip: number | null = null): ResidualFn {
		return (x, out) => {
			this.built.forEach((b, i) => {
				if (i !== skip) b.eval(x, out);
			});
		};
	}

	run(skip: number | null = null) {
		const free = this.free(skip);
		const rows = this.rows(skip);
		if (rows > MAX_ROWS || rows * rows * free.length > 4e8) throw new VectorConstraintError('The constraint system is too large to solve.');
		return solveLm(this.evalFn(skip), this.model.x0, free, this.weights, this.tol, MAX_ITER);
	}

	/** Constraint ids in conflict: each one whose removal makes the rest solvable. */
	conflicts(failed: readonly number[]): string[] {
		const ids: string[] = [];
		if (this.built.length <= MAX_CONFLICT_PROBES) {
			this.built.forEach((b, i) => {
				try {
					if (this.run(i).converged) ids.push(b.id);
				} catch {
					/* too large */
				}
			});
		}
		if (!ids.length) {
			for (const b of this.built) {
				const out: number[] = [];
				b.eval(failed, out);
				if (maxAbs(out) > this.tol * 10) ids.push(b.id);
			}
		}
		return ids;
	}
}

const scaleTol = (x: readonly number[]) => 1e-9 * x.reduce((m, v) => Math.max(m, Math.abs(v)), 1);

/** A key per thing a reference touches (for grouping constraints into components). */
function refKeys(r: VectorGeomRef): string[] {
	return r.circle ? [`${r.nodeId}#circle`] : [`${r.nodeId}#${r.anchor ?? ''}`];
}

function components(cons: readonly VectorConstraint[]): VectorConstraint[][] {
	const parent = cons.map((_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	const owner = new Map<string, number>();
	cons.forEach((c, i) => {
		// A joint (tangent / smooth at an anchor) and a node's circle reach the whole path.
		const keys = c.refs.flatMap((r) => (c.kind === 'tangent' || c.kind === 'smooth' || r.circle ? [`${r.nodeId}`] : refKeys(r).concat(r.segment ? [`${r.nodeId}`] : [])));
		for (const k of [...keys, ...c.refs.map((r) => r.nodeId)]) {
			const j = owner.get(k);
			if (j === undefined) owner.set(k, i);
			else parent[find(i)] = find(j);
		}
	});
	const groups = new Map<number, VectorConstraint[]>();
	cons.forEach((c, i) => {
		const r = find(i);
		groups.set(r, [...(groups.get(r) ?? []), c]);
	});
	return [...groups.values()];
}

interface BuildResult {
	comps: Comp[];
	skipped: { id: string; message: string }[];
}

/**
 * Builds the component systems. `previous` is the last solved document: parameters that differ
 * from it were just edited and get a heavy weight, so the solve moves them least.
 */
function build(doc: VectorDocument, cons: readonly VectorConstraint[], previous: VectorDocument | null): BuildResult {
	const located = locateNodes(doc);
	const before = previous ? locateNodes(previous) : null;
	const env = vectorConstraintEnv(doc);
	const skipped: BuildResult['skipped'] = [];
	const comps: Comp[] = [];
	for (const group of components(cons)) {
		const model = new Model(located);
		const built: Built[] = [];
		for (const c of group) {
			try {
				const target = VECTOR_DIMENSIONAL_KINDS.has(c.kind) ? vectorConstraintValue(env, c) : 0;
				built.push(interpret(c, model, target));
			} catch (e) {
				skipped.push({ id: c.id, message: e instanceof Error ? e.message : String(e) });
			}
		}
		if (!built.length) continue;
		const weights = model.x0.map(() => 1);
		if (before) {
			// The same slots measured in the previous document: what moved since was just edited.
			const prev = new Model(before);
			for (const [key, slot] of model.slots) {
				let off: number | null = null;
				if (slot.kind === 'circle') off = prev.circleSlot(slot.nodeId)?.off ?? null;
				else {
					const loc = before.get(slot.nodeId);
					if (loc && loc.node.subpaths[slot.subpath]?.anchors[slot.index]) off = prev.pointSlot(loc, slot.subpath, slot.index, slot.part)?.off ?? null;
				}
				const k = slot.kind === 'circle' ? 3 : 2;
				for (let i = 0; i < k; i++) {
					const j = slot.off + i;
					if (off === null || Math.abs(prev.x0[off + i] - model.x0[j]) > 1e-9) weights[j] = 1e6;
				}
				void key;
			}
		}
		comps.push(new Comp(model, built, weights, scaleTol(model.x0)));
	}
	return { comps, skipped };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** What a solve did. */
export interface VectorSolveResult {
	/** The document with the solved geometry (the same object when nothing moved). */
	document: VectorDocument;
	/** Every component converged (every constraint holds). */
	converged: boolean;
	/** Constraints in conflict where a component did not converge. */
	conflicts: string[];
	/** Constraints that could not be interpreted (and were ignored), with the reason. */
	skipped: { id: string; message: string }[];
}

/**
 * Solves the document's constraints and writes the geometry back. `previous` (the last solved
 * document) marks what was just edited, which moves least. A component that cannot be solved is
 * left with its best compromise and reported in `conflicts`.
 */
export function solveVectorConstraints(doc: VectorDocument, previous: VectorDocument | null = null): VectorSolveResult {
	const cons = (doc.constraints ?? []).slice(0, VECTOR_MAX_CONSTRAINTS);
	if (!cons.length) return { document: doc, converged: true, conflicts: [], skipped: [] };
	const { comps, skipped } = build(doc, cons, previous);
	let out = doc;
	let converged = true;
	const conflicts: string[] = [];
	for (const comp of comps) {
		let o;
		try {
			o = comp.run();
		} catch {
			converged = false;
			conflicts.push(...comp.built.map((b) => b.id));
			continue;
		}
		if (!o.converged) {
			converged = false;
			conflicts.push(...comp.conflicts(o.x));
		}
		// Nothing moved: keep the document object.
		if (o.x.some((v, i) => Math.abs(v - comp.model.x0[i]) > 1e-12)) out = comp.model.writeBack(out, o.x);
	}
	return { document: out, converged, conflicts, skipped };
}

/** The largest residual of each constraint at the current geometry (null when it cannot be interpreted). */
export function vectorConstraintResiduals(doc: VectorDocument): Map<string, number | null> {
	const out = new Map<string, number | null>();
	const env = vectorConstraintEnv(doc);
	const located = locateNodes(doc);
	for (const c of doc.constraints ?? []) {
		try {
			const model = new Model(located);
			const target = VECTOR_DIMENSIONAL_KINDS.has(c.kind) ? vectorConstraintValue(env, c) : 0;
			const b = interpret(c, model, target);
			const r: number[] = [];
			b.eval(model.x0, r);
			out.set(c.id, maxAbs(r));
		} catch {
			out.set(c.id, null);
		}
	}
	return out;
}

/** The current value of a dimensional constraint's references (degrees for angles). */
export function measureVectorConstraint(doc: VectorDocument, c: Pick<VectorConstraint, 'kind' | 'refs' | 'axis'>): number {
	const model = new Model(locateNodes(doc));
	const b = interpret({ id: '', ...c, value: '1' }, model, 1);
	if (!b.measure) throw new VectorConstraintError(`${c.kind} has no value to measure.`);
	return b.measure(model.x0);
}

/** Checks a constraint's references against the document (throws with what is needed). */
export function validateVectorConstraint(doc: VectorDocument, c: VectorConstraint): void {
	for (const r of c.refs) {
		const loc = locateNodes(doc).get(r.nodeId);
		if (!loc) throw new VectorConstraintError(`There is no path "${r.nodeId}" (constraints refer to paths, not groups or text).`, [c.id]);
		if (r.anchor && !findVectorAnchorById(loc.node, r.anchor)) throw new VectorConstraintError(`Path "${r.nodeId}" has no anchor "${r.anchor}".`, [c.id]);
		if (r.circle && !vectorPathCircle(loc.node, loc.world)) throw new VectorConstraintError(`Path "${r.nodeId}" is not round enough to be a circle.`, [c.id]);
	}
	interpret(c, new Model(locateNodes(doc)), VECTOR_DIMENSIONAL_KINDS.has(c.kind) ? 1 : 0);
}

/** Next free name for a dimensional constraint (`d1`, `ang2`, `rad1`, `dia1`). */
export function nextVectorConstraintName(doc: VectorDocument, kind: VectorConstraintKind): string {
	const prefix = kind === 'angle' ? 'ang' : kind === 'radius' ? 'rad' : kind === 'diameter' ? 'dia' : 'd';
	const used = new Set([...(doc.parameters ?? []).map((p) => p.name), ...(doc.constraints ?? []).map((c) => c.name ?? '')]);
	for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/**
 * Adds a constraint to the document: names and measures a dimensional one without a value,
 * refuses one that conflicts with the others or duplicates them (over-constrains), solves and
 * returns the new document. Throws a `VectorConstraintError` naming the constraints involved.
 */
export function addVectorConstraint(doc: VectorDocument, input: VectorConstraint): VectorDocument {
	if ((doc.constraints?.length ?? 0) >= VECTOR_MAX_CONSTRAINTS) throw new VectorConstraintError('Too many constraints.');
	let c: VectorConstraint = { ...input, refs: input.refs.map((r) => ({ ...r })) };
	validateVectorConstraint(doc, c);
	if (VECTOR_DIMENSIONAL_KINDS.has(c.kind)) {
		const name = c.name ?? nextVectorConstraintName(doc, c.kind);
		if (!isValidVectorParameterName(name)) throw new VectorConstraintError(`"${name}" is not a valid name: a letter or _ then letters, digits or _.`);
		if ([...(doc.parameters ?? []), ...(doc.constraints ?? [])].some((p) => p.name === name)) throw new VectorConstraintError(`The name "${name}" is already used.`);
		c = { ...c, name, value: c.value?.trim() ? c.value.trim() : formatVectorValue(measureVectorConstraint(doc, c)) };
	} else {
		delete c.name;
		delete c.value;
	}
	const trial: VectorDocument = { ...doc, constraints: [...(doc.constraints ?? []), c] };
	const { comps, skipped } = build(trial, trial.constraints!, null);
	const own = skipped.find((s) => s.id === c.id);
	if (own) throw new VectorConstraintError(own.message, [c.id]);
	const comp = comps.find((k) => k.built.some((b) => b.id === c.id));
	if (!comp) throw new VectorConstraintError('The constraint could not be interpreted.', [c.id]);
	const o = comp.run();
	if (!o.converged) {
		const ids = comp.conflicts(o.x).filter((i) => i !== c.id);
		throw new VectorConstraintError(`The constraint conflicts with ${ids.length ? ids.map((i) => `"${i}"`).join(', ') : 'the existing constraints'}.`, [c.id, ...ids]);
	}
	const pos = comp.built.findIndex((b) => b.id === c.id);
	const nb = comp.built[pos];
	if (nb.rows > 0) {
		// The new rows must raise the rank, or they only repeat what is already there.
		const free = comp.free();
		const others = comp.built.filter((b) => b.id !== c.id);
		const ordered = [...others, nb];
		const f: ResidualFn = (x, out) => ordered.forEach((b) => b.eval(x, out));
		const rowsAll = ordered.reduce((s, b) => s + b.rows, 0);
		const rowsOld = rowsAll - nb.rows;
		const jac = jacobian(f, o.x, free, rowsAll);
		if (rankQr(jac, rowsAll, free.length) < rankQr(jac.subarray(0, rowsOld * free.length), rowsOld, free.length) + nb.rows) {
			const mine = new Set(nb.refs.map((r) => r.nodeId));
			const ids = others.filter((b) => b.refs.some((r) => mine.has(r.nodeId))).map((b) => b.id);
			throw new VectorConstraintError(`The constraint would over-constrain the geometry (redundant with ${ids.length ? ids.map((i) => `"${i}"`).join(', ') : 'existing constraints'}).`, [c.id, ...ids]);
		}
	} else if (nb.locks.length) {
		const before = comp.free(pos);
		const after = new Set(comp.free());
		const locked = before.map((j, k) => [j, k] as const).filter(([j]) => !after.has(j));
		const rowsOld = comp.rows(pos);
		const nf = before.length;
		const jac = Array.from(jacobian(comp.evalFn(pos), o.x, before, rowsOld));
		const rOld = rankQr(Float64Array.from(jac), rowsOld, nf);
		for (const [, k] of locked) for (let col = 0; col < nf; col++) jac.push(col === k ? 1 : 0);
		if (!locked.length || rankQr(Float64Array.from(jac), rowsOld + locked.length, nf) < rOld + locked.length) {
			const mine = new Set(nb.refs.map((r) => r.nodeId));
			const ids = comp.built.filter((b) => b.id !== c.id && b.refs.some((r) => mine.has(r.nodeId))).map((b) => b.id);
			throw new VectorConstraintError(`The Fix would over-constrain the geometry (redundant with ${ids.map((i) => `"${i}"`).join(', ') || 'existing constraints'}).`, [c.id, ...ids]);
		}
	}
	return comp.model.writeBack(trial, o.x);
}

/** Constraint state of the drawing or a part of it. */
export type VectorDofStatus = 'unconstrained' | 'under' | 'fully' | 'over' | 'unknown';

export interface VectorDofReport {
	/** Remaining degrees of freedom (null when too large to analyse). */
	dof: number | null;
	status: VectorDofStatus;
	/** Equations that only repeat others. */
	redundant: number;
	constraints: number;
	/** Per constrained path: its parameters and remaining freedom. */
	nodes: { nodeId: string; params: number; dof: number | null; status: VectorDofStatus }[];
	message: string;
}

/** Degrees of freedom the constraints leave (QR rank of the Jacobian per component; per path by null space). */
export function vectorConstraintDof(doc: VectorDocument): VectorDofReport {
	const cons = doc.constraints ?? [];
	if (!cons.length) return { dof: 0, status: 'unconstrained', redundant: 0, constraints: 0, nodes: [], message: 'No constraints' };
	const { comps } = build(doc, cons, null);
	let total: number | null = 0;
	let redundant = 0;
	let count = 0;
	const nodes = new Map<string, { params: number; dof: number | null; over: boolean }>();
	for (const comp of comps) {
		const free = comp.free();
		const rows = comp.rows();
		count += comp.built.length;
		const nf = free.length;
		if (rows > MAX_ROWS) {
			total = null;
			continue;
		}
		const jac = jacobian(comp.evalFn(), comp.model.x0, free, rows);
		const { rank, basis } = nullSpace(jac, rows, nf);
		const red = Math.max(0, rows - rank);
		redundant += red;
		if (total !== null) total += nf - Math.min(rank, nf);
		for (const slot of comp.model.slots.values()) {
			const k = slot.kind === 'circle' ? 3 : 2;
			const cols: number[] = [];
			free.forEach((j, c) => {
				if (j >= slot.off && j < slot.off + k) cols.push(c);
			});
			const e = nodes.get(slot.nodeId) ?? { params: 0, dof: 0, over: false };
			e.params += k;
			if (e.dof !== null) e.dof += cols.length && basis.length ? qr(basis.map((v) => cols.map((c) => v[c])), 0, 1e-6).rank : 0;
			e.over ||= red > 0;
			nodes.set(slot.nodeId, e);
		}
	}
	const status: VectorDofStatus = redundant > 0 ? 'over' : total === null ? 'unknown' : total === 0 ? 'fully' : 'under';
	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	const message =
		status === 'over' ? `Over-constrained: ${plural(redundant, 'redundant equation', 'redundant equations')}` : status === 'fully' ? 'Fully constrained' : total === null ? 'Too large to analyse' : `${plural(total, 'degree of freedom', 'degrees of freedom')} remaining`;
	return {
		dof: total,
		status,
		redundant,
		constraints: count,
		nodes: [...nodes].map(([nodeId, e]) => ({ nodeId, params: e.params, dof: e.dof, status: e.over ? 'over' : e.dof === 0 ? 'fully' : e.dof === null ? 'unknown' : 'under' })),
		message
	};
}

/** Constraints whose references are gone (deleted paths or anchors) or no longer fit, removed. */
export function purgeVectorConstraints(doc: VectorDocument): { document: VectorDocument; removed: string[] } {
	const cons = doc.constraints;
	if (!cons?.length) return { document: doc, removed: [] };
	const located = locateNodes(doc);
	const removed: string[] = [];
	const kept = cons.filter((c) => {
		const ok = c.refs.every((r) => {
			const loc = located.get(r.nodeId);
			if (!loc) return false;
			if (!r.anchor) return !r.circle || !!vectorPathCircle(loc.node, loc.world);
			const at = findVectorAnchorById(loc.node, r.anchor);
			if (!at) return false;
			// A segment needs the anchor after it.
			const sp = loc.node.subpaths[at.subpath];
			return !r.segment || (sp.anchors.length > 1 && (at.index + 1 < sp.anchors.length || sp.closed));
		});
		if (!ok) removed.push(c.id);
		return ok;
	});
	return removed.length ? { document: { ...doc, constraints: kept }, removed } : { document: doc, removed };
}

export { VectorExprError };
