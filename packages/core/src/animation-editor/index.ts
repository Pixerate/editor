/**
 * `@pixerate/editor/animation-editor`: a UI-agnostic animation editor for vector artwork.
 *
 * A scene (`MotionScene`) is plain JSON: the vector editor's artwork plus shots of commands
 * (enter, draw, move, morph, follow, …) whose timing comes from their content. It compiles to
 * timed segments, renders any frame as a vector document or SVG, checks itself with coded
 * issues, edits all-or-nothing with undo, exposes agent tools, and exports to Flair's vector
 * motion and effect formats.
 */
export * from './types.js';
export * from './issues.js';
export * from './parse.js';
export * from './compile.js';
export * from './evaluate.js';
export * from './onion.js';
export * from './check.js';
export * from './edit.js';
export * from './flair.js';
export * from './flair-import.js';
export * from './controller.js';
export * from './tools.js';
export * from './instructions.js';
