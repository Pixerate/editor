---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

One brush editor for every editor that paints, scoped to what each host can use.

- `BrushEditor` moved to `@pixerate/editor-react/brushes` and `@pixerate/editor-svelte/brushes` (still exported from `paint-editor`). It takes a brush, a host profile, a preview (pixels or an image URL) and `onSave` / `onSaveAs`, and names what the brush has that the host can't use.
- New `BrushLibraryEditor` on a brush library: edits a saved brush in place, saves built-ins as a copy, and starts new brushes for the host.
- `brushEditorSections` now lists only the sections, controls and options a host profile uses (no velocity on canvas, no grain or pick-up in the image editor, no engine controls for an engine the host lacks).
- Core: `brushEditorScope`, `checkBrushEdit`, `withKeptIssues`, `newBrushFor`, `saveBrushEdit`, `brushIdFromName`, `isBrushLibrary`, `degrade(…, { ignored })`, `paintBrushPreviewRenderer`, and vector `brushLibrary` / `refreshBrushes`.
- `update_brush` keeps facets the host can't use that the brush already had (returned as `kept`) and refuses only changes that add them.
- `vector.setBrushstroke` / `setBrushstroke` with the same `brushId` takes the saved brush as the library has it now.
- "Edit brush…" in the image `BrushOptionsBar`, and a library picker plus "Edit brush…" on vector brushstrokes in `VectorAppearancePanel`. Their previews come from a new `brushPreview` option on the image and vector controllers (or a `renderBrushPreview` prop).
