import { HistoryManager } from '../history/HistoryManager.js';
import type { Command, HistoryState } from '../history/types.js';
import { findParameterKeyframe, getParameterKeyState, PARAMETER_KEY_TOLERANCE, withoutParameterKeyframe, withParameterKeyframe } from './keyframes.js';
import {
	checkParameterSchema,
	cloneValue,
	coerceParameterValue,
	getChoiceOptions,
	getParameterDefaults,
	getParameterFields,
	getParameterGroups,
	getParameterVisibility,
	normalizeHexColor,
	ParameterSchemaError,
	parameterLabel,
	parameterStep,
	parameterValuesEqual,
	vectorComponentField,
	vectorSize
} from './schema.js';
import type {
	ParameterError,
	ParameterField,
	ParameterKeyframes,
	ParameterKeyState,
	ParameterPreset,
	ParameterSchema,
	ParameterTrack,
	ParameterValue,
	ParameterValues
} from './types.js';

export interface ParametersControllerOptions {
	schema: ParameterSchema;
	/** Starting values (missing or invalid ones use the default; invalid ones are reported in `errors`). */
	values?: Partial<ParameterValues>;
	/** User presets (the schema's presets are added as built-in). */
	presets?: readonly ParameterPreset[];
	/** History to record into, e.g. one shared with the rest of the app (default: a new one). */
	history?: HistoryManager;
	/** Where keyframes live. Without it, keyframe methods do nothing. */
	keyframes?: ParameterKeyframes;
	/** Starting playhead time in ms (default 0). */
	time?: number;
	/** Keys within this many ms of the playhead count as "at" it (default 0.5). */
	keyTolerance?: number;
	/** Random source for `randomize` (default `Math.random`). */
	random?: () => number;
	/** Called after values change (set, undo, preset, load, …) with the ids that changed. */
	onChange?: (values: Readonly<ParameterValues>, changed: readonly string[]) => void;
}

/** A snapshot of the controller. The same object is returned until something changes. */
export interface ParametersState {
	schema: ParameterSchema;
	/** Every field in schema order (groups flattened). */
	fields: readonly ParameterField[];
	values: Readonly<ParameterValues>;
	defaults: Readonly<ParameterValues>;
	/** Field and group id → shown (see `showIf`). */
	visible: Readonly<Record<string, boolean>>;
	/** Group id → collapsed. */
	collapsed: Readonly<Record<string, boolean>>;
	/** Field id → the last rejected value's error (cleared when the field is next set). */
	errors: Readonly<Record<string, string>>;
	/** Built-in presets first, then user presets. */
	presets: readonly ParameterPreset[];
	/** The first preset whose values match the current values, if any. */
	activePreset: string | null;
	/** Any value differs from its default. */
	modified: boolean;
	/** Playhead time in ms (for keyframes). */
	time: number;
	/** Whether a keyframes adapter is attached. */
	keyframesEnabled: boolean;
	/** Field id → keyframe state at `time`. */
	keys: Readonly<Record<string, ParameterKeyState>>;
	/** The gesture in progress (a field id), if any. */
	gesture: string | null;
	canUndo: boolean;
	canRedo: boolean;
	undoLabel: string;
	redoLabel: string;
	/** Bumped on every change. */
	revision: number;
}

export type ParameterSetResult = { ok: true; value: ParameterValue } | { ok: false; error: ParameterError; message: string };

export type ParameterSetValuesResult =
	| { ok: true; values: Partial<ParameterValues>; changed: string[] }
	| { ok: false; errors: ParameterError[]; message: string };

export type ParameterActionResult = { ok: true } | { ok: false; message: string };

export interface SetParameterOptions {
	/** Undo step label (default "Change <label>"). */
	label?: string;
}

export interface RandomizeParametersOptions {
	/** Only these fields (default: every visible field that allows it). */
	ids?: readonly string[];
	/** Seed for a repeatable result. */
	seed?: number;
	/** Random source (default: the controller's). */
	random?: () => number;
}

export interface ApplyPresetOptions {
	/** Keep values the preset leaves out (default: they go back to their defaults). */
	merge?: boolean;
}

/** What `toJSON` returns and `load` takes. */
export interface ParametersSnapshot {
	values: Partial<ParameterValues>;
	/** User presets. */
	presets?: ParameterPreset[];
}

interface Change {
	values?: { before: Partial<ParameterValues>; after: Partial<ParameterValues> };
	presets?: { before: ParameterPreset[]; after: ParameterPreset[] };
	tracks?: Record<string, { before: ParameterTrack | undefined; after: ParameterTrack | undefined }>;
}

/** A repeatable random source (mulberry32). */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const unknownMessage = (id: string, fields: readonly ParameterField[]) =>
	`There is no parameter "${id}"; expected one of ${fields.map((f) => `"${f.id}"`).join(', ')}.`;

/**
 * Headless state for a parameters panel: values with validation, undo (slider drags merge
 * into one step), reset, randomize, presets and optional keyframe hooks. `getState()` returns
 * the same object until something changes, so it works with `useSyncExternalStore`.
 */
export class ParametersController {
	readonly history: HistoryManager;
	private schema: ParameterSchema;
	private fields: ParameterField[] = [];
	private fieldMap = new Map<string, ParameterField>();
	private defaults: ParameterValues = {};
	private values: ParameterValues = {};
	private userPresets: ParameterPreset[];
	private collapsed: Record<string, boolean> = {};
	private errors: Record<string, string> = {};
	private time: number;
	private keyframes?: ParameterKeyframes;
	private readonly keyTolerance: number;
	private readonly random: () => number;
	private readonly onChange?: ParametersControllerOptions['onChange'];
	private readonly listeners = new Set<(state: ParametersState) => void>();
	private readonly cleanups: Array<() => void> = [];
	private gestureId: string | null = null;
	private gestureCount = 0;
	private revision = 0;
	private applying = false;
	private state!: ParametersState;

	constructor(options: ParametersControllerOptions) {
		this.history = options.history ?? new HistoryManager();
		this.schema = options.schema;
		this.userPresets = (options.presets ?? []).map((p) => ({ ...p, values: { ...p.values }, builtIn: false }));
		this.time = options.time ?? 0;
		this.keyframes = options.keyframes;
		this.keyTolerance = options.keyTolerance ?? PARAMETER_KEY_TOLERANCE;
		this.random = options.random ?? Math.random;
		this.onChange = options.onChange;
		this.indexSchema(options.schema);
		for (const group of getParameterGroups(this.schema)) if (group.collapsed) this.collapsed[group.id] = true;
		this.values = this.adopt(options.values ?? {}, this.defaults);
		this.state = this.computeState();
		this.cleanups.push(
			this.history.subscribe((h) => {
				// Edits notify as they apply; only re-notify when the undo/redo state moved on.
				const s = this.state;
				if (this.applying || (s.canUndo === h.canUndo && s.canRedo === h.canRedo && s.undoLabel === h.undoName && s.redoLabel === h.redoName)) return;
				this.notify();
			})
		);
		this.watchKeyframes();
	}

	private unwatchKeyframes?: () => void;

	private watchKeyframes() {
		this.unwatchKeyframes?.();
		this.unwatchKeyframes = this.keyframes?.subscribe?.(() => {
			if (!this.applying) this.notify();
		});
	}

	// -------------------------------------------------------------------------
	// State
	// -------------------------------------------------------------------------

	/** The current snapshot (stable until the next change). */
	getState = (): ParametersState => this.state;

	/** Calls `listener` after every change. Returns an unsubscribe function. */
	subscribe = (listener: (state: ParametersState) => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSchema(): ParameterSchema {
		return this.schema;
	}

	getField(id: string): ParameterField | undefined {
		return this.fieldMap.get(id);
	}

	getValue(id: string): ParameterValue | undefined {
		return this.values[id];
	}

	getValues(): Readonly<ParameterValues> {
		return this.values;
	}

	private indexSchema(schema: ParameterSchema) {
		const problems = checkParameterSchema(schema);
		if (problems.length) throw new ParameterSchemaError(problems.join(' '));
		this.fields = getParameterFields(schema);
		this.fieldMap = new Map(this.fields.map((f) => [f.id, f]));
		this.defaults = getParameterDefaults(schema);
	}

	/** Values for every field: valid entries of `values`, else `fallback`. Invalid ones are reported. */
	private adopt(values: Partial<ParameterValues>, fallback: ParameterValues): ParameterValues {
		const out: ParameterValues = {};
		for (const field of this.fields) {
			const raw = values[field.id];
			if (raw === undefined) {
				out[field.id] = cloneValue(fallback[field.id] ?? field.default);
				continue;
			}
			const result = coerceParameterValue(field, raw);
			if (result.ok) out[field.id] = result.value;
			else {
				out[field.id] = cloneValue(fallback[field.id] ?? field.default);
				this.errors = { ...this.errors, [field.id]: result.error.message };
			}
		}
		return out;
	}

	private allPresets(): ParameterPreset[] {
		const builtIn = (this.schema.presets ?? []).map((p) => ({ ...p, builtIn: true }));
		const names = new Set(builtIn.map((p) => p.name));
		return [...builtIn, ...this.userPresets.filter((p) => !names.has(p.name))];
	}

	private presetValues(preset: ParameterPreset, base: ParameterValues): ParameterValues {
		const out: ParameterValues = { ...base };
		for (const field of this.fields) {
			const raw = preset.values[field.id];
			if (raw === undefined) continue;
			const result = coerceParameterValue(field, raw);
			if (result.ok) out[field.id] = result.value;
		}
		return out;
	}

	private computeState(): ParametersState {
		const history: HistoryState = this.history.getState();
		const presets = this.allPresets();
		const keys: Record<string, ParameterKeyState> = {};
		if (this.keyframes) {
			for (const field of this.fields) keys[field.id] = getParameterKeyState(this.keyframes.getTrack(field.id), this.time, this.keyTolerance);
		}
		const same = (a: ParameterValues) => this.fields.every((f) => parameterValuesEqual(a[f.id], this.values[f.id]));
		return {
			schema: this.schema,
			fields: this.fields,
			values: this.values,
			defaults: this.defaults,
			visible: getParameterVisibility(this.schema, this.values),
			collapsed: this.collapsed,
			errors: this.errors,
			presets,
			activePreset: presets.find((p) => same(this.presetValues(p, this.defaults)))?.name ?? null,
			modified: !same(this.defaults),
			time: this.time,
			keyframesEnabled: !!this.keyframes,
			keys,
			gesture: this.gestureId,
			canUndo: history.canUndo,
			canRedo: history.canRedo,
			undoLabel: history.undoName,
			redoLabel: history.redoName,
			revision: this.revision
		};
	}

	private notify(changed: readonly string[] = []) {
		this.revision++;
		this.state = this.computeState();
		if (changed.length) this.onChange?.(this.values, changed);
		const state = this.state;
		this.listeners.forEach((listener) => {
			try {
				listener(state);
			} catch (error) {
				console.error('[ParametersController] Error in state listener:', error);
			}
		});
	}

	// -------------------------------------------------------------------------
	// Changes (all edits go through one undoable command shape)
	// -------------------------------------------------------------------------

	private apply(change: Change, side: 'before' | 'after') {
		const changed: string[] = [];
		this.applying = true;
		try {
			if (change.values) {
				const patch = change.values[side];
				const next = { ...this.values };
				for (const [id, value] of Object.entries(patch)) {
					if (!this.fieldMap.has(id) || value === undefined) continue;
					next[id] = cloneValue(value);
					changed.push(id);
					if (id in this.errors) {
						const { [id]: _, ...rest } = this.errors;
						this.errors = rest;
					}
				}
				this.values = next;
			}
			if (change.presets) this.userPresets = change.presets[side].map((p) => ({ ...p }));
			if (change.tracks && this.keyframes) {
				for (const [id, t] of Object.entries(change.tracks)) this.keyframes.setTrack(id, t[side]);
			}
		} finally {
			this.applying = false;
		}
		this.notify(changed);
	}

	private command(name: string, change: Change, tag?: string): Command {
		return {
			name,
			tag,
			execute: () => this.apply(change, 'after'),
			undo: () => this.apply(change, 'before'),
			redo: () => this.apply(change, 'after')
		};
	}

	/** Track updates that keep keys at the playhead in step with new values. */
	private keyUpdates(after: Partial<ParameterValues>): Change['tracks'] {
		if (!this.keyframes) return undefined;
		let tracks: Change['tracks'];
		for (const [id, value] of Object.entries(after)) {
			const track = this.keyframes.getTrack(id);
			if (value === undefined || findParameterKeyframe(track, this.time, this.keyTolerance) < 0) continue;
			(tracks ??= {})[id] = { before: track, after: withParameterKeyframe(track, { time: this.time, value }, this.keyTolerance) };
		}
		return tracks;
	}

	private record(name: string, after: Partial<ParameterValues>, extra: Omit<Change, 'values'> = {}) {
		const before: Partial<ParameterValues> = {};
		for (const id of Object.keys(after)) before[id] = cloneValue(this.values[id]);
		const tracks = { ...(this.keyUpdates(after) ?? {}), ...(extra.tracks ?? {}) };
		const change: Change = { values: { before, after }, ...extra, ...(Object.keys(tracks).length ? { tracks } : {}) };
		this.history.execute(this.command(name, change));
	}

	private reject(errors: ParameterError[]) {
		const next = { ...this.errors };
		for (const e of errors) next[e.id] = e.message;
		this.errors = next;
		this.notify();
	}

	/** Only the entries of `values` that differ from the current values. */
	private diff(values: Partial<ParameterValues>): Partial<ParameterValues> {
		const out: Partial<ParameterValues> = {};
		for (const [id, value] of Object.entries(values)) {
			if (value !== undefined && !parameterValuesEqual(this.values[id], value)) out[id] = value;
		}
		return out;
	}

	private clearErrors(ids: readonly string[]) {
		if (!ids.some((id) => id in this.errors)) return false;
		const next = { ...this.errors };
		for (const id of ids) delete next[id];
		this.errors = next;
		return true;
	}

	/**
	 * Sets one value after validating it (`int`s round, colours normalise). Invalid values are
	 * not stored; the error is returned and shown in `state.errors`. One undo step, or part of
	 * the current gesture (see `beginGesture`).
	 */
	setValue(id: string, value: unknown, options: SetParameterOptions = {}): ParameterSetResult {
		const field = this.fieldMap.get(id);
		if (!field) {
			const message = unknownMessage(id, this.fields);
			return { ok: false, error: { id, path: `/${id}`, message }, message };
		}
		const result = coerceParameterValue(field, value);
		if (!result.ok) {
			this.reject([result.error]);
			return { ok: false, error: result.error, message: result.error.message };
		}
		if (parameterValuesEqual(this.values[id], result.value)) {
			if (this.clearErrors([id])) this.notify();
			return { ok: true, value: result.value };
		}
		const name = options.label ?? `Change ${parameterLabel(field)}`;
		if (this.gestureId !== null) {
			const after = { [id]: result.value };
			const before = { [id]: cloneValue(this.values[id]) };
			const tracks = this.keyUpdates(after);
			const change: Change = { values: { before, after }, ...(tracks ? { tracks } : {}) };
			this.history.executeMerged(this.command(name, change, `parameters.set:${id}`), {
				key: `parameters.gesture:${this.gestureId}:${this.gestureCount}`
			});
		} else {
			this.record(name, { [id]: result.value });
		}
		return { ok: true, value: result.value };
	}

	/**
	 * Sets several values as one undo step. All-or-nothing: if any id is unknown or any value
	 * invalid, nothing changes and every error is returned.
	 */
	setValues(values: Partial<ParameterValues> | Record<string, unknown>, options: SetParameterOptions = {}): ParameterSetValuesResult {
		const errors: ParameterError[] = [];
		const coerced: Partial<ParameterValues> = {};
		for (const [id, raw] of Object.entries(values)) {
			if (raw === undefined) continue;
			const field = this.fieldMap.get(id);
			if (!field) {
				errors.push({ id, path: `/${id}`, message: unknownMessage(id, this.fields) });
				continue;
			}
			const result = coerceParameterValue(field, raw);
			if (result.ok) coerced[id] = result.value;
			else errors.push(result.error);
		}
		if (errors.length) {
			this.reject(errors.filter((e) => this.fieldMap.has(e.id)));
			return { ok: false, errors, message: errors.map((e) => e.message).join(' ') };
		}
		const after = this.diff(coerced);
		const changed = Object.keys(after);
		if (changed.length) {
			const label = options.label ?? (changed.length === 1 ? `Change ${parameterLabel(this.fieldMap.get(changed[0])!)}` : 'Change parameters');
			this.record(label, after);
		} else if (this.clearErrors(Object.keys(coerced))) this.notify();
		return { ok: true, values: coerced, changed };
	}

	/**
	 * Starts a continuous edit of `id` (a slider drag): every `setValue` until `endGesture()`
	 * merges into one undo step.
	 */
	beginGesture(id: string): void {
		if (this.gestureId === id) return;
		this.history.endGesture();
		this.gestureId = id;
		this.gestureCount++;
		this.notify();
	}

	/** Ends the current gesture; the next change is a new undo step. */
	endGesture(): void {
		if (this.gestureId === null) return;
		this.gestureId = null;
		this.history.endGesture();
		this.notify();
	}

	/** Puts fields (default: all) back to their defaults as one undo step. */
	reset(ids?: readonly string[]): ParameterActionResult {
		const targets = ids ?? this.fields.map((f) => f.id);
		const unknown = targets.find((id) => !this.fieldMap.has(id));
		if (unknown) return { ok: false, message: unknownMessage(unknown, this.fields) };
		const after = this.diff(Object.fromEntries(targets.map((id) => [id, cloneValue(this.defaults[id])])));
		const changed = Object.keys(after);
		if (changed.length) {
			const label = ids && changed.length === 1 ? `Reset ${parameterLabel(this.fieldMap.get(changed[0])!)}` : 'Reset parameters';
			this.record(label, after);
		} else if (this.clearErrors(targets)) this.notify();
		return { ok: true };
	}

	/**
	 * Picks random values within each field's range, snapped to its step, as one undo step.
	 * Skips hidden fields, `randomize: false`, `readOnly`, image and text fields, and numbers
	 * without both `min` and `max`.
	 */
	randomize(options: RandomizeParametersOptions = {}): ParameterSetValuesResult {
		const rand = options.random ?? (options.seed !== undefined ? seededRandom(options.seed) : this.random);
		const visible = this.state.visible;
		const explicit = options.ids !== undefined;
		const errors: ParameterError[] = [];
		const after: Partial<ParameterValues> = {};
		for (const id of options.ids ?? this.fields.map((f) => f.id)) {
			const field = this.fieldMap.get(id);
			if (!field) {
				errors.push({ id, path: `/${id}`, message: unknownMessage(id, this.fields) });
				continue;
			}
			if (!explicit && (!visible[id] || field.randomize === false || field.readOnly)) continue;
			const value = randomValue(field, this.values[id], rand);
			if (value !== undefined) after[id] = value;
		}
		if (errors.length) return { ok: false, errors, message: errors.map((e) => e.message).join(' ') };
		const diff = this.diff(after);
		const changed = Object.keys(diff);
		if (changed.length) this.record('Randomize parameters', diff);
		return { ok: true, values: after, changed };
	}

	// -------------------------------------------------------------------------
	// Presets
	// -------------------------------------------------------------------------

	/** Applies a preset as one undo step. Fields it leaves out return to their defaults unless `merge`. */
	applyPreset(name: string, options: ApplyPresetOptions = {}): ParameterActionResult {
		const preset = this.allPresets().find((p) => p.name === name);
		if (!preset) return { ok: false, message: this.unknownPreset(name) };
		const target = this.presetValues(preset, options.merge ? this.values : this.defaults);
		const after = this.diff(target);
		if (Object.keys(after).length) this.record(`Apply preset "${name}"`, after);
		return { ok: true };
	}

	/** Saves the current values (all fields) as a user preset, replacing one with the same name. Undoable. */
	savePreset(name: string, options: { description?: string } = {}): ParameterActionResult {
		const trimmed = name.trim();
		if (!trimmed) return { ok: false, message: 'A preset needs a name.' };
		if ((this.schema.presets ?? []).some((p) => p.name === trimmed)) {
			return { ok: false, message: `"${trimmed}" is a built-in preset; save under another name.` };
		}
		const preset: ParameterPreset = { name: trimmed, values: Object.fromEntries(this.fields.map((f) => [f.id, cloneValue(this.values[f.id])])) };
		if (options.description) preset.description = options.description;
		const before = this.userPresets;
		const at = before.findIndex((p) => p.name === trimmed);
		const after = at >= 0 ? before.map((p, i) => (i === at ? preset : p)) : [...before, preset];
		this.history.execute(this.command(`Save preset "${trimmed}"`, { presets: { before, after } }));
		return { ok: true };
	}

	/** Deletes a user preset (built-in presets cannot be deleted). Undoable. */
	deletePreset(name: string): ParameterActionResult {
		if ((this.schema.presets ?? []).some((p) => p.name === name)) {
			return { ok: false, message: `"${name}" is a built-in preset and cannot be deleted.` };
		}
		const before = this.userPresets;
		if (!before.some((p) => p.name === name)) return { ok: false, message: this.unknownPreset(name) };
		const after = before.filter((p) => p.name !== name);
		this.history.execute(this.command(`Delete preset "${name}"`, { presets: { before, after } }));
		return { ok: true };
	}

	private unknownPreset(name: string) {
		const names = this.allPresets().map((p) => `"${p.name}"`);
		return `There is no preset "${name}"; ${names.length ? `expected one of ${names.join(', ')}` : 'none are saved yet'}.`;
	}

	// -------------------------------------------------------------------------
	// Keyframes
	// -------------------------------------------------------------------------

	/** Moves the playhead. `values` (e.g. evaluated from the tracks) are shown without an undo step. */
	setTime(time: number, values?: Partial<ParameterValues>): void {
		const t = Number.isFinite(time) ? Math.max(0, time) : 0;
		const changed: string[] = [];
		if (values) {
			const next = { ...this.values };
			for (const [id, raw] of Object.entries(values)) {
				const field = this.fieldMap.get(id);
				if (!field || raw === undefined) continue;
				const result = coerceParameterValue(field, raw);
				if (result.ok && !parameterValuesEqual(next[id], result.value)) {
					next[id] = result.value;
					changed.push(id);
				}
			}
			this.values = next;
		}
		if (t === this.time && changed.length === 0) return;
		this.time = t;
		this.notify(changed);
	}

	/** `keyed`, `animated` or `none` for a field at `time` (default: the playhead). */
	keyState(id: string, time = this.time): ParameterKeyState {
		if (!this.keyframes) return 'none';
		return getParameterKeyState(this.keyframes.getTrack(id), time, this.keyTolerance);
	}

	/** Attaches (or with `undefined` detaches) a keyframes adapter. */
	setKeyframes(keyframes: ParameterKeyframes | undefined): void {
		this.keyframes = keyframes;
		this.watchKeyframes();
		this.notify();
	}

	/**
	 * Adds a keyframe with the field's current value at `time` (default: the playhead), or
	 * removes the one already there. One undo step.
	 */
	toggleKeyframe(id: string, time = this.time): { ok: true; keyed: boolean } | { ok: false; message: string } {
		if (!this.keyframes) return { ok: false, message: 'Keyframes are not available here.' };
		const field = this.fieldMap.get(id);
		if (!field) return { ok: false, message: unknownMessage(id, this.fields) };
		const before = this.keyframes.getTrack(id);
		const keyed = findParameterKeyframe(before, time, this.keyTolerance) >= 0;
		const after = keyed
			? withoutParameterKeyframe(before, time, this.keyTolerance)
			: withParameterKeyframe(before, { time, value: cloneValue(this.values[id]) }, this.keyTolerance);
		const label = `${keyed ? 'Remove keyframe from' : 'Add keyframe to'} ${parameterLabel(field)}`;
		this.history.execute(this.command(label, { tracks: { [id]: { before, after } } }));
		return { ok: true, keyed: !keyed };
	}

	// -------------------------------------------------------------------------
	// Groups, schema, persistence, history
	// -------------------------------------------------------------------------

	/** Collapses or expands a group (view state; not an undo step). */
	setCollapsed(groupId: string, collapsed: boolean): void {
		if (!!this.collapsed[groupId] === collapsed) return;
		const next = { ...this.collapsed };
		if (collapsed) next[groupId] = true;
		else delete next[groupId];
		this.collapsed = next;
		this.notify();
	}

	toggleCollapsed(groupId: string): void {
		this.setCollapsed(groupId, !this.collapsed[groupId]);
	}

	/**
	 * Replaces the schema (e.g. after a shader recompiles). Values that still fit their field
	 * are kept; others reset to the new default. Not an undo step; throws a
	 * `ParameterSchemaError` for an invalid schema.
	 */
	setSchema(schema: ParameterSchema): void {
		const old = this.values;
		this.indexSchema(schema);
		this.schema = schema;
		const kept: ParameterValues = {};
		for (const field of this.fields) {
			const result = old[field.id] === undefined ? null : coerceParameterValue(field, old[field.id]);
			kept[field.id] = result?.ok ? result.value : cloneValue(this.defaults[field.id]);
		}
		const changed = this.fields.filter((f) => !parameterValuesEqual(old[f.id], kept[f.id])).map((f) => f.id);
		this.values = kept;
		this.errors = Object.fromEntries(Object.entries(this.errors).filter(([id]) => this.fieldMap.has(id)));
		for (const group of getParameterGroups(schema)) if (group.collapsed && !(group.id in this.collapsed)) this.collapsed[group.id] = true;
		this.collapsed = { ...this.collapsed };
		this.notify(changed);
	}

	/** Values and user presets, for saving. */
	toJSON(): ParametersSnapshot {
		return {
			values: Object.fromEntries(this.fields.map((f) => [f.id, cloneValue(this.values[f.id])])),
			presets: this.userPresets.map(({ builtIn: _, ...p }) => ({ ...p, values: { ...p.values } }))
		};
	}

	/**
	 * Replaces values (and user presets, when given) without an undo step, e.g. when opening a
	 * document. Missing values use defaults; invalid ones use defaults and are reported in
	 * `state.errors`. Clears the history when `clearHistory` is true.
	 */
	load(snapshot: ParametersSnapshot, options: { clearHistory?: boolean } = {}): void {
		const old = this.values;
		this.errors = {};
		this.values = this.adopt(snapshot.values ?? {}, this.defaults);
		if (snapshot.presets) this.userPresets = snapshot.presets.map((p) => ({ ...p, values: { ...p.values }, builtIn: false }));
		const changed = this.fields.filter((f) => !parameterValuesEqual(old[f.id], this.values[f.id])).map((f) => f.id);
		if (options.clearHistory) {
			this.applying = true;
			try {
				this.history.clear();
			} finally {
				this.applying = false;
			}
		}
		this.notify(changed);
	}

	undo(): boolean {
		this.endGesture();
		return this.history.undo();
	}

	redo(): boolean {
		this.endGesture();
		return this.history.redo();
	}

	/** Stops listening to the history and keyframes adapter. */
	destroy(): void {
		this.cleanups.splice(0).forEach((fn) => fn());
		this.unwatchKeyframes?.();
		this.unwatchKeyframes = undefined;
		this.listeners.clear();
	}
}

export function createParametersController(options: ParametersControllerOptions): ParametersController {
	return new ParametersController(options);
}

function randomNumber(rand: () => number, min: number, max: number, step: number, int: boolean): number {
	const raw = min + rand() * (max - min);
	const snapped = step > 0 ? min + Math.round((raw - min) / step) * step : raw;
	const v = Math.min(max, Math.max(min, snapped));
	return int ? Math.round(v) : Math.round(v * 1e6) / 1e6;
}

/** A random value for a field, or `undefined` when it cannot be randomised. */
function randomValue(field: ParameterField, current: ParameterValue | undefined, rand: () => number): ParameterValue | undefined {
	switch (field.type) {
		case 'number':
		case 'int':
			if (field.min === undefined || field.max === undefined) return undefined;
			return randomNumber(rand, field.min, field.max, parameterStep(field), field.type === 'int');
		case 'boolean':
			return rand() < 0.5;
		case 'choice': {
			const options = getChoiceOptions(field);
			return options[Math.min(options.length - 1, Math.floor(rand() * options.length))].value;
		}
		case 'color': {
			const rgb = Array.from({ length: 3 }, () => Math.floor(rand() * 256).toString(16).padStart(2, '0')).join('');
			const alpha = field.alpha ? (normalizeHexColor(String(current ?? field.default), true) ?? '#000000ff').slice(7) : '';
			return `#${rgb}${alpha}`;
		}
		case 'vector': {
			const out: number[] = [];
			for (let i = 0; i < vectorSize(field); i++) {
				const c = vectorComponentField(field, i);
				const now = Array.isArray(current) ? current[i] : c.default;
				out.push(c.min === undefined || c.max === undefined ? now : randomNumber(rand, c.min, c.max, parameterStep(c), false));
			}
			return out;
		}
		default:
			return undefined;
	}
}
