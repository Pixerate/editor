import { NumberFormat } from '../spreadsheet/numfmt/index.js';

/**
 * A compiled spreadsheet number format code for chart labels, e.g. `#,##0.00`, `0.0%`,
 * `#,##0,,"M"`, `$#,##0;[Red]($#,##0);"–"` or `yyyy-mm-dd`. Backed by the spreadsheet's
 * format engine (`NumberFormat`), so charts and sheets write numbers the same way; colours
 * such as `[Red]` are ignored on charts.
 */
export interface ChartFormatCode {
	format(value: number): string;
	/** The code is a date or time format (values are serial day numbers from 1899-12-30). */
	isDate: boolean;
	/** The code shows a percentage (values are multiplied by 100). */
	isPercent: boolean;
}

/** Compiles a spreadsheet format code (cached). */
export function compileChartFormatCode(code: string): ChartFormatCode {
	const fmt = NumberFormat.parseCached(code);
	return {
		isDate: fmt.isDate(),
		isPercent: fmt.isPercent(),
		format: (value: number) => (Number.isFinite(value) ? fmt.formatNumber(value).text : '')
	};
}

/** Formats `value` with a spreadsheet format code. */
export function formatChartValueWithCode(value: number, code: string): string {
	return compileChartFormatCode(code).format(value);
}

/** A spreadsheet serial day number (1 = 1900-01-01, with the 1900 leap-year quirk) as a UTC date. */
export function chartSerialToDate(serial: number): Date {
	// Day 60 is the fictional 1900-02-29; serials from 61 count from 1899-12-30, earlier ones from 1899-12-31.
	const origin = serial < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
	return new Date(origin + Math.round(serial * 86400000));
}

/** A UTC date as a spreadsheet serial day number. */
export function chartDateToSerial(date: Date): number {
	const serial = (date.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
	return serial < 61 ? serial - 1 : serial;
}
