import type { ChartNumberFormat } from './types.js';

/**
 * Plain chart number text (#814): the part of `formatChartNumber` without spreadsheet format codes,
 * so a page bundle can write numbers without the format-code parser.
 */

const clean = (n: number) => (Math.abs(n) < 1e-12 ? 0 : Number(n.toPrecision(12)));

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
 * Writes a number for a chart label as `formatChartNumber` does, ignoring `code` (a non-finite
 * number is ''). Locale-independent: `,` thousands, `.` decimals.
 */
export function formatPlainChartNumber(value: number, format: ChartNumberFormat = {}, fallbackDecimals?: number): string {
	if (!Number.isFinite(value)) return '';
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

