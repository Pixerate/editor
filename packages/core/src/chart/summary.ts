// Numeric summaries for agents that check visuals without looking follow
// filmcraft-main/crates/scopes/src/summary.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See
// THIRD_PARTY_NOTICES.md.
import { checkChartColors, type ChartColorCheck } from './color.js';
import { describeChartErrorBars } from './errorbars.js';
import { layoutChart } from './layout.js';
import type { ChartLayoutOptions } from './layout-shared.js';
import { formatChartNumber } from './scale.js';
import { chartSpecColorsByCategory, chartFamily, chartSeriesColor, chartSliceColor, CHART_TYPE_LABELS } from './spec.js';
import { summarizeChartSeries, type ChartSeriesSummary } from './stats.js';
import type { ChartAxis, ChartScene, ChartSpec, ChartWarning } from './types.js';
import { chartTreeDepth, chartTreeToRows } from './tree.js';

/** An axis as drawn. `logBase` is set on a logarithmic axis, `reversed` when it runs the other way. */
export interface ChartAxisSummary {
	min: number;
	max: number;
	ticks: number[];
	logBase?: number;
	reversed?: boolean;
}

export interface ChartSummary {
	type: ChartSpec['type'];
	title: string;
	categories: number;
	series: ChartSeriesSummary[];
	/** The value axis as drawn: range and ticks (absent for pies and treemaps). */
	valueAxis?: ChartAxisSummary;
	secondaryAxis?: ChartAxisSummary;
	xAxis?: ChartAxisSummary;
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
	const colors = chartSpecColorsByCategory(spec) ? spec.categories.map((_, i) => visible[0]?.pointColors?.[i] || chartSliceColor(spec, i)) : visible.map((s) => chartSeriesColor(spec, spec.series.indexOf(s)));
	const check = checkChartColors(colors, { surface: scene.theme.surface.startsWith('var(') ? '#ffffff' : scene.theme.surface });
	const axis = (s: ChartScene['valueScale'], a: ChartAxis): ChartAxisSummary | undefined =>
		s ? { min: s.domain[0], max: s.domain[1], ticks: [...s.ticks], ...(s.logBase ? { logBase: s.logBase } : {}), ...(a.reverse ? { reversed: true } : {}) } : undefined;
	return {
		type: spec.type,
		title: spec.title,
		categories: spec.categories.length,
		series,
		...(scene.valueScale ? { valueAxis: axis(scene.valueScale, spec.yAxis) } : {}),
		...(scene.valueScale2 ? { secondaryAxis: axis(scene.valueScale2, spec.yAxis2) } : {}),
		...(scene.xScale ? { xAxis: axis(scene.xScale, spec.xAxis) } : {}),
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
	if (family === 'pie' || family === 'funnel' || family === 'treemap' || family === 'sunburst') {
		const s = series[0];
		const total = s.sum ?? 0;
		const share = (v: number | null) => (total && v !== null ? ` (${Math.round((v / total) * 100)}%)` : '');
		parts.push(`${head} of ${s.name} across ${spec.categories.length} categories, totalling ${fmt(s.sum)}.`);
		parts.push(`The largest is ${s.maxAt} at ${fmt(s.max)}${share(s.max)}; the smallest is ${s.minAt} at ${fmt(s.min)}${share(s.min)}.`);
		if (spec.tree.length) {
			const depth = chartTreeDepth(spec.tree);
			const items = chartTreeToRows(spec.tree).length;
			parts.push(`The data is grouped ${depth} level${depth === 1 ? '' : 's'} deep with ${items} item${items === 1 ? '' : 's'}.`);
		}
		return parts.join(' ');
	}
	if (family === 'sankey') {
		if (!spec.links.length) return `${head} with no flows yet.`;
		const total = spec.links.reduce((t, l) => t + l.value, 0);
		const largest = [...spec.links].sort((a, b) => b.value - a.value)[0];
		const sources = spec.sankeyNodes.filter((n) => !spec.links.some((l) => l.target === n));
		const sinks = spec.sankeyNodes.filter((n) => !spec.links.some((l) => l.source === n));
		return `${head} of ${spec.links.length} flows between ${spec.sankeyNodes.length} nodes, from ${sources.join(', ')} to ${sinks.join(', ')}. The largest flow is ${largest.source} → ${largest.target} (${fmt(largest.value)}); all flows add up to ${fmt(total)}.`;
	}
	if (family === 'parliament') {
		const s = spec.series.find((x) => !x.hidden)!;
		const seats = spec.categories.map((c, i) => ({ c, n: Math.max(0, Math.round(s.values[i] ?? 0)) }));
		const total = seats.reduce((t, x) => t + x.n, 0);
		const majority = spec.parliamentMajority ?? Math.floor(total / 2) + 1;
		const largest = [...seats].sort((a, b) => b.n - a.n)[0];
		const verdict = largest && largest.n >= majority ? `${largest.c} holds a majority with ${largest.n}` : `no group reaches the majority of ${majority}; the largest is ${largest?.c} with ${largest?.n}`;
		return `${head} of ${total} seats across ${seats.length} groups: ${verdict}.`;
	}
	if (family === 'slope') {
		const [a, b] = spec.series.filter((x) => !x.hidden);
		if (!b) return `${head} that needs a second series to compare against.`;
		const moves = spec.categories.map((c, i) => ({ c, d: a.values[i] !== null && b.values[i] !== null ? (b.values[i] as number) - (a.values[i] as number) : null })).filter((m): m is { c: string; d: number } => m.d !== null);
		const up = moves.filter((m) => m.d > 0).length;
		const down = moves.filter((m) => m.d < 0).length;
		const top = [...moves].sort((x, y) => y.d - x.d);
		const extremes = top.length ? ` The biggest rise is ${top[0].c} (${fmt(top[0].d)}); the biggest fall is ${top[top.length - 1].c} (${fmt(top[top.length - 1].d)}).` : '';
		return `${head} from ${a.name} to ${b.name}: ${up} of ${moves.length} rose and ${down} fell.${extremes}`;
	}
	if (family === 'likert') {
		const answers = spec.series.filter((x) => !x.hidden);
		const side = Math.floor(answers.length / 2);
		const agree = spec.categories.map((c, i) => {
			const vals = answers.map((x) => Math.max(0, x.values[i] ?? 0));
			const total = vals.reduce((t, v) => t + v, 0);
			return { c, share: total ? vals.slice(answers.length - side).reduce((t, v) => t + v, 0) / total : 0 };
		});
		const best = [...agree].sort((x, y) => y.share - x.share);
		const pct = (v: number) => `${Math.round(v * 100)}%`;
		return `${head} of ${spec.categories.length} questions with ${answers.length} answers from ${answers[0]?.name} to ${answers[answers.length - 1]?.name}. Most positive: ${best[0]?.c} (${pct(best[0]?.share ?? 0)}); least: ${best[best.length - 1]?.c} (${pct(best[best.length - 1]?.share ?? 0)}).`;
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
	// Axis scales and error bars change how the picture reads.
	const axes: string[] = [];
	for (const [a, name] of [
		[spec.yAxis, 'value axis'],
		[spec.yAxis2, 'secondary value axis'],
		[spec.xAxis, family === 'xy' ? 'x axis' : 'category axis']
	] as const) {
		if (name === 'secondary value axis' && !spec.series.some((s) => !s.hidden && s.axis === 'secondary')) continue;
		const log = a.scale === 'log' && (name !== 'category axis');
		if (log || a.reverse) axes.push(`The ${name} is ${[log ? `logarithmic (base ${a.logBase ?? 10})` : '', a.reverse ? 'reversed' : ''].filter(Boolean).join(' and ')}.`);
	}
	parts.push(...axes);
	for (const s of spec.series.filter((x) => !x.hidden && (x.errorBars || x.xErrorBars)).slice(0, 8)) {
		const bars = [s.errorBars ? describeChartErrorBars(s.errorBars) : '', s.xErrorBars ? `x ${describeChartErrorBars(s.xErrorBars)}` : ''].filter(Boolean).join(' and ');
		parts.push(`${s.name} has ${bars}.`);
	}
	return parts.join(' ');
}
