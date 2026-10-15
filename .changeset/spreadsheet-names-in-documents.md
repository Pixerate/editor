---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Spreadsheet defined names now survive the single-document save path. Apps that only save the document passed to `onDocumentChange` (including through `useSpreadsheetEditor` and `createReactiveSpreadsheet`) lost every defined name on reload. Each sheet document now has an optional `names` array: all the workbook-scoped names plus that sheet's own sheet-scoped names. The controller updates it on every change, including define, rename, delete, undo and redo.

`new SpreadsheetController({ document })`, `loadDocument` and `addSheet({ document })` read these names back. Any `sheetId` in a document's names means "this sheet". When a workbook is loaded, `workbook.names` wins over the same names repeated in `sheets[*].names`, and names found only in sheet documents are added (the first sheet wins). `getWorkbook()` is unchanged: names stay in `names` only. Saved documents and workbooks without these fields load as before. `new SpreadsheetController({ workbook })` no longer changes the `id`, `name` or `names` of the sheet objects passed in.
