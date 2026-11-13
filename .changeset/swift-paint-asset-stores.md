---
"@pixerate/swift": minor
"@pixerate/editor": patch
"@pixerate/conformance": patch
---

Swift paint documents with external assets and their agent tools (#742). `PixeratePaint` adds external asset stores (`PaintAssetStore`, `PaintEditorController.toJSONExternal` and `loadJSONAsync`, with the TS core's asset ids, references and problems), `createPaintEditorDocument` (the `pixerate.editor-document` contract of kind `paint`: images as content-addressed asset references, revisions from the controller's new `documentRevision`, opening clears the history, read-only mid-stroke), `editorDocument(assets:name:)` / `openEditorDocument(_:assets:)` so an envelope reopens in Swift, and `createPaintDocumentToolProvider` with `get_paint_document` / `load_paint_document` (also registered by `PaintEditorModel`). `PixerateCore` adds `EditorAssetRegistry`, `externalizeAssets`, `internalizeAssets`, `collectAssetRefs`, `persistEditorAssets` / `preloadEditorAssets` over an `EditorStorage` (`MemoryEditorStorage`), `EditorDocumentSpec` `subscribe` and `assets`, `EditorDocument.destroy()`, and `createDocumentToolProvider` (`get_<kind>_document`, `load_<kind>_document`, `undo_<kind>`, `redo_<kind>`; `EditorDocumentHistory` now reports `documentHistoryState()`).

The paint contracts list the `paint-document` provider (`get_paint_document`, `load_paint_document`), `createPaintConformanceHost` registers it, and the new `document-tools` paint scenario calls both tools.
