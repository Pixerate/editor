// The xychart-beta, pie and radar-beta grammars follow Ursula's statement adapters (src/xychart, src/pie,
// src/radar), and the metadata comment follows its `%% @ursula` line (src/source/metadata.ts).
import { chartFamily, defaultChartAxis, normalizeChartSpec } from './spec.js';
import type { ChartAxis, ChartIssue, ChartSeries, ChartSpec, ChartValue } from './types.js';

/** The comment line that carries what Mermaid cannot express. Every Mermaid tool ignores `%%` comments. */
export const CHART_MERMAID_META_PREFIX = '%% @pixerate ';

export type ChartMermaidFamily = 'xychart' | 'pie' | 'radar';

export interface ChartMermaidOptions {
	/** Write the `%% @pixerate {…}` line so the chart round-trips exactly (default `true`). */
	meta?: boolean;
	/** Indentation of statements (default four spaces). */
	indent?: string;
}

const quote = (text: string) => `"${text.replace(/"/g, '#quot;')}"`;
const unquote = (text: string) => {
	const t = text.trim();
	return (t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t).replace(/#quot;/g, '"');
};
const word = (text: string) => (/^[A-Za-z0-9_]+$/.test(text) ? text : quote(text));
const num = (value: number) => (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10))));

/** Splits on `sep` outside quotes and brackets. */
function splitOutside(text: string, sep: string): string[] {
	const out: string[] = [];
	let cur = '';
	let quoted = false;
	let depth = 0;
	for (const ch of text) {
		if (ch === '"') quoted = !quoted;
		else if (!quoted && (ch === '[' || ch === '{')) depth++;
		else if (!quoted && (ch === ']' || ch === '}')) depth--;
		if (ch === sep && !quoted && depth === 0) {
			out.push(cur);
			cur = '';
		} else cur += ch;
	}
	out.push(cur);
	return out;
}

/** The Mermaid family a chart is written as. */
export function chartMermaidFamily(spec: Pick<ChartSpec, 'type' | 'series'>): ChartMermaidFamily {
	const family = chartFamily(spec);
	if (family === 'pie' || family === 'funnel' || family === 'treemap' || family === 'parliament' || family === 'sunburst') return 'pie';
	if (family === 'radar') return 'radar';
	return 'xychart';
}

function slug(label: string, i: number, taken: Set<string>): string {
	let base = label.normalize('NFKD').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || `a${i + 1}`;
	if (!/^[A-Za-z_]/.test(base)) base = `a_${base}`;
	let id = base;
	for (let k = 2; taken.has(id); k++) id = `${base}_${k}`;
	taken.add(id);
	return id;
}

/** Fields that differ from what the Mermaid text alone would give, for the metadata line. */
function metaFor(spec: ChartSpec, text: string): Record<string, unknown> | null {
	const base = chartFromMermaid(text, { ignoreMeta: true }).spec;
	const meta: Record<string, unknown> = {};
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	for (const key of Object.keys(spec) as (keyof ChartSpec)[]) {
		if (key === 'series' || key === 'version') continue;
		if (!same(spec[key], base[key])) meta[key] = spec[key];
	}
	const series = spec.series.map((s, i) => {
		const b = base.series[i];
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(s)) {
			if (k === 'values') {
				// Gaps are written as 0 in Mermaid; record where they are, and exact values that rounded.
				if (b && !same(v, b.values)) out.values = v;
				continue;
			}
			if (!b || !same(v, (b as unknown as Record<string, unknown>)[k])) out[k] = v;
		}
		return out;
	});
	if (series.some((s) => Object.keys(s).length) || spec.series.length !== base.series.length) meta.series = series;
	return Object.keys(meta).length ? meta : null;
}

/**
 * Writes a chart as Mermaid: `xychart-beta` for bar, line, area and scatter charts (areas and
 * scatters drawn as lines; slopes and Likert charts as lines and bars), `pie` for pies, donuts,
 * funnels, treemaps and parliaments, `radar-beta` for
 * radars. Anything Mermaid cannot hold (stacking, colours, formats, gaps, trendlines, other
 * chart types) goes into one `%% @pixerate {…}` comment so `chartFromMermaid` gets the chart
 * back exactly, while any Mermaid renderer still draws the basic chart.
 */
export function chartToMermaid(spec: ChartSpec, options: ChartMermaidOptions = {}): string {
	const ind = options.indent ?? '    ';
	const family = chartMermaidFamily(spec);
	const visible = spec.series.filter((s) => !s.hidden);
	const lines: string[] = [];
	const v = (x: ChartValue) => (x === null || !Number.isFinite(x) ? '0' : num(x));
	if (family === 'pie') {
		const s = visible[0] ?? spec.series[0];
		lines.push(`pie${spec.dataLabels ? ' showData' : ''}`);
		if (spec.title) lines.push(`${ind}title ${spec.title}`);
		spec.categories.forEach((c, i) => {
			const value = s?.values[i];
			if (value !== null && value !== undefined && Number.isFinite(value) && value > 0) lines.push(`${ind}${quote(c)} : ${num(value)}`);
		});
	} else if (family === 'radar') {
		lines.push('radar-beta');
		if (spec.title) lines.push(`${ind}title ${spec.title}`);
		const taken = new Set<string>();
		const ids = spec.categories.map((c, i) => slug(c, i, taken));
		lines.push(`${ind}axis ${ids.map((id, i) => (id === spec.categories[i] ? id : `${id}["${spec.categories[i].replace(/"/g, "'")}"]`)).join(', ')}`);
		const seriesTaken = new Set<string>(ids);
		for (const [i, s] of spec.series.entries()) {
			const id = slug(s.id, i, seriesTaken);
			lines.push(`${ind}curve ${id}["${s.name.replace(/"/g, "'")}"]{${s.values.map(v).join(', ')}}`);
		}
		if (spec.yAxis.max !== null) lines.push(`${ind}max ${num(spec.yAxis.max)}`);
		if (spec.yAxis.min !== null) lines.push(`${ind}min ${num(spec.yAxis.min)}`);
		if (spec.radarTicks !== null) lines.push(`${ind}ticks ${spec.radarTicks}`);
		// Mermaid draws circles unless told otherwise.
		if (spec.radarGraticule === 'polygon') lines.push(`${ind}graticule polygon`);
		if (!spec.legend.show) lines.push(`${ind}showLegend false`);
	} else {
		lines.push(`xychart-beta${spec.orientation === 'horizontal' ? ' horizontal' : ''}`);
		if (spec.title) lines.push(`${ind}title ${quote(spec.title)}`);
		const xTitle = spec.xAxis.title ? ` ${quote(spec.xAxis.title)}` : '';
		lines.push(`${ind}x-axis${xTitle} [${spec.categories.map(word).join(', ')}]`);
		const y = spec.yAxis;
		if (y.title || y.min !== null || y.max !== null) {
			let out = `${ind}y-axis`;
			if (y.title) out += ` ${quote(y.title)}`;
			if (y.min !== null || y.max !== null) {
				// Mermaid wants both ends; the missing one comes from the data.
				const all = spec.series.flatMap((s) => s.values).filter((x): x is number => x !== null && Number.isFinite(x));
				const lo = y.min ?? Math.min(0, ...all);
				const hi = y.max ?? Math.max(lo + 1, ...all);
				out += ` ${num(lo)} --> ${num(hi)}`;
			}
			lines.push(out);
		}
		for (const s of spec.series) {
			const kind = (s.type ?? (spec.type === 'bar' ? 'bar' : 'line')) === 'bar' ? 'bar' : 'line';
			lines.push(`${ind}${kind} ${quote(s.name)} [${s.values.map(v).join(', ')}]`);
		}
	}
	let text = `${lines.join('\n')}\n`;
	if (options.meta !== false) {
		const meta = metaFor(spec, text);
		if (meta) {
			const [header, ...rest] = lines;
			text = `${[header, `${CHART_MERMAID_META_PREFIX}${JSON.stringify({ v: 1, ...meta })}`, ...rest].join('\n')}\n`;
		}
	}
	return text;
}

export interface ChartMermaidParseOptions {
	/** Accept a statement that is still being written (an unclosed `[` list): for streaming views. */
	partial?: boolean;
	/** Ignore the `%% @pixerate` line (what the Mermaid text alone says). */
	ignoreMeta?: boolean;
}

export interface ChartMermaidResult {
	spec: ChartSpec;
	/** Problems, with 1-based `line` numbers. Lines that could not be read are listed and skipped. */
	issues: ChartIssue[];
	family: ChartMermaidFamily | null;
	/** The `%% @pixerate` line was found and applied. */
	hasMeta: boolean;
}

const RANGE = /^(-?\d+(?:\.\d+)?)\s*-->\s*(-?\d+(?:\.\d+)?)$/;

function takeTitle(text: string): { title?: string; rest: string } {
	const t = text.trim();
	if (t.startsWith('"')) {
		const end = t.indexOf('"', 1);
		if (end > 0) return { title: unquote(t.slice(0, end + 1)), rest: t.slice(end + 1).trim() };
	}
	if (!t || t.startsWith('[') || RANGE.test(t) || /^-?\d/.test(t)) return { rest: t };
	const m = /^(\S+)\s*(.*)$/.exec(t)!;
	return { title: m[1], rest: m[2].trim() };
}

function parseList(text: string, partial: boolean): string[] | undefined {
	const t = text.trim();
	let m = /^\[(.*)\]$/s.exec(t);
	if (!m && partial) m = /^\[(.*)$/s.exec(t);
	if (!m) return undefined;
	if (!m[1].trim()) return [];
	const items = splitOutside(m[1], ',').map((x) => x.trim());
	// A partial list may end mid-item: drop an empty or unfinished last entry.
	if (partial && !/\]$/.test(t)) {
		const last = items[items.length - 1];
		if (!last || (last.startsWith('"') && !/"$/.test(last.slice(1)))) items.pop();
	}
	return items.map(unquote);
}

/**
 * Reads Mermaid `xychart-beta`, `pie` or `radar-beta` text as a chart. Never throws: lines it
 * cannot read are reported with their line numbers and skipped, and the result always draws.
 * A `%% @pixerate {…}` line written by `chartToMermaid` restores everything Mermaid cannot hold.
 */
export function chartFromMermaid(text: string, options: ChartMermaidParseOptions = {}): ChartMermaidResult {
	const issues: ChartIssue[] = [];
	const partial = !!options.partial;
	const all = text.replace(/^﻿/, '').split(/\r?\n/);
	let start = 0;
	let frontTitle: string | undefined;
	// Frontmatter (--- … ---) may carry a title.
	if (all[0]?.trim() === '---') {
		const end = all.findIndex((l, i) => i > 0 && l.trim() === '---');
		if (end > 0) {
			for (const l of all.slice(1, end)) {
				const m = /^title:\s*(.+)$/.exec(l.trim());
				if (m) frontTitle = unquote(m[1]);
			}
			start = end + 1;
		}
	}
	let family: ChartMermaidFamily | null = null;
	let headerLine = -1;
	let horizontal = false;
	let showData = false;
	let meta: Record<string, unknown> | null = null;
	for (let i = start; i < all.length; i++) {
		const t = all[i].trim();
		if (!t || t.startsWith('%%')) continue;
		let m: RegExpExecArray | null;
		if ((m = /^xychart(?:-beta)?(?:\s+(horizontal|vertical))?\s*$/i.exec(t))) {
			family = 'xychart';
			horizontal = m[1]?.toLowerCase() === 'horizontal';
		} else if ((m = /^pie(\s+showData)?(?:\s+title\s+(.*))?\s*$/i.exec(t))) {
			family = 'pie';
			showData = !!m[1];
			if (m[2]) frontTitle = m[2].trim();
		} else if (/^radar(?:-beta)?\s*$/i.test(t)) family = 'radar';
		else issues.push({ path: 'header', line: i + 1, message: `Line ${i + 1}: expected a chart header (xychart-beta, pie or radar-beta), got "${t.slice(0, 40)}".` });
		headerLine = i;
		break;
	}
	let title = frontTitle ?? '';
	const categories: string[] = [];
	const series: ChartSeries[] = [];
	const xAxis: ChartAxis = defaultChartAxis(false);
	const yAxis: ChartAxis = defaultChartAxis(true);
	const radarAxes: { id: string; label: string }[] = [];
	const pieSlices: { label: string; value: number }[] = [];
	let legendShow = true;
	let radarTicks: number | null = null;
	// Mermaid's radar default.
	let graticule: 'circle' | 'polygon' = 'circle';
	const counts = { bar: 0, line: 0 };
	const lineIssue = (i: number, message: string) => issues.push({ path: `line ${i + 1}`, line: i + 1, message: `Line ${i + 1}: ${message}` });
	for (let i = headerLine + 1; family && i < all.length; i++) {
		const raw = all[i];
		const t = raw.trim();
		if (!t) continue;
		if (t.startsWith(CHART_MERMAID_META_PREFIX.trim())) {
			if (options.ignoreMeta) continue;
			try {
				const parsed = JSON.parse(t.slice(CHART_MERMAID_META_PREFIX.trim().length).trim());
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
				else lineIssue(i, 'the @pixerate metadata is not a JSON object; it was ignored.');
			} catch {
				if (!partial) lineIssue(i, 'the @pixerate metadata is not valid JSON; it was ignored.');
			}
			continue;
		}
		if (t.startsWith('%%')) continue;
		const isLast = i === all.length - 1 || all.slice(i + 1).every((l) => !l.trim());
		let m: RegExpExecArray | null;
		if ((m = /^title\s+(.+)$/i.exec(t))) {
			title = unquote(m[1]);
			continue;
		}
		if (family === 'xychart') {
			if ((m = /^x-axis\b(.*)$/i.exec(t))) {
				const { title: xt, rest } = takeTitle(m[1]);
				if (xt) xAxis.title = xt;
				const list = parseList(rest, partial && isLast);
				if (list) categories.splice(0, categories.length, ...list);
				else if (RANGE.test(rest)) {
					const r = RANGE.exec(rest)!;
					xAxis.min = Number(r[1]);
					xAxis.max = Number(r[2]);
				} else if (rest) lineIssue(i, `expected x-axis [a, b, …] or a range "min --> max", got "${rest.slice(0, 40)}".`);
				continue;
			}
			if ((m = /^y-axis\b(.*)$/i.exec(t))) {
				const { title: yt, rest } = takeTitle(m[1]);
				if (yt) yAxis.title = yt;
				const r = RANGE.exec(rest);
				if (r) {
					yAxis.min = Number(r[1]);
					yAxis.max = Number(r[2]);
				} else if (rest) lineIssue(i, `expected y-axis "min --> max", got "${rest.slice(0, 40)}".`);
				continue;
			}
			if ((m = /^(bar|line)\b(.*)$/i.exec(t))) {
				const kind = m[1].toLowerCase() as 'bar' | 'line';
				const { title: st, rest } = takeTitle(m[2]);
				const list = parseList(rest, partial && isLast);
				if (!list) {
					if (!(partial && isLast)) lineIssue(i, `expected ${kind} [1, 2, 3], got "${rest.slice(0, 40)}".`);
					continue;
				}
				const values = list.map((x) => (x.trim() === '' ? null : Number(x)));
				if (values.some((x) => x !== null && !Number.isFinite(x))) {
					lineIssue(i, `${kind} values must be numbers.`);
					continue;
				}
				counts[kind]++;
				series.push({ id: `series-${series.length + 1}`, name: st ?? `${kind === 'bar' ? 'Bar' : 'Line'} ${counts[kind]}`, values: values as ChartValue[], type: kind });
				continue;
			}
		} else if (family === 'pie') {
			if ((m = /^"((?:[^"\\]|\\.)*)"\s*:\s*(-?\d+(?:\.\d+)?)\s*$/.exec(t))) {
				pieSlices.push({ label: m[1].replace(/#quot;/g, '"'), value: Number(m[2]) });
				continue;
			}
			if (/^showData\s*$/i.test(t)) {
				showData = true;
				continue;
			}
		} else if (family === 'radar') {
			if ((m = /^axis\s+(.+)$/.exec(t))) {
				for (const part of splitOutside(m[1], ',')) {
					const a = /^([A-Za-z_][\w-]*)\s*(?:\[\s*"((?:[^"\\]|\\.)*)"\s*\])?$/.exec(part.trim());
					if (a) radarAxes.push({ id: a[1], label: a[2] ?? a[1] });
					else lineIssue(i, `could not read the axis "${part.trim()}".`);
				}
				continue;
			}
			if ((m = /^curve\s+([A-Za-z_][\w-]*)\s*(?:\[\s*"((?:[^"\\]|\\.)*)"\s*\])?\s*\{(.*)\}?\s*$/.exec(t))) {
				const body = m[3].replace(/\}\s*$/, '');
				const entries = body.trim() ? splitOutside(body, ',').map((x) => x.trim()).filter(Boolean) : [];
				const ids = radarAxes.map((a) => a.id);
				const values: ChartValue[] = ids.map(() => null);
				let k = 0;
				for (const e of entries) {
					const keyed = /^([A-Za-z_][\w-]*)\s*:\s*(-?\d+(?:\.\d+)?)$/.exec(e);
					if (keyed) {
						const at = ids.indexOf(keyed[1]);
						if (at >= 0) values[at] = Number(keyed[2]);
						else lineIssue(i, `curve ${m[1]} names an unknown axis "${keyed[1]}".`);
					} else if (/^-?\d+(?:\.\d+)?$/.test(e)) {
						if (k < values.length) values[k] = Number(e);
						else values.push(Number(e));
						k++;
					} else lineIssue(i, `could not read "${e}" in curve ${m[1]}.`);
				}
				series.push({ id: m[1], name: m[2] ?? m[1], values });
				continue;
			}
			if ((m = /^(max|min|ticks|graticule|showLegend)\s+(\S+)$/.exec(t))) {
				if (m[1] === 'max') yAxis.max = Number(m[2]);
				else if (m[1] === 'min') yAxis.min = Number(m[2]);
				else if (m[1] === 'showLegend') legendShow = m[2] !== 'false';
				else if (m[1] === 'ticks') {
					const n = Number(m[2]);
					if (Number.isFinite(n) && n >= 1) radarTicks = Math.min(50, Math.round(n));
					else lineIssue(i, `expected ticks to be a number of rings (1 or more), got "${m[2]}".`);
				} else if (m[2] === 'circle' || m[2] === 'polygon') graticule = m[2];
				else lineIssue(i, `expected graticule circle or polygon, got "${m[2]}".`);
				continue;
			}
		}
		if (!(partial && isLast)) lineIssue(i, `could not read "${t.slice(0, 60)}"; it was skipped.`);
	}

	let input: Record<string, unknown>;
	if (family === 'pie') {
		input = {
			type: 'pie',
			title,
			dataLabels: showData,
			categories: pieSlices.map((s) => s.label),
			series: [{ id: 'series-1', name: title || 'Values', values: pieSlices.map((s) => s.value) }]
		};
	} else if (family === 'radar') {
		input = { type: 'radar', title, categories: radarAxes.map((a) => a.label), series, yAxis, legend: { show: legendShow, position: 'bottom' }, radarTicks, radarGraticule: graticule };
	} else {
		const allBar = series.length > 0 && series.every((s) => s.type === 'bar');
		const allLine = series.length > 0 && series.every((s) => s.type === 'line');
		const type = allLine ? 'line' : 'bar';
		const longest = Math.max(0, ...series.map((s) => s.values.length));
		const cats = categories.length ? categories : Array.from({ length: longest }, (_, i) => `${i + 1}`);
		input = {
			type,
			title,
			orientation: horizontal ? 'horizontal' : 'vertical',
			categories: cats,
			xAxis,
			yAxis,
			// Series that match the chart type do not need their own type.
			series: series.map((s) => (allBar || allLine || s.type === type ? { ...s, type: undefined } : s))
		};
	}
	if (meta) {
		const { v: _v, series: metaSeries, ...rest } = meta as Record<string, unknown> & { v?: number; series?: Record<string, unknown>[] };
		Object.assign(input, rest);
		if (Array.isArray(metaSeries)) {
			const base = (input.series as Record<string, unknown>[]) ?? [];
			input.series = metaSeries.map((extra, i) => ({ ...(base[i] ?? {}), ...(extra ?? {}) }));
		}
	}
	const { spec, issues: specIssues } = normalizeChartSpec(input);
	if (!family && !partial && !issues.length) issues.push({ path: 'header', message: 'The text is empty: expected a chart header (xychart-beta, pie or radar-beta).' });
	return { spec, issues: [...issues, ...specIssues], family, hasMeta: !!meta };
}

export interface FoundChartMermaid {
	source: string;
	family: ChartMermaidFamily;
	/** 1-based line where the block starts in the input. */
	line: number;
}

/**
 * Finds Mermaid charts in Markdown or chat text: fenced ```mermaid blocks (and unlabelled
 * fences) whose header is xychart-beta, pie or radar-beta, else the whole text when it is one.
 */
export function findMermaidCharts(text: string): FoundChartMermaid[] {
	const lines = text.replace(/^﻿/, '').split(/\r?\n/);
	const found: FoundChartMermaid[] = [];
	const familyOf = (body: string): ChartMermaidFamily | null => {
		const header = body.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('%%') && l.trim() !== '---');
		if (!header) return null;
		if (/^\s*xychart(-beta)?\b/.test(header)) return 'xychart';
		if (/^\s*pie\b/.test(header)) return 'pie';
		if (/^\s*radar(-beta)?\b/.test(header)) return 'radar';
		return null;
	};
	for (let i = 0; i < lines.length; i++) {
		const open = /^ {0,3}(`{3,}|~{3,})\s*([\w-]*)/.exec(lines[i]);
		if (!open) continue;
		const fence = open[1];
		const info = open[2].toLowerCase();
		let end = i + 1;
		while (end < lines.length && !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[end])) end++;
		const body = lines.slice(i + 1, end).join('\n');
		if (!info || info === 'mermaid') {
			const family = familyOf(body);
			if (family) found.push({ source: `${body.trimEnd()}\n`, family, line: i + 2 });
		}
		i = end;
	}
	if (!found.length) {
		const family = familyOf(text);
		if (family) found.push({ source: `${text.trim()}\n`, family, line: 1 });
	}
	return found;
}

