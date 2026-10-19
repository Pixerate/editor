---
"@pixerate/editor": minor
---

Add `getLayerDataURL` and `getLayerThumbnailDataURL` to `ImageEditorController`. `getLayerDataURL(id)` returns a tight base64 PNG data URL of the non-transparent content of a pixel or smart layer, ideal for deconstructing compositions, extracting layers, and sticker generation. `getLayerThumbnailDataURL(id, options)` returns a scaled PNG data URL preview of a pixel/smart layer or its mask directly, without requiring callers to manually create or draw onto canvas elements.
