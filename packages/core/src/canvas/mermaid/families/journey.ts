// Follows Ursula's src/react/canvases/journey.tsx.
import { JOURNEY_METRICS, journeyGeometry } from '../../../diagram/journey/geometry.js';
import { DIAGRAM_TITLE_TARGET, estimateTextWidth, sceneColor, type DiagramMark, type DiagramSceneTheme, type FamilyScene } from '../scene-kit.js';

const M = JOURNEY_METRICS;
/** Mermaid's journey title is bold 4ex. */
const TITLE_SIZE = 32;

/** Actor colours follow the section colours in the palette, so a dot reads on its task. */
function actorColor(theme: DiagramSceneTheme, slot: number): string {
	return sceneColor(theme, M.sectionColours + slot);
}

/** Splits `text` (explicit `<br>` / newlines first) into lines no wider than `max` px. */
function wrapLines(text: string, size: number, max: number): string[] {
	const lines: string[] = [];
	for (const para of text.replace(/<br\s*\/?>/gi, '\n').split('\n')) {
		let line = '';
		for (const word of para.split(/\s+/).filter(Boolean)) {
			const next = line ? `${line} ${word}` : word;
			if (line && estimateTextWidth(next, size) > max) {
				lines.push(line);
				line = word;
			} else line = next;
		}
		lines.push(line);
	}
	return lines;
}

/** Centred, wrapped label marks inside a box (smaller text when it needs more than two lines). */
function boxLabel(
	key: string,
	role: string,
	target: string,
	text: string,
	box: { x: number; y: number; width: number; height: number },
	fill: string
): DiagramMark[] {
	let size: number = M.fontSize;
	let lines = wrapLines(text, size, box.width - 10);
	if (lines.length > 2) {
		size = 13;
		lines = wrapLines(text, size, box.width - 8);
	}
	const lineHeight = size * 1.15;
	const max = Math.max(1, Math.floor(box.height / lineHeight));
	if (lines.length > max) lines = [...lines.slice(0, max - 1), `${lines[max - 1]}…`];
	const top = box.y + box.height / 2 - (lines.length * lineHeight) / 2 + lineHeight / 2;
	return lines.map((line, i) => ({
		kind: 'text',
		key: `${key}:${i}`,
		role,
		target,
		x: box.x + box.width / 2,
		y: top + i * lineHeight,
		text: line,
		anchor: 'middle',
		baseline: 'middle',
		size,
		fill
	}));
}

/**
 * User journeys as Mermaid draws them (Ursula's `canvases/journey.tsx`): the title, a dashed
 * line down from every task to its face (higher score = higher face), the thick axis, the
 * actor legend on the left, section bars on top and the task boxes with their actor dots.
 * Tasks, their dots and faces select the task; a section bar selects its section.
 */
export const journeyScene: FamilyScene = ({ graph, theme }) => {
	const geo = journeyGeometry(graph);
	const marks: DiagramMark[] = [];
	const ink = theme.mutedText;

	if (graph.title)
		marks.push({
			kind: 'text',
			key: 'title',
			role: 'title',
			target: DIAGRAM_TITLE_TARGET,
			x: geo.title.x,
			y: geo.title.baseline + 7,
			text: graph.title,
			anchor: 'start',
			baseline: 'bottom',
			size: TITLE_SIZE,
			weight: 700,
			fill: theme.text
		});

	// Mermaid draws the dashed line from the task's top to y = 450; the box covers its top.
	for (const t of geo.tasks.values())
		marks.push({ kind: 'line', key: `task-line:${t.id}`, role: 'task-line', x1: t.face.x, y1: t.y, x2: t.face.x, y2: M.lineBottom, stroke: theme.grid, strokeWidth: 1, dash: '4 2' });

	marks.push({
		kind: 'line',
		key: 'axis',
		role: 'axis',
		x1: geo.axis.x1,
		y1: geo.axis.y,
		x2: geo.axis.x2,
		y2: geo.axis.y,
		stroke: theme.edge,
		strokeWidth: M.axisWidth,
		markerEnd: 'arrowclosed'
	});

	for (const l of geo.legend)
		marks.push(
			{ kind: 'circle', key: `legend-dot:${l.name}`, role: 'legend', cx: l.x, cy: l.y, r: M.actorRadius, fill: actorColor(theme, l.colour), stroke: theme.nodeStroke, strokeWidth: 1 },
			{ kind: 'text', key: `legend:${l.name}`, role: 'legend', x: l.labelX, y: l.y, text: l.name, anchor: 'start', baseline: 'middle', size: M.fontSize, fill: theme.text }
		);

	// Faces (Mermaid's `drawFace`): r = 15, eyes at ±r/3, mouth by score.
	for (const t of geo.tasks.values()) {
		const { x, y } = t.face;
		const r = M.faceRadius;
		marks.push(
			{ kind: 'circle', key: `face:${t.id}`, role: 'face', target: t.id, cx: x, cy: y, r, fill: theme.nodeFill, stroke: ink, strokeWidth: 2 },
			{ kind: 'circle', key: `eye-l:${t.id}`, role: 'face-eye', cx: x - r / 3, cy: y - r / 3, r: 1.5, fill: ink, stroke: ink, strokeWidth: 2 },
			{ kind: 'circle', key: `eye-r:${t.id}`, role: 'face-eye', cx: x + r / 3, cy: y - r / 3, r: 1.5, fill: ink, stroke: ink, strokeWidth: 2 }
		);
		if (t.score > 3)
			// Lower half circle centred 2px below the middle.
			marks.push({ kind: 'path', key: `mouth:${t.id}`, role: 'face-mouth', d: `M${x + 7},${y + 2} A7,7 0 0 1 ${x - 7},${y + 2}`, fill: 'none', stroke: ink, strokeWidth: 1, box: { x: x - 7, y: y + 2, width: 14, height: 7 } });
		else if (t.score < 3)
			// Upper half circle centred 7px below the middle.
			marks.push({ kind: 'path', key: `mouth:${t.id}`, role: 'face-mouth', d: `M${x - 7},${y + 7} A7,7 0 0 1 ${x + 7},${y + 7}`, fill: 'none', stroke: ink, strokeWidth: 1, box: { x: x - 7, y, width: 14, height: 7 } });
		else marks.push({ kind: 'line', key: `mouth:${t.id}`, role: 'face-mouth', x1: x - 5, y1: y + 7, x2: x + 5, y2: y + 7, stroke: ink, strokeWidth: 1 });
	}

	for (const group of graph.groups) {
		const s = geo.sections.get(group.id);
		if (!s) continue;
		marks.push({
			kind: 'rect',
			key: `section:${s.id}`,
			role: 'section',
			target: s.id,
			x: s.x,
			y: s.y,
			width: s.width,
			height: s.height,
			fill: sceneColor(theme, s.colour),
			stroke: theme.nodeStroke,
			strokeWidth: 1,
			radius: 3,
			// Mermaid draws no bar for an empty section; it is parked after the tasks, faded.
			...(s.empty ? { dash: '4 3', opacity: 0.6 } : {})
		});
		marks.push(...boxLabel(`section-label:${s.id}`, 'section-label', s.id, group.label, s, theme.paletteText).map((m) => (s.empty ? { ...m, opacity: 0.6 } : m)));
	}

	for (const node of graph.nodes) {
		const t = geo.tasks.get(node.id);
		if (!t) continue;
		marks.push({
			kind: 'rect',
			key: `task:${t.id}`,
			role: 'task',
			target: t.id,
			x: t.x,
			y: t.y,
			width: t.width,
			height: t.height,
			fill: sceneColor(theme, t.colour),
			stroke: theme.nodeStroke,
			strokeWidth: 1,
			radius: 3
		});
		marks.push(...boxLabel(`task-label:${t.id}`, 'task-label', t.id, node.label ?? node.id, t, theme.paletteText));
		for (const a of t.actors)
			marks.push({ kind: 'circle', key: `actor:${t.id}:${a.name}`, role: 'actor', target: t.id, cx: a.x, cy: a.y, r: M.actorRadius, fill: actorColor(theme, a.colour), stroke: theme.nodeStroke, strokeWidth: 1 });
	}
	return marks;
};
