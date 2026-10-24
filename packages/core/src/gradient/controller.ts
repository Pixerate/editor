import { HistoryManager } from '../history/HistoryManager.js';
import type { Command } from '../history/types.js';
import {
	createGradient,
	distributeGradientStops,
	insertGradientStop,
	normalizeGradient,
	removeGradientStop,
	reverseGradient,
	updateGradientStop
} from './model.js';
import type {
	Gradient,
	GradientInterpolation,
	GradientShape,
	GradientStop,
	GradientType
} from './types.js';

export interface GradientControllerOptions {
	/** Initial gradient value (parsed or object). */
	value?: unknown;
	/** History manager to record undo/redo into (creates own if omitted). */
	history?: HistoryManager;
	/** Whether the gradient is read-only or a function returning reason/boolean. */
	readOnly?: boolean | string | (() => boolean | string);
	/** Callback invoked whenever the gradient or selection changes. */
	onChange?: (gradient: Readonly<Gradient>) => void;
}

export interface GradientState {
	gradient: Readonly<Gradient>;
	selectedStopId: string | null;
	canUndo: boolean;
	canRedo: boolean;
	undoLabel: string;
	redoLabel: string;
	revision: number;
}

export type GradientActionResult = { ok: true } | { ok: false; message: string };

/** The geometry fields `setGeometry` changes; omitted fields stay as they are. */
export interface GradientGeometryPatch {
	type?: GradientType;
	/** Degrees (linear and conic); any finite number, stored modulo 360. */
	angle?: number;
	/** 0–1 of the box (radial and conic). */
	center?: { x: number; y: number };
	shape?: GradientShape;
	interpolation?: GradientInterpolation;
	repeating?: boolean;
}

export const GRADIENT_TYPES: readonly GradientType[] = ['linear', 'radial', 'conic'];
export const GRADIENT_INTERPOLATIONS: readonly GradientInterpolation[] = ['oklab', 'oklch', 'srgb', 'srgb-linear'];
const GRADIENT_SHAPES: readonly GradientShape[] = ['circle', 'ellipse'];
const GEOMETRY_KEYS = ['type', 'angle', 'shape', 'interpolation', 'repeating'] as const;

/** Why a geometry patch is invalid, or null when it is fine. */
function geometryError(patch: GradientGeometryPatch): string | null {
	const list = (values: readonly string[]) => values.map((v) => `"${v}"`).join(', ');
	if (patch.type !== undefined && !GRADIENT_TYPES.includes(patch.type)) {
		return `Unknown gradient type "${String(patch.type)}"; use one of ${list(GRADIENT_TYPES)}.`;
	}
	if (patch.angle !== undefined && (typeof patch.angle !== 'number' || !Number.isFinite(patch.angle))) {
		return `The angle must be a finite number of degrees; got ${String(patch.angle)}.`;
	}
	if (patch.center !== undefined) {
		const c = patch.center as { x?: unknown; y?: unknown } | null;
		const inRange = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
		if (!c || typeof c !== 'object' || !inRange(c.x) || !inRange(c.y)) {
			return `The center needs x and y between 0 and 1; got ${JSON.stringify(patch.center)}.`;
		}
	}
	if (patch.shape !== undefined && !GRADIENT_SHAPES.includes(patch.shape)) {
		return `Unknown radial shape "${String(patch.shape)}"; use ${list(GRADIENT_SHAPES)}.`;
	}
	if (patch.interpolation !== undefined && !GRADIENT_INTERPOLATIONS.includes(patch.interpolation)) {
		return `Unknown interpolation "${String(patch.interpolation)}"; use one of ${list(GRADIENT_INTERPOLATIONS)}.`;
	}
	if (patch.repeating !== undefined && typeof patch.repeating !== 'boolean') {
		return `"repeating" must be true or false; got ${String(patch.repeating)}.`;
	}
	return null;
}

function sameGradientJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b);
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const bb = b as unknown[];
		return a.length === bb.length && a.every((v, i) => sameGradientJson(v, bb[i]));
	}
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const keys = Object.keys(ao).filter((k) => ao[k] !== undefined);
	if (keys.length !== Object.keys(bo).filter((k) => bo[k] !== undefined).length) return false;
	return keys.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && sameGradientJson(ao[k], bo[k]));
}

export class GradientController {
	private _gradient: Gradient;
	private _selectedStopId: string | null = null;
	private readonly _history: HistoryManager;
	private readonly _readOnlyOption?: boolean | string | (() => boolean | string);
	private readonly _onChange?: (gradient: Readonly<Gradient>) => void;
	private readonly _listeners = new Set<(state: GradientState) => void>();
	private _gestureKey: string | null = null;
	private _gestureCount = 0;
	private _revision = 0;
	private _cachedState: GradientState | null = null;

	constructor(options: GradientControllerOptions = {}) {
		if (options.value !== undefined) {
			const norm = normalizeGradient(options.value);
			if ('error' in norm) throw new Error(norm.error);
			this._gradient = norm.gradient;
		} else {
			this._gradient = createGradient(['#000000', '#ffffff']);
		}
		this._history = options.history ?? new HistoryManager();
		this._readOnlyOption = options.readOnly;
		this._onChange = options.onChange;
		if (this._gradient.stops.length > 0) {
			this._selectedStopId = this._gradient.stops[0].id;
		}
	}

	get state(): GradientState {
		if (this._cachedState && this._cachedState.revision === this._revision) {
			const hState = this._history.getState();
			if (
				this._cachedState.canUndo === hState.canUndo &&
				this._cachedState.canRedo === hState.canRedo &&
				this._cachedState.undoLabel === hState.undoName &&
				this._cachedState.redoLabel === hState.redoName &&
				this._cachedState.selectedStopId === this._selectedStopId &&
				this._cachedState.gradient === this._gradient
			) {
				return this._cachedState;
			}
		}
		const hState = this._history.getState();
		this._cachedState = {
			gradient: this._gradient,
			selectedStopId: this._selectedStopId,
			canUndo: hState.canUndo,
			canRedo: hState.canRedo,
			undoLabel: hState.undoName,
			redoLabel: hState.redoName,
			revision: this._revision
		};
		return this._cachedState;
	}

	get readOnlyReason(): string | null {
		const r = typeof this._readOnlyOption === 'function' ? this._readOnlyOption() : this._readOnlyOption;
		if (!r) return null;
		return typeof r === 'string' ? r : 'The gradient is read-only.';
	}

	get isReadOnly(): boolean {
		return this.readOnlyReason !== null;
	}

	getGradient(): Readonly<Gradient> {
		return this._gradient;
	}

	getSelectedStopId(): string | null {
		return this._selectedStopId;
	}

	getSelectedStop(): GradientStop | null {
		if (!this._selectedStopId) return null;
		return this._gradient.stops.find((s) => s.id === this._selectedStopId) ?? null;
	}

	subscribe(fn: (state: GradientState) => void): () => void {
		this._listeners.add(fn);
		try {
			fn(this.state);
		} catch (err) {
			console.error('GradientController subscriber error', err);
		}
		return () => {
			this._listeners.delete(fn);
		};
	}

	/** `changed` is false for view-only updates (selection), which don't call `onChange`. */
	private _notify(changed = true): void {
		this._revision++;
		const s = this.state;
		for (const fn of this._listeners) {
			try {
				fn(s);
			} catch (err) {
				console.error('GradientController subscriber error', err);
			}
		}
		if (changed && this._onChange) {
			try {
				this._onChange(this._gradient);
			} catch (err) {
				console.error('GradientController onChange error', err);
			}
		}
	}

	private _checkReadOnly(): { ok: false; message: string } | null {
		const reason = this.readOnlyReason;
		if (reason) {
			return { ok: false, message: reason };
		}
		return null;
	}

	/** Selects a stop (view state; not an undo step and no `onChange`). Unknown ids are ignored. */
	selectStop(stopId: string | null): void {
		if (stopId !== null && !this._gradient.stops.some((s) => s.id === stopId)) {
			return;
		}
		if (this._selectedStopId !== stopId) {
			this._selectedStopId = stopId;
			this._notify(false);
		}
	}

	beginGesture(label = 'Edit Gradient'): void {
		if (this._gestureKey === label) return;
		this._history.endGesture();
		this._gestureKey = label;
		this._gestureCount++;
	}

	endGesture(): void {
		this._gestureKey = null;
		this._history.endGesture();
	}

	private _apply(newGradient: Gradient, label: string, newStopId = this._selectedStopId): GradientActionResult {
		const ro = this._checkReadOnly();
		if (ro) return ro;

		if (newStopId !== null && !newGradient.stops.some((s) => s.id === newStopId)) {
			newStopId = newGradient.stops[0]?.id ?? null;
		}

		if (sameGradientJson(this._gradient, newGradient) && this._selectedStopId === newStopId) {
			return { ok: true };
		}

		const beforeGradient = this._gradient;
		const beforeStopId = this._selectedStopId;

		const cmd: Command = {
			name: label,
			tag: 'gradient',
			execute: () => {
				this._gradient = newGradient;
				this._selectedStopId = newStopId;
				this._notify();
			},
			undo: () => {
				this._gradient = beforeGradient;
				this._selectedStopId = beforeStopId;
				this._notify();
			}
		};

		if (this._gestureKey !== null) {
			this._history.executeMerged(cmd, { key: `gradient.gesture:${this._gestureKey}:${this._gestureCount}` });
		} else {
			this._history.execute(cmd);
		}
		return { ok: true };
	}

	/** The selected stop after `next` replaces the gradient: same id if it survives, else same index. */
	private _selectionAfterReplace(next: Gradient): string | null {
		if (this._selectedStopId === null) return null;
		if (next.stops.some((s) => s.id === this._selectedStopId)) return this._selectedStopId;
		const index = this._gradient.stops.findIndex((s) => s.id === this._selectedStopId);
		return next.stops[Math.min(Math.max(index, 0), next.stops.length - 1)]?.id ?? null;
	}

	setGradient(value: unknown, label = 'Set Gradient'): GradientActionResult {
		const norm = normalizeGradient(value);
		if ('error' in norm) {
			return { ok: false, message: norm.error };
		}
		return this._apply(norm.gradient, label, this._selectionAfterReplace(norm.gradient));
	}

	/**
	 * Replaces the gradient without an undo step (e.g. syncing a controlled `value` from the
	 * host). Keeps the selection when the stop survives. Notifies subscribers and `onChange`.
	 */
	load(value: unknown, options: { clearHistory?: boolean } = {}): GradientActionResult {
		const norm = normalizeGradient(value);
		if ('error' in norm) {
			return { ok: false, message: norm.error };
		}
		const nextStopId = this._selectionAfterReplace(norm.gradient);
		if (options.clearHistory) this._history.clear();
		if (sameGradientJson(this._gradient, norm.gradient) && this._selectedStopId === nextStopId) {
			return { ok: true };
		}
		this._gradient = norm.gradient;
		this._selectedStopId = nextStopId;
		this._notify();
		return { ok: true };
	}

	/**
	 * Changes any of type, angle, center, shape, interpolation and repeating as one undo step.
	 * Every field is checked before anything changes; an invalid one fails the whole call.
	 */
	setGeometry(patch: GradientGeometryPatch, label = 'Change Gradient Geometry'): GradientActionResult {
		const ro = this._checkReadOnly();
		if (ro) return ro;
		const error = geometryError(patch);
		if (error) return { ok: false, message: error };
		const merged: Gradient = { ...this._gradient };
		for (const key of GEOMETRY_KEYS) {
			if (patch[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = patch[key];
		}
		if (patch.center) merged.center = { ...patch.center };
		if (patch.shape !== undefined && merged.type !== 'radial') {
			return { ok: false, message: `The shape applies to radial gradients only; this one is ${merged.type}. Set type "radial" too.` };
		}
		if (patch.center !== undefined && merged.type === 'linear') {
			return { ok: false, message: 'The center applies to radial and conic gradients only; this one is linear.' };
		}
		if (patch.angle !== undefined && merged.type === 'radial') {
			return { ok: false, message: 'The angle applies to linear and conic gradients only; this one is radial.' };
		}
		// Fill the defaults a new type needs (center for radial / conic, angle for linear / conic).
		const norm = normalizeGradient(merged);
		if ('error' in norm) return { ok: false, message: norm.error };
		return this._apply(norm.gradient, label);
	}

	setType(type: GradientType): GradientActionResult {
		return this.setGeometry({ type }, 'Change Gradient Type');
	}

	setAngle(angle: number): GradientActionResult {
		return this.setGeometry({ angle }, 'Change Gradient Angle');
	}

	setCenter(center: { x: number; y: number }): GradientActionResult {
		return this.setGeometry({ center }, 'Change Gradient Center');
	}

	setShape(shape: GradientShape): GradientActionResult {
		return this.setGeometry({ shape }, 'Change Gradient Shape');
	}

	setInterpolation(interpolation: GradientInterpolation): GradientActionResult {
		return this.setGeometry({ interpolation }, 'Change Gradient Interpolation');
	}

	setRepeating(repeating: boolean): GradientActionResult {
		return this.setGeometry({ repeating }, 'Toggle Gradient Repeating');
	}

	addStop(offset: number, color?: string): { ok: true; stop: GradientStop } | { ok: false; message: string } {
		const ro = this._checkReadOnly();
		if (ro) return { ok: false, message: ro.message };
		try {
			const { gradient: next, stop } = insertGradientStop(this._gradient, offset, color);
			const res = this._apply(next, 'Add Gradient Stop', stop.id);
			if (!res.ok) return res;
			return { ok: true, stop };
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
	}

	updateStop(id: string, patch: Partial<Omit<GradientStop, 'id'>>): GradientActionResult {
		const ro = this._checkReadOnly();
		if (ro) return ro;
		try {
			const next = updateGradientStop(this._gradient, id, patch);
			return this._apply(next, 'Update Gradient Stop');
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
	}

	removeStop(id: string): GradientActionResult {
		const ro = this._checkReadOnly();
		if (ro) return ro;
		try {
			const next = removeGradientStop(this._gradient, id);
			return this._apply(next, 'Remove Gradient Stop');
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
	}

	reverse(): GradientActionResult {
		const ro = this._checkReadOnly();
		if (ro) return ro;
		const next = reverseGradient(this._gradient);
		return this._apply(next, 'Reverse Gradient');
	}

	distribute(): GradientActionResult {
		const ro = this._checkReadOnly();
		if (ro) return ro;
		const next = distributeGradientStops(this._gradient);
		return this._apply(next, 'Distribute Gradient Stops');
	}

	undo(): boolean {
		if (this.isReadOnly || !this._history.getState().canUndo) return false;
		return this._history.undo();
	}

	redo(): boolean {
		if (this.isReadOnly || !this._history.getState().canRedo) return false;
		return this._history.redo();
	}

	dispose(): void {
		this._listeners.clear();
	}
}
