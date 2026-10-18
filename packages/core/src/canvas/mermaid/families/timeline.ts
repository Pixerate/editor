// Follows Ursula's src/react/canvases/timeline.tsx (and its .ursula-timeline__* styles).
import { TIMELINE_METRICS, textWidth, timelineGeometry, type TimelineBox, type TimelineColour } from '../../../diagram/timeline/geometry.js';
import { DIAGRAM_TITLE_TARGET, sceneColor, type DiagramMark, type DiagramSceneTheme, type FamilyScene } from '../scene-kit.js';

const M = TIMELINE_METRICS;
const RADIUS = 5;
/** Box text: 17px below the top, 16px with a 1.1 line height (Ursula's `.ursula-timeline__box`). */
const TEXT_TOP = 17;
const TEXT_LINE = M.fontSize * 1.1;

/** Fill, text and bottom-line colours for a colour slot (Mermaid's `cScale`, `cScaleLabel`, `cScaleInv`). */
function colours(theme: DiagramSceneTheme, colour: TimelineColour): { fill: string; text: string; line?: string } {
	if (colour === 'root') return { fill: theme.nodeStroke, text: theme.background };
	return { fill: sceneColor(theme, colour), text: theme.paletteText, line: sceneColor(theme, colour + 6) };
}

/** A box with rounded top corners and a square bottom (Mermaid's `node-bkg` path). */
function boxPath({ x, y, width: w, height: h }: TimelineBox): string {
	const r = Math.min(RADIUS, w / 2, h / 2);
	return `M ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} L ${x + w - r} ${y} Q ${x + w} ${y} ${x + w} ${y + r} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
}

/** Lines of `text` wrapped at `width` (word wrap, `<br>` breaks), like the geometry's `wrapLines`. */
function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const part of String(text).split(/<br\s*\/?>|\n/i)) {
		let line = '';
		for (const word of part.split(/\s+/).filter(Boolean)) {
			const next = line ? `${line} ${word}` : word;
			if (line && textWidth(next) > width) {
				out.push(line);
				line = word;
			} else line = next;
		}
		out.push(line);
	}
	return out.length ? out : [''];
}

/** A line ending in Mermaid's timeline arrowhead (`M0,0 V4 L6,2 Z`, scaled by the stroke width). */
function arrowLine(key: string, x1: number, y1: number, x2: number, y2: number, width: number, dashed: boolean, colour: string): DiagramMark[] {
	const len = Math.hypot(x2 - x1, y2 - y1) || 1;
	const ux = (x2 - x1) / len;
	const uy = (y2 - y1) / len;
	const bx = x2 - ux * 5 * width;
	const by = y2 - uy * 5 * width;
	const tx = x2 + ux * width;
	const ty = y2 + uy * width;
	return [
		{ kind: 'line', key, role: dashed ? 'event-line' : 'axis', x1, y1, x2, y2, stroke: colour, strokeWidth: width, ...(dashed ? { dash: '5,5' } : {}) },
		{
			kind: 'path',
			key: `${key}:head`,
			role: dashed ? 'event-line' : 'axis',
			d: `M ${bx - uy * 2 * width} ${by + ux * 2 * width} L ${tx} ${ty} L ${bx + uy * 2 * width} ${by - ux * 2 * width} Z`,
			fill: colour
		}
	];
}

/**
 * Timelines as Mermaid's left-to-right timeline draws them (Ursula's `canvases/timeline.tsx`):
 * section header bands on top, each period as a box in one row, a thick time axis with an
 * arrow under the periods, and each period's events stacked below it on a dashed line, with
 * the title left-aligned above. One colour per section, or one per period without sections.
 * A period and its events select the period; a section band selects the section.
 */
export const timelineScene: FamilyScene = ({ graph, theme }) => {
	const geo = timelineGeometry(graph);
	const marks: DiagramMark[] = [];
	const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
	const groups = new Map(graph.groups.map((g) => [g.id, g]));
	const line = theme.text;

	const box = (key: string, role: string, target: string, b: TimelineBox, colour: TimelineColour, text: string, opacity?: number, brighten = false) => {
		const c = colours(theme, colour);
		marks.push({ kind: 'path', key, role, target, d: boxPath(b), fill: c.fill, ...(opacity !== undefined ? { opacity } : {}) });
		// Mermaid's `brightness(120%)` on events, as a translucent background-coloured wash.
		if (brighten) marks.push({ kind: 'path', key: `${key}:wash`, role, target, d: boxPath(b), fill: theme.background, opacity: 0.2 });
		if (c.line) marks.push({ kind: 'line', key: `${key}:line`, role, target, x1: b.x, y1: b.y + b.height, x2: b.x + b.width, y2: b.y + b.height, stroke: c.line, strokeWidth: 3 });
		wrap(text, b.width - 2 * M.padding).forEach((t, i) =>
			marks.push({ kind: 'text', key: `${key}:text:${i}`, role: `${role}-label`, target, x: b.x + b.width / 2, y: b.y + TEXT_TOP + TEXT_LINE * (i + 0.5), text: t, anchor: 'middle', baseline: 'middle', size: M.fontSize, fill: c.text })
		);
	};

	// Lines under everything else: the dashed event lines, then the axis.
	for (const l of geo.eventLines) marks.push(...arrowLine(`event-line:${l.periodId}`, l.x, l.y1, l.x, l.y2, M.eventLineWidth, true, line));
	marks.push(...arrowLine('axis', geo.axis.x1, geo.axis.y, geo.axis.x2, geo.axis.y, M.axisWidth, false, line));

	// Events (Mermaid draws them 20% brighter), then sections and periods.
	for (const e of geo.events) box(`event:${e.periodId}:${e.index}`, 'event', e.periodId, e, e.colour, e.text, undefined, true);
	for (const s of geo.sections.values()) box(`section:${s.id}`, 'section', s.id, s, s.colour, groups.get(s.id)?.label ?? s.id, s.empty ? 0.6 : undefined);
	for (const p of geo.periods.values()) {
		const node = nodes.get(p.id);
		box(`period:${p.id}`, 'period', p.id, p, p.colour, node?.label ?? p.id);
	}

	// Mermaid: bold, 4ex, left-aligned at the title x, baseline 30px above the content.
	if (graph.title)
		marks.push({ kind: 'text', key: 'title', role: 'title', target: DIAGRAM_TITLE_TARGET, x: geo.title.x, y: geo.title.baseline, text: graph.title, anchor: 'start', baseline: 'bottom', size: 32, weight: 700, fill: theme.text });
	return marks;
};
