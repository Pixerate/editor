// Waterfall, funnel, radar, histogram, box-and-whisker and treemap layouts follow
// gridcraft-main/crates/chart/src/render.rs (`waterfall`, `funnel`, `radar`, `histogram`, `box_whisker`,
// `treemap`) (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { categoryFrame, toValueScale } from './layout-cartesian.js';
import { arcPath, axisScale, contrastingTextColor, r2, truncate, type FamilyResult, type LayoutCtx } from './layout-shared.js';
import { formatChartNumber, linearMap, stepDecimals } from './scale.js';
import { chartSeriesColor, chartSliceColor } from './spec.js';
import { chartBoxStats, chartHistogram, chartSquarify } from './stats.js';
import type { ChartMark, ChartRect, ChartSelection, ChartSeries } from './types.js';

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
	const scale = axisScale(lo, hi, radius, spec.yAxis, ctx.options.valueDomain);
	const rOf = (v: number) => linearMap(Math.min(scale.max, Math.max(scale.min, v)), [scale.min, scale.max], [0, radius]);
	const angle = (i: number) => (i / n) * Math.PI * 2;
	const at = (i: number, r: number): [number, number] => [cx + r * Math.sin(angle(i)), cy - r * Math.cos(angle(i))];
	const yTarget: ChartSelection = { kind: 'axis', axis: 'y' };
	// Rings and spokes
	if (spec.yAxis.gridlines)
		scale.ticks.forEach((t, k) => {
			const r = rOf(t);
			if (r <= 0) return;
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
