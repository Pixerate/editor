// Follows Ursula's src/react/canvases/architecture.tsx (and the title node of src/react/canvas/Canvas.tsx).
import type { DiagramGraph, GraphNode } from '../../../diagram/types.js';
import { ARCH_METRICS, architectureArrow, architectureEdgeRoute, isSide, serviceLabelLines, shiftEndpoint, type ArchSide } from '../../../diagram/architecture/geometry.js';
import type { DiagramLayout } from '../layout.js';
import { DIAGRAM_TITLE_TARGET, estimateTextWidth, type DiagramMark, type DiagramSceneTheme, type FamilyScene } from '../scene-kit.js';

const A = ARCH_METRICS;
/** Mermaid's built-in icon square and glyph colours (Ursula's `--ursula-arch-icon-bg` / `-fg` defaults). */
const ICON_BG = '#087ebf';
const ICON_FG = '#ffffff';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Rewrites an SVG path (M, L, H, V, C, S, Q, Z, absolute or relative; no arcs) as absolute
 * M / L / C / Q / Z commands, scaled by `s` and moved by (`ox`, `oy`), so Mermaid's 80×80 icon
 * glyphs can be drawn at any size in canvas coordinates.
 */
function placePath(d: string, s: number, ox: number, oy: number): string {
	const tokens = d.match(/[MmLlHhVvCcSsQqZz]|-?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g) ?? [];
	const out: string[] = [];
	const P = (x: number, y: number) => `${r2(ox + x * s)},${r2(oy + y * s)}`;
	let i = 0;
	let cmd = '';
	let x = 0, y = 0, sx = 0, sy = 0;
	let lastC: [number, number] | null = null;
	const num = () => Number(tokens[i++]);
	while (i < tokens.length) {
		if (/[A-Za-z]/.test(tokens[i]!)) cmd = tokens[i++]!;
		const rel = cmd === cmd.toLowerCase();
		const bx = rel ? x : 0;
		const by = rel ? y : 0;
		switch (cmd.toUpperCase()) {
			case 'M':
				x = bx + num();
				y = by + num();
				sx = x;
				sy = y;
				out.push(`M${P(x, y)}`);
				cmd = rel ? 'l' : 'L';
				lastC = null;
				break;
			case 'L':
				x = bx + num();
				y = by + num();
				out.push(`L${P(x, y)}`);
				lastC = null;
				break;
			case 'H':
				x = bx + num();
				out.push(`L${P(x, y)}`);
				lastC = null;
				break;
			case 'V':
				y = (rel ? y : 0) + num();
				out.push(`L${P(x, y)}`);
				lastC = null;
				break;
			case 'C': {
				const c1x = bx + num(), c1y = by + num(), c2x = bx + num(), c2y = by + num();
				x = bx + num();
				y = by + num();
				out.push(`C${P(c1x, c1y)} ${P(c2x, c2y)} ${P(x, y)}`);
				lastC = [c2x, c2y];
				break;
			}
			case 'S': {
				const c1x = lastC ? 2 * x - lastC[0] : x;
				const c1y = lastC ? 2 * y - lastC[1] : y;
				const c2x = bx + num(), c2y = by + num();
				x = bx + num();
				y = by + num();
				out.push(`C${P(c1x, c1y)} ${P(c2x, c2y)} ${P(x, y)}`);
				lastC = [c2x, c2y];
				break;
			}
			case 'Q': {
				const cx = bx + num(), cy = by + num();
				x = bx + num();
				y = by + num();
				out.push(`Q${P(cx, cy)} ${P(x, y)}`);
				lastC = null;
				break;
			}
			case 'Z':
				x = sx;
				y = sy;
				out.push('Z');
				lastC = null;
				break;
			default:
				i++;
		}
	}
	return out.join(' ');
}

/** An ellipse as four cubic curves (glyph units). */
function ellipse(cx: number, cy: number, rx: number, ry: number): string {
	const k = 0.5523;
	return `M${cx - rx},${cy} C${cx - rx},${cy - ry * k} ${cx - rx * k},${cy - ry} ${cx},${cy - ry} C${cx + rx * k},${cy - ry} ${cx + rx},${cy - ry * k} ${cx + rx},${cy} C${cx + rx},${cy + ry * k} ${cx + rx * k},${cy + ry} ${cx},${cy + ry} C${cx - rx * k},${cy + ry} ${cx - rx},${cy + ry * k} ${cx - rx},${cy} Z`;
}

/** A rounded rectangle (glyph units). */
function roundRect(x: number, y: number, w: number, h: number, r: number): string {
	return `M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`;
}

const line = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} L${x2},${y2}`;

/** A glyph part: `stroke` parts are 2px outlines, `fill` parts solid. */
type GlyphPart = { d: string; paint: 'stroke' | 'fill' | 'both'; width?: number };

const BAR = (y: number): GlyphPart => ({ d: `m56.25,${y}c0,.27-.45.5-1,.5h-10.5c-.55,0-1-.23-1-.5s.45-.5,1-.5h10.5c.55,0,1,.23,1,.5Z`, paint: 'both', width: 1 });
const DOTS = (y: number): GlyphPart[] => [32.5, 27.5, 22.5].map((x) => ({ d: ellipse(x, y, 0.75, 0.75), paint: 'both', width: 1 }));

/**
 * Mermaid's built-in architecture icons (`architectureIcons` in its renderer, 80×80), as paths:
 * the same outlines, with its `<ellipse>`, `<circle>`, `<rect>` and `<line>` elements written as
 * path data.
 */
const ARCH_GLYPHS: Record<string, GlyphPart[]> = {
	database: [
		{ d: 'm20,57.86c0,3.94,8.95,7.14,20,7.14s20-3.2,20-7.14', paint: 'stroke' },
		{ d: 'm20,45.95c0,3.94,8.95,7.14,20,7.14s20-3.2,20-7.14', paint: 'stroke' },
		{ d: 'm20,34.05c0,3.94,8.95,7.14,20,7.14s20-3.2,20-7.14', paint: 'stroke' },
		{ d: ellipse(40, 22.14, 20, 7.14), paint: 'stroke' },
		{ d: line(20, 57.86, 20, 22.14), paint: 'stroke' },
		{ d: line(60, 57.86, 60, 22.14), paint: 'stroke' }
	],
	server: [
		{ d: roundRect(17.5, 17.5, 45, 45, 2), paint: 'stroke' },
		{ d: line(17.5, 32.5, 62.5, 32.5), paint: 'stroke' },
		{ d: line(17.5, 47.5, 62.5, 47.5), paint: 'stroke' },
		BAR(25),
		BAR(40),
		BAR(55),
		...DOTS(25),
		...DOTS(40),
		...DOTS(55)
	],
	disk: [
		{ d: roundRect(20, 15, 40, 50, 1), paint: 'stroke' },
		{ d: ellipse(24, 19.17, 0.8, 0.83), paint: 'stroke' },
		{ d: ellipse(56, 19.17, 0.8, 0.83), paint: 'stroke' },
		{ d: ellipse(24, 60.83, 0.8, 0.83), paint: 'stroke' },
		{ d: ellipse(56, 60.83, 0.8, 0.83), paint: 'stroke' },
		{ d: ellipse(40, 33.75, 14, 14.58), paint: 'stroke' },
		{ d: ellipse(40, 33.75, 4, 4.17), paint: 'both' },
		{ d: 'm37.51,42.52l-4.83,13.22c-.26.71-1.1,1.02-1.76.64l-4.18-2.42c-.66-.38-.81-1.26-.33-1.84l9.01-10.8c.88-1.05,2.56-.08,2.09,1.2Z', paint: 'fill' }
	],
	internet: [
		{ d: ellipse(40, 40, 22.5, 22.5), paint: 'stroke' },
		{ d: line(40, 17.5, 40, 62.5), paint: 'stroke' },
		{ d: line(17.5, 40, 62.5, 40), paint: 'stroke' },
		{ d: 'm39.99,17.51c-15.28,11.1-15.28,33.88,0,44.98', paint: 'stroke' },
		{ d: 'm40.01,17.51c15.28,11.1,15.28,33.88,0,44.98', paint: 'stroke' },
		{ d: line(19.75, 30.1, 60.25, 30.1), paint: 'stroke' },
		{ d: line(19.75, 49.9, 60.25, 49.9), paint: 'stroke' }
	],
	cloud: [
		{
			d: 'm65,47.5c0,2.76-2.24,5-5,5H20c-2.76,0-5-2.24-5-5,0-1.87,1.03-3.51,2.56-4.36-.04-.21-.06-.42-.06-.64,0-2.6,2.48-4.74,5.65-4.97,1.65-4.51,6.34-7.76,11.85-7.76.86,0,1.69.08,2.5.23,2.09-1.57,4.69-2.5,7.5-2.5,6.1,0,11.19,4.38,12.28,10.17,2.14.56,3.72,2.51,3.72,4.83,0,.03,0,.07-.01.1,2.29.46,4.01,2.48,4.01,4.9Z',
			paint: 'stroke'
		}
	],
	blank: []
};

/**
 * A service or group icon at (`x`, `y`), `size` px: Mermaid's glyph on its blue square, the
 * icon name on the square for icons from an icon pack (`logos:aws-lambda`), or Mermaid's dashed
 * outline when there is no icon.
 */
function iconMarks(key: string, target: string, icon: string | undefined, x: number, y: number, size: number, theme: DiagramSceneTheme): DiagramMark[] {
	const s = size / 80;
	if (!icon)
		return [
			{
				kind: 'path',
				key: `icon:${key}`,
				role: 'icon',
				target,
				d: placePath('M0,80 V5 Q0,0 5,0 H75 Q80,0 80,5 V80 Z', s, x, y),
				fill: 'none',
				stroke: theme.groupStroke,
				strokeWidth: 2,
				dash: '8'
			}
		];
	const marks: DiagramMark[] = [{ kind: 'rect', key: `icon:${key}`, role: 'icon', target, x, y, width: size, height: size, fill: ICON_BG }];
	const glyph = ARCH_GLYPHS[icon];
	if (glyph) {
		glyph.forEach((part, i) =>
			marks.push({
				kind: 'path',
				key: `icon-glyph:${key}:${i}`,
				role: 'icon-glyph',
				target,
				d: placePath(part.d, s, x, y),
				fill: part.paint === 'stroke' ? 'none' : ICON_FG,
				stroke: part.paint === 'fill' ? undefined : ICON_FG,
				strokeWidth: (part.width ?? 2) * s
			})
		);
		return marks;
	}
	// An icon Mermaid resolves from a registered icon pack: its name, broken to fit the square.
	const font = 11 * s;
	const perLine = Math.max(1, Math.floor((72 * s) / estimateTextWidth('m', font)));
	const lines: string[] = [];
	for (let i = 0; i < icon.length; i += perLine) lines.push(icon.slice(i, i + perLine));
	const shown = lines.slice(0, Math.max(1, Math.floor((72 * s) / (font * 1.2))));
	const lh = font * 1.2;
	shown.forEach((text, i) =>
		marks.push({ kind: 'text', key: `icon-name:${key}:${i}`, role: 'icon-name', target, x: x + size / 2, y: y + size / 2 + (i - (shown.length - 1) / 2) * lh, text, anchor: 'middle', baseline: 'middle', size: font, fill: ICON_FG })
	);
	return marks;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const isJunction = (n: GraphNode) => n.shape === 'sm-circ' || !!n.data?.junction;
const iconOf = (data: Record<string, unknown> | undefined) => (typeof data?.icon === 'string' && data.icon ? data.icon : undefined);

/** Ursula's title node: centred over the top-level items, 56px above the highest one. */
function titleMark(graph: DiagramGraph, layout: DiagramLayout, theme: DiagramSceneTheme): DiagramMark | null {
	if (!graph.title) return null;
	const groupIds = new Set(graph.groups.map((g) => g.id));
	const roots = [...graph.nodes, ...graph.groups].filter((n) => !(n.parentId && groupIds.has(n.parentId)) && layout.positions[n.id] && layout.sizes[n.id]);
	const minX = roots.length ? Math.min(...roots.map((n) => layout.positions[n.id]![0])) : 0;
	const maxX = roots.length ? Math.max(...roots.map((n) => layout.positions[n.id]![0] + layout.sizes[n.id]!.width)) : 240;
	const minY = roots.length ? Math.min(...roots.map((n) => layout.positions[n.id]![1])) : 0;
	return { kind: 'text', key: 'title', role: 'title', target: DIAGRAM_TITLE_TARGET, x: (minX + maxX) / 2, y: minY - 56 + 18, text: graph.title, anchor: 'middle', baseline: 'middle', size: 18, weight: 600, fill: theme.text };
}

/**
 * `architecture-beta` diagrams as Mermaid draws them (Ursula's `canvases/architecture.tsx`):
 * groups as dashed frames with their icon and label at the top-left; services as Mermaid's 80px
 * icon squares (its `cloud`, `database`, `disk`, `internet` and `server` glyphs, the name on
 * the square for icon-pack icons, a dashed outline without an icon) with the label beneath;
 * junctions as points; edges leaving from their port sides as Mermaid's orthogonal lines with
 * triangular heads and the title along the line. Every part of a service, junction, group or
 * edge selects it.
 */
export const architectureScene: FamilyScene = ({ graph, layout, theme }) => {
	const marks: DiagramMark[] = [];
	const box = (id: string) => {
		const p = layout.positions[id];
		const s = layout.sizes[id];
		return p && s ? { x: p[0], y: p[1], width: s.width, height: s.height } : null;
	};

	// Groups, outermost first.
	const groupIds = new Set(graph.groups.map((g) => g.id));
	const parentOf = new Map(graph.groups.map((g) => [g.id, g.parentId]));
	const depth = (id: string) => {
		let d = 0;
		const seen = new Set<string>();
		let p = parentOf.get(id);
		while (p && groupIds.has(p) && !seen.has(p)) {
			seen.add(p);
			d++;
			p = parentOf.get(p);
		}
		return d;
	};
	for (const group of [...graph.groups].sort((a, b) => depth(a.id) - depth(b.id))) {
		const b = box(group.id);
		if (!b) continue;
		const icon = iconOf(group.data);
		marks.push({ kind: 'rect', key: `group:${group.id}`, role: 'group', target: group.id, ...b, fill: 'none', stroke: theme.groupStroke, strokeWidth: 2, dash: '8' });
		if (icon) marks.push(...iconMarks(`group:${group.id}`, group.id, icon, b.x + 1, b.y + 1, A.groupIconSize, theme));
		const label = group.data?.untitled ? '' : group.label;
		if (label)
			marks.push({ kind: 'text', key: `group-label:${group.id}`, role: 'group-label', target: group.id, x: b.x + (icon ? A.groupIconSize + 4 : 4), y: b.y + 7 + 19 / 2, text: label, anchor: 'start', baseline: 'middle', size: A.fontSize, fill: theme.groupText });
	}

	// Edges (under the services); titles go on top.
	const labels: DiagramMark[] = [];
	const junctions = new Set(graph.nodes.filter(isJunction).map((n) => n.id));
	const port = (b: { x: number; y: number; width: number; height: number }, side: ArchSide) =>
		side === 'L' ? { x: b.x, y: b.y + b.height / 2 } : side === 'R' ? { x: b.x + b.width, y: b.y + b.height / 2 } : side === 'T' ? { x: b.x + b.width / 2, y: b.y } : { x: b.x + b.width / 2, y: b.y + b.height };
	for (const edge of graph.edges) {
		const from = box(edge.source);
		const to = box(edge.target);
		if (!from || !to) continue;
		const d = edge.data ?? {};
		const sourceSide: ArchSide = isSide(d.sourceSide) ? d.sourceSide : 'R';
		const targetSide: ArchSide = isSide(d.targetSide) ? d.targetSide : 'L';
		const s = shiftEndpoint(port(from, sourceSide), sourceSide, { group: !!d.sourceGroup, junction: junctions.has(edge.source) });
		const t = shiftEndpoint(port(to, targetSide), targetSide, { group: !!d.targetGroup, junction: junctions.has(edge.target) });
		const route = architectureEdgeRoute(s, sourceSide, t, targetSide);
		marks.push({ kind: 'path', key: `edge:${edge.id}`, role: 'edge', target: edge.id, d: route.points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' '), fill: 'none', stroke: theme.edge, strokeWidth: 3 });
		const head = (key: string, points: string) => marks.push({ kind: 'path', key, role: 'arrow', target: edge.id, d: `M${points.split(' ').join(' L')} Z`, fill: theme.edge });
		if (edge.arrowStart !== 'none') head(`arrow-start:${edge.id}`, architectureArrow(s, sourceSide));
		if (edge.arrowEnd !== 'none') head(`arrow-end:${edge.id}`, architectureArrow(t, targetSide));
		if (edge.label)
			labels.push({ kind: 'text', key: `edge-label:${edge.id}`, role: 'edge-label', target: edge.id, x: route.label.x, y: route.label.y, text: edge.label, anchor: 'middle', baseline: 'middle', size: A.fontSize, rotate: route.rotate || undefined, fill: theme.text });
	}

	// Services and junctions.
	for (const node of graph.nodes) {
		const b = box(node.id);
		if (!b) continue;
		if (isJunction(node)) {
			const cx = b.x + b.width / 2;
			const cy = b.y + b.height / 2;
			// The junction box is clickable; the dot is inset 3px as in Ursula.
			marks.push(
				{ kind: 'circle', key: `junction:${node.id}`, role: 'junction', target: node.id, cx, cy, r: b.width / 2, fill: 'transparent' },
				{ kind: 'circle', key: `junction-dot:${node.id}`, role: 'junction', target: node.id, cx, cy, r: Math.max(1, b.width / 2 - 3), fill: theme.edge }
			);
			continue;
		}
		marks.push(...iconMarks(`service:${node.id}`, node.id, iconOf(node.data), b.x, b.y, b.width, theme));
		if (node.data?.untitled) continue;
		serviceLabelLines(node.label ?? '').forEach((text, i) =>
			marks.push({ kind: 'text', key: `service-label:${node.id}:${i}`, role: 'service-label', target: node.id, x: b.x + b.width / 2, y: b.y + b.height + (i + 0.5) * A.lineHeight, text, anchor: 'middle', baseline: 'middle', size: A.fontSize, fill: theme.text })
		);
	}

	marks.push(...labels);
	const title = titleMark(graph, layout, theme);
	if (title) marks.push(title);
	return marks;
};
