---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Smart selections report where they are unsure, and refinement can work only there (#392, item C).

- **New results:** `select_subject`, `select_object`, `select_sky` and `quick_select` now also return:
  - `uncertainRegions`: up to 20 regions with bounds, area and confidence, least confident first
  - `uncertainCount`
  - `edgeConfidence`

  These are the stretches of the new selection's edge with no image edge under them.
- **Core:** `controller.selectionUncertainty()` and the pure `selectionUncertainty(mask, pixels)` return the trimap's unknown band as a mask plus the regions.
- **Refine:** `refine_selection` and `refineSelectionTo` take `regions` (rectangles) and refine only inside them, leaving the rest of the selection as it was. Regions that miss the image are rejected before anything changes.
- **React and Svelte:** the Refine Edge panel adds "Only uncertain areas".
