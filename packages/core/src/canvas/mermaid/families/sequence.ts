// Follows Ursula's src/react/canvases/sequence.tsx (and its .ursula-seq__* styles).
import { SEQUENCE_METRICS, sequenceGeometry } from '../../../diagram/sequence/geometry.js';
import type { ArrowHead, EdgePattern, GraphEdge } from '../../../diagram/types.js';
import { DIAGRAM_TITLE_TARGET, estimateTextWidth, sceneColor, type DiagramMark, type DiagramSceneTheme, type FamilyScene } from '../scene-kit.js';

const M = SEQUENCE_METRICS;
/** Participant, note and message text (Ursula caps them at 14px). */
const LABEL_SIZE = 14;
const LINE_HEIGHT = 1.25;
/** Fragment tabs, fragment conditions. */
const SMALL_SIZE = 13;
const TITLE_SIZE = 18;
/** Palette slot of Mermaid's yellow note colour. */
const NOTE_COLOR = 5;

/** Label text as Ursula shows it (`displayLabel`): backticks dropped, `<br>` as new lines, entities decoded. */
function displayLines(label: string): string[] {
	let text = label;
	if (text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1);
	return text
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/#quot;/g, '"')
		.replace(/#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
		.split('\n');
}

function dashFor(pattern: EdgePattern): string | undefined {
	return pattern === 'dotted' ? '6 4' : pattern === 'invisible' ? '0 1' : undefined;
}

/** Arrow heads the mark contract draws: `->>` filled, `-)` open; crosses are drawn separately. */
function markerFor(head: ArrowHead): 'arrow' | 'arrowclosed' | undefined {
	if (head === 'none' || head === 'arrow_cross') return undefined;
	return head === 'arrow_open' ? 'arrow' : 'arrowclosed';
}

/** Lines of text centred on (x, cy), one mark per line. */
function textLines(
	lines: string[],
	base: { key: string; role: string; target?: string; x: number; cy: number; size: number; fill: string; weight?: number; anchor?: 'start' | 'middle' | 'end' }
): DiagramMark[] {
	const lh = base.size * LINE_HEIGHT;
	const top = base.cy - ((lines.length - 1) * lh) / 2;
	return lines.map((text, i) => ({
		kind: 'text',
		key: lines.length === 1 ? base.key : `${base.key}:${i}`,
		role: base.role,
		...(base.target ? { target: base.target } : {}),
		x: base.x,
		y: top + i * lh,
		text,
		anchor: base.anchor ?? 'middle',
		baseline: 'middle',
		size: base.size,
		fill: base.fill,
		...(base.weight ? { weight: base.weight } : {})
	}));
}

/** A participant box (or stick figure for `actor`) with its name; `mirror` is the copy under the lifelines. */
function participantMarks(
	node: { id: string; label: string; shape: string },
	box: { x: number; y: number; width: number; height: number },
	mirror: boolean,
	theme: DiagramSceneTheme
): DiagramMark[] {
	const prefix = mirror ? 'mirror' : 'participant';
	const role = mirror ? 'participant-mirror' : 'participant';
	const lines = displayLines(node.label || node.id);
	if (node.shape !== 'actor') {
		return [
			{ kind: 'rect', key: `${prefix}:${node.id}`, role, target: node.id, ...box, fill: theme.nodeFill, stroke: theme.nodeStroke, strokeWidth: 1, radius: 3 },
			...textLines(lines, { key: `${prefix}-label:${node.id}`, role: `${role}-label`, target: node.id, x: box.x + box.width / 2, cy: box.y + box.height / 2, size: LABEL_SIZE, fill: theme.text })
		];
	}
	// Actor: a 28×34 figure (viewBox 40×46, scaled to fit) over the name, bottom-aligned with a 2px gap.
	const lh = LABEL_SIZE * LINE_HEIGHT;
	const labelHeight = lines.length * lh;
	const scale = Math.min(28 / 40, 34 / 46);
	const figTop = box.y + box.height - labelHeight - 2 - 34 + (34 - 46 * scale) / 2;
	const figLeft = box.x + box.width / 2 - 20 * scale;
	const fx = (v: number) => figLeft + v * scale;
	const fy = (v: number) => figTop + v * scale;
	const d = `M${fx(20)},${fy(15)} V${fy(31)} M${fx(6)},${fy(21)} H${fx(34)} M${fx(20)},${fy(31)} L${fx(9)},${fy(44)} M${fx(20)},${fy(31)} L${fx(31)},${fy(44)}`;
	return [
		{ kind: 'circle', key: `${prefix}-head:${node.id}`, role: `${role}-figure`, target: node.id, cx: fx(20), cy: fy(8), r: 7 * scale, fill: theme.nodeFill, stroke: theme.nodeStroke, strokeWidth: 1.5 },
		{
			kind: 'path',
			key: `${prefix}-body:${node.id}`,
			role: `${role}-figure`,
			target: node.id,
			d,
			fill: 'none',
			stroke: theme.nodeStroke,
			strokeWidth: 1.5,
			box: { x: fx(6), y: fy(15), width: 28 * scale, height: 29 * scale }
		},
		...textLines(lines, {
			key: `${prefix}-label:${node.id}`,
			role: `${role}-label`,
			target: node.id,
			x: box.x + box.width / 2,
			cy: box.y + box.height - labelHeight / 2,
			size: LABEL_SIZE,
			fill: theme.text
		})
	];
}

/** Mermaid's `x` head: a cross at the end of a message heading in direction `dir` (±1). */
function crossMark(key: string, target: string, x: number, y: number, dir: number, stroke: string): DiagramMark {
	const cx = x - dir * 2.8;
	const h = 2.8;
	return {
		kind: 'path',
		key,
		role: 'message-head',
		target,
		d: `M${cx - h},${y - h} L${cx + h},${y + h} M${cx + h},${y - h} L${cx - h},${y + h}`,
		stroke,
		strokeWidth: 1.5
	};
}

/**
 * Sequence diagrams as Mermaid draws them (Ursula's `canvases/sequence.tsx`): participants in
 * a row, mirrored under the lifelines, one horizontal message per row with its label and
 * (with `autonumber`) a numbered dot, notes, `alt`/`loop` fragment frames with their
 * dividers, activation bars and coloured boxes. Participants, their lifelines and mirrors
 * select the participant; a message's line, head, number and label select the message; a
 * box's frame selects its group.
 */
export const sequenceScene: FamilyScene = ({ graph, theme }) => {
	const geo = sequenceGeometry(graph);
	const marks: DiagramMark[] = [];

	// Boxes (groups), behind everything.
	for (const group of graph.groups) {
		const box = geo.boxes.get(group.id);
		if (!box) continue;
		const color = typeof group.data?.color === 'string' ? group.data.color : undefined;
		marks.push(
			{ kind: 'rect', key: `box:${group.id}`, role: 'box', target: group.id, ...box, fill: color ?? 'none', stroke: theme.groupStroke, strokeWidth: 1 },
			...textLines(displayLines(group.label), {
				key: `box-label:${group.id}`,
				role: 'box-label',
				target: group.id,
				x: box.x + box.width / 2,
				cy: box.y + 4 + (LABEL_SIZE * LINE_HEIGHT) / 2,
				size: LABEL_SIZE,
				weight: 600,
				fill: theme.groupText
			})
		);
	}

	// Title, centred over the participants and boxes (Ursula's title node: 56px above them).
	if (graph.title) {
		const lefts = [...[...geo.columns.values()].map((c) => c.x), ...[...geo.boxes.values()].map((b) => b.x)];
		const rights = [...[...geo.columns.values()].map((c) => c.x + c.width), ...[...geo.boxes.values()].map((b) => b.x + b.width)];
		const tops = [0, ...[...geo.boxes.values()].map((b) => b.y)];
		const minX = lefts.length ? Math.min(...lefts) : 0;
		const maxX = rights.length ? Math.max(...rights) : 240;
		marks.push({ kind: 'text', key: 'title', role: 'title', target: DIAGRAM_TITLE_TARGET, x: (minX + maxX) / 2, y: Math.min(...tops) - 38, text: graph.title, anchor: 'middle', baseline: 'middle', size: TITLE_SIZE, weight: 600, fill: theme.text });
	}

	// Fragments (`alt`, `loop`…): frame, keyword tab, condition and dashed dividers; outer ones first.
	[...geo.fragments]
		.map((f, i) => ({ f, i }))
		.sort((a, b) => a.f.depth - b.f.depth || a.i - b.i)
		.forEach(({ f, i }) => {
			marks.push({ kind: 'rect', key: `fragment:${i}`, role: 'fragment', x: f.x, y: f.y, width: f.width, height: f.height, fill: 'none', stroke: theme.mutedText, strokeWidth: 1.5 });
			const tabW = estimateTextWidth(f.keyword, SMALL_SIZE) + 22;
			const tabH = SMALL_SIZE * LINE_HEIGHT + 4;
			marks.push(
				{
					kind: 'path',
					key: `fragment-tab:${i}`,
					role: 'fragment-tab',
					d: `M${f.x},${f.y} H${f.x + tabW} V${f.y + tabH * 0.6} L${f.x + tabW - 8},${f.y + tabH} H${f.x} Z`,
					fill: theme.groupFill,
					stroke: theme.mutedText,
					strokeWidth: 1.5
				},
				{ kind: 'text', key: `fragment-keyword:${i}`, role: 'fragment-keyword', x: f.x + 8, y: f.y + tabH / 2, text: f.keyword, anchor: 'start', baseline: 'middle', size: SMALL_SIZE, weight: 600, fill: theme.groupText }
			);
			if (f.text)
				marks.push({ kind: 'text', key: `fragment-text:${i}`, role: 'fragment-text', x: f.x + f.width / 2, y: f.y + 3, text: `[${f.text}]`, anchor: 'middle', baseline: 'top', size: SMALL_SIZE, weight: 600, fill: theme.text });
			f.dividers.forEach((d, j) => {
				marks.push({ kind: 'line', key: `fragment-divider:${i}:${j}`, role: 'fragment-divider', x1: f.x, y1: d.y, x2: f.x + f.width, y2: d.y, stroke: theme.mutedText, strokeWidth: 1.5, dash: '6 4' });
				if (d.text)
					marks.push({ kind: 'text', key: `fragment-divider-text:${i}:${j}`, role: 'fragment-text', x: f.x + f.width / 2, y: d.y + 3, text: `[${d.text}]`, anchor: 'middle', baseline: 'top', size: SMALL_SIZE, weight: 600, fill: theme.text });
			});
		});

	// Lifelines.
	for (const col of geo.columns.values())
		marks.push({ kind: 'line', key: `lifeline:${col.id}`, role: 'lifeline', target: col.id, x1: col.center, y1: geo.lifelineTop, x2: col.center, y2: geo.lifelineBottom, stroke: theme.grid, strokeWidth: 1 });

	// Activation bars.
	geo.activations.forEach((a, i) =>
		marks.push({ kind: 'rect', key: `activation:${i}`, role: 'activation', x: a.x, y: a.top, width: M.activationWidth, height: Math.max(8, a.bottom - a.top), fill: theme.groupFill, stroke: theme.edge, strokeWidth: 1 })
	);

	// Participants, top and mirrored at the bottom.
	for (const node of graph.nodes) {
		const col = geo.columns.get(node.id);
		if (!col) continue;
		marks.push(...participantMarks(node, { x: col.x, y: 0, width: col.width, height: M.actorHeight }, false, theme));
		marks.push(...participantMarks(node, { x: col.x, y: geo.lifelineBottom, width: col.width, height: M.actorHeight }, true, theme));
	}

	// Notes: a tinted box (fill and outline drawn apart so the tint does not fade the border).
	const noteColor = sceneColor(theme, NOTE_COLOR);
	geo.notes.forEach((n, i) => {
		const box = { x: n.x, y: n.y, width: n.width, height: n.height };
		marks.push(
			{ kind: 'rect', key: `note-bg:${i}`, role: 'note', ...box, fill: theme.background },
			{ kind: 'rect', key: `note-fill:${i}`, role: 'note', ...box, fill: noteColor, opacity: 0.3 },
			{ kind: 'rect', key: `note:${i}`, role: 'note', ...box, fill: 'none', stroke: noteColor, strokeWidth: 1 },
			...textLines(displayLines(n.text), { key: `note-text:${i}`, role: 'note-text', x: n.x + n.width / 2, cy: n.y + n.height / 2, size: LABEL_SIZE, fill: theme.text })
		);
	});

	// Messages, above everything else.
	const edges = new Map<string, GraphEdge>(graph.edges.map((e) => [e.id, e]));
	const autonumber = !!graph.data?.autonumber;
	geo.messages.forEach((row, index) => {
		const edge = edges.get(row.edgeId);
		if (!edge) return;
		const x1 = geo.columns.get(edge.source)?.center ?? 0;
		const x2 = geo.columns.get(edge.target)?.center ?? 0;
		const y = row.y;
		const stroke = theme.edge;
		const strokeWidth = edge.pattern === 'thick' ? 3.5 : 1.5;
		const dash = dashFor(edge.pattern);
		const markerEnd = markerFor(edge.arrowEnd);
		const markerStart = markerFor(edge.arrowStart);
		const heads = { ...(markerEnd ? { markerEnd } : {}), ...(markerStart ? { markerStart } : {}) };
		let endX: number;
		let endDir: number;
		let startDir: number;
		let endY = y;
		let startY = y;
		if (row.self) {
			endX = x1 + 4;
			endDir = -1;
			startDir = -1;
			endY = y + 10;
			startY = y - 10;
			marks.push({
				kind: 'path',
				key: `message:${edge.id}`,
				role: 'message',
				target: edge.id,
				d: `M${x1},${y - 10} H${x1 + 44} V${y + 10} H${x1 + 4}`,
				fill: 'none',
				stroke,
				strokeWidth,
				...(dash ? { dash } : {}),
				...heads,
				box: { x: x1, y: y - 10, width: 44, height: 20 }
			});
		} else {
			endX = x2 + (x2 > x1 ? -2 : 2);
			endDir = x2 >= x1 ? 1 : -1;
			startDir = -endDir;
			marks.push({ kind: 'line', key: `message:${edge.id}`, role: 'message', target: edge.id, x1, y1: y, x2: endX, y2: y, stroke, strokeWidth, ...(dash ? { dash } : {}), ...heads });
		}
		if (edge.arrowEnd === 'arrow_cross') marks.push(crossMark(`message-cross-end:${edge.id}`, edge.id, endX, endY, endDir, stroke));
		if (edge.arrowStart === 'arrow_cross') marks.push(crossMark(`message-cross-start:${edge.id}`, edge.id, x1, startY, startDir, stroke));
		if (autonumber)
			marks.push(
				{ kind: 'circle', key: `number-dot:${edge.id}`, role: 'message-number', target: edge.id, cx: x1, cy: y, r: 10, fill: stroke },
				{ kind: 'text', key: `number:${edge.id}`, role: 'message-number', target: edge.id, x: x1, y, text: String(index + 1), anchor: 'middle', baseline: 'middle', size: 11, weight: 600, fill: theme.background }
			);
		const label = edge.label ? displayLines(edge.label).join(' ') : '';
		if (label)
			marks.push({
				kind: 'text',
				key: `message-label:${edge.id}`,
				role: 'message-label',
				target: edge.id,
				x: row.self ? x1 + 52 + 4 : (x1 + x2) / 2,
				y: row.self ? y - 18 : y - 13,
				text: label,
				anchor: row.self ? 'start' : 'middle',
				baseline: 'middle',
				size: LABEL_SIZE,
				fill: theme.text
			});
	});
	return marks;
};
