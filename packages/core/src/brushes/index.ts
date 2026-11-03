/**
 * `@pixerate/editor/brushes`: the brush model shared by every editor that paints. A `Brush` is
 * made of facets (tip, marks, dynamics, behaviour, light, motion, colour); `resolveBrush` turns
 * one into the flat form the paint engine reads, `migrateBrushV1` reads brushes written before
 * the facet model, and `BRUSH_PRESETS` is the built-in library. Host profiles say what each editor
 * can render (`checkBrush`), `createBrushLibrary` keeps user brushes on any storage adapter, and
 * `createBrushLibraryToolProvider` gives agents the library, and `brushEditorSections` /
 * `brushLibraryGroups` describe the brush editor and library browser the UI packages draw. No
 * renderer is bundled.
 */

export * from './types';
export { BRUSH_FACET_SCHEMAS, BRUSH_JSON_SCHEMA, BRUSH_WORD, MAX_BRUSH_PALETTE } from './schema';
export { normalizeBrushSpec, WET_BRUSH_TOOLS } from './normalize';
export { resolveBrush, resolveCategory, resolveEngine, resolveWetMedium, type ResolveBrushOptions } from './resolve';
export { migrateBrushV1 } from './migrate';
export { BRUSH_PRESETS } from './presets';
export { BRUSH_HOST_PROFILES, brushColourKind, CANVAS_PROFILE, checkBrush, degrade, IMAGE_PROFILE, listPresets, PAINT_PROFILE, VECTOR_PROFILE, type BrushCheck, type BrushColourKind, type BrushHostProfile, type BrushIssue, type BrushSupport, type DegradedBrush } from './profiles';
export {
  BrushLibraryError,
  createBrushLibrary,
  parseBrushLibrary,
  type BrushFilter,
  type BrushLibrary,
  type BrushLibraryEntry,
  type BrushLibraryErrorCode,
  type BrushLibraryFile,
  type BrushLibraryOptions,
  type ImportBrushesResult,
  type SaveBrushResult,
} from './library';
export { BRUSH_PATCH_PROPERTIES, BRUSH_UNSET_PROPERTY, changedBrushPaths, mergeBrushPatch, UNSETTABLE_BRUSH_FACETS, type BrushPatch, type UnsettableBrushFacet } from './patch';
export { brushEditorSections, brushLibraryGroups, setBrushEditorValue, type BrushEditorControl, type BrushEditorSection, type BrushEditorSectionId, type BrushLibraryGroup } from './ui';
export { createBrushLibraryToolProvider, createBrushLibraryTools, type BrushLibraryToolProviderOptions, type BrushPreviewImage, type BrushPreviewRenderer } from './tools';
