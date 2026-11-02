/**
 * `@pixerate/editor/effects`: the effects provider contract. Editors take an `EffectProvider`
 * (`setEffectsProvider`) to find, describe and render effects that live in another package,
 * such as Flair's `flairEffects()`, and behave exactly as before without one. Dependency-free:
 * no TipTap, ProseMirror, DOM or framework imports.
 */
export * from './types.js';
export * from './errors.js';
export * from './helpers.js';
export * from './templates.js';
export * from './conformance.js';
export * from './fake.js';
export * from './tools.js';
export * from './ui.js';
export * from './pool.js';
export * from './authoring.js';
export * from './authoring-session.js';
export * from './authoring-tools.js';
