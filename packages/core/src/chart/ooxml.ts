// The DrawingML chart reader follows deckcraft-main/crates/pptx/src/read/chart.rs (group → type mapping,
// secondary-axis detection by axis id and position, cache / literal data, number-format precedence) and the
// chartex reader gridcraft-main/crates/xlsx/src/chartex.rs; the "editable only when it regenerates" idea is
// from wordcraft-main/crates/docx/src/chart_spec.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors).
// See THIRD_PARTY_NOTICES.md.
import { parseChartColor, chartRgbToHex } from './color.js';
import { chartFamily, chartSeriesType, chartVariesColors, defaultChartAxis, isCartesianChart, normalizeChartSpec } from './spec.js';
import { chartTreeFromRows } from './tree.js';
import type { ChartAxis, ChartErrorBars, ChartErrorBarType, ChartIssue, ChartLegendPosition, ChartMarker, ChartNumberFormat, ChartSeries, ChartSpec, ChartTrendline, ChartTrendlineType, ChartType, ChartValue } from './types.js';

export const CHART_OOXML_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
export const CHART_OOXML_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
export const CHART_OOXML_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';

type ParserCtor = { new (): DOMParser };

export interface ChartOoxmlReadOptions {
	/** `DOMParser` constructor (default: the global one; pass jsdom's or xmldom's in Node). */
	DOMParser?: ParserCtor;
}

export interface ChartOoxmlReadResult {
	spec: ChartSpec;
	/** Problems and simplifications, as sentences. */
	issues: ChartIssue[];
	/** Features the file uses that the spec cannot hold (3-D, stock, surface, gradients, …). */
	unsupported: string[];
	/**
	 * Nothing was dropped: writing `spec` back gives an equivalent chart. When false, keep the
	 * original part (or show the chart read-only) if the file must stay as it was.
	 */
	lossless: boolean;
}

const MAX_POINTS = 100_000;

function parser(options: ChartOoxmlReadOptions): ParserCtor {
	const P = options.DOMParser ?? (globalThis as { DOMParser?: ParserCtor }).DOMParser;
	if (!P) throw new Error('Reading chart XML needs a DOMParser. In Node, pass one (e.g. from jsdom or @xmldom/xmldom) as { DOMParser }.');
	return P;
}

const kids = (el: Element | null | undefined, name?: string): Element[] => (el ? Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1 && (!name || (n as Element).localName === name)) : []);
const kid = (el: Element | null | undefined, name: string) => kids(el, name)[0];
const val = (el: Element | null | undefined, name: string) => kid(el, name)?.getAttribute('val') ?? undefined;
const path = (el: Element | null | undefined, ...names: string[]) => names.reduce<Element | undefined>((e, n) => kid(e, n), el ?? undefined);
const find = (el: Element | null | undefined, name: string): Element | undefined => {
	if (!el) return undefined;
	for (const c of kids(el)) {
		if (c.localName === name) return c;
		const deep = find(c, name);
		if (deep) return deep;
	}
	return undefined;
};
const bool = (v: string | undefined, fallback = false) => (v === undefined ? fallback : v === '1' || v === 'true');
const numberOf = (v: string | undefined) => {
	if (v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

function strings(e: Element | undefined): string[] {
	if (!e) return [];
	const cache = find(e, 'strCache') ?? find(e, 'numCache') ?? find(e, 'strLit') ?? find(e, 'numLit');
	if (cache) {
		const n = Math.min(MAX_POINTS, Number(val(cache, 'ptCount') ?? 0) || 0);
		const out: string[] = Array(n).fill('');
		for (const pt of kids(cache, 'pt').slice(0, MAX_POINTS)) {
			const i = Number(pt.getAttribute('idx') ?? 0);
			if (!Number.isInteger(i) || i < 0 || i >= MAX_POINTS) continue;
			while (out.length <= i) out.push('');
			out[i] = kid(pt, 'v')?.textContent ?? '';
		}
		return out;
	}
	const multi = find(e, 'multiLvlStrCache');
	if (multi) {
		const lvl = kid(multi, 'lvl');
		return kids(lvl, 'pt').map((p) => kid(p, 'v')?.textContent ?? '');
	}
	const v = kid(e, 'v') ?? find(e, 'v');
	return v ? [v.textContent ?? ''] : [];
}

const numbers = (e: Element | undefined): ChartValue[] => strings(e).map((s) => (s.trim() === '' ? null : numberOf(s.trim())));

function formatCodeOf(e: Element | undefined): string | undefined {
	return find(e, 'numCache') ? (kid(find(e, 'numCache'), 'formatCode')?.textContent ?? undefined) : undefined;
}

function richText(t: Element | undefined): string | undefined {
	if (!t) return undefined;
	const tx = kid(t, 'tx');
	const rich = kid(tx, 'rich');
	if (rich) return kids(rich, 'p').map((p) => Array.from(p.getElementsByTagNameNS('*', 't')).map((x) => x.textContent ?? '').join('')).join('\n');
	const v = find(tx, 'v');
	return v?.textContent ?? undefined;
}

function solidColor(spPr: Element | undefined): string | undefined {
	const fill = kid(spPr, 'solidFill') ?? kid(kid(spPr, 'ln'), 'solidFill');
	const srgb = kid(fill, 'srgbClr');
	const v = srgb?.getAttribute('val');
	return v && /^[0-9a-f]{6}$/i.test(v) ? `#${v.toLowerCase()}` : undefined;
}

const MARKERS: Record<string, ChartMarker> = { circle: 'circle', dot: 'circle', square: 'square', diamond: 'diamond', triangle: 'triangle', x: 'cross', plus: 'cross', star: 'cross', dash: 'square', none: 'none' };
const TREND_IN: Record<string, ChartTrendlineType> = { linear: 'linear', exp: 'exponential', log: 'logarithmic', poly: 'polynomial', power: 'power', movingAvg: 'moving-average' };
const TREND_OUT: Record<ChartTrendlineType, string> = { linear: 'linear', exponential: 'exp', logarithmic: 'log', polynomial: 'poly', power: 'power', 'moving-average': 'movingAvg' };
const LEGEND_IN: Record<string, ChartLegendPosition> = { b: 'bottom', t: 'top', l: 'left', r: 'right', tr: 'right' };
const ERR_IN: Record<string, ChartErrorBarType> = { fixedVal: 'fixed', percentage: 'percent', stdDev: 'stddev', stdErr: 'stderr', cust: 'custom' };
const ERR_OUT: Record<ChartErrorBarType, string> = { fixed: 'fixedVal', percent: 'percentage', stddev: 'stdDev', stderr: 'stdErr', custom: 'cust' };

/** Reads one `c:errBars` (Excel's error amount types map one to one); `null` for an unknown type. */
function readErrorBars(e: Element): ChartErrorBars | null {
	const type = ERR_IN[val(e, 'errValType') ?? 'fixedVal'];
	if (!type) return null;
	const bars: ChartErrorBars = { type };
	const value = numberOf(val(e, 'val'));
	if (value !== null && type !== 'custom' && type !== 'stderr') bars.value = Math.abs(value);
	if (type === 'custom') {
		const plus = kid(e, 'plus');
		const minus = kid(e, 'minus');
		const p = plus ? numbers(plus).map((v) => (v === null ? null : Math.abs(v))) : [];
		const m = minus ? numbers(minus).map((v) => (v === null ? null : Math.abs(v))) : [];
		// Minus amounts default to the plus ones; an empty side is left out.
		if (p.some((v) => v !== null)) bars.plus = p;
		if (m.some((v) => v !== null) && JSON.stringify(m) !== JSON.stringify(p)) bars.minus = m;
	}
	const direction = val(e, 'errBarType');
	if (direction === 'plus' || direction === 'minus') bars.direction = direction;
	if (bool(val(e, 'noEndCap'))) bars.cap = false;
	return bars;
}

/**
 * Reads a DrawingML chart part (`c:chartSpace`, e.g. `word/charts/chart1.xml`) or an Office
 * 2016 chartex part (`cx:chartSpace`: waterfall, funnel, treemap, histogram, box & whisker)
 * as a chart spec. Data comes from the cached values. Never throws for a malformed chart: it
 * returns an empty chart and says why.
 */
export function chartFromOoxml(xml: string, options: ChartOoxmlReadOptions = {}): ChartOoxmlReadResult {
	const issues: ChartIssue[] = [];
	const unsupported: string[] = [];
	let doc: Document;
	try {
		doc = new (parser(options))().parseFromString(xml, 'application/xml');
	} catch (error) {
		return { spec: normalizeChartSpec({}).spec, issues: [{ path: '', message: `The chart XML could not be read: ${(error as Error).message}` }], unsupported, lossless: false };
	}
	const root = doc.documentElement;
	if (!root || root.localName !== 'chartSpace' || doc.getElementsByTagName('parsererror').length) {
		return { spec: normalizeChartSpec({}).spec, issues: [{ path: '', message: 'This is not a chart part: expected a c:chartSpace (or cx:chartSpace) root element.' }], unsupported, lossless: false };
	}
	if (root.namespaceURI?.includes('chartex') || kid(root, 'chartData')) return readChartex(root, issues, unsupported);

	const chart = kid(root, 'chart');
	const plot = kid(chart, 'plotArea');
	const input: Record<string, unknown> = { type: 'bar' };
	const titleEl = kid(chart, 'title');
	if (titleEl && !bool(val(chart, 'autoTitleDeleted'))) input.title = richText(titleEl) ?? '';
	const legend = kid(chart, 'legend');
	input.legend = { show: !!legend, position: LEGEND_IN[val(legend, 'legendPos') ?? 'r'] ?? 'right' };
	if (kid(root, 'roundedCorners') && bool(val(root, 'roundedCorners'))) unsupported.push('rounded corners');

	const valAxes = kids(plot, 'valAx');
	const vertical = (a: Element) => ['l', 'r'].includes(val(a, 'axPos') ?? '');
	const secondaryPlaced = (a: Element) => val(a, 'crosses') === 'max' || ['r', 't'].includes(val(a, 'axPos') ?? '');
	const groupValAxis = (g: Element) => {
		const ids = kids(g, 'axId').map((a) => a.getAttribute('val'));
		const axes = ids.map((id) => valAxes.find((a) => val(a, 'axId') === id)).filter((a): a is Element => !!a);
		return axes.find(vertical) ?? axes[0];
	};
	const groups = kids(plot).filter((g) => g.localName.endsWith('Chart'));
	const used = groups.map(groupValAxis).filter((a): a is Element => !!a);
	const primaryAxis = used.find((a) => !secondaryPlaced(a)) ?? used[0];

	const series: ChartSeries[] = [];
	let categories: string[] = [];
	const types: ChartType[] = [];
	let stacking: ChartSpec['stacking'] = 'none';
	let orientation: ChartSpec['orientation'] = 'vertical';
	let dataLabels = false;
	let points = false;
	for (const g of groups) {
		const name = g.localName;
		const grouping = val(g, 'grouping') ?? 'clustered';
		let type: ChartType;
		if (/3D/.test(name)) unsupported.push(`3-D ${name.replace(/3DChart$/, '')} chart (drawn flat)`);
		switch (name) {
			case 'barChart':
			case 'bar3DChart':
				type = 'bar';
				if (val(g, 'barDir') === 'bar') orientation = 'horizontal';
				break;
			case 'lineChart':
			case 'line3DChart':
				type = 'line';
				// Points are on when a series shows a marker (the group's marker flag is usually set).
				if (kids(g, 'ser').some((s) => (val(kid(s, 'marker'), 'symbol') ?? (bool(val(g, 'marker'), true) ? 'auto' : 'none')) !== 'none')) points = true;
				break;
			case 'areaChart':
			case 'area3DChart':
				type = 'area';
				break;
			case 'pieChart':
			case 'pie3DChart':
			case 'ofPieChart':
				type = 'pie';
				if (name === 'ofPieChart') unsupported.push('pie-of-pie (drawn as one pie)');
				break;
			case 'doughnutChart':
				type = 'donut';
				input.innerRadius = Math.min(0.9, Math.max(0, (numberOf(val(g, 'holeSize')) ?? 50) / 100));
				break;
			case 'scatterChart':
				type = 'scatter';
				if (/line/i.test(val(g, 'scatterStyle') ?? '')) points = true;
				break;
			case 'bubbleChart':
				type = 'bubble';
				break;
			case 'radarChart':
				type = 'radar';
				break;
			default:
				unsupported.push(`${name.replace(/Chart$/, '')} chart`);
				continue;
		}
		if (grouping === 'stacked') stacking = 'stacked';
		else if (grouping === 'percentStacked') stacking = 'percent';
		const gap = numberOf(val(g, 'gapWidth'));
		const overlap = numberOf(val(g, 'overlap'));
		if (type === 'bar') {
			// gapWidth is the gap between groups as a % of one bar; ours is a fraction of the category.
			const n = Math.max(1, kids(g, 'ser').length);
			const g100 = (gap ?? 150) / 100;
			const o = Math.max(-1, Math.min(1, (overlap ?? (grouping === 'clustered' ? 0 : 100)) / 100));
			const barsWidth = grouping === 'clustered' ? n - (n - 1) * o : 1;
			input.gapWidth = Math.round(Math.max(0, Math.min(0.9, g100 / (barsWidth + g100))) * 100) / 100;
			if (grouping === 'clustered') input.overlap = o;
		}
		if (bool(val(kid(g, 'dLbls'), 'showVal'))) dataLabels = true;
		types.push(type);
		const axis = groupValAxis(g);
		const secondary = !!axis && !!primaryAxis && axis !== primaryAxis;
		for (const s of kids(g, 'ser').slice(0, 1000)) {
			const out: ChartSeries = { id: `series-${series.length + 1}`, name: strings(kid(s, 'tx'))[0] ?? `Series ${series.length + 1}`, values: [] };
			const color = solidColor(kid(s, 'spPr'));
			if (color) out.color = color;
			out.type = type === 'bubble' ? undefined : (type as ChartSeries['type']);
			if (secondary) out.axis = 'secondary';
			const marker = val(kid(s, 'marker'), 'symbol');
			// Circles (and none on a line chart without points) are the defaults; other shapes are kept.
			if (marker && MARKERS[marker] && MARKERS[marker] !== 'circle' && (type === 'scatter' || MARKERS[marker] !== 'none') && (type === 'line' || type === 'scatter')) out.marker = MARKERS[marker];
			if (bool(val(s, 'smooth'))) out.curve = 'smooth';
			const sl = kid(s, 'dLbls');
			if (sl && val(sl, 'showVal') !== undefined) out.dataLabels = bool(val(sl, 'showVal'));
			const labelCode = [kid(sl, 'numFmt'), kid(kid(g, 'dLbls'), 'numFmt')].find((n) => n && n.getAttribute('sourceLinked') !== '1')?.getAttribute('formatCode');
			const valueEl = kid(s, 'val') ?? kid(s, 'yVal');
			const code = labelCode ?? formatCodeOf(valueEl);
			if (code && code !== 'General') out.format = { code };
			const catEl = kid(s, 'cat') ?? kid(s, 'xVal');
			const cats = strings(catEl);
			if (type === 'scatter' || type === 'bubble') {
				const xs = cats.map((c) => numberOf(c.trim()));
				if (xs.some((x) => x !== null)) out.x = xs;
			}
			if (!categories.length && cats.length) categories = cats;
			out.values = numbers(valueEl);
			if (type === 'bubble') out.sizes = numbers(kid(s, 'bubbleSize'));
			const dPts = kids(s, 'dPt');
			if (dPts.length) {
				const pc: (string | null)[] = [];
				for (const dp of dPts) {
					const i = Number(val(dp, 'idx'));
					const c = solidColor(kid(dp, 'spPr'));
					if (Number.isInteger(i) && i >= 0 && i < MAX_POINTS && c) {
						while (pc.length <= i) pc.push(null);
						pc[i] = c;
					}
				}
				if (pc.some(Boolean)) out.pointColors = pc;
			}
			const trends: ChartTrendline[] = [];
			for (const t of kids(s, 'trendline')) {
				const kind = TREND_IN[val(t, 'trendlineType') ?? ''];
				if (!kind) continue;
				const line: ChartTrendline = { type: kind };
				const order = numberOf(val(t, 'order'));
				const period = numberOf(val(t, 'period'));
				if (kind === 'polynomial' && order) line.order = order;
				if (kind === 'moving-average' && period) line.period = period;
				for (const k of ['forward', 'backward', 'intercept'] as const) {
					const n = numberOf(val(t, k));
					if (n !== null && (k === 'intercept' || n > 0)) line[k] = n;
				}
				if (bool(val(t, 'dispEq'))) line.showEquation = true;
				if (bool(val(t, 'dispRSqr'))) line.showR2 = true;
				const tName = kid(t, 'name')?.textContent;
				if (tName) line.name = tName;
				const tc = solidColor(kid(t, 'spPr'));
				if (tc) line.color = tc;
				trends.push(line);
			}
			if (trends.length) out.trendlines = trends;
			for (const e of kids(s, 'errBars')) {
				const bars = readErrorBars(e);
				if (!bars) {
					unsupported.push(`error bars of type "${val(e, 'errValType')}"`);
					continue;
				}
				// x error bars only exist on scatter and bubble series.
				if (val(e, 'errDir') === 'x') {
					if (type === 'scatter' || type === 'bubble') out.xErrorBars = bars;
					else unsupported.push('x error bars on a category chart');
				} else if (type === 'pie' || type === 'donut' || type === 'radar') unsupported.push(`error bars on a ${type} chart`);
				else out.errorBars = bars;
			}
			series.push(out);
		}
	}
	if (!types.length) {
		issues.push({ path: 'plotArea', message: unsupported.length ? `The chart type is not supported: ${unsupported.join(', ')}.` : 'The chart has no plot groups.' });
		return { spec: normalizeChartSpec(input).spec, issues, unsupported, lossless: false };
	}
	const first = types[0];
	const combo = types.some((t) => t !== first);
	input.type = combo ? (types.includes('bar') ? 'bar' : first) : first;
	if (!combo) for (const s of series) delete s.type;
	else for (const s of series) if (s.type === input.type) delete s.type;
	if (!combo) for (const s of series) if (s.axis) issues.push({ path: 'series', message: `"${s.name}" is on a second value axis.` });
	if (types.some((t) => !isCartesianChart(t)) && combo) unsupported.push('a pie or radar mixed with other chart types');
	input.series = series;
	input.categories = categories.length ? categories : Array.from({ length: Math.max(0, ...series.map((s) => s.values.length)) }, (_, i) => `${i + 1}`);
	input.stacking = stacking;
	input.orientation = orientation;
	input.dataLabels = dataLabels;
	input.points = points || first !== 'line';
	if (bool(val(groups[0], 'varyColors')) && !combo && isCartesianChart(first) && series.length === 1) input.varyColors = true;

	// Axes
	const readAxis = (a: Element | undefined, fallback: ChartAxis): ChartAxis => {
		const axis: ChartAxis = { ...fallback, format: {} };
		if (!a) return axis;
		axis.show = !bool(val(a, 'delete'));
		axis.title = richText(kid(a, 'title')) ?? '';
		axis.gridlines = !!kid(a, 'majorGridlines');
		const scaling = kid(a, 'scaling');
		axis.min = numberOf(val(scaling, 'min'));
		axis.max = numberOf(val(scaling, 'max'));
		if (val(scaling, 'orientation') === 'maxMin') axis.reverse = true;
		if (kid(scaling, 'logBase')) {
			if (a.localName !== 'valAx') unsupported.push('a logarithmic category axis');
			else {
				axis.scale = 'log';
				const base = numberOf(val(scaling, 'logBase')) ?? 10;
				if (base !== 10) axis.logBase = base;
			}
		}
		axis.step = numberOf(val(a, 'majorUnit'));
		const fmt = kid(a, 'numFmt');
		const code = fmt?.getAttribute('formatCode');
		if (code && code !== 'General' && fmt?.getAttribute('sourceLinked') !== '1') axis.format = { code };
		return axis;
	};
	const xy = first === 'scatter' || first === 'bubble';
	const catAxis = kid(plot, 'catAx') ?? kid(plot, 'dateAx') ?? (xy ? valAxes.find((a) => !vertical(a)) : undefined);
	input.xAxis = readAxis(catAxis, defaultChartAxis(false));
	if (kid(plot, 'dateAx')) (input.xAxis as ChartAxis).kind = 'date';
	input.yAxis = readAxis(primaryAxis ?? valAxes.find(vertical) ?? valAxes[0], defaultChartAxis(true));
	const secondaryAxis = valAxes.find((a) => a !== primaryAxis && (xy ? vertical(a) && a !== primaryAxis : true) && a !== catAxis);
	if (series.some((s) => s.axis === 'secondary') && secondaryAxis) input.yAxis2 = readAxis(secondaryAxis, defaultChartAxis(false));
	const { spec, issues: specIssues } = normalizeChartSpec(input);
	issues.push(...specIssues);
	const uniq = [...new Set(unsupported)];
	return { spec, issues, unsupported: uniq, lossless: uniq.length === 0 && specIssues.length === 0 };
}

function readChartex(root: Element, issues: ChartIssue[], unsupported: string[]): ChartOoxmlReadResult {
	const data = new Map<string, { categories: string[]; values: ChartValue[]; code?: string; paths?: string[][] }>();
	for (const d of kids(kid(root, 'chartData'), 'data')) {
		const id = d.getAttribute('id') ?? String(data.size);
		const strDim = kids(d, 'strDim')[0];
		const numDim = kids(d, 'numDim')[0];
		const lvl = (dim: Element | undefined) => kids(dim, 'lvl')[0];
		const cats = kids(lvl(strDim), 'pt').map((p) => p.textContent ?? '');
		// Hierarchical categories (treemap and sunburst) list their levels leaf first, root last; a
		// parent level names a group at the first point it covers and is blank until the next.
		const levels = kids(strDim, 'lvl').map((l) => {
			const out: string[] = [];
			for (const p of kids(l, 'pt')) out[Number(p.getAttribute('idx') ?? out.length)] = (p.textContent ?? '').trim();
			return out;
		});
		let paths: string[][] | undefined;
		if (levels.length > 1) {
			const carried: string[] = [];
			paths = levels[0].map((_, i) => {
				const path: string[] = [];
				for (let k = levels.length - 1; k >= 1; k--) {
					const name = levels[k][i];
					if (name) {
						carried[k] = name;
						carried.length = Math.max(carried.length, k + 1);
						// A new group resets the groups inside it.
						for (let j = 1; j < k; j++) carried[j] = '';
					}
					if (carried[k]) path.push(carried[k]);
				}
				if (levels[0][i]) path.push(levels[0][i]);
				return path;
			});
		}
		const values: ChartValue[] = [];
		const nl = lvl(numDim);
		for (const p of kids(nl, 'pt')) {
			const i = Number(p.getAttribute('idx') ?? values.length);
			while (values.length < i) values.push(null);
			values[i] = numberOf((p.textContent ?? '').trim());
		}
		data.set(id, { categories: cats, values, code: nl?.getAttribute('formatCode') ?? undefined, paths });
	}
	const chart = kid(root, 'chart');
	const region = path(chart, 'plotArea', 'plotAreaRegion');
	const seriesEls = kids(region, 'series');
	const layouts: Record<string, ChartType> = { waterfall: 'waterfall', funnel: 'funnel', treemap: 'treemap', sunburst: 'sunburst', boxWhisker: 'box', clusteredColumn: 'histogram', paretoLine: 'histogram' };
	const layout = seriesEls[0]?.getAttribute('layoutId') ?? '';
	const type = layouts[layout];
	if (!type) {
		issues.push({ path: 'plotArea', message: `The chart layout "${layout || 'unknown'}" is not supported.` });
		return { spec: normalizeChartSpec({}).spec, issues, unsupported: [layout || 'unknown chartex layout'], lossless: false };
	}
	if (layout === 'paretoLine') unsupported.push('pareto line');
	const series: ChartSeries[] = [];
	let categories: string[] = [];
	for (const s of seriesEls) {
		if (s.getAttribute('layoutId') === 'paretoLine') continue;
		const ref = kid(s, 'dataId')?.getAttribute('val') ?? '0';
		const d = data.get(ref);
		if (!d) continue;
		if (!categories.length) categories = d.categories;
		const out: ChartSeries = { id: `series-${series.length + 1}`, name: strings(kid(s, 'tx'))[0] ?? `Series ${series.length + 1}`, values: d.values };
		if (d.code && d.code !== 'General') out.format = { code: d.code };
		series.push(out);
	}
	const title = richText(kid(chart, 'title'));
	const longest = Math.max(0, ...series.map((s) => s.values.length));
	const input: Record<string, unknown> = {
		type,
		title: title ?? '',
		series,
		categories: categories.length >= longest ? categories : Array.from({ length: longest }, (_, i) => categories[i] ?? `${i + 1}`)
	};
	if (type === 'waterfall') input.showTotal = false;
	const first = data.get(kid(seriesEls[0], 'dataId')?.getAttribute('val') ?? '0');
	if ((type === 'treemap' || type === 'sunburst') && first?.paths) {
		const treeIssues: ChartIssue[] = [];
		input.tree = chartTreeFromRows(first.paths.map((path, i) => ({ path, value: first.values[i] ?? 0 })), treeIssues);
		for (const t of treeIssues) issues.push({ path: 'chartData', message: t.message });
	}
	const { spec, issues: specIssues } = normalizeChartSpec(input);
	issues.push(...specIssues);
	return { spec, issues, unsupported, lossless: unsupported.length === 0 && specIssues.length === 0 };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex = (color: string | undefined) => {
	if (!color) return null;
	const rgb = parseChartColor(color);
	return rgb ? chartRgbToHex(rgb).slice(1).toUpperCase() : null;
};
const fillXml = (color: string | undefined, line = false) => {
	const h = hex(color);
	if (!h) return '';
	return line ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${h}"/></a:solidFill><a:round/></a:ln></c:spPr>` : `<c:spPr><a:solidFill><a:srgbClr val="${h}"/></a:solidFill></c:spPr>`;
};
const rich = (text: string) => `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/>`;
const strLit = (items: readonly string[]) => `<c:strLit><c:ptCount val="${items.length}"/>${items.map((s, i) => `<c:pt idx="${i}"><c:v>${esc(s)}</c:v></c:pt>`).join('')}</c:strLit>`;
const numLit = (items: readonly ChartValue[], code = 'General') =>
	`<c:numLit><c:formatCode>${esc(code)}</c:formatCode><c:ptCount val="${items.length}"/>${items.map((v, i) => (v === null || !Number.isFinite(v) ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numLit>`;

const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', INR: '₹' };

/** A spreadsheet format code equivalent to a chart number format (`General` when there is none). */
export function chartFormatToCode(format: ChartNumberFormat): string {
	if (format.code) return format.code;
	const d = format.decimals;
	const frac = (n: number | undefined, fallback: number) => {
		const k = n ?? fallback;
		return k > 0 ? `.${'0'.repeat(k)}` : '';
	};
	const wrap = (body: string) => `${format.prefix ? `"${format.prefix.replace(/"/g, '')}"` : ''}${body}${format.suffix ? `"${format.suffix.replace(/"/g, '')}"` : ''}`;
	switch (format.style) {
		case 'percent':
			return wrap(`#,##0${frac(d, 0)}%`);
		case 'currency': {
			const code = (format.currency || 'USD').toUpperCase();
			const sym = CURRENCY_SYMBOL[code] ?? `${code} `;
			return wrap(`"${sym}"#,##0${frac(d, 0)}`);
		}
		case 'compact':
			return wrap('#,##0.0,,"M"');
		default:
			return d !== undefined || format.prefix || format.suffix ? wrap(`#,##0${frac(d, 0)}`) : 'General';
	}
}

/** One `c:errBars` (CT_ErrBars order: errDir, errBarType, errValType, noEndCap, plus, minus, val). */
function errBarsXml(bars: ChartErrorBars, dir: 'x' | 'y' | null): string {
	let x = `<c:errBars>${dir ? `<c:errDir val="${dir}"/>` : ''}<c:errBarType val="${bars.direction ?? 'both'}"/><c:errValType val="${ERR_OUT[bars.type]}"/><c:noEndCap val="${bars.cap === false ? 1 : 0}"/>`;
	if (bars.type === 'custom') {
		const plus = bars.plus ?? (bars.minus ?? []).map(() => null);
		x += `<c:plus>${numLit(plus)}</c:plus><c:minus>${numLit(bars.minus ?? plus)}</c:minus>`;
	} else if (bars.type !== 'stderr') x += `<c:val val="${bars.value ?? (bars.type === 'percent' ? 5 : 1)}"/>`;
	return `${x}</c:errBars>`;
}

const MARKER_OUT: Record<ChartMarker, string> = { circle: 'circle', square: 'square', diamond: 'diamond', triangle: 'triangle', cross: 'x', none: 'none' };

export interface ChartOoxmlWriteResult {
	/** The `c:chartSpace` part. */
	xml: string;
	/** What could not be written as DrawingML, as sentences (empty when nothing was lost). */
	issues: string[];
}

/**
 * Writes a chart as a DrawingML chart part (`c:chartSpace`) with the data as literals (no
 * embedded workbook), for `word/charts/chartN.xml` or `ppt/charts/chartN.xml`. Waterfall,
 * histogram, box, funnel and treemap charts need Office 2016 chartex parts; they are written
 * as the closest classic chart and reported in `issues`.
 */
export function chartToOoxml(spec: ChartSpec): ChartOoxmlWriteResult {
	const issues: string[] = [];
	const family = chartFamily(spec);
	let type = spec.type;
	if (family === 'waterfall' || family === 'histogram' || family === 'box' || family === 'funnel') {
		issues.push(`${spec.type} charts are written as bar charts: DrawingML has no ${spec.type} type (Office 2016 stores it as chartex).`);
		type = 'bar';
	} else if (family === 'treemap') {
		issues.push(`Treemaps are written as pie charts${spec.tree.length ? ' of the top-level group totals' : ''}: DrawingML has no treemap type.`);
		type = 'pie';
	} else if (family === 'sunburst') {
		issues.push(`Sunburst charts are written as doughnut charts of the ${spec.tree.length ? 'top-level group totals' : 'values'}: DrawingML has no sunburst type (Office 2016 stores it as chartex).`);
		type = 'donut';
	} else if (family === 'sankey') {
		issues.push('Sankey diagrams are written as bar charts of how much passes through each node: DrawingML has no flows.');
		type = 'bar';
	} else if (family === 'parliament') {
		issues.push('Parliament charts are written as doughnut charts of the seats: DrawingML has no parliament type.');
		type = 'donut';
	} else if (family === 'slope') {
		issues.push('Slope charts are written as line charts with the two series as lines over the categories: DrawingML has no slope type.');
		type = 'line';
	} else if (family === 'likert') {
		issues.push('Likert charts are written as 100% stacked horizontal bars: DrawingML has no diverging bar.');
		spec = { ...spec, type: 'bar', stacking: 'percent', orientation: 'horizontal' };
		type = 'bar';
	}
	const visible = spec.series.filter((s) => !s.hidden);
	const annotations = [
		spec.referenceLines.length || spec.referenceBands.length ? 'reference lines and bands' : '',
		spec.series.some((s) => s.callouts) ? 'callouts' : '',
		spec.highlight.length ? 'the highlight' : '',
		spec.note ? 'the note' : ''
	].filter(Boolean);
	if (annotations.length) issues.push(`${annotations.join(', ').replace(/^./, (c) => c.toUpperCase())} ${annotations.length === 1 && !annotations[0].endsWith('s') ? 'is' : 'are'} not written: DrawingML has no equivalent.`);
	if (visible.length < spec.series.length) issues.push(`${spec.series.length - visible.length} hidden series ${spec.series.length - visible.length === 1 ? 'is' : 'are'} left out.`);
	const grouping = spec.stacking === 'stacked' ? 'stacked' : spec.stacking === 'percent' ? 'percentStacked' : 'standard';
	const ids = { cat: 500000001, val: 500000002, cat2: 500000003, val2: 500000004 };
	const xy = family === 'xy' || type === 'scatter' || type === 'bubble';
	const pieLike = type === 'pie' || type === 'donut';
	const typed = (s: ChartSeries) => (pieLike || type === 'radar' ? type : type === 'bubble' ? 'bubble' : xy ? 'scatter' : chartSeriesType({ type }, s));
	// Groups: (kind, axis) in first-appearance order.
	const groups: { kind: string; secondary: boolean; series: { s: ChartSeries; index: number }[] }[] = [];
	visible.forEach((s) => {
		const kind = typed(s);
		const secondary = !pieLike && s.axis === 'secondary';
		let g = groups.find((x) => x.kind === kind && x.secondary === secondary);
		if (!g) groups.push((g = { kind, secondary, series: [] }));
		g.series.push({ s, index: spec.series.indexOf(s) });
	});
	if (pieLike && visible.length > 1) issues.push('Only the first series of a pie is drawn; the others are kept in the part.');
	const catLit = strLit(spec.categories);
	let order = 0;
	const serXml = (kind: string, s: ChartSeries, index: number) => {
		const parts = [`<c:idx val="${index}"/>`, `<c:order val="${order++}"/>`, `<c:tx><c:v>${esc(s.name)}</c:v></c:tx>`];
		const lineLike = kind === 'line' || kind === 'scatter' || kind === 'radar';
		parts.push(fillXml(s.color, lineLike));
		if (kind === 'bar' || kind === 'bubble') parts.push('<c:invertIfNegative val="0"/>');
		if (lineLike) {
			const marker = s.marker ?? (spec.points || kind === 'scatter' ? 'circle' : 'none');
			parts.push(`<c:marker><c:symbol val="${MARKER_OUT[marker]}"/>${marker !== 'none' ? '<c:size val="5"/>' : ''}</c:marker>`);
		}
		(s.pointColors ?? []).forEach((c, i) => {
			const h = hex(c ?? undefined);
			if (h) parts.push(`<c:dPt><c:idx val="${i}"/>${kind === 'bar' ? '<c:invertIfNegative val="0"/>' : ''}<c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${h}"/></a:solidFill></c:spPr></c:dPt>`);
		});
		const labels = s.dataLabels ?? spec.dataLabels;
		const code = s.format ? chartFormatToCode(s.format) : undefined;
		if (s.dataLabels !== undefined || code)
			parts.push(`<c:dLbls>${code ? `<c:numFmt formatCode="${esc(code)}" sourceLinked="0"/>` : ''}<c:showLegendKey val="0"/><c:showVal val="${labels ? 1 : 0}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`);
		if (!pieLike && kind !== 'radar')
			for (const t of s.trendlines ?? []) {
				let x = `<c:trendline>${t.name ? `<c:name>${esc(t.name)}</c:name>` : ''}${fillXml(t.color, true)}<c:trendlineType val="${TREND_OUT[t.type]}"/>`;
				if (t.type === 'polynomial') x += `<c:order val="${t.order ?? 2}"/>`;
				if (t.type === 'moving-average') x += `<c:period val="${t.period ?? 2}"/>`;
				if (t.forward) x += `<c:forward val="${t.forward}"/>`;
				if (t.backward) x += `<c:backward val="${t.backward}"/>`;
				if (t.intercept !== undefined && t.intercept !== null) x += `<c:intercept val="${t.intercept}"/>`;
				x += `<c:dispRSqr val="${t.showR2 ? 1 : 0}"/><c:dispEq val="${t.showEquation ? 1 : 0}"/></c:trendline>`;
				parts.push(x);
			}
		if (!pieLike && kind !== 'radar') {
			const xyKind = kind === 'scatter' || kind === 'bubble';
			if (s.errorBars) parts.push(errBarsXml(s.errorBars, xyKind ? 'y' : null));
			if (s.xErrorBars) {
				if (xyKind) parts.push(errBarsXml(s.xErrorBars, 'x'));
				else issues.push(`"${s.name}" has x error bars, which only scatter and bubble charts can hold; they are left out.`);
			}
		} else if (s.errorBars || s.xErrorBars) issues.push(`Error bars on "${s.name}" are left out: ${kind} charts cannot show them.`);
		const valCode = chartFormatToCode(s.format ?? (s.axis === 'secondary' ? spec.yAxis2.format : spec.yAxis.format));
		if (kind === 'scatter' || kind === 'bubble') {
			const xs = s.x ?? spec.categories.map((_, i) => i + 1);
			parts.push(`<c:xVal>${numLit(xs)}</c:xVal><c:yVal>${numLit(s.values, valCode)}</c:yVal>`);
			if (kind === 'bubble') parts.push(`<c:bubbleSize>${numLit(s.sizes ?? s.values.map(() => 1))}</c:bubbleSize><c:bubble3D val="0"/>`);
			else parts.push(`<c:smooth val="${(s.curve ?? spec.curve) === 'smooth' ? 1 : 0}"/>`);
		} else {
			parts.push(`<c:cat>${catLit}</c:cat><c:val>${numLit(s.values, valCode)}</c:val>`);
			if (kind === 'line') parts.push(`<c:smooth val="${(s.curve ?? spec.curve) === 'smooth' ? 1 : 0}"/>`);
		}
		if ((s.curve ?? spec.curve) === 'step' && lineLike) issues.push(`"${s.name}" uses step lines, which DrawingML cannot express; they are written straight.`);
		if ((s.curve ?? spec.curve) === 'smooth' && kind === 'area') issues.push(`"${s.name}" is a smoothed area, which DrawingML cannot express; it is written straight.`);
		return `<c:ser>${parts.join('')}</c:ser>`;
	};
	const dLbls = `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="${spec.dataLabels ? 1 : 0}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`;
	const vary = chartVariesColors(spec) ? 1 : 0;
	const groupXml = groups.map((g) => {
		const axes = g.secondary ? `<c:axId val="${ids.cat2}"/><c:axId val="${ids.val2}"/>` : `<c:axId val="${ids.cat}"/><c:axId val="${ids.val}"/>`;
		const sers = g.series.map(({ s, index }) => serXml(g.kind, s, index)).join('');
		switch (g.kind) {
			case 'bar': {
				const n = g.series.length;
				const barsWidth = spec.stacking === 'none' ? n - (n - 1) * spec.overlap : 1;
				const gapPct = Math.round(Math.min(500, (spec.gapWidth / Math.max(0.01, 1 - spec.gapWidth)) * barsWidth * 100));
				const overlapPct = spec.stacking === 'none' ? Math.round(spec.overlap * 100) : 100;
				return `<c:barChart><c:barDir val="${spec.orientation === 'horizontal' ? 'bar' : 'col'}"/><c:grouping val="${spec.stacking === 'none' ? 'clustered' : grouping}"/><c:varyColors val="${vary}"/>${sers}${dLbls}<c:gapWidth val="${gapPct}"/><c:overlap val="${overlapPct}"/>${axes}</c:barChart>`;
			}
			case 'line':
				return `<c:lineChart><c:grouping val="${spec.stacking === 'none' ? 'standard' : 'standard'}"/><c:varyColors val="${vary}"/>${sers}${dLbls}<c:marker val="1"/>${axes}</c:lineChart>`;
			case 'area':
				return `<c:areaChart><c:grouping val="${grouping}"/><c:varyColors val="${vary}"/>${sers}${dLbls}${axes}</c:areaChart>`;
			case 'scatter':
				return `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="${vary}"/>${sers}${dLbls}${axes}</c:scatterChart>`;
			case 'bubble':
				return `<c:bubbleChart><c:varyColors val="0"/>${sers}${dLbls}<c:bubbleScale val="100"/>${axes}</c:bubbleChart>`;
			case 'radar':
				return `<c:radarChart><c:radarStyle val="marker"/><c:varyColors val="0"/>${sers}${dLbls}${axes}</c:radarChart>`;
			case 'donut':
				return `<c:doughnutChart><c:varyColors val="1"/>${sers}${dLbls}<c:firstSliceAng val="0"/><c:holeSize val="${Math.round(Math.max(10, Math.min(90, spec.innerRadius * 100)))}"/></c:doughnutChart>`;
			default:
				return `<c:pieChart><c:varyColors val="1"/>${sers}${dLbls}<c:firstSliceAng val="0"/></c:pieChart>`;
		}
	});
	// CT_Scaling order: logBase, orientation, max, min.
	const scaling = (a: ChartAxis) =>
		`<c:scaling>${a.scale === 'log' ? `<c:logBase val="${a.logBase ?? 10}"/>` : ''}<c:orientation val="${a.reverse ? 'maxMin' : 'minMax'}"/>${a.max !== null ? `<c:max val="${a.max}"/>` : ''}${a.min !== null ? `<c:min val="${a.min}"/>` : ''}</c:scaling>`;
	const title = (a: ChartAxis) => (a.title ? `<c:title>${rich(a.title)}</c:title>` : '');
	const fmt = (a: ChartAxis) => {
		const code = chartFormatToCode(a.format);
		return code !== 'General' ? `<c:numFmt formatCode="${esc(code)}" sourceLinked="0"/>` : `<c:numFmt formatCode="${spec.stacking === 'percent' ? '0%' : 'General'}" sourceLinked="1"/>`;
	};
	const horizontal = spec.orientation === 'horizontal';
	const catPos = horizontal ? 'l' : 'b';
	const valPos = horizontal ? 'b' : 'l';
	const valAx = (id: number, cross: number, a: ChartAxis, pos: string, crosses: string, catKind = false) =>
		`<c:valAx><c:axId val="${id}"/>${scaling(a)}<c:delete val="${a.show ? 0 : 1}"/><c:axPos val="${pos}"/>${a.gridlines ? '<c:majorGridlines/>' : ''}${title(a)}${fmt(a)}<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="${crosses}"/><c:crossBetween val="${catKind ? 'midCat' : 'between'}"/>${a.step ? `<c:majorUnit val="${a.step}"/>` : ''}</c:valAx>`;
	const catAx = (id: number, cross: number, a: ChartAxis, pos: string, hidden = false) =>
		`<c:${a.kind === 'date' ? 'dateAx' : 'catAx'}><c:axId val="${id}"/><c:scaling><c:orientation val="${a.reverse ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="${a.show && !hidden ? 0 : 1}"/><c:axPos val="${pos}"/>${a.gridlines ? '<c:majorGridlines/>' : ''}${title(a)}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:auto val="1"/>${a.kind === 'date' ? '<c:lblOffset val="100"/><c:baseTimeUnit val="days"/>' : '<c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/>'}</c:${a.kind === 'date' ? 'dateAx' : 'catAx'}>`;
	let axes = '';
	if (!pieLike) {
		if (xy) axes = valAx(ids.cat, ids.val, spec.xAxis, 'b', 'autoZero', true) + valAx(ids.val, ids.cat, spec.yAxis, 'l', 'autoZero', true);
		else {
			if (spec.xAxis.scale === 'log') issues.push('The category axis cannot be logarithmic; its log scale is left out.');
			axes = catAx(ids.cat, ids.val, spec.xAxis, catPos) + valAx(ids.val, ids.cat, spec.yAxis, valPos, 'autoZero');
		}
		if (groups.some((g) => g.secondary)) axes += catAx(ids.cat2, ids.val2, spec.xAxis, catPos, true) + valAx(ids.val2, ids.cat2, spec.yAxis2, horizontal ? 't' : 'r', 'max');
	}
	const legendPos = { bottom: 'b', top: 't', left: 'l', right: 'r' }[spec.legend.position];
	const legend = spec.legend.show ? `<c:legend><c:legendPos val="${legendPos}"/><c:overlay val="0"/></c:legend>` : '';
	const titleXml = spec.title ? `<c:title>${rich(spec.title)}</c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>';
	if (spec.subtitle) issues.push('The subtitle is left out: DrawingML charts have one title.');
	if (family === 'radar' && spec.series.some((s) => s.trendlines?.length)) issues.push('Trendlines on a radar chart are left out.');
	const xml =
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<c:chartSpace xmlns:c="${CHART_OOXML_NS}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
		`<c:roundedCorners val="0"/><c:chart>${titleXml}<c:plotArea><c:layout/>${groupXml.join('')}${axes}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
		`<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${Math.round(10 * 100)}"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr></c:chartSpace>`;
	return { xml, issues: [...new Set(issues)] };
}
