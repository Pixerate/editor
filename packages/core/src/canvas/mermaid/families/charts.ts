import { layoutChart } from '../../../chart/layout.js';
import { createChartSpec } from '../../../chart/spec.js';
import type { ChartMark, ChartSelection, ChartSpec, ChartTheme } from '../../../chart/types.js';
import type { DiagramGraph } from '../../../diagram/types.js';
import { RADAR_CHART_BOX, XY_CHART_BOX } from '../../../diagram/layout-registry.js';
import { DIAGRAM_TITLE_TARGET, type DiagramMark, type DiagramSceneTheme, type FamilyScene } from '../scene-kit.js';

/**
 * XY and radar charts, which Ursula leaves to Mermaid's own rendering, are drawn with the
 * chart module (`layoutChart`): each series' bars, lines and points select its node.
 */

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const numbers = (v: unknown): (number | null)[] => (Array.isArray(v) ? v.map(num) : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function chartTheme(theme: DiagramSceneTheme): Partial<ChartTheme> {
	return {
		background: theme.background,
		surface: theme.background,
		text: theme.text,
		mutedText: theme.mutedText,
		grid: theme.grid,
		axis: theme.mutedText,
		selection: theme.selection,
		fontFamily: theme.fontFamily
	};
}

/** The chart spec an `xychart-beta` graph describes. */
export function xyChartSpec(graph: DiagramGraph, palette?: readonly string[]): ChartSpec {
	const data = graph.data ?? {};
	const longest = Math.max(0, ...graph.nodes.map((n) => numbers(n.data?.values).length));
	let categories = Array.isArray(data.categories) ? data.categories.map(String) : [];
	const xMin = num(data.xMin);
	const xMax = num(data.xMax);
	if (!categories.length && longest) {
		// A numeric x axis spreads the values evenly between its ends, as Mermaid does.
		categories = Array.from({ length: longest }, (_, i) =>
			xMin !== null && xMax !== null ? String(Math.round((xMin + ((xMax - xMin) * i) / Math.max(1, longest - 1)) * 100) / 100) : String(i + 1)
		);
	}
	const bars = graph.nodes.some((n) => n.shape === 'bar');
	return createChartSpec({
		type: bars ? 'bar' : 'line',
		title: graph.title ?? '',
		categories,
		series: graph.nodes.map((n) => ({ id: n.id, name: n.label, values: numbers(n.data?.values), type: n.shape === 'line' ? 'line' : 'bar' })),
		orientation: data.horizontal ? 'horizontal' : 'vertical',
		xAxis: { show: true, title: text(data.xTitle), min: null, max: null, step: null, gridlines: false, format: {} },
		yAxis: { show: true, title: text(data.yTitle), min: num(data.yMin), max: num(data.yMax), step: null, gridlines: true, format: {} },
		legend: { show: graph.nodes.some((n) => n.data?.titled), position: 'top' },
		...(palette ? { palette: [...palette] } : {})
	});
}

/** The chart spec a `radar-beta` graph describes. */
export function radarChartSpec(graph: DiagramGraph, palette?: readonly string[]): ChartSpec {
	const data = graph.data ?? {};
	return createChartSpec({
		type: 'radar',
		title: graph.title ?? '',
		categories: Array.isArray(data.axes) ? data.axes.map(String) : [],
		series: graph.nodes.map((n) => ({ id: n.id, name: n.label, values: numbers(n.data?.values) })),
		yAxis: { show: true, title: '', min: num(data.min), max: num(data.max), step: null, gridlines: true, format: {} },
		legend: { show: data.showLegend !== false, position: 'top' },
		...(palette ? { palette: [...palette] } : {})
	});
}

function targetOf(target: ChartSelection | undefined): string | undefined {
	if (!target) return undefined;
	if (target.kind === 'series' || target.kind === 'point') return target.seriesId;
	if (target.kind === 'title') return DIAGRAM_TITLE_TARGET;
	return undefined;
}

/** Chart marks as diagram marks, moved to `(x, y)`. */
function toDiagramMarks(marks: readonly ChartMark[], x: number, y: number): DiagramMark[] {
	return marks
		.filter((m) => m.role !== 'selection' && m.role !== 'drag-readout')
		.map((m): DiagramMark => {
			const base = { key: m.key, role: m.role, ...(targetOf(m.target) ? { target: targetOf(m.target) } : {}), ...(m.opacity !== undefined ? { opacity: m.opacity } : {}) };
			switch (m.kind) {
				case 'rect':
					return { ...base, kind: 'rect', x: m.x + x, y: m.y + y, width: m.width, height: m.height, fill: m.fill, stroke: m.stroke, strokeWidth: m.strokeWidth, radius: m.radius };
				case 'circle':
					return { ...base, kind: 'circle', cx: m.cx + x, cy: m.cy + y, r: m.r, fill: m.fill, stroke: m.stroke, strokeWidth: m.strokeWidth };
				case 'line':
					return { ...base, kind: 'line', x1: m.x1 + x, y1: m.y1 + y, x2: m.x2 + x, y2: m.y2 + y, stroke: m.stroke, strokeWidth: m.strokeWidth, dash: m.dash };
				case 'text':
					return { ...base, kind: 'text', x: m.x + x, y: m.y + y, text: m.text, anchor: m.anchor, baseline: m.baseline, size: m.size, weight: m.weight, fill: m.fill, rotate: m.rotate };
				case 'path':
					return {
						...base,
						kind: 'path',
						// Chart paths are absolute, so the whole path moves with a translate prefix.
						d: x || y ? translatePath(m.d, x, y) : m.d,
						fill: m.fill,
						stroke: m.stroke,
						strokeWidth: m.strokeWidth,
						dash: m.dash
					};
			}
		});
}

/** Moves an absolute M / L / C / Q / Z path (what the chart layout draws) by (dx, dy). */
function translatePath(d: string, dx: number, dy: number): string {
	let i = 0;
	return d.replace(/-?\d*\.?\d+(?:e-?\d+)?/gi, (v) => String(Math.round((Number(v) + (i++ % 2 === 0 ? dx : dy)) * 100) / 100));
}

export const xyChartScene: FamilyScene = ({ graph, theme }) => {
	const box = XY_CHART_BOX;
	const scene = layoutChart(xyChartSpec(graph, theme.palette), { width: box.width, height: box.height, theme: chartTheme(theme) });
	return toDiagramMarks(scene.marks, box.x, box.y);
};

export const radarScene: FamilyScene = ({ graph, theme }) => {
	const box = RADAR_CHART_BOX;
	const scene = layoutChart(radarChartSpec(graph, theme.palette), { width: box.width, height: box.height, theme: chartTheme(theme) });
	return toDiagramMarks(scene.marks, box.x, box.y);
};
