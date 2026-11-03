---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Canvas, vector and the image editor paint from the shared brush library.

- **Canvas.** Brushed freehand strokes use the presets `CANVAS_PROFILE` admits, which replaces the hand-written filter. The listed set is unchanged.
  - `createCanvasDrawController` (and React `useCanvasDraw` / Svelte `createCanvasDraw`) takes a `brushLibrary`. Its saved brushes work in `drawStroke`, `canvas.drawFreehand` and the gestures, and are listed by `listBrushes` / `canvas.listBrushes` (`listCanvasBrushes(library)`).
  - A stroke drawn with a saved brush keeps a copy (`brush.spec`), so it renders without the library. Hand-drawn strokes take `style.brushSpec`.
  - Refusals now say why and name the ids to use, for example "Brush 'watercolor-round' (Watercolour round) can't brush a canvas stroke: Canvas has no wet surface. …".
  - New: `resolveCanvasBrushSpec`, and `renderCanvasBrushPreview` for the library tools' `preview_brush`.
- **Vector.** Brushstrokes use the presets `VECTOR_PROFILE` admits, which replaces the hand-written filter. The listed set is unchanged.
  - `VectorEditorController` takes a `brushLibrary`, with new `listBrushstrokeBrushes()` and `whenBrushesLoaded()`.
  - A saved brush is kept in the layer (`brush.spec`).
  - `vector.listBrushes` lists saved brushes with `builtin`.
  - Refusals say why (a preset the profile refuses) or give the closest ids (an unknown one).
- **Image editor.**
  - The `brushLibrary` option, with `setBrushPreset(id)` and `listBrushPresets()`. A preset sets the tool it needs (brush, Mixer Brush or eraser), its brush and mixer settings, and its own gradient.
  - `PaintOptions.brushPreset` records the preset, until the brush is changed by hand.
  - New agent tool `set_brush_preset`; `get_paint` returns `brushPreset`.
- **Brushes.** `snapshotBrushLibrary` keeps a synchronous copy of a library, for hosts that read synchronously.
- **UI.**
  - React and Svelte get a `brushes` subpath: `BrushLibraryBrowser` (moved from paint-editor, which re-exports it; thumbnails may be image URLs) and `useBrushLibrary` / `brushLibraryState`.
  - `<BrushOptionsBar>` gains Brush presets.
  - The vector brushstroke menu lists saved brushes.
  - `useCanvasBrushes` / `createCanvasBrushes` take a `library` and list its saved brushes with their `spec`.

**Migrating:**

- **Canvas and vector errors:** the refusal messages changed. Wet and other refused presets are now explained ("can't brush a canvas stroke: …", "can't paint a brushstroke: …") instead of saying "not a dry brush" or "Unknown brush".
- **`vectorBrushstrokeBrush(id)`:** it returns presets only. Use `vectorBrushstrokeBrushOf(brushstroke)` for a layer's brush.
