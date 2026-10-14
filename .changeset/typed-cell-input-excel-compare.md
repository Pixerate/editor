---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Spreadsheet: typed cell input is now parsed into typed values, and comparisons follow Excel.

- New `parseCellInput(raw)` (numbers with `$`, `%`, thousands separators, scientific notation, `(100)` negatives, fractions such as `1 1/2`; dates such as `3/4/2026`, `4-Mar-2026`, `Mar 4, 2026`; times; TRUE/FALSE; error literals; a leading `'` forces text) and `parseNumberText(text)`. Dates stay ISO text (`2026-03-04`); a time on its own becomes a fraction of a day.
- `setCellValue`, TSV/CSV import, `importRows`, clipboard paste and autofill store the typed value in `value` and keep `raw` as typed. Cells get an automatic `numberFormat` (new optional `CellData` field) and, when the column format is unset or `text`, a matching `format` (`currency`, `percentage`, `date`, `number`). Documents saved with numeric-string values are re-parsed from `raw` on load.
- Writes to bound number/boolean/date fields are coerced by the field type before `updateRecord`; string and enum fields still receive the text as typed. Values read from data sources are never re-parsed.
- `compareValues` follows Excel: numbers < text < booleans < errors, numbers compared at 15 significant digits (`=0.1+0.2=0.3` is TRUE), blanks as 0/""/FALSE, ISO dates chronologically (and as serials against numbers). New `sortCompareValues` (blanks last), `compareNumbers`, `numberToText`. `&` and other text coercion print numbers with up to 15 significant digits; arithmetic coerces numeric text such as `"1,000"`, `"50%"` and date text.
- Table sort uses Excel's type order; filters and criteria (`SUMIF`, `COUNTIFS`…) read operands with the typed-input rules (`">1,000"`, `"10%"`, `">=3/1/2026"`).
- New `formatCellDisplay(cell)`, used by the React and Svelte grids, CSV/TSV export and clipboard text, shows typed values as entered (`10%`, `$1,200.50`, `3/4/2026`) and booleans as TRUE/FALSE.
