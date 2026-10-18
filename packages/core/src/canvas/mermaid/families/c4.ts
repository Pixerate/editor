// Follows Ursula's src/react/canvases/c4.tsx (and the title node of src/react/canvas/Canvas.tsx).
import type { DiagramGraph } from '../../../diagram/types.js';
import { c4ArrowHead, c4BoundaryText, c4ElementGeometry, c4RelGeometry, type C4ElementType } from '../../../diagram/c4/geometry.js';
import type { DiagramLayout } from '../layout.js';
import { DIAGRAM_TITLE_TARGET, estimateTextWidth, type DiagramMark, type DiagramSceneTheme, type FamilyScene } from '../scene-kit.js';

/** Mermaid's C4 element colours (`config.c4` `*_bg_color` / `*_border_color`), as Ursula hardcodes them. */
const C4_COLORS: Record<string, { bg: string; border: string }> = {
	person: { bg: '#08427b', border: '#073b6f' },
	system: { bg: '#1168bd', border: '#3c7fc0' },
	container: { bg: '#438dd5', border: '#3c7fc0' },
	component: { bg: '#85bbf0', border: '#78a8d8' },
	external_person: { bg: '#686868', border: '#8a8a8a' },
	external_system: { bg: '#999999', border: '#8a8a8a' },
	external_container: { bg: '#b3b3b3', border: '#a6a6a6' },
	external_component: { bg: '#cccccc', border: '#bfbfbf' }
};
const C4_ELEMENT_FG = '#ffffff';

const NAME_SIZE = 14;
const TYPE_SIZE = 10.5;
const DESCR_SIZE = 11.48;
const LINE_HEIGHT = 1.15;
const SECTION_GAP = 3;
const REL_FONT = 12;
const REL_LINE = 14;
const REL_GAP = 3;

function colorsOf(type: C4ElementType): { bg: string; border: string } {
	return C4_COLORS[`${type.external ? 'external_' : ''}${type.base}`] ?? C4_COLORS.container!;
}

const styleOf = (data: Record<string, unknown> | undefined): Record<string, string> => (data?.c4Style ?? {}) as Record<string, string>;

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
 * C4 diagrams as Mermaid's C4 renderer draws them (Ursula's `canvases/c4.tsx`): boundaries as
 * dashed frames (deployment nodes solid) with the label, `[type]` and description centred at
 * the top; people as a head over a rounded body, systems, containers and components as rounded
 * rectangles, `*Db` as cylinders and `*Queue` as horizontal cylinders, in Mermaid's C4 colours
 * (`_Ext` grey, `UpdateElementStyle` overrides) with the bold name, the `[Type: technology]` line
 * and the description; relations as thin lines (the first straight, the rest Mermaid's curves)
 * with filled heads and the label and `[technology]` at the midpoint (numbered in `C4Dynamic`).
 * Every part of an element, boundary or relation selects it.
 */
export const c4Scene: FamilyScene = ({ graph, layout, theme }) => {
	const marks: DiagramMark[] = [];
	const box = (id: string) => {
		const p = layout.positions[id];
		const s = layout.sizes[id];
		return p && s ? { x: p[0], y: p[1], width: s.width, height: s.height } : null;
	};

	// Boundaries, outermost first.
	const groupIds = new Set(graph.groups.map((g) => g.id));
	const depth = (id: string) => {
		let d = 0;
		const seen = new Set<string>();
		let p = graph.groups.find((g) => g.id === id)?.parentId;
		while (p && groupIds.has(p) && !seen.has(p)) {
			seen.add(p);
			d++;
			p = graph.groups.find((g) => g.id === p)?.parentId;
		}
		return d;
	};
	for (const group of [...graph.groups].sort((a, b) => depth(a.id) - depth(b.id))) {
		const b = box(group.id);
		if (!b) continue;
		const text = c4BoundaryText(group);
		const cx = b.x + b.width / 2;
		marks.push({ kind: 'rect', key: `boundary:${group.id}`, role: 'boundary', target: group.id, ...b, radius: 2.5, fill: 'none', stroke: theme.groupStroke, strokeWidth: 1, dash: text.solid ? undefined : '7 7' });
		marks.push({ kind: 'text', key: `boundary-label:${group.id}`, role: 'boundary-label', target: group.id, x: cx, y: b.y + text.labelY, text: text.label, anchor: 'middle', baseline: 'middle', size: 16, weight: 700, fill: theme.groupText });
		marks.push({ kind: 'text', key: `boundary-type:${group.id}`, role: 'boundary-type', target: group.id, x: cx, y: b.y + text.typeY, text: text.type, anchor: 'middle', baseline: 'middle', size: 14, fill: theme.groupText });
		if (text.descr && text.descrY !== undefined)
			marks.push({ kind: 'text', key: `boundary-descr:${group.id}`, role: 'boundary-descr', target: group.id, x: cx, y: b.y + text.descrY, text: text.descr, anchor: 'middle', baseline: 'middle', size: 12, fill: theme.groupText });
	}

	// Relation lines and heads (under the elements); their labels go on top, as in Mermaid.
	const labels: DiagramMark[] = [];
	const dynamic = graph.data?.c4Type === 'C4Dynamic';
	graph.edges.forEach((edge, index) => {
		const from = box(edge.source);
		const to = box(edge.target);
		if (!from || !to) return;
		const geo = c4RelGeometry(from, to, index);
		const { start, end, control } = geo;
		const style = styleOf(edge.data);
		const line = style.lineColor || theme.edge;
		marks.push({
			kind: 'path',
			key: `relation:${edge.id}`,
			role: 'relation',
			target: edge.id,
			d: control ? `M${start.x},${start.y} Q${control.x},${control.y} ${end.x},${end.y}` : `M${start.x},${start.y} L${end.x},${end.y}`,
			fill: 'none',
			stroke: line,
			strokeWidth: 1
		});
		const head = (key: string, points: string) =>
			marks.push({ kind: 'path', key, role: 'arrow', target: edge.id, d: `M${points.split(' ').join(' L')} Z`, fill: line });
		if (edge.arrowEnd !== 'none') head(`arrow-end:${edge.id}`, c4ArrowHead(end, control ?? start));
		if (edge.arrowStart !== 'none') head(`arrow-start:${edge.id}`, c4ArrowHead(start, control ?? end));

		const offsetX = parseInt(style.offsetX ?? '0', 10) || 0;
		const offsetY = parseInt(style.offsetY ?? '0', 10) || 0;
		const left = geo.label.x + offsetX;
		const top = geo.label.y + offsetY - 7;
		const textFill = style.textColor || theme.text;
		const label = `${dynamic ? `${index + 1}: ` : ''}${edge.label ?? ''}`;
		const tech = typeof edge.data?.tech === 'string' && edge.data.tech ? `[${edge.data.tech}]` : '';
		const gridWidth = Math.max(label ? estimateTextWidth(label, REL_FONT) : 0, tech ? estimateTextWidth(tech, REL_FONT) : 0);
		if (label)
			labels.push({ kind: 'text', key: `relation-label:${edge.id}`, role: 'relation-label', target: edge.id, x: left, y: top + REL_LINE / 2, text: label, anchor: 'start', baseline: 'middle', size: REL_FONT, fill: textFill });
		if (tech)
			labels.push({
				kind: 'text',
				key: `relation-tech:${edge.id}`,
				role: 'relation-tech',
				target: edge.id,
				x: left + gridWidth / 2,
				y: top + (label ? REL_LINE + REL_GAP : 0) + REL_LINE / 2,
				text: tech,
				anchor: 'middle',
				baseline: 'middle',
				size: REL_FONT,
				italic: true,
				fill: style.textColor || theme.mutedText
			});
	});

	// Elements.
	for (const node of graph.nodes) {
		const b = box(node.id);
		if (!b) continue;
		const geo = c4ElementGeometry(node);
		const style = styleOf(node.data);
		const colors = colorsOf(geo.type);
		const fill = style.bgColor || colors.bg;
		const stroke = style.borderColor || colors.border;
		const fg = style.fontColor || C4_ELEMENT_FG;
		const { x, y } = b;
		const w = geo.width;
		const h = geo.height;
		const common = { target: node.id, fill, stroke, strokeWidth: 2 };
		if (geo.person) {
			const { headRadius: r, bodyTop, bodyRadius } = geo.person;
			marks.push(
				{ kind: 'rect', key: `element:${node.id}`, role: 'element', ...common, x, y: y + bodyTop, width: w, height: h - bodyTop, radius: bodyRadius },
				{ kind: 'circle', key: `element-head:${node.id}`, role: 'element', ...common, cx: x + w / 2, cy: y + r, r }
			);
		} else if (geo.shape === 'cylinder' && geo.cylinder) {
			const { rx, ry } = geo.cylinder;
			const body = h - 2 * ry;
			marks.push({
				kind: 'path',
				key: `element:${node.id}`,
				role: 'element',
				...common,
				d: `M${x},${y + ry} a${rx},${ry} 0,0,0 ${w},0 a${rx},${ry} 0,0,0 ${-w},0 l0,${body} a${rx},${ry} 0,0,0 ${w},0 l0,${-body}`,
				box: { x, y, width: w, height: h }
			});
		} else if (geo.shape === 'h-cyl' && geo.cylinder) {
			const { rx, ry } = geo.cylinder;
			const body = w - 2 * rx;
			marks.push({
				kind: 'path',
				key: `element:${node.id}`,
				role: 'element',
				...common,
				d: `M${x + rx},${y + h} a${rx},${ry} 0,0,1 0,${-h} l${body},0 a${rx},${ry} 0,0,1 0,${h} M${x + rx + body},${y} a${rx},${ry} 0,0,0 0,${h} l${-body},0`,
				box: { x, y, width: w, height: h }
			});
		} else marks.push({ kind: 'rect', key: `element:${node.id}`, role: 'element', ...common, x, y, width: w, height: h, radius: 12 });

		// Text: the sections stacked around the text centre, each line centred.
		let top = y + geo.textCenter.y - geo.textHeight / 2;
		for (const section of geo.sections) {
			const size = section.part === 'label' ? NAME_SIZE : section.part === 'tech' ? TYPE_SIZE : DESCR_SIZE;
			const lh = section.fontSize * LINE_HEIGHT;
			section.lines.forEach((line, i) => {
				if (!line) return;
				marks.push({
					kind: 'text',
					key: `element-${section.part}:${node.id}:${i}`,
					role: section.part === 'label' ? 'element-name' : section.part === 'tech' ? 'element-type' : 'element-descr',
					target: node.id,
					x: x + geo.textCenter.x,
					y: top + (i + 0.5) * lh,
					text: line,
					anchor: 'middle',
					baseline: 'middle',
					size,
					weight: section.bold ? 700 : undefined,
					fill: fg
				});
			});
			top += section.height + SECTION_GAP;
		}
	}

	marks.push(...labels);
	const title = titleMark(graph, layout, theme);
	if (title) marks.push(title);
	return marks;
};
