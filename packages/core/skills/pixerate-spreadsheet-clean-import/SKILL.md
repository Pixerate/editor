---
name: pixerate-spreadsheet-clean-import
description: The clean-up workflow for imported data in a Pixerate spreadsheet - a CSV export, a pasted table or a report dump turned into tidy data. Covers finding the data region, profiling each column, removing title, blank, total and repeated header rows, normalising headers, fixing types (numbers stored as text, currency and European decimals, day-first dates read month-first, lost leading zeros, missing-value markers), trimming and unifying text, removing duplicates by a key, and validating the result without damaging the source. Use when asked to clean, tidy, fix, normalise, deduplicate or prepare imported or pasted data for analysis, or when a column will not sum or sort. Load with pixerate-spreadsheet, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-spreadsheet
---

# Cleaning imported data

Imported data arrives as typed text: each cell is parsed the way a person's typing is (en-US),
so `$1,200.00` and `(45)` become numbers, `3/4/2026` becomes the ISO date `2026-03-04`, and
anything the parser does not recognise (`USD 300`, `1.250,50`, `31/03/2026`, `n/a`) stays text.
`get_range` shows both sides: `raw` is what was typed, `values` what it became. Cleaning is
reading both, deciding what each column should be, and writing it back in blocks.

This skill is the method. `pixerate-spreadsheet` has the full tool reference and the formula list.

## Goal and quality bar

- One header row of short, unique, trimmed names, with units in the header (`Amount (USD)`).
- One record per row: no title, notes, blank, subtotal, total or repeated header rows inside the data.
- One type per column: numbers are numbers (they sum), dates are ISO dates, codes that must keep
  leading zeros are text, missing values are empty cells (not 0, not `n/a`).
- Text is trimmed and each category is spelled one way (`North`, not `north` and `NORTH `).
- No duplicates by the key the user chose; the right row of each set is kept.
- Nothing is lost by accident: the user can see what changed, and undo it.

## Inputs to confirm

Ask when you cannot tell from the data; say what you assumed when you can.

- **In place or beside?** Clean the cells in place (the default for a sheet that is only an
  import), or keep the raw columns and add clean ones next to them (when the raw data is the
  only copy, or must be audited).
- **Date order** of the source: month-first (US) or day-first (most other places). A raw date
  whose first part is above 12 (`31/03/2026`) settles it.
- **The duplicate key** (which columns make two rows the same record, and whether case and
  spaces count) and **which row wins** (first, last, most recently updated, most complete).
- **Missing values:** empty (the default), or a value the user names. Never 0 unless told.
- **Category spelling:** the canonical form when variants disagree (`North` or `north`).

## Working method

1. **Find the data and keep a way back.** `get_range` a generous area (`A1:Z60`) and find the
   header row, the first and last data row and any title, notes or total rows. If rows are
   hidden or filtered, run `spreadsheet.unhideAll` or `spreadsheet.clearFilters` first so the
   user sees what you clean. Before a large rewrite, `get_spreadsheet_document` keeps a copy
   that `load_spreadsheet_document` can restore; small steps are each one `undo_spreadsheet`.
   **Check:** you can name the data range and each column's intended type.
2. **Profile each column** from `raw` and `values` together: numbers stored as text (a string in
   `values` where the rest are numbers), currency codes, comma decimals, slash dates and their
   order, codes that lost leading zeros (a number where text is expected: ZIP, ID, phone),
   missing-value markers (`n/a`, `-`, `NULL`, `?`), stray spaces and case variants.
   **Check:** a list of problems per column, with counts. Report anything you will not fix.
3. **Fix the structure.** `unmerge_cells` over the region first. Delete title, notes, blank,
   total and repeated header rows with `delete_rows`, from the bottom up so earlier row numbers
   stay valid, or rewrite the whole block and delete the leftover tail once.
   **Check:** `get_range` shows the header in row 1 of the region, data directly below, and
   `sheet.rows` is the count you expect.
4. **Fix the headers** in one `set_range` over the header row: trimmed, unique, plain names,
   units in the header and not in the cells.
   **Check:** no duplicates, no leading or trailing spaces.
5. **Fix the values, a column (or a block) at a time** with `set_range`: numbers as JSON
   numbers, dates as ISO text, text codes with a leading `'` (`'02134`), missing values as
   `null`. For a large table use formula columns (see the recipes) rather than copying values
   through the conversation.
   **Check:** the returned `errors` is empty, and a `get_range` of the column shows one type.
6. **Remove duplicates** by the confirmed key, keeping the winning row of each set. Rewrite the
   kept rows as one block and delete the rest, or delete the losing rows from the bottom up.
   **Check:** the row count fell by the number of duplicates you found in step 2.
7. **Validate the whole region.** `get_range` it once more: `errors` is empty, every column has
   one type, totals you can compute (a sum of amounts, a row count) match what you expect from
   the source. For a big sheet, count in scratch cells instead of reading every value (see the
   recipes), then clear them.
   **Check:** every problem from step 2 is fixed or reported.
8. **Report** what changed: rows removed (blank, total, duplicate) and why, columns converted,
   assumptions (date order, the key, the canonical spelling) and anything left for the user.

## Decision table

| Situation | Approach |
| --- | --- |
| Small table (a few hundred cells to change), sheet is only an import | Read, then rewrite the cleaned block in place with `set_range`; delete leftover rows |
| Large table, or the raw data must stay | Formula columns beside the raw ones (`=TRIM(C2:C5000)`, `=MAP(...)`); the raw columns stay as they are |
| One or two broken columns, the rest fine | `set_range` on those columns only; leave every other cell untouched |
| Numbers with a currency code or unit (`USD 300`, `12 kg`) | Strip it, put the unit in the header; ask when one column mixes currencies |
| Comma decimals (`1.250,50`) | Convert to `1250.5`; then check that cells the parser already turned into numbers (`1,250` read as 1250) were not meant as `1.25` |
| Slash dates, source is day-first | Rewrite every slash date in the column from `raw` as ISO, including the ones that already parsed (they parsed month-first and are wrong) |
| Codes that must keep zeros (ZIP, ID, phone) | Text with a leading `'`, padded to the code's length |
| Missing markers (`n/a`, `-`, `NULL`) | Empty cell (`null`), unless the user names a value |
| Exact duplicate rows | Keep the first |
| Same key, different details | Keep the row the user chose (latest, most complete); say which you dropped |
| Merged title cells above the header | Unmerge, then delete the title rows or leave them above the data with a blank row between |

## Recipes

**Rewrite in place (small table).** `get_range` the region; build the clean block (header plus
kept rows) in one `set_range` from the top-left cell; `delete_rows` the rows left below it.
That is two undo steps, and every cell the user had is accounted for in your report.

**Formula columns (large table).** Insert clean columns with `insert_columns` to the right of
the raw ones and write one spilling formula at the top of each, leaving the cells below empty:

- Trim text: `=TRIM(C2:C5000)`; one spelling: `=MAP(E2:E5000,LAMBDA(v,PROPER(TRIM(v))))`.
- Currency text to numbers: `=MAP(D2:D5000,LAMBDA(v,IF(ISNUMBER(v),v,VALUE(TRIM(SUBSTITUTE(v,"USD",""))))))`.
- Comma decimals: `VALUE(SUBSTITUTE(SUBSTITUTE(v,".",""),",","."))` inside the same `MAP`.
- Day-first text dates: `DATE(RIGHT(v,4),MID(v,4,2),LEFT(v,2))`, which gives an ISO date; take
  `v` from the raw text, since a date the parser already read month-first is wrong.

Tell the user the clean columns are formulas over the raw ones (sorting or deleting the raw
columns breaks them), and name the headers you gave them.

**Count instead of reading (big sheets).** Write checks into a spare cell outside the data, read
them, then clear the cell with `set_range` and `null`:

- Duplicates by key: `=COUNTA(A2:A5000)-COUNTA(UNIQUE(A2:A5000))`.
- Text in a number column: `=COUNTA(D2:D5000)-COUNT(D2:D5000)`.
- Stray spaces: `=COUNTIF(C2:C5000," *")+COUNTIF(C2:C5000,"* ")`.

**Keep the latest of each duplicate.** Read the key and date columns, pick the winner of each
set by date, then rewrite the kept rows as one block (or delete the losers bottom up). Normalise
the key (trim, lower case) only for comparing; write the kept row's own key back cleaned.

## Pitfalls

- **Month-first parsing.** `02/04/2026` from a day-first export is stored as 4 February, with no
  error. Only `raw` shows the original; check it whenever a column has slash dates.
- **Silent number parsing.** `1,250` becomes 1250 and `007` becomes 7 on input. Write codes with
  a leading `'`, and check comma-decimal sources for values that parsed as thousands.
- **Totals inside the data** double every sum. A total row is usually last, has an empty key and
  a `SUM` in `raw`; delete it, and compute totals elsewhere if the user wants them.
- **Deleting top-down** shifts the rows below, so the next row number you delete is wrong.
  Delete from the bottom, or rewrite the block and delete the tail.
- **Formulas that point into the data** become `#REF!` when rows they use are deleted. Read
  `raw` for formulas before deleting and check `errors` after.
- **Spills need room.** A spilling clean column turns into `#SPILL!` if anything sits below it.
- **0 is not missing.** Writing 0 for `n/a` changes averages and counts; write `null`.
- **Hidden rows are still data.** `get_range` returns them; unhide before you show the user a
  result, so what they see matches what you counted.
- **Copying values through the conversation** is slow and error-prone for thousands of cells;
  use formula columns, and keep the values you write to the cells that change.

## Tools used

- `get_range`: read `raw` and `values`, the sheet size, errors and merges, before and after every step
- `set_range`: write headers, cleaned blocks, formula columns and scratch checks, one undo step each
- `set_cell`: fix one cell
- `delete_rows`, `insert_rows`: remove title, blank, total and duplicate rows; make room
- `insert_columns`, `delete_columns`: add clean formula columns; drop empty or unwanted ones
- `unmerge_cells`: split merged cells before restructuring
- `get_spreadsheet_document`, `load_spreadsheet_document`: keep a copy before a large rewrite, and restore it
- `undo_spreadsheet`: take back a step
- `spreadsheet.unhideAll`, `spreadsheet.clearFilters`: see every row before cleaning
