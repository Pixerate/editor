/**
 * `@pixerate/editor/paint`: the brush engine shared by the image and paint editors. Brush
 * settings, dab walking and spacing, the round computed tip, flow build-up towards each dab's
 * opacity ceiling, the stroke coverage buffer applied to raster tiles, the Mixer Brush (a
 * reservoir that picks up canvas colour per dab), pigment-like colour mixing (Kubelka-Munk over
 * reflectance spectra) with its `mix_colors` agent tool, and the retouching tools (Clone Stamp,
 * Healing Brush, Spot Healing, Smudge, Dodge, Burn, Sponge) with their Poisson healing. No DOM and
 * no framework imports: it runs in Node and in Workers.
 */

export * from './brush';
export * from './mixer';
export * from './exchange';
export * from './blending';
export * from './pigment';
export * from './pigment-tools';
export * from './heal';
export * from './retouch';
export * from './wet';
