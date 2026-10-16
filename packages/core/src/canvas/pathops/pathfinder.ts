/**
 * The Pathfinder panel's dividing operations over a stack of shapes (index 0 at the back):
 * Divide, Trim, Merge, Crop, Outline and Minus Back. (Unite, Minus Front, Intersect and Exclude
 * are `pathBoolean`.) Every result carries the index of the shape whose paint it keeps.
 *
 * The filled areas come from one arrangement of all shapes (`dividePaths`, `pathBooleanSelect`):
 * each area knows the shapes covering it, so an operation is a choice of areas per result.
 * Outline and Divide with cutting lines use the planar map (`PlanarMap`).
 *
 * Ported from vectorcraft-main/crates/pathops/src/pathfinder.rs (`pathfinder`, `PathfinderOp`,
 * `outline_edges`), MIT OR Apache-2.0, © ArtCraft Team and contributors. See
 * THIRD_PARTY_NOTICES.md.
 */
import type { PolygonFillRule } from '../polygonBoolean.js';
import { pathToContours, contoursToPath, type BezierPath, type BezierPathInput } from './bezier.js';
import { dividePaths, pathBooleanSelect, type PathOpsOptions, type PathOpsReport } from './boolean.js';
import { PlanarMap } from './planar.js';

export type PathfinderOperation = 'divide' | 'trim' | 'merge' | 'crop' | 'outline' | 'minusBack';

export const PATHFINDER_OPERATIONS: readonly PathfinderOperation[] = ['divide', 'trim', 'merge', 'crop', 'outline', 'minusBack'];

/** A shape of the stack. */
export interface PathfinderShape {
	/** Its outline; open subpaths are closed for filling (unless `line`). */
	path: BezierPathInput;
	fillRule?: PolygonFillRule;
	/** Identifies its paint: Merge joins touching areas whose shapes share a key (default: the index). */
	key?: string | number;
	/**
	 * An unfilled open path: a cutting edge for Divide, splitting the faces it crosses without
	 * becoming one (ignored by the other operations).
	 */
	line?: boolean;
}

/** One result: a filled area (or an open stroke for Outline). */
export interface PathfinderPiece {
	path: BezierPath;
	/** Index of the shape whose paint it keeps. */
	source: number;
	/** Outline edges are open paths (a loop with no junction on it stays closed). */
	open?: boolean;
}

export interface PathfinderResult extends PathOpsReport {
	pieces: PathfinderPiece[];
}

const top = (covering: readonly number[]) => covering[covering.length - 1];

/**
 * Runs a Pathfinder operation:
 * - `divide`: every face of the arrangement becomes its own piece, painted like the top-most
 *   shape covering it. `line` shapes cut the faces they cross.
 * - `trim`: hidden parts are removed; one piece per shape that stays visible, nothing merged.
 * - `merge`: like Trim, then touching or overlapping visible parts of shapes with the same key
 *   become one piece (one per connected area).
 * - `crop`: the top shape crops the others; it is removed, the visible parts of the shapes below
 *   inside it stay.
 * - `outline`: every outline is cut where it meets another; the pieces are open paths painted
 *   like the shape they bound (the top-most where outlines coincide).
 * - `minusBack`: the top shape minus everything behind it.
 */
export function pathfinder(op: PathfinderOperation, shapes: readonly PathfinderShape[], options: PathOpsOptions = {}): PathfinderResult {
	const n = shapes.length;
	if (n === 0) return { pieces: [], engine: 'curve' };
	const filled = shapes.filter((s) => !s.line);
	const operands = shapes.map((s) => ({ path: s.path, fillRule: s.fillRule ?? 'nonzero' }));

	if (op === 'outline') {
		const map = PlanarMap.build(
			shapes.map((s) => ({ path: s.line ? s.path : closeAll(s.path), fills: false })),
			options
		);
		if (!map) return { pieces: [], engine: 'curve', error: 'could not map the outlines' };
		const pieces = map.chains().map((c) => ({ path: contoursToPath([{ segments: c.segments, closed: c.closed }]), source: c.source, open: !c.closed }));
		return { pieces, engine: 'curve' };
	}

	if (op === 'divide') {
		if (filled.length !== n) {
			const map = PlanarMap.build(shapes.map((s) => ({ path: s.line ? s.path : closeAll(s.path), fillRule: s.fillRule, fills: !s.line })), options);
			if (!map) return { pieces: [], engine: 'curve', error: 'could not map the shapes' };
			const pieces: PathfinderPiece[] = [];
			map.faces.forEach((face, i) => {
				const covering = map.faceSources(i);
				if (covering.length) pieces.push({ path: face.path, source: top(covering) });
			});
			return { pieces, engine: 'curve' };
		}
		const result = dividePaths(operands, options);
		return { ...report(result), pieces: result.pieces.map((p) => ({ path: p.path, source: top(p.operands) })) };
	}

	// The filled-area operations ignore cutting lines.
	const index = shapes.flatMap((s, i) => (s.line ? [] : [i]));
	const m = index.length;
	if (m === 0) return { pieces: [], engine: 'curve' };
	const ops = index.map((i) => operands[i]);
	const key = (k: number) => shapes[index[k]].key ?? index[k];
	const select = (selectors: ((covering: readonly number[]) => boolean)[]) => pathBooleanSelect(ops, selectors, options);
	const joined = (parts: BezierPath[]) => parts.flat();

	switch (op) {
		case 'trim': {
			const result = select(index.map((_, k) => (c) => c.length > 0 && top(c) === k));
			const pieces = result.parts.flatMap((parts, k) => (parts.length ? [{ path: joined(parts), source: index[k] }] : []));
			return { ...report(result), pieces };
		}
		case 'merge': {
			const keys: (string | number)[] = [];
			for (let k = 0; k < m; k++) if (!keys.includes(key(k))) keys.push(key(k));
			const result = select(keys.map((kk) => (c) => c.length > 0 && key(top(c)) === kk));
			const pieces: PathfinderPiece[] = [];
			result.parts.forEach((parts, j) => {
				// Painted like the front-most shape with that key.
				let source = 0;
				for (let k = 0; k < m; k++) if (key(k) === keys[j]) source = index[k];
				for (const part of parts) pieces.push({ path: part, source });
			});
			return { ...report(result), pieces };
		}
		case 'crop': {
			if (m < 2) return { pieces: [], engine: 'curve' };
			const front = m - 1;
			const result = select(
				index.slice(0, front).map((_, k) => (c) => c.length >= 2 && top(c) === front && c[c.length - 2] === k)
			);
			const pieces = result.parts.flatMap((parts, k) => (parts.length ? [{ path: joined(parts), source: index[k] }] : []));
			return { ...report(result), pieces };
		}
		case 'minusBack': {
			const front = m - 1;
			const result = select([(c) => c.length === 1 && c[0] === front]);
			const parts = result.parts[0];
			return { ...report(result), pieces: parts.length ? [{ path: joined(parts), source: index[front] }] : [] };
		}
	}
	return { pieces: [], engine: 'curve' };
}

function report(r: PathOpsReport): PathOpsReport {
	return { engine: r.engine, ...(r.fallbackReason ? { fallbackReason: r.fallbackReason } : {}), ...(r.error ? { error: r.error } : {}) };
}

/** The path with every subpath closed (as it fills). */
function closeAll(path: BezierPathInput): BezierPath {
	return contoursToPath(pathToContours(path).map((c) => ({ segments: c.segments, closed: true })));
}
