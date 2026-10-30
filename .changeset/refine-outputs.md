---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Select and Mask outputs and Decontaminate Colors. `refine_selection` and `controller.refineSelectionTo(params, output, { layerId, decontaminate })` refine the selection and put the result in one of four places, as one undo step:

- `selection`: the refined selection (the default).
- `layer-mask`: a mask on the layer, then deselect.
- `new-layer`: Layer via Copy, with the source layer hidden.
- `new-layer-with-mask`: a masked copy of the layer, with the source layer hidden.

Decontaminate Colors (`decontaminate` 0..100, new-layer outputs only) replaces the old background's colour in soft edges with the subject's own colour. Edge pixels that are mostly subject are unmixed using the local background colour; ones that are mostly background take the subject's local colour. The colours are read from the source layer. The Refine Edge panel in React and Svelte has Output to and Decontaminate colors controls. New exports: `decontaminateColors`, `REFINE_OUTPUTS` and the `RefineOutput` and `RefineOutputResult` types.
