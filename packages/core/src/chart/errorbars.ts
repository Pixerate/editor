import type { ChartErrorBars, ChartErrorBarType, ChartValue } from './types.js';

export const CHART_ERROR_BAR_TYPES: readonly ChartErrorBarType[] = ['fixed', 'percent', 'stddev', 'stderr', 'custom'];
export const CHART_ERROR_BAR_DIRECTIONS: readonly NonNullable<ChartErrorBars['direction']>[] = ['both', 'plus', 'minus'];

/** Labels for pickers, shared by the React and Svelte components. */
export const CHART_ERROR_BAR_LABELS: Readonly<Record<ChartErrorBarType, string>> = {
	fixed: 'Fixed amount',
	percent: 'Percentage',
	stddev: 'Standard deviation',
	stderr: 'Standard error',
	custom: 'Custom'
};

/** The default `value` per type (`fixed` 1, `percent` 5, `stddev` 1). */
export function defaultChartErrorBarValue(type: ChartErrorBarType): number | undefined {
	return type === 'fixed' ? 1 : type === 'percent' ? 5 : type === 'stddev' ? 1 : undefined;
}

/** One point's error bar: where it is centred and how far it reaches each way (both 0 or more). */
export interface ChartErrorAmount {
	/** The point's value, or the series mean for `stddev` (as Excel draws it). */
	center: number;
	plus: number;
	minus: number;
}

/** Mean and sample standard deviation of the finite values (sd 0 with fewer than 2). */
function meanAndSd(values: readonly ChartValue[]): { mean: number; sd: number; n: number } {
	const xs = values.filter((v): v is number => v !== null && Number.isFinite(v));
	const n = xs.length;
	if (!n) return { mean: 0, sd: 0, n };
	const mean = xs.reduce((t, v) => t + v, 0) / n;
	const sd = n > 1 ? Math.sqrt(xs.reduce((t, v) => t + (v - mean) ** 2, 0) / (n - 1)) : 0;
	return { mean, sd, n };
}

/**
 * The error bar at each point of `values` (a series' values, or its x values for x error
 * bars), following Excel's error amount types: `fixed` and `percent` from `value`, `stddev`
 * around the series mean, `stderr` (sample standard deviation / √n) and `custom` amounts from
 * `plus` / `minus`. Gaps (and custom points without an amount) give `null`.
 */
export function chartErrorAmounts(bars: ChartErrorBars, values: readonly ChartValue[]): (ChartErrorAmount | null)[] {
	const direction = bars.direction ?? 'both';
	const up = direction !== 'minus';
	const down = direction !== 'plus';
	const stats = bars.type === 'stddev' || bars.type === 'stderr' ? meanAndSd(values) : null;
	const amount = bars.value ?? defaultChartErrorBarValue(bars.type) ?? 0;
	return values.map((v, i) => {
		if (v === null || !Number.isFinite(v)) return null;
		let plus: number;
		let minus: number;
		let center = v;
		switch (bars.type) {
			case 'fixed':
				plus = minus = Math.abs(amount);
				break;
			case 'percent':
				plus = minus = Math.abs((v * amount) / 100);
				break;
			case 'stddev':
				center = stats!.mean;
				plus = minus = Math.abs(amount) * stats!.sd;
				break;
			case 'stderr':
				plus = minus = stats!.n ? stats!.sd / Math.sqrt(stats!.n) : 0;
				break;
			default: {
				const p = bars.plus?.[i] ?? null;
				const m = bars.minus?.[i] ?? (bars.minus ? null : p);
				if ((p === null || !Number.isFinite(p)) && (m === null || !Number.isFinite(m))) return null;
				plus = p !== null && Number.isFinite(p) ? Math.abs(p) : 0;
				minus = m !== null && Number.isFinite(m) ? Math.abs(m) : 0;
			}
		}
		return { center, plus: up ? plus : 0, minus: down ? minus : 0 };
	});
}

/** A one-line description of error bars ("±5% error bars", "±1 standard deviation error bars"). */
export function describeChartErrorBars(bars: ChartErrorBars): string {
	const sign = bars.direction === 'plus' ? '+' : bars.direction === 'minus' ? '−' : '±';
	const value = bars.value ?? defaultChartErrorBarValue(bars.type);
	switch (bars.type) {
		case 'fixed':
			return `${sign}${value} error bars`;
		case 'percent':
			return `${sign}${value}% error bars`;
		case 'stddev':
			return `${sign}${value} standard deviation${value === 1 ? '' : 's'} error bars`;
		case 'stderr':
			return `${sign}standard error bars`;
		default:
			return 'custom error bars';
	}
}

/**
 * Error bars for a picker change: `null` for none, else bars of `type` that keep the current
 * direction and caps. Switching to `custom` starts from the amounts the current bars (or ±1)
 * draw, so the picture does not jump. Shared by the React and Svelte inspectors.
 */
export function chartErrorBarsOfType(type: ChartErrorBarType | '' | null, current: ChartErrorBars | undefined, values: readonly ChartValue[]): ChartErrorBars | null {
	if (!type) return null;
	const keep: Partial<ChartErrorBars> = { ...(current?.direction ? { direction: current.direction } : {}), ...(current?.cap === false ? { cap: false } : {}) };
	if (type !== 'custom') return { type, ...keep, ...(current?.type === type && current.value !== undefined ? { value: current.value } : {}) };
	if (current?.type === 'custom') return current;
	const amounts = chartErrorAmounts({ ...(current ?? { type: 'fixed' }), direction: 'both' }, values);
	const round = (n: number) => Number(n.toPrecision(4));
	const plus = amounts.map((a) => (a ? round(a.plus) : null));
	const minus = amounts.map((a) => (a ? round(a.minus) : null));
	return { type, plus, ...(JSON.stringify(minus) !== JSON.stringify(plus) ? { minus } : {}), ...keep };
}

/** Custom amounts as text for an input: "1, 2, -, 0.5" (`-` is a point without a bar). */
export function formatChartAmountList(values: readonly ChartValue[] | undefined): string {
	return (values ?? []).map((v) => (v === null ? '-' : String(v))).join(', ');
}

/** Reads amounts typed as "1, 2, -, 0.5" (commas, semicolons or spaces; `-` or blank for none). */
export function parseChartAmountList(text: string): (string | null)[] {
	return text
		.split(/[;,\s]+/)
		.filter((t) => t !== '')
		.map((t) => (t === '-' ? null : t));
}
