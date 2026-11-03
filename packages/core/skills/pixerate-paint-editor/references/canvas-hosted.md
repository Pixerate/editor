# Canvas-hosted layer

A host can mount the painting as a layer of a larger canvas (`createPaintEditorToolProvider` with
`origin`). Then every position you pass or read back is a canvas coordinate, not a document
pixel: stroke points, picks, bounds, guides, stencils, stickers and wet areas alike.
`get_canvas_info` `bounds` says where the painting lies on that canvas; paint inside it. The
host may leave out tools it owns (`new_canvas`, `set_canvas`, `extend_canvas`, exports, the
view), so work with the tools you are given.
