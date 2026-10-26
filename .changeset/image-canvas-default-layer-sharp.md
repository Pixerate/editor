---
"@pixerate/editor": patch
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
---

Image editor: a newly loaded image (and a document saved without an active layer) opens with its topmost paintable pixel layer active, which is the Background for a new image, so the first brush stroke, fill or `paint_stroke` works without picking a layer. Deleting the active layer moves to the nearest paintable layer below it, and `remove_layer` returns the new `activeLayerId`. Paint refusals now carry a person-facing message (`LayerOperationError.userMessage`, `userErrorMessage()`), which `ImageEditorCanvas`'s `onError` / `onerror` and the brush bar's Fill show (e.g. "Pick a layer to paint on in the Layers panel."). Agent tools keep the message that names tools. `ImageEditorCanvas` (React and Svelte) now stays sharp on high-DPI screens and when a host scales it with a CSS transform. The new `measureCanvasViewport` sizes the backing store from `getBoundingClientRect()` × `devicePixelRatio`. `RenderOptions.pixelRatio` draws through that scale, and layout and pointer mapping stay in CSS pixels. `watchCanvasViewport` measures again on resize and after transitions.
