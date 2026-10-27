// Flows for Sankey diagrams (Ursula's chart documents, src/chart/types.ts `SankeyChartSpec`).
import { parseChartValue } from './spec.js';
import type { ChartIssue, ChartLink } from './types.js';

/** Most flows a chart may have. */
export const MAX_CHART_LINKS = 2000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nameOf = (value: unknown) => (typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '');

/**
 * Checks flows: each has a source and a target (different names) and a value above 0, a pair
 * appears once, and flows only go forwards (a flow that would close a loop is dropped, since a
 * Sankey diagram cannot draw one). Problems are reported with the flow's index.
 */
export function normalizeChartLinks(value: unknown, issues: ChartIssue[] = [], path = 'links'): ChartLink[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		issues.push({ path, message: `${path} must be an array of flows such as {"source": "Website", "target": "Signup", "value": 120}.` });
		return [];
	}
	const out: ChartLink[] = [];
	const seen = new Set<string>();
	const next = new Map<string, Set<string>>();
	// Whether `to` can already reach `from` (adding from → to would close a loop).
	const reaches = (to: string, from: string) => {
		const stack = [to];
		const visited = new Set<string>();
		while (stack.length) {
			const n = stack.pop()!;
			if (n === from) return true;
			if (visited.has(n)) continue;
			visited.add(n);
			for (const m of next.get(n) ?? []) stack.push(m);
		}
		return false;
	};
	value.forEach((raw, i) => {
		const where = `${path}[${i}]`;
		if (out.length >= MAX_CHART_LINKS) {
			if (out.length === MAX_CHART_LINKS && i === MAX_CHART_LINKS) issues.push({ path, message: `There are more than ${MAX_CHART_LINKS} flows; the rest were left out.` });
			return;
		}
		if (!isRecord(raw)) {
			issues.push({ path: where, message: `${where} must be an object with source, target and value.` });
			return;
		}
		for (const k of Object.keys(raw)) if (!['source', 'target', 'value', 'color'].includes(k)) issues.push({ path: `${where}.${k}`, message: `${where} has no "${k}"; a flow takes source, target, value and color.` });
		const source = nameOf(raw.source);
		const target = nameOf(raw.target);
		if (!source || !target) {
			issues.push({ path: where, message: `${where} needs a source and a target (node names).` });
			return;
		}
		if (source === target) {
			issues.push({ path: where, message: `${where} goes from "${source}" to itself; a flow must join two different nodes.` });
			return;
		}
		const v = parseChartValue(raw.value);
		if (!(typeof v === 'number' && v > 0)) {
			issues.push({ path: `${where}.value`, message: `The flow from "${source}" to "${target}" needs a value above 0; got ${JSON.stringify(raw.value)}.` });
			return;
		}
		const key = `${source}\u0000${target}`;
		if (seen.has(key)) {
			issues.push({ path: where, message: `The flow from "${source}" to "${target}" appears twice; add the values into one flow. The second was left out.` });
			return;
		}
		if (reaches(target, source)) {
			issues.push({ path: where, message: `The flow from "${source}" to "${target}" would close a loop (${target} already leads back to ${source}); flows must only go forwards, so it was left out.` });
			return;
		}
		seen.add(key);
		if (!next.has(source)) next.set(source, new Set());
		next.get(source)!.add(target);
		const link: ChartLink = { source, target, value: v };
		if (typeof raw.color === 'string' && raw.color.trim()) link.color = raw.color.trim();
		out.push(link);
	});
	return out;
}

/**
 * The nodes of a set of flows, in `order` first (names no flow uses are reported and dropped),
 * then any others as the flows first name them.
 */
export function chartSankeyNodes(links: readonly ChartLink[], order: readonly string[] = [], issues: ChartIssue[] = []): string[] {
	const used = new Set<string>();
	const named: string[] = [];
	for (const l of links)
		for (const n of [l.source, l.target])
			if (!used.has(n)) {
				used.add(n);
				named.push(n);
			}
	const out: string[] = [];
	for (const n of order) {
		if (!used.has(n)) {
			if (links.length) issues.push({ path: 'sankeyNodes', message: `sankeyNodes names "${n}", which no flow uses; it was left out.` });
			continue;
		}
		if (!out.includes(n)) out.push(n);
	}
	for (const n of named) if (!out.includes(n)) out.push(n);
	return out;
}

/** How much flows through each node: the larger of what comes in and what goes out. */
export function chartSankeyNodeValues(links: readonly ChartLink[], nodes: readonly string[]): number[] {
	const inflow = new Map<string, number>();
	const outflow = new Map<string, number>();
	for (const l of links) {
		outflow.set(l.source, (outflow.get(l.source) ?? 0) + l.value);
		inflow.set(l.target, (inflow.get(l.target) ?? 0) + l.value);
	}
	return nodes.map((n) => Math.max(inflow.get(n) ?? 0, outflow.get(n) ?? 0));
}

/**
 * Reads flows from a table of source, target and value columns. With `header` (default
 * `auto`: when the first row's third cell is not a number) the first row is skipped.
 */
export function chartLinksFromTable(rows: ReadonlyArray<ReadonlyArray<unknown>>, options: { header?: boolean | 'auto' } = {}): { source: unknown; target: unknown; value: unknown }[] {
	const grid = rows.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''));
	if (!grid.length) return [];
	const header = options.header ?? 'auto';
	const skip = header === true || (header === 'auto' && typeof parseChartValue(grid[0][2]) !== 'number');
	return (skip ? grid.slice(1) : grid).map((r) => ({ source: r[0], target: r[1], value: r[2] }));
}

/** Flows with one field of flow `index` set to `text` (for the data grids; `setLinks` checks the result). */
export function setChartLinkField(links: readonly ChartLink[], index: number, field: 'source' | 'target' | 'value', text: string): Record<string, unknown>[] {
	return links.map((l, i) => (i === index ? { ...l, [field]: field === 'value' ? text : text.trim() } : { ...l }));
}

/**
 * Flows with a new one at the end: from the last flow's target (or "Start") to a new node
 * named "Step n", carrying the last flow's value (or 1).
 */
export function addChartLink(links: readonly ChartLink[]): ChartLink[] {
	const last = links[links.length - 1];
	const names = new Set(links.flatMap((l) => [l.source, l.target]));
	let n = names.size + 1;
	while (names.has(`Step ${n}`)) n++;
	return [...links.map((l) => ({ ...l })), { source: last?.target ?? 'Start', target: `Step ${n}`, value: last?.value ?? 1 }];
}
