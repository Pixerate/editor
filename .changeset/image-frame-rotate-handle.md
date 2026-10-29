---
"@pixerate/editor": minor
"@pixerate/editor-svelte": minor
"@pixerate/editor-react": minor
---

Image editor: the selected-layer frame and Free Transform now show a rotate handle on a stem above the top edge, like the vector editor's selection box. Dragging it rotates about the reference point (Shift snaps to 15°). The handle sits a fixed 24 screen pixels out (`TRANSFORM_ROTATE_HANDLE_OFFSET`), follows the frame as it turns, stays outside flipped frames, and is hidden in Warp mode. `TransformOverlay` gains `rotate`, `TransformHandle` gains `'rotate'`, and `quadFrameOverlay` takes an optional `rotateOffset`. Dragging outside the frame still rotates as before.
