---
"@pixerate/editor": patch
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Fix spreadsheet keyboard handling in React and Svelte:

- **Formula bar:** keystrokes no longer fall through to the grid. Previously Backspace in the formula bar cleared the active cell, arrow keys moved the cursor, and Enter re-opened the cell editor. In React, typing in the formula bar now actually edits the value; it commits on Enter or blur and is discarded on Escape. The formula bar is read-only for read-only sheets and columns.
- **Redo:** Cmd/Ctrl+Shift+Z now redoes (with Shift held, `e.key` is `"Z"`), and Ctrl+Y is supported.
- **Copy:** Cmd/Ctrl+C copies the selected range instead of the whole sheet. `SpreadsheetController.exportToTsv(range?)` accepts an optional range.
- **React column resize:** `onColumnResize` now fires when the pointer stops moving before mouseup. Previously the effect re-subscribed after every width update and lost the drag state.
- **React `useSpreadsheetEditor`:** the initial `document` now reflects the controller, so `<SpreadsheetEditor />` without a document renders the default grid immediately instead of an empty table. The `onDocumentChange`, `onSelectionChange` and `onCellCommit` callbacks are no longer captured once at mount.
