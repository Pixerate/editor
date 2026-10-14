---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Spreadsheet table operations, CSV and rich clipboard.

- `SpreadsheetController` gains undoable table operations: `sortRows` (multi-column, stable, numbers before text, blanks last; whole table or a range; header/footer rows stay put), filters (`addFilterRule`, `setFilterRules`, `updateFilterRule`, `removeFilterRule`, `clearFilters`, `setFiltersEnabled`, `toggleFilters`), header/footer/frozen row and column counts, `hideRows`/`hideColumns`/`unhideRows`/`unhideColumns`/`unhideAll`, `mergeCells`/`unmergeCells` (selection, navigation and editing respect merges), `autofill` (number/date series, "Item 1" → "Item 2", formulas with relative references shifted), categories (`groupRowsBy`, `setGroupSummary`, `toggleGroupCollapsed`, `getGroups`) and `transposeRange`. Sort and transpose keep formula references pointing at the moved cells, and merges follow row/column inserts and deletes.
- `getViewModel()` / `buildSpreadsheetView()` describe what to render: visible rows (with group headers) and columns in display order, frozen offsets and merged-cell spans. Keyboard navigation follows the view, skipping hidden, filtered and collapsed rows.
- New RFC 4180 CSV module (`parseCsv`, `serializeCsv`, `parseTsv`, `serializeTsv`) and `importFromCsv` / `exportToCsv`.
- New spreadsheet clipboard: `copyToClipboardData` writes `text/plain` (TSV), `text/html` (a table) and `application/x.pixerate.spreadsheet+json` (raw inputs and formulas); `pasteClipboardData` prefers that format (formulas re-based to the target), then HTML tables, then TSV.
- New core helpers: `offsetFormulaReferences`, `remapFormulaReferences`, `mapFormulaReferences`, `fillSeries`, `computeFillTarget`, `compareCellValues`, `matchesFilterRule`, `aggregateValues`, `getSpreadsheetMenuItems`, `bindSpreadsheetTableActions`.
- React (`useSpreadsheetEditor`, `<SpreadsheetEditor />`) and Svelte (`createReactiveSpreadsheet`, `<SpreadsheetEditor />`) expose every table action plus `viewModel`, and render frozen panes (sticky), merged cells, hidden rows/columns, filtered-column markers and collapsible category headers with summaries. Both add a right-click table menu, a fill handle for autofill, and copy/paste of all three clipboard formats. Mod+C now lets the browser's `copy` event write the rich formats, falling back to `navigator.clipboard.writeText` (TSV) when no copy event fires.
