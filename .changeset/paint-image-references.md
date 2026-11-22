---
'@pixerate/editor': minor
---

Paint editor tools take images by reference: `createPaintEditorToolProvider` accepts `resolveImage` and `imageReferences` (like the vector commands), so `place_image`, `set_tracing_image` and `add_reference_image` can be given a canvas node id or image URL that the host loads, not only PNG data. Inline PNGs still decode synchronously; without a resolver the tools are unchanged. Exports `PaintImageResolver`, `PaintResolvedImage` and `PAINT_IMAGE_MAX_PIXELS`.
