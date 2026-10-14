---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Spreadsheet dynamic arrays and date arithmetic.

- **Spilling**: a formula returning several values (`=A1:A3`, `=A1:A3*2`, `=SEQUENCE(3)`, `INDEX(..., 0, n)`, 2D `XLOOKUP` results) spills into the cells below and to the right. Spilled cells keep an empty `raw`, carry `CellData.spillAnchor` and are not stored in the document. A blocked spill (non-empty cell, merged cells, another spill, or the edge of the sheet; the grid never grows) shows `#SPILL!` with a message naming the blocking cell. Typing into a spilled cell blocks the array; clearing it restores the spill. New controller methods `getSpillAt(row, col)` and `getSpills()` return `SpreadsheetSpill` objects.
- **Recalculation**: spill ranges join the dependency graph (`DependencyGraph.setSpillEdges`), so dependents of spilled cells recalculate when the array changes size, and cycles through spills are `#CYCLE!`.
- **`A1#` spill references** in the lexer (`SPILL_REF`), parser (`SpillRef`), evaluator (`EvaluationContext.resolveSpill`) and reference rewriting (insert/delete, paste/autofill offsets, sort/transpose remaps, clipboard JSON).
- **Array functions**: FILTER, SORT, SORTBY, UNIQUE, SEQUENCE, TRANSPOSE, RANDARRAY and LET; element-wise arithmetic, comparison and `&` on arrays with broadcasting; scalar functions such as IF, LEN, ROUND and IFERROR apply element by element (`FormulaFunctionDefinition.elementwise`); implicit intersection `@`. New error codes `#SPILL!` and `#CALC!`. `evaluateWithDiagnostics` now also returns multi-value results in `array` (`value` is still the top-left value). LAMBDA is not implemented.
- **Dates**: `date + n` / `date - n` return ISO dates, `date - date` returns days, and ISO dates compare chronologically. TRIM collapses inner runs of spaces like Excel.
- **Table operations**: sorting, merging and transposing a range that touches a spill are refused; CSV/TSV export writes spilled values; copying spilled cells without their anchor pastes them as values.
- **React / Svelte**: the spreadsheet editors draw a border around the active spill range and show the anchor's formula greyed out in the formula bar for spilled cells.
