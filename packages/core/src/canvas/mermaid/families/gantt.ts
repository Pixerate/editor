// Follows Ursula's src/react/canvases/gantt.tsx (and its .ursula-gantt__* styles).
import { GANTT_METRICS, ganttGeometry, type GanttRow } from '../../../diagram/gantt/geometry.js';
import type { GraphNode } from '../../../diagram/types.js';
import { DIAGRAM_TITLE_TARGET, sceneColor, type DiagramMark, type DiagramSceneTheme, type FamilyScene } from '../scene-kit.js';

const M = GANTT_METRICS;

/** Mermaid's palette slot for critical tasks and the today line (red in both palettes). */
const CRIT = 3;

type Status = '' | 'done' | 'active' | 'crit' | 'done-crit' | 'active-crit';

function statusOf(node: GraphNode | undefined): Status {
	const tags = Array.isArray(node?.data?.tags) ? (node!.data!.tags as unknown[]).map(String) : [];
	const done = tags.includes('done');
	const active = tags.includes('active');
	const crit = tags.includes('crit');
	if (crit && done) return 'done-crit';
	if (crit && active) return 'active-crit';
	if (crit) return 'crit';
	if (done) return 'done';
	if (active) return 'active';
	return '';
}

/** Bar colours by status, as Mermaid's `taskBkgColor`, `activeTaskBkgColor`, `critBkgColor`… */
function barColours(theme: DiagramSceneTheme, status: Status): { fill: string; stroke: string; text: string } {
	const task = sceneColor(theme, 0);
	const crit = sceneColor(theme, CRIT);
	switch (status) {
		case 'active':
			return { fill: theme.background, stroke: task, text: theme.text };
		case 'done':
			return { fill: theme.grid, stroke: theme.mutedText, text: theme.text };
		case 'crit':
			return { fill: crit, stroke: crit, text: theme.paletteText };
		case 'active-crit':
			return { fill: theme.background, stroke: crit, text: theme.text };
		case 'done-crit':
			return { fill: theme.grid, stroke: crit, text: theme.text };
		default:
			return { fill: task, stroke: task, text: theme.paletteText };
	}
}

/** Section band colours: Mermaid alternates `sectionBkgColor`, `altSectionBkgColor`, `sectionBkgColor2`. */
function bandFill(theme: DiagramSceneTheme, index: number): string {
	const slot = ((index % 4) + 4) % 4;
	if (slot === 1 || slot === 3) return theme.background;
	return sceneColor(theme, slot === 0 ? 0 : 2);
}

/** Ursula's label-fit estimate: labels wider than the bar go to its right. */
const labelWidth = (text: string) => text.length * 6.8 + 16;

/** A right-to-left step connector (React Flow's smooth step, without the rounded corners). */
function stepPath(from: GanttRow, to: GanttRow): string {
	const offset = 12;
	const sx = from.x + from.width;
	const sy = from.y + from.height / 2;
	const tx = to.x;
	const ty = to.y + to.height / 2;
	if (tx >= sx + 2 * offset) {
		const mx = (sx + tx) / 2;
		return `M ${sx} ${sy} L ${mx} ${sy} L ${mx} ${ty} L ${tx} ${ty}`;
	}
	const my = (sy + ty) / 2;
	return `M ${sx} ${sy} L ${sx + offset} ${sy} L ${sx + offset} ${my} L ${tx - offset} ${my} L ${tx - offset} ${ty} L ${tx} ${ty}`;
}

/**
 * Gantt charts as Mermaid draws them (Ursula's `canvases/gantt.tsx`): sections as full-width
 * bands at 20% opacity with their names on the left, grid lines with date ticks along the
 * bottom, the today line, one bar per task coloured by status (`done`, `active`, `crit` and
 * their combinations), milestones as diamonds, and the title centred above. A bar and its label
 * select the task; a band and its name select the section. `after` dependencies are not drawn by
 * Mermaid, so they appear only when they or one of their tasks is selected.
 */
export const ganttScene: FamilyScene = ({ graph, selection, theme }) => {
	const geo = ganttGeometry(graph);
	const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
	const marks: DiagramMark[] = [];
	const left = geo.chartX - M.labelWidth;
	const fullWidth = M.labelWidth + geo.chartWidth + M.rightPadding;

	// Bands (the loose band, for tasks before the first section, draws like section 0).
	for (const band of geo.bands) {
		const key = band.id ?? '::loose';
		marks.push({
			kind: 'rect',
			key: `band:${key}`,
			role: 'section',
			target: band.id,
			x: left,
			y: band.y,
			width: fullWidth,
			height: band.height,
			fill: bandFill(theme, band.id ? band.index : 0),
			opacity: 0.2
		});
		if (band.label !== undefined)
			marks.push({ kind: 'text', key: `section:${key}`, role: 'section-label', target: band.id, x: left + 8, y: band.y + 4, text: band.label, anchor: 'start', baseline: 'top', size: 12, fill: theme.groupText });
	}

	// Grid lines, tick labels and the today line.
	for (const tick of geo.ticks) {
		marks.push(
			{ kind: 'line', key: `tick:${tick.time}`, role: 'grid', x1: tick.x, y1: geo.top, x2: tick.x, y2: geo.bottom, stroke: theme.grid, opacity: 0.8 },
			{ kind: 'text', key: `tick-label:${tick.time}`, role: 'axis', x: tick.x, y: geo.bottom + 6, text: tick.label, anchor: 'middle', baseline: 'top', size: 11, fill: theme.mutedText }
		);
	}
	if (geo.today !== undefined)
		marks.push({ kind: 'line', key: 'today', role: 'today', x1: geo.today, y1: geo.top, x2: geo.today, y2: geo.bottom, stroke: sceneColor(theme, CRIT), strokeWidth: 2 });

	// Dependencies of the selection.
	for (const edge of graph.edges) {
		if (!selection.has(edge.id) && !selection.has(edge.source) && !selection.has(edge.target)) continue;
		const from = geo.rowById.get(edge.source);
		const to = geo.rowById.get(edge.target);
		if (!from || !to) continue;
		marks.push({ kind: 'path', key: `dependency:${edge.id}`, role: 'dependency', target: edge.id, d: stepPath(from, to), stroke: theme.selection, strokeWidth: 1.5, dash: '5 4', markerEnd: 'arrowclosed' });
	}

	// Tasks.
	for (const row of geo.rows) {
		const node = nodes.get(row.id);
		const status = statusOf(node);
		const colours = barColours(theme, status);
		const label = (node?.label ?? row.id).replace(/<br\s*\/?>/gi, ' ');
		if (row.milestone) {
			// A square rotated 45° and scaled to 80%, as Ursula's diamond.
			const cx = row.x + row.width / 2;
			const cy = row.y + row.height / 2;
			const h = (row.width * 0.8 * Math.SQRT2) / 2;
			const crit = status.includes('crit');
			marks.push({
				kind: 'path',
				key: `milestone:${row.id}`,
				role: 'milestone',
				target: row.id,
				d: `M ${cx} ${cy - h} L ${cx + h} ${cy} L ${cx} ${cy + h} L ${cx - h} ${cy} Z`,
				fill: status.startsWith('done') ? theme.grid : sceneColor(theme, 0),
				stroke: crit ? sceneColor(theme, CRIT) : status.startsWith('done') ? theme.mutedText : sceneColor(theme, 0),
				strokeWidth: 2
			});
		} else {
			marks.push({ kind: 'rect', key: `bar:${row.id}`, role: 'bar', target: row.id, x: row.x, y: row.y, width: row.width, height: row.height, fill: colours.fill, stroke: colours.stroke, strokeWidth: 2, radius: 3 });
		}
		const outside = row.milestone || labelWidth(label) > row.width;
		marks.push({
			kind: 'text',
			key: `label:${row.id}`,
			role: 'task-label',
			target: row.id,
			x: outside ? row.x + row.width + 6 : row.x + row.width / 2,
			y: row.y + row.height / 2,
			text: label,
			anchor: outside ? 'start' : 'middle',
			baseline: 'middle',
			size: 12,
			fill: outside ? theme.text : colours.text,
			...(row.milestone ? { italic: true } : {})
		});
	}

	// Title, centred above everything (Ursula's generic title node: 56px above the top).
	if (graph.title)
		marks.push({ kind: 'text', key: 'title', role: 'title', target: DIAGRAM_TITLE_TARGET, x: left + fullWidth / 2, y: geo.top - 38, text: graph.title, anchor: 'middle', baseline: 'middle', size: 18, weight: 600, fill: theme.text });
	return marks;
};
