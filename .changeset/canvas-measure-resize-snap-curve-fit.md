---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

Canvas distance measuring, resize / grid snapping and Bézier curve fitting.

- **Measuring**: `measureBetween(a, b)` (inside, overlapping and separated boxes, labelled lines plus dashed extension lines), `measureToLine`, `measureSelection(nodes, selectedIds, hoveredId)` and `measureLabel`. `GuideLine` gains the `measure` / `extension` kinds and an optional `label`, which both `<CanvasGuidesLayer>`s draw (new `measureColor` prop). Alt-hover hooks: React `useCanvasMeasure`, Svelte `createCanvasMeasure`.
- **Resize snapping**: `snapResize(rect, handle, targets, options)` keeps the opposite edge / corner fixed, snaps corner axes independently, rejects snaps that collapse or flip the box, and supports `keepAspectRatio`, `minWidth` / `minHeight`. The arrange controller adds `snapResizeChanges` (React Flow `dimensions` changes), `beginResize` / `resize` / `endResize`, and the Svelte rune adds `resizerHandlers(id)` for `<NodeResizer>`. Locked nodes are not resized.
- **Grid snapping**: `snapToGrid` and the `gridSize` / `gridOrigin` guide options for drag and resize snapping.
- **Curve fitting**: `fitCubics`, `fitPathData`, `fitFreehandPath` (Schneider-style with corner preservation). `polygonToSvgPath` takes `curves: 'fit'`, and `combineShapeNodes` now fits curves by default (`curves: 'lines'` restores straight segments), so booleans of curved shapes stay smooth.
