import { formatChartNumber, linearMap, niceScale, stepDecimals } from './scale.js';
import { chartSeriesColor, chartSeriesType, chartSliceColor, DEFAULT_CHART_THEME, isCartesianChart } from './spec.js';
import type {
	ChartMark,
	ChartNumberFormat,
	ChartRect,
	ChartScene,
	ChartSelection,
	ChartSeries,
	ChartSeriesType,
	ChartSpec,
	ChartTheme,
	ChartValueScale
} from './types.js';

export type ChartTextMeasure = (text: string, size: number, weight?: number) => number;

export interface ChartLayoutOptions {
	width: number;
	height: number;
	theme?: Partial<ChartTheme>;
	/** Highlighted in the scene (selection outlines, `selected` flags). */
	selection?: ChartSelection | null;
	/** Text width in pixels (default: an estimate from the character count). */
	measureText?: ChartTextMeasure;
	/** Shown when there is nothing to draw (default "No data"). */
	emptyMessage?: string;
	/**
	 * Fixes the value axis to this range (over `yAxis.min` / `yAxis.max`). Canvases pass
	 * `ChartPointDrag.valueDomain` during a drag so the axis does not rescale under the pointer.
	 */
	valueDomain?: { min: number; max: number } | null;
}

/** A DOM-free text width estimate (average glyph ≈ 0.56 em, bold ≈ 0.6 em). */
export const estimateChartTextWidth: ChartTextMeasure = (text, size, weight = 400) => text.length * size * (weight >= 600 ? 0.6 : 0.56);

/** Whether two selections point at the same thing. */
export function sameChartSelection(a: ChartSelection | null | undefined, b: ChartSelection | null | undefined): boolean {
	if (!a || !b || a.kind !== b.kind) return false;
	switch (a.kind) {
		case 'axis':
			return a.axis === (b as typeof a).axis;
		case 'series':
			return a.seriesId === (b as typeof a).seriesId;
		case 'point':
			return a.seriesId === (b as typeof a).seriesId && a.index === (b as typeof a).index;
		case 'category':
			return a.index === (b as typeof a).index;
		default:
			return true;
	}
}

/**
 * Black or white text for a label drawn on `fill` (#rgb, #rrggbb or rgb()), by perceived
 * luminance (0.299 R + 0.587 G + 0.114 B). Unparseable colours (CSS variables) get white.
 */
export function contrastingTextColor(fill: string): string {
	let rgb: number[] | null = null;
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(fill.trim());
	if (hex) {
		const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
		rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
	} else {
		const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(fill.trim());
		if (fn) rgb = fn.slice(1, 4).map(Number);
	}
	if (!rgb) return '#ffffff';
	const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
	return luminance > 0.5 ? '#0f172a' : '#ffffff';
}

const r2 = (n: number) => Math.round(n * 100) / 100;

interface Pt {
	c: number;
	v: number;
}

/** Path through points (in category/value pixel space) with the chosen curve; `map` turns them into x/y. */
function curvePath(points: Pt[], curve: ChartSpec['curve'], map: (p: Pt) => [number, number], moveFirst = true): string {
	if (!points.length) return '';
	const xy = points.map(map);
	let d = `${moveFirst ? 'M' : 'L'}${r2(xy[0][0])},${r2(xy[0][1])}`;
	if (points.length === 1) return d;
	if (curve === 'step') {
		for (let i = 1; i < points.length; i++) {
			const mid = (points[i - 1].c + points[i].c) / 2;
			const a = map({ c: mid, v: points[i - 1].v });
			const b = map({ c: mid, v: points[i].v });
			d += `L${r2(a[0])},${r2(a[1])}L${r2(b[0])},${r2(b[1])}L${r2(xy[i][0])},${r2(xy[i][1])}`;
		}
		return d;
	}
	if (curve === 'smooth' && points.length > 2) {
		// Monotone cubic (Fritsch–Carlson): smooth, never overshoots the data.
		const n = points.length;
		const dc = points.slice(1).map((p, i) => p.c - points[i].c);
		const slope = points.slice(1).map((p, i) => (dc[i] === 0 ? 0 : (p.v - points[i].v) / dc[i]));
		const tangent = points.map((_, i) => {
			if (i === 0) return slope[0];
			if (i === n - 1) return slope[n - 2];
			const a = slope[i - 1];
			const b = slope[i];
			if (a * b <= 0) return 0;
			const wa = 2 * dc[i] + dc[i - 1];
			const wb = dc[i] + 2 * dc[i - 1];
			return (wa + wb) / (wa / a + wb / b);
		});
		for (let i = 1; i < n; i++) {
			const h = dc[i - 1] / 3;
			const p0 = points[i - 1];
			const p1 = points[i];
			const a = map({ c: p0.c + h, v: p0.v + tangent[i - 1] * h });
			const b = map({ c: p1.c - h, v: p1.v - tangent[i] * h });
			d += `C${r2(a[0])},${r2(a[1])} ${r2(b[0])},${r2(b[1])} ${r2(xy[i][0])},${r2(xy[i][1])}`;
		}
		return d;
	}
	for (let i = 1; i < xy.length; i++) d += `L${r2(xy[i][0])},${r2(xy[i][1])}`;
	return d;
}

function arcPath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
	const full = end - start >= Math.PI * 2 - 1e-9;
	if (full) end = start + Math.PI * 2 - 1e-4;
	const p = (r: number, a: number) => `${r2(cx + r * Math.sin(a))},${r2(cy - r * Math.cos(a))}`;
	const large = end - start > Math.PI ? 1 : 0;
	let d = `M${p(outer, start)}A${r2(outer)},${r2(outer)} 0 ${large} 1 ${p(outer, end)}`;
	if (inner > 0) d += `L${p(inner, end)}A${r2(inner)},${r2(inner)} 0 ${large} 0 ${p(inner, start)}Z`;
	else d += `L${r2(cx)},${r2(cy)}Z`;
	return d;
}

interface LegendItem {
	label: string;
	color: string;
	target: ChartSelection;
	faded: boolean;
	selected: boolean;
	shape: 'square' | 'line';
}

interface Stack {
	/** Per category: [bottom, top] of this series' segment, or null for a gap. */
	segments: ([number, number] | null)[];
}

/**
 * Lays a chart out as drawing primitives (rects, paths, circles, lines and text) in a
 * `width × height` box. Pure and DOM-free: the React and Svelte canvases render the marks
 * as SVG, `chartSceneToSvg` writes them as a string, and anything else (canvas, PDF) can
 * draw them too. Clickable marks carry the `target` they select.
 */
export function layoutChart(spec: ChartSpec, options: ChartLayoutOptions): ChartScene {
	const width = Math.max(1, options.width);
	const height = Math.max(1, options.height);
	const theme: ChartTheme = { ...DEFAULT_CHART_THEME, ...options.theme };
	const measure = options.measureText ?? estimateChartTextWidth;
	const selection = options.selection ?? null;
	const fs = theme.fontSize;
	const marks: ChartMark[] = [];
	const isSelected = (target: ChartSelection) => sameChartSelection(selection, target);
	const seriesSelected = (id: string) => selection?.kind === 'series' && selection.seriesId === id;
	const pad = 12;

	marks.push({ kind: 'rect', key: 'background', role: 'background', x: 0, y: 0, width, height, fill: theme.background, target: { kind: 'chart' } });

	// Titles ----------------------------------------------------------------
	let top = pad;
	const outline = (key: string, box: ChartRect) =>
		marks.push({ kind: 'rect', key, role: 'selection', ...box, fill: 'none', stroke: theme.selection, strokeWidth: 1, radius: 3 });
	const titleMark = (kind: 'title' | 'subtitle', label: string, size: number, weight: number, fill: string) => {
		const target: ChartSelection = { kind };
		const selected = isSelected(target);
		marks.push({ kind: 'text', key: kind, role: kind, x: width / 2, y: top, text: label, anchor: 'middle', baseline: 'top', size, weight, fill, target, selected });
		if (selected) {
			const w = measure(label, size, weight);
			outline(`${kind}-selection`, { x: width / 2 - w / 2 - 4, y: top - 3, width: w + 8, height: size * 1.25 + 6 });
		}
		top += size * 1.35;
	};
	if (spec.title) titleMark('title', spec.title, theme.titleSize, 600, theme.text);
	if (spec.subtitle) titleMark('subtitle', spec.subtitle, fs + 1, 400, theme.mutedText);
	if (spec.title || spec.subtitle) top += 6;

	const cartesian = isCartesianChart(spec.type);
	const visible = spec.series.filter((s) => !s.hidden);

	// Legend ----------------------------------------------------------------
	const legendItems: LegendItem[] = cartesian
		? spec.series.map((s, i) => ({
				label: s.name,
				color: chartSeriesColor(spec, i),
				target: { kind: 'series', seriesId: s.id },
				faded: !!s.hidden,
				selected: seriesSelected(s.id),
				shape: chartSeriesType(spec, s) === 'line' ? 'line' : 'square'
			}))
		: spec.categories.map((c, i) => ({
				label: c,
				color: chartSliceColor(spec, i),
				target: { kind: 'category', index: i },
				faded: false,
				selected: isSelected({ kind: 'category', index: i }),
				shape: 'square'
			}));
	let area: ChartRect = { x: pad, y: top, width: width - pad * 2, height: height - top - pad };
	const showLegend = spec.legend.show && legendItems.length > 0 && (!cartesian || spec.series.length > 1 || spec.series.some((s) => s.hidden));
	if (showLegend) area = layoutLegend(legendItems, spec.legend.position, area, theme, measure, marks, isSelected({ kind: 'legend' }));

	const empty = (message: string) => {
		marks.push({ kind: 'text', key: 'empty', role: 'empty', x: area.x + area.width / 2, y: area.y + area.height / 2, text: message, anchor: 'middle', baseline: 'middle', size: fs + 1, fill: theme.mutedText });
		return { width, height, plot: { x: area.x, y: area.y, width: 0, height: 0 }, marks, percent: false, theme };
	};
	const hasData = visible.some((s) => s.values.some((v) => v !== null));
	if (!spec.categories.length || !visible.length || !hasData) return empty(options.emptyMessage ?? 'No data');

	if (!cartesian) return layoutPie(spec, visible[0], area, theme, marks, selection, width, height);

	// Cartesian -------------------------------------------------------------
	const horizontal = spec.orientation === 'horizontal';
	const n = spec.categories.length;
	const types = new Map<string, ChartSeriesType>(visible.map((s) => [s.id, chartSeriesType(spec, s)]));
	const stacked = spec.stacking !== 'none';
	const percent = spec.stacking === 'percent';

	// Stack bars together and areas together (lines and scatter are never stacked).
	const stacks = new Map<string, Stack>();
	if (stacked) {
		for (const kind of ['bar', 'area'] as const) {
			const group = visible.filter((s) => types.get(s.id) === kind);
			if (!group.length) continue;
			const totals = Array.from({ length: n }, (_, i) => group.reduce((t, s) => t + Math.abs(s.values[i] ?? 0), 0));
			const pos = Array(n).fill(0);
			const neg = Array(n).fill(0);
			for (const s of group) {
				const segments = s.values.map((raw, i) => {
					if (raw === null && kind === 'bar') return null;
					let v = raw ?? 0;
					if (percent) v = totals[i] ? v / totals[i] : 0;
					const base = v >= 0 ? pos[i] : neg[i];
					const seg: [number, number] = [base, base + v];
					if (v >= 0) pos[i] += v;
					else neg[i] += v;
					return seg;
				});
				stacks.set(s.id, { segments });
			}
		}
	}

	let lo = Infinity;
	let hi = -Infinity;
	const see = (v: number) => {
		lo = Math.min(lo, v);
		hi = Math.max(hi, v);
	};
	for (const s of visible) {
		const stack = stacks.get(s.id);
		if (stack) stack.segments.forEach((seg) => seg && (see(seg[0]), see(seg[1])));
		else s.values.forEach((v) => v !== null && see(v));
	}
	if (!Number.isFinite(lo)) {
		lo = 0;
		hi = 1;
	}
	if ([...types.values()].some((t) => t === 'bar' || t === 'area')) {
		lo = Math.min(lo, 0);
		hi = Math.max(hi, 0);
	}
	const valueFormat: ChartNumberFormat = percent && !spec.yAxis.format.style ? { ...spec.yAxis.format, style: 'percent' } : spec.yAxis.format;

	// Margins depend on label sizes, and the tick count on the plot length: estimate, then lay out.
	const xAxis = spec.xAxis;
	const yAxis = spec.yAxis;
	const titleBand = fs * 1.3 + 6;
	const frozen = options.valueDomain;
	const fixedMin = frozen && Number.isFinite(frozen.min) ? frozen.min : yAxis.min;
	const fixedMax = frozen && Number.isFinite(frozen.max) ? frozen.max : yAxis.max;
	const valueLen0 = horizontal ? area.width : area.height;
	let scale = niceScale(lo, hi, Math.max(2, Math.min(10, Math.round(valueLen0 / 56))), fixedMin, fixedMax);
	const tickText = (t: number) => formatChartNumber(t, valueFormat, valueFormat.decimals ?? stepDecimals(scale.step));
	const valueLabelWidth = Math.max(0, ...scale.ticks.map((t) => measure(tickText(t), fs)));
	const catLabelWidth = Math.max(0, ...spec.categories.map((c) => measure(c, fs)));

	let left: number;
	let bottom: number;
	let rotate = 0;
	if (horizontal) {
		left = (xAxis.show ? Math.min(catLabelWidth, area.width * 0.35) + 8 : 2) + (xAxis.title ? titleBand : 0);
		bottom = (yAxis.show ? fs * 1.6 : 2) + (yAxis.title ? titleBand : 0);
	} else {
		left = (yAxis.show ? valueLabelWidth + 8 : 2) + (yAxis.title ? titleBand : 0);
		const band = (area.width - left - 8) / n;
		if (xAxis.show && catLabelWidth > band * 0.92) rotate = -40;
		const catHeight = rotate ? Math.min(catLabelWidth * Math.sin(Math.PI / 4.5) + fs, area.height * 0.4) : fs * 1.6;
		bottom = (xAxis.show ? catHeight : 2) + (xAxis.title ? titleBand : 0);
	}
	const rightPad = horizontal ? Math.max(8, valueLabelWidth / 2) : 8;
	const plot: ChartRect = {
		x: area.x + left,
		y: area.y + (horizontal ? 4 : fs / 2 + 2),
		width: Math.max(1, area.width - left - rightPad),
		height: Math.max(1, area.height - bottom - (horizontal ? 4 : fs / 2 + 2))
	};
	scale = niceScale(lo, hi, Math.max(2, Math.min(10, Math.round((horizontal ? plot.width : plot.height) / 56))), fixedMin, fixedMax);

	const domain: [number, number] = [scale.min, scale.max];
	const valueRange: [number, number] = horizontal ? [plot.x, plot.x + plot.width] : [plot.y + plot.height, plot.y];
	const valuePx = (v: number) => linearMap(Math.min(scale.max, Math.max(scale.min, v)), domain, valueRange);
	const catStart = horizontal ? plot.y : plot.x;
	const catLen = horizontal ? plot.height : plot.width;
	const band = catLen / n;
	const catCenter = (i: number) => catStart + band * (i + 0.5);
	const map = (p: Pt): [number, number] => (horizontal ? [p.v, p.c] : [p.c, p.v]);
	const zero = valuePx(Math.min(scale.max, Math.max(scale.min, 0)));

	// Grid and axes
	const axisSelected = (axis: 'x' | 'y') => isSelected({ kind: 'axis', axis });
	if (yAxis.gridlines) {
		scale.ticks.forEach((t, i) => {
			const p = valuePx(t);
			const [x1, y1] = map({ c: catStart, v: p });
			const [x2, y2] = map({ c: catStart + catLen, v: p });
			marks.push({ kind: 'line', key: `grid-y-${i}`, role: 'grid', x1, y1, x2, y2, stroke: theme.grid, strokeWidth: 1 });
		});
	}
	if (xAxis.gridlines) {
		for (let i = 1; i < n; i++) {
			const c = catStart + band * i;
			const [x1, y1] = map({ c, v: valueRange[0] });
			const [x2, y2] = map({ c, v: valueRange[1] });
			marks.push({ kind: 'line', key: `grid-x-${i}`, role: 'grid', x1, y1, x2, y2, stroke: theme.grid, strokeWidth: 1 });
		}
	}

	const yTarget: ChartSelection = { kind: 'axis', axis: 'y' };
	const xTarget: ChartSelection = { kind: 'axis', axis: 'x' };
	if (yAxis.show) {
		scale.ticks.forEach((t, i) => {
			const p = valuePx(t);
			const label = tickText(t);
			if (horizontal)
				marks.push({ kind: 'text', key: `tick-y-${i}`, role: 'tick-label', x: p, y: plot.y + plot.height + 6, text: label, anchor: 'middle', baseline: 'top', size: fs, fill: theme.mutedText, target: yTarget });
			else marks.push({ kind: 'text', key: `tick-y-${i}`, role: 'tick-label', x: plot.x - 8, y: p, text: label, anchor: 'end', baseline: 'middle', size: fs, fill: theme.mutedText, target: yTarget });
		});
	}
	if (xAxis.show) {
		const [x1, y1] = map({ c: catStart, v: zero });
		const [x2, y2] = map({ c: catStart + catLen, v: zero });
		marks.push({ kind: 'line', key: 'axis-x', role: 'axis', x1, y1, x2, y2, stroke: theme.axis, strokeWidth: 1, target: xTarget });
		const every = horizontal ? Math.max(1, Math.ceil((fs * 1.3) / band)) : rotate ? Math.max(1, Math.ceil((fs * 1.4) / band)) : 1;
		spec.categories.forEach((c, i) => {
			if (i % every) return;
			const target: ChartSelection = { kind: 'category', index: i };
			const selected = isSelected(target);
			const fill = selected ? theme.selection : theme.mutedText;
			if (horizontal) {
				const maxW = left - (xAxis.title ? titleBand : 0) - 8;
				marks.push({ kind: 'text', key: `tick-x-${i}`, role: 'tick-label', x: plot.x - 8, y: catCenter(i), text: truncate(c, maxW, fs, measure), anchor: 'end', baseline: 'middle', size: fs, fill, target, selected });
			} else if (rotate)
				marks.push({ kind: 'text', key: `tick-x-${i}`, role: 'tick-label', x: catCenter(i), y: plot.y + plot.height + 8, text: c, anchor: 'end', baseline: 'middle', size: fs, fill, rotate, target, selected });
			else marks.push({ kind: 'text', key: `tick-x-${i}`, role: 'tick-label', x: catCenter(i), y: plot.y + plot.height + 6, text: c, anchor: 'middle', baseline: 'top', size: fs, fill, target, selected });
		});
	}
	// Axis titles: category axis title beside the category labels, value axis title beside the ticks.
	const bottomTitle = horizontal ? yAxis.title : xAxis.title;
	const leftTitle = horizontal ? xAxis.title : yAxis.title;
	if (bottomTitle)
		marks.push({ kind: 'text', key: `axis-title-${horizontal ? 'y' : 'x'}`, role: 'axis-title', x: plot.x + plot.width / 2, y: area.y + area.height, text: bottomTitle, anchor: 'middle', baseline: 'bottom', size: fs + 1, weight: 500, fill: theme.text, target: horizontal ? yTarget : xTarget });
	if (leftTitle)
		marks.push({ kind: 'text', key: `axis-title-${horizontal ? 'x' : 'y'}`, role: 'axis-title', x: area.x, y: plot.y + plot.height / 2, text: leftTitle, anchor: 'middle', baseline: 'top', size: fs + 1, weight: 500, fill: theme.text, rotate: -90, target: horizontal ? xTarget : yTarget });
	// The selected axis gets an outline around its labels.
	for (const axis of ['x', 'y'] as const) {
		if (!axisSelected(axis)) continue;
		const onLeft = (axis === 'y') !== horizontal;
		const box: ChartRect = onLeft
			? { x: area.x, y: plot.y - fs / 2, width: left - 2, height: plot.height + fs }
			: { x: plot.x - 4, y: plot.y + plot.height + 2, width: plot.width + 8, height: area.y + area.height - plot.y - plot.height - 2 };
		outline(`axis-${axis}-selection`, box);
	}

	// Series ----------------------------------------------------------------
	const bars = visible.filter((s) => types.get(s.id) === 'bar');
	const slots = stacked ? 1 : bars.length;
	const groupWidth = band * (bars.length ? 0.72 : 0);
	const barWidth = slots ? groupWidth / slots : 0;
	const labelMarks: ChartMark[] = [];
	const decimals = valueFormat.decimals ?? undefined;
	const dataLabel = (v: number) => formatChartNumber(v, valueFormat, decimals);

	const drawOrder = [...visible].sort((a, b) => order(types.get(a.id)!) - order(types.get(b.id)!));
	for (const s of drawOrder) {
		const si = spec.series.indexOf(s);
		const color = chartSeriesColor(spec, si);
		const type = types.get(s.id)!;
		const stack = stacks.get(s.id);
		const selSeries = seriesSelected(s.id);
		const seriesTarget: ChartSelection = { kind: 'series', seriesId: s.id };

		if (type === 'bar') {
			const slot = stacked ? 0 : bars.indexOf(s);
			s.values.forEach((raw, i) => {
				const seg = stack ? stack.segments[i] : raw === null ? null : ([0, raw] as [number, number]);
				if (!seg || raw === null) return;
				const a = valuePx(seg[0]);
				const b = valuePx(seg[1]);
				const c0 = catCenter(i) - groupWidth / 2 + slot * barWidth + barWidth * 0.06;
				const cw = barWidth * 0.88;
				const target: ChartSelection = { kind: 'point', seriesId: s.id, index: i };
				const selected = isSelected(target);
				const [x, y] = map({ c: c0, v: Math.min(a, b) });
				const rect = horizontal ? { x: Math.min(a, b), y: c0, width: Math.abs(b - a), height: cw } : { x, y, width: cw, height: Math.abs(b - a) };
				marks.push({
					kind: 'rect',
					key: `bar-${s.id}-${i}`,
					role: 'bar',
					...rect,
					fill: color,
					radius: Math.min(2, cw / 4),
					target,
					selected: selected || selSeries,
					...(selSeries ? { stroke: theme.selection, strokeWidth: 1.5 } : {})
				});
				if (selected) outline(`bar-${s.id}-${i}-selection`, { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 });
				if (spec.dataLabels) {
					const v = percent ? seg[1] - seg[0] : raw;
					const text = dataLabel(v);
					// Inside a stacked segment: only when it fits along the value axis.
					if (stacked && Math.abs(b - a) < (horizontal ? measure(text, fs - 1) + 4 : fs + 1)) return;
					const end = valuePx(seg[1]);
					const outward = (seg[1] >= seg[0] ? 1 : -1) * (horizontal ? 1 : -1);
					const [lx, ly] = map({ c: c0 + cw / 2, v: stacked ? (a + b) / 2 : end + outward * 4 });
					labelMarks.push({
						kind: 'text',
						key: `label-${s.id}-${i}`,
						role: 'data-label',
						x: lx,
						y: ly,
						text,
						anchor: horizontal && !stacked ? (outward > 0 ? 'start' : 'end') : 'middle',
						baseline: horizontal || stacked ? 'middle' : outward < 0 ? 'bottom' : 'top',
						size: fs - 1,
						fill: stacked ? contrastingTextColor(color) : theme.text,
						target
					});
				}
			});
			continue;
		}

		// Line, area and scatter share the point positions.
		const pointValue = (i: number): number | null => (stack ? (stack.segments[i]?.[1] ?? null) : s.values[i]);
		const runs: Pt[][] = [];
		let run: Pt[] = [];
		for (let i = 0; i < n; i++) {
			const v = pointValue(i);
			if (v === null) {
				if (run.length) runs.push(run);
				run = [];
				continue;
			}
			run.push({ c: catCenter(i), v: valuePx(v) });
		}
		if (run.length) runs.push(run);

		if (type === 'area') {
			// Stacked areas fill down to the series below; others down to zero.
			const parts = runs.map((r) => {
				const baseline = stack
					? r.map((p) => ({ c: p.c, v: valuePx(stack.segments[Math.round((p.c - catStart) / band - 0.5)]?.[0] ?? 0) })).reverse()
					: [
							{ c: r[r.length - 1].c, v: zero },
							{ c: r[0].c, v: zero }
						];
				return `${curvePath(r, spec.curve, map)}${stack ? curvePath(baseline, spec.curve, map, false) : baseline.map((p) => `L${map(p).map(r2).join(',')}`).join('')}Z`;
			});
			marks.push({ kind: 'path', key: `area-${s.id}`, role: 'area', d: parts.join(''), fill: color, opacity: 0.22, target: seriesTarget, selected: selSeries });
		}
		if (type === 'line' || type === 'area') {
			marks.push({
				kind: 'path',
				key: `line-${s.id}`,
				role: 'line',
				d: runs.map((r) => curvePath(r, spec.curve, map)).join(''),
				fill: 'none',
				stroke: color,
				strokeWidth: selSeries ? 3.5 : 2,
				target: seriesTarget,
				selected: selSeries
			});
		}
		const showDots = type === 'scatter' || spec.points;
		for (let i = 0; i < n; i++) {
			const v = pointValue(i);
			if (v === null || s.values[i] === null) continue;
			const [cx, cy] = map({ c: catCenter(i), v: valuePx(v) });
			const target: ChartSelection = { kind: 'point', seriesId: s.id, index: i };
			const selected = isSelected(target);
			const r = type === 'scatter' ? 4.5 : 3.5;
			// Without dots the point still gets a transparent target so it can be picked and dragged.
			marks.push({
				kind: 'circle',
				key: `point-${s.id}-${i}`,
				role: 'point',
				cx,
				cy,
				r: showDots ? r : 6,
				fill: showDots ? (type === 'scatter' ? color : theme.surface) : 'transparent',
				...(showDots ? { stroke: color, strokeWidth: 2 } : {}),
				opacity: type === 'scatter' ? 0.85 : undefined,
				target,
				selected: selected || selSeries
			});
			if (selected) marks.push({ kind: 'circle', key: `point-${s.id}-${i}-selection`, role: 'selection', cx, cy, r: r + 3.5, fill: 'none', stroke: theme.selection, strokeWidth: 1.5 });
			if (spec.dataLabels) {
				const raw = s.values[i]!;
				const shown = percent && stack ? stack.segments[i]![1] - stack.segments[i]![0] : raw;
				labelMarks.push({
					kind: 'text',
					key: `label-${s.id}-${i}`,
					role: 'data-label',
					x: horizontal ? cx + 8 : cx,
					y: horizontal ? cy : cy - 8,
					text: dataLabel(shown),
					anchor: horizontal ? 'start' : 'middle',
					baseline: horizontal ? 'middle' : 'bottom',
					size: fs - 1,
					fill: theme.text,
					target
				});
			}
		}
	}
	marks.push(...labelMarks);

	const valueScale: ChartValueScale = { axis: horizontal ? 'x' : 'y', domain, range: valueRange, ticks: scale.ticks };
	return { width, height, plot, marks, valueScale, percent, theme };
}

const order = (t: ChartSeriesType) => (t === 'area' ? 0 : t === 'bar' ? 1 : t === 'line' ? 2 : 3);

function truncate(text: string, maxWidth: number, size: number, measure: ChartTextMeasure): string {
	if (measure(text, size) <= maxWidth) return text;
	let out = text;
	while (out.length > 1 && measure(`${out}…`, size) > maxWidth) out = out.slice(0, -1);
	return `${out}…`;
}

function layoutLegend(
	items: LegendItem[],
	position: ChartSpec['legend']['position'],
	area: ChartRect,
	theme: ChartTheme,
	measure: ChartTextMeasure,
	marks: ChartMark[],
	legendSelected: boolean
): ChartRect {
	const fs = theme.fontSize;
	const swatch = 10;
	const rowH = fs * 1.7;
	const itemW = (item: LegendItem) => swatch + 6 + measure(item.label, fs) + 14;
	const placed: { item: LegendItem; x: number; y: number }[] = [];
	let box: ChartRect;
	let rest: ChartRect;
	if (position === 'left' || position === 'right') {
		const w = Math.min(area.width * 0.35, Math.max(...items.map(itemW)));
		const h = Math.min(items.length * rowH, area.height);
		const x = position === 'left' ? area.x : area.x + area.width - w;
		const y = area.y + (area.height - h) / 2;
		items.forEach((item, i) => {
			if ((i + 1) * rowH <= area.height + 0.5) placed.push({ item, x, y: y + i * rowH + rowH / 2 });
		});
		box = { x, y, width: w, height: h };
		rest = position === 'left' ? { ...area, x: area.x + w + 8, width: area.width - w - 8 } : { ...area, width: area.width - w - 8 };
	} else {
		// Wrap into rows, each centred.
		const rows: LegendItem[][] = [[]];
		let used = 0;
		for (const item of items) {
			const w = itemW(item);
			if (used + w > area.width && rows[rows.length - 1].length) {
				rows.push([]);
				used = 0;
			}
			rows[rows.length - 1].push(item);
			used += w;
		}
		const shown = rows.slice(0, 3);
		const h = shown.length * rowH;
		const y0 = position === 'top' ? area.y : area.y + area.height - h;
		shown.forEach((row, r) => {
			const total = row.reduce((t, item) => t + itemW(item), 0) - 14;
			let x = area.x + (area.width - total) / 2;
			for (const item of row) {
				placed.push({ item, x, y: y0 + r * rowH + rowH / 2 });
				x += itemW(item);
			}
		});
		box = { x: area.x, y: y0, width: area.width, height: h };
		rest = position === 'top' ? { ...area, y: area.y + h + 6, height: area.height - h - 6 } : { ...area, height: area.height - h - 6 };
	}
	placed.forEach(({ item, x, y }, i) => {
		const opacity = item.faded ? 0.4 : undefined;
		if (item.shape === 'line')
			marks.push({ kind: 'line', key: `legend-swatch-${i}`, role: 'legend-swatch', x1: x, y1: y, x2: x + swatch, y2: y, stroke: item.color, strokeWidth: 2.5, opacity, target: item.target, selected: item.selected });
		else
			marks.push({ kind: 'rect', key: `legend-swatch-${i}`, role: 'legend-swatch', x, y: y - swatch / 2, width: swatch, height: swatch, radius: 2, fill: item.color, opacity, target: item.target, selected: item.selected });
		marks.push({
			kind: 'text',
			key: `legend-label-${i}`,
			role: 'legend-label',
			x: x + swatch + 6,
			y,
			text: item.label,
			anchor: 'start',
			baseline: 'middle',
			size: fs,
			fill: item.selected ? theme.selection : theme.text,
			weight: item.selected ? 600 : undefined,
			opacity,
			target: item.target,
			selected: item.selected
		});
	});
	if (legendSelected) marks.push({ kind: 'rect', key: 'legend-selection', role: 'selection', x: box.x - 4, y: box.y - 2, width: box.width + 8, height: box.height + 4, fill: 'none', stroke: theme.selection, strokeWidth: 1, radius: 3 });
	return rest;
}

function layoutPie(
	spec: ChartSpec,
	series: ChartSeries,
	area: ChartRect,
	theme: ChartTheme,
	marks: ChartMark[],
	selection: ChartSelection | null,
	width: number,
	height: number
): ChartScene {
	const fs = theme.fontSize;
	const values = spec.categories.map((_, i) => Math.max(0, series.values[i] ?? 0));
	const total = values.reduce((a, b) => a + b, 0);
	const labelRoom = spec.dataLabels ? fs * 2.2 : 4;
	const outer = Math.max(4, Math.min(area.width, area.height) / 2 - labelRoom);
	const inner = spec.type === 'donut' ? outer * spec.innerRadius : 0;
	const cx = area.x + area.width / 2;
	const cy = area.y + area.height / 2;
	const plot = { x: cx - outer, y: cy - outer, width: outer * 2, height: outer * 2 };
	if (total <= 0) {
		marks.push({ kind: 'text', key: 'empty', role: 'empty', x: cx, y: cy, text: 'No positive values', anchor: 'middle', baseline: 'middle', size: fs + 1, fill: theme.mutedText });
		return { width, height, plot, marks, percent: false, theme };
	}
	let angle = 0;
	const format = spec.yAxis.format;
	values.forEach((v, i) => {
		if (v <= 0) return;
		const sweep = (v / total) * Math.PI * 2;
		const start = angle;
		const end = angle + sweep;
		angle = end;
		const target: ChartSelection = { kind: 'point', seriesId: series.id, index: i };
		const selected = sameChartSelection(selection, target) || sameChartSelection(selection, { kind: 'category', index: i });
		const seriesSel = selection?.kind === 'series' && selection.seriesId === series.id;
		// The selected slice pops out a little.
		const mid = (start + end) / 2;
		const off = selected ? 6 : 0;
		const ox = cx + off * Math.sin(mid);
		const oy = cy - off * Math.cos(mid);
		marks.push({
			kind: 'path',
			key: `slice-${i}`,
			role: 'slice',
			d: arcPath(ox, oy, outer, inner, start, end),
			fill: chartSliceColor(spec, i),
			stroke: selected || seriesSel ? theme.selection : theme.surface,
			strokeWidth: selected || seriesSel ? 2 : 1,
			target,
			selected: selected || seriesSel
		});
		if (spec.dataLabels && sweep > 0.12) {
			const share = v / total;
			const text = format.style ? formatChartNumber(v, format) : `${Math.round(share * 100)}%`;
			const lr = outer + fs * 1.1;
			const lx = ox + lr * Math.sin(mid);
			const ly = oy - lr * Math.cos(mid);
			const anchor = Math.abs(Math.sin(mid)) < 0.2 ? 'middle' : Math.sin(mid) > 0 ? 'start' : 'end';
			marks.push({ kind: 'text', key: `label-slice-${i}`, role: 'data-label', x: lx, y: ly, text, anchor, baseline: 'middle', size: fs, fill: theme.text, target });
		}
	});
	if (spec.type === 'donut' && inner > fs * 2) {
		marks.push({ kind: 'text', key: 'donut-total', role: 'data-label', x: cx, y: cy, text: formatChartNumber(total, format), anchor: 'middle', baseline: 'middle', size: Math.min(theme.titleSize + 4, inner / 2), weight: 600, fill: theme.text, target: { kind: 'series', seriesId: series.id } });
	}
	return { width, height, plot, marks, percent: false, theme };
}

/**
 * The data value at a scene point along the value axis (for dragging a bar or point), or
 * `undefined` when the scene has no value scale or is percent-stacked.
 */
export function chartValueAtPoint(scene: ChartScene, point: { x: number; y: number }): number | undefined {
	const scale = scene.valueScale;
	if (!scale || scene.percent) return undefined;
	const px = scale.axis === 'y' ? point.y : point.x;
	return linearMap(px, scale.range, scale.domain);
}

/** The value a drag should store: snapped to a tenth of the tick step (or `step`) and kept finite. */
export function snapChartValue(scene: ChartScene, value: number, step?: number): number {
	const ticks = scene.valueScale?.ticks ?? [];
	const unit = step ?? (ticks.length > 1 ? (ticks[1] - ticks[0]) / 10 : 1);
	if (!(unit > 0)) return value;
	const snapped = Math.round(value / unit) * unit;
	return Number(snapped.toPrecision(12));
}
