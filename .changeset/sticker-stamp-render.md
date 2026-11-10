---
'@pixerate/editor': minor
'@pixerate/swift': minor
---

Render one sticker stamp exactly as the paint canvas draws it, for brush and sticker previews (#738). `renderStickerStamp(art, { colour, size, frame, rotation })` (TS, `@pixerate/editor/paint-editor`) and `renderStickerStamp(_:colour:size:frame:rotation:)` (Swift) return `size × size` straight RGBA: a tintable sticker as a flat silhouette in the paint colour shaped by the art's alpha, any other in its own pixels, the frame wrapped to the art's frame count (negative frames from the last), turned clockwise about the centre. `renderStickerStampFrom(provider, ref, options)` (TS) and `renderStickerStamp(_:ref:…)` (Swift) load the art through `StickerArtCache.ensure` first, and draw editor stamps too. The canvas now tints and picks frames through the same shared helpers (`tintStickerArt`, `stickerArtFrame`), so previews and strokes can't drift; Swift matches the TS bytes.
