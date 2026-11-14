/**
 * Data visuals offered as UI components (#819) beside the chart types: `lineage` (a root fanned
 * out to a row of items), `braid` (strands twisted into one root, over and under) and `weave`
 * (items and the tags they share, many-to-many). Built on core's geometry (#811), drawn-on motion
 * and linked focus (#812) and fitted text (#813), so they draw the same here, in the page kit and
 * in Swift.
 *
 * Each renders to a standalone SVG string at a progress `p` (frame-pure, `p = 1` at rest) and with
 * an optional focused key (linked marks lit, the rest dimmed), so a host animates and responds to
 * pointer and keyboard by drawing again; `interaction(data)` gives the `createLinkFocus` options.
 */
import { drawPieces } from '../animation/draw.js';
import { bezierPathLength } from '../canvas/pathops/bezier.js';
import { fanElbows } from '../geom/connectors.js';
import { helix, splitByDepth } from '../geom/helix.js';
import { linkFocusLit, type LinkFocusOptions } from '../interaction/linkFocus.js';
import { estimatedMeasure, fitText } from '../typography/fit.js';
import { DEFAULT_CHART_PALETTE, DEFAULT_CHART_THEME } from './spec.js';

export type UiVisualId = 'lineage' | 'braid' | 'weave';

/** A lineage's data: one root fanned out to a row of items. */
export interface LineageUiData {
	root: string;
	items: { label: string }[];
	/** Accessible name (default: built from the data). */
	title?: string;
}

/** A braid's data: strands twisted into one root. `value` sets a strand's weight. */
export interface BraidUiData {
	root?: string;
	strands: { name: string; value?: number }[];
	/** Whole twists along the braid (default 2.5). */
	turns?: number;
	title?: string;
}

/** A weave's data: items and the tags each one has. */
export interface WeaveUiData {
	items: { label: string; tags: string[] }[];
	title?: string;
}

export interface UiVisualRenderInput {
	width: number;
	height: number;
	colors: Record<string, string>;
	/** Overall progress, 0–1 (1 is at rest). */
	progress: number;
	/** The focused key, from `interaction(data).order`, or null. */
	focus: string | null;
	/** Opacity of marks out of focus. */
	dim: number;
}

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const measure = estimatedMeasure('sans-serif');

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => {
	const r = Math.round(v * 100) / 100;
	return Object.is(r, -0) ? '0' : String(r);
};

function attrs(a: Record<string, string | number | undefined | null | false>): string {
	return Object.entries(a)
		.filter(([, v]) => v !== undefined && v !== null && v !== false)
		.map(([k, v]) => ` ${k}="${esc(typeof v === 'number' ? n(v) : String(v))}"`)
		.join('');
}

function el(tag: string, a: Record<string, string | number | undefined | null | false>, text?: string): string {
	return text === undefined ? `<${tag}${attrs(a)}/>` : `<${tag}${attrs(a)}>${esc(text)}</${tag}>`;
}

/** The standalone SVG document, labelled the way chart SVG is. */
function svgDoc(width: number, height: number, label: string, description: string, background: string, body: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}" role="img" aria-label="${esc(label)}" aria-labelledby="visual-title visual-desc"><title id="visual-title">${esc(label)}</title><desc id="visual-desc">${esc(description)}</desc>${el('rect', { width, height, fill: background })}${body}</svg>`;
}

/** Splits a label into lines that fit `width` at `size`, word by word (a long word gets a line of its own). */
function wrap(label: string, size: number, spacing: number, width: number): string[] {
	const lines: string[] = [];
	for (const word of label.split(/\s+/).filter(Boolean)) {
		const last = lines[lines.length - 1];
		if (last !== undefined && measure(`${last} ${word}`, size, spacing) <= width) lines[lines.length - 1] = `${last} ${word}`;
		else lines.push(word);
	}
	return lines.length ? lines : [''];
}

function textLines(x: number, y: number, lines: string[], size: number, spacing: number, fill: string, extra: Record<string, string | number | undefined> = {}): string {
	return el('text', { x, y, 'text-anchor': 'middle', 'font-family': FONT, 'font-size': size, 'font-weight': 600, 'letter-spacing': spacing || undefined, fill, ...extra }, '').replace(
		'></text>',
		`>${lines.map((line, i) => `<tspan x="${n(x)}" dy="${i === 0 ? 0 : n(size * 1.2)}">${esc(line)}</tspan>`).join('')}</text>`
	);
}

/** `stroke-dasharray` and visibility for a stroke drawn to `visible` of `length`. */
function dash(visible: number, length: number): Record<string, string | undefined> {
	if (visible >= length) return {};
	return { 'stroke-dasharray': `${n(visible)} ${n(length)}`, visibility: visible > 0 ? undefined : 'hidden' };
}

/** 0 before `start`, 1 after `end`, linear between. */
const phase = (p: number, start: number, end: number) => (p <= start ? 0 : p >= end ? 1 : (p - start) / (end - start));

const opacityAttr = (lit: boolean, dim: number, fade = 1) => {
	const o = (lit ? 1 : dim) * fade;
	return o >= 1 ? undefined : n(o);
};

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export function lineageInteraction(data: LineageUiData): LinkFocusOptions {
	const items = data.items.map((_, i) => `item-${i}`);
	return {
		marks: [['root'], ...items.map((k) => [k]), ...items.map((k) => ['root', k])],
		links: { root: items },
		order: ['root', ...items],
		labels: Object.fromEntries([['root', data.root], ...data.items.map((it, i) => [`item-${i}`, it.label])])
	};
}

export function describeLineage(data: LineageUiData): string {
	return `Lineage from ${data.root} to ${data.items.length} ${data.items.length === 1 ? 'item' : 'items'}: ${data.items.map((it) => it.label).join(', ')}.`;
}

export function renderLineage(data: LineageUiData, input: UiVisualRenderInput): string {
	const { width: W, height: H, colors: c, progress: p, dim } = input;
	const count = data.items.length;
	const pad = 16;
	const column = (W - 2 * pad) / count;
	const words = data.items.flatMap((it) => it.label.split(/\s+/).filter(Boolean));
	const fit = fitText(words.length ? words : [''], Math.max(8, column - 6), { measure, min: 8, max: 14, tracking: { floor: -0.03 } });
	const lines = data.items.map((it) => wrap(it.label, fit.size, fit.letterSpacing, column - 6));
	const maxLines = Math.max(1, ...lines.map((l) => l.length));
	const labelBlock = maxLines * fit.size * 1.2;
	const rootSize = Math.min(15, Math.max(10, fit.size + 1));
	const root = { x: W / 2, y: pad + rootSize + 10 };
	const rowY = Math.max(root.y + 40, H - pad - labelBlock - 12);
	const targets = data.items.map((_, i) => ({ x: pad + column * (i + 0.5), y: rowY }));
	const fan = fanElbows(root, targets, { gap: Math.min(4, column / 6), radius: 10, lead: Math.min(18, (rowY - root.y) / 3) });
	const model = lineageInteraction(data);
	const lit = linkFocusLit(model.marks, model.links, input.focus);
	const litRoot = lit[0];
	const litItem = (i: number) => lit[1 + i];
	const litLink = (i: number) => lit[1 + count + i];
	let body = '';
	fan.elbows.forEach((e, i) => {
		const at = 0.05 + (0.4 * i) / Math.max(1, count);
		const drawn = drawPieces([{ from: 0, to: e.length }], { at, span: 0.45, ease: 'ease-out' }).drawAt(p)[0];
		body += el('path', { d: e.d, fill: 'none', stroke: c['ink-muted'], 'stroke-width': 1.5, 'stroke-linecap': 'round', 'data-link-focus': `root item-${i}`, opacity: opacityAttr(litLink(i), dim), ...dash(drawn.visible, drawn.length) });
	});
	body += el('circle', { cx: root.x, cy: root.y, r: 5, fill: c.accent, opacity: opacityAttr(litRoot, dim), 'data-link-focus': 'root' });
	body += el('text', { x: root.x, y: root.y - 10, 'text-anchor': 'middle', 'font-family': FONT, 'font-size': rootSize, 'font-weight': 700, fill: c.ink, opacity: opacityAttr(litRoot, dim) }, data.root);
	targets.forEach((t, i) => {
		const at = 0.05 + (0.4 * i) / Math.max(1, count) + 0.35;
		const fade = phase(p, at, at + 0.15);
		const o = opacityAttr(litItem(i), dim, fade);
		body += `<g${attrs({ 'data-link-focus': `item-${i}`, opacity: fade <= 0 ? '0' : o })}>`;
		body += el('circle', { cx: t.x, cy: t.y, r: 3.5, fill: c.accent });
		body += textLines(t.x, t.y + 10 + fit.size, lines[i], fit.size, fit.letterSpacing, c.ink);
		body += '</g>';
	});
	const label = data.title || `${data.root} and ${count} ${count === 1 ? 'item' : 'items'}`;
	return svgDoc(W, H, label, describeLineage(data), c.surface, body);
}

// ---------------------------------------------------------------------------
// Braid
// ---------------------------------------------------------------------------

export function braidInteraction(data: BraidUiData): LinkFocusOptions {
	const keys = data.strands.map((_, i) => `strand-${i}`);
	return { marks: keys.map((k) => [k]), links: {}, order: keys, labels: Object.fromEntries(data.strands.map((s, i) => [`strand-${i}`, s.name])) };
}

export function describeBraid(data: BraidUiData): string {
	const weights = data.strands.some((s) => typeof s.value === 'number');
	return `Braid of ${data.strands.length} strands${data.root ? ` into ${data.root}` : ''}: ${data.strands.map((s) => (weights && typeof s.value === 'number' ? `${s.name} (${s.value})` : s.name)).join(', ')}.`;
}

export function renderBraid(data: BraidUiData, input: UiVisualRenderInput, palette: readonly string[]): string {
	const { width: W, height: H, colors: c, progress: p, dim } = input;
	const pad = 16;
	const size = 12;
	const labelWidth = Math.min(160, Math.max(48, ...data.strands.map((s) => measure(s.name, size, 0) + 14)));
	const rootLabel = data.root ? measure(data.root, size, 0) + 14 : 0;
	const start = { x: pad + rootLabel + 6, y: H / 2 };
	const end = { x: Math.max(start.x + 60, W - pad - labelWidth), y: H / 2 };
	const amplitude = Math.max(6, Math.min(60, (H - 2 * pad) / 2 - 10));
	const count = data.strands.length;
	const max = Math.max(0, ...data.strands.map((s) => (typeof s.value === 'number' && s.value > 0 ? s.value : 0)));
	const widthOf = (s: BraidUiData['strands'][number]) => (max > 0 && typeof s.value === 'number' ? 2.5 + 5.5 * Math.max(0, s.value) / max : 5);
	// A turn needs room: at least 3.5 amplitudes along the axis, or the twists close up into coils.
	const turns = Math.min(data.turns ?? 2.5, Math.max(0.75, (end.x - start.x) / (amplitude * 3.5)));
	const strands = data.strands.map((s, i) => {
		const h = helix([start, end], { amplitude, turns, phase: (2 * Math.PI * i) / count, envelope: 'start', samples: Math.max(48, Math.round((end.x - start.x) / 3)) });
		const runs = splitByDepth(h.points, h.depth);
		const plan = drawPieces(runs.map((r) => ({ from: r.from, to: r.to })), { total: h.length, at: 0.04 * i, span: 0.8, ease: 'ease-in-out' });
		return { s, i, h, runs, drawn: plan.drawAt(p), color: palette[i % palette.length]!, width: widthOf(s) };
	});
	const lit = linkFocusLit(braidInteraction(data).marks, {}, input.focus);
	let body = '';
	for (const front of [false, true]) {
		for (const st of strands) {
			st.runs.forEach((r, k) => {
				if (r.front !== front) return;
				const d = st.drawn[k];
				body += el('path', { d: r.d, fill: 'none', stroke: st.color, 'stroke-width': st.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-link-focus': `strand-${st.i}`, opacity: opacityAttr(lit[st.i], dim, front ? 1 : 0.6), ...dash(d.visible, d.length) });
			});
		}
	}
	body += el('circle', { cx: start.x, cy: start.y, r: 4, fill: c.ink });
	if (data.root) body += el('text', { x: start.x - 10, y: start.y + size * 0.35, 'text-anchor': 'end', 'font-family': FONT, 'font-size': size, 'font-weight': 700, fill: c.ink }, data.root);
	// Labels at the open end, in the strands' order down the page, pushed apart to one line each and
	// kept inside the picture; a label moved off its strand's end gets a short leader.
	const ends = strands.map((st) => st.h.points[st.h.points.length - 1]!);
	const lineH = size * 1.45;
	const order = ends.map((_, i) => i).sort((a, b) => ends[a]!.y - ends[b]!.y || a - b);
	const ys = order.map((i) => ends[i]!.y);
	for (let k = 1; k < ys.length; k++) ys[k] = Math.max(ys[k]!, ys[k - 1]! + lineH);
	const overflow = ys[ys.length - 1]! - (H - pad - size * 0.5);
	if (overflow > 0) for (let k = 0; k < ys.length; k++) ys[k]! -= overflow;
	for (let k = ys.length - 2; k >= 0; k--) ys[k] = Math.min(ys[k]!, ys[k + 1]! - lineH);
	const top = pad + size * 0.5;
	if (ys[0]! < top) {
		const shift = top - ys[0]!;
		for (let k = 0; k < ys.length; k++) ys[k]! += shift;
	}
	const labelY: number[] = new Array(count);
	order.forEach((i, k) => (labelY[i] = ys[k]!));
	const fade = phase(p, 0.82, 1);
	strands.forEach((st, i) => {
		const end = ends[i]!;
		const x = end.x + 14;
		const y = labelY[i]!;
		const o = fade <= 0 ? '0' : opacityAttr(lit[i]!, dim, fade);
		if (Math.abs(y - end.y) > 3) body += el('line', { x1: end.x + 4, y1: end.y, x2: x - 3, y2: y, stroke: st.color, 'stroke-width': 1, 'data-link-focus': `strand-${i}`, opacity: o });
		body += el('text', { x, y: y + size * 0.35, 'font-family': FONT, 'font-size': size, 'font-weight': 600, fill: c.ink, 'data-link-focus': `strand-${i}`, opacity: o }, st.s.name);
	});
	const label = data.title || `Braid of ${count} strands${data.root ? ` into ${data.root}` : ''}`;
	return svgDoc(W, H, label, describeBraid(data), c.surface, body);
}

// ---------------------------------------------------------------------------
// Weave
// ---------------------------------------------------------------------------

/** The weave's tags, in order of first appearance. */
export function weaveTags(data: WeaveUiData): string[] {
	const tags: string[] = [];
	for (const it of data.items) for (const t of it.tags) if (!tags.includes(t)) tags.push(t);
	return tags;
}

export function weaveInteraction(data: WeaveUiData): LinkFocusOptions {
	const tags = weaveTags(data);
	const links: Record<string, string[]> = {};
	const linkMarks: string[][] = [];
	data.items.forEach((it, i) => {
		links[`item-${i}`] = [...new Set(it.tags)].map((t) => `tag-${tags.indexOf(t)}`);
		for (const t of links[`item-${i}`]!) linkMarks.push([`item-${i}`, t]);
	});
	const items = data.items.map((_, i) => `item-${i}`);
	const tagKeys = tags.map((_, j) => `tag-${j}`);
	return {
		marks: [...items.map((k) => [k]), ...tagKeys.map((k) => [k]), ...linkMarks],
		links,
		order: [...items, ...tagKeys],
		labels: Object.fromEntries([...data.items.map((it, i) => [`item-${i}`, it.label]), ...tags.map((t, j) => [`tag-${j}`, t])])
	};
}

export function describeWeave(data: WeaveUiData): string {
	const tags = weaveTags(data);
	return `${data.items.length} ${data.items.length === 1 ? 'item' : 'items'} and ${tags.length} ${tags.length === 1 ? 'tag' : 'tags'}: ${data.items.map((it) => `${it.label} (${it.tags.length ? it.tags.join(', ') : 'none'})`).join('; ')}.`;
}

export function renderWeave(data: WeaveUiData, input: UiVisualRenderInput): string {
	const { width: W, height: H, colors: c, progress: p, dim } = input;
	const pad = 16;
	const tags = weaveTags(data);
	const items = data.items;
	const itemColumn = (W - 2 * pad) / items.length;
	const tagColumn = (W - 2 * pad) / Math.max(1, tags.length);
	const itemWords = items.flatMap((it) => it.label.split(/\s+/).filter(Boolean));
	const itemFit = fitText(itemWords.length ? itemWords : [''], Math.max(8, itemColumn - 6), { measure, min: 8, max: 14, tracking: { floor: -0.03 } });
	const tagFit = fitText(tags.length ? tags : [''], Math.max(8, tagColumn - 18), { measure, min: 8, max: 12 });
	const itemLines = items.map((it) => wrap(it.label, itemFit.size, itemFit.letterSpacing, itemColumn - 6));
	const maxLines = Math.max(1, ...itemLines.map((l) => l.length));
	const itemY = pad + maxLines * itemFit.size * 1.2 + 10;
	const chipH = tagFit.size + 12;
	const tagY = H - pad - chipH;
	const ix = (i: number) => pad + itemColumn * (i + 0.5);
	const tx = (j: number) => pad + tagColumn * (j + 0.5);
	const model = weaveInteraction(data);
	const lit = linkFocusLit(model.marks, model.links, input.focus);
	const linkMarks = model.marks.slice(items.length + tags.length);
	let body = '';
	linkMarks.forEach((keys, k) => {
		const i = Number(keys[0]!.slice(5));
		const j = Number(keys[1]!.slice(4));
		const x0 = ix(i), y0 = itemY, x1 = tx(j), y1 = tagY;
		const mid = (y0 + y1) / 2;
		const d = `M${n(x0)} ${n(y0)}C${n(x0)} ${n(mid)} ${n(x1)} ${n(mid)} ${n(x1)} ${n(y1)}`;
		const length = bezierPathLength(d);
		const at = 0.05 + (0.45 * k) / Math.max(1, linkMarks.length);
		const drawn = drawPieces([{ from: 0, to: length }], { at, span: 0.4, ease: 'ease-out' }).drawAt(p)[0];
		body += el('path', { d, fill: 'none', stroke: c.accent, 'stroke-width': 1.75, 'stroke-linecap': 'round', 'data-link-focus': keys.join(' '), opacity: opacityAttr(lit[items.length + tags.length + k], dim), ...dash(drawn.visible, drawn.length) });
	});
	const fade = phase(p, 0, 0.2);
	items.forEach((_, i) => {
		body += `<g${attrs({ 'data-link-focus': `item-${i}`, opacity: fade <= 0 ? '0' : opacityAttr(lit[i], dim, fade) })}>`;
		body += el('circle', { cx: ix(i), cy: itemY, r: 4.5, fill: c.ink });
		body += textLines(ix(i), pad + itemFit.size, itemLines[i], itemFit.size, itemFit.letterSpacing, c.ink);
		body += '</g>';
	});
	tags.forEach((t, j) => {
		const w = Math.min(tagColumn - 6, measure(t, tagFit.size, tagFit.letterSpacing) + 16);
		body += `<g${attrs({ 'data-link-focus': `tag-${j}`, opacity: fade <= 0 ? '0' : opacityAttr(lit[items.length + j], dim, fade) })}>`;
		body += el('rect', { x: tx(j) - w / 2, y: tagY, width: w, height: chipH, rx: chipH / 2, fill: c['surface-raised'], stroke: c.border });
		body += el('text', { x: tx(j), y: tagY + chipH / 2 + tagFit.size * 0.35, 'text-anchor': 'middle', 'font-family': FONT, 'font-size': tagFit.size, fill: c['ink-muted'] }, t);
		body += '</g>';
	});
	const label = data.title || `${items.length} items and ${tags.length} tags`;
	return svgDoc(W, H, label, describeWeave(data), c.surface, body);
}

// ---------------------------------------------------------------------------
// Defaults shared with ui-components.ts
// ---------------------------------------------------------------------------

export const UI_VISUAL_DARK = { surface: '#0f172a', raised: '#1e293b', ink: '#e2e8f0', inkMuted: '#94a3b8', border: '#334155' } as const;
export const UI_VISUAL_LIGHT = { surface: DEFAULT_CHART_THEME.surface, raised: '#f1f5f9', ink: DEFAULT_CHART_THEME.text, inkMuted: DEFAULT_CHART_THEME.mutedText, border: '#cbd5e1' } as const;
export const UI_VISUAL_PALETTE = DEFAULT_CHART_PALETTE;
