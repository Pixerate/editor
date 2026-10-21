---
name: pixerate-spreadsheet
description: How to read and edit a Pixerate spreadsheet through agent tools - reading cells and formula results in A1 notation (get_range), writing values and formulas in bulk (set_range, set_cell), inserting and deleting rows and columns with reference shifting, merging, unmerging and transposing ranges, and the spreadsheet.* commands for filters and hidden rows. Covers tidy-data layout, formulas versus values, supported functions (SUM, XLOOKUP, FILTER, LAMBDA and more) and formula errors such as #REF!, #DIV/0! and #SPILL!. Use when asked to fill, clean, restructure, calculate, total or summarise data in a spreadsheet, sheet, grid, table of cells or workbook.
---

# Editing spreadsheets

A spreadsheet is a grid of rows and columns addressed in **A1 notation**: columns are
letters (`A`, `B`, ..., `AA`), rows are 1-based numbers, a range is `A1:C10`. Each cell has
**raw input** (what was typed, e.g. `=SUM(B2:B9)` or `1,234`) and a **computed value**
(`4200`), plus an error code when evaluation fails. There are no cell ids; the address is the
handle. Typed input is parsed like a spreadsheet app: `1,234`, `$5`, `10%`, `(100)` become
numbers, `TRUE` becomes a boolean, `3/4/2026` becomes the ISO date `2026-03-04`, and a
leading `'` forces text.

Errors, namespacing and `run_commands` batching are in the `pixerate-agent-tools` skill.

## Working method

1. **Read.** `get_range` on the area you will touch (and its header row). The result gives
   the sheet size (`sheet.rows`, `sheet.columns`), `values`, `raw` and `errors`. Read a
   generous range such as `A1:Z50` when you do not know where the data is; it is clamped to
   the sheet.
2. **Plan the layout** before writing: where the header row goes, which columns hold inputs
   and which hold formulas, where totals go.
3. **Write in blocks.** One `set_range` per rectangular block (headers plus data, or a whole
   formula column) instead of many `set_cell` calls. It is one undo step, grows the sheet to
   fit, and refuses the whole write if any target cell is read-only.
4. **Check.** Every write returns `errors` for the cells it wrote; `get_range` the dependent
   area (totals, lookups) to confirm the computed values. Fix every `#` error before you
   finish.
5. **Restructure deliberately.** Use `insert_rows` / `insert_columns` to make room so
   formulas shift with the data; never move data by rewriting it cell by cell.

## Best practices

- **Tidy data.** One header row of short, unique, plain-text names. One variable per column,
  one record per row, one data type per column. No blank rows or columns inside a data
  region, no subtotals mixed into the data, no notes in data cells.
- **Inputs, then calculations, then outputs.** Keep raw inputs in their own cells or columns
  and derive everything else with formulas, so a change to an input flows through. Never
  type a computed number over a formula.
- **Formulas over pasted values** whenever the result depends on other cells (totals,
  ratios, lookups). Write a literal value only for genuine inputs.
- **No magic numbers.** Put rates and thresholds in a labelled cell and reference it with an
  absolute reference (`=B2*$F$1`), rather than writing `=B2*0.2`.
- **Whole-column formulas.** Write a calculated column as one `set_range` with a formula per
  row (`[["=B2*C2"], ["=B3*C3"], ...]`), or use a dynamic array once at the top
  (`=B2:B100*C2:C100`) and leave the cells below it empty for the spill.
- **Ranges that grow.** Totals over a whole column (`=SUM(B:B)`) or over a range that
  includes a spare row stay correct when rows are appended; put totals above the data or in a
  separate column if you use whole-column references, so the total does not include itself.
- **Prefer robust lookups.** `XLOOKUP` or `INDEX`/`MATCH` with exact match over `VLOOKUP`
  with a hard-coded column number, which breaks when a column is inserted.
- **Handle expected errors explicitly** with `IFERROR` / `IFNA` around lookups and divisions,
  and only where an error is expected, so real problems still show.
- **Keep data regions unmerged.** Merged cells break sorting, filtering, transposing and
  formulas; use them only for titles outside the data.
- **Consistent types.** Dates as dates (ISO text `2026-03-04` is safe), numbers without
  units in the cell (put the unit in the header: `Revenue (USD)`), percentages either as
  `10%` or `0.1` throughout a column.

## Supported formulas

Operators: `+ - * / ^ & = <> < > <= >=`, whole-column (`A:A`) and absolute (`$A$1`)
references, spill references (`A1#`). Functions, by group:

- Math: SUM, PRODUCT, ROUND, ROUNDUP, ROUNDDOWN, INT, ABS, SIGN, SQRT, POWER, MOD, CEILING,
  FLOOR, PI, RAND, RANDBETWEEN.
- Statistics: AVERAGE, COUNT, COUNTA, COUNTBLANK, MIN, MAX, MEDIAN, MODE, STDEV, VAR, LARGE,
  SMALL, RANK.
- Conditional: SUMIF(S), COUNTIF(S), AVERAGEIF(S), MAXIFS, MINIFS.
- Logical: IF, IFS, IFERROR, IFNA, SWITCH, AND, OR, XOR, NOT.
- Lookup: XLOOKUP, VLOOKUP, HLOOKUP, INDEX, MATCH.
- Text: CONCAT, TEXTJOIN, UPPER, LOWER, PROPER, TRIM, LEN, LEFT, RIGHT, MID, FIND, SEARCH,
  SUBSTITUTE, REPLACE, REPT, EXACT, VALUE, TEXT. (No CONCATENATE; use `&` or CONCAT.)
- Date: TODAY, NOW, DATE, YEAR, MONTH, DAY, WEEKDAY, DAYS, EDATE, EOMONTH, NETWORKDAYS,
  DATEDIF.
- Information: ISBLANK, ISNUMBER, ISTEXT, ISERROR, ISNA.
- Dynamic arrays: FILTER, SORT, SORTBY, UNIQUE, SEQUENCE, TRANSPOSE, RANDARRAY, LET.
- Lambda: LAMBDA, MAP, REDUCE, SCAN, BYROW, BYCOL, MAKEARRAY, ISOMITTED.

An unlisted function gives `#NAME?`. Error codes: `#DIV/0!`, `#VALUE!`, `#REF!` (a referenced
cell was deleted), `#NAME?`, `#N/A` (lookup miss), `#NUM!`, `#CYCLE!` (circular reference),
`#SPILL!` (an array result is blocked by non-empty cells or the sheet edge), `#CALC!`,
`#ERROR!`.

## Tool reference

### Read

| Tool | Use it to |
| --- | --- |
| `get_range` | Read a cell or range (`range`: `"B2"` or `"A1:C5"`). Returns `range` (clamped to the sheet, null if outside it), `values` (computed, row by row), `raw` (the input or formula text), `errors` (`[{cell, error}]`), `merges` (merged ranges touching it, e.g. `["A1:C1"]`; a merged range keeps its value in its top-left cell) and `sheet` size. Read before every write and after it to check computed results. |

### Write

| Tool | Use it to |
| --- | --- |
| `set_range` | Write a 2D block of raw inputs from `start` (top-left cell), row by row, as one undo step. Strings starting with `=` are formulas; `null` or `""` clears a cell; numbers and booleans are stored as typed. Up to 10000 rows by 1000 columns. The sheet grows to fit. All-or-nothing: any read-only target cell fails the whole write. Returns the written `range`, `written` count, `errors` and new `sheet` size. The default write tool. |
| `set_cell` | Set one cell's raw input (`cell` in A1, `value` string, number or boolean; `=` starts a formula). Returns `raw` and the computed `value`. Fails outside the sheet (it does not grow it; use `set_range` or `insert_rows` first) and on read-only cells. Use for a single fix, not for filling data. |
| `insert_rows` | Insert `count` (default 1, max 1000) empty rows before row number `before` (1-based; one past the last row appends). Formula references below shift down. |
| `delete_rows` | Delete `count` rows from row `start` with their contents. References below shift up; formulas that pointed at deleted cells become `#REF!`. Read dependents first. |
| `insert_columns` | Insert `count` empty columns before column letter `before` (one past the last column appends). References to the right shift. |
| `delete_columns` | Delete `count` columns from column letter `start` with their contents. References shift left; references to deleted cells become `#REF!`. |
| `merge_cells` | Merge a `range` of at least two cells into one showing the top-left value, as one undo step. Every other value in the range is cleared, and the result lists the `cleared` cells: move content into the top-left cell first. Refused when the range partly overlaps an existing merge (the error names it), touches read-only cells or a spill range, or leaves the sheet. Use for titles above a table, never inside data. |
| `unmerge_cells` | Split every merge touching a `range` (a single cell is enough) back into cells; the value stays top-left. Returns the ranges unmerged; fails when there are none (`get_range` lists them). Unmerge before sorting, filtering or transposing a region. |
| `transpose_range` | Swap rows and columns of a `range` in place, anchored at its top-left (`A1:C2` becomes `A1:B3`), moving values, formulas and formats; formulas that pointed into the range follow their cells. Cells the new shape covers outside the old range are overwritten, so check that area is empty first. Refused across merges (unmerge first), read-only cells or spills. Returns the new range. |

## Commands

Run with `run_command` when the host registers them. Merge, unmerge and transpose act on the
**user's current selection** and are disabled with "Select a range first." without one; use
the `merge_cells`, `unmerge_cells` and `transpose_range` tools instead, which take a range.
Use these commands only when the user asks you to act on what they selected. When there is
nothing to do they fail with the reason.

| Command | Use it to |
| --- | --- |
| `spreadsheet.toggleFilters` | Turn filtering on or off (existing filter rules are kept). Filters hide rows in the view only; data and formulas are unchanged. |
| `spreadsheet.clearFilters` | Remove all filter rules. Disabled when there are none. |
| `spreadsheet.unhideAll` | Show every hidden row and column. Do this before reasoning about what the user sees versus what `get_range` returns. |
| `spreadsheet.mergeCells` | Merge the user's selected range (as `merge_cells`). Destroys every value except the top-left one. |
| `spreadsheet.unmergeCells` | Remove every merge intersecting the user's selection (as `unmerge_cells`). |
| `spreadsheet.transposeRange` | Transpose the user's selected range in place (as `transpose_range`). |

## Pitfalls

- With agent playback on, `set_cell` is clicked and typed, `set_range` is dragged across the block it fills, and row and column edits mark their rows or columns. Results are unchanged; keep writing whole blocks with `set_range`.
- **Raw versus computed.** `values` holds results, `raw` holds what to edit. When copying or
  moving a formula, copy from `raw`; `set_range` writes references as given (it does not
  offset relative references the way paste or fill-down does), so write each row's formula
  with its own row number.
- **Strings that look like formulas or numbers.** Any string starting with `=` becomes a
  formula; `"007"` becomes the number 7. Prefix with `'` to keep text (`"'007"`).
- **Read-only cells.** Formula-type columns, read-only columns and read-only cells refuse
  writes; `set_range` names the cells and writes nothing. Write around them, or tell the user.
- **Spills.** Leave the cells below and right of a dynamic-array formula empty; anything there
  turns the anchor into `#SPILL!`. Spilled cells show values in `get_range` but have empty
  `raw` and cannot be edited on their own; edit the anchor formula.
- **Deleting rows or columns** turns references to the deleted cells into `#REF!`, and ranges
  that cross the deletion shrink. Check `get_range` on dependent totals afterwards.
- **Hidden and filtered rows** are still in the sheet and in `get_range` results and are still
  counted by `SUM`; only the view hides them.
- **Dates** are stored as ISO text (`2026-03-04`); compute with date functions, not string
  operations.
- **Large ranges.** Read only what you need; a full read of a big sheet costs many tokens.
