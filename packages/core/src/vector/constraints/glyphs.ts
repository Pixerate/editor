/**
 * Where to draw constraint glyphs (document space), the constraints panel's data and the actions the
 * current selection allows. Framework-neutral, so React and Svelte draw the same thing.
 */

import { applyMatrix, multiplyMatrices, IDENTITY_MATRIX } from '../../geom/affine.js';
import type { AffineMatrix } from '../../geom/types.js';
import { findVectorAnchorById, vectorConstraintDof, vectorConstraintEnv, vectorConstraintResiduals, vectorConstraintValue, vectorPathCircle, VECTOR_DIMENSIONAL_KINDS, type VectorDofReport } from './solve.js';
import type { Vec2, VectorAnchorRef, VectorConstraint, VectorConstraintKind, VectorDocument, VectorGeomRef, VectorNode, VectorPathNode } from '../types.js';

/** Short glyphs per kind. */
export const VECTOR_CONSTRAINT_GLYPHS: Readonly<Record<VectorConstraintKind, string>> = {
	coincident: '●',
	collinear: '≡',
	concentric: '◎',
	fix: '⚓',
	parallel: '∥',
	perpendicular: '⊥',
	horizontal: 'H',
	vertical: 'V',
	tangent: 'T',
	smooth: 'G2',
	symmetric: '⇹',
	equal: '=',
	distance: '↔',
	angle: '∠',
	radius: 'R',
	diameter: 'Ø'
};

export const VECTOR_CONSTRAINT_LABELS: Readonly<Record<VectorConstraintKind, string>> = {
	coincident: 'Coincident',
	collinear: 'Collinear',
	concentric: 'Concentric',
	fix: 'Fix',
	parallel: 'Parallel',
	perpendicular: 'Perpendicular',
	horizontal: 'Horizontal',
	vertical: 'Vertical',
	tangent: 'Tangent',
	smooth: 'Smooth (G2)',
	symmetric: 'Symmetric',
	equal: 'Equal',
	distance: 'Distance',
	angle: 'Angle',
	radius: 'Radius',
	diameter: 'Diameter'
};

/** A constraint's glyph in document space. */
export interface VectorConstraintGlyph {
	id: string;
	kind: VectorConstraintKind;
	/** The glyph, or `name = value` for dimensional constraints. */
	label: string;
	/** Where to draw it (near the middle of what it refers to). */
	at: Vec2;
	/** The points it refers to (for a highlight). */
	points: Vec2[];
	/** A dimension line between two points (distances). */
	dimension: { a: Vec2; b: Vec2 } | null;
	satisfied: boolean;
}

function worlds(doc: VectorDocument): Map<string, { node: VectorPathNode; world: AffineMatrix }> {
	const out = new Map<string, { node: VectorPathNode; world: AffineMatrix }>();
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

/** The document-space points a reference stands for (a point, a segment's ends, a circle's centre). */
function refPoints(ref: VectorGeomRef, located: ReturnType<typeof worlds>): Vec2[] {
	const loc = located.get(ref.nodeId);
	if (!loc) return [];
	if (ref.circle) {
		const c = vectorPathCircle(loc.node, loc.world);
		return c ? [c.c] : [];
	}
	if (!ref.anchor) return [];
	const at = findVectorAnchorById(loc.node, ref.anchor);
	if (!at) return [];
	const sp = loc.node.subpaths[at.subpath];
	const a = sp.anchors[at.index];
	const p = ref.handle ? (a[ref.handle] ?? a) : a;
	const first = applyMatrix(loc.world, p);
	if (!ref.segment) return [first];
	const next = sp.anchors[(at.index + 1) % sp.anchors.length];
	return [first, applyMatrix(loc.world, next)];
}

/** Glyphs of the constraints that touch `nodeIds` (all when null), document space. */
export function vectorConstraintGlyphs(doc: VectorDocument, nodeIds: ReadonlySet<string> | null = null): VectorConstraintGlyph[] {
	const cons = (doc.constraints ?? []).filter((c) => !nodeIds || c.refs.some((r) => nodeIds.has(r.nodeId)));
	if (!cons.length) return [];
	const located = worlds(doc);
	const residuals = vectorConstraintResiduals(doc);
	const env = vectorConstraintEnv(doc);
	const scale = Math.max(doc.width, doc.height, 1);
	return cons.flatMap((c): VectorConstraintGlyph[] => {
		const groups = c.refs.map((r) => refPoints(r, located));
		const points = groups.flat();
		if (!points.length) return [];
		const mids = groups.map((g) => (g.length === 2 ? { x: (g[0].x + g[1].x) / 2, y: (g[0].y + g[1].y) / 2 } : g[0])).filter(Boolean);
		const at = { x: mids.reduce((s, p) => s + p.x, 0) / mids.length, y: mids.reduce((s, p) => s + p.y, 0) / mids.length };
		let label = VECTOR_CONSTRAINT_GLYPHS[c.kind];
		if (VECTOR_DIMENSIONAL_KINDS.has(c.kind)) {
			let v: number | null = null;
			try {
				v = vectorConstraintValue(env, c);
			} catch {
				v = null;
			}
			const shown = v === null ? '?' : `${Math.round(v * 100) / 100}${c.kind === 'angle' ? '°' : ''}`;
			label = `${c.name ?? label} = ${shown}`;
		}
		const r = residuals.get(c.id);
		const dimension = c.kind === 'distance' && points.length === 2 ? { a: points[0], b: points[1] } : null;
		return [{ id: c.id, kind: c.kind, label, at, points, dimension, satisfied: r !== null && r !== undefined && r <= 1e-6 * scale }];
	});
}

/** A constraint the selection allows, with its references ready for `addConstraint`. */
export interface VectorConstraintAction {
	kind: VectorConstraintKind;
	label: string;
	refs: { nodeId: string; subpath?: number; index?: number; segment?: boolean; circle?: boolean }[];
	/** Dimensional: it asks for a value (the current measure is the default). */
	dimensional: boolean;
}

/**
 * Constraints the selected anchors (direct tool) or paths allow: one anchor (fix, tangent and
 * smooth at it), two anchors (a segment when they are neighbours: horizontal, vertical, length,
 * fix; else coincident, horizontal, vertical, distance), three (a point and a segment: on its
 * line), four as two segments (parallel, perpendicular, equal, collinear, angle); one or two round
 * paths (radius, diameter, fix; concentric, equal, tangent).
 */
export function vectorConstraintActions(doc: VectorDocument, selection: { anchors: readonly VectorAnchorRef[]; nodes: readonly string[] }): VectorConstraintAction[] {
	const located = worlds(doc);
	const act = (kind: VectorConstraintKind, refs: VectorConstraintAction['refs']): VectorConstraintAction => ({ kind, label: VECTOR_CONSTRAINT_LABELS[kind], refs, dimensional: VECTOR_DIMENSIONAL_KINDS.has(kind) });
	const anchors = selection.anchors.filter((r) => located.get(r.nodeId)?.node.subpaths[r.subpath]?.anchors[r.index]);
	if (anchors.length) {
		const neighbours = (a: VectorAnchorRef, b: VectorAnchorRef) => {
			if (a.nodeId !== b.nodeId || a.subpath !== b.subpath) return null;
			const sp = located.get(a.nodeId)!.node.subpaths[a.subpath];
			const n = sp.anchors.length;
			if (b.index === a.index + 1 || (sp.closed && a.index === n - 1 && b.index === 0)) return a;
			if (a.index === b.index + 1 || (sp.closed && b.index === n - 1 && a.index === 0)) return b;
			return null;
		};
		const pointRef = (r: VectorAnchorRef) => ({ nodeId: r.nodeId, subpath: r.subpath, index: r.index });
		const segRef = (r: VectorAnchorRef) => ({ ...pointRef(r), segment: true });
		if (anchors.length === 1) return [act('fix', [pointRef(anchors[0])]), act('tangent', [pointRef(anchors[0])]), act('smooth', [pointRef(anchors[0])])];
		if (anchors.length === 2) {
			const start = neighbours(anchors[0], anchors[1]);
			if (start) return ['horizontal', 'vertical', 'distance', 'fix'].map((k) => act(k as VectorConstraintKind, [segRef(start)]));
			return ['coincident', 'horizontal', 'vertical', 'distance'].map((k) => act(k as VectorConstraintKind, anchors.map(pointRef)));
		}
		if (anchors.length === 3) {
			for (let i = 0; i < 3; i++) {
				const others = anchors.filter((_, k) => k !== i);
				const start = neighbours(others[0], others[1]);
				if (start) return [act('coincident', [pointRef(anchors[i]), segRef(start)]), act('distance', [pointRef(anchors[i]), segRef(start)])];
			}
			return [];
		}
		if (anchors.length === 4) {
			for (const [i, j, k, l] of [
				[0, 1, 2, 3],
				[0, 2, 1, 3],
				[0, 3, 1, 2]
			]) {
				const s1 = neighbours(anchors[i], anchors[j]);
				const s2 = neighbours(anchors[k], anchors[l]);
				if (s1 && s2) return ['parallel', 'perpendicular', 'equal', 'collinear', 'angle'].map((kind) => act(kind as VectorConstraintKind, [segRef(s1), segRef(s2)]));
			}
		}
		return [];
	}
	const circles = selection.nodes.filter((id) => {
		const loc = located.get(id);
		return loc && vectorPathCircle(loc.node, loc.world);
	});
	if (circles.length === 1 && selection.nodes.length === 1) return ['radius', 'diameter', 'fix'].map((k) => act(k as VectorConstraintKind, [{ nodeId: circles[0], circle: true }]));
	if (circles.length === 2 && selection.nodes.length === 2) return ['concentric', 'equal', 'tangent'].map((k) => act(k as VectorConstraintKind, circles.map((id) => ({ nodeId: id, circle: true }))));
	return [];
}

/** The constraints panel: degrees of freedom, constraints of the selection (all without one), actions, parameters. */
export interface VectorConstraintPanelData {
	dof: VectorDofReport;
	constraints: { id: string; kind: VectorConstraintKind; label: string; name?: string; value?: string; satisfied: boolean; conflict: boolean }[];
	actions: VectorConstraintAction[];
	parameters: { name: string; value: string; result: number | null; error: string | null }[];
}

export function vectorConstraintPanel(doc: VectorDocument, selection: { anchors: readonly VectorAnchorRef[]; nodes: readonly string[] }, conflicts: readonly string[] = []): VectorConstraintPanelData {
	const touched = new Set([...selection.nodes, ...selection.anchors.map((a) => a.nodeId)]);
	const glyphs = new Map(vectorConstraintGlyphs(doc, touched.size ? touched : null).map((g) => [g.id, g]));
	const env = vectorConstraintEnv(doc);
	const list = (doc.constraints ?? []).filter((c: VectorConstraint) => glyphs.has(c.id));
	return {
		dof: vectorConstraintDof(doc),
		constraints: list.map((c) => ({
			id: c.id,
			kind: c.kind,
			label: VECTOR_CONSTRAINT_LABELS[c.kind],
			...(c.name ? { name: c.name } : {}),
			...(c.value !== undefined ? { value: c.value } : {}),
			satisfied: glyphs.get(c.id)?.satisfied ?? false,
			conflict: conflicts.includes(c.id)
		})),
		actions: vectorConstraintActions(doc, selection),
		parameters: (doc.parameters ?? []).map((p) => {
			try {
				return { name: p.name, value: p.value, result: env.value(p.name), error: null };
			} catch (e) {
				return { name: p.name, value: p.value, result: null, error: e instanceof Error ? e.message : String(e) };
			}
		})
	};
}

/** The constraints panel for an editor state (selection: the direct tool's anchors, else the selected paths). */
export function getVectorConstraintPanel(state: { document: VectorDocument; selection: readonly string[]; selectedAnchors: readonly VectorAnchorRef[]; tool: string; constraintIssues: { conflicts: string[] } | null }): VectorConstraintPanelData {
	const anchors = state.tool === 'direct' ? state.selectedAnchors : [];
	return vectorConstraintPanel(state.document, { anchors, nodes: state.selection }, state.constraintIssues?.conflicts ?? []);
}
