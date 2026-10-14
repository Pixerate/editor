---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Add Freeform-style shape boolean operations (Unite / Intersect / Subtract / Exclude / Divide) for canvas shape nodes. Core (`@pixerate/editor/canvas`) gains a dependency-free polygon boolean engine for multi-polygons with holes (`polygonBoolean`, `unionPolygons`, `intersectPolygons`, `subtractPolygons`, `xorPolygons`, `dividePolygons`), shape geometry (`data.shape` descriptions for rect / rounded rect, ellipse, regular polygon, star and SVG path data; `parseSvgPath`, `flattenSvgPath`, `shapeToPolygon`, `polygonToSvgPath`, `simplifyRing`, `getShapeRenderData`), `combineShapeNodes` / `canCombineShapeNodes`, and `combineShapes` / `unite` / `intersect` / `subtract` / `exclude` / `divide` / `canCombineShapes` on the arrange controller (one undo step with `HistoryManager`). `useCanvasArrange` and `createCanvasArrange` expose the new actions, and both packages add a headless `ShapeNode` component for React Flow / SvelteFlow.
