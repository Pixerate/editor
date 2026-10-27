// Grouped chart data: the `tree` of treemaps and sunbursts (Ursula's chart documents call these
// treemap groups and sunburst nodes, src/chart/types.ts `TreemapGroup` and `SunburstNode`).
import { parseChartValue } from './spec.js';
import type { ChartIssue, ChartTreeNode } from './types.js';

/** Deepest tree the editor keeps (a sunburst draws one ring per level). */
export const MAX_CHART_TREE_DEPTH = 6;
/** Most nodes a tree may have. */
export const MAX_CHART_TREE_NODES = 5000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks a tree: every node has a name unique among its siblings, leaves have a value of 0 or
 * more, groups have children. Problems are reported with the node's path and the node is
 * dropped (or its value set to 0), so the rest of the tree is kept.
 */
export function normalizeChartTree(value: unknown, issues: ChartIssue[] = [], path = 'tree'): ChartTreeNode[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		issues.push({ path, message: `${path} must be an array of nodes such as {"name": "Europe", "children": [{"name": "France", "value": 40}]}.` });
		return [];
	}
	let count = 0;
	const read = (list: unknown[], at: string, depth: number): ChartTreeNode[] => {
		const out: ChartTreeNode[] = [];
		const names = new Set<string>();
		list.forEach((raw, i) => {
			const where = `${at}[${i}]`;
			if (!isRecord(raw)) {
				issues.push({ path: where, message: `${where} must be an object with a name and a value or children.` });
				return;
			}
			const name = typeof raw.name === 'number' ? String(raw.name) : typeof raw.name === 'string' ? raw.name.trim() : '';
			if (!name) {
				issues.push({ path: `${where}.name`, message: `${where} needs a name.` });
				return;
			}
			if (names.has(name)) {
				issues.push({ path: `${where}.name`, message: `"${name}" appears twice under the same group in ${at}; sibling names must be unique, so the second was left out.` });
				return;
			}
			if (++count > MAX_CHART_TREE_NODES) {
				if (count === MAX_CHART_TREE_NODES + 1) issues.push({ path, message: `The tree has more than ${MAX_CHART_TREE_NODES} nodes; the rest were left out.` });
				return;
			}
			names.add(name);
			for (const k of Object.keys(raw)) if (!['name', 'value', 'children', 'color'].includes(k)) issues.push({ path: `${where}.${k}`, message: `${where} has no "${k}"; a node takes name, value, children and color.` });
			const node: ChartTreeNode = { name };
			if (typeof raw.color === 'string' && raw.color.trim()) node.color = raw.color.trim();
			if (Array.isArray(raw.children) && raw.children.length) {
				if (depth >= MAX_CHART_TREE_DEPTH) {
					issues.push({ path: `${where}.children`, message: `${where} is more than ${MAX_CHART_TREE_DEPTH} levels deep; its children were left out.` });
					node.value = 0;
				} else {
					if (raw.value !== undefined && raw.value !== null) issues.push({ path: `${where}.value`, message: `"${name}" is a group: its value is the sum of its children, so the value given was ignored.` });
					const children = read(raw.children, `${where}.children`, depth + 1);
					if (children.length) node.children = children;
					else node.value = 0;
				}
			} else {
				if (raw.children !== undefined && raw.children !== null && !Array.isArray(raw.children)) issues.push({ path: `${where}.children`, message: `${where}.children must be an array of nodes.` });
				const v = parseChartValue(raw.value);
				if (raw.value === undefined || raw.value === null) node.value = 0;
				else if (typeof v === 'number' && v >= 0) node.value = v;
				else {
					issues.push({ path: `${where}.value`, message: `"${name}" needs a value of 0 or more; got ${JSON.stringify(raw.value)}.` });
					node.value = 0;
				}
			}
			out.push(node);
		});
		return out;
	};
	return read(value, path, 1);
}

/** The value of a node: its own, or the sum of its leaves. */
export function chartTreeTotal(node: ChartTreeNode): number {
	return node.children ? node.children.reduce((t, c) => t + chartTreeTotal(c), 0) : (node.value ?? 0);
}

/** Levels in the tree (1 for a flat list of leaves, 0 for none). */
export function chartTreeDepth(tree: readonly ChartTreeNode[]): number {
	return tree.reduce((d, n) => Math.max(d, 1 + (n.children ? chartTreeDepth(n.children) : 0)), 0);
}

/** The node at a path of names from the top, or undefined. */
export function findChartTreeNode(tree: readonly ChartTreeNode[], path: readonly string[]): ChartTreeNode | undefined {
	let list: readonly ChartTreeNode[] | undefined = tree;
	let node: ChartTreeNode | undefined;
	for (const name of path) {
		node = list?.find((n) => n.name === name);
		if (!node) return undefined;
		list = node.children;
	}
	return node;
}

/** One leaf as a row: the names from the top down to it, and its value. */
export interface ChartTreeRow {
	path: string[];
	value: number;
}

/** Every leaf of the tree as a row, in order (the tree as a table: group, …, name, value). */
export function chartTreeToRows(tree: readonly ChartTreeNode[]): ChartTreeRow[] {
	const out: ChartTreeRow[] = [];
	const walk = (list: readonly ChartTreeNode[], prefix: string[]) => {
		for (const n of list) {
			if (n.children) walk(n.children, [...prefix, n.name]);
			else out.push({ path: [...prefix, n.name], value: n.value ?? 0 });
		}
	};
	walk(tree, []);
	return out;
}

/**
 * Builds a tree from rows of names and a value: rows that share leading names share those
 * groups, in the order they first appear. Empty names end a path. A name that is both a leaf
 * and a group, or a repeated path, is reported; the first wins.
 */
export function chartTreeFromRows(rows: readonly { path: readonly unknown[]; value: unknown }[], issues: ChartIssue[] = []): ChartTreeNode[] {
	const tree: ChartTreeNode[] = [];
	rows.forEach((row, r) => {
		const path: string[] = [];
		for (const cell of row.path) {
			const name = cell === null || cell === undefined ? '' : String(cell).trim();
			if (!name) break;
			path.push(name);
		}
		if (!path.length) return;
		if (path.length > MAX_CHART_TREE_DEPTH) {
			issues.push({ path: `rows[${r}]`, message: `Row ${r + 1} is ${path.length} levels deep; the tree keeps at most ${MAX_CHART_TREE_DEPTH}, so the row was left out.` });
			return;
		}
		const v = parseChartValue(row.value);
		if (row.value !== null && row.value !== undefined && String(row.value).trim() !== '' && !(typeof v === 'number' && v >= 0)) {
			issues.push({ path: `rows[${r}]`, message: `Row ${r + 1} (${path.join(' / ')}) needs a value of 0 or more; got ${JSON.stringify(row.value)}. It was counted as 0.` });
		}
		const value = typeof v === 'number' && v >= 0 ? v : 0;
		let list = tree;
		for (let k = 0; k < path.length; k++) {
			const last = k === path.length - 1;
			let node = list.find((n) => n.name === path[k]);
			if (!node) {
				node = last ? { name: path[k], value } : { name: path[k], children: [] };
				list.push(node);
				if (last) return;
			} else if (last) {
				issues.push({ path: `rows[${r}]`, message: `Row ${r + 1} (${path.join(' / ')}) ${node.children ? 'names a group that already has items' : 'repeats an earlier row'}; it was left out.` });
				return;
			} else if (!node.children) {
				issues.push({ path: `rows[${r}]`, message: `Row ${r + 1} puts items under "${path.slice(0, k + 1).join(' / ')}", which an earlier row made an item with its own value; it was left out.` });
				return;
			}
			list = node.children!;
		}
	});
	return tree;
}

/**
 * Reads a table as a tree: every column but the last holds names (group, subgroup, …, item),
 * the last holds the value. Blank names repeat the name above (as spreadsheets lay out groups).
 * With `header` (default `auto`: when the first row's last cell is not a number) the first row
 * is skipped.
 */
export function chartTreeFromTable(rows: ReadonlyArray<ReadonlyArray<unknown>>, options: { header?: boolean | 'auto' } = {}, issues: ChartIssue[] = []): ChartTreeNode[] {
	const grid = rows.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ''));
	if (!grid.length) return [];
	const width = Math.max(...grid.map((r) => r.length));
	if (width < 2) {
		issues.push({ path: 'rows', message: 'A tree table needs at least two columns: names, then values.' });
		return [];
	}
	const header = options.header ?? 'auto';
	const skip = header === true || (header === 'auto' && typeof parseChartValue(grid[0][width - 1]) !== 'number');
	const body = skip ? grid.slice(1) : grid;
	// Blank leading names repeat the path above (groups are written once, at their first row).
	let above: string[] = [];
	return chartTreeFromRows(
		body.map((r) => {
			const cells = Array.from({ length: width - 1 }, (_, k) => (r[k] === null || r[k] === undefined ? '' : String(r[k]).trim()));
			const first = cells.findIndex((c) => c !== '');
			if (first < 0) return { path: [], value: r[width - 1] };
			const own: string[] = [];
			for (const c of cells.slice(first)) {
				if (!c) break;
				own.push(c);
			}
			const path = [...above.slice(0, first), ...own];
			above = path;
			return { path, value: r[width - 1] };
		}),
		issues
	);
}

/** A flat tree (one leaf per category) from labels and values, for starting to group a table. */
export function chartTreeFromSeries(categories: readonly string[], values: readonly (number | null)[]): ChartTreeNode[] {
	const seen = new Set<string>();
	const out: ChartTreeNode[] = [];
	categories.forEach((c, i) => {
		const name = c.trim() || `${i + 1}`;
		if (seen.has(name)) return;
		seen.add(name);
		const v = values[i];
		out.push({ name, value: v !== null && v !== undefined && Number.isFinite(v) && v > 0 ? v : 0 });
	});
	return out;
}

/** A deep copy. */
export function cloneChartTree(tree: readonly ChartTreeNode[]): ChartTreeNode[] {
	return tree.map((n) => ({ ...n, ...(n.children ? { children: cloneChartTree(n.children) } : {}) }));
}

// Editing the tree as a table (the data grids): each helper returns new rows for `setTreeRows`.

/** Column headings for a tree table `depth` levels deep: Group, Level 2, …, Item. */
export function chartTreeColumnLabels(depth: number): string[] {
	if (depth <= 1) return ['Item'];
	return Array.from({ length: depth }, (_, k) => (k === 0 ? 'Group' : k === depth - 1 ? 'Item' : `Level ${k + 1}`));
}

/** Rows with the name at `level` of row `row` set (shorter paths are padded with blanks; a blank name ends the path there). */
export function setChartTreeRowName(rows: readonly ChartTreeRow[], row: number, level: number, name: string): { path: string[]; value: unknown }[] {
	return rows.map((r, i) => {
		if (i !== row) return { path: [...r.path], value: r.value };
		const path = [...r.path];
		while (path.length <= level) path.push('');
		path[level] = name.trim();
		return { path, value: r.value };
	});
}

/** Rows with row `row`'s value set (text is parsed by `setTreeRows`). */
export function setChartTreeRowValue(rows: readonly ChartTreeRow[], row: number, value: unknown): { path: string[]; value: unknown }[] {
	return rows.map((r, i) => ({ path: [...r.path], value: i === row ? value : r.value }));
}

/** Rows with a new item after the last row, in the same group, named "Item n" (unique there), value 0. */
export function addChartTreeRow(rows: readonly ChartTreeRow[]): ChartTreeRow[] {
	const parent = rows.length ? rows[rows.length - 1].path.slice(0, -1) : [];
	const taken = new Set(rows.filter((r) => r.path.length === parent.length + 1 && parent.every((p, k) => r.path[k] === p)).map((r) => r.path[parent.length]));
	let n = rows.length + 1;
	while (taken.has(`Item ${n}`)) n++;
	return [...rows.map((r) => ({ path: [...r.path], value: r.value })), { path: [...parent, `Item ${n}`], value: 0 }];
}

/** Rows without row `row`. */
export function removeChartTreeRow(rows: readonly ChartTreeRow[], row: number): ChartTreeRow[] {
	return rows.filter((_, i) => i !== row).map((r) => ({ path: [...r.path], value: r.value }));
}
