// Portions ported from cadcraft/crates/constraints/src/auto.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Auto-constrain: constraints a sketch already nearly satisfies, inferred within tolerances and
 * added one by one (refused ones skipped), most important first: coincident points of different
 * paths, concentric and tangent circles, a segment tangent to a circle, horizontal and vertical
 * segments, collinear, perpendicular (connected) and parallel segment pairs, equal lengths and radii.
 */

import { applyMatrix, multiplyMatrices, IDENTITY_MATRIX } from '../../geom/affine.js';
import type { AffineMatrix } from '../../geom/types.js';
import { addVectorConstraint, vectorPathCircle, VectorConstraintError } from './solve.js';
import type { Vec2, VectorConstraint, VectorConstraintKind, VectorDocument, VectorGeomRef, VectorNode, VectorPathNode } from '../types.js';

export interface VectorInferOptions {
	/** Document units (default 0.5). */
	distanceTolerance?: number;
	/** Degrees (default 1). */
	angleTolerance?: number;
	/** Kinds to infer (default all of them). */
	kinds?: readonly VectorConstraintKind[];
}

/** Most candidates returned. */
const MAX_CANDIDATES = 2000;

/** The path with every anchor given a stable id (`a1`, `a2`, …; existing ids kept). */
export function withVectorAnchorIds(node: VectorPathNode): VectorPathNode {
	if (node.subpaths.every((sp) => sp.anchors.every((a) => a.id))) return node;
	let n = 0;
	for (const sp of node.subpaths) for (const a of sp.anchors) if (a.id && /^a\d+$/.test(a.id)) n = Math.max(n, Number(a.id.slice(1)));
	const used = new Set(node.subpaths.flatMap((sp) => sp.anchors.map((a) => a.id).filter(Boolean)));
	const next = () => {
		let id = `a${++n}`;
		while (used.has(id)) id = `a${++n}`;
		used.add(id);
		return id;
	};
	return { ...node, subpaths: node.subpaths.map((sp) => ({ ...sp, anchors: sp.anchors.map((a) => (a.id ? a : { ...a, id: next() })) })) };
}

/** The document with every anchor of the paths `ids` (all paths when absent) given an id. */
export function withVectorDocumentAnchorIds(doc: VectorDocument, ids?: ReadonlySet<string>): VectorDocument {
	let changed = false;
	const map = (list: VectorNode[]): VectorNode[] =>
		list.map((n) => {
			if (n.type === 'path' && (!ids || ids.has(n.id))) {
				const next = withVectorAnchorIds(n);
				if (next !== n) changed = true;
				return next;
			}
			if (n.type === 'group') {
				const children = map(n.children);
				return children.some((c, i) => c !== n.children[i]) ? { ...n, children } : n;
			}
			return n;
		});
	const nodes = map(doc.nodes);
	return changed ? { ...doc, nodes } : doc;
}

interface Geo {
	points: { ref: VectorGeomRef; p: Vec2 }[];
	lines: { ref: VectorGeomRef; a: Vec2; b: Vec2 }[];
	circles: { ref: VectorGeomRef; c: Vec2; r: number }[];
}

function collect(doc: VectorDocument, ids: ReadonlySet<string> | null): Geo {
	const g: Geo = { points: [], lines: [], circles: [] };
	const visit = (list: readonly VectorNode[], parent: AffineMatrix, inside: boolean) => {
		for (const n of list) {
			const m = n.transform ? multiplyMatrices(n.transform as AffineMatrix, parent) : parent;
			const picked = inside || !ids || ids.has(n.id);
			if (n.type === 'group') visit(n.children, m, picked);
			if (n.type !== 'path' || !picked) continue;
			const circle = vectorPathCircle(n, m);
			if (circle && n.subpaths.length === 1) {
				g.circles.push({ ref: { nodeId: n.id, circle: true }, ...circle });
				continue;
			}
			for (const sp of n.subpaths) {
				const pts = sp.anchors.map((a) => applyMatrix(m, a));
				sp.anchors.forEach((a, i) => g.points.push({ ref: { nodeId: n.id, anchor: a.id! }, p: pts[i] }));
				const segs = sp.closed ? sp.anchors.length : sp.anchors.length - 1;
				for (let i = 0; i < segs; i++) {
					const a = sp.anchors[i];
					const b = sp.anchors[(i + 1) % sp.anchors.length];
					// Straight segments only (no handles off their anchors).
					const straight = (!a.out || (a.out.x === a.x && a.out.y === a.y)) && (!b.in || (b.in.x === b.x && b.in.y === b.y));
					if (straight && sp.anchors.length > 1) g.lines.push({ ref: { nodeId: n.id, anchor: a.id!, segment: true }, a: pts[i], b: pts[(i + 1) % pts.length] });
				}
			}
		}
	};
	visit(doc.nodes, IDENTITY_MATRIX, false);
	g.points.splice(1000);
	g.lines.splice(1000);
	g.circles.splice(1000);
	return g;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
/** Acute angle between two directions, radians in [0, π/2]. */
const angleBetween = (u: Vec2, v: Vec2) => {
	const a = Math.abs(Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y));
	return a > Math.PI / 2 ? Math.PI - a : a;
};
const lineDist = (a: Vec2, b: Vec2, p: Vec2) => {
	const l = dist(a, b);
	return l > 1e-12 ? Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / l : dist(a, p);
};

/**
 * Candidate constraints the paths `ids` (default all) nearly satisfy, most important first. Their
 * anchors need ids (`withVectorDocumentAnchorIds`); candidates have ids `auto-<n>`.
 */
export function inferVectorConstraints(doc: VectorDocument, ids: readonly string[] | null = null, options: VectorInferOptions = {}): VectorConstraint[] {
	const tol = Math.max(0, options.distanceTolerance ?? 0.5);
	const atol = (Math.max(0, Math.min(45, options.angleTolerance ?? 1)) * Math.PI) / 180;
	const allow = (k: VectorConstraintKind) => !options.kinds || options.kinds.includes(k);
	const g = collect(doc, ids ? new Set(ids) : null);
	const out: VectorConstraint[] = [];
	const push = (kind: VectorConstraintKind, refs: VectorGeomRef[]) => {
		if (out.length < MAX_CANDIDATES && allow(kind)) out.push({ id: `auto-${out.length + 1}`, kind, refs });
	};
	for (let i = 0; i < g.points.length; i++)
		for (let j = i + 1; j < g.points.length; j++) {
			const a = g.points[i];
			const b = g.points[j];
			if (a.ref.nodeId !== b.ref.nodeId && dist(a.p, b.p) <= tol) push('coincident', [a.ref, b.ref]);
		}
	for (let i = 0; i < g.circles.length; i++)
		for (let j = i + 1; j < g.circles.length; j++) {
			const a = g.circles[i];
			const b = g.circles[j];
			const d = dist(a.c, b.c);
			if (d <= tol) push('concentric', [a.ref, b.ref]);
			else if (Math.abs(d - (a.r + b.r)) <= tol || Math.abs(d - Math.abs(a.r - b.r)) <= tol) push('tangent', [a.ref, b.ref]);
		}
	for (const l of g.lines)
		for (const c of g.circles) {
			if (l.ref.nodeId === c.ref.nodeId) continue;
			const d = { x: l.b.x - l.a.x, y: l.b.y - l.a.y };
			const ll = d.x * d.x + d.y * d.y;
			const t = ll > 0 ? ((c.c.x - l.a.x) * d.x + (c.c.y - l.a.y) * d.y) / ll : -1;
			if (Math.abs(lineDist(l.a, l.b, c.c) - c.r) <= tol && t >= -1e-9 && t <= 1 + 1e-9 && Math.sqrt(ll) > tol) push('tangent', [l.ref, c.ref]);
		}
	for (const l of g.lines) {
		const d = { x: l.b.x - l.a.x, y: l.b.y - l.a.y };
		if (Math.hypot(d.x, d.y) <= tol) continue;
		if (angleBetween(d, { x: 1, y: 0 }) <= atol) push('horizontal', [l.ref]);
		else if (angleBetween(d, { x: 0, y: 1 }) <= atol) push('vertical', [l.ref]);
	}
	const connected = (a: Geo['lines'][number], b: Geo['lines'][number]) => [b.a, b.b].some((p) => dist(p, a.a) <= tol || dist(p, a.b) <= tol);
	const parallel: VectorGeomRef[][] = [];
	const equal: VectorGeomRef[][] = [];
	for (let i = 0; i < g.lines.length; i++)
		for (let j = i + 1; j < g.lines.length; j++) {
			const a = g.lines[i];
			const b = g.lines[j];
			const d1 = { x: a.b.x - a.a.x, y: a.b.y - a.a.y };
			const d2 = { x: b.b.x - b.a.x, y: b.b.y - b.a.y };
			const l1 = Math.hypot(d1.x, d1.y);
			const l2 = Math.hypot(d2.x, d2.y);
			if (l1 <= tol || l2 <= tol) continue;
			const ang = angleBetween(d1, d2);
			if (ang <= atol) {
				if (lineDist(a.a, a.b, b.a) <= tol && lineDist(a.a, a.b, b.b) <= tol) push('collinear', [a.ref, b.ref]);
				else parallel.push([a.ref, b.ref]);
			} else if (Math.abs(Math.PI / 2 - ang) <= atol && connected(a, b)) push('perpendicular', [a.ref, b.ref]);
			if (Math.abs(l1 - l2) <= tol) equal.push([a.ref, b.ref]);
		}
	for (const p of parallel) push('parallel', p);
	for (const p of equal) push('equal', p);
	for (let i = 0; i < g.circles.length; i++)
		for (let j = i + 1; j < g.circles.length; j++) if (Math.abs(g.circles[i].r - g.circles[j].r) <= tol) push('equal', [g.circles[i].ref, g.circles[j].ref]);
	return out;
}

/**
 * Auto-constrain: anchors of the paths given ids, the inferred constraints added one by one with
 * `newId` ids (each solved; refused ones, redundant or conflicting, skipped). Returns the document
 * and the constraints added.
 */
export function autoConstrainVector(doc: VectorDocument, ids: readonly string[] | null, newId: () => string, options: VectorInferOptions = {}): { document: VectorDocument; added: VectorConstraint[] } {
	let d = withVectorDocumentAnchorIds(doc, ids ? new Set(ids) : undefined);
	const added: VectorConstraint[] = [];
	for (const candidate of inferVectorConstraints(d, ids, options)) {
		const c = { ...candidate, id: newId() };
		try {
			d = addVectorConstraint(d, c);
			added.push(d.constraints![d.constraints!.length - 1]);
		} catch (e) {
			if (!(e instanceof VectorConstraintError)) throw e;
		}
	}
	return { document: d, added };
}
