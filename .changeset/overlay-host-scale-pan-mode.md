---
'@pixerate/editor': minor
'@pixerate/editor-react': patch
'@pixerate/editor-svelte': minor
---

Image editor overlay chrome keeps its size on screen under a host's CSS zoom. `measureCanvasViewport()` returns `hostScale` (screen pixels per CSS pixel from transforms on the element), and the new `RenderOptions.hostScale` draws the crop and Free Transform frames and handles, the brush cursor, the clone source marker and the text caret that much smaller. `ImageEditorCanvas` (React and Svelte) passes it, so the handles of a canvas inside a zoomed canvas node no longer grow with the zoom. The crop and transform handles are also a little smaller (8px instead of 10px) and the transform frame thinner.

Svelte `ImageEditorCanvas` takes `panMode`: a host's hand tool, where a primary drag pans the view in every mode (as holding Space does) and the canvas's own gestures pause, with a grab cursor.
