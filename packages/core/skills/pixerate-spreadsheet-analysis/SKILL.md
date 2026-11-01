---
name: pixerate-spreadsheet-analysis
description: The analysis workflow in a Pixerate spreadsheet - turning tidy data into answers with live formulas - summary tables by category (SUMIFS, COUNTIFS, AVERAGEIFS), distinct lists with UNIQUE, ranked and filtered views with SORT and FILTER, period totals and growth, shares of a total, checks that the summary reconciles with the data, and handing the result to a chart. Use when asked to summarise, total, count, average, group, pivot, rank, compare, break down or analyse data in a spreadsheet, work out growth or percentages, find the top items, or prepare numbers for a chart, or when get_range and set_range are available. Load with pixerate-spreadsheet, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-spreadsheet
---

# Analysing data in a spreadsheet

An analysis is a set of formulas that answer a question from the data and keep answering it
when the data changes. Start from tidy data (one header row, one record per row; clean it first
with `pixerate-spreadsheet-clean-import` if needed), put each summary in its own block beside or
below the data, and make every number a formula over the data, never a typed result.

This skill is the method. `pixerate-spreadsheet` has the full tool reference and the supported
functions; for the chart that shows the result, see `pixerate-chart-choose-and-build`.

## Goal and quality bar

- Every result is a formula over the data (`SUMIFS`, `COUNTIFS`, `AVERAGEIFS`, `FILTER`,
  `UNIQUE`, `SORT`), with absolute references to the data range, so it updates and can be
  checked.
- Summaries have a header row and one row per group; nothing is typed over a formula.
- The summary reconciles: group totals add up to the data's total.
- No formula errors (`get_range` `errors` empty); expected errors handled explicitly
  (`IFERROR` around a division by a possible zero), and blanks where a value does not apply.
- The data itself is untouched.

## Inputs to confirm

- **The question** (totals by region, growth by month, top products) and the measure.
- **Where the result goes** (a cell such as G1, or below the data).
- **Groups:** a fixed list the user gives, or every distinct value in the data (`UNIQUE`).

## Working method

1. **Read the data.** `get_range` the header and a sample; note the data range, which column is
   the group and which the measure, and whether it is tidy.
   **Check:** one header row, one record per row, numbers as numbers.
2. **Lay out the summary** in an empty area: a header row, then one row per group. List groups
   yourself when there are few and fixed, or `=UNIQUE(B2:B500)` for every value (leave room for
   it to spill).
3. **Write the formulas in one block.** `set_range` with the header and a formula per row, each
   with absolute data references and a relative group cell: `=SUMIFS($D$2:$D$500,$B$2:$B$500,G2)`.
   **Check:** the returned `errors` is empty.
4. **Reconcile.** Add a total row (`=SUM(H2:H5)`) and compare it with `=SUM($D$2:$D$500)`; for
   counts, with `=COUNTA` of the key column.
   **Check:** they match; if not, a group is missing or a value is text.
5. **Derived measures**: growth `=B3/B2-1` (blank for the first period), share `=H2/SUM($H$2:$H$5)`,
   rank `=RANK(H2,$H$2:$H$5)`, ranked lists `=SORT(G2:H5,2,-1)`.
   **Check:** `get_range` values match a hand calculation for one row.
6. **Hand over.** Tell the user where the summary is and what each column means; to chart it,
   pass the summary block (categories and values) to the chart editor's `set_chart_data`.

## Decision table

| Question | Formula |
| --- | --- |
| Total per group | `SUMIFS(measure, group_range, group)` |
| How many per group | `COUNTIFS(group_range, group)` |
| Average per group | `AVERAGEIFS(measure, group_range, group)` |
| Two conditions (region and month) | `SUMIFS` with two criteria pairs |
| Every distinct group | `UNIQUE(group_range)`, spilled |
| Rows that meet a condition | `FILTER(data, condition)` |
| Top items | `SORT` (or `SORTBY`) the summary by its total, descending |
| Change from the previous period | `=this/previous-1`, first period blank |
| Share of total | `=value/SUM($total_range)` |

## Recipes

**Totals by region at G1.** `set_range` from G1 with `[["Region", "Total"], ["North",
"=SUMIFS($D$2:$D$11,$B$2:$B$11,G2)"], ...]` (each row's formula pointing at its own G cell).

**Month-over-month growth in C.** `set_range` from C1: `[["Growth"], [null], ["=B3/B2-1"],
["=B4/B3-1"], ...]`.

**Orders and average per product.** Columns `=COUNTIFS($C$2:$C$11,G2)` and
`=AVERAGEIFS($D$2:$D$11,$C$2:$C$11,G2)`.

## Pitfalls

- **Typed results.** A number typed into a summary does not update; always a formula.
- **Relative data references.** `D2:D11` shifts when you write the formula down; use `$D$2:$D$11`.
- **Text numbers** in the measure column are skipped by `SUMIFS`; clean the data first.
- **Spills blocked**: `UNIQUE`, `FILTER` and `SORT` need empty cells below and to the right.
- **Totals inside the data range** double-count; keep summaries outside it.
- **0 for "no previous period"** misleads averages; leave it blank.
- **`set_range` writes formulas as given**: write each row's own references.

## Tools used

- `get_range`: read the data and check every result and error
- `set_range`: write summary blocks with headers and formulas, one undo step
- `set_cell`: fix one formula
- `insert_columns`, `insert_rows`: make room for a summary
- `undo_spreadsheet`: take back a step
