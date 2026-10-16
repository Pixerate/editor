---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add Pathfinder extras, a Shape Builder tool and click-to-fill regions to the vector editor.

- `VectorEditorController.pathfinder('divide' | 'trim' | 'merge' | 'crop' | 'outline' | 'minusBack')` in document space (rotated nodes, holes, live corners; unfilled stroked paths take part as their stroke's area), plus the `vector.pathfinder` command.
- Shape Builder tool (M): hover highlights the face under the pointer, click or drag merges faces into one shape, Alt deletes faces and line pieces; `shapeBuilder`, `getShapeBuilderFaces` and the `vector.shapeBuilder` / `vector.shapeBuilderFaces` commands.
- Paint Bucket tool (B) and `fillRegion`: fills the region the visible outlines enclose (crossings split, islands as holes, optional `editing.fillGap`), plus `vector.fillRegion`.
- Core geometry: `pathfinder`, `PlanarMap`, `planarSplit`, `pathBooleanSelect` and `interiorPoint` in `@pixerate/editor/canvas`.
- Overlay `builder` data; React and Svelte canvases draw the face highlights and both toolbars gain a Pathfinder group and a Gaps toggle.
