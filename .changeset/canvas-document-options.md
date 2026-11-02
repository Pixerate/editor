---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

The canvas editor document takes new options. `getViewport` / `setViewport` save and restore the view with the document; panning doesn't count as a change. `omitNodeKeys` / `omitEdgeKeys` leave the host's own fields out. `validateNode` adds host checks to loads. `normalize`, `formatVersion` and `migrations` upgrade older host shapes. `assets` keeps inline images in node data out of the JSON. `canvasDocumentContentKey` is exported, and `useCanvasEditorDocument` and `createCanvasDocument` accept the same options.
