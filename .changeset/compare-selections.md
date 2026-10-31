---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Compare two selections (#392, item D).

**What it does:** the new `compare_selections` tool and `controller.compareSelections(a, b, { minArea, show })` report what changed between two selections. Each of `a` and `b` can be:
- the current selection
- the selection a number of undo steps back (`a` defaults to one step back)
- a saved channel
- a layer's painted or vector mask

**What it returns:**
- the added and removed area, with the largest pieces and their bounds
- the IoU
- the coverage change, which also catches edges that only softened
- whether the two are identical

**On the canvas:** with `show` (the default), added area is tinted green and removed area red until the selection next changes. This is view state only, with no undo step. `controller.clearSelectionDiff()` hides it.

**Core:** `compareSelectionMasks`, `selectionDiffPixels` and `controller.selectionFrom(source)`.

**React and Svelte:** a "Show Last Change" button (`SelectionChangeCheck`) in the Refine Edge panel.
