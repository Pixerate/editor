---
'@pixerate/editor': minor
---

Paint editor: render one area of the canvas. `compositePixels({ rect })` and `renderPreview({ rect })` take a rectangle in document pixels (inside the canvas, whole pixels), and the `render_preview` tool takes `rect` (in host coordinates when the document is hosted). A host can frame the part being worked on instead of the whole page, and only that area is composited. Swift: `compositePixels(rect:)` and `renderPreview(maxSide:rect:)`.
