import { isVideoKeyframes, type VideoAnimatable, type VideoEase, type VideoKey } from './keyframes.js';
import type { VideoClip, VideoClipAnimation, VideoClipAnimationEffect, VideoProject, VideoTransform } from './types.js';

/** Default length of an entrance or exit animation (ms). */
export const VIDEO_CLIP_ANIMATION_DURATION = 500;

interface EffectSpec {
	/** Offset of the picture at the start of an entrance (end of an exit), as fractions of the frame. */
	x?: number;
	y?: number;
	/** Scale at the start of an entrance, as a factor of the clip's own. */
	scale?: number;
	/** Eases for an entrance and an exit. */
	easeIn: VideoEase;
	easeOut: VideoEase;
}

const EFFECTS: Record<VideoClipAnimationEffect, EffectSpec> = {
	fade: { easeIn: 'linear', easeOut: 'linear' },
	rise: { y: 0.06, easeIn: 'ease-out', easeOut: 'ease-in' },
	drop: { y: -0.06, easeIn: 'ease-out', easeOut: 'ease-in' },
	'slide-left': { x: 0.15, easeIn: 'ease-out', easeOut: 'ease-in' },
	'slide-right': { x: -0.15, easeIn: 'ease-out', easeOut: 'ease-in' },
	zoom: { scale: 0.6, easeIn: 'ease-out', easeOut: 'ease-in' },
	// Overshoots past full size, then settles (a "back" curve).
	pop: { scale: 0.3, easeIn: [0.34, 1.56, 0.64, 1], easeOut: [0.36, 0, 0.66, -0.56] }
};

const PROPS = ['opacity', 'x', 'y', 'scale'] as const;
type Prop = (typeof PROPS)[number];

/** The properties an animation moves (each also fades: opacity is always one). */
export function videoClipAnimationProperties(animation: VideoClipAnimation): Prop[] {
	const spec = EFFECTS[animation.effect];
	return PROPS.filter((p) => p === 'opacity' || spec[p as 'x' | 'y' | 'scale'] !== undefined);
}

/** Entrance and exit lengths (ms), shortened in proportion when together they are longer than the clip. */
export function videoClipAnimationSpans(clip: VideoClip): { in: number; out: number } {
	const a = clip.animateIn ? (clip.animateIn.duration ?? VIDEO_CLIP_ANIMATION_DURATION) : 0;
	const b = clip.animateOut ? (clip.animateOut.duration ?? VIDEO_CLIP_ANIMATION_DURATION) : 0;
	const k = a + b > clip.duration ? clip.duration / (a + b) : 1;
	return { in: a * k, out: b * k };
}

/**
 * The clip with its entrance and exit animations written out as keyframes on opacity, x, y and
 * scale, so previews, SVG frames and the ffmpeg export all play them the same way. A property the
 * clip already keys itself is left alone (`checkVideoProject` notes it). Returns the clip unchanged
 * when it has no animations.
 */
export function videoClipAnimated(clip: VideoClip, project: Pick<VideoProject, 'width' | 'height'>): VideoClip {
	if (!clip.animateIn && !clip.animateOut) return clip;
	const spans = videoClipAnimationSpans(clip);
	const out: VideoClip = { ...clip, transform: { ...clip.transform } };
	for (const prop of PROPS) {
		const current: VideoAnimatable | undefined = prop === 'opacity' ? clip.opacity : clip.transform?.[prop];
		if (isVideoKeyframes(current)) continue;
		const base = current ?? (prop === 'opacity' || prop === 'scale' ? 1 : 0);
		const away = (spec: EffectSpec): number | undefined => {
			if (prop === 'opacity') return 0;
			const v = spec[prop];
			if (v === undefined) return undefined;
			return prop === 'scale' ? base * v : base + v * (prop === 'x' ? project.width : project.height);
		};
		const keys: VideoKey[] = [];
		if (clip.animateIn) {
			const spec = EFFECTS[clip.animateIn.effect];
			const from = away(spec);
			if (from !== undefined) keys.push({ t: 0, v: from, ease: spec.easeIn }, { t: spans.in, v: base });
		}
		if (clip.animateOut) {
			const spec = EFFECTS[clip.animateOut.effect];
			const to = away(spec);
			if (to !== undefined) {
				const start = clip.duration - spans.out;
				if (!keys.length || keys[keys.length - 1].t < start) keys.push({ t: start, v: base, ease: spec.easeOut });
				else keys[keys.length - 1] = { ...keys[keys.length - 1], ease: spec.easeOut };
				keys.push({ t: clip.duration, v: to });
			}
		}
		if (!keys.length) continue;
		if (prop === 'opacity') out.opacity = { keys };
		else (out.transform as VideoTransform)[prop] = { keys };
	}
	return out;
}
