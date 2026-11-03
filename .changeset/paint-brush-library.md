---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

The paint editor paints from the shared brush library, and gets a brush editor.

- **Controller.** `PaintEditorController` takes a `brushLibrary` option (`@pixerate/editor/brushes`; default a library in memory). Pass one library to every editor so a brush saved in one shows in all of them. New methods: `setBrushFacets(patch, id?, unset?)`, `setBrushSpec(brush)`, `getBrushSpec(id?)`, `brushChanges(patch, from?)` and `whenBrushesLoaded()`.
- **Documents.** Paint documents are now version 2: recorded strokes and live strokes store facet brushes. Version 1 documents still load and replay to the same pixels; an editor that only reads version 1 refuses version 2 documents.
- **UI.** `<BrushEditor>` and `<BrushLibraryBrowser>` in React and Svelte, built on the new `brushEditorSections` and `brushLibraryGroups` from `@pixerate/editor/brushes`. `<BrushPanel>` now uses both: a library grouped by medium and variety with a filter, and the active brush edited by facet with a live preview and "Save brush".
- **Agent tools.** `createPaintBrushLibraryToolProvider(controller)` gives the brush library's tools (`list_brush_presets`, `describe_brush`, `create_brush`, `update_brush`, `duplicate_brush`, `remove_brush`, `export_brushes`, `import_brushes`, `check_brush`, `preview_brush`) on the editor's library, with previews painted on the editor's paper.

**Migrating:**

- **Tools removed from `createPaintEditorToolProvider`:** `list_brushes`, `save_brush`, `remove_brush`, `export_brushes`, `import_brushes` and `render_brush_thumbnail`. Register `createPaintBrushLibraryToolProvider(controller)` and use, in that order:
  - `list_brush_presets`;
  - `create_brush` (or `get_brush`, then `create_brush` with its `brush`);
  - `remove_brush`;
  - `export_brushes`, which returns `{ file }` in v2;
  - `import_brushes`, which takes `{ file, overwrite }`;
  - `preview_brush`.
- **`set_brush` takes facets** (`tip`, `marks`, `dynamics`, `behaviour`, `light`, `motion`, `colour`, `unset`) and returns `{ brush, engine, problems }`. `get_brush` returns `{ brush, engine, category, builtin, strokePaint }`. `paint_stroke` and `update_stroke` take facets for `brush` too. The flat fields are refused. Where they went:

  | Old field | New field |
  | --- | --- |
  | `particle` | `marks`, with `kind: 'particles'` |
  | `impasto` | `behaviour.thick` |
  | `behavior` | `behaviour.exchange` |
  | `paint` | `colour.default` |
  | `paint: null` | `unset: ['colour']` |
  | `sticker.stamps` | `tip.stamps` |
  | `rotation` | `dynamics.rotation` |
  | `grain` | `behaviour.grain` |

  `pixerate-paint-editor/references/brush-facets.md` maps every setting.
- **Async controller methods:** `saveBrush`, `removeBrush`, `exportBrushes` and `importBrushes` return promises. `exportBrushes` writes version 2 files.
- **Error hints:** errors that used to point to `list_brushes` now point to `list_brush_presets`.
