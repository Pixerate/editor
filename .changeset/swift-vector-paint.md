---
"@pixerate/swift": minor
---

**Swift vector editor: paint and appearance (#624).**

- Gradients: `setGradient` (a colour becomes a gradient; type changes, `aspect`, `reverse`, stops), with `parseVectorColor`, `applyVectorGradientPatch` and `defaultVectorGradient`.
- Fill and stroke stacks: `addPaintLayer`, `updatePaintLayer`, `removePaintLayer`, `movePaintLayer` and `setPaintLayers`; `addShape`, `addPath` and `setStyle` now take gradient paints and whole `fills` / `strokes` stacks, and shape defaults may hold stacks.
- Blend modes and filters: `setBlendMode`, `addFilter`, `updateFilter`, `removeFilter` and `moveFilter`, with the filters drawn as SVG filters in the scene render data and the SVG export (`vectorFilterSvg`, `vectorFilterMarkup`).
- Path effects (`PathEffects.swift`, `applyVectorEffects`): Trim Paths, Round Corners, Pucker & Bloat, Twist, Zig Zag, Wiggle Paths, Offset Paths, Merge Paths, Repeater, Contour and Block Shadow, with `addEffect`, `updateEffect`, `removeEffect`, `moveEffect` and Expand Appearance. They follow baked transforms and are drawn in render data and SVG export. Envelope, Extrude and Bevel still throw `VectorNotPorted`.
- Masks: `makeMask` (clipping and opacity masks), `setMaskOptions` and `releaseMask`; mask groups are bounded, listed and used by booleans and the Pathfinder as their masked result.
- Lenses: `setLens`, with backdrops resolved after every edit and stripped from saved documents, and `vectorLensDrawn`.
- The 26 commands behind these run, and the `paint-and-appearance` scenario passes (6 of 15 vector scenarios).
