---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Tables in the rich-text editor.

- **Behaviour change:** `createRichTextPreset` now includes tables by default (TipTap's `table`, `tableRow`, `tableHeader`, `tableCell` nodes): resizable columns, header rows/columns/cells, `colspan` / `rowspan` (kept from pasted HTML and from DOCX and PDF import, which were previously flattened into paragraphs), cell `align` and `backgroundColor`, and table node selection. Pass `table: false` to keep the old flattening, or `table: { … }` to configure them. `createRichTextToolProvider` now also lists an `edit_table` tool when the schema has tables.
- New table API: `TABLE_ACTIONS`, `getTableActionState` (with reasons such as "Place the cursor in a table first."), `runTableAction`, `getTableState`, `createTableStore`, `createTableCommands` (command registry: `table.insertTable`, `table.addRowAfter`, `table.mergeCells`, `table.toggleHeaderRow`, `table.goToNextCell`, `table.setCellAlignment`, …), `DEFAULT_TABLE_TOOLBAR`, `shouldShowTableBubbleMenu`, `createTableExtensions`.
- Export: plain text writes table rows as lines of tab-separated cells; markdown writes GFM pipe tables (header alignment, escaped `|`) when representable and HTML otherwise; GFM tables in markdown import as tables. The HTML sanitizer now allows `colgroup`, `col` and `colwidth`.
- Track changes: inserted and deleted rows, columns and tables are tracked as whole-block changes (reject removes inserted ones, accept removes deleted ones); header toggles are tracked block changes; merging/splitting cells is disabled while tracking. Whole-block changes inside tables are described as "Inserted 2 table cells".
- React: `TableToolbar`, `TableBubbleMenu`, `InsertTableGrid`, `useTableMenu`. Svelte: `TableToolbar`, `TableBubbleMenu`, `InsertTableGrid`, `createTableMenu`.
