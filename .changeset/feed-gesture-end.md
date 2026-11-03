---
"@pixerate/editor": patch
---

`createCanvasChangeFeed` reports when a drag or resize ends (`gestureEnded: true`), even when the drop only clears the runtime `dragging` / `resizing` flags. Before, such a drop produced no change, so followers waiting for the gesture to end (such as jazz) never heard it.
