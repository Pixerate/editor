/**
 * Perspective (projective) maps between quadrilaterals: what Free Distort needs. The maths is
 * shared with the image editor's Free Transform and lives in `src/geom/homography.ts`; these are
 * its vector-named exports.
 */
export {
	solve8,
	applyHomography as applyVectorHomography,
	homographyFromPoints as vectorHomography,
	homographyKeepsQuad as vectorHomographyKeepsQuad,
	orderQuad as orderVectorQuad
} from '../geom/homography.js';

/** A 3×3 projective map, row-major, normalised so that the last entry is 1. */
export type { Homography as VectorHomography } from '../geom/types.js';
