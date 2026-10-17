import { HistoryManager } from '../history/HistoryManager.js';
import type { Command, HistoryMark } from '../history/types.js';
import { parseCsv, parseTsv } from '../spreadsheet/csv.js';
import { sameChartSelection } from './layout.js';
import { chartPresetPatch } from './presets.js';
import { chartFamily } from './spec.js';
import { chartMovingAverage, chartSupportsTrendlines, fitChartTrendline, type ChartTrendFit } from './trend.js';
import {
	chartDataFromTable,
	normalizeChartTrendline,
	cloneChartSeries,
	cloneChartSpec,
	normalizeChartSpec,
	parseChartValue,
	uniqueChartSeriesId,
	type ChartTableOptions
} from './spec.js';
import type {
	ChartAxis,
	ChartIssue,
	ChartCurve,
	ChartLegend,
	ChartMarker,
	ChartNumberFormat,
	ChartSelection,
	ChartSeries,
	ChartSeriesType,
	ChartSpec,
	ChartTrendline,
	ChartType,
	ChartValue
} from './types.js';

/** Structural equality of JSON-like values (specs are plain data; key order does not matter). */
function sameChartJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b);
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const bb = b as unknown[];
		return a.length === bb.length && a.every((v, i) => sameChartJson(v, bb[i]));
	}
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const keys = Object.keys(ao).filter((k) => ao[k] !== undefined);
	if (keys.length !== Object.keys(bo).filter((k) => bo[k] !== undefined).length) return false;
	return keys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && sameChartJson(ao[k], bo[k]));
}

export interface ChartControllerOptions {
	/** Starting chart (any partial or saved spec; problems are reported in `state.issues`). */
	spec?: Partial<ChartSpec> | unknown;
	/** History to record into, e.g. one shared with the rest of the app (default: a new one). */
	history?: HistoryManager;
	/** Called after the spec changes (edit, undo, redo, load). */
	onChange?: (spec: Readonly<ChartSpec>) => void;
}

/** A snapshot of the controller. The same object is returned until something changes. */
export interface ChartState {
	spec: Readonly<ChartSpec>;
	selection: ChartSelection | null;
	/** The series the selection belongs to (a series, one of its points or one of its trendlines). */
	selectedSeries: ChartSeries | null;
	/** The category the selection belongs to (a category or a point). */
	selectedIndex: number | null;
	/** Problems from the last load or rejected edit, as sentences. */
	issues: readonly ChartIssue[];
	/** The gesture in progress (e.g. a bar drag), if any. */
	gesture: string | null;
	canUndo: boolean;
	canRedo: boolean;
	undoLabel: string;
	redoLabel: string;
	/** Bumped on every change. */
	revision: number;
}

export type ChartActionResult = { ok: true } | { ok: false; message: string; issues?: ChartIssue[] };

/** Top-level fields with partial axes and legend. */
export type ChartSpecPatch = Partial<Omit<ChartSpec, 'version' | 'xAxis' | 'yAxis' | 'yAxis2' | 'legend'>> & {
	xAxis?: Partial<ChartAxis>;
	yAxis?: Partial<ChartAxis>;
	yAxis2?: Partial<ChartAxis>;
	legend?: Partial<ChartLegend>;
};

export interface ChartSeriesInput {
	id?: string;
	name?: string;
	values?: readonly unknown[];
	color?: string;
	type?: ChartSeriesType;
	hidden?: boolean;
	axis?: 'primary' | 'secondary';
	x?: readonly unknown[];
	sizes?: readonly unknown[];
	pointColors?: readonly (string | null)[];
	marker?: ChartMarker;
	curve?: ChartCurve;
	dataLabels?: boolean;
	format?: ChartNumberFormat;
	trendlines?: readonly ChartTrendline[];
}

/** Changes to one series; `null` resets a field to the chart's default. */
export interface ChartSeriesPatch {
	name?: string;
	/** `null` goes back to the palette colour. */
	color?: string | null;
	/** `null` follows the chart type. */
	type?: ChartSeriesType | null;
	hidden?: boolean;
	axis?: 'primary' | 'secondary' | null;
	x?: readonly unknown[] | null;
	sizes?: readonly unknown[] | null;
	pointColors?: readonly (string | null)[] | null;
	marker?: ChartMarker | null;
	curve?: ChartCurve | null;
	dataLabels?: boolean | null;
	format?: ChartNumberFormat | null;
}

export interface ChartEditOptions {
	/** Undo step label. */
	label?: string;
}

const fail = (message: string, issues?: ChartIssue[]): ChartActionResult => ({ ok: false, message, ...(issues ? { issues } : {}) });

/**
 * Headless state for a chart editor: a validated `ChartSpec`, a selection, and undoable
 * edits to data (values, series, categories, pasted grids, CSV) and presentation (type,
 * titles, axes, legend, stacking, …). Drags merge into one undo step (`beginGesture`).
 * `getState()` returns the same object until something changes, so it works with
 * `useSyncExternalStore` and Svelte runes alike.
 */
export class ChartController {
	readonly history: HistoryManager;
	private spec: ChartSpec;
	private selection: ChartSelection | null = null;
	private issues: ChartIssue[] = [];
	private gestureKey: string | null = null;
	private gestureCount = 0;
	private gestureStart: { spec: ChartSpec; mark: HistoryMark } | null = null;
	private revision = 0;
	private applying = false;
	private readonly onChange?: ChartControllerOptions['onChange'];
	private readonly listeners = new Set<(state: ChartState) => void>();
	private unsubscribeHistory?: () => void;
	private state!: ChartState;

	constructor(options: ChartControllerOptions = {}) {
		this.history = options.history ?? new HistoryManager();
		this.onChange = options.onChange;
		const { spec, issues } = normalizeChartSpec(options.spec ?? {});
		this.spec = spec;
		this.issues = issues;
		this.state = this.computeState();
		this.connect();
	}

	private connect() {
		this.unsubscribeHistory?.();
		this.unsubscribeHistory = this.history.subscribe((h) => {
			// Edits notify as they apply; only re-notify when the undo/redo state moved on.
			const s = this.state;
			if (this.applying || (s.canUndo === h.canUndo && s.canRedo === h.canRedo && s.undoLabel === h.undoName && s.redoLabel === h.redoName)) return;
			this.notify(false);
		});
	}

	// -------------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------------

	/** The current snapshot (stable until the next change). */
	getState = (): ChartState => this.state;

	/** Calls `listener` after every change. Returns an unsubscribe function. */
	subscribe = (listener: (state: ChartState) => void): (() => void) => {
		// Reconnect after `destroy()` so a remount (React StrictMode) keeps undo working.
		if (!this.unsubscribeHistory) this.connect();
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** The current spec (do not mutate; edit through the controller). */
	getSpec(): Readonly<ChartSpec> {
		return this.spec;
	}

	getSeries(id: string): ChartSeries | undefined {
		return this.spec.series.find((s) => s.id === id);
	}

	private computeState(): ChartState {
		const h = this.history.getState();
		const sel = this.selection;
		const seriesId = sel?.kind === 'series' || sel?.kind === 'point' || sel?.kind === 'trendline' ? sel.seriesId : null;
		return {
			spec: this.spec,
			selection: sel,
			selectedSeries: seriesId ? (this.spec.series.find((s) => s.id === seriesId) ?? null) : null,
			selectedIndex: sel?.kind === 'point' || sel?.kind === 'category' ? sel.index : null,
			issues: this.issues,
			gesture: this.gestureKey,
			canUndo: h.canUndo,
			canRedo: h.canRedo,
			undoLabel: h.undoName,
			redoLabel: h.redoName,
			revision: this.revision
		};
	}

	private notify(specChanged: boolean) {
		this.revision++;
		this.state = this.computeState();
		if (specChanged) this.onChange?.(this.spec);
		const state = this.state;
		this.listeners.forEach((listener) => {
			try {
				listener(state);
			} catch (error) {
				console.error('[ChartController] Error in state listener:', error);
			}
		});
	}

	// -------------------------------------------------------------------------
	// Changes: every edit records a before / after snapshot of the spec
	// -------------------------------------------------------------------------

	/** Drops a selection that no longer points at anything. */
	private validSelection(sel: ChartSelection | null, spec: ChartSpec): ChartSelection | null {
		if (!sel) return null;
		switch (sel.kind) {
			case 'series':
				return spec.series.some((s) => s.id === sel.seriesId) ? sel : null;
			case 'point':
				return spec.series.some((s) => s.id === sel.seriesId) && sel.index < spec.categories.length ? sel : null;
			case 'category':
				return sel.index < spec.categories.length ? sel : null;
			case 'trendline':
				return spec.series.find((s) => s.id === sel.seriesId)?.trendlines?.[sel.index] ? sel : null;
			case 'title':
				return spec.title ? sel : null;
			case 'subtitle':
				return spec.subtitle ? sel : null;
			default:
				return sel;
		}
	}

	private applySpec(spec: ChartSpec) {
		this.applying = true;
		try {
			this.spec = spec;
			this.selection = this.validSelection(this.selection, spec);
		} finally {
			this.applying = false;
		}
		this.notify(true);
	}

	private commit(label: string, next: ChartSpec, select?: ChartSelection | null) {
		const before = this.spec;
		const hadIssues = this.issues.length > 0;
		this.issues = [];
		// A no-op edit (same value, same title, …) records no undo step.
		if (sameChartJson(before, next)) {
			const reselect = select !== undefined && !sameChartSelection(this.selection, select) && !(select === null && this.selection === null);
			if (reselect) this.selection = select;
			if (reselect || hadIssues) this.notify(false);
			return;
		}
		const command: Command = {
			name: label,
			tag: 'chart',
			execute: () => this.applySpec(next),
			undo: () => this.applySpec(before),
			redo: () => this.applySpec(next)
		};
		if (select !== undefined) this.selection = select;
		if (this.gestureKey !== null) this.history.executeMerged(command, { key: `chart.gesture:${this.gestureKey}:${this.gestureCount}` });
		else this.history.execute(command);
	}

	private reject(message: string, issues: ChartIssue[] = []): ChartActionResult {
		this.issues = issues.length ? issues : [{ path: '', message }];
		this.notify(false);
		return fail(message, issues.length ? issues : undefined);
	}

	/** A copy of the spec with `edit` applied (series and categories copied as needed). */
	private edited(edit: (draft: ChartSpec) => void): ChartSpec {
		const draft = cloneChartSpec(this.spec);
		edit(draft);
		return draft;
	}

	private unknownSeries(id: string): ChartActionResult {
		const ids = this.spec.series.map((s) => `"${s.id}"`);
		return fail(`There is no series "${id}"; ${ids.length ? `expected one of ${ids.join(', ')}` : 'the chart has no series yet'}.`);
	}

	private badIndex(index: number): ChartActionResult {
		const n = this.spec.categories.length;
		return fail(n ? `Category index ${index} is out of range; expected 0 to ${n - 1}.` : 'The chart has no categories yet.');
	}

	// -------------------------------------------------------------------------
	// Presentation
	// -------------------------------------------------------------------------

	/**
	 * Changes any presentation or data fields as one undo step. All-or-nothing: if anything
	 * is invalid, nothing changes and every problem is returned (and shown in `state.issues`).
	 */
	update(patch: ChartSpecPatch, options: ChartEditOptions = {}): ChartActionResult {
		const s = this.spec;
		const merged = {
			...s,
			...patch,
			xAxis: patch.xAxis ? { ...s.xAxis, ...patch.xAxis } : s.xAxis,
			yAxis: patch.yAxis ? { ...s.yAxis, ...patch.yAxis } : s.yAxis,
			yAxis2: patch.yAxis2 ? { ...s.yAxis2, ...patch.yAxis2 } : s.yAxis2,
			legend: patch.legend ? { ...s.legend, ...patch.legend } : s.legend,
			version: 1
		};
		const { spec, issues } = normalizeChartSpec(merged);
		if (issues.length) return this.reject(issues.map((i) => i.message).join(' '), issues);
		if (JSON.stringify(spec) === JSON.stringify(s)) return { ok: true };
		this.commit(options.label ?? updateLabel(patch), spec);
		return { ok: true };
	}

	setType(type: ChartType): ChartActionResult {
		return this.update({ type }, { label: `Change chart type` });
	}

	setTitle(title: string): ChartActionResult {
		return this.update({ title }, { label: 'Edit title' });
	}

	setSubtitle(subtitle: string): ChartActionResult {
		return this.update({ subtitle }, { label: 'Edit subtitle' });
	}

	/** Changes the category (`x`), value (`y`) or secondary value (`y2`) axis. */
	setAxis(axis: 'x' | 'y' | 'y2', patch: Partial<ChartAxis>): ChartActionResult {
		const key = axis === 'x' ? 'xAxis' : axis === 'y' ? 'yAxis' : 'yAxis2';
		return this.update({ [key]: patch }, { label: `Change ${axis === 'x' ? 'category' : axis === 'y' ? 'value' : 'secondary value'} axis` });
	}

	/**
	 * Applies a named quick layout and / or colour scheme (see `CHART_LAYOUT_PRESETS` and
	 * `CHART_COLOR_SCHEMES`) as one undo step.
	 */
	applyPreset(options: { layout?: string; colors?: string }): ChartActionResult {
		const preset = chartPresetPatch(options);
		if (!preset.ok) return this.reject(preset.message);
		const label = options.layout && options.colors ? 'Apply chart style' : options.layout ? 'Apply quick layout' : 'Change colours';
		return this.update(preset.patch, { label });
	}

	setLegend(patch: Partial<ChartLegend>): ChartActionResult {
		return this.update({ legend: patch }, { label: 'Change legend' });
	}

	// -------------------------------------------------------------------------
	// Data
	// -------------------------------------------------------------------------

	/**
	 * Replaces categories and / or series as one undo step. Values are validated and padded
	 * to the categories; all-or-nothing like `update`.
	 */
	setData(data: { categories?: readonly unknown[]; series?: readonly ChartSeriesInput[] }, options: ChartEditOptions = {}): ChartActionResult {
		return this.update({ ...(data.categories ? { categories: data.categories as string[] } : {}), ...(data.series ? { series: data.series as ChartSeries[] } : {}) }, { label: options.label ?? 'Edit chart data' });
	}

	/**
	 * Sets one value (numbers, numeric text such as `1,200` or `12%`, or blank for a gap).
	 * One undo step, or part of the current gesture.
	 */
	setValue(seriesId: string, index: number, value: unknown, options: ChartEditOptions = {}): ChartActionResult {
		const series = this.getSeries(seriesId);
		if (!series) return this.unknownSeries(seriesId);
		if (!Number.isInteger(index) || index < 0 || index >= this.spec.categories.length) return this.badIndex(index);
		const parsed = parseChartValue(value);
		if (parsed === undefined) return this.reject(`"${String(value)}" is not a number; enter a number or leave the cell blank.`, [{ path: `${seriesId}[${index}]`, message: `"${String(value)}" is not a number.` }]);
		if (series.values[index] === parsed) {
			if (this.issues.length) {
				this.issues = [];
				this.notify(false);
			}
			return { ok: true };
		}
		const next = this.edited((d) => {
			d.series.find((s) => s.id === seriesId)!.values[index] = parsed;
		});
		this.commit(options.label ?? `Edit ${series.name} · ${this.spec.categories[index]}`, next);
		return { ok: true };
	}

	/** Several values as one undo step (all-or-nothing). */
	setValues(cells: readonly { seriesId: string; index: number; value: unknown }[], options: ChartEditOptions = {}): ChartActionResult {
		const issues: ChartIssue[] = [];
		const parsed: { seriesId: string; index: number; value: ChartValue }[] = [];
		for (const cell of cells) {
			if (!this.getSeries(cell.seriesId)) issues.push({ path: cell.seriesId, message: (this.unknownSeries(cell.seriesId) as { message: string }).message });
			else if (!Number.isInteger(cell.index) || cell.index < 0 || cell.index >= this.spec.categories.length) issues.push({ path: `${cell.seriesId}[${cell.index}]`, message: (this.badIndex(cell.index) as { message: string }).message });
			else {
				const value = parseChartValue(cell.value);
				if (value === undefined) issues.push({ path: `${cell.seriesId}[${cell.index}]`, message: `"${String(cell.value)}" is not a number.` });
				else parsed.push({ seriesId: cell.seriesId, index: cell.index, value });
			}
		}
		if (issues.length) return this.reject(issues.map((i) => i.message).join(' '), issues);
		const next = this.edited((d) => {
			for (const cell of parsed) d.series.find((s) => s.id === cell.seriesId)!.values[cell.index] = cell.value;
		});
		if (JSON.stringify(next.series) !== JSON.stringify(this.spec.series)) this.commit(options.label ?? 'Edit values', next);
		return { ok: true };
	}

	/** Adds a series (values padded to the categories) and selects it. Returns its id. */
	addSeries(input: ChartSeriesInput = {}, options: { at?: number } = {}): { ok: true; id: string } | { ok: false; message: string; issues?: ChartIssue[] } {
		const id = input.id && !this.getSeries(input.id) ? input.id : uniqueChartSeriesId(this.spec.series);
		const name = input.name ?? `Series ${this.spec.series.length + 1}`;
		const at = Math.max(0, Math.min(this.spec.series.length, options.at ?? this.spec.series.length));
		const series = [...this.spec.series];
		series.splice(at, 0, { ...input, id, name, values: (input.values ?? []) as ChartValue[] } as unknown as ChartSeries);
		const { spec, issues } = normalizeChartSpec({ ...this.spec, series });
		if (issues.length) return this.reject(issues.map((i) => i.message).join(' '), issues) as { ok: false; message: string };
		this.commit(`Add series "${name}"`, spec, { kind: 'series', seriesId: id });
		return { ok: true, id };
	}

	removeSeries(id: string): ChartActionResult {
		const series = this.getSeries(id);
		if (!series) return this.unknownSeries(id);
		this.commit(
			`Delete series "${series.name}"`,
			this.edited((d) => {
				d.series = d.series.filter((s) => s.id !== id);
			})
		);
		return { ok: true };
	}

	updateSeries(id: string, patch: ChartSeriesPatch): ChartActionResult {
		const series = this.getSeries(id);
		if (!series) return this.unknownSeries(id);
		const next = cloneChartSeries(series);
		if (patch.name !== undefined) next.name = String(patch.name);
		if (patch.color === null || patch.color === '') delete next.color;
		else if (patch.color !== undefined) next.color = patch.color;
		if (patch.type === null) delete next.type;
		else if (patch.type !== undefined) next.type = patch.type;
		if (patch.hidden !== undefined) {
			if (patch.hidden) next.hidden = true;
			else delete next.hidden;
		}
		const resettable = ['axis', 'x', 'sizes', 'pointColors', 'marker', 'curve', 'dataLabels', 'format'] as const;
		for (const key of resettable) {
			if (!(key in patch) || patch[key] === undefined) continue;
			if (patch[key] === null) delete (next as any)[key];
			else (next as any)[key] = patch[key];
		}
		if (next.axis === 'primary') delete next.axis;
		const series2 = this.spec.series.map((s) => (s.id === id ? next : s));
		const { spec, issues } = normalizeChartSpec({ ...this.spec, series: series2 });
		if (issues.length) return this.reject(issues.map((i) => i.message).join(' '), issues);
		if (JSON.stringify(spec.series) === JSON.stringify(this.spec.series)) return { ok: true };
		const label =
			patch.hidden !== undefined && Object.keys(patch).length === 1
				? `${patch.hidden ? 'Hide' : 'Show'} "${series.name}"`
				: patch.name !== undefined && Object.keys(patch).length === 1
					? 'Rename series'
					: `Change series "${series.name}"`;
		this.commit(label, spec);
		return { ok: true };
	}

	toggleSeries(id: string): ChartActionResult {
		const series = this.getSeries(id);
		if (!series) return this.unknownSeries(id);
		return this.updateSeries(id, { hidden: !series.hidden });
	}

	/** Moves a series to position `to` (drawing and legend order). */
	moveSeries(id: string, to: number): ChartActionResult {
		const from = this.spec.series.findIndex((s) => s.id === id);
		if (from < 0) return this.unknownSeries(id);
		const target = Math.max(0, Math.min(this.spec.series.length - 1, to));
		if (target === from) return { ok: true };
		this.commit(
			'Reorder series',
			this.edited((d) => {
				const [s] = d.series.splice(from, 1);
				d.series.splice(target, 0, s);
			})
		);
		return { ok: true };
	}

	/** Inserts a category (with gaps in every series) at `at` (default: the end). Returns its index. */
	addCategory(label?: string, options: { at?: number } = {}): { ok: true; index: number } {
		const at = Math.max(0, Math.min(this.spec.categories.length, options.at ?? this.spec.categories.length));
		const name = label ?? `${this.spec.categories.length + 1}`;
		this.commit(
			`Add category "${name}"`,
			this.edited((d) => {
				d.categories.splice(at, 0, name);
				for (const s of d.series) s.values.splice(at, 0, null);
			}),
			{ kind: 'category', index: at }
		);
		return { ok: true, index: at };
	}

	removeCategory(index: number): ChartActionResult {
		if (!Number.isInteger(index) || index < 0 || index >= this.spec.categories.length) return this.badIndex(index);
		this.commit(
			`Delete category "${this.spec.categories[index]}"`,
			this.edited((d) => {
				d.categories.splice(index, 1);
				for (const s of d.series) s.values.splice(index, 1);
			})
		);
		return { ok: true };
	}

	renameCategory(index: number, label: string): ChartActionResult {
		if (!Number.isInteger(index) || index < 0 || index >= this.spec.categories.length) return this.badIndex(index);
		if (this.spec.categories[index] === label) return { ok: true };
		this.commit(
			'Rename category',
			this.edited((d) => {
				d.categories[index] = String(label);
			})
		);
		return { ok: true };
	}

	moveCategory(from: number, to: number): ChartActionResult {
		if (!Number.isInteger(from) || from < 0 || from >= this.spec.categories.length) return this.badIndex(from);
		const target = Math.max(0, Math.min(this.spec.categories.length - 1, to));
		if (target === from) return { ok: true };
		const move = <T>(list: T[]) => {
			const [item] = list.splice(from, 1);
			list.splice(target, 0, item);
		};
		this.commit(
			'Reorder categories',
			this.edited((d) => {
				move(d.categories);
				for (const s of d.series) move(s.values);
			})
		);
		return { ok: true };
	}

	/**
	 * Pastes a block of cells (TSV / CSV text or rows) into the data grid with its top-left at
	 * `row` (category index) and `column` (series index; `-1` is the category column). The
	 * grid grows to fit. Non-numeric value cells become gaps and are reported in `issues`.
	 */
	pasteCells(row: number, column: number, cells: string | ReadonlyArray<ReadonlyArray<unknown>>): ChartActionResult & { issues?: ChartIssue[] } {
		const rows: unknown[][] = typeof cells === 'string' ? (cells.includes('\t') ? parseTsv(cells) : parseCsv(cells)) : cells.map((r) => [...r]);
		if (!rows.length) return { ok: true };
		const issues: ChartIssue[] = [];
		const next = this.edited((d) => {
			const width = Math.max(...rows.map((r) => r.length));
			const lastSeries = column + width - 1;
			while (d.series.length <= lastSeries) {
				const id = uniqueChartSeriesId(d.series);
				d.series.push({ id, name: `Series ${d.series.length + 1}`, values: d.categories.map(() => null) });
			}
			const lastRow = row + rows.length - 1;
			while (d.categories.length <= lastRow) {
				d.categories.push(`${d.categories.length + 1}`);
				for (const s of d.series) s.values.push(null);
			}
			rows.forEach((cellsInRow, r) => {
				cellsInRow.forEach((cell, c) => {
					const col = column + c;
					const index = row + r;
					if (col < 0) d.categories[index] = cell === null || cell === undefined ? '' : String(cell).trim();
					else {
						const parsed = parseChartValue(cell);
						if (parsed === undefined) issues.push({ path: `${d.series[col].id}[${index}]`, message: `"${String(cell)}" is not a number; it was left blank.` });
						d.series[col].values[index] = parsed ?? null;
					}
				});
			});
		});
		this.commit('Paste cells', next);
		if (issues.length) {
			this.issues = issues;
			this.notify(false);
		}
		return issues.length ? { ok: true, issues } : { ok: true };
	}

	/**
	 * Replaces the data with a grid of cells (see `chartDataFromTable`): one undo step. Series
	 * colours and types are kept by name.
	 */
	importTable(rows: ReadonlyArray<ReadonlyArray<unknown>>, options: ChartTableOptions = {}): ChartActionResult & { issues?: ChartIssue[] } {
		const data = chartDataFromTable(rows, options);
		if (!data.categories.length || !data.series.length) return this.reject('There is no data to import: expected a header row and at least one row of values.');
		const byName = new Map(this.spec.series.map((s) => [s.name, s]));
		const series = data.series.map((s) => {
			const old = byName.get(s.name);
			return { ...s, ...(old?.color ? { color: old.color } : {}), ...(old?.type ? { type: old.type } : {}), ...(old ? { id: old.id } : {}) };
		});
		const { spec } = normalizeChartSpec({ ...this.spec, categories: data.categories, series });
		this.commit('Import data', spec);
		if (data.issues.length) {
			this.issues = data.issues;
			this.notify(false);
			return { ok: true, issues: data.issues };
		}
		return { ok: true };
	}

	/** Imports CSV (or TSV, detected by tabs) text; see `importTable`. */
	importCsv(text: string, options: ChartTableOptions & { delimiter?: string } = {}): ChartActionResult & { issues?: ChartIssue[] } {
		const delimiter = options.delimiter ?? (text.includes('\t') ? '\t' : ',');
		return this.importTable(parseCsv(text, { delimiter }), options);
	}

	// -------------------------------------------------------------------------
	// Trendlines
	// -------------------------------------------------------------------------

	/** Adds a trendline to a series and selects it. Returns its index (and the fit, when it can be computed). */
	addTrendline(seriesId: string, input: ChartTrendline): { ok: true; index: number; fit: ChartTrendFit | null } | { ok: false; message: string; issues?: ChartIssue[] } {
		const series = this.getSeries(seriesId);
		if (!series) return this.unknownSeries(seriesId) as { ok: false; message: string };
		if (!chartSupportsTrendlines(this.spec.type, this.spec.stacking))
			return this.reject(`Trendlines need an unstacked bar, line, area, scatter or bubble chart; this is a ${this.spec.stacking !== 'none' ? `${this.spec.stacking} ` : ''}${this.spec.type} chart.`) as { ok: false; message: string };
		const issues: ChartIssue[] = [];
		const line = normalizeChartTrendline(input, 'trendline', issues);
		if (!line || issues.length) return this.reject(issues.map((i) => i.message).join(' ') || 'The trendline is not valid.', issues) as { ok: false; message: string };
		const index = series.trendlines?.length ?? 0;
		const next = this.edited((d) => {
			const s = d.series.find((x) => x.id === seriesId)!;
			s.trendlines = [...(s.trendlines ?? []), line];
		});
		this.commit(`Add trendline to "${series.name}"`, next, { kind: 'trendline', seriesId, index });
		return { ok: true, index, fit: this.trendlineFit(seriesId, index) };
	}

	/** Changes a trendline (all-or-nothing). */
	updateTrendline(seriesId: string, index: number, patch: Partial<ChartTrendline>): ChartActionResult {
		const series = this.getSeries(seriesId);
		if (!series) return this.unknownSeries(seriesId);
		const current = series.trendlines?.[index];
		if (!current) return fail(`"${series.name}" has no trendline ${index}; ${series.trendlines?.length ? `expected 0 to ${series.trendlines.length - 1}` : 'it has none yet'}.`);
		const issues: ChartIssue[] = [];
		const merged: Record<string, unknown> = { ...current, ...patch };
		for (const [k, v] of Object.entries(patch)) if (v === null) delete merged[k];
		const line = normalizeChartTrendline(merged, 'trendline', issues);
		if (!line || issues.length) return this.reject(issues.map((i) => i.message).join(' '), issues);
		this.commit(
			'Change trendline',
			this.edited((d) => {
				d.series.find((x) => x.id === seriesId)!.trendlines![index] = line;
			})
		);
		return { ok: true };
	}

	removeTrendline(seriesId: string, index: number): ChartActionResult {
		const series = this.getSeries(seriesId);
		if (!series) return this.unknownSeries(seriesId);
		if (!series.trendlines?.[index]) return fail(`"${series.name}" has no trendline ${index}.`);
		this.commit(
			'Delete trendline',
			this.edited((d) => {
				const s = d.series.find((x) => x.id === seriesId)!;
				s.trendlines = s.trendlines!.filter((_, i) => i !== index);
				if (!s.trendlines.length) delete s.trendlines;
			})
		);
		return { ok: true };
	}

	/** The points a series' trendlines are fitted to: (x, y) with x = 1, 2, 3 … on category charts. */
	trendlinePoints(seriesId: string): [number, number][] {
		const series = this.getSeries(seriesId);
		if (!series) return [];
		const xy = chartFamily(this.spec) === 'xy';
		const out: [number, number][] = [];
		series.values.forEach((v, i) => {
			const x = xy ? (series.x?.[i] ?? (this.spec.type === 'bubble' ? i + 1 : null)) : i + 1;
			if (v !== null && x !== null && Number.isFinite(v) && Number.isFinite(x)) out.push([x, v]);
		});
		return out;
	}

	/** The fitted coefficients, R² and equation of a trendline (null for moving averages or unfittable data). */
	trendlineFit(seriesId: string, index: number): ChartTrendFit | null {
		const line = this.getSeries(seriesId)?.trendlines?.[index];
		if (!line) return null;
		return fitChartTrendline(line, this.trendlinePoints(seriesId));
	}

	/** The moving-average points of a trendline (empty for other kinds). */
	trendlineMovingAverage(seriesId: string, index: number): [number, number][] {
		const line = this.getSeries(seriesId)?.trendlines?.[index];
		if (!line || line.type !== 'moving-average') return [];
		return chartMovingAverage(this.trendlinePoints(seriesId), line.period ?? 2);
	}

	// -------------------------------------------------------------------------
	// Reshaping
	// -------------------------------------------------------------------------

	/**
	 * Switches rows and columns: series become categories and categories become series (one
	 * undo step). Series colours, types and other per-series settings are dropped.
	 */
	transpose(): ChartActionResult {
		const s = this.spec;
		if (!s.series.length || !s.categories.length) return this.reject('There is no data to switch: the chart needs at least one series and one category.');
		const used = new Set<string>();
		const series: ChartSeries[] = s.categories.map((name, i) => {
			let id = `series-${i + 1}`;
			for (let k = i + 2; used.has(id); k++) id = `series-${k}`;
			used.add(id);
			return { id, name, values: s.series.map((x) => x.values[i] ?? null) };
		});
		const { spec } = normalizeChartSpec({ ...s, categories: s.series.map((x) => x.name), series });
		this.commit('Switch rows and columns', spec, null);
		return { ok: true };
	}

	// -------------------------------------------------------------------------
	// Selection and gestures
	// -------------------------------------------------------------------------

	/** Selects a chart element (view state; not an undo step). */
	select(selection: ChartSelection | null): void {
		const next = this.validSelection(selection, this.spec);
		if (sameChartSelection(next, this.selection) || (next === null && this.selection === null)) return;
		this.selection = next;
		this.notify(false);
	}

	/**
	 * Deletes what is selected: a series or category is removed, a point becomes a gap, a
	 * title is cleared, the legend or an axis is hidden.
	 */
	deleteSelection(): ChartActionResult {
		const sel = this.selection;
		if (!sel) return fail('Nothing is selected.');
		switch (sel.kind) {
			case 'series':
				return this.removeSeries(sel.seriesId);
			case 'category':
				return this.removeCategory(sel.index);
			case 'point':
				return this.setValue(sel.seriesId, sel.index, null, { label: 'Clear value' });
			case 'title':
				return this.setTitle('');
			case 'subtitle':
				return this.setSubtitle('');
			case 'legend':
				return this.setLegend({ show: false });
			case 'axis':
				return this.setAxis(sel.axis, { show: false });
			case 'trendline':
				return this.removeTrendline(sel.seriesId, sel.index);
			default:
				return fail('The chart itself cannot be deleted.');
		}
	}

	/** Adds `delta` to a value (a gap counts as 0). */
	nudgeValue(seriesId: string, index: number, delta: number): ChartActionResult {
		const series = this.getSeries(seriesId);
		if (!series) return this.unknownSeries(seriesId);
		const current = series.values[index] ?? 0;
		return this.setValue(seriesId, index, Number((current + delta).toPrecision(12)), { label: `Edit ${series.name} · ${this.spec.categories[index] ?? index}` });
	}

	/** Starts a continuous edit (a drag): every change until `endGesture()` is one undo step. */
	beginGesture(key: string): void {
		if (this.gestureKey === key) return;
		this.history.endGesture();
		this.gestureKey = key;
		this.gestureCount++;
		this.gestureStart = { spec: this.spec, mark: this.history.mark() };
		this.notify(false);
	}

	/**
	 * Cancels the gesture in progress (Escape during a drag): everything it changed is taken
	 * back and leaves no undo or redo step.
	 */
	cancelGesture(): void {
		if (this.gestureKey === null) return;
		const start = this.gestureStart;
		this.gestureKey = null;
		this.gestureStart = null;
		this.history.endGesture();
		if (start) this.history.revertTo(start.mark);
		this.notify(false);
	}

	endGesture(): void {
		if (this.gestureKey === null) return;
		this.gestureKey = null;
		this.history.endGesture();
		// A drag that ends where it started leaves no undo step behind.
		const start = this.gestureStart;
		this.gestureStart = null;
		if (start && sameChartJson(start.spec, this.spec)) this.history.revertTo(start.mark);
		this.notify(false);
	}

	// -------------------------------------------------------------------------
	// Persistence and history
	// -------------------------------------------------------------------------

	/** The spec, for saving (a copy). */
	toJSON(): ChartSpec {
		return cloneChartSpec(this.spec);
	}

	/**
	 * Replaces the chart without an undo step (e.g. when opening a document). Problems are
	 * fixed with defaults and reported in `state.issues` (and returned).
	 */
	load(input: unknown, options: { clearHistory?: boolean } = {}): ChartIssue[] {
		const { spec, issues } = normalizeChartSpec(input);
		this.spec = spec;
		this.issues = issues;
		this.selection = this.validSelection(this.selection, spec);
		if (options.clearHistory) {
			this.applying = true;
			try {
				this.history.clear();
			} finally {
				this.applying = false;
			}
		}
		this.notify(true);
		return issues;
	}

	undo(): boolean {
		this.endGesture();
		return this.history.undo();
	}

	redo(): boolean {
		this.endGesture();
		return this.history.redo();
	}

	/** Stops listening to the history (reconnected by the next `subscribe`). */
	destroy(): void {
		this.unsubscribeHistory?.();
		this.unsubscribeHistory = undefined;
		this.listeners.clear();
	}
}

export function createChartController(options: ChartControllerOptions = {}): ChartController {
	return new ChartController(options);
}

function updateLabel(patch: ChartSpecPatch): string {
	const keys = Object.keys(patch);
	if (keys.length !== 1) return 'Change chart';
	const labels: Record<string, string> = {
		type: 'Change chart type',
		title: 'Edit title',
		subtitle: 'Edit subtitle',
		categories: 'Edit categories',
		series: 'Edit series',
		xAxis: 'Change category axis',
		yAxis: 'Change value axis',
		yAxis2: 'Change secondary value axis',
		labelPosition: 'Change label position',
		gapWidth: 'Change bar spacing',
		overlap: 'Change bar overlap',
		bins: 'Change histogram bins',
		showTotal: 'Toggle waterfall total',
		legend: 'Change legend',
		stacking: 'Change stacking',
		orientation: 'Change orientation',
		curve: 'Change line style',
		points: 'Toggle points',
		dataLabels: 'Toggle data labels',
		palette: 'Change colours',
		innerRadius: 'Change donut hole'
	};
	return labels[keys[0]] ?? 'Change chart';
}
