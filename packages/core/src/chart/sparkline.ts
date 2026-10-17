// Ported from gridcraft-main/crates/chart/src/sparkline.rs (MIT OR Apache-2.0, © ArtCraft Team and
// contributors). See THIRD_PARTY_NOTICES.md.
import { r2 } from './layout-shared.js';
import { chartSceneToSvg } from './svg.js';
import { DEFAULT_CHART_THEME } from './spec.js';
import type { ChartMark, ChartScene, ChartValue } from './types.js';

export type ChartSparklineKind = 'line' | 'column' | 'win-loss';

export interface ChartSparklineOptions {
	kind?: ChartSparklineKind;
	width: number;
	height: number;
	/** Line, positive column and win colour (default the first palette colour). */
	color?: string;
	/** Negative column and loss colour (default red). */
	negativeColor?: string;
	/** Dots on every line point (thinned past 500). */
	markers?: boolean;
	/** Highlight the highest and lowest point of a line (or column). */
	highLow?: boolean;
	/** Fixed value range (default: the data, including 0 for columns). */
	min?: number;
	max?: number;
}

const MAX_POINTS = 100_000;

/**
 * Lays out a word-sized chart (a sparkline) as marks: a line broken at gaps, columns
 * (negatives in `negativeColor`) or win/loss bars of equal height. Long lines are thinned past
 * 4000 points. Returns a scene with no axes, legend or targets.
 */
export function layoutSparkline(values: readonly ChartValue[], options: ChartSparklineOptions): ChartScene {
	const kind = options.kind ?? 'line';
	const w = Number.isFinite(options.width) ? Math.max(1, options.width) : 1;
	const h = Number.isFinite(options.height) ? Math.max(1, options.height) : 1;
	const color = options.color ?? '#4269d0';
	const negative = options.negativeColor ?? '#e5484d';
	const theme = { ...DEFAULT_CHART_THEME, background: 'transparent' };
	const marks: ChartMark[] = [];
	const scene: ChartScene = { width: w, height: h, plot: { x: 0, y: 0, width: w, height: h }, marks, percent: false, theme, warnings: [] };
	const vals = values.slice(0, MAX_POINTS).map((v) => (v !== null && Number.isFinite(v) ? Math.max(-1e300, Math.min(1e300, v)) : null));
	const n = vals.length;
	if (!n) return scene;
	const pad = Math.max(0.5, Math.min(2, h * 0.1));
	const x0 = pad;
	const y0 = pad;
	const iw = Math.max(0.5, w - 2 * pad);
	const ih = Math.max(0.5, h - 2 * pad);
	let lo = Infinity;
	let hi = -Infinity;
	for (const v of vals) if (v !== null) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
	if (!Number.isFinite(lo)) return scene;
	if (options.min !== undefined && Number.isFinite(options.min)) lo = options.min;
	if (options.max !== undefined && Number.isFinite(options.max)) hi = options.max;
	let hiAt = -1;
	let loAt = -1;
	vals.forEach((v, i) => {
		if (v === null) return;
		if (hiAt < 0 || v > vals[hiAt]!) hiAt = i;
		if (loAt < 0 || v < vals[loAt]!) loAt = i;
	});
	if (kind === 'line') {
		const span = hi - lo;
		const fy = (v: number) => y0 + ih - (span > 0 ? (v - lo) / span : 0.5) * ih;
		const fx = (j: number) => (n > 1 ? x0 + (j / (n - 1)) * iw : x0 + iw / 2);
		let d = '';
		let run: [number, number][] = [];
		const flush = () => {
			if (run.length >= 2) {
				const pts = run.length > 4000 ? run.filter((_, i) => i % (Math.floor(run.length / 2000) + 1) === 0) : run;
				d += pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r2(x)},${r2(y)}`).join('');
			}
			run = [];
		};
		vals.forEach((v, j) => (v === null ? flush() : run.push([fx(j), fy(v)])));
		flush();
		if (d) marks.push({ kind: 'path', key: 'sparkline', role: 'line', d, fill: 'none', stroke: color, strokeWidth: 1.25 });
		const r = Math.max(1, Math.min(3, h * 0.08));
		if (options.markers || n === 1) {
			const step = Math.max(1, Math.floor(n / 500));
			vals.forEach((v, j) => {
				if (v !== null && j % step === 0) marks.push({ kind: 'circle', key: `point-${j}`, role: 'point', cx: fx(j), cy: fy(v), r, fill: color });
			});
		}
		if (options.highLow && n > 1) {
			if (hiAt >= 0) marks.push({ kind: 'circle', key: 'high', role: 'point', cx: fx(hiAt), cy: fy(vals[hiAt]!), r: r + 0.5, fill: color });
			if (loAt >= 0 && loAt !== hiAt) marks.push({ kind: 'circle', key: 'low', role: 'point', cx: fx(loAt), cy: fy(vals[loAt]!), r: r + 0.5, fill: negative });
		}
		return scene;
	}
	const slot = iw / n;
	const bw = Math.max(0.25, slot * 0.8);
	const win = kind === 'win-loss';
	const lo0 = win ? -1 : Math.min(lo, 0);
	const hi0 = win ? 1 : Math.max(hi, 0);
	const span = hi0 - lo0;
	const fy = (v: number) => (span > 0 ? y0 + ih - ((v - lo0) / span) * ih : y0 + ih);
	const base = fy(0);
	vals.forEach((raw, j) => {
		if (raw === null) return;
		const v = win ? Math.sign(raw) : raw;
		if (win && v === 0) return;
		const top = fy(v);
		const highlight = options.highLow && !win && (j === hiAt || j === loAt);
		marks.push({ kind: 'rect', key: `bar-${j}`, role: 'bar', x: x0 + j * slot + (slot - bw) / 2, y: Math.min(top, base), width: bw, height: Math.max(0.5, Math.abs(top - base)), fill: v < 0 ? negative : color, opacity: options.highLow && !win && !highlight ? 0.6 : undefined });
	});
	return scene;
}

/** A sparkline as a standalone SVG string (e.g. for an inline image in rich text). */
export function sparklineToSvg(values: readonly ChartValue[], options: ChartSparklineOptions & { ariaLabel?: string }): string {
	return chartSceneToSvg(layoutSparkline(values, options), { ariaLabel: options.ariaLabel });
}
