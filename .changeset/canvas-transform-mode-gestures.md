---
'@pixerate/editor': minor
'@pixerate/editor-svelte': minor
---

Image editor transform mode: the canvas draws the active layer's frame and opens a Free Transform only for the length of a drag (one undo step when something changed), so other edits never meet an open transform. Pressing away from the frame picks the layer there, or none. Adds `boxFrameOverlay`, `boxFrameHit` and `FreeTransformTool.modified`.
