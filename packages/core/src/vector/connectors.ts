/**
 * Connectors glued to objects: connection sites, routing and rerouting after every edit.
 *
 * After wordcraft's `crates/doc/src/connector.rs` (`sites`, `site_point`, `nearest_site`,
 * `connector_segs`, `reroute_group`) and deckcraft's `crates/engine/src/connect.rs` (`sites`,
 * `nearest_site`, `reroute`, `set_glue`) (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md): an end is glued to a site of another object (here a side's middle or the
 * centre of its own bounds, through its rotation); the connector is routed again whenever what it
 * is glued to changes, and glue to an object that no longer exists is dropped, the end staying where
 * it was. Straight, elbow and curved routes follow `connector_segs`; elbows leave and enter along the
 * sides' normals (a gap out first) and curves take their handles along them. `auto` sides (the one
 * facing the other end) are ours.
 */

import type { AffineMatrix } from '../geom/types.js';
import { applyMatrix, applyMatrixLinear, invertMatrix, isIdentityMatrix } from '../geom/affine.js';
import type {
	VectorAnchor,
	VectorConnector,
	VectorConnectorEnd,
	VectorConnectorRoute,
	VectorConnectorSide,
	VectorDocument,
	VectorNode,
	VectorPathNode,
	VectorSubpath
} from './types.js';
import { VECTOR_CONNECTOR_ROUTES, VECTOR_CONNECTOR_SIDES } from './types.js';
import { findVectorNode, hitTestVectorNodes, vectorNodeBounds, vectorWorldMatrix } from './geometry.js';

type Vec = { x: number; y: number };

/** A connection site in document space: where an end meets the object, and the side's outward normal. */
export interface VectorConnectionSite {
	side: Exclude<VectorConnectorSide, 'auto'>;
	x: number;
	y: number;
	/** Unit outward normal (zero for the centre). */
	nx: number;
	ny: number;
}

const SIDES = ['top', 'right', 'bottom', 'left', 'center'] as const;

/** Whether the node is a connector path. */
export function isVectorConnector(node: VectorNode | null | undefined): node is VectorPathNode & { connector: VectorConnector } {
	return node?.type === 'path' && !!node.connector;
}

/**
 * The connection sites of node `id` in document space, in the order top, right, bottom, left,
 * centre: the middles of its own (unrotated) bounds' sides, through its rotation and its ancestors'.
 * Empty for a connector, a hidden node or one without extent.
 */
export function vectorConnectionSites(nodes: readonly VectorNode[], id: string): VectorConnectionSite[] {
	const node = findVectorNode(nodes, id);
	if (!node || isVectorConnector(node) || node.visible === false) return [];
	const world = vectorWorldMatrix(nodes, id);
	if (!world) return [];
	const { transform: _t, ...own } = node;
	const b = vectorNodeBounds(own as VectorNode);
	if (!b) return [];
	// The node's own space → document (its transform included; `own` was measured without it).
	const cx = b.x + b.width / 2;
	const cy = b.y + b.height / 2;
	const local: Record<(typeof SIDES)[number], [Vec, Vec]> = {
		top: [{ x: cx, y: b.y }, { x: 0, y: -1 }],
		right: [{ x: b.x + b.width, y: cy }, { x: 1, y: 0 }],
		bottom: [{ x: cx, y: b.y + b.height }, { x: 0, y: 1 }],
		left: [{ x: b.x, y: cy }, { x: -1, y: 0 }],
		center: [{ x: cx, y: cy }, { x: 0, y: 0 }]
	};
	return SIDES.map((side) => {
		const [p, n] = local[side];
		const q = applyMatrix(world, p);
		const m = applyMatrixLinear(world, n);
		const len = Math.hypot(m.x, m.y);
		return { side, x: q.x, y: q.y, nx: len > 1e-12 ? m.x / len : 0, ny: len > 1e-12 ? m.y / len : 0 };
	});
}

/** The site of `sites` nearest `p` (document space) within `radius`, or null. */
export function nearestVectorConnectionSite(sites: readonly VectorConnectionSite[], p: Vec, radius = Infinity): VectorConnectionSite | null {
	let best: VectorConnectionSite | null = null;
	let bestD = radius;
	for (const s of sites) {
		const d = Math.hypot(s.x - p.x, s.y - p.y);
		if (d <= bestD) {
			best = s;
			bestD = d;
		}
	}
	return best;
}

/** The site of an `auto` end: the side whose normal faces `toward` most (the nearer one on a tie). */
function facingSite(sites: readonly VectorConnectionSite[], toward: Vec): VectorConnectionSite {
	let best = sites[0];
	let score = -Infinity;
	for (const s of sites) {
		if (s.side === 'center') continue;
		const dx = toward.x - s.x;
		const dy = toward.y - s.y;
		const len = Math.hypot(dx, dy) || 1;
		const v = (s.nx * dx + s.ny * dy) / len - len * 1e-9;
		if (v > score) {
			score = v;
			best = s;
		}
	}
	return best;
}

/** A routed end: its point and the direction the line leaves it (zero when it has none). */
interface RoutedEnd {
	x: number;
	y: number;
	nx: number;
	ny: number;
	glued: boolean;
}

/** The connector's current end points in document space (its first and last anchors). */
function storedEnds(node: VectorPathNode, world: AffineMatrix): [Vec, Vec] | null {
	const sp = node.subpaths[0];
	if (!sp?.anchors.length) return null;
	const a = sp.anchors[0];
	const b = sp.anchors[sp.anchors.length - 1];
	return [applyMatrix(world, a), applyMatrix(world, b)];
}

/** Where a glued end's object is (its centre), for choosing the other end's `auto` side. */
function centreOf(sites: readonly VectorConnectionSite[]): Vec {
	const c = sites[4];
	return { x: c.x, y: c.y };
}

/** Unit vector along the dominant axis of `v` (right when zero). */
function axis(v: Vec): Vec {
	if (Math.abs(v.x) >= Math.abs(v.y)) return { x: v.x < 0 ? -1 : 1, y: 0 };
	return { x: 0, y: v.y < 0 ? -1 : 1 };
}

/** Removes repeated points and middle points of straight runs. */
function tidy(points: Vec[]): Vec[] {
	const out: Vec[] = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-9) continue;
		out.push(p);
	}
	for (let i = out.length - 2; i >= 1; i--) {
		const a = out[i - 1];
		const b = out[i];
		const c = out[i + 1];
		if (Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < 1e-9) out.splice(i, 1);
	}
	return out;
}

/** The elbow route's points between two ends (document space). */
function elbowPoints(a: RoutedEnd, b: RoutedEnd, gap: number): Vec[] {
	const na = a.glued && (a.nx || a.ny) ? axis({ x: a.nx, y: a.ny }) : axis({ x: b.x - a.x, y: b.y - a.y });
	const nb = b.glued && (b.nx || b.ny) ? axis({ x: b.nx, y: b.ny }) : axis({ x: a.x - b.x, y: a.y - b.y });
	const s = { x: a.x + na.x * (a.glued ? gap : 0), y: a.y + na.y * (a.glued ? gap : 0) };
	const e = { x: b.x + nb.x * (b.glued ? gap : 0), y: b.y + nb.y * (b.glued ? gap : 0) };
	const ha = na.x !== 0;
	const hb = nb.x !== 0;
	let mid: Vec[];
	if (ha && hb) {
		// Out and in sideways: across through the middle, or round the middle when that would turn back.
		const mx = (s.x + e.x) / 2;
		mid = (mx - s.x) * na.x >= 0 && (mx - e.x) * nb.x >= 0 ? [{ x: mx, y: s.y }, { x: mx, y: e.y }] : [{ x: s.x, y: (s.y + e.y) / 2 }, { x: e.x, y: (s.y + e.y) / 2 }];
	} else if (!ha && !hb) {
		const my = (s.y + e.y) / 2;
		mid = (my - s.y) * na.y >= 0 && (my - e.y) * nb.y >= 0 ? [{ x: s.x, y: my }, { x: e.x, y: my }] : [{ x: (s.x + e.x) / 2, y: s.y }, { x: (s.x + e.x) / 2, y: e.y }];
	} else if (ha) mid = [{ x: e.x, y: s.y }];
	else mid = [{ x: s.x, y: e.y }];
	return tidy([{ x: a.x, y: a.y }, s, ...mid, e, { x: b.x, y: b.y }]);
}

/** The connector's path in document space, from routed ends. */
export function vectorConnectorWorldAnchors(a: RoutedEnd, b: RoutedEnd, route: VectorConnectorRoute, options: { radius?: number; gap?: number } = {}): VectorAnchor[] {
	const gap = options.gap ?? 16;
	if (route === 'elbow') {
		const pts = elbowPoints(a, b, gap);
		const r = options.radius ?? 0;
		return pts.map((p, i) => (r > 0 && i > 0 && i < pts.length - 1 ? { x: p.x, y: p.y, corner: { radius: r } } : { x: p.x, y: p.y }));
	}
	if (route === 'curved') {
		const d = Math.hypot(b.x - a.x, b.y - a.y);
		const k = Math.max(d * 0.4, gap);
		const na = a.glued && (a.nx || a.ny) ? { x: a.nx, y: a.ny } : axis({ x: b.x - a.x, y: b.y - a.y });
		const nb = b.glued && (b.nx || b.ny) ? { x: b.nx, y: b.ny } : axis({ x: a.x - b.x, y: a.y - b.y });
		return [
			{ x: a.x, y: a.y, out: { x: a.x + na.x * k, y: a.y + na.y * k } },
			{ x: b.x, y: b.y, in: { x: b.x + nb.x * k, y: b.y + nb.y * k } }
		];
	}
	return [
		{ x: a.x, y: a.y },
		{ x: b.x, y: b.y }
	];
}

/** Resolves one end: its site (an `auto` one facing `toward`), or null when its object is gone. */
function resolveEnd(nodes: readonly VectorNode[], end: VectorConnectorEnd, toward: Vec): VectorConnectionSite | null {
	const sites = vectorConnectionSites(nodes, end.nodeId);
	if (!sites.length) return null;
	const side = end.side ?? 'auto';
	return side === 'auto' ? facingSite(sites, toward) : (sites.find((s) => s.side === side) ?? null);
}

/** What routing a connector gives: its new subpaths (own space) and which ends lost their object. */
export interface VectorConnectorRouting {
	subpaths: VectorSubpath[];
	/** The resolved sides of its glued ends (null when not glued). */
	startSide: Exclude<VectorConnectorSide, 'auto'> | null;
	endSide: Exclude<VectorConnectorSide, 'auto'> | null;
	/** Ends glued to an object that no longer exists (or has no extent). */
	dropped: { start: boolean; end: boolean };
}

/** Routes connector `id` of `nodes` from where its ends are glued (or stored), or null when it is not a connector. */
export function routeVectorConnector(nodes: readonly VectorNode[], id: string): VectorConnectorRouting | null {
	const node = findVectorNode(nodes, id);
	if (!isVectorConnector(node)) return null;
	const world = vectorWorldMatrix(nodes, id);
	if (!world) return null;
	const c = node.connector;
	const stored = storedEnds(node, world) ?? [
		{ x: 0, y: 0 },
		{ x: 0, y: 0 }
	];
	const glue = (e: VectorConnectorEnd | null | undefined) => (e && e.nodeId !== id ? e : null);
	const startGlue = glue(c.start);
	const endGlue = glue(c.end);
	// Reference points for `auto` sides: the other end's object centre, or its stored point.
	const centre = (e: VectorConnectorEnd | null, fallback: Vec) => {
		if (!e) return fallback;
		const sites = vectorConnectionSites(nodes, e.nodeId);
		return sites.length ? centreOf(sites) : fallback;
	};
	const s = startGlue ? resolveEnd(nodes, startGlue, centre(endGlue, stored[1])) : null;
	const e = endGlue ? resolveEnd(nodes, endGlue, s ? { x: s.x, y: s.y } : centre(startGlue, stored[0])) : null;
	const a: RoutedEnd = s ? { ...s, glued: true } : { ...stored[0], nx: 0, ny: 0, glued: false };
	const b: RoutedEnd = e ? { ...e, glued: true } : { ...stored[1], nx: 0, ny: 0, glued: false };
	const anchors = vectorConnectorWorldAnchors(a, b, c.route ?? 'straight', { radius: c.radius, gap: c.gap });
	const back = invertMatrix(world);
	const toLocal = (p: Vec) => (isIdentityMatrix(back) ? p : applyMatrix(back, p));
	const local = anchors.map((an) => ({
		...an,
		...toLocal(an),
		...(an.in ? { in: toLocal(an.in) } : {}),
		...(an.out ? { out: toLocal(an.out) } : {})
	}));
	return {
		subpaths: [{ closed: false, anchors: local }],
		startSide: s?.side ?? null,
		endSide: e?.side ?? null,
		dropped: { start: !!startGlue && !s, end: !!endGlue && !e }
	};
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const samePoint = (a: Vec | null | undefined, b: Vec | null | undefined) => (!a && !b) || (!!a && !!b && near(a.x, b.x) && near(a.y, b.y));
function sameSubpaths(a: readonly VectorSubpath[], b: readonly VectorSubpath[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((sp, i) => {
		const o = b[i];
		return (
			sp.closed === o.closed &&
			sp.anchors.length === o.anchors.length &&
			sp.anchors.every((p, k) => {
				const q = o.anchors[k];
				return samePoint(p, q) && samePoint(p.in, q.in) && samePoint(p.out, q.out) && (p.corner?.radius ?? 0) === (q.corner?.radius ?? 0);
			})
		);
	});
}

/**
 * The document with every connector routed again (glue to objects that no longer exist dropped);
 * the same object when nothing moved.
 */
export function rerouteVectorConnectors<D extends Pick<VectorDocument, 'nodes'>>(doc: D): D {
	const ids: string[] = [];
	const walk = (list: readonly VectorNode[]) => {
		for (const n of list) {
			if (isVectorConnector(n) && (n.connector.start || n.connector.end)) ids.push(n.id);
			if (n.type === 'group') walk(n.children);
		}
	};
	walk(doc.nodes);
	if (!ids.length) return doc;
	const next = new Map<string, VectorPathNode>();
	for (const id of ids) {
		const node = findVectorNode(doc.nodes, id) as VectorPathNode & { connector: VectorConnector };
		const r = routeVectorConnector(doc.nodes, id);
		if (!r) continue;
		const changed = !sameSubpaths(node.subpaths, r.subpaths);
		if (!changed && !r.dropped.start && !r.dropped.end) continue;
		const connector: VectorConnector = { ...node.connector };
		if (r.dropped.start) delete connector.start;
		if (r.dropped.end) delete connector.end;
		next.set(id, { ...node, subpaths: changed ? r.subpaths : node.subpaths, connector });
	}
	if (!next.size) return doc;
	const map = (list: readonly VectorNode[]): VectorNode[] => {
		let touched = false;
		const out = list.map((n) => {
			const hit = next.get(n.id);
			if (hit) {
				touched = true;
				return hit;
			}
			if (n.type === 'group') {
				const children = map(n.children);
				if (children !== n.children) {
					touched = true;
					return { ...n, children };
				}
			}
			return n;
		});
		return touched ? out : (list as VectorNode[]);
	};
	return { ...doc, nodes: map(doc.nodes) };
}

/** Reads connector settings from untrusted data (JSON, SVG import), or null. */
export function sanitizeVectorConnector(value: unknown): VectorConnector | null {
	if (!value || typeof value !== 'object') return null;
	const r = value as Record<string, unknown>;
	const end = (v: unknown): VectorConnectorEnd | null => {
		if (!v || typeof v !== 'object') return null;
		const e = v as Record<string, unknown>;
		if (typeof e.nodeId !== 'string' || !e.nodeId) return null;
		return VECTOR_CONNECTOR_SIDES.includes(e.side as VectorConnectorSide) && e.side !== 'auto' ? { nodeId: e.nodeId, side: e.side as VectorConnectorSide } : { nodeId: e.nodeId };
	};
	const out: VectorConnector = {};
	const start = end(r.start);
	const finish = end(r.end);
	if (start) out.start = start;
	if (finish) out.end = finish;
	if (VECTOR_CONNECTOR_ROUTES.includes(r.route as VectorConnectorRoute) && r.route !== 'straight') out.route = r.route as VectorConnectorRoute;
	if (typeof r.radius === 'number' && Number.isFinite(r.radius) && r.radius > 0) out.radius = r.radius;
	if (typeof r.gap === 'number' && Number.isFinite(r.gap) && r.gap >= 0) out.gap = r.gap;
	return out;
}

/** Labels for the connector pickers. */
export const VECTOR_CONNECTOR_ROUTE_LABELS: Readonly<Record<VectorConnectorRoute, string>> = { straight: 'Straight', elbow: 'Elbow', curved: 'Curved' };
export const VECTOR_CONNECTOR_SIDE_LABELS: Readonly<Record<VectorConnectorSide, string>> = { auto: 'Auto', top: 'Top', right: 'Right', bottom: 'Bottom', left: 'Left', center: 'Centre' };

/** What the connector panel shows: the first selected connector, or null. */
export interface VectorConnectorPanel {
	id: string;
	route: VectorConnectorRoute;
	radius: number;
	gap: number;
	start: VectorConnectorEnd | null;
	end: VectorConnectorEnd | null;
}

/** The connector panel's data for a selection. */
export function getVectorConnectorPanel(state: { document: Pick<VectorDocument, 'nodes'>; selection: readonly string[] }): VectorConnectorPanel | null {
	for (const id of state.selection) {
		const n = findVectorNode(state.document.nodes, id);
		if (isVectorConnector(n)) {
			const c = n.connector;
			return { id: n.id, route: c.route ?? 'straight', radius: c.radius ?? 0, gap: c.gap ?? 16, start: c.start ?? null, end: c.end ?? null };
		}
	}
	return null;
}

/**
 * What a connector end dragged to `p` (document space) glues to: the nearest connection site
 * within `radius` of a top-level object (that side), else the object under `p` (`auto`), else
 * null (a free end). Connectors, hidden and locked objects and `exclude` are skipped.
 */
export function vectorConnectorTargetAt(nodes: readonly VectorNode[], p: Vec, radius: number, exclude?: string): (VectorConnectorEnd & { site: VectorConnectionSite | null }) | null {
	let best: { nodeId: string; site: VectorConnectionSite; d: number } | null = null;
	for (const n of nodes) {
		if (n.id === exclude || n.visible === false || n.locked || isVectorConnector(n)) continue;
		const site = nearestVectorConnectionSite(vectorConnectionSites(nodes, n.id), p, radius);
		if (site) {
			const d = Math.hypot(site.x - p.x, site.y - p.y);
			if (!best || d < best.d) best = { nodeId: n.id, site, d };
		}
	}
	if (best) return { nodeId: best.nodeId, side: best.site.side, site: best.site };
	const usable = nodes.filter((n) => n.id !== exclude && !isVectorConnector(n));
	const hit = hitTestVectorNodes(usable, p, 0);
	return hit ? { nodeId: hit.id, side: 'auto', site: null } : null;
}
