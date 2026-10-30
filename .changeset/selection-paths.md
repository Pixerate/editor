---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Selections ⇄ paths. `selectionToPath` (Make Work Path) traces the selection's outline into closed Bézier subpaths in document pixels, holes included (fill even-odd), within `tolerance` px (default 0.5), with square corners kept square. It returns compact SVG path data. `pathToSelection` (Make Selection) fills a path into the selection by mode, with feather and anti-aliasing. `addVectorMask(id, 'selection')`, the agent tool `add_vector_mask` `from: "selection"`, and a new Layers panel menu item "Add Vector Mask from Selection" turn the selection into a sharp, editable vector mask. New agent tools: `selection_to_path` (read-only) and `path_to_selection`. Lower level: `selectionToSubpaths`, `subpathsToSvgPath`, and `traceField` (now exported) with `squareCorners`. `getVectorMask` bounds now measure the curves rather than their handles.
