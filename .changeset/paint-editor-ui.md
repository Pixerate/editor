---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Paint editor components for React (`@pixerate/editor-react/paint-editor`) and Svelte (`@pixerate/editor-svelte/paint-editor`), in parity. Both include `PaintEditor`, `usePaintEditor` / `createReactivePaintEditor`, `PaintCanvas`, `PaintToolbar`, `BrushPanel`, `PaperPanel`, `ColorPanel` and `PaintLayersPanel`. `PaintCanvas` is a document-sized canvas that uploads only the tiles that changed, shown through the view's zoom, rotation and mirroring. It reads pen pressure, tilt and twist, uses coalesced events and draws a predicted tail, with palm rejection, middle-button pan, wheel zoom and Shift+wheel rotation. It draws guide overlays and floating reference images. `PaintToolbar` covers tools, history, view, symmetry, perspective, tracing and reference images, hand, save / open and PNG / JPEG / PSD. `BrushPanel` has the library with thumbnails, settings, save, import and export. `PaperPanel` has the library and grain settings, which commit once on release. `ColorPanel` has an RYB / RGB wheel with harmonies, swatches and the mixing pad. Core adds the framework-free logic they share: `PaintGesture`, `PaintCanvasPresenter`, `handlePaintShortcut`, `guideOverlay`, the slider tables, `renderColorWheel`, `decodeImageBlob` and `downloadBytes`.
