---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Faster recalculation for formulas over ranges, and virtualised rendering of large sheets.

- **Range-aware dependency graph** (`@pixerate/editor`): ranges are stored whole in an interval index (per column, plus a per-sheet index for ranges wider than 64 columns) instead of one key per cell, so `=SUM(A1:A50000)` and `=SUM(A:A)` are one entry each and an edit finds its dependents in O(log n + k). Only the dirty subgraph is recalculated, in topological order, with cycles, spills, cross-sheet / 3-D / defined-name references and LAMBDA unchanged. New: `IntervalIndex`, `extractReferenceDependencies`, `rangeDependencyKey`, `DependencyGraph.dependsOn` / `setVolatile` / `getVolatileKeys` / `detachSpilledCell` / `getIndexStats`, `getEvaluationPlan(keys, { includeVolatile })`, and `SpreadsheetController.getRecalculationStats()` (formulas evaluated by the last recalculation). `DependencyGraph.getDependencies` now returns range keys (`A1:A3`, `A:`) rather than every cell of a range.
- **Volatile functions** (`NOW`, `TODAY`, `RAND`, `RANDBETWEEN`, `RANDARRAY`, also through defined names) now recalculate on every edit, as in Excel.
- **Bulk loads**: CSV import, `importRows`, paste and autofill register formulas once and recalculate in one plan (one full evaluation when the grid grows); row and column lookups by id no longer scan the sheet, so a 50k-row CSV import goes from ~23 s to ~0.5 s.
- **Single-cell edits** are undone from a record of that cell instead of a whole-sheet snapshot (an edit on a 50k-cell sheet: ~25 ms → ~0.2 ms).
- **Evaluation fast paths**: `SUM`, `PRODUCT`, `AVERAGE`, `COUNT`, `COUNTA`, `MIN` and `MAX` read range arguments without materialising blank cells (`EvaluationContext.resolveRange` gets an optional `{ skipBlanks }` hint), large ranges read by several formulas are resolved once per recalculation, and formulas are parsed once for registration and evaluation.
- **Fixes**: a blocked dynamic array no longer becomes `#CYCLE!` through its blockers, and stale spill edges no longer cause false cycles after re-entering an anchor or typing into a spilled cell.
- **Virtualised rendering**: new core helpers `measureSpreadsheetView`, `getSpreadsheetViewWindow`, `getSpreadsheetScrollToCell` and `shouldVirtualizeSpreadsheet`. React (`useSpreadsheetViewport`) and Svelte (`createSpreadsheetViewport`) `SpreadsheetEditor`s render only the visible rows and columns plus overscan for sheets over 200 rows or 60 columns (`virtualize` prop: `'auto'` | `true` | `false`), keeping frozen panes, merged cells, row groups, conditional formats, selection, column resizing and keyboard navigation (the active cell scrolls into view). Smaller sheets render as before. `SpreadsheetGroupRow` accepts `labelColumns`, `leadingColumns`, `leftSpace` and `rightSpace` for windowed columns.
