/**
 * Provider camera moves on video clips (see `VideoClipCamera` and `@pixerate/editor/effects`).
 * A clip is the shot: a `transition` move (`in`) moves the camera from `from` to `framing` from
 * the clip's start, and a `hold` move (`during`) plays across the rest of the clip. The moves are
 * baked into the clip's x, y, scale and rotation keys with `sampleEffectCameraMove` at the
 * project's frame rate, keeping a cut's two keys (a jump), so nothing downstream needs the
 * provider. The camera looks at the clip's picture as its own transform places it.
 */

import { cameraMoveParts, resolveCameraMoveSpec, sampleEffectCameraMove } from '../effects/helpers.js';
import type { CameraKeyframe, CameraMoveRole, CameraMoveSpec, CameraStage, CameraView, EffectProvider } from '../effects/types.js';
import { isVideoKeyframes, VIDEO_TRANSFORM_PROPERTIES, type VideoKey } from './keyframes.js';
import type { VideoCameraFraming, VideoClip, VideoClipCamera, VideoProject, VideoTransform } from './types.js';

type TransformProperty = (typeof VIDEO_TRANSFORM_PROPERTIES)[number];

/** The view that shows `framing` of a `stage`-sized frame (see `VideoCameraFraming`). */
export function videoCameraView(framing: VideoCameraFraming | undefined, stage: CameraStage): CameraView {
	const zoom = framing?.zoom ?? 1;
	return { zoom, scrollX: stage.width / (2 * zoom) - (stage.width / 2 + (framing?.x ?? 0)), scrollY: stage.height / (2 * zoom) - (stage.height / 2 + (framing?.y ?? 0)) };
}

/**
 * The clip transform that shows `view` of a picture placed by `base`: the picture's centre goes
 * where the camera puts it (turned by the view's roll round the frame's centre), its scale times
 * the zoom, its rotation plus the roll. Tilt, turn and blur have no place in a clip transform.
 */
export function videoTransformOfView(view: CameraView, base: VideoClipCamera['base'], stage: CameraStage): Required<VideoClipCamera['base']> {
	const cx = stage.width / 2;
	const cy = stage.height / 2;
	// The picture's centre in scene units, then on the stage before the roll, from the frame's centre.
	const px = (cx + (base.x ?? 0) + view.scrollX) * view.zoom - cx;
	const py = (cy + (base.y ?? 0) + view.scrollY) * view.zoom - cy;
	const roll = view.roll ?? 0;
	const a = (roll * Math.PI) / 180;
	const tidy = (n: number) => Math.round(n * 1000) / 1000 || 0;
	return {
		x: tidy(px * Math.cos(a) - py * Math.sin(a)),
		y: tidy(px * Math.sin(a) + py * Math.cos(a)),
		scale: tidy((base.scale ?? 1) * view.zoom),
		rotation: tidy((base.rotation ?? 0) + roll)
	};
}

/** What baking a clip's camera moves gave: its transform with the keys, and notes on what could not be kept. */
export interface VideoCameraBake {
	transform: VideoTransform;
	/** Ms from the clip's start of each move's cut, when it has one. */
	cuts: number[];
	/** When each move plays (clip ms). */
	windows: { in?: { start: number; end: number }; during?: { start: number; end: number } };
	notes: string[];
}

/** The clip's transform as plain numbers, for a camera's `base` (refusing keyed fields, which a camera would replace). */
export function videoCameraBase(clip: VideoClip): VideoClipCamera['base'] {
	if (clip.camera) return clip.camera.base;
	const t = clip.transform ?? {};
	const keyed = VIDEO_TRANSFORM_PROPERTIES.filter((p) => isVideoKeyframes(t[p]));
	if (keyed.length)
		throw new Error(`Clip "${clip.id}" keys its ${keyed.join(', ')}, which a camera move would replace; remove those keyframes first (set_video_keyframes with keys null).`);
	return Object.fromEntries(VIDEO_TRANSFORM_PROPERTIES.flatMap((p) => (typeof t[p] === 'number' ? [[p, t[p]]] : []))) as VideoClipCamera['base'];
}

/**
 * Bakes a clip's camera moves (its `camera`) into transform keys at the project's frame rate:
 * `in` from the clip's start over its `ms` (default the move's `durationMs`), then `during`
 * across the rest of the clip. Keys are linear, one per frame, with both keys of a cut kept.
 * Async: the provider samples the moves (`sampleEffectCameraMove`).
 */
export async function bakeVideoClipCamera(clip: VideoClip, camera: VideoClipCamera, project: Pick<VideoProject, 'width' | 'height' | 'fps'>, provider: EffectProvider): Promise<VideoCameraBake> {
	const stage = { width: project.width, height: project.height };
	const fps = project.fps > 0 ? project.fps : 30;
	const to = videoCameraView(camera.framing, stage);
	const notes: string[] = [];
	const cuts: number[] = [];
	const windows: VideoCameraBake['windows'] = {};
	let keys: CameraKeyframe[] = [];
	let inMs = 0;
	const moveIn = cameraMoveParts(camera.in);
	if (moveIn) {
		const { description } = await resolveCameraMoveSpec(provider, moveIn, 'transition');
		inMs = moveIn.ms ?? description.camera!.durationMs;
		if (inMs > clip.duration) throw new Error(`The move into clip "${clip.id}" takes ${inMs} ms, longer than the clip (${clip.duration} ms); give a shorter "ms" or lengthen the clip.`);
		const sample = await sampleEffectCameraMove(provider, moveIn.move, { from: videoCameraView(camera.from, stage), to, ms: inMs, stage, fps, values: moveIn.values });
		keys.push(...sample.keys);
		if (sample.cut !== undefined) cuts.push(sample.cut);
		windows.in = { start: 0, end: inMs };
	}
	const moveDuring = cameraMoveParts(camera.during);
	const holdMs = clip.duration - inMs;
	if (moveDuring && holdMs > 0) {
		await resolveCameraMoveSpec(provider, moveDuring, 'hold');
		// A hold starts where the move in left the camera (its framing), else at the framing.
		const at = keys.length ? keys[keys.length - 1].view : to;
		const sample = await sampleEffectCameraMove(provider, moveDuring.move, { from: at, to: at, ms: holdMs, stage, fps, values: moveDuring.values });
		const shifted = sample.keys.map((k) => ({ t: k.t + inMs, view: k.view }));
		// The hold's first key is where the move in ended: one key there, not two.
		if (keys.length && shifted.length && sameView(keys[keys.length - 1].view, shifted[0].view)) shifted.shift();
		keys.push(...shifted);
		if (sample.cut !== undefined) cuts.push(sample.cut + inMs);
		windows.during = { start: inMs, end: clip.duration };
	} else if (moveDuring) notes.push(`The move into the clip fills it, so the hold move "${moveDuring.move}" has no time to play; shorten the move in or lengthen the clip.`);
	if (!keys.length) keys = [{ t: 0, view: to }];
	const flat = keys.some((k) => k.view.tilt || k.view.turn || (k.view.blur && k.view.blur > 0));
	if (flat) notes.push('A clip transform has no tilt, turn or motion blur, so those parts of the move are left out; the zoom, pan and roll are kept.');

	const base = videoCameraBase(clip);
	const transforms = keys.map((k) => ({ t: Math.round(k.t * 1000) / 1000, value: videoTransformOfView(k.view, base, stage) }));
	const transform: VideoTransform = {};
	for (const p of VIDEO_TRANSFORM_PROPERTIES) {
		const out: VideoKey[] = [];
		for (const { t, value } of transforms) {
			const last = out[out.length - 1];
			// Drop repeats on runs of the same value (a hold that does not touch this property), keeping a run's ends.
			const prev = out[out.length - 2];
			if (last && prev && last.v === value[p] && prev.v === value[p] && prev.t !== last.t) out[out.length - 1] = { t, v: value[p] };
			else out.push({ t, v: value[p] });
		}
		transform[p as TransformProperty] = out.length > 1 && out.some((k) => k.v !== out[0].v) ? { keys: out } : out[0].v;
	}
	return { transform, cuts, windows, notes };
}

const sameView = (a: CameraView, b: CameraView) => (['zoom', 'scrollX', 'scrollY', 'tilt', 'turn', 'roll', 'blur'] as const).every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 1e-9);

/** A clip's camera move for a role as its parts, or undefined. */
export function videoClipCameraMove(clip: Pick<VideoClip, 'camera'> | undefined, role: CameraMoveRole): Exclude<CameraMoveSpec, string> | undefined {
	return cameraMoveParts(clip?.camera?.[role === 'transition' ? 'in' : 'during']);
}
