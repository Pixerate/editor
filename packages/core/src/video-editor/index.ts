/**
 * `@pixerate/editor/video-editor`: a UI-agnostic non-linear video editor.
 *
 * A project (`VideoProject`) is plain JSON: assets (video, audio, images), tracks of clips placed
 * on a timeline (media, titles, colours) with fades, speed, transforms and transitions, and
 * markers. It edits all-or-nothing with undo (insert, ripple, trim, split, move), checks itself
 * with coded issues, evaluates any moment as layers and sounds (`videoFrameAt`), plays in a
 * browser on a canvas (`VideoPreviewEngine`), renders frames as SVG, exports to an ffmpeg command
 * or a CMX 3600 EDL, and exposes agent tools.
 */
export * from './types.js';
export * from './keyframes.js';
export * from './parse.js';
export * from './timeline.js';
export * from './check.js';
export * from './edit.js';
export * from './evaluate.js';
export * from './render.js';
export * from './export.js';
export * from './preview.js';
export * from './controller.js';
export * from './tools.js';
export * from './ui.js';
