/**
 * A video project is plain JSON: the media it uses (assets), tracks of clips placed on a timeline,
 * and markers. Every time is in milliseconds; `fps` sets the frame grid edits snap to and exports use.
 *
 * Tracks are listed top to bottom as a timeline shows them: on screen, a clip on an earlier video
 * track draws over one on a later track. Clips on one track never overlap.
 */

import type { VideoAnimatable, VideoKeyframes } from './keyframes.js';
import type { EffectValue } from '../effects/types.js';

export type VideoAssetKind = 'video' | 'audio' | 'image';

/** A spoken word in an asset's transcript, timed in the source (ms). */
export interface VideoTranscriptWord {
	word: string;
	start: number;
	end: number;
}

/** A smaller copy of an asset's media for the preview (see `VideoAsset.proxies`). */
export interface VideoAssetProxy {
	/** Its size as a fraction of the original (0.5 = half width and height). */
	scale: number;
	/** What the preview loads instead of the original. */
	src: string;
	width?: number;
	height?: number;
}

/** A piece of source media. The project refers to it by id; `src` is whatever the host can load. */
export interface VideoAsset {
	id: string;
	kind: VideoAssetKind;
	/** URL, blob URL, path or data URL (whatever the playback engine and exporter can open). */
	src: string;
	name?: string;
	/** Length of the source (ms). Required for video and audio; images have none. */
	duration?: number;
	/** Intrinsic size in pixels (video and image). Placement assumes the project size when missing. */
	width?: number;
	height?: number;
	/** Whether a video asset has sound (default true). */
	hasAudio?: boolean;
	/** A still to show for a video where its frames cannot be drawn (SVG renders, thumbnails). */
	poster?: string;
	/** What is said in it, word by word, timed in the source (see `parseVideoTranscript`). */
	transcript?: VideoTranscriptWord[];
	/**
	 * Smaller copies of a video for smooth editing (see `videoProxyFfmpeg`). The preview plays the
	 * one its preview scale picks; exports and EDLs always use `src`. A proxy must have the same
	 * length and timing as the original.
	 */
	proxies?: VideoAssetProxy[];
}

export type VideoTrackKind = 'video' | 'audio';

export interface VideoTrack {
	id: string;
	kind: VideoTrackKind;
	name?: string;
	/** Silences every clip on the track. */
	muted?: boolean;
	/** Leaves the track's pictures out of the frame. */
	hidden?: boolean;
	/** Refuses edits to the track's clips. */
	locked?: boolean;
	/**
	 * Moves with ripple edits made on other sync-locked tracks, so it stays in sync (default true).
	 * Turn it off for a track that should stay put while the others ripple (e.g. a music bed).
	 */
	syncLocked?: boolean;
	/** Gain applied to every clip on the track (1 = unchanged, default 1). */
	volume?: number;
	clips: VideoClip[];
}

/** Where a picture sits in the frame, after it has been fitted. Each field may be keyframed. */
export interface VideoTransform {
	/** Offset of the centre from the frame's centre, in pixels (default 0). */
	x?: VideoAnimatable;
	y?: VideoAnimatable;
	/** 1 = fitted size (default 1). */
	scale?: VideoAnimatable;
	/** Degrees clockwise (default 0). */
	rotation?: VideoAnimatable;
}

/** How a picture is fitted to the frame before its transform: like CSS `object-fit`. */
export type VideoFit = 'contain' | 'cover' | 'fill' | 'none';
export const VIDEO_FITS = ['contain', 'cover', 'fill', 'none'] as const;

/**
 * - `crossfade`: this clip fades up over the one before.
 * - `dip`: down into a colour and up out of it.
 * - `wipe`: an edge travels across, revealing this clip.
 * - `push`: this clip slides in, pushing the one before out.
 * - `slide`: this clip slides in over the one before, which stays put.
 * - `iris`: a circle opens from the centre, revealing this clip.
 * - `effect`: a transition effect from the editor's effects provider (`VideoTransition.effect`).
 */
export type VideoTransitionType = 'crossfade' | 'dip' | 'wipe' | 'push' | 'slide' | 'iris' | 'effect';
export const VIDEO_TRANSITION_TYPES = ['crossfade', 'dip', 'wipe', 'push', 'slide', 'iris', 'effect'] as const;

/**
 * Values of a provider effect's controls (see `@pixerate/editor/effects`): plain values, or
 * keyframes (clip-relative ms) for numeric controls.
 */
export type VideoEffectValues = Record<string, EffectValue | VideoKeyframes>;

/** A provider effect used by a transition or an effect clip. Kept in the project even without a provider. */
export interface VideoEffectRef {
	/** The provider's effect id. */
	effect: string;
	/** The provider it was applied with (its `id`). */
	provider?: string;
	/** The effect's name when it was applied, shown where no provider can draw it. */
	name?: string;
	values?: VideoEffectValues;
}

/**
 * A provider effect on a clip's picture (see `VideoClipBase.effects`). Effects run in order on the
 * picture as it comes from the source, before the clip's grade, placement, opacity and blend.
 */
export interface VideoClipEffect extends VideoEffectRef {
	/** Unique within the clip (e.g. `fx1`). */
	id: string;
	/** Default true. */
	enabled?: boolean;
	/** How much of the effect's result shows over its input, 0–1 (default 1), or keyframes. */
	opacity?: VideoAnimatable;
}
export type VideoWipeDirection = 'left' | 'right' | 'up' | 'down';
export const VIDEO_WIPE_DIRECTIONS = ['left', 'right', 'up', 'down'] as const;

/**
 * A transition into a clip from the clip that ends where it starts on the same track. It plays over
 * the cut, half before and half after, so both clips run past the cut into their handles (media
 * beyond the out point of the one before, before the in point of this one).
 */
export interface VideoTransition {
	type: VideoTransitionType;
	/** Length (ms), centred on the cut. */
	duration: number;
	/** For dip: the colour passed through (default black). */
	color?: string;
	/** For wipe, push and slide: the way the edge or picture travels (default right: in from the left). */
	direction?: VideoWipeDirection;
	/** For effect: the provider's transition effect and its values (plain values only). */
	effect?: VideoEffectRef;
	/**
	 * Shape of the sound's fades through the transition (see `VideoFadeCurve`). Default
	 * `equal-power` for crossfades and wipes, where two sounds overlap and a linear mix dips in
	 * loudness halfway; `linear` for dips, where one sound fades out before the other fades in.
	 */
	audioCurve?: VideoFadeCurve;
}

/** The curve a transition's sound fades follow (its `audioCurve`, else the default for its type). */
export const videoTransitionAudioCurve = (t: VideoTransition): VideoFadeCurve => t.audioCurve ?? (t.type === 'dip' ? 'linear' : 'equal-power');

/**
 * How a clip's picture mixes with what is beneath it, as in CSS `mix-blend-mode` (`add` sums the
 * colours, `plus-lighter` in CSS). These are the modes the canvas preview, SVG frames and ffmpeg's
 * `blend` filter all share.
 */
export type VideoBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'add';
export const VIDEO_BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'add'] as const;

/** A 3D LUT a grade applies after its other steps (see `VideoGrade.lut`). */
export interface VideoGradeLut {
	/** A `.cube` file: whatever the host can load (URL, path) and the exporter can open. */
	src: string;
	/** How much of the LUT's change to apply, 0–1 (default 1). */
	strength?: number;
	/** A label for the look (default the file's TITLE or name). */
	name?: string;
}

/**
 * Colour correction for a clip's picture (see `VIDEO_GRADE_CONTROLS` for ranges). Applied in a fixed
 * order: exposure, contrast, saturation, hue, white balance (temperature and tint), then the LUT.
 */
export interface VideoGrade {
	/** Stops: +1 doubles every channel (default 0). */
	exposure?: number;
	/** -1 (flat grey) to 1 (twice as steep), around mid grey (default 0). */
	contrast?: number;
	/** -1 (black and white) to 1 (twice as saturated); default 0. */
	saturation?: number;
	/** Hue rotation in degrees (default 0). */
	hue?: number;
	/** -1 (cool) to 1 (warm); default 0. */
	temperature?: number;
	/** -1 (green) to 1 (magenta); default 0. */
	tint?: number;
	/** A 3D LUT (a `.cube` file) applied last, mixed in at its `strength`. */
	lut?: VideoGradeLut;
}

/**
 * How a clip enters or leaves: `fade`; `rise` (up into place) or `drop` (down into place);
 * `slide-left` / `slide-right` (in moving that way); `zoom` (grows into place); `pop` (grows past its
 * size and settles). Each also fades. An exit plays the same movement backwards.
 */
export type VideoClipAnimationEffect = 'fade' | 'rise' | 'drop' | 'slide-left' | 'slide-right' | 'zoom' | 'pop';
export const VIDEO_CLIP_ANIMATION_EFFECTS = ['fade', 'rise', 'drop', 'slide-left', 'slide-right', 'zoom', 'pop'] as const;

/** An entrance or exit animation (see `VideoClipAnimationEffect`). */
export interface VideoClipAnimation {
	effect: VideoClipAnimationEffect;
	/** Length (ms, default 500). */
	duration?: number;
}

interface VideoClipBase {
	id: string;
	name?: string;
	/** Where it starts on the timeline (ms). */
	start: number;
	/** How long it lasts on the timeline (ms). */
	duration: number;
	/** 0–1 (default 1), or keyframes (`{ keys: [{ t, v, ease }] }`, `t` in ms from the clip's start). */
	opacity?: VideoAnimatable;
	transform?: VideoTransform;
	/** Default contain. */
	fit?: VideoFit;
	/** How the picture mixes with what is beneath it (default normal). */
	blend?: VideoBlendMode;
	/** Colour correction of the picture. */
	grade?: VideoGrade;
	/** How the picture enters, from the clip's start (on top of any fade in). */
	animateIn?: VideoClipAnimation;
	/** How the picture leaves, up to the clip's end. */
	animateOut?: VideoClipAnimation;
	/** Fade in from nothing over this long (ms), pictures and sound. */
	fadeIn?: number;
	/** Fade out over this long (ms). */
	fadeOut?: number;
	/** Transition from the clip before (see `VideoTransition`). */
	transition?: VideoTransition;
	/** Provider effects on the picture, applied in order (see `VideoClipEffect`). */
	effects?: VideoClipEffect[];
}

/**
 * The shape of a sound fade, the same curves ffmpeg's `afade` draws, so previews and exports agree.
 * With `x` running 0→1 through a fade in (1→0 through a fade out), the gain is:
 * - `linear`: x (ffmpeg `tri`). Dips in loudness in the middle of a crossfade.
 * - `equal-power`: sin(x·π/2) (`qsin`). Keeps loudness steady; the usual choice for crossfades.
 * - `s-curve`: (1 − cos(x·π))/2 (`hsin`). Gentle at both ends.
 * - `exponential`: x³ (`cub`). Slow start; a natural-sounding fade in from silence.
 * - `logarithmic`: 1 − (1 − x)² (`ipar`). Fast start, slow finish.
 */
export type VideoFadeCurve = 'linear' | 'equal-power' | 's-curve' | 'exponential' | 'logarithmic';
export const VIDEO_FADE_CURVES = ['linear', 'equal-power', 's-curve', 'exponential', 'logarithmic'] as const;

/** A stretch of an asset. */
export interface VideoMediaClip extends VideoClipBase {
	type: 'media';
	asset: string;
	/** Where in the source it starts (ms, default 0). */
	in?: number;
	/** Playback speed (default 1): it uses `duration × speed` of the source. */
	speed?: number;
	/**
	 * A speed ramp: keys mapping clip time to source time after the in point (`v` ms from `in`), so
	 * a key's slope is the speed there, a flat stretch is a freeze frame and eased keys ramp between
	 * speeds. Never runs backwards. Before the first key and after the last the picture holds. Takes
	 * the place of `speed` (see `videoSpeedRampKeys` for building one from speeds).
	 */
	timeRemap?: VideoKeyframes;
	/** Gain (1 = unchanged, default 1), or keyframes. */
	volume?: VideoAnimatable;
	/** Silences this clip. */
	muted?: boolean;
	/** Shape of the sound's fade in (default linear). The picture always fades linearly. */
	fadeInCurve?: VideoFadeCurve;
	/** Shape of the sound's fade out (default linear). */
	fadeOutCurve?: VideoFadeCurve;
}

/** A title. */
export interface VideoTextClip extends VideoClipBase {
	type: 'text';
	text: string;
	/** CSS colour (default white). */
	color?: string;
	/** Pixels (default 64). */
	fontSize?: number;
	/** Default sans-serif. */
	fontFamily?: string;
	/** Default 700. */
	fontWeight?: number;
	/** Box behind the text (CSS colour); none by default. */
	background?: string;
}

/** A solid colour filling the frame. */
export interface VideoColorClip extends VideoClipBase {
	type: 'color';
	color: string;
}

/**
 * A compound clip: a nested sequence (see `VideoProject.sequences`) played as one picture and one
 * sound. It plays the sequence's own time from `in`, at normal speed. Its opacity, transform, blend,
 * grade, fades, transitions and animations apply to the sequence's composite, not to each of its
 * clips; its volume and fades apply to the sequence's mixed sound.
 */
export interface VideoSequenceClip extends VideoClipBase {
	type: 'sequence';
	/** The id of the sequence it plays (in `project.sequences`). */
	sequence: string;
	/** Where in the sequence's time it starts (ms, default 0). */
	in?: number;
	/** Gain on the sequence's sound (1 = unchanged, default 1), or keyframes. */
	volume?: VideoAnimatable;
	/** Silences the sequence's sound. */
	muted?: boolean;
	/** Shape of the sound's fade in (default linear). */
	fadeInCurve?: VideoFadeCurve;
	/** Shape of the sound's fade out (default linear). */
	fadeOutCurve?: VideoFadeCurve;
}

/**
 * A picture drawn by a provider effect (a generator, title or overlay), filling the frame. Without
 * a provider it shows as a placeholder and keeps its effect id and values.
 */
export interface VideoEffectClip extends VideoClipBase, VideoEffectRef {
	type: 'effect';
}

export type VideoClip = VideoMediaClip | VideoTextClip | VideoColorClip | VideoSequenceClip | VideoEffectClip;
export type VideoClipType = VideoClip['type'];

/**
 * How a clip is placed where others already are: `refuse` an overlap (the default), `overwrite`
 * what is underneath (cutting, trimming or removing it), or `insert` (cut everything across the
 * point and push later material along on every sync-locked track).
 */
export type VideoPlacementMode = 'refuse' | 'overwrite' | 'insert';
export const VIDEO_PLACEMENT_MODES = ['refuse', 'overwrite', 'insert'] as const;
export const VIDEO_CLIP_TYPES = ['media', 'text', 'color', 'sequence', 'effect'] as const;

export interface VideoMarker {
	id: string;
	time: number;
	label?: string;
	/** CSS colour. */
	color?: string;
}

/**
 * A nested sequence: tracks of clips with their own timeline from 0, played inside the project by
 * compound clips (`type: 'sequence'`). Its frame is the project's frame size, transparent where no
 * clip covers it. A sequence may hold compound clips of other sequences, but never itself (directly
 * or through others).
 */
export interface VideoSequence {
	id: string;
	name?: string;
	tracks: VideoTrack[];
}

export interface VideoProject {
	version: 1;
	name?: string;
	/** Frame size in pixels. */
	width: number;
	height: number;
	/** Frames per second: the grid edits snap to and exports use. */
	fps: number;
	/** What shows where no clip covers the frame (default black). */
	background?: string;
	assets: VideoAsset[];
	tracks: VideoTrack[];
	/** Nested sequences that compound clips play (see `VideoSequence`). */
	sequences?: VideoSequence[];
	markers?: VideoMarker[];
}
