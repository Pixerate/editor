---
'@pixerate/editor': minor
---

Paint editor tools can drive a paint document hosted as a layer on a larger canvas. `createPaintEditorToolProvider` takes a controller getter (resolved when a tool first runs, so registering never creates the document) and new options: `origin` (where document (0, 0) sits in host coordinates; every position argument and result is mapped through it in one place, from tools' declared `coordinates`, and descriptions say canvas coordinates; directors still receive document pixels), `exclude` (bare tool names to leave out) and `onChange` (called after each successful write). `get_canvas_info` now also returns `bounds`.

`canvas.drawFreehand` (`createDrawCommands`) now plays back: its new `plan` (also exported as `planFreehandPlayback`) traces the stroke on its surface in canvas coordinates, moving to the first point, pressing with `gesture: 'path'`, dragging through up to 32 points paced by length, then releasing and committing.
