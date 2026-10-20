/**
 * Symbols and instances: reusable art (`VectorDocument.symbols`) drawn by `instance` nodes through
 * an affine transform that may scale and skew.
 *
 * The concepts follow vectorcraft's `Symbol { name, art }` and `SymbolInstance { symbol, xf }`
 * (`crates/doc/src/symbols.rs`, MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md): instances measure and draw their symbol's art placed by their own
 * transform, nesting is bounded, and a symbol that would contain itself draws nothing. The
 * resolution and expansion here are our own.
 *
 * Instances carry their symbol's art resolved (`art`, the symbol's own `nodes` array) so that
 * geometry, rendering and export, which see one node at a time, can draw them. The editor resolves
 * after every change (`resolveVectorSymbols`); storage leaves it out (`stripVectorSymbolArt`).
 */

import { decomposeRigid, isIdentityMatrix, multiplyMatrices } from '../geom/affine.js';
import type { AffineMatrix } from '../geom/types.js';
import type { VectorDocument, VectorGroupNode, VectorInstanceNode, VectorInstanceOverrides, VectorNode, VectorPaint, VectorStrokeLayer, VectorSymbol } from './types.js';

/** Instances inside symbols nest at most this deep; deeper ones draw nothing. */
export const VECTOR_SYMBOL_MAX_DEPTH = 16;

const visit = (nodes: readonly VectorNode[], fn: (n: VectorNode) => void) => {
	for (const n of nodes) {
		fn(n);
		if (n.type === 'group') visit(n.children, fn);
	}
};

/** Ids of the symbols instances in `nodes` use (nested groups included, not through other symbols). */
export function vectorSymbolsUsedIn(nodes: readonly VectorNode[]): Set<string> {
	const out = new Set<string>();
	visit(nodes, (n) => {
		if (n.type === 'instance') out.add(n.symbolId);
	});
	return out;
}

/** Whether symbol `symbolId`'s art reaches symbol `target` through its instances (a cycle when they are the same). */
export function vectorSymbolUses(symbols: readonly VectorSymbol[], symbolId: string, target: string): boolean {
	const byId = new Map(symbols.map((s) => [s.id, s]));
	const seen = new Set<string>();
	const walk = (id: string, depth: number): boolean => {
		if (depth > VECTOR_SYMBOL_MAX_DEPTH || seen.has(id)) return false;
		seen.add(id);
		const sym = byId.get(id);
		if (!sym) return false;
		for (const used of vectorSymbolsUsedIn(sym.nodes)) if (used === target || walk(used, depth + 1)) return true;
		return false;
	};
	return walk(symbolId, 0);
}

/**
 * The document with every instance's `art` set to its symbol's art (instances inside symbols
 * included), the same object when nothing changed. An instance of a missing symbol, or one that
 * would draw its own symbol, gets no art.
 */
export function resolveVectorSymbols(doc: VectorDocument): VectorDocument {
	const symbols = doc.symbols ?? [];
	if (!symbols.length && !hasInstances(doc.nodes)) return doc;
	// Symbols first: their own instances resolve to the (resolved) art of the symbols they use.
	const resolved = new Map<string, VectorSymbol>();
	const byId = new Map(symbols.map((s) => [s.id, s]));
	const resolving = new Set<string>();
	const symbolOf = (id: string): VectorSymbol | null => {
		const hit = resolved.get(id);
		if (hit) return hit;
		const sym = byId.get(id);
		if (!sym || resolving.has(id)) return null;
		resolving.add(id);
		const nodes = resolveList(sym.nodes);
		resolving.delete(id);
		const next = nodes === sym.nodes ? sym : { ...sym, nodes };
		resolved.set(id, next);
		return next;
	};
	const resolveNode = (n: VectorNode): VectorNode => {
		if (n.type === 'instance') {
			const sym = symbolOf(n.symbolId);
			const art = sym && !resolving.has(n.symbolId) ? sym.nodes : undefined;
			if (n.art === art) return n;
			const next: VectorInstanceNode = { ...n };
			if (art) next.art = art;
			else delete next.art;
			return next;
		}
		if (n.type === 'group') {
			const children = resolveList(n.children);
			return children === n.children ? n : { ...n, children };
		}
		return n;
	};
	const resolveList = (list: VectorNode[]): VectorNode[] => {
		let changed = false;
		const out = list.map((n) => {
			const r = resolveNode(n);
			if (r !== n) changed = true;
			return r;
		});
		return changed ? out : list;
	};
	const nextSymbols = symbols.map((s) => symbolOf(s.id) ?? s);
	const nodes = resolveList(doc.nodes);
	const symbolsChanged = nextSymbols.some((s, i) => s !== symbols[i]);
	if (nodes === doc.nodes && !symbolsChanged) return doc;
	return { ...doc, nodes, ...(doc.symbols ? { symbols: symbolsChanged ? nextSymbols : doc.symbols } : {}) };
}

function hasInstances(nodes: readonly VectorNode[]): boolean {
	let found = false;
	visit(nodes, (n) => {
		if (n.type === 'instance') found = true;
	});
	return found;
}

/** The document without resolved art on its instances (for storage). */
export function stripVectorSymbolArt(doc: VectorDocument): VectorDocument {
	const strip = (list: VectorNode[]): VectorNode[] =>
		list.map((n) => {
			if (n.type === 'instance' && n.art) {
				const { art: _a, ...rest } = n;
				return rest;
			}
			if (n.type === 'group') return { ...n, children: strip(n.children) };
			return n;
		});
	return { ...doc, nodes: strip(doc.nodes), ...(doc.symbols ? { symbols: doc.symbols.map((s) => ({ ...s, nodes: strip(s.nodes) })) } : {}) };
}

/** A node's stroke widths (every stroke layer, the shorthand and profiles are relative) times `k`; groups pass it on. */
export function scaleVectorStrokeWidths<T extends VectorNode>(node: T, k: number): T {
	if (k === 1 || !(k > 0)) return node;
	if (node.type === 'group') return { ...node, children: node.children.map((c) => scaleVectorStrokeWidths(c, k)) } as T;
	if (node.type === 'instance') return node;
	const out = { ...node } as T & { strokeWidth?: number; stroke?: VectorPaint; strokes?: VectorStrokeLayer[] | null };
	if (out.strokeWidth !== undefined || out.stroke) out.strokeWidth = (out.strokeWidth ?? 1) * k;
	if (Array.isArray(out.strokes)) out.strokes = out.strokes.map((l) => ({ ...l, strokeWidth: (l.strokeWidth ?? 1) * k }));
	return out;
}

/** A node's fills and / or strokes all painted with the overrides' paints (groups pass them on). */
export function tintVectorNode<T extends VectorNode>(node: T, overrides: Pick<VectorInstanceOverrides, 'fill' | 'stroke'>): T {
	if (overrides.fill === undefined && overrides.stroke === undefined) return node;
	if (node.type === 'group') return { ...node, children: node.children.map((c) => tintVectorNode(c, overrides)) } as T;
	if (node.type === 'instance') {
		const own = node.overrides ?? {};
		return { ...node, overrides: { ...own, ...(overrides.fill !== undefined ? { fill: overrides.fill } : {}), ...(overrides.stroke !== undefined ? { stroke: overrides.stroke } : {}) } } as T;
	}
	const out = { ...node } as T & { fill?: VectorPaint; stroke?: VectorPaint; fills?: { paint: VectorPaint }[] | null; strokes?: { paint: VectorPaint }[] | null };
	const has = (p: VectorPaint | undefined) => p !== undefined && p !== null && p !== 'none';
	if (overrides.fill !== undefined) {
		if (Array.isArray(out.fills)) out.fills = out.fills.map((l) => ({ ...l, paint: overrides.fill! }));
		if (has(out.fill) || Array.isArray(out.fills)) out.fill = overrides.fill;
	}
	if (overrides.stroke !== undefined) {
		if (Array.isArray(out.strokes)) out.strokes = out.strokes.map((l) => ({ ...l, paint: overrides.stroke! }));
		if (has(out.stroke) || Array.isArray(out.strokes)) out.stroke = overrides.stroke;
	}
	return out;
}

/** Copies of `nodes` with ids prefixed `<prefix>~` (all the way down). */
export function prefixVectorIds(nodes: readonly VectorNode[], prefix: string): VectorNode[] {
	return nodes.map((n) => {
		const id = `${prefix}~${n.id}`;
		if (n.type === 'group') return { ...n, id, children: prefixVectorIds(n.children, prefix) };
		return { ...n, id };
	});
}

/**
 * What an instance draws, as a plain group in its parent's space: its art placed through its
 * transform (the rotation on the group, scale and skew baked into the art so transforms stay
 * rigid), strokes scaled unless `scaleStrokes` is false, overrides applied, ids `<instance>~<art>`.
 * `bake(node, m)` is `transformVectorNode` (passed in to keep this module below geometry).
 */
export function vectorInstanceGroup(node: VectorInstanceNode, bake: (n: VectorNode, m: AffineMatrix) => VectorNode): VectorGroupNode {
	const m = (node.transform ?? [1, 0, 0, 1, 0, 0]) as AffineMatrix;
	const { rigid, residual } = decomposeRigid(m);
	const k = Math.sqrt(Math.abs(residual[0] * residual[3] - residual[1] * residual[2]));
	const hidden = new Set(node.overrides?.hidden ?? []);
	const keep = (list: readonly VectorNode[]): VectorNode[] =>
		list.filter((n) => !hidden.has(n.id)).map((n) => (n.type === 'group' ? { ...n, children: keep(n.children) } : n));
	let children = prefixVectorIds(keep(node.art ?? []), node.id);
	if (!isIdentityMatrix(residual)) children = children.map((c) => bake(c, residual));
	if (node.scaleStrokes !== false && Math.abs(k - 1) > 1e-12) children = children.map((c) => scaleVectorStrokeWidths(c, k));
	if (node.overrides && (node.overrides.fill !== undefined || node.overrides.stroke !== undefined)) children = children.map((c) => tintVectorNode(c, node.overrides!));
	const group: VectorGroupNode = { id: node.id, type: 'group', children };
	if (!isIdentityMatrix(rigid)) group.transform = rigid;
	if (node.name !== undefined) group.name = node.name;
	if (node.visible === false) group.visible = false;
	if (node.locked) group.locked = true;
	if (node.opacity !== undefined) group.opacity = node.opacity;
	if (node.blendMode) group.blendMode = node.blendMode;
	if (node.filters?.length) group.filters = node.filters;
	if (node.effects?.length) group.effects = node.effects;
	if (node.booleanOperation) group.booleanOperation = node.booleanOperation;
	if (node.blendStep) group.blendStep = true;
	return group;
}

/** `a` then `b` (re-exported for callers that place art). */
export const composeVectorMatrices = (a: AffineMatrix, b: AffineMatrix): AffineMatrix => multiplyMatrices(a, b);
