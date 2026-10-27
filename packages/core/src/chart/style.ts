/**
 * House style for charts: the `chart.json` profile (palette, allowed colour schemes and
 * layouts, theme, defaults for new charts), its checks, and `check_chart_style`.
 */
import type { AgentTool, AgentToolProvider } from '../tools/registry.js';
import type { StyleCheck, StyleDomain, StyleResolver } from '../tools/style.js';
import type { ChartSelection, ChartSpec, ChartType } from './types.js';
import { CHART_PALETTE_SHADES, chartColorDistance, chartContrastRatio, checkChartColors, parseChartColor, shadeChartColor } from './color.js';
import { chartColorsByCategory, chartSeriesColor, chartSliceColor } from './spec.js';
import { CHART_COLOR_SCHEMES, CHART_LAYOUT_PRESETS } from './presets.js';
import type { ChartController } from './controller.js';

const CHART_TYPES: readonly ChartType[] = ['bar', 'line', 'area', 'scatter', 'bubble', 'pie', 'donut', 'radar', 'waterfall', 'histogram', 'box', 'funnel', 'treemap'];

/** A chart's `chart.json` house-style profile, after `$token` references are resolved. */
export interface ChartStyleProfile {
	/** Series colours in order: the house palette. */
	palette?: string[];
	/** `CHART_COLOR_SCHEMES` ids allowed besides the palette. */
	colorSchemes?: string[];
	/** `CHART_LAYOUT_PRESETS` ids allowed. */
	layouts?: string[];
	/** Colours and type to draw charts with (the `theme` option of the chart renderers). */
	theme?: Partial<Record<'background' | 'surface' | 'text' | 'mutedText' | 'grid' | 'axis' | 'positive' | 'negative' | 'fontFamily', string> & Record<'fontSize' | 'titleSize', number>>;
	/** Spec values new charts start from. */
	defaults?: Partial<Pick<ChartSpec, 'dataLabels' | 'points' | 'curve' | 'stacking' | 'orientation' | 'labelPosition'>>;
}

const COLOR = { type: 'string', minLength: 1, description: 'A CSS colour (hex or rgb()), or a { "$token": ... } reference.' } as const;

/** The colours a chart draws with, each with the selection that edits it. */
function chartColors(spec: ChartSpec): { color: string; label: string; target: ChartSelection }[] {
	const out: { color: string; label: string; target: ChartSelection }[] = [];
	const visible = spec.series.map((s, i) => ({ s, i })).filter(({ s }) => !s.hidden);
	if (chartColorsByCategory(spec.type)) {
		const first = visible[0];
		spec.categories.forEach((name, index) => {
			const color = first?.s.pointColors?.[index] || chartSliceColor(spec, index);
			out.push({ color, label: `Slice "${name}"`, target: first ? { kind: 'point', seriesId: first.s.id, index } : { kind: 'category', index } });
		});
		return out;
	}
	for (const { s, i } of visible) {
		out.push({ color: chartSeriesColor(spec, i), label: `Series "${s.name}"`, target: { kind: 'series', seriesId: s.id } });
		s.pointColors?.forEach((c, index) => {
			if (c) out.push({ color: c, label: `Point ${index + 1} of "${s.name}"`, target: { kind: 'point', seriesId: s.id, index } });
		});
	}
	return out;
}

const paletteOf = (profile: Readonly<Record<string, unknown>>) => {
	const palette = (profile as ChartStyleProfile).palette;
	if (!palette?.length) throw new Error('the profile has no palette.');
	return palette;
};

const paletteOnly: StyleCheck<ChartSpec> = {
	id: 'palette-only',
	description: 'Every series, slice and point colour comes from the house palette (or a lighter or darker shade the chart cycles to once the palette runs out).',
	optionsSchema: {
		type: 'object',
		properties: { tolerance: { type: 'number', minimum: 0, maximum: 1, description: 'Largest OKLab distance still counted as the same colour (default 0.02).' } },
		additionalProperties: false
	},
	run(spec, profile, { tolerance = 0.02 }) {
		const palette = paletteOf(profile);
		const allowed = palette.flatMap((c) => CHART_PALETTE_SHADES.map((t) => shadeChartColor(c, t))).map((c) => ({ c, rgb: parseChartColor(c) }));
		return chartColors(spec).flatMap(({ color, label, target }) => {
			const rgb = parseChartColor(color);
			if (!rgb) return [];
			let best = { c: palette[0], d: Infinity };
			for (const a of allowed) {
				if (!a.rgb) continue;
				const d = chartColorDistance(rgb, a.rgb);
				if (d < best.d) best = { c: a.c, d };
			}
			if (best.d <= (tolerance as number)) return [];
			const nearest = palette.map((c) => ({ c, d: parseChartColor(c) ? chartColorDistance(rgb, parseChartColor(c)!) : Infinity })).sort((a, b) => a.d - b.d)[0].c;
			return [{ severity: 'error' as const, message: `${label} uses ${color}, which is not in the house palette; use ${nearest} or another palette colour (${palette.join(', ')}).`, target }];
		});
	}
};

const distinguishable: StyleCheck<ChartSpec> = {
	id: 'distinguishable',
	description: 'Series (or slice) colours can be told apart with normal vision and with protanopia, deuteranopia and tritanopia.',
	optionsSchema: {
		type: 'object',
		properties: { minDistance: { type: 'number', minimum: 0, maximum: 1, description: 'Smallest OKLab distance between two colours after simulation (default 0.08).' } },
		additionalProperties: false
	},
	run(spec, _profile, { minDistance = 0.08 }) {
		const colors = chartColors(spec).filter((c) => c.target.kind !== 'point' || chartColorsByCategory(spec.type));
		const result = checkChartColors(colors.map((c) => c.color), { minDistance: minDistance as number, minContrast: 0 });
		const findings = [];
		for (const [vision, pair] of Object.entries(result.closest)) {
			if (!pair || pair.distance >= (minDistance as number)) continue;
			const who = vision === 'normal' ? '' : ` with ${vision}`;
			findings.push({
				severity: 'warning' as const,
				message: `${colors[pair.a].label} (${pair.colors[0]}) and ${colors[pair.b].label} (${pair.colors[1]}) are hard to tell apart${who} (distance ${pair.distance}, want ${minDistance}); give the second another palette colour.`,
				target: colors[pair.b].target
			});
		}
		return findings;
	}
};

const minContrast: StyleCheck<ChartSpec> = {
	id: 'min-contrast',
	description: "Marks stand out from the background: each series or slice colour against the profile theme's background (or surface, default white).",
	optionsSchema: {
		type: 'object',
		properties: { ratio: { type: 'number', minimum: 1, maximum: 21, description: 'Smallest contrast ratio (default 3, the WCAG ratio for graphics).' } },
		additionalProperties: false
	},
	run(spec, profile, { ratio = 3 }) {
		const theme = (profile as ChartStyleProfile).theme ?? {};
		const background = theme.background && theme.background !== 'transparent' ? theme.background : (theme.surface ?? '#ffffff');
		return chartColors(spec).flatMap(({ color, label, target }) => {
			const r = chartContrastRatio(color, background);
			if (r === null || r >= (ratio as number)) return [];
			return [{ severity: 'warning' as const, message: `${label} (${color}) has contrast ${Math.round(r * 100) / 100}:1 against the background ${background}; want at least ${ratio}:1, so use a darker or lighter palette colour.`, target }];
		});
	}
};

const allowedType: StyleCheck<ChartSpec> = {
	id: 'allowed-type',
	description: 'The chart is one of the chart types the house style allows.',
	optionsSchema: {
		type: 'object',
		properties: { types: { type: 'array', items: { type: 'string', enum: [...CHART_TYPES] }, minItems: 1, description: 'Allowed chart types.' } },
		required: ['types'],
		additionalProperties: false
	},
	run(spec, _profile, { types }) {
		const allowed = types as string[];
		if (allowed.includes(spec.type)) return [];
		return [{ severity: 'error' as const, message: `This is a ${spec.type} chart; the house style allows ${allowed.join(', ')}. Change the type with update_chart.`, target: { kind: 'chart' } satisfies ChartSelection }];
	}
};

/** The chart house-style domain: register it with `createStyleResolver({ domains })`. */
export const chartStyleDomain: StyleDomain<ChartSpec> = {
	id: 'chart',
	title: 'Charts',
	description: 'The house palette and theme for charts, which colour schemes and layouts are allowed, defaults for new charts, and the checks to run.',
	profileSchema: {
		type: 'object',
		properties: {
			palette: { type: 'array', items: COLOR, minItems: 1, description: 'Series colours in order.' },
			colorSchemes: { type: 'array', items: { type: 'string', enum: CHART_COLOR_SCHEMES.map((s) => s.id) }, description: 'Colour scheme ids allowed besides the palette (empty: none).' },
			layouts: { type: 'array', items: { type: 'string', enum: CHART_LAYOUT_PRESETS.map((p) => p.id) }, description: 'Layout preset ids allowed.' },
			theme: {
				type: 'object',
				properties: {
					background: COLOR,
					surface: COLOR,
					text: COLOR,
					mutedText: COLOR,
					grid: COLOR,
					axis: COLOR,
					positive: COLOR,
					negative: COLOR,
					fontFamily: { type: 'string', minLength: 1, description: 'CSS font family.' },
					fontSize: { type: 'number', minimum: 6, maximum: 48, description: 'Body text size in px.' },
					titleSize: { type: 'number', minimum: 6, maximum: 72, description: 'Title size in px.' }
				},
				additionalProperties: false,
				description: 'Colours and type to draw charts with.'
			},
			defaults: {
				type: 'object',
				properties: {
					dataLabels: { type: 'boolean', description: 'Value labels on.' },
					points: { type: 'boolean', description: 'Dots on lines.' },
					curve: { type: 'string', enum: ['linear', 'smooth', 'step'], description: 'Line interpolation.' },
					stacking: { type: 'string', enum: ['none', 'stacked', 'percent'], description: 'Stacking.' },
					orientation: { type: 'string', enum: ['vertical', 'horizontal'], description: 'Bar direction.' },
					labelPosition: { type: 'string', enum: ['auto', 'inside', 'outside', 'center'], description: 'Bar label position.' }
				},
				additionalProperties: false,
				description: 'Spec values new charts start from.'
			}
		},
		additionalProperties: false
	},
	checks: [paletteOnly, distinguishable, minContrast, allowedType]
};

/** The spec patch that starts a chart in the house style: the palette and the defaults. */
export function chartStylePatch(profile: Readonly<Record<string, unknown>>): Partial<ChartSpec> {
	const p = profile as ChartStyleProfile;
	return { ...(p.defaults ?? {}), ...(p.palette?.length ? { palette: [...p.palette] } : {}) };
}

export interface ChartStyleToolProviderOptions {
	/** Provider id (unique per registry). Default `chart-style`. */
	id?: string;
	/** Tool-name prefix; defaults to `chart`, so `check_chart_style` joins the chart toolset. */
	namespace?: string;
}

/** `check_chart_style`: runs the chart house-style checks against a chart. */
export function createChartStyleToolProvider(controller: ChartController, styles: StyleResolver, options: ChartStyleToolProviderOptions = {}): AgentToolProvider {
	if (!styles.domains.some((d) => d.id === 'chart')) throw new Error('The style resolver has no "chart" domain; add chartStyleDomain to its domains.');
	const check: AgentTool = {
		name: 'check_chart_style',
		title: 'Check chart house style',
		description:
			"Checks the chart against the house style (see get_style with domain \"chart\"): runs the checks its profile turns on (palette-only, distinguishable, min-contrast, allowed-type). Returns findings with a severity, a sentence saying how to fix it, a target selection (series id or point) for update_chart_series or update_chart, and the layer that asked for it; plus the checks that ran and the ones skipped with the reason. Check after a batch of edits and again after fixing.",
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		annotations: { title: 'Check chart house style', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		handler: async () => {
			const { style, ...report } = await styles.check('chart', controller.getSpec() as ChartSpec);
			return {
				...report,
				ok: report.findings.length === 0,
				...(style.skills.length ? {} : { note: 'No house style applies to charts.' }),
				...(style.issues.length ? { issues: style.issues } : {})
			};
		}
	};
	return {
		id: options.id ?? 'chart-style',
		namespace: options.namespace ?? 'chart',
		title: 'Chart house style',
		description: 'Check a chart against the house style.',
		skill: 'pixerate-chart',
		tools: [check]
	};
}
