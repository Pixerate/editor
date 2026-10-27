---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Chart editor: slope, Likert and parliament charts, for parity with Ursula's chart documents. `slope` joins each category from the first series (before) to the second (after), labelled at both ends and draggable. `likert` draws each category as a diverging bar of its answers (most negative first) as shares of its total, coloured with the colour-blind-safe PuOr scheme (`chartLikertColor`), with `likertNeutral` (`split` or `separate`) and `likertSort` (`none`, `positive`, `negative`). `parliament` draws the first series as seats in a hemicycle with the majority line and the total, with `parliamentArc`, `parliamentMajority` and `parliamentLabel`. All are set through `update_chart` / `chart.update`, recommended by `recommendChartTypes` when the data suits them, described by `describeChart`, kept through Mermaid, and written to Office as the closest classic chart with an issue. The React and Svelte inspectors show the new options.
