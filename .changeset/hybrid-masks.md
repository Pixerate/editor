---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Hybrid vector masks (#392, item 1). Each segment of a vector mask can now have its own edge, so one mask can hold sharp sides and hair:
- **`hard`** (the default) is the path's own edge.
- **`feather`** blurs across the curve by `radius` px.
- **`matte`** solves a corridor from `inner` px inside to `outer` px outside the path. It uses the colour-guided filter against the layer's own pixels (the Background's come from the source image).

Where modes meet they blend over a few pixels, with no seam. The work happens only in tiles along the path, so a 12 MP mask with soft edges renders in a few hundred ms. It's cached with the layer.

**API changes:**
- **Model:** `VectorMask.edges`.
- **Core:** `hybridVectorMaskCoverage` and `validVectorMaskEdges`.
- **Controller:** `controller.setVectorMaskEdge`.
- **Agent tool:** `set_vector_mask_edge`. `get_vector_mask` now also returns `edges` and `segmentCount`.
- **Other tools:** `inspect_mask_edge`, `compare_selections` and rasterizing see the hybrid coverage.

**Saving:**
- Edges are saved in documents.
- They're dropped when a new path no longer has their segment.
- PSD export bakes a hybrid mask into the pixel mask, with a warning.

**Canvas:** Alt+Shift-click a vector mask segment with Direct Selection to cycle hard → feather → matte. Feathered segments are drawn amber and dashed, matte ones magenta.

**React and Svelte:** a `VectorMaskEdgesPanel` in the Layers panel lists the soft edges and edits their settings.
