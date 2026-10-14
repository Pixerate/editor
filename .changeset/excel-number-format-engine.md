---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add an Excel number-format engine (ported from GridCraft's numfmt): `NumberFormat.parse` never throws and supports up to four sections, `[>=100]` conditions, `[Red]`/`[ColorN]` colours, `,` scaling, `%`, scientific `E+`, `?` padding, fractions (`# ??/??`), `_x` spacing, `*x` fill, elapsed `[h]`/`[m]`/`[s]`, the `@` text section, date/time tokens and Excel's 15-significant-digit rounding (`2.675` → `2.68`); codes over 255 characters display as General. Also `formatNumberFormatValue`, `formatTextFunction`, `formatGeneralFit`, `builtinNumberFormat`/`builtinNumberFormatId` (ids 0–49), `numberFormatColorToCss`, `NUMBER_FORMAT_PRESETS` and `CellFormat` ↔ code mapping helpers.

`TEXT()` now uses the engine (text that is neither a number nor a date is returned unchanged, as in Excel, instead of `#VALUE!`). `formatCellForDisplay(cell)` returns the text, colour and whether the value is numeric; `formatCellDisplay` uses it, and numbers in cells with a `currency` / `percentage` / `date` `CellFormat` but no code use that kind's code. New `SpreadsheetColumn.numberFormat`, `CellData.explicitNumberFormat`, and undoable `setCellNumberFormat(range, code)` / `setColumnNumberFormat(colId, code)` on the controller (also on the React and Svelte spreadsheet state). Context menu items can be `checked` and ask for `input` (`runSpreadsheetMenuItem`).

React and Svelte grids render formatted values right-aligned for numbers with `[Red]`-style colours, and the table context menu gains "Format cells" presets (General, Number, Currency, Percent, Date, Time) and a Custom… code prompt.
