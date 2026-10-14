---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add curve-preserving path operations for the canvas. A new Bézier path engine (`pathBoolean`, `unitePaths`, `intersectPaths`, `subtractPaths`, `excludePaths`, `dividePaths`, `normalizeBezierPath`) intersects curves directly (subdivision with Newton polishing, tangencies, coincident edges and T-junctions resolved; nonzero / evenodd fill rules) and rebuilds results from exact sub-curves of the inputs, falling back to the polygon engine (reported as `engine` / `fallbackReason`) only when it cannot resolve the input. Adds `offsetPath` (inset / outset with miter, round or bevel joins and loop removal), `outlineStroke` (SVG joins, caps, miter limit and dashes to a clean filled path) and arc-length / area / hit-test utilities (`bezierPathLength`, `bezierPathPointAtLength`, `bezierPathArea`, `pointInBezierPath`, …).

Behaviour change: `combineShapeNodes` (and the arrange controller's Unite / Intersect / Subtract / Exclude / Divide) now use the curve engine by default, so results keep exact arcs and straight sides instead of fitted polylines; pass `engine: 'polygon'` (or `curves: 'lines'`) for the previous behaviour. Results also report `engine`.

New undoable shape commands: `arrange.offsetShapes(distance, ids?, options?)` and `arrange.outlineStroke(ids?, options?)` (with `canOffsetShapes` / `canOutlineStroke`) in core, `useCanvasArrange` (React) and `createCanvasArrange` (Svelte); pure `offsetShapeNodes`, `outlineShapeNodeStrokes` and `applyShapeReplacement`; and `createShapeCommands` for the command palette / context menus. Portions ported from VectorCraft (MIT OR Apache-2.0).
