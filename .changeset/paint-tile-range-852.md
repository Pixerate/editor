---
'@pixerate/editor': patch
'@pixerate/swift': patch
---

Strokes on a pixel layer offset more than about 8.4 million px from the canvas no longer alias onto another tile of that layer (#852). Paint code that keys tiles straight from pixel coordinates now stops at the surface tile range, as `tilesInRect` does: reads past it see the default and writes drop the pixel. That covers brush coverage, the paint exchange used by the mixer, blender, smudge and sponge, clone and heal sources, culture growth, thick paint, antimatter, the scraper, procedural fills, backlight, the viewport's mip lookups and mesh warps. The wet engine already worked in canvas space. New exports: `tileKeyIn(tx, ty)`, which returns `tileKey` for a tile in range and otherwise `NO_TILE_KEY` (−1, a key no tile has). The Swift paint editor matches.
