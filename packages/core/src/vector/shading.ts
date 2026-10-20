/**
 * Gradient meshes and freeform gradients: paints that are not a function of one parameter, drawn
 * as SVG patterns of small flat tiles (as conic gradients are drawn as wedges).
 *
 * Meshes follow effectcraft's `crates/pdf/src/shading.rs` (PDF shading types 6 and 7: Coons patches
 * bounded by cubic sides, tessellated into small cells whose colours blend between the patch's
 * corners); here the lattice's sides are Catmull-Rom curves through its points, so a mesh stays
 * smooth across patches. Freeform gradients follow vectorcraft's `crates/color/src/freeform.rs`
 * (`Freeform`, `Field::sample`: each point paints a disc of pure colour of its spread and blends
 * into the others beyond it by inverse-square distance from the disc's edge; a line is a
 * Catmull-Rom curve whose pieces each act as a source weighted by their share of its length;
 * `auto` places a 2 × n grid of points inside the shape; `spread_scale`) (MIT OR Apache-2.0,
 * © ArtCraft Team and contributors; see THIRD_PARTY_NOTICES.md).
 */

import type { VectorBounds, VectorFreeformGradient, VectorFreeformPoint, VectorMeshGradient, VectorPaint, Vec2 } from './types.js';
import type { VectorMatrix } from './types.js';
import { parseVectorColor, patternAttrs, type VectorRgba, type VectorSvgPatternDef } from './gradient.js';
import type { SvgGradientDef, SvgGradientStop } from '../canvas/gradient.js';

/** Whether the paint is a gradient mesh. */
export function isVectorMeshGradient(paint: VectorPaint | undefined): paint is VectorMeshGradient {
	return !!paint && typeof paint === 'object' && (paint as VectorMeshGradient).type === 'mesh' && Array.isArray((paint as VectorMeshGradient).points);
}

/** Whether the paint is a freeform gradient. */
export function isVectorFreeformGradient(paint: VectorPaint | undefined): paint is VectorFreeformGradient {
	return !!paint && typeof paint === 'object' && (paint as VectorFreeformGradient).type === 'freeform' && Array.isArray((paint as VectorFreeformGradient).points);
}

/** Whether the paint is a mesh or freeform gradient (drawn as tiles). */
export function isVectorShadedPaint(paint: VectorPaint | undefined): paint is VectorMeshGradient | VectorFreeformGradient {
	return isVectorMeshGradient(paint) || isVectorFreeformGradient(paint);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rgbaOf = (color: string, opacity = 1): VectorRgba => {
	const c = parseVectorColor(color) ?? [0, 0, 0, 1];
	return [c[0], c[1], c[2], c[3] * opacity];
};
const hex2 = (v: number) =>
	Math.round(Math.min(1, Math.max(0, v)) * 255)
		.toString(16)
		.padStart(2, '0');
/** A CSS colour for straight-alpha channels: `#rrggbb`, or `rgba()` when not opaque. */
export function vectorRgbaToCss([r, g, b, a]: VectorRgba): string {
	if (a >= 0.9995) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
	const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
	return `rgba(${c(r)},${c(g)},${c(b)},${Math.round(Math.max(0, a) * 1000) / 1000})`;
}

// ---------------------------------------------------------------------------
// Meshes
// ---------------------------------------------------------------------------

/** The most rows or columns a mesh has. */
export const VECTOR_MESH_MAX = 32;

/**
 * A mesh over `bounds` with `rows` × `columns` patches, its points evenly spread. Colours come from
 * `colors` row by row (one per point), or the four `corners` (top-left, top-right, bottom-right,
 * bottom-left) blended across, or white.
 */
export function createVectorMeshGradient(bounds: VectorBounds, rows: number, columns: number, colors: { colors?: readonly string[]; corners?: readonly [string, string, string, string] } = {}): VectorMeshGradient {
	const r = Math.min(VECTOR_MESH_MAX, Math.max(1, Math.round(rows)));
	const c = Math.min(VECTOR_MESH_MAX, Math.max(1, Math.round(columns)));
	const points: Vec2[] = [];
	const out: string[] = [];
	const corners = colors.corners?.map((k) => rgbaOf(k));
	for (let i = 0; i <= r; i++) {
		for (let j = 0; j <= c; j++) {
			points.push({ x: bounds.x + (bounds.width * j) / c, y: bounds.y + (bounds.height * i) / r });
			const k = i * (c + 1) + j;
			if (colors.colors?.[k]) out.push(colors.colors[k]);
			else if (corners) {
				const u = j / c;
				const v = i / r;
				const top = corners[0].map((x, n) => lerp(x, corners[1][n], u));
				const bottom = corners[3].map((x, n) => lerp(x, corners[2][n], u));
				out.push(vectorRgbaToCss(top.map((x, n) => lerp(x, bottom[n], v)) as VectorRgba));
			} else out.push('#ffffff');
		}
	}
	return { type: 'mesh', rows: r, columns: c, points, colors: out };
}

/** A Catmull-Rom cubic through `p1` to `p2` (neighbours `p0`, `p3`): its four control points. */
function catmull(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2): [Vec2, Vec2, Vec2, Vec2] {
	return [p1, { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }, { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }, p2];
}

function cubicAt(c: readonly Vec2[], t: number): Vec2 {
	const s = 1 - t;
	const a = s * s * s;
	const b = 3 * s * s * t;
	const d = 3 * s * t * t;
	const e = t * t * t;
	return { x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y };
}

/** A mesh with consistent arrays (rows / columns clamped, points and colours filled out), or null when it cannot be made so. */
function meshOk(m: VectorMeshGradient): boolean {
	const n = (m.rows + 1) * (m.columns + 1);
	return m.rows >= 1 && m.columns >= 1 && m.points.length === n && m.colors.length === n;
}

/**
 * The mesh's lattice point at row `r`, column `c`, extended by one point past each edge in a
 * straight line (so the curves through an evenly spread edge run evenly to its end).
 */
function meshLattice(m: VectorMeshGradient): (r: number, c: number) => Vec2 {
	const cols = m.columns + 1;
	const at = (r: number, c: number) => m.points[r * cols + c];
	const ext = (a: Vec2, b: Vec2): Vec2 => ({ x: 2 * a.x - b.x, y: 2 * a.y - b.y });
	const P = (r: number, c: number): Vec2 => {
		if (r < 0) return ext(P(0, c), P(1, c));
		if (r > m.rows) return ext(P(m.rows, c), P(m.rows - 1, c));
		if (c < 0) return ext(at(r, 0), at(r, 1));
		if (c > m.columns) return ext(at(r, m.columns), at(r, m.columns - 1));
		return at(r, c);
	};
	return P;
}

/** The point of the mesh's surface at patch (i, j), parameters (u, v) 0–1. */
export function vectorMeshPointAt(m: VectorMeshGradient, i: number, j: number, u: number, v: number): Vec2 {
	const P = meshLattice(m);
	// The patch's sides: Catmull-Rom curves along its rows and columns of the lattice.
	const top = catmull(P(i, j - 1), P(i, j), P(i, j + 1), P(i, j + 2));
	const bottom = catmull(P(i + 1, j - 1), P(i + 1, j), P(i + 1, j + 1), P(i + 1, j + 2));
	const left = catmull(P(i - 1, j), P(i, j), P(i + 1, j), P(i + 2, j));
	const right = catmull(P(i - 1, j + 1), P(i, j + 1), P(i + 1, j + 1), P(i + 2, j + 1));
	const t = cubicAt(top, u);
	const b = cubicAt(bottom, u);
	const l = cubicAt(left, v);
	const r = cubicAt(right, v);
	const [p00, p01, p11, p10] = [P(i, j), P(i, j + 1), P(i + 1, j + 1), P(i + 1, j)];
	// Coons: the two ruled surfaces minus the bilinear one.
	const bl = (k: 'x' | 'y') => (1 - u) * (1 - v) * p00[k] + u * (1 - v) * p01[k] + u * v * p11[k] + (1 - u) * v * p10[k];
	return { x: (1 - v) * t.x + v * b.x + (1 - u) * l.x + u * r.x - bl('x'), y: (1 - v) * t.y + v * b.y + (1 - u) * l.y + u * r.y - bl('y') };
}

/** The mesh's colour (straight alpha) at patch (i, j), parameters (u, v): its corners blended. */
export function vectorMeshColorAt(m: VectorMeshGradient, i: number, j: number, u: number, v: number): VectorRgba {
	const cols = m.columns + 1;
	const C = (r: number, c: number) => rgbaOf(m.colors[r * cols + c], m.opacities?.[r * cols + c] ?? 1);
	const a = C(i, j);
	const b = C(i, j + 1);
	const c = C(i + 1, j + 1);
	const d = C(i + 1, j);
	return [0, 1, 2, 3].map((k) => (1 - u) * (1 - v) * a[k] + u * (1 - v) * b[k] + u * v * c[k] + (1 - u) * v * d[k]) as VectorRgba;
}

/** Each patch's outline (four Catmull-Rom sides), for drawing the mesh lines on the canvas: `M…C…` path data per row and column of the lattice. */
export function vectorMeshLines(m: VectorMeshGradient): { rows: Vec2[][][]; columns: Vec2[][][] } {
	const P = meshLattice(m);
	const rows: Vec2[][][] = [];
	for (let i = 0; i <= m.rows; i++) rows.push(Array.from({ length: m.columns }, (_, j) => catmull(P(i, j - 1), P(i, j), P(i, j + 1), P(i, j + 2))));
	const columns: Vec2[][][] = [];
	for (let j = 0; j <= m.columns; j++) columns.push(Array.from({ length: m.rows }, (_, i) => catmull(P(i - 1, j), P(i, j), P(i + 1, j), P(i + 2, j))));
	return { rows, columns };
}

// ---------------------------------------------------------------------------
// Freeform gradients
// ---------------------------------------------------------------------------

/** Pieces each line segment is tessellated into for sampling. */
const LINE_STEPS = 16;

interface Source {
	x: number;
	y: number;
	c: VectorRgba;
	radius: number;
}

const lerpSource = (a: Source, b: Source, t: number): Source => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), c: a.c.map((v, k) => lerp(v, b.c[k], t)) as VectorRgba, radius: lerp(a.radius, b.radius, t) });

/** The length freeform spreads are fractions of: half the longer side of the painted box. */
export function vectorFreeformSpreadScale(bounds: VectorBounds): number {
	return Math.max(Math.abs(bounds.width), Math.abs(bounds.height)) / 2;
}

/** The cubic segments of line `line` of a freeform gradient (a Catmull-Rom curve through its points); empty for a line naming a missing point. */
export function vectorFreeformLineSegments(f: VectorFreeformGradient, line: number): [Vec2, Vec2, Vec2, Vec2][] {
	const ix = f.lines?.[line];
	if (!ix) return [];
	const pts = ix.map((i) => f.points[i]);
	if (pts.some((p) => !p)) return [];
	const n = pts.length;
	const out: [Vec2, Vec2, Vec2, Vec2][] = [];
	for (let i = 0; i + 1 < n; i++) out.push(catmull(pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(n - 1, i + 2)]));
	return out;
}

/** A freeform gradient ready to sample many spots (see `sampleVectorFreeform`). */
export interface VectorFreeformField {
	points: Source[];
	pieces: { a: Source; b: Source; share: number }[];
	eps: number;
}

/** The colour field of a freeform gradient on a box whose spread scale is `scale` (lines tessellated once). */
export function vectorFreeformField(f: VectorFreeformGradient, scale: number): VectorFreeformField {
	const src = (p: VectorFreeformPoint): Source => ({ x: p.x, y: p.y, c: rgbaOf(p.color, p.opacity ?? 1), radius: Math.min(1, Math.max(0, p.spread ?? 0)) * scale });
	const points = f.points.map(src);
	const pieces: VectorFreeformField['pieces'] = [];
	(f.lines ?? []).forEach((ix, l) => {
		const v: Source[] = [];
		vectorFreeformLineSegments(f, l).forEach((c, s) => {
			const a = points[ix[s]];
			const b = points[ix[s + 1]];
			for (let k = s === 0 ? 0 : 1; k <= LINE_STEPS; k++) {
				const t = k / LINE_STEPS;
				const at = cubicAt(c, t);
				v.push({ ...lerpSource(a, b, t), x: at.x, y: at.y });
			}
		});
		let len = 0;
		for (let k = 1; k < v.length; k++) len += Math.hypot(v[k].x - v[k - 1].x, v[k].y - v[k - 1].y);
		const n = Math.max(1, v.length - 1);
		for (let k = 1; k < v.length; k++) {
			const d = Math.hypot(v[k].x - v[k - 1].x, v[k].y - v[k - 1].y);
			pieces.push({ a: v[k - 1], b: v[k], share: len > 0 ? d / len : 1 / n });
		}
	});
	return { points, pieces, eps: 1e-9 * (Math.abs(scale) + 1) };
}

/** The freeform field's colour at `p` (straight alpha, 0–1). After vectorcraft's `Field::sample`. */
export function sampleVectorFreeform(field: VectorFreeformField, p: Vec2): VectorRgba {
	const disc = { w: 0, c: [0, 0, 0, 0] };
	const far = { w: 0, c: [0, 0, 0, 0] };
	const add = (d: number, s: Source, share: number) => {
		let acc: typeof disc;
		let w: number;
		if (d < s.radius || d <= field.eps) {
			// The deeper inside a disc, the stronger: weights fade to nothing at its edge.
			acc = disc;
			w = (s.radius - d + field.eps) * share;
		} else {
			const e = d - s.radius;
			acc = far;
			w = share / (e * e);
		}
		acc.w += w;
		for (let k = 0; k < 4; k++) acc.c[k] += w * s.c[k];
	};
	for (const s of field.points) add(Math.hypot(s.x - p.x, s.y - p.y), s, 1);
	for (const piece of field.pieces) {
		const vx = piece.b.x - piece.a.x;
		const vy = piece.b.y - piece.a.y;
		const l2 = vx * vx + vy * vy;
		const t = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - piece.a.x) * vx + (p.y - piece.a.y) * vy) / l2)) : 0;
		const s = lerpSource(piece.a, piece.b, t);
		add(Math.hypot(s.x - p.x, s.y - p.y), s, piece.share);
	}
	const acc = disc.w > 0 ? disc : far;
	if (!(acc.w > 0 && Number.isFinite(acc.w))) return [0, 0, 0, 0];
	return acc.c.map((v) => v / acc.w) as VectorRgba;
}

/**
 * The points a first freeform gradient gets on a shape with box `b`: a 2 × n grid (n = 2–4 along
 * the longer side), each moved to the nearest spot `inside` the shape when its place is not, coloured
 * along `colors` (first to last). After vectorcraft's `Freeform::auto`.
 */
export function autoVectorFreeformGradient(b: VectorBounds, colors: readonly string[], inside: (p: Vec2) => boolean = () => true): VectorFreeformGradient {
	const w = Math.max(b.width, 1e-9);
	const h = Math.max(b.height, 1e-9);
	const long = Math.min(4, Math.max(2, Math.round((2 * Math.max(w, h)) / Math.min(w, h))));
	const [cols, rows] = w >= h ? [long, 2] : [2, long];
	const cell = (i: number, n: number) => (i + 0.5) / n;
	const targets: Vec2[] = [];
	// Row by row, every other row backwards: neighbours in the list are neighbours on the art.
	for (let j = 0; j < rows; j++) for (let k = 0; k < cols; k++) targets.push({ x: b.x + cell(j % 2 === 0 ? k : cols - 1 - k, cols) * w, y: b.y + cell(j, rows) * h });
	const GRID = 24;
	const candidates: Vec2[] = [];
	for (let k = 0; k < GRID * GRID; k++) {
		const p = { x: b.x + cell(k % GRID, GRID) * w, y: b.y + cell(Math.floor(k / GRID), GRID) * h };
		if (inside(p)) candidates.push(p);
	}
	const apart = Math.min(w, h) * 0.15;
	const placed: Vec2[] = [];
	for (const t of targets) {
		let at = t;
		if (!inside(t)) {
			let best: Vec2 | null = null;
			let bestD = Infinity;
			for (const c of candidates) {
				if (!placed.every((q) => Math.hypot(q.x - c.x, q.y - c.y) >= apart)) continue;
				const d = Math.hypot(c.x - t.x, c.y - t.y);
				if (d < bestD) {
					best = c;
					bestD = d;
				}
			}
			at = best ?? t;
		}
		placed.push(at);
	}
	const palette = colors.length ? colors : ['#ffffff', '#000000'];
	const n = placed.length;
	const colorAt = (k: number) => {
		if (palette.length === 1) return palette[0];
		const t = (k / Math.max(1, n - 1)) * (palette.length - 1);
		const i = Math.min(palette.length - 2, Math.floor(t));
		const a = rgbaOf(palette[i]);
		const c = rgbaOf(palette[i + 1]);
		return vectorRgbaToCss(a.map((v, q) => lerp(v, c[q], t - i)) as VectorRgba);
	};
	return { type: 'freeform', points: placed.map((p, k) => ({ x: p.x, y: p.y, color: colorAt(k) })) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const fmt = (n: number, digits: number) => {
	const k = 10 ** digits;
	const v = Math.round(n * k) / k;
	return Object.is(v, -0) ? '0' : String(v);
};
const quadD = (pts: readonly Vec2[], precision: number) => `M${pts.map((p) => `${fmt(p.x, precision)} ${fmt(p.y, precision)}`).join('L')}Z`;

/** Options for `vectorShadedSvgDefs`. */
export interface VectorShadedSvgOptions {
	/** The shape's box in its own space (freeform spreads and cells). */
	bounds?: VectorBounds | null;
	/** The area the pattern covers (default `bounds` padded by 1). */
	area?: VectorBounds | null;
	/** Cells per mesh patch side (default 8). */
	meshCells?: number;
	/** Strips across a freeform gradient's longer side (default 96). */
	freeformCells?: number;
	precision?: number;
}

/**
 * A mesh or freeform paint as an SVG `<pattern>` of small flat tiles in the painted element's user
 * space (reference it as `url(#id)`). Each tile slightly overlaps the ones after it so no seams show
 * between them.
 */
export function vectorShadedSvgDefs(paint: VectorMeshGradient | VectorFreeformGradient, id: string, options: VectorShadedSvgOptions = {}): VectorSvgPatternDef[] {
	const precision = options.precision ?? 3;
	const bounds = options.bounds ?? null;
	const area = options.area ?? (bounds ? { x: bounds.x - 1, y: bounds.y - 1, width: bounds.width + 2, height: bounds.height + 2 } : { x: 0, y: 0, width: 1, height: 1 });
	const tiles: { d: string; fill: string }[] = [];
	const gradients: SvgGradientDef[] = [];
	if (isVectorMeshGradient(paint)) {
		if (meshOk(paint)) {
			const k = Math.max(1, Math.min(32, Math.round(options.meshCells ?? 8)));
			for (let i = 0; i < paint.rows; i++) {
				for (let j = 0; j < paint.columns; j++) {
					const grid: Vec2[][] = [];
					for (let a = 0; a <= k; a++) {
						const row: Vec2[] = [];
						for (let b = 0; b <= k; b++) row.push(vectorMeshPointAt(paint, i, j, b / k, a / k));
						grid.push(row);
					}
					for (let a = 0; a < k; a++) {
						for (let b = 0; b < k; b++) {
							const c = vectorMeshColorAt(paint, i, j, (b + 0.5) / k, (a + 0.5) / k);
							if (c[3] <= 0.0005) continue;
							// Grown a little past its right and bottom edges, over the cells drawn after it.
							const q = [grid[a][b], grid[a][b + 1], grid[a + 1][b + 1], grid[a + 1][b]];
							const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
							const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
							const grow = (p: Vec2) => ({ x: cx + (p.x - cx) * 1.12, y: cy + (p.y - cy) * 1.12 });
							tiles.push({ d: quadD(q.map(grow), precision), fill: vectorRgbaToCss(c) });
						}
					}
				}
			}
		}
	} else if (bounds && paint.points.length) {
		// Horizontal strips, each a linear gradient through the field sampled across it: smooth
		// along x, and strips thin enough that the steps between them do not show.
		const field = vectorFreeformField(paint, vectorFreeformSpreadScale(bounds));
		const n = Math.max(2, Math.min(256, Math.round(options.freeformCells ?? 96)));
		const side = Math.max(area.width, area.height, 1e-9);
		const rows = Math.max(2, Math.ceil((n * area.height) / side));
		const samples = Math.max(2, Math.min(96, Math.ceil((n * area.width) / side) + 1));
		const ch = area.height / rows;
		for (let r = 0; r < rows; r++) {
			const y = area.y + r * ch;
			const stops: SvgGradientStop[] = [];
			for (let k = 0; k < samples; k++) {
				const t = k / (samples - 1);
				const c = sampleVectorFreeform(field, { x: area.x + t * area.width, y: y + ch / 2 });
				const opaque = vectorRgbaToCss([c[0], c[1], c[2], 1]);
				stops.push({ offset: `${fmt(t * 100, 3)}%`, stopColor: opaque, ...(c[3] < 0.9995 ? { stopOpacity: Math.round(Math.max(0, c[3]) * 1000) / 1000 } : {}) });
			}
			const gid = `${id}-r${r}`;
			gradients.push({ id: gid, type: 'linear', attrs: { gradientUnits: 'userSpaceOnUse', x1: fmt(area.x, precision), y1: '0', x2: fmt(area.x + area.width, precision), y2: '0' }, stops });
			// Each strip reaches a quarter into the next, so no seam shows between them.
			const h = r < rows - 1 ? ch * 1.25 : ch;
			tiles.push({ d: quadD([{ x: area.x, y }, { x: area.x + area.width, y }, { x: area.x + area.width, y: y + h }, { x: area.x, y: y + h }], precision), fill: `url(#${gid})` });
		}
	}
	return [{ id, type: 'pattern', attrs: patternAttrs(area), gradients, tiles }];
}

// ---------------------------------------------------------------------------
// Transforms, sanitizing and editing
// ---------------------------------------------------------------------------

const apply = (m: VectorMatrix, p: Vec2): Vec2 => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/** A mesh or freeform paint with every point mapped by `f`. */
export function mapVectorShadedPaint<T extends VectorMeshGradient | VectorFreeformGradient>(paint: T, f: (p: Vec2) => Vec2): T {
	if (isVectorMeshGradient(paint)) return { ...paint, points: paint.points.map((p) => f(p)) } as T;
	return { ...paint, points: (paint as VectorFreeformGradient).points.map((p) => ({ ...p, ...f(p) })) } as T;
}

/** A mesh or freeform paint moved by `m` (it lives in the node's own space, like its geometry). */
export function transformVectorShadedPaint<T extends VectorMeshGradient | VectorFreeformGradient>(paint: T, m: VectorMatrix): T {
	return mapVectorShadedPaint(paint, (p) => apply(m, p));
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const color = (v: unknown): string | null => (typeof v === 'string' && parseVectorColor(v) ? v : null);

/** A mesh or freeform paint from untrusted input (agent commands, SVG data attributes), or null when it is malformed. */
export function sanitizeVectorShadedPaint(input: unknown): VectorMeshGradient | VectorFreeformGradient | null {
	if (!input || typeof input !== 'object') return null;
	const r = input as Record<string, unknown>;
	if (r.type === 'mesh') {
		const rows = r.rows;
		const columns = r.columns;
		if (!finite(rows) || !finite(columns) || rows < 1 || columns < 1 || rows > VECTOR_MESH_MAX || columns > VECTOR_MESH_MAX || !Number.isInteger(rows) || !Number.isInteger(columns)) return null;
		const n = (rows + 1) * (columns + 1);
		if (!Array.isArray(r.points) || !Array.isArray(r.colors) || r.points.length !== n || r.colors.length !== n) return null;
		const points: Vec2[] = [];
		for (const p of r.points as unknown[]) {
			const q = p as Record<string, unknown>;
			if (!q || !finite(q.x) || !finite(q.y)) return null;
			points.push({ x: q.x, y: q.y });
		}
		const colors: string[] = [];
		for (const c of r.colors as unknown[]) {
			const k = color(c);
			if (!k) return null;
			colors.push(k);
		}
		const out: VectorMeshGradient = { type: 'mesh', rows, columns, points, colors };
		if (Array.isArray(r.opacities) && r.opacities.length === n && r.opacities.every(finite)) out.opacities = (r.opacities as number[]).map((o) => Math.min(1, Math.max(0, o)));
		return out;
	}
	if (r.type === 'freeform') {
		if (!Array.isArray(r.points) || !r.points.length) return null;
		const points: VectorFreeformPoint[] = [];
		for (const p of r.points as unknown[]) {
			const q = p as Record<string, unknown>;
			const c = q ? color(q.color) : null;
			if (!q || !finite(q.x) || !finite(q.y) || !c) return null;
			points.push({
				x: q.x,
				y: q.y,
				color: c,
				...(finite(q.opacity) && q.opacity < 1 ? { opacity: Math.max(0, q.opacity) } : {}),
				...(finite(q.spread) && q.spread > 0 ? { spread: Math.min(1, q.spread) } : {})
			});
		}
		const out: VectorFreeformGradient = { type: 'freeform', points };
		if (Array.isArray(r.lines)) {
			const lines = (r.lines as unknown[]).filter((l): l is number[] => Array.isArray(l) && l.length >= 2 && l.every((i) => Number.isInteger(i) && i >= 0 && i < points.length) && l.every((i, k) => k === 0 || i !== l[k - 1]));
			if (lines.length) out.lines = lines.map((l) => [...l]);
		}
		return out;
	}
	return null;
}

/** A freeform gradient with point `index` removed (lines through it close up; lines left with one point go), or null when it is the last point. */
export function removeVectorFreeformPoint(f: VectorFreeformGradient, index: number): VectorFreeformGradient | null {
	if (index < 0 || index >= f.points.length || f.points.length <= 1) return null;
	const points = f.points.filter((_, k) => k !== index);
	const lines = (f.lines ?? [])
		.map((l) =>
			l
				.filter((i) => i !== index)
				.map((i) => (i > index ? i - 1 : i))
				.filter((i, k, arr) => k === 0 || i !== arr[k - 1])
		)
		.filter((l) => l.length >= 2);
	return { type: 'freeform', points, ...(lines.length ? { lines } : {}) };
}

/** The mesh lattice point nearest `p` within `radius`, or the freeform point: its index, or -1. */
export function nearestVectorShadingPoint(paint: VectorMeshGradient | VectorFreeformGradient, p: Vec2, radius: number): number {
	let best = -1;
	let bestD = radius;
	paint.points.forEach((q, k) => {
		const d = Math.hypot(q.x - p.x, q.y - p.y);
		if (d <= bestD) {
			best = k;
			bestD = d;
		}
	});
	return best;
}
