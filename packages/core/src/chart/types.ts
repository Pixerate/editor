/**
 * Chart kinds.
 *
 * - `bar`, `line`, `area` and `scatter` are cartesian: categories along one axis, values along
 *   the other, and series may mix them (a combo chart). A scatter chart whose series carry
 *   numeric `x` values plots them on a numeric x axis instead.
 * - `bubble` plots `x`, `y` (the values) and `sizes` per series.
 * - `pie` and `donut` draw the first visible series, one slice per category.
 * - `radar` draws each series as a polygon over one spoke per category.
 * - `waterfall` draws the first series as running increases and decreases.
 * - `histogram` bins every value of the visible series; `box` draws one box and whiskers per series.
 * - `funnel` and `treemap` draw the first series, one bar or rectangle per category.
 */
export type ChartType =
	| 'bar'
	| 'line'
	| 'area'
	| 'scatter'
	| 'bubble'
	| 'pie'
	| 'donut'
	| 'radar'
	| 'waterfall'
	| 'histogram'
	| 'box'
	| 'funnel'
	| 'treemap';

/** How a series is drawn in a cartesian chart. */
export type ChartSeriesType = 'bar' | 'line' | 'area' | 'scatter';

/** One data value; `null` is a gap (missing value). */
export type ChartValue = number | null;

/** Point marker shapes for line, area and scatter series. */
export type ChartMarker = 'circle' | 'square' | 'diamond' | 'triangle' | 'cross' | 'none';

/** Trendline fits (as in spreadsheets). */
export type ChartTrendlineType = 'linear' | 'exponential' | 'logarithmic' | 'power' | 'polynomial' | 'moving-average';

export interface ChartTrendline {
	type: ChartTrendlineType;
	/** Polynomial order, 2–6 (default 2). */
	order?: number;
	/** Moving-average period, 2 or more (default 2). */
	period?: number;
	/** Extend the line this many x units past the last point (default 0). */
	forward?: number;
	/** Extend the line this many x units before the first point (default 0). */
	backward?: number;
	/** Force the line through this y at x = 0 (linear, polynomial and exponential only). */
	intercept?: number | null;
	/** Write the fitted equation on the chart. */
	showEquation?: boolean;
	/** Write R² on the chart. */
	showR2?: boolean;
	/** Legend name (default: e.g. "Linear (Sales)"). */
	name?: string;
	/** CSS colour (default: the series colour). */
	color?: string;
}

/** How error amounts are worked out (as in spreadsheets: Excel's `c:errValType`). */
export type ChartErrorBarType = 'fixed' | 'percent' | 'stddev' | 'stderr' | 'custom';

/**
 * Error bars on a series (Excel's `c:errBars`). Amounts are in data units and drawn from each
 * point, except `stddev`, which is drawn around the series mean as Excel does.
 */
export interface ChartErrorBars {
	/**
	 * - `fixed`: the same amount at every point (`value`, default 1).
	 * - `percent`: `value` percent of each point's value (default 5).
	 * - `stddev`: `value` standard deviations of the series (default 1), around the series mean.
	 * - `stderr`: the standard error of the series (sample standard deviation / √n) at every point.
	 * - `custom`: per-point amounts from `plus` and `minus`.
	 */
	type: ChartErrorBarType;
	/** The amount for `fixed`, `percent` and `stddev` (see `type` for defaults). */
	value?: number;
	/** Custom amounts above each point (0 or more; `null`: none). */
	plus?: ChartValue[];
	/** Custom amounts below each point (0 or more; `null`: none). Defaults to `plus`. */
	minus?: ChartValue[];
	/** Which way the bars go (default `both`). */
	direction?: 'both' | 'plus' | 'minus';
	/** Draw end caps (default `true`). */
	cap?: boolean;
}

export interface ChartSeries {
	/** Stable id (unique within the chart). */
	id: string;
	name: string;
	/** One value per category (the y values of a scatter or bubble chart). */
	values: ChartValue[];
	/** CSS colour (default: the palette colour for the series' position). */
	color?: string;
	/** Overrides the chart type for this series (cartesian charts only). */
	type?: ChartSeriesType;
	/** Hidden series keep their data but are not drawn or scaled. */
	hidden?: boolean;
	/** Plot against the secondary value axis (on the right). */
	axis?: 'primary' | 'secondary';
	/** Numeric x per category (scatter and bubble charts). */
	x?: ChartValue[];
	/** Bubble sizes per category (bubble charts; area is proportional to size). */
	sizes?: ChartValue[];
	/** Colour overrides per category (`null` keeps the series colour). */
	pointColors?: (string | null)[];
	/** Point marker (default: circles on lines when `points` is on). */
	marker?: ChartMarker;
	/** Line interpolation for this series (default: the chart's `curve`). */
	curve?: ChartCurve;
	/** Value labels for this series (default: the chart's `dataLabels`). */
	dataLabels?: boolean;
	/** How this series' data labels are written (default: the value axis format). */
	format?: ChartNumberFormat;
	/** Fitted lines drawn over the series. */
	trendlines?: ChartTrendline[];
	/** Error bars along the value axis (bar, line, area and scatter series). */
	errorBars?: ChartErrorBars;
	/** Error bars along the numeric x axis (scatter charts with x values). */
	xErrorBars?: ChartErrorBars;
}

export interface ChartNumberFormat {
	/** `number` (default), `percent` (0.25 → 25%), `currency` or `compact` (1.2K). */
	style?: 'number' | 'percent' | 'currency' | 'compact';
	/** Fixed decimals (default: as many as the ticks need, up to 2). */
	decimals?: number;
	/** ISO currency code for `currency` (default `USD`). */
	currency?: string;
	prefix?: string;
	suffix?: string;
	/**
	 * A spreadsheet format code such as `#,##0.0,,"M"` or `0.0%;[Red]-0.0%`. When set it
	 * wins over the other fields. Supports sections (positive;negative;zero), digit
	 * placeholders, thousands separators and scaling, percent, scientific and literal text.
	 */
	code?: string;
}

export interface ChartAxis {
	/** Draw the axis line, ticks and labels (default `true`). */
	show: boolean;
	title: string;
	/** Fixed lower bound (default: from the data, including 0 for bars and areas). */
	min: number | null;
	/** Fixed upper bound (default: from the data). */
	max: number | null;
	/** Fixed distance between ticks (default: a round number from the plot size). */
	step: number | null;
	/** Grid lines at each tick (default: on for the value axis). */
	gridlines: boolean;
	/** How tick and data labels are written (value axes, and the x axis of scatter charts). */
	format: ChartNumberFormat;
	/**
	 * Category axis only: `date` reads the categories as dates (ISO `2024-03-01`, `2024-03`,
	 * `2024`), labels them with calendar steps that fit, and thins the rest.
	 */
	kind?: 'category' | 'date';
	/**
	 * Value axes (and the numeric x axis of scatter and bubble charts): `log` spaces ticks by
	 * powers of `logBase`. Values of 0 or less cannot be drawn and are skipped. Not allowed with
	 * percent stacking. Absent means `linear`.
	 */
	scale?: 'linear' | 'log';
	/** Base of a logarithmic axis, 2–1000 (default 10). */
	logBase?: number;
	/** Run the axis the other way: values from the top down, or categories from right to left. */
	reverse?: boolean;
}

export type ChartLegendPosition = 'top' | 'bottom' | 'left' | 'right';

export interface ChartLegend {
	show: boolean;
	position: ChartLegendPosition;
}

export type ChartStacking = 'none' | 'stacked' | 'percent';
export type ChartOrientation = 'vertical' | 'horizontal';
export type ChartCurve = 'linear' | 'smooth' | 'step';
export type ChartRadarGraticule = 'polygon' | 'circle';
/** Where bar labels go: `auto` puts them outside, or centred on stacked segments, and drops ones that do not fit. */
export type ChartLabelPosition = 'auto' | 'inside' | 'outside' | 'center';

/** A whole chart: data plus presentation. Plain JSON, safe to persist. */
export interface ChartSpec {
	version: 1;
	type: ChartType;
	title: string;
	subtitle: string;
	/** Category labels (the x axis, or pie slices). */
	categories: string[];
	series: ChartSeries[];
	/** The category axis (or the numeric x axis of a scatter or bubble chart). */
	xAxis: ChartAxis;
	/** The value axis. */
	yAxis: ChartAxis;
	/** The secondary value axis, drawn on the right when a visible series uses it. */
	yAxis2: ChartAxis;
	legend: ChartLegend;
	/** Stack bars and areas (`percent` scales each category to 100%). */
	stacking: ChartStacking;
	/** `horizontal` draws bars sideways (bar charts only). */
	orientation: ChartOrientation;
	/** Line and area interpolation. */
	curve: ChartCurve;
	/** Dots on line and area series. */
	points: boolean;
	/** Value labels on bars, points and slices. */
	dataLabels: boolean;
	/** Where bar value labels go. */
	labelPosition: ChartLabelPosition;
	/** Series colours in order (cycled through lighter and darker shades once used up). */
	palette: string[];
	/** Donut hole as a fraction of the radius (0–0.9). */
	innerRadius: number;
	/** Empty space between category groups, as a fraction of the category width (0–0.9). */
	gapWidth: number;
	/** How much bars in a group overlap, as a fraction of a bar's width (-1 to 1; negative is a gap). */
	overlap: number;
	/** Histogram bin count (`null`: √n, between 1 and 100). */
	bins: number | null;
	/** Waterfall: append a running-total bar (categories labelled "total" are always totals). */
	showTotal: boolean;
	/** Radar: number of evenly spaced rings from the value axis minimum to its maximum, 1–50 (`null`: round-number rings). */
	radarTicks: number | null;
	/** Radar: rings drawn as polygons through the spokes or as circles. */
	radarGraticule: ChartRadarGraticule;
}

/** What a click selects. */
export type ChartSelection =
	| { kind: 'chart' }
	| { kind: 'title' }
	| { kind: 'subtitle' }
	| { kind: 'legend' }
	| { kind: 'axis'; axis: 'x' | 'y' | 'y2' }
	| { kind: 'series'; seriesId: string }
	| { kind: 'point'; seriesId: string; index: number }
	| { kind: 'category'; index: number }
	| { kind: 'trendline'; seriesId: string; index: number };

/** Colours and type used to lay out a chart. Any CSS colour strings work. */
export interface ChartTheme {
	/** Fill behind the chart (`transparent` lets the page show through). */
	background: string;
	/** The page colour: slice separators and hollow points (set it when `background` is transparent). */
	surface: string;
	text: string;
	mutedText: string;
	grid: string;
	axis: string;
	/** Outline drawn around the selected mark. */
	selection: string;
	/** Waterfall increases. */
	positive: string;
	/** Waterfall decreases. */
	negative: string;
	fontFamily: string;
	fontSize: number;
	titleSize: number;
}

export interface ChartRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** What a mark is, for styling and tests. */
export type ChartMarkRole =
	| 'background'
	| 'title'
	| 'subtitle'
	| 'grid'
	| 'axis'
	| 'tick'
	| 'tick-label'
	| 'axis-title'
	| 'bar'
	| 'line'
	| 'area'
	| 'point'
	| 'slice'
	| 'cell'
	| 'box'
	| 'whisker'
	| 'outlier'
	| 'connector'
	| 'trendline'
	| 'trendline-label'
	| 'error-bar'
	| 'data-label'
	| 'legend-swatch'
	| 'legend-label'
	| 'drag-readout'
	| 'selection'
	| 'empty';

interface ChartMarkBase {
	/** Unique within the scene (a stable key for frameworks). */
	key: string;
	role: ChartMarkRole;
	/** What clicking this mark selects (none: not clickable). */
	target?: ChartSelection;
	/** Mark belongs to the current selection. */
	selected?: boolean;
	opacity?: number;
}

export interface ChartRectMark extends ChartMarkBase {
	kind: 'rect';
	x: number;
	y: number;
	width: number;
	height: number;
	fill: string;
	stroke?: string;
	strokeWidth?: number;
	radius?: number;
}

export interface ChartPathMark extends ChartMarkBase {
	kind: 'path';
	d: string;
	fill?: string;
	stroke?: string;
	strokeWidth?: number;
	dash?: string;
}

export interface ChartCircleMark extends ChartMarkBase {
	kind: 'circle';
	cx: number;
	cy: number;
	r: number;
	fill: string;
	stroke?: string;
	strokeWidth?: number;
}

export interface ChartLineMark extends ChartMarkBase {
	kind: 'line';
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	stroke: string;
	strokeWidth?: number;
	dash?: string;
}

export interface ChartTextMark extends ChartMarkBase {
	kind: 'text';
	x: number;
	y: number;
	text: string;
	anchor: 'start' | 'middle' | 'end';
	/** Vertical alignment of the text box to `y`. */
	baseline: 'top' | 'middle' | 'bottom';
	size: number;
	weight?: number;
	fill: string;
	/** Degrees, around (x, y). */
	rotate?: number;
}

export type ChartMark = ChartRectMark | ChartPathMark | ChartCircleMark | ChartLineMark | ChartTextMark;

/** Maps between data values and scene pixels along one axis of the plot. */
export interface ChartValueScale {
	/** `y` for vertical charts, `x` for horizontal bars and the numeric x axis of scatter charts. */
	axis: 'x' | 'y';
	domain: [number, number];
	range: [number, number];
	ticks: number[];
	/** Set when the axis is logarithmic: values map by their logarithm in this base. */
	logBase?: number;
}

/** Something the layout had to leave out or shorten, as a sentence (for agents and screen readers). */
export interface ChartWarning {
	code: 'labels-hidden' | 'labels-truncated' | 'legend-truncated' | 'points-decimated' | 'values-skipped' | 'data-labels-hidden' | 'type-fallback';
	message: string;
}

/** A laid-out chart: drawing primitives in scene pixels, ready for SVG, canvas or anything else. */
export interface ChartScene {
	width: number;
	height: number;
	/** The plot area (inside the axes). Empty for pies. */
	plot: ChartRect;
	/** Draw in order. */
	marks: ChartMark[];
	/** The value scale of a cartesian chart (absent for pies and empty charts). */
	valueScale?: ChartValueScale;
	/** The secondary value scale, when a visible series uses it. */
	valueScale2?: ChartValueScale;
	/** The numeric x scale of a scatter or bubble chart with x values. */
	xScale?: ChartValueScale;
	/** Percent-stacked: values are shown as shares, so dragging is disabled. */
	percent: boolean;
	theme: ChartTheme;
	/** What was left out or shortened (hidden labels, decimated lines, …). */
	warnings: ChartWarning[];
}

export interface ChartIssue {
	path: string;
	message: string;
	/** 1-based source line, for text formats such as Mermaid. */
	line?: number;
}
