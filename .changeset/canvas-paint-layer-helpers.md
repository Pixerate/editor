---
"@pixerate/editor": minor
---

Helpers for building a paint layer on an infinite canvas yourself (the demo has a recipe):

- `@pixerate/editor/raster`:
  - World ↔ surface mapping: `worldToSurface`, `surfaceToWorld`, `worldRectToSurface`, `screenToWorld`, `visibleSurfaceRect`.
  - A resolution policy: `surfaceResolutionForZoom` and `surfaceMipLevel`.
  - `drawSurfaceToViewport` / `SurfaceViewportRenderer`, which draws the visible tiles of a surface onto a 2D context at the right mip level with seam-free placement. Tile images are cached by tile and the canvas factory is injected.
- `@pixerate/editor/paint`:
  - `pointerStrokeSamples` / `pointerStrokeSample` / `pointerPressure` turn Pointer Events into stroke samples in your coordinates, with pen pressure, tilt and coalesced events. The paint and image editors now share `pointerPressure`.
  - `WetWorld.stepRegion` / `stepRegionSync` simulate only the live wet tiles that touch a region (the viewport), holding the rest still.
