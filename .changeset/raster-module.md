---
"@pixerate/editor": minor
---

New `@pixerate/editor/raster` subpath: the tiled copy-on-write surfaces, the PNG / zlib codec, blend modes, the generic layer stack (pixel layers, groups, raster masks, clipping, locks and tree helpers) and the per-tile compositor engine (`RasterCompositor` with a `CompositorProfile` for editor-specific layer kinds), free of DOM and framework imports. The image editor's compositor is this engine with the photo profile; `@pixerate/editor/image-editor` keeps exporting the same names.
