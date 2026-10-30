---
"@pixerate/editor": minor
---

Add a layers model for vector documents: `vectorLayerRows()` lists nodes top first as layers-panel rows (kind, name, depth, visibility, lock, child count, expanded groups), with `vectorLayerKind()`, `vectorLayerName()` and `vectorLayerChildren()` (a blend's generated steps are left out). Add `VectorEditorController.reorderNode(id, index)`, which moves a node among its siblings as one undo step, as dragging it in a layers panel does.
