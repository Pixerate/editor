/**
 * `@pixerate/editor/raster`: the shared raster layer stack. Tiled copy-on-write surfaces, a
 * synchronous PNG / zlib codec, blend modes, Gaussian blur of coverage planes, the generic layer
 * stack (pixel layers, groups, masks, clipping, locks) and the per-tile compositor engine with its
 * caches. No DOM and no framework imports: it runs in Node and in Workers. The image editor and
 * the paint editor build their own layer kinds on top.
 */

export * from './surface';
export * from './blend';
export * from './blur';
export * from './layers';
export * from './compositor';
export { encodePng, decodePng, isPng, bytesToBase64, base64ToBytes, parseDataUrl, pngDataUrl, type DecodedPng } from './png';
export { inflate, inflateRaw, deflate, deflateRaw, adler32, ZlibError } from './zlib';
