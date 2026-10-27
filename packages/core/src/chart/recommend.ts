// Ported from gridcraft-main/crates/engine/src/cmd/insert.rs (`series_from_range`, `scatter_x_from_first`,
// `recommend_charts`) (MIT OR Apache-2.0, © ArtCraft Team and contributors), extended for the chart types
// this editor adds. See THIRD_PARTY_NOTICES.md.
import { parseChartDate } from './date.js';
import { chartDataFromTable, parseChartValue } from './spec.js';
import type { ChartIssue, ChartSeries, ChartStacking, ChartType } from './types.js';

export interface ChartTableShape {
	/** The first row holds series names (some text, every value cell text or blank). */
	headerRow: boolean;
	/** The first column holds category labels (all text, or a blank top-left cell above a header row). */
	labelColumn: boolean;
	/** Series run along rows (the block is much wider than tall). */
	byRows: boolean;
	series: number;
	/** Points per series. */
	points: number;
	anyNumber: boolean;
	nonNegative: boolean;
	mixedSigns: boolean;
	/** The category labels read as dates. */
	dates: boolean;
}

const blank = (c: unknown) => c === null || c === undefined || String(c).trim() === '';
const isText = (c: unknown) => blank(c) || parseChartValue(c) === undefined;

/**
 * Reads the shape of a block of cells the way spreadsheets do: a header row when the first
 * row is text, a label column when the first column is text (or the top-left cell is blank
 * above a header row, the convention for years and x values), and series along the longer side.
 */
export function analyzeChartTable(rows: ReadonlyArray<ReadonlyArray<unknown>>): ChartTableShape {
	const grid = rows.filter((r) => r.some((c) => !blank(c)));
	const height = grid.length;
	const width = Math.max(0, ...grid.map((r) => r.length));
	const cell = (r: number, c: number) => grid[r]?.[c];
	const headerRow = height > 1 && grid[0].some((c) => !blank(c) && isText(c)) && Array.from({ length: width - 1 }, (_, i) => i + 1).every((c) => isText(cell(0, c)));
	const blankCorner = headerRow && blank(cell(0, 0));
	const labelColumn = width > 1 && (blankCorner || Array.from({ length: height - (headerRow ? 1 : 0) }, (_, i) => i + (headerRow ? 1 : 0)).every((r) => isText(cell(r, 0))));
	const byRows = width > height + 1;
	const dataRows = height - (headerRow ? 1 : 0);
	const dataCols = width - (labelColumn ? 1 : 0);
	let anyNumber = false;
	let nonNegative = true;
	let anyNegative = false;
	let anyPositive = false;
	for (let r = headerRow ? 1 : 0; r < height; r++)
		for (let c = labelColumn ? 1 : 0; c < width; c++) {
			const v = parseChartValue(cell(r, c));
			if (typeof v !== 'number') continue;
			anyNumber = true;
			if (v < 0) {
				nonNegative = false;
				anyNegative = true;
			} else if (v > 0) anyPositive = true;
		}
	const labels = byRows ? grid[0]?.slice(labelColumn ? 1 : 0) ?? [] : grid.slice(headerRow ? 1 : 0).map((r) => r[0]);
	const dates = (byRows ? headerRow : labelColumn) && labels.length > 1 && labels.filter((l) => !blank(l) && parseChartDate(String(l)) !== null).length >= labels.length * 0.8;
	return {
		headerRow,
		labelColumn,
		byRows,
		series: Math.max(0, byRows ? dataRows : dataCols),
		points: Math.max(0, byRows ? dataCols : dataRows),
		anyNumber,
		nonNegative,
		mixedSigns: anyNegative && anyPositive,
		dates
	};
}

export interface ChartRecommendation {
	type: ChartType;
	stacking?: ChartStacking;
	label: string;
	/** Why it suits the data, as a sentence. */
	reason: string;
}

/**
 * Chart types that suit the shape of a block of cells, best first. A heuristic from the shape
 * (series count, points per series, text or date categories, negative values), not a copy of
 * any spreadsheet's ranking.
 */
export function recommendChartTypes(rows: ReadonlyArray<ReadonlyArray<unknown>>): ChartRecommendation[] {
	const shape = analyzeChartTable(rows);
	if (!shape.anyNumber || !shape.series) return [];
	return recommendForShape(shape);
}

export function recommendForShape(shape: Omit<ChartTableShape, 'headerRow' | 'byRows'> & Partial<ChartTableShape>): ChartRecommendation[] {
	const out: ChartRecommendation[] = [];
	const add = (type: ChartType, label: string, reason: string, stacking?: ChartStacking) => out.push({ type, label, reason, ...(stacking ? { stacking } : {}) });
	if (shape.series === 2 && !shape.labelColumn && !shape.byRows) {
		add('scatter', 'Scatter', 'Two numeric columns without labels: the first is x, the second y.');
		add('line', 'Line', 'Shows the second column in order.');
		add('bar', 'Column', 'Compares the values side by side.');
		return out;
	}
	if (shape.series === 1 && !shape.labelColumn && shape.points > 20) {
		add('histogram', 'Histogram', 'Many unlabelled values: shows how they are distributed.');
		add('box', 'Box plot', 'Summarises the spread: quartiles, median and outliers.');
		add('line', 'Line', 'Shows the values in order.');
		return out;
	}
	if (shape.dates) {
		add('line', 'Line', 'The categories are dates: a line shows change over time.');
		add('area', 'Area', 'Shows change over time with volume.');
		add('bar', 'Column', 'Compares each period.');
		if (shape.series > 1) add('area', 'Stacked area', 'Shows how the parts add up over time.', 'stacked');
		return out;
	}
	if (shape.series === 1) {
		if (shape.points > 12) {
			add('line', 'Line', 'One long series: a line shows its shape.');
			add('bar', 'Column', 'Compares every value.');
			add('area', 'Area', 'Emphasises the volume under the series.');
		} else {
			add('bar', 'Column', 'One short series: columns compare the values.');
			if (shape.mixedSigns) add('waterfall', 'Waterfall', 'Positive and negative values: shows how they add up to a total.');
			add('bar', 'Bar', 'Horizontal bars fit long category names.');
			if (shape.nonNegative && shape.points >= 2) {
				add('pie', 'Pie', 'Shares of a whole (all values are positive).');
				add('donut', 'Donut', 'Shares of a whole with the total in the middle.');
				if (shape.points >= 5) add('treemap', 'Treemap', 'Compares many shares by area.');
				add('funnel', 'Funnel', 'Shows stages that narrow down.');
				add('parliament', 'Parliament', 'Seats or votes per group, with the majority line.');
			}
			add('line', 'Line', 'Shows the values in order.');
		}
		return out;
	}
	if (shape.points > 12) {
		add('line', 'Line', 'Several long series: lines keep them readable.');
		add('bar', 'Column', 'Compares the series at each category.');
		add('area', 'Area', 'Emphasises volume.');
		add('bar', 'Stacked column', 'Shows how the series add up.', 'stacked');
	} else {
		if (shape.series === 2 && shape.labelColumn) add('slope', 'Slope', 'Two columns per item: shows what rose and what fell between them.');
		add('bar', 'Column', 'Several series: clustered columns compare them per category.');
		add('bar', 'Bar', 'Horizontal bars fit long category names.');
		add('bar', 'Stacked column', 'Shows how the series add up.', 'stacked');
		add('line', 'Line', 'Shows the series in order.');
		if (shape.points >= 3 && shape.series <= 6) add('radar', 'Radar', 'Compares several measures across the series.');
		if (shape.nonNegative && shape.series >= 3 && shape.series <= 7) add('likert', 'Likert', 'Survey answers per question (columns from most negative to most positive): shows agreement against disagreement.');
	}
	return out;
}

export interface ChartFromTable {
	type: ChartType;
	stacking: ChartStacking;
	categories: string[];
	series: ChartSeries[];
	issues: ChartIssue[];
	shape: ChartTableShape;
}

/**
 * Builds chart data from a block of cells (CSV, a clipboard grid or a spreadsheet range) using
 * the spreadsheet conventions of `analyzeChartTable`. `type: 'auto'` (the default) takes the
 * first recommendation. A scatter chart of a block without labels takes the first column as
 * the x values of the others.
 */
export function chartFromTable(rows: ReadonlyArray<ReadonlyArray<unknown>>, options: { type?: ChartType | 'auto' } = {}): ChartFromTable {
	const shape = analyzeChartTable(rows);
	const rec = (options.type ?? 'auto') === 'auto' ? recommendForShape(shape)[0] : undefined;
	const type = rec?.type ?? (options.type === 'auto' || !options.type ? 'bar' : options.type);
	const stacking = rec?.stacking ?? 'none';
	const grid = rows.filter((r) => r.some((c) => !blank(c))).map((r) => [...r]);
	// Without a header row, invent one so chartDataFromTable reads every row as data.
	const width = Math.max(0, ...grid.map((r) => r.length));
	let table = grid;
	if (!shape.labelColumn) table = table.map((r, i) => [shape.headerRow && i === 0 ? '' : String(i + (shape.headerRow ? 0 : 1)), ...r]);
	if (!shape.headerRow) table = [['', ...Array.from({ length: width }, (_, i) => `Series ${i + 1}`)], ...table];
	const xFromFirst = type === 'scatter' && !shape.labelColumn && !shape.byRows && shape.series > 1;
	if (xFromFirst) {
		// The first data column becomes x: move it into the label column.
		table = table.map((r) => [r[1], ...r.slice(2)]);
	}
	const data = chartDataFromTable(table, { seriesIn: shape.byRows ? 'rows' : 'columns', header: true, xFromFirstColumn: xFromFirst });
	return { type, stacking, categories: data.categories, series: data.series, issues: data.issues, shape };
}
