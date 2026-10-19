---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
---

Warp in the Free Transform UI: a Warp mode in `FreeTransformTool` and both `<FreeTransformOptionsBar>`s draws the Bézier mesh (grid lines, anchors, handles) through the transform's corners. Drag an anchor or handle (the grid stays smooth across its lines) or pull anywhere inside the mesh. The bar offers Photoshop's fifteen presets with bend, horizontal and vertical distortion and orientation, and a Default / 3 × 3 / 5 × 5 grid. The warp and the corner transform commit together as one undo step. New exports: `WARP_STYLE_OPTIONS`, `WARP_GRID_OPTIONS`, `WarpBar`.
