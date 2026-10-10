---
"@pixerate/editor": minor
---

Spreadsheet engine correctness fixes (`SpreadsheetController` and the formula engine):

- **Recalculation order and cycles:** recalculation now follows dependency order, so loading a document where `A1` = `=A2*2` and `A2` = `=3+1` gives 8, not 0. Every cell in a reference cycle is marked `#CYCLE!`, and it stays marked across inserts, undo and full recalculations. Cells depending on a cycle show `#CYCLE!` too. Breaking the cycle recalculates every member. The dependency graph is rebuilt on full recalculation instead of keeping stale keys.
- **Inserting and deleting rows or columns rewrites references**, like spreadsheet apps. References after the change shift, ranges grow or shrink, references to a deleted row or column become `#REF!`, and `$` markers are kept. The new `shiftFormulaReferences(formula, change)` helper is exported.
- **`[property]` references** in column formulas resolve against the row being evaluated. Previously they used the selected cell's row, giving every row the same value.
- **Formula semantics** now follow spreadsheet conventions:
  - Errors propagate: `=1/0+1` gives `#DIV/0!`, not `NaN`, and `#REF!` literals are supported.
  - Unknown names and functions give `#NAME?`.
  - Unterminated strings and unexpected characters are formula errors.
  - `$A$1:$B$2` and whole-column ranges such as `A:A` now work.
  - `MIN`, `MAX` and `SUM` handle very large ranges without overflowing the stack.
  - `ROUND` rounds half away from zero without float drift: `ROUND(-2.5)` gives -3 and `ROUND(1.005, 2)` gives 1.01.
  - `IF` accepts the text `"TRUE"`/`"FALSE"`; other text gives `#VALUE!`.
  - Comparisons are type-aware: `"1"=1` is FALSE, and text comparisons are case-insensitive.
  - Blank cells act as `""` in text and 0 in arithmetic, so `=""&A1` is `""`.
  - `TODAY()` returns the local date.
- **TSV import (paste):** a paste is now a single undo step, recalculates once, keeps leading empty cells (`"\tB"` puts B in column B), and grows the grid without shifting references. Large pastes are dramatically faster: a 3,000-row formula chain dropped from minutes to under 100ms.
- `undo()` / `redo()` no longer leave the controller stuck in history mode if recalculation throws.

**Behavior changes:**
- Formulas referencing unknown bare names now return `#NAME?` instead of the name as text.
- Blank cells are passed to formulas as `""` instead of `0`.
- `tokenizeFormula` throws on unterminated strings and unexpected characters.
