import type { ChartNumberFormat } from './types.js';

/** A "nice" step (1, 2, 2.5 or 5 × 10ⁿ) for about `count` intervals over `span`. */
export function niceStep(span: number, count: number): number {
	if (!(span > 0) || !(count > 0)) return 1;
	const raw = span / count;
	const power = Math.pow(10, Math.floor(Math.log10(raw)));
	const fraction = raw / power;
	const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
	return nice * power;
}

/** Removes float noise such as 0.30000000000000004. */
const clean = (n: number) => (Math.abs(n) < 1e-12 ? 0 : Number(n.toPrecision(12)));

export interface NiceScale {
	min: number;
	max: number;
	step: number;
	ticks: number[];
}

/**
 * Extends `[min, max]` to round numbers and lists the ticks between them. Fixed ends
 * (`fixedMin` / `fixedMax`) are kept exactly; ticks then start at the first nice value
 * inside them.
 */
export function niceScale(min: number, max: number, count = 5, fixedMin: number | null = null, fixedMax: number | null = null): NiceScale {
	let lo = fixedMin ?? min;
	let hi = fixedMax ?? max;
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
		lo = 0;
		hi = 1;
	}
	if (lo > hi) [lo, hi] = [hi, lo];
	if (lo === hi) {
		const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
		// A flat series at 0 grows upwards; anything else gets room on both free sides.
		if (fixedMin === null && lo !== 0) lo -= pad;
		if (fixedMax === null || lo === hi) hi += pad;
	}
	const step = niceStep(hi - lo, count);
	const niceMin = fixedMin ?? clean(Math.floor(lo / step + 1e-9) * step);
	const niceMax = fixedMax ?? clean(Math.ceil(hi / step - 1e-9) * step);
	const ticks: number[] = [];
	const first = Math.ceil(niceMin / step - 1e-9) * step;
	for (let t = first, i = 0; t <= niceMax + step * 1e-9 && i < 1000; t += step, i++) ticks.push(clean(t));
	return { min: niceMin, max: niceMax, step, ticks };
}

/** Decimals needed to tell ticks `step` apart (at most 6). */
export function stepDecimals(step: number): number {
	if (!(step > 0) || step >= 1) return 0;
	return Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
}

const COMPACT = [
	{ value: 1e12, suffix: 'T' },
	{ value: 1e9, suffix: 'B' },
	{ value: 1e6, suffix: 'M' },
	{ value: 1e3, suffix: 'K' }
];

function grouped(value: number, decimals: number): string {
	const fixed = Math.abs(value).toFixed(decimals);
	const [int, frac] = fixed.split('.');
	const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return `${value < 0 && Number(fixed) !== 0 ? '-' : ''}${withCommas}${frac ? `.${frac}` : ''}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', INR: '₹', AUD: 'A$', CAD: 'C$' };

/**
 * Writes a number for a chart label. Locale-independent (so labels and tests are the same
 * everywhere): `,` thousands, `.` decimals. `decimals` defaults to `fallbackDecimals`
 * (e.g. from the tick step), else up to 2 trimmed.
 */
export function formatChartNumber(value: number | null | undefined, format: ChartNumberFormat = {}, fallbackDecimals?: number): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return '';
	const style = format.style ?? 'number';
	let body: string;
	const decimalsFor = (v: number) => {
		if (format.decimals !== undefined) return format.decimals;
		if (fallbackDecimals !== undefined) return fallbackDecimals;
		return Number.isInteger(v) ? 0 : Math.abs(v) < 1 ? Math.min(4, Math.max(2, stepDecimals(Math.abs(v)) + 1)) : 2;
	};
	const trim = (s: string) => (format.decimals === undefined && fallbackDecimals === undefined && s.includes('.') ? s.replace(/\.?0+$/, '') : s);
	if (style === 'percent') {
		const v = value * 100;
		const d = format.decimals ?? (fallbackDecimals !== undefined ? Math.max(0, fallbackDecimals - 2) : Number.isInteger(clean(v)) ? 0 : 1);
		body = `${grouped(clean(v), d)}%`;
	} else if (style === 'compact') {
		const unit = COMPACT.find((u) => Math.abs(value) >= u.value);
		if (unit) {
			const v = value / unit.value;
			const d = format.decimals ?? (Math.abs(v) >= 100 || Number.isInteger(clean(v)) ? 0 : 1);
			body = `${trim(grouped(v, d))}${unit.suffix}`;
		} else body = trim(grouped(value, decimalsFor(value)));
	} else if (style === 'currency') {
		const code = (format.currency || 'USD').toUpperCase();
		const symbol = CURRENCY_SYMBOLS[code] ?? `${code} `;
		const d = format.decimals ?? (fallbackDecimals !== undefined ? fallbackDecimals : Number.isInteger(value) ? 0 : 2);
		const s = grouped(Math.abs(value), d);
		body = `${value < 0 ? '-' : ''}${symbol}${s}`;
	} else body = trim(grouped(value, decimalsFor(value)));
	return `${format.prefix ?? ''}${body}${format.suffix ?? ''}`;
}

/** Linear map from `domain` to `range`. */
export function linearMap(value: number, domain: readonly [number, number], range: readonly [number, number]): number {
	const [d0, d1] = domain;
	const [r0, r1] = range;
	if (d1 === d0) return (r0 + r1) / 2;
	return r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}
