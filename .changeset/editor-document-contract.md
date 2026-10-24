---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add one save / load / undo contract for editors, starting with the diagram editor.

- `@pixerate/editor/persistence`: `EditorDocument` and `defineEditorDocument` (whole-document JSON, loads that are checked and migrated first and change nothing on failure, a revision per document change, undo / redo), editor files that name their editor (`serializeEditorDocument`, `parseEditorDocument`), `createEditorAutosave` (crash recovery for any editor document), `createEditorDocumentStore` (named saves on any storage adapter) and `createDocumentToolProvider`, the same agent tools for every editor: `get_<kind>_document`, `load_<kind>_document` (one undo step), `undo_<kind>`, `redo_<kind>` and, with a store, `save_<kind>_document`, `list_saved_<kind>_documents` and `open_saved_<kind>_document`.
- `@pixerate/editor/diagram`: `createDiagramEditorDocument(controller)` (kind `diagram`, document `{ source }`).
- React: `useEditorAutosave(doc, options)` in `/persistence`; `useMermaidDiagram()` returns `editorDocument`.
- Svelte: `createEditorAutosave(doc, options)` in `/persistence`; `createMermaidDiagram()` returns `editorDocument`.
