import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EUROPE_CHART_MAP } from '../src/chart-maps/europe.js';
import { layoutChart, type ChartLayoutOptions } from '../src/chart/layout.js';
import { registerChartMap } from '../src/chart/maps.js';
import {
	chartFromMermaid,
	chartMermaidFamily,
	chartToMermaid,
	findMermaidCharts,
	type ChartMermaidOptions,
	type ChartMermaidParseOptions
} from '../src/chart/mermaid.js';
import { chartFileName, chartRasterSize, resolveChartSvgPaints } from '../src/chart/raster.js';
import { sparklineToSvg, type ChartSparklineOptions } from '../src/chart/sparkline.js';
import { CSS_VARIABLE_CHART_THEME, createChartSpec } from '../src/chart/spec.js';
import { chartSceneToDomSpec, chartSceneToSvg, chartToSvg, type ChartSvgOptions } from '../src/chart/svg.js';
import { parseSankey } from '../src/diagram/sankey/index.js';
import { parseTreemap, treemapValue } from '../src/diagram/treemap/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../swift/Tests/PixerateChartTests/Fixtures/chart-svg-mermaid-vectors.json');

function buildVectors() {
	registerChartMap(EUROPE_CHART_MAP);

	const familySpecs: { name: string; input: unknown; width?: number; height?: number; svgOptions?: ChartSvgOptions; layoutOptions?: Partial<ChartLayoutOptions> }[] = [
		{
			name: 'cartesian-bar-line-combo',
			input: {
				type: 'bar',
				title: 'Quarterly Revenue & Margin <2025>',
				subtitle: 'In "millions" & %',
				categories: ['Q1', 'Q2', 'Q3', 'Q4'],
				series: [
					{ id: 'rev', name: 'Revenue & Sales', values: [120, 145, 160, 190], dataLabels: true },
					{ id: 'margin', name: 'Margin', type: 'line', axis: 'secondary', values: [0.22, 0.25, 0.24, 0.28], trendlines: [{ type: 'linear', showEquation: true, showR2: true }] }
				],
				yAxis2: { show: true, title: 'Margin %', format: { style: 'percent', decimals: 0 } },
				referenceLines: [{ value: 150, label: 'Target' }],
				referenceBands: [{ from: 130, to: 170, label: 'Band' }]
			}
		},
		{
			name: 'cartesian-RotatedLabels-Selection',
			input: {
				type: 'area',
				title: 'Monthly Active Users',
				categories: ['January 2025', 'February 2025', 'March 2025', 'April 2025', 'May 2025', 'June 2025', 'July 2025', 'August 2025'],
				series: [
					{ id: 's1', name: 'Web', values: [10, 20, 15, 30, 25, 40, 35, 50] },
					{ id: 's2', name: 'Mobile', values: [15, 25, 20, 35, 30, 45, 40, 55] }
				],
				stacking: 'stacked',
				curve: 'monotone'
			},
			width: 420,
			height: 280,
			layoutOptions: { selection: { kind: 'point', seriesId: 's1', index: 2 } },
			svgOptions: { hideSelection: false, ariaLabel: 'Custom Aria Title', description: 'Custom Description' }
		},
		{
			name: 'xy-bubble',
			input: {
				type: 'bubble',
				title: 'Deals by Size',
				categories: ['A', 'B', 'C', 'D'],
				series: [{ id: 'deals', name: 'Deals', x: [10, 25, 40, 55], values: [20, 45, 30, 70], sizes: [5, 15, 10, 25], marker: 'diamond' }]
			}
		},
		{
			name: 'pie-donut',
			input: {
				type: 'donut',
				title: 'Share by Region',
				categories: ['North', 'South', 'East', 'West'],
				series: [{ id: 'share', name: 'Share', values: [42, 28, 19, 11] }],
				dataLabels: true
			}
		},
		{
			name: 'radar-polygon',
			input: {
				type: 'radar',
				title: 'Platform Score',
				categories: ['Speed', 'Reliability', 'Cost', 'UX', 'Docs'],
				series: [
					{ id: 'v1', name: 'v1', values: [70, 80, 60, 75, 65] },
					{ id: 'v2', name: 'v2', values: [90, 88, 75, 85, 80] }
				],
				radarTicks: 4,
				radarGraticule: 'polygon'
			}
		},
		{
			name: 'waterfall',
			input: {
				type: 'waterfall',
				title: 'Operating Bridge',
				categories: ['Start', 'New Logos', 'Expansion', 'Churn', 'Costs'],
				series: [{ id: 'bridge', name: 'Bridge', values: [100, 40, 25, -18, -32] }],
				showTotal: true,
				dataLabels: true
			}
		},
		{
			name: 'histogram',
			input: {
				type: 'histogram',
				title: 'Latency Distribution',
				categories: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
				series: [{ id: 'lat', name: 'Latency', values: [12, 15, 18, 22, 24, 25, 27, 31, 35, 48] }],
				bins: 4
			}
		},
		{
			name: 'box',
			input: {
				type: 'box',
				title: 'Scores by Cohort',
				categories: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'],
				series: [
					{ id: 'c1', name: 'Cohort A', values: [10, 20, 22, 25, 28, 30, 65] },
					{ id: 'c2', name: 'Cohort B', values: [15, 18, 24, 27, 32, 35, 40] }
				]
			}
		},
		{
			name: 'funnel',
			input: {
				type: 'funnel',
				title: 'Signup Funnel',
				categories: ['Visited', 'Signed Up', 'Activated', 'Paid'],
				series: [{ id: 'f', name: 'Users', values: [1000, 420, 180, 75] }],
				dataLabels: true
			}
		},
		{
			name: 'treemap',
			input: {
				type: 'treemap',
				title: 'Budget Breakdown',
				tree: [
					{ name: 'Engineering', children: [{ name: 'Frontend', value: 45 }, { name: 'Backend', value: 65 }] },
					{ name: 'Go-to-Market', children: [{ name: 'Sales', value: 50 }, { name: 'Marketing', value: 30 }] }
				],
				dataLabels: true
			}
		},
		{
			name: 'slope',
			input: {
				type: 'slope',
				title: 'Before vs After',
				categories: ['2024', '2025'],
				series: [
					{ id: 'a', name: 'Alpha', values: [40, 68] },
					{ id: 'b', name: 'Beta', values: [55, 48] },
					{ id: 'g', name: 'Gamma', values: [30, 52] }
				]
			}
		},
		{
			name: 'likert',
			input: {
				type: 'likert',
				title: 'Survey Responses',
				categories: ['Ease of use', 'Performance', 'Support'],
				series: [
					{ id: 'sd', name: 'Strongly disagree', values: [5, 8, 4] },
					{ id: 'd', name: 'Disagree', values: [10, 12, 8] },
					{ id: 'n', name: 'Neutral', values: [15, 20, 18] },
					{ id: 'a', name: 'Agree', values: [45, 38, 42] },
					{ id: 'sa', name: 'Strongly agree', values: [25, 22, 28] }
				],
				likertNeutral: 'split',
				likertSort: 'net'
			}
		},
		{
			name: 'parliament',
			input: {
				type: 'parliament',
				title: 'Chamber Seats',
				categories: ['Left', 'Centre', 'Right', 'Green'],
				series: [{ id: 'seats', name: 'Seats', values: [180, 110, 140, 45] }],
				parliamentMajority: 238,
				parliamentLabel: '475 seats'
			}
		},
		{
			name: 'sunburst',
			input: {
				type: 'sunburst',
				title: 'Cloud Spend',
				sunburstLabel: '$190k',
				tree: [
					{
						name: 'Prod',
						children: [
							{ name: 'Compute', children: [{ name: 'API', value: 60 }, { name: 'Workers', value: 40 }] },
							{ name: 'Storage', value: 35 }
						]
					},
					{ name: 'Staging', children: [{ name: 'Compute', value: 30 }, { name: 'Storage', value: 25 }] }
				]
			}
		},
		{
			name: 'sankey',
			input: {
				type: 'sankey',
				title: 'Energy Flow',
				links: [
					{ source: 'Solar', target: 'Grid', value: 45 },
					{ source: 'Wind', target: 'Grid', value: 35 },
					{ source: 'Grid', target: 'Homes', value: 50 },
					{ source: 'Grid', target: 'Industry', value: 30 }
				]
			}
		},
		{
			name: 'streamgraph',
			input: {
				type: 'streamgraph',
				title: 'Genre Streams',
				categories: ['W1', 'W2', 'W3', 'W4', 'W5'],
				series: [
					{ id: 'pop', name: 'Pop', values: [30, 42, 38, 50, 45] },
					{ id: 'rock', name: 'Rock', values: [25, 20, 28, 22, 30] },
					{ id: 'jazz', name: 'Jazz', values: [12, 18, 15, 20, 16] }
				]
			}
		},
		{
			name: 'barrace',
			input: {
				type: 'barrace',
				title: 'Top Brands',
				categories: ['2021', '2022', '2023'],
				series: [
					{ id: 'a', name: 'Apex', values: [100, 130, 160] },
					{ id: 'b', name: 'Bolt', values: [90, 140, 180] },
					{ id: 'c', name: 'Crest', values: [110, 115, 125] }
				],
				raceTopN: 2
			},
			layoutOptions: { raceFrame: 1.5 }
		},
		{
			name: 'choropleth',
			input: {
				type: 'choropleth',
				title: 'Adoption across Europe',
				map: 'europe',
				categories: ['France', 'Germany', 'Spain', 'Italy', 'Poland'],
				series: [{ id: 'rate', name: 'Adoption', values: [72, 84, 65, 58, 79] }],
				mapSteps: 4
			}
		}
	];

	const svgVectors = familySpecs.map((item) => {
		const spec = createChartSpec(item.input as any);
		const width = item.width ?? 640;
		const height = item.height ?? 400;
		const scene = layoutChart(spec, { width, height, ...item.layoutOptions });
		const sceneSvg = chartSceneToSvg(scene, item.svgOptions);
		const directSvg = chartToSvg(spec, { width, height, ...item.layoutOptions, ...item.svgOptions });
		return {
			name: item.name,
			spec,
			width,
			height,
			layoutOptions: item.layoutOptions ?? null,
			svgOptions: item.svgOptions ?? null,
			sceneSvg,
			directSvg
		};
	});

	const domSpecVectors = [familySpecs[0], familySpecs[1], familySpecs[3]].map((item) => {
		const spec = createChartSpec(item.input as any);
		const scene = layoutChart(spec, { width: item.width ?? 640, height: item.height ?? 400, ...item.layoutOptions });
		const extraAttrs = item.name === 'pie-donut' ? { 'data-chart-id': 'donut-1', class: 'chart-svg' } : undefined;
		return {
			name: item.name,
			spec,
			width: item.width ?? 640,
			height: item.height ?? 400,
			layoutOptions: item.layoutOptions ?? null,
			svgOptions: item.svgOptions ?? null,
			extraAttrs: extraAttrs ? Object.entries(extraAttrs) : [],
			domSpec: chartSceneToDomSpec(scene, { ...item.svgOptions, ...(extraAttrs ? { attrs: extraAttrs } : {}) })
		};
	});

	const sparklineCases: { name: string; values: (number | null)[]; options: ChartSparklineOptions & { ariaLabel?: string } }[] = [
		{ name: 'line-markers-highlow', values: [4, 8, null, 2, 10, 6], options: { kind: 'line', width: 80, height: 24, markers: true, highLow: true, ariaLabel: 'Trend' } },
		{ name: 'column-negative', values: [5, -3, 0, 8, -6], options: { kind: 'column', width: 64, height: 20, highLow: true } },
		{ name: 'win-loss', values: [12, -4, 0, 7, -1], options: { kind: 'win-loss', width: 60, height: 18 } }
	];
	const sparklineVectors = sparklineCases.map((c) => ({
		...c,
		svg: sparklineToSvg(c.values, c.options)
	}));

	const themedSvg = chartToSvg(
		createChartSpec({
			type: 'bar',
			title: 'Variables & currentColor',
			categories: ['A', 'B'],
			series: [{ id: 's1', name: 'S1', values: [10, 20], color: 'var(--chart-1, #2563eb)' }]
		}),
		{ width: 320, height: 200, theme: CSS_VARIABLE_CHART_THEME }
	);

	const paintCases: { name: string; svg: string; vars?: Record<string, string>; color?: string; fontFamily?: string }[] = [
		{ name: 'theme-default-fallbacks', svg: themedSvg },
		{ name: 'theme-custom-lookup', svg: themedSvg, vars: { '--foreground': '#f8fafc', '--muted-foreground': '#94a3b8', '--border': '#334155', '--chart-1': '#38bdf8' }, color: '#e2e8f0', fontFamily: '"Inter", sans-serif' },
		{
			name: 'nested-vars-currentcolor-and-empty-drop',
			svg: '<svg font-family="inherit" fill="var(--a, var(--b, #112233))" stroke="currentColor" data-empty="var(--missing)"><text fill="currentColor">var(--not-an-attr) &amp; currentColor</text></svg>',
			vars: { '--b': '#abcdef' },
			color: '#123456',
			fontFamily: 'Fira Sans'
		}
	];
	const paintVectors = paintCases.map((c) => ({
		...c,
		resolved: resolveChartSvgPaints(c.svg, {
			lookup: c.vars ? (name) => c.vars![name] ?? '' : undefined,
			scope:
				c.color || c.fontFamily
					? ({
							ownerDocument: {
								defaultView: {
									getComputedStyle: () => ({
										getPropertyValue: (n: string) => c.vars?.[n] ?? '',
										color: c.color ?? '',
										fontFamily: c.fontFamily ?? ''
									})
								}
							}
						} as any)
					: null
		})
	}));

	const rasterSizeCases: { width: number; height: number; scale?: number; maxSize?: number }[] = [
		{ width: 640, height: 400 },
		{ width: 800, height: 450, scale: 2, maxSize: 1024 },
		{ width: 300, height: 200, scale: 3, maxSize: 2048 },
		{ width: 500, height: 250, scale: 0, maxSize: 1024 },
		{ width: 0, height: 400 },
		{ width: 400, height: -10 }
	];
	const rasterSizeVectors = rasterSizeCases.map((c) => {
		try {
			return { ...c, result: chartRasterSize(c.width, c.height, c.scale, c.maxSize), error: null };
		} catch (e) {
			return { ...c, result: null, error: (e as Error).message };
		}
	});

	const fileNameTitles = ['Quarterly Revenue (2025)!', '  ---  ', 'Café & Résumé — 100%', '', 'A'.repeat(80)];
	const fileNameVectors = fileNameTitles.map((title) => ({
		title,
		extension: 'svg',
		fileName: chartFileName({ title }, 'svg')
	}));

	return {
		svgVectors,
		domSpecVectors,
		sparklineVectors,
		paintVectors,
		rasterSizeVectors,
		fileNameVectors,
		...buildMermaidAndDiagramVectors(familySpecs)
	};
}

function buildMermaidAndDiagramVectors(familySpecs: { name: string; input: unknown }[]) {
	const sankeySources = [
		`sankey-beta\nSolar,Grid,45\nWind,Grid,35\nGrid,Homes,50\nGrid,Industry,30`,
		`---\ntitle: Budget\n---\n%%{init: {"theme": "neutral"}}%%\n%% comment\nsankey\n"R&D, Core", "Cloud\nInfra" , 12.5\n"Quote ""A""",Target,8`,
		`flowchart TD\nA --> B`,
		`sankey-beta\nA,B`,
		`sankey-beta\nA,B,notanumber`,
		`sankey-beta\n"unclosed,B,10`,
		`sankey-beta\n"A"extra,B,10`,
		`sankey-beta\nA"quote,B,10`,
		`sankey-beta\n%% only comments`
	];
	const sankeyVectors = sankeySources.map((source) => ({
		source,
		result: parseSankey(source)
	}));

	const treemapSources = [
		`treemap-beta\ntitle Company Budget\naccTitle: Accessible Title\naccDescr: Accessible Description\n    "Engineering":::eng\n        "Frontend": 45\n        "Backend": 65\n    'Go-to-Market'\n        "Sales": 1,200.5:::sales\n        "Marketing", 300`,
		`treemap\naccDescr {\n  Multi-line\n  description\n}\nclassDef highlight fill:#f00\n"Single Leaf": 42 %% trailing comment`,
		`pie\n"A" : 10`,
		`treemap-beta\naccDescr {\n  unclosed`,
		`treemap-beta\nUnquoted: 10`,
		`treemap-beta\n"MissingValue":`,
		`treemap-beta\n"DotValue": .`,
		`treemap-beta\n%% empty`
	];
	const treemapVectors = treemapSources.map((source) => {
		const parsed = parseTreemap(source);
		const totals = 'data' in parsed ? parsed.data.items.map((item) => treemapValue(item)) : null;
		return { source, result: parsed, totals };
	});

	const mermaidExportCases: { name: string; spec: ReturnType<typeof createChartSpec>; options?: ChartMermaidOptions }[] = [
		...familySpecs.map((f) => ({ name: f.name, spec: createChartSpec(f.input as any) })),
		{
			name: 'xychart-horizontal-gaps-and-quotes',
			spec: createChartSpec({
				type: 'bar',
				orientation: 'horizontal',
				title: 'Quotes "here" & gaps',
				categories: ['North America', 'EMEA_1', 'APAC "East"'],
				xAxis: { title: 'Region "Name"' },
				yAxis: { title: 'ARR ($M)', min: 0, max: 200 },
				series: [
					{ id: 's1', name: 'ARR "2025"', values: [120.123456789, null, 85.5] },
					{ id: 's2', name: 'Target', type: 'line', values: [100, 90, 80] }
				]
			})
		},
		{
			name: 'xychart-no-meta-custom-indent',
			spec: createChartSpec({
				type: 'line',
				title: 'Plain Line',
				categories: ['Jan', 'Feb', 'Mar'],
				series: [{ id: 's1', name: 'Visits', values: [10, 20, 30] }]
			}),
			options: { meta: false, indent: '  ' }
		},
		{
			name: 'radar-no-legend-min-max-circle',
			spec: createChartSpec({
				type: 'radar',
				title: '123 Numeric Axis Names',
				categories: ['1st Axis', '1st Axis', ' cafés & bars '],
				series: [{ id: '1', name: 'Series "One"', values: [10, 20, 30] }],
				yAxis: { min: 0, max: 50 },
				radarGraticule: 'circle',
				legend: { show: false, position: 'bottom' }
			})
		},
		{
			name: 'sankey-colon-title-and-csv-quotes',
			spec: createChartSpec({
				type: 'sankey',
				title: 'Flow: 2025 "Report"',
				links: [
					{ source: 'Source, A', target: 'Target "B"', value: 12.5 },
					{ source: ' LeadingSpace', target: 'Normal', value: 7 }
				]
			})
		},
		{
			name: 'treemap-quotes-in-names',
			spec: createChartSpec({
				type: 'treemap',
				title: 'Treemap Quotes',
				tree: [
					{
						name: 'Group "A"',
						children: [
							{ name: `Both "double" and 'single'`, value: 25 },
							{ name: 'Plain', value: 75 }
						]
					}
				]
			})
		}
	];

	const mermaidExportVectors = mermaidExportCases.map((c) => {
		const family = chartMermaidFamily(c.spec);
		const mermaid = chartToMermaid(c.spec, c.options);
		const roundTrip = chartFromMermaid(mermaid);
		const withoutMeta = chartFromMermaid(mermaid, { ignoreMeta: true });
		return {
			name: c.name,
			spec: c.spec,
			options: c.options ?? null,
			family,
			mermaid,
			roundTrip,
			withoutMeta
		};
	});

	const mermaidParseCases: { name: string; text: string; options?: ChartMermaidParseOptions }[] = [
		{
			name: 'xychart-with-axis-ranges-and-unquoted-titles',
			text: `xychart-beta horizontal\n    title Revenue\n    x-axis Quarter [Q1, "Q2 2025", Q3]\n    y-axis USD 0 --> 100\n    bar [20, 50, 80]\n    line Growth [25, 55, 85]`
		},
		{
			name: 'xychart-numeric-xaxis-range-and-errors',
			text: `xychart\n    x-axis 0 --> 10\n    x-axis bad-rest\n    y-axis bad-y\n    bar [10, nope, 30]\n    line not-a-list\n    unknown statement`
		},
		{
			name: 'xychart-partial-streaming',
			text: `xychart-beta\n    x-axis [Jan, Feb, "Mar\n`,
			options: { partial: true }
		},
		{
			name: 'xychart-partial-series-streaming',
			text: `xychart-beta\n    x-axis [Jan, Feb, Mar]\n    bar "Sales" [10, 20, `,
			options: { partial: true }
		},
		{
			name: 'pie-inline-title-and-showdata',
			text: `pie showData title Market Share\n    "Web" : 55.5\n    "Mobile" : 34.5\n    "Desktop" : 10`
		},
		{
			name: 'radar-keyed-curves-and-settings',
			text: `radar-beta\n    title Radar Settings\n    axis speed["Speed"], rel["Reliability"], ux\n    curve c1["Team A"]{ux: 90, speed: 70, rel: 80}\n    curve c2{60, 75, 85}\n    max 100\n    min 0\n    ticks 5\n    graticule circle\n    showLegend false`
		},
		{
			name: 'radar-issues',
			text: `radar-beta\n    axis 123bad, ok["OK"]\n    curve c1{unknown_axis: 10, bad_entry}\n    ticks 0\n    graticule triangle`
		},
		{
			name: 'sankey-frontmatter-and-partial',
			text: `---\ntitle: "Energy Flow"\n---\nsankey-beta\nSolar,Grid,40\nWind,Grid`,
			options: { partial: true }
		},
		{
			name: 'treemap-wrapper-section-becomes-title',
			text: `treemap-beta\n"All Departments"\n    "Eng"\n        "Core": 60\n        "UI": 40\n    "Sales"\n        "Direct": 50`
		},
		{
			name: 'treemap-deep-becomes-sunburst',
			text: `treemap-beta\n"Org"\n    "Dept"\n        "Team"\n            "IC": 100`
		},
		{
			name: 'invalid-meta-comments',
			text: `pie\n%% @pixerate [1, 2, 3]\n"A" : 10`
		},
		{
			name: 'malformed-meta-json',
			text: `pie\n%% @pixerate {not json\n"A" : 10`
		},
		{
			name: 'unknown-header',
			text: `flowchart TD\n    A --> B`
		},
		{
			name: 'empty-source',
			text: `   \n  %% just a comment \n`
		}
	];
	const mermaidParseVectors = mermaidParseCases.map((c) => ({
		name: c.name,
		text: c.text,
		options: c.options ?? null,
		result: chartFromMermaid(c.text, c.options)
	}));

	const findMermaidInputs = [
		`Here is a report:\n\n\`\`\`mermaid\nxychart-beta\n    x-axis [Q1, Q2]\n    bar [10, 20]\n\`\`\`\n\nAnd a flowchart to ignore:\n\`\`\`mermaid\nflowchart TD\n    A --> B\n\`\`\`\n\nAnd an unlabelled sankey:\n~~~\n---\ntitle: Flows\n---\nsankey-beta\nA,B,10\n~~~`,
		`pie showData\n    "Yes" : 80\n    "No" : 20`,
		`Just prose without any charts.`
	];
	const findMermaidVectors = findMermaidInputs.map((text) => ({
		text,
		found: findMermaidCharts(text)
	}));

	return {
		sankeyVectors,
		treemapVectors,
		mermaidExportVectors,
		mermaidParseVectors,
		findMermaidVectors
	};
}

describe('Swift chart SVG and Mermaid vectors', () => {
	it('matches the recorded Swift fixture (set UPDATE_SWIFT_VECTORS=1 to regenerate)', () => {
		const vectors = buildVectors();
		const serialized = `${JSON.stringify(vectors, null, 2)}\n`;
		if (process.env.UPDATE_SWIFT_VECTORS === '1') {
			mkdirSync(dirname(fixturePath), { recursive: true });
			writeFileSync(fixturePath, serialized, 'utf8');
		}
		expect(existsSync(fixturePath)).toBe(true);
		const current = readFileSync(fixturePath, 'utf8');
		expect(JSON.parse( serialized )).toEqual(JSON.parse(current));
	});
});
