---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Spreadsheet formula engine: function registry, 70 new functions, diagnostics and autocomplete.

- **Function registry** (`@pixerate/editor`): every formula function now has a category, description and argument specs. Use `registerFormulaFunction` / `unregisterFormulaFunction` to add or override functions, `listFormulaFunctions` / `searchFormulaFunctions` for function browsers, and `getFormulaSignature` (e.g. `SUMIF(range, criteria, [sum_range])`) / `getFormulaSignatureParts` for hints. The existing 16 functions moved onto the registry unchanged.
- **New functions**: IFERROR, IFNA, AND, OR, NOT, XOR, IFS, SWITCH, SUMIF(S), COUNTIF(S), AVERAGEIF(S), MAXIFS, MINIFS, COUNTBLANK, INDEX, MATCH, XLOOKUP, VLOOKUP, HLOOKUP, LEFT, RIGHT, MID, FIND, SEARCH, SUBSTITUTE, REPLACE, REPT, TEXTJOIN, PROPER, EXACT, VALUE, TEXT, ROUNDUP, ROUNDDOWN, INT, MOD, POWER, SQRT, PRODUCT, MEDIAN, MODE, STDEV, VAR, LARGE, SMALL, RANK, CEILING, FLOOR, SIGN, PI, RAND, RANDBETWEEN, NOW, DATE, YEAR, MONTH, DAY, WEEKDAY, EDATE, EOMONTH, NETWORKDAYS, DATEDIF, ISBLANK, ISNUMBER, ISTEXT, ISERROR, ISNA. Criteria support `">5"`, `"<>x"`, `"=a"` and `*` / `?` wildcards.
- **Diagnostics**: `FormulaEvaluator.evaluateWithDiagnostics()` returns `{ value, error, message }` with argument-indexed messages (`Argument 1 of SUMIF must be a range.`), unknown-function, argument-count and circular/self-reference messages. Cells get an optional `CellData.errorMessage`, and `CellData.error` now carries the code for value errors such as `#DIV/0!` (previously only set for `#CYCLE!` and malformed formulas). Wrong argument counts now return `#ERROR!` instead of throwing.
- **Autocomplete**: `getFormulaCaretContext`, `getFormulaHints` and `applyFormulaSuggestion` in core; new `FormulaHints` components in React and Svelte, wired into the cell editor and formula bar of `SpreadsheetEditor` (ArrowUp/Down to choose, Tab or click to accept, Escape to close). Error cells show their message as a tooltip.
