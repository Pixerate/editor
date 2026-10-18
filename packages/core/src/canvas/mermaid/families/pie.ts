import { PIE_METRICS, pieGeometry } from '../../../diagram/pie/geometry.js';
import { DIAGRAM_TITLE_TARGET, sceneColor, type DiagramMark, type FamilyScene } from '../scene-kit.js';

const M = PIE_METRICS;

/**
 * Pie charts as Mermaid draws them (Ursula's `canvases/pie.tsx`): wedges in document order
 * with a percentage on each, the outer circle, the legend to the right and the title above.
 * A wedge and its legend row select the slice.
 */
export const pieScene: FamilyScene = ({ graph, theme }) => {
	const geo = pieGeometry(graph);
	const marks: DiagramMark[] = [];
	for (const slice of geo.slices) {
		if (!slice.drawn) continue;
		const r = geo.radius;
		marks.push({
			kind: 'path',
			key: `wedge:${slice.id}`,
			role: 'slice',
			target: slice.id,
			d: slice.path,
			fill: sceneColor(theme, slice.colorIndex),
			stroke: theme.background,
			strokeWidth: 2,
			box: { x: geo.cx - r, y: geo.cy - r, width: r * 2, height: r * 2 }
		});
	}
	marks.push({ kind: 'circle', key: 'outer', role: 'outline', cx: geo.cx, cy: geo.cy, r: geo.outerRadius, fill: 'none', stroke: theme.nodeStroke, strokeWidth: M.outerStrokeWidth });
	for (const slice of geo.slices) {
		if (!slice.drawn) continue;
		marks.push({ kind: 'text', key: `percent:${slice.id}`, role: 'slice-label', target: slice.id, x: slice.labelX, y: slice.labelY, text: slice.labelText, anchor: 'middle', baseline: 'bottom', size: 17, fill: theme.paletteText });
	}
	for (const entry of geo.legend) {
		marks.push(
			{ kind: 'rect', key: `swatch:${entry.sliceId}`, role: 'legend', target: entry.sliceId, x: entry.x, y: entry.y, width: M.legendRectSize, height: M.legendRectSize, fill: sceneColor(theme, entry.colorIndex), stroke: sceneColor(theme, entry.colorIndex) },
			{
				kind: 'text',
				key: `legend:${entry.sliceId}`,
				role: 'legend',
				target: entry.sliceId,
				x: entry.x + M.legendRectSize + M.legendSpacing,
				y: entry.y + M.legendRectSize / 2,
				text: entry.text,
				anchor: 'start',
				baseline: 'middle',
				size: M.legendFontSize,
				fill: theme.text
			}
		);
	}
	if (geo.title)
		marks.push({ kind: 'text', key: 'title', role: 'title', target: DIAGRAM_TITLE_TARGET, x: geo.title.x, y: geo.title.y, text: geo.title.text, anchor: 'middle', baseline: 'bottom', size: M.titleFontSize, fill: theme.text });
	return marks;
};
