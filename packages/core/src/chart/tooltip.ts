import { chartHitTest } from './interaction.js';
import { chartCategoryAtPoint } from './layout.js';
import { estimateChartTextWidth, type ChartTextMeasure } from './layout-shared.js';
import { formatChartNumber } from './scale.js';
import { chartFamily, chartPointColor, chartSliceColor, type ChartFamily } from './spec.js';
import type { ChartNumberFormat, ChartScene, ChartSeries, ChartSpec, ChartValue } from './types.js';

/** `point`: the bar, point or slice under the pointer. `category`: every series in the category under the pointer (bar, line and area charts; other charts fall back to `point`). */
export type ChartTooltipMode = 'point' | 'category';

export interface ChartTooltipItem {
	seriesId: string;
	/** The series name (the category label on pie, funnel and parliament charts). */
	name: string;
	color: string;
	value: ChartValue;
	/** Share of the category (percent-stacked charts) or of the series (pie and donut charts), 0–1. */
	share?: number;
	/** The value as the chart writes it: the series format, else its value axis format. */
	text: string;
}

export interface ChartTooltip {
	/** The category label (the series name on scatter and bubble charts with x values). */
	title: string;
	/** The category the items belong to. */
	index: number;
	items: ChartTooltipItem[];
	/** Where to anchor the tooltip, in scene pixels (the pointer). */
	x: number;
	y: number;
}

export interface ChartTooltipOptions {
	/** Default `point`. */
	mode?: ChartTooltipMode;
	/** Text width for hit-testing labels (default: an estimate). */
	measureText?: ChartTextMeasure;
}

// Families whose point targets index straight into `series.values`.
const VALUE_FAMILIES = new Set<ChartFamily>(['cartesian', 'xy', 'pie', 'radar', 'waterfall', 'funnel', 'parliament', 'slope', 'streamgraph']);
// Families that colour (and name) each category rather than each series.
const SLICE_FAMILIES = new Set<ChartFamily>(['pie', 'funnel', 'parliament']);

function valueFormat(spec: ChartSpec, series: ChartSeries): ChartNumberFormat {
	return series.format ?? (series.axis === 'secondary' ? spec.yAxis2.format : spec.yAxis.format);
}

const percentText = (share: number) => formatChartNumber(share, { style: 'percent', decimals: share < 0.1 ? 1 : 0 });

function item(spec: ChartSpec, seriesIndex: number, index: number, share?: number): ChartTooltipItem {
	const family = chartFamily(spec);
	const series = spec.series[seriesIndex];
	const value = series.values[index] ?? null;
	const slice = SLICE_FAMILIES.has(family);
	let text = formatChartNumber(value, valueFormat(spec, series));
	if (family === 'xy') {
		const x = series.x?.[index];
		if (x !== null && x !== undefined) text = `${formatChartNumber(x, spec.xAxis.format)}, ${text}`;
	}
	if (share !== undefined) text = `${text} (${percentText(share)})`;
	return {
		seriesId: series.id,
		name: slice ? (spec.categories[index] ?? series.name) : series.name,
		color: slice ? (series.pointColors?.[index] ?? chartSliceColor(spec, index)) : chartPointColor(spec, seriesIndex, index),
		value,
		...(share !== undefined ? { share } : {}),
		text
	};
}

/**
 * What a tooltip shows for one category: the category label and each visible series' value
 * there, written as the chart writes it. `seriesId` narrows it to one series (one bar, point
 * or slice). Returns `null` for charts whose marks are not one value per category (histogram,
 * box, treemap and sunburst with a tree, sankey, …), for an index out of range, or when no
 * visible series has a value there.
 */
export function chartTooltipFor(spec: ChartSpec, index: number, seriesId?: string, anchor: { x: number; y: number } = { x: 0, y: 0 }): ChartTooltip | null {
	const family = chartFamily(spec);
	if (!VALUE_FAMILIES.has(family)) return null;
	if (!Number.isInteger(index) || index < 0 || index >= Math.max(spec.categories.length, ...spec.series.map((s) => s.values.length))) return null;
	const visible = spec.series.map((s, i) => ({ s, i })).filter(({ s }) => !s.hidden && (!seriesId || s.id === seriesId));
	const present = visible.filter(({ s }) => s.values[index] !== null && s.values[index] !== undefined && Number.isFinite(s.values[index]));
	if (!present.length) return null;
	const shareOf = (s: ChartSeries): number | undefined => {
		const v = s.values[index] as number;
		if (spec.stacking === 'percent' && family === 'cartesian') {
			const total = spec.series.filter((t) => !t.hidden && t.axis === s.axis).reduce((sum, t) => sum + Math.abs(t.values[index] ?? 0), 0);
			return total ? Math.abs(v) / total : undefined;
		}
		if (family === 'pie') {
			const total = s.values.reduce<number>((sum, t) => sum + (t !== null && t > 0 ? t : 0), 0);
			return total && v > 0 ? v / total : undefined;
		}
		return undefined;
	};
	const items = present.map(({ s, i }) => item(spec, i, index, shareOf(s)));
	const title = family === 'xy' ? (spec.categories[index] || present[0].s.name) : (spec.categories[index] ?? '');
	return { title, index, items, x: anchor.x, y: anchor.y };
}

/**
 * The tooltip at a scene point (for hover), or `null` when the pointer is over nothing with a
 * value. In `category` mode, anywhere in a category's band of a bar, line or area chart shows
 * every series there; elsewhere both modes show the one bar, point or slice under the pointer.
 */
export function chartTooltipAt(spec: ChartSpec, scene: ChartScene, point: { x: number; y: number }, options: ChartTooltipOptions = {}): ChartTooltip | null {
	if (options.mode === 'category' && scene.categoryScale) {
		const index = chartCategoryAtPoint(scene, point);
		if (index !== undefined) return chartTooltipFor(spec, index, undefined, point);
	}
	const target = chartHitTest(scene, point, options.measureText ?? estimateChartTextWidth);
	if (target?.kind === 'point') return chartTooltipFor(spec, target.index, target.seriesId, point);
	// A pie slice's label or a bar's data label point at the same target as the mark.
	if (target?.kind === 'category' && scene.categoryScale && options.mode === 'category') return chartTooltipFor(spec, target.index, undefined, point);
	return null;
}

/** Whether two tooltips show the same thing (so a host can skip re-rendering while the pointer moves within a mark). */
export function sameChartTooltip(a: ChartTooltip | null, b: ChartTooltip | null): boolean {
	if (!a || !b) return a === b;
	return a.index === b.index && a.items.length === b.items.length && a.items.every((it, i) => it.seriesId === b.items[i].seriesId && it.text === b.items[i].text);
}
