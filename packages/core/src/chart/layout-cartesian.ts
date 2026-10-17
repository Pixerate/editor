// Trendline sampling and clipping follow gridcraft-main/crates/chart/src/render.rs (`draw_trendline`,
// `clip_segment`) and the label rules its `on` / fit checks use; marker de-duplication and polyline decimation
// follow its `draw_markers` and `decimate` (MIT OR Apache-2.0, © ArtCraft Team and contributors). See
// THIRD_PARTY_NOTICES.md.
import { chartDateLabels } from './date.js';
import {
	axisScale,
	clippedPolyline,
	contrastingTextColor,
	curvePath,
	markerPath,
	r2,
	truncate,
	type FamilyResult,
	type LayoutCtx,
	type Pt
} from './layout-shared.js';
import { chartErrorAmounts } from './errorbars.js';
import { chartScaleToPixel, formatChartNumber, stepDecimals, type NiceScale } from './scale.js';
import { chartPointColor, chartSeriesColor, chartSeriesType } from './spec.js';
import { decimateChartPoints } from './stats.js';
import { chartMovingAverage, chartSupportsTrendlines, chartTrendlineName, fitChartTrendline, trendNumberText } from './trend.js';
import type { ChartAxis, ChartErrorBars, ChartMark, ChartMarker, ChartNumberFormat, ChartRect, ChartSelection, ChartSeries, ChartSeriesType, ChartValue, ChartValueScale } from './types.js';

/** Data labels are skipped on series with more points than this. */
export const MAX_CHART_DATA_LABELS = 200;
/** Lines with more points than this are thinned per pixel column. */
export const MAX_CHART_LINE_POINTS = 2000;
/** Markers beyond this many are thinned to one per 2px cell. */
export const MAX_CHART_MARKERS = 1000;

export interface ValueAxisInput {
	lo: number;
	hi: number;
	axis: ChartAxis;
	format: ChartNumberFormat;
	frozen?: { min: number; max: number } | null;
	headroom?: boolean;
	/** Which selection the tick labels pick. */
	key: 'y' | 'y2';
}

export interface ScaleInfo {
	scale: NiceScale;
	range: [number, number];
	/** Value → pixel, clamped to the axis. */
	px(v: number): number;
	/** Value → pixel, not clamped. */
	raw(v: number): number;
	/** Pixel of 0 (or the nearest end; the lower end on a log axis). */
	zero: number;
	format: ChartNumberFormat;
	tickText(t: number): string;
	/** Set when the axis is logarithmic. */
	logBase?: number;
}

export interface CategoryFrame {
	plot: ChartRect;
	horizontal: boolean;
	n: number;
	band: number;
	catStart: number;
	catLen: number;
	catCenter(i: number): number;
	map(p: Pt): [number, number];
	value: ScaleInfo;
	value2?: ScaleInfo;
}

export interface CategoryFrameInput {
	labels: readonly string[];
	horizontal: boolean;
	primary: ValueAxisInput;
	secondary?: ValueAxisInput;
	/** What clicking category label `i` selects (default: the category). */
	labelTarget?: (i: number) => ChartSelection | undefined;
	/** Category axis settings (default `spec.xAxis`). */
	categoryAxis?: ChartAxis;
}

/**
 * Value ↔ pixel for one axis: logarithmic when `axis.scale` is `log` (values of 0 or less
 * clamp to the lower end), and running the other way when `axis.reverse` is set.
 */
export function scaleInfo(scale: NiceScale, range: [number, number], format: ChartNumberFormat, axis?: Pick<ChartAxis, 'scale' | 'logBase' | 'reverse'>): ScaleInfo {
	const logBase = axis?.scale === 'log' ? (axis.logBase ?? 10) : undefined;
	const r: [number, number] = axis?.reverse ? [range[1], range[0]] : range;
	const vs = { domain: [scale.min, scale.max] as [number, number], range: r, logBase };
	const raw = (v: number) => chartScaleToPixel(v, vs);
	const px = (v: number) => (logBase && !(v > 0) ? r[0] : raw(Math.min(scale.max, Math.max(scale.min, v))));
	// Log ticks span powers, so each is written with the decimals it needs.
	const tickText = (t: number) => formatChartNumber(t, format, logBase ? format.decimals : (format.decimals ?? stepDecimals(scale.step)));
	return { scale, range: r, px, raw, zero: px(0), format, tickText, ...(logBase ? { logBase } : {}) };
}

/**
 * The axes of a category chart: category labels along one side (rotated, thinned or read as
 * dates as space allows), one or two value axes, grid lines and axis titles. Returns the plot
 * box and value ↔ pixel maps.
 */
export function categoryFrame(ctx: LayoutCtx, area: ChartRect, input: CategoryFrameInput): CategoryFrame {
	const { spec, theme, measure, fs, marks } = ctx;
	const { labels, horizontal, primary, secondary } = input;
	const xAxis = input.categoryAxis ?? spec.xAxis;
	const n = Math.max(1, labels.length);
	const titleBand = fs * 1.3 + 6;
	const labelTarget = input.labelTarget ?? ((i: number) => ({ kind: 'category', index: i }) as ChartSelection);

	const estimate = (v: ValueAxisInput, length: number) => {
		const s = axisScale(v.lo, v.hi, length, v.axis, v.frozen, v.headroom);
		const info = scaleInfo(s, [0, 1], v.format, v.axis);
		return Math.max(0, ...s.ticks.map((t) => measure(info.tickText(t), fs)));
	};
	const valueLen0 = horizontal ? area.width : area.height;
	const valueLabelWidth = primary.axis.show ? estimate(primary, valueLen0) : 0;
	const valueLabelWidth2 = secondary?.axis.show ? estimate(secondary, valueLen0) : 0;
	const catLabelWidth = Math.max(0, ...labels.map((c) => measure(c, fs)));

	let left: number;
	let bottom: number;
	let right = 8;
	let top = horizontal ? 4 : fs / 2 + 2;
	let rotate = 0;
	let dateLabels: ReturnType<typeof chartDateLabels> = null;
	let rotatedMax = 0;
	if (horizontal) {
		left = (xAxis.show ? Math.min(catLabelWidth, area.width * 0.35) + 8 : 2) + (xAxis.title ? titleBand : 0);
		bottom = (primary.axis.show ? fs * 1.6 : 2) + (primary.axis.title ? titleBand : 0);
		right = Math.max(8, valueLabelWidth / 2);
		if (secondary) top = (secondary.axis.show ? fs * 1.6 : 4) + (secondary.axis.title ? titleBand : 0);
	} else {
		left = (primary.axis.show ? valueLabelWidth + 8 : 2) + (primary.axis.title ? titleBand : 0);
		if (secondary) right = (secondary.axis.show ? valueLabelWidth2 + 8 : 8) + (secondary.axis.title ? titleBand : 0);
		const band = (area.width - left - right) / n;
		if (xAxis.show && xAxis.kind === 'date') dateLabels = chartDateLabels(labels, band, (t) => measure(t, fs));
		if (xAxis.show && !dateLabels && catLabelWidth > band * 0.92) rotate = -40;
		const sin = Math.sin(Math.PI / 4.5);
		const catHeight = rotate ? Math.min(catLabelWidth * sin + fs, area.height * 0.4) : fs * 1.6;
		if (rotate) rotatedMax = (catHeight - fs) / sin;
		bottom = (xAxis.show ? catHeight : 2) + (xAxis.title ? titleBand : 0);
	}
	const plot: ChartRect = {
		x: area.x + left,
		y: area.y + top,
		width: Math.max(1, area.width - left - right),
		height: Math.max(1, area.height - bottom - top)
	};
	const valueLen = horizontal ? plot.width : plot.height;
	const range: [number, number] = horizontal ? [plot.x, plot.x + plot.width] : [plot.y + plot.height, plot.y];
	const value = scaleInfo(axisScale(primary.lo, primary.hi, valueLen, primary.axis, primary.frozen, primary.headroom), range, primary.format, primary.axis);
	const value2 = secondary ? scaleInfo(axisScale(secondary.lo, secondary.hi, valueLen, secondary.axis, secondary.frozen, secondary.headroom), range, secondary.format, secondary.axis) : undefined;

	const catStart = horizontal ? plot.y : plot.x;
	const catLen = horizontal ? plot.height : plot.width;
	const band = catLen / n;
	// A reversed category axis runs from the far end; `i` may be fractional (trendlines).
	const catCenter = (i: number) => catStart + band * (xAxis.reverse ? n - i - 0.5 : i + 0.5);
	const map = (p: Pt): [number, number] => (horizontal ? [p.v, p.c] : [p.c, p.v]);

	// Grid lines
	const gridAt = (info: ScaleInfo, key: string) =>
		info.scale.ticks.forEach((t, i) => {
			const p = info.px(t);
			const [x1, y1] = map({ c: catStart, v: p });
			const [x2, y2] = map({ c: catStart + catLen, v: p });
			marks.push({ kind: 'line', key: `grid-${key}-${i}`, role: 'grid', x1, y1, x2, y2, stroke: theme.grid, strokeWidth: 1 });
		});
	if (primary.axis.gridlines) gridAt(value, 'y');
	if (value2 && secondary!.axis.gridlines) gridAt(value2, 'y2');
	if (xAxis.gridlines) {
		for (let i = 1; i < n; i++) {
			const c = catStart + band * i;
			const [x1, y1] = map({ c, v: range[0] });
			const [x2, y2] = map({ c, v: range[1] });
			marks.push({ kind: 'line', key: `grid-x-${i}`, role: 'grid', x1, y1, x2, y2, stroke: theme.grid, strokeWidth: 1 });
		}
	}

	// Value tick labels
	const ticksFor = (info: ScaleInfo, v: ValueAxisInput, far: boolean) => {
		if (!v.axis.show) return;
		const target: ChartSelection = { kind: 'axis', axis: v.key };
		info.scale.ticks.forEach((t, i) => {
			const p = info.px(t);
			const label = info.tickText(t);
			const key = `tick-${v.key}-${i}`;
			if (horizontal) {
				if (far) marks.push({ kind: 'text', key, role: 'tick-label', x: p, y: plot.y - 6, text: label, anchor: 'middle', baseline: 'bottom', size: fs, fill: theme.mutedText, target });
				else marks.push({ kind: 'text', key, role: 'tick-label', x: p, y: plot.y + plot.height + 6, text: label, anchor: 'middle', baseline: 'top', size: fs, fill: theme.mutedText, target });
			} else if (far) marks.push({ kind: 'text', key, role: 'tick-label', x: plot.x + plot.width + 8, y: p, text: label, anchor: 'start', baseline: 'middle', size: fs, fill: theme.mutedText, target });
			else marks.push({ kind: 'text', key, role: 'tick-label', x: plot.x - 8, y: p, text: label, anchor: 'end', baseline: 'middle', size: fs, fill: theme.mutedText, target });
		});
	};
	ticksFor(value, primary, false);
	if (value2) ticksFor(value2, secondary!, true);

	// Category axis line and labels
	const xTarget: ChartSelection = { kind: 'axis', axis: 'x' };
	if (xAxis.show) {
		const [x1, y1] = map({ c: catStart, v: value.zero });
		const [x2, y2] = map({ c: catStart + catLen, v: value.zero });
		marks.push({ kind: 'line', key: 'axis-x', role: 'axis', x1, y1, x2, y2, stroke: theme.axis, strokeWidth: 1, target: xTarget });
		const every = dateLabels ? 1 : horizontal ? Math.max(1, Math.ceil((fs * 1.3) / band)) : rotate ? Math.max(1, Math.ceil((fs * 1.4) / band)) : 1;
		let hidden = 0;
		let truncated = 0;
		labels.forEach((c, i) => {
			const text0 = dateLabels ? dateLabels.labels.get(i) : i % every ? undefined : c;
			if (text0 === undefined) {
				hidden++;
				return;
			}
			const target = labelTarget(i);
			const selected = target ? ctx.isSelected(target) : false;
			const fill = selected ? theme.selection : theme.mutedText;
			const extra = target ? { target, selected } : {};
			if (horizontal) {
				const maxW = left - (xAxis.title ? titleBand : 0) - 8;
				const text = truncate(text0, maxW, fs, measure);
				if (text !== text0) truncated++;
				marks.push({ kind: 'text', key: `tick-x-${i}`, role: 'tick-label', x: plot.x - 8, y: catCenter(i), text, anchor: 'end', baseline: 'middle', size: fs, fill, ...extra });
			} else if (rotate) {
				// Rotated labels run down and to the left: keep them inside the chart.
				const room = (catCenter(i) - 2) / Math.cos(Math.PI / 4.5);
				const text = truncate(text0, Math.max(fs, Math.min(rotatedMax, room)), fs, measure);
				if (text !== text0) truncated++;
				marks.push({ kind: 'text', key: `tick-x-${i}`, role: 'tick-label', x: catCenter(i), y: plot.y + plot.height + 8, text, anchor: 'end', baseline: 'middle', size: fs, fill, rotate, ...extra });
			} else {
				const text = dateLabels ? text0 : truncate(text0, Math.max(band - 4, fs * 2), fs, measure);
				if (text !== text0) truncated++;
				marks.push({ kind: 'text', key: `tick-x-${i}`, role: 'tick-label', x: catCenter(i), y: plot.y + plot.height + 6, text, anchor: dateLabels ? 'start' : 'middle', baseline: 'top', size: fs, fill, ...extra });
			}
		});
		if (dateLabels) {
			// Date labels sit at the start of their bucket; mark it with a short tick.
			for (const i of dateLabels.indexes) {
				const x = catCenter(i);
				marks.push({ kind: 'line', key: `tick-mark-x-${i}`, role: 'tick', x1: x, y1: plot.y + plot.height, x2: x, y2: plot.y + plot.height + 4, stroke: theme.axis, strokeWidth: 1 });
			}
		}
		if (hidden && !dateLabels) ctx.warn('labels-hidden', `${hidden} of ${labels.length} category labels are hidden so the rest do not overlap.`);
		if (truncated) ctx.warn('labels-truncated', `${truncated} category label${truncated === 1 ? ' was' : 's were'} shortened to fit.`);
	}

	// Axis titles: category title beside the category labels, value titles beside their ticks.
	const yTarget: ChartSelection = { kind: 'axis', axis: 'y' };
	const valueTitle = primary.axis.title;
	const catTitle = xAxis.title;
	const bottomTitle = horizontal ? valueTitle : catTitle;
	const leftTitle = horizontal ? catTitle : valueTitle;
	if (bottomTitle)
		marks.push({ kind: 'text', key: `axis-title-${horizontal ? 'y' : 'x'}`, role: 'axis-title', x: plot.x + plot.width / 2, y: area.y + area.height, text: bottomTitle, anchor: 'middle', baseline: 'bottom', size: fs + 1, weight: 500, fill: theme.text, target: horizontal ? yTarget : xTarget });
	if (leftTitle)
		marks.push({ kind: 'text', key: `axis-title-${horizontal ? 'x' : 'y'}`, role: 'axis-title', x: area.x, y: plot.y + plot.height / 2, text: leftTitle, anchor: 'middle', baseline: 'top', size: fs + 1, weight: 500, fill: theme.text, rotate: -90, target: horizontal ? xTarget : yTarget });
	if (secondary?.axis.title) {
		const target: ChartSelection = { kind: 'axis', axis: 'y2' };
		if (horizontal) marks.push({ kind: 'text', key: 'axis-title-y2', role: 'axis-title', x: plot.x + plot.width / 2, y: area.y, text: secondary.axis.title, anchor: 'middle', baseline: 'top', size: fs + 1, weight: 500, fill: theme.text, target });
		else marks.push({ kind: 'text', key: 'axis-title-y2', role: 'axis-title', x: area.x + area.width, y: plot.y + plot.height / 2, text: secondary.axis.title, anchor: 'middle', baseline: 'top', size: fs + 1, weight: 500, fill: theme.text, rotate: 90, target });
	}
	// The selected axis gets an outline around its labels.
	for (const axis of ['x', 'y', 'y2'] as const) {
		if (!ctx.isSelected({ kind: 'axis', axis })) continue;
		if (axis === 'y2' && !secondary) continue;
		let box: ChartRect;
		if (axis === 'y2') box = horizontal ? { x: plot.x - 4, y: area.y, width: plot.width + 8, height: plot.y - area.y - 2 } : { x: plot.x + plot.width + 2, y: plot.y - fs / 2, width: area.x + area.width - plot.x - plot.width - 2, height: plot.height + fs };
		else {
			const onLeft = (axis === 'y') !== horizontal;
			box = onLeft
				? { x: area.x, y: plot.y - fs / 2, width: left - 2, height: plot.height + fs }
				: { x: plot.x - 4, y: plot.y + plot.height + 2, width: plot.width + 8, height: area.y + area.height - plot.y - plot.height - 2 };
		}
		ctx.outline(`axis-${axis}-selection`, box);
	}
	return { plot, horizontal, n, band, catStart, catLen, catCenter, map, value, value2 };
}

export const toValueScale = (info: ScaleInfo, axis: 'x' | 'y'): ChartValueScale => ({ axis, domain: [info.scale.min, info.scale.max], range: info.range, ticks: info.scale.ticks, ...(info.logBase ? { logBase: info.logBase } : {}) });

type ChartErrorAmountLike = ReturnType<typeof chartErrorAmounts>[number];

/** An error bar in value units: its centre and ends. */
interface ErrorSpan {
	center: number;
	lo: number;
	hi: number;
}

/**
 * One error bar as path data: a stem from pixel `a` to `b` along the value direction at `c`
 * across it, with caps `width` wide at the ends that have them. `map` turns (across, along)
 * into x / y.
 */
function errorBarPath(map: (p: Pt) => [number, number], c: number, a: number, b: number, width: number, capA: boolean, capB: boolean): string {
	if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || (Math.abs(a - b) < 0.01 && !capA && !capB)) return '';
	const at = (across: number, along: number) => map({ c: across, v: along }).map(r2).join(',');
	let d = `M${at(c, a)}L${at(c, b)}`;
	if (capA) d += `M${at(c - width / 2, a)}L${at(c + width / 2, a)}`;
	if (capB) d += `M${at(c - width / 2, b)}L${at(c + width / 2, b)}`;
	return d;
}

interface Stack {
	/** Per category: [bottom, top] of this series' segment, or null for a gap. */
	segments: ([number, number] | null)[];
}

const order = (t: ChartSeriesType) => (t === 'area' ? 0 : t === 'bar' ? 1 : t === 'line' ? 2 : 3);

/** A point marker: a circle mark, or a path for other shapes. */
export function pointMark(base: { key: string; target?: ChartSelection; selected?: boolean; opacity?: number }, shape: ChartMarker | 'hit', cx: number, cy: number, r: number, fill: string, stroke?: string, strokeWidth?: number): ChartMark {
	if (shape === 'circle' || shape === 'hit' || shape === 'none') return { kind: 'circle', role: 'point', ...base, cx, cy, r, fill, ...(stroke ? { stroke, strokeWidth } : {}) };
	const closed = shape !== 'cross';
	return { kind: 'path', role: 'point', ...base, d: markerPath(shape, cx, cy, r), fill: closed ? fill : 'none', stroke: stroke ?? fill, strokeWidth: strokeWidth ?? 2 };
}

interface TrendLabel {
	text: string;
	color: string;
	target: ChartSelection;
}

/**
 * Draws the trendlines of one series: `points` in data units, `toPx` maps them to the scene,
 * `xRange` is the fitted span (extended by forward/backward).
 */
function drawTrendlines(ctx: LayoutCtx, plot: ChartRect, series: ChartSeries, color: string, points: [number, number][], toPx: (x: number, y: number) => [number, number], labels: TrendLabel[], logAxis = false) {
	(series.trendlines ?? []).forEach((t, ti) => {
		const target: ChartSelection = { kind: 'trendline', seriesId: series.id, index: ti };
		const selected = ctx.isSelected(target);
		const stroke = t.color ?? color;
		let px: [number, number][] = [];
		const finitePx = (q: [number, number]) => Number.isFinite(q[0]) && Number.isFinite(q[1]);
		if (t.type === 'moving-average') px = chartMovingAverage(points, t.period ?? 2).map(([x, y]) => toPx(x, y)).filter(finitePx);
		else {
			const fit = fitChartTrendline(t, points);
			if (!fit) {
				ctx.warn('values-skipped', `The ${t.type} trendline on "${series.name}" could not be fitted (too few usable points).`);
				return;
			}
			const xs = points.map((p) => p[0]);
			const lo = Math.min(...xs) - (t.backward ?? 0);
			const hi = Math.max(...xs) + (t.forward ?? 0);
			// A straight fit is a curve on a log axis: sample it like the others.
			const steps = t.type === 'linear' && !logAxis ? 1 : 200;
			for (let k = 0; k <= steps; k++) {
				const x = lo + ((hi - lo) * k) / steps;
				const y = fit.evaluate(x);
				const q = y === null ? null : toPx(x, y);
				// Log axes have no pixel for values of 0 or less.
				if (q && finitePx(q)) px.push(q);
			}
			if (t.showEquation) labels.push({ text: fit.equation, color: stroke, target });
			if (t.showR2) labels.push({ text: fit.r2 === null ? 'R² = #N/A' : `R² = ${trendNumberText(fit.r2)}`, color: stroke, target });
		}
		const d = clippedPolyline(px, plot);
		if (!d) return;
		ctx.marks.push({ kind: 'path', key: `trendline-${series.id}-${ti}`, role: 'trendline', d, fill: 'none', stroke, strokeWidth: selected ? 3 : 1.5, dash: '6 4', target, selected });
	});
}

function drawTrendLabels(ctx: LayoutCtx, plot: ChartRect, labels: TrendLabel[]) {
	labels.forEach((l, i) =>
		ctx.marks.push({ kind: 'text', key: `trendline-label-${i}`, role: 'trendline-label', x: plot.x + plot.width - 4, y: plot.y + 4 + i * (ctx.fs + 3), text: l.text, anchor: 'end', baseline: 'top', size: ctx.fs - 1, fill: l.color, target: l.target })
	);
}

/** Where a bar's value label goes, or null when it does not fit. */
function barLabel(ctx: LayoutCtx, text: string, rect: ChartRect, horizontal: boolean, positive: boolean, stacked: boolean, fill: string, plot: ChartRect): { x: number; y: number; anchor: 'start' | 'middle' | 'end'; baseline: 'top' | 'middle' | 'bottom'; fill: string } | null {
	const { measure, fs, spec, theme } = ctx;
	const size = fs - 1;
	const tw = measure(text, size);
	const th = size + 2;
	const along = horizontal ? rect.width : rect.height;
	const across = horizontal ? rect.height : rect.width;
	const need = horizontal ? tw + 6 : th + 2;
	const fitsInside = along >= need && across >= (horizontal ? th : Math.min(tw, across + 1));
	let position = spec.labelPosition;
	if (position === 'auto') position = stacked ? 'center' : 'outside';
	const cx = rect.x + rect.width / 2;
	const cy = rect.y + rect.height / 2;
	const inner = contrastingTextColor(fill);
	const centre = () => ({ x: cx, y: cy, anchor: 'middle' as const, baseline: 'middle' as const, fill: inner });
	const insideEnd = () =>
		horizontal
			? { x: positive ? rect.x + rect.width - 4 : rect.x + 4, y: cy, anchor: (positive ? 'end' : 'start') as 'end' | 'start', baseline: 'middle' as const, fill: inner }
			: { x: cx, y: positive ? rect.y + 3 : rect.y + rect.height - 3, anchor: 'middle' as const, baseline: (positive ? 'top' : 'bottom') as 'top' | 'bottom', fill: inner };
	const outside = () =>
		horizontal
			? { x: positive ? rect.x + rect.width + 4 : rect.x - 4, y: cy, anchor: (positive ? 'start' : 'end') as 'start' | 'end', baseline: 'middle' as const, fill: theme.text }
			: { x: cx, y: positive ? rect.y - 4 : rect.y + rect.height + 4, anchor: 'middle' as const, baseline: (positive ? 'bottom' : 'top') as 'bottom' | 'top', fill: theme.text };
	const outsideFits = () => {
		if (horizontal) return positive ? rect.x + rect.width + 4 + tw <= plot.x + plot.width + 8 : rect.x - 4 - tw >= plot.x - 8;
		return positive ? rect.y - 4 - th >= plot.y - fs : rect.y + rect.height + 4 + th <= plot.y + plot.height + fs;
	};
	if (position === 'center') return fitsInside ? centre() : null;
	if (position === 'inside') return fitsInside ? insideEnd() : stacked ? null : outside();
	// outside
	if (stacked) return fitsInside ? centre() : null;
	if (outsideFits()) return outside();
	return fitsInside ? insideEnd() : null;
}

/** Bar, line, area and scatter series over categories (a combo chart when they mix). */
export function layoutCartesian(ctx: LayoutCtx, area: ChartRect, visible: ChartSeries[]): FamilyResult {
	const { spec, theme, marks, measure, fs } = ctx;
	const horizontal = spec.orientation === 'horizontal';
	const n = spec.categories.length;
	const types = new Map<string, ChartSeriesType>(visible.map((s) => [s.id, chartSeriesType(spec, s)]));
	const stacked = spec.stacking !== 'none';
	const percent = spec.stacking === 'percent';
	const onSecondary = (s: ChartSeries) => s.axis === 'secondary';
	const useSecondary = visible.some(onSecondary);

	// Stack bars together and areas together, per axis (lines and scatter are never stacked).
	const stacks = new Map<string, Stack>();
	if (stacked) {
		for (const kind of ['bar', 'area'] as const) {
			for (const secondary of [false, true]) {
				const group = visible.filter((s) => types.get(s.id) === kind && onSecondary(s) === secondary);
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
	}

	const logOf = (secondary: boolean) => (secondary ? spec.yAxis2 : spec.yAxis).scale === 'log';
	// Error bars in value units where they are drawn: on stack tops, scaled to shares when percent-stacked.
	const errors = new Map<string, (ErrorSpan | null)[]>();
	for (const s of visible) {
		if (!s.errorBars) continue;
		const stack = stacks.get(s.id);
		errors.set(
			s.id,
			chartErrorAmounts(s.errorBars, s.values).map((e, i) => {
				const raw = s.values[i];
				const seg = stack?.segments[i];
				if (!e || raw === null || (stack && !seg)) return null;
				const k = seg && percent ? (raw ? (seg[1] - seg[0]) / raw : 0) : 1;
				const center = (seg ? seg[1] : raw) + (e.center - raw) * k;
				return { center, lo: center - e.minus * k, hi: center + e.plus * k };
			})
		);
	}

	const range = (secondary: boolean) => {
		let lo = Infinity;
		let hi = -Infinity;
		const log = logOf(secondary);
		const see = (v: number) => {
			if (!Number.isFinite(v) || (log && !(v > 0))) return;
			lo = Math.min(lo, v);
			hi = Math.max(hi, v);
		};
		const group = visible.filter((s) => onSecondary(s) === secondary);
		for (const s of group) {
			const stack = stacks.get(s.id);
			if (stack) stack.segments.forEach((seg) => seg && (see(seg[0]), see(seg[1])));
			else s.values.forEach((v) => v !== null && see(v));
			errors.get(s.id)?.forEach((e) => e && (see(e.lo), see(e.hi)));
		}
		if (log) {
			const skipped = group.reduce((t, s) => t + s.values.filter((v) => v !== null && Number.isFinite(v) && v <= 0).length, 0);
			if (skipped) ctx.warn('values-skipped', `${skipped} value${skipped === 1 ? '' : 's'} of 0 or less cannot be drawn on the logarithmic ${secondary ? 'secondary ' : ''}value axis and ${skipped === 1 ? 'was' : 'were'} skipped.`);
		}
		if (!Number.isFinite(lo)) {
			lo = log ? 1 : 0;
			hi = log ? 10 : 1;
		}
		if (!log && group.some((s) => types.get(s.id) === 'bar' || types.get(s.id) === 'area')) {
			lo = Math.min(lo, 0);
			hi = Math.max(hi, 0);
		}
		const lineLike = group.some((s) => types.get(s.id) === 'line' || types.get(s.id) === 'scatter');
		return { lo, hi, lineLike };
	};
	const pctFormat = (f: ChartNumberFormat): ChartNumberFormat => (percent && !f.style && !f.code ? { ...f, style: 'percent' } : f);
	const p = range(false);
	const s2 = useSecondary ? range(true) : null;
	const frame = categoryFrame(ctx, area, {
		labels: spec.categories,
		horizontal,
		primary: { lo: p.lo, hi: p.hi, axis: spec.yAxis, format: pctFormat(spec.yAxis.format), frozen: ctx.options.valueDomain, headroom: p.lineLike, key: 'y' },
		secondary: s2 ? { lo: s2.lo, hi: s2.hi, axis: spec.yAxis2, format: pctFormat(spec.yAxis2.format), frozen: ctx.options.valueDomain2, headroom: s2.lineLike, key: 'y2' } : undefined
	});
	const { plot, band, catCenter, map, catStart } = frame;
	const infoOf = (s: ChartSeries) => (onSecondary(s) && frame.value2 ? frame.value2 : frame.value);

	// Bars: groups take (1 - gapWidth) of each category; bars in a group overlap by `overlap`.
	const bars = visible.filter((s) => types.get(s.id) === 'bar');
	const barAxes = [...new Set(bars.map((s) => onSecondary(s)))];
	const slots = stacked ? barAxes.length : bars.length;
	const groupWidth = band * (1 - spec.gapWidth);
	const o = Math.max(-1, Math.min(0.99, spec.overlap));
	const barWidth = slots ? groupWidth / (slots - (slots - 1) * o) : 0;
	const slotOf = (s: ChartSeries) => (stacked ? barAxes.indexOf(onSecondary(s)) : bars.indexOf(s));
	const labelMarks: ChartMark[] = [];
	const errorMarks: ChartMark[] = [];
	const trendLabels: TrendLabel[] = [];
	let hiddenLabels = 0;
	const trendsAllowed = chartSupportsTrendlines(spec.type, spec.stacking);

	const drawOrder = [...visible].sort((a, b) => order(types.get(a.id)!) - order(types.get(b.id)!));
	for (const s of drawOrder) {
		const si = spec.series.indexOf(s);
		const color = chartSeriesColor(spec, si);
		const type = types.get(s.id)!;
		const stack = stacks.get(s.id);
		const selSeries = ctx.seriesSelected(s.id);
		const seriesTarget: ChartSelection = { kind: 'series', seriesId: s.id };
		const info = infoOf(s);
		const valuePx = info.px;
		const log = logOf(onSecondary(s));
		const labelsOn = (s.dataLabels ?? spec.dataLabels) && s.values.length <= MAX_CHART_DATA_LABELS;
		if ((s.dataLabels ?? spec.dataLabels) && !labelsOn) ctx.warn('data-labels-hidden', `Data labels are off for "${s.name}": it has more than ${MAX_CHART_DATA_LABELS} points.`);
		const labelFormat = s.format ?? info.format;
		const dataLabel = (v: number) => formatChartNumber(v, labelFormat, labelFormat.decimals ?? undefined);

		if (type === 'bar') {
			const slot = slotOf(s);
			s.values.forEach((raw, i) => {
				const seg = stack ? stack.segments[i] : raw === null ? null : ([0, raw] as [number, number]);
				if (!seg || raw === null || !Number.isFinite(raw)) return;
				if (log && (raw <= 0 || seg[1] <= 0)) return;
				const a = valuePx(seg[0]);
				const b = valuePx(seg[1]);
				const c0 = catCenter(i) - groupWidth / 2 + slot * barWidth * (1 - o);
				const cw = barWidth;
				const target: ChartSelection = { kind: 'point', seriesId: s.id, index: i };
				const selected = ctx.isSelected(target);
				const [x, y] = map({ c: c0, v: Math.min(a, b) });
				const rect = horizontal ? { x: Math.min(a, b), y: c0, width: Math.abs(b - a), height: cw } : { x, y, width: cw, height: Math.abs(b - a) };
				const fill = chartPointColor(spec, si, i);
				marks.push({
					kind: 'rect',
					key: `bar-${s.id}-${i}`,
					role: 'bar',
					...rect,
					fill,
					radius: Math.min(2, cw / 4),
					target,
					selected: selected || selSeries,
					...(selSeries ? { stroke: theme.selection, strokeWidth: 1.5 } : {})
				});
				if (selected) ctx.outline(`bar-${s.id}-${i}-selection`, { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 });
				if (labelsOn) {
					const v = percent ? seg[1] - seg[0] : raw;
					const text = dataLabel(v);
					// Which way the bar grows on screen (reversed and log axes included).
					const grows = horizontal ? b >= a : b <= a;
					const at = barLabel(ctx, text, rect, horizontal, grows, stacked, fill, plot);
					if (!at) {
						hiddenLabels++;
						return;
					}
					labelMarks.push({ kind: 'text', key: `label-${s.id}-${i}`, role: 'data-label', ...at, text, size: fs - 1, target });
				}
			});
		} else {
			// Line, area and scatter share the point positions.
			const curve = s.curve ?? spec.curve;
			const pointValue = (i: number): number | null => {
				const v = stack ? (stack.segments[i]?.[1] ?? null) : s.values[i];
				return v !== null && Number.isFinite(v) && !(log && (v <= 0 || (s.values[i] ?? 0) <= 0)) ? v : null;
			};
			const runs: Pt[][] = [];
			let run: Pt[] = [];
			for (let i = 0; i < n; i++) {
				const v = pointValue(i);
				if (v === null) {
					if (run.length) runs.push(run);
					run = [];
					continue;
				}
				run.push({ c: catCenter(i), v: valuePx(v), i });
			}
			if (run.length) runs.push(run);
			const thin = (r: Pt[]) => {
				if (r.length <= MAX_CHART_LINE_POINTS) return r;
				const pts = decimateChartPoints(r.map((p) => ({ x: p.c, y: p.v, p })), MAX_CHART_LINE_POINTS).map((q) => q.p);
				ctx.warn('points-decimated', `"${s.name}" has ${r.length} points; its line is drawn with ${pts.length} (one column of pixels each).`);
				return pts;
			};
			const drawn = runs.map(thin);

			if (type === 'area') {
				// Stacked areas fill down to the series below; others down to zero.
				const parts = drawn.map((r) => {
					const baseline = stack
						? r.map((pt) => ({ c: pt.c, v: valuePx(stack.segments[pt.i!]?.[0] ?? 0) })).reverse()
						: [
								{ c: r[r.length - 1].c, v: info.zero },
								{ c: r[0].c, v: info.zero }
							];
					return `${curvePath(r, curve, map)}${stack ? curvePath(baseline, curve, map, false) : baseline.map((pt) => `L${map(pt).map(r2).join(',')}`).join('')}Z`;
				});
				marks.push({ kind: 'path', key: `area-${s.id}`, role: 'area', d: parts.join(''), fill: color, opacity: 0.22, target: seriesTarget, selected: selSeries });
			}
			if (type === 'line' || type === 'area') {
				marks.push({ kind: 'path', key: `line-${s.id}`, role: 'line', d: drawn.map((r) => curvePath(r, curve, map)).join(''), fill: 'none', stroke: color, strokeWidth: selSeries ? 3.5 : 2, target: seriesTarget, selected: selSeries });
			}
			const marker: ChartMarker = s.marker ?? (type === 'scatter' || spec.points ? 'circle' : 'none');
			const showDots = marker !== 'none';
			const thinMarkers = n > MAX_CHART_MARKERS;
			const cells = new Set<string>();
			for (let i = 0; i < n; i++) {
				const v = pointValue(i);
				if (v === null || s.values[i] === null) continue;
				const [cx, cy] = map({ c: catCenter(i), v: valuePx(v) });
				if (thinMarkers) {
					const cell = `${Math.round(cx / 2)},${Math.round(cy / 2)}`;
					if (cells.has(cell)) continue;
					cells.add(cell);
				}
				const target: ChartSelection = { kind: 'point', seriesId: s.id, index: i };
				const selected = ctx.isSelected(target);
				const r = type === 'scatter' ? 4.5 : 3.5;
				const pointColor = chartPointColor(spec, si, i);
				const fill = showDots ? (type === 'scatter' ? pointColor : theme.surface) : 'transparent';
				// Without markers the point still gets a transparent target so it can be picked and dragged.
				marks.push(
					pointMark({ key: `point-${s.id}-${i}`, target, selected: selected || selSeries, opacity: type === 'scatter' ? 0.85 : undefined }, showDots ? marker : 'hit', cx, cy, showDots ? r : 6, fill, showDots ? pointColor : undefined, 2)
				);
				if (selected) marks.push({ kind: 'circle', key: `point-${s.id}-${i}-selection`, role: 'selection', cx, cy, r: r + 3.5, fill: 'none', stroke: theme.selection, strokeWidth: 1.5 });
				if (labelsOn) {
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
		const errs = errors.get(s.id);
		if (errs) {
			const slot = type === 'bar' ? slotOf(s) : 0;
			const capWidth = type === 'bar' ? Math.min(10, barWidth * 0.5) : 8;
			const cap = s.errorBars!.cap !== false;
			errs.forEach((e, i) => {
				if (!e || (log && !((s.values[i] ?? 0) > 0))) return;
				const c = type === 'bar' ? catCenter(i) - groupWidth / 2 + slot * barWidth * (1 - o) + barWidth / 2 : catCenter(i);
				const d = errorBarPath(map, c, valuePx(e.lo), valuePx(e.hi), capWidth, cap && e.lo < e.center, cap && e.hi > e.center);
				if (d) errorMarks.push({ kind: 'path', key: `error-bar-${s.id}-${i}`, role: 'error-bar', d, fill: 'none', stroke: type === 'bar' ? theme.text : color, strokeWidth: selSeries ? 2 : 1.25, target: seriesTarget, selected: selSeries });
			});
		}
		if (trendsAllowed && s.trendlines?.length) {
			// Category charts fit against x = 1, 2, 3, … (as spreadsheets do).
			const points: [number, number][] = [];
			s.values.forEach((v, i) => v !== null && Number.isFinite(v) && points.push([i + 1, v]));
			const toPx = (x: number, y: number) => map({ c: catCenter(x - 1), v: info.raw(y) });
			drawTrendlines(ctx, plot, s, color, points, toPx, trendLabels, !!info.logBase);
		}
	}
	marks.push(...errorMarks, ...labelMarks);
	drawTrendLabels(ctx, plot, trendLabels);
	if (hiddenLabels) ctx.warn('data-labels-hidden', `${hiddenLabels} data label${hiddenLabels === 1 ? '' : 's'} did not fit and ${hiddenLabels === 1 ? 'is' : 'are'} hidden.`);
	return {
		plot,
		valueScale: toValueScale(frame.value, horizontal ? 'x' : 'y'),
		...(frame.value2 ? { valueScale2: toValueScale(frame.value2, horizontal ? 'x' : 'y') } : {}),
		percent
	};
}

/** Scatter (with x values) and bubble charts: numeric x against numeric y. */
export function layoutXy(ctx: LayoutCtx, area: ChartRect, visible: ChartSeries[]): FamilyResult {
	const { spec, theme, marks, measure, fs } = ctx;
	const bubble = spec.type === 'bubble';
	const yAxis = spec.yAxis;
	const xAxis = spec.xAxis;
	const xLog = xAxis.scale === 'log';
	const yLog = yAxis.scale === 'log';
	let skipped = 0;
	const pointsOf = (s: ChartSeries) =>
		s.values
			.map((y, i) => ({ i, x: s.x?.[i] ?? (bubble || !s.x ? i + 1 : null), y, size: s.sizes?.[i] ?? null }))
			.filter((p): p is { i: number; x: number; y: number; size: number | null } => {
				if (p.x === null || p.y === null || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
				// Log axes cannot place 0 or less.
				if ((xLog && p.x <= 0) || (yLog && p.y <= 0)) return (skipped++, false);
				return true;
			});
	const all = visible.map((s) => ({ s, pts: pointsOf(s) }));
	if (skipped) ctx.warn('values-skipped', `${skipped} point${skipped === 1 ? '' : 's'} with a value of 0 or less cannot be drawn on the logarithmic ${xLog && yLog ? 'axes' : xLog ? 'x axis' : 'value axis'} and ${skipped === 1 ? 'was' : 'were'} skipped.`);
	// Error bars per point, keyed by series id and point index.
	const yErrors = new Map<string, (ChartErrorAmountLike | null)[]>();
	const xErrors = new Map<string, (ChartErrorAmountLike | null)[]>();
	for (const { s } of all) {
		if (s.errorBars) yErrors.set(s.id, chartErrorAmounts(s.errorBars, s.values));
		if (s.xErrorBars) xErrors.set(s.id, chartErrorAmounts(s.xErrorBars, s.values.map((_, i) => (s.x?.[i] ?? (bubble || !s.x ? i + 1 : null)) as ChartValue)));
	}
	let xlo = Infinity;
	let xhi = -Infinity;
	let ylo = Infinity;
	let yhi = -Infinity;
	let maxSize = 0;
	const seeX = (v: number) => {
		if (!Number.isFinite(v) || (xLog && !(v > 0))) return;
		xlo = Math.min(xlo, v);
		xhi = Math.max(xhi, v);
	};
	const seeY = (v: number) => {
		if (!Number.isFinite(v) || (yLog && !(v > 0))) return;
		ylo = Math.min(ylo, v);
		yhi = Math.max(yhi, v);
	};
	for (const { s, pts } of all) {
		for (const p of pts) {
			seeX(p.x);
			seeY(p.y);
			if (p.size !== null && p.size > maxSize) maxSize = p.size;
			const ey = yErrors.get(s.id)?.[p.i];
			if (ey) (seeY(ey.center - ey.minus), seeY(ey.center + ey.plus));
			const ex = xErrors.get(s.id)?.[p.i];
			if (ex) (seeX(ex.center - ex.minus), seeX(ex.center + ex.plus));
		}
		// Forecasts widen the x axis.
		for (const t of s.trendlines ?? []) {
			if (!pts.length) continue;
			seeX(Math.min(...pts.map((p) => p.x)) - (t.backward ?? 0));
			seeX(Math.max(...pts.map((p) => p.x)) + (t.forward ?? 0));
		}
	}
	if (!Number.isFinite(xlo)) [xlo, xhi] = xLog ? [1, 10] : [0, 1];
	if (!Number.isFinite(ylo)) [ylo, yhi] = yLog ? [1, 10] : [0, 1];
	const titleBand = fs * 1.3 + 6;
	const yEst = axisScale(ylo, yhi, area.height, yAxis, ctx.options.valueDomain, true);
	const yText = (t: number, step: number) => formatChartNumber(t, yAxis.format, yAxis.format.decimals ?? (yLog ? undefined : stepDecimals(step)));
	const left = (yAxis.show ? Math.max(0, ...yEst.ticks.map((t) => measure(yText(t, yEst.step), fs))) + 8 : 2) + (yAxis.title ? titleBand : 0);
	const bottom = (xAxis.show ? fs * 1.6 : 2) + (xAxis.title ? titleBand : 0);
	const plot: ChartRect = { x: area.x + left, y: area.y + fs / 2 + 2, width: Math.max(1, area.width - left - 12), height: Math.max(1, area.height - bottom - fs / 2 - 2) };
	const maxR = bubble ? Math.max(4, Math.min(plot.width, plot.height) * 0.08) : 0;
	// Bubbles get room so they are not cut by the frame.
	const inset = bubble ? maxR : 0;
	const yScale = axisScale(ylo, yhi, plot.height, yAxis, ctx.options.valueDomain, true);
	const xScale = axisScale(xlo, xhi, plot.width, xAxis, ctx.options.xDomain, true);
	const xRange: [number, number] = [plot.x + inset, plot.x + plot.width - inset];
	const yRange: [number, number] = [plot.y + plot.height - inset, plot.y + inset];
	const xInfo = scaleInfo(xScale, xRange, xAxis.format, xAxis);
	const yInfo = scaleInfo(yScale, yRange, yAxis.format, yAxis);
	const { raw: xRaw, px: xPx } = xInfo;
	const { raw: yRaw, px: yPx } = yInfo;
	const xTarget: ChartSelection = { kind: 'axis', axis: 'x' };
	const yTarget: ChartSelection = { kind: 'axis', axis: 'y' };

	if (yAxis.gridlines) yScale.ticks.forEach((t, i) => marks.push({ kind: 'line', key: `grid-y-${i}`, role: 'grid', x1: plot.x, y1: yPx(t), x2: plot.x + plot.width, y2: yPx(t), stroke: theme.grid, strokeWidth: 1 }));
	if (xAxis.gridlines) xScale.ticks.forEach((t, i) => marks.push({ kind: 'line', key: `grid-x-${i}`, role: 'grid', x1: xPx(t), y1: plot.y, x2: xPx(t), y2: plot.y + plot.height, stroke: theme.grid, strokeWidth: 1 }));
	if (yAxis.show) yScale.ticks.forEach((t, i) => marks.push({ kind: 'text', key: `tick-y-${i}`, role: 'tick-label', x: plot.x - 8, y: yPx(t), text: yText(t, yScale.step), anchor: 'end', baseline: 'middle', size: fs, fill: theme.mutedText, target: yTarget }));
	if (xAxis.show) {
		// The x axis crosses at y = 0, else along the lower end of the y axis (the top when reversed).
		const y0 = !yLog && yScale.min <= 0 && yScale.max >= 0 ? yPx(0) : yAxis.reverse ? plot.y : plot.y + plot.height;
		marks.push({ kind: 'line', key: 'axis-x', role: 'axis', x1: plot.x, y1: y0, x2: plot.x + plot.width, y2: y0, stroke: theme.axis, strokeWidth: 1, target: xTarget });
		const texts = xScale.ticks.map((t) => formatChartNumber(t, xAxis.format, xAxis.format.decimals ?? (xLog ? undefined : stepDecimals(xScale.step))));
		const widest = Math.max(0, ...texts.map((t) => measure(t, fs)));
		// Log ticks are unevenly spaced: thin by the closest pair.
		const spacing = Math.min(Infinity, ...xScale.ticks.slice(1).map((t, i) => Math.abs(xPx(t) - xPx(xScale.ticks[i]))));
		const every = Math.max(1, Math.ceil((widest + 8) / spacing));
		xScale.ticks.forEach((t, i) => {
			if (i % every) return;
			marks.push({ kind: 'text', key: `tick-x-${i}`, role: 'tick-label', x: xPx(t), y: plot.y + plot.height + 6, text: texts[i], anchor: 'middle', baseline: 'top', size: fs, fill: theme.mutedText, target: xTarget });
		});
	}
	if (xAxis.title) marks.push({ kind: 'text', key: 'axis-title-x', role: 'axis-title', x: plot.x + plot.width / 2, y: area.y + area.height, text: xAxis.title, anchor: 'middle', baseline: 'bottom', size: fs + 1, weight: 500, fill: theme.text, target: xTarget });
	if (yAxis.title) marks.push({ kind: 'text', key: 'axis-title-y', role: 'axis-title', x: area.x, y: plot.y + plot.height / 2, text: yAxis.title, anchor: 'middle', baseline: 'top', size: fs + 1, weight: 500, fill: theme.text, rotate: -90, target: yTarget });
	for (const axis of ['x', 'y'] as const) {
		if (!ctx.isSelected({ kind: 'axis', axis })) continue;
		ctx.outline(`axis-${axis}-selection`, axis === 'y' ? { x: area.x, y: plot.y - fs / 2, width: left - 2, height: plot.height + fs } : { x: plot.x - 4, y: plot.y + plot.height + 2, width: plot.width + 8, height: area.y + area.height - plot.y - plot.height - 2 });
	}

	const labelMarks: ChartMark[] = [];
	const errorMarks: ChartMark[] = [];
	const trendLabels: TrendLabel[] = [];
	// Bigger bubbles first, so small ones stay clickable on top.
	for (const { s, pts } of all) {
		const si = spec.series.indexOf(s);
		const color = chartSeriesColor(spec, si);
		const type = chartSeriesType(spec, s);
		const selSeries = ctx.seriesSelected(s.id);
		const seriesTarget: ChartSelection = { kind: 'series', seriesId: s.id };
		if (type === 'line' || type === 'area') {
			const xy = pts.map((p) => ({ x: xPx(p.x), y: yPx(p.y) }));
			const thinned = xy.length > MAX_CHART_LINE_POINTS ? decimateChartPoints(xy, MAX_CHART_LINE_POINTS) : xy;
			if (thinned.length < xy.length) ctx.warn('points-decimated', `"${s.name}" has ${xy.length} points; its line is drawn with ${thinned.length}.`);
			const d = curvePath(thinned.map((p) => ({ c: p.x, v: p.y })), s.curve ?? spec.curve, (p) => [p.c, p.v]);
			if (d) marks.push({ kind: 'path', key: `line-${s.id}`, role: 'line', d, fill: 'none', stroke: color, strokeWidth: selSeries ? 3.5 : 2, target: seriesTarget, selected: selSeries });
		}
		const marker: ChartMarker = bubble ? 'circle' : (s.marker ?? (type === 'scatter' || spec.points ? 'circle' : 'none'));
		const ordered = bubble ? [...pts].sort((a, b) => (b.size ?? 0) - (a.size ?? 0)) : pts;
		const labelsOn = (s.dataLabels ?? spec.dataLabels) && pts.length <= MAX_CHART_DATA_LABELS;
		const labelFormat = s.format ?? yAxis.format;
		const cells = new Set<string>();
		for (const p of ordered) {
			const cx = xPx(p.x);
			const cy = yPx(p.y);
			if (pts.length > MAX_CHART_MARKERS) {
				const cell = `${Math.round(cx / 2)},${Math.round(cy / 2)}`;
				if (cells.has(cell)) continue;
				cells.add(cell);
			}
			const target: ChartSelection = { kind: 'point', seriesId: s.id, index: p.i };
			const selected = ctx.isSelected(target);
			const pointColor = chartPointColor(spec, si, p.i);
			const r = bubble ? (maxSize > 0 && p.size !== null && p.size > 0 ? Math.max(2, Math.sqrt(p.size / maxSize) * maxR) : 2) : 4.5;
			if (bubble) marks.push({ kind: 'circle', key: `point-${s.id}-${p.i}`, role: 'point', cx, cy, r, fill: pointColor, stroke: pointColor, strokeWidth: 1, opacity: 0.6, target, selected: selected || selSeries });
			else marks.push(pointMark({ key: `point-${s.id}-${p.i}`, target, selected: selected || selSeries, opacity: 0.85 }, marker === 'none' ? 'hit' : marker, cx, cy, marker === 'none' ? 6 : r, marker === 'none' ? 'transparent' : pointColor, marker === 'none' ? undefined : pointColor, 2));
			if (selected) marks.push({ kind: 'circle', key: `point-${s.id}-${p.i}-selection`, role: 'selection', cx, cy, r: r + 3.5, fill: 'none', stroke: theme.selection, strokeWidth: 1.5 });
			if (labelsOn) labelMarks.push({ kind: 'text', key: `label-${s.id}-${p.i}`, role: 'data-label', x: cx, y: cy - r - 4, text: formatChartNumber(p.y, labelFormat), anchor: 'middle', baseline: 'bottom', size: fs - 1, fill: theme.text, target });
		}
		// Error bars: y bars vertical through the point, x bars horizontal.
		const stroke = color;
		const errorBar = (key: string, d: string) => d && errorMarks.push({ kind: 'path', key, role: 'error-bar', d, fill: 'none', stroke, strokeWidth: selSeries ? 2 : 1.25, target: seriesTarget, selected: selSeries });
		for (const p of pts) {
			const ey = yErrors.get(s.id)?.[p.i];
			if (ey) {
				const lo = ey.center - ey.minus;
				const hi = ey.center + ey.plus;
				const cap = s.errorBars!.cap !== false;
				errorBar(`error-bar-${s.id}-${p.i}`, errorBarPath((q) => [q.c, q.v], xPx(p.x), yPx(lo), yPx(hi), 8, cap && lo < ey.center, cap && hi > ey.center));
			}
			const ex = xErrors.get(s.id)?.[p.i];
			if (ex) {
				const lo = ex.center - ex.minus;
				const hi = ex.center + ex.plus;
				const cap = s.xErrorBars!.cap !== false;
				errorBar(`error-bar-x-${s.id}-${p.i}`, errorBarPath((q) => [q.v, q.c], yPx(p.y), xPx(lo), xPx(hi), 8, cap && lo < ex.center, cap && hi > ex.center));
			}
		}
		if (s.trendlines?.length) drawTrendlines(ctx, plot, s, color, pts.map((p) => [p.x, p.y]), (x, y) => [xRaw(x), yRaw(y)], trendLabels, xLog || yLog);
	}
	marks.push(...errorMarks, ...labelMarks);
	drawTrendLabels(ctx, plot, trendLabels);
	return {
		plot,
		valueScale: toValueScale(yInfo, 'y'),
		xScale: toValueScale(xInfo, 'x')
	};
}

/** Legend entries for trendlines (dashed lines after their series). */
export function trendlineLegendItems(spec: { series: ChartSeries[]; type: string; stacking: string }, color: (i: number) => string) {
	if (!chartSupportsTrendlines(spec.type, spec.stacking)) return [];
	return spec.series.flatMap((s, si) =>
		s.hidden ? [] : (s.trendlines ?? []).map((t, ti) => ({ label: chartTrendlineName(t, s.name), color: t.color ?? color(si), target: { kind: 'trendline', seriesId: s.id, index: ti } as ChartSelection, after: s.id }))
	);
}
