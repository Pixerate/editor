/**
 * Generic effect authoring session: controls values, keyframes, presets, timing, undo/redo
 * and preview rendering for any effect provider.
 */

import { evaluateEasing, isAnimationEasing } from '../animation/easing.js';
import type { AnimationEasing } from '../animation/easing.js';
import { HistoryManager } from '../history/HistoryManager.js';
import type { Command } from '../history/types.js';
import type { SchemaValidationError } from '../tools/schema.js';
import { EffectControlError, EffectDisposedError, EffectUnsupportedError } from './errors.js';
import { effectValueErrors } from './helpers.js';
import type {
	EffectAuthoringDocument,
	EffectAuthoringIssue,
	EffectAuthoringResult,
	EffectAuthoringSession,
	EffectAuthoringSource,
	EffectAuthoringState,
	EffectKeyframe
} from './authoring.js';
import type {
	EffectDescription,
	EffectPreset,
	EffectProvider,
	EffectRenderer,
	EffectRendererOptions,
	EffectValue,
	EffectValues
} from './types.js';

export interface GenericAuthoringOptions {
	/** The provider whose `describe` and `createRenderer` the session uses. */
	provider: EffectProvider;
	/** Undo history to record into (default: a new HistoryManager). */
	history?: HistoryManager;
	/**
	 * Time source for playback: called with a frame callback, returns a cancel function.
	 * Default: requestAnimationFrame where it exists, else a 16 ms timer. Tests pass a manual one.
	 */
	schedule?: (frame: (now: number) => void) => () => void;
	/** Ms within which `setValue` calls on one control with no gesture merge (default 400). */
	mergeWindowMs?: number;
}

const HEX_RE = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Schema errors as one sentence naming each control (`control "color": Must match …`). */
function valueErrorMessage(errors: readonly SchemaValidationError[]): string {
	return errors
		.map((e) => {
			const [control, ...rest] = e.path.replace(/^\//, '').split('/');
			return `control "${control}"${rest.length ? ` (item ${rest.join('/')})` : ''}: ${e.message}`;
		})
		.join('; ');
}

/** Problems with a saved document against the effect it names, as schema-style errors (empty when it is valid). */
function documentErrors(doc: EffectAuthoringDocument, description: EffectDescription): SchemaValidationError[] {
	const errors: SchemaValidationError[] = [];
	const controls = Object.keys(description.controls.properties);
	const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
	if (doc.values !== undefined) {
		if (!isRecord(doc.values)) errors.push({ path: '/values', message: 'must be an object of control values' });
		else errors.push(...effectValueErrors(description, doc.values).map((e) => ({ ...e, path: `/values${e.path}` })));
	}
	if (doc.tracks !== undefined) {
		if (!isRecord(doc.tracks)) errors.push({ path: '/tracks', message: 'must be an object of keyframe lists' });
		else
			for (const [control, kfs] of Object.entries(doc.tracks)) {
				const at = `/tracks/${control}`;
				if (!controls.includes(control)) errors.push({ path: at, message: `there is no control "${control}"; the controls are ${controls.join(', ')}` });
				else if (!Array.isArray(kfs)) errors.push({ path: at, message: 'must be a list of keyframes' });
				else
					kfs.forEach((kf: unknown, i) => {
						if (!isRecord(kf)) return errors.push({ path: `${at}/${i}`, message: 'must be a keyframe object' });
						if (typeof kf.time !== 'number' || !Number.isFinite(kf.time) || kf.time < 0) errors.push({ path: `${at}/${i}/time`, message: 'must be a finite number of ms >= 0' });
						errors.push(...effectValueErrors(description, { [control]: kf.value }).map((e) => ({ ...e, path: `${at}/${i}/value` })));
						if (kf.easing !== undefined && !isAnimationEasing(kf.easing)) errors.push({ path: `${at}/${i}/easing`, message: 'is not a valid easing' });
					});
			}
	}
	if (doc.presets !== undefined) {
		if (!Array.isArray(doc.presets)) errors.push({ path: '/presets', message: 'must be a list of presets' });
		else
			doc.presets.forEach((p: unknown, i) => {
				if (!isRecord(p) || typeof p.name !== 'string' || !p.name) return errors.push({ path: `/presets/${i}`, message: 'must have a name' });
				errors.push(...effectValueErrors(description, p.values).map((e) => ({ ...e, path: `/presets/${i}/values${e.path}` })));
			});
	}
	if (doc.duration !== undefined && (typeof doc.duration !== 'number' || !Number.isFinite(doc.duration) || !(doc.duration > 0))) {
		errors.push({ path: '/duration', message: 'must be a finite number of ms > 0' });
	}
	if (doc.loop !== undefined && typeof doc.loop !== 'boolean') errors.push({ path: '/loop', message: 'must be a boolean' });
	return errors;
}

function parseHex(hex: string): { r: number; g: number; b: number; a: number; hasAlpha: boolean } | null {
	if (!HEX_RE.test(hex)) return null;
	const body = hex.slice(1);
	const r = parseInt(body.slice(0, 2), 16);
	const g = parseInt(body.slice(2, 4), 16);
	const b = parseInt(body.slice(4, 6), 16);
	const hasAlpha = body.length === 8;
	const a = hasAlpha ? parseInt(body.slice(6, 8), 16) : 255;
	return { r, g, b, a, hasAlpha };
}

function toHex2(n: number): string {
	const clamped = Math.round(Math.max(0, Math.min(255, n)));
	return clamped.toString(16).padStart(2, '0');
}

function lerpHex(c1: string, c2: string, t: number): string {
	const p1 = parseHex(c1);
	const p2 = parseHex(c2);
	if (!p1 || !p2) return t >= 1 ? c2 : c1;
	const r = p1.r + (p2.r - p1.r) * t;
	const g = p1.g + (p2.g - p1.g) * t;
	const b = p1.b + (p2.b - p1.b) * t;
	const a = p1.a + (p2.a - p1.a) * t;
	const withAlpha = p1.hasAlpha || p2.hasAlpha;
	return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}${withAlpha ? toHex2(a) : ''}`;
}

function interpolateValue(v1: EffectValue, v2: EffectValue, progress: number): EffectValue {
	if (typeof v1 === 'number' && typeof v2 === 'number') {
		return v1 + (v2 - v1) * progress;
	}
	if (Array.isArray(v1) && Array.isArray(v2) && v1.length === v2.length) {
		return v1.map((num, i) => {
			const other = v2[i];
			return typeof num === 'number' && typeof other === 'number' ? num + (other - num) * progress : num;
		});
	}
	if (typeof v1 === 'string' && typeof v2 === 'string' && v1.startsWith('#') && v2.startsWith('#')) {
		return lerpHex(v1, v2, progress);
	}
	// Booleans, strings, enums hold earlier keyframe's value
	return progress >= 1 ? v2 : v1;
}

function valuesAtTime(
	time: number,
	baseValues: EffectValues,
	tracks: Readonly<Record<string, readonly EffectKeyframe[]>>
): EffectValues {
	const result: Record<string, EffectValue> = { ...baseValues };
	for (const [control, kfs] of Object.entries(tracks)) {
		if (!kfs || kfs.length === 0) continue;
		if (kfs.length === 1) {
			result[control] = kfs[0].value;
			continue;
		}
		if (time <= kfs[0].time) {
			result[control] = kfs[0].value;
			continue;
		}
		const last = kfs[kfs.length - 1];
		if (time >= last.time) {
			result[control] = last.value;
			continue;
		}
		// Find segment kf1 -> kf2
		let idx = 0;
		while (idx < kfs.length - 1 && kfs[idx + 1].time <= time) {
			idx++;
		}
		const kf1 = kfs[idx];
		const kf2 = kfs[idx + 1];
		const span = kf2.time - kf1.time;
		const rawProgress = span > 0 ? (time - kf1.time) / span : 0;
		const easing = kf1.easing ?? 'linear';
		const eased = evaluateEasing(easing, rawProgress);
		result[control] = interpolateValue(kf1.value, kf2.value, eased);
	}
	return result;
}

const defaultSchedule = (frame: (now: number) => void): (() => void) => {
	if (typeof requestAnimationFrame === 'function') {
		let handle: number;
		let running = true;
		const tick = (now: number) => {
			if (!running) return;
			frame(now);
			if (running) handle = requestAnimationFrame(tick);
		};
		handle = requestAnimationFrame(tick);
		return () => {
			running = false;
			cancelAnimationFrame(handle);
		};
	}
	let handle: ReturnType<typeof setTimeout>;
	let running = true;
	const interval = 16;
	const tick = () => {
		if (!running) return;
		frame(Date.now());
		if (running) handle = setTimeout(tick, interval);
	};
	handle = setTimeout(tick, interval);
	return () => {
		running = false;
		clearTimeout(handle);
	};
};

function isDocumentSource(source: EffectAuthoringSource): source is { document: EffectAuthoringDocument } {
	return (
		'document' in source &&
		typeof (source as { document?: unknown }).document === 'object' &&
		(source as { document?: unknown }).document !== null
	);
}

/**
 * Creates an effect authoring session with values, presets, keyframes, timing and undo
 * over any provider. It has no source editing (`sourceLanguage: null`).
 */
export async function createEffectAuthoringSession(
	source: EffectAuthoringSource,
	options: GenericAuthoringOptions
): Promise<EffectAuthoringSession> {
	const { provider, history = new HistoryManager(), mergeWindowMs = 400 } = options;
	const scheduleFn = options.schedule ?? defaultSchedule;

	let effectId: string;
	let requestedPreset: string | undefined;
	let initialDoc: EffectAuthoringDocument | null = null;

	if (isDocumentSource(source)) {
		const doc = source.document as EffectAuthoringDocument;
		if (doc.version !== 1 || !doc.effectId) {
			throw new EffectUnsupportedError('Invalid effect authoring document: version 1 required');
		}
		effectId = doc.effectId;
		initialDoc = doc;
	} else if ('effectId' in source && typeof source.effectId === 'string') {
		effectId = source.effectId;
		requestedPreset = source.preset;
	} else {
		throw new EffectUnsupportedError('Invalid effect authoring source');
	}

	// The provider's own errors (UnknownEffectError for a bad id, anything else as it is) pass through.
	const description: EffectDescription = await provider.describe(effectId);
	if (initialDoc) {
		const problems = documentErrors(initialDoc, description);
		if (problems.length) throw new EffectControlError(effectId, problems);
	}

	if (description.kind === 'motion') {
		throw new EffectUnsupportedError('Motion effects cannot be authored as pixel effects', effectId);
	}

	// Internal mutable state
	let disposed = false;
	let playing = false;
	let cancelSchedule: (() => void) | null = null;
	let lastScheduleTime: number | null = null;
	let playheadTime = 0;
	let duration = initialDoc?.duration ?? description.duration ?? 1000;
	if (!(duration > 0)) duration = 1000;
	let loop = initialDoc?.loop ?? description.loop ?? false;
	let compiled: boolean | null = null;

	// Saved presets: only user-saved presets
	let savedPresets: EffectPreset[] = initialDoc ? [...(initialDoc.presets ?? [])] : [];

	// Base values (for controls when not keyframed)
	let baseValues: Record<string, EffectValue> = { ...description.defaults };
	if (initialDoc?.values) {
		baseValues = { ...baseValues, ...initialDoc.values };
	} else if (requestedPreset) {
		const found = description.presets.find((p) => p.name === requestedPreset);
		if (!found) {
			const validNames = description.presets.map((p) => `"${p.name}"`).join(', ');
			throw new EffectUnsupportedError(
				`Unknown preset "${requestedPreset}" for effect "${effectId}". Valid presets are: ${validNames || 'none'}`,
				effectId
			);
		}
		baseValues = { ...baseValues, ...found.values };
	}

	// Tracks: control -> sorted keyframes
	let tracks: Record<string, EffectKeyframe[]> = {};
	if (initialDoc?.tracks) {
		for (const [k, kfs] of Object.entries(initialDoc.tracks)) {
			tracks[k] = [...kfs].sort((a, b) => a.time - b.time);
		}
	}

	// Previews created by this session
	const livePreviews = new Set<EffectRenderer>();

	// Subscribers
	const listeners = new Set<(state: EffectAuthoringState) => void>();
	let cachedState: EffectAuthoringState | null = null;

	function mergePresets(): readonly EffectPreset[] {
		const result: EffectPreset[] = [];
		const seen = new Set<string>();
		// Saved presets take priority / replace provider presets with same name
		for (const p of savedPresets) {
			result.push(p);
			seen.add(p.name);
		}
		for (const p of description.presets) {
			if (!seen.has(p.name)) {
				result.push(p);
				seen.add(p.name);
			}
		}
		return result;
	}

	function currentMergedDescription(): EffectDescription {
		return {
			...description,
			presets: mergePresets()
		};
	}

	function buildState(): EffectAuthoringState {
		const desc = currentMergedDescription();
		const currentValues = valuesAtTime(playheadTime, baseValues, tracks);
		const historyState = history.getState();
		return {
			providerId: provider.id,
			effectId,
			name: initialDoc?.name ?? description.name,
			kind: description.kind,
			description: desc,
			source: null,
			sourceLanguage: null,
			values: currentValues,
			tracks: { ...tracks },
			issues: [],
			compiled,
			time: playheadTime,
			duration,
			loop,
			playing,
			canUndo: historyState.canUndo,
			canRedo: historyState.canRedo
		};
	}

	function getState(): EffectAuthoringState {
		if (!cachedState) {
			cachedState = buildState();
		}
		return cachedState;
	}

	function invalidateState(): void {
		cachedState = null;
		const next = getState();
		listeners.forEach((l) => l(next));
	}

	function validControlNames(): string[] {
		return Object.keys(description.controls.properties);
	}

	function checkDisposed(): EffectAuthoringResult | null {
		if (disposed) {
			return { ok: false, message: 'the session is closed' };
		}
		return null;
	}

	function pauseInternal(): void {
		if (!playing) return;
		playing = false;
		if (cancelSchedule) {
			cancelSchedule();
			cancelSchedule = null;
		}
		lastScheduleTime = null;
		invalidateState();
	}

	function seekInternal(t: number): void {
		const clamped = Math.max(0, Math.min(duration, t));
		if (clamped !== playheadTime) {
			playheadTime = clamped;
			invalidateState();
		}
	}

	const session: EffectAuthoringSession = {
		getState,

		subscribe(listener: (state: EffectAuthoringState) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		setValue(name: string, value: EffectValue, opts?: { gesture?: string | null }): EffectAuthoringResult {
			const disp = checkDisposed();
			if (disp) return disp;

			const validNames = validControlNames();
			if (!validNames.includes(name)) {
				return { ok: false, message: `there is no control "${name}"; the controls are ${validNames.join(', ')}` };
			}

			const errors = effectValueErrors(description, { [name]: value });
			if (errors.length > 0) {
				return { ok: false, message: valueErrorMessage(errors) };
			}

			const isAnimated = (tracks[name]?.length ?? 0) > 0;
			if (isAnimated) {
				const oldTracks = { ...tracks };
				const t = playheadTime;
				const currentTrack = [...(tracks[name] ?? [])];
				const existingIdx = currentTrack.findIndex((kf) => kf.time === t);
				const prevKf = existingIdx >= 0 ? currentTrack[existingIdx] : undefined;

				const execute = () => {
					const track = [...(tracks[name] ?? [])];
					const idx = track.findIndex((kf) => kf.time === t);
					if (idx >= 0) {
						track[idx] = { ...track[idx], value };
					} else {
						track.push({ time: t, value });
						track.sort((a, b) => a.time - b.time);
					}
					tracks[name] = track;
					invalidateState();
				};

				const undo = () => {
					tracks = { ...oldTracks };
					invalidateState();
				};

				const cmd: Command = {
					name: `Set ${name}`,
					tag: name,
					execute,
					undo
				};

				if (opts?.gesture) {
					history.executeMerged(cmd, { key: opts.gesture });
				} else {
					history.executeMerged(cmd, { windowMs: mergeWindowMs });
				}
				invalidateState();
				return { ok: true };
			}

			// Not animated: sets static value
			const prevVal = baseValues[name];
			const execute = () => {
				baseValues[name] = value;
			};
			const undo = () => {
				baseValues[name] = prevVal;
			};

			const cmd: Command = {
				name: `Set ${name}`,
				tag: name,
				execute,
				undo
			};

			if (opts?.gesture) {
				history.executeMerged(cmd, { key: opts.gesture });
			} else {
				history.executeMerged(cmd, { windowMs: mergeWindowMs });
			}
			invalidateState();
			return { ok: true };
		},

		setValues(values: EffectValues, opts?: { gesture?: string | null }): EffectAuthoringResult {
			const disp = checkDisposed();
			if (disp) return disp;

			const validNames = validControlNames();
			for (const [k, v] of Object.entries(values)) {
				if (!validNames.includes(k)) {
					return { ok: false, message: `there is no control "${k}"; the controls are ${validNames.join(', ')}` };
				}
				const errors = effectValueErrors(description, { [k]: v });
				if (errors.length > 0) {
					return { ok: false, message: valueErrorMessage(errors) };
				}
			}

			const prevBase = { ...baseValues };
			const prevTracks = { ...tracks };
			const t = playheadTime;

			const execute = () => {
				for (const [k, v] of Object.entries(values)) {
					const isAnimated = (tracks[k]?.length ?? 0) > 0;
					if (isAnimated) {
						const track = [...(tracks[k] ?? [])];
						const idx = track.findIndex((kf) => kf.time === t);
						if (idx >= 0) {
							track[idx] = { ...track[idx], value: v };
						} else {
							track.push({ time: t, value: v });
							track.sort((a, b) => a.time - b.time);
						}
						tracks[k] = track;
					} else {
						baseValues[k] = v;
					}
				}
			};

			const undo = () => {
				baseValues = { ...prevBase };
				tracks = { ...prevTracks };
			};

			const cmd: Command = {
				name: 'Set values',
				execute,
				undo
			};

			if (opts?.gesture) {
				history.executeMerged(cmd, { key: opts.gesture });
			} else {
				history.execute(cmd);
			}
			invalidateState();
			return { ok: true };
		},

		resetValues(names?: readonly string[]): EffectAuthoringResult {
			const disp = checkDisposed();
			if (disp) return disp;

			const targets = names ? [...names] : validControlNames();
			const prevBase = { ...baseValues };
			const prevTracks = { ...tracks };

			const execute = () => {
				for (const name of targets) {
					if (name in description.defaults) {
						baseValues[name] = description.defaults[name];
					}
					delete tracks[name];
				}
			};

			const undo = () => {
				baseValues = { ...prevBase };
				tracks = { ...prevTracks };
			};

			history.execute({
				name: 'Reset values',
				execute,
				undo
			});
			invalidateState();
			return { ok: true };
		},

		applyPreset(name: string): EffectAuthoringResult {
			const disp = checkDisposed();
			if (disp) return disp;

			const allPresets = mergePresets();
			const preset = allPresets.find((p) => p.name === name);
			if (!preset) {
				const available = allPresets.map((p) => `"${p.name}"`).join(', ');
				return { ok: false, message: `unknown preset "${name}"; available presets are: ${available || 'none'}` };
			}

			const prevBase = { ...baseValues };
			const prevTracks = { ...tracks };

			const execute = () => {
				for (const [k, v] of Object.entries(preset.values)) {
					baseValues[k] = v;
					delete tracks[k];
				}
			};

			const undo = () => {
				baseValues = { ...prevBase };
				tracks = { ...prevTracks };
			};

			history.execute({
				name: `Apply preset "${name}"`,
				execute,
				undo
			});
			invalidateState();
			return { ok: true };
		},

		savePreset(name: string): EffectAuthoringResult {
			const disp = checkDisposed();
			if (disp) return disp;

			if (!name || !name.trim()) {
				return { ok: false, message: 'preset name cannot be empty' };
			}

			const trimmed = name.trim();
			const currentValues = valuesAtTime(playheadTime, baseValues, tracks);
			const prevSaved = [...savedPresets];

			const execute = () => {
				const next = savedPresets.filter((p) => p.name !== trimmed);
				next.push({ name: trimmed, values: { ...currentValues } });
				savedPresets = next;
			};

			const undo = () => {
				savedPresets = [...prevSaved];
			};

			history.execute({
				name: `Save preset "${trimmed}"`,
				execute,
				undo
			});
			invalidateState();
			return { ok: true };
		},

		setKeyframe(name: string, time: number, value?: EffectValue, easing?: AnimationEasing): EffectAuthoringResult {
			const disp = checkDisposed();
			if (disp) return disp;

			const validNames = validControlNames();
			if (!validNames.includes(name)) {
				return { ok: false, message: `there is no control "${name}"; the controls are ${validNames.join(', ')}` };
			}
			if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
				return { ok: false, message: 'keyframe time must be a finite number >= 0' };
			}
			if (easing !== undefined && !isAnimationEasing(easing)) {
				return { ok: false, message: `invalid easing: ${String(easing)}` };
			}

			const targetValue = value !== undefined ? value : valuesAtTime(time, baseValues, tracks)[name];
			const errors = effectValueErrors(description, { [name]: targetValue });
			if (errors.length > 0) {
				return { ok: false, message: valueErrorMessage(errors) };
			}

			const prevTrack = tracks[name] ? [...tracks[name]] : undefined;

			const execute = () => {
				const track = prevTrack ? [...prevTrack] : [];
				const idx = track.findIndex((kf) => kf.time === time);
				const kf: EffectKeyframe = {
					time,
					value: targetValue,
					...(easing !== undefined ? { easing } : {})
				};
				if (idx >= 0) {
					track[idx] = kf;
				} else {
					track.push(kf);
					track.sort((a, b) => a.time - b.time);
				}
				tracks[name] = track;
			};

			const undo = () => {
				if (prevTrack === undefined) {
					delete tracks[name];
				} else {
					tracks[name] = [...prevTrack];
				}
			};

			history.execute({
				name: `Set keyframe on ${name}`,
				execute,
				undo
			});
			invalidateState();
			return { ok: true };
		},

		removeKeyframe(name: string, time: number): EffectAuthoringResult {
			const disp = checkDisposed();
			if (disp) return disp;

			const validNames = validControlNames();
			if (!validNames.includes(name)) {
				return { ok: false, message: `there is no control "${name}"; the controls are ${validNames.join(', ')}` };
			}
			const track = tracks[name];
			if (!track || !track.some((kf) => kf.time === time)) {
				const times = track?.map((kf) => `${kf.time}`).join(', ');
				return {
					ok: false,
					message: times
						? `no keyframe at ${time} ms on control "${name}"; its keyframes are at ${times} ms`
						: `control "${name}" has no keyframes`
				};
			}

			const prevTrack = [...track];

			const execute = () => {
				const next = tracks[name].filter((kf) => kf.time !== time);
				if (next.length === 0) {
					delete tracks[name];
				} else {
					tracks[name] = next;
				}
			};

			const undo = () => {
				tracks[name] = [...prevTrack];
			};

			history.execute({
				name: `Remove keyframe on ${name}`,
				execute,
				undo
			});
			invalidateState();
			return { ok: true };
		},

		clearTrack(name: string): EffectAuthoringResult {
			const disp = checkDisposed();
			if (disp) return disp;

			const validNames = validControlNames();
			if (!validNames.includes(name)) {
				return { ok: false, message: `there is no control "${name}"; the controls are ${validNames.join(', ')}` };
			}
			const prevTrack = tracks[name] ? [...tracks[name]] : undefined;
			if (!prevTrack || prevTrack.length === 0) {
				const animated = Object.keys(tracks).filter((k) => tracks[k]?.length);
				return {
					ok: false,
					message: `control "${name}" is not animated, so there is nothing to clear; ${animated.length ? `the animated controls are ${animated.join(', ')}` : 'no control is animated'}`
				};
			}

			const currentValue = valuesAtTime(playheadTime, baseValues, tracks)[name];
			const prevBase = baseValues[name];

			const execute = () => {
				delete tracks[name];
				baseValues[name] = currentValue;
			};

			const undo = () => {
				tracks[name] = [...prevTrack];
				baseValues[name] = prevBase;
			};

			history.execute({
				name: `Clear animation on ${name}`,
				execute,
				undo
			});
			invalidateState();
			return { ok: true };
		},

		setTiming(timing: { duration?: number; loop?: boolean }): EffectAuthoringResult {
			const disp = checkDisposed();
			if (disp) return disp;

			if (timing.duration !== undefined && (!(timing.duration > 0) || !Number.isFinite(timing.duration))) {
				return { ok: false, message: 'duration must be a finite number > 0' };
			}

			const prevDuration = duration;
			const prevLoop = loop;
			const prevTime = playheadTime;

			const execute = () => {
				if (timing.duration !== undefined) {
					duration = timing.duration;
					if (playheadTime > duration) playheadTime = duration;
				}
				if (timing.loop !== undefined) {
					loop = timing.loop;
				}
			};

			const undo = () => {
				duration = prevDuration;
				loop = prevLoop;
				playheadTime = prevTime;
			};

			history.execute({
				name: 'Set timing',
				execute,
				undo
			});
			invalidateState();
			return { ok: true };
		},

		play(): void {
			if (disposed || playing) return;
			playing = true;
			lastScheduleTime = null;
			cancelSchedule = scheduleFn((now: number) => {
				if (!playing) return;
				const delta = lastScheduleTime === null ? 0 : Math.max(0, now - lastScheduleTime);
				lastScheduleTime = now;
				let nextTime = playheadTime + delta;
				if (nextTime >= duration) {
					if (loop) {
						nextTime = duration > 0 ? nextTime % duration : 0;
					} else {
						nextTime = duration;
						pauseInternal();
					}
				}
				seekInternal(nextTime);
			});
			invalidateState();
		},

		pause(): void {
			pauseInternal();
		},

		seek(time: number): void {
			if (disposed) return;
			seekInternal(time);
		},

		undo(): boolean {
			if (disposed) return false;
			const changed = history.undo();
			if (changed) invalidateState();
			return changed;
		},

		redo(): boolean {
			if (disposed) return false;
			const changed = history.redo();
			if (changed) invalidateState();
			return changed;
		},

		async createPreview(opts: EffectRendererOptions): Promise<EffectRenderer> {
			if (disposed) {
				throw new EffectDisposedError(effectId);
			}

			const renderer = await provider.createRenderer(effectId, opts);
			livePreviews.add(renderer);

			const preview: EffectRenderer = {
				effectId: renderer.effectId,
				width: renderer.width,
				height: renderer.height,
				depth: renderer.depth,
				render: async (req) => {
					if (disposed) throw new EffectDisposedError(effectId);
					const effectiveValues = req.values ?? valuesAtTime(req.time, baseValues, tracks);
					const pixels = await renderer.render({
						...req,
						values: effectiveValues
					});
					if (compiled !== true) {
						compiled = true;
						invalidateState();
					}
					return pixels;
				},
				dispose: () => {
					livePreviews.delete(renderer);
					renderer.dispose();
				}
			};

			return preview;
		},

		exportDocument(): EffectAuthoringDocument {
			const currentValues = valuesAtTime(playheadTime, baseValues, tracks);
			return {
				version: 1,
				providerId: provider.id,
				effectId,
				name: initialDoc?.name ?? description.name,
				values: { ...currentValues },
				tracks: JSON.parse(JSON.stringify(tracks)),
				presets: JSON.parse(JSON.stringify(savedPresets)),
				duration,
				loop
			};
		},

		dispose(): void {
			if (disposed) return;
			disposed = true;
			pauseInternal();
			listeners.clear();
			for (const p of livePreviews) {
				try {
					p.dispose();
				} catch {
					// ignore errors on preview disposal
				}
			}
			livePreviews.clear();
		}
	};

	return session;
}
