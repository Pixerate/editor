// Portions ported from gridcraft-main/crates/chart/src/render.rs (`histogram` binning, `quantile` and
// `box_whisker` statistics, `squarify` treemap layout, `decimate`) (MIT OR Apache-2.0, © ArtCraft Team and
// contributors). See THIRD_PARTY_NOTICES.md.
import type { ChartRect, ChartValue } from './types.js';

export interface ChartHistogramBin {
	/** Lower edge (exclusive, except for the first bin). */
	from: number;
	/** Upper edge (inclusive). */
	to: number;
	count: number;
}

/**
 * Bins values into `bins` equal-width bins (default √n, from 1 to 100). Bins are
 * right-inclusive, the first closed on both sides, so a value on an edge belongs to the bin
 * that ends there. Gaps and non-finite values are ignored.
 */
export function chartHistogram(values: readonly ChartValue[], bins: number | null = null): ChartHistogramBin[] {
	const vals = values.filter((v): v is number => v !== null && Number.isFinite(v));
	if (!vals.length) return [];
	let lo = Infinity;
	let hi = -Infinity;
	for (const v of vals) {
		lo = Math.min(lo, v);
		hi = Math.max(hi, v);
	}
	const span = hi - lo;
	let count = bins ?? Math.max(1, Math.min(100, Math.ceil(Math.sqrt(vals.length))));
	if (!(span > 0)) count = 1;
	const width = count === 1 && !(span > 0) ? 1 : span / count;
	const edges = Array.from({ length: count }, (_, b) => (b + 1 === count ? Math.max(hi, lo + b * width) : lo + (b + 1) * width));
	const counts = Array<number>(count).fill(0);
	for (const v of vals) {
		// First edge >= v (binary search).
		let a = 0;
		let z = count;
		while (a < z) {
			const mid = (a + z) >> 1;
			if (edges[mid] < v) a = mid + 1;
			else z = mid;
		}
		counts[Math.min(a, count - 1)]++;
	}
	return counts.map((c, b) => ({ from: clean(lo + b * width), to: clean(edges[b]), count: c }));
}

const clean = (n: number) => (Math.abs(n) < 1e-12 ? 0 : Number(n.toPrecision(12)));

/** The `q` quantile (0–1) of sorted values, interpolating linearly between ranks (`q·(n-1)`). */
export function chartQuantile(sorted: readonly number[], q: number): number {
	const n = sorted.length;
	if (!n) return 0;
	const pos = q * (n - 1);
	const i = Math.floor(pos);
	const a = sorted[i];
	const b = sorted[i + 1] ?? a;
	return a + (b - a) * (pos - i);
}

export interface ChartBoxStats {
	min: number;
	max: number;
	q1: number;
	median: number;
	q3: number;
	mean: number;
	/** Whisker ends: the furthest values within 1.5 × IQR of the box. */
	lowerWhisker: number;
	upperWhisker: number;
	/** Values beyond the whiskers. */
	outliers: number[];
	count: number;
}

/** Box-and-whisker statistics (Tukey fences at 1.5 × IQR); `null` without values. */
export function chartBoxStats(values: readonly ChartValue[]): ChartBoxStats | null {
	const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
	if (!v.length) return null;
	const q1 = chartQuantile(v, 0.25);
	const median = chartQuantile(v, 0.5);
	const q3 = chartQuantile(v, 0.75);
	const iqr = q3 - q1;
	const lo = q1 - 1.5 * iqr;
	const hi = q3 + 1.5 * iqr;
	return {
		min: v[0],
		max: v[v.length - 1],
		q1,
		median,
		q3,
		mean: v.reduce((t, x) => t + x, 0) / v.length,
		lowerWhisker: v.find((x) => x >= lo) ?? q1,
		upperWhisker: [...v].reverse().find((x) => x <= hi) ?? q3,
		outliers: v.filter((x) => x < lo || x > hi),
		count: v.length
	};
}

/** Squarified treemap (Bruls et al.): positive `values` packed into `rect`, largest first. Returns one rect per input index (zero-size for values ≤ 0). */
export function chartSquarify(values: readonly number[], rect: ChartRect): ChartRect[] {
	const out: ChartRect[] = values.map(() => ({ x: rect.x, y: rect.y, width: 0, height: 0 }));
	const items = values
		.map((v, i) => [i, v] as [number, number])
		.filter(([, v]) => v > 0 && Number.isFinite(v))
		.sort((a, b) => b[1] - a[1]);
	const total = items.reduce((t, [, v]) => t + v, 0);
	const area = rect.width * rect.height;
	if (!(total > 0 && area > 0)) return out;
	const scale = area / total;
	const rem = { ...rect };
	let row: [number, number][] = [];
	const worst = (r: number[], side: number) => {
		const s = r.reduce((t, v) => t + v, 0);
		if (s <= 0 || side <= 0) return Infinity;
		const mn = Math.min(...r);
		const mx = Math.max(...r);
		return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
	};
	const layoutRow = (r: [number, number][]) => {
		const s = r.reduce((t, [, a]) => t + a, 0);
		if (s <= 0) return;
		if (rem.width >= rem.height) {
			const cw = s / Math.max(1e-6, rem.height);
			let y = rem.y;
			for (const [j, a] of r) {
				const h = a / Math.max(1e-6, cw);
				out[j] = { x: rem.x, y, width: cw, height: h };
				y += h;
			}
			rem.x += cw;
			rem.width = Math.max(0, rem.width - cw);
		} else {
			const rh = s / Math.max(1e-6, rem.width);
			let x = rem.x;
			for (const [j, a] of r) {
				const w = a / Math.max(1e-6, rh);
				out[j] = { x, y: rem.y, width: w, height: rh };
				x += w;
			}
			rem.y += rh;
			rem.height = Math.max(0, rem.height - rh);
		}
	};
	let i = 0;
	while (i < items.length) {
		const [j, v] = items[i];
		const a = v * scale;
		const side = Math.min(rem.width, rem.height);
		const cur = row.map(([, x]) => x);
		if (!row.length || worst([...cur, a], side) <= worst(cur, side)) {
			row.push([j, a]);
			i++;
		} else {
			layoutRow(row);
			row = [];
		}
	}
	if (row.length) layoutRow(row);
	return out;
}

/**
 * Thins a long polyline (sorted by x) to the first, lowest, highest and last point of each
 * pixel column, which draws identically. Returns the input when it has `max` points or fewer.
 */
export function decimateChartPoints<T extends { x: number; y: number }>(points: readonly T[], max = 2000): T[] {
	if (points.length <= max) return [...points];
	const out: T[] = [];
	let i = 0;
	while (i < points.length) {
		const col = Math.floor(points[i].x);
		const start = i;
		let mn = i;
		let mx = i;
		let k = i + 1;
		while (k < points.length && Math.floor(points[k].x) === col) {
			if (points[k].y < points[mn].y) mn = k;
			if (points[k].y > points[mx].y) mx = k;
			k++;
		}
		const end = k - 1;
		for (const idx of [...new Set([start, mn, mx, end])].sort((a, b) => a - b)) out.push(points[idx]);
		i = k;
	}
	return out;
}

export interface ChartSeriesSummary {
	id: string;
	name: string;
	/** Values present (not gaps). */
	count: number;
	gaps: number;
	min: number | null;
	max: number | null;
	mean: number | null;
	sum: number | null;
	/** Category label of the minimum and maximum. */
	minAt: string | null;
	maxAt: string | null;
	/** Direction of a least-squares line through the values in order. */
	trend: 'rising' | 'falling' | 'flat' | null;
	/** Relative change from the first to the last value, e.g. 0.25 for +25%. */
	change: number | null;
}

const round = (n: number) => Number(n.toPrecision(6));

/** Numbers about one series, for agents that check a chart without looking at it. */
export function summarizeChartSeries(series: { id: string; name: string; values: readonly ChartValue[] }, categories: readonly string[]): ChartSeriesSummary {
	const present = series.values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null && Number.isFinite(p[1]));
	const base: ChartSeriesSummary = { id: series.id, name: series.name, count: present.length, gaps: series.values.length - present.length, min: null, max: null, mean: null, sum: null, minAt: null, maxAt: null, trend: null, change: null };
	if (!present.length) return base;
	let lo = present[0];
	let hi = present[0];
	let sum = 0;
	for (const p of present) {
		if (p[1] < lo[1]) lo = p;
		if (p[1] > hi[1]) hi = p;
		sum += p[1];
	}
	const mean = sum / present.length;
	let trend: ChartSeriesSummary['trend'] = null;
	if (present.length >= 2) {
		const mx = present.reduce((t, p) => t + p[0], 0) / present.length;
		let sxy = 0;
		let sxx = 0;
		for (const [i, v] of present) {
			sxy += (i - mx) * (v - mean);
			sxx += (i - mx) ** 2;
		}
		const slope = sxx ? sxy / sxx : 0;
		const spread = hi[1] - lo[1];
		// Flat when the fitted line moves less than 5% of the spread over the whole series.
		const travel = Math.abs(slope * (present[present.length - 1][0] - present[0][0]));
		trend = !spread || travel < spread * 0.05 ? 'flat' : slope > 0 ? 'rising' : 'falling';
	}
	const first = present[0][1];
	const last = present[present.length - 1][1];
	return {
		...base,
		min: round(lo[1]),
		max: round(hi[1]),
		mean: round(mean),
		sum: round(sum),
		minAt: categories[lo[0]] ?? String(lo[0]),
		maxAt: categories[hi[0]] ?? String(hi[0]),
		trend,
		change: present.length >= 2 && first !== 0 ? round((last - first) / Math.abs(first)) : null
	};
}
