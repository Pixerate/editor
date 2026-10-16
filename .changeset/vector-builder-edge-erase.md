---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Shape Builder: Alt now erases the edges of closed outlines too, not only the pieces of unfilled open paths. The nearer of a line piece and an outline edge within tolerance is taken; an erased edge opens a closed subpath there, splits an open one or removes a subpath it runs all the way round, a filled open subpath runs round its invisible closing edge without it ever coming back, and an edge bounding a face deleted in the same gesture goes with that face. Results stay in each node's own space with its transform, `shapeBuilder()` and the `vector.shapeBuilder` command report the `edges` erased, and the overlay's `builder.lines` shows them. Hovered and dragged faces now get a 45° hatch (`builder.hatches`, from the new `hatchPath` helper) over the translucent fill, drawn by the React and Svelte canvases as `data-vector-builder-hatch`. New pathops helpers: `cutOutPiece`, `contourEnclosesArea`, `hatchPath`.
