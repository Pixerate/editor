---
"@pixerate/editor": minor
"@pixerate/editor-react": minor
"@pixerate/editor-svelte": minor
"@pixerate/swift": minor
---

An isometric perspective grid for the vector editor (closes #799).

- `VectorPerspective.isometric: { angle }` (1–89°, 30 is true isometric) with no vanishing points: planes floor, left and right, mapped in parallel (affine maps), so art keeps its size anywhere on a plane and grid lines never clip at a horizon. Drawing on a plane, laying art onto it and the grid lines work as for the other grids.
- `vector.setPerspective` takes `isometric` (vanishing points are no longer required), and refuses vanishing points with it; `vectorIsometricPerspectivePreset(width, height, angle?)` starts one for a page.
- React and Svelte `VectorPerspectivePanel` have an Iso preset next to 1-pt, 2-pt and 3-pt.
- Swift: the same grid, sanitizing, plane maps and preset, with the isometric scenario extended.
