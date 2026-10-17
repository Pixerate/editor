/**
 * `@pixerate/editor/animation`: the keyframe animation model on its own, with no dependencies
 * and no canvas nodes. Tracks, easing, OKLab colour mixing, evaluation, and a player on an
 * injectable clock. `@pixerate/editor/canvas` builds node animation on top and re-exports
 * everything here.
 */
export * from './easing.js';
export * from './color.js';
export * from './keyframes.js';
export * from './evaluate.js';
export * from './clock.js';
export * from './player.js';
export * from './presence.js';
