---
name: pixerate-chart-annotate
description: The annotation workflow in the Pixerate chart editor - turning a correct chart into one that makes its point - a title that states the takeaway, highlighting the categories or series that matter, reference lines for targets and averages, bands for ranges, callouts on the points that need explaining, units, a source note and a check that the annotations stay few and honest. Use when asked to make a chart tell a story, highlight or call out a point, show a target, goal, threshold, average or range, add a source or footnote, or make a chart ready for a report, slide or board pack, or when highlight_chart, add_chart_reference_line, add_chart_reference_band or set_chart_callout are available. Load with pixerate-chart, which lists every tool.
metadata:
  kind: workflow
  reference: pixerate-chart
---

# Annotating a chart

A chart for a report or a slide should say what it means, not leave the reader to find it. Once
the type and data are right (`pixerate-chart-choose-and-build`), add the few marks that point at
the message: a title that states it, a highlight on what matters, a reference line or band for
the benchmark, a callout where something needs explaining, and a source note. Fewer is better:
every annotation competes with the data.

This skill is the method. `pixerate-chart` has the full tool reference.

## Goal and quality bar

- The title states the takeaway ("Q3 was our record quarter"), the subtitle the measure and
  units if the axis does not.
- What matters stands out (`highlight`), and everything else recedes.
- Benchmarks are drawn, labelled, on the right axis: a target line, an average, a normal range.
- At most one or two reference lines, one band and a couple of callouts.
- The source is cited in `note`; units are stated.
- The data is unchanged by annotating.

## Inputs to confirm

- **The message:** the one thing the reader should take away.
- **Benchmarks:** targets, averages, thresholds or ranges, with their values and units.
- **Source** of the data, and the audience (report, slide, dashboard).

## Working method

1. **Read.** `get_chart`: the type, categories, series, existing annotations and warnings.
   **Check:** the chart is already the right type with clean data; if not, fix that first.
2. **Title the takeaway.** `update_chart` `title` with the message, `subtitle` with the measure
   and units.
3. **Highlight.** `highlight_chart` with the category labels or series names that carry the
   message; the rest dims.
   **Check:** `get_chart` `spec.highlight`.
4. **Benchmarks.** `add_chart_reference_line` for a target or average (`value`, `label`, `axis`);
   `add_chart_reference_band` for a range (`from`, `to`, `label`).
   **Check:** `spec.referenceLines` / `referenceBands` have the values and labels.
5. **Callouts** for points that need a word (`set_chart_callout` on a series and category), such
   as "Launch" or "Strike".
6. **Source and units.** `update_chart` `note` ("Source: …"); the axis `format` or title for
   units.
7. **Review.** `render_chart`; remove any annotation that does not help the message.

## Decision table

| Want to say | Annotation |
| --- | --- |
| This one is the point | `highlight_chart` on it; title states it |
| Above or below a goal | `add_chart_reference_line` at the target, labelled |
| Inside or outside a normal range | `add_chart_reference_band`, labelled |
| Compared with the average | Reference line at the average, labelled "Average" |
| Something happened here | `set_chart_callout` on that point |
| Where the numbers came from | `note` |
| The trend, not the noise | `add_chart_trendline` (say what it models) |

## Recipes

**Record quarter.** `highlight_chart` `{ names: ["Q3"] }` → `update_chart` `{ title: "Q3 was our
record quarter" }`.

**Target.** `add_chart_reference_line` `{ value: 100000, label: "Target" }`.

**Board-ready.** `update_chart` `{ note: "Source: internal CRM, 2026", yAxis: { format: { style:
"currency", currency: "USD" } } }`.

## Pitfalls

- **Neutral titles** ("Quarterly revenue") make the reader do the work; state the finding when
  the chart has one.
- **Annotation clutter**: many lines, bands and callouts hide the data.
- **Recolouring instead of highlighting**: changing one series' colour by hand breaks palettes
  and colour checks; `highlight_chart` keeps them.
- **Unlabelled lines**: a line without a label is a puzzle.
- **Targets on the wrong axis**: put a reference line on the axis of the series it belongs to
  (`axis: "y2"` for a secondary-axis series).
- **Claims the data does not support**: the title must be true of the chart as drawn.

## Tools used

- `get_chart`, `render_chart`: read and look
- `update_chart`: title, subtitle, note and axis formats
- `highlight_chart`: what stands out
- `add_chart_reference_line`, `update_chart_reference_line`, `remove_chart_reference_line`: targets and averages
- `add_chart_reference_band`, `update_chart_reference_band`, `remove_chart_reference_band`: ranges
- `set_chart_callout`: notes on points
- `add_chart_trendline`: a fitted trend
- `undo_chart`: take back a step
