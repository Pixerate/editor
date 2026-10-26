---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Bring the save / load / undo contract to the image and paint editors, with pixels kept as assets.

- `createEditorAssetRegistry()` (`/persistence`): a synchronous, content-addressed store for inline images. With `defineEditorDocument({ assets })`, documents hold `pixerate-asset:` references instead of PNG data URLs and base64, and loads swap them back (refusing references that are not loaded). `withEditorAssets(storage, registry)`, `persistEditorAssets` and `preloadEditorAssets` move the bytes to and from storage; autosave and `createEditorDocumentStore` use them automatically.
- `createImageEditorDocument(controller)` (kind `image`; agent loads are one undo step) and `createPaintEditorDocument(controller)` (kind `paint`; opening clears history; read-only mid-stroke or mid wet step). `get_image_document` / `get_paint_document` never return pixel data.
- `ImageEditorController`: `documentRevision` and `clearHistory()`. `PaintEditorController`: `documentRevision` and `busyReason()`.
- Paint's `save_document` and `open_document` tools are deprecated in favour of the shared `*_paint_document` tools and will be removed in a later minor version.
- React: `useImageEditor()` and `usePaintEditor()` return `editorDocument`. Svelte: `createReactiveImageEditor()` and `createReactivePaintEditor()` return `editorDocument`.
