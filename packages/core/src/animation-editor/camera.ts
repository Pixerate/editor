/**
 * Provider camera moves in the animation editor (see `MotionCamera.in` / `during` and
 * `@pixerate/editor/effects`). The compiled camera track still eases a box from framing to
 * framing; with a provider that has camera moves (`capabilities.supportsCamera`) the camera's
 * view comes from the provider's `cameraView` while a move plays, and stays where a hold move
 * left it until the next framing. Without one, every function here returns null and the box
 * track rules, as before camera moves.
 */

import { cameraBoxOfView, cameraMoveParts, cameraViewOfBox, resolveCameraMoveSpec } from '../effects/helpers.js';
import { motionIssue, type MotionIssue } from './issues.js';
import type { CameraMoveRole, CameraMoveSpec, CameraStage, CameraView, EffectProvider, EffectSummary } from '../effects/types.js';
import { compileMotionScene, motionTrackKey, trackValue, type MotionTimeline } from './compile.js';
import type { MotionRect, MotionScene, MotionShot } from './types.js';

/** When a shot's camera plays a move (or, after a hold move, eases from where it left off). */
export interface MotionCameraWindow {
	shot: string;
	/** `in` and `during` play a provider move; `ease` eases from a hold move's last view to the next framing. */
	kind: 'in' | 'during' | 'ease';
	/** The move's id (`in` and `during`). */
	move?: string;
	values?: Record<string, unknown>;
	start: number;
	end: number;
	from: CameraView;
	to: CameraView;
	/** Where the camera is when the window ends and until the next one, or null when the box track takes over again. */
	after: CameraView | null;
}

const windowCache = new WeakMap<MotionTimeline, WeakMap<EffectProvider, MotionCameraWindow[]>>();

/** A shot's camera move for a role as its parts (`{ move, ms?, preset?, values? }`), or undefined. */
export function motionShotCameraMove(shot: MotionShot | undefined, role: CameraMoveRole): Exclude<CameraMoveSpec, string> | undefined {
	return cameraMoveParts(shot?.camera?.[role === 'transition' ? 'in' : 'during']);
}

/** The stage a scene's camera looks at: its artwork's size. */
export const motionCameraStage = (scene: MotionScene): CameraStage => ({ width: scene.artwork.width, height: scene.artwork.height });

/** True when a provider can play camera moves. */
export const effectsPlayCamera = (provider: EffectProvider | null | undefined): provider is EffectProvider & { cameraView: NonNullable<EffectProvider['cameraView']> } =>
	!!provider && provider.capabilities.supportsCamera === true && typeof provider.cameraView === 'function';

/** A provider's camera moves of a role (all of them with no role), in catalog order. Empty without camera support. */
export async function motionCameraMoves(provider: EffectProvider | null | undefined, role?: CameraMoveRole): Promise<EffectSummary[]> {
	if (!effectsPlayCamera(provider)) return [];
	const all = await provider.list({ kind: 'camera' });
	return all.filter((e) => e.kind === 'camera' && e.camera && (!role || e.camera.role === role));
}

/**
 * Where the scene's camera plays provider moves, in time order. Empty without a provider that
 * plays camera moves, or when no shot names one. Cached per compiled scene and provider.
 */
export function motionCameraWindows(scene: MotionScene, provider: EffectProvider | null | undefined): MotionCameraWindow[] {
	if (!effectsPlayCamera(provider)) return [];
	if (!scene.shots.some((s) => s.camera && (s.camera.in !== undefined || s.camera.during !== undefined))) return [];
	const timeline = compileMotionScene(scene);
	let byProvider = windowCache.get(timeline);
	if (!byProvider) windowCache.set(timeline, (byProvider = new WeakMap()));
	const cached = byProvider.get(provider);
	if (cached) return cached;

	const stage = motionCameraStage(scene);
	const full: MotionRect = { x: 0, y: 0, width: stage.width, height: stage.height };
	const track = timeline.tracks.get(motionTrackKey('', 'camera'));
	const boxView = (t: number): CameraView => {
		const b = trackValue(track, t);
		return cameraViewOfBox(Array.isArray(b) ? { x: b[0], y: b[1], width: b[2], height: b[3] } : full, stage);
	};
	const view = (move: string, values: Record<string, unknown> | undefined, from: CameraView, to: CameraView, u: number, ms: number): CameraView | null => {
		try {
			return provider.cameraView(move, { from, to, u, ms, stage }, values as never);
		} catch {
			// An unknown move or bad values: `checkMotionCameraMoves` reports it; the box track plays.
			return null;
		}
	};

	const windows: MotionCameraWindow[] = [];
	let carry: CameraView | null = null;
	for (const timing of timeline.shots) {
		const shot = scene.shots[timing.index];
		const eases = timing.commandsStart > timing.start && !!track?.some((seg) => seg.shot === timing.id);
		const framed = !!track?.some((seg) => seg.shot === timing.id);
		if (timing.cameraIn && timing.commandsStart > timing.start) {
			const spec = cameraMoveParts(shot.camera?.in)!;
			const from = carry ?? boxView(timing.start);
			const to = boxView(timing.commandsStart);
			if (view(spec.move, spec.values, from, to, 0, timing.commandsStart - timing.start)) {
				windows.push({ shot: timing.id, kind: 'in', move: spec.move, ...(spec.values ? { values: spec.values } : {}), start: timing.start, end: timing.commandsStart, from, to, after: null });
				carry = null;
			}
		} else if (carry && eases) {
			windows.push({ shot: timing.id, kind: 'ease', start: timing.start, end: timing.commandsStart, from: carry, to: boxView(timing.commandsStart), after: null });
			carry = null;
		} else if (framed) carry = null;
		if (timing.cameraDuring && timing.end > timing.commandsEnd) {
			const spec = cameraMoveParts(shot.camera?.during)!;
			const from = carry ?? boxView(timing.commandsEnd);
			const ms = timing.end - timing.commandsEnd;
			const last = view(spec.move, spec.values, from, from, 1, ms);
			if (last) {
				windows.push({ shot: timing.id, kind: 'during', move: spec.move, ...(spec.values ? { values: spec.values } : {}), start: timing.commandsEnd, end: timing.end, from, to: from, after: last });
				carry = last;
			}
		}
	}
	byProvider.set(provider, windows);
	return windows;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Eases between two views by their centres and zoom (the zoom at a steady rate). */
function easeViews(from: CameraView, to: CameraView, u: number, stage: CameraStage): CameraView {
	const k = smooth(Math.min(1, Math.max(0, u)));
	const a = cameraBoxOfView(from, stage);
	const b = cameraBoxOfView(to, stage);
	const zoom = from.zoom * Math.pow(to.zoom / from.zoom, k);
	const cx = lerp(a.x + a.width / 2, b.x + b.width / 2, k);
	const cy = lerp(a.y + a.height / 2, b.y + b.height / 2, k);
	const view: CameraView = { zoom, scrollX: stage.width / (2 * zoom) - cx, scrollY: stage.height / (2 * zoom) - cy };
	for (const key of ['tilt', 'turn', 'roll'] as const) if (from[key] || to[key]) view[key] = lerp(from[key] ?? 0, to[key] ?? 0, k);
	return view;
}

/**
 * Where the camera looks at `time` (ms) when a provider camera move decides it: during a move,
 * and after a hold move until the next framing. Null otherwise (the camera box track rules), and
 * always null without a provider that plays camera moves.
 */
export function motionCameraViewAt(scene: MotionScene, time: number, provider: EffectProvider | null | undefined): CameraView | null {
	const windows = motionCameraWindows(scene, provider);
	if (!windows.length || !effectsPlayCamera(provider)) return null;
	const stage = motionCameraStage(scene);
	let before: MotionCameraWindow | undefined;
	for (const w of windows) {
		if (w.start > time) break;
		if (time < w.end || (time === w.end && w === windows[windows.length - 1] && w.after)) {
			const u = w.end > w.start ? (time - w.start) / (w.end - w.start) : 1;
			if (w.kind === 'ease') return easeViews(w.from, w.to, u, stage);
			try {
				return provider.cameraView(w.move!, { from: w.from, to: w.to, u: Math.min(1, Math.max(0, u)), ms: w.end - w.start, stage }, w.values as never);
			} catch {
				return null;
			}
		}
		before = w;
	}
	if (!before?.after) return null;
	// A later framing without a move takes over from the box track.
	const track = compileMotionScene(scene).tracks.get(motionTrackKey('', 'camera'));
	const retaken = track?.some((seg) => seg.start >= before!.end && seg.start <= time);
	return retaken ? null : before.after;
}

/** The camera box a view shows (what becomes the SVG `viewBox`). */
export function motionCameraBox(view: CameraView, scene: MotionScene): MotionRect {
	return cameraBoxOfView(view, motionCameraStage(scene));
}

/**
 * The CSS `transform` for a view's tilt and turn on a stage element `width` pixels wide (they
 * are 3D, so an SVG cannot draw them): `perspective(…) rotateX(…) rotateY(…)`, or `''` when flat.
 * The roll and the blur are drawn in the frame's SVG.
 */
export function motionCameraTransform(view: CameraView | null | undefined, width: number): string {
	if (!view || (!view.tilt && !view.turn)) return '';
	const distance = (view.perspective ?? 2) * width;
	return `perspective(${Math.round(distance)}px)${view.tilt ? ` rotateX(${round(view.tilt)}deg)` : ''}${view.turn ? ` rotateY(${round(-view.turn)}deg)` : ''}`;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The SVG with a view's roll and motion blur applied round its content: a rotation about the
 * middle of the view's box, and a Gaussian blur (`blur` stage pixels, streaked along `blurAngle`
 * as an axis-aligned approximation).
 */
export function withCameraViewEffects(svg: string, view: CameraView | null | undefined, box: MotionRect, idPrefix = 'vg-'): string {
	if (!view || (!view.roll && !(view.blur && view.blur > 0))) return svg;
	const open = svg.match(/<svg\b[^>]*>/);
	const close = svg.lastIndexOf('</svg>');
	if (!open || close < 0) return svg;
	const startBody = open.index! + open[0].length;
	const attrs: string[] = [];
	let defs = '';
	if (view.roll) attrs.push(`transform="rotate(${round(view.roll)} ${round(box.x + box.width / 2)} ${round(box.y + box.height / 2)})"`);
	if (view.blur && view.blur > 0) {
		// Stage pixels to scene units, and blur radius to a Gaussian's deviation.
		const s = view.blur / view.zoom / 2;
		const a = ((view.blurAngle ?? 0) * Math.PI) / 180;
		const [sx, sy] = view.blurAngle === undefined ? [s, s] : [Math.abs(Math.cos(a)) * s, Math.abs(Math.sin(a)) * s];
		const id = `${idPrefix}camera-blur`;
		defs = `<defs><filter id="${id}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${round(sx)} ${round(sy)}"/></filter></defs>`;
		attrs.push(`filter="url(#${id})"`);
	}
	return `${svg.slice(0, startBody)}${defs}<g ${attrs.join(' ')}>${svg.slice(startBody, close)}</g>${svg.slice(close)}`;
}

/**
 * Problems with the scene's camera moves against a provider: moves it does not have or of the
 * wrong role, and presets or values that do not fit (errors), or, without a provider that has
 * camera moves, a note that they are not played.
 */
export async function checkMotionCameraMoves(scene: MotionScene, provider: EffectProvider | null | undefined): Promise<MotionIssue[]> {
	const issues: MotionIssue[] = [];
	const named = scene.shots.filter((s) => s.camera && (s.camera.in !== undefined || s.camera.during !== undefined));
	if (!named.length) return issues;
	if (!effectsPlayCamera(provider)) {
		const ids = named.map((s) => `"${s.id}"`).join(', ');
		issues.push(motionIssue('camera-move-not-played', `Shots ${ids} name camera moves, but ${provider ? `${provider.name} has no camera moves` : 'no effects provider is set'}, so the camera eases between framings instead; set a provider with camera moves to play them.`));
		return issues;
	}
	for (const shot of named) {
		for (const [field, role] of [['in', 'transition'], ['during', 'hold']] as const) {
			const spec = shot.camera![field];
			if (spec === undefined) continue;
			try {
				await resolveCameraMoveSpec(provider, spec, role);
			} catch (error) {
				const code = (error as { code?: string }).code === 'invalid_values' || /preset/.test((error as Error).message) ? 'camera-move-values' : 'camera-move-unknown';
				issues.push(motionIssue(code, (error as Error).message, { shot: shot.id }));
			}
		}
	}
	return issues;
}
