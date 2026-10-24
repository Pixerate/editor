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
		return () => {
			this._listeners.delete(fn);
		};
	}

	private _notify(): void {
		this._revision++;
		const s = this.state;
		for (const fn of this._listeners) {
			try {
				fn(s);
			} catch (err) {
				console.error('GradientController subscriber error', err);
			}
		}
		if (this._onChange) {
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

	selectStop(stopId: string | null): void {
		if (stopId !== null && !this._gradient.stops.some((s) => s.id === stopId)) {
			return;
		}
		if (this._selectedStopId !== stopId) {
			this._selectedStopId = stopId;
			this._notify();
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

	setGradient(value: unknown, label = 'Set Gradient'): GradientActionResult {
		const norm = normalizeGradient(value);
		if ('error' in norm) {
			return { ok: false, message: norm.error };
		}
		return this._apply(norm.gradient, label, norm.gradient.stops[0]?.id ?? null);
	}

	setType(type: GradientType): GradientActionResult {
		return this._apply({ ...this._gradient, type }, 'Change Gradient Type');
	}

	setAngle(angle: number): GradientActionResult {
		return this._apply({ ...this._gradient, angle }, 'Change Gradient Angle');
	}

	setCenter(center: { x: number; y: number }): GradientActionResult {
		return this._apply({ ...this._gradient, center }, 'Change Gradient Center');
	}

	setShape(shape: GradientShape): GradientActionResult {
		return this._apply({ ...this._gradient, shape }, 'Change Gradient Shape');
	}

	setInterpolation(interpolation: GradientInterpolation): GradientActionResult {
		return this._apply({ ...this._gradient, interpolation }, 'Change Gradient Interpolation');
	}

	setRepeating(repeating: boolean): GradientActionResult {
		return this._apply({ ...this._gradient, repeating }, 'Toggle Gradient Repeating');
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
