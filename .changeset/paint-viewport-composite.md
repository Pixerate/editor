---
"@pixerate/editor": minor
"@pixerate/editor-react": patch
"@pixerate/editor-svelte": patch
"@pixerate/swift": patch
---

The paint canvas composites only the tiles in view (#515): `PaintCanvasPresenter.render(ctx, visible)` takes the visible part of the canvas (`visibleDocumentRect(view, canvas, viewport, VIEW_MARGIN)`), so a slider drag or a stroke on a large canvas costs what is on screen; tiles out of view are composited when they come into view. React's and Svelte's `PaintCanvas` and Swift's `PaintCanvasView` pass it once the viewport is measured. The raster compositor now patches a tile's dirty part only when that tile was composited in its previous call; a tile left out (out of view) is composited whole, so a change made while it was out of view is never lost.
