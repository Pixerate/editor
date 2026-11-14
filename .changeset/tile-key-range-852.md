---
'@pixerate/editor': patch
'@pixerate/swift': patch
'@pixerate/conformance': patch
---

Paint documents no longer alias tiles far off the canvas (#852). Surfaces hold −8388608..8388607 px on each axis (the range a tile key round-trips): `tilesInRect` stops at it, so reads past it see the default, writes drop pixels past it and no loop runs for ever past 2^53 px. A saved channel (light, fluorescent, thermochromic, ferrofluid, thick paint), culture occupancy, layer asset or deep samples that reach past it are refused with a load problem ("it lies outside the surface range, …") instead of being saved at another tile or as a blank PNG. New exports: `MIN_TILE`, `MAX_TILE`, `MIN_SURFACE_PIXEL`, `MAX_SURFACE_PIXEL`, `SURFACE_RANGE_MESSAGE`, `tileInRange`, `checkSurfaceRange` and `surfaceFromSavedPixels`. The Swift paint editor matches, and the `document-load-edge-cases` scenario records the refusals and channels on the range's first and last tiles.
