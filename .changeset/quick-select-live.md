---
'@pixerate/editor': minor
---

Quick Selection grows while you drag. As the brush moves, the stroke so far is computed (in the selection worker when there is one; one at a time, catching up with the newest points) and shown in place of the selection. That uses the new `controller.setSelectionPreview` and the renderer's `state.selectionPreview`, which are view state only, with no undo step and nothing saved. Releasing applies the stroke as one undo step, as before; cancelling drops the preview. The gesture's `draftPath` for Quick Selection is now `null` (the live result replaces the brush path), and `previewed` resolves once a preview has caught up.
