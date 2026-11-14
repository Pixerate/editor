---
"@pixerate/editor": minor
---

More chart types and new data visuals as UI components (#819). `uiComponents()` now lists `line-chart` and `donut-chart` beside `sparkline` and `bar-chart`, plus three data visuals built on the connector, helix, draw-on, linked-focus and text-fitting helpers:

- `lineage`: a root fanned out to a row of items with rounded connectors that never cross and labels sized to fit their columns.
- `braid`: two to six strands twisted into a root, over and under, weighted by `value` and labelled at the open end.
- `weave`: items along the top joined to the tags they share along the bottom, many to many.

The data visuals take `progress` (0–1, frame-pure, drawn on; 1 at rest) and `focus` (a key whose linked marks stay lit while the rest dim, by `dim`) in `render`, and `interaction(data)` gives the `createLinkFocus` options (marks, links, keyboard order, labels). Their contracts carry `motion: true`, a `focus` state and event, the arrow-key walk and `reducedMotionAt: 1`; marks carry `data-link-focus`. Existing `sparkline` and `bar-chart` output and content hashes are unchanged. `ChartUiRenderOptions` gains `progress`, `focus` and `dim`, and invalid values are refused with a message.
