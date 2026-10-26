---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Bring the save / load / undo contract to the rich text, spreadsheet and design-token editors.

- `createRichTextEditorDocument(editor)` (root entry, kind `rich_text`: ProseMirror JSON checked against the schema; opening starts a fresh undo history), `createSpreadsheetEditorDocument(controller)` (kind `spreadsheet`: the whole workbook) and `createTokensEditorDocument(store)` (kind `tokens`: agent loads also refuse broken and cyclic aliases). Each gets `undo_<kind>` / `redo_<kind>` with the shared document tools.
- `SpreadsheetController`: `subscribe(listener)`, `loadWorkbook(workbook, { undoable: true })` (one undo step), and `undo()` / `redo()` now return whether anything happened.
- New `pixerate-tokens` agent skill.
- React: `useSpreadsheetEditor()` and `useTokens()` return `editorDocument`; new `useRichTextEditorDocument(editor)`.
- Svelte: `createReactiveSpreadsheet()` and `createTokens()` return `editorDocument`.
