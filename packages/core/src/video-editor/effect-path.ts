/**
 * Paths for effects that draw along one (`pathControlsOf`): where a clip's picture is in the frame,
 * so a path drawn on the frame can be handed to an effect in the pixels of the picture it renders.
 *
 * An effect clip renders at the project frame and is placed over it (filled, unless moved or
 * scaled); a clip effect renders over the clip's picture as it comes from the source (a media
 * clip's own size), before placement. Either way a frame point maps into the picture by undoing
 * the clip's placement and rotation at its first frame.
 */

import { placeVideoRect, videoTransformAt } from './evaluate.js';
import { videoMaskPolygon } from './mask.js';
import type { VideoClip, VideoProject } from './types.js';

/** A clip's picture: its size in pixels, where it is placed in the frame, and its rotation (degrees). */
export interface VideoClipPicture {
	size: { width: number; height: number };
	rect: { x: number; y: number; width: number; height: number };
	rotation: number;
}

/** Where a clip's picture lies in the frame at its first frame. */
export function videoClipPicture(project: VideoProject, clip: VideoClip): VideoClipPicture {
	const asset = clip.type === 'media' ? project.assets.find((a) => a.id === clip.asset) : undefined;
	const size = asset ? { width: asset.width ?? project.width, height: asset.height ?? project.height } : { width: project.width, height: project.height };
	const fit = clip.fit ?? (clip.type === 'media' || clip.type === 'sequence' ? 'contain' : 'fill');
	const rect = placeVideoRect(project, size, clip.type === 'text' ? 'fill' : fit, clip.transform, 0);
	return { size, rect, rotation: videoTransformAt(clip.transform, 0).rotation };
}

/** Turns `[x, y]` about a centre by `deg` degrees. */
function turn(x: number, y: number, cx: number, cy: number, deg: number): [number, number] {
	if (!deg) return [x, y];
	const a = (deg * Math.PI) / 180;
	const dx = x - cx;
	const dy = y - cy;
	return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

/** Frame points `[x0, y0, x1, y1, …]` in the pixels of a clip's picture (rounded to 0.01 px). */
export function framePointsToPicture(points: readonly number[], picture: VideoClipPicture): number[] {
	const { rect, size, rotation } = picture;
	const cx = rect.x + rect.width / 2;
	const cy = rect.y + rect.height / 2;
	const out: number[] = [];
	for (let i = 0; i + 1 < points.length; i += 2) {
		const [x, y] = turn(points[i], points[i + 1], cx, cy, -rotation);
		out.push(Math.round((((x - rect.x) / rect.width) * size.width) * 100) / 100, Math.round((((y - rect.y) / rect.height) * size.height) * 100) / 100);
	}
	return out;
}

/** A clip's mask outline as frame points `[x0, y0, …]` (its rotation applied), closed; `null` without a mask. */
export function videoClipMaskOutline(project: VideoProject, clip: VideoClip): number[] | null {
	if (!clip.mask) return null;
	const picture = videoClipPicture(project, clip);
	const { rect, rotation } = picture;
	const cx = rect.x + rect.width / 2;
	const cy = rect.y + rect.height / 2;
	const polygon = videoMaskPolygon(clip.mask, rect).map(([x, y]) => turn(x, y, cx, cy, rotation));
	if (polygon.length < 2) return null;
	return [...polygon, polygon[0]].flatMap(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
}

/**
 * Collects a path drawn on the preview with a pointer, in frame pixels: `down` and `move` take the
 * pointer's position over the preview element (`box`, its on-screen rect) and keep a point every
 * `spacing` frame pixels. Framework-free, for the bindings.
 */
export class VideoPathGesture {
	points: number[] = [];
	private drawing = false;

	constructor(
		private readonly frame: { width: number; height: number },
		private readonly spacing = 3
	) {}

	private at(e: { clientX: number; clientY: number }, box: { left: number; top: number; width: number; height: number }): [number, number] {
		return [Math.round(((e.clientX - box.left) / box.width) * this.frame.width * 100) / 100, Math.round(((e.clientY - box.top) / box.height) * this.frame.height * 100) / 100];
	}

	down(e: { clientX: number; clientY: number }, box: { left: number; top: number; width: number; height: number }): void {
		this.drawing = true;
		this.points = this.at(e, box);
	}

	move(e: { clientX: number; clientY: number }, box: { left: number; top: number; width: number; height: number }): boolean {
		if (!this.drawing) return false;
		const [x, y] = this.at(e, box);
		const n = this.points.length;
		if (Math.hypot(x - this.points[n - 2], y - this.points[n - 1]) < this.spacing) return false;
		this.points.push(x, y);
		return true;
	}

	/** Ends the stroke; returns its points, or `null` for a tap (fewer than two points). */
	up(): number[] | null {
		this.drawing = false;
		return this.points.length >= 4 ? [...this.points] : null;
	}
}
