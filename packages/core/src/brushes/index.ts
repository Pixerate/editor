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
export { BRUSH_FACET_SCHEMAS, BRUSH_GRAIN_SOURCE_PATTERN, BRUSH_JSON_SCHEMA, BRUSH_WORD, MAX_BRUSH_PALETTE, TIP_GRAIN_PATTERNS } from './schema';
export {
  BRUSH_SOURCE_CHANNELS,
  BRUSH_SOURCE_PROVIDER,
  brushSourceFromMask,
  brushSourceIdFromName,
  brushSourceIdOf,
  brushSourceIds,
  brushSourceRef,
  BrushSourceError,
  decodeBrushSource,
  isBrushSourceRef,
  makeBrushSource,
  MAX_BRUSH_SOURCE_INPUT_PIXELS,
  MAX_BRUSH_SOURCE_SIZE,
  MAX_BRUSH_SOURCES,
  readBrushSource,
  summarizeBrushSource,
  type BrushSource,
  type BrushSourceChannel,
  type BrushSourceInput,
  type BrushSourceSummary,
  type DecodedBrushSource,
} from './sources';
export { normalizeBrushSpec, WET_BRUSH_TOOLS } from './normalize';
export { resolveBrush, resolveCategory, resolveEngine, resolveWetMedium, type ResolveBrushOptions } from './resolve';
export { migrateBrushV1 } from './migrate';
export { BRUSH_PRESETS } from './presets';
export { brushColourHex } from './colour';
export { BRUSH_PREVIEW_DARK_PAPER, BRUSH_PREVIEW_FALLBACKS, BRUSH_PREVIEW_MIN_CONTRAST, brushPreviewColours, brushPreviewsOnDark, brushPreviewStrength, type BrushPreviewColours, type BrushPreviewColoursOptions } from './preview';
export { BRUSH_CONTRACT_FORMAT_VERSION, BRUSH_LIBRARY_FILE_JSON_SCHEMA, BRUSH_PROFILE_JSON_SCHEMA, brushContracts } from './contract';
export { BRUSH_HOST_PROFILES, brushColourKind, CANVAS_PROFILE, checkBrush, checkBrushEdit, degrade, withKeptIssues, IMAGE_PROFILE, listPresets, PAINT_PROFILE, VECTOR_PROFILE, type BrushCheck, type BrushEditCheck, type BrushColourKind, type BrushHostProfile, type BrushIssue, type BrushSupport, type DegradedBrush } from './profiles';
export {
  BrushLibraryError,
  createBrushLibrary,
  isBrushLibrary,
  parseBrushLibrary,
  parseBrushLibrarySources,
  type AddBrushSourceResult,
  snapshotBrushLibrary,
  type BrushFilter,
  type BrushLibrary,
  type BrushLibraryEntry,
  type BrushLibraryErrorCode,
  type BrushLibraryFile,
  type BrushLibrarySnapshot,
  type BrushLibraryOptions,
  type ImportBrushesResult,
  type SaveBrushResult,
} from './library';
export { BRUSH_PATCH_PROPERTIES, BRUSH_UNSET_PROPERTY, changedBrushPaths, mergeBrushPatch, UNSETTABLE_BRUSH_FACETS, type BrushPatch, type UnsettableBrushFacet } from './patch';
export {
  addBrushSourceFromFile,
  brushEditorScope,
  brushEditorSections,
  imageFileToPngDataUrl,
  withBrushSource,
  brushIdFromName,
  brushLibraryGroups,
  newBrushFor,
  saveBrushEdit,
  setBrushEditorValue,
  type BrushEditorHiddenFacet,
  type BrushEditorScope,
  type SaveBrushEditOptions,
  type SaveBrushEditResult,
  type BrushEditorContext,
  type BrushEditorControl,
  type BrushEditorSection,
  type BrushEditorSectionId,
  type BrushLibraryGroup,
} from './ui';
export { createBrushLibraryToolProvider, createBrushLibraryTools, type BrushLibraryToolProviderOptions, type BrushPreviewImage, type BrushPreviewRenderer } from './tools';
export {
  BRUSH_PACK_FORMATS,
  brushPackFormat,
  BrushPackError,
  importBrushFile,
  importBrushPack,
  MAX_BRUSH_PACK_BYTES,
  MAX_PACK_BRUSHES,
  readBrushPack,
  type BrushPack,
  type BrushPackFormat,
  type ImportBrushPackResult,
  type ReadBrushPackOptions,
} from './import/pack';
export { AbrError, readAbr, type AbrFile, type AbrTip } from './import/abr';
