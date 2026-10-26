// The legend height cap and the final non-finite pass follow gridcraft-main/crates/chart/src/render.rs
// (`legend`, `finalize`) (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { layoutCartesian, layoutXy, trendlineLegendItems } from './layout-cartesian.js';
import { applyHighlight, chartAnnotationFamily, drawCallouts, drawNote, noteHeight } from './layout-annotations.js';
import { layoutBox, layoutFunnel, layoutHistogram, layoutPie, layoutRadar, layoutTreemap, layoutWaterfall } from './layout-families.js';
import { estimateChartTextWidth, sameChartSelection, type ChartLayoutOptions, type FamilyResult, type LayoutCtx } from './layout-shared.js';
import { chartScaleFromPixel, formatChartNumber } from './scale.js';
import { chartSpecColorsByCategory, chartFamily, chartVariesColors, chartSeriesColor, chartSeriesType, chartSliceColor, DEFAULT_CHART_THEME } from './spec.js';
import type { ChartMark, ChartRect, ChartScene, ChartSelection, ChartSpec, ChartTheme, ChartWarning } from './types.js';

export { contrastingTextColor, estimateChartTextWidth, sameChartSelection, type ChartLayoutOptions, type ChartTextMeasure } from './layout-shared.js';

interface LegendItem {
	label: string;
	color: string;
	target: ChartSelection;
	faded: boolean;
	selected: boolean;
	shape: 'square' | 'line' | 'dash';
}

function legendItems(spec: ChartSpec, ctx: LayoutCtx): LegendItem[] {
	const family = chartFamily(spec);
	// Funnel bars are labelled along the side already.
	if (spec.type === 'funnel') return [];
	if (chartSpecColorsByCategory(spec)) {
		const first = spec.series.find((s) => !s.hidden);
		return spec.categories.map((c, i) => ({
			label: c,
			color: first?.pointColors?.[i] || chartSliceColor(spec, i),
			target: { kind: 'category', index: i },
			faded: false,
			selected: ctx.isSelected({ kind: 'category', index: i }),
			shape: 'square'
		}));
	}
	if (family === 'waterfall') {
		const first = spec.series.find((s) => !s.hidden);
		if (!first) return [];
		const target: ChartSelection = { kind: 'series', seriesId: first.id };
		return [
			{ label: 'Increase', color: ctx.theme.positive, target, faded: false, selected: false, shape: 'square' },
			{ label: 'Decrease', color: ctx.theme.negative, target, faded: false, selected: false, shape: 'square' },
			{ label: 'Total', color: chartSeriesColor(spec, spec.series.indexOf(first)), target, faded: false, selected: false, shape: 'square' }
		];
	}
	if (family === 'box') return [];
	const trends = trendlineLegendItems(spec, (i) => chartSeriesColor(spec, i));
	const items: LegendItem[] = [];
	spec.series.forEach((s, i) => {
		const type = chartSeriesType(spec, s);
		items.push({
			label: s.name,
			color: chartSeriesColor(spec, i),
			target: { kind: 'series', seriesId: s.id },
			faded: !!s.hidden,
			selected: ctx.seriesSelected(s.id),
			shape: family === 'cartesian' || family === 'xy' || family === 'radar' ? (type === 'line' ? 'line' : 'square') : 'square'
		});
		for (const t of trends.filter((t) => t.after === s.id)) items.push({ label: t.label, color: t.color, target: t.target, faded: false, selected: ctx.isSelected(t.target), shape: 'dash' });
	});
	return items;
}

/**
 * Lays a chart out as drawing primitives (rects, paths, circles, lines and text) in a
 * `width × height` box. Pure and DOM-free: the React and Svelte canvases render the marks
 * as SVG, `chartSceneToSvg` writes them as a string, and anything else (canvas, PDF) can
 * draw them too. Clickable marks carry the `target` they select; what had to be left out
 * (hidden labels, thinned lines) is listed in `warnings`.
 */
export function layoutChart(spec: ChartSpec, options: ChartLayoutOptions): ChartScene {
	const width = Math.max(1, Number.isFinite(options.width) ? options.width : 1);
	const height = Math.max(1, Number.isFinite(options.height) ? options.height : 1);
	const theme: ChartTheme = { ...DEFAULT_CHART_THEME, ...options.theme };
	const selection = options.selection ?? null;
	const marks: ChartMark[] = [];
	const warnings: ChartWarning[] = [];
	const ctx: LayoutCtx = {
		spec,
		options,
		theme,
		measure: options.measureText ?? estimateChartTextWidth,
		fs: theme.fontSize,
		width,
		height,
		marks,
		warnings,
		selection,
		isSelected: (target) => sameChartSelection(selection, target),
		seriesSelected: (id) => selection?.kind === 'series' && selection.seriesId === id,
		outline: (key, box) => marks.push({ kind: 'rect', key, role: 'selection', ...box, fill: 'none', stroke: theme.selection, strokeWidth: 1, radius: 3 }),
		warn: (code, message) => {
			if (!warnings.some((w) => w.code === code && w.message === message)) warnings.push({ code, message });
		}
	};
	const pad = 12;
	const fs = theme.fontSize;

	marks.push({ kind: 'rect', key: 'background', role: 'background', x: 0, y: 0, width, height, fill: theme.background, target: { kind: 'chart' } });

	// Titles ----------------------------------------------------------------
	let top = pad;
	const titleMark = (kind: 'title' | 'subtitle', label: string, size: number, weight: number, fill: string) => {
		const target: ChartSelection = { kind };
		const selected = ctx.isSelected(target);
		marks.push({ kind: 'text', key: kind, role: kind, x: width / 2, y: top, text: label, anchor: 'middle', baseline: 'top', size, weight, fill, target, selected });
		if (selected) {
			const w = ctx.measure(label, size, weight);
			ctx.outline(`${kind}-selection`, { x: width / 2 - w / 2 - 4, y: top - 3, width: w + 8, height: size * 1.25 + 6 });
		}
		top += size * 1.35;
	};
	if (spec.title) titleMark('title', spec.title, theme.titleSize, 600, theme.text);
	if (spec.subtitle) titleMark('subtitle', spec.subtitle, fs + 1, 400, theme.mutedText);
	if (spec.title || spec.subtitle) top += 6;

	const family = chartFamily(spec);
	const visible = spec.series.filter((s) => !s.hidden);

	// Legend ----------------------------------------------------------------
	const items = legendItems(spec, ctx);
	let area: ChartRect = { x: pad, y: top, width: width - pad * 2, height: height - top - pad - noteHeight(spec, fs) };
	const seriesLegend = family === 'cartesian' || family === 'xy' || family === 'radar' || family === 'histogram';
	const hasTrend = items.some((i) => i.shape === 'dash');
	const showLegend = spec.legend.show && items.length > 0 && (!seriesLegend || chartVariesColors(spec) || spec.series.length > 1 || spec.series.some((s) => s.hidden) || hasTrend);
	if (showLegend) area = layoutLegend(items, spec.legend.position, area, ctx, ctx.isSelected({ kind: 'legend' }));

	const finish = (result: FamilyResult): ChartScene => {
		if (result.plot.width > 0) {
			if (chartAnnotationFamily(chartFamily(spec))) drawCallouts(ctx, result.plot);
			else if (spec.referenceLines.length || spec.referenceBands.length || spec.series.some((s) => s.callouts))
				ctx.warn('annotations-skipped', `Reference lines, bands and callouts are drawn on bar, line, area, scatter and bubble charts; this ${spec.type} chart leaves them out.`);
		}
		applyHighlight(ctx);
		drawNote(ctx, pad);
		if (options.readout) addReadout(ctx, options.readout, result.plot);
		const kept = finalizeMarks(marks, width, height);
		if (kept.length < marks.length) ctx.warn('values-skipped', `${marks.length - kept.length} mark${marks.length - kept.length === 1 ? ' was' : 's were'} left out: their values are not finite numbers.`);
		return {
			width,
			height,
			plot: result.plot,
			marks: kept,
			percent: result.percent ?? false,
			theme,
			warnings,
			...(result.valueScale ? { valueScale: result.valueScale } : {}),
			...(result.valueScale2 ? { valueScale2: result.valueScale2 } : {}),
			...(result.xScale ? { xScale: result.xScale } : {})
		};
	};
	const empty = (message: string) => {
		marks.push({ kind: 'text', key: 'empty', role: 'empty', x: area.x + area.width / 2, y: area.y + area.height / 2, text: message, anchor: 'middle', baseline: 'middle', size: fs + 1, fill: theme.mutedText });
		return finish({ plot: { x: area.x, y: area.y, width: 0, height: 0 } });
	};
	const hasData = visible.some((s) => s.values.some((v) => v !== null && Number.isFinite(v)));
	const needsCategories = family !== 'histogram' && family !== 'box' && family !== 'xy';
	if ((needsCategories && !spec.categories.length) || !visible.length || !hasData) return empty(options.emptyMessage ?? 'No data');

	switch (family) {
		case 'pie':
			return finish(layoutPie(ctx, area, visible[0]));
		case 'radar':
			if (spec.categories.length < 3) {
				ctx.warn('type-fallback', 'A radar chart needs at least 3 categories; it is drawn as a line chart until then.');
				return finish(layoutCartesian(ctx, area, visible));
			}
			return finish(layoutRadar(ctx, area, visible));
		case 'waterfall':
			return finish(layoutWaterfall(ctx, area, visible[0]));
		case 'histogram':
			return finish(layoutHistogram(ctx, area, visible));
		case 'box':
			return finish(layoutBox(ctx, area, visible));
		case 'funnel':
			return finish(layoutFunnel(ctx, area, visible[0]));
		case 'treemap':
			return finish(layoutTreemap(ctx, area, visible[0]));
		case 'xy':
			return finish(layoutXy(ctx, area, visible));
		default:
			return finish(layoutCartesian(ctx, area, visible));
	}
}

function layoutLegend(items: LegendItem[], position: ChartSpec['legend']['position'], area: ChartRect, ctx: LayoutCtx, legendSelected: boolean): ChartRect {
	const { theme, measure, marks } = ctx;
	const fs = theme.fontSize;
	const swatch = 10;
	const rowH = fs * 1.7;
	const itemW = (item: LegendItem) => swatch + 6 + measure(item.label, fs) + 14;
	const placed: { item: LegendItem; x: number; y: number }[] = [];
	let box: ChartRect;
	let rest: ChartRect;
	if (position === 'left' || position === 'right') {
		const w = Math.min(area.width * 0.35, Math.max(...items.map(itemW)));
		const fit = Math.max(1, Math.floor((area.height + 0.5) / rowH));
		const shown = items.slice(0, fit);
		const h = Math.min(shown.length * rowH, area.height);
		const x = position === 'left' ? area.x : area.x + area.width - w;
		const y = area.y + (area.height - h) / 2;
		shown.forEach((item, i) => placed.push({ item, x, y: y + i * rowH + rowH / 2 }));
		if (shown.length < items.length) ctx.warn('legend-truncated', `The legend shows ${shown.length} of ${items.length} entries; the chart is too short for the rest.`);
		box = { x, y, width: w, height: h };
		rest = position === 'left' ? { ...area, x: area.x + w + 8, width: area.width - w - 8 } : { ...area, width: area.width - w - 8 };
	} else {
		// Wrap into rows, each centred; at most 30% of the chart height.
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
		const maxRows = Math.max(1, Math.floor((ctx.height * 0.3) / rowH));
		const shown = rows.slice(0, maxRows);
		const hiddenCount = rows.slice(maxRows).reduce((t, r) => t + r.length, 0);
		if (hiddenCount) ctx.warn('legend-truncated', `The legend shows ${items.length - hiddenCount} of ${items.length} entries; the rest do not fit.`);
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
		if (item.shape === 'line' || item.shape === 'dash')
			marks.push({ kind: 'line', key: `legend-swatch-${i}`, role: 'legend-swatch', x1: x, y1: y, x2: x + swatch, y2: y, stroke: item.color, strokeWidth: item.shape === 'dash' ? 1.5 : 2.5, ...(item.shape === 'dash' ? { dash: '3 2' } : {}), opacity, target: item.target, selected: item.selected });
		else marks.push({ kind: 'rect', key: `legend-swatch-${i}`, role: 'legend-swatch', x, y: y - swatch / 2, width: swatch, height: swatch, radius: 2, fill: item.color, opacity, target: item.target, selected: item.selected });
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

/** Writes the value of a point next to it while it is dragged, kept inside the plot. */
function addReadout(ctx: LayoutCtx, readout: { seriesId: string; index: number }, plot: ChartRect) {
	const { spec, marks, theme, fs, measure } = ctx;
	const series = spec.series.find((s) => s.id === readout.seriesId);
	const value = series?.values[readout.index];
	if (!series || value === null || value === undefined) return;
	const mark = marks.find((m) => (m.role === 'point' || m.role === 'bar') && m.target?.kind === 'point' && m.target.seriesId === readout.seriesId && m.target.index === readout.index);
	if (!mark) return;
	let ax: number;
	let ay: number;
	if (mark.kind === 'rect') {
		ax = mark.x + mark.width / 2;
		ay = mark.y;
	} else if (mark.kind === 'circle') {
		ax = mark.cx;
		ay = mark.cy - mark.r;
	} else return;
	const axis = series.axis === 'secondary' ? spec.yAxis2 : spec.yAxis;
	const x = series.x?.[readout.index];
	const text =
		x !== null && x !== undefined && chartFamily(spec) === 'xy'
			? `${formatChartNumber(x, spec.xAxis.format)}, ${formatChartNumber(value, axis.format)}`
			: `${spec.categories[readout.index] ?? ''}: ${formatChartNumber(value, series.format ?? axis.format)}`;
	const w = measure(text, fs, 600) + 10;
	const h = fs + 8;
	const bx = Math.max(plot.x, Math.min(plot.x + plot.width - w, ax - w / 2));
	const by = Math.max(plot.y, Math.min(plot.y + plot.height - h, ay - h - 6));
	marks.push({ kind: 'rect', key: 'drag-readout-box', role: 'drag-readout', x: bx, y: by, width: w, height: h, fill: theme.text, radius: 3, opacity: 0.9 });
	marks.push({ kind: 'text', key: 'drag-readout', role: 'drag-readout', x: bx + w / 2, y: by + h / 2, text, anchor: 'middle', baseline: 'middle', size: fs, weight: 600, fill: theme.surface });
}

const finite = (...n: (number | undefined)[]) => n.every((v) => v === undefined || Number.isFinite(v));

/** Drops marks with non-finite coordinates (junk data never reaches a renderer) and clamps the rest near the box. */
function finalizeMarks(marks: ChartMark[], width: number, height: number): ChartMark[] {
	const lim = (v: number, size: number) => Math.max(-size * 4, Math.min(size * 5, v));
	const out: ChartMark[] = [];
	for (const m of marks) {
		switch (m.kind) {
			case 'rect':
				if (!finite(m.x, m.y, m.width, m.height)) continue;
				out.push({ ...m, x: lim(m.x, width), y: lim(m.y, height), width: Math.max(0, Math.min(m.width, width * 9)), height: Math.max(0, Math.min(m.height, height * 9)) });
				break;
			case 'circle':
				if (!finite(m.cx, m.cy, m.r)) continue;
				out.push({ ...m, cx: lim(m.cx, width), cy: lim(m.cy, height) });
				break;
			case 'line':
				if (!finite(m.x1, m.y1, m.x2, m.y2)) continue;
				out.push({ ...m, x1: lim(m.x1, width), y1: lim(m.y1, height), x2: lim(m.x2, width), y2: lim(m.y2, height) });
				break;
			case 'text':
				if (!finite(m.x, m.y, m.size)) continue;
				out.push(m);
				break;
			case 'path':
				if (/NaN|Infinity/.test(m.d)) continue;
				out.push(m);
				break;
		}
	}
	return out;
}

/**
 * The data value at a scene point along the value axis (for dragging a bar or point), or
 * `undefined` when the scene has no value scale or is percent-stacked. `secondary` reads the
 * secondary axis. Reversed and logarithmic axes are mapped as drawn.
 */
export function chartValueAtPoint(scene: ChartScene, point: { x: number; y: number }, secondary = false): number | undefined {
	const scale = secondary ? (scene.valueScale2 ?? scene.valueScale) : scene.valueScale;
	if (!scale || scene.percent) return undefined;
	const px = scale.axis === 'y' ? point.y : point.x;
	return chartScaleFromPixel(px, scale);
}

/** The x value at a scene point on a scatter or bubble chart, or `undefined` without a numeric x axis. */
export function chartXAtPoint(scene: ChartScene, point: { x: number; y: number }): number | undefined {
	const scale = scene.xScale;
	if (!scale) return undefined;
	return chartScaleFromPixel(point.x, scale);
}

/**
 * The value a drag should store: snapped to a tenth of the tick step (or `step`) and kept
 * finite. On a logarithmic axis (`logBase`, without a `step`) ticks are not evenly spaced, so
 * the value is rounded to two significant digits instead.
 */
export function snapChartValue(scene: ChartScene, value: number, step?: number, ticks: readonly number[] = scene.valueScale?.ticks ?? [], logBase?: number): number {
	if (logBase && step === undefined) return value > 0 && Number.isFinite(value) ? Number(value.toPrecision(2)) : value;
	const unit = step ?? (ticks.length > 1 ? (ticks[1] - ticks[0]) / 10 : 1);
	if (!(unit > 0)) return value;
	const snapped = Math.round(value / unit) * unit;
	return Number(snapped.toPrecision(12));
}
