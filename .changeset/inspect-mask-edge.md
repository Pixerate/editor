---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Measure a mask's edge without looking at it (#392, item A). The new read-only `inspect_mask_edge` tool and `controller.inspectMaskEdge(target, { layerId, minArea })` report on the selection, a layer's painted mask or its vector mask:
- `haloScore`: old background left just inside the edge
- `edgeAlignment`: the share of the edge on strong image edges
- `jaggedness`: outline turning beyond what closing it needs, per 100 px
- `softFraction`
- `holes` and `islands`
- up to five `worst` regions, ready for `capture_view`
- `issues` with suggested fixes, judged against `MASK_EDGE_THRESHOLDS`

The analysis is the pure `inspectMaskEdge(mask, pixels)` in core. React and Svelte add `MaskEdgeCheck` (a Check Edge button with the scores and findings) to the Refine Edge panel. The masking workflow skill now measures the edge before and after cleanup.
