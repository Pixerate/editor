// Follows Ursula's src/react/canvases/mindmap.tsx.
import { MINDMAP_METRICS, mindmapGeometry, type MindmapTopicGeometry } from '../../../diagram/mindmap/geometry.js';
import { sceneColor, type DiagramMark, type DiagramSceneTheme, type FamilyScene } from '../scene-kit.js';

const M = MINDMAP_METRICS;

type Box = { x: number; y: number; width: number; height: number };

const round = (v: number) => Math.round(v * 100) / 100;

/** What a label line reads as (Ursula's `displayLabel`): no backticks, `<br>`s and `#…;` entities decoded. */
function displayLabel(label: string): string {
	let text = label;
	if (text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1);
	return text
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/#quot;/g, '"')
		.replace(/#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

interface Arc {
	rx: number;
	ry: number;
	rotation: number;
	large: number;
	sweep: number;
	dx: number;
	dy: number;
}

/**
 * A closed outline of relative arcs from `(x, y)`, as path data plus its exact bounds
 * (each arc is sampled through its centre parameterisation, SVG spec F.6.5).
 */
function arcOutline(x: number, y: number, arcs: Arc[]): { d: string; box: Box } {
	let px = x;
	let py = y;
	const xs = [x];
	const ys = [y];
	const parts = [`M${round(x)},${round(y)}`];
	for (const a of arcs) {
		parts.push(`a${round(a.rx)},${round(a.ry)} ${a.rotation} ${a.large},${a.sweep} ${round(a.dx)},${round(a.dy)}`);
		for (const [sx, sy] of sampleArc(px, py, a)) {
			xs.push(sx);
			ys.push(sy);
		}
		px += a.dx;
		py += a.dy;
	}
	// Ursula closes with `H0 V0 Z` (back to the start).
	parts.push(`H${round(x)} V${round(y)} Z`);
	const bx = Math.min(...xs);
	const by = Math.min(...ys);
	return { d: parts.join(' '), box: { x: bx, y: by, width: Math.max(...xs) - bx, height: Math.max(...ys) - by } };
}

function sampleArc(x1: number, y1: number, a: Arc): [number, number][] {
	const x2 = x1 + a.dx;
	const y2 = y1 + a.dy;
	let rx = Math.abs(a.rx);
	let ry = Math.abs(a.ry);
	if (!rx || !ry || (a.dx === 0 && a.dy === 0)) return [[x2, y2]];
	const phi = (a.rotation * Math.PI) / 180;
	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	const hx = (x1 - x2) / 2;
	const hy = (y1 - y2) / 2;
	const x1p = cos * hx + sin * hy;
	const y1p = -sin * hx + cos * hy;
	const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
	if (lambda > 1) {
		rx *= Math.sqrt(lambda);
		ry *= Math.sqrt(lambda);
	}
	const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
	const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
	const k = (a.large === a.sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
	const cxp = (k * rx * y1p) / ry;
	const cyp = (-k * ry * x1p) / rx;
	const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
	const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
	const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
	const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
	let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
	if (!a.sweep && dt > 0) dt -= 2 * Math.PI;
	if (a.sweep && dt < 0) dt += 2 * Math.PI;
	const out: [number, number][] = [];
	const steps = 24;
	for (let i = 1; i <= steps; i++) {
		const t = t1 + (dt * i) / steps;
		out.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
	}
	return out;
}

const arc = (rx: number, ry: number, rotation: number, sweep: number, dx: number, dy: number): Arc => ({ rx, ry, rotation, large: 0, sweep, dx, dy });

/** Mermaid's shape for a bracket form, in the topic's `w` × `h` box at (x0, y0). */
function topicShape(t: MindmapTopicGeometry, x0: number, y0: number, fill: string, underline: string): DiagramMark[] {
	const { width: w, height: h } = t;
	const base = { target: t.id, role: 'topic' };
	const key = `topic:${t.id}`;
	switch (t.form) {
		case 'circle':
			return [{ kind: 'circle', key, ...base, cx: x0 + w / 2, cy: y0 + h / 2, r: w / 2, fill }];
		case 'square':
			return [{ kind: 'rect', key, ...base, x: x0, y: y0, width: w, height: h, fill }];
		case 'rounded':
			return [{ kind: 'rect', key, ...base, x: x0, y: y0, width: w, height: h, fill, radius: 5 }];
		case 'hexagon': {
			const m = h / 4;
			const pts = [
				[m, h],
				[w - m, h],
				[w, h / 2],
				[w - m, 0],
				[m, 0],
				[0, h / 2]
			];
			return [{ kind: 'path', key, ...base, d: `M${pts.map(([x, y]) => `${round(x0 + x!)},${round(y0 + y!)}`).join(' L')} Z`, fill }];
		}
		case 'cloud': {
			const r1 = 0.15 * w;
			const r2 = 0.25 * w;
			const r3 = 0.35 * w;
			const r4 = 0.2 * w;
			const { d, box } = arcOutline(x0, y0, [
				arc(r1, r1, 0, 1, w * 0.25, -w * 0.1),
				arc(r3, r3, 1, 1, w * 0.4, -w * 0.1),
				arc(r2, r2, 1, 1, w * 0.35, w * 0.2),
				arc(r1, r1, 1, 1, w * 0.15, h * 0.35),
				arc(r4, r4, 1, 1, -w * 0.15, h * 0.65),
				arc(r2, r1, 1, 1, -w * 0.25, w * 0.15),
				arc(r3, r3, 1, 1, -w * 0.5, 0),
				arc(r1, r1, 1, 1, -w * 0.25, -w * 0.15),
				arc(r1, r1, 1, 1, -w * 0.1, -h * 0.35),
				arc(r4, r4, 1, 1, w * 0.1, -h * 0.65)
			]);
			return [{ kind: 'path', key, ...base, d, fill, box }];
		}
		case 'bang': {
			const r = 0.15 * w;
			const { d, box } = arcOutline(x0, y0, [
				arc(r, r, 1, 0, w * 0.25, -h * 0.1),
				arc(r, r, 1, 0, w * 0.25, 0),
				arc(r, r, 1, 0, w * 0.25, 0),
				arc(r, r, 1, 0, w * 0.25, h * 0.1),
				arc(r, r, 1, 0, w * 0.15, h * 0.33),
				arc(r * 0.8, r * 0.8, 1, 0, 0, h * 0.34),
				arc(r, r, 1, 0, -w * 0.15, h * 0.33),
				arc(r, r, 1, 0, -w * 0.25, h * 0.15),
				arc(r, r, 1, 0, -w * 0.25, 0),
				arc(r, r, 1, 0, -w * 0.25, 0),
				arc(r, r, 1, 0, -w * 0.25, -h * 0.15),
				arc(r, r, 1, 0, -w * 0.1, -h * 0.33),
				arc(r * 0.8, r * 0.8, 1, 0, 0, -h * 0.34),
				arc(r, r, 1, 0, w * 0.1, -h * 0.33)
			]);
			return [{ kind: 'path', key, ...base, d, fill, box }];
		}
		default:
			// `defaultMindmapNode`: a box with 5px corners and a line along the bottom.
			return [
				{ kind: 'rect', key, ...base, x: x0, y: y0, width: w, height: h, fill, radius: 5 },
				{ kind: 'line', key: `underline:${t.id}`, role: 'topic-underline', target: t.id, x1: x0, y1: y0 + h, x2: x0 + w, y2: y0 + h, stroke: underline, strokeWidth: 3 }
			];
	}
}

/** Section colours: the root is drawn dark (Mermaid's `git0`), sections in palette order. */
function topicColors(t: MindmapTopicGeometry, theme: DiagramSceneTheme): { fill: string; label: string; underline: string } {
	// `cScaleInv<n>` is the section hue's opposite: half way round the palette.
	const underline = sceneColor(theme, t.section + Math.floor(theme.palette.length / 2));
	if (t.section < 0) return { fill: theme.nodeStroke, label: theme.background, underline };
	return { fill: sceneColor(theme, t.section), label: theme.paletteText, underline };
}

/** A Font Awesome / Material icon class (`fa fa-book`) as one letter for the badge. */
function iconGlyph(icon: string): string {
	const name = icon.trim().split(/\s+/).pop() ?? '';
	const word = name.replace(/^(fa[a-z]?|mdi|bi|icon)-/, '');
	return (word[0] ?? '?').toUpperCase();
}

/**
 * Mind maps as Mermaid draws them (Ursula's `canvases/mindmap.tsx`): straight branches
 * between topic centres in the section colour, thinner with depth, under the topics; the
 * root dark in the centre, every top-level branch a section in its palette colour, Mermaid's
 * node shapes per bracket form (default box with an underline, rounded, square, circle,
 * cloud, bang, hexagon), wrapped labels and an icon badge on the top-left corner. Mermaid
 * prints no title on mind maps. A topic's shape, label and badge select it.
 */
export const mindmapScene: FamilyScene = ({ graph, theme }) => {
	const geo = mindmapGeometry(graph);
	const marks: DiagramMark[] = [];
	for (const e of geo.edges) {
		const a = geo.topics.get(e.source);
		const b = geo.topics.get(e.target);
		if (!a || !b) continue;
		marks.push({ kind: 'line', key: `branch:${e.edgeId}`, role: 'branch', x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: sceneColor(theme, e.section), strokeWidth: e.width });
	}
	for (const node of graph.nodes) {
		const t = geo.topics.get(node.id);
		if (!t) continue;
		const x0 = t.x - t.width / 2;
		const y0 = t.y - t.height / 2;
		const colors = topicColors(t, theme);
		marks.push(...topicShape(t, x0, y0, colors.fill, colors.underline));
		const top = t.y - (t.lines.length * M.lineHeight) / 2;
		t.lines.forEach((line, i) => {
			const text = displayLabel(line);
			if (!text) return;
			marks.push({
				kind: 'text',
				key: `label:${t.id}:${i}`,
				role: 'topic-label',
				target: t.id,
				x: t.x,
				y: top + (i + 0.5) * M.lineHeight,
				text,
				anchor: 'middle',
				baseline: 'middle',
				size: M.fontSize,
				fill: colors.label
			});
		});
		const icon = typeof node.data?.icon === 'string' ? node.data.icon : undefined;
		if (icon) {
			marks.push(
				{ kind: 'circle', key: `icon:${t.id}`, role: 'icon', target: t.id, cx: x0, cy: y0, r: 11, fill: colors.fill, stroke: theme.background, strokeWidth: 2 },
				{ kind: 'text', key: `icon-glyph:${t.id}`, role: 'icon', target: t.id, x: x0, y: y0, text: iconGlyph(icon), anchor: 'middle', baseline: 'middle', size: 12, fill: colors.label }
			);
		}
	}
	return marks;
};
