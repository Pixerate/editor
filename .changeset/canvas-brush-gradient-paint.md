---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Gradient paint for brushed freehand strokes on the canvas. A brushed stroke's `brush.paint` (and `FreehandStrokeStyle.paint`) takes a `PaintSource`-shaped value: one colour, or a gradient sampled dab by dab along the path by distance (in canvas units, the same at every zoom), pressure, tilt, direction, across the tip or at random. The stroke colour still gives the alpha and fills `paint` stops. `canvas.drawFreehand` takes an optional, strictly validated `paint` and returns it normalised; `velocity` and `time` mappings are refused because canvas strokes record no timing. New `validateCanvasBrushPaint` and the `CanvasBrushPaint` types, re-exported from the React and Svelte packages; `useCanvasDraw` / `createCanvasDraw` carry `style.paint`.
