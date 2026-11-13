/**
 * A chart laid out in 3-D (#795): bars as boxes and line or area series as ribbons, in world
 * units, for a renderer that draws 3-D (`@pixerate/editor/three`). Pure geometry with no
 * renderer, so it can be tested without WebGL and ported like the 2-D layout.
 *
 * World axes: x runs along the categories (one unit per category), y up along the values, z
 * back into the picture. The floor is y = 0 at the value axis' minimum.
 */
import { CHART_VIEW3D_DEFAULTS, chartPointColor, chartSeriesColor } from './spec.js';
import { formatChartNumber, niceScale } from './scale.js';
import type { ChartSpec, ChartView3d } from './types.js';

/** One bar (or one stacked segment) as a box. */
export interface Chart3dBox {
	seriesId: string;
	/** Category index. */
	index: number;
	value: number;
	color: string;
	x0: number;
	x1: number;
	y0: number;
	y1: number;
	z0: number;
	z1: number;
}

/** A line or area series as a ribbon of thickness `z1 - z0` through its points. */
export interface Chart3dRibbon {
	seriesId: string;
	kind: 'line' | 'area';
	color: string;
	/** One point per category with a value, in order (`x` at the category centre, `y` the value). */
	points: { index: number; x: number; y: number }[];
	z0: number;
	z1: number;
}

export interface Chart3dLayout {
	/** Extent along x (categories), y (values) and z (depth), in world units. */
	width: number;
	height: number;
	depth: number;
	boxes: Chart3dBox[];
	ribbons: Chart3dRibbon[];
	/** Value axis ticks with their height and label. */
	ticks: { value: number; y: number; label: string }[];
	/** Category labels at the front of the floor. */
	categories: { label: string; x: number }[];
	view: ChartView3d;
	/** What could not be drawn in 3-D, in sentences. */
	warnings: string[];
}

/** Chart types drawn in 3-D. Others are drawn flat. */
export const CHART_3D_TYPES: readonly ChartSpec['type'][] = ['bar', 'line', 'area'];

/** World height of the value axis, as a multiple of the number of categories (at least 3). */
const HEIGHT_PER_CATEGORY = 0.6;

/**
 * Lays out `spec` in 3-D: bars side by side within each category (or stacked), lines and areas as
 * ribbons, each in its own row behind the bars. `spec.view3d` gives the depth (default Office's).
 */
export function layoutChart3d(spec: ChartSpec): Chart3dLayout {
	const view = spec.view3d ?? CHART_VIEW3D_DEFAULTS;
	const warnings: string[] = [];
	const n = Math.max(1, spec.categories.length);
	const width = n;
	const height = HEIGHT_PER_CATEGORY * Math.max(3, n);
	const empty = (message: string): Chart3dLayout => ({ width, height, depth: 1, boxes: [], ribbons: [], ticks: [], categories: [], view, warnings: [message] });
	if (!CHART_3D_TYPES.includes(spec.type)) return empty(`Only bar, line and area charts are drawn in 3-D; this ${spec.type} chart is drawn flat.`);
	if (spec.orientation === 'horizontal') warnings.push('Horizontal bars are drawn as columns in 3-D.');
	if (spec.yAxis.scale === 'log') warnings.push('A logarithmic value axis is drawn linear in 3-D.');
	const visible = spec.series.map((s, si) => ({ s, si })).filter(({ s }) => !s.hidden);
	if (visible.some(({ s }) => s.axis === 'secondary')) warnings.push('Series on the secondary axis share the main value axis in 3-D.');
	const typeOf = (s: (typeof spec.series)[number]) => s.type ?? (spec.type === 'line' ? 'line' : spec.type === 'area' ? 'area' : 'bar');
	const bars = visible.filter(({ s }) => typeOf(s) === 'bar');
	const rows = visible.filter(({ s }) => typeOf(s) === 'line' || typeOf(s) === 'area');
	for (const { s } of visible) if (typeOf(s) === 'scatter') warnings.push(`"${s.name}" is a scatter series and is not drawn in 3-D.`);
	const stacked = spec.stacking !== 'none';

	// The value range: stacks sum, percent stacks run to 100.
	const values: number[] = [0];
	if (stacked && bars.length) {
		for (let i = 0; i < spec.categories.length; i++) {
			let up = 0;
			let down = 0;
			for (const { s } of bars) {
				const v = s.values[i];
				if (typeof v !== 'number' || !Number.isFinite(v)) continue;
				if (v >= 0) up += v;
				else down += v;
			}
			const total = up - down;
			values.push(spec.stacking === 'percent' ? (total ? (up / total) * 100 : 0) : up, spec.stacking === 'percent' ? (total ? (down / total) * 100 : 0) : down);
		}
	} else for (const { s } of bars) for (const v of s.values) if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
	for (const { s } of rows) for (const v of s.values) if (typeof v === 'number' && Number.isFinite(v)) values.push(v);
	const scale = niceScale(Math.min(...values), Math.max(...values), 5, spec.yAxis.min, spec.yAxis.max);
	const span = scale.max - scale.min || 1;
	const yOf = (v: number) => ((Math.max(scale.min, Math.min(scale.max, v)) - scale.min) / span) * height;

	// Bars: side by side within the category's group width (or one stack), depth from the view.
	const gap = Math.max(0, Math.min(0.9, spec.gapWidth));
	const group = 1 - gap;
	const slots = stacked ? 1 : Math.max(1, bars.length);
	const barWidth = group / slots;
	const barDepth = Math.min(4, barWidth * view.depth);
	const boxes: Chart3dBox[] = [];
	for (let i = 0; i < spec.categories.length; i++) {
		let up = 0;
		let down = 0;
		let total = 0;
		if (spec.stacking === 'percent') for (const { s } of bars) total += Math.abs(typeof s.values[i] === 'number' ? (s.values[i] as number) : 0);
		bars.forEach(({ s, si }, k) => {
			const raw = s.values[i];
			if (typeof raw !== 'number' || !Number.isFinite(raw)) return;
			const v = spec.stacking === 'percent' ? (total ? (raw / total) * 100 : 0) : raw;
			let from = Math.max(scale.min, 0);
			let to = v;
			if (stacked) {
				from = v >= 0 ? up : down;
				to = from + v;
				if (v >= 0) up = to;
				else down = to;
			}
			const x0 = i + gap / 2 + (stacked ? 0 : k) * barWidth;
			const [y0, y1] = [yOf(Math.min(from, to)), yOf(Math.max(from, to))];
			boxes.push({ seriesId: s.id, index: i, value: raw, color: chartPointColor(spec, si, i), x0, x1: x0 + barWidth, y0, y1, z0: 0, z1: barDepth });
		});
	}

	// Lines and areas: one ribbon each, in rows behind the bars.
	const rowDepth = Math.max(0.15, Math.min(1, view.depth * 0.25));
	const rowGap = rowDepth * 0.6;
	let z = boxes.length ? barDepth + rowGap : 0;
	const ribbons: Chart3dRibbon[] = rows.map(({ s, si }) => {
		const points: Chart3dRibbon['points'] = [];
		s.values.forEach((v, i) => {
			if (typeof v === 'number' && Number.isFinite(v) && i < spec.categories.length) points.push({ index: i, x: i + 0.5, y: yOf(v) });
		});
		const ribbon: Chart3dRibbon = { seriesId: s.id, kind: typeOf(s) === 'area' ? 'area' : 'line', color: chartSeriesColor(spec, si), points, z0: z, z1: z + rowDepth };
		z += rowDepth + rowGap;
		return ribbon;
	});
	const depth = Math.max(barDepth, z - (ribbons.length ? rowGap : 0), 0.5);
	const format = spec.yAxis.format ?? {};
	return {
		width,
		height,
		depth,
		boxes,
		ribbons,
		ticks: scale.ticks.map((value) => ({ value, y: yOf(value), label: formatChartNumber(value, spec.stacking === 'percent' ? { ...format, suffix: '%' } : format) })),
		categories: spec.categories.map((label, i) => ({ label, x: i + 0.5 })),
		view,
		warnings
	};
}
