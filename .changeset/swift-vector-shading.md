---
"@pixerate/swift": minor
---

**Swift vector editor: gradient meshes, freeform gradients and the rest of the gradient paint servers (#624).**

- Gradient meshes and freeform gradients (`Shading.swift`): Coons patches through a lattice of coloured points (`createVectorMeshGradient`, `vectorMeshPointAt`, `vectorMeshColorAt`, `vectorMeshLines`), freeform colour fields with spreads and lines (`vectorFreeformField`, `sampleVectorFreeform`, `autoVectorFreeformGradient`), their checks (`sanitizeVectorShadedPaint`), point edits and transforms. They are drawn in render data and SVG export as patterns of flat tiles and strips (`vectorShadedSvgDefs`), and SVG import reads them back.
- The controller has `setMeshGradient`, `setMeshPoint`, `setFreeformGradient`, `addFreeformPoint`, `setFreeformPoint`, `removeFreeformPoint`, `setFreeformLines` and `getShading`, and the 8 commands behind them run. Mesh and freeform paints passed to `setStyle`, `addShape` and paint stacks are checked instead of throwing.
- Every gradient now has a paint server: stop midpoints, smoothness and linear / Oklab interpolation are expanded into stops (`expandVectorGradientStops`, `vectorGradientRamp`), reflected gradients with a pad or repeat spread become stop periods (`expandVectorGradientSpread`), conic and diamond gradients become patterns of gradient tiles, and gradients along or across a stroke become patterns of slices (`vectorStrokeGradientDefs`). `VectorPaintDef` is now an enum of a gradient element or a `VectorSvgPatternDef`.
- Free Distort now takes gradient, mesh and freeform paints: node-space gradient handles and mesh / freeform points follow the map (`mapVectorPaint`); box gradients follow the new bounds.
- The `gradients-and-shading` scenario passes (8 of 15 vector scenarios).
