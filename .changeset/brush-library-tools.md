---
"@pixerate/editor": minor
---

Add the brush library, host profiles and agent tools to `@pixerate/editor/brushes` (brush module phase 2).

- **Host profiles.** `PAINT_PROFILE`, `IMAGE_PROFILE`, `CANVAS_PROFILE` and `VECTOR_PROFILE` (also `BRUSH_HOST_PROFILES`) say what each host can render. Each capability is `full`, `ignored` (the brush renders without it, with a warning) or `none` (refused). `checkBrush(brush, profile)` returns `{ ok, issues }`, each issue with its facet, severity, reason and fix. `listPresets(profile)` filters the library, and `degrade(brush, profile)` strips what a host refuses and says what it dropped. The canvas and vector profiles list exactly the brushes their hand-written filters allow today; those editors don't read the profiles yet.
- **Library.** `createBrushLibrary({ storage, namespace, presets })` holds the built-in presets plus user brushes on any `StorageAdapter` (memory only without one). It has `list` (filter by kind, medium, variety, tool, tag, text, source or host), `get`, `save`, `remove`, `duplicate`, `exportFile`, `importFile` and `subscribe`. Built-in ids are protected. Library files are `pixerate-brushes` version 2, and `parseBrushLibrary` still reads version 1 files by migrating each brush.
- **Agent tools.** `createBrushLibraryToolProvider(library, { profile, renderPreview, readOnly })` adds `list_brush_presets`, `describe_brush`, `create_brush` (optionally `basedOn` a brush), `update_brush`, `duplicate_brush`, `remove_brush`, `check_brush`, `export_brushes` and `import_brushes`. `preview_brush` is added only when the host passes a renderer. Writes are normalised and checked against the host before anything is stored. The tools live in their own `brushes` namespace, apart from the paint editor's brush tools.
- **Skills.** New `pixerate-brushes` reference skill, and a `pixerate-brushes-design` workflow skill with three evals (new eval fixture `editor: 'brushes'`).
