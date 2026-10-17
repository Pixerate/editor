/** Chart kinds. `bar`, `line`, `area` and `scatter` are cartesian; series may mix them (a combo chart). */
export type ChartType = 'bar' | 'line' | 'area' | 'scatter' | 'pie' | 'donut';

/** How a series is drawn in a cartesian chart. */
export type ChartSeriesType = 'bar' | 'line' | 'area' | 'scatter';

/** One data value; `null` is a gap (missing value). */
export type ChartValue = number | null;

export interface ChartSeries {
	/** Stable id (unique within the chart). */
	id: string;
	name: string;
	/** One value per category. */
	values: ChartValue[];
	/** CSS colour (default: the palette colour for the series' position). */
	color?: string;
	/** Overrides the chart type for this series (cartesian charts only). */
	type?: ChartSeriesType;
	/** Hidden series keep their data but are not drawn or scaled. */
	hidden?: boolean;
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
}

export interface ChartAxis {
	/** Draw the axis line, ticks and labels (default `true`). */
	show: boolean;
	title: string;
	/** Fixed lower bound (default: from the data, including 0 for bars and areas). */
	min: number | null;
	/** Fixed upper bound (default: from the data). */
	max: number | null;
	/** Grid lines at each tick (default: on for the value axis). */
	gridlines: boolean;
	/** How tick and data labels are written (value axis only). */
	format: ChartNumberFormat;
}

export type ChartLegendPosition = 'top' | 'bottom' | 'left' | 'right';

export interface ChartLegend {
	show: boolean;
	position: ChartLegendPosition;
}

export type ChartStacking = 'none' | 'stacked' | 'percent';
export type ChartOrientation = 'vertical' | 'horizontal';
export type ChartCurve = 'linear' | 'smooth' | 'step';

/** A whole chart: data plus presentation. Plain JSON, safe to persist. */
export interface ChartSpec {
	version: 1;
	type: ChartType;
	title: string;
	subtitle: string;
	/** Category labels (the x axis, or pie slices). */
	categories: string[];
	series: ChartSeries[];
	/** The category axis. */
	xAxis: ChartAxis;
	/** The value axis. */
	yAxis: ChartAxis;
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
	/** Series colours in order (cycled). */
	palette: string[];
	/** Donut hole as a fraction of the radius (0–0.9). */
	innerRadius: number;
}

/** What a click selects. */
export type ChartSelection =
	| { kind: 'chart' }
	| { kind: 'title' }
	| { kind: 'subtitle' }
	| { kind: 'legend' }
	| { kind: 'axis'; axis: 'x' | 'y' }
	| { kind: 'series'; seriesId: string }
	| { kind: 'point'; seriesId: string; index: number }
	| { kind: 'category'; index: number };

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
	| 'data-label'
	| 'legend-swatch'
	| 'legend-label'
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
	/** `y` for vertical charts, `x` for horizontal bars. */
	axis: 'x' | 'y';
	domain: [number, number];
	range: [number, number];
	ticks: number[];
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
	/** Percent-stacked: values are shown as shares, so dragging is disabled. */
	percent: boolean;
	theme: ChartTheme;
}

export interface ChartIssue {
	path: string;
	message: string;
}
