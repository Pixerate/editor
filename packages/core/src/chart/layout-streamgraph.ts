import { categoryFrame, toValueScale } from './layout-cartesian.js';
import { curvePath, r2, type FamilyResult, type LayoutCtx, type Pt } from './layout-shared.js';
import { chartSeriesColor } from './spec.js';
import type { ChartRect, ChartSelection, ChartSeries } from './types.js';

/**
 * Lays out a streamgraph: series stacked symmetrically around a center baseline (silhouette offset).
 *
 * For each category index i:
 *   total(i) = sum_{s} v_s(i)  (where v_s(i) >= 0)
 *   y0(i) = -0.5 * total(i)
 *
 * Layers stack upwards from y0:
 *   layer_s: from y_bottom = y0 + prefix_sum to y_top = y_bottom + v_s(i)
 *
 * The value domain is symmetric: [-maxHalf, maxHalf].
 */
export function layoutStreamgraph(ctx: LayoutCtx, area: ChartRect, visible: ChartSeries[]): FamilyResult {
	const { spec, theme, marks, selection } = ctx;
	const n = spec.categories.length;

	if (!visible.length || n === 0) {
		const plot: ChartRect = { x: area.x + 8, y: area.y + 8, width: Math.max(1, area.width - 16), height: Math.max(1, area.height - 16) };
		marks.push({
			kind: 'text',
			key: 'empty',
			role: 'empty',
			x: plot.x + plot.width / 2,
			y: plot.y + plot.height / 2,
			text: ctx.options.emptyMessage ?? 'No data',
			anchor: 'middle',
			baseline: 'middle',
			size: ctx.fs + 1,
			fill: theme.mutedText
		});
		return { plot };
	}

	// Calculate column totals across visible series (non-negative)
	const totals = new Array<number>(n).fill(0);
	for (let i = 0; i < n; i++) {
		let colSum = 0;
		for (const s of visible) {
			const v = s.values[i];
			if (v !== null && Number.isFinite(v) && v > 0) {
				colSum += v;
			}
		}
		totals[i] = colSum;
	}

	const maxTotal = Math.max(0, ...totals);
	const halfTotal = maxTotal > 0 ? maxTotal / 2 : 1;
	const headroom = spec.yAxis.max === null;
	const maxHalf = headroom ? halfTotal * 1.15 : halfTotal;

	const lo = -maxHalf;
	const hi = maxHalf;

	const frame = categoryFrame(ctx, area, {
		labels: spec.categories,
		horizontal: spec.orientation === 'horizontal',
		primary: {
			lo,
			hi,
			axis: spec.yAxis,
			format: spec.yAxis.format,
			frozen: ctx.options.valueDomain,
			key: 'y'
		}
	});

	const { plot, catCenter, map, value } = frame;
	const curve = spec.curve === 'step' ? 'linear' : spec.curve;

	// Baseline silhouette offset per category: y0(i) = -0.5 * total(i)
	const baselines = totals.map((t) => -0.5 * t);

	// Running stack positions per category
	const currentOffsets = [...baselines];

	// Center zero rule (baseline)
	const zeroPx = value.px(0);
	const [zx1, zy1] = map({ c: frame.catStart, v: zeroPx });
	const [zx2, zy2] = map({ c: frame.catStart + frame.catLen, v: zeroPx });
	marks.push({
		kind: 'line',
		key: 'rule-zero',
		role: 'grid',
		x1: zx1,
		y1: zy1,
		x2: zx2,
		y2: zy2,
		stroke: theme.axis,
		strokeWidth: 1,
		dash: '3,3'
	});

	// For each series, compute bottom and top runs
	interface SeriesLayer {
		series: ChartSeries;
		color: string;
		selSeries: boolean;
		bottomPts: Pt[];
		topPts: Pt[];
	}

	const layers: SeriesLayer[] = [];

	for (let sIdx = 0; sIdx < visible.length; sIdx++) {
		const s = visible[sIdx];
		const color = chartSeriesColor(spec, spec.series.indexOf(s));
		const selSeries = ctx.seriesSelected(s.id);

		const bottomPts: Pt[] = [];
		const topPts: Pt[] = [];

		for (let i = 0; i < n; i++) {
			const c = catCenter(i);
			const rawVal = s.values[i];
			const val = rawVal !== null && Number.isFinite(rawVal) && rawVal > 0 ? rawVal : 0;
			const bVal = currentOffsets[i];
			const tVal = bVal + val;
			currentOffsets[i] = tVal;

			bottomPts.push({ c, v: value.px(bVal), i });
			topPts.push({ c, v: value.px(tVal), i });
		}

		layers.push({ series: s, color, selSeries, bottomPts, topPts });
	}

	// Draw area ribbons (from bottom to top)
	for (const layer of layers) {
		const { series: s, color, selSeries, bottomPts, topPts } = layer;
		const seriesTarget: ChartSelection = { kind: 'series', seriesId: s.id };

		// Path: top forward, then bottom backward
		const revBottom = [...bottomPts].reverse();
		const d = `${curvePath(topPts, curve, map)}${curvePath(revBottom, curve, map, false)}Z`;

		marks.push({
			kind: 'path',
			key: `area-${s.id}`,
			role: 'area',
			d,
			fill: color,
			opacity: selSeries ? 0.85 : 0.65,
			target: seriesTarget,
			selected: selSeries
		});
	}

	// Draw crisp boundary lines (splines) along top of each layer and bottom of first layer
	if (layers.length > 0) {
		const bottomBase = layers[0].bottomPts;
		marks.push({
			kind: 'path',
			key: `boundary-bottom`,
			role: 'line',
			d: curvePath(bottomBase, curve, map),
			fill: 'none',
			stroke: theme.axis,
			strokeWidth: 1.5,
			opacity: 0.7
		});
	}

	for (const layer of layers) {
		const { series: s, color, selSeries, topPts } = layer;
		const seriesTarget: ChartSelection = { kind: 'series', seriesId: s.id };

		marks.push({
			kind: 'path',
			key: `line-${s.id}`,
			role: 'line',
			d: curvePath(topPts, curve, map),
			fill: 'none',
			stroke: color,
			strokeWidth: selSeries ? 3 : 1.75,
			target: seriesTarget,
			selected: selSeries
		});
	}

	// Draw interactive point targets (invisible or visible dots for hover / click / tooltip)
	const showDots = spec.points;
	for (const layer of layers) {
		const { series: s, color } = layer;
		for (let i = 0; i < n; i++) {
			const rawVal = s.values[i];
			if (rawVal === null || !Number.isFinite(rawVal)) continue;

			// Position point in the vertical middle of the ribbon at this category
			const bPt = layer.bottomPts[i];
			const tPt = layer.topPts[i];
			const midV = (bPt.v + tPt.v) / 2;
			const [cx, cy] = map({ c: bPt.c, v: midV });

			const target: ChartSelection = { kind: 'point', seriesId: s.id, index: i };
			const selected = ctx.isSelected(target);

			if (showDots || selected) {
				marks.push({
					kind: 'circle',
					key: `pt-${s.id}-${i}`,
					role: 'point',
					cx: r2(cx),
					cy: r2(cy),
					r: selected ? 5 : 3.5,
					fill: selected ? theme.selection : color,
					stroke: theme.surface,
					strokeWidth: 1.5,
					target,
					selected
				});
			} else {
				// Invisible target for hit-testing / tooltip anchoring
				marks.push({
					kind: 'circle',
					key: `hit-${s.id}-${i}`,
					role: 'point',
					cx: r2(cx),
					cy: r2(cy),
					r: 6,
					fill: 'transparent',
					stroke: 'none',
					target
				});
			}
		}
	}

	return {
		plot,
		valueScale: toValueScale(value, frame.horizontal ? 'x' : 'y'),
		categoryScale: { axis: frame.horizontal ? 'y' : 'x', start: frame.catStart, length: frame.catLen, count: frame.n, reverse: !!spec.xAxis.reverse }
	};
}
