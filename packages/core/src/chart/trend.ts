// Portions ported from gridcraft-main/crates/chart/src/trend.rs (MIT OR Apache-2.0, © ArtCraft Team and
// contributors). See THIRD_PARTY_NOTICES.md.
import type { ChartTrendline, ChartTrendlineType } from './types.js';

/**
 * A fitted regression trendline. Exponential, logarithmic and power fits are linear fits of
 * transformed data (`ln y ~ x`, `y ~ ln x`, `ln y ~ ln x`), as spreadsheets document them;
 * points the transform cannot take (values ≤ 0) are skipped, and R² is for the transformed fit.
 */
export interface ChartTrendFit {
	type: Exclude<ChartTrendlineType, 'moving-average'>;
	/** Coefficients `c0…cd` of `Y = Σ cₖ·Xᵏ` in the transformed variables. */
	coefficients: number[];
	/** Coefficient of determination; `null` when undefined (all y equal). */
	r2: number | null;
	/** The equation as a label, e.g. `y = 0.5x² - 2x + 1` or `y = 3e^(0.2x)`. */
	equation: string;
	/** Number of points used. */
	points: number;
	/** The fitted y at `x`, or `null` outside the fit's domain (x ≤ 0 for log and power). */
	evaluate(x: number): number | null;
}

const degree = (t: ChartTrendline): number => (t.type === 'polynomial' ? Math.max(2, Math.min(6, t.order ?? 2)) : 1);
const logX = (type: ChartTrendlineType) => type === 'logarithmic' || type === 'power';
const logY = (type: ChartTrendlineType) => type === 'exponential' || type === 'power';

/**
 * Fits `trendline` to the points. Returns `null` for moving averages (see
 * `chartMovingAverage`) and degenerate data: too few usable points, all x equal, or a
 * singular system.
 */
export function fitChartTrendline(trendline: ChartTrendline, points: ReadonlyArray<readonly [number, number]>): ChartTrendFit | null {
	const type = trendline.type;
	if (type === 'moving-average') return null;
	const d = degree(trendline);
	const data = points
		.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && (!logX(type) || x > 0) && (!logY(type) || y > 0))
		.map(([x, y]) => [logX(type) ? Math.log(x) : x, logY(type) ? Math.log(y) : y] as const);
	if (data.length < 2 || data.length <= d) return null;
	// A fixed intercept applies to linear, exponential and polynomial fits; it fixes Y at x = 0.
	let fixed: number | null = null;
	const b = trendline.intercept;
	if (b !== undefined && b !== null && Number.isFinite(b)) {
		if (type === 'linear' || type === 'polynomial') fixed = b;
		else if (type === 'exponential' && b > 0) fixed = Math.log(b);
	}
	const n = data.length;
	const center = fixed !== null ? 0 : data.reduce((t, p) => t + p[0], 0) / n;
	const scale = data.reduce((m, p) => Math.max(m, Math.abs(p[0] - center)), 0);
	if (!(Number.isFinite(scale) && scale > 0)) return null;
	const first = fixed !== null ? 1 : 0;
	const b0 = fixed ?? 0;
	// Normal equations over the unknown powers first..d of u = (x - center) / scale.
	const m = d + 1 - first;
	const ata = Array.from({ length: m }, () => Array<number>(m).fill(0));
	const aty = Array<number>(m).fill(0);
	for (const [x, y] of data) {
		const u = (x - center) / scale;
		const pows = Array.from({ length: m }, (_, k) => Math.pow(u, k + first));
		for (let i = 0; i < m; i++) {
			aty[i] += pows[i] * (y - b0);
			for (let j = 0; j < m; j++) ata[i][j] += pows[i] * pows[j];
		}
	}
	const sol = solve(ata, aty);
	if (!sol) return null;
	const a = Array<number>(d + 1).fill(b0);
	sol.forEach((v, k) => (a[k + first] = v));
	const coefficients = expand(a, center, scale);
	if (!coefficients) return null;
	const poly = (x: number) => {
		const u = (x - center) / scale;
		return a.reduceRight((acc, c) => acc * u + c, 0);
	};
	const mean = data.reduce((t, p) => t + p[1], 0) / n;
	let ssRes = 0;
	let ssTot = 0;
	for (const [x, y] of data) {
		ssRes += (y - poly(x)) ** 2;
		// A fixed intercept is LINEST(y - b, x, FALSE): the total sum of squares is not centred.
		ssTot += fixed !== null ? (y - b0) ** 2 : (y - mean) ** 2;
	}
	const r2 = ssTot > 0 && Number.isFinite(ssTot) && Number.isFinite(ssRes) ? 1 - ssRes / ssTot : null;
	return {
		type,
		coefficients,
		r2,
		equation: equationText(type, coefficients),
		points: n,
		evaluate(x: number) {
			let xx = x;
			if (logX(type)) {
				if (!(x > 0)) return null;
				xx = Math.log(x);
			}
			const p = poly(xx);
			const y = logY(type) ? Math.exp(p) : p;
			return Number.isFinite(y) ? y : null;
		}
	};
}

/** Gaussian elimination with partial pivoting; `null` when (nearly) singular. */
function solve(a: number[][], b: number[]): number[] | null {
	const n = b.length;
	const big = a.flat().reduce((m, v) => Math.max(m, Math.abs(v)), 0);
	if (!(Number.isFinite(big) && big > 0)) return null;
	for (let col = 0; col < n; col++) {
		let piv = col;
		for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
		[a[col], a[piv]] = [a[piv], a[col]];
		[b[col], b[piv]] = [b[piv], b[col]];
		const p = a[col][col];
		if (!Number.isFinite(p) || Math.abs(p) <= big * 1e-13) return null;
		for (let r = col + 1; r < n; r++) {
			const f = a[r][col] / p;
			for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
			b[r] -= f * b[col];
		}
	}
	const x = Array<number>(n).fill(0);
	for (let r = n - 1; r >= 0; r--) {
		let s = 0;
		for (let c = r + 1; c < n; c++) s += a[r][c] * x[c];
		x[r] = (b[r] - s) / a[r][r];
	}
	return x.every(Number.isFinite) ? x : null;
}

/** Coefficients in X of `Σ aₖ·((X - c) / s)ᵏ` (binomial expansion). */
function expand(a: number[], c: number, s: number): number[] | null {
	const out = Array<number>(a.length).fill(0);
	a.forEach((ak, k) => {
		const lead = ak / Math.pow(s, k);
		let binom = 1;
		for (let j = 0; j <= k; j++) {
			out[j] += lead * binom * Math.pow(-c, k - j);
			binom = (binom * (k - j)) / (j + 1);
		}
	});
	return out.every(Number.isFinite) ? out : null;
}

const POWERS = ['', 'x', 'x²', 'x³', 'x⁴', 'x⁵', 'x⁶'];

function equationText(type: ChartTrendFit['type'], coef: number[]): string {
	const c0 = coef[0] ?? 0;
	const c1 = coef[1] ?? 0;
	if (type === 'exponential') return `y = ${trendNumberText(Math.exp(c0))}e^(${trendNumberText(c1)}x)`;
	if (type === 'power') return `y = ${trendNumberText(Math.exp(c0))}x^${trendNumberText(c1)}`;
	if (type === 'logarithmic') return terms([[c1, 'ln(x)'], [c0, '']]);
	return terms(coef.map((c, k) => [c, POWERS[k] ?? 'x'] as [number, string]).reverse());
}

/** `y = a·t1 ± b·t2 …`, skipping terms whose coefficient shows as 0 and unit coefficients on powers of x. */
function terms(parts: [number, string][]): string {
	let s = 'y = ';
	let first = true;
	for (const [c, t] of parts) {
		const txt = trendNumberText(Math.abs(c));
		if (txt === '0') continue;
		const neg = c < 0;
		if (first) s += neg ? '-' : '';
		else s += neg ? ' - ' : ' + ';
		if (txt !== '1' || !t) s += txt;
		s += t;
		first = false;
	}
	return first ? `${s}0` : s;
}

/** A coefficient as trendline labels show it: up to four decimals, scientific when tiny or huge. */
export function trendNumberText(v: number): string {
	if (!Number.isFinite(v)) return '#NUM!';
	const a = Math.abs(v);
	if (a === 0) return '0';
	if (a < 1e-4 || a >= 1e11) {
		const [mant, exp] = v.toExponential(4).split('e');
		const e = Number(exp);
		return `${trimZeros(mant)}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
	}
	const s = trimZeros(v.toFixed(4));
	return s === '-0' ? '0' : s;
}

const trimZeros = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

/**
 * Moving average of `period` consecutive points in plotted order: point `i` (from
 * `period - 1`) is `(xᵢ, mean(yᵢ₋ₚ₊₁ … yᵢ))`. Empty when there are fewer points than `period`.
 */
export function chartMovingAverage(points: ReadonlyArray<readonly [number, number]>, period: number): [number, number][] {
	const p = Math.max(2, Math.min(1000, Math.round(period) || 2));
	const pts = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
	const out: [number, number][] = [];
	let sum = 0;
	pts.forEach(([x, y], i) => {
		sum += y;
		if (i >= p) sum -= pts[i - p][1];
		if (i >= p - 1) out.push([x, sum / p]);
	});
	return out;
}

/** The legend name spreadsheets give a trendline, e.g. `Linear (Sales)`. */
export function chartTrendlineName(trendline: ChartTrendline, seriesName: string): string {
	if (trendline.name) return trendline.name;
	const kind: Record<ChartTrendlineType, string> = {
		linear: 'Linear',
		exponential: 'Expon.',
		logarithmic: 'Log.',
		polynomial: 'Poly.',
		power: 'Power',
		'moving-average': `${Math.max(2, trendline.period ?? 2)} per. Mov. Avg.`
	};
	return `${kind[trendline.type]} (${seriesName})`;
}

/** Whether trendlines can be drawn for this chart type and stacking (unstacked cartesian and xy charts). */
export function chartSupportsTrendlines(type: string, stacking: string): boolean {
	return (type === 'bar' || type === 'line' || type === 'area' || type === 'scatter' || type === 'bubble') && stacking === 'none';
}
