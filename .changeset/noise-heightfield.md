---
"@pixerate/editor": minor
"@pixerate/swift": minor
---

Seeded noise and heightfield surfaces for 3-D data pictures (closes #807).

- `noise2`, `noise3`, `fbm2`, `fbm3` (`/tools`, also `/three`): value and gradient noise in 2-D and 3-D and fractal sums (`octaves`, `lacunarity`, `gain`), seeded, always within [-1, 1]. Integer hashing and plain arithmetic only, so the Swift port gives the same numbers bit for bit (shared fixtures).
- `heightfield(height, { x0, x1, z0, z1, resolution, base })` (`/tools`): a surface `y = height(x, z)` closed by side walls and a floor into a watertight solid (every edge shared by two triangles, all facing out) with smooth normals; `heightfieldGeometry(field)` (`/three`) makes three.js geometry of it.
- 3-D charts take `relief: { amount, scale, octaves, seed }`: area tops become heightfields sculpted by fractal noise in proportion to the value, so no thickness changes by more than `amount` (default 4%, at most 25%). `scene.relief` / the renderer's `relief` give the stated bound and the error actually drawn; `setProgress(p)` grows the relief in (frame-pure). Picking and focus work on sculpted areas.
- The chart skill says when decoration is not data and how to caption it. Demo: Relief on the Charts tab's 3-D view, with the stated and drawn error.
- Swift: `noise2`, `noise3`, `fbm2`, `fbm3` in PixerateGeometry.
