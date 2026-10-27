import type { VideoClipMask } from './types.js';

/**
 * Clip masks as plain geometry: every shape becomes a polygon in frame pixels (curves as short
 * straight segments), so the canvas preview, SVG frames and agents all cut the same shape. The
 * polygon is in the layer's unrotated frame space: renderers turn it with the layer.
 */

/** A rect in frame pixels (the layer's placed picture). */
interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** A mask resolved for one layer: its outline in frame pixels, soft edge and side. */
export interface VideoLayerMask {
	/** The outline, `[x, y]` frame pixels before the layer's rotation. */
	points: [number, number][];
	/** Soft edge width in frame pixels (0 = hard). */
	feather: number;
	/** Show the outside instead of the inside. */
	inverted: boolean;
}

/** The defaults a mask's missing fields take. */
export const VIDEO_MASK_DEFAULTS = { x: 0.5, y: 0.5, width: 0.5, height: 0.5, rotation: 0, feather: 0, cornerRadius: 0 } as const;

const ELLIPSE_SEGMENTS = 64;
const CORNER_SEGMENTS = 8;

/** A mask with its defaults filled in and values clamped (corner radius 0–1, sizes and feather at least 0). */
export function normalizeVideoClipMask(mask: VideoClipMask): Required<Omit<VideoClipMask, 'points' | 'inverted'>> & Pick<VideoClipMask, 'points'> & { inverted: boolean } {
	const d = VIDEO_MASK_DEFAULTS;
	const finite = (v: number | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
	return {
		shape: mask.shape,
		x: finite(mask.x, d.x),
		y: finite(mask.y, d.y),
		width: Math.max(0, finite(mask.width, d.width)),
		height: Math.max(0, finite(mask.height, d.height)),
		rotation: finite(mask.rotation, d.rotation),
		feather: Math.max(0, finite(mask.feather, d.feather)),
		cornerRadius: Math.min(1, Math.max(0, finite(mask.cornerRadius, d.cornerRadius))),
		inverted: mask.inverted === true,
		...(mask.points ? { points: mask.points } : {})
	};
}

/** The mask's outline in frame pixels for a layer placed at `rect` (before the layer's own rotation). */
export function videoMaskPolygon(mask: VideoClipMask, rect: Rect): [number, number][] {
	const m = normalizeVideoClipMask(mask);
	const cx = rect.x + m.x * rect.width;
	const cy = rect.y + m.y * rect.height;
	const a = (m.rotation * Math.PI) / 180;
	const cos = Math.cos(a);
	const sin = Math.sin(a);
	/** A point relative to the centre, turned by the mask's rotation. */
	const turn = (dx: number, dy: number): [number, number] => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
	if (m.shape === 'linear') {
		// A half-plane through the centre, as a quad far larger than anything it cuts.
		const R = 4 * (Math.hypot(rect.width, rect.height) + Math.hypot(cx - rect.x, cy - rect.y)) + 1;
		return [turn(-R, 0), turn(R, 0), turn(R, -R), turn(-R, -R)];
	}
	if (m.shape === 'polygon') {
		return (m.points ?? []).map((p) => turn((p.x - m.x) * rect.width, (p.y - m.y) * rect.height));
	}
	const hw = (m.width * rect.width) / 2;
	const hh = (m.height * rect.height) / 2;
	if (m.shape === 'ellipse') {
		return Array.from({ length: ELLIPSE_SEGMENTS }, (_, i) => {
			const t = (i / ELLIPSE_SEGMENTS) * 2 * Math.PI;
			return turn(hw * Math.cos(t), hh * Math.sin(t));
		});
	}
	const r = m.cornerRadius * Math.min(hw, hh);
	if (r <= 0) return [turn(-hw, -hh), turn(hw, -hh), turn(hw, hh), turn(-hw, hh)];
	// Rounded corners, clockwise from the top left.
	const corners: [number, number, number][] = [
		[-hw + r, -hh + r, Math.PI],
		[hw - r, -hh + r, 1.5 * Math.PI],
		[hw - r, hh - r, 0],
		[-hw + r, hh - r, 0.5 * Math.PI]
	];
	const out: [number, number][] = [];
	for (const [x, y, start] of corners)
		for (let i = 0; i <= CORNER_SEGMENTS; i++) {
			const t = start + (i / CORNER_SEGMENTS) * (Math.PI / 2);
			out.push(turn(x + r * Math.cos(t), y + r * Math.sin(t)));
		}
	return out;
}

/** A mask resolved for a layer placed at `rect`. */
export function videoLayerMask(mask: VideoClipMask, rect: Rect): VideoLayerMask {
	const m = normalizeVideoClipMask(mask);
	return { points: videoMaskPolygon(mask, rect), feather: m.feather, inverted: m.inverted };
}

/** An SVG path (`d`) of a resolved mask's outline. */
export function videoMaskSvgPath(mask: VideoLayerMask): string {
	const n = (v: number) => String(Math.round(v * 100) / 100);
	return mask.points.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join('') + 'Z';
}

/**
 * How much of a point (frame pixels) a resolved mask shows, 0 or 1 (no feather): an even-odd test
 * against its outline. For agents and tests reading what a mask keeps.
 */
export function videoMaskContains(mask: VideoLayerMask, x: number, y: number): boolean {
	let inside = false;
	const p = mask.points;
	for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
		const [xi, yi] = p[i];
		const [xj, yj] = p[j];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return mask.inverted ? !inside : inside;
}
