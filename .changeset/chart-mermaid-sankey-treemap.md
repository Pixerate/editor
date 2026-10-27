---
"@pixerate/editor": minor
---

Chart editor: Mermaid `sankey-beta` and `treemap-beta`. `chartFromMermaid` reads Sankey diagrams into flows (`links`, node order kept) and treemaps into grouped data (`tree`) with the diagram module's parsers, following Ursula's rule for treemaps: one section round everything is the whole, items or one level of sections make a treemap, deeper nesting a sunburst. `chartToMermaid` writes Sankey diagrams with flows as `sankey-beta` CSV records (title in frontmatter) and treemaps and sunbursts as `treemap-beta` with their levels instead of a pie of the totals, still with the `%% @pixerate` comment for an exact round trip. `findMermaidCharts`, `import_chart_mermaid` and `export_chart_mermaid` handle both families, and `findMermaidCharts` now skips frontmatter when it looks for a chart's header.
