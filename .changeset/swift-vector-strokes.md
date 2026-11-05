---
"@pixerate/swift": minor
---

**Swift vector editor: strokes, corners and brushstrokes (#624).**

- Width profiles (`Width.swift`): presets, side scales with monotone interpolation, width points (`insertWidthPoint`, `setWidthPoint`, `removeWidthPoints`), taper / wave and pressure generators. The controller has `setWidthProfile` and `setWidthPoint`; stroke layers, shape defaults and SVG import keep profiles.
- Variable-width outlines (`variableStrokeOutline`, `variableStrokeRings`) and stroke parts (`vectorStrokeParts`, `vectorStrokeOutlinePath`, `hitTestVectorStroke`): alignment, arrowheads (`tip` and `extend`), caps, joins and dashes, matching the TS core exactly. Opacity masks, filter reach and the Pathfinder now take aligned, arrowed and profiled strokes.
- `outlineStroke`: one filled path per stroke layer above a copy that keeps the fill.
- Live corners in the controller: `setCornerRadius`, `setCornerKind` and `setCornerSmoothing`.
- Brushstrokes as data: `addBrushstroke`, `setBrushstroke`, `setColorScheme` and `setColorLocked`, with the brushes the vector profile admits (`vectorBrushstrokeBrushes`), their checks and default colours. `PixerateVector` now depends on `PixeratePaint`. Drawing brushstrokes in render data and SVG export (the raster brush engine along a path) still throws `VectorNotPorted`, as do aligned, arrowed and profiled strokes in render data and SVG export.
- The 9 commands behind these run, and the `strokes-and-corners` scenario passes (7 of 15 vector scenarios).
