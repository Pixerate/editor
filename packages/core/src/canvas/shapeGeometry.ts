/**
 * Shape geometry: shape descriptions (rect, rounded rect, ellipse, regular polygon, star and
 * SVG path data) to polygons, SVG path parsing / flattening, and polygons back to path data.
 */
import type { Point } from './types.js';
import type { MultiPolygon, PolygonFillRule, PolygonRing } from './polygonBoolean.js';
import { fitPathData } from './curveFit.js';

// ---------------------------------------------------------------------------
// Shape descriptions
// ---------------------------------------------------------------------------

import type { CanvasGradientDef, SvgGradientDef } from './gradient.js';
import type { CanvasBrushstroke } from './brushTypes.js';
import { gradientToSvgDef, resolveCanvasGradient } from './gradient.js';

/** Paint shared by every shape kind. Colours are any CSS colour, preset name, or gradient definition. */
/**
 * A provider effect (see `@pixerate/editor/effects`) drawn on a shape: `fill` paints the shape's
 * inside with the effect (clipped to its outline), `overlay` draws it over the node's box. Kept,
 * and not drawn, without an effects provider.
 */
export interface CanvasShapeEffect {
	/** The provider's effect id. */
	effect: string;
	provider?: string;
	name?: string;
	/** Control values (over the effect's defaults). */
	values: Record<string, number | string | boolean | readonly number[]>;
	mode: 'fill' | 'overlay';
	/** 0–1 (default 1). */
	opacity?: number;
	/** Animated effects play while true (default true); false holds the first frame. */
	playing?: boolean;
}

export interface ShapePaint {
	/** A provider effect drawn on the shape (see `CanvasShapeEffect`). */
	effect?: CanvasShapeEffect;
	fill?: string | CanvasGradientDef;
	stroke?: string | CanvasGradientDef;
	strokeWidth?: number;
	opacity?: number;
	strokeLinecap?: 'round' | 'butt' | 'square';
	strokeLinejoin?: 'round' | 'bevel' | 'miter';
	fillGradient?: CanvasGradientDef;
	strokeGradient?: CanvasGradientDef;
}

interface ShapeBase extends ShapePaint {
	/** Clockwise rotation in degrees (on a y-down canvas) about the centre of the node box. */
	rotation?: number;
}

/** Rectangle filling the node box, optionally with rounded corners. */
export interface RectShape extends ShapeBase {
	kind: 'rect';
	/** One radius, or `[topLeft, topRight, bottomRight, bottomLeft]`. Clamped to fit. */
	cornerRadius?: number | readonly [number, number, number, number];
}

/** Ellipse (circle when the node is square) inscribed in the node box. */
export interface EllipseShape extends ShapeBase {
	kind: 'ellipse';
}

/** Regular polygon, stretched so its bounding box fills the node box. */
export interface RegularPolygonShape extends ShapeBase {
	kind: 'polygon';
	/** Number of sides (at least 3, default 6). The first vertex points up. */
	sides?: number;
}

/** Star, stretched so its bounding box fills the node box. */
export interface StarShape extends ShapeBase {
	kind: 'star';
	/** Number of points (at least 3, default 5). The first point points up. */
	points?: number;
	/** Inner radius as a fraction of the outer radius (default 0.5). */
	innerRadius?: number;
}

/** Arbitrary SVG path data. */
export interface PathShape extends ShapeBase {
	kind: 'path';
	d: string;
	/**
	 * `[minX, minY, width, height]` of the path's coordinate space, scaled to the node box.
	 * Without it the path coordinates are node-local pixels.
	 */
	viewBox?: readonly [number, number, number, number];
	/** Fill rule (default `nonzero`, as in SVG). */
	fillRule?: PolygonFillRule;
	/**
	 * Draw the path with a dry paint brush instead of an SVG stroke (a brushed freehand stroke):
	 * the brush and pen profiles along the path. Rendered by `renderShapeBrushstroke`.
	 */
	brush?: CanvasBrushstroke;
}

/**
 * Shape description stored on a node as `data.shape`. Geometry is relative to the node
 * box (`0,0` to `width,height`), so resizing the node resizes the shape.
 */
export type ShapeDescription = RectShape | EllipseShape | RegularPolygonShape | StarShape | PathShape;

export type ShapeKind = ShapeDescription['kind'];

export const SHAPE_KINDS: readonly ShapeKind[] = ['rect', 'ellipse', 'polygon', 'star', 'path'];

/** Whether a value is a supported shape description. */
export function isShapeDescription(value: unknown): value is ShapeDescription {
	if (!value || typeof value !== 'object') return false;
	const kind = (value as { kind?: unknown }).kind;
	if (!SHAPE_KINDS.includes(kind as ShapeKind)) return false;
	return kind !== 'path' || typeof (value as PathShape).d === 'string';
}

export interface ShapeSize {
	width: number;
	height: number;
}

export interface FlattenOptions {
	/** Maximum distance between a curve and its polyline, in output units (default 0.25). */
	tolerance?: number;
	/** Upper bound on the segments one curve is split into (default 512). */
	maxSegments?: number;
}

// ---------------------------------------------------------------------------
// SVG path parsing
// ---------------------------------------------------------------------------

/** Normalised absolute path command produced by `parseSvgPath`. */
export type PathCommand =
	| { type: 'M'; x: number; y: number }
	| { type: 'L'; x: number; y: number }
	| { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
	| { type: 'Q'; x1: number; y1: number; x: number; y: number }
	| {
			type: 'A';
			rx: number;
			ry: number;
			rotation: number;
			largeArc: boolean;
			sweep: boolean;
			x: number;
			y: number;
	  }
	| { type: 'Z' };

const PARAM_COUNTS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Character scanner for path data (handles `1.5.5`, `1e-3`, `-1-2` and compact arc flags). */
class PathScanner {
	private pos = 0;
	constructor(private readonly text: string) {}

	private skip() {
		while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos])) this.pos++;
	}

	/** The next command letter, or `null` when a number (or the end) follows. */
	command(): string | null {
		this.skip();
		const ch = this.text[this.pos];
		if (ch && /[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
			this.pos++;
			return ch;
		}
		return null;
	}

	done(): boolean {
		this.skip();
		return this.pos >= this.text.length;
	}

	number(): number | null {
		this.skip();
		const match = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.pos, this.pos + 64));
		if (!match) return null;
		this.pos += match[0].length;
		const value = Number(match[0]);
		return Number.isFinite(value) ? value : null;
	}

	flag(): number | null {
		this.skip();
		const ch = this.text[this.pos];
		if (ch === '0' || ch === '1') {
			this.pos++;
			return ch === '1' ? 1 : 0;
		}
		return null;
	}
}

/**
 * Parses SVG path data into absolute `M`, `L`, `C`, `Q`, `A` and `Z` commands. Relative
 * commands, `H` / `V`, smooth curves (`S` / `T`) and implicit repeated commands are
 * normalised. Parsing stops at the first malformed command (as browsers do).
 */
export function parseSvgPath(d: string): PathCommand[] {
	const scanner = new PathScanner(d ?? '');
	const commands: PathCommand[] = [];
	let cx = 0;
	let cy = 0;
	let startX = 0;
	let startY = 0;
	let lastControl: { x: number; y: number; type: 'C' | 'Q' } | null = null;
	let command = '';

	while (!scanner.done()) {
		const letter = scanner.command();
		if (letter) {
			command = letter;
			if (command === 'z' || command === 'Z') {
				commands.push({ type: 'Z' });
				cx = startX;
				cy = startY;
				lastControl = null;
				continue;
			}
		} else if (!command || command === 'z' || command === 'Z') {
			break;
		}
		const lower = command.toLowerCase();
		const count = PARAM_COUNTS[lower];
		const args: number[] = [];
		for (let k = 0; k < count; k++) {
			const value = lower === 'a' && (k === 3 || k === 4) ? scanner.flag() : scanner.number();
			if (value === null) return commands;
			args.push(value);
		}
		const rel = command !== command.toUpperCase();
		const ox = rel ? cx : 0;
		const oy = rel ? cy : 0;
		switch (lower) {
			case 'm': {
				cx = args[0] + ox;
				cy = args[1] + oy;
				startX = cx;
				startY = cy;
				commands.push({ type: 'M', x: cx, y: cy });
				lastControl = null;
				// Extra coordinate pairs after a moveto are implicit linetos.
				command = rel ? 'l' : 'L';
				break;
			}
			case 'l':
				cx = args[0] + ox;
				cy = args[1] + oy;
				commands.push({ type: 'L', x: cx, y: cy });
				lastControl = null;
				break;
			case 'h':
				cx = args[0] + (rel ? cx : 0);
				commands.push({ type: 'L', x: cx, y: cy });
				lastControl = null;
				break;
			case 'v':
				cy = args[0] + (rel ? cy : 0);
				commands.push({ type: 'L', x: cx, y: cy });
				lastControl = null;
				break;
			case 'c': {
				const c: PathCommand = {
					type: 'C',
					x1: args[0] + ox,
					y1: args[1] + oy,
					x2: args[2] + ox,
					y2: args[3] + oy,
					x: args[4] + ox,
					y: args[5] + oy
				};
				commands.push(c);
				lastControl = { x: c.x2, y: c.y2, type: 'C' };
				cx = c.x;
				cy = c.y;
				break;
			}
			case 's': {
				const x1: number = lastControl?.type === 'C' ? 2 * cx - lastControl.x : cx;
				const y1: number = lastControl?.type === 'C' ? 2 * cy - lastControl.y : cy;
				const c: PathCommand = {
					type: 'C',
					x1,
					y1,
					x2: args[0] + ox,
					y2: args[1] + oy,
					x: args[2] + ox,
					y: args[3] + oy
				};
				commands.push(c);
				lastControl = { x: c.x2, y: c.y2, type: 'C' };
				cx = c.x;
				cy = c.y;
				break;
			}
			case 'q': {
				const c: PathCommand = { type: 'Q', x1: args[0] + ox, y1: args[1] + oy, x: args[2] + ox, y: args[3] + oy };
				commands.push(c);
				lastControl = { x: c.x1, y: c.y1, type: 'Q' };
				cx = c.x;
				cy = c.y;
				break;
			}
			case 't': {
				const x1: number = lastControl?.type === 'Q' ? 2 * cx - lastControl.x : cx;
				const y1: number = lastControl?.type === 'Q' ? 2 * cy - lastControl.y : cy;
				const c: PathCommand = { type: 'Q', x1, y1, x: args[0] + ox, y: args[1] + oy };
				commands.push(c);
				lastControl = { x: x1, y: y1, type: 'Q' };
				cx = c.x;
				cy = c.y;
				break;
			}
			case 'a': {
				const c: PathCommand = {
					type: 'A',
					rx: Math.abs(args[0]),
					ry: Math.abs(args[1]),
					rotation: args[2],
					largeArc: args[3] !== 0,
					sweep: args[4] !== 0,
					x: args[5] + ox,
					y: args[6] + oy
				};
				commands.push(c);
				lastControl = null;
				cx = c.x;
				cy = c.y;
				break;
			}
		}
	}
	return commands;
}

// ---------------------------------------------------------------------------
// Curve flattening
// ---------------------------------------------------------------------------

function segmentCount(curvature: number, tolerance: number, max: number): number {
	if (!(curvature > 0)) return 1;
	return Math.max(1, Math.min(max, Math.ceil(Math.sqrt(curvature / tolerance))));
}

function flattenCubic(
	out: Point[],
	p0: Point,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	x: number,
	y: number,
	tolerance: number,
	max: number
) {
	// Uniform subdivision error <= max|B''| / (8 n²) with |B''| <= 6 * max second difference.
	const dd = Math.max(
		Math.hypot(p0[0] - 2 * x1 + x2, p0[1] - 2 * y1 + y2),
		Math.hypot(x1 - 2 * x2 + x, y1 - 2 * y2 + y)
	);
	const n = segmentCount((6 * dd) / 8, tolerance, max);
	for (let k = 1; k <= n; k++) {
		const t = k / n;
		const mt = 1 - t;
		const a = mt * mt * mt;
		const b = 3 * mt * mt * t;
		const c = 3 * mt * t * t;
		const e = t * t * t;
		out.push([a * p0[0] + b * x1 + c * x2 + e * x, a * p0[1] + b * y1 + c * y2 + e * y]);
	}
}

function flattenQuadratic(
	out: Point[],
	p0: Point,
	x1: number,
	y1: number,
	x: number,
	y: number,
	tolerance: number,
	max: number
) {
	const dd = Math.hypot(p0[0] - 2 * x1 + x, p0[1] - 2 * y1 + y);
	const n = segmentCount((2 * dd) / 8, tolerance, max);
	for (let k = 1; k <= n; k++) {
		const t = k / n;
		const mt = 1 - t;
		out.push([mt * mt * p0[0] + 2 * mt * t * x1 + t * t * x, mt * mt * p0[1] + 2 * mt * t * y1 + t * t * y]);
	}
}

function arcSteps(radius: number, sweep: number, tolerance: number, max: number): number {
	if (radius <= tolerance) return Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
	const step = 2 * Math.acos(1 - tolerance / radius);
	return Math.max(1, Math.min(max, Math.ceil(Math.abs(sweep) / step)));
}

/** Flattens an SVG elliptical arc (endpoint parameterisation, SVG 1.1 F.6.5). */
function flattenArc(
	out: Point[],
	p0: Point,
	cmd: Extract<PathCommand, { type: 'A' }>,
	tolerance: number,
	max: number
) {
	const [x0, y0] = p0;
	let { rx, ry } = cmd;
	const { x, y } = cmd;
	if (x0 === x && y0 === y) return;
	if (rx === 0 || ry === 0) {
		out.push([x, y]);
		return;
	}
	const phi = (cmd.rotation * Math.PI) / 180;
	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	const dx = (x0 - x) / 2;
	const dy = (y0 - y) / 2;
	const x1p = cos * dx + sin * dy;
	const y1p = -sin * dx + cos * dy;
	const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
	if (lambda > 1) {
		const s = Math.sqrt(lambda);
		rx *= s;
		ry *= s;
	}
	const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
	const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
	let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
	if (cmd.largeArc === cmd.sweep) coef = -coef;
	const cxp = (coef * rx * y1p) / ry;
	const cyp = (-coef * ry * x1p) / rx;
	const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
	const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
	const angle = (ux: number, uy: number, vx: number, vy: number) => {
		const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
		return a;
	};
	const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
	let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
	if (!cmd.sweep && delta > 0) delta -= 2 * Math.PI;
	else if (cmd.sweep && delta < 0) delta += 2 * Math.PI;
	const n = arcSteps(Math.max(rx, ry), delta, tolerance, max);
	for (let k = 1; k < n; k++) {
		const t = theta1 + (delta * k) / n;
		const ex = rx * Math.cos(t);
		const ey = ry * Math.sin(t);
		out.push([cos * ex - sin * ey + cx, sin * ex + cos * ey + cy]);
	}
	out.push([x, y]);
}

/**
 * Flattens SVG path data into closed rings (one per subpath; open subpaths are closed the
 * way SVG fills them). Curves are approximated within `tolerance`.
 */
export function flattenSvgPath(d: string | PathCommand[], options: FlattenOptions = {}): PolygonRing[] {
	const tolerance = options.tolerance && options.tolerance > 0 ? options.tolerance : 0.25;
	const max = options.maxSegments ?? 512;
	const commands = typeof d === 'string' ? parseSvgPath(d) : d;
	const rings: PolygonRing[] = [];
	let current: Point[] = [];
	let start: Point = [0, 0];
	const flush = () => {
		if (current.length >= 3) rings.push(current);
		current = [];
	};
	const last = (): Point => current[current.length - 1] ?? start;
	for (const cmd of commands) {
		switch (cmd.type) {
			case 'M':
				flush();
				start = [cmd.x, cmd.y];
				current = [start];
				break;
			case 'L':
				if (current.length === 0) current = [start];
				current.push([cmd.x, cmd.y]);
				break;
			case 'C':
				if (current.length === 0) current = [start];
				flattenCubic(current, last(), cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y, tolerance, max);
				break;
			case 'Q':
				if (current.length === 0) current = [start];
				flattenQuadratic(current, last(), cmd.x1, cmd.y1, cmd.x, cmd.y, tolerance, max);
				break;
			case 'A':
				if (current.length === 0) current = [start];
				flattenArc(current, last(), cmd, tolerance, max);
				break;
			case 'Z':
				flush();
				// A command after Z without a moveto starts at the subpath start.
				break;
		}
	}
	flush();
	return rings.map(dedupeRing).filter((r) => r.length >= 3);
}

function dedupeRing(ring: Point[]): Point[] {
	const out: Point[] = [];
	for (const p of ring) {
		const prev = out[out.length - 1];
		if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
	}
	while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
	return out;
}

// ---------------------------------------------------------------------------
// Shapes to polygons
// ---------------------------------------------------------------------------

function cornerRadii(shape: RectShape, width: number, height: number): [number, number, number, number] {
	const raw = shape.cornerRadius ?? 0;
	let radii = (typeof raw === 'number' ? [raw, raw, raw, raw] : [...raw]).map((r) =>
		Number.isFinite(r) && r > 0 ? r : 0
	) as [number, number, number, number];
	// Scale all radii down together when adjacent corners would overlap (CSS rule).
	const factor = Math.min(
		1,
		width / Math.max(radii[0] + radii[1], 1e-12),
		height / Math.max(radii[1] + radii[2], 1e-12),
		width / Math.max(radii[2] + radii[3], 1e-12),
		height / Math.max(radii[3] + radii[0], 1e-12)
	);
	if (factor < 1) radii = radii.map((r) => r * factor) as [number, number, number, number];
	return radii;
}

/** Unit vertices of a regular polygon / star, stretched to fill the box. */
function polygonVertices(count: number, inner: number | null, width: number, height: number): Point[] {
	const raw: Point[] = [];
	const total = inner === null ? count : count * 2;
	for (let k = 0; k < total; k++) {
		const angle = -Math.PI / 2 + (k * 2 * Math.PI) / total;
		const r = inner !== null && k % 2 === 1 ? inner : 1;
		raw.push([r * Math.cos(angle), r * Math.sin(angle)]);
	}
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of raw) {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	const sx = width / (maxX - minX || 1);
	const sy = height / (maxY - minY || 1);
	return raw.map(([x, y]) => [(x - minX) * sx, (y - minY) * sy]);
}

function rotationTransform(shape: ShapeDescription, size: ShapeSize): ((p: Point) => Point) | null {
	const deg = shape.rotation ?? 0;
	if (!deg || !Number.isFinite(deg)) return null;
	const rad = (deg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const cx = size.width / 2;
	const cy = size.height / 2;
	return ([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
}

/**
 * SVG path data for a shape in node-local pixels (exact curves: arcs for rounded corners
 * and ellipses), plus the fill rule and a `transform` for rotation / path view boxes.
 * Use it to render a shape; use `shapeToPolygon` for geometry.
 */
export function getShapeSvg(
	shape: ShapeDescription,
	size: ShapeSize
): { d: string; transform?: string; fillRule: PolygonFillRule } {
	const { width: w, height: h } = size;
	const f = (n: number) => formatNumber(n, 3);
	const transforms: string[] = [];
	if (shape.rotation) transforms.push(`rotate(${f(shape.rotation)} ${f(w / 2)} ${f(h / 2)})`);
	let d = '';
	let fillRule: PolygonFillRule = 'nonzero';
	switch (shape.kind) {
		case 'rect': {
			const [tl, tr, br, bl] = cornerRadii(shape, w, h);
			if (tl + tr + br + bl === 0) {
				d = `M0 0H${f(w)}V${f(h)}H0Z`;
			} else {
				const arc = (r: number, x: number, y: number) => (r > 0 ? `A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y)}` : '');
				d =
					`M${f(tl)} 0H${f(w - tr)}${arc(tr, w, tr)}V${f(h - br)}${arc(br, w - br, h)}` +
					`H${f(bl)}${arc(bl, 0, h - bl)}V${f(tl)}${arc(tl, tl, 0)}Z`;
			}
			break;
		}
		case 'ellipse': {
			const rx = w / 2;
			const ry = h / 2;
			d = `M0 ${f(ry)}A${f(rx)} ${f(ry)} 0 1 1 ${f(w)} ${f(ry)}A${f(rx)} ${f(ry)} 0 1 1 0 ${f(ry)}Z`;
			break;
		}
		case 'polygon':
		case 'star': {
			const points =
				shape.kind === 'polygon'
					? polygonVertices(Math.max(3, Math.floor(shape.sides ?? 6)), null, w, h)
					: polygonVertices(Math.max(3, Math.floor(shape.points ?? 5)), clampRatio(shape.innerRadius), w, h);
			d = ringsToPath([points], f);
			break;
		}
		case 'path': {
			d = shape.d;
			fillRule = shape.fillRule ?? 'nonzero';
			const vb = validViewBox(shape.viewBox);
			if (vb) {
				transforms.push(
					`scale(${f(w / vb[2])} ${f(h / vb[3])})`,
					`translate(${f(-vb[0])} ${f(-vb[1])})`
				);
			}
			break;
		}
	}
	return transforms.length > 0 ? { d, transform: transforms.join(' '), fillRule } : { d, fillRule };
}

/** Everything a renderer needs to draw a shape as one SVG `<path>`. */
export interface ShapeRenderData {
	/** SVG `viewBox` (`0 0 width height`): node-local pixels. */
	viewBox: string;
	width: number;
	height: number;
	d: string;
	transform?: string;
	fillRule: PolygonFillRule;
	fill: string;
	stroke: string;
	strokeWidth: number;
	opacity?: number;
	strokeLinecap?: 'round' | 'butt' | 'square';
	strokeLinejoin?: 'round' | 'bevel' | 'miter';
	/** Gradient def for the fill, when fill uses a gradient. */
	fillGradient?: SvgGradientDef;
	/** Gradient def for the stroke, when stroke uses a gradient. */
	strokeGradient?: SvgGradientDef;
}

export interface GetShapeRenderDataOptions {
	/** Unique ID suffix or base ID used when generating SVG gradient IDs (default: auto random). */
	id?: string;
}

/**
 * Resolves the SVG drawing of a shape for a node size. Without a size, a path's view box
 * size (or 100x100) is used. Paint defaults: `fill: currentColor`, `stroke: none`,
 * `strokeWidth: 1`. Supports solid colors, CSS gradients, presets, and CanvasGradientDef.
 */
export function getShapeRenderData(
	shape: ShapeDescription,
	size: Partial<ShapeSize> = {},
	options: GetShapeRenderDataOptions = {}
): ShapeRenderData {
	const vb = shape.kind === 'path' ? validViewBox(shape.viewBox) : null;
	const width = size.width && size.width > 0 ? size.width : vb ? vb[2] : 100;
	const height = size.height && size.height > 0 ? size.height : vb ? vb[3] : 100;
	const svg = getShapeSvg(shape, { width, height });

	const baseId = options.id || Math.random().toString(36).slice(2, 9);

	// Resolve fill (gradient or solid)
	let fillStr = 'currentColor';
	let fillGradientDef: SvgGradientDef | undefined;
	const rawFill = shape.fillGradient ?? shape.fill;
	const resolvedFillGradient = resolveCanvasGradient(rawFill);
	if (resolvedFillGradient) {
		const gradId = `shape-fill-${baseId}`;
		fillGradientDef = gradientToSvgDef(resolvedFillGradient, gradId);
		fillStr = `url(#${gradId})`;
	} else if (typeof shape.fill === 'string') {
		fillStr = shape.fill;
	} else if (shape.fill === undefined) {
		fillStr = 'currentColor';
	}

	// Resolve stroke (gradient or solid)
	let strokeStr = 'none';
	let strokeGradientDef: SvgGradientDef | undefined;
	const rawStroke = shape.strokeGradient ?? shape.stroke;
	const resolvedStrokeGradient = resolveCanvasGradient(rawStroke);
	if (resolvedStrokeGradient) {
		const gradId = `shape-stroke-${baseId}`;
		strokeGradientDef = gradientToSvgDef(resolvedStrokeGradient, gradId);
		strokeStr = `url(#${gradId})`;
	} else if (typeof shape.stroke === 'string') {
		strokeStr = shape.stroke;
	} else if (shape.stroke === undefined) {
		strokeStr = 'none';
	}

	const data: ShapeRenderData = {
		viewBox: `0 0 ${formatNumber(width, 3)} ${formatNumber(height, 3)}`,
		width,
		height,
		d: svg.d,
		fillRule: svg.fillRule,
		fill: fillStr,
		stroke: strokeStr,
		strokeWidth: shape.strokeWidth ?? 1
	};
	if (svg.transform) data.transform = svg.transform;
	if (shape.opacity !== undefined) data.opacity = shape.opacity;
	if (shape.strokeLinecap) data.strokeLinecap = shape.strokeLinecap;
	if (shape.strokeLinejoin) data.strokeLinejoin = shape.strokeLinejoin;
	if (fillGradientDef) data.fillGradient = fillGradientDef;
	if (strokeGradientDef) data.strokeGradient = strokeGradientDef;
	return data;
}

function clampRatio(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0.5;
	return Math.min(1, Math.max(0.01, value));
}

function validViewBox(vb: PathShape['viewBox']): readonly [number, number, number, number] | null {
	if (!vb || vb.length !== 4 || !vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0) return null;
	return vb;
}

/**
 * Converts a shape to rings in node-local pixels (rotation applied), flattening curves at
 * `tolerance`. Returns the rings with the fill rule they must be read with.
 */
export function shapeToPolygon(
	shape: ShapeDescription,
	size: ShapeSize,
	options: FlattenOptions = {}
): { rings: PolygonRing[]; fillRule: PolygonFillRule } {
	const { width: w, height: h } = size;
	if (!(w > 0) || !(h > 0)) return { rings: [], fillRule: 'nonzero' };
	let rings: PolygonRing[];
	let fillRule: PolygonFillRule = 'nonzero';
	if (shape.kind === 'path') {
		fillRule = shape.fillRule ?? 'nonzero';
		const vb = validViewBox(shape.viewBox);
		if (vb) {
			const sx = w / vb[2];
			const sy = h / vb[3];
			// Flatten in path units with the tolerance scaled to stay within `tolerance` px.
			const tolerance = (options.tolerance ?? 0.25) / Math.max(sx, sy);
			rings = flattenSvgPath(shape.d, { ...options, tolerance }).map((ring) =>
				ring.map(([x, y]) => [(x - vb[0]) * sx, (y - vb[1]) * sy] as Point)
			);
		} else {
			rings = flattenSvgPath(shape.d, options);
		}
	} else {
		const { d } = getShapeSvg({ ...shape, rotation: 0 }, size);
		rings = flattenSvgPath(d, options);
	}
	const rotate = rotationTransform(shape, size);
	if (rotate) rings = rings.map((ring) => ring.map(rotate));
	return { rings, fillRule };
}

// ---------------------------------------------------------------------------
// Polygons to path data
// ---------------------------------------------------------------------------

/** Formats a number with at most `precision` decimals, without trailing zeros. */
export function formatNumber(value: number, precision = 3): string {
	const factor = 10 ** precision;
	const rounded = Math.round(value * factor) / factor;
	return Object.is(rounded, -0) ? '0' : String(rounded);
}

function ringsToPath(rings: readonly (readonly Point[])[], f: (n: number) => string): string {
	let d = '';
	for (const ring of rings) {
		if (ring.length < 2) continue;
		d += `M${f(ring[0][0])} ${f(ring[0][1])}`;
		for (let i = 1; i < ring.length; i++) d += `L${f(ring[i][0])} ${f(ring[i][1])}`;
		d += 'Z';
	}
	return d;
}

/** Perpendicular distance from `p` to the segment `a`–`b`. */
function segmentDistance(p: Point, a: Point, b: Point): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len2 = dx * dx + dy * dy;
	if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
	const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function rdp(points: Point[], tolerance: number): Point[] {
	if (points.length <= 2) return points;
	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;
	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length) {
		const [s, e] = stack.pop()!;
		let maxDist = -1;
		let index = -1;
		for (let i = s + 1; i < e; i++) {
			const dist = segmentDistance(points[i], points[s], points[e]);
			if (dist > maxDist) {
				maxDist = dist;
				index = i;
			}
		}
		if (index !== -1 && maxDist > tolerance) {
			keep[index] = 1;
			stack.push([s, index], [index, e]);
		}
	}
	return points.filter((_, i) => keep[i]);
}

/**
 * Simplifies a closed ring with Ramer–Douglas–Peucker at `tolerance`. Returns an empty
 * ring when fewer than three points survive.
 */
export function simplifyRing(ring: readonly Point[], tolerance: number): Point[] {
	if (ring.length <= 3 || !(tolerance > 0)) return [...ring];
	// Anchor on the point farthest from the first one so the closing seam is not lost.
	let far = 0;
	let farDist = -1;
	for (let i = 1; i < ring.length; i++) {
		const dist = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
		if (dist > farDist) {
			farDist = dist;
			far = i;
		}
	}
	const first = rdp(ring.slice(0, far + 1) as Point[], tolerance);
	const second = rdp([...ring.slice(far), ring[0]] as Point[], tolerance);
	const out = [...first.slice(0, -1), ...second.slice(0, -1)];
	return out.length >= 3 ? out : [];
}

export interface PolygonToPathOptions {
	/** Decimal places in the output (default 3). */
	precision?: number;
	/** Ramer–Douglas–Peucker tolerance; `0` (default) keeps every vertex. */
	simplify?: number;
	/** Added to every point before formatting (e.g. to make coordinates node-local). */
	offset?: { x: number; y: number };
	/**
	 * `'lines'` (default) writes every ring as `M`/`L`/`Z`. `'fit'` fits cubic Béziers to each
	 * ring (`fitPathData`), so flattened curves come back as smooth `C` curves while sharp
	 * corners (turning more than `cornerAngleDeg`) and straight edges stay as they are.
	 */
	curves?: 'lines' | 'fit';
	/** Curve-fitting tolerance in path units for `curves: 'fit'` (default 0.25). */
	curveTolerance?: number;
	/** Corner threshold in degrees for `curves: 'fit'` (default 30). */
	cornerAngleDeg?: number;
}

/**
 * Converts a multi-polygon (or a list of rings) to SVG path data using `M`/`L`/`Z`. Holes
 * keep their opposite orientation, so the path fills correctly with either fill rule.
 */
export function polygonToSvgPath(input: MultiPolygon | PolygonRing[], options: PolygonToPathOptions = {}): string {
	const precision = options.precision ?? 3;
	const f = (n: number) => formatNumber(n, precision);
	const dx = options.offset?.x ?? 0;
	const dy = options.offset?.y ?? 0;
	const rings: Point[][] = [];
	const fit = options.curves === 'fit';
	let fitted = '';
	for (const item of input as any[]) {
		const list: Point[][] =
			item.length > 0 && Array.isArray(item[0]) && Array.isArray(item[0][0]) ? item : [item];
		for (const ring of list) {
			let r = ring;
			if (options.simplify && options.simplify > 0) r = simplifyRing(r, options.simplify);
			if (r.length < 3) continue;
			if (fit) {
				fitted += fitPathData(r, {
					tolerance: options.curveTolerance ?? 0.25,
					cornerAngleDeg: options.cornerAngleDeg,
					precision,
					offset: { x: dx, y: dy }
				});
				continue;
			}
			rings.push(dx || dy ? r.map(([x, y]) => [x + dx, y + dy] as Point) : r);
		}
	}
	return fit ? fitted : ringsToPath(rings, f);
}
