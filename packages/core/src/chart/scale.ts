import { formatChartValueWithCode } from './numfmt.js';
import type { ChartNumberFormat, ChartValueScale } from './types.js';

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
	// Non-finite fixed ends fall back to the data range, and a non-finite data range to 0..1.
	if (fixedMin !== null && !Number.isFinite(fixedMin)) fixedMin = null;
	if (fixedMax !== null && !Number.isFinite(fixedMax)) fixedMax = null;
	let lo = fixedMin ?? min;
	let hi = fixedMax ?? max;
	if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
		fixedMin = fixedMax = null;
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
	// Near ±Number.MAX_VALUE the span overflows to Infinity: halve it and double the step.
	const span = hi - lo;
	const step = Number.isFinite(span) ? niceStep(span, count) : niceStep(hi / 2 - lo / 2, count) * 2;
	// Rounding outwards can overflow too; keep the data end then.
	const finiteOr = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);
	const niceMin = fixedMin ?? finiteOr(snap(Math.floor(lo / step + 1e-9) * step, step), lo);
	const niceMax = fixedMax ?? finiteOr(snap(Math.ceil(hi / step - 1e-9) * step, step), hi);
	// Ticks are first + i·step (never a running sum, which stalls once step is below the
	// float spacing, e.g. near 1e16) and deduplicated where neighbours round to one float.
	const firstIndex = Math.ceil(niceMin / step - 1e-9);
	const lastIndex = Math.floor(niceMax / step + 1e-9);
	const n = Math.min(999, Math.max(-1, lastIndex - firstIndex));
	const ticks: number[] = [];
	for (let i = 0; i <= n; i++) {
		const t = snap((firstIndex + i) * step, step);
		if (Number.isFinite(t) && t !== ticks[ticks.length - 1]) ticks.push(t);
	}
	return { min: niceMin, max: niceMax, step, ticks };
}

/** `clean`, unless that moves `n` by a noticeable part of `step` (large numbers such as 1e16 + 2). */
function snap(n: number, step: number): number {
	const c = clean(n);
	return Math.abs(c - n) <= step * 1e-6 ? c : n;
}

/** Decimals needed to write ticks `step` apart exactly: 1 → 0, 2.5 → 1, 0.25 → 2 (at most 6). */
export function stepDecimals(step: number): number {
	if (!(step > 0) || !Number.isFinite(step)) return 0;
	for (let d = 0; d < 6; d++) {
		const scaled = step * Math.pow(10, d);
		if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return d;
	}
	return 6;
}

/** Decimals that show the leading digit of `value` (0.12 → 1, 0.012 → 2; at most 6). */
function magnitudeDecimals(value: number): number {
	if (!(value > 0) || value >= 1) return 0;
	return Math.min(6, Math.max(0, Math.ceil(-Math.log10(value) - 1e-9)));
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
	if (format.code) return `${format.prefix ?? ''}${formatChartValueWithCode(value, format.code)}${format.suffix ?? ''}`;
	const style = format.style ?? 'number';
	let body: string;
	const decimalsFor = (v: number) => {
		if (format.decimals !== undefined) return format.decimals;
		if (fallbackDecimals !== undefined) return fallbackDecimals;
		return Number.isInteger(v) ? 0 : Math.abs(v) < 1 ? Math.min(4, Math.max(2, magnitudeDecimals(Math.abs(v)) + 1)) : 2;
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

/** Rounds float noise off a tick without flushing tiny values to 0 (log ticks such as 1e-15). */
const tidy = (n: number) => (n === 0 ? 0 : Number(n.toPrecision(12)));

/**
 * A logarithmic scale over `[lo, hi]` (only positive values count): the ends extend to whole
 * powers of `base` unless fixed, and ticks sit on the powers, thinned to about `count`, or, in
 * base 10 over a few decades, on the 1-2-5 steps between them. `step` is the base. Non-positive
 * or non-finite ends fall back to the data, and no positive data at all gives 1 to `base`.
 */
export function niceLogScale(lo: number, hi: number, count = 5, base = 10, fixedMin: number | null = null, fixedMax: number | null = null): NiceScale {
	if (!(base > 1) || !Number.isFinite(base)) base = 10;
	if (fixedMin !== null && !(fixedMin > 0 && Number.isFinite(fixedMin))) fixedMin = null;
	if (fixedMax !== null && !(fixedMax > 0 && Number.isFinite(fixedMax))) fixedMax = null;
	if (!(lo > 0) || !Number.isFinite(lo)) lo = hi > 0 && Number.isFinite(hi) ? hi : (fixedMin ?? 1);
	if (!(hi > 0) || !Number.isFinite(hi)) hi = Math.max(lo, fixedMax ?? lo * base);
	if (lo > hi) [lo, hi] = [hi, lo];
	const log = (v: number) => Math.log(v) / Math.log(base);
	const e0 = Math.floor(log(fixedMin ?? lo) + 1e-9);
	let e1 = Math.ceil(log(fixedMax ?? hi) - 1e-9);
	if (e1 <= e0) e1 = e0 + 1;
	let min = fixedMin ?? tidy(Math.pow(base, e0));
	let max = fixedMax ?? tidy(Math.pow(base, e1));
	if (!(max > min)) {
		if (fixedMax === null) max = tidy(min * base);
		else min = tidy(max / base);
	}
	if (!Number.isFinite(max)) max = Number.MAX_VALUE;
	if (!(min > 0)) min = Number.MIN_VALUE;
	const inside = (t: number) => t >= min * (1 - 1e-9) && t <= max * (1 + 1e-9);
	const decades = Math.max(1, log(max) - log(min));
	let ticks: number[] = [];
	const first = Math.ceil(log(min) - 1e-9);
	const last = Math.floor(log(max) + 1e-9);
	if (base === 10 && decades * 3 <= count + 1) {
		for (let e = first - 1; e <= last; e++) for (const m of [1, 2, 5]) ticks.push(tidy(m * Math.pow(10, e)));
	} else {
		const every = Math.max(1, Math.ceil((last - first + 1) / (count + 2)));
		for (let e = Math.ceil(first / every) * every; e <= last && ticks.length < 1000; e += every) ticks.push(tidy(Math.pow(base, e)));
	}
	ticks = ticks.filter((t) => Number.isFinite(t) && t > 0 && inside(t));
	// A fixed range inside one power: fall back to evenly spaced ticks between the ends.
	if (ticks.length < 2) ticks = niceScale(min, max, count, min, max).ticks.filter((t) => t > 0);
	return { min, max, step: base, ticks: [...new Set(ticks)].sort((a, b) => a - b) };
}

/**
 * A data value's pixel on a value scale: linear, or by logarithm when `scale.logBase` is set
 * (values of 0 or less have no pixel there and give NaN).
 */
export function chartScaleToPixel(value: number, scale: Pick<ChartValueScale, 'domain' | 'range' | 'logBase'>): number {
	if (!scale.logBase) return linearMap(value, scale.domain, scale.range);
	if (!(value > 0)) return NaN;
	return linearMap(Math.log(value), [Math.log(scale.domain[0]), Math.log(scale.domain[1])], scale.range);
}

/** The data value at a pixel on a value scale (the inverse of `chartScaleToPixel`). */
export function chartScaleFromPixel(px: number, scale: Pick<ChartValueScale, 'domain' | 'range' | 'logBase'>): number {
	if (!scale.logBase) return linearMap(px, scale.range, scale.domain);
	return Math.exp(linearMap(px, scale.range, [Math.log(scale.domain[0]), Math.log(scale.domain[1])]));
}
