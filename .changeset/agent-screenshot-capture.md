---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Agents can take screenshots with a new `capture_view` tool. It captures the viewport, all content, the selection, items by id or a rect, as PNG or JPEG. The result has the image plus the captured rect and pixel scale, so a point in the image maps back to surface coordinates. Selection boxes, resize handles and agent cursors are left out unless `includeOverlays` is set.

- Core (`/tools`): `createCaptureTool` / `createCaptureToolProvider` over any `CaptureSurface`, `rasterizeElement` (a DOM element drawn through an SVG `foreignObject`, no dependencies) and `createElementCaptureSurface` for any DOM view.
- Canvas (`/canvas`): `createCanvasCaptureToolProvider` for React Flow / Svelte Flow canvases, in canvas units, framing nodes by id wherever the view is scrolled.
- Image editor: `capture_view` is part of `createImageEditorToolProvider`. It works in natural image pixels, the same space as the selection tools, zooms up to 8× with hard pixel edges and can shade unselected pixels. `ImageEditorController.renderSourceView` renders the edited image without crop or rotation.
- React: `useCanvasCapture`. Svelte: `createCanvasCapture`.
