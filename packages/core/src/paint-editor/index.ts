/**
 * `@pixerate/editor/paint-editor`: a natural-media paint editor (in the spirit of Corel Painter
 * and Rebelle), separate from the image editor but built on the same engine: the shared raster
 * layer stack and compositor (`@pixerate/editor/raster`) and the shared brush engine, Mixer Brush
 * and pigment mixing (`@pixerate/editor/paint`). Paper with generated grain, grain-responsive dry
 * media, pen input, a brush library, strokes as data, save / load / export and the agent tools.
 * No DOM and no framework imports (pointer handling lives in the bindings).
 */

export * from './noise';
export * from './paper';
export * from './document';
export * from './brushes';
export * from './engine';
export * from './dab-stroke';
export * from './stroke';
export * from './strokes';
export * from './render';
export * from './serialize';
export * from './view';
export * from './input';
export * from './encode';
export * from './thumbnails';
export * from './guides';
export * from './color';
export * from './mixing-pad';
export * from './controller';
export * from './presence';
export * from './tools';
export type { PaintAgentTool, PaintOrigin, PaintToolCoordinates } from './hosted';
export * from './ui';
export { BLEND_MODES, PAINTERLY_BLEND_MODES, isBlendMode, isPainterlyBlendMode, standardBlendMode, type BlendMode, type BlendModeInfo } from '../raster/blend';
export * from './wet';
export * from './wet-tools';
export * from './thick';
export * from './thick-tools';
export * from './replay';
export * from './replay-tools';
export * from './stencils';
export * from './stickers';
export * from './procedural';
export * from './sticker-tools';
export * from './effects';
export * from './effect-tools';
export { WET_FLOW_KINDS, DEFAULT_FLOW, normalizeFlow, type WetFlowKind, type WetFlowSpec } from '../paint/wet/flow';
export { DEFAULT_WET_PARAMS, WET_PARAM_KEYS, normalizeWetParams, type WetParams, type WetTilt } from '../paint/wet/model';
export { wetSupport, type WetSupport } from '../paint/wet/wasm';
export type { WetBackendInfo } from '../paint/wet/world';
export * from '../paint/gradient-paint';
export * from './playback';
export * from './editorDocument';
