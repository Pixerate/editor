---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Isometric (2.5D) projection for the vector and diagram editors (part of #799).

- `isoProjector({ angle, scale, origin })` (`@pixerate/editor/tools`) maps grid points (i, j, k) to the page and gives a box's visible faces (top, right, left; a flat tile has only its top) with path data, its corners, its six-sided outline (an obstacle for label placement) and grid lines on whole multiples of a step, so a partial block lines up with whole ones. `isoOrder` sorts boxes back to front (wholly behind along an axis first, then farther, then input order; a cycle is broken at the farthest box), and `isoFaceColors` / `isoShade` shade one fill for the faces.
- Vector: `vector.addIsoBoxes` (`VectorEditorController.addIsoBoxes`) adds editable blocks, each a group of face paths with optional grid lines, all in one group drawn back to front and centred on the artboard by default, as one undo step. Ported to the Swift vector editor with a conformance scenario.
- Diagrams: `mermaidToSvg(doc, { projection: 'isometric' })` and `render_diagram` `projection: "isometric"` draw a laid-out diagram as blocks standing on their groups' floor tiles, with edges along the floor.
