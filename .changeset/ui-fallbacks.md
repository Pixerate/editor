---
"@pixerate/editor": minor
"@pixerate/swift": minor
"@pixerate/conformance": patch
---

Fallbacks for the chart types, data visuals and diagram families offered as UI components (Pixerate/surreal-ui#38): every descriptor now names `fallback: 'table'`, and each component has `fallback(data)`, which returns `{ implements: 'table', props }` in the shape of `@pixerate/schemas` `UiFallback` and `UiTableProps` (2.6.0), for where the drawing can't be shown (no script or SVG, a screen reader's table view, a host without the provider). Charts become categories by series with the unit in the caption, `lineage`, `braid` and `weave` list their items, `flow` gives each step and where it leads, `timeline` each period and its events, and `mindmap` each branch, topic and detail. `UiFallback`, `UiTableProps` and `tableFallback` are exported from `/chart`. Swift's `ChartUiComponent.fallback(_:)` gives the same table for the four Swift-ready chart types. The content hashes include the example's fallback, so every UI component's `contentHash` changes.
