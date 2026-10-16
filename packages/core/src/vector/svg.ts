/**
 * SVG export and import for vector documents. Import is DOM-free (works in Node and
 * workers): it reads `<svg>`, `<g>`, `<path>`, `<rect>`, `<circle>`, `<ellipse>`, `<line>`,
 * `<polyline>`, `<polygon>`, linear / radial gradients, presentation attributes, `style`
 * declarations and `transform`s. Text, images, clip paths, masks, filters and `<use>` are
 * skipped.
 */
import { gradientToSvgDef, type CanvasGradientDef, type GradientStop, type SvgGradientDef } from '../canvas/gradient.js';
import { formatNumber } from '../canvas/shapeGeometry.js';
import {
	bezierToSubpaths,
	ellipseSubpath,
	hasPaint,
	IDENTITY_MATRIX,
	lineSubpath,
	multiplyMatrices,
	rectSubpath,
	rotateMatrix,
	scaleMatrix,
	transformVectorNode,
	translateMatrix,
	vectorPathData,
	type AffineMatrix
} from './geometry.js';
import type { VectorDocument, VectorFillRule, VectorGroupNode, VectorLineCap, VectorLineJoin, VectorNode, VectorPaint, VectorPathNode, VectorSubpath } from './types.js';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface VectorSvgExportOptions {
	/** Decimal places for coordinates (default 3). */
	precision?: number;
	/** Draw `document.background` as a full-size rect (default true). */
	background?: boolean;
	/** Include hidden nodes with `display="none"` instead of leaving them out (default false). */
	includeHidden?: boolean;
	/** Prefix for gradient ids (default `vg-`), to keep ids unique when several SVGs share a page. */
	idPrefix?: string;
	/** Indent nested elements (default true). */
	pretty?: boolean;
}

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A paint as an SVG attribute value plus the gradient def it needs (if any). */
export function vectorPaintToSvg(paint: VectorPaint | undefined, gradientId: string): { value: string; gradient: SvgGradientDef | null } {
	if (!hasPaint(paint)) return { value: 'none', gradient: null };
	if (typeof paint === 'string') return { value: paint, gradient: null };
	return { value: `url(#${gradientId})`, gradient: gradientToSvgDef(paint as CanvasGradientDef, gradientId) };
}

function gradientMarkup(def: SvgGradientDef): string {
	const tag = def.type === 'radial' ? 'radialGradient' : 'linearGradient';
	const attrs = Object.entries(def.attrs)
		.map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
		.join('');
	const stops = def.stops
		.map((s) => `<stop offset="${s.offset}" stop-color="${escapeAttr(s.stopColor)}"${s.stopOpacity !== undefined ? ` stop-opacity="${s.stopOpacity}"` : ''}/>`)
		.join('');
	return `<${tag} id="${escapeAttr(def.id)}"${attrs}>${stops}</${tag}>`;
}

/** Serializes a vector document as a standalone SVG string. */
export function vectorDocumentToSvg(doc: VectorDocument, options: VectorSvgExportOptions = {}): string {
	const precision = options.precision ?? 3;
	const prefix = options.idPrefix ?? 'vg-';
	const pretty = options.pretty !== false;
	const defs: string[] = [];
	const lines: string[] = [];
	const num = (n: number) => formatNumber(n, precision);
	const indent = (depth: number) => (pretty ? '  '.repeat(depth) : '');

	const common = (node: VectorNode) => {
		let out = ` id="${escapeAttr(node.id)}"`;
		if (node.transform) out += ` transform="matrix(${node.transform.map((n) => formatNumber(n, 6)).join(' ')})"`;
		if (node.opacity !== undefined && node.opacity < 1) out += ` opacity="${num(node.opacity)}"`;
		if (node.visible === false) out += ` display="none"`;
		return out;
	};

	const emit = (node: VectorNode, depth: number) => {
		if (node.visible === false && !options.includeHidden) return;
		if (node.type === 'group') {
			lines.push(`${indent(depth)}<g${common(node)}>`);
			for (const child of node.children) emit(child, depth + 1);
			lines.push(`${indent(depth)}</g>`);
			return;
		}
		const fill = vectorPaintToSvg(node.fill, `${prefix}fill-${node.id}`);
		const stroke = vectorPaintToSvg(node.stroke, `${prefix}stroke-${node.id}`);
		if (fill.gradient) defs.push(gradientMarkup(fill.gradient));
		if (stroke.gradient) defs.push(gradientMarkup(stroke.gradient));
		let attrs = `${common(node)} d="${vectorPathData(node, precision)}" fill="${escapeAttr(fill.value)}"`;
		if (node.fillRule === 'evenodd') attrs += ` fill-rule="evenodd"`;
		if (stroke.value !== 'none') {
			attrs += ` stroke="${escapeAttr(stroke.value)}" stroke-width="${num(node.strokeWidth ?? 1)}"`;
			if (node.strokeLinecap && node.strokeLinecap !== 'butt') attrs += ` stroke-linecap="${node.strokeLinecap}"`;
			if (node.strokeLinejoin && node.strokeLinejoin !== 'miter') attrs += ` stroke-linejoin="${node.strokeLinejoin}"`;
			if (node.strokeDasharray?.length) attrs += ` stroke-dasharray="${node.strokeDasharray.map(num).join(' ')}"`;
		}
		lines.push(`${indent(depth)}<path${attrs}/>`);
	};

	for (const node of doc.nodes) emit(node, 1);
	const w = num(doc.width);
	const h = num(doc.height);
	const nl = pretty ? '\n' : '';
	const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`];
	if (defs.length) out.push(`${indent(1)}<defs>${defs.join('')}</defs>`);
	if (doc.background && options.background !== false && hasPaint(doc.background)) {
		out.push(`${indent(1)}<rect width="${w}" height="${h}" fill="${escapeAttr(doc.background)}"/>`);
	}
	out.push(...lines, '</svg>');
	return out.join(nl);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface VectorSvgImportOptions {
	/** Makes ids for elements without a usable `id` (default `node-1`, `node-2`, …). */
	createId?: () => string;
}

interface Element {
	name: string;
	attrs: Record<string, string>;
	children: Element[];
}

/** A tiny non-validating XML reader: elements and attributes only. */
function parseXml(source: string): Element | null {
	const text = source
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<\?[\s\S]*?\?>/g, '')
		.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
		.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, '');
	const root: Element = { name: '#root', attrs: {}, children: [] };
	const stack: Element[] = [root];
	const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
	const attr = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
	let m: RegExpExecArray | null;
	while ((m = tag.exec(text))) {
		const [, closing, rawName, rawAttrs, selfClosing] = m;
		const name = rawName.replace(/^svg:/, '');
		if (closing) {
			for (let i = stack.length - 1; i > 0; i--) {
				if (stack[i].name === name) {
					stack.length = i;
					break;
				}
			}
			continue;
		}
		const attrs: Record<string, string> = {};
		let a: RegExpExecArray | null;
		attr.lastIndex = 0;
		while ((a = attr.exec(rawAttrs))) attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
		const el: Element = { name, attrs, children: [] };
		stack[stack.length - 1].children.push(el);
		if (!selfClosing) stack.push(el);
	}
	const find = (el: Element): Element | null => {
		if (el.name === 'svg') return el;
		for (const c of el.children) {
			const f = find(c);
			if (f) return f;
		}
		return null;
	};
	return find(root);
}

function decodeEntities(s: string): string {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

const numberList = (s: string | undefined): number[] =>
	(s ?? '')
		.trim()
		.split(/[\s,]+|(?=-)(?<![eE])/)
		.filter(Boolean)
		.map(Number)
		.filter((n) => Number.isFinite(n));

const length = (s: string | undefined, fallback = 0): number => {
	if (s === undefined) return fallback;
	const n = parseFloat(s);
	return Number.isFinite(n) ? n : fallback;
};

/** Parses an SVG `transform` attribute into one matrix. */
export function parseSvgTransform(value: string | undefined): AffineMatrix {
	let m: AffineMatrix = IDENTITY_MATRIX;
	if (!value) return m;
	const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
	let t: RegExpExecArray | null;
	while ((t = re.exec(value))) {
		const n = numberList(t[2]);
		let step: AffineMatrix = IDENTITY_MATRIX;
		switch (t[1]) {
			case 'matrix':
				if (n.length >= 6) step = [n[0], n[1], n[2], n[3], n[4], n[5]];
				break;
			case 'translate':
				step = translateMatrix(n[0] ?? 0, n[1] ?? 0);
				break;
			case 'scale':
				step = scaleMatrix(n[0] ?? 1, n[1] ?? n[0] ?? 1);
				break;
			case 'rotate':
				step = rotateMatrix(n[0] ?? 0, { x: n[1] ?? 0, y: n[2] ?? 0 });
				break;
			case 'skewX':
				step = [1, 0, Math.tan(((n[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
				break;
			case 'skewY':
				step = [1, Math.tan(((n[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
				break;
		}
		// SVG lists apply right to left: `translate(…) rotate(…)` rotates first.
		m = multiplyMatrices(step, m);
	}
	return m;
}

interface InheritedStyle {
	fill: string;
	stroke: string;
	strokeWidth: string;
	strokeLinecap?: string;
	strokeLinejoin?: string;
	strokeDasharray?: string;
	fillRule?: string;
}

const STYLE_KEYS: Record<string, keyof InheritedStyle> = {
	fill: 'fill',
	stroke: 'stroke',
	'stroke-width': 'strokeWidth',
	'stroke-linecap': 'strokeLinecap',
	'stroke-linejoin': 'strokeLinejoin',
	'stroke-dasharray': 'strokeDasharray',
	'fill-rule': 'fillRule'
};

function readStyle(el: Element, parent: InheritedStyle): InheritedStyle {
	const out = { ...parent };
	for (const [attr, key] of Object.entries(STYLE_KEYS)) if (el.attrs[attr] !== undefined) out[key] = el.attrs[attr].trim();
	for (const decl of (el.attrs.style ?? '').split(';')) {
		const i = decl.indexOf(':');
		if (i < 0) continue;
		const key = STYLE_KEYS[decl.slice(0, i).trim()];
		if (key) out[key] = decl.slice(i + 1).replace(/!important/, '').trim();
	}
	return out;
}

function readStops(el: Element): GradientStop[] {
	return el.children
		.filter((c) => c.name === 'stop')
		.map((c) => {
			const style = Object.fromEntries(
				(c.attrs.style ?? '')
					.split(';')
					.map((d) => d.split(':').map((s) => s.trim()))
					.filter((d) => d.length === 2)
			);
			const raw = c.attrs.offset ?? '0';
			const offset = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
			const opacity = style['stop-opacity'] ?? c.attrs['stop-opacity'];
			return {
				offset: Number.isFinite(offset) ? Math.max(0, Math.min(1, offset)) : 0,
				color: style['stop-color'] ?? c.attrs['stop-color'] ?? '#000',
				...(opacity !== undefined ? { opacity: parseFloat(opacity) } : {})
			};
		});
}

const fraction = (s: string | undefined, fallback: number) => {
	if (s === undefined) return fallback;
	const n = parseFloat(s);
	if (!Number.isFinite(n)) return fallback;
	return s.trim().endsWith('%') ? n / 100 : n;
};

function collectGradients(el: Element, raw: Map<string, Element>) {
	if ((el.name === 'linearGradient' || el.name === 'radialGradient') && el.attrs.id) raw.set(el.attrs.id, el);
	for (const c of el.children) collectGradients(c, raw);
}

function resolveGradient(id: string, raw: Map<string, Element>, seen = new Set<string>()): CanvasGradientDef | null {
	const el = raw.get(id);
	if (!el || seen.has(id)) return null;
	seen.add(id);
	let stops = readStops(el);
	const href = el.attrs.href ?? el.attrs['xlink:href'];
	if (!stops.length && href?.startsWith('#')) stops = resolveGradient(href.slice(1), raw, seen)?.stops ?? [];
	if (!stops.length) return null;
	if (el.name === 'radialGradient') {
		return { type: 'radial', cx: fraction(el.attrs.cx, 0.5), cy: fraction(el.attrs.cy, 0.5), r: fraction(el.attrs.r, 0.5), stops };
	}
	const x1 = fraction(el.attrs.x1, 0);
	const y1 = fraction(el.attrs.y1, 0);
	const x2 = fraction(el.attrs.x2, 1);
	const y2 = fraction(el.attrs.y2, 0);
	// CSS angle: 0° points up, clockwise.
	const angle = Math.round(((Math.atan2(x2 - x1, -(y2 - y1)) * 180) / Math.PI + 360) % 360);
	return { type: 'linear', angle, stops };
}

/** Parses SVG markup into a vector document. Throws when there is no `<svg>` element. */
export function parseVectorSvg(svg: string, options: VectorSvgImportOptions = {}): VectorDocument {
	const root = parseXml(svg);
	if (!root) throw new Error('The markup has no <svg> element.');
	let counter = 0;
	const usedIds = new Set<string>();
	const createId = options.createId ?? (() => `node-${++counter}`);
	const idFor = (el: Element) => {
		const id = el.attrs.id;
		if (id && !usedIds.has(id)) {
			usedIds.add(id);
			return id;
		}
		let next = createId();
		while (usedIds.has(next)) next = createId();
		usedIds.add(next);
		return next;
	};

	const rawGradients = new Map<string, Element>();
	collectGradients(root, rawGradients);
	const paint = (value: string): VectorPaint => {
		const v = value.trim();
		const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(v);
		if (url) return resolveGradient(url[1], rawGradients) ?? null;
		if (v === 'none' || v === '') return null;
		return v;
	};

	const viewBox = numberList(root.attrs.viewBox);
	const width = viewBox.length === 4 ? viewBox[2] : length(root.attrs.width, 300);
	const height = viewBox.length === 4 ? viewBox[3] : length(root.attrs.height, 150);
	const rootMatrix: AffineMatrix = viewBox.length === 4 ? translateMatrix(-viewBox[0], -viewBox[1]) : IDENTITY_MATRIX;

	const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'style', 'title', 'desc', 'metadata', 'pattern', 'marker', 'filter', 'text', 'image', 'use', 'linearGradient', 'radialGradient', 'script', 'foreignObject']);

	const shapeOf = (el: Element): VectorSubpath[] | null => {
		const a = el.attrs;
		switch (el.name) {
			case 'path':
				return a.d ? bezierToSubpaths(a.d) : null;
			case 'rect': {
				const w = length(a.width);
				const h = length(a.height);
				if (w <= 0 || h <= 0) return null;
				const r = length(a.rx ?? a.ry, 0);
				return [rectSubpath({ x: length(a.x), y: length(a.y), width: w, height: h }, r)];
			}
			case 'circle': {
				const r = length(a.r);
				if (r <= 0) return null;
				const cx = length(a.cx);
				const cy = length(a.cy);
				return [ellipseSubpath({ x: cx - r, y: cy - r, width: 2 * r, height: 2 * r })];
			}
			case 'ellipse': {
				const rx = length(a.rx);
				const ry = length(a.ry);
				if (rx <= 0 || ry <= 0) return null;
				return [ellipseSubpath({ x: length(a.cx) - rx, y: length(a.cy) - ry, width: 2 * rx, height: 2 * ry })];
			}
			case 'line':
				return [lineSubpath({ x: length(a.x1), y: length(a.y1) }, { x: length(a.x2), y: length(a.y2) })];
			case 'polyline':
			case 'polygon': {
				const n = numberList(a.points);
				if (n.length < 4) return null;
				const anchors = [];
				for (let i = 0; i + 1 < n.length; i += 2) anchors.push({ x: n[i], y: n[i + 1] });
				return [{ anchors, closed: el.name === 'polygon' }];
			}
		}
		return null;
	};

	const visit = (el: Element, style: InheritedStyle, matrix: AffineMatrix): VectorNode[] => {
		const out: VectorNode[] = [];
		for (const child of el.children) {
			if (SKIP.has(child.name)) continue;
			const m = multiplyMatrices(parseSvgTransform(child.attrs.transform), matrix);
			const s = readStyle(child, style);
			const opacity = child.attrs.opacity !== undefined ? parseFloat(child.attrs.opacity) : undefined;
			const hidden = child.attrs.display === 'none' || child.attrs.visibility === 'hidden';
			const meta = {
				...(child.attrs['inkscape:label'] || child.attrs['data-name'] ? { name: child.attrs['inkscape:label'] ?? child.attrs['data-name'] } : {}),
				...(opacity !== undefined && Number.isFinite(opacity) && opacity < 1 ? { opacity } : {}),
				...(hidden ? { visible: false } : {})
			};
			if (child.name === 'g' || child.name === 'svg' || child.name === 'a' || child.name === 'switch') {
				const children = visit(child, s, m);
				if (!children.length) continue;
				const group: VectorGroupNode = { id: idFor(child), type: 'group', ...meta, children };
				out.push(group);
				continue;
			}
			const subpaths = shapeOf(child);
			if (!subpaths || !subpaths.length) continue;
			let node: VectorPathNode = {
				id: idFor(child),
				type: 'path',
				...meta,
				subpaths,
				fill: child.name === 'line' ? null : paint(s.fill),
				stroke: paint(s.stroke),
				...(s.strokeWidth ? { strokeWidth: length(s.strokeWidth, 1) } : {}),
				...(s.strokeLinecap ? { strokeLinecap: s.strokeLinecap as VectorLineCap } : {}),
				...(s.strokeLinejoin ? { strokeLinejoin: s.strokeLinejoin as VectorLineJoin } : {}),
				...(s.strokeDasharray && s.strokeDasharray !== 'none' ? { strokeDasharray: numberList(s.strokeDasharray) } : {}),
				...(s.fillRule === 'evenodd' ? { fillRule: 'evenodd' as VectorFillRule } : {})
			};
			if (m !== IDENTITY_MATRIX) {
				node = transformVectorNode(node, m);
				const strokeScale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
				if (hasPaint(node.stroke) && strokeScale > 0 && Math.abs(strokeScale - 1) > 1e-9) node.strokeWidth = (node.strokeWidth ?? 1) * strokeScale;
			}
			out.push(node);
		}
		return out;
	};

	const nodes = visit(root, readStyle(root, { fill: '#000', stroke: 'none', strokeWidth: '' }), rootMatrix);
	return { width, height, nodes };
}
