/**
 * `@pixerate/editor/paint`: the brush engine shared by the image and paint editors. Brush
 * settings, dab walking and spacing, the round computed tip, flow build-up towards each dab's
 * opacity ceiling, and the stroke coverage buffer applied to raster tiles. No DOM and no
 * framework imports: it runs in Node and in Workers.
 */

export * from './brush';
