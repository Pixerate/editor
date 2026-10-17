// Quick layouts and colour schemes, as GridCraft's `chart.quickLayout` and `chart.changeColors` offer them
// (gridcraft-main/crates/engine/src/cmd/extra.rs; MIT OR Apache-2.0, © ArtCraft Team and contributors).
// See THIRD_PARTY_NOTICES.md.
import { shadeChartColor } from './color.js';
import { DEFAULT_CHART_PALETTE } from './spec.js';
import type { ChartAxis, ChartLegend, ChartSpec } from './types.js';

/** A partial change several fields at once (what `ChartController.update` takes). */
export type ChartPresetPatch = Partial<Omit<ChartSpec, 'version' | 'xAxis' | 'yAxis' | 'yAxis2' | 'legend' | 'series' | 'categories'>> & {
	xAxis?: Partial<ChartAxis>;
	yAxis?: Partial<ChartAxis>;
	yAxis2?: Partial<ChartAxis>;
	legend?: Partial<ChartLegend>;
};

export interface ChartLayoutPreset {
	id: string;
	label: string;
	description: string;
	patch: ChartPresetPatch;
}

/** Quick layouts: legend, labels and grid lines set together. */
export const CHART_LAYOUT_PRESETS: readonly ChartLayoutPreset[] = [
	{ id: 'standard', label: 'Standard', description: 'Legend at the bottom, value grid lines, no data labels.', patch: { legend: { show: true, position: 'bottom' }, dataLabels: false, xAxis: { gridlines: false, show: true }, yAxis: { gridlines: true, show: true } } },
	{ id: 'minimal', label: 'Minimal', description: 'No legend, grid lines or axis titles; the data speaks.', patch: { legend: { show: false }, dataLabels: false, xAxis: { gridlines: false, title: '' }, yAxis: { gridlines: false, title: '' } } },
	{ id: 'labelled', label: 'Labelled', description: 'Values written on the marks, no value axis or grid lines.', patch: { dataLabels: true, labelPosition: 'auto', yAxis: { show: false, gridlines: false }, xAxis: { gridlines: false } } },
	{ id: 'legend-right', label: 'Legend on the right', description: 'Legend beside the plot, value grid lines.', patch: { legend: { show: true, position: 'right' }, yAxis: { gridlines: true } } },
	{ id: 'presentation', label: 'Presentation', description: 'Legend on top, data labels, light grid.', patch: { legend: { show: true, position: 'top' }, dataLabels: true, yAxis: { gridlines: true }, xAxis: { gridlines: false } } },
	{ id: 'analysis', label: 'Analysis', description: 'Grid lines on both axes, point markers, legend at the bottom.', patch: { legend: { show: true, position: 'bottom' }, points: true, dataLabels: false, xAxis: { gridlines: true }, yAxis: { gridlines: true } } }
];

export interface ChartColorScheme {
	id: string;
	label: string;
	description: string;
	palette: readonly string[];
}

/** Shades of one hue, dark to light (for monochrome schemes). */
export function monochromeChartPalette(base: string, count = 6): string[] {
	const steps = count <= 1 ? [0] : Array.from({ length: count }, (_, i) => -0.45 + (1.05 * i) / (count - 1));
	return steps.map((t) => shadeChartColor(base, t));
}

/** Named palettes. `default` and `okabe-ito` are colour-blind friendly. */
export const CHART_COLOR_SCHEMES: readonly ChartColorScheme[] = [
	{ id: 'default', label: 'Default', description: 'Ten distinct colours, readable on light and dark backgrounds.', palette: DEFAULT_CHART_PALETTE },
	{ id: 'okabe-ito', label: 'Okabe–Ito', description: 'Eight colours chosen to stay distinct with colour-blindness.', palette: ['#e69f00', '#56b4e9', '#009e73', '#f0e442', '#0072b2', '#d55e00', '#cc79a7', '#000000'] },
	{ id: 'office', label: 'Office', description: 'The six accent colours of the default Office theme.', palette: ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'] },
	{ id: 'warm', label: 'Warm', description: 'Reds, oranges and yellows.', palette: ['#b2182b', '#d6604d', '#f4a582', '#e08214', '#fdb863', '#8c510a'] },
	{ id: 'cool', label: 'Cool', description: 'Blues, teals and purples.', palette: ['#2166ac', '#4393c3', '#35978f', '#80cdc1', '#762a83', '#9970ab'] },
	{ id: 'monochrome-blue', label: 'Monochrome blue', description: 'Shades of one blue.', palette: monochromeChartPalette('#4269d0') },
	{ id: 'monochrome-green', label: 'Monochrome green', description: 'Shades of one green.', palette: monochromeChartPalette('#3ca951') },
	{ id: 'monochrome-orange', label: 'Monochrome orange', description: 'Shades of one orange.', palette: monochromeChartPalette('#e8710a') },
	{ id: 'monochrome-gray', label: 'Monochrome grey', description: 'Shades of grey.', palette: monochromeChartPalette('#6b7280') }
];

/** The change a named layout and / or colour scheme makes, or a sentence saying which names exist. */
export function chartPresetPatch(options: { layout?: string; colors?: string }): { ok: true; patch: ChartPresetPatch } | { ok: false; message: string } {
	const patch: ChartPresetPatch = {};
	if (options.layout !== undefined) {
		const preset = CHART_LAYOUT_PRESETS.find((p) => p.id === options.layout);
		if (!preset) return { ok: false, message: `There is no layout "${options.layout}"; expected one of ${CHART_LAYOUT_PRESETS.map((p) => `"${p.id}"`).join(', ')}.` };
		Object.assign(patch, preset.patch);
	}
	if (options.colors !== undefined) {
		const scheme = CHART_COLOR_SCHEMES.find((p) => p.id === options.colors);
		if (!scheme) return { ok: false, message: `There is no colour scheme "${options.colors}"; expected one of ${CHART_COLOR_SCHEMES.map((p) => `"${p.id}"`).join(', ')}.` };
		patch.palette = [...scheme.palette];
	}
	if (options.layout === undefined && options.colors === undefined) return { ok: false, message: 'Name a layout, a colour scheme or both.' };
	return { ok: true, patch };
}
