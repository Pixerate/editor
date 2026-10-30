---
'@pixerate/editor': minor
---

Vector layers move into and out of groups: `VectorEditorController.moveNode(id, { parentId, index })` reparents a node, keeping it where it is on the canvas, in one undo step; `reorderNode` now uses it. Agents get it as the `vector.moveLayer` command.
