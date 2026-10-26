---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Chart editor: radar charts keep Mermaid's `ticks` and `graticule`. New `radarTicks` (an even ring count, or `null` for round-number rings) and `radarGraticule` (`polygon` or `circle`) spec fields are drawn by the radar layout, read and written by `chartFromMermaid` / `chartToMermaid`, settable through `update_chart` / `chart.update`, and shown as Rings and Grid in the React and Svelte inspectors. A `radar-beta` block without `graticule` now imports as `circle` (Mermaid's default), and polygon rings are written as `graticule polygon`.
