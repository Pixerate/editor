// Waterfall, funnel, radar, histogram, box-and-whisker and treemap layouts follow
// gridcraft-main/crates/chart/src/render.rs (`waterfall`, `funnel`, `radar`, `histogram`, `box_whisker`,
// `treemap`) (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { categoryFrame, toValueScale } from './layout-cartesian.js';
import { arcPath, axisScale, contrastingTextColor, r2, truncate, type FamilyResult, type LayoutCtx } from './layout-shared.js';
import { formatChartNumber, linearMap, stepDecimals } from './scale.js';
import { chartSeriesColor, chartSliceColor } from './spec.js';
import { shadeChartColor } from './color.js';
import { chartBoxStats, chartHistogram, chartSquarify } from './stats.js';
import { chartTreeDepth, chartTreeFromSeries, chartTreeTotal } from './tree.js';
import type { ChartMark, ChartRect, ChartSelection, ChartSeries, ChartTreeNode } from './types.js';

const sliceColor = (ctx: LayoutCtx, series: ChartSeries, i: number) => series.pointColors?.[i] || chartSliceColor(ctx.spec, i);

/** Pie and donut: the first visible series, one slice per category. */
export function layoutPie(ctx: LayoutCtx, area: ChartRect, series: ChartSeries): FamilyResult {
	const { spec, theme, marks, fs, selection } = ctx;
	const values = spec.categories.map((_, i) => {
		const v = series.values[i];
		return v !== null && Number.isFinite(v) ? Math.max(0, v) : 0;
	});
	const total = values.reduce((a, b) => a + b, 0);
	const labelsOn = series.dataLabels ?? spec.dataLabels;
	const labelRoom = labelsOn ? fs * 2.2 : 4;
	const outer = Math.max(4, Math.min(area.width, area.height) / 2 - labelRoom);
	const inner = spec.type === 'donut' ? outer * spec.innerRadius : 0;
	const cx = area.x + area.width / 2;
	const cy = area.y + area.height / 2;
	const plot = { x: cx - outer, y: cy - outer, width: outer * 2, height: outer * 2 };
	if (total <= 0) {
		marks.push({ kind: 'text', key: 'empty', role: 'empty', x: cx, y: cy, text: 'No positive values', anchor: 'middle', baseline: 'middle', size: fs + 1, fill: theme.mutedText });
		return { plot };
	}
	let angle = 0;
	const format = series.format ?? spec.yAxis.format;
	let hidden = 0;
	values.forEach((v, i) => {
		if (v <= 0) return;
		const sweep = (v / total) * Math.PI * 2;
		const start = angle;
		const end = angle + sweep;
		angle = end;
		const target: ChartSelection = { kind: 'point', seriesId: series.id, index: i };
		const selected = ctx.isSelected(target) || ctx.isSelected({ kind: 'category', index: i });
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
			fill: sliceColor(ctx, series, i),
			stroke: selected || seriesSel ? theme.selection : theme.surface,
			strokeWidth: selected || seriesSel ? 2 : 1,
			target,
			selected: selected || seriesSel
		});
		if (!labelsOn) return;
		if (sweep <= 0.12) {
			hidden++;
			return;
		}
		const share = v / total;
		const text = format.style || format.code ? formatChartNumber(v, format) : `${Math.round(share * 100)}%`;
		const lr = outer + fs * 1.1;
		const lx = ox + lr * Math.sin(mid);
		const ly = oy - lr * Math.cos(mid);
		const anchor = Math.abs(Math.sin(mid)) < 0.2 ? 'middle' : Math.sin(mid) > 0 ? 'start' : 'end';
		marks.push({ kind: 'text', key: `label-slice-${i}`, role: 'data-label', x: lx, y: ly, text, anchor, baseline: 'middle', size: fs, fill: theme.text, target });
	});
	if (hidden) ctx.warn('data-labels-hidden', `${hidden} slice label${hidden === 1 ? ' is' : 's are'} hidden: the slices are too thin.`);
	if (spec.type === 'donut' && inner > fs * 2) {
		marks.push({ kind: 'text', key: 'donut-total', role: 'data-label', x: cx, y: cy, text: formatChartNumber(total, format), anchor: 'middle', baseline: 'middle', size: Math.min(theme.titleSize + 4, inner / 2), weight: 600, fill: theme.text, target: { kind: 'series', seriesId: series.id } });
	}
	return { plot };
}

/** Radar: one spoke per category, one polygon per series. */
export function layoutRadar(ctx: LayoutCtx, area: ChartRect, visible: ChartSeries[]): FamilyResult {
	const { spec, theme, marks, fs, measure } = ctx;
	const n = spec.categories.length;
	const labelW = Math.min(area.width * 0.25, Math.max(0, ...spec.categories.map((c) => measure(c, fs))));
	const radius = Math.max(8, Math.min(area.width / 2 - labelW - 8, area.height / 2 - fs * 1.6));
	const cx = area.x + area.width / 2;
	const cy = area.y + area.height / 2;
	let lo = 0;
	let hi = -Infinity;
	for (const s of visible) for (const v of s.values) if (v !== null && Number.isFinite(v)) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
	if (!Number.isFinite(hi)) hi = 1;
	let scale = axisScale(lo, hi, radius, spec.yAxis, ctx.options.valueDomain);
	// A fixed ring count (Mermaid's `ticks`) spaces rings evenly over the scale instead of at round numbers.
	if (spec.radarTicks !== null && spec.yAxis.scale !== 'log') {
		const n = spec.radarTicks;
		const step = (scale.max - scale.min) / n;
		scale = { ...scale, step, ticks: Array.from({ length: n + 1 }, (_, k) => Number((scale.min + step * k).toPrecision(12))) };
	}
	const rOf = (v: number) => linearMap(Math.min(scale.max, Math.max(scale.min, v)), [scale.min, scale.max], [0, radius]);
	const angle = (i: number) => (i / n) * Math.PI * 2;
	const at = (i: number, r: number): [number, number] => [cx + r * Math.sin(angle(i)), cy - r * Math.cos(angle(i))];
	const yTarget: ChartSelection = { kind: 'axis', axis: 'y' };
	// Rings and spokes
	if (spec.yAxis.gridlines)
		scale.ticks.forEach((t, k) => {
			const r = rOf(t);
			if (r <= 0) return;
			if (spec.radarGraticule === 'circle') {
				marks.push({ kind: 'circle', key: `grid-ring-${k}`, role: 'grid', cx, cy, r, fill: 'none', stroke: theme.grid, strokeWidth: 1 });
				return;
			}
			const d = Array.from({ length: n }, (_, i) => at(i, r)).map(([x, y], i) => `${i ? 'L' : 'M'}${r2(x)},${r2(y)}`).join('') + 'Z';
			marks.push({ kind: 'path', key: `grid-ring-${k}`, role: 'grid', d, fill: 'none', stroke: theme.grid, strokeWidth: 1 });
		});
	for (let i = 0; i < n; i++) {
		const [x, y] = at(i, radius);
		marks.push({ kind: 'line', key: `spoke-${i}`, role: 'axis', x1: cx, y1: cy, x2: x, y2: y, stroke: theme.grid, strokeWidth: 1, target: { kind: 'axis', axis: 'x' } });
		if (spec.xAxis.show) {
			const [lx, ly] = at(i, radius + 8);
			const s = Math.sin(angle(i));
			const c = Math.cos(angle(i));
			const target: ChartSelection = { kind: 'category', index: i };
			const selected = ctx.isSelected(target);
			marks.push({ kind: 'text', key: `tick-x-${i}`, role: 'tick-label', x: lx, y: ly, text: truncate(spec.categories[i], labelW, fs, measure), anchor: Math.abs(s) < 0.2 ? 'middle' : s > 0 ? 'start' : 'end', baseline: Math.abs(c) < 0.2 ? 'middle' : c > 0 ? 'bottom' : 'top', size: fs, fill: selected ? theme.selection : theme.mutedText, target, selected });
		}
	}
	if (spec.yAxis.show)
		scale.ticks.forEach((t, k) => {
			const r = rOf(t);
			marks.push({ kind: 'text', key: `tick-y-${k}`, role: 'tick-label', x: cx + 4, y: cy - r, text: formatChartNumber(t, spec.yAxis.format, spec.yAxis.format.decimals ?? stepDecimals(scale.step)), anchor: 'start', baseline: 'bottom', size: fs - 1, fill: theme.mutedText, target: yTarget });
		});
	for (const s of visible) {
		const si = spec.series.indexOf(s);
		const color = chartSeriesColor(spec, si);
		const selSeries = ctx.seriesSelected(s.id);
		const pts = s.values.map((v, i) => (v !== null && Number.isFinite(v) ? at(i, rOf(v)) : null));
		const present = pts.filter((p): p is [number, number] => p !== null);
		if (!present.length) continue;
		const d = present.map(([x, y], i) => `${i ? 'L' : 'M'}${r2(x)},${r2(y)}`).join('') + 'Z';
		marks.push({ kind: 'path', key: `area-${s.id}`, role: 'area', d, fill: color, opacity: s.type === 'line' ? 0 : 0.15, target: { kind: 'series', seriesId: s.id }, selected: selSeries });
		marks.push({ kind: 'path', key: `line-${s.id}`, role: 'line', d, fill: 'none', stroke: color, strokeWidth: selSeries ? 3.5 : 2, target: { kind: 'series', seriesId: s.id }, selected: selSeries });
		pts.forEach((p, i) => {
			if (!p) return;
			const target: ChartSelection = { kind: 'point', seriesId: s.id, index: i };
			const selected = ctx.isSelected(target);
			marks.push({ kind: 'circle', key: `point-${s.id}-${i}`, role: 'point', cx: p[0], cy: p[1], r: spec.points ? 3.5 : 6, fill: spec.points ? theme.surface : 'transparent', ...(spec.points ? { stroke: color, strokeWidth: 2 } : {}), target, selected: selected || selSeries });
			if (selected) marks.push({ kind: 'circle', key: `point-${s.id}-${i}-selection`, role: 'selection', cx: p[0], cy: p[1], r: 7, fill: 'none', stroke: theme.selection, strokeWidth: 1.5 });
			if (s.dataLabels ?? spec.dataLabels) marks.push({ kind: 'text', key: `label-${s.id}-${i}`, role: 'data-label', x: p[0], y: p[1] - 6, text: formatChartNumber(s.values[i], s.format ?? spec.yAxis.format), anchor: 'middle', baseline: 'bottom', size: fs - 1, fill: theme.text, target });
		});
	}
	return { plot: { x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2 } };
}

/** Waterfall: the first series as running increases (positive colour) and decreases (negative colour). */
export function layoutWaterfall(ctx: LayoutCtx, area: ChartRect, series: ChartSeries): FamilyResult {
	const { spec, theme, marks, fs } = ctx;
	const isTotal = (label: string) => /\b(sub)?total\b/i.test(label);
	const steps: { label: string; index: number | null; from: number; to: number; total: boolean }[] = [];
	let running = 0;
	spec.categories.forEach((label, i) => {
		const v = series.values[i];
		if (isTotal(label)) {
			steps.push({ label, index: i, from: 0, to: running, total: true });
			return;
		}
		const delta = v !== null && Number.isFinite(v) ? v : 0;
		steps.push({ label, index: i, from: running, to: running + delta, total: false });
		running += delta;
	});
	if (spec.showTotal && !(steps.length && steps[steps.length - 1].total)) steps.push({ label: 'Total', index: null, from: 0, to: running, total: true });
	let lo = 0;
	let hi = 0;
	for (const s of steps) {
		lo = Math.min(lo, s.from, s.to);
		hi = Math.max(hi, s.from, s.to);
	}
	const horizontal = spec.orientation === 'horizontal';
	const frame = categoryFrame(ctx, area, {
		labels: steps.map((s) => s.label),
		horizontal,
		primary: { lo, hi, axis: spec.yAxis, format: spec.yAxis.format, frozen: ctx.options.valueDomain, key: 'y' },
		labelTarget: (k) => (steps[k].index !== null ? { kind: 'category', index: steps[k].index! } : undefined)
	});
	const { band, catCenter, map, value } = frame;
	const w = band * (1 - spec.gapWidth);
	const color = chartSeriesColor(spec, spec.series.indexOf(series));
	const format = series.format ?? spec.yAxis.format;
	const labelsOn = series.dataLabels ?? spec.dataLabels;
	let prevEnd: number | null = null;
	steps.forEach((s, k) => {
		const a = value.px(s.from);
		const b = value.px(s.to);
		const c0 = catCenter(k) - w / 2;
		const [x, y] = map({ c: c0, v: Math.min(a, b) });
		const rect = horizontal ? { x: Math.min(a, b), y: c0, width: Math.max(1, Math.abs(b - a)), height: w } : { x, y, width: w, height: Math.max(1, Math.abs(b - a)) };
		const fill = s.total ? color : s.to >= s.from ? theme.positive : theme.negative;
		const target: ChartSelection = s.index !== null ? { kind: 'point', seriesId: series.id, index: s.index } : { kind: 'series', seriesId: series.id };
		const selected = ctx.isSelected(target);
		marks.push({ kind: 'rect', key: `bar-${series.id}-${s.index ?? 'total'}`, role: 'bar', ...rect, fill, radius: Math.min(2, w / 4), target, selected });
		if (selected) ctx.outline(`bar-${series.id}-${s.index ?? 'total'}-selection`, { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 });
		// Dashed connector from the previous bar's end to this bar's start.
		if (prevEnd !== null) {
			const [x1, y1] = map({ c: catCenter(k - 1) + w / 2, v: value.px(prevEnd) });
			const [x2, y2] = map({ c: c0, v: value.px(prevEnd) });
			marks.push({ kind: 'line', key: `connector-${k}`, role: 'connector', x1, y1, x2, y2, stroke: theme.axis, strokeWidth: 1, dash: '3 3' });
		}
		prevEnd = s.to;
		if (labelsOn) {
			const text = formatChartNumber(s.total ? s.to : s.to - s.from, format);
			const up = s.to >= s.from;
			const [lx, ly] = map({ c: catCenter(k), v: (horizontal ? Math.max(a, b) + 4 : up ? Math.min(a, b) - 4 : Math.max(a, b) + 4) });
			marks.push({ kind: 'text', key: `label-${series.id}-${s.index ?? 'total'}`, role: 'data-label', x: lx, y: ly, text, anchor: horizontal ? 'start' : 'middle', baseline: horizontal ? 'middle' : up ? 'bottom' : 'top', size: fs - 1, fill: theme.text, target });
		}
	});
	return { plot: frame.plot, valueScale: toValueScale(value, horizontal ? 'x' : 'y') };
}

/** Histogram: every value of the visible series, binned; one bar per series in each bin. */
export function layoutHistogram(ctx: LayoutCtx, area: ChartRect, visible: ChartSeries[]): FamilyResult {
	const { spec, marks, fs, theme } = ctx;
	const pooled = visible.flatMap((s) => s.values);
	const bins = chartHistogram(pooled, spec.bins);
	if (!bins.length) return { plot: area };
	const edgeFormat = spec.xAxis.format;
	const edges = (b: (typeof bins)[number], k: number) => `${k === 0 ? '[' : '('}${formatChartNumber(b.from, edgeFormat)}, ${formatChartNumber(b.to, edgeFormat)}]`;
	// Count per series per bin, with the same edges.
	const counts = visible.map((s) => {
		const c = bins.map(() => 0);
		for (const v of s.values) {
			if (v === null || !Number.isFinite(v)) continue;
			let k = bins.findIndex((b) => v <= b.to);
			if (k < 0) k = bins.length - 1;
			c[k]++;
		}
		return c;
	});
	const maxCount = Math.max(1, ...counts.flat());
	const frame = categoryFrame(ctx, area, {
		labels: bins.map(edges),
		horizontal: false,
		primary: { lo: 0, hi: maxCount, axis: { ...spec.yAxis, format: spec.yAxis.format.code || spec.yAxis.format.style ? spec.yAxis.format : { decimals: 0 } }, format: spec.yAxis.format.code || spec.yAxis.format.style ? spec.yAxis.format : { decimals: 0 }, frozen: null, key: 'y' },
		labelTarget: () => undefined
	});
	const { band, catCenter, value, plot } = frame;
	const k = visible.length;
	const gap = k > 1 ? band * spec.gapWidth * 0.5 : 0;
	const w = (band - gap) / k;
	visible.forEach((s, si) => {
		const color = chartSeriesColor(spec, spec.series.indexOf(s));
		const target: ChartSelection = { kind: 'series', seriesId: s.id };
		const selected = ctx.seriesSelected(s.id);
		counts[si].forEach((c, b) => {
			if (!c) return;
			const top = value.px(c);
			const x = catCenter(b) - band / 2 + gap / 2 + si * w;
			marks.push({ kind: 'rect', key: `bar-${s.id}-${b}`, role: 'bar', x, y: top, width: w, height: value.zero - top, fill: color, stroke: theme.surface, strokeWidth: 0.75, opacity: k > 1 ? 0.85 : undefined, target, selected });
			if (s.dataLabels ?? spec.dataLabels) marks.push({ kind: 'text', key: `label-${s.id}-${b}`, role: 'data-label', x: x + w / 2, y: top - 3, text: String(c), anchor: 'middle', baseline: 'bottom', size: fs - 1, fill: theme.text, target });
		});
	});
	return { plot };
}

/** Box and whiskers: one box per visible series (quartiles, median, mean ×, whiskers at 1.5 × IQR, outliers). */
export function layoutBox(ctx: LayoutCtx, area: ChartRect, visible: ChartSeries[]): FamilyResult {
	const { spec, marks, theme, fs } = ctx;
	const stats = visible.map((s) => chartBoxStats(s.values));
	let lo = Infinity;
	let hi = -Infinity;
	for (const st of stats) if (st) (lo = Math.min(lo, st.min)), (hi = Math.max(hi, st.max));
	if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
	const frame = categoryFrame(ctx, area, {
		labels: visible.map((s) => s.name),
		horizontal: false,
		primary: { lo, hi, axis: spec.yAxis, format: spec.yAxis.format, frozen: ctx.options.valueDomain, headroom: true, key: 'y' },
		labelTarget: (i) => ({ kind: 'series', seriesId: visible[i].id })
	});
	const { band, catCenter, value, plot } = frame;
	const bw = Math.min(80, band * (1 - spec.gapWidth) * 0.6);
	visible.forEach((s, i) => {
		const st = stats[i];
		if (!st) return;
		const color = chartSeriesColor(spec, spec.series.indexOf(s));
		const target: ChartSelection = { kind: 'series', seriesId: s.id };
		const selected = ctx.seriesSelected(s.id);
		const c = catCenter(i);
		const y = value.px;
		const line = (key: string, x1: number, y1: number, x2: number, y2: number, width = 1.25, stroke = color) => marks.push({ kind: 'line', key, role: 'whisker', x1, y1, x2, y2, stroke, strokeWidth: width, target });
		line(`whisker-hi-${s.id}`, c, y(st.upperWhisker), c, y(st.q3));
		line(`whisker-lo-${s.id}`, c, y(st.q1), c, y(st.lowerWhisker));
		line(`cap-hi-${s.id}`, c - bw / 4, y(st.upperWhisker), c + bw / 4, y(st.upperWhisker));
		line(`cap-lo-${s.id}`, c - bw / 4, y(st.lowerWhisker), c + bw / 4, y(st.lowerWhisker));
		const top = y(st.q3);
		const bottom = y(st.q1);
		marks.push({ kind: 'rect', key: `box-${s.id}`, role: 'box', x: c - bw / 2, y: top, width: bw, height: Math.max(0.5, bottom - top), fill: color, opacity: 0.3, stroke: selected ? theme.selection : color, strokeWidth: selected ? 2.5 : 1.5, target, selected });
		line(`median-${s.id}`, c - bw / 2, y(st.median), c + bw / 2, y(st.median), 2.5);
		const my = y(st.mean);
		marks.push({ kind: 'path', key: `mean-${s.id}`, role: 'whisker', d: `M${r2(c - 3)},${r2(my - 3)}L${r2(c + 3)},${r2(my + 3)}M${r2(c - 3)},${r2(my + 3)}L${r2(c + 3)},${r2(my - 3)}`, stroke: color, strokeWidth: 1.25, fill: 'none', target });
		st.outliers.slice(0, 500).forEach((o, k) => marks.push({ kind: 'circle', key: `outlier-${s.id}-${k}`, role: 'outlier', cx: c, cy: y(o), r: 2.5, fill: 'none', stroke: color, strokeWidth: 1, target }));
		if (s.dataLabels ?? spec.dataLabels) marks.push({ kind: 'text', key: `label-${s.id}-median`, role: 'data-label', x: c + bw / 2 + 4, y: y(st.median), text: formatChartNumber(st.median, s.format ?? spec.yAxis.format), anchor: 'start', baseline: 'middle', size: fs - 1, fill: theme.text, target });
	});
	return { plot, valueScale: toValueScale(value, 'y') };
}

/** Funnel: the first series, one centred bar per category, widths proportional to the values. */
export function layoutFunnel(ctx: LayoutCtx, area: ChartRect, series: ChartSeries): FamilyResult {
	const { spec, marks, theme, fs, measure } = ctx;
	const n = spec.categories.length;
	const labelW = spec.xAxis.show ? Math.min(area.width * 0.3, Math.max(0, ...spec.categories.map((c) => measure(c, fs)))) + 10 : 0;
	const plot: ChartRect = { x: area.x + labelW, y: area.y, width: Math.max(1, area.width - labelW), height: area.height };
	const max = Math.max(0, ...series.values.map((v) => (v !== null && Number.isFinite(v) ? Math.abs(v) : 0)));
	const band = plot.height / Math.max(1, n);
	const h = band * (1 - Math.min(0.5, spec.gapWidth * 0.5));
	const format = series.format ?? spec.yAxis.format;
	const labelsOn = series.dataLabels ?? true;
	const cx = plot.x + plot.width / 2;
	spec.categories.forEach((label, i) => {
		const v = series.values[i];
		const cy = plot.y + band * (i + 0.5);
		const target: ChartSelection = { kind: 'point', seriesId: series.id, index: i };
		const selected = ctx.isSelected(target);
		if (spec.xAxis.show) {
			const catTarget: ChartSelection = { kind: 'category', index: i };
			marks.push({ kind: 'text', key: `tick-x-${i}`, role: 'tick-label', x: plot.x - 8, y: cy, text: truncate(label, labelW - 10, fs, measure), anchor: 'end', baseline: 'middle', size: fs, fill: ctx.isSelected(catTarget) ? theme.selection : theme.mutedText, target: catTarget });
		}
		if (v === null || !Number.isFinite(v) || max <= 0) return;
		const w = Math.max(1, (Math.abs(v) / max) * plot.width);
		const fill = sliceColor(ctx, series, i);
		marks.push({ kind: 'rect', key: `bar-${series.id}-${i}`, role: 'bar', x: cx - w / 2, y: cy - h / 2, width: w, height: h, fill, radius: 2, target, selected });
		if (selected) ctx.outline(`bar-${series.id}-${i}-selection`, { x: cx - w / 2 - 2, y: cy - h / 2 - 2, width: w + 4, height: h + 4 });
		if (labelsOn) {
			const text = formatChartNumber(v, format);
			const fits = measure(text, fs) + 8 <= w && fs + 2 <= h;
			marks.push({ kind: 'text', key: `label-${series.id}-${i}`, role: 'data-label', x: fits ? cx : cx + w / 2 + 4, y: cy, text, anchor: fits ? 'middle' : 'start', baseline: 'middle', size: fs, fill: fits ? contrastingTextColor(fill) : theme.text, target });
		}
	});
	return { plot };
}

/** Treemap: the first series' positive values as nested rectangles (squarified), labelled where they fit. */
export function layoutTreemap(ctx: LayoutCtx, area: ChartRect, series: ChartSeries): FamilyResult {
	const { spec, marks, theme, fs, measure } = ctx;
	const values = spec.categories.map((_, i) => {
		const v = series.values[i];
		return v !== null && Number.isFinite(v) ? v : 0;
	});
	const rects = chartSquarify(values, area);
	const format = series.format ?? spec.yAxis.format;
	const labelsOn = series.dataLabels ?? true;
	let unlabelled = 0;
	rects.forEach((r, i) => {
		if (r.width <= 0 || r.height <= 0) return;
		const target: ChartSelection = { kind: 'point', seriesId: series.id, index: i };
		const selected = ctx.isSelected(target) || ctx.isSelected({ kind: 'category', index: i });
		const fill = sliceColor(ctx, series, i);
		marks.push({ kind: 'rect', key: `cell-${i}`, role: 'cell', ...r, fill, stroke: selected ? theme.selection : theme.surface, strokeWidth: selected ? 2.5 : 1.5, target, selected });
		if (!labelsOn) return;
		const room = r.width - 8;
		if (room < fs * 2 || r.height < fs * 1.5) {
			unlabelled++;
			return;
		}
		const color = contrastingTextColor(fill);
		marks.push({ kind: 'text', key: `label-cell-${i}`, role: 'data-label', x: r.x + 4, y: r.y + 4, text: truncate(spec.categories[i], room, fs, measure), anchor: 'start', baseline: 'top', size: fs, weight: 600, fill: color, target });
		if (r.height >= fs * 3) marks.push({ kind: 'text', key: `label-value-${i}`, role: 'data-label', x: r.x + 4, y: r.y + 6 + fs * 1.2, text: truncate(formatChartNumber(values[i], format), room, fs - 1, measure), anchor: 'start', baseline: 'top', size: fs - 1, fill: color, target });
	});
	if (unlabelled) ctx.warn('data-labels-hidden', `${unlabelled} treemap cell${unlabelled === 1 ? ' is' : 's are'} too small for a label.`);
	return { plot: area };
}

export type { ChartMark };

/** Spreads label centres (sorted top to bottom) at least `gap` apart, kept within [top, bottom]. */
function dodge(ys: number[], gap: number, top: number, bottom: number): number[] {
	const out = [...ys];
	for (let k = 1; k < out.length; k++) out[k] = Math.max(out[k], out[k - 1] + gap);
	const over = out.length ? out[out.length - 1] - bottom : 0;
	if (over > 0) for (let k = out.length - 1; k >= 0; k--) out[k] = Math.max(top, Math.min(out[k] - over, k < out.length - 1 ? out[k + 1] - gap : Infinity));
	return out;
}

/** Slope: each category's value in the first series (left) joined to the second (right), labelled at both ends. */
export function layoutSlope(ctx: LayoutCtx, area: ChartRect, visible: ChartSeries[]): FamilyResult {
	const { spec, theme, marks, fs, measure } = ctx;
	const [a, b] = visible;
	if (visible.length > 2) ctx.warn('values-skipped', `A slope chart joins two series; ${visible.length - 2} more ${visible.length === 3 ? 'is' : 'are'} not drawn.`);
	const at = (s: ChartSeries, i: number) => {
		const v = s.values[i];
		return v !== null && Number.isFinite(v) ? v : null;
	};
	const all = spec.categories.flatMap((_, i) => [at(a, i), at(b, i)]).filter((v): v is number => v !== null);
	const lo = Math.min(...all);
	const hi = Math.max(...all);
	const labelsOn = a.dataLabels ?? b.dataLabels ?? spec.dataLabels;
	const fmtA = (v: number) => formatChartNumber(v, a.format ?? spec.yAxis.format);
	const fmtB = (v: number) => formatChartNumber(v, b.format ?? spec.yAxis.format);
	const leftText = (i: number) => {
		const v = at(a, i);
		return labelsOn && v !== null ? `${spec.categories[i]}  ${fmtA(v)}` : spec.categories[i];
	};
	const rightText = (i: number) => {
		const v = at(b, i);
		return labelsOn && v !== null ? `${fmtB(v)}  ${spec.categories[i]}` : spec.categories[i];
	};
	const maxW = area.width * 0.3;
	const leftW = Math.min(maxW, Math.max(0, ...spec.categories.map((_, i) => measure(leftText(i), fs))));
	const rightW = Math.min(maxW, Math.max(0, ...spec.categories.map((_, i) => measure(rightText(i), fs))));
	const headerH = fs * 1.8;
	const plot: ChartRect = { x: area.x + leftW + 10, y: area.y + headerH + fs / 2, width: Math.max(1, area.width - leftW - rightW - 20), height: Math.max(1, area.height - headerH - fs) };
	const scale = axisScale(lo, hi, plot.height, spec.yAxis, ctx.options.valueDomain, true);
	const yOf = (v: number) => linearMap(Math.min(scale.max, Math.max(scale.min, v)), [scale.min, scale.max], [plot.y + plot.height, plot.y]);
	const xL = plot.x;
	const xR = plot.x + plot.width;
	// Column captions: the series names, which say what "before" and "after" are.
	for (const [s, x, anchor] of [[a, xL, 'end'], [b, xR, 'start']] as const) {
		const target: ChartSelection = { kind: 'series', seriesId: s.id };
		const selected = ctx.seriesSelected(s.id);
		marks.push({ kind: 'line', key: `axis-slope-${s.id}`, role: 'axis', x1: x, y1: plot.y, x2: x, y2: plot.y + plot.height, stroke: theme.axis, strokeWidth: 1, target });
		marks.push({ kind: 'text', key: `axis-title-${s.id}`, role: 'axis-title', x, y: area.y, text: truncate(s.name, maxW + plot.width / 2, fs + 1, measure), anchor: anchor === 'end' ? 'end' : 'start', baseline: 'top', size: fs + 1, weight: 600, fill: selected ? theme.selection : theme.text, target, selected });
	}
	const leftLabels: { i: number; y: number }[] = [];
	const rightLabels: { i: number; y: number }[] = [];
	spec.categories.forEach((_, i) => {
		const va = at(a, i);
		const vb = at(b, i);
		const color = sliceColor(ctx, a, i);
		const catTarget: ChartSelection = { kind: 'category', index: i };
		const catSelected = ctx.isSelected(catTarget);
		if (va !== null && vb !== null)
			marks.push({ kind: 'line', key: `line-slope-${i}`, role: 'line', x1: xL, y1: yOf(va), x2: xR, y2: yOf(vb), stroke: color, strokeWidth: catSelected ? 3.5 : 2, target: catTarget, selected: catSelected });
		for (const [s, v, x, labels] of [[a, va, xL, leftLabels], [b, vb, xR, rightLabels]] as const) {
			if (v === null) continue;
			const target: ChartSelection = { kind: 'point', seriesId: s.id, index: i };
			const selected = ctx.isSelected(target);
			marks.push({ kind: 'circle', key: `point-${s.id}-${i}`, role: 'point', cx: x, cy: yOf(v), r: 4, fill: color, stroke: theme.surface, strokeWidth: 1.5, target, selected: selected || catSelected || ctx.seriesSelected(s.id) });
			if (selected) marks.push({ kind: 'circle', key: `point-${s.id}-${i}-selection`, role: 'selection', cx: x, cy: yOf(v), r: 7.5, fill: 'none', stroke: theme.selection, strokeWidth: 1.5 });
			labels.push({ i, y: yOf(v) });
		}
	});
	// Labels at both ends, pushed apart where values are close.
	let moved = 0;
	for (const [labels, x, anchor, text, width] of [[leftLabels, xL - 8, 'end', leftText, leftW], [rightLabels, xR + 8, 'start', rightText, rightW]] as const) {
		labels.sort((p, q) => p.y - q.y);
		const ys = dodge(labels.map((l) => l.y), fs * 1.15, plot.y - fs / 2, plot.y + plot.height + fs / 2);
		labels.forEach((l, k) => {
			if (Math.abs(ys[k] - l.y) > 0.5) moved++;
			const target: ChartSelection = { kind: 'category', index: l.i };
			const selected = ctx.isSelected(target);
			marks.push({ kind: 'text', key: `label-slope-${anchor === 'end' ? 'left' : 'right'}-${l.i}`, role: 'data-label', x, y: ys[k], text: truncate(text(l.i), width, fs, measure), anchor, baseline: 'middle', size: fs, fill: selected ? theme.selection : theme.text, weight: selected ? 600 : undefined, target, selected });
		});
	}
	if (moved) ctx.warn('labels-truncated', `${moved} slope label${moved === 1 ? ' was' : 's were'} moved off its point so the labels do not overlap.`);
	return { plot, valueScale: { axis: 'y', domain: [scale.min, scale.max], range: [plot.y + plot.height, plot.y], ticks: scale.ticks } };
}

/**
 * Likert: one diverging bar per category (a question), the series (answers) from most negative
 * to most positive, as shares of the question's total. Negative answers run left of the centre
 * line, positive ones right; with an odd number of answers the middle one straddles the centre
 * (`likertNeutral: 'split'`) or is drawn in its own column (`separate`).
 */
export function layoutLikert(ctx: LayoutCtx, area: ChartRect, visible: ChartSeries[]): FamilyResult {
	const { spec, theme, marks, fs, measure } = ctx;
	const n = visible.length;
	const side = Math.floor(n / 2);
	const neutral = n % 2 === 1 ? side : -1;
	const separate = neutral >= 0 && spec.likertNeutral === 'separate';
	if (spec.likertNeutral === 'separate' && neutral < 0) ctx.warn('type-fallback', 'A separate neutral column needs an odd number of answers; the middle answer is not set apart.');
	const shares = spec.categories.map((_, i) => {
		const raw = visible.map((s) => {
			const v = s.values[i];
			return v !== null && Number.isFinite(v) ? Math.max(0, v) : 0;
		});
		const total = raw.reduce((t, v) => t + v, 0);
		return raw.map((v) => (total ? v / total : 0));
	});
	const sum = (p: number[], from: number, to: number) => p.slice(from, to).reduce((t, v) => t + v, 0);
	const negOf = (p: number[]) => sum(p, 0, side) + (neutral >= 0 && !separate ? p[neutral] / 2 : 0);
	const posOf = (p: number[]) => sum(p, n - side, n) + (neutral >= 0 && !separate ? p[neutral] / 2 : 0);
	const rows = spec.categories.map((_, i) => i);
	if (spec.likertSort === 'positive') rows.sort((p, q) => sum(shares[q], n - side, n) - sum(shares[p], n - side, n));
	else if (spec.likertSort === 'negative') rows.sort((p, q) => sum(shares[q], 0, side) - sum(shares[p], 0, side));
	const extent = Math.max(0.01, ...shares.map((p) => Math.max(negOf(p), posOf(p))));
	const labelW = spec.xAxis.show ? Math.min(area.width * 0.35, Math.max(0, ...spec.categories.map((c) => measure(c, fs)))) + 10 : 4;
	const neutralW = separate ? Math.max(40, area.width * 0.18) : 0;
	const axisH = spec.yAxis.show ? fs * 1.6 : 2;
	const headH = separate ? fs * 1.5 : 0;
	const plot: ChartRect = { x: area.x + labelW, y: area.y + headH, width: Math.max(1, area.width - labelW - (separate ? neutralW + 14 : 0)), height: Math.max(1, area.height - axisH - headH) };
	const half = axisScale(0, extent, plot.width / 2, { ...spec.yAxis, min: 0, max: null, scale: undefined, reverse: undefined });
	const m = half.max;
	const xOf = (v: number) => plot.x + ((v + m) / (2 * m)) * plot.width;
	const percent = { style: 'percent' as const, decimals: spec.yAxis.format.decimals };
	const ticks = [...half.ticks.slice(1).map((t) => -t).reverse(), ...half.ticks];
	const axisTarget: ChartSelection = { kind: 'axis', axis: 'y' };
	ticks.forEach((t, k) => {
		const x = xOf(t);
		if (spec.yAxis.gridlines && t !== 0) marks.push({ kind: 'line', key: `grid-y-${k}`, role: 'grid', x1: x, y1: plot.y, x2: x, y2: plot.y + plot.height, stroke: theme.grid, strokeWidth: 1 });
		if (spec.yAxis.show) marks.push({ kind: 'text', key: `tick-y-${k}`, role: 'tick-label', x, y: plot.y + plot.height + 6, text: formatChartNumber(Math.abs(t), percent, percent.decimals ?? stepDecimals(half.step * 100)), anchor: 'middle', baseline: 'top', size: fs, fill: theme.mutedText, target: axisTarget });
	});
	const band = plot.height / Math.max(1, rows.length);
	const barH = Math.max(2, band * (1 - Math.min(0.9, spec.gapWidth)));
	const neutralMax = separate ? Math.max(0.01, ...shares.map((p) => p[neutral])) : 1;
	const neutralX = plot.x + plot.width + 14;
	if (separate) {
		const s = visible[neutral];
		marks.push({ kind: 'text', key: 'likert-neutral-title', role: 'axis-title', x: neutralX, y: area.y, text: truncate(s.name, neutralW, fs, measure), anchor: 'start', baseline: 'top', size: fs, weight: 600, fill: theme.mutedText, target: { kind: 'series', seriesId: s.id } });
	}
	let hidden = 0;
	rows.forEach((i, r) => {
		const p = shares[i];
		const y = plot.y + r * band + (band - barH) / 2;
		const catTarget: ChartSelection = { kind: 'category', index: i };
		const catSelected = ctx.isSelected(catTarget);
		if (spec.xAxis.show)
			marks.push({ kind: 'text', key: `tick-x-${i}`, role: 'tick-label', x: plot.x - 8, y: y + barH / 2, text: truncate(spec.categories[i], labelW - 10, fs, measure), anchor: 'end', baseline: 'middle', size: fs, fill: catSelected ? theme.selection : theme.mutedText, target: catTarget, selected: catSelected });
		const segment = (j: number, x0: number, x1: number, key: string) => {
			const s = visible[j];
			if (x1 - x0 <= 0) return;
			const target: ChartSelection = { kind: 'point', seriesId: s.id, index: i };
			const selected = ctx.isSelected(target);
			const fill = s.pointColors?.[i] || chartSeriesColor(spec, spec.series.indexOf(s));
			const rect = { x: x0, y, width: x1 - x0, height: barH };
			marks.push({ kind: 'rect', key, role: 'bar', ...rect, fill, target, selected: selected || ctx.seriesSelected(s.id) || catSelected });
			if (selected) ctx.outline(`${key}-selection`, { x: rect.x - 2, y: rect.y - 2, width: rect.width + 4, height: rect.height + 4 });
			if (!(s.dataLabels ?? spec.dataLabels)) return;
			const text = formatChartNumber(p[j], percent, percent.decimals ?? 0);
			if (measure(text, fs - 1) + 6 > rect.width || barH < fs) {
				hidden++;
				return;
			}
			marks.push({ kind: 'text', key: `label-${s.id}-${i}`, role: 'data-label', x: rect.x + rect.width / 2, y: y + barH / 2, text, anchor: 'middle', baseline: 'middle', size: fs - 1, fill: contrastingTextColor(fill), target });
		};
		let cursor = -negOf(p);
		visible.forEach((s, j) => {
			if (separate && j === neutral) return;
			segment(j, xOf(cursor), xOf(cursor + p[j]), `bar-${s.id}-${i}`);
			cursor += p[j];
		});
		if (separate) segment(neutral, neutralX, neutralX + (p[neutral] / neutralMax) * neutralW, `bar-${visible[neutral].id}-${i}`);
	});
	marks.push({ kind: 'line', key: 'axis-likert-centre', role: 'axis', x1: xOf(0), y1: plot.y, x2: xOf(0), y2: plot.y + plot.height, stroke: theme.axis, strokeWidth: 1.25, target: axisTarget });
	if (hidden) ctx.warn('data-labels-hidden', `${hidden} data label${hidden === 1 ? '' : 's'} did not fit and ${hidden === 1 ? 'is' : 'are'} hidden.`);
	return { plot, percent: true };
}

/** Parliament: the first series as seats in a hemicycle (rows of dots), one colour per category, with the majority line and the total. */
export function layoutParliament(ctx: LayoutCtx, area: ChartRect, series: ChartSeries): FamilyResult {
	const { spec, theme, marks, fs } = ctx;
	const seats = spec.categories.map((_, i) => {
		const v = series.values[i];
		return v !== null && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
	});
	if (series.values.some((v) => v !== null && Number.isFinite(v) && (v < 0 || !Number.isInteger(v)))) ctx.warn('values-skipped', 'Seats are whole numbers of 0 or more; other values were rounded.');
	const total = seats.reduce((t, v) => t + v, 0);
	const empty = (text: string) => {
		marks.push({ kind: 'text', key: 'empty', role: 'empty', x: area.x + area.width / 2, y: area.y + area.height / 2, text, anchor: 'middle', baseline: 'middle', size: fs + 1, fill: theme.mutedText });
		return { plot: area };
	};
	if (!total) return empty('No seats');
	if (total > 2000) return empty('Too many seats to draw (more than 2,000)');
	const arc = (spec.parliamentArc * Math.PI) / 180;
	const start = Math.PI / 2 + arc / 2;
	// The unit sector's bounds (the centre included) fit it into the area.
	const angles = [start, start - arc, ...[0, 0.5, 1, 1.5, 2, 2.5].map((k) => k * Math.PI).filter((t) => t < start && t > start - arc)];
	const xs = [0, ...angles.map(Math.cos)];
	const ys = [0, ...angles.map(Math.sin)];
	const pad = fs * 1.2;
	const radius = Math.max(8, Math.min((area.width - pad * 2) / (Math.max(...xs) - Math.min(...xs)), (area.height - pad * 2) / (Math.max(...ys) - Math.min(...ys))));
	const cx = area.x + area.width / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * radius;
	const cy = area.y + area.height / 2 + ((Math.max(...ys) + Math.min(...ys)) / 2) * radius;
	const inner = radius * 0.4;
	// Fewest rows that space seats along each arc about as far apart as the rows are (more rows: closer rows, wider spacing).
	let rows = 1;
	for (; rows < 60; rows++) {
		const gap = (radius - inner) / rows;
		const length = Array.from({ length: rows }, (_, k) => (inner + gap * (k + 0.5)) * arc).reduce((t, l) => t + l, 0);
		if (length / total >= gap * 0.9) break;
	}
	const gap = (radius - inner) / rows;
	const radii = Array.from({ length: rows }, (_, k) => inner + gap * (k + 0.5));
	const lengths = radii.map((r) => r * arc);
	const all = lengths.reduce((t, l) => t + l, 0);
	// Seats per row in proportion to its length (largest remainder).
	const exact = lengths.map((l) => (l / all) * total);
	const counts = exact.map(Math.floor);
	exact.map((e, k) => ({ k, rest: e - counts[k] })).sort((p, q) => q.rest - p.rest).slice(0, total - counts.reduce((t, c) => t + c, 0)).forEach(({ k }) => counts[k]++);
	const places: { angle: number; r: number }[] = [];
	radii.forEach((r, k) => {
		for (let j = 0; j < counts[k]; j++) places.push({ angle: counts[k] === 1 ? Math.PI / 2 : start - (arc * (j + 0.5)) / counts[k], r });
	});
	// Fill from the left: each group takes the next seats by angle.
	places.sort((p, q) => q.angle - p.angle || p.r - q.r);
	const dot = Math.max(1, Math.min(gap, all / total) * 0.42);
	let next = 0;
	seats.forEach((count, i) => {
		const target: ChartSelection = { kind: 'point', seriesId: series.id, index: i };
		const selected = ctx.isSelected(target) || ctx.isSelected({ kind: 'category', index: i }) || ctx.seriesSelected(series.id);
		const fill = sliceColor(ctx, series, i);
		for (let k = 0; k < count; k++, next++) {
			const { angle, r } = places[next];
			marks.push({ kind: 'circle', key: `seat-${i}-${k}`, role: 'point', cx: cx + r * Math.cos(angle), cy: cy - r * Math.sin(angle), r: dot, fill, ...(selected ? { stroke: theme.selection, strokeWidth: 1.5 } : {}), target, selected });
		}
	});
	const majority = spec.parliamentMajority ?? Math.floor(total / 2) + 1;
	if (majority <= total) {
		const angle = start - arc * (majority / total);
		const r0 = inner - gap * 0.3;
		const r1 = radius + gap * 0.3;
		marks.push({ kind: 'line', key: 'majority-line', role: 'reference-line', x1: cx + r0 * Math.cos(angle), y1: cy - r0 * Math.sin(angle), x2: cx + r1 * Math.cos(angle), y2: cy - r1 * Math.sin(angle), stroke: theme.text, strokeWidth: 1.25, dash: '4 3', opacity: 0.8 });
		const lr = r1 + fs * 0.4;
		const lx = cx + lr * Math.cos(angle);
		const ly = cy - lr * Math.sin(angle);
		marks.push({ kind: 'text', key: 'majority-label', role: 'reference-label', x: lx, y: ly, text: `Majority ${majority}`, anchor: Math.abs(Math.cos(angle)) < 0.25 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end', baseline: Math.sin(angle) >= 0 ? 'bottom' : 'top', size: fs - 1, weight: 500, fill: theme.text });
	} else ctx.warn('values-skipped', `The majority of ${majority} is more than the ${total} seats; the majority line is not drawn.`);
	if (inner > fs * 2.2) {
		const size = Math.min(theme.titleSize + 8, inner * 0.6);
		// A half circle has its centre on the base line: the total sits just above it.
		const ty = spec.parliamentArc <= 200 ? cy - size * 0.2 : cy;
		const totalTarget: ChartSelection = { kind: 'series', seriesId: series.id };
		marks.push({ kind: 'text', key: 'parliament-total', role: 'data-label', x: cx, y: ty, text: formatChartNumber(total, {}), anchor: 'middle', baseline: spec.parliamentArc <= 200 ? 'bottom' : 'middle', size, weight: 700, fill: theme.text, target: totalTarget });
		marks.push({ kind: 'text', key: 'parliament-caption', role: 'data-label', x: cx, y: spec.parliamentArc <= 200 ? ty + 2 : ty + size * 0.6, text: spec.parliamentLabel || 'seats', anchor: 'middle', baseline: 'top', size: fs, fill: theme.mutedText, target: totalTarget });
	}
	return { plot: { x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2 } };
}

/** The colour of a tree node: its own, else its top-level group's palette colour, shaded by `shade`. */
function treeColor(ctx: LayoutCtx, series: ChartSeries | undefined, node: ChartTreeNode, group: number, base: string | null, shade: number): string {
	if (node.color) return node.color;
	if (base === null) return series?.pointColors?.[group] || chartSliceColor(ctx.spec, group);
	return shadeChartColor(base, shade);
}

/**
 * Treemap of `spec.tree`: each group a rectangle sized by its total, its children squarified
 * inside under a header with its name, down to the leaves. Everything in a top-level group is
 * drawn in its colour (leaves in lighter and darker shades) and selects that category.
 */
export function layoutTreemapTree(ctx: LayoutCtx, area: ChartRect, series: ChartSeries | undefined): FamilyResult {
	const { spec, marks, theme, fs, measure } = ctx;
	const format = series?.format ?? spec.yAxis.format;
	const labelsOn = series?.dataLabels ?? true;
	let unlabelled = 0;
	const draw = (nodes: readonly ChartTreeNode[], rect: ChartRect, key: string, group: number | null, base: string | null) => {
		const rects = chartSquarify(nodes.map(chartTreeTotal), rect);
		nodes.forEach((node, k) => {
			const r = rects[k];
			if (r.width <= 0.5 || r.height <= 0.5) return;
			const g = group ?? k;
			const target: ChartSelection = { kind: 'category', index: g };
			const selected = ctx.isSelected(target) || ctx.isSelected({ kind: 'point', seriesId: series?.id ?? '', index: g });
			const id = `${key}-${k}`;
			// Leaves vary a little around their group's colour so neighbours stay apart.
			const fill = treeColor(ctx, series, node, g, base, base === null ? 0 : ((k % 4) - 1.5) * 0.14);
			if (node.children) {
				const header = r.height > fs * 3.2 && r.width > fs * 3 ? fs * 1.5 : 0;
				marks.push({ kind: 'rect', key: `group-${id}`, role: 'cell', ...r, fill, stroke: selected ? theme.selection : theme.surface, strokeWidth: selected ? 2.5 : 2, target, selected });
				if (header) marks.push({ kind: 'text', key: `label-group-${id}`, role: 'data-label', x: r.x + 5, y: r.y + 4, text: truncate(node.name, r.width - 10, fs, measure), anchor: 'start', baseline: 'top', size: fs, weight: 700, fill: contrastingTextColor(fill), target });
				const inner = { x: r.x + 2, y: r.y + (header || 2), width: Math.max(0, r.width - 4), height: Math.max(0, r.height - (header || 2) - 2) };
				draw(node.children, inner, id, g, base ?? fill);
				return;
			}
			marks.push({ kind: 'rect', key: `cell-${id}`, role: 'cell', ...r, fill, stroke: selected ? theme.selection : theme.surface, strokeWidth: selected ? 2.5 : 1, target, selected });
			if (!labelsOn) return;
			const room = r.width - 8;
			if (room < fs * 2 || r.height < fs * 1.5) {
				unlabelled++;
				return;
			}
			const color = contrastingTextColor(fill);
			marks.push({ kind: 'text', key: `label-cell-${id}`, role: 'data-label', x: r.x + 4, y: r.y + 4, text: truncate(node.name, room, fs, measure), anchor: 'start', baseline: 'top', size: fs, weight: 600, fill: color, target });
			if (r.height >= fs * 3) marks.push({ kind: 'text', key: `label-value-${id}`, role: 'data-label', x: r.x + 4, y: r.y + 6 + fs * 1.2, text: truncate(formatChartNumber(node.value ?? 0, format), room, fs - 1, measure), anchor: 'start', baseline: 'top', size: fs - 1, fill: color, target });
		});
	};
	draw(spec.tree, area, 'n', null, null);
	if (unlabelled) ctx.warn('data-labels-hidden', `${unlabelled} treemap cell${unlabelled === 1 ? ' is' : 's are'} too small for a label.`);
	return { plot: area };
}

/**
 * Sunburst: `spec.tree` as rings from the centre out, each node an arc sized by its total
 * inside its parent's arc (without a tree, the first series as one ring). Labels go on arcs
 * wide enough for them; the total and `sunburstLabel` sit in the centre.
 */
export function layoutSunburst(ctx: LayoutCtx, area: ChartRect, series: ChartSeries | undefined): FamilyResult {
	const { spec, marks, theme, fs, measure } = ctx;
	const tree = spec.tree.length ? spec.tree : chartTreeFromSeries(spec.categories, series?.values ?? []);
	const indexOf = new Map(spec.categories.map((c, i) => [c.trim() || `${i + 1}`, i] as const));
	const depth = chartTreeDepth(tree);
	const total = tree.reduce((t, n) => t + chartTreeTotal(n), 0);
	const cx = area.x + area.width / 2;
	const cy = area.y + area.height / 2;
	const outer = Math.max(8, Math.min(area.width, area.height) / 2 - 4);
	const plot = { x: cx - outer, y: cy - outer, width: outer * 2, height: outer * 2 };
	if (!(total > 0)) {
		marks.push({ kind: 'text', key: 'empty', role: 'empty', x: cx, y: cy, text: 'No positive values', anchor: 'middle', baseline: 'middle', size: fs + 1, fill: theme.mutedText });
		return { plot };
	}
	const hole = outer * 0.28;
	const ring = (outer - hole) / Math.max(1, depth);
	const format = series?.format ?? spec.yAxis.format;
	let unlabelled = 0;
	const walk = (nodes: readonly ChartTreeNode[], start: number, sweep: number, level: number, key: string, group: number | null, base: string | null) => {
		const sum = nodes.reduce((t, n) => t + chartTreeTotal(n), 0);
		let at = start;
		nodes.forEach((node, k) => {
			const value = chartTreeTotal(node);
			if (!(value > 0) || !sum) return;
			const a0 = at;
			const a1 = at + (sweep * value) / sum;
			at = a1;
			const g = group ?? indexOf.get(node.name) ?? k;
			const target: ChartSelection = { kind: 'category', index: g };
			const selected = ctx.isSelected(target) || ctx.isSelected({ kind: 'point', seriesId: series?.id ?? '', index: g });
			const fill = treeColor(ctx, series, node, g, base, 0.22 * level);
			const id = `${key}-${k}`;
			const r0 = hole + ring * level;
			const r1 = r0 + ring;
			marks.push({ kind: 'path', key: `slice-${id}`, role: 'slice', d: arcPath(cx, cy, r1, r0, a0, a1), fill, stroke: selected ? theme.selection : theme.surface, strokeWidth: selected ? 2 : 1, target, selected });
			const mid = (a0 + a1) / 2;
			const rm = (r0 + r1) / 2;
			const text = node.name;
			const width = measure(text, fs - 1);
			// Horizontal text fits where the arc's chord at mid radius is wider than the label.
			if (ring >= fs * 1.3 && 2 * rm * Math.sin(Math.min(Math.PI / 2, (a1 - a0) / 2)) >= width + 6) marks.push({ kind: 'text', key: `label-slice-${id}`, role: 'data-label', x: cx + rm * Math.sin(mid), y: cy - rm * Math.cos(mid), text, anchor: 'middle', baseline: 'middle', size: fs - 1, weight: level === 0 ? 600 : undefined, fill: contrastingTextColor(fill), target });
			else unlabelled++;
			if (node.children) walk(node.children, a0, a1 - a0, level + 1, id, g, base ?? fill);
		});
	};
	walk(tree, 0, Math.PI * 2, 0, 'n', null, null);
	if (unlabelled) ctx.warn('data-labels-hidden', `${unlabelled} sunburst arc${unlabelled === 1 ? ' is' : 's are'} too narrow for a label.`);
	if (hole > fs * 2) {
		const size = Math.min(theme.titleSize + 4, hole * 0.45);
		const centre: ChartSelection | undefined = series ? { kind: 'series', seriesId: series.id } : undefined;
		const caption = spec.sunburstLabel;
		marks.push({ kind: 'text', key: 'sunburst-total', role: 'data-label', x: cx, y: caption ? cy - 2 : cy, text: formatChartNumber(total, format), anchor: 'middle', baseline: caption ? 'bottom' : 'middle', size, weight: 700, fill: theme.text, ...(centre ? { target: centre } : {}) });
		if (caption) marks.push({ kind: 'text', key: 'sunburst-caption', role: 'data-label', x: cx, y: cy + 2, text: truncate(caption, hole * 1.8, fs - 1, measure), anchor: 'middle', baseline: 'top', size: fs - 1, fill: theme.mutedText, ...(centre ? { target: centre } : {}) });
	}
	return { plot };
}
