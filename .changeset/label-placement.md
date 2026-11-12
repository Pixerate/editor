---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Label placement around obstacles (#792).

- `placeLabels(labels, options)` (`@pixerate/editor/tools`): places labels near their anchors, clear of obstacles (boxes, points, segments, polygons; `labelHull` for convex hulls), of each other and of other labels' anchors. Each label tries its preferred sides (`prefer`, the corners and `center` too), stepping outwards from `distance` to `reach` and inside `bounds`, one line first and then its `wrapped` size. The most constrained labels go first, a clashing spot is used only when no clear one exists, and clashing labels go first in up to `passes` more rounds. Optional leader lines; the same input always gives the same result. Pure geometry: callers pass sizes.
- Chart callouts are placed together with it, clear of the bars, points and each other, instead of being nudged one at a time (in TypeScript and Swift, which match exactly).
- Diagram SVG export (`mermaidToSvg`): an edge label sits on its edge, or beside it when a node or another label is there.
- Vector: `vector.placeCallouts` moves label nodes clear of the other art and each other and draws leader lines, as one undo step (`VectorEditorController.placeCallouts`); ported to the Swift vector editor with a conformance scenario.
