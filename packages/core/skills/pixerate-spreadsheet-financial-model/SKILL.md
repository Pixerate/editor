---
name: pixerate-spreadsheet-financial-model
description: The financial model workflow in a Pixerate spreadsheet - inputs (assumptions) in labelled cells kept apart from calculations and outputs, one consistent formula across each row, absolute references to inputs, no hard-coded numbers in formulas, projections that compound, scenario and sensitivity tables, checks that totals tie, and finding the hard-coded or broken cell in an existing model. Use when asked to build or check a financial model, forecast, projection, budget, business case, revenue or cost model, break-even, loan or growth calculation, scenario or what-if table, or to find why a model does not update, or when get_range and set_range are available. Load with pixerate-spreadsheet, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-spreadsheet
---

# Building a financial model

A model is inputs, calculations and outputs. Inputs are the assumptions a person changes
(starting revenue, growth, prices); calculations turn them into numbers period by period;
outputs are what the reader looks at (totals, year-5 revenue, profit). Every calculation
refers to inputs by absolute reference and never contains a typed number, so changing one
assumption flows through everything.

This skill is the method. `pixerate-spreadsheet` has the full tool reference and functions.

## Goal and quality bar

- Inputs live in their own labelled cells at the top (or on their own block), one assumption per
  cell, with units in the label.
- Each row of the projection uses one formula pattern across its periods, referring to inputs
  absolutely (`$B$2`) and to the previous period relatively (`B5`).
- No hard-coded numbers in calculation formulas (no `*1.08`, no `+5000`); constants that matter
  are inputs.
- Outputs are formulas; checks tie (subtotals add to totals, a balance closes).
- No formula errors; the model gives the expected value for a case you can work out by hand.

## Inputs to confirm

- **Assumptions** and their values and units (growth as 0.08 or 8 %, currency).
- **Periods** (years or months) and how many.
- **Layout** the user expects (where inputs, the projection and outputs go).
- **Scenarios** to compare (low, base, high).

## Working method

1. **Read** what exists: `get_range` the whole model area, `raw` as well as `values`.
   **Check:** you can list the inputs, the calculation rows and the outputs.
2. **Inputs block.** Labels in column A, values in B (`set_range` in one call). Rates as
   fractions (0.08), money as plain numbers with the currency in the label.
3. **Timeline.** A header row of periods (years 1-5 in B4:F4).
4. **Calculation rows.** One `set_range` per row: the first period from an input (`=$B$1`),
   later periods from the previous one and the input (`=B5*(1+$B$2)`), the same pattern across.
   **Check:** `get_range` values match a hand calculation (100,000 at 8 % is 108,000, then
   116,640); `errors` empty.
5. **Outputs and checks.** Totals (`=SUM(B5:F5)`), year-N values, and a check cell that should be
   0 or TRUE (`=SUM(B7:F7)-B9`).
6. **Scenarios.** A small table with the scenario inputs in one column and the output formula
   next to each, referring to the starting input absolutely and its own scenario cell
   relatively (`=$B$1*(1+A9)^4` for year 5).
   **Check:** the base scenario equals the main model's output.
7. **Audit.** Read `raw` across every calculation row: each should match its neighbours' pattern;
   a formula with a typed number or a different reference is the bug.

## Decision table

| Need | Formula pattern |
| --- | --- |
| Compound growth period on period | `=prev*(1+$rate$)` |
| Value at period n directly | `=$start$*(1+$rate$)^(n-1)` |
| Cost as a share of revenue | `=revenue_cell*$cost_share$` |
| Fixed cost each period | `=$fixed_cost$` |
| Running total | `=prev_total+this_period` |
| Profit | `=revenue-costs` |
| Scenario output | Input in its own cell per scenario, output formula next to it |
| Something does not update | Find the formula with a typed number or a missing `$` |

## Recipes

**Five-year projection.** `set_range` from A1: `[["Starting revenue", 100000], ["Growth", 0.08],
[], ["Year", 1, 2, 3, 4, 5], ["Revenue", "=$B$1", "=B5*(1+$B$2)", "=C5*(1+$B$2)",
"=D5*(1+$B$2)", "=E5*(1+$B$2)"]]`.

**Find a hard-coded number.** `get_range` the calculation rows; compare each `raw` with its
neighbours; replace the odd one with the pattern (`set_cell`).

**Scenarios.** From A8: `[["Growth", "Year 5 revenue"], [0.05, "=$B$1*(1+A9)^4"], [0.08,
"=$B$1*(1+A10)^4"], [0.12, "=$B$1*(1+A11)^4"]]`.

## Pitfalls

- **Typed numbers in formulas** (`=C5*1.08`) do not follow the input; the classic broken model.
- **Relative input references** shift as formulas copy across; inputs need `$`.
- **Mixed patterns in a row** hide errors; one formula pattern per row.
- **Percent confusion**: 8 typed as a rate is 800 %; write 0.08 or `8%`.
- **Circular references** (`#CYCLE!`) from a total that includes itself.
- **`set_range` does not shift references** the way fill does; write each cell's own.
- **Outputs typed as values** break when an input changes.

## Tools used

- `get_range`: read `raw` and `values`, check results and errors
- `set_range`: write the inputs, timeline, rows and scenario tables, one undo step each
- `set_cell`: fix one formula
- `insert_rows`, `insert_columns`: add periods or lines
- `undo_spreadsheet`: take back a step
