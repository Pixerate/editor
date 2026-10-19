---
"@pixerate/editor": minor
---

Free Transform for the image editor: scale, rotate, skew, distort, perspective and warp (preset or Bézier mesh) of a pixel layer with its linked mask, an unlinked mask alone, the selected pixels (committed back into the layer), a Layer via Copy, or just the selection outline (Transform Selection). `beginFreeTransform` opens a session with a live, block-sampled preview and commits one undo step resampled tile by tile (`transformSurface` / `warpSurface` in `@pixerate/editor/raster`: nearest, bilinear or Photoshop's Bicubic, premultiplied, pre-filtered when shrinking). Layer masks gain a `linked` flag (PSD mask flag bit 0). New agent tools: `get_transform_frame`, `transform_layer`, `warp_layer`, `transform_selection`, `flip_layer`, `rotate_layer_90`. The homography and warp-mesh maths moved to a shared `src/geom` module; the vector editor re-exports it under its existing names.
