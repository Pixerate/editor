// Numeric summaries for agents that check visuals without looking follow
// filmcraft-main/crates/scopes/src/summary.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See
// THIRD_PARTY_NOTICES.md.
import { checkChartColors, type ChartColorCheck } from './color.js';
import { layoutChart } from './layout.js';
import type { ChartLayoutOptions } from './layout-shared.js';
import { formatChartNumber } from './scale.js';
import { chartColorsByCategory, chartFamily, chartSeriesColor, chartSliceColor, CHART_TYPE_LABELS } from './spec.js';
import { summarizeChartSeries, type ChartSeriesSummary } from './stats.js';
import type { ChartScene, ChartSpec, ChartWarning } from './types.js';

export interface ChartSummary {
	type: ChartSpec['type'];
	title: string;
	categories: number;
	series: ChartSeriesSummary[];
	/** The value axis as drawn: range and ticks (absent for pies and treemaps). */
	valueAxis?: { min: number; max: number; ticks: number[] };
	secondaryAxis?: { min: number; max: number; ticks: number[] };
	xAxis?: { min: number; max: number; ticks: number[] };
	/** What the layout left out at this size (hidden labels, thinned lines, …). */
	warnings: ChartWarning[];
	/** Whether the series colours can be told apart (also with colour-blindness). */
	colors: Pick<ChartColorCheck, 'ok' | 'issues'>;
	/** A plain-language description (the SVG `<desc>`). */
	description: string;
}

/**
 * Numbers about a chart for agents and screen readers: per-series min / max / mean / trend,
 * the axes as drawn, layout warnings at `size`, a colour check and a one-paragraph
 * description. Lets an agent verify a chart without rendering it.
 */
export function summarizeChart(spec: ChartSpec, size: Pick<ChartLayoutOptions, 'width' | 'height' | 'measureText'> = { width: 640, height: 400 }, scene: ChartScene = layoutChart(spec, { ...size, selection: null })): ChartSummary {
	const visible = spec.series.filter((s) => !s.hidden);
	const series = visible.map((s) => summarizeChartSeries(s, spec.categories));
	const colors = chartColorsByCategory(spec.type) ? spec.categories.map((_, i) => visible[0]?.pointColors?.[i] || chartSliceColor(spec, i)) : visible.map((s) => chartSeriesColor(spec, spec.series.indexOf(s)));
	const check = checkChartColors(colors, { surface: scene.theme.surface.startsWith('var(') ? '#ffffff' : scene.theme.surface });
	const axis = (s: ChartScene['valueScale']) => (s ? { min: s.domain[0], max: s.domain[1], ticks: [...s.ticks] } : undefined);
	return {
		type: spec.type,
		title: spec.title,
		categories: spec.categories.length,
		series,
		...(scene.valueScale ? { valueAxis: axis(scene.valueScale) } : {}),
		...(scene.valueScale2 ? { secondaryAxis: axis(scene.valueScale2) } : {}),
		...(scene.xScale ? { xAxis: axis(scene.xScale) } : {}),
		warnings: scene.warnings,
		colors: { ok: check.ok, issues: check.issues },
		description: describeChart(spec, series)
	};
}

/** A plain-language description of a chart: type, what it compares, ranges and notable extremes. */
export function describeChart(spec: ChartSpec, series = spec.series.filter((s) => !s.hidden).map((s) => summarizeChartSeries(s, spec.categories))): string {
	const kind = CHART_TYPE_LABELS[spec.type].toLowerCase();
	const parts: string[] = [];
	const family = chartFamily(spec);
	const format = spec.yAxis.format;
	const fmt = (v: number | null) => (v === null ? 'blank' : formatChartNumber(v, format));
	const head = spec.title ? `${spec.title}: a ${kind} chart` : `A ${kind} chart`;
	if (!series.length || series.every((s) => s.count === 0)) return `${head} with no data.`;
	if (family === 'pie' || family === 'funnel' || family === 'treemap') {
		const s = series[0];
		const total = s.sum ?? 0;
		const share = (v: number | null) => (total && v !== null ? ` (${Math.round((v / total) * 100)}%)` : '');
		parts.push(`${head} of ${s.name} across ${spec.categories.length} categories, totalling ${fmt(s.sum)}.`);
		parts.push(`The largest is ${s.maxAt} at ${fmt(s.max)}${share(s.max)}; the smallest is ${s.minAt} at ${fmt(s.min)}${share(s.min)}.`);
		return parts.join(' ');
	}
	if (family === 'waterfall') {
		const s = spec.series.find((x) => !x.hidden)!;
		const steps = s.values.filter((v, i) => v !== null && Number.isFinite(v) && !/\b(sub)?total\b/i.test(spec.categories[i] ?? '')) as number[];
		const total = steps.reduce((t, v) => t + v, 0);
		const up = steps.filter((v) => v > 0).length;
		const down = steps.filter((v) => v < 0).length;
		return `${head} of ${s.name}: ${up} increase${up === 1 ? '' : 's'} and ${down} decrease${down === 1 ? '' : 's'} over ${spec.categories.length} steps, ending at a total of ${fmt(total)}.`;
	}
	if (family === 'histogram' || family === 'box') {
		parts.push(`${head} of ${series.map((s) => s.name).join(', ')}.`);
		for (const s of series) parts.push(`${s.name}: ${s.count} values from ${fmt(s.min)} to ${fmt(s.max)}, mean ${fmt(s.mean)}.`);
		return parts.join(' ');
	}
	const what = family === 'xy' ? `${series.length} series of points` : `${series.length} series over ${spec.categories.length} categories${spec.categories.length ? ` (${spec.categories[0]} to ${spec.categories[spec.categories.length - 1]})` : ''}`;
	parts.push(`${head} showing ${what}.`);
	for (const s of series.slice(0, 8)) {
		if (!s.count) {
			parts.push(`${s.name} has no values.`);
			continue;
		}
		const pct = s.change !== null ? Math.round(Math.abs(s.change) * 100) : 0;
		const trend = s.trend && s.trend !== 'flat' ? `, ${s.trend}${pct ? `, ${s.change! > 0 ? 'up' : 'down'} ${pct}% from first to last` : ''}` : s.trend === 'flat' ? ', roughly flat' : '';
		parts.push(`${s.name} ranges from ${fmt(s.min)} (${s.minAt}) to ${fmt(s.max)} (${s.maxAt})${trend}.`);
	}
	if (series.length > 8) parts.push(`${series.length - 8} more series are not described.`);
	return parts.join(' ');
}
