/**
 * A video project is plain JSON: the media it uses (assets), tracks of clips placed on a timeline,
 * and markers. Every time is in milliseconds; `fps` sets the frame grid edits snap to and exports use.
 *
 * Tracks are listed top to bottom as a timeline shows them: on screen, a clip on an earlier video
 * track draws over one on a later track. Clips on one track never overlap.
 */

export type VideoAssetKind = 'video' | 'audio' | 'image';

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

/** Where a picture sits in the frame, after it has been fitted. */
export interface VideoTransform {
	/** Offset of the centre from the frame's centre, in pixels (default 0). */
	x?: number;
	y?: number;
	/** 1 = fitted size (default 1). */
	scale?: number;
	/** Degrees clockwise (default 0). */
	rotation?: number;
}

/** How a picture is fitted to the frame before its transform: like CSS `object-fit`. */
export type VideoFit = 'contain' | 'cover' | 'fill' | 'none';
export const VIDEO_FITS = ['contain', 'cover', 'fill', 'none'] as const;

export type VideoTransitionType = 'crossfade' | 'dip' | 'wipe';
export const VIDEO_TRANSITION_TYPES = ['crossfade', 'dip', 'wipe'] as const;
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
	/** For wipe: the way the edge travels (default right, revealing from the left). */
	direction?: VideoWipeDirection;
}

interface VideoClipBase {
	id: string;
	name?: string;
	/** Where it starts on the timeline (ms). */
	start: number;
	/** How long it lasts on the timeline (ms). */
	duration: number;
	/** 0–1 (default 1). */
	opacity?: number;
	transform?: VideoTransform;
	/** Default contain. */
	fit?: VideoFit;
	/** Fade in from nothing over this long (ms), pictures and sound. */
	fadeIn?: number;
	/** Fade out over this long (ms). */
	fadeOut?: number;
	/** Transition from the clip before (see `VideoTransition`). */
	transition?: VideoTransition;
}

/** A stretch of an asset. */
export interface VideoMediaClip extends VideoClipBase {
	type: 'media';
	asset: string;
	/** Where in the source it starts (ms, default 0). */
	in?: number;
	/** Playback speed (default 1): it uses `duration × speed` of the source. */
	speed?: number;
	/** Gain (1 = unchanged, default 1). */
	volume?: number;
	/** Silences this clip. */
	muted?: boolean;
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

export type VideoClip = VideoMediaClip | VideoTextClip | VideoColorClip;
export type VideoClipType = VideoClip['type'];

/**
 * How a clip is placed where others already are: `refuse` an overlap (the default), `overwrite`
 * what is underneath (cutting, trimming or removing it), or `insert` (cut everything across the
 * point and push later material along on every sync-locked track).
 */
export type VideoPlacementMode = 'refuse' | 'overwrite' | 'insert';
export const VIDEO_PLACEMENT_MODES = ['refuse', 'overwrite', 'insert'] as const;
export const VIDEO_CLIP_TYPES = ['media', 'text', 'color'] as const;

export interface VideoMarker {
	id: string;
	time: number;
	label?: string;
	/** CSS colour. */
	color?: string;
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
	markers?: VideoMarker[];
}
