---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Chart editor: Sankey diagrams, for parity with Ursula's chart documents. New `spec.links` (flows between named nodes) is the chart's data when set: the categories become the nodes (in `sankeyNodes` order) and the first series how much passes through each. `normalizeChartLinks` refuses self-flows, repeated pairs and loops with sentences. The new `sankey` type puts nodes in columns by the chains of flows into them, sizes nodes and flows on one scale, colours flows by `sankeyLinkColor` (`source`, `target`, `gray`), keeps a highlighted node's flows bright, and draws its table as bars until it has flows. New controller methods `setLinks`, `importLinksTable`, `addLink`, `updateLink`, `removeLink`, helpers `chartSankeyNodes`, `chartSankeyNodeValues`, `chartLinksFromTable`, `setChartLinkField`, `addChartLink`, and agent tools `set_chart_links`, `import_chart_links_csv`, `add_chart_link`, `update_chart_link`, `remove_chart_link` with matching `chart.*` commands. Cell edits are refused while the data is flows. The React and Svelte data grids show flows as a Source / Target / Value table (`ChartLinksGrid`), and the inspectors a flow colour option.
