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
export * from './stroke';
export * from './strokes';
export * from './render';
export * from './serialize';
export * from './view';
export * from './input';
export * from './encode';
export * from './thumbnails';
export * from './controller';
export * from './tools';
