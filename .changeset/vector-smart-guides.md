---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Vector editor: smart guides and object snapping. Moves, selection-box resizes, anchor and handle drags, the pen and the shape tools snap to other objects' anchors, paths, path intersections (curve–curve included), perpendicular and tangent points, bounding-box edges and centres, the artboard and construction angles; moves also space themselves evenly between neighbours, and resizes and new shapes match other objects' widths and heights. Everything works in document space, so rotated nodes snap exactly. `snap` options are now `{ grid, objects, guides, threshold, angles }` (objects and guides on by default, 5 px pull), hold Cmd / Ctrl during a drag to bypass snapping, and `toggleSnapping()` flips object snapping. `state.guides` and `getVectorOverlayRenderData(...).guides` expose the labelled guide lines ("anchor", "centre", "intersect", "path", "align", gap and size labels). New `VectorSnapTargets` (gathered once per gesture, bisection lookups) for custom tools, and `segmentIntersections` in the path ops. The React and Svelte `VectorCanvas` draw the guides (`guideColor` prop) and both `VectorToolbar`s add a snapping toggle (`showSnap`).
