// Follows Ursula's src/react/canvases/quadrant.tsx.
import { QUADRANT_METRICS, quadrantGeometry } from '../../../diagram/quadrant/geometry.js';
import { DIAGRAM_TITLE_TARGET, sceneColor, type DiagramMark, type FamilyScene } from '../scene-kit.js';

const M = QUADRANT_METRICS;
/** Quadrant tint over the background (Mermaid's quadrant fills are light shades). */
const QUADRANT_TINT = 0.18;

/**
 * Quadrant charts as Mermaid draws them (Ursula's `canvases/quadrant.tsx`): the chart area
 * split into four tinted quadrants with their labels, the internal and external borders, the
 * x-axis labels under the chart (above it while there are no points), the y-axis labels
 * rotated on the left, the title on top, and every point a filled circle with its label just
 * below. A quadrant (its area or label) selects its group; a point or its label selects the
 * point. Points keep their own `color`, `strokeColor` and `strokeWidth`.
 */
export const quadrantScene: FamilyScene = ({ graph, theme }) => {
	const geo = quadrantGeometry(graph);
	const marks: DiagramMark[] = [];
	const groups = new Map(graph.groups.map((g) => [g.id, g]));

	for (const q of geo.quadrants) {
		const group = groups.get(q.id);
		marks.push({ kind: 'rect', key: `quadrant-fill:${q.id}`, role: 'quadrant-fill', x: q.x, y: q.y, width: q.width, height: q.height, fill: sceneColor(theme, q.n - 1), opacity: QUADRANT_TINT });
		// A transparent area on top of the tint carries the selection (the tint's opacity would hide its outline).
		marks.push({ kind: 'rect', key: `quadrant:${q.id}`, role: 'quadrant', ...(group ? { target: q.id } : {}), x: q.x, y: q.y, width: q.width, height: q.height, fill: 'transparent' });
	}
	for (const q of geo.quadrants) {
		const group = groups.get(q.id);
		// Unnamed quadrants (`placeholder`) show no label, as in Mermaid.
		if (!group || group.data?.placeholder || !group.label) continue;
		marks.push({
			kind: 'text',
			key: `quadrant-label:${q.id}`,
			role: 'quadrant-label',
			target: q.id,
			x: q.labelX,
			y: q.labelY,
			text: group.label,
			anchor: 'middle',
			baseline: q.labelBaseline,
			size: M.quadrantLabelFontSize,
			fill: theme.text
		});
	}

	geo.borders.forEach((b, i) =>
		marks.push({
			kind: 'line',
			key: `border:${i}`,
			role: b.external ? 'border' : 'divider',
			x1: b.x1,
			y1: b.y1,
			x2: b.x2,
			y2: b.y2,
			stroke: theme.nodeStroke,
			strokeWidth: b.external ? M.externalBorderWidth : M.internalBorderWidth
		})
	);

	for (const l of geo.axisLabels)
		marks.push({
			kind: 'text',
			key: `axis:${l.key}`,
			role: 'axis-label',
			x: l.x,
			y: l.y,
			text: l.text,
			anchor: l.anchor,
			baseline: 'top',
			size: l.rotation ? M.yAxisLabelFontSize : M.xAxisLabelFontSize,
			fill: theme.text,
			...(l.rotation ? { rotate: l.rotation } : {})
		});

	if (geo.title)
		marks.push({ kind: 'text', key: 'title', role: 'title', target: DIAGRAM_TITLE_TARGET, x: geo.title.x, y: geo.title.y, text: geo.title.text, anchor: 'middle', baseline: 'top', size: M.titleFontSize, fill: theme.text });

	for (const p of geo.points) {
		const fill = p.color ?? sceneColor(theme, 0);
		const strokeWidth = p.strokeWidth ? parseFloat(p.strokeWidth) : 0;
		marks.push({
			kind: 'circle',
			key: `point:${p.id}`,
			role: 'point',
			target: p.id,
			cx: p.cx,
			cy: p.cy,
			r: p.radius,
			fill,
			...(Number.isFinite(strokeWidth) && strokeWidth > 0 ? { stroke: p.strokeColor ?? fill, strokeWidth } : {})
		});
		marks.push({
			kind: 'text',
			key: `point-label:${p.id}`,
			role: 'point-label',
			target: p.id,
			x: p.cx,
			y: p.cy + M.pointTextPadding,
			text: p.label.replace(/<br\s*\/?>/gi, ' '),
			anchor: 'middle',
			baseline: 'top',
			size: M.pointLabelFontSize,
			fill: theme.text
		});
	}
	return marks;
};
