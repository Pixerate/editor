import type { JsonSchema } from '../tools/schema.js';
import { CHART_ERROR_BAR_DIRECTIONS, CHART_ERROR_BAR_TYPES } from './errorbars.js';
import {
	CHART_AXIS_KINDS,
	CHART_AXIS_SCALES,
	CHART_CURVES,
	CHART_LABEL_POSITIONS,
	CHART_LEGEND_POSITIONS,
	CHART_MARKERS,
	CHART_NUMBER_STYLES,
	CHART_ORIENTATIONS,
	CHART_RADAR_GRATICULES,
	CHART_SERIES_TYPES,
	CHART_STACKINGS,
	CHART_TRENDLINE_TYPES,
	CHART_TYPES
} from './spec.js';

// JSON Schema fragments shared by the chart commands and the chart agent tools.

export const VALUE: JsonSchema = { type: ['number', 'string', 'null'], description: 'A number, numeric text ("1,200", "12%", "$40", "(3)") or null for a gap.' };
export const SERIES_REF: JsonSchema = { type: 'string', description: 'Series id (from get_chart) or exact series name.' };
export const CATEGORY_REF: JsonSchema = { type: ['string', 'integer'], description: 'Category index (0-based) or exact category label.' };
export const WIDTH: JsonSchema = { type: 'number', minimum: 50, maximum: 4096, description: 'Width in pixels (default 640).' };
export const HEIGHT: JsonSchema = { type: 'number', minimum: 50, maximum: 4096, description: 'Height in pixels (default 400).' };

export const FORMAT: JsonSchema = {
	type: 'object',
	description: 'How numbers are written on this axis or series.',
	properties: {
		style: { type: 'string', enum: [...CHART_NUMBER_STYLES], description: 'number (default), percent (0.25 → 25%), currency or compact (1.2K).' },
		decimals: { type: 'integer', minimum: 0, maximum: 10, description: 'Fixed decimals (default: what the ticks need).' },
		currency: { type: 'string', description: 'ISO currency code for style "currency", e.g. "EUR" (default USD).' },
		prefix: { type: 'string', description: 'Text before every number.' },
		suffix: { type: 'string', description: 'Text after every number.' },
		code: { type: 'string', description: 'Spreadsheet format code such as "#,##0.0,,\\"M\\"" or "0.0%"; wins over the other fields.' }
	},
	additionalProperties: false
};

export const AXIS = (what: string): JsonSchema => ({
	type: 'object',
	description: what,
	properties: {
		show: { type: 'boolean', description: 'Draw the axis labels (default true).' },
		title: { type: 'string', description: 'Axis title ("" for none).' },
		min: { type: ['number', 'null'], description: 'Fixed lower bound, or null for automatic.' },
		max: { type: ['number', 'null'], description: 'Fixed upper bound, or null for automatic.' },
		step: { type: ['number', 'null'], exclusiveMinimum: 0, description: 'Fixed distance between ticks, or null for automatic.' },
		gridlines: { type: 'boolean', description: 'Grid lines at each tick.' },
		format: FORMAT,
		kind: { type: ['string', 'null'], enum: [...CHART_AXIS_KINDS, null], description: 'Category axis only: "date" reads categories as dates and labels them by calendar steps.' },
		scale: {
			type: ['string', 'null'],
			enum: [...CHART_AXIS_SCALES, null],
			description:
				'Value axes and the numeric x axis of scatter / bubble charts: "log" spaces ticks by powers of logBase (values of 0 or less are skipped; min and max must be above 0; not with percent stacking). "linear" or null is the default. Ignored on a category axis.'
		},
		logBase: { type: ['number', 'null'], minimum: 2, maximum: 1000, description: 'Base of a log axis, 2 to 1000 (default 10; null resets).' },
		reverse: { type: ['boolean', 'null'], description: 'Run the axis the other way: values from the top down (or right to left), categories from the far end. Default false.' }
	},
	additionalProperties: false
});

export const TRENDLINE_PROPS: Record<string, JsonSchema> = {
	type: { type: 'string', enum: [...CHART_TRENDLINE_TYPES], description: 'Fit: linear, exponential, logarithmic, power, polynomial or moving-average.' },
	order: { type: 'integer', minimum: 2, maximum: 6, description: 'Polynomial order (default 2).' },
	period: { type: 'integer', minimum: 2, description: 'Moving-average period in points (default 2).' },
	forward: { type: 'number', minimum: 0, description: 'Extend the line this many x units past the last point (default 0).' },
	backward: { type: 'number', minimum: 0, description: 'Extend the line this many x units before the first point (default 0).' },
	intercept: { type: ['number', 'null'], description: 'Force the fit through this y at x = 0 (linear, polynomial, exponential).' },
	showEquation: { type: 'boolean', description: 'Write the fitted equation on the chart.' },
	showR2: { type: 'boolean', description: 'Write R² on the chart.' },
	name: { type: 'string', description: 'Legend name (default e.g. "Linear (Sales)").' },
	color: { type: 'string', description: 'CSS colour (default: the series colour).' }
};

export const ERROR_BARS = (what: string): JsonSchema => ({
	type: ['object', 'null'],
	description: `${what} null removes them.`,
	properties: {
		type: {
			type: 'string',
			enum: [...CHART_ERROR_BAR_TYPES],
			description: 'fixed: the same amount at every point; percent: a percentage of each value; stddev: value standard deviations of the series, drawn around the series mean (as Excel does); stderr: the standard error of the series at every point; custom: per-point plus / minus amounts.'
		},
		value: { type: 'number', minimum: 0, description: 'Amount in data units for fixed (default 1), percent of each value for percent (default 5), number of standard deviations for stddev (default 1). Not for stderr or custom.' },
		plus: { type: 'array', items: VALUE, description: 'custom only: amount above each point, one per category, in data units (0 or more; null for none).' },
		minus: { type: 'array', items: VALUE, description: 'custom only: amount below each point, one per category (default: the plus amounts).' },
		direction: { type: 'string', enum: [...CHART_ERROR_BAR_DIRECTIONS], description: 'both (default), plus (only above) or minus (only below).' },
		cap: { type: 'boolean', description: 'Draw end caps (default true).' }
	},
	required: ['type'],
	additionalProperties: false
});

export const SERIES_PROPS: Record<string, JsonSchema> = {
	name: { type: 'string', description: 'Series name (legend and data grid header).' },
	values: { type: 'array', items: VALUE, description: 'One value per category, in category order (padded with gaps).' },
	color: { type: ['string', 'null'], description: 'CSS colour, or null for the palette colour.' },
	type: { type: ['string', 'null'], enum: [...CHART_SERIES_TYPES, null], description: 'Draw this series as bar, line, area or scatter (a combo chart); null follows the chart type.' },
	hidden: { type: 'boolean', description: 'Hide the series (its data is kept).' },
	axis: { type: ['string', 'null'], enum: ['primary', 'secondary', null], description: 'Value axis: secondary is drawn on the right with its own scale.' },
	x: { type: ['array', 'null'], items: VALUE, description: 'Numeric x per category, for scatter and bubble charts.' },
	sizes: { type: ['array', 'null'], items: VALUE, description: 'Bubble sizes per category (area is proportional to size).' },
	pointColors: { type: ['array', 'null'], items: { type: ['string', 'null'] }, description: 'Colour per category (null keeps the series colour).' },
	marker: { type: ['string', 'null'], enum: [...CHART_MARKERS, null], description: 'Point marker shape for line, area and scatter series.' },
	curve: { type: ['string', 'null'], enum: [...CHART_CURVES, null], description: 'Line shape for this series: linear, smooth or step.' },
	dataLabels: { type: ['boolean', 'null'], description: 'Value labels for this series (null follows the chart).' },
	format: { ...FORMAT, type: ['object', 'null'], description: 'How this series\' labels are written (null follows the value axis).' },
	errorBars: ERROR_BARS('Error bars along the value axis (bar, line, area and scatter series; on stacked charts they sit on the stack top).'),
	xErrorBars: ERROR_BARS('Error bars along the x axis (scatter and bubble charts with numeric x values; amounts in x units).')
};


export const CHART_UPDATE_PROPERTIES: Record<string, JsonSchema> = {
				type: { type: 'string', enum: [...CHART_TYPES], description: 'Chart type.' },
				title: { type: 'string', description: 'Title ("" for none).' },
				subtitle: { type: 'string', description: 'Subtitle ("" for none).' },
				xAxis: AXIS('Category axis (or numeric x axis of scatter / bubble charts).'),
				yAxis: AXIS('Value axis.'),
				yAxis2: AXIS('Secondary value axis (for series with axis "secondary").'),
				legend: {
					type: 'object',
					description: 'Legend.',
					properties: { show: { type: 'boolean', description: 'Show the legend.' }, position: { type: 'string', enum: [...CHART_LEGEND_POSITIONS], description: 'Where the legend goes.' } },
					additionalProperties: false
				},
				stacking: { type: 'string', enum: [...CHART_STACKINGS], description: 'none, stacked, or percent (each category scaled to 100%).' },
				orientation: { type: 'string', enum: [...CHART_ORIENTATIONS], description: 'horizontal draws bars sideways.' },
				curve: { type: 'string', enum: [...CHART_CURVES], description: 'Line shape: linear, smooth or step.' },
				points: { type: 'boolean', description: 'Dots on line and area series.' },
				dataLabels: { type: 'boolean', description: 'Value labels on bars, points and slices.' },
				labelPosition: { type: 'string', enum: [...CHART_LABEL_POSITIONS], description: 'Bar label position; auto drops labels that do not fit.' },
				palette: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Series colours in order (CSS colours).' },
				innerRadius: { type: 'number', minimum: 0, maximum: 0.9, description: 'Donut hole as a fraction of the radius.' },
				gapWidth: { type: 'number', minimum: 0, maximum: 0.9, description: 'Space between bar groups as a fraction of the category (default 0.28).' },
				overlap: { type: 'number', minimum: -1, maximum: 1, description: 'Bar overlap within a group as a fraction of a bar (negative: a gap; default -0.12).' },
				bins: { type: ['integer', 'null'], minimum: 1, maximum: 500, description: 'Histogram bin count, or null for √n.' },
				showTotal: { type: 'boolean', description: 'Waterfall: append a total bar.' },
				radarTicks: { type: ['integer', 'null'], minimum: 1, maximum: 50, description: 'Radar: number of evenly spaced rings from the value axis min to max, or null for round-number rings (default null).' },
				radarGraticule: { type: 'string', enum: [...CHART_RADAR_GRATICULES], description: 'Radar: draw rings as polygons through the spokes or as circles (default polygon).' }
			};
