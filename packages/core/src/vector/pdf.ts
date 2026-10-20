/**
 * Vector PDF export: the drawing as real PDF paths, not a picture.
 *
 * After cadcraft's `crates/io/src/pdf.rs` (a minimal PDF writer of our own: objects, a
 * cross-reference table and Flate-compressed content streams of `m` / `l` / `c` / `h` paths
 * painted with `f` / `f*` / `S`, RGB colours and line settings) and pdfcraft's
 * `crates/content/src/lib.rs` (content stream operators: `q` / `Q` state, `cm`, `W n` clipping,
 * `gs` graphics states for opacity and blend modes, `sh` shadings) (MIT OR Apache-2.0, © ArtCraft
 * Team and contributors; see THIRD_PARTY_NOTICES.md).
 *
 * It draws what the canvas draws: the scene render data (effects expanded, text as glyph outlines,
 * paint stacks, aligned strokes and arrowheads, clip masks, frames). Linear and radial gradients
 * are native PDF shadings; conic, diamond, mesh and freeform paints are their tiles. Filters,
 * opacity masks, stop opacity and text without glyph outlines are left out and named in `notes`.
 */

import { resolveVectorLenses } from './lens.js';
import { deflate } from '../raster/zlib.js';
import { parseSvgPath } from '../canvas/shapeGeometry.js';
import type { SvgGradientDef } from '../canvas/gradient.js';
import { parseVectorColor, type VectorPaintDef, type VectorSvgPatternDef } from './gradient.js';
import { getVectorSceneRenderData, type VectorRenderGroup, type VectorRenderNode, type VectorRenderPaintLayer, type VectorRenderPath } from './render.js';
import type { VectorRenderStrokeParts } from './svg.js';
import { vectorFrameDocument, vectorArtboards } from './frames.js';
import { findVectorNode } from './geometry.js';
import type { VectorDocument } from './types.js';

/** Options of `vectorDocumentToPdf`. */
export interface VectorPdfOptions {
	/** `document`: one page of the artboard (default); `artboards`: a page per top-level frame. */
	pages?: 'document' | 'artboards';
	/** PDF points per document unit (default 1). */
	scale?: number;
	/** Document title. */
	title?: string;
	/** Flate-compress the content streams (default true). */
	compress?: boolean;
}

/** What `vectorDocumentToPdf` returns. */
export interface VectorPdfExport {
	bytes: Uint8Array;
	pages: number;
	/** What was approximated or left out. */
	notes: string[];
}

const n = (v: number) => {
	const r = Math.round(v * 1000) / 1000;
	return Object.is(r, -0) ? '0' : String(r);
};

const BLEND: Record<string, string> = {
	multiply: 'Multiply',
	screen: 'Screen',
	overlay: 'Overlay',
	darken: 'Darken',
	lighten: 'Lighten',
	'color-dodge': 'ColorDodge',
	'color-burn': 'ColorBurn',
	'hard-light': 'HardLight',
	'soft-light': 'SoftLight',
	difference: 'Difference',
	exclusion: 'Exclusion',
	hue: 'Hue',
	saturation: 'Saturation',
	color: 'Color',
	luminosity: 'Luminosity'
};

/** An SVG `matrix(a b c d e f)` / `translate` / `scale` / `rotate` attribute as numbers (identity when absent). */
function matrixOf(t: string | undefined): number[] {
	if (!t) return [1, 0, 0, 1, 0, 0];
	let m = [1, 0, 0, 1, 0, 0];
	const mul = (a: number[], b: number[]) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
	for (const [, name, args] of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
		const v = args.split(/[\s,]+/).filter(Boolean).map(Number);
		let k = [1, 0, 0, 1, 0, 0];
		if (name === 'matrix' && v.length === 6) k = v;
		else if (name === 'translate') k = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
		else if (name === 'scale') k = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
		else if (name === 'rotate') {
			const r = ((v[0] ?? 0) * Math.PI) / 180;
			const [cx, cy] = [v[1] ?? 0, v[2] ?? 0];
			k = mul(mul([1, 0, 0, 1, cx, cy], [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]), [1, 0, 0, 1, -cx, -cy]);
		}
		m = mul(m, k);
	}
	return m;
}

/** SVG path data as PDF path operators, and its box (for bounding-box gradients). */
function pathOps(d: string): { ops: string; box: { x: number; y: number; w: number; h: number } | null } {
	const out: string[] = [];
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const see = (x: number, y: number) => {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	};
	let cx = 0;
	let cy = 0;
	for (const c of parseSvgPath(d)) {
		if (c.type === 'M') {
			out.push(`${n(c.x)} ${n(c.y)} m`);
			see(c.x, c.y);
			[cx, cy] = [c.x, c.y];
		} else if (c.type === 'L') {
			out.push(`${n(c.x)} ${n(c.y)} l`);
			see(c.x, c.y);
			[cx, cy] = [c.x, c.y];
		} else if (c.type === 'C') {
			out.push(`${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)} c`);
			see(c.x1, c.y1);
			see(c.x2, c.y2);
			see(c.x, c.y);
			[cx, cy] = [c.x, c.y];
		} else if (c.type === 'Q') {
			// A quadratic as the equal cubic.
			const c1 = [cx + (2 / 3) * (c.x1 - cx), cy + (2 / 3) * (c.y1 - cy)];
			const c2 = [c.x + (2 / 3) * (c.x1 - c.x), c.y + (2 / 3) * (c.y1 - c.y)];
			out.push(`${n(c1[0])} ${n(c1[1])} ${n(c2[0])} ${n(c2[1])} ${n(c.x)} ${n(c.y)} c`);
			see(c.x, c.y);
			[cx, cy] = [c.x, c.y];
		} else if (c.type === 'Z') out.push('h');
		else {
			// Arcs never come from our own path data; a straight line keeps the outline closed.
			out.push(`${n(c.x)} ${n(c.y)} l`);
			[cx, cy] = [c.x, c.y];
		}
	}
	return { ops: out.join('\n'), box: minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

/** One page's resources and content, built up while drawing. */
class Page {
	content: string[] = [];
	states = new Map<string, string>();
	shadings = new Map<string, string>();
	constructor(
		readonly writer: PdfWriter,
		readonly defs: Map<string, VectorPaintDef>,
		readonly notes: Set<string>
	) {}

	/** A graphics state with this fill / stroke alpha and blend mode, by name. */
	gs(alpha: number, strokeAlpha: number, blend?: string): string {
		const bm = blend ? BLEND[blend] : undefined;
		if (blend && blend !== 'normal' && !bm) this.notes.add(`Blend mode ${blend} has no PDF equivalent (normal used).`);
		const key = `${n(alpha)}|${n(strokeAlpha)}|${bm ?? ''}`;
		let name = this.states.get(key);
		if (!name) {
			name = `GS${this.states.size + 1}`;
			this.states.set(key, name);
			this.writer.gsDicts.set(`${this.writer.pageIndex}:${name}`, `<< /Type /ExtGState /ca ${n(alpha)} /CA ${n(strokeAlpha)}${bm ? ` /BM /${bm}` : ''} >>`);
		}
		return name;
	}

	/** Sets the fill colour (or prepares a paint server) for `paint`: returns its alpha, or a def to fill with by clipping. */
	paint(paint: string, stroking: boolean): { alpha: number; def?: VectorPaintDef } | null {
		if (!paint || paint === 'none') return null;
		const url = /^url\(#(.+)\)$/.exec(paint);
		if (url) {
			const def = this.defs.get(url[1]);
			return def ? { alpha: 1, def } : null;
		}
		const c = parseVectorColor(paint);
		if (!c) return null;
		this.content.push(`${n(c[0])} ${n(c[1])} ${n(c[2])} ${stroking ? 'RG' : 'rg'}`);
		return { alpha: c[3] };
	}

	/** A linear or radial gradient as a shading, by name (stop opacity left out). */
	shading(def: SvgGradientDef): string {
		let name = this.shadings.get(def.id);
		if (name) return name;
		name = `Sh${this.shadings.size + 1}`;
		this.shadings.set(def.id, name);
		const stops = def.stops.map((s) => ({ t: Math.min(1, Math.max(0, parseFloat(s.offset) / (s.offset.endsWith('%') ? 100 : 1))), c: parseVectorColor(s.stopColor) ?? [0, 0, 0, 1], a: s.stopOpacity ?? 1 }));
		if (stops.some((s) => s.a < 1 || s.c[3] < 1)) this.notes.add('Gradient stop opacity has no PDF shading equivalent (stops drawn opaque).');
		if (def.attrs.spreadMethod && def.attrs.spreadMethod !== 'pad') this.notes.add('Repeating and reflected gradient spreads are drawn padded.');
		const rgb = (c: number[]) => `[${n(c[0])} ${n(c[1])} ${n(c[2])}]`;
		const list = stops.length === 1 ? [stops[0], stops[0]] : stops;
		const fns = list.slice(1).map((s, k) => `<< /FunctionType 2 /Domain [0 1] /C0 ${rgb(list[k].c)} /C1 ${rgb(s.c)} /N 1 >>`);
		const fn = fns.length === 1 ? fns[0] : `<< /FunctionType 3 /Domain [${n(list[0].t)} ${n(list[list.length - 1].t)}] /Functions [${fns.join(' ')}] /Bounds [${list.slice(1, -1).map((s) => n(s.t)).join(' ')}] /Encode [${fns.map(() => '0 1').join(' ')}] >>`;
		const a = def.attrs;
		const num = (k: string, d = 0) => (a[k] === undefined ? d : parseFloat(String(a[k])));
		const coords =
			def.type === 'linear'
				? `/ShadingType 2 /Coords [${n(num('x1'))} ${n(num('y1'))} ${n(num('x2', 1))} ${n(num('y2'))}]`
				: `/ShadingType 3 /Coords [${n(num('fx', num('cx', 0.5)))} ${n(num('fy', num('cy', 0.5)))} ${n(num('fr'))} ${n(num('cx', 0.5))} ${n(num('cy', 0.5))} ${n(num('r', 0.5))}]`;
		this.writer.shadingDicts.set(`${this.writer.pageIndex}:${name}`, `<< ${coords} /ColorSpace /DeviceRGB /Function ${fn} /Extend [true true] >>`);
		return name;
	}

	/** Fills the current clip with a paint server (a gradient shading, or a pattern's tiles). */
	fillDef(def: VectorPaintDef, box: { x: number; y: number; w: number; h: number } | null) {
		if (def.type === 'pattern') return this.tiles(def);
		const g = def as SvgGradientDef;
		const name = this.shading(g);
		this.content.push('q');
		if (g.attrs.gradientUnits !== 'userSpaceOnUse' && box) this.content.push(`${n(box.w)} 0 0 ${n(box.h)} ${n(box.x)} ${n(box.y)} cm`);
		const t = matrixOf(g.attrs.gradientTransform as string | undefined);
		if (t.join() !== '1,0,0,1,0,0') this.content.push(`${t.map(n).join(' ')} cm`);
		this.content.push(`/${name} sh`, 'Q');
	}

	/** A pattern's tiles, each filled (a gradient tile through its own clip). */
	tiles(def: VectorSvgPatternDef) {
		const inner = new Map(this.defs);
		for (const g of def.gradients) inner.set(g.id, g);
		for (const tile of def.tiles) {
			const { ops, box } = pathOps(tile.d);
			const url = /^url\(#(.+)\)$/.exec(tile.fill);
			if (url) {
				const g = inner.get(url[1]);
				if (!g) continue;
				this.content.push('q', ops, 'W n');
				this.fillDef(g, box);
				this.content.push('Q');
			} else {
				const c = parseVectorColor(tile.fill);
				if (!c) continue;
				this.content.push('q');
				if (c[3] < 1) this.content.push(`/${this.gs(c[3], 1)} gs`);
				this.content.push(`${n(c[0])} ${n(c[1])} ${n(c[2])} rg`, ops, 'f', 'Q');
			}
		}
	}

	/** Fills path data `d` with `paint` at `alpha` (`evenodd` for the even-odd rule). */
	fill(d: string, paint: string, alpha: number, evenodd: boolean, blend?: string) {
		const { ops, box } = pathOps(d);
		this.content.push('q');
		const p = this.paint(paint, false);
		if (!p) return void this.content.pop();
		const a = alpha * p.alpha;
		if (a < 1 || (blend && blend !== 'normal')) this.content.push(`/${this.gs(a, a, blend)} gs`);
		if (p.def) {
			this.content.push(ops, evenodd ? 'W* n' : 'W n');
			this.fillDef(p.def, box);
		} else this.content.push(ops, evenodd ? 'f*' : 'f');
		this.content.push('Q');
	}

	/** Strokes path data `d` (a gradient stroke is drawn as solid in its first colour). */
	stroke(d: string, paint: string, width: number, alpha: number, cap?: string, join?: string, dash?: string, blend?: string) {
		const { ops } = pathOps(d);
		this.content.push('q');
		let p = this.paint(paint, true);
		if (p?.def) {
			// PDF strokes take one colour; gradients on strokes go through their outline elsewhere.
			const first = p.def.type === 'pattern' ? p.def.tiles[0]?.fill : (p.def as SvgGradientDef).stops[0]?.stopColor;
			this.notes.add('Gradient strokes are drawn in their first colour.');
			p = first ? this.paint(first, true) : null;
		}
		if (!p) return void this.content.pop();
		const a = alpha * p.alpha;
		if (a < 1 || (blend && blend !== 'normal')) this.content.push(`/${this.gs(a, a, blend)} gs`);
		this.content.push(`${n(width)} w`, `${cap === 'round' ? 1 : cap === 'square' ? 2 : 0} J`, `${join === 'round' ? 1 : join === 'bevel' ? 2 : 0} j`);
		const dashes = (dash ?? '')
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(Number);
		if (dashes.length) this.content.push(`[${dashes.map(n).join(' ')}] 0 d`);
		this.content.push(ops, 'S', 'Q');
	}

	/** A stroke drawn in parts (aligned inside / outside, arrowheads, width profiles). */
	strokeParts(parts: VectorRenderStrokeParts, fillD: string, paint: string, layer: { cap?: string; join?: string; dash?: string; alpha: number; blend?: string }, evenodd: boolean) {
		if (parts.clip) {
			this.content.push('q');
			const shape = pathOps(fillD).ops;
			if (parts.clip.kind === 'clip') this.content.push(shape, evenodd ? 'W* n' : 'W n');
			else {
				// Outside: everything in the box but the shape.
				const b = parts.clip.bounds;
				this.content.push(`${n(b.x)} ${n(b.y)} ${n(b.width)} ${n(b.height)} re`, shape, 'W* n');
			}
		}
		if (parts.outline) this.fill(parts.outline, paint, layer.alpha, false, layer.blend);
		else this.stroke(parts.d, paint, parts.width, layer.alpha, layer.cap, layer.join, layer.dash, layer.blend);
		if (parts.clip) this.content.push('Q');
		for (const h of parts.heads) this.fill(h, paint, layer.alpha, false, layer.blend);
	}

	/** One render node (cumulative `alpha` from its groups). */
	node(node: VectorRenderNode, alpha: number) {
		if (node.kind === 'text') {
			this.notes.add('Text without glyph outlines is left out (load fonts so text draws as outlines).');
			return;
		}
		if ((node as VectorRenderPath).filter || (node as VectorRenderGroup).filter) this.notes.add('Filters (shadows, glows, blurs) are left out.');
		this.content.push('q');
		if (node.transform) this.content.push(`${matrixOf(node.transform).map(n).join(' ')} cm`);
		const a = alpha * node.opacity;
		if (node.kind === 'group') {
			if (node.opacity < 1 && node.children.length > 1) this.notes.add('Group opacity is applied to each object in the group.');
			if (node.blendMode && node.blendMode !== 'normal') this.notes.add('Group blend modes are applied to each object in the group.');
			if (node.mask) {
				if (node.mask.type === 'clip' && node.mask.clip?.length) {
					const evenodd = node.mask.clip.some((c) => c.clipRule === 'evenodd');
					this.content.push(node.mask.clip.map((c) => pathOps(c.d).ops).join('\n'), evenodd ? 'W* n' : 'W n');
				} else this.notes.add('Opacity masks are left out (the contents are drawn whole).');
			}
			for (const c of node.children) this.node(blendInto(c, node.blendMode), a);
		} else this.path(node, a);
		this.content.push('Q');
	}

	path(p: VectorRenderPath, alpha: number) {
		const evenodd = p.fillRule === 'evenodd';
		const layers: VectorRenderPaintLayer[] = p.layers ?? [
			{ kind: 'fill', index: 0, fill: p.fill, stroke: 'none', strokeWidth: 0, opacity: 1 },
			{ kind: 'stroke', index: 0, fill: 'none', stroke: p.stroke, strokeWidth: p.strokeWidth, strokeLinecap: p.strokeLinecap, strokeLinejoin: p.strokeLinejoin, strokeDasharray: p.strokeDasharray, opacity: 1, strokeParts: p.strokeParts }
		];
		for (const l of layers) {
			const a = alpha * l.opacity;
			const blend = l.blendMode ?? p.blendMode;
			if (l.kind === 'fill') {
				if (l.fill !== 'none') this.fill(p.d, l.fill, a, evenodd, blend);
			} else if (l.stroke !== 'none' && l.strokeWidth > 0) {
				if (l.strokeParts) this.strokeParts(l.strokeParts, p.d, l.stroke, { cap: l.strokeLinecap, join: l.strokeLinejoin, dash: l.strokeDasharray, alpha: a, blend }, evenodd);
				else this.stroke(p.d, l.stroke, l.strokeWidth, a, l.strokeLinecap, l.strokeLinejoin, l.strokeDasharray, blend);
			}
		}
	}
}

/** A child carrying its group's blend mode (PDF has no isolated groups here). */
function blendInto(node: VectorRenderNode, blend: string | undefined): VectorRenderNode {
	if (!blend || blend === 'normal' || node.blendMode) return node;
	return { ...node, blendMode: blend } as VectorRenderNode;
}

/** The PDF file: numbered objects, then the cross-reference table. */
class PdfWriter {
	objects: (Uint8Array | string)[] = [];
	gsDicts = new Map<string, string>();
	shadingDicts = new Map<string, string>();
	pageIndex = 0;
	add(body: Uint8Array | string): number {
		this.objects.push(body);
		return this.objects.length;
	}
	set(id: number, body: Uint8Array | string) {
		this.objects[id - 1] = body;
	}
	stream(dict: string, data: Uint8Array, compress: boolean): Uint8Array {
		const body = compress ? deflate(data) : data;
		const head = new TextEncoder().encode(`<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${body.length} >>\nstream\n`);
		const tail = new TextEncoder().encode('\nendstream');
		const out = new Uint8Array(head.length + body.length + tail.length);
		out.set(head);
		out.set(body, head.length);
		out.set(tail, head.length + body.length);
		return out;
	}
	bytes(root: number, info: number): Uint8Array {
		const enc = new TextEncoder();
		const parts: Uint8Array[] = [enc.encode('%PDF-1.7\n%âãÏÓ\n')];
		let offset = parts[0].length;
		const offsets: number[] = [];
		this.objects.forEach((o, k) => {
			offsets.push(offset);
			const body = typeof o === 'string' ? enc.encode(o) : o;
			const chunk = [enc.encode(`${k + 1} 0 obj\n`), body, enc.encode('\nendobj\n')];
			for (const c of chunk) {
				parts.push(c);
				offset += c.length;
			}
		});
		const xref = [`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
		parts.push(enc.encode(`${xref}trailer\n<< /Size ${this.objects.length + 1} /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
		const total = parts.reduce((s, p) => s + p.length, 0);
		const out = new Uint8Array(total);
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	}
}

/** A PDF string literal (escaped). */
const pdfString = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?')})`;

/**
 * The document as a vector PDF: one page of the artboard, or (`pages: 'artboards'`) one page per
 * top-level frame, each the frame's size. One document unit is `scale` points.
 */
export function vectorDocumentToPdf(doc: VectorDocument, options: VectorPdfOptions = {}): VectorPdfExport {
	const notes = new Set<string>();
	doc = resolveVectorLenses(doc);
	const scale = options.scale ?? 1;
	const compress = options.compress !== false;
	const frames = options.pages === 'artboards' ? vectorArtboards(doc) : [];
	if (options.pages === 'artboards' && !frames.length) notes.add('There are no artboards (top-level frames): the whole drawing is one page.');
	const docs = frames.length ? frames.map((f) => vectorFrameDocument(doc, f.id, findVectorNode)!) : [doc];
	const w = new PdfWriter();
	const catalog = w.add('');
	const pagesId = w.add('');
	const pageIds: number[] = [];
	docs.forEach((d, k) => {
		w.pageIndex = k;
		const scene = getVectorSceneRenderData({ document: d, viewport: { x: 0, y: 0, zoom: 1 } }, { idPrefix: `p${k}-` });
		const defs = new Map<string, VectorPaintDef>(scene.defs.map((x) => [x.id, x]));
		const page = new Page(w, defs, notes);
		const W = d.width * scale;
		const H = d.height * scale;
		// y down, in document units.
		page.content.push(`${n(scale)} 0 0 ${n(-scale)} 0 ${n(H)} cm`);
		if (d.background) {
			const c = parseVectorColor(d.background);
			if (c) page.content.push(`${n(c[0])} ${n(c[1])} ${n(c[2])} rg`, `0 0 ${n(d.width)} ${n(d.height)} re`, 'f');
		}
		for (const node of scene.nodes) page.node(node, 1);
		const content = w.add(w.stream('', new TextEncoder().encode(page.content.join('\n')), compress));
		const gsEntries = [...page.states.values()].map((name) => `/${name} ${w.add(w.gsDicts.get(`${k}:${name}`)!)} 0 R`);
		const shEntries = [...page.shadings.values()].map((name) => `/${name} ${w.add(w.shadingDicts.get(`${k}:${name}`)!)} 0 R`);
		const resources = `<< ${gsEntries.length ? `/ExtGState << ${gsEntries.join(' ')} >> ` : ''}${shEntries.length ? `/Shading << ${shEntries.join(' ')} >>` : ''} >>`;
		pageIds.push(w.add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(W)} ${n(H)}] /Resources ${resources} /Contents ${content} 0 R >>`));
	});
	w.set(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
	w.set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
	const info = w.add(`<< /Producer (Pixerate vector editor)${options.title ? ` /Title ${pdfString(options.title)}` : ''} >>`);
	return { bytes: w.bytes(catalog, info), pages: pageIds.length, notes: [...notes] };
}
