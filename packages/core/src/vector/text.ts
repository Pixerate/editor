// Portions ported from effectcraft/crates/text/src/path_text.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Text nodes: layout through the shared text engine (`src/text`, also used by the image editor's
 * type layers), glyph placement for point, area and path text, glyph outlines, and the pure edits
 * the controller and agent commands build on.
 *
 * Fonts come from one text shaper per page (`setVectorTextShaper`; the controller's `textShaper`
 * option sets it). In browsers the default is the Canvas 2D shaper (the browser's own fonts, no
 * outlines: text draws as SVG `<text>`), elsewhere a metric shaper that estimates advances. With an
 * outline shaper (`createOutlineTextShaper` over fonts read by `parseOpenTypeFont`), text draws as
 * its glyph outlines, so path effects, envelopes and Create Outlines work on it.
 */

import { toBezierPath, transformBezierPath, type BezierPath } from '../canvas/pathops/bezier.js';
import { caretAt, DEFAULT_AUTO_LEADING, fitRuns, isTextSpace, layoutText, restyleRange, spliceRuns, styleAt, textDecorations, textFragmentOutline, textIndexAt, textRectPath, type LaidFragment, type LaidLine, type TextLayout } from '../text/layout.js';
import { createCanvasTextShaper, createMetricTextShaper, cssFontFamily } from '../text/shapers.js';
import type { ParagraphStyle, TextFont, TextShaper, TextStyle } from '../text/types.js';
import { applyMatrix, isIdentityMatrix } from '../geom/affine.js';
import type { AffineMatrix } from '../geom/types.js';
import type {
	Vec2,
	VectorBounds,
	VectorCharacterStyle,
	VectorPaint,
	VectorParagraphStyle,
	VectorPathNode,
	VectorPathTextBaseline,
	VectorSubpath,
	VectorTextFrame,
	VectorTextNode,
	VectorTextRun,
	VectorTextRunStyle
} from './types.js';
import { VECTOR_PATH_TEXT_BASELINES, VECTOR_TEXT_ALIGNS } from './types.js';

// ---------------------------------------------------------------------------
// Shaper
// ---------------------------------------------------------------------------

let current: TextShaper | null = null;
let generation = 0;

/**
 * Sets the text shaper every vector editor on the page lays text out with (`null`: back to the
 * default). Text nodes already laid out with another shaper lay out again when next drawn.
 */
export function setVectorTextShaper(shaper: TextShaper | null): void {
	if (shaper === current) return;
	current = shaper;
	generation++;
}

/** The text shaper in use: the one set, else the browser's (Canvas 2D), else the metric shaper. */
export function getVectorTextShaper(): TextShaper {
	if (!current) current = createCanvasTextShaper() ?? createMetricTextShaper();
	return current;
}

/** Bumped whenever the shaper changes (part of every layout cache key). */
export function vectorTextShaperGeneration(): number {
	return generation;
}

/** Whether the shaper gives glyph outlines (text then draws as paths, and Create Outlines works). */
export function vectorTextHasOutlines(): boolean {
	return typeof getVectorTextShaper().outline === 'function';
}

/** Families the shaper can draw, when it can tell (always includes the generic families). */
export function vectorTextFamilies(): string[] {
	return getVectorTextShaper().families?.() ?? ['sans-serif', 'serif', 'monospace'];
}

// ---------------------------------------------------------------------------
// Styles and runs
// ---------------------------------------------------------------------------

export const DEFAULT_VECTOR_FONT: Readonly<VectorCharacterStyle> = { fontFamily: 'sans-serif', fontWeight: 400, fontSize: 24 };

/** Character style fields, in the order agents see them. */
export const VECTOR_CHARACTER_STYLE_KEYS = ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'tracking', 'leading', 'baselineShift', 'underline', 'strikethrough'] as const;
/** Paragraph style fields. */
export const VECTOR_PARAGRAPH_STYLE_KEYS = ['align', 'autoLeading', 'firstLineIndent', 'startIndent', 'endIndent', 'spaceBefore', 'spaceAfter'] as const;

export class VectorTextError extends Error {}
const fail = (message: string): never => {
	throw new VectorTextError(message);
};

/** A resolved run: the node's style with the run's fields over it. */
export interface VectorResolvedRun {
	start: number;
	end: number;
	style: VectorCharacterStyle;
	/** The run's own fill, when it has one. */
	fill?: VectorPaint;
}

/**
 * Runs fitted to a text of `length`: cut at its end, and text past the last run in the node's own
 * style (an empty override). Neighbours with equal styles merge.
 */
export function fitVectorTextRuns(runs: readonly VectorTextRun[], length: number): VectorTextRun[] {
	const out: VectorTextRun[] = [];
	let left = length;
	for (const r of runs) {
		if (left <= 0) break;
		const n = Math.min(Math.max(0, Math.floor(r.length)), left);
		if (n > 0) out.push({ length: n, style: r.style });
		left -= n;
	}
	if (left > 0) out.push({ length: left, style: {} });
	return fitRuns(out, length, {});
}

/** The node's runs fitted to its text, each with the full style it draws in. */
export function vectorTextRuns(node: Pick<VectorTextNode, 'text' | 'font' | 'runs'>): VectorResolvedRun[] {
	const runs = fitVectorTextRuns(node.runs ?? [], node.text.length);
	const out: VectorResolvedRun[] = [];
	let at = 0;
	for (const r of runs) {
		const { fill, ...fields } = r.style;
		const style = { ...node.font, ...stripUndefined(fields) } as VectorCharacterStyle;
		out.push({ start: at, end: at + r.length, style, ...(fill !== undefined ? { fill } : {}) });
		at += r.length;
	}
	if (!out.length) out.push({ start: 0, end: 0, style: { ...node.font } });
	return out;
}

function stripUndefined<T extends object>(o: T): T {
	const out = { ...o } as Record<string, unknown>;
	for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
	return out as T;
}

/** The style at code unit `index` (the run holding it; past the end, the last run). */
export function vectorTextStyleAt(node: Pick<VectorTextNode, 'text' | 'font' | 'runs'>, index: number): VectorResolvedRun {
	const runs = vectorTextRuns(node);
	return runs.find((r) => index >= r.start && index < r.end) ?? runs[runs.length - 1];
}

const paintKey = (paint: VectorPaint | undefined) => (paint === undefined ? '' : JSON.stringify(paint));

// ---------------------------------------------------------------------------
// Path measure (text on a path)
// ---------------------------------------------------------------------------

/** A subpath flattened and measured by arc length. */
export interface VectorPathMeasure {
	points: Vec2[];
	/** Cumulative length at each point. */
	lengths: number[];
	closed: boolean;
	length: number;
}

function flattenCommands(path: BezierPath): { points: Vec2[]; closed: boolean } {
	const pts: Vec2[] = [];
	let closed = false;
	let cur: Vec2 = { x: 0, y: 0 };
	let started = false;
	const push = (p: Vec2) => {
		const last = pts[pts.length - 1];
		if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 1e-9) pts.push(p);
	};
	for (const c of path) {
		if (c.type === 'M') {
			if (started) break;
			started = true;
			cur = { x: c.x, y: c.y };
			push(cur);
		} else if (c.type === 'L') {
			cur = { x: c.x, y: c.y };
			push(cur);
		} else if (c.type === 'Q' || c.type === 'C') {
			const p0 = cur;
			const ctrl = c.type === 'Q' ? [{ x: c.x1, y: c.y1 }] : [{ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }];
			const p3 = { x: c.x, y: c.y };
			const chord = [p0, ...ctrl, p3].reduce((s, p, i, a) => (i ? s + Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) : 0), 0);
			const n = Math.max(4, Math.min(256, Math.ceil(chord / 2)));
			for (let i = 1; i <= n; i++) {
				const t = i / n;
				const u = 1 - t;
				if (c.type === 'Q') push({ x: u * u * p0.x + 2 * u * t * c.x1 + t * t * p3.x, y: u * u * p0.y + 2 * u * t * c.y1 + t * t * p3.y });
				else
					push({
						x: u * u * u * p0.x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * p3.x,
						y: u * u * u * p0.y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * p3.y
					});
			}
			cur = p3;
		} else if (c.type === 'Z') {
			closed = true;
			if (pts.length > 1) push({ ...pts[0] });
			break;
		}
	}
	return { points: pts, closed };
}

/** Measures a path's first subpath by arc length (reversed when `reverse`). */
export function measureVectorPath(path: BezierPath, reverse = false): VectorPathMeasure {
	const { points, closed } = flattenCommands(path);
	if (reverse) points.reverse();
	const lengths: number[] = [];
	let acc = 0;
	points.forEach((p, i) => {
		if (i) acc += Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y);
		lengths.push(acc);
	});
	return { points, lengths, closed, length: acc };
}

/**
 * Point and unit tangent at arc length `s`. Closed paths wrap; open paths continue straight along
 * their end tangents past either end.
 */
export function vectorPathAt(m: VectorPathMeasure, s: number): { point: Vec2; tangent: Vec2 } {
	const pts = m.points;
	if (pts.length < 2 || m.length <= 1e-9) return { point: pts[0] ?? { x: 0, y: 0 }, tangent: { x: 1, y: 0 } };
	if (m.closed) s = ((s % m.length) + m.length) % m.length;
	let lo = 0;
	let hi = pts.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (m.lengths[mid] <= s) lo = mid;
		else hi = mid;
	}
	const a = pts[lo];
	const b = pts[lo + 1];
	const seg = m.lengths[lo + 1] - m.lengths[lo];
	const tangent = seg > 0 ? { x: (b.x - a.x) / seg, y: (b.y - a.y) / seg } : { x: 1, y: 0 };
	const d = s - m.lengths[lo];
	return { point: { x: a.x + tangent.x * d, y: a.y + tangent.y * d }, tangent };
}

/**
 * Arc-length positions for character pivots along a path: `xs` are the pivots along the line,
 * `[x0, x1]` the line's extent. `left` / `center` / `right` keep the spacing; `justify` spreads the
 * pivots over the path between the margins.
 */
export function vectorPathTextPositions(xs: readonly number[], line: [number, number], align: 'left' | 'center' | 'right' | 'justify', length: number, start: number, end: number): number[] {
	if (!xs.length) return [];
	if (align === 'justify') {
		const a = start;
		const b = length - end;
		const x0 = xs[0];
		const x1 = xs[xs.length - 1];
		if (Math.abs(x1 - x0) < 1e-9) return xs.map(() => a);
		return xs.map((x) => a + ((b - a) * (x - x0)) / (x1 - x0));
	}
	if (align === 'center') {
		const mid = (start + length - end) / 2;
		const c = (line[0] + line[1]) / 2;
		return xs.map((x) => mid + x - c);
	}
	if (align === 'right') return xs.map((x) => length - end - (line[1] - x));
	return xs.map((x) => start + x - line[0]);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** One placed character, in the node's own space. */
export interface VectorTextGlyph {
	/** Index of its first code unit in the text. */
	index: number;
	/** The character (two code units for a surrogate pair). */
	char: string;
	/** Its origin: the start of the character on the baseline. */
	x: number;
	y: number;
	/** Turn in degrees, clockwise on screen (0 for point and area text). */
	angle: number;
	advance: number;
	/** The line's ascent and descent around the baseline. */
	ascent: number;
	descent: number;
	/** Index into `fragments`. */
	fragment: number;
}

/** A run of glyphs in one style on one line. */
export interface VectorTextFragment {
	style: VectorCharacterStyle;
	/** The font as the shaper resolved it (its family may be a fallback). */
	font: TextFont;
	fill?: VectorPaint;
	/** Glyphs of this fragment: `glyphs.slice(from, to)`. */
	from: number;
	to: number;
	line: number;
	/** The shared engine's fragment and line (point and area text). */
	laid?: { fragment: LaidFragment; line: LaidLine };
}

/** A laid-out text node. */
export interface VectorTextLayout {
	/** The shaper it was laid out with. */
	shaper: string;
	glyphs: VectorTextGlyph[];
	fragments: VectorTextFragment[];
	/** Lines: their text range and baseline (node space for point and area text). */
	lines: { start: number; end: number; baseline: number; x: number; width: number }[];
	/** Where text space (the shared layout's) starts in the node: the frame's origin. */
	origin: Vec2;
	/** The shared layout in text space (one line for path text). */
	text: TextLayout;
	/** Bounds of the glyph boxes (or the frame box of area text), node space; null when empty. */
	bounds: VectorBounds | null;
	/** Text that does not fit (lines below an area's box, characters past a path's end). */
	overflow: boolean;
	/** Families drawn with a fallback. */
	missingFonts: string[];
}

/** The node as the shared engine's text block (text space). */
function textBlock(node: VectorTextNode): { text: string; runs: Array<{ length: number; style: TextStyle }>; paragraphs: Array<{ length: number; style: ParagraphStyle }>; frame: { kind: 'point' } | { kind: 'box'; width: number; height: number } } {
	const runs = vectorTextRuns(node);
	const keys: string[] = [];
	const text = node.frame.kind === 'path' ? node.text.replace(/\n/g, ' ') : node.text;
	return {
		text,
		runs: runs.map((r) => {
			const k = paintKey(r.fill);
			let i = keys.indexOf(k);
			if (i < 0) i = keys.push(k) - 1;
			// `color` keeps runs of different fills apart (layout does not draw).
			return { length: r.end - r.start, style: { ...r.style, color: `#${i}` } as TextStyle };
		}),
		paragraphs: [{ length: text.length, style: { ...(node.paragraph ?? {}), ...(node.frame.kind === 'path' ? { align: 'left' as const } : {}) } }],
		frame: node.frame.kind === 'area' ? { kind: 'box', width: Math.max(0, node.frame.width), height: Math.max(0, node.frame.height) } : { kind: 'point' }
	};
}

/** Code units of the character at `i` (2 for a surrogate pair). */
const charAt = (text: string, i: number) => {
	const c = text.charCodeAt(i);
	return c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? text.slice(i, i + 2) : text[i];
};

const layoutCache = new WeakMap<object, { key: string; layout: VectorTextLayout }>();

/** Lays out a text node with the current shaper (memoised per node object and shaper). */
export function layoutVectorText(node: VectorTextNode): VectorTextLayout {
	const shaper = getVectorTextShaper();
	const key = `${shaper.id}:${generation}`;
	const hit = layoutCache.get(node);
	if (hit && hit.key === key) return hit.layout;
	const layout = computeLayout(node, shaper);
	layoutCache.set(node, { key, layout });
	return layout;
}

function computeLayout(node: VectorTextNode, shaper: TextShaper): VectorTextLayout {
	const block = textBlock(node);
	const runs = vectorTextRuns(node);
	const text = layoutText(block, shaper);
	const frame = node.frame;
	const origin = frame.kind === 'path' ? { x: 0, y: 0 } : { x: frame.x, y: frame.y };
	const glyphs: VectorTextGlyph[] = [];
	const fragments: VectorTextFragment[] = [];
	const lines: VectorTextLayout['lines'] = [];
	let overflow = false;
	const fillOf = (f: LaidFragment) => runs.find((r) => f.start >= r.start && f.start < r.end)?.fill;
	const styleOf = (f: LaidFragment): VectorCharacterStyle => {
		const { color: _c, opacity: _o, postScriptName: _p, ...style } = f.style;
		return style as VectorCharacterStyle;
	};
	if (frame.kind !== 'path') {
		text.lines.forEach((l, li) => {
			if (frame.kind === 'area' && li > 0 && l.baseline + l.descent > frame.height + 1e-6) {
				overflow = true;
				return;
			}
			lines.push({ start: l.start, end: l.end, baseline: origin.y + l.baseline, x: origin.x + l.x, width: l.width });
			for (const f of l.fragments) {
				const from = glyphs.length;
				for (let k = 0; k < f.end - f.start; k++) {
					const index = f.start + k;
					const ch = block.text[index];
					const lo = ch.charCodeAt(0);
					if (lo >= 0xdc00 && lo <= 0xdfff && k > 0) {
						// The low half of a pair: its advance joins the high half's glyph.
						const g = glyphs[glyphs.length - 1];
						if (g) g.advance += f.carets[k + 1] - f.carets[k];
						continue;
					}
					glyphs.push({ index, char: charAt(block.text, index), x: origin.x + f.x + f.carets[k], y: origin.y + f.y, angle: 0, advance: f.carets[k + 1] - f.carets[k], ascent: l.ascent, descent: l.descent, fragment: fragments.length });
				}
				fragments.push({ style: styleOf(f), font: f.font, ...(fillOf(f) !== undefined ? { fill: fillOf(f) } : {}), from, to: glyphs.length, line: lines.length - 1, laid: { fragment: f, line: l } });
			}
		});
	} else {
		const line = text.lines[0];
		const measure = measureVectorPath(subpathPath(frame.path), !!frame.flip);
		const align = node.paragraph?.align ?? 'left';
		const start = Math.max(0, frame.start ?? 0);
		const end = Math.max(0, frame.end ?? 0);
		const upright = frame.orientation === 'upright';
		const baselineOffset = pathBaselineOffset(frame.baseline ?? 'baseline', line?.ascent ?? 0, line?.descent ?? 0);
		if (line) {
			const chars = line.chars.filter((c) => {
				const lo = block.text.charCodeAt(c.index);
				return !(lo >= 0xdc00 && lo <= 0xdfff && c.index > 0 && block.text.charCodeAt(c.index - 1) >= 0xd800 && block.text.charCodeAt(c.index - 1) <= 0xdbff);
			});
			const advanceOf = (c: (typeof chars)[number]) => {
				const pair = charAt(block.text, c.index).length === 2;
				const low = pair ? line.chars.find((d) => d.index === c.index + 1) : undefined;
				return c.advance + (low?.advance ?? 0);
			};
			const pivots = chars.map((c) => c.x + advanceOf(c) / 2);
			const positions = vectorPathTextPositions(pivots, [line.x, line.x + line.width], align, measure.length, start, end);
			const limit = measure.length - end;
			lines.push({ start: line.start, end: line.end, baseline: 0, x: 0, width: line.width });
			for (const f of line.fragments) {
				const from = glyphs.length;
				const shift = f.y - line.baseline;
				chars.forEach((c, k) => {
					if (c.index < f.start || c.index >= f.end) return;
					const s = positions[k];
					const adv = advanceOf(c);
					if (s - adv / 2 < start - 1e-6 || s + adv / 2 > limit + 1e-6) {
						if (!isTextSpace(block.text[c.index])) overflow = true;
						return;
					}
					const { point, tangent } = vectorPathAt(measure, s);
					const t = upright ? { x: 1, y: 0 } : tangent;
					const n = upright ? { x: 0, y: 1 } : { x: -tangent.y, y: tangent.x };
					const off = baselineOffset + shift;
					glyphs.push({
						index: c.index,
						char: charAt(block.text, c.index),
						x: point.x + n.x * off - (t.x * adv) / 2,
						y: point.y + n.y * off - (t.y * adv) / 2,
						angle: upright ? 0 : (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI,
						advance: adv,
						ascent: line.ascent,
						descent: line.descent,
						fragment: fragments.length
					});
				});
				fragments.push({ style: styleOf(f), font: f.font, ...(fillOf(f) !== undefined ? { fill: fillOf(f) } : {}), from, to: glyphs.length, line: 0 });
			}
		}
	}
	let bounds: VectorBounds | null = null;
	if (frame.kind === 'area') bounds = { x: frame.x, y: frame.y, width: Math.max(0, frame.width), height: Math.max(0, frame.height) };
	else {
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (const g of glyphs) {
			for (const p of glyphBox(g)) {
				x0 = Math.min(x0, p.x);
				y0 = Math.min(y0, p.y);
				x1 = Math.max(x1, p.x);
				y1 = Math.max(y1, p.y);
			}
		}
		if (x0 < Infinity) bounds = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
		else if (frame.kind === 'point') {
			// Empty point text still has a place: a zero-width line at its origin.
			const l = text.lines[0];
			bounds = { x: frame.x, y: frame.y - (l?.ascent ?? 0), width: 0, height: (l?.ascent ?? 0) + (l?.descent ?? 0) };
		}
	}
	return { shaper: shaper.id, glyphs, fragments, lines, origin, text, bounds, overflow, missingFonts: text.missingFonts };
}

function pathBaselineOffset(baseline: VectorPathTextBaseline, ascent: number, descent: number): number {
	if (baseline === 'ascender') return ascent;
	if (baseline === 'descender') return -descent;
	if (baseline === 'center') return (ascent - descent) / 2;
	return 0;
}

/** The anchors of a subpath as a Bézier path (no live corners: text follows the stored path). */
function subpathPath(sp: VectorSubpath): BezierPath {
	const a = sp.anchors;
	const out: BezierPath = [];
	if (!a.length) return out;
	out.push({ type: 'M', x: a[0].x, y: a[0].y });
	const seg = (p: (typeof a)[number], q: (typeof a)[number]) => {
		if (p.out || q.in) {
			const c1 = p.out ?? p;
			const c2 = q.in ?? q;
			out.push({ type: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: q.x, y: q.y });
		} else out.push({ type: 'L', x: q.x, y: q.y });
	};
	for (let i = 1; i < a.length; i++) seg(a[i - 1], a[i]);
	if (sp.closed && a.length > 1) {
		seg(a[a.length - 1], a[0]);
		out.push({ type: 'Z' });
	}
	return out;
}

/** The four corners of a glyph's box (origin, advance, ascent to descent), turned by its angle. */
export function glyphBox(g: VectorTextGlyph): Vec2[] {
	const r = (g.angle * Math.PI) / 180;
	const t = { x: Math.cos(r), y: Math.sin(r) };
	const n = { x: -t.y, y: t.x };
	const at = (u: number, v: number) => ({ x: g.x + t.x * u + n.x * v, y: g.y + t.y * u + n.y * v });
	return [at(0, -g.ascent), at(g.advance, -g.ascent), at(g.advance, g.descent), at(0, g.descent)];
}

// ---------------------------------------------------------------------------
// Outlines
// ---------------------------------------------------------------------------

/** The text as paths in the node's own space, one per fill (bottom to top in text order). */
export interface VectorTextPaths {
	/** `fill`: a run's own fill, or undefined for the node's paint. */
	parts: Array<{ fill?: VectorPaint; path: BezierPath }>;
	/** Whether these are glyph outlines (false: glyph boxes, for geometry without an outline shaper). */
	outlines: boolean;
}

const pathsCache = new WeakMap<object, { key: string; paths: VectorTextPaths }>();

/**
 * What a text node draws as geometry: its glyph outlines (plus underline and strike-through bars)
 * with an outline shaper, else a box per glyph (ascent to descent), which bounds, hit-testing and
 * snapping use. Memoised per node object and shaper.
 */
export function vectorTextPaths(node: VectorTextNode): VectorTextPaths {
	const shaper = getVectorTextShaper();
	const key = `${shaper.id}:${generation}`;
	const hit = pathsCache.get(node);
	if (hit && hit.key === key) return hit.paths;
	const layout = layoutVectorText(node);
	const outlines = typeof shaper.outline === 'function';
	const byFill = new Map<string, { fill?: VectorPaint; path: BezierPath }>();
	const partFor = (fill: VectorPaint | undefined) => {
		const k = paintKey(fill);
		let p = byFill.get(k);
		if (!p) {
			p = { ...(fill !== undefined ? { fill } : {}), path: [] };
			byFill.set(k, p);
		}
		return p.path;
	};
	const blockText = node.frame.kind === 'path' ? node.text.replace(/\n/g, ' ') : node.text;
	layout.fragments.forEach((f) => {
		const out = partFor(f.fill);
		const glyphs = layout.glyphs.slice(f.from, f.to);
		if (!glyphs.length) return;
		if (!outlines) {
			if (node.frame.kind === 'path') {
				for (const g of glyphs) if (!isTextSpace(g.char)) out.push(...polygon(glyphBox(g)));
			} else {
				const first = glyphs[0];
				const last = glyphs[glyphs.length - 1];
				out.push(...polygon([{ x: first.x, y: first.y - first.ascent }, { x: last.x + last.advance, y: first.y - first.ascent }, { x: last.x + last.advance, y: first.y + first.descent }, { x: first.x, y: first.y + first.descent }]));
			}
			return;
		}
		if (node.frame.kind !== 'path') {
			// Point and area text: the shared engine's fragment outline, moved to the frame.
			if (!f.laid) return;
			let path = textFragmentOutline(shaper, blockText, f.laid.fragment);
			for (const r of textDecorations(f.laid.fragment, f.laid.line)) path = [...path, ...textRectPath(r)];
			out.push(...(layout.origin.x || layout.origin.y ? transformBezierPath(path, [1, 0, 0, 1, layout.origin.x, layout.origin.y]) : path));
			return;
		}
		for (const g of glyphs) {
			if (isTextSpace(g.char)) continue;
			const glyph = shaper.outline!(g.char, f.font, 0, 0);
			const r = (g.angle * Math.PI) / 180;
			const c = Math.cos(r);
			const s = Math.sin(r);
			out.push(...transformBezierPath(glyph, [c, s, -s, c, g.x, g.y]));
		}
		// Decorations along a path: a bar under each glyph.
		if (f.style.underline || f.style.strikethrough) {
			const t = Math.max(1, f.style.fontSize / 15);
			for (const g of glyphs) {
				const bars: Array<[number, number]> = [];
				if (f.style.underline) bars.push([Math.max(t, g.descent * 0.35), t]);
				if (f.style.strikethrough) bars.push([-g.ascent * 0.3 - t / 2, t]);
				for (const [v, h] of bars) out.push(...polygon(glyphBox({ ...g, ascent: -v, descent: v + h })));
			}
		}
	});
	const paths: VectorTextPaths = { parts: [...byFill.values()].filter((p) => p.path.length), outlines };
	pathsCache.set(node, { key, paths });
	return paths;
}

function polygon(pts: Vec2[]): BezierPath {
	return [{ type: 'M', x: pts[0].x, y: pts[0].y }, ...pts.slice(1).map((p) => ({ type: 'L' as const, x: p.x, y: p.y })), { type: 'Z' }];
}

/**
 * The style a text node paints with as a path node (for the drawing machinery): its paint stacks,
 * stroke settings and fill rule, with `fill` replacing the top fill's paint when given.
 */
export function vectorTextPaintSource(node: VectorTextNode, fill?: VectorPaint, subpaths: VectorSubpath[] = []): VectorPathNode {
	const { type: _t, text: _x, font: _f, runs: _r, paragraph: _p, frame: _fr, ...rest } = node;
	const out: VectorPathNode = { ...rest, type: 'path', subpaths, fillRule: 'nonzero' };
	if (fill === undefined) return out;
	if (Array.isArray(out.fills) && out.fills.length) {
		const fills = out.fills.map((l) => ({ ...l }));
		fills[fills.length - 1].paint = fill;
		return { ...out, fills, fill };
	}
	return { ...out, fill };
}

// ---------------------------------------------------------------------------
// Carets and hit testing (editing)
// ---------------------------------------------------------------------------

/** A caret as a segment from the top of its line to the bottom, node space. */
export interface VectorTextCaret {
	top: Vec2;
	bottom: Vec2;
	/** The line it is on. */
	line: number;
}

/** The caret before code unit `index` (after the last character at the end). */
export function vectorTextCaret(node: VectorTextNode, index: number): VectorTextCaret {
	const layout = layoutVectorText(node);
	const glyphs = layout.glyphs;
	const at = (g: VectorTextGlyph, u: number): VectorTextCaret => {
		const r = (g.angle * Math.PI) / 180;
		const t = { x: Math.cos(r), y: Math.sin(r) };
		const n = { x: -t.y, y: t.x };
		const o = { x: g.x + t.x * u, y: g.y + t.y * u };
		return { top: { x: o.x - n.x * g.ascent, y: o.y - n.y * g.ascent }, bottom: { x: o.x + n.x * g.descent, y: o.y + n.y * g.descent }, line: layout.fragments[g.fragment]?.line ?? 0 };
	};
	if (node.frame.kind !== 'path') {
		// Point and area text: the shared engine's caret (it knows empty lines and line ends).
		const c = caretAt(layout.text, index);
		const o = layout.origin;
		return { top: { x: o.x + c.x, y: o.y + c.top }, bottom: { x: o.x + c.x, y: o.y + c.bottom }, line: c.line };
	}
	const g = glyphs.find((x) => x.index >= index);
	if (g && g.index === index) return at(g, 0);
	const prev = [...glyphs].reverse().find((x) => x.index < index);
	if (prev) return at(prev, prev.advance);
	if (g) return at(g, 0);
	// No glyphs: the start of the path.
	const frame = node.frame;
	const m = measureVectorPath(subpathPath(frame.path), !!frame.flip);
	const { point, tangent } = vectorPathAt(m, frame.start ?? 0);
	const size = node.font.fontSize;
	const n = { x: -tangent.y, y: tangent.x };
	return { top: { x: point.x - n.x * size * 0.8, y: point.y - n.y * size * 0.8 }, bottom: { x: point.x + n.x * size * 0.2, y: point.y + n.y * size * 0.2 }, line: 0 };
}

/** The text index nearest a node-space point (for clicks). */
export function vectorTextIndexAt(node: VectorTextNode, p: Vec2): number {
	const layout = layoutVectorText(node);
	if (node.frame.kind !== 'path') return textIndexAt(layout.text, { x: p.x - layout.origin.x, y: p.y - layout.origin.y });
	let best = node.text.length;
	let bestD = Infinity;
	for (const g of layout.glyphs) {
		const r = (g.angle * Math.PI) / 180;
		const t = { x: Math.cos(r), y: Math.sin(r) };
		const dx = p.x - g.x;
		const dy = p.y - g.y;
		const u = dx * t.x + dy * t.y;
		const v = -dx * t.y + dy * t.x;
		const du = u < 0 ? -u : u > g.advance ? u - g.advance : 0;
		const dv = v < -g.ascent ? -g.ascent - v : v > g.descent ? v - g.descent : 0;
		const d = Math.hypot(du, dv);
		if (d < bestD) {
			bestD = d;
			best = u < g.advance / 2 ? g.index : g.index + g.char.length;
		}
	}
	return best;
}

/** Quads (node space) covering the glyphs of [start, end), one per line for point and area text. */
export function vectorTextSelectionQuads(node: VectorTextNode, start: number, end: number): Vec2[][] {
	if (end <= start) return [];
	const layout = layoutVectorText(node);
	const picked = layout.glyphs.filter((g) => g.index >= start && g.index < end);
	if (node.frame.kind === 'path') return picked.map(glyphBox);
	const byLine = new Map<number, VectorTextGlyph[]>();
	for (const g of picked) {
		const line = layout.fragments[g.fragment].line;
		byLine.set(line, [...(byLine.get(line) ?? []), g]);
	}
	const out: Vec2[][] = [];
	for (const gs of byLine.values()) {
		const a = gs[0];
		const b = gs[gs.length - 1];
		out.push(glyphBox({ ...a, advance: b.x + b.advance - a.x }));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function num(v: unknown, path: string, min: number, max: number): number {
	if (!isNum(v) || v < min || v > max) fail(`${path} must be a number from ${min} to ${max}, got ${JSON.stringify(v)}.`);
	return v as number;
}

/**
 * A character style patch validated (`null` clears an optional field). With `full`, the result
 * must be a complete style (the node's own).
 */
export function patchVectorCharacterStyle<T extends Partial<VectorCharacterStyle>>(base: T, patch: Record<string, unknown>, path = 'style'): T {
	const out = { ...base } as Record<string, unknown>;
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		switch (k) {
			case 'fontFamily':
				if (typeof v !== 'string' || !v.trim()) fail(`${path}.fontFamily must be a font family name.`);
				out.fontFamily = (v as string).trim();
				break;
			case 'fontWeight': {
				const w = v === 'normal' ? 400 : v === 'bold' ? 700 : v;
				out.fontWeight = Math.round(num(w, `${path}.fontWeight`, 1, 1000));
				break;
			}
			case 'fontSize':
				out.fontSize = num(v, `${path}.fontSize`, 0.5, 5000);
				break;
			case 'italic':
			case 'underline':
			case 'strikethrough':
				if (typeof v !== 'boolean' && v !== null) fail(`${path}.${k} must be true or false.`);
				if (v) out[k] = true;
				else delete out[k];
				break;
			case 'tracking':
			case 'leading':
			case 'baselineShift': {
				if (v === null) {
					delete out[k];
					break;
				}
				const [min, max] = k === 'tracking' ? [-1000, 10000] : k === 'leading' ? [0, 10000] : [-5000, 5000];
				const value = num(v, `${path}.${k}`, min, max);
				if (k !== 'leading' && value === 0) delete out[k];
				else out[k] = value;
				break;
			}
			default:
				fail(`${path}.${k} is not a character style field; use ${VECTOR_CHARACTER_STYLE_KEYS.join(', ')} (and fill for a range's colour).`);
		}
	}
	return out as T;
}

/** A paragraph style patch validated (`null` clears a field). */
export function patchVectorParagraphStyle(base: VectorParagraphStyle, patch: Record<string, unknown>, path = 'paragraph'): VectorParagraphStyle {
	const out = { ...base } as Record<string, unknown>;
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		if (k === 'align') {
			if (v === null || v === 'left') delete out.align;
			else if (!VECTOR_TEXT_ALIGNS.includes(v as never)) fail(`${path}.align must be one of ${VECTOR_TEXT_ALIGNS.join(', ')}.`);
			else out.align = v;
		} else if ((VECTOR_PARAGRAPH_STYLE_KEYS as readonly string[]).includes(k)) {
			if (v === null) {
				delete out[k];
				continue;
			}
			const value = k === 'autoLeading' ? num(v, `${path}.${k}`, 0.1, 10) : num(v, `${path}.${k}`, -10000, 10000);
			if ((k === 'autoLeading' && value === DEFAULT_AUTO_LEADING) || (k !== 'autoLeading' && value === 0)) delete out[k];
			else out[k] = value;
		} else fail(`${path}.${k} is not a paragraph style field; use ${VECTOR_PARAGRAPH_STYLE_KEYS.join(', ')}.`);
	}
	return out as VectorParagraphStyle;
}

/** A frame from loose input, validated. */
export function sanitizeVectorTextFrame(value: unknown, path = 'frame'): VectorTextFrame {
	const f = value as Record<string, unknown> | null;
	if (!f || typeof f !== 'object') return fail(`${path} must be an object with kind point, area or path.`);
	if (f.kind === 'point') return { kind: 'point', x: num(f.x, `${path}.x`, -1e7, 1e7), y: num(f.y, `${path}.y`, -1e7, 1e7) };
	if (f.kind === 'area')
		return { kind: 'area', x: num(f.x, `${path}.x`, -1e7, 1e7), y: num(f.y, `${path}.y`, -1e7, 1e7), width: num(f.width, `${path}.width`, 0, 1e7), height: num(f.height, `${path}.height`, 0, 1e7) };
	if (f.kind === 'path') {
		const sp = f.path as VectorSubpath | undefined;
		if (!sp || !Array.isArray(sp.anchors) || sp.anchors.length < 2 || !sp.anchors.every((a) => isNum(a?.x) && isNum(a?.y))) fail(`${path}.path must be a subpath with at least two anchors.`);
		const out: VectorTextFrame = { kind: 'path', path: { closed: !!sp!.closed, anchors: sp!.anchors.map((a) => ({ ...a })) } };
		if (f.start !== undefined && f.start !== 0) out.start = num(f.start, `${path}.start`, 0, 1e7);
		if (f.end !== undefined && f.end !== 0) out.end = num(f.end, `${path}.end`, 0, 1e7);
		if (f.flip) out.flip = true;
		if (f.orientation !== undefined && f.orientation !== 'rotate') {
			if (f.orientation !== 'upright') fail(`${path}.orientation must be rotate or upright.`);
			out.orientation = 'upright';
		}
		if (f.baseline !== undefined && f.baseline !== 'baseline') {
			if (!VECTOR_PATH_TEXT_BASELINES.includes(f.baseline as never)) fail(`${path}.baseline must be one of ${VECTOR_PATH_TEXT_BASELINES.join(', ')}.`);
			out.baseline = f.baseline as VectorPathTextBaseline;
		}
		return out;
	}
	return fail(`${path}.kind must be point, area or path, got ${JSON.stringify(f.kind)}.`);
}

/** Normalised runs: fitted to the text, empty overrides dropped, `null` when there is one plain style. */
export function normalizeVectorTextRuns(text: string, runs: readonly VectorTextRun[] | null | undefined): VectorTextRun[] | null {
	if (!runs?.length) return null;
	const cleaned = fitVectorTextRuns(
		runs.map((r) => ({ length: r.length, style: stripUndefined(r.style) })),
		text.length
	);
	if (cleaned.every((r) => !Object.keys(r.style).length)) return null;
	return cleaned;
}

/** A text node read from untrusted data (JSON, SVG data attributes, agents): fields validated and normalised. */
export function sanitizeVectorTextFields(value: Record<string, unknown>): Pick<VectorTextNode, 'text' | 'font' | 'runs' | 'paragraph' | 'frame'> {
	const text = typeof value.text === 'string' ? value.text.replace(/\r\n?/g, '\n') : '';
	const font = patchVectorCharacterStyle({ ...DEFAULT_VECTOR_FONT }, (value.font as Record<string, unknown>) ?? {}, 'font');
	const runs = Array.isArray(value.runs)
		? normalizeVectorTextRuns(
				text,
				(value.runs as VectorTextRun[])
					.filter((r) => r && isNum(r.length))
					.map((r) => {
						const { fill, ...rest } = (r.style ?? {}) as VectorTextRunStyle;
						return { length: r.length, style: { ...patchVectorCharacterStyle({}, rest as Record<string, unknown>, 'runs.style'), ...(fill !== undefined ? { fill } : {}) } };
					})
			)
		: null;
	const paragraph = value.paragraph ? patchVectorParagraphStyle({}, value.paragraph as Record<string, unknown>) : null;
	const frame = sanitizeVectorTextFrame(value.frame ?? { kind: 'point', x: 0, y: 0 });
	return { text, font, ...(runs ? { runs } : {}), ...(paragraph && Object.keys(paragraph).length ? { paragraph } : {}), frame };
}

/** A range of the text from loose input: [start, end) in UTF-16 code units (default the whole text). */
export function vectorTextRange(text: string, start: unknown, end: unknown): [number, number] {
	const s = start === undefined ? 0 : start;
	const e = end === undefined ? text.length : end;
	if (!Number.isInteger(s) || !Number.isInteger(e) || (s as number) < 0 || (e as number) > text.length || (s as number) > (e as number)) {
		fail(`start and end must be whole numbers with 0 ≤ start ≤ end ≤ ${text.length} (the text's length in UTF-16 code units), got ${String(start)} and ${String(end)}.`);
	}
	return [s as number, e as number];
}

// ---------------------------------------------------------------------------
// Edits (pure)
// ---------------------------------------------------------------------------

/** The node with [start, end) of its text replaced by `insert` (styled like the character before it). */
export function replaceVectorText(node: VectorTextNode, start: number, end: number, insert: string): VectorTextNode {
	const clean = insert.replace(/\r\n?/g, '\n');
	const text = node.text.slice(0, start) + clean + node.text.slice(end);
	let runs: VectorTextRun[] | null = null;
	if (node.runs?.length) {
		const fitted = fitVectorTextRuns(node.runs, node.text.length);
		const style = styleAt(fitted, start > 0 ? start - 1 : start, {} as VectorTextRunStyle);
		runs = normalizeVectorTextRuns(text, spliceRuns(fitted, start, end, clean.length, style));
	}
	const next: VectorTextNode = { ...node, text };
	if (runs) next.runs = runs;
	else delete next.runs;
	return next;
}

/**
 * The node with a character style patch (and `fill`) applied over [start, end). The whole text
 * changes the node's own style (and its `fill`) and drops those fields from its runs.
 */
export function styleVectorText(node: VectorTextNode, start: number, end: number, patch: Record<string, unknown>): VectorTextNode {
	const { fill, ...fields } = patch as { fill?: VectorPaint } & Record<string, unknown>;
	const whole = start <= 0 && end >= node.text.length;
	if (whole) {
		let next: VectorTextNode = { ...node, font: patchVectorCharacterStyle(node.font, fields, 'style') };
		const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
		if (next.runs?.length && (keys.length || fill !== undefined)) {
			const runs = normalizeVectorTextRuns(
				next.text,
				next.runs.map((r) => {
					const style = { ...r.style } as Record<string, unknown>;
					for (const k of keys) delete style[k];
					if (fill !== undefined) delete style.fill;
					return { length: r.length, style: style as VectorTextRunStyle };
				})
			);
			next = { ...next };
			if (runs) next.runs = runs;
			else delete next.runs;
		}
		if (fill !== undefined) next = { ...next, fill };
		return next;
	}
	if (end <= start) return node;
	const fitted = fitVectorTextRuns(node.runs ?? [], node.text.length);
	const restyled = restyleRange(fitted.length ? fitted : [{ length: node.text.length, style: {} }], start, end, (s) => {
		const own = patchVectorCharacterStyle(s as Partial<VectorCharacterStyle>, fields, 'style') as VectorTextRunStyle;
		// A field set back to the node's own value is no override.
		for (const k of VECTOR_CHARACTER_STYLE_KEYS) if (own[k] !== undefined && own[k] === node.font[k]) delete own[k];
		const out: VectorTextRunStyle = { ...own };
		if (fill !== undefined) {
			if (fill === null && (s as VectorTextRunStyle).fill !== undefined) delete out.fill;
			else out.fill = fill;
		} else if ((s as VectorTextRunStyle).fill !== undefined) out.fill = (s as VectorTextRunStyle).fill;
		return out;
	});
	const runs = normalizeVectorTextRuns(node.text, restyled);
	const next: VectorTextNode = { ...node };
	if (runs) next.runs = runs;
	else delete next.runs;
	return next;
}

/**
 * The node with scale and skew of `m` baked in (its rigid part goes to `transform` elsewhere): the
 * frame's points map through `m`, font sizes scale by √|det| (text keeps its proportions), and an
 * area's box takes each axis' own scale.
 */
export function bakeVectorTextGeometry(node: VectorTextNode, m: AffineMatrix): VectorTextNode {
	if (isIdentityMatrix(m)) return node;
	const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
	const scaleStyle = <S extends Partial<VectorCharacterStyle>>(s: S): S => ({
		...s,
		...(s.fontSize !== undefined ? { fontSize: s.fontSize * k } : {}),
		...(s.leading !== undefined ? { leading: s.leading * k } : {}),
		...(s.baselineShift !== undefined ? { baselineShift: s.baselineShift * k } : {})
	});
	const font = scaleStyle(node.font);
	const runs = node.runs?.map((r) => ({ length: r.length, style: scaleStyle(r.style) }));
	const p = node.paragraph;
	const paragraph = p
		? {
				...p,
				...(p.firstLineIndent ? { firstLineIndent: p.firstLineIndent * k } : {}),
				...(p.startIndent ? { startIndent: p.startIndent * k } : {}),
				...(p.endIndent ? { endIndent: p.endIndent * k } : {}),
				...(p.spaceBefore ? { spaceBefore: p.spaceBefore * k } : {}),
				...(p.spaceAfter ? { spaceAfter: p.spaceAfter * k } : {})
			}
		: p;
	let frame: VectorTextFrame;
	const f = node.frame;
	if (f.kind === 'point') {
		const q = applyMatrix(m, f);
		frame = { kind: 'point', x: q.x, y: q.y };
	} else if (f.kind === 'area') {
		const q = applyMatrix(m, f);
		const sx = Math.hypot(m[0], m[1]);
		const sy = Math.hypot(m[2], m[3]);
		frame = { kind: 'area', x: q.x, y: q.y, width: f.width * sx, height: f.height * sy };
	} else {
		const map = (v: Vec2) => applyMatrix(m, v);
		frame = {
			...f,
			path: { closed: f.path.closed, anchors: f.path.anchors.map((a) => ({ ...a, ...map(a), ...(a.in ? { in: map(a.in) } : {}), ...(a.out ? { out: map(a.out) } : {}) })) },
			...(f.start ? { start: f.start * k } : {}),
			...(f.end ? { end: f.end * k } : {})
		};
	}
	return { ...node, font, ...(runs ? { runs } : {}), ...(paragraph ? { paragraph } : {}), frame };
}

/** The text of a node as a short name ("Hello world…"). */
export function vectorTextName(text: string): string {
	const t = text.replace(/\s+/g, ' ').trim();
	return t ? (t.length > 24 ? `${t.slice(0, 24)}…` : t) : 'Text';
}

/** Parses loose path data for a path text frame (the first subpath). */
export function pathTextFrameFromBezier(path: BezierPath): VectorSubpath | null {
	const cmds = toBezierPath(path);
	const anchors: VectorSubpath['anchors'] = [];
	let closed = false;
	for (const c of cmds) {
		if (c.type === 'M') {
			if (anchors.length) break;
			anchors.push({ x: c.x, y: c.y });
		} else if (c.type === 'L') anchors.push({ x: c.x, y: c.y });
		else if (c.type === 'C') {
			anchors[anchors.length - 1].out = { x: c.x1, y: c.y1 };
			anchors.push({ x: c.x, y: c.y, in: { x: c.x2, y: c.y2 } });
		} else if (c.type === 'Q') {
			const p = anchors[anchors.length - 1];
			anchors[anchors.length - 1].out = { x: p.x + ((c.x1 - p.x) * 2) / 3, y: p.y + ((c.y1 - p.y) * 2) / 3 };
			anchors.push({ x: c.x, y: c.y, in: { x: c.x + ((c.x1 - c.x) * 2) / 3, y: c.y + ((c.y1 - c.y) * 2) / 3 } });
		} else if (c.type === 'Z') {
			closed = true;
			break;
		}
	}
	return anchors.length >= 2 ? { anchors, closed } : null;
}

/**
 * The outline the editor shows for a text node (hover, selection), node space: an area's box, a
 * path text's path, or a box round each line of point text.
 */
export function vectorTextBoxOutline(node: VectorTextNode): BezierPath {
	const f = node.frame;
	if (f.kind === 'area') return polygon([{ x: f.x, y: f.y }, { x: f.x + f.width, y: f.y }, { x: f.x + f.width, y: f.y + f.height }, { x: f.x, y: f.y + f.height }]);
	if (f.kind === 'path') return subpathPath(f.path);
	const layout = layoutVectorText(node);
	const out: BezierPath = [];
	layout.text.lines.forEach((l, i) => {
		const line = layout.lines[i];
		if (!line) return;
		const top = line.baseline - l.ascent;
		const bottom = line.baseline + l.descent;
		const w = Math.max(l.width, 1);
		out.push(...polygon([{ x: line.x, y: top }, { x: line.x + w, y: top }, { x: line.x + w, y: bottom }, { x: line.x, y: bottom }]));
	});
	return out;
}

/** One `<tspan>` of text drawn as SVG text: a fragment's characters, each placed on its own. */
export interface VectorTextSpan {
	text: string;
	/** Per-character origins (node space) and turns (degrees; absent when all are 0). */
	x: number[];
	y: number[];
	rotate?: number[];
	style: VectorCharacterStyle;
	/** The family to draw with (the resolved one, a fallback when the family is missing). */
	family: string;
	/** The run's own fill, if it has one. */
	fill?: VectorPaint;
}

/** The text as SVG text spans: one per fragment, every character placed by the layout. */
export function vectorTextSpans(node: VectorTextNode): VectorTextSpan[] {
	const layout = layoutVectorText(node);
	const out: VectorTextSpan[] = [];
	for (const f of layout.fragments) {
		const glyphs = layout.glyphs.slice(f.from, f.to);
		if (!glyphs.length) continue;
		const turned = glyphs.some((g) => g.angle !== 0);
		out.push({
			text: glyphs.map((g) => g.char).join(''),
			x: glyphs.map((g) => g.x),
			y: glyphs.map((g) => g.y),
			...(turned ? { rotate: glyphs.map((g) => g.angle) } : {}),
			style: f.style,
			family: f.font.family,
			...(f.fill !== undefined ? { fill: f.fill } : {})
		});
	}
	return out;
}

const geometryCache = new WeakMap<object, { key: string; node: VectorPathNode }>();

/**
 * The text as one path node in its style: its geometry (glyph outlines, or glyph boxes) and paint
 * stacks. Paint servers and stroke layers of SVG text are computed on it.
 */
export function vectorTextGeometryNode(node: VectorTextNode): VectorPathNode {
	const key = `${getVectorTextShaper().id}:${generation}`;
	const hit = geometryCache.get(node);
	if (hit && hit.key === key) return hit.node;
	const path = vectorTextPaths(node).parts.flatMap((p) => p.path);
	const out = vectorTextPaintSource(node, undefined, bezierToSubpathsLite(path));
	geometryCache.set(node, { key, node: out });
	return out;
}

/** Polygon / Bézier commands to subpaths (anchors with absolute handles), without importing geometry. */
function bezierToSubpathsLite(path: BezierPath): VectorSubpath[] {
	const out: VectorSubpath[] = [];
	let cur: VectorSubpath | null = null;
	for (const c of path) {
		if (c.type === 'M') {
			cur = { anchors: [{ x: c.x, y: c.y }], closed: false };
			out.push(cur);
		} else if (!cur) continue;
		else if (c.type === 'L') cur.anchors.push({ x: c.x, y: c.y });
		else if (c.type === 'C') {
			cur.anchors[cur.anchors.length - 1].out = { x: c.x1, y: c.y1 };
			cur.anchors.push({ x: c.x, y: c.y, in: { x: c.x2, y: c.y2 } });
		} else if (c.type === 'Q') {
			const p = cur.anchors[cur.anchors.length - 1];
			p.out = { x: p.x + ((c.x1 - p.x) * 2) / 3, y: p.y + ((c.y1 - p.y) * 2) / 3 };
			cur.anchors.push({ x: c.x, y: c.y, in: { x: c.x + ((c.x1 - c.x) * 2) / 3, y: c.y + ((c.y1 - c.y) * 2) / 3 } });
		} else if (c.type === 'Z') {
			const a = cur.anchors;
			if (a.length > 1 && Math.abs(a[0].x - a[a.length - 1].x) < 1e-9 && Math.abs(a[0].y - a[a.length - 1].y) < 1e-9) {
				const last = a.pop()!;
				if (last.in) a[0].in = last.in;
			}
			cur.closed = true;
		}
	}
	return out.filter((sp) => sp.anchors.length);
}

/** One `<tspan>` as render data: per-character positions (space-separated lists) and its font. */
export interface VectorRenderTextSpan {
	text: string;
	x: string;
	y: string;
	/** Per-character turns in degrees (text on a path). */
	rotate?: string;
	/** A CSS `font-family` value. */
	fontFamily: string;
	fontSize: number;
	fontWeight: number;
	fontStyle?: 'italic';
	/** `underline`, `line-through` or both. */
	textDecoration?: string;
	/** The run's own fill (a colour or `url(#id)`), for layers with `runFills`. */
	fill?: string;
}

const fmt = (n: number) => Math.round(n * 1000) / 1000;

/** A span as render data (positions as SVG number lists), with the run's fill as drawn. */
export function vectorTextSpanSvg(sp: VectorTextSpan, fill?: string): VectorRenderTextSpan {
	const list = (v: number[]) => v.map(fmt).join(' ');
	const deco = [sp.style.underline ? 'underline' : '', sp.style.strikethrough ? 'line-through' : ''].filter(Boolean).join(' ');
	return {
		text: sp.text,
		x: list(sp.x),
		y: sp.y.every((v) => v === sp.y[0]) ? String(fmt(sp.y[0])) : list(sp.y),
		...(sp.rotate ? { rotate: list(sp.rotate) } : {}),
		fontFamily: cssFontFamily(sp.family),
		fontSize: sp.style.fontSize,
		fontWeight: sp.style.fontWeight,
		...(sp.style.italic ? { fontStyle: 'italic' as const } : {}),
		...(deco ? { textDecoration: deco } : {}),
		...(fill !== undefined ? { fill } : {})
	};
}
