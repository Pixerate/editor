---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Brushed freehand strokes on the canvas, opt-in. `FreehandStrokeStyle.brush` takes a dry paint preset id (`ink-pen`, `pencil-hb`, …) or tip settings. The stroke stays a path shape node and gains `data.shape.brush`, with pressure and tilt profiles along its length taken from the pen, so selecting, erasing, grouping and export work as before. It is drawn with the paint engine's `renderBrushstroke` and re-rendered when the path, the brush or the zoom bucket changes. The paint engine loads only when the first brushed stroke is drawn. Strokes without a brush are unchanged.

- Core: `renderShapeBrushstroke`, `getBrushedShapeSvg` (SVG with the image embedded), `listCanvasBrushes`, `pointerPenSample`. The draw controller takes pen samples in `startStroke` / `continueStroke`, and its `drawStroke` draws a whole stroke in one undo step.
- Agents: `createDrawCommands` adds `canvas.drawFreehand` (points, tool, colour, width, opacity, `brush`, and `pressure` / `tiltX` / `tiltY` profiles; wet brushes are refused) and `canvas.listBrushes`.
- React: `<ShapeNode>` draws brushed shapes, `<ShapeNodeZoomProvider>` keeps them sharp, `useCanvasBrushes` lists the brushes, and `<CanvasDrawLayer>` passes pen pressure and tilt (coalesced events for brushed strokes).
- Svelte: the same, with `setShapeNodeZoom` and `createCanvasBrushes`.
